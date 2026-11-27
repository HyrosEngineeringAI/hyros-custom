/**
 * The add-database skill's fixed files, tested where they live (.claude/skills/add-database/files/) so a
 * dashboard without a database never carries them. What needs the postgres package (respond.js, migrate() with
 * a url, db.js's client) is not loaded here: the template has no dependencies. db.js loads it only with a url, so
 * its one-statement-at-a-time wrapper is tested over a fake client.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FILES = join(ROOT, '.claude', 'skills', 'add-database', 'files');
const at = (path) => new URL(`../.claude/skills/add-database/files/${path}`, import.meta.url).href;

const { HttpError, toResponse, badRequest, notFound } = await import(at('api/_lib/errors.js'));
const { bearer, verifyWithHyros, requireDashboardUser, identifyCaller, isCronSecret, clearCache, CACHE_MS } = await import(at('api/_lib/auth.js'));
const { migrate, migrationFiles } = await import(at('supabase/migrate.mjs'));
const { oneAtATime, hasDatabase, sql: noSql } = await import(at('api/_lib/db.js'));
// src/core/db.js imports ./api.js: install it next to the template's core, as the skill does in a dashboard.
const core = join(await mkdtemp(join(tmpdir(), 'core-')), 'src', 'core');
await cp(join(ROOT, 'src', 'core'), core, { recursive: true });
await cp(join(FILES, 'src', 'core', 'db.js'), join(core, 'db.js'));
const { db, request, DbError } = await import(pathToFileURL(join(core, 'db.js')).href);
const { configure, credential } = await import(pathToFileURL(join(core, 'api.js')).href);

const ACCOUNT = '3fbcb1563c51a0e0';
const ENV = { HYROS_API_URL: 'https://api.test/v1/api/v1.0/', DASHBOARD_ACCOUNT_ID: ACCOUNT };

function hyros(status, profile) {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, authorization: init.headers.authorization });
    return { status, ok: status >= 200 && status < 300, json: async () => ({ result: { userProfile: profile } }) };
  };
  return { seen, fetchFn };
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])));
  return nested.flat();
}

beforeEach(() => clearCache());

test('every fixed file starts with the same add-database version line', async () => {
  const files = await walk(FILES);
  assert.ok(files.length >= 8, 'the skill ships its fixed files');
  const versions = new Set();
  for (const file of files) {
    const first = (await readFile(file, 'utf8')).split('\n')[0];
    const match = /add-database v(\d+)\./.exec(first);
    assert.ok(match, `${relative(FILES, file).split(sep).join('/')} starts with an add-database v<N> line`);
    versions.add(match[1]);
  }
  assert.equal(versions.size, 1, 'one version for all the fixed files, raised together');
});

test('the template carries no database file outside the skill', async () => {
  for (const path of ['api', 'supabase', 'src/core/db.js']) {
    assert.ok(!existsSync(join(ROOT, path)), `${path} exists only once the skill copied it`);
  }
});

test('a route error maps to its status and code', () => {
  assert.deepEqual(toResponse(badRequest('text is required')), { status: 400, code: 'bad_request', message: 'text is required' });
  assert.equal(toResponse(notFound()).status, 404);
  assert.equal(toResponse(new HttpError(403, 'forbidden', 'x')).code, 'forbidden');
  assert.deepEqual(toResponse({ code: '25006' }).status, 507, 'a full disk turns the database read only');
  assert.equal(toResponse({ code: 'ECONNREFUSED' }).code, 'unavailable');
  assert.deepEqual(toResponse(new Error('syntax error at or near "selec"')), { status: 500, code: 'internal', message: 'The dashboard database failed to answer' },
    'a database error never reaches the page');
});

test('the bearer token is read from the Authorization header only', () => {
  assert.equal(bearer({ headers: { authorization: 'Bearer abc.def' } }), 'abc.def');
  assert.equal(bearer({ headers: { authorization: 'Basic abc' } }), null);
  assert.equal(bearer({ headers: {} }), null);
});

test('a request without a token is refused before HYROS is asked', async () => {
  await assert.rejects(requireDashboardUser({ headers: {} }, { env: ENV, fetchFn: () => assert.fail('no call') }), { status: 401, code: 'auth' });
});

test('a token of the owning account is accepted, asked with HYROS once per cache window', async () => {
  const { seen, fetchFn } = hyros(200, { accountId: ACCOUNT, email: 'owner@example.com' });

  assert.deepEqual(await verifyWithHyros('tok-1', { env: ENV, fetchFn, now: 1000 }), { accountId: ACCOUNT, email: 'owner@example.com' });
  await verifyWithHyros('tok-1', { env: ENV, fetchFn, now: 1000 + CACHE_MS - 1 });
  assert.equal(seen.length, 1, 'the second call is served from the cache');
  assert.equal(seen[0].url, 'https://api.test/v1/api/v1.0/user-info');
  assert.equal(seen[0].authorization, 'Bearer tok-1');

  await verifyWithHyros('tok-1', { env: ENV, fetchFn, now: 1000 + CACHE_MS + 1 });
  assert.equal(seen.length, 2, 'an expired entry is asked again');
});

test('a token of another account is refused', async () => {
  const { fetchFn } = hyros(200, { accountId: 'someone-else' });
  await assert.rejects(verifyWithHyros('tok-1', { env: ENV, fetchFn }), { status: 403, code: 'forbidden' });
});

test('a token HYROS refuses is refused, and is not cached', async () => {
  const refused = hyros(401, null);
  await assert.rejects(verifyWithHyros('tok-1', { env: ENV, fetchFn: refused.fetchFn }), { status: 401, code: 'auth' });
  const accepted = hyros(200, { accountId: ACCOUNT });
  await verifyWithHyros('tok-1', { env: ENV, fetchFn: accepted.fetchFn });
  assert.equal(accepted.seen.length, 1);
});

test('without the variables or HYROS the route is unavailable, never open', async () => {
  await assert.rejects(verifyWithHyros('tok-1', { env: {}, fetchFn: () => assert.fail('no call') }), { status: 503, code: 'no_database' });
  await assert.rejects(verifyWithHyros('tok-1', { env: ENV, fetchFn: async () => { throw new Error('down'); } }), { status: 503, code: 'unavailable' });
  const noId = hyros(200, { email: 'owner@example.com' });
  await assert.rejects(verifyWithHyros('tok-1', { env: ENV, fetchFn: noId.fetchFn }), { status: 503 }, 'a profile without accountId is never accepted');
});

test('the cron secret is recognized in constant time, and never without one set', () => {
  assert.equal(isCronSecret('cron-s3cret', { CRON_SECRET: 'cron-s3cret' }), true);
  assert.equal(isCronSecret('cron-s3cre', { CRON_SECRET: 'cron-s3cret' }), false, 'a different length is refused');
  assert.equal(isCronSecret('cron-s3creT', { CRON_SECRET: 'cron-s3cret' }), false);
  assert.equal(isCronSecret('', { CRON_SECRET: '' }), false, 'an unset secret matches nothing');
  assert.equal(isCronSecret('anything', {}), false);
});

test('a route takes the page by default; the cron secret opens only a route that takes the cron', async () => {
  const env = { ...ENV, CRON_SECRET: 'cron-s3cret' };
  const cronReq = { headers: { authorization: 'Bearer cron-s3cret' } };
  const userReq = { headers: { authorization: 'Bearer tok-1' } };
  const never = { env, fetchFn: () => assert.fail('the cron secret is never sent to HYROS') };

  assert.deepEqual(await identifyCaller(cronReq, ['cron'], never), { caller: 'cron', user: null });
  assert.deepEqual(await identifyCaller(cronReq, ['user', 'cron'], never), { caller: 'cron', user: null });
  await assert.rejects(identifyCaller(cronReq, ['user'], never), { status: 403, code: 'forbidden' });
  await assert.rejects(identifyCaller(cronReq, undefined, never), { status: 403 }, 'user only is the default');

  const owner = hyros(200, { accountId: ACCOUNT, email: 'owner@example.com' });
  assert.deepEqual(await identifyCaller(userReq, ['user', 'cron'], { env, fetchFn: owner.fetchFn }),
    { caller: 'user', user: { accountId: ACCOUNT, email: 'owner@example.com' } });
  await assert.rejects(identifyCaller(userReq, ['cron'], { env, fetchFn: () => assert.fail('a cron-only route asks HYROS nothing') }),
    { status: 401, code: 'auth' });
  await assert.rejects(identifyCaller({ headers: {} }, ['cron'], never), { status: 401 });
});

test('migrations run in name order and a badly named file fails the build', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'migrations-'));
  await writeFile(join(dir, '0002_add_stage.sql'), 'select 1;');
  await writeFile(join(dir, '0001_create_notes.sql'), 'select 1;');
  assert.deepEqual(await migrationFiles(dir), ['0001_create_notes.sql', '0002_add_stage.sql']);

  await writeFile(join(dir, 'notes.sql'), 'select 1;');
  await assert.rejects(migrationFiles(dir), /0001_create_notes\.sql/);
});

test('without a database url migrate does nothing', async () => {
  const lines = [];
  assert.deepEqual(await migrate({ url: '', log: (line) => lines.push(line) }), []);
  assert.match(lines[0], /nothing to migrate/);
});

test('the page calls its own routes with the HYROS token and retries once with a new one', async () => {
  let n = 0;
  const invalidated = [];
  configure({ url: 'https://api.test/v1/api/v1.0', getToken: async () => `tok-${++n}`, markInvalid: (t) => invalidated.push(t) });
  assert.ok(credential(), 'api.js lends its credential once configured');

  const seen = [];
  const fetchFn = async (href, init) => {
    seen.push({ href, method: init.method, authorization: init.headers.authorization, body: init.body });
    if (seen.length === 1) return { status: 401, ok: false, json: async () => ({ error: { code: 'auth', message: 'refused' } }) };
    return { status: 200, ok: true, json: async () => ({ id: 1 }) };
  };

  assert.deepEqual(await request('POST', 'notes', { body: { text: 'hi' }, fetchFn }), { id: 1 });
  assert.deepEqual(seen.map((s) => s.authorization), ['Bearer tok-1', 'Bearer tok-2']);
  assert.equal(seen[0].href, '/api/db/notes');
  assert.equal(seen[0].body, '{"text":"hi"}');
  assert.deepEqual(invalidated, ['tok-1']);
});

test('a route error reaches the view as a DbError with its code', async () => {
  configure({ url: 'https://api.test/v1/api/v1.0', getToken: async () => 'tok', markInvalid: () => {} });
  const fetchFn = async () => ({ status: 507, ok: false, json: async () => ({ error: { code: 'storage_full', message: 'The dashboard database is full.' } }) });

  await assert.rejects(request('GET', 'notes', { params: { stage: 'won' }, fetchFn }), (err) => err instanceof DbError && err.code === 'storage_full' && err.status === 507);
  await assert.rejects(request('GET', '../secrets', { fetchFn }), { code: 'bad_request' }, 'a route name never leaves /api/db/');
  assert.equal(typeof db.get, 'function');
});

/** A route that never answers: the fetch only ends when the page gives up. */
const silentRoute = (seen = []) => (href, init) => {
  seen.push(href);
  return new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
};

/** Starts `call` under fake timers and tells whether it gave up at `ms` and not a millisecond before. */
async function givesUpAt(ms, call) {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let settled = false;
    const pending = call().catch((err) => err).finally(() => { settled = true; });
    await new Promise((resolve) => { setImmediate(resolve); });
    mock.timers.tick(ms - 1);
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.equal(settled, false, `still waiting at ${ms - 1} ms`);
    mock.timers.tick(1);
    const err = await pending;
    assert.ok(err instanceof DbError && err.code === 'timeout', `gave up at ${ms} ms with a timeout`);
  } finally {
    mock.timers.reset();
  }
}

test('a call gives up after 20 s unless it asks for another wait', async () => {
  configure({ url: 'https://api.test/v1/api/v1.0', getToken: async () => 'tok', markInvalid: () => {} });

  await givesUpAt(20000, () => request('GET', 'notes', { fetchFn: silentRoute() }));
  await givesUpAt(20000, () => request('GET', 'notes', { timeoutMs: undefined, fetchFn: silentRoute() }));
  await givesUpAt(90000, () => request('POST', 'summary', { body: { id: 1 }, timeoutMs: 90000, fetchFn: silentRoute() }));
});

test('the retry with a new token waits as long as the first try', async () => {
  let n = 0;
  configure({ url: 'https://api.test/v1/api/v1.0', getToken: async () => `tok-${++n}`, markInvalid: () => {} });
  const seen = [];
  const silent = silentRoute(seen);
  const fetchFn = (href, init) => (seen.length === 0
    ? (seen.push(href), Promise.resolve({ status: 401, ok: false, json: async () => ({ error: { code: 'auth', message: 'refused' } }) }))
    : silent(href, init));

  await givesUpAt(45000, () => request('GET', 'notes', { timeoutMs: 45000, fetchFn }));
  assert.equal(seen.length, 2, 'refused once, then retried');
});

test('db.get, post, patch and del pass their wait to the request', async () => {
  configure({ url: 'https://api.test/v1/api/v1.0', getToken: async () => 'tok', markInvalid: () => {} });
  const realFetch = globalThis.fetch;
  globalThis.fetch = silentRoute();
  try {
    await givesUpAt(30000, () => db.get('notes', { stage: 'won' }, { timeoutMs: 30000 }));
    await givesUpAt(30000, () => db.post('notes', { text: 'hi' }, { timeoutMs: 30000 }));
    await givesUpAt(30000, () => db.patch('notes', { id: 1 }, { timeoutMs: 30000 }));
    await givesUpAt(30000, () => db.del('notes', { id: 1 }, { timeoutMs: 30000 }));
    await givesUpAt(20000, () => db.get('notes'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

/**
 * A stand-in for a postgres.js client: a statement is a promise that goes to the client's dispatcher only when
 * awaited, as postgres.js does, and answers after `answerIn` ms, never when the text says `hang`.
 */
function fakeClient(wire) {
  class Query extends Promise {
    static get [Symbol.species]() { return Promise; }
    constructor(strings, args, handler) {
      let resolve, reject;
      super((a, b) => { resolve = a; reject = b; });
      Object.assign(this, { strings, args, handler, resolve, reject, executed: false, cancelled: null });
    }
    handle() { if (!this.executed) { this.executed = true; Promise.resolve().then(() => this.handler(this)); } }
    then(...a) { this.handle(); return super.then(...a); }
    catch(...a) { this.handle(); return super.catch(...a); }
  }
  const client = (strings, ...args) => (Array.isArray(strings.raw) ? new Query(strings, args, dispatch) : { helper: strings });
  function dispatch(q) {
    if (client.ended) return q.reject(Object.assign(new Error('ended'), { code: 'CONNECTION_ENDED' }));
    const text = q.strings.join('?');
    wire.inFlight++;
    wire.peak = Math.max(wire.peak, wire.inFlight);
    wire.sent.push(text);
    if (text.includes('hang')) return;
    setTimeout(() => { wire.inFlight--; text.includes('fail') ? q.reject(new Error('failed')) : q.resolve([{ text }]); }, wire.answerIn);
  }
  client.end = async () => { client.ended = true; wire.ended++; };
  client.json = (value) => ({ json: value });
  client.begin = async (fn) => { wire.sent.push('begin'); return fn(client); };
  return client;
}

function wired() {
  const wire = { inFlight: 0, peak: 0, sent: [], ended: 0, made: 0, answerIn: 5 };
  return { wire, connect: () => (wire.made++, fakeClient(wire)) };
}

test('without a database url there is no client to load', () => {
  assert.equal(hasDatabase, false);
  assert.equal(noSql, null);
});

test('different statements sent together go out one at a time, and each answers its own caller', async () => {
  const { wire, connect } = wired();
  const sql = oneAtATime(connect);
  const rows = await Promise.all([sql`select 1`, sql`select now()`, sql`select ${1}`, sql`select * from pg_class`, sql`select 5`]);
  assert.equal(wire.peak, 1, 'never two statements on the wire');
  assert.deepEqual(rows.map((r) => r[0].text), ['select 1', 'select now()', 'select ?', 'select * from pg_class', 'select 5']);
});

test('a statement never awaited, like a nested fragment, never takes a turn', async () => {
  const { wire, connect } = wired();
  const sql = oneAtATime(connect);
  sql`where id = ${1}`;
  await sql`select 1`;
  assert.deepEqual(wire.sent, ['select 1']);
  assert.deepEqual(sql('id'), { helper: 'id' }, 'helpers go to the client as they are');
  assert.deepEqual(sql.json({ a: 1 }), { json: { a: 1 } });
});

test('a failing statement fails its caller and the next one still runs', async () => {
  const { wire, connect } = wired();
  const sql = oneAtATime(connect);
  const [failed, next] = await Promise.allSettled([sql`select fail`, sql`select 2`]);
  assert.equal(failed.status, 'rejected');
  assert.equal(next.value[0].text, 'select 2');
  assert.equal(wire.peak, 1);
});

test('a statement with no answer times out, the connection is replaced, and the line recovers', async () => {
  const { wire, connect } = wired();
  const sql = oneAtATime(connect, { timeoutMs: 30 });
  const waiting = sql`select 2`;
  await assert.rejects(Promise.all([sql`select hang`, waiting]), { code: 'QUERY_TIMEOUT' });
  assert.equal((await waiting)[0].text, 'select 2', 'the statement queued behind it runs on the new connection');
  assert.equal(wire.made, 2);
  assert.equal(wire.ended, 1, 'the hung connection is torn down');
  assert.equal((await sql`select 3`)[0].text, 'select 3');
});

test('a transaction is one turn', async () => {
  const { wire, connect } = wired();
  const sql = oneAtATime(connect);
  const [inside] = await Promise.all([
    sql.begin(async (tx) => {
      await tx`select in tx`;
      return (await tx`select again in tx`)[0].text;
    }),
    sql`select outside`,
  ]);
  assert.equal(inside, 'select again in tx');
  assert.deepEqual(wire.sent, ['begin', 'select in tx', 'select again in tx', 'select outside'], 'nothing slips in between');
  assert.equal(wire.peak, 1);
});

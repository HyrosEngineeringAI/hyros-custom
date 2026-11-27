// add-database v4. Copied by the add-database skill: do not edit, run the skill again to update it.
/**
 * The dashboard's own Postgres database, for the functions under `api/` only. The browser never sees
 * SUPABASE_DB_URL: HYROS sets it on the Vercel project as a sensitive variable when it creates the database.
 *
 * It goes through Supabase's pooler in transaction mode: every function instance opens its own connection,
 * and the pooler is what keeps many short-lived instances within the database's connection limit. Transaction
 * mode does not support prepared statements, hence `prepare: false`.
 *
 * The pooler hangs when several statements reach it together on one connection: none of them answers, and
 * neither does any statement sent on that connection afterwards. So `sql` sends one statement at a time, each
 * once the previous one answered, whatever the routes do (`Promise.all` included). A statement that still gets
 * no answer within QUERY_TIMEOUT_MS fails with `QUERY_TIMEOUT` and the connection is replaced, so the function
 * instance recovers without a new deployment.
 */
const url = process.env.SUPABASE_DB_URL;

/** False until HYROS created the database; every route answers `no_database` meanwhile. */
export const hasDatabase = Boolean(url);

/** How long one statement, or one `sql.begin` transaction, may take before its connection is replaced. */
export const QUERY_TIMEOUT_MS = 120_000;

// Loaded only with a database, so the template's tests load this file without the postgres package.
const postgres = hasDatabase ? (await import('postgres')).default : null;

/** Tagged-template SQL: `await sql\`select * from notes where id = ${id}\``. Values are always sent as parameters. */
export const sql = hasDatabase
  ? oneAtATime(() => postgres(url, { prepare: false, max: 1, idle_timeout: 20, connect_timeout: 10 }))
  : null;

const PROBE = Object.assign([''], { raw: [''] });
const noop = () => {};

/**
 * A postgres.js client whose statements go out one at a time. `connect()` makes the client underneath, again
 * each time a statement times out; `sql` itself stays the same object. A statement runs when it is awaited
 * and waits for its turn then; a nested `sql` fragment is never awaited, so it never takes a turn.
 */
export function oneAtATime(connect, { timeoutMs = QUERY_TIMEOUT_MS } = {}) {
  let client = connect();
  let turn = Promise.resolve();
  const dispatchers = new WeakMap();

  // The client's own dispatcher, which puts a statement on the wire: every query it makes carries it.
  const dispatcher = (c) => dispatchers.get(c) || dispatchers.set(c, c(PROBE).handler).get(c);

  function replace(used) {
    if (client === used) client = connect();
    // A timeout of 0 tears the connection down now, failing whatever was still waiting on it.
    used.end({ timeout: 0 }).catch(noop);
  }

  /** Runs `run(client)` once every earlier turn ended, and ends the turn when it settles or times out. */
  function inTurn(run, onTimeout = noop) {
    const mine = turn.then(() => new Promise((resolve, reject) => {
      const used = client;
      const timer = setTimeout(() => {
        const err = Object.assign(new Error(`The database did not answer within ${timeoutMs / 1000} s`), { code: 'QUERY_TIMEOUT' });
        onTimeout(err);
        reject(err);
        replace(used);
      }, timeoutMs);
      Promise.resolve().then(() => run(used)).then(
        (value) => { clearTimeout(timer); resolve(value); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    }));
    turn = mine.then(noop, noop);
    return mine;
  }

  // The query answers its own caller; the turn only waits for it. Promise's own then does not send it.
  const queued = (query) => {
    query.handler = (q) => {
      inTurn(
        (c) => {
          if (!q.cancelled) dispatcher(c)(q);
          return Promise.prototype.then.call(q, noop, noop);
        },
        (err) => q.reject(err),
      ).catch(noop);
    };
    return query;
  };

  function sql(strings, ...args) {
    const made = client(strings, ...args);
    return Array.isArray(strings?.raw) ? queued(made) : made;
  }

  return Object.assign(sql, {
    json: (value) => client.json(value),
    array: (...values) => client.array(...values),
    typed: (value, type) => client.typed(value, type),
    unsafe: (...args) => queued(client.unsafe(...args)),
    // A transaction holds the connection for all its statements, so it is one turn; inside it, use its own `sql`.
    begin: (...args) => inTurn((c) => c.begin(...args)),
  });
}

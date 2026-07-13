const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('neon.tech') ? { rejectUnauthorized: false } : false,
  // Pool sizing (SERVER-11, revised): the admin Money Board mounts BOTH aggregate
  // endpoints at once (OverviewPage useEffect), and each fans out its own Promise.all:
  // /proposals/dashboard-stats ~14 concurrent queries + /proposals/financials ~9. So a
  // SINGLE page load demands ~23 simultaneous checkouts, which already overshot the old
  // max of 20 (that comment counted only the 14 and missed the +9). Two admins/managers
  // loading together is ~46, plus the autopay sweep (CONCURRENCY=5) and any in-flight
  // Stripe webhook transaction holding a client. 50 covers two concurrent Money Board
  // loads with operational headroom instead of queueing them toward the 10s
  // connectionTimeoutMillis, where a slow scan or a Neon cold start turns the queue into
  // 500s that starve unrelated requests (webhooks, staff portal) too.
  // Ceiling check: 50 is safe against either Neon endpoint. Through the pooled
  // (PgBouncer) endpoint, app-side connections are multiplexed onto a handful of
  // backends and the binding limit is max_client_conn (thousands). Against a direct
  // compute, max_connections scales with compute size and is >= 112 even on the
  // smallest 0.25 CU tier. Do NOT size this against a single observed max_connections
  // reading: it is compute-size dependent, and via PgBouncer it is not the constraint
  // at all.
  max: 50,
  connectionTimeoutMillis: 10000,
});

// A pooled client can emit 'error' asynchronously when the backend drops it from
// under us — a Neon idle reap, an idle-in-transaction timeout, a network blip.
// pg forwards an idle client's error to the Pool, and an UNHANDLED pool 'error'
// takes down the whole process (this was Sentry SERVER-17). Handle it: capture,
// log, and let pg evict the dead client so the next checkout gets a fresh one.
pool.on('error', (err) => {
  try {
    const Sentry = require('@sentry/node');
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, { tags: { area: 'pg-pool' } });
    }
  } catch (_sentryErr) { /* best-effort: never let error reporting crash us */ }
  console.error('[db] idle pool client error (handled, process stays up):', err && err.message);
});

// Split a SQL script into individual statements on `;`, respecting Postgres
// regions that may legitimately contain `;`:
//   - Dollar-quoted bodies (`$$...$$`, `$body$...$body$`) — DO blocks, function
//     bodies, seed rows with embedded HTML.
//   - Line comments (`-- ... \n`) — schema.sql narrative comments routinely
//     contain `;` (e.g. "(status='pending_review'); admin reviews ...").
//   - Block comments (`/* ... */`).
//   - Single-quoted strings, with the `''` escape.
//   - Double-quoted identifiers, with the `""` escape.
//
// Dollar-quote tags only close on an exact match — `$body$ ... $$` does NOT
// close. The empty-tag form `$$` is its own tag.
function splitStatements(sql) {
  const TAG_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;
  const statements = [];
  const len = sql.length;
  let buf = '';
  let openTag = null;
  let i = 0;

  while (i < len) {
    // Inside a dollar-quoted body: copy raw until close tag — comments and
    // quotes inside don't apply.
    if (openTag !== null) {
      if (sql.startsWith(openTag, i)) {
        buf += openTag;
        i += openTag.length;
        openTag = null;
      } else {
        buf += sql[i++];
      }
      continue;
    }

    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === '-' && next === '-') {
      const eol = sql.indexOf('\n', i);
      const stop = eol === -1 ? len : eol + 1;
      buf += sql.slice(i, stop);
      i = stop;
      continue;
    }

    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? len : end + 2;
      buf += sql.slice(i, stop);
      i = stop;
      continue;
    }

    if (ch === "'") {
      buf += ch;
      i++;
      while (i < len) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            buf += "''";
            i += 2;
            continue;
          }
          buf += "'";
          i++;
          break;
        }
        buf += sql[i++];
      }
      continue;
    }

    if (ch === '"') {
      buf += ch;
      i++;
      while (i < len) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            buf += '""';
            i += 2;
            continue;
          }
          buf += '"';
          i++;
          break;
        }
        buf += sql[i++];
      }
      continue;
    }

    if (ch === '$') {
      const m = TAG_RE.exec(sql.slice(i));
      if (m) {
        openTag = m[0];
        buf += openTag;
        i += openTag.length;
        continue;
      }
    }

    if (ch === ';') {
      const stmt = buf.trim();
      if (stmt.length > 0) statements.push(stmt);
      buf = '';
      i++;
      continue;
    }

    buf += ch;
    i++;
  }

  const tail = buf.trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}

// Postgres error codes that are expected to fire when re-running schema.sql
// against an already-initialized DB. Anything outside this list signals a real
// problem (bad SQL, missing dependency, partial prior run) and should NOT be
// quietly swallowed.
//   42P07 duplicate_table
//   42P06 duplicate_schema
//   42710 duplicate_object         (constraints, types, triggers, etc.)
//   42701 duplicate_column
//   42P16 invalid_table_definition (e.g. constraint already exists, NOT NULL re-add)
//   23505 unique_violation         (seed inserts that ON CONFLICT didn't catch)
//   42704 undefined_object         (DROP IF NOT EXISTS quirks across versions)
const IDEMPOTENT_PG_CODES = new Set([
  '42P07', '42P06', '42710', '42701', '42P16', '23505', '42704',
]);

// Money-integrity indexes that MUST exist after a schema apply. A partial UNIQUE
// index that fails to build on pre-existing duplicate data raises 23505, which the
// IDEMPOTENT_PG_CODES swallow above treats as "already applied" — so a
// silently-absent guard would boot clean with no alert (F7 review follow-up).
const CRITICAL_INDEXES = ['uq_invoice_payments_positive_link'];

// Returns the names of CRITICAL_INDEXES absent from the DB. Exported for unit
// testing; called by initDb after the schema apply.
async function findMissingCriticalIndexes(db = pool) {
  // Scope to the public schema: index names are unique per schema, so a public
  // hit is unambiguously the guard we mean, and a same-named index in another
  // (backup/restore) schema can't mask a real absence in public.
  const { rows } = await db.query(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1)",
    [CRITICAL_INDEXES]
  );
  const present = new Set(rows.map((r) => r.indexname));
  return CRITICAL_INDEXES.filter((name) => !present.has(name));
}

async function initDb() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const statements = splitStatements(schema);
  const client = await pool.connect();
  const unexpected = [];
  try {
    for (const stmt of statements) {
      try {
        await client.query(stmt);
      } catch (err) {
        if (err.code && IDEMPOTENT_PG_CODES.has(err.code)) {
          // Expected on a re-run against a populated DB — quiet.
          continue;
        }
        // Unexpected error — capture for end-of-init reporting; don't abort
        // mid-loop so a single bad statement doesn't strand the rest of the
        // schema half-applied.
        unexpected.push({
          code: err.code || 'UNKNOWN',
          message: err.message.split('\n')[0],
          stmt: stmt.slice(0, 200),
        });
        console.error(`Schema statement FAILED [${err.code || 'UNKNOWN'}]:`, err.message.split('\n')[0]);
      }
    }

    // F7 review follow-up: assert money-integrity indexes actually exist. A UNIQUE
    // INDEX build that hit pre-existing duplicate data would have raised 23505 and
    // been swallowed as idempotent above, leaving the guard silently absent. Route
    // any miss through the same unexpected-failure reporting (Sentry + loud log).
    // Uses the held `client` (one-connection rule), not a bare pool checkout.
    // Wrapped so a transient catalog error (a DB blip in the instant after the
    // schema apply) routes into `unexpected` and boots with an alert, matching
    // this file's alert-don't-wedge design — never a hard boot crash via start()'s
    // process.exit(1), which would be strictly worse than the silent absence it guards.
    try {
      for (const name of await findMissingCriticalIndexes(client)) {
        unexpected.push({
          code: 'INTEGRITY_INDEX_ABSENT',
          message: `money-integrity index missing after schema apply: ${name}`,
          stmt: name,
        });
        console.error(`Money-integrity index MISSING after schema apply: ${name}`);
      }
    } catch (checkErr) {
      unexpected.push({
        code: 'INTEGRITY_INDEX_CHECK_FAILED',
        message: `money-integrity index check failed: ${checkErr.message.split('\n')[0]}`,
        stmt: 'findMissingCriticalIndexes',
      });
      console.error('Money-integrity index check FAILED (non-fatal):', checkErr.message.split('\n')[0]);
    }

    if (unexpected.length > 0) {
      // Surface to Sentry so deploys with broken migrations are visible without
      // requiring someone to read server logs.
      try {
        const Sentry = require('@sentry/node');
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureMessage(
            `initDb: ${unexpected.length} unexpected schema statement(s) failed`,
            { level: 'error', extra: { unexpected } }
          );
        }
      } catch (_sentryErr) { /* best-effort */ }
      console.error(`✗ Database schema initialized with ${unexpected.length} UNEXPECTED failure(s) — review immediately`);
    } else {
      console.log('✓ Database schema initialized');
    }
  } finally {
    client.release();
  }
}

module.exports = { pool, initDb, splitStatements, findMissingCriticalIndexes };

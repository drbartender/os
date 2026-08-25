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
const CRITICAL_INDEXES = [
  // The marketing send-once guard. If this index is silently absent, the send
  // route's 23505 catch never fires and a re-run mails the whole list again.
  'idx_email_sends_campaign_client_once',
  'uq_invoice_payments_positive_link',
  'idx_duty_lines_event_kinds',
  'idx_duty_lines_bounty',
  'idx_duty_lines_contest',
  // Added 2026-08-14 (schema-trap sweep). Both are DEDUPE guards created by a
  // bare DROP-then-CREATE that re-runs on EVERY boot, so each boot has a window
  // with no guard, and a CREATE that fails on duplicate data raises 23505 —
  // which IDEMPOTENT_PG_CODES swallows, leaving the guard permanently absent and
  // the boot green. Listing them here is what turns that into a loud alert.
  'idx_scheduled_messages_pending_uniq', // enqueue dedupe; absence = duplicate sends
  'idx_sms_messages_twilio_sid',         // Twilio webhook-retry dedupe; absence = double-logged inbound SMS
];

// Constraints whose VALUE LIST is load-bearing and which schema.sql defines more
// than once. schema.sql is re-executed on every boot and is not transactional end
// to end, so if two definitions of the same constraint disagree, the narrower one
// is live for the seconds between them — on every boot, not only an interrupted
// one. Worse, the DO $$ ... EXCEPTION WHEN OTHERS THEN NULL wrapper these use
// swallows the failure, so a narrowed or entirely absent constraint boots green.
//
// This is the gap the 2026-08-14 sweep found and nothing covered: an index that
// vanishes is caught by CRITICAL_INDEXES above, but a CHECK that quietly loses a
// value was invisible. The dispatcher's own claim state ('processing') lives in
// one of these, and a narrowed constraint there makes every claim raise 23514,
// which the dispatcher's generic catch records as status='failed' — a TERMINAL
// value — so a collision does not retry, it permanently drops that batch.
//
// `mustContain` is deliberately a subset, not the full list: it names the values
// a NARROWED definition would drop. Adding a new value to a constraint does not
// require touching this manifest; REMOVING one from schema.sql while it stays
// here is meant to fail loudly.
//
// Every entry names its TABLE as well as its constraint. Constraint names are
// unique per TABLE, not per schema, so two tables in `public` may legitimately
// carry the same name; keying the catalog lookup on the name alone let whichever
// row came back last win, and a same-named constraint on an unrelated table
// could satisfy the contract for a real one. No such pair exists today (checked
// against dev, 2026-08-20: zero duplicate constraint names in public), so this
// is exactness, not a live fix -- but the guard exists to be trusted when it is
// green, and a lookup that can silently answer about the wrong table is not.
const CONSTRAINT_CONTRACT = [
  { table: 'scheduled_messages', constraint: 'scheduled_messages_status_check',
    mustContain: ['processing', 'dead_letter', 'suppressed_by_sibling'] },
  { table: 'scheduled_messages', constraint: 'scheduled_messages_channel_check',
    mustContain: ['push'] },
  // 'event_passed' has a live writer (staleProposalSweep.js). A narrowed
  // constraint would raise 23514 on every swept row, so it must be flagged.
  // NOTE this manifest is alert-don't-wedge (Sentry + console, the boot
  // continues); the sweep's own rethrow is what turns the 23514 into a 'failed'
  // scheduler heartbeat rather than a silent green.
  { table: 'proposals', constraint: 'proposals_archive_reason_check',
    mustContain: ['option_not_chosen', 'event_passed'] },
  // Same BARE DROP-then-ADD shape as archive_reason, and schema.sql calls it the
  // worst shape in the file for good reason: the two statements are separate
  // autocommit transactions, so an ADD that fails leaves users.onboarding_status
  // with NO constraint at all, committed. That is not theoretical — it is what
  // happened whenever a 'suspended' row existed, before the value was added to
  // the earlier site. 'suspended' has no live writer today (admin/users.js
  // validStatuses excludes it and the route throws first), so it is NOT asserted
  // here; the values that ARE written are.
  { table: 'users', constraint: 'users_onboarding_status_check',
    mustContain: ['in_progress', 'hired', 'deactivated'] },
  // Not a duplicate-definition case, but the same failure mode: its DO-block ADD
  // has failed outright on a populated DB (three pre-existing 'confirmed' rows on
  // dev) and left the table with NO status constraint at all, silently, forever.
  { table: 'shifts', constraint: 'shifts_status_check',
    mustContain: ['open', 'completed', 'cancelled'] },
  // AUTH, and the omission the 2026-08-14 sweep named by name. It is the worst
  // instance of the bare DROP-then-ADD shape in the file AND a double
  // definition: `CREATE TABLE users` carries an unnamed inline CHECK that
  // Postgres auto-names `users_role_check` (schema.sql:16-18 says so), and
  // schema.sql:303-305 then drops and re-adds that same name OUTSIDE a DO block.
  // Two autocommit statements: an ADD that fails leaves users.role accepting
  // ANY string, committed, on a table whose value decides admin/manager/staff.
  { table: 'users', constraint: 'users_role_check',
    mustContain: ['staff', 'admin', 'manager'] },
  // Pricing: `applies_to` decides which add-ons an engine offers for a byob vs
  // hosted vs class proposal. Bare DROP-then-ADD at schema.sql:2434.
  { table: 'service_addons', constraint: 'service_addons_applies_to_check',
    mustContain: ['byob', 'hosted', 'all', 'class'] },
  // The client-comms ledger's terminal states. Bare DROP-then-ADD at
  // schema.sql:4556, and the Resend webhook writes 'bounced' and 'complained':
  // a narrowed constraint raises 23514 inside the webhook and we stop recording
  // the two states that matter most for deliverability.
  { table: 'message_log', constraint: 'message_log_status_check',
    mustContain: ['sent', 'failed', 'bounced', 'complained'] },
  // BILLED VOICE ON A TIMER, and the newest instance of the double-definition
  // shape (2026-08-25). consult_call_attempts_status_check is written TWICE in
  // schema.sql: once as the inline CHECK in the CREATE TABLE body, which only a
  // fresh database ever runs, and once in an idempotent DO block, which is what
  // dev and prod actually get. Two sites, one name, and nothing but this entry
  // stops them drifting apart silently and forever.
  //
  // Load-bearing in the strong sense. The cap-trip marker insert writes
  // 'skipped_cap' from inside the 60-second sweep, so a narrowed list raises
  // 23514 there, the sweep's per-row catch records the fault, and the consult
  // call bridge simply stops ringing -- in a feature whose failure mode is
  // already silence, on a booking page the public can reach.
  //
  // ALL TWELVE values are asserted, not the narrowing subset the header above
  // describes. The two definitions are byte-identical today and the whole point
  // of contracting this one is that neither site may quietly lose a value; a
  // thirteenth added later still needs no change here.
  { table: 'consult_call_attempts', constraint: 'consult_call_attempts_status_check',
    mustContain: ['pending', 'calling_admin', 'calling_va', 'connected', 'missed',
      'failed', 'skipped_cancelled', 'skipped_invalid_phone', 'skipped_unconfigured',
      'skipped_disabled', 'skipped_cap', 'skipped_missed_window'] },
  //
  // DELIBERATELY NOT HERE: email_sends_recipient_check (schema.sql:1673, the
  // lead_id/client_id XOR). It is the same bare DROP-then-ADD shape and its
  // absence IS a real hazard, but it enumerates no values, so `mustContain` has
  // nothing to hold. Covering it needs a presence-only entry kind, which is a
  // change to what this manifest MEANS rather than another row in it. Recorded
  // in the backlog rather than bolted on as an empty array, because an entry
  // whose mustContain is [] asserts nothing and reads exactly like one that does.
];

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

// Returns human-readable violations of CONSTRAINT_CONTRACT: an entry per absent
// or narrowed constraint. Empty array = healthy. Exported for unit testing;
// called by initDb after the schema apply, same as the index check.
async function findViolatedConstraintContracts(db = pool) {
  // pg_get_constraintdef renders a CHECK ... IN (...) as
  // "CHECK ((status = ANY (ARRAY['pending'::text, ...])))", so a required value
  // is matched as the quoted literal. That holds for varchar columns too, where
  // the cast reads ::character varying but the quoted literal is unchanged.
  const { rows } = await db.query(
    `SELECT t.relname AS tbl, c.conname, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND c.conname = ANY($1)`,
    [CONSTRAINT_CONTRACT.map((c) => c.constraint)]
  );
  // Keyed on TABLE.constraint, not the bare name: see the manifest header. A
  // name that exists only on some other table now misses this lookup and is
  // reported ABSENT, which is the honest answer, rather than quietly satisfying
  // the contract with an unrelated table's definition.
  const defByKey = new Map(rows.map((r) => [`${r.tbl}.${r.conname}`, r.def]));

  const violations = [];
  for (const { table, constraint, mustContain } of CONSTRAINT_CONTRACT) {
    const def = defByKey.get(`${table}.${constraint}`);
    if (!def) {
      violations.push(`${table}.${constraint} is ABSENT — the column accepts anything`);
      continue;
    }
    // Matched as the QUOTED literal, which is what makes this safe against the
    // shape it looks unsafe against: 'open' is NOT a substring of 'reopen' once
    // both quotes are required, and the same holds for prefixes and suffixes
    // ('pending' vs 'pending_review', 'paid' vs 'unpaid'). Verified rather than
    // assumed, 2026-08-20; the backlog carried the opposite claim.
    //
    // The residual hole is a MULTI-ARM check whose arms are about different
    // columns, where the literal could be found in the wrong arm. Every
    // contracted constraint here is single-column today (archive_reason's two
    // arms are both about archive_reason), so it is latent; closing it properly
    // needs the column name and a scoped extractor, not a tighter substring.
    const missing = mustContain.filter((v) => !def.includes(`'${v}'`));
    if (missing.length > 0) {
      violations.push(`${table}.${constraint} is NARROWED — missing: ${missing.join(', ')}`);
    }
  }
  return violations;
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

    // Schema-trap sweep (2026-08-14): assert the load-bearing CHECK constraints
    // still carry their required values. A constraint defined twice with
    // differing bodies is live in its NARROW form for the seconds between the two
    // blocks on every boot, and the DO-block wrapper swallows any failure — so
    // before this check, a narrowed or absent constraint booted green. Same
    // alert-don't-wedge contract as the index check above: route into
    // `unexpected` (Sentry + loud log), never a hard boot crash.
    try {
      for (const violation of await findViolatedConstraintContracts(client)) {
        unexpected.push({
          code: 'CONSTRAINT_CONTRACT_VIOLATED',
          message: `constraint contract violated after schema apply: ${violation}`,
          stmt: violation,
        });
        console.error(`Constraint contract VIOLATED after schema apply: ${violation}`);
      }
    } catch (checkErr) {
      unexpected.push({
        code: 'CONSTRAINT_CONTRACT_CHECK_FAILED',
        message: `constraint contract check failed: ${checkErr.message.split('\n')[0]}`,
        stmt: 'findViolatedConstraintContracts',
      });
      console.error('Constraint contract check FAILED (non-fatal):', checkErr.message.split('\n')[0]);
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

// CRITICAL_INDEXES is exported so the test derives its expectations from the
// manifest instead of restating it — the restated copies went stale the first
// time an index was added (duty_lines, 2026-08) and the guard's own suite was
// then red on every run, which is a guard nobody reads.
module.exports = {
  pool, initDb, splitStatements,
  findMissingCriticalIndexes, CRITICAL_INDEXES,
  findViolatedConstraintContracts, CONSTRAINT_CONTRACT,
};

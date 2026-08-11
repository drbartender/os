'use strict';

// verify-marketing-schema: assert the marketing tag / do-not-contact objects
// are installed AND have the definition this code expects.
//
//   node server/scripts/verify-marketing-schema.js
//
// READ-ONLY. It deliberately does NOT call initDb(): initDb re-applies all of
// schema.sql, which would heal the exact failure this script exists to detect
// (a deploy where a statement was silently swallowed) and would report OK. It
// is also why this is safe to run against prod: catalog reads only, no DDL, no
// locks, no seeds.
//
// WHY IT CHECKS DEFINITIONS, NOT JUST NAMES
// -----------------------------------------
// An enumerated CHECK installed under a guarded IF NOT EXISTS is write-once:
// widening the list in schema.sql never reaches an already-booted database,
// while the server allowlist, the client mirror, and the drift test (which
// reads schema.sql's text, not the DB) all still pass. A name-only check would
// pass too. So the tag CHECK is compared against the vocabulary this code
// actually enforces.
//
// Exits non-zero on the first problem, so a runbook step or CI can gate on it.

require('dotenv').config();
const { pool } = require('../db');
const { MARKETING_TAGS } = require('../utils/marketingTags');

const WANT_COLUMNS = [
  'marketing_excluded',
  'marketing_excluded_at',
  'marketing_excluded_by',
  'marketing_excluded_reason',
];
const WANT_INDEXES = [
  'idx_client_tags_tag',
  'idx_clients_marketing_excluded',
  'idx_message_log_client_created',
];

(async () => {
  let ok = true;
  const fail = (msg) => { console.error(`  FAIL ${msg}`); ok = false; };

  try {
    const table = (await pool.query("SELECT to_regclass('public.client_tags') AS t")).rows[0].t;
    if (!table) fail('table client_tags is missing');

    const cols = (await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'clients' AND column_name = ANY($1)`, [WANT_COLUMNS]
    )).rows.map(r => r.column_name);
    for (const c of WANT_COLUMNS) if (!cols.includes(c)) fail(`column clients.${c} is missing`);

    const idx = (await pool.query(
      'SELECT indexname FROM pg_indexes WHERE indexname = ANY($1)', [WANT_INDEXES]
    )).rows.map(r => r.indexname);
    for (const i of WANT_INDEXES) if (!idx.includes(i)) fail(`index ${i} is missing`);

    // Relation-scoped: pg_constraint.conname is unique per relation, not
    // globally, so an unscoped lookup can match someone else's constraint.
    const defs = new Map((await pool.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE (conrelid = 'client_tags'::regclass AND conname = 'client_tags_tag_check')
           OR (conrelid = 'clients'::regclass
               AND conname = 'clients_marketing_excluded_reason_check')`
    )).rows.map(r => [r.conname, r.def]));

    const tagDef = defs.get('client_tags_tag_check');
    if (!tagDef) {
      fail('constraint client_tags_tag_check is missing');
    } else {
      // Every tag this code accepts must be enforceable by the DB, and the DB
      // must not accept a tag this code rejects.
      const inDb = [...tagDef.matchAll(/'([a-z_-]+)'/g)].map(m => m[1]).sort();
      const inCode = MARKETING_TAGS.map(t => t.id).sort();
      if (JSON.stringify(inDb) !== JSON.stringify(inCode)) {
        fail(`client_tags_tag_check is stale.\n     DB enforces: ${inDb.join(', ')}\n     code expects: ${inCode.join(', ')}`);
      }
    }

    if (!defs.get('clients_marketing_excluded_reason_check')) {
      fail('constraint clients_marketing_excluded_reason_check is missing');
    }

    console.log(ok ? 'marketing schema OK' : 'marketing schema INCOMPLETE');
  } catch (err) {
    console.error('marketing schema CHECK FAILED:', err.message);
    ok = false;
  } finally {
    await pool.end();
  }

  process.exit(ok ? 0 : 1);
})();

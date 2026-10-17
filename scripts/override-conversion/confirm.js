#!/usr/bin/env node
'use strict';
// The conversion's confirmation (plan 2026-10-16-price-override-removal, Task V4
// runbook step 7; spec 8.5). Read-only, over pg, against a branch cut AFTER the
// forward block ran (on the rehearsal, the rehearsal branch itself), so no data
// passes through a chat.
//
//   node scripts/override-conversion/confirm.js <uri-file> <changes.json> [--also-held <id,...>]
//
// Clean means: no booking carries an override outside the legal-hold list (a
// converted one, one still on Dallas's list, or a new one all fail it); every
// changed row holds exactly the approved after-state (every key of its lines and
// snapshot); every changed row's snapshot total equals total_price; every contract refund with a
// drop has its line, sits on an override-absorbed booking, or is on Dallas's
// list; and every changed row has its activity record. Held bookings are
// dropped by the seam and only counted; their ids are never printed.

const { heldCheck, parseIdList, readUriFile, pgConfig, readJson, argValue } = require('./shared');
const { canonical } = require('./transform');

const OVERRIDES = `SELECT id FROM proposals WHERE total_price_override IS NOT NULL
                     AND ($1::int[] IS NULL OR id = ANY($1)) ORDER BY id`;
const SNAPSHOT_TOTAL = `SELECT id FROM proposals WHERE id = ANY($1)
                          AND (pricing_snapshot->>'total')::numeric IS DISTINCT FROM total_price ORDER BY id`;
const UNLINED_REFUNDS = `SELECT r.id, r.proposal_id FROM proposal_refunds r JOIN proposals p ON p.id = r.proposal_id
   WHERE r.status = 'succeeded' AND r.total_scope = 'contract' AND r.total_price_before > r.total_price_after
     AND ($1::int[] IS NULL OR p.id = ANY($1))
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(p.adjustments) = 'array' THEN p.adjustments ELSE '[]'::jsonb END) e
         WHERE e->>'refund_id' = r.id::text)
   ORDER BY r.proposal_id, r.id`;
const LOGGED = `SELECT DISTINCT proposal_id FROM proposal_activity_log
                 WHERE details->>'run' = $1 AND proposal_id = ANY($2)
                   AND action IN ('price_override_converted', 'refund_line_backfilled')`;
const WRITTEN = 'SELECT id, adjustments, pricing_snapshot FROM proposals WHERE id = ANY($1)';

/**
 * @param {object} db  a pg client or pool on the converted database
 * @param {{ changes, dallasLists, absorbedRefunds }} planned  run.js's changes.json
 * @param {{ extraHeldIds?: number[], scopeIds?: number[]|null, tag?: string|null }} [opts]
 *   scopeIds narrows the global checks to those bookings (tests only)
 */
async function confirmConversion(db, planned, { extraHeldIds = [], scopeIds = null, tag = null } = {}) {
  const isHeld = heldCheck(extraHeldIds);
  const changed = planned.changes.map((c) => c.id);
  const converted = new Set(planned.changes.filter((c) => c.kind !== 'refund_backfill').map((c) => c.id));
  const listed = new Set(Object.values(planned.dallasLists).flat().map((e) => e.id));
  const absorbed = new Set(planned.absorbedRefunds.map((a) => a.proposalId));
  const failures = {
    convertedStillOverridden: [], listedOverrides: [], unexpectedOverrides: [], snapshotTotal: [], uncoveredRefunds: [], missingLog: [],
    contentMismatch: [],
  };
  let heldOverrides = 0;
  for (const { id } of (await db.query(OVERRIDES, [scopeIds])).rows) {
    if (isHeld(id)) heldOverrides += 1;
    else if (converted.has(id)) failures.convertedStillOverridden.push(id);
    else if (listed.has(id)) failures.listedOverrides.push(id);
    else failures.unexpectedOverrides.push(id);
  }
  failures.snapshotTotal = (await db.query(SNAPSHOT_TOTAL, [changed])).rows.map((r) => r.id);
  // Every key of what each row holds against the approved change set, read over
  // pg, never through the pasted block: a slip the in-block arithmetic cannot see
  // (a label, visible, source, refund_id or breakdown row) still shows here.
  const stored = new Map((await db.query(WRITTEN, [changed])).rows.map((r) => [r.id, r]));
  for (const c of planned.changes) {
    const row = stored.get(c.id);
    if (!row || canonical(row.adjustments) !== canonical(c.after.adjustments)
      || canonical(row.pricing_snapshot) !== canonical(c.after.pricing_snapshot)) failures.contentMismatch.push(c.id);
  }
  const listedRefunds = [];
  for (const r of (await db.query(UNLINED_REFUNDS, [scopeIds])).rows) {
    if (isHeld(r.proposal_id) || absorbed.has(r.proposal_id)) continue;
    if (listed.has(r.proposal_id)) listedRefunds.push(r.id);
    else failures.uncoveredRefunds.push({ refundId: r.id, proposalId: r.proposal_id });
  }
  if (tag) {
    const logged = new Set((await db.query(LOGGED, [tag, changed])).rows.map((r) => r.proposal_id));
    failures.missingLog = changed.filter((pid) => !logged.has(pid));
  }
  const clean = Object.values(failures).every((list) => list.length === 0);
  return { clean, failures, heldOverrides, listedRefunds };
}

async function main(argv) {
  const [uriFile, changesFile] = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] || '').startsWith('--'));
  if (!uriFile || !changesFile) throw new Error('usage: confirm.js <uri-file> <changes.json> [--also-held <id,...>]');
  const planned = readJson(changesFile);
  const { Client } = require('pg');
  const client = new Client(pgConfig(readUriFile(uriFile)));
  await client.connect();
  let out;
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    out = await confirmConversion(client, planned, { extraHeldIds: parseIdList(argValue(argv, '--also-held')), tag: planned.tag });
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
  console.log(`run ${planned.tag}: ${planned.changes.length} changed bookings checked; `
    + `${out.heldOverrides} held booking(s) keep an override (counted, never named); `
    + `${out.listedRefunds.length} unlined refund(s) on Dallas's list`);
  for (const [name, list] of Object.entries(out.failures)) {
    if (list.length) console.log(`  FAIL ${name}: ${JSON.stringify(list)}`);
  }
  console.log(out.clean ? 'confirmation clean' : 'confirmation NOT clean');
  if (!out.clean) process.exitCode = 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`confirm.js: ${err && err.message}`);
    process.exit(1);
  });
}

module.exports = { confirmConversion };

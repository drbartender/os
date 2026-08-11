#!/usr/bin/env node
'use strict';
// One-off (spec 2026-08-03): strip self-elected checkout gratuity from UNPAID
// proposals. Before election-at-payment shipped, create-intent persisted the
// client's "Skip the tip jar" click immediately — an abandoned checkout left a
// Gratuity line baked into the quote (Delara, proposal 665). Paid proposals are
// NEVER touched.
//   node scripts/reset-unpaid-gratuity.js           # dry run (default)
//   node scripts/reset-unpaid-gratuity.js --apply   # write
//
// This runs against PROD once, by hand, so it is built to be auditable:
//   - it prints the resolved DB target (host + database, never credentials), so
//     the reviewed dry run is provably the same target as the apply;
//   - --apply is ONE transaction: a ~14-row cleanup lands whole or not at all;
//   - a row counts as RESET only if its UPDATE actually matched;
//   - anything it cannot recompute safely is SKIPPED for a hand fix, never
//     guessed at (three guards below).
require('dotenv').config();
const { pool } = require('../server/db');
const { recomputeSnapshotGratuity } = require('../server/utils/pricingEngine');

/** Host + database ONLY — never user/password. Proves which DB a run hit. */
function describeTarget() {
  try {
    const u = new URL(process.env.DATABASE_URL);
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch {
    return '(DATABASE_URL missing or unparseable)';
  }
}

/** Proposals money is DOLLARS; compare in integer cents, never float equality. */
const cents = (n) => Math.round(Number(n) * 100);

async function resetUnpaidGratuity({ apply = false } = {}) {
  console.log(`TARGET DB: ${describeTarget()}  |  MODE: ${apply ? 'APPLY (writes)' : 'DRY RUN'}`);
  const { rows } = await pool.query(`
    SELECT id, total_price, amount_paid, pricing_snapshot, event_duration_hours
      FROM proposals
     WHERE COALESCE(amount_paid, 0) = 0
       AND (COALESCE(gratuity_rate, 0) > 0
            OR COALESCE((pricing_snapshot->'gratuity'->>'total')::numeric, 0) > 0)
       AND gratuity_floor_rate IS NULL
     ORDER BY id`);
  // gratuity_floor_rate guard (spec 2026-08-10): an ADMIN-MANDATED gratuity is
  // exactly the shape this script hunts (unpaid, rate > 0) but is deliberate;
  // a re-run must never strip mandated quotes.
  // Snapshot-carried OR column-carried: prod proposal 580 holds a $400 gratuity
  // in its snapshot/total with a ZERO column (pre-existing drift, found at
  // review) — a column-only WHERE would leave that Delara-shaped row behind.

  const changed = [];
  const skipped = [];
  const raced = [];
  const skip = (id, reason) => {
    skipped.push({ id, reason });
    console.log(`#${id}: SKIPPED (${reason} — fix by hand)`);
  };

  // Classify every row first (pure, no writes), then apply in ONE transaction.
  const planned = [];
  for (const row of rows) {
    if (Number(row.amount_paid) > 0) throw new Error(`paid row ${row.id} matched — refusing`);
    const snap = row.pricing_snapshot || {};
    // Degenerate snapshot (legacy '{}' rows): recomputeSnapshotGratuity resolves
    // no basis and returns total 0, which would ZERO a real proposal's price.
    // Mirrors the webhook's degenerate_snapshot refusal (spec 2026-08-03 §4.5).
    if (!(Number(snap.total) > 0)) { skip(row.id, 'degenerate_snapshot'); continue; }
    // Column/snapshot drift (archived #500 carries a 300 total against a 400
    // snapshot): the snapshot is NOT the authority for such a row, so recomputing
    // the total from it would write a number the proposal never had.
    if (cents(row.total_price) !== cents(snap.total)) { skip(row.id, 'total_mismatch'); continue; }
    const newSnap = recomputeSnapshotGratuity(snap, {
      gratuityRate: 0, tipJar: true,
      staffNoun: snap.staff_noun, durationHours: row.event_duration_hours,
    });
    // Belt for a snapshot whose ONLY line was the gratuity: stripping it must
    // never zero a proposal's total. A $0 service total on a matched row means
    // something is wrong with that row, not that we should write $0.
    if (!(Number(newSnap.total) > 0)) { skip(row.id, 'degenerate_result'); continue; }
    planned.push({ row, newSnap });
  }

  const record = (row, newSnap) => {
    changed.push({ id: row.id, from: Number(row.total_price), to: newSnap.total });
    console.log(`#${row.id}: total ${row.total_price} -> ${newSnap.total}`);
  };

  if (!apply) {
    for (const { row, newSnap } of planned) record(row, newSnap);
  } else {
    // ONE transaction, one pooled client, every query on it, released in finally
    // (one-connection invariant). Any error rolls the whole cleanup back.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const { row, newSnap } of planned) {
        const res = await client.query(
          `UPDATE proposals SET tip_jar = true, gratuity_rate = 0,
                  gratuity_rate_change_origin = NULL,
                  pricing_snapshot = $1, total_price = $2, updated_at = NOW()
            WHERE id = $3 AND COALESCE(amount_paid, 0) = 0
              AND gratuity_floor_rate IS NULL`,
          [JSON.stringify(newSnap), newSnap.total, row.id]
        );
        // rowCount 0 = a re-check dropped it: a payment landed OR an admin
        // mandate (spec 2026-08-10) was set between the SELECT and this UPDATE.
        // Report it; never claim a reset that did not happen.
        if (res.rowCount === 0) {
          raced.push({ id: row.id, reason: 'recheck_dropped' });
          console.log(`#${row.id}: RACED (a payment or an admin mandate landed mid-run — NOT reset)`);
        } else {
          record(row, newSnap);
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(
    `${changed.length} unpaid proposals ${apply ? 'RESET' : 'would be reset (dry run — pass --apply)'}`
    + `; ${skipped.length} SKIPPED; ${raced.length} RACED`
  );
  if (skipped.length) {
    console.log(`SKIPPED (need a hand fix): ${skipped.map(s => `#${s.id} (${s.reason})`).join(', ')}`);
  }
  if (raced.length) {
    console.log(`RACED (paid mid-run, re-check by hand): ${raced.map(r => `#${r.id}`).join(', ')}`);
  }
  return { examined: rows.length, changed, skipped, raced };
}

if (require.main === module) {
  resetUnpaidGratuity({ apply: process.argv.includes('--apply') })
    .then(() => pool.end())
    .catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { resetUnpaidGratuity };

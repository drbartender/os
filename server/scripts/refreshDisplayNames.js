'use strict';

// Backfill and audit for contractor_profiles.display_name. Spec §6, §7.
//
//   node -r dotenv/config server/scripts/refreshDisplayNames.js --stamp-existing
//        first run only: populate display_name AND mark every existing row as
//        already reviewed, so the §3.5 notice queue opens empty instead of with
//        one notice per staffer who has been fine all year. REFUSES to run once
//        any row already carries a stamp (that means it is not a first run);
//        add --i-mean-it to override, which is irreversible.
//
//   node -r dotenv/config server/scripts/refreshDisplayNames.js
//        ordinary re-run: populate display_name, touch NO review stamps.
//
//   node -r dotenv/config server/scripts/refreshDisplayNames.js --check
//        audit only: exit non-zero if any stored display_name differs from a
//        fresh computation. The safety net for a write path someone adds later
//        and forgets to wire to refreshDisplayName().
//
// --stamp-existing is deliberately opt-in and NOT the default. If the default
// stamped, a routine post-go-live re-run would silently ack every pending
// notice, which is exactly the state the notice exists to prevent.
//
// This script NEVER rewrites a stored preferred_name beyond trimming
// whitespace. Shortening is a display concern and lives in display_name, so
// nobody's stored name is second-guessed by a script (spec §6).

require('dotenv').config();
const { pool } = require('../db');
const { computeDisplayName } = require('../utils/staffDisplayName');
const { validatePreferredName } = require('../utils/staffDisplayName.validate');

const CHECK_ONLY = process.argv.includes('--check');
const STAMP_EXISTING = process.argv.includes('--stamp-existing');
const I_MEAN_IT = process.argv.includes('--i-mean-it');

async function main() {
  // --stamp-existing is a one-way door: it acks every pending name notice and
  // there is no record of which stamps it invented. A second accidental run
  // (wrong terminal, shell history, a re-deploy script) would silently swallow
  // every notice raised since go-live. Any existing stamp proves this is not a
  // first run, so refuse unless someone says so a second time, out loud.
  if (STAMP_EXISTING && !I_MEAN_IT) {
    const { rows: [{ n }] } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM contractor_profiles WHERE preferred_name_reviewed_at IS NOT NULL'
    );
    if (n > 0) {
      console.error(
        `REFUSING --stamp-existing: ${n} row(s) already carry preferred_name_reviewed_at, so this is not a first run.\n` +
        'Stamping again would silently acknowledge every pending name notice, and it cannot be undone.\n' +
        'Re-run with --i-mean-it if that is genuinely what you want.'
      );
      await pool.end();
      process.exit(1);
    }
  }

  const { rows } = await pool.query(
    `SELECT cp.user_id, cp.preferred_name, cp.display_name,
            u.onboarding_status,
            COALESCE(ag.full_name, ap.full_name) AS legal_name
       FROM contractor_profiles cp
       JOIN users u ON u.id = cp.user_id
       LEFT JOIN agreements   ag ON ag.user_id = cp.user_id
       LEFT JOIN applications ap ON ap.user_id = cp.user_id
      ORDER BY cp.user_id`
  );

  let drift = 0, updated = 0, trimmed = 0, stamped = 0;
  const needsHuman = [];
  const needsLegalName = [];

  for (const r of rows) {
    const trimmedName = String(r.preferred_name || '').trim().replace(/\s+/g, ' ');
    const expected = computeDisplayName({ preferredName: trimmedName, legalFullName: r.legal_name });

    if (CHECK_ONLY) {
      if (expected !== r.display_name) {
        drift++;
        console.log(`DRIFT user ${r.user_id}: stored ${JSON.stringify(r.display_name)} != computed ${JSON.stringify(expected)}`);
      }
      continue;
    }

    // The ONLY write here that touches a real profile field, so the ONLY one
    // that carries updated_at (see the display_name UPDATE below for why that
    // matters).
    if (trimmedName && trimmedName !== r.preferred_name) {
      await pool.query(
        'UPDATE contractor_profiles SET preferred_name = $1, updated_at = NOW() WHERE user_id = $2',
        [trimmedName, r.user_id]
      );
      trimmed++;
    }

    // Conditional, and deliberately WITHOUT updated_at. Two reasons:
    //   1. smsInbound.js lookupSender resolves a shared inbound number to one
    //      staff account with `ORDER BY cp.updated_at DESC LIMIT 1`. Stamping
    //      every row on every run re-arms an arbitrary pick, so a routine
    //      backfill could silently move where a STOP lands.
    //   2. display_name is derived. A run that changes nothing must report
    //      nothing, or the audit trail cannot tell a no-op from a rewrite.
    const upd = await pool.query(
      'UPDATE contractor_profiles SET display_name = $1 WHERE user_id = $2 AND display_name IS DISTINCT FROM $1',
      [expected, r.user_id]
    );
    updated += upd.rowCount;

    // Same no-updated_at rule. Only stamps a row that has never been stamped,
    // so the write is idempotent and never re-dates an older review.
    if (STAMP_EXISTING) {
      const st = await pool.query(
        `UPDATE contractor_profiles
            SET preferred_name_reviewed_at = NOW()
          WHERE user_id = $1 AND preferred_name_reviewed_at IS NULL`,
        [r.user_id]
      );
      stamped += st.rowCount;
    }

    // Report only. A script does not get to decide what someone is called.
    const check = validatePreferredName(trimmedName);
    if (trimmedName && !check.valid) {
      needsHuman.push(`  user ${r.user_id}: ${JSON.stringify(trimmedName)} (${check.error}) -> renders ${JSON.stringify(expected)}`);
    }
    if (!r.legal_name && r.onboarding_status !== 'deactivated') {
      needsLegalName.push(`  user ${r.user_id}: ${JSON.stringify(trimmedName)} has no agreement or application on file`);
    }
  }

  if (CHECK_ONLY) {
    // An empty table is not a clean audit, it is the shape a wrong or unset
    // DATABASE_URL takes: zero rows, zero drift, exit 0, "everything is fine".
    // Every real database this runs against has staff in it.
    if (rows.length === 0) {
      console.error('FAIL: 0 contractor_profiles rows. Nothing was audited. Check DATABASE_URL.');
      await pool.end();
      process.exit(1);
    }
    console.log(drift === 0 ? `OK: ${rows.length} rows, no drift` : `FAIL: ${drift} row(s) drifted`);
    await pool.end();
    process.exit(drift === 0 ? 0 : 1);
  }

  console.log(`Checked ${rows.length} rows: ${updated} display_name change(s), ${trimmed} whitespace fix(es)${STAMP_EXISTING ? `, ${stamped} newly marked reviewed` : ', review stamps untouched'}.`);
  if (needsHuman.length) console.log(`\nMalformed preferred names, fix by hand:\n${needsHuman.join('\n')}`);
  if (needsLegalName.length) console.log(`\nActive staff with no legal name on file:\n${needsLegalName.join('\n')}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });

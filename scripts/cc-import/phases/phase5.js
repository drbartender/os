/**
 * Phase 5 — Payouts archive (with re-run-safe cascade).
 *
 *  - Load `report (5).csv` (116 rows; Date, Amount, Payee, Reference, Category)
 *    into `legacy_cc_raw_imports` + `legacy_cc_payouts`.
 *  - Re-run guard (spec §8.5 step 2): for each row, look up the existing
 *    `legacy_cc_payouts.payee_user_id` keyed by raw_import_id. If non-null —
 *    set by a prior Phase 5 run OR by operator via Section 9.3.E
 *    `/unmatched-payee/.../link` — KEEP it. Do NOT re-derive (this prevents
 *    Phase 5 re-runs from routing a payee whose stub the operator has already
 *    promoted into a fresh stub).
 *  - For rows still unresolved (`payee_user_id IS NULL` or brand-new), run
 *    the Section 7.3 fuzzy cascade against `users` (real + Phase 1 stubs).
 *    Single match → use that user id. Zero or multi-match → leave NULL
 *    (operator resolves on the Review page in Batch 9).
 *  - INSERT ... ON CONFLICT (raw_import_id) DO NOTHING for idempotency.
 *
 * Phase 5 is intentionally minimal: no event link (CSV doesn't carry one), no
 * promotion to native, no per-row status mutation on the raw row (the raw row
 * stays at the default `'pending'` once written — Phase 5's "archive" is the
 * presence of the `legacy_cc_payouts` row itself; no consumer reads the
 * raw-import `import_status` for payouts).
 *
 * Spec reference: docs/superpowers/specs/2026-05-25-checkcherry-import-design.md §6.4, §8.5.
 * Plan reference: docs/superpowers/plans/2026-05-26-checkcherry-import.md Task 16.
 */

const path = require('path');
const crypto = require('crypto');
const { pool } = require('../lib/db');
const { startRun, finishRun } = require('../lib/runLog');
const { loadCsv } = require('../lib/csv');
const { parseCcDate } = require('../lib/dateFmt');
const { parseMoneyCents } = require('../lib/money');
const { findByName, normalize } = require('../lib/fuzzyName');

const SOURCE_FILE = 'report (5).csv';
const SOURCE_ENTITY = 'payouts';

// ── small helpers ────────────────────────────────────────────────────────

function rowHash(row) {
  return crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
}

/** Look up a column tolerating whitespace-padded header keys (CC quirk). */
function getCol(row, ...candidates) {
  for (const col of candidates) {
    if (Object.prototype.hasOwnProperty.call(row, col)) {
      const v = row[col];
      if (v != null && String(v).trim() !== '') return v;
    }
    for (const k of Object.keys(row)) {
      if (k.trim() === col) {
        const v = row[k];
        if (v != null && String(v).trim() !== '') return v;
      }
    }
  }
  return undefined;
}

function trimOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

/** Format a Date as `YYYY-MM-DD` (UTC) for DATE-column writes. */
function dateOnly(d) {
  return d.toISOString().slice(0, 10);
}

// ── raw_imports helper ──────────────────────────────────────────────────

/**
 * INSERT (or upsert) one CC row into `legacy_cc_raw_imports`. Returns the
 * BIGSERIAL id. Payouts have no CC payout id — `cc_id` stays NULL. The ON
 * CONFLICT path resets the status to 'pending' on re-runs so a prior-run
 * 'errored' status doesn't poison the current pass.
 */
async function recordRawImport(client, sourceRowNumber, row) {
  const payload = JSON.stringify(row);
  const hash = rowHash(row);
  const r = await client.query(
    `INSERT INTO legacy_cc_raw_imports
       (source_file, source_entity, source_row_number, source_row_hash, cc_id, payload)
     VALUES ($1, $2, $3, $4, NULL, $5::jsonb)
     ON CONFLICT (source_file, source_row_number) DO UPDATE
       SET source_row_hash = EXCLUDED.source_row_hash,
           payload = EXCLUDED.payload,
           import_status = 'pending',
           import_notes = NULL
     RETURNING id`,
    [SOURCE_FILE, SOURCE_ENTITY, sourceRowNumber, hash, payload]
  );
  return r.rows[0].id;
}

// ── runner ──────────────────────────────────────────────────────────────

/**
 * Phase 5 entry point. Idempotent, re-run-safe.
 *
 * @param {object} options
 * @param {string} options.ccDir       — directory containing `report (5).csv`
 * @param {Function} [options.loadCsv] — DI override for tests
 * @param {Function} [options.captureMessage] — Sentry DI; defaults to require('@sentry/node').captureMessage
 * @param {Function} [options.captureException] — Sentry DI
 * @returns {Promise<{
 *   processed:number, inserted:number, skipped:number, errored:number,
 *   resolved:number, unmatched:number, preservedExistingLink:number,
 *   samples:Array<object>, runId:number,
 * }>}
 */
async function run({
  ccDir,
  loadCsv: loadCsvFn = loadCsv,
  captureMessage = null,
  captureException = null,
} = {}) {
  if (!ccDir) throw new Error('phase5.run: ccDir is required');

  const runId = await startRun(5);
  const samples = [];
  let processed = 0;
  let inserted = 0;            // new legacy_cc_payouts rows written this run
  let skipped = 0;             // ON CONFLICT (raw_import_id) — row already existed
  let errored = 0;
  let resolved = 0;            // rows we set payee_user_id on (fresh derive this run)
  let unmatched = 0;           // rows where payee_user_id stayed NULL (zero-/multi-match)
  let preservedExistingLink = 0; // rows where the re-run guard fired

  function sendSummary(level, extra) {
    try {
      let send = captureMessage;
      if (!send) {
        const Sentry = require('@sentry/node');
        send = Sentry.captureMessage.bind(Sentry);
      }
      send('cc-import phase 5 summary', { level, extra });
    } catch (_) {
      // Sentry must never break the importer.
    }
  }

  function reportException(err, tags) {
    try {
      let send = captureException;
      if (!send) {
        const Sentry = require('@sentry/node');
        send = Sentry.captureException.bind(Sentry);
      }
      send(err, { tags });
    } catch (_) {
      // best-effort
    }
  }

  let rows;
  try {
    rows = loadCsvFn(path.join(ccDir, SOURCE_FILE));
  } catch (err) {
    samples.push({ file: SOURCE_FILE, error: `Could not load CSV: ${err.message}` });
    sendSummary('warning', { phase: 5, processed: 0, inserted: 0, errored: 0, skipped: 0, samples });
    await finishRun(runId, {
      status: 'failed',
      rowsProcessed: 0, rowsInserted: 0, rowsSkipped: 0, rowsErrored: 0,
      errorSummary: `phase 5: failed to load ${SOURCE_FILE}: ${err.message}`,
      notes: samples,
    });
    return {
      processed: 0, inserted: 0, skipped: 0, errored: 0,
      resolved: 0, unmatched: 0, preservedExistingLink: 0,
      samples, runId,
    };
  }

  // Per-row processing on the shared pool. Each row is independent (no shared
  // transaction) — the raw_imports + legacy_cc_payouts pair are written on
  // separate statements but never in a way that leaves one without the other:
  // recordRawImport always succeeds (ON CONFLICT DO UPDATE), and the payouts
  // INSERT either lands or is skipped by ON CONFLICT (raw_import_id). On a
  // payouts-row exception we mark the raw row 'errored' for the Review page.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const sourceRowNumber = i + 1;
    processed++;

    const client = await pool.connect();
    let rawImportId = null;
    try {
      rawImportId = await recordRawImport(client, sourceRowNumber, row);

      const payeeName = trimOrNull(getCol(row, 'Payee', 'Payee Name'));
      const paidOn = parseCcDate(getCol(row, 'Date', 'Paid On', 'Payment Date'));
      const amountCents = parseMoneyCents(getCol(row, 'Amount'));
      const reference = trimOrNull(getCol(row, 'Reference', 'Reference Role'));
      const category = trimOrNull(getCol(row, 'Category'));

      // Validate the NOT NULL columns before we touch the cascade. payee_name
      // and paid_on and amount_cents are NOT NULL in `legacy_cc_payouts`.
      if (!payeeName) {
        errored++;
        if (samples.length < 5) samples.push({ rowNum: sourceRowNumber, error: 'payee_missing' });
        await client.query(
          `UPDATE legacy_cc_raw_imports SET import_status = 'errored', import_notes = $2::jsonb
            WHERE id = $1`,
          [rawImportId, JSON.stringify({ error: 'payee_missing', source_row_number: sourceRowNumber })]
        );
        continue;
      }
      if (!paidOn) {
        errored++;
        if (samples.length < 5) samples.push({ rowNum: sourceRowNumber, error: 'paid_on_unparseable', value: getCol(row, 'Date') });
        await client.query(
          `UPDATE legacy_cc_raw_imports SET import_status = 'errored', import_notes = $2::jsonb
            WHERE id = $1`,
          [rawImportId, JSON.stringify({
            error: 'paid_on_unparseable', source_row_number: sourceRowNumber,
            raw_date: getCol(row, 'Date') ?? null,
          })]
        );
        continue;
      }
      if (amountCents == null) {
        errored++;
        if (samples.length < 5) samples.push({ rowNum: sourceRowNumber, error: 'amount_unparseable', value: getCol(row, 'Amount') });
        await client.query(
          `UPDATE legacy_cc_raw_imports SET import_status = 'errored', import_notes = $2::jsonb
            WHERE id = $1`,
          [rawImportId, JSON.stringify({
            error: 'amount_unparseable', source_row_number: sourceRowNumber,
            raw_amount: getCol(row, 'Amount') ?? null,
          })]
        );
        continue;
      }

      // Re-run guard (spec §8.5 step 2): keep an existing non-null
      // payee_user_id without re-deriving.
      const existingRes = await client.query(
        `SELECT payee_user_id FROM legacy_cc_payouts WHERE raw_import_id = $1`,
        [rawImportId]
      );
      const existingLink = existingRes.rowCount > 0 ? existingRes.rows[0].payee_user_id : null;

      let payeeUserId = existingLink;
      let guardFired = false;
      if (existingLink != null) {
        guardFired = true;
      } else {
        // Section 7.3 fuzzy cascade against users (real + Phase 1 stubs).
        const matches = await findByName(client, payeeName);
        if (matches.length === 1) {
          payeeUserId = matches[0];
        }
        // Zero or multi-match → leave NULL; operator resolves on Review page.
      }

      // Normalize JS-side using the exact same lowercase/trim/collapse-ws
      // formula the schema-side index uses
      // (LOWER(TRIM(regexp_replace(..., '[[:space:]]+', ' ', 'g')))).
      const payeeNameNormalized = normalize(payeeName);

      const insRes = await client.query(
        `INSERT INTO legacy_cc_payouts
           (payee_name, payee_name_normalized, payee_user_id,
            paid_on, amount_cents, reference_role, category, raw_import_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (raw_import_id) DO NOTHING
         RETURNING id`,
        [
          payeeName, payeeNameNormalized, payeeUserId,
          dateOnly(paidOn), amountCents, reference, category, rawImportId,
        ]
      );

      if (insRes.rowCount > 0) {
        inserted++;
        if (payeeUserId != null) {
          if (guardFired) preservedExistingLink++;
          else resolved++;
        } else {
          unmatched++;
        }
      } else {
        // ON CONFLICT (raw_import_id) — row already existed. The re-run guard
        // already preserved its payee_user_id, so nothing more to do; count
        // the preserved link toward the metric so re-runs report it cleanly.
        skipped++;
        if (existingLink != null) preservedExistingLink++;
      }
    } catch (err) {
      errored++;
      if (samples.length < 5) samples.push({ rowNum: sourceRowNumber, error: err.message });
      // Best-effort error-status on the raw row.
      if (rawImportId != null) {
        try {
          await client.query(
            `UPDATE legacy_cc_raw_imports SET import_status = 'errored', import_notes = $2::jsonb
              WHERE id = $1`,
            [rawImportId, JSON.stringify({ error: err.message, phase: 5, source_row_number: sourceRowNumber })]
          );
        } catch (_) { /* swallow */ }
      }
      reportException(err, { phase: 'cc_import_phase5', source_row_number: sourceRowNumber });
    } finally {
      client.release();
    }
  }

  sendSummary(errored > 0 ? 'warning' : 'info', {
    phase: 5,
    processed,
    inserted,
    skipped,
    errored,
    resolved,
    unmatched,
    preservedExistingLink,
    samples: samples.slice(0, 5),
  });

  await finishRun(runId, {
    status: errored > 0 ? 'partial' : 'succeeded',
    rowsProcessed: processed,
    rowsInserted: inserted,
    rowsSkipped: skipped,
    rowsErrored: errored,
    errorSummary: `phase 5: processed=${processed} inserted=${inserted} skipped=${skipped} ` +
      `errored=${errored} resolved=${resolved} unmatched=${unmatched} preservedExistingLink=${preservedExistingLink}`,
    notes: samples,
  });

  return {
    processed, inserted, skipped, errored,
    resolved, unmatched, preservedExistingLink,
    samples, runId,
  };
}

module.exports = { run };

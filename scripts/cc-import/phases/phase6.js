/**
 * Phase 6 — Leads + invoices archive.
 *
 *  - Load `report (12).csv` (~81 lead rows) into `legacy_cc_raw_imports`
 *    with `source_entity='leads'`.
 *  - Load `report (14).csv` (~27 invoice rows) into `legacy_cc_raw_imports`
 *    with `source_entity='invoices'`.
 *  - Both are pure archive: no separate normalized table — the
 *    `legacy_cc_raw_imports.payload` JSON IS the archive. Set
 *    `import_status = 'archived'` on insert (skip the 'pending' default since
 *    these never promote to native).
 *  - ON CONFLICT (source_file, source_row_number) DO UPDATE for re-runnability.
 *
 * Gallery / Video URLs in `report (14).csv` are R2-rewritten by Phase 0
 * (Task 11) before this phase runs against the canonical CC dir — Phase 6
 * just stores whatever URLs are in the payload at run time.
 *
 * Spec reference: docs/superpowers/specs/2026-05-25-checkcherry-import-design.md §8.6.
 * Plan reference: docs/superpowers/plans/2026-05-26-checkcherry-import.md Task 17.
 */

const path = require('path');
const crypto = require('crypto');
const { pool } = require('../lib/db');
const { startRun, finishRun } = require('../lib/runLog');
const { loadCsv } = require('../lib/csv');

const SOURCES = [
  { file: 'report (12).csv', entity: 'leads' },
  { file: 'report (14).csv', entity: 'invoices' },
];

function rowHash(row) {
  return crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
}

/**
 * Archive one row into `legacy_cc_raw_imports`. cc_id is NULL (leads &
 * invoices don't carry a CC primary identifier we'd dedup on across phases),
 * and import_status is forced to 'archived' on both INSERT and the
 * re-run UPDATE branch (these rows never promote so 'pending' is a lie).
 */
async function archiveRow(client, sourceFile, sourceEntity, sourceRowNumber, row) {
  const payload = JSON.stringify(row);
  const hash = rowHash(row);
  await client.query(
    `INSERT INTO legacy_cc_raw_imports
       (source_file, source_entity, source_row_number, source_row_hash, cc_id, payload, import_status)
     VALUES ($1, $2, $3, $4, NULL, $5::jsonb, 'archived')
     ON CONFLICT (source_file, source_row_number) DO UPDATE
       SET source_row_hash = EXCLUDED.source_row_hash,
           payload = EXCLUDED.payload,
           import_status = 'archived',
           import_notes = NULL`,
    [sourceFile, sourceEntity, sourceRowNumber, hash, payload]
  );
}

/**
 * Phase 6 entry point. Loads each CSV and archives every row. Idempotent.
 *
 * @param {object} options
 * @param {string} options.ccDir       — directory containing reports 12 + 14
 * @param {Function} [options.loadCsv] — DI for tests
 * @param {Function} [options.captureMessage]   — Sentry DI
 * @param {Function} [options.captureException] — Sentry DI
 * @returns {Promise<{
 *   processed:number, inserted:number, skipped:number, errored:number,
 *   byEntity:{leads:number, invoices:number},
 *   samples:Array<object>, runId:number,
 * }>}
 */
async function run({
  ccDir,
  loadCsv: loadCsvFn = loadCsv,
  captureMessage = null,
  captureException = null,
} = {}) {
  if (!ccDir) throw new Error('phase6.run: ccDir is required');

  const runId = await startRun(6);
  const samples = [];
  let processed = 0;
  let inserted = 0;
  let skipped = 0; // reserved for future per-CSV failure paths; archiveRow itself doesn't no-op
  let errored = 0;
  const byEntity = { leads: 0, invoices: 0 };

  function sendSummary(level, extra) {
    try {
      let send = captureMessage;
      if (!send) {
        const Sentry = require('@sentry/node');
        send = Sentry.captureMessage.bind(Sentry);
      }
      send('cc-import phase 6 summary', { level, extra });
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

  for (const { file, entity } of SOURCES) {
    let rows;
    try {
      rows = loadCsvFn(path.join(ccDir, file));
    } catch (err) {
      // Missing CSV is non-fatal (mirrors Phase 1 — operator may run a
      // subset). Record the failure in `samples` and move on; finishRun's
      // status will end up 'partial' if anything errored.
      samples.push({ file, error: `Could not load CSV: ${err.message}` });
      errored++;
      reportException(err, { phase: 'cc_import_phase6', file });
      continue;
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const sourceRowNumber = i + 1;
      processed++;

      const client = await pool.connect();
      try {
        await archiveRow(client, file, entity, sourceRowNumber, row);
        inserted++;
        byEntity[entity]++;
      } catch (err) {
        errored++;
        if (samples.length < 5) samples.push({ file, rowNum: sourceRowNumber, error: err.message });
        reportException(err, { phase: 'cc_import_phase6', file, source_row_number: sourceRowNumber });
      } finally {
        client.release();
      }
    }
  }

  sendSummary(errored > 0 ? 'warning' : 'info', {
    phase: 6,
    processed,
    inserted,
    skipped,
    errored,
    byEntity,
    samples: samples.slice(0, 5),
  });

  await finishRun(runId, {
    status: errored > 0 ? 'partial' : 'succeeded',
    rowsProcessed: processed,
    rowsInserted: inserted,
    rowsSkipped: skipped,
    rowsErrored: errored,
    errorSummary: `phase 6: processed=${processed} inserted=${inserted} skipped=${skipped} errored=${errored} ` +
      `(leads=${byEntity.leads} invoices=${byEntity.invoices})`,
    notes: samples,
  });

  return { processed, inserted, skipped, errored, byEntity, samples, runId };
}

module.exports = { run };

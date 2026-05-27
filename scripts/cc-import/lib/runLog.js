const { pool } = require('./db');

async function startRun(phase) {
  const { rows } = await pool.query(
    `INSERT INTO cc_import_runs (phase, status) VALUES ($1, 'running') RETURNING id`,
    [phase]
  );
  return rows[0].id;
}

async function finishRun(runId, { status, rowsProcessed, rowsInserted, rowsSkipped, rowsErrored, errorSummary, notes }) {
  await pool.query(
    `UPDATE cc_import_runs
        SET finished_at = NOW(), status = $1,
            rows_processed = $2, rows_inserted = $3, rows_skipped = $4, rows_errored = $5,
            error_summary = $6, notes = $7
      WHERE id = $8`,
    [status, rowsProcessed ?? 0, rowsInserted ?? 0, rowsSkipped ?? 0, rowsErrored ?? 0, errorSummary ?? null, JSON.stringify(notes ?? []), runId]
  );
}

module.exports = { startRun, finishRun };

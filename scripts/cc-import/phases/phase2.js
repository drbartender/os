/**
 * Phase 2 — Clients dedup + cc_id annotation
 *
 * 1. Load `report (9).csv` into `legacy_cc_raw_imports`.
 * 2. Per row (each under a SAVEPOINT inside an outer transaction):
 *      - Normalize email per spec §7.1 (empty / 'n/a' / 'none' / 'noemail@*'
 *        → placeholder `cc-import-noemail-<cc_id>@drbartender.local` +
 *        `email_status = 'bad'`).
 *      - Case-collision pre-check on existing `clients` table (LOWER(TRIM(email))).
 *        If > 1 match, rollback savepoint + mark raw row errored
 *        (`client_email_case_collision`).
 *      - On clean hit (single existing client): UPDATE cc_id only if currently
 *        NULL, plus canonicalize email (LOWER(TRIM)) if it differs from its
 *        already-lowercased-trimmed form. If the canonicalizing UPDATE errors
 *        (race with another client owning the lowercased email), rollback and
 *        mark errored.
 *      - No hit: INSERT new clients row (name, lowercased email, phone,
 *        source='direct', cc_id, email_status='bad' iff placeholder path).
 *      - Mark raw row promoted.
 * 3. After the loop: COMMIT outer transaction. Emit per-phase Sentry summary.
 *
 * Spec reference: docs/superpowers/specs/2026-05-25-checkcherry-import-design.md §7.1, §8.2.
 * Plan reference: docs/superpowers/plans/2026-05-26-checkcherry-import.md Task 13.
 */

const path = require('path');
const crypto = require('crypto');
const { pool } = require('../lib/db');
const { startRun, finishRun } = require('../lib/runLog');
const { loadCsv } = require('../lib/csv');
const { normalizeEmail, placeholderEmail } = require('../lib/email');

const SOURCE_FILE = 'report (9).csv';
const SOURCE_ENTITY = 'clients';

// ── helpers ──────────────────────────────────────────────────────────────

function rowHash(row) {
  return crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
}

/**
 * CC exports occasionally pad header keys with whitespace. Look up by exact
 * key first, then by trimmed key as fallback.
 */
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

// normalizeEmail + placeholderEmail moved to scripts/cc-import/lib/email.js
// (shared with Phase 3's client_email_normalized lookup). Re-exported below
// for back-compat with existing test imports.

/**
 * Build a usable client name from the CC row. Prefer the explicit `Name`
 * column; fall back to "First Last" when only those are present.
 */
function buildName(row) {
  const explicit = getCol(row, 'Name');
  if (explicit) return String(explicit).trim();
  const first = getCol(row, 'First Name');
  const last = getCol(row, 'Last Name');
  const composed = [first, last].filter(Boolean).map(s => String(s).trim()).join(' ').trim();
  return composed || null;
}

// ── raw_imports helpers (re-import refreshes payload + status) ───────────

async function recordRawImport(client, sourceRowNumber, row, ccId) {
  const payload = JSON.stringify(row);
  const hash = rowHash(row);
  const r = await client.query(
    `INSERT INTO legacy_cc_raw_imports
       (source_file, source_entity, source_row_number, source_row_hash, cc_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (source_file, source_row_number) DO UPDATE
       SET source_row_hash = EXCLUDED.source_row_hash,
           payload = EXCLUDED.payload,
           cc_id = EXCLUDED.cc_id,
           import_status = 'pending',
           import_notes = NULL
     RETURNING id`,
    [SOURCE_FILE, SOURCE_ENTITY, sourceRowNumber, hash, ccId, payload]
  );
  return r.rows[0].id;
}

async function markRawErrored(execClient, rawImportId, error) {
  await execClient.query(
    `UPDATE legacy_cc_raw_imports
        SET import_status = 'errored', import_notes = $2::jsonb
      WHERE id = $1`,
    [rawImportId, JSON.stringify(error)]
  );
}

async function markRawPromoted(execClient, rawImportId) {
  await execClient.query(
    `UPDATE legacy_cc_raw_imports
        SET import_status = 'promoted', import_notes = NULL
      WHERE id = $1 AND import_status NOT IN ('errored', 'promoted')`,
    [rawImportId]
  );
}

// ── core runner ──────────────────────────────────────────────────────────

async function run({ ccDir, loadCsv: loadCsvFn = loadCsv, captureMessage = null } = {}) {
  if (!ccDir) throw new Error('phase2.run: ccDir is required');

  const runId = await startRun(2);
  const samples = [];
  let processed = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let errored = 0;

  function sendSummary(level, extra) {
    try {
      let send = captureMessage;
      if (!send) {
        const Sentry = require('@sentry/node');
        send = Sentry.captureMessage.bind(Sentry);
      }
      send('cc-import phase 2 summary', { level, extra });
    } catch (_) {
      // Sentry must never break the importer.
    }
  }

  let rows;
  try {
    rows = loadCsvFn(path.join(ccDir, SOURCE_FILE));
  } catch (err) {
    samples.push({ file: SOURCE_FILE, error: `Could not load CSV: ${err.message}` });
    sendSummary('warning', { phase: 2, processed: 0, inserted: 0, updated: 0, errored: 0, skipped: 0, samples });
    await finishRun(runId, {
      status: 'failed',
      rowsProcessed: 0, rowsInserted: 0, rowsSkipped: 0, rowsErrored: 0,
      errorSummary: `phase 2: failed to load ${SOURCE_FILE}: ${err.message}`,
      notes: samples,
    });
    return { processed: 0, inserted: 0, updated: 0, errored: 0, skipped: 0, samples, runId };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const sourceRowNumber = i + 1; // 1-based CSV position
      processed++;

      const ccId = (() => {
        const raw = getCol(row, 'ID');
        if (raw == null) return null;
        const s = String(raw).trim();
        return s || null;
      })();

      if (!ccId) {
        // Without a CC ID we have no idempotency key — can't even build a
        // placeholder email. Record raw row outside this row's SAVEPOINT so
        // we still have an audit trail, then skip the per-row promotion.
        const c0 = await pool.connect();
        try {
          const rawImportId = await recordRawImport(c0, sourceRowNumber, row, null);
          await markRawErrored(c0, rawImportId, { error: 'cc_id_missing', source_row_number: sourceRowNumber });
        } finally {
          c0.release();
        }
        errored++;
        if (samples.length < 5) samples.push({ rowNum: sourceRowNumber, error: 'cc_id_missing' });
        continue;
      }

      await client.query('SAVEPOINT row_sp');
      let rawImportId = null;
      try {
        rawImportId = await recordRawImport(client, sourceRowNumber, row, ccId);

        const rawEmail = getCol(row, 'Email');
        const normalized = normalizeEmail(rawEmail);
        const usePlaceholder = normalized == null;
        const emailToWrite = usePlaceholder ? placeholderEmail(ccId) : normalized;

        const name = buildName(row) || `CC Client ${ccId}`;
        const phone = (() => {
          const v = getCol(row, 'Phone');
          if (v == null) return null;
          const s = String(v).trim();
          return s || null;
        })();

        // Case-collision pre-check (spec §7.1 step 2): catches the
        // operator-vs-importer race where another client was just inserted
        // with a different case for the same logical email.
        const collisionRes = await client.query(
          `SELECT id, email FROM clients WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))`,
          [emailToWrite]
        );

        if (collisionRes.rowCount > 1) {
          await client.query('ROLLBACK TO SAVEPOINT row_sp');
          errored++;
          if (samples.length < 5) {
            samples.push({
              rowNum: sourceRowNumber,
              ccId,
              error: 'client_email_case_collision',
              candidates: collisionRes.rows.map(r => r.id),
            });
          }
          // Mark raw row errored on a separate pooled connection (the outer
          // transaction's savepoint just rolled back, including the
          // recordRawImport write).
          const cErr = await pool.connect();
          try {
            const reInsertId = await recordRawImport(cErr, sourceRowNumber, row, ccId);
            await markRawErrored(cErr, reInsertId, {
              error: 'client_email_case_collision',
              email: emailToWrite,
              candidates: collisionRes.rows.map(r => r.id),
            });
          } finally {
            cErr.release();
          }
          continue;
        }

        if (collisionRes.rowCount === 1) {
          // Clean dedup hit. Annotate cc_id only when not already set, and
          // canonicalize email if needed.
          const existing = collisionRes.rows[0];

          // cc_id annotation — only when currently NULL (don't overwrite a
          // prior assignment).
          await client.query(
            `UPDATE clients SET cc_id = $1 WHERE id = $2 AND cc_id IS NULL`,
            [ccId, existing.id]
          );

          // Email canonicalization — only when the existing email differs
          // from its lowercased+trimmed form. Wrapped in its own try so a
          // unique-constraint race (some other client now owns the
          // lowercased email) rolls the whole row back to errored.
          const currentEmail = String(existing.email || '');
          const canonical = currentEmail.trim().toLowerCase();
          if (currentEmail !== canonical) {
            try {
              await client.query(
                `UPDATE clients SET email = LOWER(TRIM(email))
                  WHERE id = $1 AND email <> LOWER(TRIM(email))`,
                [existing.id]
              );
            } catch (canonErr) {
              await client.query('ROLLBACK TO SAVEPOINT row_sp');
              errored++;
              if (samples.length < 5) {
                samples.push({
                  rowNum: sourceRowNumber,
                  ccId,
                  error: 'client_email_canonicalization_failed',
                  detail: canonErr.message,
                });
              }
              const cErr = await pool.connect();
              try {
                const reInsertId = await recordRawImport(cErr, sourceRowNumber, row, ccId);
                await markRawErrored(cErr, reInsertId, {
                  error: 'client_email_canonicalization_failed',
                  email: emailToWrite,
                  existing_client_id: existing.id,
                  detail: canonErr.message,
                });
              } finally {
                cErr.release();
              }
              continue;
            }
          }

          await markRawPromoted(client, rawImportId);
          updated++;
        } else {
          // No existing client — INSERT new row.
          await client.query(
            `INSERT INTO clients (name, email, phone, source, cc_id, email_status)
             VALUES ($1, $2, $3, 'direct', $4, $5)`,
            [name, emailToWrite, phone, ccId, usePlaceholder ? 'bad' : 'ok']
          );
          await markRawPromoted(client, rawImportId);
          inserted++;
        }

        await client.query('RELEASE SAVEPOINT row_sp');
      } catch (err) {
        try { await client.query('ROLLBACK TO SAVEPOINT row_sp'); } catch (_) {}
        errored++;
        if (samples.length < 5) samples.push({ rowNum: sourceRowNumber, ccId, error: err.message });
        // Mark raw row errored on a separate pooled connection.
        const cErr = await pool.connect();
        try {
          const reInsertId = await recordRawImport(cErr, sourceRowNumber, row, ccId);
          await markRawErrored(cErr, reInsertId, {
            error: err.message,
            phase: 2,
            source_row_number: sourceRowNumber,
          });
        } catch (_) {
          // Best-effort raw-row tagging — don't let it cascade.
        } finally {
          cErr.release();
        }
        try {
          const Sentry = require('@sentry/node');
          Sentry.captureException(err, { tags: { phase: 'cc_import_phase2', ccId } });
        } catch (_) {}
      }
    }

    await client.query('COMMIT');
  } catch (outerErr) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw outerErr;
  } finally {
    client.release();
  }

  sendSummary(errored > 0 ? 'warning' : 'info', {
    phase: 2,
    processed,
    inserted,
    updated,
    errored,
    skipped,
    samples: samples.slice(0, 5),
  });

  await finishRun(runId, {
    status: errored > 0 ? 'partial' : 'succeeded',
    rowsProcessed: processed,
    // Cross-phase accounting convention (matches Phase 3): rows_inserted counts
    // any row that produced a DB state change — new INSERT (`inserted`) OR
    // dedup-update of an existing row (`updated`). rows_skipped is reserved
    // for rows we deliberately left untouched (none on the Phase 2 happy path;
    // a re-import re-records the raw row and either inserts or updates).
    rowsInserted: inserted + updated,
    rowsSkipped: skipped,
    rowsErrored: errored,
    errorSummary: `phase 2: processed=${processed} inserted=${inserted} updated=${updated} errored=${errored}`,
    notes: samples,
  });

  return { processed, inserted, updated, errored, skipped, samples, runId };
}

module.exports = { run, normalizeEmail, placeholderEmail };

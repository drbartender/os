const path = require('path');
const crypto = require('crypto');
const { pool } = require('../lib/db');
const { startRun, finishRun } = require('../lib/runLog');
const { loadCsv } = require('../lib/csv');
const httpFetchLib = require('../lib/httpFetch');
const r2Lib = require('../lib/r2');

const MAX_ATTEMPTS = 10; // spec §8.0: max 10 attempts total across all runs

// Slugify an email or other identifier for use in an R2 key segment.
function slug(s) {
  return String(s || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unknown';
}

function extFromContentType(ct) {
  if (!ct) return 'bin';
  const head = ct.split(';')[0].trim().toLowerCase();
  if (head === 'application/pdf') return 'pdf';
  if (head.startsWith('image/')) {
    const sub = head.slice('image/'.length);
    return sub === 'jpeg' ? 'jpg' : sub.replace(/[^a-z0-9]/g, '') || 'img';
  }
  if (head.startsWith('video/')) {
    return head.slice('video/'.length).replace(/[^a-z0-9]/g, '') || 'vid';
  }
  return 'bin';
}

// Source map (spec §8.0 Phase 0).
// Each entry: file name, source_entity tag for the failures table, list of URL
// column names, and an r2Key(row, col, idx, contentType) function.
const SOURCES = [
  {
    file: 'Contractor Profile.csv',
    entity: 'wix_contractor',
    urlCols: ['Resume', 'W9'],
    r2Path: (row, col, idx, ct) => {
      const who = slug(row.Email || row['Email Address'] || row.email);
      return `legacy/wix/${who}/${slug(col)}-${idx}.${extFromContentType(ct)}`;
    },
  },
  {
    file: 'Payment Info.csv',
    entity: 'wix_payment_info',
    urlCols: ['Upload your signed W9 (Photo or PDF)'],
    r2Path: (row, col, idx, ct) => {
      const who = slug(row.Email || row['Email Address'] || row.email);
      return `legacy/wix/${who}/w9-${idx}.${extFromContentType(ct)}`;
    },
  },
  {
    file: 'report (14).csv',
    entity: 'cc_invoice',
    urlCols: ['Gallery URL', 'Video URL'],
    r2Path: (row, col, idx, ct) => {
      const id = slug(row.ID || row.Id || row.id);
      const kind = col === 'Gallery URL' ? 'gallery' : 'video';
      return `legacy/cc/${id}/${kind}/${idx}.${extFromContentType(ct)}`;
    },
  },
];

function rowHash(row) {
  return crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
}

/**
 * Normalize CC/Wix CSV headers. CC exports occasionally include trailing
 * whitespace on header keys. We look up by trimmed key, falling back to the
 * raw value.
 */
function getCol(row, col) {
  if (Object.prototype.hasOwnProperty.call(row, col)) return row[col];
  for (const k of Object.keys(row)) {
    if (k.trim() === col) return row[k];
  }
  return undefined;
}

/**
 * Phase 0 runner. Walks the CC + Wix CSVs, downloads URL columns into R2, and
 * persists failures to cc_import_phase0_failures with backoff up to 10 total
 * attempts before surfacing on the Review page.
 *
 * @param {object} opts
 * @param {string} opts.ccDir   Directory holding canonical CC/Wix CSVs.
 * @param {boolean} [opts.retryFromDb] If true, only re-attempt URLs already in
 *   cc_import_phase0_failures (skip fresh URLs).
 * @param {function} [opts.fetchToBuffer] Override for tests.
 * @param {function} [opts.uploadToR2]    Override for tests.
 * @param {function} [opts.loadCsv]       Override for tests.
 * @param {function} [opts.captureMessage] Override for Sentry calls in tests.
 * @returns {Promise<{processed, resolved, failed, skipped, samples, runId}>}
 */
async function run(opts = {}) {
  const {
    ccDir,
    retryFromDb = false,
    fetchToBuffer = httpFetchLib.fetchToBuffer,
    uploadToR2 = r2Lib.uploadToR2,
    loadCsv: loadCsvFn = loadCsv,
    captureMessage = null,
  } = opts;

  if (!ccDir) throw new Error('phase0.run: ccDir is required');

  const runId = await startRun(0);
  const samples = [];
  let processed = 0;
  let resolved = 0;
  let failed = 0;
  let skipped = 0;

  try {
    for (const src of SOURCES) {
      let rows;
      try {
        rows = loadCsvFn(path.join(ccDir, src.file));
      } catch (err) {
        // Missing CSV is non-fatal — operator may run a subset. Surface in
        // the run notes and continue.
        samples.push({ file: src.file, error: `Could not load CSV: ${err.message}` });
        continue;
      }

      for (let rIdx = 0; rIdx < rows.length; rIdx++) {
        const row = rows[rIdx];
        for (const col of src.urlCols) {
          const raw = getCol(row, col);
          const url = (raw == null ? '' : String(raw)).trim();
          if (!url) continue;
          if (!/^https?:\/\//i.test(url)) continue; // not a URL — skip silently
          processed++;

          // Look up prior state.
          const { rows: existingRows } = await pool.query(
            `SELECT attempt_count, resolved_at, given_up_at
               FROM cc_import_phase0_failures
              WHERE source_url = $1 AND source_entity = $2`,
            [url, src.entity]
          );
          const existing = existingRows[0] || null;

          if (existing && (existing.resolved_at || existing.given_up_at)) {
            skipped++;
            continue;
          }

          if (retryFromDb && !existing) {
            // --retry-from-db: only retry URLs already known to have failed.
            skipped++;
            continue;
          }

          const priorAttempts = existing ? existing.attempt_count : 0;
          if (priorAttempts >= MAX_ATTEMPTS) {
            // Past cap — surfaces on Review page for "Accept loss".
            skipped++;
            continue;
          }

          const rIdxForKey = rIdx + 1; // 1-based for readability in R2 keys

          try {
            const { buffer, contentType } = await fetchToBuffer(url);
            const r2Key = src.r2Path(row, col, rIdxForKey, contentType);
            await uploadToR2(r2Key, buffer, contentType);

            // Record success. ON CONFLICT handles both new + previously-failed URLs.
            await pool.query(
              `INSERT INTO cc_import_phase0_failures
                 (source_url, source_entity, source_row_hash, attempt_count,
                  last_error, last_attempted_at, resolved_at, resolved_r2_key)
               VALUES ($1, $2, $3, $4, NULL, NOW(), NOW(), $5)
               ON CONFLICT (source_url, source_entity) DO UPDATE
                 SET attempt_count = cc_import_phase0_failures.attempt_count + 1,
                     last_error = NULL,
                     last_attempted_at = NOW(),
                     resolved_at = NOW(),
                     resolved_r2_key = EXCLUDED.resolved_r2_key`,
              [url, src.entity, rowHash(row), priorAttempts + 1, r2Key]
            );
            resolved++;
          } catch (err) {
            failed++;
            const msg = String(err && err.message || err).slice(0, 4000);
            await pool.query(
              `INSERT INTO cc_import_phase0_failures
                 (source_url, source_entity, source_row_hash, attempt_count,
                  last_error, last_attempted_at)
               VALUES ($1, $2, $3, 1, $4, NOW())
               ON CONFLICT (source_url, source_entity) DO UPDATE
                 SET attempt_count = cc_import_phase0_failures.attempt_count + 1,
                     last_error = $4,
                     last_attempted_at = NOW(),
                     source_row_hash = EXCLUDED.source_row_hash`,
              [url, src.entity, rowHash(row), msg]
            );
            if (samples.length < 5) samples.push({ url, entity: src.entity, error: msg });
          }
        }
      }
    }
  } finally {
    // Per-phase Sentry summary (spec §11; plan Global Conventions §7).
    try {
      let send = captureMessage;
      if (!send) {
        const Sentry = require('@sentry/node');
        send = Sentry.captureMessage.bind(Sentry);
      }
      send(`cc-import phase 0 summary`, {
        level: failed > 0 ? 'warning' : 'info',
        extra: {
          phase: 0,
          rowsProcessed: processed,
          resolved,
          errored_count: failed,
          skipped,
          samples: samples.slice(0, 5),
        },
      });
    } catch (_) {
      // Sentry must never break the importer.
    }

    await finishRun(runId, {
      status: failed > 0 ? 'partial' : 'succeeded',
      rowsProcessed: processed,
      rowsInserted: resolved,
      rowsSkipped: skipped,
      rowsErrored: failed,
      errorSummary: `phase 0: processed=${processed} resolved=${resolved} failed=${failed} skipped=${skipped}`,
      notes: samples,
    });
  }

  return { processed, resolved, failed, skipped, samples, runId };
}

module.exports = { run, SOURCES, slug, extFromContentType };

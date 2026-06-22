/**
 * Phase 1 — Staff users
 *
 * 1. Encryption + functional-index preflight.
 * 2. Load 3 Wix CSVs (Field Guide Ack + Contractor Profile + Payment Info) into
 *    `legacy_cc_raw_imports` and merge per-email.
 * 3. For each unique email, run a per-user transaction:
 *      - Case-collision pre-check.
 *      - UPSERT into `users` with role/status carve-out.
 *      - Upsert `contractor_profiles` (Payment-Info-wins precedence).
 *      - Upsert `agreements` (Field Guide Ack only).
 *      - Upsert `payment_profiles` with bank PII encrypted via encrypt().
 * 4. Scan `report (5).csv` payee names; for each distinct unmatched payee, run
 *    the Pass 1→2→3 fuzzy cascade; on all-miss, create a `legacy_cc:`-prefixed
 *    contractor stub (no shift_requests reassignment in Phase 1 — that runs
 *    later through Section 9.3.E).
 * 5. Auto-derive `can_staff = true` for users whose payouts reference column is
 *    Bartender/Server/Barback AND have at least one non-Reimbursement /
 *    non-Cash-Advance row (computed from the in-memory payouts scan; the
 *    `legacy_cc_payouts` table itself is populated in Phase 5).
 *
 * Algorithm + invariants documented in spec §7.3 + §8.1 and the Task 12 plan.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../lib/db');
const { startRun, finishRun } = require('../lib/runLog');
const { loadCsv } = require('../lib/csv');
const { findByName, buildStubCcId, normalize } = require('../lib/fuzzyName');
const { parseCcDate } = require('../lib/dateFmt');
const { encrypt } = require('../../../server/utils/encryption');

// ── helpers ──────────────────────────────────────────────────────────────

function rowHash(row) {
  return crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
}

/**
 * CC/Wix exports occasionally pad header keys with whitespace. Look up by
 * trimmed name, falling back to the raw value.
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

function emailKey(raw) {
  const e = (raw == null ? '' : String(raw)).trim().toLowerCase();
  return e || null;
}

/**
 * Encryption preflight (spec §7.3). encrypt('') short-circuits and returns the
 * empty string regardless of key state, so we MUST use a non-empty sentinel.
 */
function encryptionPreflight() {
  const probe = encrypt('cc-import-preflight');
  if (!probe || !String(probe).startsWith('enc:')) {
    throw new Error('ENCRYPTION_KEY missing — refuse to write bank PII as plaintext (cc-import Phase 1)');
  }
}

async function indexPreflight() {
  // Functional-index preflight (spec §8.1 step 3) — without this the per-user
  // pre-check would sequentially scan `users` and lock every row it touched.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email))`);
}

/**
 * Insert (or look up) a raw_imports row for a single Wix CSV record. Returns
 * the BIGSERIAL id of the row.
 */
async function recordRawImport(client, sourceFile, sourceEntity, sourceRowNumber, row) {
  const payload = JSON.stringify(row);
  const hash = rowHash(row);
  // Reset import_status to 'pending' on re-import so a previous-run 'errored'
  // status doesn't block this run's promotion path. The downstream code will
  // either re-promote (markRawPromoted) or re-error (markRawErrored) based on
  // the current run's outcome.
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
    [sourceFile, sourceEntity, sourceRowNumber, hash, payload]
  );
  return r.rows[0].id;
}

async function markRawErrored(client, rawImportId, error) {
  await client.query(
    `UPDATE legacy_cc_raw_imports
        SET import_status = 'errored', import_notes = $2::jsonb
      WHERE id = $1`,
    [rawImportId, JSON.stringify(error)]
  );
}

async function markRawPromoted(client, rawImportId) {
  await client.query(
    `UPDATE legacy_cc_raw_imports
        SET import_status = 'promoted'
      WHERE id = $1 AND import_status NOT IN ('errored', 'promoted')`,
    [rawImportId]
  );
}

/**
 * Merge a single Wix row's fields into the per-email aggregate. Payment Info
 * sources are applied AFTER contractor profile (spec §7.3 / §8.1 step 4 note),
 * so Payment-Info-wins precedence falls out naturally.
 */
function mergeFields(aggregate, sourceEntity, row, rawImportId) {
  aggregate.sources[sourceEntity] = { row, rawImportId };
  aggregate.rawImportIds.push(rawImportId);
}

/**
 * Coerce a Wix yes/no field to BOOLEAN. Lots of historic shape — "Yes", "yes",
 * "YES", "true", "1" all → true. Anything else (including blank) → false.
 */
function parseYesNo(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === 'yes' || s === 'true' || s === '1' || s === 'y';
}

function intOrNull(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// ── core runner ──────────────────────────────────────────────────────────

async function run({ ccDir, loadCsv: loadCsvFn = loadCsv, captureMessage = null } = {}) {
  if (!ccDir) throw new Error('phase1.run: ccDir is required');

  const runId = await startRun(1);
  const samples = [];
  let processed = 0;
  let inserted = 0;
  let updated = 0;
  let errored = 0;
  let stubsCreated = 0;
  let stubsSkipped = 0;
  let canStaffAutoSet = 0;

  // Resolve Sentry sender once. Errors here must never break the importer.
  function sendSummary(level, extra) {
    try {
      let send = captureMessage;
      if (!send) {
        const Sentry = require('@sentry/node');
        send = Sentry.captureMessage.bind(Sentry);
      }
      send(`cc-import phase 1 summary`, { level, extra });
    } catch (_) {
      // swallow — Sentry must never break the importer.
    }
  }

  try {
    encryptionPreflight();
    await indexPreflight();

    // ── Step 1: load the 3 Wix CSVs ───────────────────────────────────────
    // Per spec §6, missing CSVs are non-fatal — operator may run a subset.
    const wixSources = [
      { file: 'Field Guide Acknowledgement.csv', entity: 'wix_field_guide' },
      { file: 'Contractor Profile.csv', entity: 'wix_contractor' },
      { file: 'Payment Info.csv', entity: 'wix_payment_info' },
    ];

    const byEmail = new Map(); // emailKey → { email, sources: {entity: {row, rawImportId}}, rawImportIds: [] }

    for (const src of wixSources) {
      const absPath = path.join(ccDir, src.file);
      let rows;
      try {
        rows = loadCsvFn(absPath);
      } catch (err) {
        samples.push({ file: src.file, error: `Could not load CSV: ${err.message}` });
        continue;
      }

      // Insert each row into legacy_cc_raw_imports, then bucket by lowercased email.
      // Each raw-import write is its own micro-transaction (Phase 0 followed the same
      // pattern with shared-pool writes); the per-user fan-out below opens its own
      // dedicated client/transaction.
      for (let rIdx = 0; rIdx < rows.length; rIdx++) {
        const row = rows[rIdx];
        const sourceRowNumber = rIdx + 1; // 1-based

        const c0 = await pool.connect();
        let rawImportId;
        try {
          rawImportId = await recordRawImport(c0, src.file, src.entity, sourceRowNumber, row);
        } finally {
          c0.release();
        }

        const email = emailKey(getCol(row, 'Email', 'Email Address'));
        if (!email) {
          // No email — orphan row. Mark errored in raw-imports so the operator
          // sees it on the Review page later. Don't count toward `processed`
          // since processed measures unique emails attempted.
          const c1 = await pool.connect();
          try {
            await markRawErrored(c1, rawImportId, {
              error: 'wix_row_missing_email',
              source_file: src.file,
              source_row_number: sourceRowNumber,
            });
          } finally {
            c1.release();
          }
          continue;
        }

        if (!byEmail.has(email)) {
          byEmail.set(email, { email, sources: {}, rawImportIds: [] });
        }
        mergeFields(byEmail.get(email), src.entity, row, rawImportId);
      }
    }

    // ── Step 2: per-user fan-out ──────────────────────────────────────────
    for (const [email, agg] of byEmail) {
      processed++;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Case-collision pre-check (spec §8.1 step 4).
        const collisionRes = await client.query(
          `SELECT COUNT(*)::int AS n FROM users WHERE LOWER(email) = LOWER($1)`,
          [email]
        );
        if (collisionRes.rows[0].n > 1) {
          await client.query('ROLLBACK');
          errored++;
          // Mark every raw-imports row for this email as errored. Reuse the same
          // pooled client (post-ROLLBACK queries run outside any transaction).
          for (const rawId of agg.rawImportIds) {
            await markRawErrored(client, rawId, {
              error: 'user_email_case_collision',
              email,
            });
          }
          if (samples.length < 5) samples.push({ email, error: 'user_email_case_collision' });
          continue;
        }

        // UPSERT with role/status carve-out + stub-promotion defense-in-depth.
        // bcryptjs cost 10 matches the rest of the codebase.
        const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
        const upRes = await client.query(
          `INSERT INTO users (email, password_hash, role, onboarding_status, pre_hired)
           VALUES (LOWER(TRIM($1)), $2, 'staff', 'hired', false)
           ON CONFLICT (email) DO UPDATE
             SET onboarding_status = 'hired'
           WHERE users.role = 'staff'
             AND (
               users.onboarding_status NOT IN ('rejected', 'deactivated')
               OR (users.cc_id LIKE 'legacy_cc:%' AND users.onboarding_status = 'deactivated')
             )
           RETURNING id, cc_id, (xmax = 0) AS inserted`,
          [email, passwordHash]
        );

        if (upRes.rows.length === 0) {
          // Existing user is rejected/deactivated non-stub OR role != staff.
          // Look up the existing user to give the operator a usable error.
          const existing = await client.query(
            `SELECT id, role, onboarding_status FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
            [email]
          );
          await client.query('ROLLBACK');
          errored++;
          for (const rawId of agg.rawImportIds) {
            await markRawErrored(client, rawId, {
              error: 'user_email_conflict_with_protected_state',
              email,
              existing_user_id: existing.rows[0]?.id ?? null,
              existing_role: existing.rows[0]?.role ?? null,
              existing_status: existing.rows[0]?.onboarding_status ?? null,
            });
          }
          if (samples.length < 5) {
            samples.push({ email, error: 'user_email_conflict_with_protected_state', existing: existing.rows[0] ?? null });
          }
          continue;
        }

        const { id: userId, inserted: wasInserted } = upRes.rows[0];
        if (wasInserted) inserted++; else updated++;

        // Pull out per-source rows for the fan-out.
        const fgRow  = agg.sources['wix_field_guide']?.row;
        const cpRow  = agg.sources['wix_contractor']?.row;
        const piRow  = agg.sources['wix_payment_info']?.row;

        // ── contractor_profiles ──
        // Spec §8.1 step 4: skip the entire upsert when the existing row predates
        // the import AND inserted === false (preserve operator edits to
        // preferred_name). For a fresh insert, build the row by applying
        // Contractor Profile first, then Payment Info on top (Payment-Info-wins
        // precedence on overlapping fields).
        if (wasInserted) {
          const preferredName =
            getCol(cpRow || {}, 'Preferred Name', 'Full Name', 'Name') ||
            getCol(piRow || {}, 'Preferred Name', 'Full Name', 'Name') ||
            getCol(fgRow || {}, 'Full Name', 'Name') || null;
          const phone =
            getCol(cpRow || {}, 'Phone', 'Phone Number') ||
            getCol(piRow || {}, 'Phone', 'Phone Number') ||
            getCol(fgRow || {}, 'Phone', 'Phone Number') || null;
          const city = getCol(cpRow || {}, 'City') || null;
          const state = getCol(cpRow || {}, 'State') || null;
          const streetAddress = getCol(cpRow || {}, 'Street Address', 'Address') || null;
          const zipCode = getCol(cpRow || {}, 'Zip', 'Zip Code', 'ZIP') || null;
          const travelDistance = getCol(cpRow || {}, 'Travel Distance', 'Distance') || null;
          const reliableTransportation = getCol(cpRow || {}, 'Reliable Transportation', 'Transportation') || null;
          const birthMonth = intOrNull(getCol(cpRow || {}, 'Birth Month'));
          const birthDay = intOrNull(getCol(cpRow || {}, 'Birth Day'));
          const birthYear = intOrNull(getCol(cpRow || {}, 'Birth Year'));
          const eqPortableBar = parseYesNo(getCol(cpRow || {}, 'Portable Bar', 'Equipment: Portable Bar'));
          const eqCooler = parseYesNo(getCol(cpRow || {}, 'Cooler', 'Equipment: Cooler'));
          const eqTableSpandex = parseYesNo(getCol(cpRow || {}, 'Table with Spandex', 'Equipment: Table with Spandex'));
          const eqNoneOpen = parseYesNo(getCol(cpRow || {}, 'None but Open', 'Equipment: None but Open'));
          const eqNoSpace = parseYesNo(getCol(cpRow || {}, 'No Space', 'Equipment: No Space'));
          const resumeFileUrl = getCol(cpRow || {}, 'Resume') || null;
          const alcoholCertUrl = getCol(cpRow || {}, 'Alcohol Certification', 'BASSET') || null;
          const emergencyName = getCol(cpRow || {}, 'Emergency Contact Name', 'Emergency Name') || null;
          const emergencyPhone = getCol(cpRow || {}, 'Emergency Contact Phone', 'Emergency Phone') || null;
          const emergencyRel = getCol(cpRow || {}, 'Emergency Contact Relationship', 'Relationship') || null;

          await client.query(
            `INSERT INTO contractor_profiles
               (user_id, preferred_name, phone, email,
                birth_month, birth_day, birth_year,
                city, state, street_address, zip_code,
                travel_distance, reliable_transportation,
                equipment_portable_bar, equipment_cooler,
                equipment_table_with_spandex, equipment_none_but_open, equipment_no_space,
                alcohol_certification_file_url, resume_file_url,
                emergency_contact_name, emergency_contact_phone, emergency_contact_relationship)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
             ON CONFLICT (user_id) DO UPDATE SET
               preferred_name = COALESCE(EXCLUDED.preferred_name, contractor_profiles.preferred_name),
               phone = COALESCE(EXCLUDED.phone, contractor_profiles.phone),
               email = COALESCE(EXCLUDED.email, contractor_profiles.email)`,
            [
              userId, preferredName, phone, email,
              birthMonth, birthDay, birthYear,
              city, state, streetAddress, zipCode,
              travelDistance, reliableTransportation,
              eqPortableBar, eqCooler, eqTableSpandex, eqNoneOpen, eqNoSpace,
              alcoholCertUrl, resumeFileUrl,
              emergencyName, emergencyPhone, emergencyRel,
            ]
          );
        }
        // If !wasInserted, intentionally skip contractor_profiles upsert.

        // ── agreements (Field Guide Ack only) ──
        if (fgRow) {
          const fullName = getCol(fgRow, 'Full Name', 'Name') || null;
          const fgPhone = getCol(fgRow, 'Phone', 'Phone Number') || null;
          const smsConsent = parseYesNo(getCol(fgRow, 'SMS Consent', 'SMS'));
          const ackFieldGuide = parseYesNo(getCol(fgRow, 'Acknowledged Field Guide', 'Field Guide Acknowledged', 'Acknowledgement'));
          const agreedNonSolicit = parseYesNo(getCol(fgRow, 'Non-Solicitation', 'Agreed Non-Solicitation'));
          const signatureData = getCol(fgRow, 'Signature', 'Signature Data') || null;
          const signedAtRaw = getCol(fgRow, 'Signed At', 'Date Submitted', 'Submission Date') || null;
          let signedAt = null;
          if (signedAtRaw) {
            const d = new Date(signedAtRaw);
            signedAt = Number.isFinite(d.getTime()) ? d : (parseCcDate(signedAtRaw) || null);
          }

          await client.query(
            // Schema-drift fix (audit 5a): write the ack_* columns the LIVE staff
            // sign route (server/routes/agreement.js) reads, not the legacy
            // acknowledged_field_guide / agreed_non_solicitation pair, so an
            // imported staffer's acks are visible to the same code path as a
            // freshly-signed one. The legacy columns are kept (no drop) but no
            // longer written by anything.
            `INSERT INTO agreements
               (user_id, full_name, email, phone, sms_consent,
                ack_field_guide, ack_non_solicit,
                signature_data, signed_at, signature_document_version)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (user_id) DO UPDATE SET
               full_name = COALESCE(EXCLUDED.full_name, agreements.full_name),
               email = COALESCE(EXCLUDED.email, agreements.email),
               phone = COALESCE(EXCLUDED.phone, agreements.phone),
               sms_consent = agreements.sms_consent OR EXCLUDED.sms_consent,
               ack_field_guide = agreements.ack_field_guide OR EXCLUDED.ack_field_guide,
               ack_non_solicit = agreements.ack_non_solicit OR EXCLUDED.ack_non_solicit,
               signature_data = COALESCE(EXCLUDED.signature_data, agreements.signature_data),
               signed_at = COALESCE(EXCLUDED.signed_at, agreements.signed_at)`,
            [
              userId, fullName, email, fgPhone, smsConsent,
              ackFieldGuide, agreedNonSolicit,
              signatureData, signedAt, 'wix-legacy-import',
            ]
          );
        }

        // ── payment_profiles (encrypted bank PII) ──
        if (piRow || cpRow) {
          // Payment-Info-wins precedence: preferred_method and W9 URL from
          // Payment Info; fallback to Contractor Profile only when Payment
          // Info doesn't have the field (spec §7.3).
          const preferredMethod =
            getCol(piRow || {}, 'Preferred Payment Method', 'Payment Method', 'Preferred Method') ||
            getCol(cpRow || {}, 'Preferred Payment Method', 'Payment Method', 'Preferred Method') || null;
          const paymentUsername =
            getCol(piRow || {}, 'Payment Username', 'Payment Handle', 'Username', 'Handle') ||
            getCol(cpRow || {}, 'Payment Username', 'Payment Handle', 'Username', 'Handle') || null;
          const w9FileUrl =
            getCol(piRow || {}, 'Upload your signed W9 (Photo or PDF)', 'W9 URL', 'W9') ||
            getCol(cpRow || {}, 'W9', 'W9 URL') || null;
          const rawRouting = getCol(piRow || {}, 'Routing Number', 'Routing') || null;
          const rawAccount = getCol(piRow || {}, 'Account Number', 'Account') || null;

          // Encrypt bank PII (preflight already verified the key is live).
          // Pass through encrypt() which produces 'enc:...' prefix; nulls are
          // returned as-is by encrypt() so we can pass them safely.
          const routingEnc = rawRouting ? encrypt(String(rawRouting).trim()) : null;
          const accountEnc = rawAccount ? encrypt(String(rawAccount).trim()) : null;

          if (preferredMethod || paymentUsername || w9FileUrl || routingEnc || accountEnc) {
            await client.query(
              `INSERT INTO payment_profiles
                 (user_id, preferred_payment_method, payment_username,
                  routing_number, account_number, w9_file_url)
               VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT (user_id) DO UPDATE SET
                 preferred_payment_method = COALESCE(EXCLUDED.preferred_payment_method, payment_profiles.preferred_payment_method),
                 payment_username = COALESCE(EXCLUDED.payment_username, payment_profiles.payment_username),
                 routing_number = COALESCE(EXCLUDED.routing_number, payment_profiles.routing_number),
                 account_number = COALESCE(EXCLUDED.account_number, payment_profiles.account_number),
                 w9_file_url = COALESCE(EXCLUDED.w9_file_url, payment_profiles.w9_file_url)`,
              [userId, preferredMethod, paymentUsername, routingEnc, accountEnc, w9FileUrl]
            );
          }
        }

        await client.query('COMMIT');

        // Mark this user's raw-imports rows as promoted. Reuse the same
        // pooled client (post-COMMIT queries run outside any transaction).
        for (const rawId of agg.rawImportIds) {
          await markRawPromoted(client, rawId);
        }
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        errored++;
        if (samples.length < 5) samples.push({ email, error: err.message });
        // Sentry per-error capture only; the summary at the end aggregates.
        try {
          const Sentry = require('@sentry/node');
          Sentry.captureException(err, { tags: { phase: 'cc_import_phase1', email } });
        } catch (_) {}
      } finally {
        client.release();
      }
    }

    // ── Step 3: payouts cascade — stubs for unmatched payees ──────────────
    // Phase 5 fully loads `legacy_cc_payouts`; Phase 1 only scans the CSV in
    // memory to (a) create stubs for never-seen-before payees and (b) derive
    // can_staff. Both per-payee aggregations live here.
    let payouts = null;
    try {
      payouts = loadCsvFn(path.join(ccDir, 'report (5).csv'));
    } catch (err) {
      samples.push({ file: 'report (5).csv', error: `Could not load payouts CSV: ${err.message}` });
    }

    if (payouts && payouts.length) {
      // Aggregate per payee: earliest paid_on (for the stub salt), and the
      // category/reference distribution (for can_staff derivation).
      // Map<payeeName, { earliestIso: string, refs: Set<string>, categories: Set<string> }>
      const byPayee = new Map();
      for (const row of payouts) {
        const name = getCol(row, 'Payee', 'Payee Name');
        if (!name || !String(name).trim()) continue;
        const dateRaw = getCol(row, 'Date', 'Paid On', 'Payment Date');
        const ref = getCol(row, 'Reference', 'Reference Role') || '';
        const cat = getCol(row, 'Category') || '';

        let iso = null;
        if (dateRaw) {
          const d = parseCcDate(dateRaw);
          if (d) iso = d.toISOString().slice(0, 10);
          else {
            const fallback = new Date(dateRaw);
            if (Number.isFinite(fallback.getTime())) iso = fallback.toISOString().slice(0, 10);
          }
        }

        if (!byPayee.has(name)) {
          byPayee.set(name, { earliestIso: iso, refs: new Set(), categories: new Set() });
        }
        const agg = byPayee.get(name);
        if (iso && (agg.earliestIso == null || iso < agg.earliestIso)) {
          agg.earliestIso = iso;
        }
        if (ref) agg.refs.add(String(ref).trim());
        if (cat) agg.categories.add(String(cat).trim());
      }

      // For each payee, run cascade. On all-miss → create stub. On single
      // match → no-op (real user already exists). On multi-match → no-op (will
      // be surfaced on Review page by Phase 5 / Section 8.5).
      // Then derive can_staff for the matched/just-created user.
      const PAY_STAFF_ROLES = new Set(['Bartender', 'Server', 'Barback']);
      const EXCLUDE_CATEGORIES = new Set(['Reimbursement', 'Cash Advance']);

      for (const [payeeName, ag] of byPayee) {
        let userId = null;
        try {
          const matches = await findByName(pool, payeeName);
          if (matches.length === 1) {
            userId = matches[0];
          } else if (matches.length > 1) {
            // Ambiguous — leave for Review page; can_staff not auto-set.
            continue;
          } else {
            // No match — create stub.
            const earliest = ag.earliestIso || '1970-01-01';
            const { ccId, email } = buildStubCcId(payeeName, earliest);
            const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
            // ON CONFLICT must match the partial unique index
            // `idx_users_cc_id ON users(cc_id) WHERE cc_id IS NOT NULL`
            // (schema.sql:2761) — Postgres requires the predicate be repeated
            // explicitly when targeting a partial unique index.
            const insRes = await pool.query(
              `INSERT INTO users (email, password_hash, role, onboarding_status, pre_hired, cc_id)
               VALUES ($1, $2, 'staff', 'deactivated', false, $3)
               ON CONFLICT (cc_id) WHERE cc_id IS NOT NULL DO NOTHING
               RETURNING id`,
              [email, passwordHash, ccId]
            );
            if (insRes.rowCount > 0) {
              userId = insRes.rows[0].id;
              stubsCreated++;
              // Seed the contractor_profile so findByName matches the stub on
              // a future Phase 1 / Phase 5 re-run.
              await pool.query(
                `INSERT INTO contractor_profiles (user_id, preferred_name)
                 VALUES ($1, $2)
                 ON CONFLICT (user_id) DO NOTHING`,
                [userId, payeeName]
              );
            } else {
              // cc_id already existed (prior Phase 1 run created this stub OR
              // there was a slug+hash collision). Look it up by cc_id so
              // can_staff still gets derived.
              const lookup = await pool.query(
                `SELECT id FROM users WHERE cc_id = $1 LIMIT 1`,
                [ccId]
              );
              if (lookup.rowCount > 0) {
                userId = lookup.rows[0].id;
                stubsSkipped++;
              }
            }
          }

          // Derive can_staff for this resolved user.
          // Predicate: at least one of the payee's references is a staff role
          // AND at least one of the categories is NOT in the excluded set.
          if (userId) {
            const hasStaffRole = [...ag.refs].some(r => PAY_STAFF_ROLES.has(r));
            const hasPayableCategory =
              ag.categories.size === 0
                ? hasStaffRole // categories are not always present; fall back to ref-only
                : [...ag.categories].some(c => !EXCLUDE_CATEGORIES.has(c));
            if (hasStaffRole && hasPayableCategory) {
              const upd = await pool.query(
                `UPDATE users SET can_staff = true
                  WHERE id = $1 AND can_staff IS DISTINCT FROM true`,
                [userId]
              );
              if (upd.rowCount > 0) canStaffAutoSet++;
            }
          }
        } catch (err) {
          errored++;
          if (samples.length < 5) samples.push({ payeeName, error: err.message });
          try {
            const Sentry = require('@sentry/node');
            Sentry.captureException(err, { tags: { phase: 'cc_import_phase1', step: 'stub_or_can_staff', payeeName } });
          } catch (_) {}
        }
      }
    }

    sendSummary(errored > 0 ? 'warning' : 'info', {
      phase: 1,
      processed,
      inserted,
      updated,
      errored,
      stubsCreated,
      stubsSkipped,
      canStaffAutoSet,
      samples: samples.slice(0, 5),
    });

    return { processed, inserted, updated, errored, stubsCreated, stubsSkipped, canStaffAutoSet, samples, runId };
  } finally {
    await finishRun(runId, {
      status: errored > 0 ? 'partial' : 'succeeded',
      rowsProcessed: processed,
      rowsInserted: inserted + stubsCreated,
      rowsSkipped: stubsSkipped,
      rowsErrored: errored,
      errorSummary: `phase 1: processed=${processed} inserted=${inserted} updated=${updated} stubsCreated=${stubsCreated} stubsSkipped=${stubsSkipped} canStaffAutoSet=${canStaffAutoSet} errored=${errored}`,
      notes: samples,
    });
  }
}

module.exports = { run, encryptionPreflight, indexPreflight };

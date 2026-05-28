/**
 * Phase 3 — Proposals + native promotion (Buckets A / B / C / D).
 *
 *  - Load `report (10).csv` into `legacy_cc_raw_imports`.
 *  - Classify each row via `lib/buckets.js::classify(...)`.
 *  - Bucket A: future + Confirmed → INSERT proposals (status='confirmed') +
 *    shifts (status='open') + shift_requests + activity-log; dedup-check
 *    against native proposals within ±14d first.
 *  - Bucket B: past + Confirmed → INSERT proposals (status='completed') +
 *    shifts (status='completed') + shift_requests + activity-log; no
 *    auto-comms enrollment.
 *  - Bucket C: non-Confirmed → archive into `legacy_cc_proposals`.
 *  - Bucket D: Confirmed + skip-list package → mark raw row `'skipped'`.
 *
 * Auto-comms enrollment runs AFTER the outer COMMIT (spec §8.3 final paragraph)
 * because the scheduler helpers acquire their own pool connections and need to
 * SEE the proposal rows the loop just wrote.
 *
 * Named exports `promoteBucketA` / `promoteBucketB` are reused by Task 19's
 * `/duplicate/:row_id/promote` admin endpoint to re-run a single row's
 * promotion (with `skipDedup: true`) after an operator's manual review.
 *
 * Spec reference: docs/superpowers/specs/2026-05-25-checkcherry-import-design.md §5, §7.2, §8.3.
 * Plan reference: docs/superpowers/plans/2026-05-26-checkcherry-import.md Task 14.
 */

const path = require('path');
const crypto = require('crypto');
const { pool } = require('../lib/db');
const { startRun, finishRun } = require('../lib/runLog');
const { loadCsv } = require('../lib/csv');
const { classify } = require('../lib/buckets');
const { parseCcDate } = require('../lib/dateFmt');
const { addHours } = require('../lib/timeFormat');
const { parseLengthHours } = require('../lib/duration');
const { parseMoneyCents } = require('../lib/money');
const { findByName } = require('../lib/fuzzyName');
const { normalizeEmail } = require('../lib/email');
const { composeVenueLocation } = require('../../../server/utils/venueAddress');

const SOURCE_FILE = 'report (10).csv';
const SOURCE_ENTITY = 'events';

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

/**
 * Parse CC `Add On Name, Quantity & Price` cell. Cells look like:
 *   "1 x Glassware Rental ($200), 1 x All the Little Things ($0)"
 * Returns an array of { name, qty, amount_cents } entries. Tolerates an empty
 * value (returns []).
 */
function parseAddons(cell) {
  if (!cell || !String(cell).trim()) return [];
  const parts = String(cell).split(/,\s*(?=\d+\s*x\s)/i); // split on next "<n> x" boundary
  const out = [];
  for (const part of parts) {
    const m = /^(\d+)\s*x\s+(.+?)\s*\(\$([\d.,]+(?:\.\d+)?)\)\s*$/i.exec(part.trim());
    if (!m) continue;
    const qty = Number(m[1]);
    const name = m[2].trim();
    const amount = parseMoneyCents(m[3]);
    out.push({ name, qty, amount_cents: amount == null ? 0 : amount });
  }
  return out;
}

/**
 * Parse CC's `Booked At` timestamp. Format: `MM-DD-YYYY H:MM AM/PM` (note CC
 * sometimes pads the hour with a double-space, e.g. "03-25-2025  1:02 PM").
 * Returns a Date (UTC noon for date-only inputs) or null on failure.
 */
function parseBookedAt(s) {
  if (!s) return null;
  const txt = String(s).trim().replace(/\s+/g, ' ');
  const m = /^(\d{2})-(\d{2})-(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(txt);
  if (!m) return null;
  const [, mm, dd, yyyy, hRaw, min, period] = m;
  let h = Number(hRaw);
  if (h === 12) h = 0;
  if (period.toUpperCase() === 'PM') h += 12;
  // Interpret as UTC. The exact wall-clock is approximate (CC didn't export tz),
  // and Phase 4 uses `paid_on` for the actual money math.
  return new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), h, Number(min)));
}

/** Bucket A balance_due_date clamp: max(event_date - 14d, today). */
function computeBalanceDueDateA(eventDate, today) {
  const minus14 = new Date(eventDate.getTime() - 14 * 86400000);
  return minus14 > today ? minus14 : today;
}

/** Format a Date as `YYYY-MM-DD` (UTC) for DATE-column writes. */
function dateOnly(d) {
  return d.toISOString().slice(0, 10);
}

// ── raw_imports helpers ─────────────────────────────────────────────────

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

async function markRawStatus(execClient, rawImportId, status, notes) {
  await execClient.query(
    `UPDATE legacy_cc_raw_imports
        SET import_status = $2, import_notes = $3::jsonb
      WHERE id = $1`,
    [rawImportId, status, notes == null ? null : JSON.stringify(notes)]
  );
}

// ── per-row context ─────────────────────────────────────────────────────

/**
 * Pull the CC columns we care about into a typed `ctx` object. One pass over
 * the row so the promote helpers stay readable.
 */
function buildRowContext(row) {
  const ccId = trimOrNull(getCol(row, 'ID'));
  const status = trimOrNull(getCol(row, 'Status'));
  const packageName = trimOrNull(getCol(row, 'Package Name'));
  const eventDate = parseCcDate(getCol(row, 'Event Date'));
  const startTime = trimOrNull(getCol(row, 'Start Time'));
  const length = trimOrNull(getCol(row, 'Length'));
  const bookedAt = parseBookedAt(getCol(row, 'Booked At', 'Booked On'));
  const venueName = trimOrNull(getCol(row, 'Venue Name'));
  const venueStreet = trimOrNull(getCol(row, 'Venue Street Address'));
  const venueCity = trimOrNull(getCol(row, 'Venue City'));
  const venueState = trimOrNull(getCol(row, 'Venue State/Province'));
  const venueZip = trimOrNull(getCol(row, 'Venue Postal Code'));
  const venueFull = trimOrNull(getCol(row, 'Venue Full Address'));
  const publicNotes = trimOrNull(getCol(row, 'Public Notes'));
  const privateNotes = trimOrNull(getCol(row, 'Private Notes'));
  const assignedStaff = trimOrNull(getCol(row, 'Assigned Staff'));
  const guestCountRaw = getCol(row, 'Estimated Number of Guests');
  const packageAmountCents = parseMoneyCents(getCol(row, 'Package Amount')) || 0;
  const addons = parseAddons(getCol(row, 'Add On Name, Quantity & Price'));
  const userEmail = trimOrNull(
    getCol(row, 'Contact Email(s)', 'User Email(s)')
  );

  let durationHours = parseLengthHours(length);
  let durationFallback = false;
  if (durationHours == null) {
    durationHours = 4;
    durationFallback = true;
  }

  let guestCount = null;
  let guestCountFallback = false;
  if (guestCountRaw != null && String(guestCountRaw).trim() !== '') {
    const n = parseInt(String(guestCountRaw).replace(/[^\d-]/g, ''), 10);
    if (Number.isFinite(n) && n > 0) {
      guestCount = n;
    } else {
      guestCountFallback = true;
    }
  } else {
    guestCountFallback = true;
  }
  if (guestCount == null) guestCount = 50;

  return {
    ccId, status, packageName, eventDate, startTime, length, bookedAt,
    venueName, venueStreet, venueCity, venueState, venueZip, venueFull,
    publicNotes, privateNotes, assignedStaff,
    guestCountRaw, guestCount, guestCountFallback,
    durationHours, durationFallback,
    packageAmountCents, addons, userEmail,
  };
}

/**
 * Total in DOLLARS to 2dp: (package_cents + sum(addon_cents)) / 100.
 */
function computeTotalDollars(ctx) {
  const addonTotal = ctx.addons.reduce((sum, a) => sum + (a.amount_cents || 0), 0);
  const cents = ctx.packageAmountCents + addonTotal;
  // Round to nearest cent before dividing to avoid 0.005 drift.
  return Math.round(cents) / 100;
}

/** Shape required by the proposal display + payroll consumers (spec §8.3). */
function buildPricingSnapshot(ctx) {
  return {
    package: { name: ctx.packageName, amount_cents: ctx.packageAmountCents },
    gratuity_cents: 0,
    line_items: ctx.addons.map((a) => ({
      name: a.name, qty: a.qty, amount_cents: a.amount_cents,
    })),
    breakdown: [],
    _cc_imported: true,
    _cc_id: ctx.ccId,
  };
}

/** Resolve `clients.id` for the row's CC client. */
async function resolveClientId(client, ctx) {
  // Prefer the email-based lookup so we also catch the case where Phase 2 ran
  // BEFORE Phase 3 but inserted under a different cc_id (operator edit, etc).
  // Phase 2 normalizes email identically, so this LOWER(TRIM(...)) join hits.
  const norm = normalizeEmail(ctx.userEmail);
  if (norm) {
    const r = await client.query(
      `SELECT id FROM clients WHERE LOWER(TRIM(email)) = $1 LIMIT 1`,
      [norm]
    );
    if (r.rowCount === 1) return r.rows[0].id;
  }
  return null;
}

async function resolveClientName(client, clientId) {
  if (!clientId) return null;
  const r = await client.query(`SELECT name FROM clients WHERE id = $1`, [clientId]);
  return r.rowCount ? r.rows[0].name : null;
}

/** ADMIN_EMAIL → users.id, or null. Cached on first call to keep the loop light. */
let adminUserIdCache; // undefined = not yet resolved; null = resolved to "none"
async function resolveAdminUserId(client) {
  if (adminUserIdCache !== undefined) return adminUserIdCache;
  const email = process.env.ADMIN_EMAIL;
  if (!email) { adminUserIdCache = null; return null; }
  const r = await client.query(
    `SELECT id FROM users WHERE email = LOWER(TRIM($1)) LIMIT 1`,
    [email]
  );
  adminUserIdCache = r.rowCount ? r.rows[0].id : null;
  return adminUserIdCache;
}

// ── shift_requests staff matching ───────────────────────────────────────

/**
 * For each assigned-staff name (comma-split), look up the user via the
 * Section 7.3 fuzzy cascade. Returns { inserted, unmatched } where
 * `unmatched` is the list of names that returned 0 or >1 matches, for the
 * outer runner to append to `cc_import_runs.notes`.
 */
async function insertShiftRequestsForStaff(client, shiftId, assignedStaff) {
  const unmatched = [];
  let inserted = 0;
  if (!assignedStaff) return { inserted, unmatched };

  const names = String(assignedStaff)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const name of names) {
    const matches = await findByName(client, name);
    if (matches.length === 1) {
      // `position='Bartender'` is LOAD-BEARING — `payrollAccrual.js:113`
      // filters `(w.position || '').toLowerCase() === 'bartender'`; omitting
      // it makes accrual see zero bartenders and silently skip gratuity
      // allocation for the event.
      await client.query(
        `INSERT INTO shift_requests (shift_id, user_id, status, position)
         VALUES ($1, $2, 'approved', 'Bartender')
         ON CONFLICT (shift_id, user_id) DO NOTHING`,
        [shiftId, matches[0]]
      );
      inserted++;
    } else {
      unmatched.push({ shift_id: shiftId, unmatched_name: name, match_count: matches.length });
    }
  }
  return { inserted, unmatched };
}

// ── core INSERT helpers (shared by Bucket A + Bucket B) ─────────────────

/**
 * INSERT into `proposals`. Returns `{ id }` on insert, or `null` on
 * ON CONFLICT (cc_id) miss (idempotent re-run).
 */
async function insertProposal(client, ctx, opts) {
  const {
    bucketStatus, balanceDueDate, clientId, totalDollars,
    pricingSnapshot, adminNotes, createdByUserId, createdAt,
  } = opts;

  const r = await client.query(
    `INSERT INTO proposals
       (client_id, cc_id, event_date, event_start_time, event_duration_hours, guest_count,
        event_type, event_type_custom, event_type_category,
        total_price, amount_paid, payment_type, status, autopay_enrolled, balance_due_date, last_minute_hold,
        venue_name, venue_street, venue_city, venue_state, venue_zip,
        admin_notes, pricing_snapshot,
        created_by, created_at, sent_at, accepted_at)
     VALUES ($1, $2, $3, $4, $5, $6,
             NULL, NULL, NULL,
             $7, 0.00, 'deposit', $8, false, $9, false,
             $10, $11, $12, $13, $14,
             $15, $16::jsonb,
             $17, $18, $18, $18)
     ON CONFLICT (cc_id) WHERE cc_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      clientId, ctx.ccId, dateOnly(ctx.eventDate), ctx.startTime, ctx.durationHours, ctx.guestCount,
      totalDollars, bucketStatus, balanceDueDate,
      ctx.venueName, ctx.venueStreet, ctx.venueCity, ctx.venueState, ctx.venueZip,
      adminNotes, JSON.stringify(pricingSnapshot),
      createdByUserId, createdAt,
    ]
  );
  return r.rowCount ? { id: r.rows[0].id } : null;
}

async function insertActivityLog(client, proposalId, ctx, bucketLetter, sourceRunId) {
  await client.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
     VALUES ($1, 'cc_import_promoted', 'system', $2::jsonb)`,
    [proposalId, JSON.stringify({ bucket: bucketLetter, cc_id: ctx.ccId, source_run_id: sourceRunId })]
  );
  if (ctx.publicNotes) {
    await client.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
       VALUES ($1, 'cc_import_public_note', 'system', $2::jsonb)`,
      [proposalId, JSON.stringify({ public_notes: ctx.publicNotes })]
    );
  }
}

/**
 * INSERT a single `shifts` row. Returns the new shift id.
 *
 * `num_bartenders` controls `positions_needed` length. CC's `Assigned Staff`
 * has 1 entry per bartender — N commas → N+1 bartenders, missing → 1.
 */
async function insertShift(client, proposalId, ctx, opts) {
  const { bucketLetter, clientName, createdByUserId } = opts;

  const numBartenders = bucketLetter === 'A'
    ? Math.max(1, (String(ctx.assignedStaff || '').split(',').filter((s) => s.trim()).length))
    : 1;
  const positionsNeeded = JSON.stringify(Array(numBartenders).fill('Bartender'));

  const startTime = ctx.startTime;
  const endTime = startTime ? addHours(startTime, ctx.durationHours) : null;
  const location = composeVenueLocation({
    venue_name: ctx.venueName,
    venue_street: ctx.venueStreet,
    venue_city: ctx.venueCity,
    venue_state: ctx.venueState,
    venue_zip: ctx.venueZip,
  });

  const r = await client.query(
    `INSERT INTO shifts
       (proposal_id, event_type, event_type_custom, client_name, event_date,
        start_time, end_time, location, setup_minutes_before, positions_needed,
        notes, status, created_by)
     VALUES ($1, NULL, NULL, $2, $3,
             $4, $5, $6, 60, $7,
             $8, $9, $10)
     RETURNING id`,
    [
      proposalId, clientName, dateOnly(ctx.eventDate),
      startTime, endTime, location, positionsNeeded,
      `Imported from Check Cherry (cc_id=${ctx.ccId})`,
      bucketLetter === 'A' ? 'open' : 'completed',
      createdByUserId,
    ]
  );
  return r.rows[0].id;
}

// ── Bucket A: future Confirmed events ───────────────────────────────────

/**
 * Promote a single CC row as a Bucket A native proposal.
 *
 * @param {object} payload — parsed CC row (column → value)
 * @param {object} options
 * @param {boolean} [options.skipDedup=false] — skip the §7.2 ±14d dedup check
 * @param {number|null} [options.sourceRunId=null] — cc_import_runs.id for audit
 * @param {import('pg').PoolClient} [options.client] — caller-managed pg client
 * @param {Date} [options.today] — UTC midnight for the date clamp
 * @returns {Promise<{status: 'promoted'|'already_promoted'|'duplicate_review'|'errored',
 *                    proposalId?: number, shiftId?: number,
 *                    rawImportId?: number, unmatched?: object[], error?: string}>}
 *
 * Re-run safety (spec §8.3): when the proposal was inserted on a prior run, the
 * INSERT ... ON CONFLICT (cc_id) DO NOTHING returns 0 rows; we look up the
 * existing proposal id and return `'already_promoted'` so the caller can still
 * (idempotently) re-enroll auto-comms if a prior run crashed mid-enrollment.
 * We do NOT re-insert shifts, shift_requests, or activity_log on this branch.
 *
 * Does NOT enroll auto-comms — caller is responsible (so re-promotion from
 * Task 19's UI also gets to decide whether to enroll).
 */
async function promoteBucketA(payload, options = {}) {
  return _promote(payload, { ...options, bucketLetter: 'A' });
}

async function promoteBucketB(payload, options = {}) {
  // Bucket B has no dedup check, no auto-comms.
  return _promote(payload, { ...options, bucketLetter: 'B', skipDedup: true });
}

/**
 * Used by the cc-import Review page's retry endpoints (`/errored-row/:id/retry`,
 * `/skipped-event/:id/promote`). Retry semantics intentionally bypass the
 * skip-list classification (Bucket D) — the operator is asking us to promote,
 * so skip-list rejection doesn't apply. Classify purely by status + date:
 * past + Confirmed → promoteBucketB (completed, no auto-comms);
 * future + Confirmed → promoteBucketA;
 * non-Confirmed or unparseable date → C-degraded to promoteBucketA (operator's
 * "make this active" intent wins; bucket letter preserved in audit log).
 *
 * Returns: { bucket: 'A'|'B'|'C', promote: function(payload, options) }
 */
function classifyForRetry(payload, today = new Date()) {
  const ctx = buildRowContext(payload);
  if (ctx.status !== 'Confirmed' || !ctx.eventDate) {
    return { bucket: 'C', promote: promoteBucketA };
  }
  return ctx.eventDate >= today
    ? { bucket: 'A', promote: promoteBucketA }
    : { bucket: 'B', promote: promoteBucketB };
}

async function _promote(payload, options) {
  const {
    bucketLetter, skipDedup = false, sourceRunId = null,
    today = (() => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; })(),
  } = options;

  // Acquire a client if caller didn't pass one. We DO NOT wrap in a
  // transaction here when caller provides one — they're managing it.
  let client = options.client;
  let ownsClient = false;
  if (!client) {
    client = await pool.connect();
    ownsClient = true;
  }

  try {
    const ctx = buildRowContext(payload);
    if (!ctx.ccId) {
      return { status: 'errored', error: 'cc_id_missing' };
    }
    if (!ctx.eventDate) {
      return { status: 'errored', error: 'event_date_unparseable' };
    }

    const clientId = await resolveClientId(client, ctx);
    if (!clientId) {
      return { status: 'errored', error: 'client_not_found_for_email_or_missing' };
    }

    // Section 7.2 dedup (Bucket A only, unless skipped).
    if (bucketLetter === 'A' && !skipDedup) {
      const dup = await client.query(
        `SELECT id, updated_at FROM proposals
          WHERE client_id = $1
            AND cc_id IS NULL
            AND event_date BETWEEN $2::date - INTERVAL '14 days'
                              AND $2::date + INTERVAL '14 days'
          LIMIT 1`,
        [clientId, dateOnly(ctx.eventDate)]
      );
      if (dup.rowCount > 0) {
        return {
          status: 'duplicate_review',
          candidateProposalId: dup.rows[0].id,
        };
      }
    }

    const totalDollars = computeTotalDollars(ctx);
    const pricingSnapshot = buildPricingSnapshot(ctx);
    const balanceDueDate = bucketLetter === 'A'
      ? dateOnly(computeBalanceDueDateA(ctx.eventDate, today))
      : null;
    const bucketStatus = bucketLetter === 'A' ? 'confirmed' : 'completed';

    const adminNotesParts = [];
    if (ctx.privateNotes) adminNotesParts.push(ctx.privateNotes);
    if (ctx.guestCountFallback) {
      const raw = ctx.guestCountRaw == null ? '(missing)' : String(ctx.guestCountRaw);
      adminNotesParts.push(`[cc-import] guest_count defaulted to 50 (raw value: ${raw})`);
    }
    if (ctx.durationFallback) {
      const raw = ctx.length == null ? '(missing)' : String(ctx.length);
      adminNotesParts.push(`[cc-import] event_duration_hours defaulted to 4 (raw Length: ${raw})`);
    }
    const adminNotes = adminNotesParts.length ? adminNotesParts.join('\n\n') : null;

    const createdByUserId = await resolveAdminUserId(client);
    const createdAt = ctx.bookedAt || new Date();

    const ins = await insertProposal(client, ctx, {
      bucketStatus, balanceDueDate, clientId, totalDollars,
      pricingSnapshot, adminNotes, createdByUserId, createdAt,
    });
    if (!ins) {
      // ON CONFLICT (cc_id) — already promoted on a prior run. Return the
      // existing proposal id so the caller can re-attempt auto-comms enrollment
      // (idempotent via scheduleMessage's ON CONFLICT). We deliberately do NOT
      // re-insert shifts / shift_requests / activity_log here — those were
      // written on the original run.
      const r = await client.query(`SELECT id FROM proposals WHERE cc_id = $1`, [ctx.ccId]);
      const existingId = r.rowCount ? r.rows[0].id : null;
      return { status: 'already_promoted', proposalId: existingId, shiftId: null, reason: 'cc_id_already_present' };
    }
    const proposalId = ins.id;

    await insertActivityLog(client, proposalId, ctx, bucketLetter, sourceRunId);

    const clientName = await resolveClientName(client, clientId);
    const shiftId = await insertShift(client, proposalId, ctx, {
      bucketLetter, clientName, createdByUserId,
    });

    const staffResult = await insertShiftRequestsForStaff(client, shiftId, ctx.assignedStaff);

    return {
      status: 'promoted',
      proposalId,
      shiftId,
      unmatched: staffResult.unmatched.map((u) => ({ ...u, proposal_id: proposalId })),
    };
  } finally {
    if (ownsClient) client.release();
  }
}

// ── Bucket C archive ────────────────────────────────────────────────────

async function archiveBucketC(client, ctx, rawImportId) {
  const totalCents = ctx.packageAmountCents;
  await client.query(
    `INSERT INTO legacy_cc_proposals
       (cc_id, status, client_id, client_email_normalized, client_name,
        event_date, event_type, package_name, service_name, brand,
        venue_name, venue_full_address, estimated_guests, source, lead_type,
        package_amount_cents, public_notes, private_notes, booked_at, raw_import_id)
     SELECT $1, $2, c.id, $4, $5, $6, NULL, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
       FROM (SELECT 1) tmp
       LEFT JOIN clients c ON LOWER(TRIM(c.email)) = $3
     ON CONFLICT (cc_id) DO NOTHING`,
    [
      ctx.ccId,                                                        // $1
      ctx.status || 'unknown',                                         // $2
      normalizeEmail(ctx.userEmail) || '',                             // $3
      normalizeEmail(ctx.userEmail),                                   // $4
      null,                                                            // $5 client_name (we keep this null; CC name field is mostly the event title)
      ctx.eventDate ? dateOnly(ctx.eventDate) : null,                  // $6
      ctx.packageName,                                                 // $7
      trimOrNull(getColPayload(ctx, 'Service Name')),                  // $8
      trimOrNull(getColPayload(ctx, 'Brand')),                         // $9
      ctx.venueName,                                                   // $10
      ctx.venueFull,                                                   // $11
      ctx.guestCountFallback ? null : ctx.guestCount,                  // $12
      trimOrNull(getColPayload(ctx, 'Source')),                        // $13
      trimOrNull(getColPayload(ctx, 'Lead Type')),                     // $14
      totalCents || null,                                              // $15
      ctx.publicNotes,                                                 // $16
      ctx.privateNotes,                                                // $17
      ctx.bookedAt,                                                    // $18
      rawImportId,                                                     // $19
    ]
  );
}

// Bucket-C only — pulls a value out of the row payload that we didn't unpack
// into ctx (we keep ctx narrow on the hot Bucket A/B path). Stored back on
// ctx in the runner so this helper has access.
function getColPayload(ctx, key) {
  if (!ctx._row) return null;
  return getCol(ctx._row, key);
}

// ── runner ──────────────────────────────────────────────────────────────

async function run({
  ccDir,
  loadCsv: loadCsvFn = loadCsv,
  captureMessage = null,
  captureException = null,
} = {}) {
  if (!ccDir) throw new Error('phase3.run: ccDir is required');

  // Reset cached admin id per-run so tests with different ADMIN_EMAIL env
  // values don't see a stale id.
  adminUserIdCache = undefined;

  const runId = await startRun(3);
  const samples = [];
  const unmatchedStaff = [];
  const bucketAPromotedIds = [];
  let processed = 0;
  let inserted = 0; // promoted + archived + duplicate_review (any DB change)
  let skipped = 0;  // Bucket D + ON CONFLICT cc_id skip
  let errored = 0;
  let bucketCounts = { A: 0, B: 0, C: 0, D: 0, dup: 0 };

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  function sendSummary(level, extra) {
    try {
      let send = captureMessage;
      if (!send) {
        const Sentry = require('@sentry/node');
        send = Sentry.captureMessage.bind(Sentry);
      }
      send('cc-import phase 3 summary', { level, extra });
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
    sendSummary('warning', { phase: 3, processed: 0, inserted: 0, errored: 0, skipped: 0, samples });
    await finishRun(runId, {
      status: 'failed',
      rowsProcessed: 0, rowsInserted: 0, rowsSkipped: 0, rowsErrored: 0,
      errorSummary: `phase 3: failed to load ${SOURCE_FILE}: ${err.message}`,
      notes: samples,
    });
    return { processed: 0, inserted: 0, skipped: 0, errored: 0, samples, runId, bucketCounts };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const sourceRowNumber = i + 1;
      processed++;

      const ctx = buildRowContext(row);
      ctx._row = row;

      if (!ctx.ccId) {
        // No idempotency key — record raw row on a separate connection so the
        // outer SAVEPOINT loop doesn't have to rollback this one.
        errored++;
        const c0 = await pool.connect();
        try {
          const rawImportId = await recordRawImport(c0, sourceRowNumber, row, null);
          await markRawStatus(c0, rawImportId, 'errored', {
            error: 'cc_id_missing', source_row_number: sourceRowNumber,
          });
        } finally { c0.release(); }
        if (samples.length < 5) samples.push({ rowNum: sourceRowNumber, error: 'cc_id_missing' });
        continue;
      }

      await client.query('SAVEPOINT row_sp');
      let rawImportId = null;
      try {
        rawImportId = await recordRawImport(client, sourceRowNumber, row, ctx.ccId);
        const bucket = classify({
          status: ctx.status,
          eventDate: ctx.eventDate,
          packageName: ctx.packageName,
        }, today);

        if (bucket === 'D') {
          await markRawStatus(client, rawImportId, 'skipped', {
            reason: 'package_in_skip_list', package_name: ctx.packageName,
          });
          bucketCounts.D++;
          skipped++;
        } else if (bucket === 'C') {
          await archiveBucketC(client, ctx, rawImportId);
          await markRawStatus(client, rawImportId, 'archived', null);
          bucketCounts.C++;
          inserted++;
        } else {
          // Bucket A or B promotion via the named-export helpers. We pass the
          // outer transaction's client so the inserts share its savepoint.
          const promoteFn = bucket === 'A' ? promoteBucketA : promoteBucketB;
          const result = await promoteFn(row, {
            client, sourceRunId: runId, today,
          });

          if (result.status === 'promoted') {
            await markRawStatus(client, rawImportId, 'promoted', {
              source_run_id: runId, proposal_id: result.proposalId, bucket,
            });
            for (const u of (result.unmatched || [])) {
              unmatchedStaff.push(u);
            }
            if (bucket === 'A') {
              bucketAPromotedIds.push(result.proposalId);
              bucketCounts.A++;
            } else {
              bucketCounts.B++;
            }
            inserted++;
          } else if (result.status === 'duplicate_review') {
            await markRawStatus(client, rawImportId, 'duplicate_review', {
              candidate_proposal_id: result.candidateProposalId,
              match_reason: 'client_id+date_within_14d',
              source_run_id: runId,
            });
            bucketCounts.dup++;
            inserted++; // raw row IS modified → count as inserted per convention
          } else if (result.status === 'already_promoted') {
            // cc_id already present from a prior run. Re-mark the raw row
            // 'promoted' (idempotent) and — for Bucket A only — re-enqueue the
            // proposal for the auto-comms enrollment loop after COMMIT, so a
            // crashed prior enrollment can recover. scheduleMessage's
            // ON CONFLICT (entity_id, ..., status='pending') DO NOTHING keeps
            // re-enrollment naturally idempotent (spec §8.3 "Re-call safety").
            await markRawStatus(client, rawImportId, 'promoted', {
              source_run_id: runId, proposal_id: result.proposalId, bucket,
              reason: 'cc_id_already_present',
            });
            if (bucket === 'A' && result.proposalId) {
              bucketAPromotedIds.push(result.proposalId);
            }
            skipped++;
          } else {
            // errored
            throw new Error(result.error || 'promotion_failed');
          }
        }

        await client.query('RELEASE SAVEPOINT row_sp');
      } catch (err) {
        try { await client.query('ROLLBACK TO SAVEPOINT row_sp'); } catch (_) {}
        errored++;
        if (samples.length < 5) samples.push({ rowNum: sourceRowNumber, ccId: ctx.ccId, error: err.message });
        const cErr = await pool.connect();
        try {
          const reInsertId = await recordRawImport(cErr, sourceRowNumber, row, ctx.ccId);
          await markRawStatus(cErr, reInsertId, 'errored', {
            error: err.message, phase: 3, source_row_number: sourceRowNumber,
          });
        } catch (_) {
          // best-effort
        } finally { cErr.release(); }
        reportException(err, { phase: 'cc_import_phase3', ccId: ctx.ccId });
      }
    }

    await client.query('COMMIT');
  } catch (outerErr) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw outerErr;
  } finally {
    client.release();
  }

  // ── Auto-comms enrollment (AFTER outer COMMIT, on separate connections) ──
  for (const proposalId of bucketAPromotedIds) {
    try {
      // Lazy-require — these pull in the whole comms graph; importing at top
      // would slow the importer down on Bucket-C-only re-runs.
      const { scheduleDepositPaidReminders } = require('../../../server/utils/depositPaidSchedulers');
      const { onProposalSignedAndPaid } = require('../../../server/utils/marketingHandlers');
      await scheduleDepositPaidReminders(proposalId, { source: 'cc_import' });
      await onProposalSignedAndPaid(proposalId);
    } catch (err) {
      reportException(err, {
        phase: 'cc_import_phase3', step: 'auto_comms_enroll', proposalId,
      });
      // Continue with the next proposal; the inserts already landed.
    }
  }

  const notes = [
    ...samples,
    ...(unmatchedStaff.length ? [{ unmatched_staff: unmatchedStaff }] : []),
    { buckets: bucketCounts },
  ];

  sendSummary(errored > 0 ? 'warning' : 'info', {
    phase: 3,
    processed,
    inserted,
    skipped,
    errored,
    bucketCounts,
    unmatchedStaffCount: unmatchedStaff.length,
    samples: samples.slice(0, 5),
  });

  await finishRun(runId, {
    status: errored > 0 ? 'partial' : 'succeeded',
    rowsProcessed: processed,
    rowsInserted: inserted,
    rowsSkipped: skipped,
    rowsErrored: errored,
    errorSummary: `phase 3: processed=${processed} inserted=${inserted} skipped=${skipped} errored=${errored} ` +
      `(A=${bucketCounts.A} B=${bucketCounts.B} C=${bucketCounts.C} D=${bucketCounts.D} dup=${bucketCounts.dup})`,
    notes,
  });

  return {
    processed, inserted, skipped, errored,
    bucketCounts, unmatchedStaff, samples, runId, bucketAPromotedIds,
  };
}

module.exports = {
  run,
  promoteBucketA,
  promoteBucketB,
  classifyForRetry,
  // Internals re-exported for unit tests.
  parseAddons,
  parseBookedAt,
  computeBalanceDueDateA,
  buildPricingSnapshot,
  buildRowContext,
};

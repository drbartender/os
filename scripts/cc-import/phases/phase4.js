/**
 * Phase 4 — Payments + refunds (Approach A: row lock + status demote + autopay clear).
 *
 *  - Load `report (11).csv` into `legacy_cc_raw_imports` + `legacy_cc_payments`.
 *  - Resolve `cc_event_id` per row by (event_date, total_price) against
 *    cc-imported proposals (the payments CSV doesn't expose an email column;
 *    see resolveCcEventId for the spec-§8.4 deviation rationale).
 *  - Process each `Payment` row → INSERT into `proposal_payments`
 *    (legacy_charge_id when ch_*, created_at = paid_on noon-UTC).
 *  - Process each `Refund` row via a FOR-UPDATE row lock + two-UPDATE
 *    pattern that mirrors `server/utils/refundHelpers.js:108-310`:
 *      UPDATE #1 — total_price and amount_paid both drop by refund amount.
 *      UPDATE #2 — status demote (balance_paid/deposit_paid only) + autopay clear.
 *    `'completed'` (Bucket B) and `'confirmed'` are preserved by the
 *    outer `WHEN status NOT IN ('balance_paid','deposit_paid') THEN status` guard.
 *  - After ALL rows processed, recompute proposals.amount_paid from scratch,
 *    re-derive payment_type + status (Bucket A confirmed → balance_paid when fully paid),
 *    and suppress now-stale balance-reminder rows.
 *
 * Named exports `promoteSingleLegacyPayment(legacyId, options)` and
 * `promoteSingleLegacyRefund(legacyId, options)` are reused by Task 19's
 * `/orphan-payment/:legacy_id/link` admin endpoint after the operator sets
 * `cc_event_id` (single-row re-promotion).
 *
 * Spec reference: docs/superpowers/specs/2026-05-25-checkcherry-import-design.md §8.4.
 * Plan reference: docs/superpowers/plans/2026-05-26-checkcherry-import.md Task 15.
 */

const path = require('path');
const crypto = require('crypto');
const { pool } = require('../lib/db');
const { startRun, finishRun } = require('../lib/runLog');
const { loadCsv } = require('../lib/csv');
const { parseCcDate } = require('../lib/dateFmt');
const { parseMoneyCents } = require('../lib/money');

const SOURCE_FILE = 'report (11).csv';
const SOURCE_ENTITY = 'payments';

// Stale-reminder sweep covers every dispatcher key that calls the
// "balance reminder fired but balance is zero" guard (spec §8.4 step 8).
const STALE_BALANCE_REMINDER_TYPES = [
  'balance_reminder_autopay_t3',
  'balance_reminder_non_autopay_t3',
  'balance_due_today',
  'balance_late_t1',
  'balance_late_t3',
  'balance_due_today_sms',
  'balance_late_t1_sms',
  'balance_late_t3_sms',
];

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

/** Parse a percentage like '0.0%' or '8.25%' or '0.0' into a Numeric or null. */
function parseTaxRate(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/%/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * `<YYYY-MM-DD>T12:00:00Z` literal for proposal_payments / proposal_refunds
 * created_at — overrides the column DEFAULT NOW() so the financial-dashboard
 * "paid" lens reports on actual paid dates. Noon UTC keeps the row's calendar
 * date stable across server timezones (spec §8.4 step 4).
 */
function paidOnNoonUtc(paidOnDate) {
  if (!paidOnDate) return null;
  const yyyy = paidOnDate.getUTCFullYear();
  const mm = String(paidOnDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(paidOnDate.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T12:00:00Z`;
}

/**
 * Map a CC payment row to (payment_method, legacy_charge_id). Spec §8.4 mapping
 * table.
 */
function mapPaymentMethod(row) {
  const method = (trimOrNull(getCol(row, 'Payment Method')) || '').toLowerCase();
  const processor = (trimOrNull(getCol(row, 'Processor')) || '').toLowerCase();
  const refRaw = trimOrNull(getCol(row, 'Reference Code'));
  const legacyChargeId = refRaw && /^ch_/i.test(refRaw) ? refRaw : null;

  if (method === 'credit card' && processor === 'stripe express') {
    return { paymentMethod: 'card', legacyChargeId };
  }
  if (method === 'credit card') {
    return { paymentMethod: 'card_external', legacyChargeId: null };
  }
  if (method === 'cash') return { paymentMethod: 'cash', legacyChargeId: null };
  if (method === 'check') return { paymentMethod: 'check', legacyChargeId: null };
  if (method === 'paypal') return { paymentMethod: 'paypal', legacyChargeId: null };
  if (method === 'other') return { paymentMethod: 'other', legacyChargeId: null };
  if (method === 'none' || !method) {
    return { paymentMethod: 'unknown', legacyChargeId: null };
  }
  return { paymentMethod: 'other', legacyChargeId };
}

/**
 * Parse one CC row into the typed fields legacy_cc_payments needs. Always
 * positive cents — sign is carried by cc_type. Returns null when the row
 * doesn't carry the bare minimum (cc_type / paid_on / amount).
 */
function parseLegacyPaymentRow(row) {
  const cc_type = trimOrNull(getCol(row, 'Type'));
  if (cc_type !== 'Payment' && cc_type !== 'Refund') return null;

  const paid_on = parseCcDate(getCol(row, 'Paid On'));
  const event_date = parseCcDate(getCol(row, 'Event Date'));

  const rawApplied = parseMoneyCents(getCol(row, 'Payment Applied'));
  if (rawApplied == null) return null;
  const payment_applied_cents = Math.abs(rawApplied);

  const tip_cents = Math.abs(parseMoneyCents(getCol(row, 'Tip Amount')) || 0);
  const processing_fee_cents = Math.abs(parseMoneyCents(getCol(row, 'Processing Fees')) || 0);

  // Net amount keeps its sign in the export (negative on refunds), so we mirror
  // that sign in our column — useful for downstream reconciliation reports.
  const net_cents = parseMoneyCents(getCol(row, 'Net Amount'));
  const event_total_cents = parseMoneyCents(getCol(row, 'Event Total'));
  const taxable_cents = parseMoneyCents(getCol(row, 'Taxable Amount'));
  const total_adjustment_cents = parseMoneyCents(getCol(row, 'Total Adjustment Amount'));
  const tax_collected_cents = parseMoneyCents(getCol(row, 'Tax Collected'));

  return {
    cc_event_title: trimOrNull(getCol(row, 'Event Title')),
    cc_type,
    paid_on,
    event_date,
    payment_applied_cents,
    tip_cents,
    processing_fee_cents,
    net_cents,
    event_total_cents,
    taxable_cents,
    total_adjustment_cents,
    tax_rate_pct: parseTaxRate(getCol(row, 'Tax Rate')),
    tax_collected_cents,
    payment_method: trimOrNull(getCol(row, 'Payment Method')),
    processor: trimOrNull(getCol(row, 'Processor')),
    receipt_number: trimOrNull(getCol(row, 'Receipt Number')),
    invoice_number: trimOrNull(getCol(row, 'Invoice Number')),
    reference_code: trimOrNull(getCol(row, 'Reference Code')),
    paid_by: trimOrNull(getCol(row, 'Paid By')),
    assigned_staff: trimOrNull(getCol(row, 'Assigned Staff')),
    public_notes: trimOrNull(getCol(row, 'Public Notes')),
    private_notes: trimOrNull(getCol(row, 'Private Notes')),
  };
}

// ── raw_imports + legacy_cc_payments writers ─────────────────────────────

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

async function markRawStatus(client, rawImportId, status, notes) {
  await client.query(
    `UPDATE legacy_cc_raw_imports
        SET import_status = $2, import_notes = $3::jsonb
      WHERE id = $1`,
    [rawImportId, status, notes == null ? null : JSON.stringify(notes)]
  );
}

/**
 * Coerce a Date to 'YYYY-MM-DD' for inserting into a DATE column. Returns null
 * for null/undefined. Postgres DATE comparisons against a JS Date silently
 * shift by local tz (pg sends a timestamptz), so we always normalize before
 * crossing the wire.
 */
function dateIso(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d);
}

/**
 * INSERT a legacy_cc_payments row; idempotent via UNIQUE(raw_import_id). Returns
 * the row id (selecting on re-run when the INSERT no-ops).
 */
async function insertLegacyPayment(client, rawImportId, parsed) {
  const ins = await client.query(
    `INSERT INTO legacy_cc_payments
       (cc_event_id, cc_event_title, cc_type, paid_on, event_date,
        payment_applied_cents, tip_cents, processing_fee_cents,
        net_cents, event_total_cents, taxable_cents, total_adjustment_cents,
        tax_rate_pct, tax_collected_cents,
        payment_method, processor,
        receipt_number, invoice_number, reference_code,
        paid_by, assigned_staff, public_notes, private_notes,
        raw_import_id)
     VALUES (NULL, $1, $2, $3::date, $4::date,
             $5, $6, $7,
             $8, $9, $10, $11,
             $12, $13,
             $14, $15,
             $16, $17, $18,
             $19, $20, $21, $22,
             $23)
     ON CONFLICT (raw_import_id) DO NOTHING
     RETURNING id`,
    [
      parsed.cc_event_title, parsed.cc_type, dateIso(parsed.paid_on), dateIso(parsed.event_date),
      parsed.payment_applied_cents, parsed.tip_cents, parsed.processing_fee_cents,
      parsed.net_cents, parsed.event_total_cents, parsed.taxable_cents, parsed.total_adjustment_cents,
      parsed.tax_rate_pct, parsed.tax_collected_cents,
      parsed.payment_method, parsed.processor,
      parsed.receipt_number, parsed.invoice_number, parsed.reference_code,
      parsed.paid_by, parsed.assigned_staff, parsed.public_notes, parsed.private_notes,
      rawImportId,
    ]
  );
  if (ins.rowCount > 0) return ins.rows[0].id;
  const sel = await client.query(
    `SELECT id FROM legacy_cc_payments WHERE raw_import_id = $1`, [rawImportId]
  );
  return sel.rows[0].id;
}

// ── cc_event_id resolver ─────────────────────────────────────────────────

/**
 * Find the matching cc-imported proposal by event_date + total_price.
 *
 * Spec §8.4 step 2 specifies a JOIN by client.email + event_date + total_price,
 * but the payments CSV (report (11).csv) doesn't expose a client email column —
 * the only identifying fields are Event Title (a free-text name + occasion
 * string), Paid By (sometimes the same name), and Reference Code (Stripe charge
 * id). For Phase 4 the (event_date, total_price) pair is unique enough across
 * the cc-imported dataset, and we tiebreak on highest unpaid balance then
 * lowest proposals.id. Anything still ambiguous gets `cc_event_id = NULL` and
 * surfaces on the Review page (Task 19 orphan-payment worklist).
 *
 * @returns {{ccId: string, proposalId: number}|null}
 */
async function resolveCcEventId(client, { eventDate, totalDollars }) {
  if (!eventDate || totalDollars == null) return null;
  // Coerce Date → 'YYYY-MM-DD' so Postgres compares it against the DATE column
  // by-value. Passing a JS Date causes pg to send a timestamptz literal which
  // never equals a bare DATE for an off-midnight zone-shifted value.
  const eventDateIso = eventDate instanceof Date
    ? eventDate.toISOString().slice(0, 10)
    : String(eventDate);
  const r = await client.query(
    `SELECT p.id, p.total_price, p.amount_paid, p.cc_id
       FROM proposals p
      WHERE p.cc_id IS NOT NULL
        AND p.event_date = $1::date
        AND p.total_price = $2
      ORDER BY (p.total_price - p.amount_paid) DESC, p.id ASC`,
    [eventDateIso, totalDollars]
  );
  if (r.rowCount === 0) return null;
  const win = r.rows[0];
  return { ccId: win.cc_id, proposalId: win.id };
}

// ── Step 3 helpers — payment promotion ──────────────────────────────────

/**
 * Compute payment_type for a legacy payment row per the per-event chronological
 * sequence (spec §8.4 "Payment-type chronological-sequence rule"):
 *  - First Payment (paid_on ASC): 'full' if >= proposal.total_price, else 'deposit'.
 *  - Subsequent Payments: 'balance'.
 *
 * Returns one of 'full' | 'deposit' | 'balance'.
 */
async function computePaymentType(client, { ccEventId, currentLegacyId, totalPriceDollars, currentAppliedCents }) {
  const r = await client.query(
    `SELECT id, paid_on, payment_applied_cents
       FROM legacy_cc_payments
      WHERE cc_event_id = $1
        AND cc_type = 'Payment'
      ORDER BY paid_on ASC NULLS LAST, id ASC`,
    [ccEventId]
  );
  // Sequence position: index in the chronological list. ID-stable tiebreak.
  let firstId = null;
  let firstAmount = null;
  for (const row of r.rows) {
    firstId = row.id;
    firstAmount = Number(row.payment_applied_cents);
    break;
  }
  // If the loop didn't find this row in the list (running for a fresh row not
  // yet inserted), treat it as the first by default.
  const isFirst = firstId == null || firstId === currentLegacyId;
  if (isFirst) {
    const totalPriceCents = Math.round(Number(totalPriceDollars) * 100);
    const amount = firstAmount != null ? firstAmount : Number(currentAppliedCents);
    return amount >= totalPriceCents ? 'full' : 'deposit';
  }
  return 'balance';
}

/**
 * Promote a single legacy_cc_payments row of cc_type='Payment' to a
 * proposal_payments row. Idempotent — re-runs skip if promoted_payment_id is set,
 * and the per-proposal unique index on legacy_charge_id catches re-inserts.
 *
 * @param {number} legacyId - legacy_cc_payments.id
 * @param {object} options
 * @param {object} [options.client] - caller pg client. If omitted we acquire one.
 * @param {object} [options.row] - parsed legacy row (avoids a SELECT when caller has it).
 * @returns {{ status: 'promoted'|'already_promoted'|'orphan'|'errored',
 *             paymentId?: number, error?: string, paymentMethod?: string,
 *             legacyChargeId?: string|null }}
 */
async function promoteSingleLegacyPayment(legacyId, options = {}) {
  let client = options.client;
  let ownsClient = false;
  if (!client) {
    client = await pool.connect();
    ownsClient = true;
  }
  try {
    let legacy = options.row;
    if (!legacy) {
      const r = await client.query(
        `SELECT * FROM legacy_cc_payments WHERE id = $1`, [legacyId]
      );
      if (r.rowCount === 0) return { status: 'errored', error: 'legacy_row_not_found' };
      legacy = r.rows[0];
    }
    if (legacy.cc_type !== 'Payment') {
      return { status: 'errored', error: 'wrong_cc_type' };
    }
    if (legacy.promoted_payment_id) {
      return { status: 'already_promoted', paymentId: legacy.promoted_payment_id };
    }
    if (!legacy.cc_event_id) {
      return { status: 'orphan' };
    }

    // Resolve proposal id + total_price.
    const pr = await client.query(
      `SELECT id, total_price FROM proposals WHERE cc_id = $1`,
      [legacy.cc_event_id]
    );
    if (pr.rowCount === 0) return { status: 'errored', error: 'proposal_not_found_for_cc_event_id' };
    const proposalId = pr.rows[0].id;
    const totalPriceDollars = Number(pr.rows[0].total_price);

    // Map payment_method + legacy_charge_id from the raw CC row stored in the
    // legacy table (payment_method / processor / reference_code).
    const ccRowLike = {
      'Payment Method': legacy.payment_method,
      'Processor': legacy.processor,
      'Reference Code': legacy.reference_code,
    };
    const { paymentMethod, legacyChargeId } = mapPaymentMethod(ccRowLike);

    const paymentType = await computePaymentType(client, {
      ccEventId: legacy.cc_event_id,
      currentLegacyId: legacy.id,
      totalPriceDollars,
      currentAppliedCents: legacy.payment_applied_cents,
    });

    const createdAt = paidOnNoonUtc(legacy.paid_on);

    // INSERT proposal_payments with the per-proposal unique index protecting
    // re-runs for ch_* rows. Rows without legacy_charge_id can re-insert on
    // a hard re-run; the outer idempotency check (promoted_payment_id) catches
    // most of those. For the no-charge-id case we rely on the promoted_payment_id
    // link being set, plus the operator's awareness of CSV re-imports.
    //
    // When CC's `Paid On` column is empty, paidOnNoonUtc returns null. We OMIT
    // the created_at column from the INSERT so the schema's DEFAULT NOW() fires
    // — writing literal NULL would (a) exclude the row from the financial
    // dashboard "paid" lens (date-grouped by created_at), and (b) break the
    // manual-reconciliation skip's ±24h window on subsequent re-runs.
    const ins = createdAt != null
      ? await client.query(
          `INSERT INTO proposal_payments
             (proposal_id, amount, fee_cents, payment_type, payment_method,
              stripe_payment_intent_id, legacy_charge_id, status, created_at)
           VALUES ($1, $2, $3, $4, $5, NULL, $6, 'succeeded', $7)
           ON CONFLICT (proposal_id, legacy_charge_id)
             WHERE legacy_charge_id IS NOT NULL DO NOTHING
           RETURNING id`,
          [
            proposalId,
            legacy.payment_applied_cents,
            legacy.processing_fee_cents,
            paymentType,
            paymentMethod,
            legacyChargeId,
            createdAt,
          ]
        )
      : await client.query(
          `INSERT INTO proposal_payments
             (proposal_id, amount, fee_cents, payment_type, payment_method,
              stripe_payment_intent_id, legacy_charge_id, status)
           VALUES ($1, $2, $3, $4, $5, NULL, $6, 'succeeded')
           ON CONFLICT (proposal_id, legacy_charge_id)
             WHERE legacy_charge_id IS NOT NULL DO NOTHING
           RETURNING id`,
          [
            proposalId,
            legacy.payment_applied_cents,
            legacy.processing_fee_cents,
            paymentType,
            paymentMethod,
            legacyChargeId,
          ]
        );

    let paymentId;
    if (ins.rowCount > 0) {
      paymentId = ins.rows[0].id;
    } else {
      // ON CONFLICT — a prior partial run inserted the row but didn't set
      // promoted_payment_id. Find the existing row by (proposal_id, legacy_charge_id)
      // and link it. Safe because legacy_charge_id is unique per proposal.
      const existing = await client.query(
        `SELECT id FROM proposal_payments
          WHERE proposal_id = $1 AND legacy_charge_id = $2`,
        [proposalId, legacyChargeId]
      );
      if (existing.rowCount === 0) {
        return { status: 'errored', error: 'insert_skipped_no_existing_row' };
      }
      paymentId = existing.rows[0].id;
    }

    await client.query(
      `UPDATE legacy_cc_payments SET promoted_payment_id = $1 WHERE id = $2`,
      [paymentId, legacyId]
    );

    return { status: 'promoted', paymentId, paymentMethod, legacyChargeId };
  } finally {
    if (ownsClient) client.release();
  }
}

/**
 * Promote a single legacy_cc_payments row of cc_type='Refund' to a
 * proposal_refunds row. Uses a dedicated client + transaction with a FOR-UPDATE
 * row lock — mirrors refundHelpers.js:108-310's Approach A.
 *
 * The status-demote outer guard `WHEN status NOT IN ('balance_paid','deposit_paid') THEN status`
 * preserves 'completed' (Bucket B terminal) and 'confirmed'/earlier lifecycle
 * states. Only balance_paid/deposit_paid get reshuffled by the refund.
 *
 * @returns {{ status: 'promoted'|'already_promoted'|'manual_skipped'|'orphan'|'errored'|'exceeds_net_paid',
 *             refundId?: number, refundCents?: number, netPaidCents?: number,
 *             error?: string }}
 */
async function promoteSingleLegacyRefund(legacyId, options = {}) {
  // We must NOT reuse the caller's client/transaction for the refund's
  // row-locked transaction — Approach A requires a dedicated connection
  // (refundHelpers.js:108). The caller's client may be in the middle of a
  // different transaction. So we always acquire a fresh pool client for the
  // refund's BEGIN/COMMIT.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Snapshot the legacy row inside this txn (caller-provided `options.row`
    // could be stale).
    const lr = await client.query(
      `SELECT id, cc_type, cc_event_id, paid_on, payment_applied_cents,
              promoted_refund_id
         FROM legacy_cc_payments WHERE id = $1`,
      [legacyId]
    );
    if (lr.rowCount === 0) {
      await client.query('ROLLBACK');
      return { status: 'errored', error: 'legacy_row_not_found' };
    }
    const legacy = lr.rows[0];
    if (legacy.cc_type !== 'Refund') {
      await client.query('ROLLBACK');
      return { status: 'errored', error: 'wrong_cc_type' };
    }
    if (legacy.promoted_refund_id) {
      await client.query('ROLLBACK');
      return { status: 'already_promoted', refundId: legacy.promoted_refund_id };
    }
    if (!legacy.cc_event_id) {
      await client.query('ROLLBACK');
      return { status: 'orphan' };
    }

    const refundAmountCents = Math.abs(Number(legacy.payment_applied_cents));
    const paidOnIso = paidOnNoonUtc(legacy.paid_on);

    // Resolve proposal id (still inside txn so cc_id resolution is consistent
    // with the lock that follows).
    const pr = await client.query(
      `SELECT id FROM proposals WHERE cc_id = $1`, [legacy.cc_event_id]
    );
    if (pr.rowCount === 0) {
      await client.query('ROLLBACK');
      return { status: 'errored', error: 'proposal_not_found_for_cc_event_id' };
    }
    const proposalId = pr.rows[0].id;

    // Manual-reconciliation skip (spec §8.4 step 5):
    //   reason LIKE 'Manual Stripe reconciliation%' + amount match + ±24h window.
    if (paidOnIso) {
      const manual = await client.query(
        `SELECT id FROM proposal_refunds
          WHERE proposal_id = $1
            AND reason LIKE 'Manual Stripe reconciliation%'
            AND amount = $2
            AND created_at >= $3::timestamptz - INTERVAL '1 day'
            AND created_at <= $3::timestamptz + INTERVAL '1 day'
          LIMIT 1`,
        [proposalId, refundAmountCents, paidOnIso]
      );
      if (manual.rowCount > 0) {
        await client.query(
          `UPDATE legacy_cc_payments SET promoted_refund_id = $1 WHERE id = $2`,
          [manual.rows[0].id, legacyId]
        );
        await client.query('COMMIT');
        return { status: 'manual_skipped', refundId: manual.rows[0].id };
      }
    } else {
      // paid_on missing in CC export — we can't run the ±24h match, so the
      // manual-reconciliation skip is bypassed for this row. Non-fatal: the
      // refund will be inserted normally below. Operators may see a duplicate
      // refund if a matching manual reconciliation already exists.
      console.warn(
        `[cc-import phase4] manual-reconciliation skip bypassed for legacy_cc_payments id=${legacyId} ` +
        `(proposal_id=${proposalId}): paid_on is NULL — cannot match against existing manual refunds.`
      );
    }

    // Lock the proposal row. Per refundHelpers.js:118-121, the SELECT locks
    // total_price + amount_paid + status; UPDATE #2's autopay_enrolled CASE
    // reads inline and doesn't need to be in the lock SELECT.
    const lockRes = await client.query(
      `SELECT total_price, amount_paid, status
         FROM proposals WHERE id = $1 FOR UPDATE`,
      [proposalId]
    );
    if (lockRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return { status: 'errored', error: 'proposal_not_found_in_lock' };
    }
    const totalPriceBefore = Number(lockRes.rows[0].total_price);

    // Refund-without-payment assertion (subtract prior refunds, spec §8.4 step 5).
    const netRes = await client.query(
      `SELECT
         COALESCE((SELECT SUM(amount) FROM proposal_payments
                    WHERE proposal_id = $1 AND status = 'succeeded'), 0)
       - COALESCE((SELECT SUM(amount) FROM proposal_refunds
                    WHERE proposal_id = $1 AND status = 'succeeded'), 0)
         AS net_paid_cents`,
      [proposalId]
    );
    const netPaidCents = Number(netRes.rows[0].net_paid_cents);
    if (netPaidCents < refundAmountCents) {
      // Mark raw row errored on the SAME txn (we're about to ROLLBACK, so do it
      // on a fresh connection so the marker survives).
      await client.query('ROLLBACK');
      const c2 = await pool.connect();
      try {
        const rawRes = await c2.query(
          `SELECT raw_import_id FROM legacy_cc_payments WHERE id = $1`,
          [legacyId]
        );
        if (rawRes.rowCount > 0) {
          await markRawStatus(c2, rawRes.rows[0].raw_import_id, 'errored', {
            error: 'refund_exceeds_net_paid',
            refund_cents: refundAmountCents,
            net_paid_cents: netPaidCents,
            proposal_id: proposalId,
          });
        }
      } finally { c2.release(); }
      return {
        status: 'exceeds_net_paid',
        refundCents: refundAmountCents,
        netPaidCents,
      };
    }

    const totalPriceAfter = Math.max(0, totalPriceBefore - refundAmountCents / 100);

    // INSERT proposal_refunds. When paidOnIso is null (CC's `Paid On` empty),
    // OMIT created_at so the schema's DEFAULT NOW() fires — see the matching
    // payment-INSERT comment above for the dashboard/skip-window reasoning.
    const refRes = paidOnIso != null
      ? await client.query(
          `INSERT INTO proposal_refunds
             (proposal_id, payment_id, stripe_payment_intent_id, stripe_refund_id,
              amount, reason, total_price_before, total_price_after,
              issued_by, status, created_at)
           VALUES ($1, NULL, NULL, NULL,
                   $2, $3, $4, $5,
                   NULL, 'succeeded', $6)
           RETURNING id`,
          [
            proposalId, refundAmountCents,
            'Legacy Check Cherry import — refund reason not exported',
            totalPriceBefore, totalPriceAfter, paidOnIso,
          ]
        )
      : await client.query(
          `INSERT INTO proposal_refunds
             (proposal_id, payment_id, stripe_payment_intent_id, stripe_refund_id,
              amount, reason, total_price_before, total_price_after,
              issued_by, status)
           VALUES ($1, NULL, NULL, NULL,
                   $2, $3, $4, $5,
                   NULL, 'succeeded')
           RETURNING id`,
          [
            proposalId, refundAmountCents,
            'Legacy Check Cherry import — refund reason not exported',
            totalPriceBefore, totalPriceAfter,
          ]
        );
    const refundId = refRes.rows[0].id;

    // UPDATE #1 — money (mirrors refundHelpers.js:230-236 Approach A).
    // Both total_price AND amount_paid drop by the refund amount (legacy CC
    // refunds are treated as the contract portion — CC doesn't distinguish
    // contract vs extra-scope). GREATEST clamps both ≥ 0.
    await client.query(
      `UPDATE proposals
          SET total_price = GREATEST(total_price - ($1 / 100.0), 0),
              amount_paid = GREATEST(amount_paid - ($1 / 100.0), 0)
        WHERE id = $2`,
      [refundAmountCents, proposalId]
    );

    // UPDATE #2 — status demote + autopay clear (mirrors refundHelpers.js:245-264).
    // Outer guard `NOT IN ('balance_paid','deposit_paid')` preserves 'completed'
    // (Bucket B terminal) and 'confirmed'/earlier lifecycle states; only the
    // already-paid statuses get reshuffled. autopay clears on the
    // balance_paid → deposit_paid transition (the case that would otherwise let
    // balanceScheduler.js re-charge the exact amount just refunded).
    await client.query(
      `UPDATE proposals
          SET status = CASE
                WHEN status NOT IN ('balance_paid','deposit_paid') THEN status
                WHEN amount_paid <= 0 THEN 'accepted'
                WHEN amount_paid < total_price THEN 'deposit_paid'
                ELSE status
              END,
              autopay_enrolled = CASE
                WHEN status = 'balance_paid' AND amount_paid < total_price THEN false
                ELSE autopay_enrolled
              END
        WHERE id = $1`,
      [proposalId]
    );

    await client.query(
      `UPDATE legacy_cc_payments SET promoted_refund_id = $1 WHERE id = $2`,
      [refundId, legacyId]
    );

    await client.query('COMMIT');
    return { status: 'promoted', refundId };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

// ── Steps 5-7: proposal-wide recompute / re-derive / suppress ────────────

/**
 * Recompute proposals.amount_paid from scratch for all cc-imported rows
 * (spec §8.4 step 6). Idempotent.
 */
async function recomputeAmountPaid(client) {
  await client.query(
    `UPDATE proposals
        SET amount_paid = ((COALESCE((SELECT SUM(amount) FROM proposal_payments p
                                      WHERE p.proposal_id = proposals.id AND p.status='succeeded'), 0)
                         - COALESCE((SELECT SUM(amount) FROM proposal_refunds  r
                                      WHERE r.proposal_id = proposals.id AND r.status='succeeded'), 0)
                         )::numeric / 100.0)::numeric(10,2)
      WHERE cc_id IS NOT NULL`
  );
}

/**
 * Re-derive payment_type + (Bucket A only) status from the freshly-recomputed
 * amount_paid (spec §8.4 step 7). Bucket B stays 'completed'.
 */
async function rederivePaymentTypeAndStatus(client) {
  await client.query(
    `UPDATE proposals
        SET payment_type = CASE WHEN amount_paid >= total_price THEN 'full' ELSE 'deposit' END,
            status = CASE
              WHEN cc_id IS NOT NULL
                AND status = 'confirmed'
                AND amount_paid >= total_price
                AND event_date >= CURRENT_DATE
              THEN 'balance_paid'
              ELSE status
            END
      WHERE cc_id IS NOT NULL`
  );
}

/**
 * Suppress the now-stale balance-reminder rows that Phase 3 enqueued against
 * amount_paid=0 for cc-imported events that arrived already paid-in-full at CC.
 * Spec §8.4 step 8.
 */
async function suppressStaleBalanceReminders(client) {
  const r = await client.query(
    `UPDATE scheduled_messages sm
        SET status = 'suppressed',
            error_message = 'cc-import: balance settled at import'
      WHERE sm.entity_type = 'proposal'
        AND sm.status = 'pending'
        AND sm.message_type = ANY($1::text[])
        AND sm.entity_id IN (
          SELECT id FROM proposals WHERE cc_id IS NOT NULL AND amount_paid >= total_price
        )`,
    [STALE_BALANCE_REMINDER_TYPES]
  );
  return r.rowCount;
}

// ── runner ──────────────────────────────────────────────────────────────

async function run({
  ccDir,
  loadCsv: loadCsvFn = loadCsv,
  captureMessage = null,
  captureException = null,
} = {}) {
  if (!ccDir) throw new Error('phase4.run: ccDir is required');

  const runId = await startRun(4);
  const samples = [];
  let processed = 0;
  let inserted = 0;  // payments+refunds linked (either fresh or already_promoted on this run)
  let skipped = 0;   // orphans + manual-reconciliation skips + idempotent skips
  let errored = 0;
  const counts = {
    payments_promoted: 0,
    refunds_promoted: 0,
    orphans: 0,
    manual_skipped: 0,
    exceeds_net_paid: 0,
    already_promoted: 0,
    unknown_method: 0,
  };

  function sendSummary(level, extra) {
    try {
      let send = captureMessage;
      if (!send) {
        const Sentry = require('@sentry/node');
        send = Sentry.captureMessage.bind(Sentry);
      }
      send('cc-import phase 4 summary', { level, extra });
    } catch (_) { /* Sentry must never break the importer. */ }
  }
  function reportException(err, tags) {
    try {
      let send = captureException;
      if (!send) {
        const Sentry = require('@sentry/node');
        send = Sentry.captureException.bind(Sentry);
      }
      send(err, { tags });
    } catch (_) { /* best-effort */ }
  }

  // Step 1 — load CSV.
  let rows;
  try {
    rows = loadCsvFn(path.join(ccDir, SOURCE_FILE));
  } catch (err) {
    samples.push({ file: SOURCE_FILE, error: `Could not load CSV: ${err.message}` });
    sendSummary('warning', { phase: 4, processed: 0, inserted: 0, errored: 0, skipped: 0, samples });
    await finishRun(runId, {
      status: 'failed',
      rowsProcessed: 0, rowsInserted: 0, rowsSkipped: 0, rowsErrored: 0,
      errorSummary: `phase 4: failed to load ${SOURCE_FILE}: ${err.message}`,
      notes: samples,
    });
    return { processed: 0, inserted: 0, skipped: 0, errored: 0, samples, runId, counts };
  }

  // Step 1 + 2 — load each row into legacy_cc_payments AND resolve cc_event_id.
  // We do these per-row using a long-lived client (no surrounding transaction —
  // each row is small and idempotent, and we don't want one bad parse to roll
  // back the whole batch). The Phase 4 refund step then acquires its own
  // dedicated client per refund row for the row-locked transaction.
  const loadClient = await pool.connect();
  // Track legacy rows by (cc_type) so step 3 (payments) and step 4 (refunds)
  // can iterate without re-querying the whole table.
  const paymentLegacyIds = [];
  const refundLegacyIds = [];
  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const sourceRowNumber = i + 1;
      processed++;

      const parsed = parseLegacyPaymentRow(row);
      if (!parsed) {
        errored++;
        try {
          const rawId = await recordRawImport(loadClient, sourceRowNumber, row);
          await markRawStatus(loadClient, rawId, 'errored', {
            error: 'unparseable_payment_row',
            source_row_number: sourceRowNumber,
            phase: 4,
          });
        } catch (e2) {
          reportException(e2, { phase: 'cc_import_phase4', step: 'raw_record', sourceRowNumber });
        }
        if (samples.length < 5) {
          samples.push({ rowNum: sourceRowNumber, error: 'unparseable_payment_row' });
        }
        continue;
      }

      try {
        const rawImportId = await recordRawImport(loadClient, sourceRowNumber, row);
        const legacyId = await insertLegacyPayment(loadClient, rawImportId, parsed);

        // Step 2 — resolve cc_event_id (always re-resolve; idempotent UPDATE).
        const totalDollars = parsed.event_total_cents != null
          ? Number(parsed.event_total_cents) / 100
          : null;
        const resolved = await resolveCcEventId(loadClient, {
          eventDate: parsed.event_date,
          totalDollars,
        });
        if (resolved) {
          await loadClient.query(
            `UPDATE legacy_cc_payments SET cc_event_id = $1 WHERE id = $2`,
            [resolved.ccId, legacyId]
          );
        } else {
          counts.orphans++;
        }

        if (parsed.cc_type === 'Payment') paymentLegacyIds.push(legacyId);
        else refundLegacyIds.push(legacyId);
      } catch (err) {
        errored++;
        reportException(err, {
          phase: 'cc_import_phase4', step: 'load_or_resolve', sourceRowNumber,
        });
        if (samples.length < 5) {
          samples.push({ rowNum: sourceRowNumber, error: err.message });
        }
      }
    }
  } finally {
    loadClient.release();
  }

  // Step 3 — promote Payment rows. Each uses a fresh client connection so a
  // single failure doesn't poison the batch.
  for (const legacyId of paymentLegacyIds) {
    try {
      const r = await promoteSingleLegacyPayment(legacyId);
      if (r.status === 'promoted') {
        inserted++;
        counts.payments_promoted++;
        if (r.paymentMethod === 'unknown') counts.unknown_method++;
      } else if (r.status === 'already_promoted') {
        skipped++;
        counts.already_promoted++;
      } else if (r.status === 'orphan') {
        skipped++;
        // counts.orphans already incremented at resolve time.
      } else {
        errored++;
        if (samples.length < 5) samples.push({ legacyId, error: r.error || r.status });
      }
    } catch (err) {
      errored++;
      reportException(err, {
        phase: 'cc_import_phase4', step: 'promote_payment', legacyId,
      });
      if (samples.length < 5) samples.push({ legacyId, error: err.message });
    }
  }

  // Step 4 — process Refund rows.
  for (const legacyId of refundLegacyIds) {
    try {
      const r = await promoteSingleLegacyRefund(legacyId);
      if (r.status === 'promoted') {
        inserted++;
        counts.refunds_promoted++;
      } else if (r.status === 'manual_skipped') {
        skipped++;
        counts.manual_skipped++;
      } else if (r.status === 'already_promoted') {
        skipped++;
        counts.already_promoted++;
      } else if (r.status === 'orphan') {
        skipped++;
      } else if (r.status === 'exceeds_net_paid') {
        errored++;
        counts.exceeds_net_paid++;
        // raw row already marked errored inside promoteSingleLegacyRefund.
      } else {
        errored++;
        if (samples.length < 5) samples.push({ legacyId, error: r.error || r.status });
      }
    } catch (err) {
      errored++;
      reportException(err, {
        phase: 'cc_import_phase4', step: 'promote_refund', legacyId,
      });
      if (samples.length < 5) samples.push({ legacyId, error: err.message });
    }
  }

  // Steps 5-7 — proposal-wide recompute, re-derive, suppress stale reminders.
  const tailClient = await pool.connect();
  let suppressedCount = 0;
  try {
    await recomputeAmountPaid(tailClient);
    await rederivePaymentTypeAndStatus(tailClient);
    suppressedCount = await suppressStaleBalanceReminders(tailClient);
  } catch (err) {
    // Tail failures are reported but don't roll back the whole phase — the
    // per-row promotions already committed.
    errored++;
    reportException(err, { phase: 'cc_import_phase4', step: 'proposal_recompute' });
    if (samples.length < 5) samples.push({ step: 'proposal_recompute', error: err.message });
  } finally {
    tailClient.release();
  }

  const notes = [
    ...samples,
    { counts, suppressed_balance_reminders: suppressedCount },
  ];

  sendSummary(errored > 0 ? 'warning' : 'info', {
    phase: 4,
    processed, inserted, skipped, errored,
    counts,
    suppressed_balance_reminders: suppressedCount,
    samples: samples.slice(0, 5),
  });

  await finishRun(runId, {
    status: errored > 0 ? 'partial' : 'succeeded',
    rowsProcessed: processed,
    rowsInserted: inserted,
    rowsSkipped: skipped,
    rowsErrored: errored,
    errorSummary: `phase 4: processed=${processed} inserted=${inserted} skipped=${skipped} errored=${errored} ` +
      `(payments=${counts.payments_promoted} refunds=${counts.refunds_promoted} ` +
      `orphans=${counts.orphans} manual_skip=${counts.manual_skipped} ` +
      `exceeds_net=${counts.exceeds_net_paid} already=${counts.already_promoted}) ` +
      `suppressed_reminders=${suppressedCount}`,
    notes,
  });

  return {
    processed, inserted, skipped, errored,
    counts, suppressedBalanceReminders: suppressedCount,
    samples, runId,
  };
}

module.exports = {
  run,
  promoteSingleLegacyPayment,
  promoteSingleLegacyRefund,
  // Internals re-exported for unit tests.
  parseLegacyPaymentRow,
  mapPaymentMethod,
  computePaymentType,
  resolveCcEventId,
  recomputeAmountPaid,
  rederivePaymentTypeAndStatus,
  suppressStaleBalanceReminders,
  paidOnNoonUtc,
  STALE_BALANCE_REMINDER_TYPES,
};

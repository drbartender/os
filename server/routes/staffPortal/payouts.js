// Staffer payout READ endpoints for the staff portal Pay tab (spec §6.6).
//
// Mounted at /api/me by the parent router. `auth` is already applied upstream
// (server/routes/staffPortal.js calls router.use(auth) before register).
//
// Both endpoints are hard-scoped to req.user.id — there is NO `:userId` path
// param, ever. This file is the staffer-facing counterpart to the admin-only
// /api/admin/payroll/contractors/:userId/payouts and /api/admin/payroll/periods/:id
// queries. Money + PII surface, so:
//
//   - SELECTs are parameterized and pinned to po.contractor_id = $1 = req.user.id
//   - We DO NOT project payment_method / payment_handle (those snapshot bank/
//     handle data and the Pay tab doesn't need them — see spec §6.6)
//   - A 404 on the detail endpoint for a payout that belongs to ANOTHER user
//     IS the IDOR guard: a staffer asking "give me /periods/:periodId" gets
//     NotFound iff no payouts row exists for (this user, this period)
//
// Money is integer cents only. summary sums are computed in SQL with COALESCE
// so an empty payout returns zeros, never NULL.

const { pool } = require('../../db');
const asyncHandler = require('../../middleware/asyncHandler');
const { ConflictError, NotFoundError, ValidationError } = require('../../utils/errors');
const storage = require('../../utils/storage');
const { assemblePaystubData } = require('../../utils/paystubData');
const { renderPaystubPdf } = require('../../utils/paystubPdf');

// pg returns DATE columns as JS Date objects; String(Date) yields a long
// "Fri May 29 2026 …" string. Normalize to YYYY-MM-DD so the client gets
// clean dates and never has to second-guess the format. Mirrors ymd() in
// server/routes/admin/payroll.js (load-bearing helper).
function ymd(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

function register(router) {
  // ─── GET /api/me/payouts ─────────────────────────────────────────────────
  // List the logged-in staffer's payouts, newest pay period first.
  //
  // Mirrors the admin per-contractor list (admin/payroll.js:413) but:
  //   - WHERE po.contractor_id = $1 is hardcoded to req.user.id (no userId param)
  //   - payment_method + payment_handle ARE NOT projected (spec §6.6 PII)
  router.get('/payouts', asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT po.id, po.status, po.total_cents, po.paid_at, po.paystub_storage_key,
              pp.id   AS period_id,
              pp.start_date, pp.end_date, pp.payday,
              CASE WHEN pp.status = 'reopened' THEN 'processing' ELSE pp.status END AS period_status,
              COALESCE(ec.event_count, 0) AS event_count
         FROM payouts po
         JOIN pay_periods pp ON pp.id = po.pay_period_id
         LEFT JOIN (
           SELECT payout_id, COUNT(*)::int AS event_count
             FROM payout_events
            GROUP BY payout_id
         ) ec ON ec.payout_id = po.id
        WHERE po.contractor_id = $1
        ORDER BY pp.start_date DESC`,
      [req.user.id]
    );
    res.json({
      payouts: rows.map((r) => ({
        id: r.id,
        status: r.status,
        total_cents: r.total_cents,
        paid_at: r.paid_at,
        paystub_storage_key: r.paystub_storage_key,
        event_count: Number(r.event_count),
        period: {
          id: r.period_id,
          start_date: ymd(r.start_date),
          end_date: ymd(r.end_date),
          payday: ymd(r.payday),
          status: r.period_status,
        },
      })),
    });
  }));

  // ─── GET /api/me/payment-history ─────────────────────────────────────────
  // The logged-in staffer's imported pre-OS payment history + a blended
  // all-time total (imported ledger + own PAID OS payouts). Spec §8.2.
  //
  // Hard-scoped to req.user.id (no :userId param, ever). PII discipline: this
  // returns platform ONLY — NO memo, NO source_account, NO payee handles (spec
  // §9; mirrors the paystub project's payment_handle exclusion). Reads
  // staff_payment_history ONLY; never legacy_cc_payouts.
  router.get('/payment-history', asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT paid_on, amount_cents, platform
         FROM staff_payment_history
        WHERE contractor_id = $1
        ORDER BY paid_on DESC, id DESC`,
      [req.user.id]
    );

    const ledgerCents = rows.reduce((sum, r) => sum + Number(r.amount_cents), 0);
    const paidRes = await pool.query(
      `SELECT COALESCE(SUM(total_cents), 0)::bigint AS cents
         FROM payouts
        WHERE contractor_id = $1 AND status = 'paid'`,
      [req.user.id]
    );
    const paidCents = Number(paidRes.rows[0].cents);

    res.json({
      history: rows.map((r) => ({
        paid_on: ymd(r.paid_on),
        amount_cents: Number(r.amount_cents),
        platform: r.platform,
      })),
      total_cents: ledgerCents,
      blended_total_cents: ledgerCents + paidCents,
    });
  }));

  // ─── GET /api/me/payouts/:periodId ───────────────────────────────────────
  // One pay period's detail for THIS staffer. The IDOR guard is the JOIN
  // condition po.contractor_id = $1 AND po.pay_period_id = $2: if there is
  // no payouts row for (this user, this period) we throw NotFound. A staffer
  // asking for a periodId that exists but belongs to someone else (or for a
  // periodId they were never paid in) gets exactly the same 404 — no info
  // leak about which periods exist.
  router.get('/payouts/:periodId', asyncHandler(async (req, res) => {
    const periodId = Number(req.params.periodId);
    if (!Number.isInteger(periodId) || periodId <= 0) {
      throw new ValidationError({ periodId: 'must be a positive integer' }, 'Invalid period id');
    }

    // One query that JOINs period + this user's payout. NotFound if either no
    // such period OR no payout for this user in that period. The combined
    // check is the whole point — we never reveal "the period exists but isn't
    // yours" vs "no such period".
    const payoutRes = await pool.query(
      `SELECT po.id            AS payout_id,
              po.status        AS payout_status,
              po.total_cents,
              po.paid_at,
              po.paystub_storage_key,
              pp.id            AS period_id,
              pp.start_date,
              pp.end_date,
              pp.payday,
              CASE WHEN pp.status = 'reopened' THEN 'processing' ELSE pp.status END AS period_status
         FROM payouts po
         JOIN pay_periods pp ON pp.id = po.pay_period_id
        WHERE po.contractor_id = $1
          AND po.pay_period_id = $2`,
      [req.user.id, periodId]
    );
    if (!payoutRes.rows[0]) throw new NotFoundError('Payout not found');
    const p = payoutRes.rows[0];

    // Pull the payout_events for this payout + project the linked
    // shift/proposal/client labels. Mirrors the staff-home / admin-payroll
    // JOIN: shifts -> proposals -> clients. LEFT JOINs because a shift can
    // outlive its proposal/client in dev data, and we'd rather show the line
    // than 500 the page.
    const eventsRes = await pool.query(
      `SELECT pe.shift_id,
              pe.contracted_hours, pe.hours, pe.rate_cents, pe.wage_cents, pe.late,
              pe.gratuity_share_cents,
              pe.card_tip_gross_cents, pe.card_tip_fee_cents, pe.card_tip_net_cents,
              pe.adjustment_cents, pe.adjustment_note, pe.line_total_cents,
              pe.held_state,
              pr.event_date, pr.event_type, pr.event_type_custom,
              c.name AS client_name
         FROM payout_events pe
         JOIN shifts s ON s.id = pe.shift_id
    LEFT JOIN proposals pr ON pr.id = s.proposal_id
    LEFT JOIN clients c   ON c.id = pr.client_id
        WHERE pe.payout_id = $1
        ORDER BY pr.event_date ASC, pe.id ASC`,
      [p.payout_id]
    );

    // Sum in JS off the same rows we're already returning. Money is integer
    // cents — Number() each column before summing (pg returns INTEGERs as JS
    // numbers, but we coerce defensively in case a NUMERIC sneaks in).
    // Held lines are sign-scoped (B13, mirrors paystubData.js). A held POSITIVE
    // reimbursement is tracked but NON-payable (line_total 0), so it is excluded
    // from the adjustments aggregate or the summary stops footing against
    // total_cents. A held NEGATIVE line (docked/clawed off-roster worker) keeps
    // its debt in line_total (LEAST(adj,0)), so it IS inside the payout total and
    // must be counted here. Wage/gratuity/tip components are zeroed on any held
    // line by construction. Exclude only held rows with a positive adjustment.
    let wages = 0;
    let gratuity = 0;
    let cardGross = 0;
    let cardFee = 0;
    let adjustments = 0;
    const events = eventsRes.rows.map((r) => {
      wages       += Number(r.wage_cents);
      gratuity    += Number(r.gratuity_share_cents);
      cardGross   += Number(r.card_tip_gross_cents);
      cardFee     += Number(r.card_tip_fee_cents);
      adjustments += (r.held_state === 'held' && Number(r.adjustment_cents) > 0) ? 0 : Number(r.adjustment_cents);
      return {
        shift_id: r.shift_id,
        event_date: ymd(r.event_date),
        client_name: r.client_name || null,
        event_type: r.event_type || null,
        event_type_custom: r.event_type_custom || null,
        contracted_hours: r.contracted_hours,
        hours: r.hours,
        rate_cents: r.rate_cents,
        wage_cents: r.wage_cents,
        late: r.late,
        gratuity_share_cents: r.gratuity_share_cents,
        card_tip_gross_cents: r.card_tip_gross_cents,
        card_tip_fee_cents: r.card_tip_fee_cents,
        card_tip_net_cents: r.card_tip_net_cents,
        adjustment_cents: r.adjustment_cents,
        adjustment_note: r.adjustment_note,
        line_total_cents: r.line_total_cents,
      };
    });

    res.json({
      period: {
        id: p.period_id,
        start_date: ymd(p.start_date),
        end_date: ymd(p.end_date),
        payday: ymd(p.payday),
        status: p.period_status,
      },
      payout: {
        id: p.payout_id,
        status: p.payout_status,
        total_cents: p.total_cents,
        paid_at: p.paid_at,
        paystub_storage_key: p.paystub_storage_key,
      },
      events,
      // total_cents comes from the payout row (canonical) — NOT a JS sum of
      // events. The two can drift mid-period before recompute, and the
      // payout-row total is the one we hand to the bank/check-cutter.
      summary: {
        wages_cents: wages,
        gratuity_cents: gratuity,
        card_tips_gross_cents: cardGross,
        card_processing_fee_cents: cardFee,
        adjustments_cents: adjustments,
        total_cents: p.total_cents,
      },
    });
  }));

  // ─── GET /api/me/payouts/:periodId/paystub ───────────────────────────────
  // Lazy-generate the paystub PDF on first download, then serve a short-lived
  // signed URL. Never touches mark-paid (protect the money path). IDOR-scoped
  // to req.user.id via the same JOIN guard the detail route uses.
  //
  // Resolution order:
  //   1. Validate periodId.
  //   2. Look up the payout (contractor_id, pay_period_id) — 404 if none.
  //   3. 409 if not paid yet — paystubs are payday docs.
  //   4. If paystub_storage_key is already set, serve a signed URL for it.
  //   5. Otherwise: assemble -> render -> uploadFile to R2 (storage.js sets
  //      Content-Type: application/pdf on .pdf keys) -> persist the key with
  //      a race-guarded UPDATE (WHERE paystub_storage_key IS NULL). If the
  //      UPDATE no-ops (another request stored its key first), re-read and
  //      use the stored value; the deterministic key shape (paystubs/<u>/<p>.pdf)
  //      means both requests upload to the same object so the data is identical.
  //   6. Respond { url }.
  //
  // NOTE: the cached key locks the PDF at first download — a later recompute of
  // a paid period's events does NOT regenerate the stored paystub (the key is
  // reused). If the post-upload UPDATE ever fails, the next request re-renders
  // identical bytes to the same deterministic key and retries; the payout row
  // stays clean on any generation failure (the point of lazy generation).
  //
  // The storage util is required as the module object (not destructured) so
  // tests can mock.method(storage, 'uploadFile', ...) and intercept the call.
  router.get('/payouts/:periodId/paystub', asyncHandler(async (req, res) => {
    const periodId = Number(req.params.periodId);
    if (!Number.isInteger(periodId) || periodId <= 0) {
      throw new ValidationError({ periodId: 'must be a positive integer' }, 'Invalid period id');
    }

    const lookup = await pool.query(
      `SELECT id, status, paystub_storage_key
         FROM payouts
        WHERE contractor_id = $1 AND pay_period_id = $2`,
      [req.user.id, periodId]
    );
    if (!lookup.rows[0]) throw new NotFoundError('Payout not found');
    const payout = lookup.rows[0];

    if (payout.status !== 'paid') {
      throw new ConflictError('Your paystub is available once the period is paid.');
    }

    // Already generated -> serve a fresh signed URL.
    if (payout.paystub_storage_key) {
      return res.json({ url: await storage.getSignedUrl(payout.paystub_storage_key) });
    }

    // Lazy generation. Assemble -> render -> upload -> persist (race-guarded).
    const data = await assemblePaystubData(req.user.id, periodId);
    if (!data) throw new NotFoundError('Payout not found');
    const buffer = await renderPaystubPdf(data);
    await storage.uploadFile(buffer, data.storageKey);

    const upd = await pool.query(
      `UPDATE payouts SET paystub_storage_key = $1
        WHERE id = $2 AND paystub_storage_key IS NULL
        RETURNING paystub_storage_key`,
      [data.storageKey, payout.id]
    );
    // Deterministic key, so a lost race just reuses the stored value — both
    // racers uploaded to the same object (R2 PutObject is last-write-wins; the
    // PDFs are semantically identical even if pdfkit's embedded CreationDate
    // makes the bytes differ).
    let key = upd.rows[0] && upd.rows[0].paystub_storage_key;
    if (!key) {
      const re = await pool.query(
        'SELECT paystub_storage_key FROM payouts WHERE id = $1',
        [payout.id]
      );
      key = (re.rows[0] && re.rows[0].paystub_storage_key) || data.storageKey;
    }
    return res.json({ url: await storage.getSignedUrl(key) });
  }));
}

module.exports = { register };

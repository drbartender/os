// One proposal with its client, package, add-ons, activity and derived money: the read behind GET /api/proposals/:id.
//
// Moved out of server/routes/proposals/getOne.js (lane connector-shared-reads,
// spec 2026-11-19 law 4) so the proposal detail page, its phone twin and the
// Claude connector's booking lookup share one copy. The route calls it with no
// exclusion and gets exactly the body it always sent, a held proposal
// included (marked legal_hold, so the editor opens read-only);
// getOne.detail.test.js pins that answer and was committed before the move.
//
// With `exclude` (legalHold.holdExclusion()), a held proposal (isLegalHold,
// or an id in exclude.proposalIds), a proposal whose client is in
// exclude.clientIds, or an id that does not read as a positive integer answers
// null, the same not-found a missing id gets. The id checks run before any
// query; the client check rides the row query's own WHERE, so the held
// client's other bookings are never loaded.
//
// The body selects the whole proposals row (SELECT p.*), link token included:
// a caller outside the admin screen builds its own field allowlist from it
// (spec law 2).

const { pool } = require('../../db');
const { setupTimeDisplay } = require('../setupTime');
const { getMessageLogForProposal } = require('../messageLog');
const { loadSettledExtensions, contractHoursFrom } = require('../contractDuration');
const {
  nettedOverpaymentCents, offContractPaidCents, loadPaymentsWithRemaining,
  contractInvoiceSlackCents,
} = require('../refundHelpers');
const { latestConsultCallForProposal } = require('../consultCallLookups');
const { isLegalHold } = require('../legalHold');
const { readExclusion, readLookupId } = require('./exclusion');
const { swapsForPackage } = require('../packageSwaps');

const PROPOSAL_SELECT = `
    SELECT p.*, c.name AS client_name, c.email AS client_email, c.phone AS client_phone, c.source AS client_source,
           c.cc_id AS client_cc_id,
           sp.name AS package_name, sp.slug AS package_slug, sp.category AS package_category, sp.includes AS package_includes,
           u.email AS created_by_email, u.cc_id AS user_cc_id,
           tb.budget_min, tb.budget_max, tb.budget_raw,
           -- The editor's staleness token (spec 2026-10-16 section 5.1): the PATCH
           -- computes the same expression on its locked row (crud.js, patchGuards.js).
           md5(COALESCE(p.adjustments, '[]'::jsonb)::text) AS adjustments_token
    FROM proposals p
    LEFT JOIN clients c ON c.id = p.client_id
    LEFT JOIN service_packages sp ON sp.id = p.package_id
    LEFT JOIN users u ON u.id = p.created_by
    LEFT JOIN LATERAL (
      -- Stated budget of the TT lead auto-drafted into this proposal: context for
      -- the admin over-budget badge. Newest lead wins, matching /lead-cost.
      SELECT tl.budget_min, tl.budget_max, tl.budget_raw
        FROM thumbtack_leads tl
       WHERE tl.proposal_id = p.id
       ORDER BY tl.id DESC
       LIMIT 1
    ) tb ON true
    WHERE p.id = $1`;
const PROPOSAL_SQL = `${PROPOSAL_SELECT}
  `;
const PROPOSAL_EXCLUDING_SQL = `${PROPOSAL_SELECT}
      AND NOT (p.id = ANY($2::int[]))
      AND (p.client_id IS NULL OR NOT (p.client_id = ANY($3::int[])))
  `;
const ADDONS_SQL = 'SELECT * FROM proposal_addons WHERE proposal_id = $1 ORDER BY id';
// Capped at the 100 most recent: an old proposal can gather hundreds of view
// and update entries.
const ACTIVITY_SQL = 'SELECT * FROM proposal_activity_log WHERE proposal_id = $1 ORDER BY created_at DESC LIMIT 100';
// Lead call bridge outcome for TT-drafted proposals (newest lead wins,
// matching the budget lateral above). NULL for pre-feature / non-TT
// proposals; the detail view renders nothing then.
const LEAD_CALL_SQL = `SELECT a.status, a.answered_by, a.bridge_duration_sec, a.created_at
         FROM lead_call_attempts a
         JOIN thumbtack_leads l ON l.id = a.lead_id
        WHERE l.proposal_id = $1
        ORDER BY a.id DESC
        LIMIT 1`;
// Auto first-reply outcome for TT-drafted proposals (newest lead wins,
// matching the laterals above). `not_needed` collapses to null below: the
// detail view renders a line only when a reply was actually queued.
const FIRST_REPLY_SQL = `SELECT l.first_reply_status, l.first_reply_template, l.first_reply_sent_at
         FROM thumbtack_leads l
        WHERE l.proposal_id = $1
        ORDER BY l.id DESC
        LIMIT 1`;

/**
 * The proposal detail, or null when there is no such proposal (or it is held).
 * @param {number|string} proposalId - the id as the route got it
 * @param {{exclude?: {proposalIds: number[], clientIds: number[]}}} [opts]
 * @returns {Promise<object|null>} every proposals column; client_name,
 *   client_email, client_phone, client_source, client_cc_id, package_name,
 *   package_slug, package_category, package_includes, created_by_email,
 *   user_cc_id, budget_min, budget_max, budget_raw, adjustments_token;
 *   setup_time_display, legal_hold, settled_extension_hours,
 *   contract_floor_hours, overpayment_cents, off_contract_paid_cents,
 *   max_refundable_cents, max_overpayment_refundable_cents; addons (quantity a
 *   number), activity (newest 100), messageLog, lead_call, consult_call,
 *   first_reply ({ status, template, sent_at } or null)
 */
async function getProposalDetail(proposalId, { exclude } = {}) {
  const hold = readExclusion(exclude);
  let id = proposalId;
  let result;
  if (hold) {
    id = readLookupId(proposalId);
    if (id === null || isLegalHold(id) || hold.proposalIds.includes(id)) return null;
    result = await pool.query(PROPOSAL_EXCLUDING_SQL, [id, hold.proposalIds, hold.clientIds]);
  } else {
    result = await pool.query(PROPOSAL_SQL, [id]);
  }
  if (!result.rows[0]) return null;

  // Every attachment depends only on the proposal id: one parallel round.
  const [addons, activity, messageLog, leadCall, firstReply, offContract, refundable, invoiceSlack, settledExt, consultCall] = await Promise.all([
    pool.query(ADDONS_SQL, [id]),
    pool.query(ACTIVITY_SQL, [id]),
    getMessageLogForProposal(id),
    pool.query(LEAD_CALL_SQL, [id]),
    pool.query(FIRST_REPLY_SQL, [id]),
    // Refund-side derived money (spec 2026-09-15). THE overpaid figure for
    // every admin surface: the raw amount_paid - total_price difference counts
    // a paid Drink Plan Extras or manual invoice as excess, which is why prod
    // 599 reads overpaid on three screens today and is not.
    offContractPaidCents(id),
    loadPaymentsWithRemaining(id),
    contractInvoiceSlackCents(id),
    loadSettledExtensions(pool, id),
    // Consult call bridge outcome (spec 2026-08-25 section 5.3): the newest ring
    // chain across this proposal's consults. NULL for a proposal that never had
    // a consult, which is the common case, so the detail view renders nothing.
    // What keeps it cheap on that common case is idx_consults_proposal_id, not
    // the shape of the join: see the header of consultCallLookups.js.
    latestConsultCallForProposal(id),
  ]);

  const fr = firstReply.rows[0];

  // setup_time_display: server-derived clock time (service start minus
  // effective minutes) for back-of-house display. Raw setup_minutes_before
  // already flows via SELECT p.* (NULL until an admin overrides; null display
  // when the start time is unparseable). Back-of-house only: never added to the
  // public token response.
  const row = result.rows[0];
  return {
    ...row,
    setup_time_display: setupTimeDisplay(row),
    // The proposal's own drink swaps, checked, for the package it is on now
    // (packageSwaps.js): the package details disclosure shows them.
    // The raw column rides as stored with the rest of p.*.
    current_package_swaps: swapsForPackage(row.package_swaps, row.package_slug),
    // Legal hold (spec 2026-10-16 section 5.3): the editor and the phone sheet
    // open read-only. Bound on the loaded row's id, never the raw param.
    legal_hold: isLegalHold(row.id),
    // Hours a settled on-site extension added to the row, ALWAYS a number (0
    // when none). The editor subtracts it to invert stored add-on quantities
    // at the contract's hours (contractDuration.js); a missing field would
    // read as NaN and reset every stepper. It is row minus contract hours, so
    // after a hand-reverted row it can be NEGATIVE (the clamp held the
    // contract above the row); the subtraction stays consistent either way.
    // contract_floor_hours is the clamp's floor (null when no extension), so
    // the editor's hint can show what the server will price.
    settled_extension_hours: contractHoursFrom(row.event_duration_hours, settledExt).settled,
    contract_floor_hours: settledExt.length
      ? Math.min(...settledExt.map((e) => Number(e.contracted_duration_hours)).filter(Number.isFinite))
      : null,
    // Netted overpayment, the same figure and the same key the cancel-line
    // preview returns. off_contract_paid_cents is the netting term, so the
    // editor can net a HYPOTHETICAL new total without a second round trip.
    // max_refundable_cents is the largest single Stripe charge still
    // refundable: no refund spans charges, and a positive overpayment can be
    // external money with no charge behind it, which the panel must say
    // before the admin fills in a form the server will refuse.
    // max_overpayment_refundable_cents is the largest UNCREDITED headroom on any
    // one charge. An overpayment refund must come off money no invoice was
    // credited, so this, not max_refundable_cents, is what a positive
    // overpayment can actually be returned through Stripe.
    overpayment_cents: nettedOverpaymentCents(row.amount_paid, row.total_price, offContract),
    off_contract_paid_cents: offContract,
    max_refundable_cents: refundable.reduce((m, p) => Math.max(m, p.remainingCents), 0),
    max_overpayment_refundable_cents: refundable.reduce(
      (m, p) => Math.max(m, Math.min(p.remainingCents, p.uncreditedCents + invoiceSlack)), 0
    ),
    // SERVER-15: pg returns the now-NUMERIC quantity as a string; coerce to a number.
    addons: addons.rows.map(a => ({ ...a, quantity: a.quantity === null ? null : Number(a.quantity) })),
    activity: activity.rows,
    messageLog,
    lead_call: leadCall.rows[0] || null,
    consult_call: consultCall || null,
    first_reply: (!fr || fr.first_reply_status === 'not_needed') ? null : {
      status: fr.first_reply_status,
      template: fr.first_reply_template,
      sent_at: fr.first_reply_sent_at,
    },
  };
}

module.exports = { getProposalDetail };

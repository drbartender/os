const { pool } = require('../db');
const { calculateProposal } = require('./pricingEngine');
const { validateProposalRules, stripIncludedAddons } = require('./proposalRules');
const { ValidationError } = require('./errors');

const BOOKED = new Set(['deposit_paid', 'balance_paid', 'confirmed', 'completed']);

// The only fields a change request may carry. Server-enforced: anything outside
// this set is rejected (spec 3.2), which is what actually keeps discounts /
// total_price_override / setup_minutes_before out of the payload.
const EDITABLE_FIELDS = [
  'event_date', 'event_start_time', 'event_duration_hours',
  'venue_name', 'venue_street', 'venue_city', 'venue_state', 'venue_zip',
  'guest_count', 'package_id', 'num_bars', 'num_bartenders',
  'addon_ids', 'addon_variants', 'addon_quantities',
];
const SIMPLE_FIELDS = EDITABLE_FIELDS.filter(f => !f.startsWith('addon_'));

const MAX_ADDON_QTY = 20;
function safeAddonQty(raw) {
  if (typeof raw !== 'number' && typeof raw !== 'string') return 1;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_ADDON_QTY, n);
}

// 'pre_booking' when not booked; else inside_t14 within 14 days of the event,
// else before_t14. Approximate at the day boundary, which is fine because every
// window routes to admin anyway (spec 2.4 / 3.3).
function computeEditWindow(proposal) {
  if (!BOOKED.has(proposal.status)) return 'pre_booking';
  if (!proposal.event_date) return 'before_t14';
  const ev = new Date(proposal.event_date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.ceil((ev.getTime() - today.getTime()) / 86400000);
  return days <= 14 ? 'inside_t14' : 'before_t14';
}

// Reject any body key outside the allowlist; return the filtered proposed state.
function filterToAllowlist(body) {
  const ignore = new Set(['note', 'acknowledged_total']);
  const unknown = Object.keys(body).filter(k => !ignore.has(k) && !EDITABLE_FIELDS.includes(k));
  if (unknown.length) {
    throw new ValidationError(
      Object.fromEntries(unknown.map(k => [k, 'This field cannot be changed here.'])),
      'These fields may not be changed via this endpoint.'
    );
  }
  const out = {};
  for (const f of EDITABLE_FIELDS) if (body[f] !== undefined) out[f] = body[f];
  return out;
}

async function currentAddonIds(proposalId, db) {
  const r = await db.query('SELECT addon_id FROM proposal_addons WHERE proposal_id = $1', [proposalId]);
  return r.rows.map(x => x.addon_id);
}

// Price a full proposed end-state. Preserves admin-locked fields (adjustments,
// total_price_override, syrups) from the current proposal. Throws ValidationError
// on a rule violation. Returns the pricing snapshot. db is a pool or in-tx client.
async function priceProposedState(proposal, proposed, db = pool) {
  const packageId = proposed.package_id ?? proposal.package_id;
  const pkg = (await db.query('SELECT * FROM service_packages WHERE id = $1', [packageId])).rows[0];
  if (!pkg) throw new ValidationError({ package_id: 'Package not found' });

  const allActive = (await db.query('SELECT * FROM service_addons WHERE is_active = true')).rows;
  const rawIds = Array.isArray(proposed.addon_ids) ? proposed.addon_ids : await currentAddonIds(proposal.id, db);
  const strippedIds = stripIncludedAddons(rawIds, allActive);
  const variants = proposed.addon_variants || {};
  const quantities = proposed.addon_quantities || {};
  const addons = allActive
    .filter(a => strippedIds.includes(a.id))
    .map(a => ({ ...a, variant: variants[String(a.id)] || null, quantity: safeAddonQty(quantities[String(a.id)]) }));

  const guestCount = Number(proposed.guest_count ?? proposal.guest_count);
  validateProposalRules({
    pkg, guestCount, addonIds: strippedIds, addons: allActive,
    clientProvidesGlassware: proposal.client_provides_glassware,
  });

  return calculateProposal({
    pkg,
    guestCount,
    durationHours: Number(proposed.event_duration_hours ?? proposal.event_duration_hours),
    numBars: Number(proposed.num_bars ?? proposal.num_bars ?? 1),
    numBartenders: proposed.num_bartenders ?? null,
    addons,
    syrupSelections: proposal.pricing_snapshot?.syrups?.selections || [],
    adjustments: proposal.adjustments || [],
    totalPriceOverride: proposal.total_price_override ?? null,
  });
}

// Build the { current, estimated, delta, staffing } preview (DOLLARS).
async function buildPreview(proposal, proposed, db = pool) {
  const snapshot = await priceProposedState(proposal, proposed, db);
  const currentTotal = Number(proposal.total_price_override ?? proposal.total_price ?? 0);
  const estimatedTotal = Number(snapshot.total);
  const currentStaffing = Number(proposal.pricing_snapshot?.staffing?.actual ?? proposal.num_bartenders ?? 1);
  return {
    snapshot,
    price_preview: {
      current_total: currentTotal,
      estimated_total: estimatedTotal,
      delta: Math.round((estimatedTotal - currentTotal) * 100) / 100,
      staffing: { current: currentStaffing, estimated: snapshot.staffing.actual },
    },
  };
}

// Sparse diff (requested) + the from-values (baseline) for the audit row.
const NUMERIC_FIELDS = new Set(['event_duration_hours', 'guest_count', 'package_id', 'num_bars', 'num_bartenders']);
async function buildDiff(proposal, proposed, db = pool) {
  const requested = {};
  const baseline = {};
  for (const f of SIMPLE_FIELDS) {
    if (proposed[f] === undefined) continue;
    // Type-aware compare so 4 vs 4.0 (or '4' vs 4) does not log a spurious diff.
    const same = NUMERIC_FIELDS.has(f)
      ? Number(proposed[f]) === Number(proposal[f])
      : String(proposed[f] ?? '') === String(proposal[f] ?? '');
    if (!same) {
      requested[f] = proposed[f];
      baseline[f] = proposal[f] ?? null;
    }
  }
  // v1 note: the add-on diff is captured only when addon_ids is present. The v1
  // client form does not expose add-on editing, so this branch is not reached
  // through the UI. When add-on editing is added, gate variants/quantities
  // independently of addon_ids and normalize the maps (sort keys, drop nulls)
  // before comparing, so a variant-only change is recorded and key-order does
  // not produce a spurious diff.
  if (proposed.addon_ids !== undefined) {
    const cur = (await db.query(
      'SELECT addon_id, variant, quantity::float8 AS quantity FROM proposal_addons WHERE proposal_id = $1 ORDER BY addon_id', [proposal.id]
    )).rows;
    const curIds = cur.map(r => r.addon_id).sort((a, b) => a - b);
    const propIds = [...(proposed.addon_ids || [])].sort((a, b) => a - b);
    if (JSON.stringify(curIds) !== JSON.stringify(propIds)
        || JSON.stringify(proposed.addon_variants || {}) !== JSON.stringify(Object.fromEntries(cur.filter(r => r.variant).map(r => [String(r.addon_id), r.variant])))
        || JSON.stringify(proposed.addon_quantities || {}) !== JSON.stringify(Object.fromEntries(cur.map(r => [String(r.addon_id), r.quantity])))) {
      requested.addon_ids = proposed.addon_ids;
      requested.addon_variants = proposed.addon_variants || {};
      requested.addon_quantities = proposed.addon_quantities || {};
      baseline.addons = cur;
    }
  }
  return { requested, baseline };
}

// Reaper: auto-cancel any pending request for a proposal that is no longer
// changeable (archived / completed). Called from lifecycle.js AND
// balanceScheduler.js (the autocomplete path bypasses lifecycle). Best-effort:
// callers wrap in try/catch. db is a pool or in-tx client.
async function cancelPendingChangeRequestsForProposal(proposalId, db = pool) {
  const res = await db.query(
    `UPDATE proposal_change_requests
        SET status = 'cancelled', cancelled_by = 'system',
            decision_note = COALESCE(decision_note, 'auto-cancelled: proposal no longer editable'),
            updated_at = NOW()
      WHERE proposal_id = $1 AND status = 'pending'
      RETURNING id`,
    [proposalId]
  );
  for (const row of res.rows) {
    await db.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
       VALUES ($1, 'change_cancelled', 'system', $2)`,
      [proposalId, JSON.stringify({ change_request_id: row.id, reason: 'proposal_no_longer_editable' })]
    );
  }
  return res.rows.length;
}

module.exports = {
  BOOKED, EDITABLE_FIELDS, SIMPLE_FIELDS, safeAddonQty,
  computeEditWindow, filterToAllowlist,
  priceProposedState, buildPreview, buildDiff,
  cancelPendingChangeRequestsForProposal,
};

// Shared form-state builders for the proposal/event editor (ProposalEditorForm).
// Moved verbatim from ProposalDetailEditForm.js so both mounts seed identically.
import { isQuantityCapable } from '../../../utils/proposalRules';

export function initialFormFromProposal(p) {
  const currentAddonIds = (p.addons || []).map(a => a.addon_id);
  const currentAddonVariants = {};
  (p.addons || []).forEach(a => {
    if (a.variant) currentAddonVariants[String(a.addon_id)] = a.variant;
  });
  const snapshot = p.pricing_snapshot || {};
  return {
    client_name: p.client_name || '',
    client_email: p.client_email || '',
    client_phone: p.client_phone || '',
    client_source: p.client_source || 'thumbtack',
    client_provides_glassware: !!p.client_provides_glassware,
    class_options: p.class_options || null,
    event_date: p.event_date ? p.event_date.slice(0, 10) : '',
    event_start_time: p.event_start_time || '',
    event_duration_hours: Number(p.event_duration_hours) || 4,
    venue_name: p.venue_name || '',
    venue_street: p.venue_street || '',
    venue_city: p.venue_city || '',
    venue_state: p.venue_state || '',
    venue_zip: p.venue_zip || '',
    guest_count: p.guest_count || 50,
    package_id: p.package_id || '',
    num_bars: p.num_bars || 0,
    addon_ids: currentAddonIds,
    addon_variants: currentAddonVariants,
    // Raw 1–10 stepper counts for quantity-capable add-ons. Seeded empty here
    // and filled by recoverAddonQuantities() once the add-on catalog loads —
    // the persisted proposal_addons.quantity is a TRANSFORMED value (hours ×
    // count for per_hour, guest count for per_guest), so recovering the raw
    // stepper count needs the catalog row's slug/billing_type/minimum_hours.
    addon_quantities: {},
    syrup_selections: snapshot.syrups?.selections || [],
    adjustments: p.adjustments || [],
    total_price_override: p.total_price_override ?? null,
    tip_jar: snapshot.gratuity?.tip_jar !== false,
    gratuity_total: Number(snapshot.gratuity?.total) || 0,
    // '' = "use the package-derived default" (server resolves null → 90 hosted /
    // 60 else). A number is an explicit override. Used by both editor mounts.
    setup_minutes_before: p.setup_minutes_before ?? '',
  };
}

// Recover the raw 1–10 stepper count for each quantity-capable add-on on a
// loaded proposal. proposal_addons.quantity is NOT the raw count — pricingEngine
// transforms it on the way in:
//   - additional-bartender : persisted quantity = durationHours × count
//   - per_hour (barback,
//     banquet-server)      : persisted quantity = effectiveHours × count,
//                            effectiveHours = max(durationHours, minimum_hours)
//   - per_guest (pre-batched
//     -mocktail)           : persisted quantity = guestCount; the count is
//                            folded into line_total only (= guestCount×rate×count)
// The inversion is anchored to PERSISTED row data (row.rate, row.quantity — the
// values frozen at proposal-creation time), NOT the live catalog row. Catalog
// rates drift (pre-batched-mocktail went $1.50 → $2.00 in prod); dividing by the
// current catalog rate would recover a wrong count and silently re-price the
// proposal on save. The catalog row is still consulted only for slug /
// billing_type / minimum_hours (minimum_hours is not persisted on
// proposal_addons — a low-probability residual, see the per_hour branch).
// `proposalAddons` are the proposal_addons rows; `catalog` is the
// /proposals/addons response. Returns an addon_quantities map keyed by addon id
// (number) → recovered count, clamped to 1–10. Addons whose count can't be
// recovered (missing/zero divisors) are omitted (stepper defaults 1).
export function recoverAddonQuantities(proposalAddons, catalog, { durationHours }) {
  const out = {};
  const byId = new Map((catalog || []).map(a => [a.id, a]));
  const dh = Number(durationHours) || 0;
  (proposalAddons || []).forEach(row => {
    const addon = byId.get(row.addon_id);
    if (!addon || !isQuantityCapable(addon)) return;
    const persistedQty = Number(row.quantity);
    const lineTotal = Number(row.line_total);
    let count;
    if (addon.slug === 'additional-bartender') {
      // persisted quantity = durationHours × count. recoverAddonQuantities runs
      // once at form-load, so dh still equals the proposal's persisted duration
      // — no rate divisor here, so no catalog drift.
      count = dh > 0 ? persistedQty / dh : null;
    } else if (addon.billing_type === 'per_hour') {
      // persisted quantity = effectiveHours × count. dh is still the persisted
      // duration (form-load). minimum_hours is NOT persisted on proposal_addons,
      // so it must come from the catalog row — an unavoidable, low-probability
      // residual (minimum_hours rarely changes). No rate divisor here.
      const effectiveHours = Math.max(dh, Number(addon.minimum_hours) || 0);
      count = effectiveHours > 0 ? persistedQty / effectiveHours : null;
    } else if (addon.billing_type === 'per_guest') {
      // persisted line_total = quantity × rate × count, where persisted quantity
      // IS the creation-time guestCount. Invert with the row's own persisted
      // rate + quantity — never the live catalog rate (catalog rates drift) and
      // never the form's current guest_count.
      const rowRate = Number(row.rate);
      count = (persistedQty > 0 && rowRate > 0) ? lineTotal / (persistedQty * rowRate) : null;
    } else if (addon.billing_type === 'per_guest_timed') {
      // per_guest_timed recovery is intentionally unimplemented: its line_total
      // carries an extra-hours term (guestCount × extra_hour_rate × extraHours)
      // on top of the per_guest base, so the per_guest inversion above does not
      // hold. Dead today — no quantity-capable addon uses per_guest_timed — so
      // return null (stepper defaults to 1, visibly unhandled, never re-prices).
      count = null;
    } else {
      // flat / per_staff / per_100_guests — persisted quantity IS the raw count.
      count = persistedQty;
    }
    if (count == null || !Number.isFinite(count)) return;
    const rounded = Math.round(count);
    if (rounded < 1) return;
    out[addon.id] = Math.min(10, Math.max(1, rounded));
  });
  return out;
}

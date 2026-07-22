// The ONE place a proposal-editor save payload is built. Both mounts of
// ProposalEditorForm (proposal page and event page) call this, so the two
// surfaces cannot drift. History: the old EventEditForm built its own payload
// and omitted addon_quantities; the server defaults an absent quantity to 1
// (safeAddonQty), so a date edit from the event page silently reset admin-set
// add-on quantities. Structural fix: one builder, always complete.

export function buildProposalPatchBody(form, {
  gratuityDirty = false,
  isClassPackage = false,
  changeRequestId,
  staffNotify = null,
} = {}) {
  const body = {
    event_date: form.event_date,
    event_start_time: form.event_start_time,
    event_duration_hours: Number(form.event_duration_hours),
    venue_name: form.venue_name,
    venue_street: form.venue_street,
    venue_city: form.venue_city,
    venue_state: form.venue_state,
    venue_zip: form.venue_zip,
    guest_count: Number(form.guest_count),
    package_id: Number(form.package_id),
    num_bars: Number(form.num_bars) || 0,
    addon_ids: (form.addon_ids || []).map(Number),
    addon_variants: form.addon_variants || {},
    addon_quantities: form.addon_quantities || {},
    syrup_selections: form.syrup_selections || [],
    adjustments: form.adjustments || [],
    total_price_override: form.total_price_override,
    client_provides_glassware: !!form.client_provides_glassware,
    // Top Shelf is class-only. Only send class_options for a class package so
    // switching to a non-class package cannot trip the server-side guard.
    class_options: isClassPackage ? form.class_options : null,
    // Blank means reset to package default; the server treats null as the reset.
    setup_minutes_before: form.setup_minutes_before === '' || form.setup_minutes_before == null
      ? null
      : Number(form.setup_minutes_before),
  };
  // Persist the gratuity dollar ONLY when the admin edited it; otherwise omit
  // both keys so the server preserves the stored rate and rescales the dollar
  // by the new staffing (crud.js gratuity branch). See gratuityDirty in the form.
  if (gratuityDirty) {
    body.tip_jar = form.tip_jar !== false;
    body.gratuity_total = form.gratuity_total;
  }
  if (changeRequestId != null) body.change_request_id = changeRequestId;
  if (staffNotify) {
    // Sub-flags only ride when the parent toggle is on, so an unchecked parent
    // never leaks a stale sub-flag (EventEditForm's Phase 4a rule, preserved).
    body.notify_assigned_staff = !!staffNotify.enabled;
    body.notify_staff_sms = !!(staffNotify.enabled && staffNotify.sms);
    body.notify_staff_email = !!(staffNotify.enabled && staffNotify.email);
  }
  return body;
}

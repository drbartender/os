// The pieces of the proposal/event editor that the phone edit sheet (lane
// ma-e3, client/src/components/mobile/useEditSheet.js) shares with the desktop
// editor (ProposalEditorForm.js). Moved out of ProposalEditorForm verbatim:
// one copy, so the two surfaces cannot drift. The other shared builders live
// beside this file: formState.js (the form a proposal seeds), patchBody.js
// (the save payload), repriceSummary.js (the booked-event reprice lines).

// Explicit bartender-count override detection (push-review money finding):
// stored num_bartenders equals the computed actual, so it is an admin
// override only when it differs from what the ORIGINAL inputs required.
// It must round-trip through preview AND PATCH or any editor save silently
// drops charged over-ratio bartenders. A retired original package (absent
// from the active catalog) makes detection impossible: fall back to not
// sending (the server recomputes, matching pre-editor behavior).
export function detectNumBartendersOverride(proposal, packages) {
  const stored = Number(proposal?.num_bartenders);
  if (!stored) return null;
  const originalPkg = (packages || []).find((p) => p.id === Number(proposal.package_id));
  if (!originalPkg) return null;
  const per = Number(originalPkg.guests_per_bartender) || 100;
  const required = Math.max(1, Math.ceil((Number(proposal.guest_count) || 0) / per));
  return stored !== required ? stored : null;
}

// The gratuity is NOT editable in the editor (election-at-payment, spec
// 2026-08-03): the client elects it at sign-and-pay and the Stripe webhook
// persists it. These stored values only feed the preview request so a paid
// proposal's gratuity line keeps rendering (and rescaling) while staff/hours
// are edited.
export function storedGratuityOf(proposal) {
  return {
    rate: Number(proposal?.pricing_snapshot?.gratuity?.rate) || 0,
    tipJar: proposal?.pricing_snapshot?.gratuity?.tip_jar !== false,
  };
}

// Admin gratuity mandate (spec 2026-08-10). Locked once signed or paid: a
// recorded signature must never stand against a total admin changed after.
export function mandateLockedFor(proposal) {
  return Number(proposal?.amount_paid || 0) > 0
    || proposal?.client_signed_at != null || proposal?.status === 'accepted';
}

// Class-options gating for the save payload. A retired package (absent from
// the active catalog) keeps the stored class semantics instead of silently
// clearing class_options.
export function isClassPackageFor(selectedPkg, proposal) {
  return selectedPkg ? selectedPkg.bar_type === 'class' : proposal?.class_options != null;
}

// The POST /proposals/calculate body. Editing an existing booking sends its
// id: the server then prices the CONTRACT's hours (worked hours minus settled
// on-site extensions), so the preview equals what the PATCH will save. The
// gratuity is previewed at the STORED rate and jar (storedGratuityOf). A draft
// mandate rides only once touched and unlocked (includeMandate); transient
// typing states ('' / 0) are withheld so the preview never 400s mid-entry.
export function buildCalculateBody(form, {
  proposalId = null, numBartendersOverride = null, tipJar = true, gratuityRate = 0, includeMandate = false,
} = {}) {
  return {
    ...(proposalId ? { proposal_id: proposalId } : {}),
    package_id: Number(form.package_id),
    guest_count: Number(form.guest_count) || 50,
    duration_hours: Number(form.event_duration_hours) || 4,
    num_bars: Number(form.num_bars) || 0,
    ...(numBartendersOverride != null ? { num_bartenders: numBartendersOverride } : {}),
    addon_ids: (form.addon_ids || []).map(Number),
    addon_variants: form.addon_variants || {},
    addon_quantities: form.addon_quantities || {},
    syrup_selections: form.syrup_selections || [],
    adjustments: form.adjustments || [],
    total_price_override: form.total_price_override,
    tip_jar: tipJar,
    gratuity_rate: gratuityRate,
    ...(includeMandate
      && (form.gratuity_mandate_total == null || Number(form.gratuity_mandate_total) > 0)
      ? { gratuity_mandate_total: form.gratuity_mandate_total }
      : {}),
  };
}

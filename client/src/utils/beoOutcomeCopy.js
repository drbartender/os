// One sentence for what the derived BEO finalize did after Mark reviewed or a
// shopping-list approve. `beo` is the server's report ({ finalized, reason,
// unpaid_extras_cents }); the reason codes mirror server/utils/beoFinalize.js.
// `finalized` means "the BEO is finalized now" (the server reports it true on
// already_finalized too), so it wins over any reason. Empty string means "say
// nothing" (the action's own toast stands alone).

const fmtDollars = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;

export function beoOutcomeCopy(beo) {
  if (!beo) return '';
  if (beo.finalized) return 'BEO finalized.';
  switch (beo.reason) {
    case 'list_not_approved': return 'BEO finalizes when the shopping list is approved.';
    case 'not_reviewed': return 'BEO finalizes when the plan is marked reviewed.';
    case 'unpaid_extras':
      return `BEO not finalized: ${fmtDollars(beo.unpaid_extras_cents)} extras unpaid. Finalize BEO overrides.`;
    case 'no_selections': return 'BEO not finalized: the plan has no selections.';
    case 'not_linked': return 'BEO not finalized: the plan is not linked to a proposal.';
    case 'archived': return 'BEO not finalized: the proposal is archived.';
    default: return 'BEO not finalized. Use Finalize BEO.';
  }
}

// Toast level: finalized and the two "not yet" states are ordinary progress;
// everything else is something the admin has to act on.
export function beoToastKind(beo) {
  if (!beo || beo.finalized) return 'success';
  if (beo.reason === 'list_not_approved' || beo.reason === 'not_reviewed') return 'success';
  return 'info';
}

// Shared proposal status -> {label, kind} for admin StatusChips. Single source
// for what was hand-copied (and had diverged) across ProposalDetail,
// ProposalsDashboard, ClientDetail, and AlternativesPanel. Union of all four
// copies: `completed` is a success state (green 'ok'), and both `archived` and
// `declined` are always present. Casing follows the sentence-case variant used
// on the proposal detail surface.
const PROPOSAL_STATUS_META = {
  draft:        { label: 'Draft',        kind: 'neutral' },
  sent:         { label: 'Sent',         kind: 'info' },
  viewed:       { label: 'Viewed',       kind: 'accent' },
  modified:     { label: 'Modified',     kind: 'violet' },
  accepted:     { label: 'Accepted',     kind: 'ok' },
  deposit_paid: { label: 'Deposit paid', kind: 'ok' },
  balance_paid: { label: 'Paid in full', kind: 'ok' },
  confirmed:    { label: 'Confirmed',    kind: 'ok' },
  completed:    { label: 'Completed',    kind: 'ok' },
  declined:     { label: 'Declined',     kind: 'danger' },
  archived:     { label: 'Archived',     kind: 'neutral' },
};

export function proposalStatusMeta(status) {
  return PROPOSAL_STATUS_META[status] || { label: status, kind: 'neutral' };
}

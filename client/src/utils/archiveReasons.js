// archiveReasons: the four reasons an admin archives a proposal with, and the label for every
// stored archive_reason, in the desktop's words (one copy for the desktop modal, the Proposals list and the phone).

// The values are the server's ARCHIVE_REASONS exactly (server/routes/proposals/
// actions.js), in the desktop archive modal's order; archiveReasons.test.js
// reads that file and fails when the two lists part.
export const ARCHIVE_REASONS = [
  { value: 'no_hire', label: 'No hire' },
  { value: 'client_cancelled', label: 'Client cancelled' },
  { value: 'we_cancelled', label: 'We cancelled' },
  { value: 'other', label: 'Other' },
];

// Every value the archive_reason CHECK allows (schema.sql): the four above,
// plus the three only the automatic paths write.
const LABELS = {
  ...Object.fromEntries(ARCHIVE_REASONS.map((r) => [r.value, r.label])),
  event_completed: 'Event completed',
  option_not_chosen: 'Option not chosen',
  event_passed: 'Event passed',
};

export function archiveReasonLabel(reason) {
  return Object.prototype.hasOwnProperty.call(LABELS, reason) ? LABELS[reason] : '';
}

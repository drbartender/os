// Display-only labels for message_log rows. Server stores the raw machine
// message_type; this maps the known ones to friendly text and falls back to the
// stored subject line (then a humanized type) for auto-captured 'other' rows.
const LABELS = {
  proposal_sent: 'Proposal sent',
  proposal_signed: 'Signed confirmation',
  signed_and_paid: 'Signed and paid',
  drink_plan_ready: 'Drink plan sent',
  drink_plan_nudge: 'Drink plan reminder',
  shopping_list_ready: 'Shopping list sent',
  payment_received: 'Payment receipt',
  balance_due_today: 'Balance due reminder',
  event_week_reminder: 'Event week reminder',
  event_eve: 'Event eve reminder',
  reschedule: 'Reschedule notice',
  review_request: 'Review request',
};

export function messageTypeLabel(type, subject) {
  if (type && LABELS[type]) return LABELS[type];
  if (type && type.startsWith('balance_')) return 'Balance reminder';
  if (subject) return subject;
  if (!type || type === 'other') return 'Message';
  return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

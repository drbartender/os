// Single source of truth for the proposal-summary fields /home and the detail
// endpoint both expose. NOTE: drink_plan_token / drink_plan_submitted_at are
// appended by the consuming query's drink_plans join, NOT part of this column list.
const BOOKED = new Set(['deposit_paid', 'balance_paid', 'confirmed', 'completed']);
const PROPOSAL_SUMMARY_COLUMNS = [
  'p.token', 'p.status', 'p.archive_reason', 'p.event_type', 'p.event_type_custom',
  'p.event_date', 'p.event_start_time', 'p.guest_count',
  'p.venue_name', 'p.venue_city', 'p.venue_state',
  'p.total_price', 'p.total_price_override', 'p.amount_paid', 'p.balance_due_date',
].join(', ');
function venueLabel(r) {
  if (r.venue_name) return String(r.venue_name);
  if (r.venue_city && r.venue_state) return `${r.venue_city}, ${r.venue_state}`;
  return 'Location TBD';
}
function shapeFocus(r) {
  const total = Number(r.total_price_override ?? r.total_price ?? 0);
  const paid = Number(r.amount_paid ?? 0);
  return {
    token: r.token, status: r.status, booked: BOOKED.has(r.status),
    event_type: r.event_type, event_type_custom: r.event_type_custom,
    event_date: r.event_date, event_start_time: r.event_start_time, guest_count: r.guest_count,
    venue_label: venueLabel(r), total_price: total, amount_paid: paid, balance_due: total - paid,
    balance_due_date: r.balance_due_date,
    drink_plan_token: r.drink_plan_token || null,
    drink_plan_submitted: r.drink_plan_submitted_at !== null && r.drink_plan_submitted_at !== undefined,
  };
}
module.exports = { BOOKED, PROPOSAL_SUMMARY_COLUMNS, shapeFocus };

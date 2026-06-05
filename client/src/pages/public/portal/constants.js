export const BOOKED = new Set(['deposit_paid', 'balance_paid', 'confirmed', 'completed']);
function venueLabel(p) {
  if (p.venue_name) return p.venue_name;
  if (p.venue_city && p.venue_state) return `${p.venue_city}, ${p.venue_state}`;
  return 'Location TBD';
}
export function mapDetailToFocus(p) {
  const total = Number(p.total_price_override ?? p.total_price ?? 0);
  const paid = Number(p.amount_paid ?? 0);
  return {
    token: p.token, status: p.status, booked: BOOKED.has(p.status),
    event_type: p.event_type, event_type_custom: p.event_type_custom,
    event_date: p.event_date, event_start_time: p.event_start_time, guest_count: p.guest_count,
    venue_label: venueLabel(p), total_price: total, amount_paid: paid, balance_due: total - paid,
    balance_due_date: p.balance_due_date,
    drink_plan_token: p.drink_plan_token || null,
    drink_plan_submitted: p.drink_plan_submitted_at !== null && p.drink_plan_submitted_at !== undefined,
  };
}
export function mapArchiveRow(r) {
  return {
    token: r.token, status: r.status, booked: BOOKED.has(r.status),
    event_type: r.event_type, event_type_custom: r.event_type_custom,
    event_date: r.event_date, event_start_time: null, guest_count: null,
    venue_label: 'Location TBD', total_price: Number(r.total_price ?? 0), amount_paid: 0,
    balance_due: 0, balance_due_date: null, drink_plan_token: null, drink_plan_submitted: false,
  };
}

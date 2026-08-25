export function deriveNextUp(focus) {
  if (!focus) return null;
  // Before the booked check: 'archived' is not in BOOKED, so without this the
  // widget offered "Review & book" pointing at a token that 404s. A past event
  // has no next action, and its invoices were voided on archive, so the pay
  // branch below has nothing to offer either.
  if (focus.past) return null;
  if (!focus.booked) return { key: 'book', label: 'Review & book your bar', cta: 'Review & book', href: `/proposal/${focus.token}` };
  if (focus.balance_due > 0) return { key: 'pay', label: 'Pay your balance', cta: 'Pay balance',
    href: focus.open_invoice_token ? `/invoice/${focus.open_invoice_token}` : `/proposal/${focus.token}` };
  if (focus.drink_plan_token && !focus.drink_plan_submitted) return { key: 'potion', label: 'Plan your potions', cta: 'Open the planner', href: `/plan/${focus.drink_plan_token}` };
  return null;
}

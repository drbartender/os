export function deriveNextUp(focus) {
  if (!focus) return null;
  if (!focus.booked) return { key: 'book', label: 'Review & book your bar', cta: 'Review & book', href: `/proposal/${focus.token}` };
  if (focus.balance_due > 0) return { key: 'pay', label: 'Pay your balance', cta: 'Pay balance', href: `/proposal/${focus.token}` };
  if (focus.drink_plan_token && !focus.drink_plan_submitted) return { key: 'potion', label: 'Plan your potions', cta: 'Open the planner', href: `/plan/${focus.drink_plan_token}` };
  return null;
}

// Shared drink-plan status -> {label, kind} for admin StatusChips. Union of the
// two hand-copied maps (DrinkPlansDashboard + potions/PlansDrawer), including
// `exploration_saved` which the dashboard copy had dropped (it fell back to the
// raw enum string). Anchored on the PlansDrawer copy; DrinkPlansDashboard keeps
// its own `pending` = 'warn' attention affordance locally (the copies disagreed
// on that kind and the spec did not name a canonical for it).
const DRINK_PLAN_STATUS_META = {
  pending:           { label: 'Pending',   kind: 'neutral' },
  draft:             { label: 'Draft',     kind: 'neutral' },
  exploration_saved: { label: 'Exploring', kind: 'info' },
  submitted:         { label: 'Submitted', kind: 'info' },
  reviewed:          { label: 'Reviewed',  kind: 'ok' },
};

export function drinkPlanStatusMeta(status) {
  return DRINK_PLAN_STATUS_META[status] || { label: status, kind: 'neutral' };
}

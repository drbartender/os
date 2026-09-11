// One predicate for every admin surface that turns a plan row into "shopping
// list owed" work: the Events Plan column (components/adminos/eventPlan.js),
// the overview prep queue (pages/admin/overview/PrepQueue.js), and the Potions
// drawer chip (pages/admin/potions/PlansDrawer.js). The Potions badge count
// applies the same rule server-side (server/routes/admin/settings.js).
//
// A hosted package never owes one: DRB stocks the bar and the server stages no
// list for it (server/utils/shoppingListGen.js isHostedPlan), so a stale or
// admin-built hosted list is never review work here. A cocktail CLASS is
// seeded 'hosted' but may self-supply (optional supplies add-on), so it still
// owes one. Unknown fails open to BYOB exactly as the server does: a spurious
// list is reviewable, a hidden one is a silent gap. Also the predicate behind
// the planner's own copy (finish screens, roadmap, crowd, picker), which
// carries the same two fields off GET /t/:token.
export function owesShoppingList(row) {
  return !(row && row.package_category === 'hosted' && row.package_bar_type !== 'class');
}

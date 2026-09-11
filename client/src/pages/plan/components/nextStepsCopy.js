// The planner finish screens' "What happens next?" sentence, shared by the v1
// confirmation (PotionPlanningLab) and the v2 celebration (CelebrationV2) so
// the hosted rule lives in one place: a hosted package never owes a shopping
// list (DRB stocks the bar and the server stages none, see
// shoppingListGen.isHostedPlan), so hosted copy never promises one. Callers
// pass `hosted: !owesShoppingList(plan)`, the same predicate the step
// banners key on. Two voices
// because the screens were written apart; the BYOB output of each is
// byte-identical to the inline copy it replaced (pinned in the test).

const VOICES = {
  v1: { verb: 'create', list: 'a shopping list', menu: 'a menu', sheet: 'a BEO (Banquet Event Order)' },
  v2: { verb: 'build', list: 'your shopping list', menu: 'your menu', sheet: 'the run sheet' },
};

// "a, b, and c" / "a and b" / "a".
function joinList(parts) {
  if (parts.length <= 1) return parts.join('');
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

export function menuOwedFor(selections) {
  const style = selections ? selections.menuStyle : undefined;
  return style === 'custom' || style === 'house';
}

export function nextStepsCopy({ voice, hosted, menuOwed }) {
  const v = voice === 'v1' ? VOICES.v1 : VOICES.v2;
  const parts = [!hosted && v.list, menuOwed && v.menu, v.sheet].filter(Boolean);
  return `We'll use your selections to ${v.verb} ${joinList(parts)} for your event. Expect to hear from us within 2 business days!`;
}

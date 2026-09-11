import { owesShoppingList } from './shoppingListOwed';

// One predicate for every admin surface that turns a plan row into "shopping
// list owed" work (Events Plan column, overview prep queue, Potions drawer
// chip, and the Potions badge on the server side). A hosted package never
// owes one: DRB stocks the bar and the server stages no list for it
// (shoppingListGen.isHostedPlan). Unknown fails open, exactly as the server.
describe('owesShoppingList', () => {
  test('a hosted package never owes a list, whatever its list column holds', () => {
    expect(owesShoppingList({ package_category: 'hosted' })).toBe(false);
    expect(owesShoppingList({ package_category: 'hosted', shopping_list_status: 'pending_review' })).toBe(false);
  });
  test('BYOB owes one', () => {
    expect(owesShoppingList({ package_category: 'byob' })).toBe(true);
  });
  test('a cocktail class is seeded hosted but may self-supply, so it still owes one', () => {
    expect(owesShoppingList({ package_category: 'hosted', package_bar_type: 'class' })).toBe(true);
    expect(owesShoppingList({ package_category: 'hosted', package_bar_type: 'full_bar' })).toBe(false);
  });
  test('no package fails open to owing one', () => {
    expect(owesShoppingList({ package_category: null })).toBe(true);
    expect(owesShoppingList({})).toBe(true);
    expect(owesShoppingList(null)).toBe(true);
  });
});

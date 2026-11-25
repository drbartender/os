// A proposal's own drink swaps applied to a package list: the client page's
// list, the admin list and the admin-only section naming a swap that matched
// nothing. Uses a real catalogued package; the swap text is synthetic.
import { getPackageForProposal, getPackageItems, getPackageBySlug, SWAP_UNMATCHED_HEADING } from './packages';

const SLUG = 'the-grand-experiment';
const SWAPS = [{ from: "Maker's Mark Bourbon", to: 'Test Bourbon – Soft.' }];
const flat = (sections) => sections.flatMap((s) => s.items);

test('the client page list carries the replacement in place of the default', () => {
  const items = flat(getPackageForProposal(SLUG, SWAPS).sections);
  expect(items).toContain('Test Bourbon – Soft.');
  expect(items.some((i) => i.startsWith("Maker's Mark Bourbon"))).toBe(false);
  expect(items.length).toBe(flat(getPackageBySlug(SLUG).sections).length);
});

test('no swaps, or a malformed value, leaves the package list as it is', () => {
  const base = getPackageBySlug(SLUG).sections;
  expect(getPackageForProposal(SLUG, []).sections).toEqual(base);
  expect(getPackageForProposal(SLUG, undefined).sections).toEqual(base);
  expect(getPackageForProposal(SLUG, { from: 'x', to: 'y' }).sections).toEqual(base);
});

test('the admin list shows names only, and no warning when every swap matched', () => {
  const sections = getPackageItems(SLUG, SWAPS);
  expect(flat(sections)).toContain('Test Bourbon');
  expect(sections.some((s) => s.heading === SWAP_UNMATCHED_HEADING)).toBe(false);
});

test('a swap that matched nothing is named in the admin list and never on the client page', () => {
  const curly = [{ from: 'Maker’s Mark Bourbon', to: 'Test Bourbon – Soft.' }];
  const sections = getPackageItems(SLUG, curly);
  const warn = sections.find((s) => s.heading === SWAP_UNMATCHED_HEADING);
  expect(warn.items).toEqual(['Maker’s Mark Bourbon (meant to become Test Bourbon)']);
  expect(flat(sections)).toContain("Maker's Mark Bourbon");
  expect(getPackageForProposal(SLUG, curly).sections.some((s) => s.heading === SWAP_UNMATCHED_HEADING)).toBe(false);
});

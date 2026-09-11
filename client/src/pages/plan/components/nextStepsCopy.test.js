import { nextStepsCopy, menuOwedFor } from './nextStepsCopy';

// The BYOB strings are pinned byte-for-byte to the copy the two finish screens
// carried inline before 2026-09-11, so moving them here changed nothing a
// client reads. The hosted strings are the reason the module exists: a hosted
// package never owes a shopping list, so the finish never promises one.
describe('nextStepsCopy', () => {
  test('v1 BYOB, menu owed (unchanged)', () => {
    expect(nextStepsCopy({ voice: 'v1', hosted: false, menuOwed: true })).toBe(
      "We'll use your selections to create a shopping list, a menu, and a BEO (Banquet Event Order) for your event. Expect to hear from us within 2 business days!");
  });
  test('v1 BYOB, no menu (unchanged)', () => {
    expect(nextStepsCopy({ voice: 'v1', hosted: false, menuOwed: false })).toBe(
      "We'll use your selections to create a shopping list and a BEO (Banquet Event Order) for your event. Expect to hear from us within 2 business days!");
  });
  test('v2 BYOB, menu owed (unchanged)', () => {
    expect(nextStepsCopy({ voice: 'v2', hosted: false, menuOwed: true })).toBe(
      "We'll use your selections to build your shopping list, your menu, and the run sheet for your event. Expect to hear from us within 2 business days!");
  });
  test('v2 BYOB, no menu (unchanged)', () => {
    expect(nextStepsCopy({ voice: 'v2', hosted: false, menuOwed: false })).toBe(
      "We'll use your selections to build your shopping list and the run sheet for your event. Expect to hear from us within 2 business days!");
  });

  test('v1 hosted, menu owed', () => {
    expect(nextStepsCopy({ voice: 'v1', hosted: true, menuOwed: true })).toBe(
      "We'll use your selections to create a menu and a BEO (Banquet Event Order) for your event. Expect to hear from us within 2 business days!");
  });
  test('v1 hosted, no menu', () => {
    expect(nextStepsCopy({ voice: 'v1', hosted: true, menuOwed: false })).toBe(
      "We'll use your selections to create a BEO (Banquet Event Order) for your event. Expect to hear from us within 2 business days!");
  });
  test('v2 hosted, menu owed', () => {
    expect(nextStepsCopy({ voice: 'v2', hosted: true, menuOwed: true })).toBe(
      "We'll use your selections to build your menu and the run sheet for your event. Expect to hear from us within 2 business days!");
  });
  test('v2 hosted, no menu', () => {
    expect(nextStepsCopy({ voice: 'v2', hosted: true, menuOwed: false })).toBe(
      "We'll use your selections to build the run sheet for your event. Expect to hear from us within 2 business days!");
  });
});

describe('menuOwedFor', () => {
  test('custom and house menus are owed, anything else is not', () => {
    expect(menuOwedFor({ menuStyle: 'custom' })).toBe(true);
    expect(menuOwedFor({ menuStyle: 'house' })).toBe(true);
    expect(menuOwedFor({ menuStyle: 'none' })).toBe(false);
    expect(menuOwedFor({})).toBe(false);
    expect(menuOwedFor(null)).toBe(false);
  });
});

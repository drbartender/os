import { activityLabel, clientSource, isMenuActivity } from './menuActivityLabels';

// The menu review's activity rows by name (spec 2026-10-19 sections 10 to 12),
// one map for the proposal page and the event page's Activity card.
describe('menuActivityLabels', () => {
  test.each([
    ['menu_approved', 'Menu approved'],
    ['menu_proof_sent', 'Menu proof sent'],
    ['menu_released', 'Menu released for printing'],
    ['menu_proof_approved', 'Client said the menu looks great'],
    ['menu_proof_changes', 'Client asked for menu changes'],
    ['menu_proof_closed', 'Menu change request closed'],
  ])('%s reads %s', (action, label) => {
    expect(activityLabel(action)).toBe(label);
    expect(isMenuActivity(action)).toBe(true);
    expect(clientSource(action)).toBe('Menu proof page');
  });

  test('every other action prints as it is, and names the proposal page as a client source', () => {
    for (const action of ['proposal_viewed', 'payment', 'sent', 'menu_something_else']) {
      expect(activityLabel(action)).toBe(action);
      expect(isMenuActivity(action)).toBe(false);
      expect(clientSource(action)).toBe('Proposal page');
    }
    expect(activityLabel(undefined)).toBeUndefined();
    expect(activityLabel('')).toBe('');
    expect(isMenuActivity('constructor')).toBe(false);
  });
});

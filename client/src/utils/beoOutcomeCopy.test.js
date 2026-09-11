import { beoOutcomeCopy, beoToastKind } from './beoOutcomeCopy';

test('finalized reads as done', () => {
  expect(beoOutcomeCopy({ finalized: true })).toBe('BEO finalized.');
  expect(beoToastKind({ finalized: true })).toBe('success');
});

test('the two "not yet" states name the missing action and stay success-level', () => {
  expect(beoOutcomeCopy({ finalized: false, reason: 'list_not_approved' })).toBe('BEO finalizes when the shopping list is approved.');
  expect(beoOutcomeCopy({ finalized: false, reason: 'not_reviewed' })).toBe('BEO finalizes when the plan is marked reviewed.');
  expect(beoToastKind({ finalized: false, reason: 'list_not_approved' })).toBe('success');
});

test('unpaid extras carries the amount in dollars and points at the override', () => {
  expect(beoOutcomeCopy({ finalized: false, reason: 'unpaid_extras', unpaid_extras_cents: 6000 }))
    .toBe('BEO not finalized: $60.00 extras unpaid. Finalize BEO overrides.');
  expect(beoToastKind({ finalized: false, reason: 'unpaid_extras' })).toBe('info');
});

test('hard skips say why; unknown reasons fall back to the button', () => {
  expect(beoOutcomeCopy({ finalized: false, reason: 'no_selections' })).toBe('BEO not finalized: the plan has no selections.');
  expect(beoOutcomeCopy({ finalized: false, reason: 'error' })).toBe('BEO not finalized. Use Finalize BEO.');
  expect(beoOutcomeCopy({ finalized: false, reason: 'conflict' })).toBe('BEO not finalized. Use Finalize BEO.');
});

test('already finalized arrives as finalized now; a missing report says nothing', () => {
  expect(beoOutcomeCopy({ finalized: true, reason: 'already_finalized' })).toBe('BEO finalized.');
  expect(beoToastKind({ finalized: true, reason: 'already_finalized' })).toBe('success');
  expect(beoOutcomeCopy(undefined)).toBe('');
  expect(beoOutcomeCopy(null)).toBe('');
});

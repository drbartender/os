import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, act } from '@testing-library/react';
import useCancelTargets from './useCancelTargets';
import { matchCancelTargets } from '../../../components/PricingBreakdown';
import api from '../../../utils/api';

// The cancel-line targets beside the editor's two parents (consistency review
// MAJOR-1, fix round 1). An adjustment target is positional (adjustment:<i>),
// so a set fetched before a save moved the lines must never bind a row.
// Fixtures are synthetic.

jest.mock('../../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));

const line = (label, amount) => ({ label, amount: -amount });
const target = (i, label, amount) => ({ target: `adjustment:${i}`, label, amount: -amount, cancellable: true });
const W = ['Test discount W', 10]; const X = ['Test discount X', 20]; const Y = ['Test discount Y', 30]; const Z = ['Test discount Z', 40];
const readOf = (lines, at) => ({
  id: 13, status: 'deposit_paid', updated_at: at,
  pricing_snapshot: { breakdown: [{ label: 'Test package', amount: 500 }, ...lines.map(([l, a]) => line(l, a))] },
});
const targetsOf = (lines) => lines.map(([l, a], i) => target(i, l, a));

// What the page would bind: each breakdown row's label to the target key the
// remove button there would send.
function Harness({ proposal, isAdmin = true }) {
  const { targets, reload } = useCancelTargets({ proposalId: 13, proposal, isAdmin });
  const { byRow } = matchCancelTargets(proposal.pricing_snapshot, targets);
  const bound = {};
  proposal.pricing_snapshot.breakdown.forEach((row, i) => { if (byRow.has(i)) bound[row.label] = byRow.get(i).target; });
  return (
    <>
      <output data-testid="bound">{JSON.stringify(bound)}</output>
      <output data-testid="targets">{JSON.stringify(targets)}</output>
      <button type="button" onClick={reload}>reload</button>
    </>
  );
}
const bound = () => JSON.parse(screen.getByTestId('bound').textContent);
const targets = () => JSON.parse(screen.getByTestId('targets').textContent);

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => { api.get.mockReset(); });

test('a save that deletes a middle line leaves no stale target bound to a row', async () => {
  const first = deferred(); const second = deferred(); const third = deferred();
  api.get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
  const R1 = readOf([W, X, Y, Z], '2027-01-01T10:00:00.000Z');
  const { rerender } = render(<Harness proposal={R1} />);
  expect(api.get).toHaveBeenCalledWith('/proposals/13/cancel-line/targets');
  await act(async () => { first.resolve({ data: { eligible: true, targets: targetsOf([W, X, Y, Z]) } }); });
  expect(bound()).toEqual({ [W[0]]: 'adjustment:0', [X[0]]: 'adjustment:1', [Y[0]]: 'adjustment:2', [Z[0]]: 'adjustment:3' });

  // The editor deleted X. onSaved calls reload before the page re-reads: the
  // old set is gone at once, nothing is bound while the fresh one is on its way.
  fireEvent.click(screen.getByRole('button', { name: 'reload' }));
  expect(targets()).toBeNull();
  expect(bound()).toEqual({});

  // The page re-reads. With the old set, Y's row would bind adjustment:2, now Z.
  const R2 = readOf([W, Y, Z], '2027-01-01T10:05:00.000Z');
  rerender(<Harness proposal={R2} />);
  expect(bound()).toEqual({});
  expect(api.get).toHaveBeenCalledTimes(3);
  // The set fetched at reload lands, but for the older read: never shown.
  await act(async () => { second.resolve({ data: { eligible: true, targets: targetsOf([W, Y, Z]) } }); });
  expect(bound()).toEqual({});
  await act(async () => { third.resolve({ data: { eligible: true, targets: targetsOf([W, Y, Z]) } }); });
  expect(bound()).toEqual({ [W[0]]: 'adjustment:0', [Y[0]]: 'adjustment:1', [Z[0]]: 'adjustment:2' });
});

test('a new read hides the old set at once, before its own set lands', async () => {
  const first = deferred(); const second = deferred();
  api.get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const R1 = readOf([W, X], '2027-01-01T10:00:00.000Z');
  const { rerender } = render(<Harness proposal={R1} />);
  await act(async () => { first.resolve({ data: { eligible: true, targets: targetsOf([W, X]) } }); });
  expect(bound()).toEqual({ [W[0]]: 'adjustment:0', [X[0]]: 'adjustment:1' });
  rerender(<Harness proposal={readOf([X], '2027-01-01T10:05:00.000Z')} />);
  expect(bound()).toEqual({});
  await act(async () => { second.resolve({ data: { eligible: true, targets: targetsOf([X]) } }); });
  expect(bound()).toEqual({ [X[0]]: 'adjustment:0' });
});

test('when the re-read fails, the set fetched at reload is the server\'s current one, so it is shown', async () => {
  const first = deferred(); const second = deferred();
  api.get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const R1 = readOf([W, X, Y], '2027-01-01T10:00:00.000Z');
  render(<Harness proposal={R1} />);
  await act(async () => { first.resolve({ data: { eligible: true, targets: targetsOf([W, X, Y]) } }); });
  fireEvent.click(screen.getByRole('button', { name: 'reload' }));
  expect(bound()).toEqual({});
  // The server now holds [X, Y]; the page still shows R1 (its re-read failed).
  await act(async () => { second.resolve({ data: { eligible: true, targets: targetsOf([X, Y]) } }); });
  // Fresh indices: X's row binds 0, where the server holds X.
  expect(bound()).toEqual({ [X[0]]: 'adjustment:0', [Y[0]]: 'adjustment:1' });
});

test('a failed or ineligible answer shows nothing', async () => {
  api.get.mockReturnValueOnce(Promise.reject({ status: 500 }));
  const { rerender } = render(<Harness proposal={readOf([W], 'a')} />);
  await act(async () => {});
  expect(targets()).toBeNull();
  api.get.mockReturnValueOnce(Promise.resolve({ data: { eligible: false, targets: targetsOf([W]) } }));
  rerender(<Harness proposal={readOf([W], 'b')} />);
  await act(async () => {});
  expect(targets()).toBeNull();
});

test('a manager, an archived or a completed booking: no fetch, no targets', async () => {
  const { rerender } = render(<Harness proposal={readOf([W], 'a')} isAdmin={false} />);
  rerender(<Harness proposal={{ ...readOf([W], 'b'), status: 'archived' }} />);
  rerender(<Harness proposal={{ ...readOf([W], 'c'), status: 'completed' }} />);
  await act(async () => {});
  expect(api.get).not.toHaveBeenCalled();
  expect(targets()).toBeNull();
});

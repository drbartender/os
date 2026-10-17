import React, { useState } from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, within } from '@testing-library/react';
import AdjustmentsSection from './AdjustmentsSection';

// The editor's price adjustment rows (spec 2026-10-16 section 5; plan Task E4
// item 3). Removing or lowering a refund line bills refunded money again, so
// it asks inline first and changes nothing until confirmed. Fixtures are
// synthetic.
const REFUND = { type: 'discount', label: 'Refund', amount: 20, visible: true, source: 'refund', refund_id: 14 };
const OTHER = { type: 'discount', label: 'Test discount A', amount: 10, visible: true };
const CONFIRM = 'This line records money already refunded. Removing it bills that amount again.';
const PREVIEW = { total: 1000, gratuity: { total: 0 }, breakdown: [] };

function Harness({ initial }) {
  const [lines, setLines] = useState(initial);
  return (
    <>
      <AdjustmentsSection adjustments={lines} loadedAdjustments={initial} onChange={(op) => setLines((cur) => op(cur))}
        preview={PREVIEW} previewStale={false} override={null} />
      <output data-testid="lines">{JSON.stringify(lines)}</output>
    </>
  );
}
const lines = () => JSON.parse(screen.getByTestId('lines').textContent);
const row = (label) => screen.getByRole('group', { name: label });

test('removing a refund line asks first and changes nothing until confirmed', () => {
  render(<Harness initial={[OTHER, REFUND]} />);
  fireEvent.click(within(row('Refund')).getByRole('button', { name: 'Remove' }));
  expect(screen.getByText(CONFIRM)).toBeInTheDocument();
  expect(lines()).toEqual([OTHER, REFUND]);
  fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
  expect(screen.queryByText(CONFIRM)).toBeNull();
  expect(lines()).toEqual([OTHER, REFUND]);

  fireEvent.click(within(row('Refund')).getByRole('button', { name: 'Remove' }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove it' }));
  expect(screen.queryByText(CONFIRM)).toBeNull();
  expect(lines()).toEqual([OTHER]);
});

test('lowering a refund line asks first; raising or relabeling it does not', () => {
  render(<Harness initial={[REFUND]} />);
  const amount = within(row('Refund')).getByLabelText('Amount');
  fireEvent.change(amount, { target: { value: '5' } });
  expect(screen.getByText(CONFIRM)).toBeInTheDocument();
  expect(lines()[0].amount).toBe(20);
  expect(amount).toHaveValue(20);
  fireEvent.click(screen.getByRole('button', { name: 'Lower it' }));
  expect(lines()[0].amount).toBe('5');
  expect(screen.queryByText(CONFIRM)).toBeNull();

  fireEvent.change(within(row('Refund')).getByLabelText('Amount'), { target: { value: '30' } });
  expect(screen.queryByText(CONFIRM)).toBeNull();
  expect(lines()[0].amount).toBe('30');
  fireEvent.change(within(row('Refund')).getByLabelText('Label'), { target: { value: 'Test refund' } });
  expect(screen.queryByText(CONFIRM)).toBeNull();
  expect(lines()[0]).toMatchObject({ label: 'Test refund', source: 'refund', refund_id: 14 });
});

test('clearing a refund line\'s amount is a lowering too', () => {
  render(<Harness initial={[REFUND]} />);
  fireEvent.change(within(row('Refund')).getByLabelText('Amount'), { target: { value: '' } });
  expect(screen.getByText(CONFIRM)).toBeInTheDocument();
  expect(lines()[0].amount).toBe(20);
});

test('another edit while the confirm is open withdraws it, so it can never land on the wrong line', () => {
  render(<Harness initial={[OTHER, REFUND]} />);
  fireEvent.click(within(row('Refund')).getByRole('button', { name: 'Remove' }));
  expect(screen.getByText(CONFIRM)).toBeInTheDocument();
  fireEvent.click(within(row('Test discount A')).getByRole('button', { name: 'Remove' }));
  expect(screen.queryByText(CONFIRM)).toBeNull();
  expect(lines()).toEqual([REFUND]);
});

test('an ordinary line lowers and removes with no confirm', () => {
  render(<Harness initial={[OTHER]} />);
  fireEvent.change(within(row('Test discount A')).getByLabelText('Amount'), { target: { value: '2' } });
  expect(screen.queryByText(CONFIRM)).toBeNull();
  expect(lines()[0].amount).toBe('2');
  fireEvent.click(within(row('Test discount A')).getByRole('button', { name: 'Remove' }));
  expect(lines()).toEqual([]);
});

test('+ Discount and + Surcharge add a fresh line; Client sees toggles visibility', () => {
  render(<Harness initial={[]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Discount' }));
  fireEvent.click(screen.getByRole('button', { name: 'Surcharge' }));
  expect(lines()).toEqual([
    { type: 'discount', label: '', amount: '', visible: true },
    { type: 'surcharge', label: '', amount: '', visible: true },
  ]);
  fireEvent.click(within(row('Discount')).getByLabelText('Client sees'));
  expect(lines()[0].visible).toBe(false);
});

test('Set agreed price sits beside them and writes its line into the rows', () => {
  render(<Harness initial={[OTHER]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Set agreed price' }));
  // Preview service total 1000 includes the -10 line; agree 900.
  fireEvent.change(screen.getByLabelText('Agreed price'), { target: { value: '900' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(lines()).toEqual([OTHER, {
    type: 'discount', label: 'Agreed price adjustment', amount: 100, visible: false, source: 'agreed_price',
  }]);
  expect(row('Agreed price adjustment')).toBeInTheDocument();
});

// Fix round 1 (code NIT-1): the confirm compares against the amount the refund
// line was loaded with, and asks once per refund line, so typing a new amount
// does not ask on every keystroke and a mistaken raise backed out never asks.
test('once a lowering is confirmed, typing on toward the new amount does not ask again', () => {
  render(<Harness initial={[REFUND]} />);
  const amount = () => within(row('Refund')).getByLabelText('Amount');
  fireEvent.change(amount(), { target: { value: '1' } });
  expect(screen.getByText(CONFIRM)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Lower it' }));
  fireEvent.change(amount(), { target: { value: '15' } });
  expect(screen.queryByText(CONFIRM)).toBeNull();
  expect(lines()[0].amount).toBe('15');
  fireEvent.change(amount(), { target: { value: '' } });
  expect(screen.queryByText(CONFIRM)).toBeNull();
  // Removing it still asks: that is its own decision.
  fireEvent.click(within(row('Refund')).getByRole('button', { name: 'Remove' }));
  expect(screen.getByText(CONFIRM)).toBeInTheDocument();
});

test('a raise backed out to the recorded refund never asks', () => {
  render(<Harness initial={[REFUND]} />);
  const amount = () => within(row('Refund')).getByLabelText('Amount');
  fireEvent.change(amount(), { target: { value: '200' } });
  fireEvent.change(amount(), { target: { value: '20' } });
  expect(screen.queryByText(CONFIRM)).toBeNull();
  expect(lines()[0].amount).toBe('20');
  // Below the recorded refund still asks.
  fireEvent.change(amount(), { target: { value: '2' } });
  expect(screen.getByText(CONFIRM)).toBeInTheDocument();
  expect(lines()[0].amount).toBe('20');
});

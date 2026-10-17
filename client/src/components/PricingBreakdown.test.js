import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, within, fireEvent } from '@testing-library/react';
import PricingBreakdown from './PricingBreakdown';

// A synthetic snapshot shaped like the engine's: service rows, then one row
// per adjustment (each with its own visible), the client Gratuity row last.
const snapshot = {
  total: 1270,
  gratuity: { total: 0 },
  adjustments: [
    { type: 'discount', label: 'Test discount A', amount: 50, visible: true },
    { type: 'discount', label: 'Test hidden discount', amount: 40, visible: false },
    { type: 'discount', label: 'Refund', amount: 20, visible: true, source: 'refund', refund_id: 7 },
    { type: 'surcharge', label: 'Agreed price adjustment', amount: 70, visible: false, source: 'agreed_price' },
  ],
  breakdown: [
    { label: 'BYOB Bar (4hrs, 100 guests)', amount: 1000 },
    { label: 'Bar Rental (1 bar)', amount: 50 },
    { label: 'Orphaned add-on', amount: 210 },
    { label: 'Test discount A', amount: -50, visible: true },
    { label: 'Test hidden discount', amount: -40, visible: false },
    { label: 'Refund', amount: -20, visible: true },
    { label: 'Agreed price adjustment', amount: 70, visible: false },
  ],
};
// GET /api/proposals/:id/cancel-line/targets, shaped as lineItemCancel.js
// computeCancelTargets returns them.
const targets = [
  { target: 'package', label: 'BYOB Bar', amount: 1000, cancellable: false, reason: 'event_cancel' },
  { target: 'bar', label: 'Bar Rental', amount: 50, quantity: 1, cancellable: true },
  { target: null, label: 'Orphaned add-on', amount: 210, cancellable: false, reason: 'orphaned_addon' },
  { target: 'adjustment:0', label: 'Test discount A', amount: -50, cancellable: true },
  { target: 'adjustment:1', label: 'Test hidden discount', amount: -40, cancellable: true },
  { target: 'adjustment:2', label: 'Refund', amount: -20, cancellable: false, reason: 'protected_line' },
  { target: 'adjustment:3', label: 'Agreed price adjustment', amount: 70, cancellable: false, reason: 'protected_line' },
];
// A table row is named from its cells, the label first.
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rowOf = (label) => screen.getByRole('row', { name: new RegExp(`^${escapeRe(label)}`) });

test('hidden lines carry the "hidden from client" tag; every other row has none', () => {
  render(<PricingBreakdown snapshot={snapshot} cancelTargets={targets} onCancelLine={jest.fn()} />);
  const tags = screen.getAllByText('hidden from client');
  expect(tags).toHaveLength(2);
  for (const tag of tags) expect(tag).toHaveClass('chip', 'muted');
  expect(within(rowOf('Test hidden discount')).getByText('hidden from client')).toBeInTheDocument();
  expect(within(rowOf('Agreed price adjustment')).getByText('hidden from client')).toBeInTheDocument();
  for (const label of ['Bar Rental (1 bar)', 'Test discount A', 'Refund']) {
    expect(within(rowOf(label)).queryByText('hidden from client')).toBeNull();
  }
});

test('refund and agreed-price lines have no remove button; ordinary lines keep theirs', () => {
  const onCancelLine = jest.fn();
  render(<PricingBreakdown snapshot={snapshot} cancelTargets={targets} onCancelLine={onCancelLine} />);
  expect(screen.queryByRole('button', { name: 'Remove Refund' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Remove Agreed price adjustment' })).toBeNull();
  expect(within(rowOf('Refund')).queryByRole('button')).toBeNull();
  expect(within(rowOf('Agreed price adjustment')).queryByRole('button')).toBeNull();
  // Unchanged: ordinary lines, a hidden one included, and the package's
  // cancel-event route keep an enabled control; an orphaned add-on keeps its
  // disabled one.
  for (const name of ['Remove Test discount A', 'Remove Test hidden discount', 'Remove Bar Rental', 'Remove BYOB Bar']) {
    expect(screen.getByRole('button', { name })).toBeEnabled();
  }
  expect(screen.getByRole('button', { name: 'Cannot remove Orphaned add-on here' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Remove Test hidden discount' }));
  expect(onCancelLine).toHaveBeenCalledWith(targets[4]);
});

test('an old snapshot (no visible on its rows) tags the hidden lines from its adjustments', () => {
  const old = {
    total: 1010,
    adjustments: [
      { type: 'discount', label: 'Test discount A', amount: 50, visible: true },
      { type: 'discount', label: 'Test hidden discount', amount: 40 },
    ],
    breakdown: [
      { label: 'BYOB Bar (4hrs, 100 guests)', amount: 1000 },
      { label: 'Bar Rental (1 bar)', amount: 50 },
      { label: 'Test discount A', amount: -50 },
      { label: 'Test hidden discount', amount: -40 },
    ],
  };
  render(<PricingBreakdown snapshot={old} />);
  expect(screen.getAllByText('hidden from client')).toHaveLength(1);
  expect(within(rowOf('Test hidden discount')).getByText('hidden from client')).toBeInTheDocument();
});

test('the editor preview (no cancel targets) tags hidden lines and draws no action column', () => {
  render(<PricingBreakdown snapshot={snapshot} />);
  expect(screen.getAllByText('hidden from client')).toHaveLength(2);
  expect(screen.queryAllByRole('button')).toHaveLength(0);
  expect(within(rowOf('Refund')).getAllByRole('cell')).toHaveLength(2);
});

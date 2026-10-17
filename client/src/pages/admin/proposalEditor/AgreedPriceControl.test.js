import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import AgreedPriceControl from './AgreedPriceControl';

// "Set agreed price" (spec 2026-10-16 section 5; plan Task E4 item 2). The
// preview is the live /calculate snapshot; the agreed price is the service
// total before the client gratuity. Fixtures are synthetic.
const AP = (amount, type = 'discount', visible = false) =>
  ({ type, label: 'Agreed price adjustment', amount, visible, source: 'agreed_price' });
const PREVIEW = { total: 1655, gratuity: { total: 0 }, breakdown: [{ label: 'Test package (4hrs, 50 guests)', amount: 1655 }] };

function mount(props = {}) {
  const onApply = jest.fn();
  const utils = render(
    <AgreedPriceControl adjustments={[]} preview={PREVIEW} previewStale={false} override={null} onApply={onApply} {...props} />
  );
  return { onApply, ...utils };
}
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Set agreed price' }));
const input = () => screen.getByLabelText('Agreed price');
const apply = () => screen.getByRole('button', { name: 'Apply' });
const type = (v) => fireEvent.change(input(), { target: { value: v } });

test('Set agreed price opens one dollar input and Apply, with the helper', () => {
  mount();
  expect(screen.queryByLabelText('Agreed price')).toBeNull();
  open();
  expect(input()).toBeInTheDocument();
  expect(apply()).toBeInTheDocument();
  expect(screen.getByText('Before gratuity. Gratuity is added on top.')).toBeInTheDocument();
  expect(screen.queryByText(/Includes staffing gratuity/)).toBeNull();
});

test('the helper adds "Includes staffing gratuity." when the preview carries a Shared Gratuity row', () => {
  mount({ preview: { ...PREVIEW, breakdown: [...PREVIEW.breakdown, { label: 'Shared Gratuity', amount: 50 }] } });
  open();
  expect(screen.getByText('Before gratuity. Gratuity is added on top. Includes staffing gratuity.')).toBeInTheDocument();
});

test('Apply writes the line through onApply and closes', () => {
  const { onApply } = mount();
  open();
  type('1,493.00');
  expect(apply()).toBeEnabled();
  fireEvent.click(apply());
  expect(onApply).toHaveBeenCalledTimes(1);
  expect(onApply).toHaveBeenCalledWith([AP(162)]);
  expect(screen.queryByLabelText('Agreed price')).toBeNull();
});

test('Apply is disabled while the preview is stale, and while there is no preview', () => {
  const { rerender, onApply } = mount({ previewStale: true });
  open();
  type('1400');
  expect(apply()).toBeDisabled();
  rerender(<AgreedPriceControl adjustments={[]} preview={null} previewStale={false} override={null} onApply={onApply} />);
  expect(apply()).toBeDisabled();
  rerender(<AgreedPriceControl adjustments={[]} preview={PREVIEW} previewStale={false} override={null} onApply={onApply} />);
  expect(apply()).toBeEnabled();
});

test('blank, non-numeric, negative or too large input disables Apply with the inline message', () => {
  mount();
  open();
  for (const v of ['', 'abc', '-1', '1000000']) {
    type(v);
    expect(apply()).toBeDisabled();
    expect(screen.getByText('Enter a price of $0 or more')).toBeInTheDocument();
  }
  type('0');
  expect(apply()).toBeEnabled();
  expect(screen.queryByText('Enter a price of $0 or more')).toBeNull();
});

test('a booking that still has an override shows it and cannot set an agreed price', () => {
  mount({ override: '3373.00' });
  expect(screen.getByText('Price override: $3,373.00. It converts to an Agreed price adjustment line soon.')).toBeInTheDocument();
  const button = screen.getByRole('button', { name: 'Set agreed price' });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
});

test('a refusal at the $0 clamp says why and changes nothing', () => {
  const { onApply } = mount({ adjustments: [AP(500)], preview: { total: 0, gratuity: { total: 0 }, breakdown: [] } });
  open();
  type('100');
  fireEvent.click(apply());
  expect(onApply).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('Remove the agreed price line, then set the price again.');
  expect(input()).toBeInTheDocument();
});

test('the price is the service total: the preview\'s client gratuity is left out', () => {
  // Total 1775 = 1655 service + 120 gratuity; agreeing 1655 changes nothing.
  const { onApply } = mount({ preview: { total: 1775, gratuity: { total: 120 }, breakdown: [] } });
  open();
  type('1655');
  fireEvent.click(apply());
  expect(onApply).toHaveBeenCalledWith([]);
});

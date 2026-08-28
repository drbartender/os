import React from 'react';
import { render } from '@testing-library/react';
import ProposalPricingBreakdown from './ProposalPricingBreakdown';

// While the redirect is settling, the Pricing table must not show any figure
// the payment webhook writes: the Gratuity line and the Total. The contract
// lines are the proposal's own and stay.
const proposal = { package_name: 'Signature Bar', package_slug: 'no-such-package', status: 'accepted' };
const snapshot = { total: 350, gratuity: { total: 0 } };
const lineItems = [
  { label: 'Signature Bar', amount: 300 },
  { label: 'Bar Rental', amount: 50 },
  { label: 'Gratuity', amount: 75, gratuity: true },
];
const none = { kind: 'none', amountPaid: 0, total: 350, remaining: 350, completed: false };
const base = {
  proposal, includes: [], lineItems, snapshot, paid: none,
  balanceAmount: 250, balanceDueDate: '2026-09-12', fullPaymentRequired: false,
  showSignAndPay: false, showPayOnly: false, showOptionsEntry: false,
  onOpenOptions: () => {}, entryRef: { current: null },
};

function pricingTable(container) {
  return container.querySelector('table');
}

test('settling hides the Gratuity line and dashes the Total; the contract lines stay', () => {
  const { container } = render(<ProposalPricingBreakdown {...base} settling />);
  const table = pricingTable(container).textContent;
  expect(table).toMatch(/Signature Bar/);
  expect(table).toMatch(/Bar Rental/);
  expect(table).toMatch(/\$50/);
  expect(table).not.toMatch(/Gratuity/);
  expect(table).not.toMatch(/\$75/);
  expect(table).not.toMatch(/\$350/);
  expect(pricingTable(container).querySelector('tfoot').textContent).toMatch(/Total\s*—/);
});

test('not settling renders the Gratuity line and the snapshot Total', () => {
  const { container } = render(<ProposalPricingBreakdown {...base} settling={false} />);
  const table = pricingTable(container).textContent;
  expect(table).toMatch(/Gratuity/);
  expect(table).toMatch(/\$75/);
  expect(pricingTable(container).querySelector('tfoot').textContent).toMatch(/\$350/);
});

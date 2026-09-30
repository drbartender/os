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

test('settling with a pending bank debit prints Pending for the Total instead of a bare dash, and names the wait', () => {
  const { container } = render(<ProposalPricingBreakdown {...base} settling pendingPayment />);
  const foot = pricingTable(container).querySelector('tfoot');
  expect(foot.textContent).toMatch(/Pending/);
  expect(foot.textContent).not.toMatch(/\$|—/);
  expect(container.textContent).toMatch(/Your bank payment is processing/);
});

// The Service Agreement section shows the version the proposal was SIGNED
// under, so a client who signed v3 never reads v4 terms as if they agreed to
// them. Unsigned proposals show the current version.
test('a proposal signed under v3 shows the v3 Section 8.1', () => {
  const signed = { ...proposal, client_signature_document_version: 'event-services-agreement-v3' };
  const { container } = render(<ProposalPricingBreakdown {...base} proposal={signed} settling={false} />);
  expect(container.textContent).toMatch(/added to the final invoice/);
  expect(container.textContent).not.toMatch(/per-guest extra-hour rate/);
});

test('an unsigned proposal shows the current Section 8.1', () => {
  const { container } = render(<ProposalPricingBreakdown {...base} settling={false} />);
  expect(container.textContent).toMatch(/per-guest extra-hour rate/);
  expect(container.textContent).not.toMatch(/added to the final invoice/);
});

// Agreement v4 Section 8.1 bills hosted added time at the package's per-guest
// extra-hour rate "as stated in the Event-Specific Agreement". This line is
// that statement: without it the client agrees to a rate they cannot see.
const ADDED_TIME = /Added time on the day/;

test('a hosted proposal states the added-time rate per hour, with the per-guest rate behind it', () => {
  const p = { ...proposal, guest_count: 100, additional_time: { hourly: 575, per_guest_rate: 5.75, billed_guests: 100 } };
  const { container } = render(<ProposalPricingBreakdown {...base} proposal={p} settling={false} />);
  expect(container.textContent).toContain(
    'Added time on the day: $575 per hour for the package ($5.75 per guest, 100 guests), plus gratuity and any extra bartenders or timed add-ons, billed in 30 minute steps.'
  );
});

test('a booking billed at the guest minimum names the minimum instead of a guest count it is not billed at', () => {
  const p = { ...proposal, guest_count: 20, additional_time: { hourly: 100, per_guest_rate: 4, billed_guests: 25 } };
  const { container } = render(<ProposalPricingBreakdown {...base} proposal={p} settling={false} />);
  expect(container.textContent).toContain(
    'Added time on the day: $100 per hour for the package ($4 per guest, 25 guest minimum), plus gratuity and any extra bartenders or timed add-ons, billed in 30 minute steps.'
  );
});

test('a service-only proposal states the hourly rate alone, and large rates get a thousands separator', () => {
  const flat = { ...proposal, guest_count: 160, additional_time: { hourly: 100, per_guest_rate: null, billed_guests: null } };
  const { container } = render(<ProposalPricingBreakdown {...base} proposal={flat} settling={false} />);
  expect(container.textContent).toContain('Added time on the day: $100 per hour for the package, plus gratuity and any extra bartenders or timed add-ons, billed in 30 minute steps.');

  const big = { ...proposal, guest_count: 250, additional_time: { hourly: 2812.5, per_guest_rate: 11.25, billed_guests: 250 } };
  const second = render(<ProposalPricingBreakdown {...base} proposal={big} settling={false} />);
  expect(second.container.textContent).toContain('$2,812.50 per hour for the package ($11.25 per guest, 250 guests)');
});

test('no rate, no line: a class, a proposal with no package, or a payload from before the field existed', () => {
  const none = render(<ProposalPricingBreakdown {...base} proposal={{ ...proposal, additional_time: null }} settling={false} />);
  expect(none.container.textContent).not.toMatch(ADDED_TIME);
  const old = render(<ProposalPricingBreakdown {...base} settling={false} />);
  expect(old.container.textContent).not.toMatch(ADDED_TIME);
});

test('the line still shows while a payment is settling: it is not a figure the webhook writes', () => {
  const p = { ...proposal, guest_count: 100, additional_time: { hourly: 575, per_guest_rate: 5.75, billed_guests: 100 } };
  const { container } = render(<ProposalPricingBreakdown {...base} proposal={p} settling />);
  expect(container.textContent).toMatch(ADDED_TIME);
});

test('a proposal signed under v3 does not show the line: v3 Section 8.1 states its own rate', () => {
  const p = {
    ...proposal, guest_count: 100, client_signature_document_version: 'event-services-agreement-v3',
    additional_time: { hourly: 575, per_guest_rate: 5.75, billed_guests: 100 },
  };
  const { container } = render(<ProposalPricingBreakdown {...base} proposal={p} settling={false} />);
  expect(container.textContent).not.toMatch(ADDED_TIME);
});

test('the current Section 8.1 points at the Event-Specific Agreement for the hosted rate', () => {
  const { container } = render(<ProposalPricingBreakdown {...base} settling={false} />);
  expect(container.textContent).toMatch(/per-guest extra-hour rate, as stated in the Event-Specific Agreement, applied to the guest count/);
});

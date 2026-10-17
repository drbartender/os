import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import PrescriptionTab from './PrescriptionTab';
import { mapDetailToFocus } from '../constants';
import api from '../../../../utils/api';

// PrescriptionTab can reuse a detail fetched by PortalHome (passed as
// proposalDetail) OR fetch its own. The load-bearing guard: it must reuse the
// prop ONLY when proposalDetail.token === focus.token, else it would render a
// previously-viewed event's price rows / payments / signature under this event's
// totals (the stale-detail bug Codex flagged).
jest.mock('../../../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('@sentry/react', () => ({ captureException: jest.fn() }));
jest.mock('../ShareButton', () => () => <div data-testid="share-button" />);

const focusA = { token: 'tok-A', total_price: 100, amount_paid: 0, balance_due: 100, booked: false };
const focusB = { token: 'tok-B', total_price: 200, amount_paid: 0, balance_due: 200, booked: false };
const detailA = {
  token: 'tok-A', package_name: 'Package A', package_includes: ['Bar setup'],
  addons: [], payments: [], client_signed_at: null,
};
const detailB = {
  token: 'tok-B', package_name: 'Package B', package_includes: [],
  addons: [], payments: [], client_signed_at: null,
};

beforeEach(() => { jest.clearAllMocks(); localStorage.clear(); });

test('reuses a token-matching proposalDetail without refetching', async () => {
  render(<PrescriptionTab focus={focusA} proposalDetail={detailA} />);
  expect(await screen.findByText('Package A')).toBeInTheDocument();
  // The change-request banner fetch always fires on mount; the guard under
  // test is that the proposal DETAIL endpoint is not refetched.
  expect(api.get).not.toHaveBeenCalledWith('/client-portal/proposals/tok-A', expect.anything());
});

test('ignores a token-MISMATCHED proposalDetail and fetches the focus token instead', async () => {
  api.get.mockResolvedValue({ data: { proposal: detailB } });
  // focus is B but the stale prop is A's detail — must NOT render A.
  render(<PrescriptionTab focus={focusB} proposalDetail={detailA} />);
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/client-portal/proposals/tok-B', expect.anything()));
  expect(await screen.findByText('Package B')).toBeInTheDocument();
  expect(screen.queryByText('Package A')).not.toBeInTheDocument();
});

test('fetches its own detail when no proposalDetail is provided (home.focus path)', async () => {
  api.get.mockResolvedValue({ data: { proposal: detailB } });
  render(<PrescriptionTab focus={focusB} />);
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/client-portal/proposals/tok-B', expect.anything()));
  expect(await screen.findByText('Package B')).toBeInTheDocument();
});

test('interpolates {bartenders}/{hours} tokens from the portal detail columns', async () => {
  const detailTokens = {
    token: 'tok-A', package_name: 'Package A',
    package_includes: ['{bartenders} professional bartender{bartenders_s}', '{hours} hours of service'],
    num_bartenders: 2, event_duration_hours: 4,
    addons: [], payments: [], client_signed_at: null,
  };
  render(<PrescriptionTab focus={focusA} proposalDetail={detailTokens} />);
  expect(await screen.findByText('2 professional bartenders')).toBeInTheDocument();
  expect(screen.getByText('4 hours of service')).toBeInTheDocument();
  expect(screen.queryByText(/\{bartenders\}/)).not.toBeInTheDocument();
});

// An archived proposal still LOADS in the portal (the archive drill-down is
// meant to show past events), but /proposal/:token 404s for one
// (publicToken.js filters `status <> 'archived'`), so every CTA pointing there
// is a dead end: Review & book, the Pay balance fallback when the sweep has
// voided the invoice, and Share. Found 2026-08-25.
const focusPast = {
  token: 'tok-P', status: 'archived', past: true, booked: false,
  total_price: 500, amount_paid: 500, balance_due: 0,
};
const detailPast = {
  token: 'tok-P', package_name: 'Package P', package_includes: [],
  addons: [], payments: [], client_signed_at: null,
};

test('a past event says so and offers no dead CTA', async () => {
  render(<PrescriptionTab focus={focusPast} proposalDetail={detailPast} />);
  expect(await screen.findByText('Package P')).toBeInTheDocument();
  expect(screen.getByText(/This event has passed/i)).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Review & book/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Pay balance/i })).not.toBeInTheDocument();
  expect(screen.queryByTestId('share-button')).not.toBeInTheDocument();
});

test('a past event with an outstanding balance still offers no dead Pay CTA', async () => {
  render(<PrescriptionTab focus={{ ...focusPast, amount_paid: 250, balance_due: 250 }} proposalDetail={detailPast} />);
  expect(await screen.findByText('Package P')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Pay balance/i })).not.toBeInTheDocument();
  expect(screen.getByText(/This event has passed/i)).toBeInTheDocument();
});

test('a LIVE unbooked proposal still offers Review & book and Share', async () => {
  render(<PrescriptionTab focus={focusA} proposalDetail={detailA} />);
  expect(await screen.findByText('Package A')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Review & book/i })).toBeInTheDocument();
  expect(screen.getByTestId('share-button')).toBeInTheDocument();
  expect(screen.queryByText(/This event has passed/i)).not.toBeInTheDocument();
});

// The tab's money (spec 2026-10-16 section 4.4): the server's rows (the portal
// detail route builds them with server/utils/clientPriceLines.js, hidden lines
// already folded), then one Gratuity row, so rows plus gratuity equal the
// Total. The Total stays focus.total_price, which reads total_price only.
const priceRows = [
  { key: 'package', label: 'Package R', amount: 476.55 },
  { key: 'bar-rental', label: 'Bar Rental', amount: 50 },
  { key: 'addon-0', label: 'Add-on R', amount: 99.77 },
  { key: 'adjustment-0', label: 'Shown discount R', amount: -25 },
];
// 476.55 + 50 + 99.77 - 25 = 601.32 of service, plus an 80 gratuity = 681.32.
const detailRows = {
  token: 'tok-R', status: 'deposit_paid', package_name: 'Package R', package_includes: [],
  price_rows: priceRows, gratuity_amount: 80, total_price: '681.32', amount_paid: '100.00',
  addons: [{ id: 1, addon_name: 'Stale add-on R', line_total: 999 }], payments: [], client_signed_at: null,
};
const focusRows = { token: 'tok-R', status: 'deposit_paid', total_price: 681.32, amount_paid: 100, balance_due: 581.32, booked: true };

const toCents = (text) => Math.round(Number(text.replace(/[$,]/g, '')) * 100);
const pricingAmounts = () => within(screen.getByRole('region', { name: 'Pricing' }))
  .getAllByText(/\$/).map((el) => el.textContent);

test('draws the server rows then a Gratuity row, and they add up to the Total', async () => {
  render(<PrescriptionTab focus={focusRows} proposalDetail={detailRows} />);
  const pricing = await screen.findByRole('region', { name: 'Pricing' });
  for (const label of ['Package R', 'Bar Rental', 'Add-on R', 'Shown discount R', 'Gratuity']) {
    expect(within(pricing).getByText(label)).toBeInTheDocument();
  }
  const amounts = pricingAmounts();
  expect(amounts).toEqual(['$476.55', '$50.00', '$99.77', '-$25.00', '$80.00']);
  expect(screen.getByText('Total')).toBeInTheDocument();
  expect(screen.getByText('$681.32')).toBeInTheDocument();
  expect(amounts.reduce((s, a) => s + toCents(a), 0)).toBe(toCents('$681.32'));
  // The add-ons-only list is gone: the server rows replace it.
  expect(screen.queryByRole('heading', { name: 'Add-ons' })).not.toBeInTheDocument();
  expect(screen.queryByText('Stale add-on R')).not.toBeInTheDocument();
});

test('no Gratuity row when there is no gratuity; the rows alone equal the Total', async () => {
  const detail = { ...detailRows, gratuity_amount: 0, total_price: '601.32' };
  const focus = { ...focusRows, total_price: 601.32, balance_due: 501.32 };
  render(<PrescriptionTab focus={focus} proposalDetail={detail} />);
  const pricing = await screen.findByRole('region', { name: 'Pricing' });
  expect(within(pricing).queryByText('Gratuity')).not.toBeInTheDocument();
  expect(pricingAmounts().reduce((s, a) => s + toCents(a), 0)).toBe(toCents('$601.32'));
  expect(screen.getByText('$601.32')).toBeInTheDocument();
});

test('no rows (no priced snapshot): no Pricing block and no lone Gratuity row; the Total still shows', async () => {
  const detail = { ...detailRows, price_rows: [], gratuity_amount: 80, total_price: '500.00' };
  const focus = { ...focusRows, total_price: 500, balance_due: 400 };
  render(<PrescriptionTab focus={focus} proposalDetail={detail} />);
  expect(await screen.findByText('Package R')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Pricing' })).not.toBeInTheDocument();
  expect(screen.queryByText('Gratuity')).not.toBeInTheDocument();
  expect(screen.getByText('$500.00')).toBeInTheDocument();
});

test('a drill-down focus reads total_price, never an override, so the rows add up to its Total', async () => {
  // A detail from a server mid-deploy can still carry the override (the
  // service figure, gratuity left out). The tab's Total must be total_price.
  const detail = { ...detailRows, total_price_override: '601.32' };
  const focus = mapDetailToFocus(detail);
  expect(focus.total_price).toBe(681.32);
  expect(focus.balance_due).toBeCloseTo(581.32, 2);
  render(<PrescriptionTab focus={focus} proposalDetail={detail} />);
  await screen.findByRole('region', { name: 'Pricing' });
  expect(screen.getByText('$681.32')).toBeInTheDocument();
  expect(screen.getByText('$581.32')).toBeInTheDocument();
  expect(pricingAmounts().reduce((s, a) => s + toCents(a), 0)).toBe(toCents('$681.32'));
});

test('row labels read as the proposal page reads them: a canonical gratuity label resolves', async () => {
  // The page passes every row label through resolveGratuityDisplayLabel; a
  // visible line named exactly "Shared Gratuity" reads "Staffing Gratuity".
  const detail = { ...detailRows, price_rows: [...priceRows.slice(0, 3), { key: 'adjustment-0', label: 'Shared Gratuity', amount: 25 }] };
  render(<PrescriptionTab focus={focusRows} proposalDetail={detail} />);
  const pricing = await screen.findByRole('region', { name: 'Pricing' });
  expect(within(pricing).getByText('Staffing Gratuity')).toBeInTheDocument();
  expect(within(pricing).queryByText('Shared Gratuity')).not.toBeInTheDocument();
  expect(within(pricing).getByText('Package R')).toBeInTheDocument();
});

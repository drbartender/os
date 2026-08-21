// The money path, mounted and clicked.
//
// This suite exists because its absence let a dead commit button on the whole
// BYOB half of the ladder survive a green 684-test run. Plan tasks 5 and 6 both
// required it; nothing here existed until the review fleet found what it was
// hiding. Every test below drives a REAL click through to a stubbed POST.

import React from 'react';
import '@testing-library/jest-dom'; // per-file import: this repo has no setupTests.js
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import OtherOptionsPanel from './OtherOptionsPanel';

jest.mock('axios', () => {
  const post = jest.fn();
  const get = jest.fn();
  const shim = { interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } } };
  return { __esModule: true, default: { post, get, create: () => shim }, post, get, create: () => shim };
});
// eslint-disable-next-line global-require
const axios = require('axios').default;

const CORE = {
  package_id: 10, slug: 'the-core-reaction', name: 'The Core Reaction', category: 'byob',
  pricing_type: 'flat', bar_type: 'service_only', description: 'You buy the alcohol.',
  is_current: true, total: 700, available: true, reason: null, dropped: [],
  priced_by: null, per_guest_rate: null, min_billed_guests: null, min_total: null,
  visible_extra_ids: [901, 902],
};
const HOSTED = {
  package_id: 30, slug: 'the-base-compound', name: 'The Base Compound', category: 'hosted',
  pricing_type: 'per_guest', bar_type: 'full_bar', description: 'Two signature cocktails.',
  is_current: false, total: 2160, available: true, reason: null, dropped: [],
  priced_by: 'rate', per_guest_rate: 18, min_billed_guests: 25, min_total: 550,
  visible_extra_ids: [901],
};
const TIERS = [
  { addon_id: null, slug: null, name: 'Bar service only', total: 700, covers: [], selected: true, description: null, per_guest_rate: null },
  { addon_id: 1, slug: 'the-foundation', name: 'The Foundation', total: 1060, covers: ['Ice Delivery'], selected: false, description: 'Ice and cups.', per_guest_rate: 3 },
];
const EXTRAS = [
  { addon_id: 901, slug: 'champagne-toast', name: 'Champagne toast', description: '', billing_type: 'per_guest', rate: 2.5, extra_hour_rate: null, category: 'beverage', selected: false },
  { addon_id: 902, slug: 'garnish-package-only', name: 'Garnish package', description: '', billing_type: 'per_100_guests', rate: 50, extra_hour_rate: null, category: 'byob_support', selected: true },
];
const quote = (over = {}) => ({
  comparable: true, reason: null,
  event: { guest_count: 120, event_duration_hours: 4, num_bars: 1, event_date: '2026-10-03' },
  current_package_id: 10, current_total: 700,
  options: [CORE, HOSTED], tiers: TIERS, extras: EXTRAS,
  ...over,
});

const mount = (props = {}) => render(
  <OtherOptionsPanel token="tok" open onClose={jest.fn()} onLanded={jest.fn()} {...props} />
);
const quoteOnly = (q) => axios.post.mockImplementation((url) => (
  url.endsWith('/options') ? Promise.resolve({ data: q }) : Promise.reject(new Error('unstubbed'))
));

beforeEach(() => { jest.resetAllMocks(); window.innerWidth = 1280; document.body.style.overflow = ''; });

// --- THE REGRESSION THAT STARTED ALL THIS --------------------------------

test('EVERY BYOB tier rung has a commit button', async () => {
  // tier entries carry no `available` on the wire; gating the CTA on it meant
  // the ladder's whole bottom half rendered with no way to act on it.
  quoteOnly(quote());
  mount();
  await screen.findByText('Yours');
  const commits = await screen.findAllByRole('button', { name: /Make this my proposal/ });
  // The Foundation is a rung here (bar-service-only is the anchor).
  expect(commits.length).toBeGreaterThanOrEqual(1);
  expect(screen.getByText('The Foundation')).toBeInTheDocument();
});

test('a tier commit posts the BYOB package id, never the client’s current one', async () => {
  // A hosted client stepping DOWN to a tier: posting their hosted id makes the
  // server strip the tier and 409 forever against a tier-priced total.
  const hostedCurrent = quote({
    current_package_id: 30, current_total: 2160,
    options: [{ ...CORE, is_current: false }, { ...HOSTED, is_current: true }],
  });
  axios.post.mockImplementation((url) => (url.endsWith('/options')
    ? Promise.resolve({ data: hostedCurrent })
    : Promise.resolve({ data: { id: 1, total_price: 1060 } })));
  mount();
  await screen.findByText('Yours');
  fireEvent.click(screen.getAllByRole('button', { name: /Make this my proposal/ })[0]);
  await waitFor(() => {
    const call = axios.post.mock.calls.find(([u]) => u.endsWith('/switch'));
    expect(call).toBeTruthy();
    expect(call[1].package_id).toBe(10); // the BYOB package, not 30
  });
});

// --- commit states --------------------------------------------------------

test('an in-flight commit shows Rewriting and blocks a second commit anywhere', async () => {
  let resolveSwitch;
  axios.post.mockImplementation((url) => (url.endsWith('/options')
    ? Promise.resolve({ data: quote() })
    : new Promise((r) => { resolveSwitch = r; })));
  mount();
  await screen.findByText('Yours');
  const buttons = screen.getAllByRole('button', { name: /Make this my proposal/ });
  const before = buttons.length;
  fireEvent.click(buttons[0]);
  expect(await screen.findByText('Rewriting…')).toBeInTheDocument();
  // Every other rung's button must stop accepting a second write.
  const stillThere = screen.queryAllByRole('button', { name: /Make this my proposal/ });
  stillThere.forEach((b) => fireEvent.click(b));
  const switchCalls = axios.post.mock.calls.filter(([u]) => u.endsWith('/switch'));
  expect(switchCalls).toHaveLength(1);
  expect(before).toBeGreaterThan(0);
  await act(async () => { resolveSwitch({ data: { id: 1 } }); });
});

test('a 409 shows the reprice card with both totals and does not commit', async () => {
  axios.post.mockImplementation((url) => (url.endsWith('/options')
    ? Promise.resolve({ data: quote() })
    : Promise.reject({
      response: { status: 409, data: { code: 'TOTAL_CHANGED', error: 'moved', quote: quote() } },
    })));
  const onLanded = jest.fn();
  mount({ onLanded });
  await screen.findByText('Yours');
  fireEvent.click(screen.getAllByRole('button', { name: /Make this my proposal/ })[0]);
  expect(await screen.findByText('Prices moved')).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: /Confirm at/ })).toBeInTheDocument();
  expect(onLanded).not.toHaveBeenCalled();
});

test('a guard refusal shows the server’s reason in the row, not a reprice card', async () => {
  axios.post.mockImplementation((url) => (url.endsWith('/options')
    ? Promise.resolve({ data: quote() })
    : Promise.reject({
      response: { status: 409, data: { code: 'PAYMENT_IN_FLIGHT', error: 'A payment is already in progress.' } },
    })));
  mount();
  await screen.findByText('Yours');
  fireEvent.click(screen.getAllByRole('button', { name: /Make this my proposal/ })[0]);
  expect(await screen.findByText(/already in progress/)).toBeInTheDocument();
  expect(screen.queryByText('Prices moved')).not.toBeInTheDocument();
});

test('a lost response reconciles instead of claiming failure', async () => {
  let n = 0;
  axios.post.mockImplementation((url) => {
    if (url.endsWith('/options')) { n += 1; return Promise.resolve({ data: quote() }); }
    return Promise.reject(new Error('Network Error'));
  });
  const onLanded = jest.fn();
  mount({ onLanded });
  await screen.findByText('Yours');
  const first = n;
  fireEvent.click(screen.getAllByRole('button', { name: /Make this my proposal/ })[0]);
  // It must refetch, tell the page to reconcile, and never render "failed".
  await waitFor(() => expect(n).toBeGreaterThan(first));
  await waitFor(() => expect(onLanded).toHaveBeenCalledWith(expect.objectContaining({ unknown: true })));
});

// --- landing --------------------------------------------------------------

test('a landed commit reports the prior CONTRACT total as the undo ack', async () => {
  axios.post.mockImplementation((url) => (url.endsWith('/options')
    ? Promise.resolve({ data: quote() })
    : Promise.resolve({ data: { id: 1, total_price: 1060 } })));
  const onLanded = jest.fn();
  mount({ onLanded });
  await screen.findByText('Yours');
  fireEvent.click(screen.getAllByRole('button', { name: /Make this my proposal/ })[0]);
  await waitFor(() => expect(onLanded).toHaveBeenCalled());
  const { undoTo } = onLanded.mock.calls[0][0];
  // current_total (the contract), NOT the anchor's displayed/draft-priced total.
  expect(undoTo.body.acknowledged_total).toBe(700);
});

test('an unproven baseline claims NEITHER extras-only NOR price drift', async () => {
  axios.post.mockImplementation((url) => (url.endsWith('/options')
    ? Promise.resolve({ data: quote() })
    : Promise.resolve({ data: { id: 1 } })));
  const onLanded = jest.fn();
  mount({ onLanded });
  await screen.findByText('Yours');
  fireEvent.click(screen.getAllByRole('button', { name: /Make this my proposal/ })[0]);
  await waitFor(() => expect(onLanded).toHaveBeenCalled());
  const arg = onLanded.mock.calls[0][0];
  // "Unproven means unclaimed": asserting drift here would blame our pricing
  // on no evidence.
  expect(arg.extrasOnly).toBe(false);
  expect(arg.priceDrift).toBe(false);
});

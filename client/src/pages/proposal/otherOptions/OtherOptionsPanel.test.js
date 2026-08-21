// The drawer's behaviour, mounted. Owns the spec's client test list for the
// things only a rendered component can show: draft isolation, the anchor's
// dirty flow, the commit states, and the drawer chrome's two treatments.
//
// The pure halves live next door and are NOT repeated here: ladder.test.js owns
// assembly and the sublines, extrasScope.test.js owns the bundle-twin parity and
// the three blocked strings, switchApi.test.js owns the error taxonomy.

import React from 'react';
import '@testing-library/jest-dom'; // per-file import: this repo has no setupTests.js
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import OtherOptionsPanel from './OtherOptionsPanel';

jest.mock('axios', () => {
  const post = jest.fn();
  const shim = { interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } } };
  return { __esModule: true, default: { post, create: () => shim }, post, create: () => shim };
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
  { addon_id: 1, slug: 'the-foundation', name: 'The Foundation', total: 1060, covers: [], selected: false, description: 'Ice and cups.', per_guest_rate: 3 },
];
const EXTRAS = [
  { addon_id: 901, slug: 'champagne-toast', name: 'Champagne toast', description: '', billing_type: 'per_guest', rate: 2.5, extra_hour_rate: null, category: 'beverage', selected: false },
  { addon_id: 902, slug: 'garnish-package-only', name: 'Garnish package', description: '', billing_type: 'per_100_guests', rate: 50, extra_hour_rate: null, category: 'byob_support', selected: true },
];
const quote = (over = {}) => ({
  comparable: true,
  reason: null,
  event: { guest_count: 120, event_duration_hours: 4, num_bars: 1, event_date: '2026-10-03' },
  current_package_id: 10,
  current_total: 700,
  options: [CORE, HOSTED],
  tiers: TIERS,
  extras: EXTRAS,
  ...over,
});

const mount = (props = {}) => render(
  <OtherOptionsPanel token="tok" open onClose={jest.fn()} onLanded={jest.fn()} {...props} />
);

beforeEach(() => {
  jest.resetAllMocks();
  window.innerWidth = 1280;
  document.body.style.overflow = '';
});

// --- chrome -----------------------------------------------------------------

test('renders as a dialog with the locked header copy', async () => {
  axios.post.mockResolvedValue({ data: quote() });
  mount();
  await screen.findByRole('dialog');
  expect(screen.getByText(/Your proposal · a second look/)).toBeInTheDocument();
  expect(screen.getByText(/How much should/)).toBeInTheDocument();
  expect(screen.getByText(/\$2 million liquor liability insurance/)).toBeInTheDocument();
});

test('the event line names guests, hours and bars, and never staffing', async () => {
  axios.post.mockResolvedValue({ data: quote() });
  mount();
  // Wait for DATA, not just the dialog: the chrome renders during loading, and
  // the event line is deliberately absent until the quote lands.
  await screen.findByText('Yours');
  // Two JSX text nodes, so query the element rather than the string.
  const line = document.querySelector('.oo-event');
  expect(line.textContent).toMatch(/120 guests/);
  expect(line.textContent).toMatch(/4 hours/);
  expect(line.textContent).toMatch(/1 bar/);
  // A package with a different ratio WOULD re-derive the crew, so promising the
  // staffing held still would be a lie the copy must never tell.
  expect(line.textContent).not.toMatch(/bartender/i);
});

test('desktop gets a side panel and does NOT lock the page or dim it', async () => {
  axios.post.mockResolvedValue({ data: quote() });
  mount();
  const d = await screen.findByRole('dialog');
  expect(d.className).toMatch(/oo-drawer-panel/);
  // The proposal beside it must stay scrollable and readable: that is the whole
  // reason the drawer replaced a bottom-of-page panel.
  expect(document.body.style.overflow).toBe('');
  expect(document.querySelector('.oo-backdrop')).toBeNull();
});

test('mobile gets a bottom sheet, a drag handle, a backdrop and a scroll lock', async () => {
  window.innerWidth = 390;
  axios.post.mockResolvedValue({ data: quote() });
  mount();
  const d = await screen.findByRole('dialog');
  expect(d.className).toMatch(/oo-drawer-sheet/);
  expect(document.querySelector('.oo-grab')).not.toBeNull();
  expect(document.querySelector('.oo-backdrop')).not.toBeNull();
  await waitFor(() => expect(document.body.style.overflow).toBe('hidden'));
});

test('Escape closes', async () => {
  axios.post.mockResolvedValue({ data: quote() });
  const onClose = jest.fn();
  mount({ onClose });
  await screen.findByRole('dialog');
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
  expect(onClose).toHaveBeenCalled();
});

test('closed renders nothing at all', () => {
  axios.post.mockResolvedValue({ data: quote() });
  const { container } = render(
    <OtherOptionsPanel token="tok" open={false} onClose={jest.fn()} onLanded={jest.fn()} />
  );
  expect(container).toBeEmptyDOMElement();
});

// --- the ladder in the DOM --------------------------------------------------

test('the anchor is the rung they stand on, and it is not repeated below', async () => {
  axios.post.mockResolvedValue({ data: quote() });
  mount();
  await screen.findByText('Yours');
  // BYOB with no tier: the anchor IS bar-service-only, so it must not also
  // appear as something to switch to.
  expect(screen.getAllByText('Bar service only')).toHaveLength(1);
});

test('a BYOB client opens collapsed, behind one line into the hosted half', async () => {
  axios.post.mockResolvedValue({ data: quote() });
  mount();
  expect(await screen.findByText(/Let us stock the whole bar/)).toBeInTheDocument();
  expect(screen.queryByText('The Base Compound')).not.toBeInTheDocument();
});

test('first-load failure offers a retry rather than an empty drawer', async () => {
  axios.post.mockRejectedValue(new Error('boom'));
  mount();
  expect(await screen.findByRole('button', { name: /Try again/ })).toBeInTheDocument();
});

test('a non-comparable proposal says why instead of rendering a blank ladder', async () => {
  axios.post.mockResolvedValue({ data: quote({ comparable: false, reason: 'custom_pricing' }) });
  mount();
  expect(await screen.findByText(/priced specially for you/)).toBeInTheDocument();
});

// --- draft isolation --------------------------------------------------------

test('committed extras start ON, and the strip scopes to the anchor', async () => {
  axios.post.mockResolvedValue({ data: quote() });
  mount();
  await screen.findByText('Yours');
  // The strip is collapsed by default, and its summary line names the drafted
  // extras, so expand before asserting on rows or the summary button matches.
  fireEvent.click(screen.getByText(/Extras · add to your package/));
  // The garnish package is the proposal's own (selected), so it must be a chip
  // and it must already read as on, not make the client re-find it.
  const garnish = await screen.findByRole('button', { name: /Garnish package/ });
  expect(garnish.getAttribute('aria-pressed')).toBe('true');
  // Champagne toast is curated-popular, so it is a chip too, but off.
  expect(screen.getByRole('button', { name: /Champagne toast/ }).getAttribute('aria-pressed')).toBe('false');
});

test('the anchor stays clean until the draft actually differs', async () => {
  axios.post.mockResolvedValue({ data: quote() });
  mount();
  await screen.findByText('Yours');
  // Nothing toggled yet: dirty is set inequality against the committed
  // baseline, so an untouched drawer must not offer to rewrite anything.
  expect(screen.queryByText(/not on your proposal yet/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Add these to my proposal/ })).not.toBeInTheDocument();
});

// ConnectClaude: the consent page's states, the one-call Allow, the passkey refusals and Cancel.
import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
const mockStart = jest.fn();
jest.mock('@simplewebauthn/browser', () => ({ startAuthentication: (...a) => mockStart(...a) }));
const mockSupported = jest.fn(() => true);
jest.mock('../../utils/webauthnClient', () => ({ isPasskeySupported: () => mockSupported() }));

// eslint-disable-next-line import/first
import ConnectClaude from './ConnectClaude';

const ID = 'abcdef12-3456-4789-8abc-def012345678';
const RETURN = 'https://claude.example.com/callback?code=drbc_ac_madeupcode&state=madeupstate';
const CANCEL_RETURN = 'https://claude.example.com/callback?error=access_denied&state=madeupstate';
const REQUEST = {
  request: {
    id: ID,
    status: 'pending',
    client_name: 'Claude',
    redirect_host: 'claude.example.com',
    requested_at: '2026-11-19T20:05:00.000Z',
    // Always ahead of the real clock, so the page's expiry timer stays quiet.
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    caller_address: '192.0.2.10',
    user_agent: 'Mozilla/5.0 (made up test agent)',
    reads: ['Upcoming events and their staffing', 'Bookings with an open balance'],
  },
  existing_connection: null,
};
const OPTIONS = { challenge: 'made-up-challenge', allowCredentials: [] };
const ASSERTION = { id: 'made-up-credential', response: {} };

const realLocation = window.location;
const assign = jest.fn();
beforeAll(() => {
  delete window.location;
  window.location = { ...realLocation, assign };
});
afterAll(() => { window.location = realLocation; });

function renderAt(url = `/connect-claude?request=${ID}`) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/connect-claude" element={<ConnectClaude />} />
      </Routes>
    </MemoryRouter>
  );
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function routeApi({ get = () => Promise.resolve({ data: REQUEST }), approve, cancel, options } = {}) {
  api.get.mockImplementation((url) => {
    if (url === `/admin/connector/requests/${ID}`) return get();
    return Promise.reject({ status: 404 });
  });
  api.post.mockImplementation((url) => {
    if (url === '/admin/connector/assert-options') return options ? options() : Promise.resolve({ data: OPTIONS });
    if (url === `/admin/connector/requests/${ID}/approve`) {
      return approve ? approve() : Promise.resolve({ data: { redirect_url: RETURN, replaced: false } });
    }
    if (url === `/admin/connector/requests/${ID}/cancel`) {
      return cancel ? cancel() : Promise.resolve({ data: { redirect_url: CANCEL_RETURN } });
    }
    return Promise.reject({ status: 404 });
  });
}

function approveCalls() {
  return api.post.mock.calls.filter(([url]) => url.endsWith('/approve'));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSupported.mockReturnValue(true);
  mockStart.mockResolvedValue(ASSERTION);
});

test('loading, then the request: what Claude reads, when and from where it started', async () => {
  const load = deferred();
  routeApi({ get: () => load.promise });
  renderAt();
  expect(screen.getByRole('status')).toHaveTextContent(/loading/i);
  await act(async () => { load.resolve({ data: REQUEST }); });
  expect(screen.getByRole('heading', { name: /allow claude to read your business/i })).toBeInTheDocument();
  expect(screen.getByText('Upcoming events and their staffing')).toBeInTheDocument();
  expect(screen.getByText('Bookings with an open balance')).toBeInTheDocument();
  expect(screen.getByText('192.0.2.10')).toBeInTheDocument();
  expect(screen.getByText('Mozilla/5.0 (made up test agent)')).toBeInTheDocument();
  expect(screen.getByText('claude.example.com')).toBeInTheDocument();
  // 20:05 UTC is 2:05 PM in Chicago in November.
  expect(screen.getByText(/Thu Nov 19, 2:05 PM/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled();
  expect(screen.queryByRole('note')).not.toBeInTheDocument();
  expect(api.get).toHaveBeenCalledWith(`/admin/connector/requests/${ID}`);
});

test('an existing connection: the page says approving replaces it', async () => {
  routeApi({
    get: () => Promise.resolve({
      data: { ...REQUEST, existing_connection: { id: 41, state: 'live', approved_at: '2026-11-01T15:00:00.000Z' } },
    }),
  });
  renderAt();
  const note = await screen.findByRole('note');
  expect(note).toHaveTextContent(/already have a Claude connection/);
  expect(note).toHaveTextContent(/replaces it/);
});

test.each([
  ['CONNECTOR_REQUEST_USED', 410, /already used/],
  ['CONNECTOR_REQUEST_CANCELLED', 410, /was cancelled/],
  ['CONNECTOR_REQUEST_EXPIRED', 410, /has expired/],
  ['CONNECTOR_REQUEST_NOT_FOUND', 404, /not found/],
  [undefined, 404, /not found/],
])('an invalid request (%s, %i) shows the error state with no Allow', async (code, status, title) => {
  routeApi({ get: () => Promise.reject({ code, status, message: 'x' }) });
  renderAt();
  expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
});

test.each([
  ['no request id', '/connect-claude'],
  ['a malformed id', '/connect-claude?request=not-a-uuid'],
])('%s: the error state, and the server is never asked', (label, url) => {
  routeApi();
  renderAt(url);
  expect(screen.getByRole('heading', { name: /not complete/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
  expect(api.get).not.toHaveBeenCalled();
});

test('a load that fails for another reason offers Try again, which reloads', async () => {
  let n = 0;
  routeApi({ get: () => (n++ === 0 ? Promise.reject({ status: 0, code: 'NETWORK_ERROR' }) : Promise.resolve({ data: REQUEST })) });
  renderAt();
  fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('button', { name: 'Allow' })).toBeInTheDocument();
});

test('Allow: the passkey, then approve with only the assertion, then the browser goes to the return address', async () => {
  routeApi();
  renderAt();
  fireEvent.click(await screen.findByRole('button', { name: 'Allow' }));
  await waitFor(() => expect(assign).toHaveBeenCalledWith(RETURN));
  expect(mockStart).toHaveBeenCalledWith({ optionsJSON: OPTIONS });
  expect(api.post).toHaveBeenCalledWith('/admin/connector/assert-options');
  expect(approveCalls()).toEqual([[`/admin/connector/requests/${ID}/approve`, { assertion: ASSERTION }]]);
  expect(screen.getByRole('status')).toHaveTextContent(/returning you to claude/i);
});

test('Allow pending: both buttons disabled, and a double click sends one approve', async () => {
  const approve = deferred();
  routeApi({ approve: () => approve.promise });
  renderAt();
  const allow = await screen.findByRole('button', { name: 'Allow' });
  act(() => { allow.click(); allow.click(); });
  await waitFor(() => expect(approveCalls()).toHaveLength(1));
  expect(screen.getByRole('button', { name: /waiting for your passkey/i })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  act(() => { screen.getByRole('button', { name: /waiting for your passkey/i }).click(); });
  expect(api.post.mock.calls.filter(([u]) => u === '/admin/connector/assert-options')).toHaveLength(1);
  expect(mockStart).toHaveBeenCalledTimes(1);
  await act(async () => { approve.resolve({ data: { redirect_url: RETURN, replaced: false } }); });
  expect(assign).toHaveBeenCalledTimes(1);
  expect(approveCalls()).toHaveLength(1);
});

test('Allow with the passkey prompt closed approves nothing and leaves Allow to try again', async () => {
  routeApi();
  mockStart.mockRejectedValue(Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' }));
  renderAt();
  fireEvent.click(await screen.findByRole('button', { name: 'Allow' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/prompt was closed/);
  expect(approveCalls()).toHaveLength(0);
  expect(assign).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled();
});

test.each([
  ['CONNECTOR_PASSKEY_WRONG_ACCOUNT', 403, /admin account/],
  ['CONNECTOR_PASSKEY_FAILED', 403, /did not pass/],
  ['CONNECTOR_PASSKEY_EXPIRED', 400, /timed out/],
  ['CONNECTOR_PASSKEY_REQUIRED', 400, /passkey check is needed/],
  ['SOMETHING_ELSE', 409, /nothing was approved/],
  ['INTERNAL_ERROR', 500, /could not confirm whether this was approved/i],
  ['NETWORK_ERROR', 0, /could not confirm whether this was approved/i],
])('Allow failed (%s): a plain message, no navigation, Allow again', async (code, status, text) => {
  routeApi({ approve: () => Promise.reject({ code, status, message: 'server words' }) });
  renderAt();
  fireEvent.click(await screen.findByRole('button', { name: 'Allow' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(text);
  expect(assign).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled();
});

test('the wrong-account message names the admin account, since the owner also has a staff account', async () => {
  routeApi({ approve: () => Promise.reject({ code: 'CONNECTOR_PASSKEY_WRONG_ACCOUNT', status: 403 }) });
  renderAt();
  fireEvent.click(await screen.findByRole('button', { name: 'Allow' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/staff account/);
  expect(alert).toHaveTextContent(/passkey for your admin account/);
});

test('no passkey on the admin account (from assert-options): says passkeys are added on the phone, and never prompts', async () => {
  routeApi({ options: () => Promise.reject({ code: 'CONNECTOR_PASSKEY_NONE', status: 409 }) });
  renderAt();
  fireEvent.click(await screen.findByRole('button', { name: 'Allow' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/on the phone/);
  expect(alert).toHaveTextContent(/open More and choose Set up fingerprint unlock/);
  expect(alert).not.toHaveTextContent(/Settings/);
  expect(screen.queryByRole('link', { name: /settings/i })).not.toBeInTheDocument();
  expect(mockStart).not.toHaveBeenCalled();
  expect(approveCalls()).toHaveLength(0);
});

test('assert-options failing with a server error before any approve: nothing was approved', async () => {
  routeApi({ options: () => Promise.reject({ code: 'INTERNAL_ERROR', status: 500 }) });
  renderAt();
  fireEvent.click(await screen.findByRole('button', { name: 'Allow' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/nothing was approved/);
  expect(mockStart).not.toHaveBeenCalled();
});

test('before the prompt the request is read again; answered in another tab, it ends with no passkey prompt', async () => {
  let n = 0;
  routeApi({
    get: () => (n++ === 0 ? Promise.resolve({ data: REQUEST }) : Promise.reject({ code: 'CONNECTOR_REQUEST_USED', status: 410 })),
  });
  renderAt();
  fireEvent.click(await screen.findByRole('button', { name: 'Allow' }));
  expect(await screen.findByRole('heading', { name: /already used/ })).toBeInTheDocument();
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(mockStart).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
});

test('a fresh read answering a non-pending status ends the same way', async () => {
  let n = 0;
  routeApi({
    get: () => Promise.resolve({ data: n++ === 0 ? REQUEST : { ...REQUEST, request: { ...REQUEST.request, status: 'cancelled' } } }),
  });
  renderAt();
  fireEvent.click(await screen.findByRole('button', { name: 'Allow' }));
  expect(await screen.findByRole('heading', { name: /was cancelled/ })).toBeInTheDocument();
  expect(mockStart).not.toHaveBeenCalled();
});

test('when the clock reaches expires_at the page reads the request again and ends it on the server\'s 410', async () => {
  jest.useFakeTimers();
  try {
    const soon = { ...REQUEST, request: { ...REQUEST.request, expires_at: new Date(Date.now() + 5000).toISOString() } };
    let n = 0;
    routeApi({ get: () => (n++ === 0 ? Promise.resolve({ data: soon }) : Promise.reject({ code: 'CONNECTOR_REQUEST_EXPIRED', status: 410 })) });
    renderAt();
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled();
    await act(async () => { jest.advanceTimersByTime(4000); });
    expect(api.get).toHaveBeenCalledTimes(1);
    await act(async () => { jest.advanceTimersByTime(1001); });
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('heading', { name: /has expired/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
  } finally {
    jest.useRealTimers();
  }
});

test('loaded past expires_at by this device\'s clock: the server is asked again, and its 410 ends it with no prompt', async () => {
  const past = { ...REQUEST, request: { ...REQUEST.request, expires_at: new Date(Date.now() - 1000).toISOString() } };
  let n = 0;
  routeApi({ get: () => (n++ === 0 ? Promise.resolve({ data: past }) : Promise.reject({ code: 'CONNECTOR_REQUEST_EXPIRED', status: 410 })) });
  renderAt();
  expect(await screen.findByRole('heading', { name: /has expired/ })).toBeInTheDocument();
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(mockStart).not.toHaveBeenCalled();
});

test('a device clock running fast: the server still answers pending, so Allow stays and works', async () => {
  // This device thinks the request ended a minute ago; the server holds it pending.
  const fast = { ...REQUEST, request: { ...REQUEST.request, expires_at: new Date(Date.now() - 60 * 1000).toISOString() } };
  routeApi({ get: () => Promise.resolve({ data: fast }) });
  renderAt();
  const allow = await screen.findByRole('button', { name: 'Allow' });
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2)); // the scheduled re-read, answered pending
  expect(screen.queryByRole('heading', { name: /has expired/ })).not.toBeInTheDocument();
  expect(allow).toBeEnabled();
  fireEvent.click(allow);
  await waitFor(() => expect(assign).toHaveBeenCalledWith(RETURN));
  expect(mockStart).toHaveBeenCalledTimes(1);
  expect(approveCalls()).toHaveLength(1);
});

test('Allow on a request that was used meanwhile turns into the error state with no Allow', async () => {
  routeApi({ approve: () => Promise.reject({ code: 'CONNECTOR_REQUEST_USED', status: 410 }) });
  renderAt();
  fireEvent.click(await screen.findByRole('button', { name: 'Allow' }));
  expect(await screen.findByRole('heading', { name: /already used/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
});

test('a browser without passkeys cannot Allow, and says so', async () => {
  mockSupported.mockReturnValue(false);
  routeApi();
  renderAt();
  expect(await screen.findByRole('button', { name: 'Allow' })).toBeDisabled();
  expect(screen.getByText(/cannot use passkeys/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
});

test('Cancel calls cancel with no body and returns the browser to its redirect_url', async () => {
  routeApi();
  renderAt();
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(assign).toHaveBeenCalledWith(CANCEL_RETURN));
  expect(api.post).toHaveBeenCalledWith(`/admin/connector/requests/${ID}/cancel`);
  expect(mockStart).not.toHaveBeenCalled();
  expect(approveCalls()).toHaveLength(0);
});

test('Cancel on an expired request shows the error state', async () => {
  routeApi({ cancel: () => Promise.reject({ code: 'CONNECTOR_REQUEST_EXPIRED', status: 410 }) });
  renderAt();
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  expect(await screen.findByRole('heading', { name: /has expired/ })).toBeInTheDocument();
  expect(assign).not.toHaveBeenCalled();
});

test('no copy on the page carries an em dash', () => {
  // eslint-disable-next-line global-require
  const src = require('fs').readFileSync(require('path').join(__dirname, 'ConnectClaude.js'), 'utf8');
  expect(src).not.toContain('—');
});

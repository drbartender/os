// ClaudeConnection: the settings block's states, the call list, withheld rows and the in-page Disconnect.
import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import api from '../utils/api';

jest.mock('../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
const mockUseAuth = jest.fn();
jest.mock('../context/AuthContext', () => ({ useAuth: () => mockUseAuth() }));

// eslint-disable-next-line import/first
import ClaudeConnection, { STATE_TEXT, callLabel, recordWords } from './ClaudeConnection';

const STATUS_NONE = {
  connection: null,
  client_id: 'made-up-client-id',
  mcp_url: 'https://api.example.com/mcp',
  address_check: 'on',
};
const LIVE = {
  id: 50101,
  state: 'live',
  approved_at: '2026-11-18T15:00:00.000Z',
  connected_at: '2026-11-18T15:01:00.000Z',
  last_used_at: '2026-11-19T14:30:00.000Z',
  expires_at: '2027-05-17T15:00:00.000Z',
  lapses_at: '2026-12-19T14:30:00.000Z',
};
const NO_CALLS = { calls: [], has_more: false };
const CALLS = {
  calls: [
    { id: 9, called_at: '2026-11-19T14:30:00.000Z', caller_address: '192.0.2.20', method: 'tools/call', tool_name: 'upcoming_events', record_ids: [], outcome: 'ok' },
    { id: 8, called_at: '2026-11-19T14:29:00.000Z', caller_address: '192.0.2.20', method: 'tools/call', tool_name: 'client', record_ids: ['50201'], outcome: 'withheld', withheld_ref: 'made-up-ref' },
    { id: 7, called_at: '2026-11-19T14:28:00.000Z', caller_address: '198.51.100.7', method: 'tools/call', tool_name: null, record_ids: [], outcome: 'refused_address' },
    { id: 6, called_at: '2026-11-19T14:27:00.000Z', caller_address: '192.0.2.20', method: 'tools/call', tool_name: 'client', record_ids: ['50202', '50203', '50204', '50205', '50206'], outcome: 'refused_tripwire' },
  ],
  has_more: true,
};

function routeApi(status, calls = NO_CALLS) {
  api.get.mockImplementation((url) => {
    if (url === '/admin/connector/status') return status instanceof Error || status.status ? Promise.reject(status) : Promise.resolve({ data: status });
    if (url === '/admin/connector/calls') return Promise.resolve({ data: calls });
    return Promise.reject({ status: 404 });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUseAuth.mockReturnValue({ user: { id: 50001, role: 'admin' } });
});

test('no connection: says so and gives the address and client id to enter in Claude', async () => {
  routeApi(STATUS_NONE);
  render(<ClaudeConnection />);
  expect(await screen.findByText('Claude is not connected.')).toBeInTheDocument();
  expect(screen.getByText('https://api.example.com/mcp')).toBeInTheDocument();
  expect(screen.getByText('made-up-client-id')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
  expect(screen.getByText('No calls yet.')).toBeInTheDocument();
  expect(api.get).toHaveBeenCalledWith('/admin/connector/calls', { params: { limit: 20 } });
});

test('a live connection: its state, approved, connected and last used', async () => {
  routeApi({ ...STATUS_NONE, connection: LIVE });
  render(<ClaudeConnection />);
  expect(await screen.findByText('Connected.')).toBeInTheDocument();
  expect(screen.getByText('Approved').nextSibling).toHaveTextContent('Wed Nov 18, 9:00 AM');
  expect(screen.getByText('Connected').nextSibling).toHaveTextContent('Wed Nov 18, 9:01 AM');
  expect(screen.getByText('Last used').nextSibling).toHaveTextContent('Thu Nov 19, 8:30 AM');
  expect(screen.getByText('Lapses').nextSibling).toHaveTextContent('Sat Dec 19, 8:30 AM unless used before then');
  expect(screen.getByText('Ends').nextSibling).toHaveTextContent('Mon May 17, 10:00 AM');
  expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  expect(screen.queryByRole('note')).not.toBeInTheDocument();
});

test.each(Object.keys(STATE_TEXT).filter((s) => s !== 'live'))('a %s connection is named in plain words and can be disconnected', async (state) => {
  routeApi({ ...STATUS_NONE, connection: { ...LIVE, state } });
  render(<ClaudeConnection />);
  expect(await screen.findByText(`${STATE_TEXT[state][0]}.`)).toBeInTheDocument();
  expect(screen.getByText(STATE_TEXT[state][1])).toBeInTheDocument();
  expect(screen.queryByText('Lapses')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
});

test('a lapse that falls on the hard end is not worded "unless used": the end is shown alone', async () => {
  routeApi({ ...STATUS_NONE, connection: { ...LIVE, lapses_at: LIVE.expires_at } });
  render(<ClaudeConnection />);
  expect(await screen.findByText('Ends')).toBeInTheDocument();
  expect(screen.queryByText('Lapses')).not.toBeInTheDocument();
  expect(screen.queryByText(/unless used/)).not.toBeInTheDocument();
});

test('signed out says the sessions were reset, naming the three causes', () => {
  expect(STATE_TEXT.signed_out[1]).toMatch(/sessions were reset/);
  expect(STATE_TEXT.signed_out[1]).toMatch(/password reset, a passkey revoke or an email change/);
  expect(STATE_TEXT.no_longer_admin[1]).toMatch(/no longer an admin/);
});

test.each([
  ['off', /address check is off/],
  ['unreadable', /cannot be read/],
])('the address check, when %s, is shown', async (check, text) => {
  routeApi({ ...STATUS_NONE, address_check: check });
  render(<ClaudeConnection />);
  expect(await screen.findByRole('note')).toHaveTextContent(text);
});

test('the call list: tool calls, refusals named as such, a withheld row marked as text held back, and more not shown', async () => {
  routeApi({ ...STATUS_NONE, connection: LIVE }, CALLS);
  const { container } = render(<ClaudeConnection />);
  await screen.findByText('Recent calls');
  const rows = container.querySelectorAll('.claude-conn__row');
  expect(rows).toHaveLength(4);
  expect(within(rows[0]).getByText('Upcoming events')).toBeInTheDocument();
  expect(rows[0]).not.toHaveTextContent('upcoming_events');
  expect(within(rows[0]).getByText('Read')).toBeInTheDocument();
  expect(rows[0]).toHaveTextContent('from 192.0.2.20');

  expect(rows[1]).toHaveClass('claude-conn__row--withheld');
  expect(within(rows[1]).getByText('Text held back')).toBeInTheDocument();
  expect(rows[1]).toHaveTextContent('A piece of client-written text (a message, a name, a note or a contact field) was held back from Claude.');
  expect(within(rows[1]).getByText('Client details')).toBeInTheDocument();
  expect(within(rows[1]).getByText('Records: 50201')).toBeInTheDocument();

  expect(rows[2]).toHaveClass('claude-conn__row--refused');
  expect(within(rows[2]).getByText('Refused: unknown address')).toBeInTheDocument();
  expect(within(rows[2]).getByText('Used a tool')).toBeInTheDocument();
  expect(rows[2]).toHaveTextContent('from 198.51.100.7');

  expect(within(rows[3]).getByText('Refused: read limit reached for the hour')).toBeInTheDocument();
  expect(within(rows[3]).getByText('Records: 50202, 50203, 50204 and 2 more')).toBeInTheDocument();

  expect(screen.getByText('More not shown.')).toBeInTheDocument();
});

test('every tool name and method reads in plain words, and an unknown slug never shows raw', () => {
  expect(callLabel({ tool_name: 'waiting_on_you' })).toBe('Waiting on you');
  expect(callLabel({ tool_name: 'money_owed' })).toBe('Money owed');
  // The seven tools the server registers (server/utils/connector/tools/index.js), each in plain words.
  expect(['upcoming_events', 'search', 'client', 'proposal_or_event', 'thread'].map((name) => callLabel({ tool_name: name })))
    .toEqual(['Upcoming events', 'Search', 'Client details', 'Proposal or event details', 'Message thread']);
  expect(callLabel({ tool_name: 'some_new_tool' })).toBe('Some new tool');
  expect(callLabel({ tool_name: null, method: 'tools/list' })).toBe('Listed the tools');
  expect(callLabel({ tool_name: null, method: 'initialize' })).toBe('Started a session');
  expect(callLabel({ tool_name: null, method: 'resources/read' })).toBe('A protocol request');
  expect(callLabel({ tool_name: null, method: null })).toBe('A request');
});

test('a failed call-log read never hides the connection or Disconnect', async () => {
  api.get.mockImplementation((url) => (url === '/admin/connector/status'
    ? Promise.resolve({ data: { ...STATUS_NONE, connection: LIVE } })
    : Promise.reject({ status: 500, message: 'x' })));
  render(<ClaudeConnection />);
  expect(await screen.findByText('Could not load the recent calls. Try refreshing.')).toBeInTheDocument();
  expect(screen.getByText('Connected.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
});

test('focus moves to the confirm step when it opens, and back to Disconnect on Keep it', async () => {
  routeApi({ ...STATUS_NONE, connection: LIVE });
  render(<ClaudeConnection />);
  const ask = await screen.findByRole('button', { name: 'Disconnect' });
  expect(ask).not.toHaveFocus();
  fireEvent.click(ask);
  expect(screen.getByRole('group', { name: /confirm disconnect/i })).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
  expect(screen.getByRole('button', { name: 'Disconnect' })).toHaveFocus();
});

test('the block colors only through its skin-aware tokens, never the fixed parchment ones', () => {
  // eslint-disable-next-line global-require
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'pages', 'admin', 'ConnectClaude.css'), 'utf8');
  const block = css.slice(css.indexOf('.claude-conn {'));
  const rules = block.match(/(?:^|\n)\s*(?:color|border|border-bottom|border-top|outline)\s*:[^;]*;/g) || [];
  expect(rules.length).toBeGreaterThan(10);
  rules.forEach((r) => expect(r).toMatch(/var\(--cc-[a-z]+\)/));
  expect(block).toMatch(/html\[data-app="admin-os"\] \.claude-conn \{[^}]*--cc-muted: var\(--ink-3\)/);
  expect(block).toMatch(/html\[data-app="admin-os"\]\[data-skin="light"\] \.claude-conn \{[^}]*--cc-muted: var\(--ink-2\)/);
  expect(block).toMatch(/@media \(max-width: 699px\)[^}]*min-height: 44px/);
});

test('no "more not shown" when the list is complete', async () => {
  routeApi({ ...STATUS_NONE, connection: LIVE }, { ...CALLS, has_more: false });
  render(<ClaudeConnection />);
  await screen.findByText('Recent calls');
  expect(screen.queryByText('More not shown.')).not.toBeInTheDocument();
});

test('Disconnect asks inside the page, Keep it backs out, and nothing is sent', async () => {
  const confirmSpy = jest.spyOn(window, 'confirm').mockImplementation(() => true);
  routeApi({ ...STATUS_NONE, connection: LIVE });
  render(<ClaudeConnection />);
  fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
  expect(screen.getByRole('group', { name: /confirm disconnect/i })).toHaveTextContent(/loses access right away/);
  fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
  expect(screen.queryByRole('group', { name: /confirm disconnect/i })).not.toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();
  expect(confirmSpy).not.toHaveBeenCalled();
  confirmSpy.mockRestore();
});

test('Disconnect, confirmed: one call, then the cleared state', async () => {
  let resolve;
  api.post.mockImplementation(() => new Promise((r) => { resolve = r; }));
  routeApi({ ...STATUS_NONE, connection: LIVE }, CALLS);
  render(<ClaudeConnection />);
  fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
  const yes = screen.getByRole('button', { name: 'Yes, disconnect' });
  act(() => { yes.click(); yes.click(); });
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledWith('/admin/connector/disconnect');
  expect(screen.getByRole('button', { name: 'Disconnecting...' })).toBeDisabled();
  await act(async () => { resolve({ data: { ok: true, revoked: 1 } }); });
  expect(screen.getByText(/Disconnected\. Claude can no longer read/)).toBeInTheDocument();
  expect(screen.getByText('Claude is not connected.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
  // The call log stays.
  expect(screen.getByText('Upcoming events')).toBeInTheDocument();
});

test('a failed Disconnect says so and keeps the connection', async () => {
  api.post.mockRejectedValue({ status: 500, message: 'Something went wrong. Please try again.' });
  routeApi({ ...STATUS_NONE, connection: LIVE });
  render(<ClaudeConnection />);
  fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
  fireEvent.click(screen.getByRole('button', { name: 'Yes, disconnect' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/went wrong/);
  expect(screen.getByText('Connected.')).toBeInTheDocument();
});

test('the connector switched off (404): the block renders nothing', async () => {
  routeApi({ status: 404, message: 'Not found' });
  const { container } = render(<ClaudeConnection />);
  await waitFor(() => expect(container).toBeEmptyDOMElement());
});

test('another load failure says so', async () => {
  routeApi({ status: 500, message: 'x' });
  render(<ClaudeConnection />);
  expect(await screen.findByText(/Could not load the Claude connection/)).toBeInTheDocument();
});

test('a manager sees nothing and the admin-only routes are never called', () => {
  mockUseAuth.mockReturnValue({ user: { id: 50007, role: 'manager' } });
  routeApi(STATUS_NONE);
  const { container } = render(<ClaudeConnection />);
  expect(container).toBeEmptyDOMElement();
  expect(api.get).not.toHaveBeenCalled();
});

test('no copy in the block carries an em dash', () => {
  // eslint-disable-next-line global-require
  const src = require('fs').readFileSync(require('path').join(__dirname, 'ClaudeConnection.js'), 'utf8');
  expect(src).not.toContain('—');
});

test('recordWords: a trip mark in Chicago time, held-back pieces as one plain entry ahead of flags, no raw marks', () => {
  const words = recordWords(['50201', 'flagged:message sms:1', 'flagged:message sms:2', 'withheld:email:c-5#abcdefabcdefabcd', 'withheld:msg:sms:3#fedcbafedcbafedc']);
  expect(words).toEqual(['50201', 'text held back (2 pieces)', 'flagged:message sms:1', 'flagged:message sms:2']);
  const trip = recordWords(['50210', 'trip:2026-11-20T03:14:00.000Z']);
  expect(trip[1]).toMatch(/^read limit trip started .*9:14/);
  expect(trip.join(' ')).not.toMatch(/T03:14|trip:/);
  expect(recordWords(['withheld:name:c-5#abcdefabcdefabcd'])).toEqual(['text held back']);
});

test('a call row shows its held-back piece within the first three records, never behind "and N more"', async () => {
  routeApi({ ...STATUS_NONE, connection: LIVE }, { calls: [{ id: 30, called_at: '2026-11-19T14:30:00.000Z', caller_address: '192.0.2.20', method: 'tools/call', tool_name: 'thread', record_ids: ['c-5', 'flagged:message sms:1', 'flagged:message sms:2', 'flagged:message sms:3', 'withheld:msg:sms:4#abcdefabcdefabcd'], outcome: 'ok' }], has_more: false });
  render(<ClaudeConnection />);
  const row = await screen.findByText(/Records:/);
  expect(row.textContent).toMatch(/Records: c-5, text held back, flagged:message sms:1 and 2 more/);
  expect(row.textContent).not.toMatch(/withheld:/);
});

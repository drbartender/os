import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import api from '../../utils/api';
import ReplyBar from './ReplyBar';
import useInboxDrafts from './useInboxDrafts';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { post: jest.fn() } }));
// A stable toast double (CRA resetMocks wipes jest.fn implementations, so the
// calls are recorded by hand).
const mockToasts = [];
jest.mock('../../context/ToastContext', () => ({
  useToast: () => ({
    success: (m, o) => mockToasts.push({ type: 'success', m, o }),
    error: (m, o) => mockToasts.push({ type: 'error', m, o }),
    info: (m, o) => mockToasts.push({ type: 'info', m, o }),
  }),
}));

// Tue Oct 6 2026, 2:40 PM Chicago: inside texting hours.
const NOW = Date.parse('2026-10-06T19:40:00.000Z');
const TEXT_REPLY = {
  mode: 'text', lines: ['888', '1922'], default_line: '1922', last_line: '1922', their_line: '1922',
  recipient_display: '(312) 555-0148', opted_out: null, bad_number: false,
  proxy: false, staff: false, first_text_prefix: {}, app: null,
};

function setup(reply = TEXT_REPLY, { onSent = () => {}, nowMs = NOW, variant = 'phone' } = {}) {
  const { result: drafts } = renderHook(() => useInboxDrafts());
  const view = render(<ReplyBar personKey="c-7" name="Avery Example" reply={reply} drafts={drafts.current} nowMs={nowMs} onSent={onSent} variant={variant} />);
  const rerender = () => view.rerender(<ReplyBar personKey="c-7" name="Avery Example" reply={reply} drafts={drafts.current} nowMs={nowMs} onSent={onSent} variant={variant} />);
  return { drafts, rerender };
}
const box = () => screen.getByRole('textbox', { name: 'Reply' });
const type = (text, rerender) => { fireEvent.change(box(), { target: { value: text } }); rerender(); };
const sentIds = () => api.post.mock.calls.map(([, body]) => body.send_id);
// Tap Send and wait for its toast (the nth of the test).
const tapSend = async (n, rerender) => {
  fireEvent.click(screen.getByRole('button', { name: 'Send from 1922' }));
  await waitFor(() => expect(mockToasts).toHaveLength(n));
  rerender();
};

beforeEach(() => { mockToasts.length = 0; });

test('the FROM switch offers the enabled lines on the default line, with "last texted"', () => {
  setup();
  expect(screen.getByRole('radio', { name: '1922' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('radio', { name: '888' })).toHaveAttribute('aria-checked', 'false');
  expect(screen.getByText('last texted 1922')).toBeInTheDocument();
  expect(box()).toHaveAttribute('placeholder', 'Text Avery from 1922');
});

// An unknown number's name is its formatted phone: the placeholder never
// reads the area code as a first name. The fixture is built from parts (the
// repo is public): a fiction-range number.
test('an unknown number (a p- key): "Text this number from 1922" on both shells, "Text this number" with no line', () => {
  const parts = ['312', '555', ['01', '71'].join('')];
  const name = `(${parts[0]}) ${parts[1]}-${parts[2]}`;
  const { result: drafts } = renderHook(() => useInboxDrafts());
  const bar = (reply, variant) => (
    <ReplyBar personKey={`p-${parts.join('')}`} name={name} reply={reply} drafts={drafts.current} nowMs={NOW} variant={variant} />
  );
  const view = render(bar(TEXT_REPLY, 'phone'));
  expect(box()).toHaveAttribute('placeholder', 'Text this number from 1922');
  view.rerender(bar(TEXT_REPLY, 'desktop'));
  expect(box()).toHaveAttribute('placeholder', 'Text this number from 1922...');
  view.rerender(bar({ ...TEXT_REPLY, staff: true }, 'phone'));
  expect(box()).toHaveAttribute('placeholder', 'Text this number');
});

test('switching away from the line they texted warns, and the draft keeps the choice', () => {
  const { rerender, drafts } = setup();
  fireEvent.click(screen.getByRole('radio', { name: '888' }));
  rerender();
  expect(screen.getByRole('radio', { name: '888' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByText('they texted 1922')).toHaveClass('ib-from-warn');
  expect(drafts.current.draftOf('c-7').line).toBe('888');
});

test('the hint names their_line, the line THEY last texted, even when our last text went from another line', () => {
  setup({ ...TEXT_REPLY, default_line: '888', last_line: '888', their_line: '1922' });
  expect(screen.getByRole('radio', { name: '888' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByText('they texted 1922')).toHaveClass('ib-from-warn');
  expect(screen.queryByText('last texted 888')).toBeNull();
});

test('no hint for someone who has never texted a DRB line (their_line null)', () => {
  setup({ ...TEXT_REPLY, their_line: null });
  expect(screen.getByRole('radio', { name: '1922' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.queryByText(/texted/)).toBeNull();
});

test('a successful send: one POST with body, line and a UUID send_id; draft cleared; toast with no Undo', async () => {
  api.post.mockResolvedValue({ status: 201, data: { message: { ref: 'sms:9', direction: 'out', line: '1922', failed: false } } });
  const onSent = jest.fn();
  const { rerender, drafts } = setup(TEXT_REPLY, { onSent });
  type('  On our way at six  ', rerender);
  fireEvent.click(screen.getByRole('button', { name: 'Send from 1922' }));
  await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
  expect(api.post).toHaveBeenCalledTimes(1);
  const [url, body] = api.post.mock.calls[0];
  expect(url).toBe('/admin/inbox/c-7/text');
  expect(body).toMatchObject({ body: 'On our way at six', line: '1922' });
  expect(body.send_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(drafts.current.draftOf('c-7').text).toBe('');
  expect(mockToasts).toEqual([{ type: 'success', m: 'Sent from 1922.', o: undefined }]);
});

test('Send is disabled while a send is in flight, so a double tap posts once', async () => {
  let finish;
  api.post.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const { rerender } = setup();
  type('Hello', rerender);
  const send = screen.getByRole('button', { name: 'Send from 1922' });
  fireEvent.click(send);
  fireEvent.click(send);
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(send).toBeDisabled();
  await act(async () => { finish({ status: 201, data: { message: { line: '1922', failed: false } } }); });
  rerender();
  expect(api.post).toHaveBeenCalledTimes(1);
});

test('two taps in one burst post once: the in-flight guard holds before the disabled button renders', async () => {
  let finish;
  api.post.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const { rerender } = setup();
  type('Hello', rerender);
  const send = screen.getByRole('button', { name: 'Send from 1922' });
  // One act: React renders nothing between the two taps, so the button is
  // still enabled for the second one.
  act(() => { send.click(); send.click(); });
  expect(api.post).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ status: 201, data: { message: { line: '1922', failed: false } } }); });
});

test('a send the server never answered keeps the draft and the retry reuses the same send_id', async () => {
  api.post
    .mockRejectedValueOnce({ status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' })
    .mockResolvedValueOnce({ status: 201, data: { message: { line: '1922', failed: false } } });
  const { rerender, drafts } = setup();
  type('Did my text arrive?', rerender);
  fireEvent.click(screen.getByRole('button', { name: 'Send from 1922' }));
  await waitFor(() => expect(mockToasts).toHaveLength(1));
  rerender();
  expect(mockToasts[0]).toMatchObject({ type: 'error', m: 'Network error. Check your connection.' });
  expect(drafts.current.draftOf('c-7').text).toBe('Did my text arrive?');
  fireEvent.click(screen.getByRole('button', { name: 'Send from 1922' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  const [first, second] = sentIds();
  expect(second).toBe(first);
});

test('no answer, then 409 still sending, then 201: all three posts carry one send_id', async () => {
  api.post
    .mockRejectedValueOnce({ status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' })
    .mockRejectedValueOnce({ status: 409, code: 'INBOX_SEND_IN_PROGRESS', message: 'This text is still sending.' })
    .mockResolvedValueOnce({ status: 201, data: { message: { line: '1922', failed: false } } });
  const { rerender, drafts } = setup();
  type('Running ten minutes late', rerender);
  await tapSend(1, rerender);
  await tapSend(2, rerender);
  expect(mockToasts[1]).toEqual({ type: 'info', m: 'Still sending, check the thread.', o: undefined });
  expect(drafts.current.draftOf('c-7').text).toBe('Running ten minutes late');
  await tapSend(3, rerender);
  expect(api.post).toHaveBeenCalledTimes(3);
  const ids = sentIds();
  expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(ids).toEqual([ids[0], ids[0], ids[0]]);
  expect(mockToasts[2]).toMatchObject({ type: 'success', m: 'Sent from 1922.' });
  expect(drafts.current.draftOf('c-7').text).toBe('');
});

test('an answer with no code (a rate limit in front of the route) keeps the send_id too', async () => {
  api.post
    .mockRejectedValueOnce({ status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' })
    .mockRejectedValueOnce({ status: 429, code: undefined, message: 'Too many requests. Please try again in a moment.' })
    .mockResolvedValueOnce({ status: 201, data: { message: { line: '1922', failed: false } } });
  const { rerender } = setup();
  type('Still on for Saturday?', rerender);
  await tapSend(1, rerender);
  await tapSend(2, rerender);
  await tapSend(3, rerender);
  const ids = sentIds();
  expect(ids).toEqual([ids[0], ids[0], ids[0]]);
  expect(mockToasts[1]).toMatchObject({ type: 'error', m: 'Too many requests. Please try again in a moment.' });
});

test('a send the server answered with a failure keeps the draft and the next tap is a new attempt', async () => {
  api.post
    .mockRejectedValueOnce({ status: 502, code: 'EXTERNAL_SERVICE_ERROR', message: 'Twilio rejected the send.' })
    .mockResolvedValueOnce({ status: 201, data: { message: { line: '1922', failed: false } } });
  const { rerender, drafts } = setup();
  type('Second try', rerender);
  fireEvent.click(screen.getByRole('button', { name: 'Send from 1922' }));
  await waitFor(() => expect(mockToasts).toHaveLength(1));
  rerender();
  expect(drafts.current.draftOf('c-7').text).toBe('Second try');
  fireEvent.click(screen.getByRole('button', { name: 'Send from 1922' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  const [first, second] = sentIds();
  expect(second).not.toBe(first);
});

test('a 201 that carries a failed row is not a success: draft kept, Not delivered, no Sent toast', async () => {
  api.post.mockResolvedValue({ status: 201, data: { message: { line: '888', failed: true, failure_reason: 'Unreachable (30003)' } } });
  const { rerender, drafts } = setup();
  type('Are you there?', rerender);
  fireEvent.click(screen.getByRole('button', { name: 'Send from 1922' }));
  await waitFor(() => expect(mockToasts).toHaveLength(1));
  expect(mockToasts[0]).toMatchObject({ type: 'error', m: 'Not delivered: Unreachable (30003)' });
  expect(drafts.current.draftOf('c-7').text).toBe('Are you there?');
});

// The server stores its answer under the send id and replays it for that id
// forever, so a 201 with a failed row must spend the id: on that path only
// spend() drops it (clear() runs on a clean success only), and a kept id
// could never resend the text.
test('a 201 that carries a failed row spends the send_id, so the next tap is a new attempt', async () => {
  api.post
    .mockResolvedValueOnce({ status: 201, data: { message: { line: '1922', failed: true, failure_reason: null } } })
    .mockResolvedValueOnce({ status: 201, data: { message: { line: '1922', failed: false } } });
  const { rerender, drafts } = setup();
  type('Try again', rerender);
  await tapSend(1, rerender);
  expect(mockToasts[0]).toEqual({ type: 'error', m: 'Not delivered.', o: undefined });
  expect(drafts.current.draftOf('c-7').text).toBe('Try again');
  await tapSend(2, rerender);
  const [first, second] = sentIds();
  expect(second).toMatch(/^[0-9a-f-]{36}$/);
  expect(second).not.toBe(first);
  expect(mockToasts[1]).toMatchObject({ type: 'success', m: 'Sent from 1922.' });
});

// The send id is spent only on an answer the text route itself gives (spec 17
// item 3, as ruled 2026-10-09): the server answers a spent id the same way
// forever only for answers it stored or decided under that id. Anything in
// front of the route, or an error the route never stored, says nothing about
// the id, so the next tap repeats it. The codes are the server's own:
// server/middleware/auth.js (NO_TOKEN, INVALID_TOKEN, USER_NOT_FOUND,
// TOKEN_VERSION_MISMATCH and the ACCOUNT_* refusals), the role guard's
// PermissionError (PERMISSION_DENIED) and server/index.js's global handler
// (INTERNAL_ERROR).
async function twoTaps(firstAnswer) {
  api.post
    .mockRejectedValueOnce(firstAnswer)
    .mockResolvedValueOnce({ status: 201, data: { message: { line: '1922', failed: false } } });
  const { rerender } = setup();
  type('Checking in', rerender);
  await tapSend(1, rerender);
  await tapSend(2, rerender);
  expect(api.post).toHaveBeenCalledTimes(2);
  const ids = sentIds();
  expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(ids[1]).toMatch(/^[0-9a-f-]{36}$/);
  return ids;
}

test('an unexpected server error (INTERNAL_ERROR, which the route never stored) keeps the send_id', async () => {
  const [first, second] = await twoTaps({ status: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred. Please try again.' });
  expect(second).toBe(first);
});

test.each([
  [401, 'NO_TOKEN'], [401, 'INVALID_TOKEN'], [401, 'USER_NOT_FOUND'], [401, 'TOKEN_VERSION_MISMATCH'],
  [403, 'ACCOUNT_DEACTIVATED'], [403, 'ACCOUNT_SUSPENDED'], [403, 'APPLICATION_REJECTED'], [403, 'PERMISSION_DENIED'],
])('a %i %s from the auth middleware in front of the route keeps the send_id', async (status, code) => {
  const [first, second] = await twoTaps({ status, code, message: 'Refused.' });
  expect(second).toBe(first);
});

test('a code this page does not know keeps the send_id', async () => {
  const [first, second] = await twoTaps({ status: 400, code: 'SOMETHING_NEW', message: 'Refused.' });
  expect(second).toBe(first);
});

test.each([
  [502, 'EXTERNAL_SERVICE_ERROR'], [500, 'INBOX_SEND_UNRECORDED'], [409, 'INBOX_SEND_UNRECORDED'],
  [409, 'INBOX_SEND_ID_REUSED'], [409, 'INBOX_OPTED_OUT'], [422, 'INBOX_NOT_TEXTABLE'],
  [422, 'INBOX_LINE_NOT_ENABLED'], [422, 'INBOX_LINE_NOT_ALLOWED'], [422, 'INBOX_BAD_NUMBER'],
  [400, 'VALIDATION_ERROR'], [404, 'INBOX_MOVED'], [404, undefined],
])('the text route\'s own %i %s spends the send_id', async (status, code) => {
  const [first, second] = await twoTaps({ status, code, message: 'Refused.' });
  expect(second).not.toBe(first);
});

test('staff: no FROM switch, the staff-line caption, and the 888', async () => {
  api.post.mockResolvedValue({ status: 201, data: { message: { line: '888', failed: false } } });
  const { rerender } = setup({ ...TEXT_REPLY, lines: ['888'], default_line: '888', last_line: null, their_line: null, staff: true });
  expect(screen.queryByRole('radiogroup', { name: 'Send from' })).toBeNull();
  expect(screen.getByText('Sends from the staff line, same as the shift texts')).toBeInTheDocument();
  expect(box()).toHaveAttribute('placeholder', 'Text Avery');
  type('Can you cover Saturday?', rerender);
  fireEvent.click(screen.getByRole('button', { name: 'Send from 888' }));
  await waitFor(() => expect(mockToasts[0]).toMatchObject({ m: 'Sent from 888.' }));
  expect(api.post.mock.calls[0][1].line).toBe('888');
});

test('opted out: the notice replaces the box, with another channel\'s Open button', () => {
  setup({ ...TEXT_REPLY, opted_out: { since: '2026-09-28T15:04:00.000Z' }, app: { name: 'Thumbtack', url: 'https://www.thumbtack.com/pro-inbox/messages/555' } });
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByText(/Texts are off for this person since Sep 28\. Texts from 888, 1922 or 0082 will not deliver\./)).toBeInTheDocument();
  expect(screen.getByText('Opted out of texts.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Open in Thumbtack/ })).toHaveAttribute('href', 'https://www.thumbtack.com/pro-inbox/messages/555');
});

test('a bad number cannot be texted', () => {
  setup({ ...TEXT_REPLY, bad_number: true });
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByText("This number can't receive texts.")).toBeInTheDocument();
});

test('an app channel: Open in Thumbtack and its caption', () => {
  setup({ mode: 'open', app: { name: 'Thumbtack', url: 'https://www.thumbtack.com/pro-inbox/messages/555' } });
  expect(screen.getByRole('link', { name: /Open in Thumbtack/ })).toHaveAttribute('target', '_blank');
  expect(screen.getByText('Closes here on its own once you reply in Thumbtack.')).toBeInTheDocument();
});

test('the first text from a 224 line shows its prefix; late hours warn in Chicago time', () => {
  setup({ ...TEXT_REPLY, first_text_prefix: { 1922: 'Dr. Bartender: ' } }, { nowMs: Date.parse('2026-10-07T03:40:00.000Z') });
  expect(screen.getByText('This first text from 1922 starts with "Dr. Bartender:"')).toBeInTheDocument();
  expect(screen.getByText("It's 10:40 PM for them")).toBeInTheDocument();
});

test('the desktop composer: textarea, the send note with the number, and Send from 1922', () => {
  setup(TEXT_REPLY, { variant: 'desktop' });
  expect(box()).toHaveClass('form-input');
  expect(screen.getByText('Sends as SMS from 1922 to (312) 555-0148.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send from 1922' })).toBeDisabled();
  // The design's desktop copy (InboxDesktop.dc.html); the phone says "last texted 1922".
  expect(screen.getByText('they last texted 1922')).toHaveClass('ib-dfrom-hint');
});

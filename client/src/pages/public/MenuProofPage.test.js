import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import api from '../../utils/api';
import MenuProofPage from './MenuProofPage';

// The client menu proof page (spec 2026-10-19 section 12; lane menu-proof-page)
// in every state, with a mocked api. The GET body is the route's own shape:
// { state, answer, answer_note, answered_at, image }.

jest.mock('../../utils/api', () => ({
  __esModule: true,
  API_BASE_URL: '/api',
  default: { get: jest.fn(), post: jest.fn() },
}));
// A link token is a UUID; the page checks that before it asks the server anything.
const TOKEN = '11111111-2222-4333-8444-555555555555';
let mockToken = TOKEN;
jest.mock('react-router-dom', () => ({ useParams: () => ({ token: mockToken }) }));

const OPEN = { state: 'open', answer: null, answer_note: null, answered_at: null, image: true };
const AT = '2026-11-03T20:15:00Z';
const IMAGE_SRC = `/api/menu-proof/${TOKEN}/image`;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const buttons = () => screen.queryAllByRole('button');

beforeEach(() => {
  mockToken = TOKEN;
  api.get.mockReset();
  api.post.mockReset();
});

test('loading: the kicker and the heading over one quiet line', async () => {
  api.get.mockReturnValue(new Promise(() => {}));
  render(<MenuProofPage />);
  expect(screen.getByText('DR. BARTENDER')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Your bar menu' })).toBeInTheDocument();
  expect(screen.getByText('Loading your menu...')).toBeInTheDocument();
  expect(api.get).toHaveBeenCalledWith(`/menu-proof/${TOKEN}`);
  expect(buttons()).toHaveLength(0);
});

test('open: the copy, the proof that opens larger in a new tab, the two buttons and the footnote', async () => {
  api.get.mockResolvedValue({ data: OPEN });
  const { container } = render(<MenuProofPage />);
  expect(await screen.findByText("Here's the menu we drafted for your event. Tap the menu to see it larger.")).toBeInTheDocument();
  expect(container.querySelector('.menu-proof-page')).not.toBeNull();
  expect(screen.getByText('DR. BARTENDER')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Your bar menu' })).toBeInTheDocument();
  const img = screen.getByRole('img');
  expect(img).toHaveAttribute('src', IMAGE_SRC);
  const link = img.closest('a');
  expect(link).toHaveAttribute('href', IMAGE_SRC);
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(screen.getByRole('button', { name: 'Looks great' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Request changes' })).toBeEnabled();
  expect(screen.getByText("Replying here doesn't change your booking. We'll take it from here.")).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).toBeNull();
});

test('Looks great: posts approved, disables everything and reads Sending..., then shows the approved state', async () => {
  api.get.mockResolvedValue({ data: OPEN });
  const post = deferred();
  api.post.mockReturnValue(post.promise);
  render(<MenuProofPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Looks great' }));
  expect(api.post).toHaveBeenCalledWith(`/menu-proof/${TOKEN}/answer`, { answer: 'approved' });
  expect(screen.getByRole('button', { name: 'Sending...' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Request changes' })).toBeDisabled();
  await act(async () => { post.resolve({ data: { state: 'approved', answered_at: AT } }); });
  expect(await screen.findByRole('heading', { name: "Thanks! We've got it." })).toBeInTheDocument();
  expect(screen.getByText("You said this looks great on November 3. We'll get it printed for your event.")).toBeInTheDocument();
  expect(screen.getByRole('img')).toHaveAttribute('src', IMAGE_SRC);
  expect(buttons()).toHaveLength(0);
});

test('Request changes: the textarea, its live counter, and Send changes disabled until a non-space character', async () => {
  api.get.mockResolvedValue({ data: OPEN });
  render(<MenuProofPage />);
  const toggle = await screen.findByRole('button', { name: 'Request changes' });
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const box = screen.getByRole('textbox', { name: "Tell us what you'd like changed" });
  expect(box).toHaveAttribute('placeholder', "Tell us what you'd like changed");
  expect(box).toHaveAttribute('maxLength', '1000');
  expect(screen.getByText('0 / 1000')).toBeInTheDocument();
  const send = screen.getByRole('button', { name: 'Send changes' });
  expect(send).toBeDisabled();
  fireEvent.change(box, { target: { value: '   \n ' } });
  expect(send).toBeDisabled();
  expect(screen.getByText('5 / 1000')).toBeInTheDocument();
  fireEvent.change(box, { target: { value: 'Swap the Paloma' } });
  expect(send).toBeEnabled();
  expect(screen.getByText('15 / 1000')).toBeInTheDocument();
});

test('Send changes: posts the trimmed note, reads Sending... with all three disabled, then shows the note read-only', async () => {
  api.get.mockResolvedValue({ data: OPEN });
  const post = deferred();
  api.post.mockReturnValue(post.promise);
  render(<MenuProofPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Request changes' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Can the title say Happy 40th?  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send changes' }));
  expect(api.post).toHaveBeenCalledWith(`/menu-proof/${TOKEN}/answer`, { answer: 'changes', note: 'Can the title say Happy 40th?' });
  expect(screen.getByRole('button', { name: 'Sending...' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Looks great' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Request changes' })).toBeDisabled();
  await act(async () => { post.resolve({ data: { state: 'changes', answered_at: AT } }); });
  expect(await screen.findByRole('heading', { name: "Thanks! We've got your notes." })).toBeInTheDocument();
  expect(screen.getByText("We'll make the changes and send you a fresh look. Reply to our email if you think of anything else.")).toBeInTheDocument();
  expect(screen.getByText('Can the title say Happy 40th?')).toBeInTheDocument();
  expect(buttons()).toHaveLength(0);
});

test('approved, from the GET: the date line in Chicago, the proof, no buttons', async () => {
  api.get.mockResolvedValue({ data: { state: 'approved', answer: 'approved', answer_note: null, answered_at: '2026-11-04T03:30:00Z', image: true } });
  render(<MenuProofPage />);
  // 03:30 GMT on November 4 is 9:30 p.m. on November 3 in Chicago.
  expect(await screen.findByText("You said this looks great on November 3. We'll get it printed for your event.")).toBeInTheDocument();
  expect(screen.getByRole('img')).toBeInTheDocument();
  expect(buttons()).toHaveLength(0);
});

test('changes, from the GET: the note renders as plain text above the proof, never as HTML', async () => {
  const note = '<b>bold</b><img src=x onerror="alert(1)"> swap it';
  api.get.mockResolvedValue({ data: { state: 'changes', answer: 'changes', answer_note: note, answered_at: AT, image: true } });
  const { container } = render(<MenuProofPage />);
  expect(await screen.findByText(note)).toBeInTheDocument();
  expect(container.querySelector('b')).toBeNull();
  expect(screen.getAllByRole('img')).toHaveLength(1);
  const noteEl = screen.getByText(note);
  const picture = screen.getByRole('img');
  // eslint-disable-next-line no-bitwise
  expect(noteEl.compareDocumentPosition(picture) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(buttons()).toHaveLength(0);
});

test.each([
  ['superseded', 'A newer version was sent.', 'Check your email for the latest link.'],
  ['expired', 'This link has expired.', "Reply to our email and we'll send a fresh one."],
  ['withdrawn', 'This menu is no longer open for review.', 'If you have questions, just reply to our email.'],
])('%s: its two lines, no picture, no buttons', async (state, heading, line) => {
  api.get.mockResolvedValue({ data: { state, answer: null, answer_note: null, answered_at: null, image: false } });
  render(<MenuProofPage />);
  expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
  expect(screen.getByText(line)).toBeInTheDocument();
  expect(screen.getByText('DR. BARTENDER')).toBeInTheDocument();
  expect(screen.queryByRole('img')).toBeNull();
  expect(buttons()).toHaveLength(0);
});

test('404: the public-error shell with the mailto link', async () => {
  api.get.mockRejectedValue({ status: 404, code: 'NOT_FOUND', message: "We couldn't find that menu." });
  const { container } = render(<MenuProofPage />);
  expect(await screen.findByRole('heading', { name: "We couldn't find that menu." })).toBeInTheDocument();
  expect(container.querySelector('.menu-proof-page .public-error')).not.toBeNull();
  const mail = screen.getByRole('link', { name: /^Email / });
  expect(mail.getAttribute('href')).toMatch(/^mailto:/);
  expect(buttons()).toHaveLength(0);
});

test('a failed load (429) says so with Try again, which refetches', async () => {
  api.get.mockRejectedValueOnce({ status: 429, code: undefined, message: 'Too many requests.' });
  api.get.mockResolvedValueOnce({ data: OPEN });
  render(<MenuProofPage />);
  expect(await screen.findByRole('heading', { name: "We couldn't load your menu right now." })).toBeInTheDocument();
  expect(screen.getByText('Please try again in a few minutes.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('button', { name: 'Looks great' })).toBeInTheDocument();
  expect(api.get).toHaveBeenCalledTimes(2);
});

test('a failed load with no network shows the same Try again', async () => {
  api.get.mockRejectedValue({ status: 0, code: 'NETWORK_ERROR', message: 'Network error.' });
  render(<MenuProofPage />);
  expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
});

test('a failed post: the inline alert, and the buttons work again', async () => {
  api.get.mockResolvedValue({ data: OPEN });
  api.post.mockRejectedValue({ status: 500, code: 'INTERNAL_ERROR', message: 'x' });
  render(<MenuProofPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Looks great' }));
  expect(await screen.findByRole('alert')).toHaveTextContent("That didn't go through. Please try again.");
  expect(screen.getByRole('button', { name: 'Looks great' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Request changes' })).toBeEnabled();
});

test.each([
  ['MENU_PROOF_SUPERSEDED', { state: 'superseded', answer: null, answer_note: null, answered_at: null, image: false }, 'A newer version was sent.'],
  ['MENU_PROOF_ANSWERED', { state: 'approved', answer: 'approved', answer_note: null, answered_at: AT, image: true }, "Thanks! We've got it."],
  ['MENU_PROOF_WITHDRAWN', { state: 'withdrawn', answer: null, answer_note: null, answered_at: null, image: false }, 'This menu is no longer open for review.'],
  ['MENU_PROOF_EXPIRED', { state: 'expired', answer: null, answer_note: null, answered_at: null, image: false }, 'This link has expired.'],
])('a 409 %s refetches and shows the state the server reports', async (code, body, heading) => {
  api.get.mockResolvedValueOnce({ data: OPEN });
  api.get.mockResolvedValueOnce({ data: body });
  api.post.mockRejectedValue({ status: 409, code, message: 'x' });
  render(<MenuProofPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Looks great' }));
  expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a 404 on the post shows the not-found shell', async () => {
  api.get.mockResolvedValue({ data: OPEN });
  api.post.mockRejectedValue({ status: 404, code: 'NOT_FOUND', message: 'x' });
  render(<MenuProofPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Looks great' }));
  expect(await screen.findByRole('heading', { name: "We couldn't find that menu." })).toBeInTheDocument();
});

test('the picture missing in R2: the line in its place, and the buttons still work', async () => {
  api.get.mockResolvedValue({ data: OPEN });
  api.post.mockResolvedValue({ data: { state: 'approved', answered_at: AT } });
  render(<MenuProofPage />);
  fireEvent.error(await screen.findByRole('img'));
  expect(await screen.findByText("We couldn't load the menu picture. Reply to our email and we'll send it again.")).toBeInTheDocument();
  expect(screen.queryByRole('img')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Looks great' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/menu-proof/${TOKEN}/answer`, { answer: 'approved' }));
  expect(await screen.findByRole('heading', { name: "Thanks! We've got it." })).toBeInTheDocument();
});

test('the page shows nothing the GET does not own: no client name, email, date or amounts', async () => {
  api.get.mockResolvedValue({ data: { ...OPEN, client_name: 'Jordan Example', email: 'jordan@example.com', event_date: '2026-12-01', total_price: 1234 } });
  const { container } = render(<MenuProofPage />);
  await screen.findByRole('button', { name: 'Looks great' });
  for (const leak of ['Jordan', 'example.com', '2026-12-01', '1234', '$']) {
    expect(container.textContent).not.toContain(leak);
  }
});

// A 429 from either limiter on the answer: "Please try again" would be refused
// again for up to an hour, so the page names the wait and the way out.
test('a rate-limited post (429) says to try later or reply to the email, never the plain retry line', async () => {
  api.get.mockResolvedValue({ data: OPEN });
  api.post.mockRejectedValue({ status: 429, code: undefined, message: 'Too many tries. Please try again later.' });
  render(<MenuProofPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Looks great' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Too many tries. Please try again later, or reply to our email.');
  expect(alert).not.toHaveTextContent("That didn't go through.");
  expect(screen.getByRole('button', { name: 'Looks great' })).toBeEnabled();
});

// The pressed button unmounts when the Thanks screen renders, so focus moves to
// its heading: a screen reader then announces that the answer landed.
test.each([
  ['Looks great', { state: 'approved', answered_at: AT }, "Thanks! We've got it."],
  ['Send changes', { state: 'changes', answered_at: AT }, "Thanks! We've got your notes."],
])('after %s the Thanks heading takes focus', async (name, body, heading) => {
  api.get.mockResolvedValue({ data: OPEN });
  api.post.mockResolvedValue({ data: body });
  render(<MenuProofPage />);
  await screen.findByRole('button', { name: 'Looks great' });
  if (name === 'Send changes') {
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Paloma first, please.' } });
  }
  fireEvent.click(screen.getByRole('button', { name }));
  const h = await screen.findByRole('heading', { name: heading });
  await waitFor(() => expect(h).toHaveFocus());
});

test('a page that only loads an answered proof does not pull focus to its heading', async () => {
  api.get.mockResolvedValue({ data: { state: 'approved', answer: 'approved', answer_note: null, answered_at: AT, image: true } });
  render(<MenuProofPage />);
  const h = await screen.findByRole('heading', { name: "Thanks! We've got it." });
  expect(h).not.toHaveFocus();
});

// The token goes into the request path, so a link whose token is not a UUID
// (a crafted /menu-proof/..%2F<path>) must never reach the API at all.
test.each(['tok-1', '../proposals/12', '', undefined])('a token that is not a UUID (%p) shows the not-found shell and asks the server nothing', async (bad) => {
  mockToken = bad;
  render(<MenuProofPage />);
  expect(await screen.findByRole('heading', { name: "We couldn't find that menu." })).toBeInTheDocument();
  expect(api.get).not.toHaveBeenCalled();
  expect(screen.queryByRole('img')).toBeNull();
  expect(buttons()).toHaveLength(0);
});

// Any press that swaps the screen moves focus to the new heading, not only a
// 200: a refused answer lands on the Thanks or a closed screen through the
// refetch, and a 404 on the not-found shell, with the pressed button gone.
test.each([
  ['MENU_PROOF_ANSWERED', { state: 'approved', answer: 'approved', answer_note: null, answered_at: AT, image: true }, "Thanks! We've got it."],
  ['MENU_PROOF_SUPERSEDED', { state: 'superseded', answer: null, answer_note: null, answered_at: null, image: false }, 'A newer version was sent.'],
  ['MENU_PROOF_WITHDRAWN', { state: 'withdrawn', answer: null, answer_note: null, answered_at: null, image: false }, 'This menu is no longer open for review.'],
  ['MENU_PROOF_EXPIRED', { state: 'expired', answer: null, answer_note: null, answered_at: null, image: false }, 'This link has expired.'],
])('a refused answer (%s) moves focus to the heading of the screen it lands on', async (code, body, heading) => {
  api.get.mockResolvedValueOnce({ data: OPEN });
  api.get.mockResolvedValueOnce({ data: body });
  api.post.mockRejectedValue({ status: 409, code, message: 'x' });
  render(<MenuProofPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Looks great' }));
  const h = await screen.findByRole('heading', { name: heading });
  await waitFor(() => expect(h).toHaveFocus());
});

test('a 404 on the post moves focus to the not-found heading', async () => {
  api.get.mockResolvedValue({ data: OPEN });
  api.post.mockRejectedValue({ status: 404, code: 'NOT_FOUND', message: 'x' });
  render(<MenuProofPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Looks great' }));
  const h = await screen.findByRole('heading', { name: "We couldn't find that menu." });
  await waitFor(() => expect(h).toHaveFocus());
});

test('a refused answer whose refetch fails moves focus to the failed-load heading', async () => {
  api.get.mockResolvedValueOnce({ data: OPEN });
  api.get.mockRejectedValueOnce({ status: 500, code: 'INTERNAL_ERROR', message: 'x' });
  api.post.mockRejectedValue({ status: 409, code: 'MENU_PROOF_SUPERSEDED', message: 'x' });
  render(<MenuProofPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Looks great' }));
  const h = await screen.findByRole('heading', { name: "We couldn't load your menu right now." });
  await waitFor(() => expect(h).toHaveFocus());
});

// The form is still there, so the press keeps its place: no focus jump.
test.each([
  ['a refetch that reads open again', { status: 409, code: 'MENU_PROOF_CHANGED', message: 'x' }],
  ['a failed post', { status: 500, code: 'INTERNAL_ERROR', message: 'x' }],
  ['a rate-limited post', { status: 429, code: undefined, message: 'x' }],
])('%s leaves the open form in place and does not pull focus to the heading', async (_name, rejection) => {
  api.get.mockResolvedValue({ data: OPEN });
  api.post.mockRejectedValue(rejection);
  render(<MenuProofPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Looks great' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Looks great' })).toBeEnabled());
  expect(screen.getByRole('heading', { name: 'Your bar menu' })).not.toHaveFocus();
});

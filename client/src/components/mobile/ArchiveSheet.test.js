import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import ArchiveSheet, { ARCHIVE_OFFLINE, ARCHIVE_UNSURE, ARCHIVE_EARLIER } from './ArchiveSheet';
import api from '../../utils/api';
import { HOLD_NOTE, SHEET_MOVED, SHEET_PAID } from '../../utils/proposalDetailView';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../context/ToastContext', () => ({ useToast: () => mockToast }));

const PROPOSAL = { id: 41, status: 'sent', client_name: 'Test Client', amount_paid: '0.00', legal_hold: false, group_id: null };
const fresh = (over = {}) => ({ data: { ...PROPOSAL, ...over } });
const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

function Loc() { return <div data-testid="loc">{useLocation().pathname}</div>; }
function mount(props = {}) {
  const onClose = jest.fn();
  render(
    <MemoryRouter initialEntries={['/proposals/41']}>
      <Routes>
        <Route path="/proposals/:id" element={<><ArchiveSheet proposal={PROPOSAL} onClose={onClose} {...props} /><Loc /></>} />
        <Route path="/proposals" element={<Loc />} />
      </Routes>
    </MemoryRouter>
  );
  return { onClose };
}
const confirmBtn = () => screen.getByRole('button', { name: /^(Archive proposal|Archiving)$/ });
const pick = (label) => fireEvent.click(screen.getByRole('button', { name: label }));

beforeEach(() => { jest.clearAllMocks(); });

test("the benchmark's head and four reasons; nothing goes out before a reason is picked", () => {
  mount();
  expect(screen.getByRole('heading', { name: 'Archive proposal · Test Client' })).toBeInTheDocument();
  expect(screen.getByText('pick a reason · required')).toBeInTheDocument();
  for (const label of ['No hire', 'Client cancelled', 'We cancelled', 'Other']) {
    expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'false');
  }
  expect(confirmBtn()).toBeDisabled();
  fireEvent.click(confirmBtn());
  expect(api.get).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
});

test('a pick, then Archive proposal: a fresh read, one post with scope one and the value, a toast and the Proposals list', async () => {
  api.get.mockResolvedValue(fresh());
  api.post.mockResolvedValue({ data: { archived_ids: [41] } });
  mount();
  pick('We cancelled');
  expect(screen.getByRole('button', { name: 'We cancelled' })).toHaveAttribute('aria-pressed', 'true');
  await act(async () => { fireEvent.click(confirmBtn()); });
  expect(api.get).toHaveBeenCalledWith('/proposals/41', { timeout: 10000 });
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledWith('/proposals/41/archive', { scope: 'one', archive_reason: 'we_cancelled' });
  expect(mockToast.success).toHaveBeenCalledWith('Proposal archived.');
  expect(screen.getByTestId('loc')).toHaveTextContent(/^\/proposals$/);
});

test('a double tap posts once', async () => {
  const read = deferred();
  api.get.mockReturnValue(read.promise);
  api.post.mockResolvedValue({ data: { archived_ids: [41] } });
  mount();
  pick('No hire');
  fireEvent.click(confirmBtn());
  fireEvent.click(confirmBtn());
  await act(async () => { read.resolve(fresh()); });
  expect(api.get).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledTimes(1);
});

test('a 409 NOT_ARCHIVABLE reads in the server words and keeps the sheet open with the pick', async () => {
  api.get.mockResolvedValue(fresh());
  api.post.mockRejectedValue({ status: 409, code: 'NOT_ARCHIVABLE', message: 'Only unpaid, unconverted proposals can be archived.' });
  const { onClose } = mount();
  pick('Client cancelled');
  await act(async () => { fireEvent.click(confirmBtn()); });
  expect(screen.getByRole('alert')).toHaveTextContent('Only unpaid, unconverted proposals can be archived.');
  expect(screen.getByRole('button', { name: 'Client cancelled' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
  expect(mockToast.success).not.toHaveBeenCalled();
  expect(screen.getByTestId('loc')).toHaveTextContent(/^\/proposals\/41$/);
});

test('after a post that got no answer, Retry reads first and counts an already archived row as done, posting nothing', async () => {
  api.get.mockResolvedValueOnce(fresh());
  api.post.mockRejectedValueOnce({ status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' });
  mount();
  pick('Other');
  await act(async () => { fireEvent.click(confirmBtn()); });
  expect(screen.getByRole('alert')).toHaveTextContent(ARCHIVE_UNSURE);
  expect(screen.getByRole('button', { name: 'Other' })).toHaveAttribute('aria-pressed', 'true');
  api.get.mockResolvedValueOnce(fresh({ status: 'archived', archive_reason: 'other' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(mockToast.success).toHaveBeenCalledWith('Proposal archived.');
  expect(screen.getByTestId('loc')).toHaveTextContent(/^\/proposals$/);
});

test('a fresh read with money on the row refuses, posts nothing, and the page reads again on close', async () => {
  api.get.mockResolvedValue(fresh({ amount_paid: '250.00' }));
  const { onClose } = mount();
  pick('No hire');
  await act(async () => { fireEvent.click(confirmBtn()); });
  expect(screen.getByRole('alert')).toHaveTextContent(`${SHEET_PAID} Nothing was archived.`);
  expect(api.post).not.toHaveBeenCalled();
  expect(confirmBtn()).toBeDisabled();
  fireEvent.click(screen.getByText('Close'));
  expect(onClose).toHaveBeenCalledWith({ moved: true });
});

test('a fresh read on legal hold, or with the status moved on, refuses and posts nothing', async () => {
  for (const [over, text] of [[{ legal_hold: true }, HOLD_NOTE], [{ status: 'deposit_paid' }, `${SHEET_MOVED} Nothing was archived.`]]) {
    api.get.mockResolvedValue(fresh(over));
    const { unmount } = render(
      <MemoryRouter><ArchiveSheet proposal={PROPOSAL} onClose={() => {}} /></MemoryRouter>
    );
    pick('No hire');
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { fireEvent.click(confirmBtn()); });
    expect(screen.getByRole('alert')).toHaveTextContent(text);
    unmount();
  }
  expect(api.post).not.toHaveBeenCalled();
});

test('a server LEGAL_HOLD refusal reads as the hold note and stops the sheet', async () => {
  api.get.mockResolvedValue(fresh());
  api.post.mockRejectedValue({ status: 409, code: 'LEGAL_HOLD', message: 'This booking is on legal hold and cannot be edited.' });
  mount();
  pick('No hire');
  await act(async () => { fireEvent.click(confirmBtn()); });
  expect(screen.getByRole('alert')).toHaveTextContent(HOLD_NOTE);
  expect(confirmBtn()).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
});

test('a read that fails, or is answered from the stored copy, says nothing was archived and posts nothing', async () => {
  for (const answer of [() => Promise.reject({ status: 0, code: 'NETWORK_ERROR' }), () => Promise.resolve({ ...fresh(), staleAt: '2026-11-05T15:00:00Z' })]) {
    api.get.mockImplementation(answer);
    const { unmount } = render(<MemoryRouter><ArchiveSheet proposal={PROPOSAL} onClose={() => {}} /></MemoryRouter>);
    pick('No hire');
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { fireEvent.click(confirmBtn()); });
    expect(screen.getByRole('alert')).toHaveTextContent(ARCHIVE_OFFLINE);
    unmount();
  }
  expect(api.post).not.toHaveBeenCalled();
});

test('Cancel closes it as unmoved; nothing closes it while a write is out', async () => {
  const read = deferred();
  api.get.mockReturnValue(read.promise);
  const { onClose } = mount();
  pick('No hire');
  fireEvent.click(confirmBtn());
  fireEvent.click(screen.getByRole('button', { name: 'Close', hidden: true }));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => { read.reject({ status: 0, code: 'NETWORK_ERROR' }); });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalledWith({ moved: false });
});

test('a row someone else archived before this sheet posted is said as such, with their reason, and is not called this archive', async () => {
  api.get.mockResolvedValue(fresh({ status: 'archived', archive_reason: 'option_not_chosen' }));
  const { onClose } = mount();
  pick('We cancelled');
  await act(async () => { fireEvent.click(confirmBtn()); });
  expect(screen.getByRole('alert')).toHaveTextContent(`${SHEET_MOVED} It is archived now: Option not chosen.`);
  expect(api.post).not.toHaveBeenCalled();
  expect(mockToast.success).not.toHaveBeenCalled();
  expect(screen.getByTestId('loc')).toHaveTextContent(/^\/proposals\/41$/);
  fireEvent.click(screen.getByText('Close'));
  expect(onClose).toHaveBeenCalledWith({ moved: true });
});

test('an answer that lands after Back closed the sheet toasts but moves no page', async () => {
  api.get.mockResolvedValue(fresh());
  const answer = deferred();
  api.post.mockReturnValue(answer.promise);
  const onLateAnswer = jest.fn();
  function Toggle() {
    const [open, setOpen] = React.useState(true);
    return (
      <>
        {open && <ArchiveSheet proposal={PROPOSAL} onClose={() => {}} onLateAnswer={onLateAnswer} />}
        <button type="button" onClick={() => setOpen(false)}>back</button>
      </>
    );
  }
  render(
    <MemoryRouter initialEntries={['/proposals/41']}>
      <Routes>
        <Route path="/proposals/:id" element={<><Toggle /><Loc /></>} />
        <Route path="/proposals" element={<Loc />} />
      </Routes>
    </MemoryRouter>
  );
  pick('No hire');
  await act(async () => { fireEvent.click(confirmBtn()); });
  expect(api.post).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'back' }));
  await act(async () => { answer.resolve({ data: { archived_ids: [41] } }); });
  expect(mockToast.success).toHaveBeenCalledWith('Proposal archived.');
  expect(screen.getByTestId('loc')).toHaveTextContent(/^\/proposals\/41$/);
  // The page is told, so it reads the proposal again instead of leaving Archive live.
  expect(onLateAnswer).toHaveBeenCalledTimes(1);
});

test('closing after a post that got no answer has the page read the proposal again', async () => {
  api.get.mockResolvedValue(fresh());
  api.post.mockRejectedValue({ status: 0, code: 'NETWORK_ERROR' });
  const { onClose } = mount();
  pick('No hire');
  await act(async () => { fireEvent.click(confirmBtn()); });
  expect(screen.getByRole('alert')).toHaveTextContent(ARCHIVE_UNSURE);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalledWith({ moved: true });
});

test('the scrim takes no tap in the first moment after the sheet opens, and closes it after', () => {
  const now = jest.spyOn(Date, 'now');
  try {
    now.mockReturnValue(2000000);
    const { onClose } = mount();
    now.mockReturnValue(2000000 + 200);
    fireEvent.click(screen.getByRole('button', { name: 'Close', hidden: true }));
    expect(onClose).not.toHaveBeenCalled();
    now.mockReturnValue(2000000 + 600);
    fireEvent.click(screen.getByRole('button', { name: 'Close', hidden: true }));
    expect(onClose).toHaveBeenCalledWith({ moved: false });
  } finally {
    now.mockRestore();
  }
});

test('a definite refusal means the post did not land: an archive by someone else found on Retry is said as theirs', async () => {
  api.get.mockResolvedValueOnce(fresh());
  api.post.mockRejectedValueOnce({ status: 409, code: 'NOT_ARCHIVABLE', message: 'Only unpaid, unconverted proposals can be archived.' });
  mount();
  pick('We cancelled');
  await act(async () => { fireEvent.click(confirmBtn()); });
  expect(screen.getByRole('alert')).toHaveTextContent('Only unpaid, unconverted proposals can be archived.');
  api.get.mockResolvedValueOnce(fresh({ status: 'archived', archive_reason: 'option_not_chosen' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
  expect(screen.getByRole('alert')).toHaveTextContent(`${SHEET_MOVED} It is archived now: Option not chosen.`);
  expect(mockToast.success).not.toHaveBeenCalled();
  expect(api.post).toHaveBeenCalledTimes(1);
});

test('a sheet opened again while an archive is still going through says so and posts nothing', async () => {
  api.get.mockResolvedValue(fresh());
  const answer = deferred();
  api.post.mockReturnValueOnce(answer.promise);
  const first = render(<MemoryRouter><ArchiveSheet proposal={PROPOSAL} onClose={() => {}} /></MemoryRouter>);
  pick('No hire');
  await act(async () => { fireEvent.click(confirmBtn()); });
  first.unmount();   // Back while the archive is out

  const { onClose } = mount();
  expect(screen.getByRole('alert')).toHaveTextContent(ARCHIVE_EARLIER);
  expect(confirmBtn()).toBeDisabled();
  fireEvent.click(screen.getByText('Close'));
  expect(onClose).toHaveBeenCalledWith({ moved: true });
  await act(async () => { answer.resolve({ data: { archived_ids: [41] } }); });
  expect(api.post).toHaveBeenCalledTimes(1);
});

test('Back during the fresh read posts nothing', async () => {
  const read = deferred();
  api.get.mockReturnValueOnce(read.promise);
  const onLateAnswer = jest.fn();
  const first = render(<MemoryRouter><ArchiveSheet proposal={PROPOSAL} onClose={() => {}} onLateAnswer={onLateAnswer} /></MemoryRouter>);
  pick('No hire');
  fireEvent.click(confirmBtn());
  await act(async () => {});
  first.unmount();
  await act(async () => { read.resolve(fresh()); });
  expect(api.post).not.toHaveBeenCalled();
  expect(onLateAnswer).not.toHaveBeenCalled();
});

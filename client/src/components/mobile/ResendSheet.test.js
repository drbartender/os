import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, act } from '@testing-library/react';
import ResendSheet, { PREVIEW_FAILED, SEND_NO_ANSWER, SEND_UNSURE, SEND_OFFLINE, EARLIER_SEND, FEE_FIRST } from './ResendSheet';
import api from '../../utils/api';
import { HOLD_NOTE, SHEET_MOVED } from '../../utils/proposalDetailView';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));

const PROPOSAL = { id: 41, status: 'sent', client_name: 'Test Client', amount_paid: '0.00', legal_hold: false, group_id: null };
const PREVIEW = {
  action: 'proposal_resend',
  recipient: { name: 'Test Client', email: 'client41@example.test', phone: '+13125550100', source: 'client' },
  warnings: ['A previous email to this address hard-bounced. Confirm the address before sending.'],
  channels: {
    email: { available: true, default: true, unavailable_reason: null },
    sms: { available: true, default: true, unavailable_reason: null },
  },
  email: { subject: 'Your proposal from Dr. Bartender', bodyText: 'Hi Test, here is your proposal.', cta: { label: 'View proposal', url: 'https://example.test/proposal/x' } },
  sms: { body: 'Your proposal is ready: https://example.test/proposal/x' },
};
const SENT_BOTH = {
  ok: true, email: 'sent', sms: 'sent', email_error: null, sms_error: null, skip_reasons: {},
  recipient_email: 'client41@example.test', recipient_phone: '+13125550100',
};
const fresh = (over = {}) => ({ data: { ...PROPOSAL, ...over } });
const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
// The preview answers at once unless the test says otherwise; sends are set per test.
function serve({ preview = { data: PREVIEW }, send } = {}) {
  api.post.mockImplementation((url) => {
    if (url === '/comms/preview') return typeof preview === 'function' ? preview() : Promise.resolve(preview);
    if (url === '/comms/send') return send();
    return Promise.reject({ status: 404 });
  });
}
const sends = () => api.post.mock.calls.filter((c) => c[0] === '/comms/send');
const freshReads = () => api.get.mock.calls.filter((c) => c[0] === '/proposals/41');
async function mount() {
  const onClose = jest.fn();
  render(<ResendSheet proposal={PROPOSAL} onClose={onClose} />);
  await act(async () => {});
  return { onClose };
}
const sendBtn = () => screen.getByRole('button', { name: /^(Send|Sending)$/ });

beforeEach(() => {
  jest.clearAllMocks();
  api.get.mockResolvedValue(fresh());
});

test("the preview: who it goes to, the server's warnings, both channels and the drafted words, read-only", async () => {
  serve();
  await mount();
  expect(api.post).toHaveBeenCalledWith('/comms/preview', { action: 'proposal_resend', entity_id: 41 }, { timeout: 10000 });
  expect(screen.getByRole('heading', { name: 'Resend proposal · Test Client' })).toBeInTheDocument();
  expect(screen.getByText('To: Test Client (client41@example.test) · (312) 555-0100')).toBeInTheDocument();
  expect(screen.getByText(PREVIEW.warnings[0])).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Email' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Text message' })).toBeChecked();
  expect(screen.getByText(PREVIEW.email.subject)).toBeInTheDocument();
  expect(screen.getByText(PREVIEW.email.bodyText)).toBeInTheDocument();
  expect(screen.getByText(PREVIEW.sms.body)).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});

test('a channel the server turned off shows its reason and no box to tick; with none on, Send stays off', async () => {
  serve({ preview: { data: { ...PREVIEW, channels: { email: { available: true, default: true }, sms: { available: false, default: false, unavailable_reason: 'Client has opted out of SMS.' } } } } });
  const { unmount } = render(<ResendSheet proposal={PROPOSAL} onClose={() => {}} />);
  await act(async () => {});
  expect(screen.getByText('Text message unavailable: Client has opted out of SMS.')).toBeInTheDocument();
  expect(screen.queryByRole('checkbox', { name: 'Text message' })).not.toBeInTheDocument();
  unmount();

  serve({ preview: { data: { ...PREVIEW, channels: { email: { available: false, unavailable_reason: 'No email on file.' }, sms: { available: false, unavailable_reason: 'No usable phone on file.' } } } } });
  await mount();
  expect(screen.getByText('Email unavailable: No email on file.')).toBeInTheDocument();
  expect(screen.getByText('Fix the client record first, then reopen this send.')).toBeInTheDocument();
  expect(sendBtn()).toBeDisabled();
});

test('Send reads the proposal fresh, then posts the channels picked and the drafted words, once under a double tap', async () => {
  const answer = deferred();
  serve({ send: () => answer.promise });
  await mount();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Text message' }));
  fireEvent.click(sendBtn());
  fireEvent.click(sendBtn());
  await act(async () => {});
  expect(freshReads()).toHaveLength(1);
  expect(api.get).toHaveBeenCalledWith('/proposals/41', { timeout: 10000 });
  expect(sends()).toHaveLength(1);
  expect(sends()[0][1]).toEqual({
    action: 'proposal_resend', entity_id: 41, channels: ['email'],
    email: { subject: PREVIEW.email.subject, body_text: PREVIEW.email.bodyText },
  });
  await act(async () => { answer.resolve({ data: { ...SENT_BOTH, sms: 'skipped', skip_reasons: { sms: 'not selected' } } }); });
  expect(screen.getByText('Emailed client41@example.test.')).toBeInTheDocument();
  expect(screen.queryByText(/Text/)).not.toBeInTheDocument();
});

test("a partial answer reads per channel in the desktop's words, and Retry sends only the failed channel, flagged retry", async () => {
  let n = 0;
  serve({
    send: () => {
      n += 1;
      return Promise.resolve({ data: n === 1
        ? { ...SENT_BOTH, sms: 'failed', sms_error: 'Carrier rejected the message.' }
        : { ...SENT_BOTH, email: 'skipped', skip_reasons: { email: 'not selected' } } });
    },
  });
  await mount();
  await act(async () => { fireEvent.click(sendBtn()); });
  expect(screen.getByText('Emailed client41@example.test.')).toBeInTheDocument();
  expect(screen.getByText('Text failed: Carrier rejected the message.')).toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
  expect(freshReads()).toHaveLength(2);
  expect(sends()).toHaveLength(2);
  expect(sends()[1][1]).toEqual({ action: 'proposal_resend', entity_id: 41, channels: ['sms'], retry: true, sms: { body: PREVIEW.sms.body } });
  expect(screen.getByText('Emailed client41@example.test.')).toBeInTheDocument();
  expect(screen.getByText('Texted (312) 555-0100.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
});

test('a send that got no answer says it may have gone, and offers no Retry and no second Send', async () => {
  serve({ send: () => Promise.reject({ status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' }) });
  await mount();
  await act(async () => { fireEvent.click(sendBtn()); });
  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent(SEND_NO_ANSWER);
  // Said above the drafted words, and brought into view: on a short phone
  // the words fill the body.
  expect(alert.compareDocumentPosition(screen.getByText(PREVIEW.email.subject)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(document.activeElement).toBe(alert);
  expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Send/ })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
  expect(sends()).toHaveLength(1);
});

test('a server error after the send was asked for is treated the same way', async () => {
  serve({ send: () => Promise.reject({ status: 500, code: 'INTERNAL', message: 'Something went wrong. Please try again.' }) });
  await mount();
  await act(async () => { fireEvent.click(sendBtn()); });
  expect(screen.getByRole('alert')).toHaveTextContent(SEND_UNSURE);
  expect(screen.queryByRole('button', { name: /^Send/ })).not.toBeInTheDocument();
});

test("a refusal before anything went out reads in the server's words, and Send stays", async () => {
  serve({ send: () => Promise.reject({ status: 400, code: 'VALIDATION_ERROR', message: "This proposal can't be resent from its current status (completed).", fieldErrors: {} }) });
  await mount();
  await act(async () => { fireEvent.click(sendBtn()); });
  expect(screen.getByRole('alert')).toHaveTextContent("This proposal can't be resent from its current status (completed).");
  expect(sendBtn()).toBeEnabled();
});

test('a server LEGAL_HOLD refusal reads as the hold note', async () => {
  serve({ send: () => Promise.reject({ status: 409, code: 'LEGAL_HOLD', message: 'This booking is on legal hold and cannot be edited.' }) });
  await mount();
  await act(async () => { fireEvent.click(sendBtn()); });
  expect(screen.getByRole('alert')).toHaveTextContent(HOLD_NOTE);
});

test('a failed preview offers Retry, which asks again', async () => {
  let n = 0;
  serve({ preview: () => { n += 1; return n === 1 ? Promise.reject({ status: 0, code: 'NETWORK_ERROR' }) : Promise.resolve({ data: PREVIEW }); } });
  await mount();
  expect(screen.getByRole('alert')).toHaveTextContent(PREVIEW_FAILED);
  expect(sendBtn()).toBeDisabled();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
  expect(screen.getByText(PREVIEW.email.subject)).toBeInTheDocument();
  expect(sendBtn()).toBeEnabled();
});

test('a fresh read that finds the status moved, or the hold on, refuses without sending; the page reads again on close', async () => {
  for (const [over, text] of [[{ status: 'deposit_paid', amount_paid: '0.00' }, `${SHEET_MOVED} Nothing was sent.`], [{ legal_hold: true }, HOLD_NOTE]]) {
    api.get.mockResolvedValue(fresh(over));
    serve({ send: () => Promise.resolve({ data: SENT_BOTH }) });
    const onClose = jest.fn();
    const { unmount } = render(<ResendSheet proposal={PROPOSAL} onClose={onClose} />);
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {});
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { fireEvent.click(sendBtn()); });
    expect(screen.getByRole('alert')).toHaveTextContent(text);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledWith({ moved: true });
    unmount();
  }
  expect(sends()).toHaveLength(0);
});

test('a fresh read that fails or comes from the stored copy says nothing was sent, and Send stays', async () => {
  serve({ send: () => Promise.resolve({ data: SENT_BOTH }) });
  api.get.mockResolvedValue({ ...fresh(), staleAt: '2026-11-05T15:00:00Z' });
  await mount();
  await act(async () => { fireEvent.click(sendBtn()); });
  expect(screen.getByRole('alert')).toHaveTextContent(SEND_OFFLINE);
  expect(sends()).toHaveLength(0);
  expect(sendBtn()).toBeEnabled();
});

test('nothing closes it while a send is out', async () => {
  const answer = deferred();
  serve({ send: () => answer.promise });
  const { onClose } = await mount();
  fireEvent.click(sendBtn());
  await act(async () => {});
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Close', hidden: true }));
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => { answer.resolve({ data: SENT_BOTH }); });
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(onClose).toHaveBeenCalledWith({ moved: false });
});

describe('the remote staffing fee comes first, as on the desktop', () => {
  const asks = (should) => api.get.mockImplementation((url) => (url === '/proposals/41/remote-staffing-check'
    ? Promise.resolve({ data: { should_prompt: should } })
    : Promise.resolve(fresh())));
  test('when the server says to prompt, the sheet sends nothing and hands the resend to desktop view', async () => {
    asks(true);
    serve({ send: () => Promise.resolve({ data: SENT_BOTH }) });
    const onDesktop = jest.fn();
    render(<ResendSheet proposal={PROPOSAL} onClose={() => {}} onDesktop={onDesktop} />);
    await act(async () => {});
    // A first geocode can wait behind a queued lookup; the desktop waits with no limit.
    expect(api.get).toHaveBeenCalledWith('/proposals/41/remote-staffing-check', { timeout: 30000 });
    expect(screen.getByRole('alert')).toHaveTextContent(FEE_FIRST);
    expect(screen.queryByRole('button', { name: /^Send/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Desktop view' }));
    expect(onDesktop).toHaveBeenCalledTimes(1);
    expect(sends()).toHaveLength(0);
  });
  test('when it says not to, or the check fails, the resend goes on here', async () => {
    for (const answer of [() => asks(false), () => api.get.mockImplementation((url) => (url.endsWith('/remote-staffing-check') ? Promise.reject({ status: 0, code: 'NETWORK_ERROR' }) : Promise.resolve(fresh())))]) {
      answer();
      serve();
      const { unmount } = render(<ResendSheet proposal={PROPOSAL} onClose={() => {}} />);
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {});
      expect(sendBtn()).toBeEnabled();
      unmount();
    }
  });
  test('an accepted proposal is already signed and is never asked', async () => {
    asks(true);
    serve();
    render(<ResendSheet proposal={{ ...PROPOSAL, status: 'accepted' }} onClose={() => {}} />);
    await act(async () => {});
    expect(api.get).not.toHaveBeenCalledWith('/proposals/41/remote-staffing-check', expect.anything());
    expect(sendBtn()).toBeEnabled();
  });
});

test('a send Back left out holds every sheet opened on the proposal: no Send while it is out, and one warning after it ends unseen', async () => {
  const answer = deferred();
  serve({ send: () => answer.promise });
  const first = render(<ResendSheet proposal={PROPOSAL} onClose={() => {}} />);
  await act(async () => {});
  fireEvent.click(sendBtn());
  await act(async () => {});
  expect(sends()).toHaveLength(1);
  first.unmount();   // Back pops the sheet's entry while the send is out

  const second = render(<ResendSheet proposal={PROPOSAL} onClose={() => {}} />);
  await act(async () => {});
  expect(screen.getByRole('alert')).toHaveTextContent(EARLIER_SEND);
  expect(screen.queryByRole('button', { name: /^Send/ })).not.toBeInTheDocument();
  second.unmount();

  await act(async () => { answer.resolve({ data: SENT_BOTH }); });
  const third = render(<ResendSheet proposal={PROPOSAL} onClose={() => {}} />);
  await act(async () => {});
  expect(screen.getByRole('alert')).toHaveTextContent(EARLIER_SEND);
  third.unmount();

  // Told once: the next sheet sends again as usual.
  render(<ResendSheet proposal={PROPOSAL} onClose={() => {}} />);
  await act(async () => {});
  expect(sendBtn()).toBeEnabled();
  expect(sends()).toHaveLength(1);
});

test("the answer takes focus as it shows, so a screen reader reads it", async () => {
  serve({ send: () => Promise.resolve({ data: SENT_BOTH }) });
  await mount();
  await act(async () => { fireEvent.click(sendBtn()); });
  expect(document.activeElement).toBe(screen.getByRole('status'));
});

test('the scrim takes no tap in the first moment after the sheet opens, and closes it after', async () => {
  serve();
  const now = jest.spyOn(Date, 'now');
  try {
    now.mockReturnValue(1000000);
    const { onClose } = await mount();
    now.mockReturnValue(1000000 + 200);
    fireEvent.click(screen.getByRole('button', { name: 'Close', hidden: true }));
    expect(onClose).not.toHaveBeenCalled();
    now.mockReturnValue(1000000 + 600);
    fireEvent.click(screen.getByRole('button', { name: 'Close', hidden: true }));
    expect(onClose).toHaveBeenCalledWith({ moved: false });
  } finally {
    now.mockRestore();
  }
});

test('Back during the fresh read: the closed sheet sends nothing, and a sheet opened meanwhile is held until it ends', async () => {
  const firstRead = deferred();
  let reads = 0;
  api.get.mockImplementation((url) => {
    if (url !== '/proposals/41') return Promise.resolve(fresh());
    reads += 1;
    return reads === 1 ? firstRead.promise : Promise.resolve(fresh());
  });
  serve({ send: () => Promise.resolve({ data: SENT_BOTH }) });
  const first = render(<ResendSheet proposal={PROPOSAL} onClose={() => {}} />);
  await act(async () => {});
  fireEvent.click(sendBtn());   // the fresh read goes out: "Sending"
  await act(async () => {});
  first.unmount();              // Back pops the sheet while the read is out

  const second = render(<ResendSheet proposal={PROPOSAL} onClose={() => {}} />);
  await act(async () => {});
  expect(screen.getByRole('alert')).toHaveTextContent(EARLIER_SEND);
  expect(screen.queryByRole('button', { name: /^Send/ })).not.toBeInTheDocument();
  second.unmount();

  await act(async () => { firstRead.resolve(fresh()); });
  expect(sends()).toHaveLength(0);   // the closed sheet posts nothing once its read lands

  // Nothing went out, so the next sheet sends as usual.
  render(<ResendSheet proposal={PROPOSAL} onClose={() => {}} />);
  await act(async () => {});
  expect(sendBtn()).toBeEnabled();
  await act(async () => { fireEvent.click(sendBtn()); });
  expect(sends()).toHaveLength(1);
});

test('a sheet opened before an earlier send ended unseen is held at its tap, once', async () => {
  const answer = deferred();
  serve({ send: () => answer.promise });
  const first = render(<ResendSheet proposal={PROPOSAL} onClose={() => {}} />);
  await act(async () => {});
  fireEvent.click(sendBtn());
  await act(async () => {});
  expect(sends()).toHaveLength(1);
  first.unmount();
  // This sheet opens while the send is out, so it is held from the start; after
  // the send ends unseen, a sheet already open is held at its own tap too.
  await act(async () => { answer.resolve({ data: SENT_BOTH }); });
  render(<ResendSheet proposal={PROPOSAL} onClose={() => {}} />);
  await act(async () => {});
  expect(screen.getByRole('alert')).toHaveTextContent(EARLIER_SEND);
  expect(sends()).toHaveLength(1);
});

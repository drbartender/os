// Unit tests for sendResult.js: the toast line and the per-channel result line
// for a send that queued a GV post into the Thumbtack thread (plan Task 11 of
// docs/superpowers/plans/2026-10-17-tt-proposal-link-via-gv.md), and the relay
// body check the SendModal mirrors from POST /api/comms/send.
import { describeSendResult, channelResultLine, relayBodyProblem, relayBodyLength } from './sendResult';

const TOKEN = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
const OTHER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const LINK = `https://drbartender.com/proposal/${TOKEN}`;
const DEFAULT_BODY = `Hi, your proposal is ready: ${LINK}`;
const RELAY = { sms: { via: 'thumbtack', max_chars: 320, phone_last4: '0123' } };

describe('describeSendResult', () => {
  test('queued sms reads Queued for Thumbtack at success level', () => {
    const r = describeSendResult({ sms: 'queued', sms_route: 'thumbtack', email: 'skipped', skip_reasons: { email: 'not selected' } });
    expect(r).toEqual({ hadFailure: false, level: 'success', message: 'Queued for Thumbtack.' });
  });

  test('email sent plus sms queued reads both clauses', () => {
    const r = describeSendResult({ email: 'sent', recipient_email: 'pat@example.test', sms: 'queued' });
    expect(r.message).toBe('Emailed pat@example.test. Queued for Thumbtack.');
    expect(r.level).toBe('success');
  });

  test('email failed plus sms queued is still a failure', () => {
    const r = describeSendResult({ email: 'failed', email_error: 'bounced', sms: 'queued' });
    expect(r.hadFailure).toBe(true);
    expect(r.message).toBe('Email failed: bounced. Queued for Thumbtack.');
  });
});

describe('channelResultLine', () => {
  test('channelResultLine queued reads Queued for Thumbtack ending 0123', () => {
    expect(channelResultLine('sms', { sms: 'queued', sms_route: 'thumbtack' }, RELAY)).toEqual({
      kind: 'queued', text: 'Queued for Thumbtack (ending 0123)',
    });
    // Without a last 4 the line still reads queued.
    expect(channelResultLine('sms', { sms: 'queued' }, {})).toEqual({ kind: 'queued', text: 'Queued for Thumbtack' });
  });

  test('channelResultLine failed keeps kind failed', () => {
    expect(channelResultLine('sms', { sms: 'failed', sms_error: 'Carrier rejected' }, RELAY)).toEqual({
      kind: 'failed', text: 'Text failed: Carrier rejected',
    });
    expect(channelResultLine('email', { email: 'failed' }, {})).toEqual({
      kind: 'failed', text: 'Email failed: Please try again.',
    });
  });

  test('sent and skipped lines', () => {
    expect(channelResultLine('email', { email: 'sent', recipient_email: 'pat@example.test' }, {})).toEqual({
      kind: 'sent', text: 'Emailed pat@example.test',
    });
    expect(channelResultLine('sms', { sms: 'sent', recipient_phone: '(312) 555-0142' }, {})).toEqual({
      kind: 'sent', text: 'Texted (312) 555-0142',
    });
    expect(channelResultLine('sms', { sms: 'skipped', skip_reasons: { sms: 'Client has opted out of SMS.' } }, {})).toEqual({
      kind: 'skipped', text: 'Text skipped: Client has opted out of SMS.',
    });
    expect(channelResultLine('email', { email: 'skipped' }, {})).toEqual({ kind: 'skipped', text: 'Email skipped' });
  });
});

describe('relayBodyProblem', () => {
  test('the default body passes', () => {
    expect(relayBodyProblem(DEFAULT_BODY, DEFAULT_BODY, 320)).toBe(null);
  });

  test('no link, two links, another link and over the cap each read the server message', () => {
    expect(relayBodyProblem('Hi there', DEFAULT_BODY, 320)).toBe('The text must include the proposal link.');
    expect(relayBodyProblem(`${LINK} and ${LINK}`, DEFAULT_BODY, 320)).toBe('The text can carry only one proposal link.');
    expect(relayBodyProblem(`See https://drbartender.com/proposal/${OTHER}`, DEFAULT_BODY, 320))
      .toBe("The text links a different proposal. Use this proposal's link.");
    expect(relayBodyProblem(`See https://example.test/proposal/${TOKEN}`, DEFAULT_BODY, 320))
      .toBe("The text links a different proposal. Use this proposal's link.");
    expect(relayBodyProblem(`${LINK} ${'x'.repeat(320)}`, DEFAULT_BODY, 320)).toBe('Thumbtack texts are capped at 320 characters.');
  });

  test('the link survives a case change and line breaks around it', () => {
    expect(relayBodyProblem(`Your proposal:\n${LINK.toUpperCase().replace('HTTPS://DRBARTENDER.COM', 'https://drbartender.com')}`, DEFAULT_BODY, 320)).toBe(null);
  });
});

describe('relayBodyLength', () => {
  test('counts the trimmed text, as the server does', () => {
    const body = `${LINK} ${'x'.repeat(320 - LINK.length - 1)}`;
    expect(body.length).toBe(320);
    expect(relayBodyLength(`${body}\n`)).toBe(320);
    expect(relayBodyLength(`  ${body} `)).toBe(320);
    expect(relayBodyProblem(`${body}\n`, DEFAULT_BODY, 320)).toBe(null);
    expect(relayBodyLength(`${body}y`)).toBe(321);
    expect(relayBodyProblem(`${body}y`, DEFAULT_BODY, 320)).toBe('Thumbtack texts are capped at 320 characters.');
  });
});

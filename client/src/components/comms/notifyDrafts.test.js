import '@testing-library/jest-dom';
import {
  SUBJECT_MAX, humanizeReason, initialDrafts, draftsOverCap, buildNotifyEntries, noticeOutcomes,
} from './notifyDrafts';

const notice = (over = {}) => ({
  type: 'event_details_changed', composable: true,
  channels: { email: { available: true, default: true }, sms: { available: true, default: false } },
  draft: { email: { subject: 'Your event moved', body_text: 'Hi' }, sms: { body: 'Moved' } },
  ...over,
});

test('humanizeReason names the columns in admin words and passes anything else through', () => {
  expect(humanizeReason('event_date changed')).toBe('Date changed');
  expect(humanizeReason('event_start_time changed')).toBe('Start time changed');
  expect(humanizeReason('event_location changed')).toBe('Location changed');
  expect(humanizeReason('something else')).toBe('something else');
});

test('initialDrafts ticks the channels that are available AND defaulted, and seeds the text', () => {
  expect(initialDrafts([notice()])).toEqual([{
    type: 'event_details_changed', channels: ['email'], subject: 'Your event moved', bodyText: 'Hi', smsBody: 'Moved',
  }]);
  expect(initialDrafts([notice({ channels: { email: { available: false, default: true } }, draft: {} })]))
    .toEqual([{ type: 'event_details_changed', channels: [], subject: '', bodyText: '', smsBody: '' }]);
});

test('draftsOverCap: a ticked channel with empty or over-long text is refused; untick it and it is not', () => {
  const n = [notice()];
  const d = initialDrafts(n);
  expect(draftsOverCap(n, d)).toBe(false);
  expect(draftsOverCap(n, [{ ...d[0], subject: '' }])).toBe(true);
  expect(draftsOverCap(n, [{ ...d[0], subject: 'x'.repeat(SUBJECT_MAX + 1) }])).toBe(true);
  expect(draftsOverCap(n, [{ ...d[0], channels: ['sms'], smsBody: '' }])).toBe(true);
  expect(draftsOverCap(n, [{ ...d[0], channels: [], subject: '' }])).toBe(false);
  expect(draftsOverCap([notice({ composable: false })], [{ ...d[0], subject: '' }])).toBe(false);
});

test('buildNotifyEntries: one entry per notice with a ticked channel, text only for a composable one', () => {
  const n = [notice()];
  expect(buildNotifyEntries(n, [{ ...initialDrafts(n)[0], channels: ['email', 'sms'] }])).toEqual([{
    type: 'event_details_changed', channels: ['email', 'sms'],
    email: { subject: 'Your event moved', body_text: 'Hi' }, sms: { body: 'Moved' },
  }]);
  expect(buildNotifyEntries(n, [{ ...initialDrafts(n)[0], channels: [] }])).toEqual([]);
  const fixed = [notice({ composable: false })];
  expect(buildNotifyEntries(fixed, initialDrafts(fixed))).toEqual([{ type: 'event_details_changed', channels: ['email'] }]);
});

test('missing notices never throw: no text rides, so the server refuses a composable notice instead', () => {
  const drafts = initialDrafts([notice()]);
  expect(buildNotifyEntries(undefined, drafts)).toEqual([{ type: 'event_details_changed', channels: ['email'] }]);
  expect(draftsOverCap(undefined, drafts)).toBe(false);
});

test('noticeOutcomes: failures, then real skips; "not selected" stays silent', () => {
  expect(noticeOutcomes([
    { email: 'failed', email_error: 'bounced', sms: 'skipped', skip_reasons: { sms: 'opted out' } },
    { email: 'skipped', sms: 'failed', skip_reasons: { email: 'not selected' } },
  ])).toEqual([
    { kind: 'error', text: 'Saved, but the email failed: bounced' },
    { kind: 'info', text: 'Saved. Text not sent: opted out' },
    { kind: 'error', text: 'Saved, but the text failed: unknown error' },
  ]);
  expect(noticeOutcomes([{ email: 'failed', email_error: 'a', sms: 'failed', sms_error: 'b' }])).toEqual([
    { kind: 'error', text: 'Saved, but the email failed: a' },
    { kind: 'error', text: 'Saved, but the text failed: b' },
  ]);
  expect(noticeOutcomes(undefined)).toEqual([]);
});

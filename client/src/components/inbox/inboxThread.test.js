import { threadModel } from './inboxThread';

// Tue Oct 6 2026, 2:40 PM Chicago.
const NOW = Date.parse('2026-10-06T19:40:00.000Z');
const row = (o) => ({
  ref: 'x', direction: 'in', channel: 'text', line: '1922', at: '2026-10-06T15:00:00.000Z',
  text: 'Hi', subject: null, author_name: null, auto: false, failed: false, failure_reason: null,
  media: [], relay_lead_name: null, ...o,
});

test('oldest first with a day separator on each Chicago day change', () => {
  const items = threadModel([
    row({ ref: 'sms:2', at: '2026-10-06T15:00:00.000Z' }),
    row({ ref: 'sms:1', at: '2026-10-04T02:00:00.000Z' }), // Sat Oct 3, 9 PM Chicago
    row({ ref: 'sms:3', at: '2026-10-06T16:00:00.000Z' }),
  ], NOW);
  expect(items.map((i) => (i.type === 'day' ? i.label : i.key))).toEqual(['Sat Oct 3', 'sms:1', 'Today', 'sms:2', 'sms:3']);
});

test('a bubble: channel tag, Chicago time, and on our side the author', () => {
  const [, inb, outb, auto, tt] = threadModel([
    row({ ref: 'sms:1', at: '2026-10-06T15:12:00.000Z' }),
    row({ ref: 'sms:2', direction: 'out', author_name: 'You', at: '2026-10-06T15:30:00.000Z' }),
    row({ ref: 'sms:3', direction: 'out', auto: true, channel: 'text', line: '888', at: '2026-10-06T15:31:00.000Z' }),
    row({ ref: 'tt:4', direction: 'out', channel: 'thumbtack', line: null, author_name: null, at: '2026-10-06T15:32:00.000Z' }),
  ], NOW);
  expect(inb).toMatchObject({ out: false, tag: 'Text 1922', meta: '10:12 AM' });
  expect(outb).toMatchObject({ out: true, tag: 'Text 1922', meta: 'You · 10:30 AM' });
  expect(auto).toMatchObject({ tag: 'Text 888', meta: 'Auto · 10:31 AM' });
  // A Thumbtack Business row has no known author: just the time.
  expect(tt).toMatchObject({ tag: 'Thumbtack', meta: '10:32 AM' });
});

test('system lines render the server copy, and say when a send never went out', () => {
  const items = threadModel([
    row({ ref: 'pal:9', direction: 'system', channel: null, text: 'Proposal sent by Zul' }),
    row({ ref: 'pal:10', direction: 'system', channel: null, text: 'You sent the proposal', failed: true, failure_reason: 'No email or text went out', at: '2026-10-06T15:01:00.000Z' }),
  ], NOW);
  expect(items[1]).toEqual({ type: 'sys', key: 'pal:9', text: 'Proposal sent by Zul', failure: null });
  expect(items[2]).toEqual({ type: 'sys', key: 'pal:10', text: 'You sent the proposal', failure: 'No email or text went out' });
});

test('a failed send says Not delivered with the reason; an email shows its subject', () => {
  const items = threadModel([
    row({ ref: 'sms:5', direction: 'out', author_name: 'Zul', failed: true, failure_reason: 'Carrier filtered (30007)' }),
    row({ ref: 'sms:6', direction: 'out', author_name: 'Zul', failed: true, failure_reason: null, at: '2026-10-06T15:01:00.000Z' }),
    row({ ref: 'ml:7', direction: 'out', channel: 'email', line: null, subject: 'Your shopping list', text: '', author_name: 'You', at: '2026-10-06T15:02:00.000Z' }),
  ], NOW);
  expect(items[1]).toMatchObject({ failed: true, failure: 'Not delivered: Carrier filtered (30007)' });
  expect(items[2]).toMatchObject({ failed: true, failure: 'Not delivered' });
  expect(items[3]).toMatchObject({ tag: 'Email', subject: 'Your shopping list', body: '(no text)' });
});

test('a picture message links each piece of media; a relay names its lead', () => {
  const items = threadModel([
    row({
      ref: 'sms:8', text: '',
      media: [{ url: 'https://example.test/m/1', content_type: 'image/jpeg' }, { url: 'https://example.test/m/2', content_type: 'text/vcard' }],
    }),
    row({ ref: 'sms:9', channel: 'text', line: '888', relay_lead_name: 'Jo Test', at: '2026-10-06T15:05:00.000Z' }),
  ], NOW);
  expect(items[1].body).toBe('');
  expect(items[1].media.map((m) => [m.label, m.url])).toEqual([['Photo', 'https://example.test/m/1'], ['Attachment', 'https://example.test/m/2']]);
  expect(items[2].relay).toBe('Thumbtack relay for Jo Test');
});

// A media link is https only on the client too (the server sends https
// links): anything else, a javascript: or data: URL included, is dropped.
test('media links are https only: a javascript:, data: or http: URL is dropped', () => {
  const items = threadModel([
    row({
      ref: 'sms:10', text: 'See this',
      media: [
        { url: 'javascript:alert(1)', content_type: 'image/png' },
        { url: 'data:text/html;base64,PGI+aGk8L2I+', content_type: 'text/html' },
        { url: 'http://example.test/m/3', content_type: 'image/png' },
        { url: 'HTTPS://example.test/m/4', content_type: 'image/png' },
      ],
    }),
  ], NOW);
  expect(items[1].media.map((m) => m.url)).toEqual(['HTTPS://example.test/m/4']);
});

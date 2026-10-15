const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chicagoYmdOf, eventLocalToUtc } = require('../businessTime');
const { ANSWERING_MESSAGE_TYPES } = require('../answeringMessageTypes');
const { parsePersonKey, personKey } = require('./personKey');
const C = require('./constants');

test('parsePersonKey: the four key shapes, ids kept as strings', () => {
  assert.deepEqual(parsePersonKey('c-12'), { type: 'c', id: '12' });
  assert.deepEqual(parsePersonKey('s-7'), { type: 's', id: '7' });
  assert.deepEqual(parsePersonKey('p-3125550100'), { type: 'p', id: '3125550100' });
  assert.deepEqual(parsePersonKey('t-123456789012345678'), { type: 't', id: '123456789012345678' });
  assert.deepEqual(parsePersonKey('t-neg_abc-1'), { type: 't', id: 'neg_abc-1' });
  assert.equal(typeof parsePersonKey('t-123456789012345678').id, 'string', 'never through Number()');
  assert.deepEqual(parsePersonKey('p-0012345678'), { type: 'p', id: '0012345678' }, 'a p- id may start with zeros');
  assert.deepEqual(parsePersonKey('c-2147483647'), { type: 'c', id: '2147483647' });
});

test('parsePersonKey: refuses everything else, including a second spelling of one row', () => {
  const bad = [null, undefined, 12, '', 'c-', 'x-1', 'c-1a', 'C-1', 'c--1', ' c-1', 'c-1 ', 't-', 't-a.b',
    't-a/b', `t-${'a'.repeat(101)}`, `p-${'1'.repeat(21)}`, 'c-007', 's-01', 'c-2147483648', 'actions'];
  for (const key of bad) assert.equal(parsePersonKey(key), null, `${String(key)} must not parse`);
});

test('personKey builds only keys that parse', () => {
  assert.equal(personKey('c', 12), 'c-12');
  assert.equal(personKey('p', '3125550100'), 'p-3125550100');
  assert.equal(personKey('t', '9876543210'), 't-9876543210');
  assert.equal(personKey('t', 'bad id'), null);
  assert.equal(personKey('c', null), null);
});

// Spec 2026-10-14 section 5.2: an unknown address is e-<16 hex of its
// SHA-256>, a Zola couple with no client is z-<zola_leads.id>.
test('parsePersonKey: e- is exactly 16 lowercase hex, z- a canonical int4', () => {
  const hex = '0123456789abcdef';
  assert.deepEqual(parsePersonKey(`e-${hex}`), { type: 'e', id: hex });
  assert.deepEqual(parsePersonKey('e-ffffffffffffffff'), { type: 'e', id: 'ffffffffffffffff' });
  assert.deepEqual(parsePersonKey('z-7'), { type: 'z', id: '7' });
  assert.deepEqual(parsePersonKey('z-2147483647'), { type: 'z', id: '2147483647' });
  const bad = [`e-${hex.slice(1)}`, `e-${hex}0`, 'e-0123456789ABCDEF', 'e-0123456789abcdeg', 'e-', 'E-0123456789abcdef',
    `e-${hex} `, 'z-07', 'z-2147483648', 'z-', 'z-1a', `z-${'1'.repeat(11)}`];
  for (const key of bad) assert.equal(parsePersonKey(key), null, `${key} must not parse`);
});

test('personKey builds e- and z- keys and round-trips them', () => {
  const hex = 'a1b2c3d4e5f60718';
  assert.equal(personKey('e', hex), `e-${hex}`);
  assert.deepEqual(parsePersonKey(personKey('e', hex)), { type: 'e', id: hex });
  assert.equal(personKey('z', 7), 'z-7');
  assert.deepEqual(parsePersonKey(personKey('z', 7)), { type: 'z', id: '7' });
  assert.equal(personKey('e', 'A1B2C3D4E5F60718'), null);
  assert.equal(personKey('z', '07'), null);
});

test('constants: the email and Zola feed values (spec 2026-10-14 sections 5 and 9)', () => {
  assert.equal(C.PERSONAL_ALIAS, 'dallas@drbartender.com');
  assert.equal(C.PERSONAL_MAILBOX_OWNER_USER_ID, 1);
  assert.equal(C.ZOLA_VENDOR_ADDRESS, 'weddingvendors@zola.com');
  assert.equal(C.ZOLA_RELAY_DOMAIN, 'vmkt-message.zola.com');
  assert.equal(C.ZOLA_UNREAD_TEXT, "Zola sent something the OS couldn't read. Open Zola.");
  assert.deepEqual(
    [C.EMAIL_LINE_MAX, C.EMAIL_PRECLIP_MAX, C.GMAIL_SYNC_MAX_PER_TICK, C.GMAIL_SYNC_TICK_MS, C.GMAIL_LEASE_SECONDS,
      C.GMAIL_SKIP_ATTEMPTS, C.ZOLA_CLIENT_DAILY_CAP],
    [4000, 8000, 50, 40000, 180, 3, 20]
  );
  assert.deepEqual([...C.DROPPED_SENDER_DOMAINS].sort(), ['accounts.google.com', 'cal.com', 'google.com', 'render.com',
    'sentry.io', 'stripe.com', 'thumbtack.com', 'twilio.com', 'vercel.com']);
  assert.throws(() => C.DROPPED_SENDER_DOMAINS.add('example.com'), TypeError);
});

test('constants: the no-reply and auto-reply patterns', () => {
  for (const local of ['no-reply', 'noreply', 'No.Reply', 'do-not-reply', 'donotreply', 'do.not.reply', 'notification',
    'notifications', 'mailer-daemon', 'MAILER-DAEMON', 'postmaster', 'alerts', 'newsletter']) {
    assert.ok(C.NO_REPLY_LOCAL_RE.test(local), `${local} is a machine sender`);
  }
  for (const local of ['pat', 'noreplyplease', 'alex.b', 'alert', 'news', 'info', 'reply']) {
    assert.ok(!C.NO_REPLY_LOCAL_RE.test(local), `${local} is not`);
  }
  for (const subject of ['Automatic reply: Your quote', 'Re: Auto-Reply', 'autoreply', 'Auto Response', 'auto-response',
    'Out of Office', 'Out of the office until Monday', 'RE: out of office']) {
    assert.ok(C.AUTO_REPLY_SUBJECT_RE.test(subject), `${subject} is an auto-reply`);
  }
  for (const subject of ['Re: Your quote', 'We will be out of office on the 6th, can you still come?', 'Fwd: Automatic reply',
    'Out offices']) {
    assert.ok(!C.AUTO_REPLY_SUBJECT_RE.test(subject), `${subject} is not`);
  }
});

test('constants: the Gmail and Zola links', () => {
  assert.equal(C.gmailThreadUrl('18c2f0a1b2c3d4e5'),
    'https://mail.google.com/mail/?authuser=contact%40drbartender.com#all/18c2f0a1b2c3d4e5');
  const uuid = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  assert.equal(C.zolaLeadUrl(uuid), `https://www.zola.com/inspire/vendors/leads/ready/${uuid}`);
  assert.equal(C.ZOLA_DASHBOARD_URL, 'https://www.zola.com/inspire/vendors/dashboard');
  for (const bad of [null, undefined, '', uuid.toUpperCase(), `${uuid}/../x`, 'not-a-uuid']) {
    assert.equal(C.zolaLeadUrl(bad), C.ZOLA_DASHBOARD_URL, `${String(bad)} opens the dashboard`);
  }
});

test('constants: the pinned windows and a parseable fixed floor', () => {
  assert.deepEqual(
    [C.CLAIM_HOURS, C.HOT_HOURS, C.HANDLED_DAYS, C.THREAD_DAYS, C.QUIET_HOURS, C.TT_MISSED_MINUTES,
      C.CALL_MIN_SECONDS, C.UNDO_SECONDS, C.CACHE_MS, C.BADGE_TIMEOUT_MS, C.BADGE_MAX_AGE_MS],
    [4, 24, 7, 30, 48, 15, 60, 60, 30000, 2000, 120000]
  );
  const floor = new Date(C.INBOX_HISTORY_START);
  assert.ok(!Number.isNaN(floor.getTime()));
  assert.ok(floor < new Date('2026-12-31T00:00:00Z'), 'a fixed literal, not a moving window');
  assert.equal(floor.getTime(), eventLocalToUtc(chicagoYmdOf(floor), 0, 0, 'America/Chicago').getTime(), 'midnight in Chicago');
  assert.equal(C.thumbtackInboxUrl('123'), 'https://www.thumbtack.com/pro-inbox/messages/123');
  for (const w of ['cancel', 'end', 'quit', 'yes', 'help', 'info']) {
    assert.ok(!C.UNAMBIGUOUS_STOP_WORDS.has(w) && !C.UNAMBIGUOUS_START_WORDS.has(w), `${w} is ambiguous and counts`);
  }
});

test('constants: THUMBTACK_PROXY_ROLLOUT is the instant the inbound code uses', () => {
  const dir = path.join(__dirname, '..');
  const hits = fs.readdirSync(dir).filter((f) => f.endsWith('.js'))
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- f is a server/utils file name from readdirSync, never input
    .map((f) => /const THUMBTACK_PROXY_ROLLOUT = '([^']+)'/.exec(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter(Boolean);
  assert.equal(hits.length, 1, 'exactly one server/utils file declares THUMBTACK_PROXY_ROLLOUT');
  assert.equal(C.THUMBTACK_PROXY_ROLLOUT, hits[0][1]);
});

// The words of a `const NAME = new Set([...])` declared in exactly one server/utils file.
function declaredSet(name) {
  const dir = path.join(__dirname, '..');
  // eslint-disable-next-line security/detect-non-literal-regexp -- name is one of this file's own literals (STOP_WORDS, START_WORDS)
  const re = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`);
  const hits = fs.readdirSync(dir).filter((f) => f.endsWith('.js'))
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- f is a server/utils file name from readdirSync, never input
    .map((f) => re.exec(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter(Boolean);
  assert.equal(hits.length, 1, `exactly one server/utils file declares ${name}`);
  return [...hits[0][1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('constants: OPT_WORDS is the STOP set plus the START set, less cancel, end, quit and yes', () => {
  const expected = new Set([...declaredSet('STOP_WORDS'), ...declaredSet('START_WORDS')]);
  for (const ambiguous of ['cancel', 'end', 'quit', 'yes']) expected.delete(ambiguous);
  assert.deepEqual([...C.OPT_WORDS].sort(), [...expected].sort());
  assert.equal(C.OPT_WORDS.size, 7);
});

test('constants: every answering message type has a Recently handled label', () => {
  for (const type of ANSWERING_MESSAGE_TYPES) assert.ok(C.SEND_LABELS.has(type), `${type} has no label`);
});

// Spec section 17 item 16: midnight Chicago, 30 days before the lane's
// 2026-10-08 cut. Moving it forward silently drops everyone still waiting
// behind the new floor; nothing on the page says they were ever there.
test('constants: the history floor is pinned', () => {
  assert.equal(C.INBOX_HISTORY_START, '2026-09-08T05:00:00.000Z');
});

test('constants: the shared word lists and the label map are read-only; reading them still works', () => {
  for (const words of [C.OPT_WORDS, C.UNAMBIGUOUS_STOP_WORDS, C.UNAMBIGUOUS_START_WORDS]) {
    assert.throws(() => words.add('hello'), TypeError);
    assert.throws(() => words.delete('stop'), TypeError);
    assert.throws(() => words.clear(), TypeError);
  }
  assert.equal(C.OPT_WORDS.size, 7, 'nothing was added or removed');
  assert.ok(C.OPT_WORDS.has('stop') && C.OPT_WORDS.has('unstop') && !C.OPT_WORDS.has('hello'));
  assert.deepEqual([...C.UNAMBIGUOUS_START_WORDS], ['start', 'unstop']);
  const seen = [];
  for (const w of C.UNAMBIGUOUS_STOP_WORDS) seen.push(w);
  assert.deepEqual(seen, ['stop', 'stopall', 'unsubscribe', 'optout', 'revoke']);
  assert.throws(() => C.SEND_LABELS.set('invoice_sent', 'something else'), TypeError);
  assert.throws(() => C.SEND_LABELS.delete('invoice_sent'), TypeError);
  assert.throws(() => C.SEND_LABELS.clear(), TypeError);
  assert.equal(C.SEND_LABELS.get('invoice_sent'), 'the invoice');
  assert.equal(new Map([...C.SEND_LABELS]).get('reschedule'), 'the event details');
  assert.equal(C.SEND_LABELS.size, 10);
});

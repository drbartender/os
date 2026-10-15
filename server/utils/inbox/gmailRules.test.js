// The counting rules at sync time (spec 2026-10-14 sections 5.2 and 5.5),
// pure. Every person, address and body here is invented; the only real
// addresses are the business mailbox, its personal alias and Zola's vendor
// address, which are system constants.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  headersOf, recipientsOf, addressOf, isBulk, isAutoReply, isBounce, classifyMessage, parseMessage,
  idsOfHistoryRecord, messageIdsIn, isDroppedDomain, ADDRESS_MAX, RECIPIENTS_MAX,
  isStrictZolaFrom,
} = require('./gmailRules');
const { zolaAuthPasses } = require('./zolaMail');
const { buildPeopleIndex } = require('./people');
const { GMAIL_MAILBOX } = require('../gmailClient');
const { PERSONAL_ALIAS, ZOLA_VENDOR_ADDRESS } = require('./constants');

const T = (iso) => new Date(iso);
const index = buildPeopleIndex({
  env: { ADMIN_EMAIL: 'desk@example.com', INBOX_OWN_EMAILS: 'old-business@example.com' },
  clients: [{ id: 501, name: 'Alex B', phone: null, email: 'alex.b@example.com', created_at: T('2026-09-01T00:00:00Z') }],
  staff: [{ id: 601, role: 'staff', phone: null, email: 'kai.staff@example.com', updated_at: T('2026-09-01T00:00:00Z'), name: 'Kai S.' }],
  operators: [{ id: 1, role: 'admin', phone: null, presence_nudge_phone: null, email: 'op-one@example.com', name: 'Op One' }],
});

const b64 = (s) => Buffer.from(s).toString('base64url');
// A Gmail message as users.messages.get?format=full returns it.
function mail({
  id = 'm1', threadId = 'th1', labels = ['INBOX', 'CATEGORY_PERSONAL', 'UNREAD'],
  from = 'Jamie Q <jamie.q@example.com>', to = GMAIL_MAILBOX, cc = null, bcc = null,
  subject = 'Bar for our party', body = 'Hi, do you have the 14th open?', extra = [],
  internalDate = Date.parse('2026-10-12T15:00:00Z'), messageId = '<a1@mail.example.com>', inReplyTo = null,
  references = null, parts = null, mimeType = 'text/plain',
} = {}) {
  const headers = [['From', from], ['To', to], ['Subject', subject], ['Message-ID', messageId]];
  if (cc) headers.push(['Cc', cc]);
  if (bcc) headers.push(['Bcc', bcc]);
  if (inReplyTo) headers.push(['In-Reply-To', inReplyTo]);
  if (references) headers.push(['References', references]);
  headers.push(...extra);
  const payload = parts
    ? { mimeType, headers: headers.map(([name, value]) => ({ name, value })), parts }
    : { mimeType, headers: headers.map(([name, value]) => ({ name, value })), body: { data: b64(body) } };
  return { id, threadId, labelIds: labels, internalDate: String(internalDate), payload };
}
function classify(message, { storedSentIds = new Set(), sentInThread = false } = {}) {
  const m = parseMessage(message);
  return classifyMessage({ ...m, index, storedSentIds, sentInThread });
}

// Authentication-Results values in mx.google.com's shape (invented selectors).
const authLine = (dkim, dmarc = 'pass') => `mx.google.com; dkim=${dkim} header.i=@zola.com header.s=sel1 header.b=AbC1; spf=pass smtp.mailfrom=bounce@zola.com; dmarc=${dmarc} (p=REJECT) header.from=zola.com`;
const zolaMail = (subject, auth = [authLine('pass')], over = {}) => mail({
  from: `Zola <${ZOLA_VENDOR_ADDRESS}>`, subject, labels: ['INBOX', 'CATEGORY_UPDATES'],
  extra: [...auth.map((v) => ['Authentication-Results', v]), ['List-Unsubscribe', '<https://example.com/u>']], ...over,
});

// The shape of a real Zola notice's Authentication-Results (2026-10-14; the
// Mandrill ids are placeholders): Mandrill's DKIM result comes BEFORE Zola's,
// folded across lines, dmarc last. The gate must pass it, or every Zola notice
// would drop as a gate failure.
const REAL_ZOLA_AUTH = 'mx.google.com;\r\n       dkim=pass header.i=@mandrillapp.com header.s=mte1 header.b=AbCd1234;\r\n'
  + '       dkim=pass header.i=@zola.com header.s=mte1 header.b=EfGh5678;\r\n'
  + '       spf=pass (google.com: domain of bounce-md_100.abc-def@mandrillapp.com designates 198.51.100.7 as permitted sender) smtp.mailfrom=bounce-md_100.abc-def@mandrillapp.com;\r\n'
  + '       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=zola.com';

test('a real Zola notice shape passes: two DKIM results with Mandrill first, folded, a quoted couple display name', () => {
  const m = zolaMail('New message from Alex B & Sam C for Dr. Bartender', [REAL_ZOLA_AUTH], { from: `"Alex B & Sam C on Zola" <${ZOLA_VENDOR_ADDRESS}>` });
  const v = classify(m);
  assert.equal(v.action, 'store');
  assert.equal(v.kind, 'zola_unparsed');
  assert.equal(v.zola.template, 'message');
  const encoded = classify(zolaMail('New message from Alex B & Sam C for Dr. Bartender', [REAL_ZOLA_AUTH], { from: `=?utf-8?Q?Alex_B_&_Sam_C_on_Zola?= <${ZOLA_VENDOR_ADDRESS}>` }));
  assert.equal(encoded.kind, 'zola_unparsed');
});

test('the Zola branch needs a strict From: a group, a list, a comment or a stray character is a gate failure even with a passing header', () => {
  for (const from of [
    `x: ${ZOLA_VENDOR_ADDRESS};`, `${ZOLA_VENDOR_ADDRESS}(`, `${ZOLA_VENDOR_ADDRESS} (Zola)`, `Bad(c) <${ZOLA_VENDOR_ADDRESS}>`,
    `"A" <${ZOLA_VENDOR_ADDRESS}>, b@example.com`, `"unterminated <${ZOLA_VENDOR_ADDRESS}>`,
  ]) {
    const v = classify(zolaMail('New Zola inquiry for Dr. Bartender', [REAL_ZOLA_AUTH], { from }));
    assert.notEqual(v.action, 'store', from);
  }
  assert.equal(isStrictZolaFrom(`Zola <${ZOLA_VENDOR_ADDRESS}>`), true);
  assert.equal(isStrictZolaFrom(ZOLA_VENDOR_ADDRESS.toUpperCase()), true);
  assert.equal(isStrictZolaFrom(`x: ${ZOLA_VENDOR_ADDRESS};`), false);
});

test('headersOf keeps the FIRST value of a repeated header, lowercases names, and skips junk entries', () => {
  const h = headersOf({ headers: [
    { name: 'Received', value: 'top' }, { name: 'received', value: 'bottom' },
    { name: 'X-Thing', value: 'one' }, null, { name: 5, value: 'x' }, { name: 'No-Value' }, { value: 'no name' },
  ] });
  assert.equal(h.get('received'), 'top');
  assert.equal(h.get('x-thing'), 'one');
  assert.equal(h.has('no-value'), false);
  assert.equal(headersOf(null).size, 0);
  assert.equal(headersOf({}).size, 0);
});

test('a forged dkim=pass Authentication-Results below a real fail line does not pass the gate', () => {
  const forged = zolaMail('New message from Alex B & Sam C for Dr. Bartender', [authLine('fail'), authLine('pass')]);
  assert.equal(zolaAuthPasses(headersOf(forged.payload)), false, 'Google writes its line on top; a later copy may be forged');
  const real = zolaMail('New message from Alex B & Sam C for Dr. Bartender', [authLine('pass'), authLine('fail')]);
  assert.equal(zolaAuthPasses(headersOf(real.payload)), true, 'the topmost line decides');
  assert.deepEqual(classify(forged), { action: 'drop', reason: 'zola_gate' });
});

test('recipientsOf: To, Cc and Bcc, lowercased, quoted commas, groups and comments, deduped, junk dropped', () => {
  const h = new Map([
    ['to', '"B, Sam" <Sam.C@Example.com>, alex.b@example.com (Alex), Friends: lee@example.com, kim@example.com;'],
    ['cc', 'undisclosed-recipients:;, ALEX.B@EXAMPLE.COM, not an address'],
    ['bcc', '<pat@example.com>'],
  ]);
  assert.deepEqual(recipientsOf(h), ['sam.c@example.com', 'alex.b@example.com', 'lee@example.com', 'kim@example.com', 'pat@example.com']);
  assert.deepEqual(recipientsOf(new Map()), []);
});

test('addressOf reads the display name and the address', () => {
  assert.deepEqual(addressOf('"Q, Jamie" <Jamie.Q@Example.com>'), { address: 'jamie.q@example.com', name: 'Q, Jamie' });
  assert.deepEqual(addressOf('jamie.q@example.com'), { address: 'jamie.q@example.com', name: null });
  assert.equal(addressOf('nobody'), null);
  assert.equal(addressOf(''), null);
});

test('isBulk: outside Primary, List-Unsubscribe, Precedence bulk, list or junk', () => {
  const primary = ['INBOX', 'CATEGORY_PERSONAL'];
  assert.equal(isBulk(new Map(), primary), false);
  assert.equal(isBulk(new Map(), ['INBOX', 'CATEGORY_UPDATES']), true);
  assert.equal(isBulk(new Map([['list-unsubscribe', '<mailto:u@example.com>']]), primary), true);
  for (const p of ['bulk', 'List', ' junk ']) assert.equal(isBulk(new Map([['precedence', p]]), primary), true, p);
  assert.equal(isBulk(new Map([['precedence', 'first-class']]), primary), false);
});

test('isAutoReply: the headers, the subject pattern, and a calendar-only Sent row', () => {
  const none = new Map();
  assert.equal(isAutoReply(new Map([['auto-submitted', 'auto-replied']]), 'Hi', false), true);
  assert.equal(isAutoReply(new Map([['auto-submitted', 'No']]), 'Hi', false), false);
  assert.equal(isAutoReply(new Map([['x-autoreply', 'yes']]), 'Hi', false), true);
  assert.equal(isAutoReply(new Map([['x-auto-response-suppress', 'All']]), 'Hi', false), true);
  assert.equal(isAutoReply(new Map([['precedence', 'auto_reply']]), 'Hi', false), true);
  for (const s of ['Out of Office: back Monday', 'Re: Automatic reply: Bar for our party', 'Autoreply', 'Auto-Response', 'out of the office']) {
    assert.equal(isAutoReply(none, s, false), true, s);
  }
  assert.equal(isAutoReply(none, 'Re: are you out of office hours?', false), false);
  assert.equal(isAutoReply(none, 'Re: Bar for our party', true), true, 'calendar only');
});

test('isBounce: Google\'s mailer-daemon or postmaster, or a Google auto-replied multipart/report, and nobody else', () => {
  assert.equal(isBounce(new Map([['from', 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>']]), {}), true);
  assert.equal(isBounce(new Map([['from', 'MAILER-DAEMON@google.com']]), {}), true);
  assert.equal(isBounce(new Map([['from', 'postmaster@googlemail.com']]), {}), true);
  const report = (from) => new Map([['from', from], ['auto-submitted', 'auto-replied'], ['content-type', 'multipart/report; report-type=delivery-status']]);
  assert.equal(isBounce(report('robot@google.com'), {}), true);
  assert.equal(isBounce(new Map([['from', 'robot@google.com'], ['auto-submitted', 'auto-replied']]), { mimeType: 'multipart/report' }), true);
  assert.equal(isBounce(new Map([['from', 'robot@google.com'], ['auto-submitted', 'auto-replied']]), { mimeType: 'text/plain' }), false);
  // All our mail leaves through Gmail, so a real delivery report is Google's.
  assert.equal(isBounce(new Map([['from', 'postmaster@mail.example.net']]), {}), false, 'a mailer-daemon anywhere else is no bounce');
  assert.equal(isBounce(new Map([['from', 'mailer-daemon@googlemail.com.evil.example']]), {}), false);
  assert.equal(isBounce(report('robot@mail.example.net'), {}), false);
  assert.equal(isBounce(new Map([['from', 'jamie.q@example.com']]), {}), false);
});

test('rule 1: DRAFT, SPAM and TRASH are never stored, Zola mail included', () => {
  for (const label of ['DRAFT', 'SPAM', 'TRASH']) {
    assert.deepEqual(classify(mail({ labels: ['CATEGORY_PERSONAL', label] })), { action: 'drop', reason: 'label' }, label);
    assert.deepEqual(classify(zolaMail('New Zola inquiry for Dr. Bartender', [authLine('pass')], { labels: [label] })), { action: 'drop', reason: 'label' }, `Zola in ${label}`);
  }
});

test('rule 2: Zola goes to its own branch BEFORE the own-address rule', () => {
  assert.equal(index.ownEmails.has(ZOLA_VENDOR_ADDRESS), true, 'the vendor address is ours');
  assert.deepEqual(classify(zolaMail('New Zola inquiry for Dr. Bartender')),
    { action: 'store', kind: 'zola_unparsed', zola: { template: 'inquiry', label: null } });
  assert.deepEqual(classify(zolaMail('New message from Alex B & Sam C for Dr. Bartender')),
    { action: 'store', kind: 'zola_unparsed', zola: { template: 'message', label: 'Alex B & Sam C' } });
  assert.deepEqual(classify(zolaMail('Alex B & Sam C closed their inquiry')),
    { action: 'store', kind: 'zola_unparsed', zola: { template: 'closed', label: 'Alex B & Sam C' } });
  assert.deepEqual(classify(zolaMail('Booked! Alex B & Sam C')), { action: 'drop', reason: 'zola_booked' });
  assert.deepEqual(classify(zolaMail('Grow your business this season')), { action: 'drop', reason: 'zola_marketing' });
  assert.deepEqual(classify(zolaMail('New Zola inquiry for Dr. Bartender', [authLine('fail')])), { action: 'drop', reason: 'zola_gate' });
  assert.deepEqual(classify(zolaMail('New Zola inquiry for Dr. Bartender', [authLine('pass', 'fail')])), { action: 'drop', reason: 'zola_gate' });
  assert.deepEqual(classify(zolaMail('New Zola inquiry for Dr. Bartender', [])), { action: 'drop', reason: 'zola_gate' });
});

test('rule 3: a Sent mail to only our own addresses, or to a dropped domain, is dropped', () => {
  const sent = (over) => mail({ labels: ['SENT'], from: GMAIL_MAILBOX, ...over });
  assert.deepEqual(classify(sent({ to: `${PERSONAL_ALIAS}, desk@example.com`, cc: 'Old <old-business@example.com>' })), { action: 'drop', reason: 'own_only' });
  assert.deepEqual(classify(sent({ to: 'jamie.q@example.com', cc: 'reply+abc@messages.thumbtack.com' })), { action: 'drop', reason: 'dropped_domain' });
  assert.deepEqual(classify(sent({ to: 'jamie.q@example.com', cc: PERSONAL_ALIAS })), { action: 'store', kind: 'message' });
  assert.deepEqual(classify(sent({ to: 'reply-xyz@vmkt-message.zola.com' })), { action: 'store', kind: 'message' }, 'a reply to Zola is a stored Sent row');
});

test('rules 4 and 5: inbound from our own address or a dropped domain is dropped', () => {
  for (const from of [GMAIL_MAILBOX, PERSONAL_ALIAS, 'Op One <op-one@example.com>', 'desk@example.com', 'old-business@example.com']) {
    assert.deepEqual(classify(mail({ from })), { action: 'drop', reason: 'own_sender' }, from);
  }
  for (const from of ['info@thumbtack.com', 'receipts@mail.stripe.com', 'calendar-notification@google.com', 'hello@cal.com']) {
    assert.deepEqual(classify(mail({ from })), { action: 'drop', reason: 'dropped_domain' }, from);
  }
  assert.deepEqual(classify(mail({ from: 'invented-staffer@drbartender.com' })), { action: 'store', kind: 'message' }, 'not the whole domain');
});

test('rule order: own and dropped-domain senders are dropped before the auto-reply rule, inbound and Sent', () => {
  const auto = [['Auto-Submitted', 'auto-replied']];
  assert.deepEqual(classify(mail({ from: 'info@thumbtack.com', extra: auto })), { action: 'drop', reason: 'dropped_domain' });
  assert.deepEqual(classify(mail({ from: 'Old <old-business@example.com>', subject: 'Out of office' })), { action: 'drop', reason: 'own_sender' });
  const sent = (to) => mail({ labels: ['SENT'], from: GMAIL_MAILBOX, to, subject: 'Automatic reply: thanks' });
  assert.deepEqual(classify(sent('reply+abc@messages.thumbtack.com')), { action: 'drop', reason: 'dropped_domain' });
  assert.deepEqual(classify(sent(PERSONAL_ALIAS)), { action: 'drop', reason: 'own_only' });
});

test('rule 6: a bounce names only the Sent row In-Reply-To names, else the LAST stored References entry', () => {
  const dsn = (over) => mail({ from: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Failure)', ...over });
  const stored = new Set(['<s1@mail.gmail.com>', '<s2@mail.gmail.com>', '<s3@mail.gmail.com>']);
  assert.deepEqual(classify(dsn({ inReplyTo: '<s2@mail.gmail.com>', references: '<s1@mail.gmail.com> <s3@mail.gmail.com> <s2@mail.gmail.com>' }), { storedSentIds: stored }),
    { action: 'store', kind: 'bounce', bounced: ['<s2@mail.gmail.com>'], bouncedTo: [] });
  assert.deepEqual(classify(dsn({ inReplyTo: '<gone@mail.gmail.com>', references: '<s1@mail.gmail.com> <s3@mail.gmail.com> <x@mail.gmail.com>' }), { storedSentIds: stored }),
    { action: 'store', kind: 'bounce', bounced: ['<s3@mail.gmail.com>'], bouncedTo: [] });
});

test('rule 6: a mailer-daemon outside Google naming our Sent row is no bounce and marks nothing', () => {
  const forged = mail({ from: 'mailer-daemon@evil.example', inReplyTo: '<s1@mail.gmail.com>', extra: [['Auto-Submitted', 'auto-replied']] });
  assert.deepEqual(classify(forged, { storedSentIds: new Set(['<s1@mail.gmail.com>']) }), { action: 'store', kind: 'auto_reply' });
  const plain = mail({ from: 'postmaster@evil.example', inReplyTo: '<s1@mail.gmail.com>' });
  assert.deepEqual(classify(plain, { storedSentIds: new Set(['<s1@mail.gmail.com>']) }), { action: 'store', kind: 'message' }, 'an ordinary reply to our mail');
});

test('rule 6: a bounce naming a stored Sent row is stored and names it; a bounce naming nothing is dropped', () => {
  const bounce = mail({
    from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', subject: 'Delivery Status Notification (Failure)',
    inReplyTo: '<sent1@mail.gmail.com>', references: '<older@mail.gmail.com> <sent1@mail.gmail.com>',
    extra: [['Auto-Submitted', 'auto-replied']],
  });
  assert.deepEqual(classify(bounce, { storedSentIds: new Set(['<sent1@mail.gmail.com>']) }),
    { action: 'store', kind: 'bounce', bounced: ['<sent1@mail.gmail.com>'], bouncedTo: [] });
  assert.deepEqual(classify(bounce), { action: 'drop', reason: 'bounce_unmatched' });
  const fromGoogle = mail({ from: 'MAILER-DAEMON@google.com', inReplyTo: '<sent1@mail.gmail.com>' });
  assert.deepEqual(classify(fromGoogle, { storedSentIds: new Set(['<sent1@mail.gmail.com>']) }),
    { action: 'store', kind: 'bounce', bounced: ['<sent1@mail.gmail.com>'], bouncedTo: [] }, 'a bounce from a dropped domain still marks the reply');
});

test('rule 7: an auto-reply by header, by subject, and a calendar-only Sent row are stored as auto_reply', () => {
  assert.deepEqual(classify(mail({ extra: [['Auto-Submitted', 'auto-replied']] })), { action: 'store', kind: 'auto_reply' });
  assert.deepEqual(classify(mail({ from: 'alex.b@example.com', subject: 'Out of office until Monday' })), { action: 'store', kind: 'auto_reply' });
  const invite = mail({
    labels: ['SENT'], from: GMAIL_MAILBOX, to: 'jamie.q@example.com', mimeType: 'multipart/mixed',
    parts: [{ mimeType: 'text/calendar', filename: 'invite.ics', headers: [], body: { data: b64('BEGIN:VCALENDAR') } }],
  });
  assert.deepEqual(classify(invite), { action: 'store', kind: 'auto_reply' });
});

test('rule 8: a known client or staffer counts whatever the category', () => {
  const updates = ['INBOX', 'CATEGORY_UPDATES'];
  assert.deepEqual(classify(mail({ from: 'Alex.B@Example.com', labels: updates, extra: [['List-Unsubscribe', '<mailto:u@example.com>']] })), { action: 'store', kind: 'message' });
  assert.deepEqual(classify(mail({ from: 'kai.staff@example.com', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] })), { action: 'store', kind: 'message' });
});

test('rule 9: a reply to our stored Sent row counts whatever the category', () => {
  const updates = ['INBOX', 'CATEGORY_UPDATES'];
  const reply = mail({ from: 'events@venue.example.com', labels: updates, inReplyTo: '<sent1@mail.gmail.com>' });
  assert.deepEqual(classify(reply, { storedSentIds: new Set(['<sent1@mail.gmail.com>']) }), { action: 'store', kind: 'message' });
  assert.deepEqual(classify(mail({ from: 'events@venue.example.com', labels: updates }), { sentInThread: true }), { action: 'store', kind: 'message' });
  assert.deepEqual(classify(reply), { action: 'drop', reason: 'bulk' }, 'naming a row we never stored is no reply');
});

test('rule 10: an unknown sender counts only past the bulk filter', () => {
  assert.deepEqual(classify(mail()), { action: 'store', kind: 'message' }, 'unknown in Primary without bulk headers');
  assert.deepEqual(classify(mail({ labels: ['INBOX', 'CATEGORY_UPDATES'] })), { action: 'drop', reason: 'bulk' });
  assert.deepEqual(classify(mail({ extra: [['List-Unsubscribe', '<https://example.com/u>']] })), { action: 'drop', reason: 'bulk' });
  for (const p of ['bulk', 'list', 'junk']) {
    assert.deepEqual(classify(mail({ extra: [['Precedence', p]] })), { action: 'drop', reason: 'bulk' }, p);
  }
  for (const local of ['no-reply', 'noreply', 'Do-Not-Reply', 'donotreply', 'notifications', 'notification', 'alerts', 'newsletter', 'no.reply+tag']) {
    assert.deepEqual(classify(mail({ from: `${local}@shop.example.com` })), { action: 'drop', reason: 'bulk' }, local);
  }
  assert.deepEqual(classify(mail({ from: 'not-an-address' })), { action: 'drop', reason: 'no_sender' });
});

test('parseMessage reads what the row stores', () => {
  const m = parseMessage(mail({
    id: 'abc', threadId: 'th9', from: '"Q, Jamie" <Jamie.Q@Example.com>', to: 'contact@drbartender.com', cc: 'Sam C <sam.c@example.com>',
    subject: `  ${'s'.repeat(1200)}`, messageId: ' <a1@mail.example.com> ', inReplyTo: 'x <r1@mail.example.com> y',
    references: '<r0@mail.example.com>\r\n <r1@mail.example.com>',
  }));
  assert.equal(m.gmailId, 'abc');
  assert.equal(m.threadId, 'th9');
  assert.equal(m.direction, 'in');
  assert.equal(m.fromAddress, 'jamie.q@example.com');
  assert.equal(m.fromName, 'Q, Jamie');
  assert.deepEqual(m.recipients, ['contact@drbartender.com', 'sam.c@example.com']);
  assert.equal(m.subject.length, 1000, 'bounded');
  assert.equal(m.messageIdHeader, '<a1@mail.example.com>');
  assert.equal(m.inReplyTo, '<r1@mail.example.com>');
  assert.deepEqual(m.references, ['<r0@mail.example.com>', '<r1@mail.example.com>']);
  assert.equal(m.at.toISOString(), '2026-10-12T15:00:00.000Z');
  assert.equal(m.text, 'Hi, do you have the 14th open?');
  assert.equal(m.attachments, 0);
  assert.equal(parseMessage(mail({ labels: ['SENT', 'INBOX'] })).direction, 'out');
  assert.equal(parseMessage({ id: 'q', threadId: 'q', labelIds: [], payload: { headers: [] } }).messageIdHeader, null);
});

test('parseMessage drops NUL characters, which Postgres refuses in text', () => {
  const m = parseMessage(mail({ from: 'Ja\u0000mie <jamie.q@example.com>', subject: 'Hi\u0000 there', body: 'one\u0000two', messageId: '<a\u0000b@mail.example.com>' }));
  assert.deepEqual([m.fromName, m.subject, m.text, m.messageIdHeader], ['Jamie', 'Hi there', 'onetwo', '<ab@mail.example.com>']);
  assert.equal(parseMessage(mail({ body: '\u0000' })).text, null);
});

test('idsOfHistoryRecord: added ids except drafts, and ids that gained Primary, Inbox or Sent', () => {
  const rec = {
    id: '9001',
    messagesAdded: [
      { message: { id: 'a1', labelIds: ['INBOX'] } },
      { message: { id: 'd1', labelIds: ['DRAFT'] } },
      { message: { id: '../x', labelIds: ['INBOX'] } },
    ],
    labelsAdded: [
      { message: { id: 'p1' }, labelIds: ['CATEGORY_PERSONAL'] },
      { message: { id: 's1' }, labelIds: ['STARRED'] },
      { message: { id: 'i1' }, labelIds: ['INBOX'] },
    ],
  };
  assert.deepEqual(idsOfHistoryRecord(rec), ['a1', 'p1', 'i1']);
  assert.deepEqual(idsOfHistoryRecord({ id: '1' }), []);
  assert.deepEqual(idsOfHistoryRecord(null), []);
});

test('bounds: an address over 320 characters is no address; at most 200 recipients, deduplicated first', () => {
  assert.equal(ADDRESS_MAX, 320);
  const at320 = `${'a'.repeat(308)}@example.com`;
  assert.equal(at320.length, 320);
  assert.deepEqual(addressOf(at320), { address: at320, name: null });
  assert.equal(addressOf(`a${at320}`), null);
  assert.equal(RECIPIENTS_MAX, 200);
  const many = Array.from({ length: 250 }, (_, i) => `guest${i}@example.com`);
  const h = new Map([['to', ['guest0@example.com', 'guest0@example.com', ...many].join(', ')]]);
  const list = recipientsOf(h);
  assert.equal(list.length, 200);
  assert.equal(new Set(list).size, 200);
  assert.equal(list[199], 'guest199@example.com', 'duplicates spend nothing');
});

test('messageIdsIn and isDroppedDomain', () => {
  assert.deepEqual(messageIdsIn('<a@x.example> junk <b@y.example>\r\n <c@z.example>'), ['<a@x.example>', '<b@y.example>', '<c@z.example>']);
  assert.deepEqual(messageIdsIn(null), []);
  assert.deepEqual(messageIdsIn('<has space@x.example>'), []);
  assert.equal(isDroppedDomain('info@thumbtack.com'), true);
  assert.equal(isDroppedDomain('receipts@mail.stripe.com'), true, 'a subdomain');
  assert.equal(isDroppedDomain('pat@notstripe.com'), false, 'a lookalike is not a subdomain');
  assert.equal(isDroppedDomain('pat@stripe.com.evil.example'), false);
  assert.equal(isDroppedDomain('pat@example.com'), false);
});

// ─── review fixes, 2026-10-15 ───
const elapsedMs = (fn) => {
  const t = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
};

test('a draft, spam or trash message is dropped before any of its text is read (spec 5.5 step 4)', () => {
  for (const label of ['DRAFT', 'SPAM', 'TRASH']) {
    const m = parseMessage(mail({ labels: ['INBOX', 'CATEGORY_PERSONAL', label], body: 'Words nobody reads' }));
    assert.deepEqual([m.text, m.attachments, m.hasCalendarOnly], [null, 0, false], label);
    assert.deepEqual(classifyMessage({ ...m, index, storedSentIds: new Set(), sentInThread: false }), { action: 'drop', reason: 'label' }, label);
  }
  assert.equal(parseMessage(mail()).text, 'Hi, do you have the 14th open?');
});

test('idsOfHistoryRecord: an id added in Spam or Trash is not read; rescued, it arrives as a label gained and is', () => {
  const added = {
    messagesAdded: [
      { message: { id: 'sp1', labelIds: ['SPAM', 'CATEGORY_PERSONAL', 'UNREAD'] } },
      { message: { id: 'tr1', labelIds: ['TRASH'] } },
      { message: { id: 'ok1', labelIds: ['INBOX', 'CATEGORY_PERSONAL'] } },
      { message: { id: 'nolabels' } },
    ],
  };
  assert.deepEqual(idsOfHistoryRecord(added), ['ok1', 'nolabels']);
  const rescued = {
    labelsAdded: [
      { message: { id: 'sp1', labelIds: ['INBOX', 'CATEGORY_PERSONAL'] }, labelIds: ['INBOX'] },
      { message: { id: 'tr1', labelIds: ['INBOX'] }, labelIds: ['INBOX'] },
      { message: { id: 'sp2', labelIds: ['INBOX', 'CATEGORY_PERSONAL'] }, labelIds: ['CATEGORY_PERSONAL'] },
    ],
  };
  assert.deepEqual(idsOfHistoryRecord(rescued), ['sp1', 'tr1', 'sp2']);
});

test('the strict Zola From check is linear and refuses anything over 400 characters', () => {
  // Before the fix 2,000 spaces took 2.7 s and 4,000 took 21.8 s (cubic backtracking).
  for (const n of [2000, 4000, 100000]) {
    const value = `${' '.repeat(n)};<${ZOLA_VENDOR_ADDRESS}>`;
    let verdict;
    const ms = elapsedMs(() => { verdict = isStrictZolaFrom(value); });
    assert.equal(verdict, false, `${n} spaces`);
    assert.ok(ms < 50, `${n} spaces took ${ms.toFixed(1)} ms`);
  }
  assert.equal(isStrictZolaFrom(`${' '.repeat(5000)}Zola <${ZOLA_VENDOR_ADDRESS}>  `), true, 'surrounding whitespace is trimmed first');
  assert.equal(isStrictZolaFrom(`<${ZOLA_VENDOR_ADDRESS}>`), true);
  assert.equal(isStrictZolaFrom(`"Alex B \\"and\\" Sam C on Zola" <${ZOLA_VENDOR_ADDRESS}>`), true, 'an escaped quote in a quoted name');
  assert.equal(isStrictZolaFrom(`"${'A'.repeat(300)}" <${ZOLA_VENDOR_ADDRESS}>`), true);
  assert.equal(isStrictZolaFrom(`"${'A'.repeat(400)}" <${ZOLA_VENDOR_ADDRESS}>`), false, 'over 400 characters');
  for (const from of [`"A" "B" <${ZOLA_VENDOR_ADDRESS}>`, `A@B <${ZOLA_VENDOR_ADDRESS}>`, `<x@example.com> <${ZOLA_VENDOR_ADDRESS}>`,
    `${ZOLA_VENDOR_ADDRESS}.evil.example`, `x${ZOLA_VENDOR_ADDRESS}`, `Zola <${ZOLA_VENDOR_ADDRESS}> x`, null, 42]) {
    assert.equal(isStrictZolaFrom(from), false, String(from));
  }
  const v = classify(zolaMail('New Zola inquiry for Dr. Bartender', [REAL_ZOLA_AUTH], { from: `${' '.repeat(4000)};<${ZOLA_VENDOR_ADDRESS}>` }));
  assert.deepEqual(v, { action: 'drop', reason: 'zola_gate' });
});

test('the Zola gate needs the notice addressed to us: To or Cc, never Bcc, never Zola itself', () => {
  const notice = (over) => classify(zolaMail('New Zola inquiry for Dr. Bartender', [REAL_ZOLA_AUTH], over));
  const gate = { action: 'drop', reason: 'zola_gate' };
  assert.deepEqual(notice({ to: 'Events <events@vendor.example.com>' }), gate, 'a signed notice to another vendor, re-sent to us');
  assert.deepEqual(notice({ to: 'events@vendor.example.com', bcc: GMAIL_MAILBOX }), gate, 'Bcc does not address it');
  assert.deepEqual(notice({ to: ZOLA_VENDOR_ADDRESS }), gate, 'Zola\'s own address is not us here');
  assert.deepEqual(notice({ to: 'undisclosed-recipients:;' }), gate);
  assert.equal(notice({ to: 'Old <old-business@example.com>', cc: GMAIL_MAILBOX }).kind, 'zola_unparsed', 'the older address in To, the mailbox in Cc');
  assert.equal(notice({ to: 'events@vendor.example.com', cc: `Desk <${GMAIL_MAILBOX.toUpperCase()}>` }).kind, 'zola_unparsed', 'our mailbox in Cc');
  const [local, domain] = GMAIL_MAILBOX.split('@');
  assert.equal(notice({ to: `${local}+zola@${domain}` }).kind, 'zola_unparsed', 'a tagged address is ours untagged');
  assert.equal(notice({}).kind, 'zola_unparsed', 'the mailbox in To');
});

test('the real Zola Authentication-Results carries no quote, so refusing a quoted line keeps every real notice', () => {
  assert.equal(REAL_ZOLA_AUTH.includes('"'), false);
  assert.equal(zolaAuthPasses(new Map([['authentication-results', REAL_ZOLA_AUTH]])), true);
});

test('rule 7: an auto-reply subject is the bare phrase or the phrase and a colon, not a subject that starts with the words', () => {
  const client = (subject) => classify(mail({ from: 'alex.b@example.com', subject }));
  assert.deepEqual(client('Out of Office party - final headcount'), { action: 'store', kind: 'message' });
  assert.deepEqual(client('Re: Out of Office party - final headcount'), { action: 'store', kind: 'message' });
  const ours = mail({ labels: ['SENT'], from: GMAIL_MAILBOX, to: 'alex.b@example.com', subject: 'Re: Out of Office party - final headcount' });
  assert.deepEqual(classify(ours), { action: 'store', kind: 'message' }, 'our reply about the party is a reply');
  for (const subject of ['Out of Office: back Monday', 'Automatic reply: Bar for our party', 'Out of office', 'RE: Auto-Reply', 'Out of the office until Monday']) {
    assert.deepEqual(client(subject), { action: 'store', kind: 'auto_reply' }, subject);
  }
  assert.equal(isAutoReply(new Map(), 'Out of office hours question', false), false);
  assert.equal(isAutoReply(new Map([['auto-submitted', 'auto-replied']]), 'Out of Office party - final headcount', false), true, 'the headers still decide first');
});

// Google's delivery report (multipart/report), invented addresses: a human
// part, the message/delivery-status part (RFC 3464), the headers of our mail.
// Each recipient is [Final-Recipient value or bare address, Action].
function dsn({
  subject = 'Delivery Status Notification (Failure)', recipients = [['nobody@example.com', 'failed']], statusPart = true,
  inReplyTo = '<s1@mail.gmail.com>',
} = {}) {
  const status = [
    'Reporting-MTA: dns; googlemail.com', 'Arrival-Date: Mon, 12 Oct 2026 08:00:00 -0700 (PDT)', 'X-Original-Message-ID: <s1@mail.gmail.com>', '',
    ...recipients.flatMap(([who, action]) => [
      `Final-Recipient: ${who.includes(';') ? who : `rfc822; ${who}`}`, `Action: ${action}`, `Status: ${action === 'failed' ? '5.1.1' : '4.4.7'}`,
      'Diagnostic-Code: smtp; 550-5.1.1 The account you tried to reach does', '    not exist.', '',
    ]),
  ].join('\r\n');
  const parts = [
    { mimeType: 'multipart/alternative', headers: [], parts: [{ mimeType: 'text/plain', headers: [], body: { data: b64("Your message wasn't delivered.") } }] },
    ...(statusPart ? [{ mimeType: 'message/delivery-status', filename: '', headers: [{ name: 'Content-Type', value: 'message/delivery-status' }], body: { data: b64(status) } }] : []),
    { mimeType: 'text/rfc822-headers', filename: '', headers: [], body: { data: b64('From: desk@example.com\r\nSubject: Re: Bar for our party') } },
  ];
  return mail({
    from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', subject, inReplyTo, mimeType: 'multipart/report', parts,
    extra: [['Auto-Submitted', 'auto-replied'], ['Content-Type', 'multipart/report; boundary="b1"; report-type=delivery-status']],
  });
}

test('rule 6: a Delay report, or any report nobody failed in, is no bounce and is never stored', () => {
  const stored = { storedSentIds: new Set(['<s1@mail.gmail.com>']) };
  const notFailed = { action: 'drop', reason: 'dsn_not_failed' };
  const delay = dsn({ subject: 'Delivery Status Notification (Delay)', recipients: [['nobody@example.com', 'delayed']] });
  assert.deepEqual(classify(delay, stored), notFailed);
  const m = parseMessage(delay);
  assert.equal(isBounce(m.headers, m.payload), false);
  for (const action of ['delivered', 'relayed', 'expanded', 'Delayed']) {
    assert.deepEqual(classify(dsn({ subject: 'Delivery Status Notification', recipients: [['nobody@example.com', action]] }), stored), notFailed, action);
  }
  assert.deepEqual(classify(dsn({ subject: 'Delivery Status Notification (Delay)', statusPart: false }), stored), notFailed,
    'no status part: the subject decides');
  assert.deepEqual(classify(dsn({ statusPart: false }), stored), { action: 'store', kind: 'bounce', bounced: ['<s1@mail.gmail.com>'], bouncedTo: [] });
  const failure = dsn();
  assert.deepEqual(classify(failure, stored), { action: 'store', kind: 'bounce', bounced: ['<s1@mail.gmail.com>'], bouncedTo: ['nobody@example.com'] });
  const f = parseMessage(failure);
  assert.equal(isBounce(f.headers, f.payload), true);
  assert.deepEqual(classify(failure), { action: 'drop', reason: 'bounce_unmatched' });
});

test('rule 6: bouncedTo names the failed Final-Recipients only, lowercased, deduplicated, at most 20, each an address', () => {
  const stored = { storedSentIds: new Set(['<s1@mail.gmail.com>']) };
  const mixed = dsn({
    recipients: [
      ['Lee.D@Example.com', 'failed'], ['alex.b@example.com', 'delayed'], ['rfc822;lee.d@example.com', 'failed'], ['pat@example.com', 'delivered'],
      ['RFC822; <Kim@Example.com>', 'failed'], ['not an address', 'failed'], [`${'a'.repeat(309)}@example.com`, 'failed'], ['x400; c=US', 'failed'],
    ],
  });
  assert.deepEqual(classify(mixed, stored).bouncedTo, ['lee.d@example.com', 'kim@example.com']);
  const many = dsn({ recipients: Array.from({ length: 25 }, (_, i) => [`guest${i}@example.com`, 'failed']) });
  const to = classify(many, stored).bouncedTo;
  assert.equal(to.length, 20);
  assert.deepEqual([to[0], to[19]], ['guest0@example.com', 'guest19@example.com']);
  const at320 = `${'a'.repeat(308)}@example.com`;
  assert.deepEqual(classify(dsn({ recipients: [[at320, 'failed']] }), stored).bouncedTo, [at320], 'an address of 320 characters is kept');
});

test('the Zola gate refuses a second To or Cc: the top one is what we read, the bottom one is what DKIM checked', () => {
  const notice = (over) => classify(zolaMail('New Zola inquiry for Dr. Bartender', [REAL_ZOLA_AUTH], over));
  const gate = { action: 'drop', reason: 'zola_gate' };
  const auth = ['Authentication-Results', REAL_ZOLA_AUTH];
  assert.deepEqual(notice({ extra: [auth, ['To', 'events@vendor.example.com']] }), gate, 'our mailbox in a To placed on top');
  assert.deepEqual(notice({ to: 'events@vendor.example.com', cc: GMAIL_MAILBOX, extra: [auth, ['cc', 'planner@vendor.example.com']] }), gate, 'two Cc headers');
  assert.equal(notice({ to: 'events@vendor.example.com', cc: GMAIL_MAILBOX, extra: [auth, ['X-Other', 'x']] }).kind, 'zola_unparsed', 'one of each passes');
});

test('rule 7: the unambiguous auto-reply phrases match whatever follows; "out of office" only as a responder writes it', () => {
  for (const subject of ['Out of Office AutoReply: Bar for our party', 'Out of office (back Monday)', 'Automatic Reply - quote',
    'Out of office reply: back soon', 'Auto-Response from Jamie Q', 'Re: Out of Office Auto-Reply']) {
    assert.equal(isAutoReply(new Map(), subject, false), true, subject);
  }
  for (const subject of ['Out of Office party - final headcount', 'Out of office party?', 'Re: Out of the office lunch plans']) {
    assert.equal(isAutoReply(new Map(), subject, false), false, subject);
  }
});

// Re-review 2026-10-15: a responder that sends no auto headers writes these.
test('rule 7: "out of office" before a dash, a comma, a period, a bar, a slash or "notice" is a responder; the party is still a message', () => {
  for (const subject of ['Out of office - back Monday', 'Out of office, returning Oct 20', 'Out of the Office – back soon',
    'Out of office.', 'Out of office | back Monday', 'Out of office notice', 'Out of Office — back Monday', 'Out of office / back Monday',
    'Out of office!', 'Re: Out of office - back Monday', 'Out of office-back Monday']) {
    assert.equal(isAutoReply(new Map(), subject, false), true, subject);
  }
  for (const subject of ['Out of Office party - final headcount', 'Out of office party?', 'Re: Out of the office lunch plans',
    'Out of office hours question', 'Out of office noticeboard ideas']) {
    assert.equal(isAutoReply(new Map(), subject, false), false, subject);
  }
  assert.deepEqual(classify(mail({ from: 'alex.b@example.com', subject: 'Out of office - back Monday' })), { action: 'store', kind: 'auto_reply' });
});

// Code review 2026-10-15: a false positive drops a client's mail for good,
// a false negative only opens an item. After "office" a responder writes
// ":" or "(", nothing (or a closing "." or "!"), until / reply / autoreply /
// notice, or a separator and then back / returning / until / away.
test('rule 7: "out of office" then a separator is a responder only before back, returning, until or away; a client\'s subject stays a message', () => {
  for (const subject of ['Out of Office - team offsite bar quote', 'Out of office, need a quote for our retreat', 'Out of office/holiday party',
    'Out of office | staff party menu']) {
    assert.equal(isAutoReply(new Map(), subject, false), false, subject);
  }
  for (const subject of ['Out of office - back Monday', 'Out of office, returning Oct 20', 'Out of office.', 'Out of Office: back Monday',
    'Automatic reply: x', 'Out of office - away until the 20th', 'Out of office until Monday']) {
    assert.equal(isAutoReply(new Map(), subject, false), true, subject);
  }
  const client = (subject) => classify(mail({ from: 'alex.b@example.com', subject }));
  for (const subject of ['Out of Office - team offsite bar quote', 'Out of office, need a quote for our retreat', 'Out of office/holiday party']) {
    assert.deepEqual(client(subject), { action: 'store', kind: 'message' }, subject);
  }
  assert.deepEqual(client('Out of office, returning Oct 20'), { action: 'store', kind: 'auto_reply' });
});

test('rule 7: the subject pattern stays linear on a subject at its 1000-character bound', () => {
  const ms = (fn) => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
  for (const s of [`Out of office${' '.repeat(987)}`, `Out of office${' '.repeat(986)}x`, `Re:${' '.repeat(996)}x`,
    `out of the office${'\t'.repeat(983)}`, 'Out of office '.repeat(71), '-'.repeat(1000),
    `Out of office${' '.repeat(985)}.x`, `Out of office -${' '.repeat(985)}x`, `Out of office${' -'.repeat(493)}`]) {
    let took = 0;
    for (let i = 0; i < 200; i += 1) took += ms(() => isAutoReply(new Map(), s, false));
    assert.ok(took < 100, `${JSON.stringify(s.slice(0, 20))} x 200 took ${took.toFixed(1)} ms`);
  }
});

// Security re-review 2026-10-15: "addressed to us" is the business's own
// mailboxes, never every address the sync treats as ours. A notice Zola signed
// for a manager's personal address, re-sent to the mailbox, must not pass.
test('the Zola gate counts only the business addresses as us: the mailbox, the personal alias and INBOX_OWN_EMAILS', () => {
  const operators = [
    { id: 1, role: 'admin', phone: null, presence_nudge_phone: null, email: 'op-one@example.com', name: 'Op One' },
    { id: 2, role: 'manager', phone: null, presence_nudge_phone: null, email: 'Mgr.Two@Example.com', name: 'Mgr Two' },
  ];
  const configured = buildPeopleIndex({ env: { ADMIN_EMAIL: 'desk@example.com', INBOX_OWN_EMAILS: ' Old-Business@Example.com , ,' }, operators });
  const bare = buildPeopleIndex({ env: { ADMIN_EMAIL: 'desk@example.com' }, operators });
  const notice = (over, ix = configured) => classifyMessage({
    ...parseMessage(zolaMail('New Zola inquiry for Dr. Bartender', [REAL_ZOLA_AUTH], over)), index: ix, storedSentIds: new Set(), sentInThread: false,
  });
  const gate = { action: 'drop', reason: 'zola_gate' };
  assert.equal(notice({ to: GMAIL_MAILBOX }).kind, 'zola_unparsed', 'the mailbox in To');
  assert.equal(notice({ to: 'events@vendor.example.com', cc: GMAIL_MAILBOX }).kind, 'zola_unparsed', 'the mailbox in Cc');
  assert.equal(notice({ to: PERSONAL_ALIAS }).kind, 'zola_unparsed', 'the personal alias');
  assert.equal(notice({ to: 'Old <old-business@example.com>' }).kind, 'zola_unparsed', 'an INBOX_OWN_EMAILS address, as configured');
  assert.equal(notice({ to: 'old-business+zola@example.com' }).kind, 'zola_unparsed', 'tagged');
  assert.deepEqual(notice({ to: 'old-business@example.com' }, bare), gate, 'the same address with INBOX_OWN_EMAILS unset');
  assert.deepEqual(notice({ to: 'Mgr Two <mgr.two@example.com>' }), gate, 'a manager\'s address only');
  assert.deepEqual(notice({ to: 'events@vendor.example.com', cc: 'mgr.two@example.com' }), gate, 'a manager\'s address in Cc');
  assert.deepEqual(notice({ to: 'op-one@example.com' }), gate, 'an admin\'s address only');
  assert.deepEqual(notice({ to: 'desk@example.com' }), gate, 'ADMIN_EMAIL only');
  assert.deepEqual(notice({ to: GMAIL_MAILBOX }, { ...configured, mailboxEmails: undefined }), gate, 'an index without the set addresses nobody');
  // Every own address is still ours as a sender and as a recipient elsewhere.
  for (const a of ['mgr.two@example.com', 'op-one@example.com', 'desk@example.com', 'old-business@example.com', GMAIL_MAILBOX, PERSONAL_ALIAS]) {
    assert.equal(configured.ownEmails.has(a), true, a);
  }
  assert.deepEqual([...configured.mailboxEmails].sort(), [GMAIL_MAILBOX, PERSONAL_ALIAS, 'old-business@example.com'].sort());
});

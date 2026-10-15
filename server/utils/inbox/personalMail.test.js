// Personal mail, judged once per mail when the sync stores it (spec
// 2026-10-14 decision 6, as the owner decided it on 2026-10-15), over a stub
// db that answers the module's two lookups and refuses anything else.
// gmailSync.db.test.js runs the same lookups against Postgres. Every person
// and address here is invented.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GMAIL_MAILBOX } = require('../gmailClient');
const { buildPeopleIndex } = require('./people');
const rules = require('./gmailRules');
const { judgePersonal, SQL } = require('./personalMail');
const { PERSONAL_ALIAS, ZOLA_VENDOR_ADDRESS, ZOLA_RELAY_DOMAIN } = require('./constants');

const FRIEND = 'friend.r@example.com';
const AT = Date.parse('2026-10-12T15:00:00Z');
const BEFORE = new Date(AT - 24 * 3600e3);
const AFTER = new Date(AT + 24 * 3600e3);
const INDEX = buildPeopleIndex({
  env: { INBOX_OWN_EMAILS: 'old-business@example.com', ADMIN_EMAIL: 'admin-box@example.com' },
  operators: [
    { id: 2, role: 'manager', phone: null, presence_nudge_phone: null, email: 'op-one@example.com', name: 'Op One' },
    // PERSONAL_MAILBOX_OWNER_USER_ID: the owner's own account.
    { id: 1, role: 'admin', phone: null, presence_nudge_phone: null, email: 'owner.home@example.com', name: 'Owner' },
  ],
});
const NO_REPLY = 'no-reply@drbartender.com';

// known: [{ address, at }] records and when they were made; inbound: the
// stored inbound rows the answered lookup reads.
function stubDb({ known = [], inbound = [], fail = null } = {}) {
  const calls = [];
  return {
    calls,
    query(sql, params) {
      const name = Object.keys(SQL).find((k) => SQL[k] === sql); // eslint-disable-line security/detect-object-injection -- k is one of SQL's own keys
      if (!name) return Promise.reject(new Error(`stub db: unexpected statement: ${String(sql).slice(0, 60)}`));
      calls.push([name, params]);
      if (fail && fail[0] === name) return Promise.reject(fail[1]());
      if (name === 'knownAt') {
        const [addresses, at] = params;
        return Promise.resolve({ rows: addresses.filter((a) => known.some((k) => k.address === a && k.at <= at)).map((address) => ({ address })) });
      }
      // SQL.answeredInbound restated: the lowest id among the rows its
      // In-Reply-To names dated at or before the reply, else the newest in
      // its thread at or before it.
      const [inReplyTo, threadId, at] = params;
      const rows = inbound.filter((r) => r.message_id_header && r.message_id_header === inReplyTo && r.at <= at).sort((a, b) => a.id - b.id);
      const pick = rows[0] || inbound.filter((r) => r.thread_id === threadId && r.at <= at)
        .sort((a, b) => (b.at - a.at) || (b.id - a.id))[0];
      return Promise.resolve({ rows: pick ? [{ personal: pick.personal, from_address: pick.from_address }] : [] });
    },
  };
}

const b64 = (s) => Buffer.from(s).toString('base64url');
function parsed({
  from = `Robin Friend <${FRIEND}>`, to = PERSONAL_ALIAS, cc = null, bcc = null, subject = 'Dinner on Sunday?', sent = false,
  inReplyTo = null, threadId = 'th-p1', extra = [],
} = {}) {
  const headers = [['From', from], ['To', to], ['Subject', subject], ['Message-ID', '<p1@mail.example.com>'], ...extra];
  if (cc) headers.push(['Cc', cc]);
  if (bcc) headers.push(['Bcc', bcc]);
  if (inReplyTo) headers.push(['In-Reply-To', inReplyTo]);
  return rules.parseMessage({
    id: 'p1', threadId, labelIds: sent ? ['SENT'] : ['INBOX', 'CATEGORY_PERSONAL'], internalDate: String(AT),
    payload: { mimeType: 'text/plain', headers: headers.map(([name, value]) => ({ name, value })), body: { data: b64('Words') } },
  });
}
const message = { action: 'store', kind: 'message' };
const judge = (m, db, verdict = message) => judgePersonal(db, m, verdict, INDEX);

// ─── inbound ───

test('inbound to the owner alias alone from someone nobody knew is personal, judged by one lookup at the mail\'s own time', async () => {
  const db = stubDb();
  assert.deepEqual(await judge(parsed(), db), { personal: true, personalTo: null });
  assert.deepEqual(db.calls, [['knownAt', [[FRIEND], new Date(AT)]]], 'the sender, lowercased, at the mail\'s at');
});

test('a sender who was a client, staffer, operator or lead when the mail arrived is business; one recorded after it is not', async () => {
  assert.deepEqual(await judge(parsed(), stubDb({ known: [{ address: FRIEND, at: BEFORE }] })), { personal: false, personalTo: null });
  assert.deepEqual(await judge(parsed(), stubDb({ known: [{ address: FRIEND, at: AFTER }] })), { personal: true, personalTo: null },
    'a record made after the mail does not unhide it');
  assert.deepEqual(await judge(parsed({ from: 'ROBIN <Friend.R@Example.com>' }), stubDb({ known: [{ address: FRIEND, at: BEFORE }] })),
    { personal: false, personalTo: null }, 'the address is compared trimmed and lowercased');
});

test('To and Cc that name none of our addresses (we were Bcc\'d, a list, a forward) are private: an unclear shape defaults personal', async () => {
  for (const shape of [
    { to: 'someone.else@example.com', bcc: PERSONAL_ALIAS },
    { to: 'someone.else@example.com', bcc: GMAIL_MAILBOX },
    { to: 'party-list@lists.example.com' },
  ]) {
    assert.deepEqual(await judge(parsed(shape), stubDb()), { personal: true, personalTo: null }, JSON.stringify(shape));
  }
});

// The owner's call (2026-10-15): the sender copied our team. An admin's or
// manager's own address in To or Cc, +tag or not, makes the mail business,
// and so does one alone in To (we were Bcc'd on mail to our own team).
test('an operator in copy is business: an admin\'s or manager\'s own address in To or Cc, and needs no lookup', async () => {
  for (const shape of [
    { to: PERSONAL_ALIAS, cc: 'Op One <op-one@example.com>' },
    { to: `${PERSONAL_ALIAS}, op-one+events@example.com` },
    { to: 'Op One <op-one@example.com>' },
    { to: 'OP-ONE@Example.com', bcc: PERSONAL_ALIAS },
  ]) {
    const db = stubDb();
    assert.deepEqual(await judge(parsed(shape), db), { personal: false, personalTo: null }, JSON.stringify(shape));
    assert.deepEqual(db.calls, [], `${JSON.stringify(shape)}: no lookup`);
  }
});

test('the owner alias with any business address in To or Cc is business, and needs no lookup', async () => {
  const tagged = (a) => a.replace('@', '+tag@');
  for (const shape of [
    { to: PERSONAL_ALIAS, cc: GMAIL_MAILBOX },
    { to: `${PERSONAL_ALIAS}, ${tagged(GMAIL_MAILBOX)}` },
    { to: GMAIL_MAILBOX.toUpperCase() },
    { to: PERSONAL_ALIAS, cc: NO_REPLY },
    { to: PERSONAL_ALIAS, cc: 'admin-box@example.com' },
    { to: PERSONAL_ALIAS, cc: 'Old <old-business@example.com>' },
    { to: GMAIL_MAILBOX, bcc: PERSONAL_ALIAS },
  ]) {
    const db = stubDb();
    assert.deepEqual(await judge(parsed(shape), db), { personal: false, personalTo: null }, JSON.stringify(shape));
    assert.deepEqual(db.calls, [], `${JSON.stringify(shape)}: no lookup`);
  }
  for (const to of [tagged(PERSONAL_ALIAS), PERSONAL_ALIAS.toUpperCase()]) {
    assert.deepEqual(await judge(parsed({ to }), stubDb()), { personal: true, personalTo: null }, `${to} is the owner alias`);
  }
});

test('a Zola notice and a bounce are never personal, and read nothing', async () => {
  const db = stubDb();
  const zola = parsed({ from: `Zola <${ZOLA_VENDOR_ADDRESS}>` });
  assert.deepEqual(await judge(zola, db, { action: 'store', kind: 'zola_unparsed', zola: { template: 'inquiry', label: null } }),
    { personal: false, personalTo: null });
  assert.deepEqual(await judge(parsed({ from: 'mailer-daemon@googlemail.com' }), db, { action: 'store', kind: 'bounce', bounced: ['<s@x>'] }),
    { personal: false, personalTo: null });
  assert.deepEqual(db.calls, []);
  assert.deepEqual(await judge(parsed(), stubDb(), { action: 'store', kind: 'auto_reply' }), { personal: true, personalTo: null },
    'an auto-reply to the owner alias from someone nobody knew is personal like any inbound');
});

test('a lookup that fails rejects the judgment: the store fails with it, never as business', async () => {
  const boom = () => new Error('Connection terminated unexpectedly');
  await assert.rejects(judge(parsed(), stubDb({ fail: ['knownAt', boom] })), /Connection terminated/);
  const sent = parsed({ from: GMAIL_MAILBOX, to: FRIEND, sent: true, inReplyTo: '<friend-1@mail.example.com>' });
  await assert.rejects(judge(sent, stubDb({ fail: ['answeredInbound', boom] })), /Connection terminated/);
});

// ─── Sent ───

const CLIENT = 'client.k@example.com';
const personalInbound = { id: 7, message_id_header: '<friend-1@mail.example.com>', thread_id: 'th-p1', at: new Date(AT - 3600e3), personal: true, from_address: FRIEND };
const businessInbound = { ...personalInbound, id: 8, message_id_header: '<friend-2@mail.example.com>', thread_id: 'th-b1', personal: false };

test('from the owner alias: personal for each recipient nobody knew when it was sent; a client copied on it gets the business event', async () => {
  const db = stubDb({ known: [{ address: CLIENT, at: BEFORE }] });
  const m = parsed({ from: `Dallas <${PERSONAL_ALIAS}>`, to: `${FRIEND}, Kim <${CLIENT}>`, sent: true });
  assert.deepEqual(await judge(m, db), { personal: true, personalTo: [FRIEND] });
  assert.deepEqual(db.calls.map(([name]) => name), ['answeredInbound', 'knownAt']);
  assert.deepEqual(db.calls[1][1], [[FRIEND, CLIENT], new Date(AT)], 'one lookup for every recipient');
  const tagged = parsed({ from: PERSONAL_ALIAS.replace('@', '+x@'), to: FRIEND, bcc: 'other.pal@example.com', sent: true });
  assert.deepEqual(await judge(tagged, stubDb()), { personal: true, personalTo: [FRIEND, 'other.pal@example.com'] }, 'a +tag and a Bcc too');
  const known = parsed({ from: PERSONAL_ALIAS, to: CLIENT, sent: true });
  assert.deepEqual(await judge(known, stubDb({ known: [{ address: CLIENT, at: BEFORE }] })), { personal: false, personalTo: null });
});

test('a reply to a personal inbound is personal for its sender, even one known by then, and for every recipient nobody knew', async () => {
  const m = parsed({
    from: GMAIL_MAILBOX, to: FRIEND, cc: `${CLIENT}, stranger.s@example.com`, sent: true, inReplyTo: personalInbound.message_id_header,
  });
  const db = stubDb({ inbound: [personalInbound], known: [{ address: CLIENT, at: BEFORE }, { address: FRIEND, at: BEFORE }] });
  assert.deepEqual(await judge(m, db), { personal: true, personalTo: [FRIEND, 'stranger.s@example.com'] });
  assert.deepEqual(db.calls[0], ['answeredInbound', [personalInbound.message_id_header, 'th-p1', new Date(AT)]]);
  // No In-Reply-To: the newest inbound in the thread before it.
  const byThread = parsed({ from: GMAIL_MAILBOX, to: FRIEND, sent: true, threadId: 'th-p1' });
  assert.deepEqual(await judge(byThread, stubDb({ inbound: [personalInbound] })), { personal: true, personalTo: [FRIEND] });
});

test('a reply from the business mailbox to a business inbound is business, and only the answered lookup runs', async () => {
  const db = stubDb({ inbound: [businessInbound] });
  const m = parsed({ from: GMAIL_MAILBOX, to: FRIEND, sent: true, threadId: 'th-b1', inReplyTo: businessInbound.message_id_header });
  assert.deepEqual(await judge(m, db), { personal: false, personalTo: null });
  assert.deepEqual(db.calls.map(([name]) => name), ['answeredInbound']);
});

test('a forward answers no one: a personal mail sent on from the business mailbox is business, and is not looked up', async () => {
  const db = stubDb({ inbound: [personalInbound] });
  const m = parsed({ from: GMAIL_MAILBOX, to: 'kai.staff@example.com', subject: 'Fwd: Dinner on Sunday?', sent: true, inReplyTo: personalInbound.message_id_header });
  assert.deepEqual(await judge(m, db), { personal: false, personalTo: null });
  assert.deepEqual(db.calls, []);
  const fromAlias = parsed({ from: PERSONAL_ALIAS, to: 'kai.staff@example.com', subject: ' FW: plans', sent: true });
  assert.deepEqual(await judge(fromAlias, stubDb()), { personal: true, personalTo: ['kai.staff@example.com'] },
    'a forward from the owner alias to someone nobody knew is still the alias rule');
});

test('our own addresses and Zola\'s relay are never personal recipients; a mail with none left is business', async () => {
  const relay = `abc@${ZOLA_RELAY_DOMAIN}`;
  const m = parsed({ from: PERSONAL_ALIAS, to: `${GMAIL_MAILBOX}, op-one@example.com, ${relay}, ${FRIEND}`, cc: GMAIL_MAILBOX.replace('@', '+t@'), sent: true });
  const db = stubDb();
  assert.deepEqual(await judge(m, db), { personal: true, personalTo: [FRIEND] });
  assert.deepEqual(db.calls[1][1][0], [FRIEND], 'only the people are looked up');
  const none = parsed({ from: PERSONAL_ALIAS, to: relay, sent: true });
  const quiet = stubDb();
  assert.deepEqual(await judge(none, quiet), { personal: false, personalTo: null });
  assert.deepEqual(quiet.calls.map(([name]) => name), ['answeredInbound'], 'no recipient to look up');
});

// The coordinator's correction (2026-10-15): ANSWERING decides first. A Sent
// mail that answers an inbound takes that inbound's side, whichever of our
// addresses it went from; only a mail that answers nothing (a fresh send, or
// a forward) uses the From rule.
test('a reply from the owner alias to a business inbound is business: answering decides, not the From, and nobody is looked up', async () => {
  const db = stubDb({ inbound: [businessInbound] });
  const m = parsed({ from: `Dallas <${PERSONAL_ALIAS}>`, to: FRIEND, cc: 'stranger.s@example.com', sent: true, threadId: 'th-b1', inReplyTo: businessInbound.message_id_header });
  assert.deepEqual(await judge(m, db), { personal: false, personalTo: null });
  assert.deepEqual(db.calls.map(([name]) => name), ['answeredInbound']);
  const byThread = parsed({ from: PERSONAL_ALIAS, to: FRIEND, sent: true, threadId: 'th-b1' });
  assert.deepEqual(await judge(byThread, stubDb({ inbound: [businessInbound] })), { personal: false, personalTo: null },
    'answering by thread as well');
});

test('a fresh send (it answers nothing) from the owner alias is personal for each recipient nobody knew; from the mailbox it is business', async () => {
  const fresh = parsed({ from: PERSONAL_ALIAS, to: `${FRIEND}, Kim <${CLIENT}>`, sent: true, threadId: 'th-new' });
  assert.deepEqual(await judge(fresh, stubDb({ known: [{ address: CLIENT, at: BEFORE }] })), { personal: true, personalTo: [FRIEND] });
  const mailbox = parsed({ from: GMAIL_MAILBOX, to: FRIEND, sent: true, threadId: 'th-new' });
  const db = stubDb();
  assert.deepEqual(await judge(mailbox, db), { personal: false, personalTo: null });
  assert.deepEqual(db.calls.map(([name]) => name), ['answeredInbound']);
});

test('a reply from the business mailbox to a personal inbound stays personal (answering decides that way too)', async () => {
  const m = parsed({ from: GMAIL_MAILBOX, to: FRIEND, sent: true, inReplyTo: personalInbound.message_id_header });
  assert.deepEqual(await judge(m, stubDb({ inbound: [personalInbound] })), { personal: true, personalTo: [FRIEND] });
});

// Security L1 (2026-10-15): a reply answers only an inbound dated at or before
// it, so a later mail that reuses a Message-ID never takes the reply over. The
// stub restates the statement; gmailSync.db.test.js runs the real one.
test('a reply answers only an inbound dated at or before it: the lookup passes the reply\'s time with its In-Reply-To', async () => {
  const later = { ...businessInbound, id: 3, message_id_header: personalInbound.message_id_header, thread_id: 'th-other', at: AFTER };
  const db = stubDb({ inbound: [later, personalInbound] });
  const m = parsed({ from: GMAIL_MAILBOX, to: FRIEND, sent: true, threadId: 'th-p9', inReplyTo: personalInbound.message_id_header });
  assert.deepEqual(await judge(m, db), { personal: true, personalTo: [FRIEND] }, 'the personal mail it answers, not the later one');
  assert.deepEqual(db.calls[0], ['answeredInbound', [personalInbound.message_id_header, 'th-p9', new Date(AT)]]);
});

// The coordinator's follow-up (2026-10-15): the owner's own account is not
// "our team". A friend copying the owner's own users.email never makes
// personal mail business; every other admin's and manager's address does.
test('the owner\'s own address in copy is not an operator in copy: the mail is still judged by its sender', async () => {
  for (const shape of [{ to: PERSONAL_ALIAS, cc: 'Owner <owner.home@example.com>' }, { to: 'owner.home+x@example.com' }]) {
    const db = stubDb();
    assert.deepEqual(await judge(parsed(shape), db), { personal: true, personalTo: null }, JSON.stringify(shape));
    assert.deepEqual(db.calls.map(([name]) => name), ['knownAt'], `${JSON.stringify(shape)}: looked up like any private shape`);
  }
  assert.deepEqual(await judge(parsed({ to: PERSONAL_ALIAS, cc: 'owner.home@example.com, op-one@example.com' }), stubDb()),
    { personal: false, personalTo: null }, 'another operator beside it still makes it business');
});

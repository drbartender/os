const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPeopleIndex, latestPhoneOf } = require('./people');
const { mapSmsHeader, failureReasonFor } = require('./readSms');
const { mapThumbtackHeader } = require('./readThumbtack');
const { mapMessageLogHeader } = require('./readMessageLog');
const { mapProposalSendHeader } = require('./readProposalSends');
const { mapCallHeader } = require('./readCalls');
const { lineE164 } = require('../smsLines');

const T = (iso) => new Date(iso);
const index = buildPeopleIndex({
  env: { ADMIN_PHONE: '+13125550199', VA_CELL: '+13125550197' },
  clients: [
    { id: 10, name: 'Robin Example', phone: '(312) 555-0101', created_at: T('2026-09-01T00:00:00Z') },
    { id: 11, name: 'Robin Older', phone: '3125550101', created_at: T('2026-08-01T00:00:00Z') },
    { id: 12, name: 'Sam Proxy', phone: '+18725550150', created_at: T('2026-09-02T00:00:00Z') },
  ],
  staff: [{ id: 20, role: 'staff', phone: '+13125550120', updated_at: T('2026-09-01T00:00:00Z'), name: 'Kai B.' }],
  operators: [
    { id: 1, role: 'admin', phone: '+13125550199', presence_nudge_phone: null, name: 'Dallas R.' },
    { id: 2, role: 'manager', phone: null, presence_nudge_phone: '+13125550198', name: 'Zul' },
  ],
  profilePhones: [{ user_id: 20, phone: '+13125550120' }, { user_id: 30, phone: '+13125550130' }],
  leads: [
    { id: 100, negotiation_id: '555001', client_id: 12, customer_name: 'Sam P.', customer_phone: '+18725550150', created_at: T('2026-09-02T00:00:00Z'), first_reply_sent_at: null },
    { id: 101, negotiation_id: '555002', client_id: null, customer_name: 'Lee N.', customer_phone: '+18725550160', created_at: T('2026-09-03T00:00:00Z'), first_reply_sent_at: T('2026-09-03T00:05:00Z') },
    { id: 102, negotiation_id: '555003', client_id: null, customer_name: 'Ash Later', customer_phone: '+18725550160', created_at: T('2026-10-01T00:00:00Z'), first_reply_sent_at: null },
  ],
});
const row = (over) => ({
  id: 1, direction: 'inbound', client_id: null, sender_id: null, recipient_id: null, recipient_phone: '+13125550101',
  from_phone: null, to_phone: null, line: null, outcome: null, opt_keyword: null, relay: false, relay_notice: false,
  status: 'received', twilio_sid: 'SM1', message_type: 'general', created_at: T('2026-09-20T15:00:00Z'),
  empty_body: false, has_media: false, short_word: null, group_size: 1, ...over,
});

test('our own numbers never form an item: the lines, ADMIN_PHONE, VA_CELL, an operator phone and a nudge phone', () => {
  for (const phone of ['+13125550199', '+13125550197', '+13125550198', lineE164('1922'), lineE164('0082')]) {
    assert.equal(mapSmsHeader(row({ recipient_phone: phone }), index), null, phone);
    assert.equal(mapSmsHeader(row({ direction: 'outbound', status: 'sent', recipient_phone: phone }), index), null, phone);
  }
});

test('who is who: client_id, then the newest client, then send-eligible staff, then a proxy lead, else p-', () => {
  assert.equal(mapSmsHeader(row({ client_id: 11 }), index).personKey, 'c-11', 'client_id wins');
  assert.equal(mapSmsHeader(row({}), index).personKey, 'c-10', 'the newest client with that number');
  const staff = mapSmsHeader(row({ recipient_phone: '+13125550120' }), index);
  assert.deepEqual([staff.personKey, staff.channel], ['s-20', 'staff_text']);
  assert.equal(mapSmsHeader(row({ direction: 'outbound', status: 'sent', recipient_id: 20, recipient_phone: '+13125550120', sender_id: 2 }), index).personKey, 's-20');
  assert.equal(mapSmsHeader(row({ recipient_phone: '+13125550130' }), index).personKey, 'p-3125550130', 'a profile that is not send-eligible is an unknown number');
  assert.equal(mapSmsHeader(row({ recipient_phone: '+18725550160' }), index).personKey, 't-555002', 'a proxy number resolves to its lead');
  assert.equal(mapSmsHeader(row({ recipient_phone: '+443125550189' }), index).personKey, 'p-3125550189');
});

test('a relay text names the newest lead created before it, and a relay notice is flagged', () => {
  const relay = mapSmsHeader(row({ recipient_phone: '+18725550160', relay: true }), index);
  assert.deepEqual([relay.personKey, relay.meta.relayLeadName, relay.meta.relayNegotiationId, relay.kind], ['t-555002', 'Lee N.', '555002', 'message']);
  const later = mapSmsHeader(row({ recipient_phone: '+18725550160', relay: true, created_at: T('2026-10-02T00:00:00Z') }), index);
  assert.deepEqual([later.personKey, later.meta.relayLeadName], ['t-555003', 'Ash Later']);
  const notice = mapSmsHeader(row({ recipient_phone: '+18725550150', relay: true, relay_notice: true, client_id: 12 }), index);
  assert.deepEqual([notice.personKey, notice.meta.relayNotice, notice.meta.relayNegotiationId], ['c-12', true, '555001']);
});

test('shift commands: an outcome decides whatever the key; the old rule only for settled staff rows', () => {
  const staffIn = (over) => mapSmsHeader(row({ recipient_phone: '+13125550120', ...over }), index);
  assert.equal(staffIn({ outcome: 'staff_cant', short_word: 'cant' }).meta.skip, 'shift_command');
  assert.equal(staffIn({ outcome: 'staff_confirm', short_word: 'confirm' }).meta.skip, 'shift_command');
  for (const outcome of ['staff_cant_no_shift', 'staff_confirm_no_shift', 'staff_confirm_ambiguous', 'staff_cant_race', 'staff_freeform', 'conversation']) {
    assert.ok(!staffIn({ outcome, short_word: 'cant' }).meta.skip, outcome);
  }
  assert.equal(staffIn({ short_word: "can't" }).meta.skip, 'shift_command', 'no outcome: the old every-line rule');
  assert.ok(!staffIn({ short_word: 'maybe' }).meta.skip);
  assert.ok(!mapSmsHeader(row({ short_word: 'confirm' }), index).meta.skip, 'only a staffer runs shift commands');
  assert.equal(mapSmsHeader(row({ outcome: 'staff_confirm', short_word: 'confirm' }), index).meta.skip, 'shift_command',
    'an outcome skips whatever the key: a staffer whose phone is also a client is c-');
  assert.ok(!staffIn({ short_word: 'confirm', processed: false }).meta.skip, 'unsettled, no outcome yet: it counts');
});

test('opt words: the seven become marked system lines, ambiguous words count, lines come from metadata', () => {
  for (const word of ['stop', 'stopall', 'unsubscribe', 'optout', 'revoke', 'start', 'unstop']) {
    const e = mapSmsHeader(row({ short_word: word }), index);
    assert.deepEqual([e.direction, e.meta.optWord], ['system', true], word);
  }
  for (const word of ['cancel', 'end', 'quit', 'yes', 'help', 'info']) {
    assert.equal(mapSmsHeader(row({ short_word: word }), index).direction, 'in', word);
  }
  assert.equal(mapSmsHeader(row({ to_phone: lineE164('1922') }), index).line, '1922');
  assert.equal(mapSmsHeader(row({ to_phone: '+18885550000' }), index).line, '888', 'an unknown To reads as the 888');
  assert.equal(mapSmsHeader(row({ direction: 'outbound', status: 'sent', line: '0082', sender_id: 2 }), index).line, '0082');
  assert.equal(mapSmsHeader(row({ direction: 'outbound', status: 'sent' }), index).line, '888', 'an automated send reads as the 888');
});

test('outbound facts, pictures, empty texts, and failure reasons in plain words', () => {
  const out = mapSmsHeader(row({ direction: 'outbound', status: 'failed', sender_id: 2, group_size: 3 }), index);
  assert.deepEqual([out.direction, out.author, out.meta.smsSenderId, out.meta.failed, out.meta.groupSize], ['out', 2, 2, true, 3]);
  assert.equal(mapSmsHeader(row({ direction: 'outbound', status: 'sent' }), index).author, 'auto');
  const pic = mapSmsHeader(row({ has_media: true, empty_body: true }), index);
  assert.deepEqual([pic.kind, pic.meta.empty], ['media', false]);
  assert.equal(mapSmsHeader(row({ empty_body: true }), index).meta.empty, true);
  assert.equal(failureReasonFor('Twilio 30007 (undelivered)'), 'Filtered by the carrier (Twilio 30007)');
  assert.equal(failureReasonFor('Twilio 30099 (failed)'), 'Twilio error 30099');
  assert.equal(failureReasonFor('Attempt to send to unsubscribed recipient'), 'Attempt to send to unsubscribed recipient');
  assert.equal(failureReasonFor('Twilio error (undelivered)'), null);
  assert.equal(failureReasonFor('Twilio send failed'), null);
  assert.equal(failureReasonFor(null), null);
});

test('Thumbtack, ledger, proposal-send and call rows map to their people and facts', () => {
  const tt = mapThumbtackHeader({ id: 5, message_id: 'm-1', negotiation_id: '555002', from_type: 'Business', at: T('2026-09-03T00:05:30Z'), empty_body: false }, index);
  assert.deepEqual([tt.ref, tt.personKey, tt.direction, tt.author], ['tt:m-1', 't-555002', 'out', null]);
  assert.equal(tt.meta.firstReplySentAt.toISOString(), '2026-09-03T00:05:00.000Z');
  assert.equal(mapThumbtackHeader({ id: 6, message_id: 'm-2', negotiation_id: '555001', from_type: 'Customer', at: T('2026-09-04T00:00:00Z'), empty_body: false }, index).personKey, 'c-12');
  assert.equal(mapThumbtackHeader({ id: 7, message_id: 'm-3', negotiation_id: 'bad id!', from_type: 'Customer', at: T('2026-09-04T00:00:00Z'), empty_body: false }, index), null);
  const ml = mapMessageLogHeader({ id: 8, client_id: 10, proposal_id: 3, channel: 'email', message_type: 'invoice_sent', status: 'sent', provider_id: 're_1', sent_by: 2, created_at: T('2026-09-05T00:00:00Z'), bounced: true });
  assert.deepEqual([ml.personKey, ml.channel, ml.author, ml.meta.failed, ml.meta.bounced], ['c-10', 'email', 2, true, true]);
  const pal = mapProposalSendHeader({ id: 9, proposal_id: 3, action: 'resent', actor_id: 1, created_at: T('2026-09-05T00:00:00Z'), client_id: 10, actor_role: 'admin' });
  assert.deepEqual([pal.ref, pal.personKey, pal.kind, pal.author, pal.meta.actorRole], ['pal:9', 'c-10', 'proposal_sent', 1, 'admin']);
  const lc = mapCallHeader({ src: 'lc', id: '44', answered_by: 'va', bridge_duration_sec: 185, client_no_answer_at: null, at: T('2026-09-06T00:00:00Z'), client_id: null, negotiation_id: '555002' }, index);
  assert.deepEqual([lc.ref, lc.personKey, lc.author, lc.meta.durationSec], ['lc:44', 't-555002', 2, 185]);
  const cc = mapCallHeader({ src: 'cc', id: '45', answered_by: 'admin', bridge_duration_sec: 300, client_no_answer_at: T('2026-09-06T00:10:00Z'), at: T('2026-09-06T00:00:00Z'), client_id: 10, negotiation_id: null }, index);
  assert.deepEqual([cc.personKey, cc.author, cc.meta.clientNoAnswer], ['c-10', 1, true]);
  assert.equal(latestPhoneOf([{ meta: { source: 'sms', phone: '+13125550101' } }, { meta: { source: 'tt' } }]), '+13125550101');
});

// ─── Email and Zola identity (spec 2026-10-14 section 5.2) ───
// Invented addresses only: example.com, plus one made-up staffer on the
// business domain. The business's own addresses come from their constants.
const crypto = require('node:crypto');
const { parsePersonKey } = require('./personKey');
const { GMAIL_MAILBOX } = require('../gmailClient');
const { FROM_EMAIL } = require('../email');
const { PERSONAL_ALIAS, ZOLA_VENDOR_ADDRESS } = require('./constants');

const NO_REPLY = /<([^>]+)>/.exec(FROM_EMAIL)[1];
const BUSINESS_STAFFER = 'invented-staffer@drbartender.com';
const mail = buildPeopleIndex({
  env: { ADMIN_EMAIL: 'Office-Desk@Example.com', INBOX_OWN_EMAILS: ' old-box@example.com , Second-Box@Example.com,,' },
  clients: [
    { id: 40, name: 'Pat Newer', phone: null, email: 'pat@example.com', created_at: T('2026-09-01T00:00:00Z') },
    { id: 41, name: 'Pat Older', phone: null, email: 'Pat@Example.com', created_at: T('2026-08-01T00:00:00Z') },
    { id: 42, name: 'Jo Shared', phone: null, email: 'shared@example.com', created_at: T('2026-08-15T00:00:00Z') },
    { id: 43, name: 'Robin Case', phone: null, email: 'Robin.Case@Example.com', created_at: T('2026-08-20T00:00:00Z') },
    { id: 44, name: 'No Email', phone: '+13125550140', email: null, created_at: T('2026-08-21T00:00:00Z') },
  ],
  staff: [
    { id: 50, role: 'staff', phone: null, email: BUSINESS_STAFFER, updated_at: T('2026-09-01T00:00:00Z'), name: 'Kai B.' },
    { id: 51, role: 'staff', phone: null, email: 'shared@example.com', updated_at: T('2026-09-01T00:00:00Z'), name: 'Jo S.' },
    { id: 52, role: 'manager', phone: null, email: 'ops-two@example.com', updated_at: T('2026-09-01T00:00:00Z'), name: 'Op Two' },
  ],
  operators: [
    { id: 1, role: 'admin', phone: null, presence_nudge_phone: null, email: 'Ops-One@Example.com', name: 'Op One' },
    { id: 52, role: 'manager', phone: null, presence_nudge_phone: null, email: 'ops-two@example.com', name: 'Op Two' },
  ],
  zolaLeads: [
    { id: 7, lead_uuid: null, couple_label: 'Alex B & Sam C', wedding_date: null, client_id: 40, closed_at: null },
    { id: 8, lead_uuid: null, couple_label: 'Lee D & Max E', wedding_date: null, client_id: null, closed_at: null },
  ],
  emailLeads: [
    { id: 3, name: 'Casey Older', email: 'casey@example.com' },
    { id: 4, name: 'Casey Lead', email: 'Casey@Example.com' },
  ],
});

test('our own addresses never form an item; a staffer on the business domain is staff', () => {
  const own = [
    GMAIL_MAILBOX, PERSONAL_ALIAS, NO_REPLY, 'office-desk@example.com', 'old-box@example.com', 'second-box@example.com',
    'ops-one@example.com', 'ops-two@example.com', ZOLA_VENDOR_ADDRESS, GMAIL_MAILBOX.toUpperCase(), ` ${PERSONAL_ALIAS} `,
  ];
  for (const address of own) {
    assert.equal(mail.resolveEmail(address), null, address);
    assert.ok(mail.ownEmails.has(address.trim().toLowerCase()), address);
  }
  assert.equal(mail.ownEmails.has(''), false, 'the empty entries in INBOX_OWN_EMAILS are not addresses');
  assert.equal(mail.resolveEmail(BUSINESS_STAFFER), 's-50', 'not the whole domain: a staffer mailbox there is staff');
  assert.equal(mail.resolveEmail(''), null);
  assert.equal(mail.resolveEmail(null), null);
});

test('resolveEmail ignores case', () => {
  assert.equal(mail.resolveEmail('robin.case@example.com'), 'c-43');
  assert.equal(mail.resolveEmail('  ROBIN.CASE@EXAMPLE.COM '), 'c-43');
});

test('client before staff when both hold the address; newest client first when two share it', () => {
  assert.equal(mail.resolveEmail('shared@example.com'), 'c-42');
  assert.equal(mail.resolveEmail('Pat@Example.com'), 'c-40', 'two case spellings: the newest client wins');
});

test('an unknown address is e- and its hash: 16 lowercase hex, stable, carrying no address', () => {
  const hash = mail.emailHash('Stranger@Example.com');
  assert.match(hash, /^[0-9a-f]{16}$/);
  assert.equal(hash, crypto.createHash('sha256').update('stranger@example.com').digest('hex').slice(0, 16));
  assert.equal(mail.emailHash('  stranger@example.com'), hash, 'trimmed and lowercased first');
  const key = mail.resolveEmail('Stranger@Example.com');
  assert.equal(key, `e-${hash}`);
  assert.deepEqual(parsePersonKey(key), { type: 'e', id: hash });
  assert.equal(key.includes('stranger'), false);
});

test('keyByEmailHash maps every client and staff address hash to its key', () => {
  const at = (address) => mail.keyByEmailHash.get(`e-${mail.emailHash(address)}`);
  assert.equal(at('pat@example.com'), 'c-40');
  assert.equal(at('shared@example.com'), 'c-42', 'the client, as resolveEmail decides');
  assert.equal(at('robin.case@example.com'), 'c-43');
  assert.equal(at(BUSINESS_STAFFER), 's-50');
  assert.equal(at('ops-two@example.com'), undefined, 'an operator is ours, never a person');
  assert.equal(at('stranger@example.com'), undefined);
  for (const [eKey, key] of mail.keyByEmailHash) {
    assert.match(eKey, /^e-[0-9a-f]{16}$/);
    assert.match(key, /^[cs]-\d+$/);
  }
});

test('zolaKey: a linked lead is its client, an unlinked one is z-', () => {
  assert.equal(mail.zolaKey(mail.zolaLeadsById.get(7)), 'c-40');
  assert.equal(mail.zolaKey(mail.zolaLeadsById.get(8)), 'z-8');
  assert.equal(mail.zolaLeadsById.has(9), false);
});

test('leadNameOf reads the marketing lead name by address, the newest row first', () => {
  assert.equal(mail.leadNameOf('CASEY@example.com'), 'Casey Lead');
  assert.equal(mail.leadNameOf('stranger@example.com'), null);
  assert.equal(mail.isEmailLead, undefined, 'gone: personal mail is judged once by the sync, never by the index');
});

// Personal mail (spec 2026-10-14 decision 6, as decided 2026-10-15): the
// addresses that make mail to the owner alias business, and the personal key.
test('businessEmails: the mailbox, INBOX_OWN_EMAILS, the no-reply address, ADMIN_EMAIL and every operator but the owner, never the alias or Zola', () => {
  assert.deepEqual([...mail.businessEmails].sort(), [GMAIL_MAILBOX, NO_REPLY, 'office-desk@example.com', 'old-box@example.com',
    'second-box@example.com', 'ops-two@example.com'].sort());
  assert.ok(mail.ownEmails.has('ops-one@example.com'), 'the owner (users.id 1) is still ours, never a person');
  const aliasAsAdmin = buildPeopleIndex({ env: { ADMIN_EMAIL: PERSONAL_ALIAS.replace('@', '+desk@') } });
  assert.equal([...aliasAsAdmin.businessEmails].some((a) => a.startsWith('dallas')), false, 'the alias, even +tagged, is never business');
  assert.ok(aliasAsAdmin.ownEmails.has(PERSONAL_ALIAS.replace('@', '+desk@')), 'though it is still ours');
});

test('personalEmailKey: an e- key of its own, never the business e- key of any address, stable, and null for no address', () => {
  const { personalEmailKey, emailHash } = require('./people');
  const key = personalEmailKey(' Friend.R@Example.com ');
  assert.match(key, /^e-[0-9a-f]{16}$/);
  assert.deepEqual(parsePersonKey(key), { type: 'e', id: key.slice(2) });
  assert.equal(key, personalEmailKey('friend.r@example.com'), 'trimmed and lowercased first');
  assert.equal(key, `e-${crypto.createHash('sha256').update('PERSONAL:friend.r@example.com').digest('hex').slice(0, 16)}`);
  assert.notEqual(key, `e-${emailHash('friend.r@example.com')}`, 'not the business key of the same address');
  for (const typed of ['personal:friend.r@example.com', 'PERSONAL:friend.r@example.com', ' Personal:Friend.R@Example.com']) {
    assert.notEqual(`e-${emailHash(typed)}`, key, `an address typed as ${typed} never hashes to it`);
  }
  // A client row holding that typed value: keyByEmailHash never maps the personal key.
  const typedClient = buildPeopleIndex({ env: {}, clients: [{ id: 60, name: 'Typed', phone: null, email: 'PERSONAL:friend.r@example.com', created_at: T('2026-09-01T00:00:00Z') }] });
  assert.equal(typedClient.keyByEmailHash.has(key), false);
  assert.deepEqual([personalEmailKey(''), personalEmailKey(null)], [null, null]);
});

test('untagged: the +tag on the local part is cut, case and spaces too; an address with no local part is left alone', () => {
  const { untagged } = require('./people');
  assert.deepEqual([untagged(' Dallas+Wedding@DrBartender.com '), untagged('contact@drbartender.com'), untagged('@x.com'), untagged('a+b+c@x.com')],
    ['dallas@drbartender.com', 'contact@drbartender.com', '@x.com', 'a@x.com']);
});

test('an index built without email inputs still answers', () => {
  const bare = buildPeopleIndex({ env: {} });
  assert.equal(bare.resolveEmail(GMAIL_MAILBOX), null);
  assert.match(bare.resolveEmail('stranger@example.com'), /^e-[0-9a-f]{16}$/);
  assert.equal(bare.keyByEmailHash.size, 0);
  assert.equal(bare.zolaLeadsById.size, 0);
  assert.equal(bare.leadNameOf('casey@example.com'), null);
});

// The Gmail sync's slim index (gmailSync.js's default loadIndex): the same
// ownEmails and resolveEmail as the full index, from three reads, not seven.
test('loadEmailIndex answers ownEmails and resolveEmail exactly as loadPeopleIndex does, from three reads', async () => {
  const {
    loadPeopleIndex, loadEmailIndex, EMAIL_CLIENTS_SQL, PEOPLE_CLIENTS_SQL, PEOPLE_STAFF_SQL, PEOPLE_OPERATORS_SQL,
  } = require('./people');
  const env = { ADMIN_EMAIL: 'Office-Desk@Example.com', INBOX_OWN_EMAILS: 'old-box@example.com' };
  const clients = [
    { id: 40, name: 'Pat Newer', phone: null, email: 'pat@example.com', created_at: T('2026-09-01T00:00:00Z') },
    { id: 41, name: 'Pat Older', phone: null, email: 'Pat@Example.com', created_at: T('2026-08-01T00:00:00Z') },
    { id: 42, name: 'Jo Shared', phone: null, email: 'shared@example.com', created_at: T('2026-08-15T00:00:00Z') },
    { id: 44, name: 'No Email', phone: '+13125550140', email: null, created_at: T('2026-08-21T00:00:00Z') },
  ];
  const staff = [
    { id: 50, role: 'staff', phone: null, email: BUSINESS_STAFFER, updated_at: T('2026-09-01T00:00:00Z'), name: 'Kai B.' },
    { id: 53, role: 'staff', phone: null, email: 'dup@example.com', updated_at: T('2026-08-01T00:00:00Z'), name: 'Dee Older' },
    { id: 54, role: 'staff', phone: null, email: 'Dup@Example.com', updated_at: T('2026-09-05T00:00:00Z'), name: 'Dee Newer' },
    { id: 51, role: 'staff', phone: null, email: 'shared@example.com', updated_at: T('2026-09-01T00:00:00Z'), name: 'Jo S.' },
  ];
  const operators = [{ id: 1, role: 'admin', phone: null, presence_nudge_phone: null, email: 'Ops-One@Example.com', name: 'Op One' }];
  const asked = [];
  const db = {
    query: async (sql) => {
      asked.push(sql);
      if (sql === EMAIL_CLIENTS_SQL) return { rows: clients.filter((c) => c.email !== null) };
      if (sql === PEOPLE_CLIENTS_SQL) return { rows: clients };
      if (sql === PEOPLE_STAFF_SQL) return { rows: staff };
      if (sql === PEOPLE_OPERATORS_SQL) return { rows: operators };
      return { rows: [] };
    },
  };
  const full = await loadPeopleIndex(db, env);
  asked.length = 0;
  const slim = await loadEmailIndex(db, env);
  assert.deepEqual(asked, [EMAIL_CLIENTS_SQL, PEOPLE_STAFF_SQL, PEOPLE_OPERATORS_SQL], 'three reads, no leads, phones or marketing rows');
  assert.deepEqual([...slim.ownEmails].sort(), [...full.ownEmails].sort());
  assert.deepEqual([...slim.businessEmails].sort(), [...full.businessEmails].sort(), 'the personal check reads the same business addresses');
  const addresses = [
    GMAIL_MAILBOX, PERSONAL_ALIAS, 'office-desk@example.com', 'old-box@example.com', 'OPS-ONE@example.com', ZOLA_VENDOR_ADDRESS,
    'pat@example.com', 'PAT@example.com', 'shared@example.com', BUSINESS_STAFFER, 'dup@example.com', 'stranger@example.com', '', null,
  ];
  assert.deepEqual(addresses.map((a) => slim.resolveEmail(a)), addresses.map((a) => full.resolveEmail(a)));
  assert.deepEqual([slim.resolveEmail('pat@example.com'), slim.resolveEmail('dup@example.com')], ['c-40', 's-54'],
    'the newest client, and the newest staff profile, as the full index decides');
});

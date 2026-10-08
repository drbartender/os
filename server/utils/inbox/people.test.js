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
  assert.equal(mapSmsHeader(row({ recipient_phone: '+447700900123' }), index).personKey, 'p-7700900123');
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

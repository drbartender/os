const { test } = require('node:test');
const assert = require('node:assert/strict');
const k = require('./rules.testkit');
const C = require('./classify');
const { normalizeEvents } = require('./normalize');
const { INBOX_HISTORY_START, TT_MISSED_TEXT } = require('./constants');

const { DALLAS, ZUL, HOUR, MIN, ago, plus } = k;

test('a text in both sms_messages and message_log is one event, keyed sms:, with the ledger author and type', () => {
  // The "Send to client" SMS: sms_messages.sender_id is NULL by design, the ledger twin carries sent_by.
  const sms = k.smsOut('c-1', ago(2 * HOUR), 'Here is your proposal', { sender: null, twilioSid: 'SMtwin0001', messageType: 'initial_proposal' });
  const ledger = k.mlSend('c-1', plus(ago(2 * HOUR), 400), { channel: 'text', messageType: 'initial_proposal', sentBy: ZUL, providerId: 'SMtwin0001', proposalId: 11 });
  const out = normalizeEvents([ledger, sms]);
  assert.deepEqual(out.map((e) => e.ref), [sms.ref]);
  assert.equal(out[0].meta.ledgerSentBy, ZUL);
  assert.equal(out[0].meta.ledgerMessageType, 'initial_proposal');
  assert.equal(out[0].meta.failed, false);
  const failedLedger = { ...ledger, meta: { ...ledger.meta, failed: true } };
  assert.equal(normalizeEvents([failedLedger, sms])[0].meta.failed, true, 'either half failing fails the send');
});

test('a send that threw is one event: the failed SID-less text and the failed provider-less ledger row pair within 10 seconds', () => {
  const at = ago(2 * HOUR);
  const sms = k.smsOut('c-6', at, 'See you Saturday', { sender: DALLAS, failed: true, failureReason: 'Twilio 21211 (failed)' });
  const ledger = k.mlSend('c-6', plus(at, 3 * 1000), { channel: 'text', messageType: 'inbox_text', sentBy: DALLAS, failed: true });
  const out = normalizeEvents([ledger, sms]);
  assert.deepEqual(out.map((e) => e.ref), [sms.ref]);
  assert.deepEqual([out[0].meta.failed, out[0].meta.ledgerMessageType], [true, 'inbox_text']);
  const late = k.mlSend('c-6', plus(at, 11 * 1000), { channel: 'text', messageType: 'inbox_text', sentBy: DALLAS, failed: true });
  assert.equal(normalizeEvents([late, sms]).length, 2, 'more than 10 seconds apart: two attempts');
  const someoneElse = k.smsOut('c-7', at, 'See you Saturday', { sender: DALLAS, failed: true });
  assert.equal(normalizeEvents([ledger, someoneElse]).length, 2, 'never across people');
  const sent = k.smsOut('c-6', at, 'See you Saturday', { sender: DALLAS, twilioSid: 'SMsent0001' });
  assert.equal(normalizeEvents([ledger, sent]).length, 2, 'a text that went out is not the failed ledger row');
});

test('a proposal send absorbs its deliveries within 5 minutes either side; a lone ledger send stands (send_now)', () => {
  const at = ago(3 * HOUR);
  const pal = k.palSend('c-2', at, { actor: ZUL, proposalId: 90 });
  const email = k.mlSend('c-2', plus(at, 30 * 1000), { messageType: 'proposal_sent', proposalId: 90, sentBy: ZUL });
  const earlier = k.mlSend('c-2', plus(at, -2 * MIN), { messageType: 'proposal_sent_sms', proposalId: 90, sentBy: ZUL });
  const late = k.mlSend('c-2', plus(at, 6 * MIN), { messageType: 'proposal_sent', proposalId: 90, sentBy: ZUL });
  const invoice = k.mlSend('c-2', plus(at, MIN), { messageType: 'invoice_sent', proposalId: 90, sentBy: ZUL });
  const out = normalizeEvents([pal, email, earlier, late, invoice]);
  const refs = out.map((e) => e.ref);
  assert.ok(refs.includes(pal.ref));
  assert.ok(!refs.includes(email.ref) && !refs.includes(earlier.ref), 'absorbed on either side of the activity row');
  assert.ok(refs.includes(late.ref), 'six minutes away is a send of its own');
  assert.ok(refs.includes(invoice.ref), 'an invoice is not a proposal delivery');
  assert.equal(out.find((e) => e.ref === pal.ref).meta.deliveries.length, 2);
  const lone = k.mlSend('c-3', ago(HOUR), { messageType: 'proposal_sent', proposalId: 91, sentBy: DALLAS });
  assert.deepEqual(normalizeEvents([lone]).map((e) => e.ref), [lone.ref]);
});

test('an absorbed SMS delivery takes its twin failure, and the twin keeps the human author', () => {
  const at = ago(5 * HOUR);
  const pal = k.palSend('c-4', at, { actor: DALLAS, proposalId: 92 });
  const sms = k.smsOut('c-4', plus(at, 20 * 1000), 'Your proposal is ready', { sender: null, twilioSid: 'SMtwin0002', failed: true, messageType: 'initial_proposal' });
  const ledger = k.mlSend('c-4', plus(at, 20 * 1000), { channel: 'text', messageType: 'initial_proposal', proposalId: 92, sentBy: DALLAS, providerId: 'SMtwin0002' });
  const out = normalizeEvents([pal, sms, ledger]);
  assert.deepEqual(out.map((e) => e.ref).sort(), [pal.ref, sms.ref].sort());
  assert.deepEqual(out.find((e) => e.ref === pal.ref).meta.deliveries, [{ ref: sms.ref, channel: 'text', failed: true }]);
  assert.equal(out.find((e) => e.ref === sms.ref).meta.ledgerSentBy, DALLAS);
});

test('one comparison send: its group_sent rows collapse into one event that absorbs the group email', () => {
  const at = ago(6 * HOUR);
  const g1 = k.palSend('c-5', at, { action: 'group_sent', proposalId: 101, actor: DALLAS, id: 501 });
  const g2 = k.palSend('c-5', plus(at, 1000), { action: 'group_sent', proposalId: 102, actor: DALLAS, id: 502 });
  const email = k.mlSend('c-5', plus(at, 20 * 1000), { messageType: 'proposal_options_sent', proposalId: 101, sentBy: DALLAS });
  const out = normalizeEvents([g2, email, g1]);
  assert.deepEqual(out.map((e) => e.ref), ['pal:501']);
  assert.deepEqual([...out[0].meta.proposalIds].sort((a, b) => a - b), [101, 102]);
  assert.equal(out[0].meta.deliveries.length, 1);
});

test('missed Thumbtack: an unmatched relay notice becomes an item, a matched one is dropped, 15 minutes is the edge', () => {
  const said = ago(2 * HOUR);
  const customer = k.ttIn('c-6', said, 'Is the date still open?', { negotiationId: 'neg-6' });
  const matched = k.relayNotice('c-6', plus(said, 15 * MIN), { negotiationId: 'neg-6' });
  const missed = k.relayNotice('c-6', plus(said, 15 * MIN + 1000), { negotiationId: 'neg-6' });
  const out = normalizeEvents([customer, matched, missed]);
  assert.ok(!out.some((e) => e.ref === matched.ref));
  const item = out.find((e) => e.ref === missed.ref);
  assert.deepEqual([item.kind, item.channel, item.direction, item.text], ['tt_missed', 'thumbtack', 'in', TT_MISSED_TEXT]);
});

test('a relay notice that quotes their words is their Thumbtack message, not tt_missed; a matched one is still dropped (Task 18 F1)', () => {
  const notice = k.relayNotice('c-11', ago(3 * HOUR), { negotiationId: 'neg-11', quoted: true });
  const [item] = normalizeEvents([notice]); // no Customer Thumbtack row within 15 minutes (24 of 24 on prod)
  assert.deepEqual([item.kind, item.channel, item.direction, item.line], ['message', 'thumbtack', 'in', null]);
  assert.deepEqual([item.text, item.meta.negotiationId, item.meta.relayQuoted], [notice.text, 'neg-11', true]);
  assert.equal(C.isCountedInbound(item), true);
  assert.equal(C.aiCannotClose(item), false);
  const customer = k.ttIn('c-11', plus(notice.at, -5 * MIN), 'Got it, we will review and get back to you.', { negotiationId: 'neg-11' });
  assert.deepEqual(normalizeEvents([customer, notice]).map((e) => e.ref), [customer.ref], 'the Thumbtack row carries the same words');
});

test('an ambiguous word that also opted the person out gets an "Opted out" companion; a bare STOP is already a line', () => {
  const cancel = k.smsIn('c-7', ago(HOUR), 'Cancel', { optKeyword: 'stop' });
  assert.deepEqual(
    normalizeEvents([cancel]).map((e) => [e.ref, e.kind, e.direction]),
    [[cancel.ref, 'message', 'in'], [`${cancel.ref}:opt_out`, 'opt_out', 'system']]
  );
  assert.deepEqual(normalizeEvents([k.optLine('c-7', ago(HOUR), 'stop')]).map((e) => e.kind), ['opt_out']);
});

test('the auto first reply is the one Business message closest to first_reply_sent_at, within 2 minutes', () => {
  const sentAt = ago(4 * HOUR);
  const opts = { negotiationId: 'neg-8', firstReplySentAt: sentAt };
  const manual = k.ttOut('c-8', plus(sentAt, -10 * MIN), 'Hi, Dallas here', opts);
  const auto = k.ttOut('c-8', plus(sentAt, 40 * 1000), 'Hi there, we are reviewing your request', opts);
  const near = k.ttOut('c-8', plus(sentAt, 100 * 1000), 'Also, what time works?', opts);
  const flags = Object.fromEntries(normalizeEvents([manual, auto, near]).map((e) => [e.ref, Boolean(e.meta.autoFirstReply)]));
  assert.deepEqual(flags, { [manual.ref]: false, [auto.ref]: true, [near.ref]: false });
});

test('refs and order are identical whatever order the readers return rows in', () => {
  const at = ago(7 * HOUR);
  const rows = [
    k.smsIn('c-9', at, 'First'),
    k.smsOut('c-9', at, 'Same-instant reply', { sender: ZUL }),
    k.palSend('c-9', plus(at, MIN), { actor: ZUL, proposalId: 93 }),
    k.mlSend('c-9', plus(at, 2 * MIN), { messageType: 'proposal_sent', proposalId: 93, sentBy: ZUL }),
    k.smsIn('c-9', plus(at, 3 * MIN), 'Cancel', { optKeyword: 'stop' }),
  ];
  const a = normalizeEvents(rows).map((e) => e.ref);
  assert.deepEqual(normalizeEvents([...rows].reverse()).map((e) => e.ref), a);
  assert.deepEqual(normalizeEvents(normalizeEvents(rows)).map((e) => e.ref), a, 'normalized input passes through unchanged');
});

test('nothing before the history floor survives', () => {
  const floorMs = new Date(INBOX_HISTORY_START).getTime();
  const before = k.smsIn('c-10', new Date(floorMs - 1000), 'Old news');
  const after = k.smsIn('c-10', new Date(floorMs + 1000), 'Still waiting');
  assert.deepEqual(normalizeEvents([before, after]).map((e) => e.ref), [after.ref]);
});

test('a delivery goes to the nearest send of its own proposal; on a tie, to the lower activity id', () => {
  const at = ago(5 * HOUR);
  const early = k.palSend('c-12', at, { actor: ZUL, proposalId: 120, id: 702 });
  const late = k.palSend('c-12', plus(at, 4 * MIN), { actor: ZUL, proposalId: 120, id: 701 });
  const other = k.palSend('c-12', plus(at, 2 * MIN), { actor: ZUL, proposalId: 121, id: 700 });
  const deliveries = (ledger) => {
    const out = normalizeEvents([early, late, other, ledger]);
    return [early, late, other].map((p) => out.find((e) => e.ref === p.ref).meta.deliveries.length);
  };
  const tie = k.mlSend('c-12', plus(at, 2 * MIN), { messageType: 'proposal_sent', proposalId: 120, sentBy: ZUL });
  assert.deepEqual(deliveries(tie), [0, 1, 0], 'two minutes from each: the lower id; never the other proposal\'s send');
  const nearer = k.mlSend('c-12', plus(at, MIN), { messageType: 'proposal_sent', proposalId: 120, sentBy: ZUL });
  assert.deepEqual(deliveries(nearer), [1, 0, 0], 'distance first, whatever the id');
});

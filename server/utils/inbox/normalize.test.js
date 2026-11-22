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

// The GV post (plan 2026-10-17 Task 12). The readers mark an echo (a Business
// Thumbtack row carrying a worked post's exact body) with meta.gvPost and an
// 888 fallback with meta.gvFallback; both carry the post's proposal and time.
const GV_BODY = 'Your proposal is ready: https://drbartender.com/proposal/00000000-0000-4000-8000-000000000001';
const gvEcho = (key, at, proposalId, postAt, opts = {}) => {
  const e = k.ttOut(key, at, GV_BODY, { negotiationId: `neg-${key}`, ...opts });
  e.meta.gvPost = { proposalId, postCreatedAt: new Date(postAt) };
  return e;
};
const gvFallback = (key, at, proposalId, postAt, opts = {}) => {
  const e = k.mlSend(key, at, { channel: 'text', messageType: 'initial_proposal', proposalId, sentBy: null, ...opts });
  e.meta.gvFallback = { proposalId, postCreatedAt: new Date(postAt) };
  return e;
};
const sendOf = (out, pal) => out.find((e) => e.ref === pal.ref);

test('a GV echo is absorbed into its proposal send as a thumbtack delivery', () => {
  const at = ago(3 * HOUR);
  const pal = k.palSend('c-40', at, { actor: DALLAS, proposalId: 400 });
  const email = k.mlSend('c-40', plus(at, 20 * 1000), { messageType: 'proposal_sent', proposalId: 400, sentBy: DALLAS });
  const echo = gvEcho('c-40', plus(at, 3 * MIN), 400, plus(at, 5 * 1000));
  const out = normalizeEvents([pal, email, echo]);
  assert.deepEqual(out.map((e) => e.ref), [pal.ref], 'the echo is no reply of its own');
  assert.deepEqual(sendOf(out, pal).meta.deliveries.map((d) => [d.channel, d.failed]), [['email', false], ['thumbtack', false]]);
});

test('a text-only send with a GV echo reads delivered', () => {
  const at = ago(3 * HOUR);
  const pal = k.palSend('c-41', at, { actor: DALLAS, proposalId: 410 });
  assert.equal(C.countsAsReply(normalizeEvents([pal])[0]), false, 'with no delivery the send is no reply');
  const out = normalizeEvents([pal, gvEcho('c-41', plus(at, 2 * MIN), 410, plus(at, -30 * 1000))]);
  assert.deepEqual(out.map((e) => e.ref), [pal.ref]);
  assert.ok(sendOf(out, pal).meta.deliveries.some((d) => !d.failed));
  assert.equal(C.countsAsReply(out[0]), true);
});

test('an 888 fallback row 8 minutes after the send is absorbed into it', () => {
  const at = ago(3 * HOUR);
  const pal = k.palSend('c-42', at, { actor: DALLAS, proposalId: 420 });
  const fb = gvFallback('c-42', plus(at, 8 * MIN), 420, plus(at, 10 * 1000));
  const out = normalizeEvents([pal, fb]);
  assert.deepEqual(out.map((e) => e.ref), [pal.ref]);
  assert.deepEqual(sendOf(out, pal).meta.deliveries, [{ ref: fb.ref, channel: 'text', failed: false }]);
  const failed = gvFallback('c-42', plus(at, 8 * MIN), 420, plus(at, 10 * 1000), { failed: true });
  assert.equal(sendOf(normalizeEvents([pal, failed]), pal).meta.deliveries[0].failed, true, 'a failed fallback is a failed delivery');
});

test('an echo with no proposal send stays a counted reply', () => {
  const echo = gvEcho('c-43', ago(2 * HOUR), 430, plus(ago(2 * HOUR), -MIN));
  const out = normalizeEvents([echo]);
  assert.deepEqual(out.map((e) => e.ref), [echo.ref]);
  assert.equal(C.countsAsReply(out[0]), true);
  const otherProposal = k.palSend('c-43', ago(2 * HOUR), { actor: DALLAS, proposalId: 431 });
  assert.deepEqual(normalizeEvents([otherProposal, echo]).map((e) => e.ref).sort(), [otherProposal.ref, echo.ref].sort(),
    'another proposal\'s send never takes it');
});

test('a resend\'s echo and fallback never attach to an older send', () => {
  const first = ago(5 * HOUR);
  const pal = k.palSend('c-44', first, { actor: DALLAS, proposalId: 440 });
  const resendAt = plus(first, 2 * HOUR); // the SendModal resend writes no activity row
  const echo = gvEcho('c-44', plus(resendAt, MIN), 440, resendAt);
  const fb = gvFallback('c-44', plus(resendAt, 6 * MIN), 440, resendAt);
  const edge = gvEcho('c-44', plus(first, 3 * MIN), 440, plus(first, 2 * MIN + 1000), { id: 9441 });
  const out = normalizeEvents([pal, echo, fb, edge]);
  assert.deepEqual(sendOf(out, pal).meta.deliveries, [], 'two minutes and a second from the send is too far');
  assert.deepEqual(out.map((e) => e.ref).sort(), [pal.ref, echo.ref, fb.ref, edge.ref].sort());
});

test('an auto fallback with its sms_messages twin reads delivered', () => {
  const at = ago(4 * HOUR);
  const pal = k.palSend('c-45', at, { actor: null, proposalId: 450 });
  const sms = k.smsOut('c-45', plus(at, 7 * MIN), 'Your proposal is ready', { sender: null, twilioSid: 'SMgvtwin0001', messageType: 'initial_proposal' });
  const fb = gvFallback('c-45', plus(at, 7 * MIN), 450, plus(at, 3 * 1000), { providerId: 'SMgvtwin0001' });
  const out = normalizeEvents([pal, sms, fb]);
  assert.deepEqual(out.map((e) => e.ref), [pal.ref], 'the fallback and its twin go into the send');
  assert.deepEqual(sendOf(out, pal).meta.deliveries, [{ ref: sms.ref, channel: 'text', failed: false }]);
});

test('a fallback the 5-minute absorb already took is not delivered twice', () => {
  const at = ago(4 * HOUR);
  const pal = k.palSend('c-46', at, { actor: DALLAS, proposalId: 460 });
  const fb = gvFallback('c-46', plus(at, 4 * MIN), 460, plus(at, -20 * 1000));
  const out = normalizeEvents([pal, fb]);
  assert.deepEqual(out.map((e) => e.ref), [pal.ref]);
  assert.equal(sendOf(out, pal).meta.deliveries.length, 1);
});

test('a GV echo is never a holding reply', () => {
  const sentAt = ago(4 * HOUR);
  const opts = { negotiationId: 'neg-47', firstReplySentAt: sentAt };
  const echo = gvEcho('c-47', plus(sentAt, 30 * 1000), 470, plus(sentAt, 20 * 1000), opts);
  const auto = k.ttOut('c-47', plus(sentAt, 60 * 1000), 'Hi there, we are reviewing your request', opts);
  const out = normalizeEvents([echo, auto]);
  const flags = Object.fromEntries(out.map((e) => [e.ref, Boolean(e.meta.autoFirstReply)]));
  assert.deepEqual(flags, { [echo.ref]: false, [auto.ref]: true }, 'the nearer echo never takes the auto first reply');
  assert.equal(C.isHolding(out.find((e) => e.ref === echo.ref), new Map(), false), false);
});

test('a hand paste of a worked post\'s wording an hour later is a reply of its own, never a second delivery', () => {
  const at = ago(5 * HOUR);
  const pal = k.palSend('c-48', at, { actor: DALLAS, proposalId: 480 });
  const postAt = plus(at, 5 * 1000);
  const echo = gvEcho('c-48', plus(postAt, MIN), 480, postAt);
  const ask = k.ttIn('c-48', plus(postAt, 30 * MIN), 'Nothing came through on my end', { negotiationId: 'neg-c-48' });
  const paste = gvEcho('c-48', plus(postAt, 60 * MIN), 480, postAt);
  const out = normalizeEvents([pal, echo, ask, paste]);
  assert.deepEqual(out.map((e) => e.ref), [pal.ref, ask.ref, paste.ref]);
  assert.equal(out[2].direction, 'out');
  assert.equal(C.countsAsReply(out[2]), true);
  assert.equal(sendOf(out, pal).meta.deliveries.filter((d) => d.channel === 'thumbtack').length, 1, 'the first echo decides');
  const noEcho = normalizeEvents([pal, ask, paste]);
  assert.deepEqual(noEcho.map((e) => e.ref), [pal.ref, ask.ref, paste.ref]);
  assert.deepEqual(sendOf(noEcho, pal).meta.deliveries, []);
});

test('an echo 10 minutes after its post is still absorbed', () => {
  const at = ago(3 * HOUR);
  const pal = k.palSend('c-49', at, { actor: DALLAS, proposalId: 490 });
  const out = normalizeEvents([pal, gvEcho('c-49', plus(at, 10 * MIN), 490, at)]);
  assert.deepEqual(out.map((e) => e.ref), [pal.ref]);
  assert.equal(sendOf(out, pal).meta.deliveries[0].channel, 'thumbtack');
});

test('an echo exactly 15 minutes after its post is absorbed; one millisecond more stands', () => {
  const at = ago(3 * HOUR);
  const pal = k.palSend('c-50', at, { actor: DALLAS, proposalId: 500 });
  const edge = gvEcho('c-50', plus(at, 15 * MIN), 500, at);
  assert.deepEqual(normalizeEvents([pal, edge]).map((e) => e.ref), [pal.ref]);
  const over = gvEcho('c-50', plus(at, 15 * MIN + 1), 500, at);
  const out = normalizeEvents([pal, over]);
  assert.deepEqual(out.map((e) => e.ref), [pal.ref, over.ref]);
  assert.deepEqual(sendOf(out, pal).meta.deliveries, []);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const k = require('./rules.testkit');

const { DALLAS, ZUL, HOUR, MIN, ago, plus, run, stateOf } = k;

test('cross-channel: a reply on a channel a later piece adds (a stubbed email reader) closes a text', () => {
  const q = k.smsIn('c-101', ago(5 * HOUR), 'Do you have availability on the 12th?');
  const emailReply = {
    ref: 'gm:abc1', personKey: 'c-101', channel: 'email', line: null, direction: 'out', at: ago(4 * HOUR),
    author: ZUL, kind: 'message', text: 'Yes, we can do the 12th.', meta: { source: 'gmail', id: 1, textBearing: true },
  };
  assert.equal(stateOf(run({ events: [q] }), 'c-101').status, 'waiting');
  const s = stateOf(run({ events: [q, emailReply] }), 'c-101');
  assert.equal(s.status, 'handled');
  assert.deepEqual([s.closed.reasonCode, s.closed.reasonText, s.closed.by], ['reply', 'Zul replied', 'Z']);
});

test('Thumbtack: the auto first reply is holding, so the lead waits as a promise', () => {
  const sentAt = ago(6 * HOUR);
  const ask = k.ttIn('c-102', ago(6 * HOUR + 5 * MIN), 'Looking for two bartenders in May', { negotiationId: 'neg-102' });
  const auto = k.ttOut('c-102', plus(sentAt, 30 * 1000), 'Hi there, we are reviewing your request', { negotiationId: 'neg-102', firstReplySentAt: sentAt });
  const s = stateOf(run({ events: [ask, auto] }), 'c-102');
  assert.equal(s.status, 'waiting');
  assert.deepEqual([s.state.type, s.state.byUserId, s.state.mine], ['promise', null, false]);
  assert.deepEqual(s.channels, ['thumbtack']);
});

test('Thumbtack: a manual reply far from first_reply_sent_at is a real reply; the later agent template is the promise', () => {
  const sentAt = ago(3 * HOUR);
  const ask = k.ttIn('c-103', ago(5 * HOUR), 'Do you do mocktails?', { negotiationId: 'neg-103' });
  const manual = k.ttOut('c-103', ago(4 * HOUR), 'Yes we do, happy to help.', { negotiationId: 'neg-103', firstReplySentAt: sentAt });
  const alone = stateOf(run({ events: [ask, manual] }), 'c-103');
  assert.equal(alone.status, 'handled');
  assert.deepEqual([alone.closed.reasonText, alone.closed.by], ['Replied in Thumbtack', null]);
  const auto = k.ttOut('c-103', plus(sentAt, 45 * 1000), 'Hi there, we are reviewing your request', { negotiationId: 'neg-103', firstReplySentAt: sentAt });
  const both = stateOf(run({ events: [ask, manual, auto] }), 'c-103');
  assert.equal(both.status, 'waiting');
  assert.equal(both.state.type, 'promise');
});

test('Thumbtack: a proposal sent after the auto reply closes the lead when a delivery went out; a forced send counts too', () => {
  const sentAt = ago(10 * HOUR);
  const ask = k.ttIn('c-104', ago(10 * HOUR + 2 * MIN), 'Quote for a backyard party?', { negotiationId: 'neg-104' });
  const auto = k.ttOut('c-104', plus(sentAt, 20 * 1000), 'Hi there, we are reviewing your request', { negotiationId: 'neg-104', firstReplySentAt: sentAt });
  for (const action of ['status_changed', 'status_force_changed']) {
    const pal = k.palSend('c-104', ago(8 * HOUR), { action, actor: ZUL, proposalId: 404 });
    const email = k.mlSend('c-104', plus(ago(8 * HOUR), 40 * 1000), { messageType: 'proposal_sent', proposalId: 404, sentBy: ZUL });
    const s = stateOf(run({ events: [ask, auto, pal, email] }), 'c-104');
    assert.equal(s.status, 'handled', action);
    assert.deepEqual([s.closed.reasonCode, s.closed.reasonText, s.closed.by], ['proposal', 'Proposal sent by Zul', 'Z']);
  }
});

test('a proposal send whose every delivery failed, or that sent nothing at all, does not close', () => {
  const ask = k.smsIn('c-105', ago(9 * HOUR), 'Can I get a quote for 80 guests?');
  const pal = k.palSend('c-105', ago(8 * HOUR), { actor: DALLAS, proposalId: 505 });
  const failedEmail = k.mlSend('c-105', plus(ago(8 * HOUR), 30 * 1000), { messageType: 'proposal_sent', proposalId: 505, failed: true });
  const failedSms = k.mlSend('c-105', plus(ago(8 * HOUR), 50 * 1000), { channel: 'text', messageType: 'initial_proposal', proposalId: 505, sentBy: null, failed: true });
  assert.equal(stateOf(run({ events: [ask, pal, failedEmail, failedSms] }), 'c-105').status, 'waiting');
  assert.equal(stateOf(run({ events: [ask, pal] }), 'c-105').status, 'waiting', 'suppressed: no delivery at all');
});

test('send_now: a lone proposal-send ledger row closes the item, by email or through its SMS twin', () => {
  const ask = k.smsIn('c-111', ago(6 * HOUR), 'Can you quote 60 guests?');
  const email = k.mlSend('c-111', ago(5 * HOUR), { messageType: 'proposal_sent', sentBy: ZUL, proposalId: 711 });
  const viaEmail = stateOf(run({ events: [ask, email] }), 'c-111');
  assert.deepEqual([viaEmail.status, viaEmail.closed.reasonText], ['handled', 'Proposal sent by Zul']);
  const sms = k.smsOut('c-111', ago(5 * HOUR), 'Your proposal is ready', { sender: null, twilioSid: 'SMlone0001', messageType: 'initial_proposal' });
  const ledger = k.mlSend('c-111', ago(5 * HOUR), { channel: 'text', messageType: 'initial_proposal', sentBy: ZUL, providerId: 'SMlone0001', proposalId: 711 });
  const viaSms = stateOf(run({ events: [ask, sms, ledger] }), 'c-111');
  assert.deepEqual([viaSms.status, viaSms.closed.reasonCode, viaSms.closed.reasonText, viaSms.closed.by], ['handled', 'send', 'Proposal sent by Zul', 'Z']);
});

test('staff: a group text never answers one staffer; a single-recipient text does', () => {
  const ask = k.smsIn('s-201', ago(3 * HOUR), 'Can I swap Saturday for Sunday?', { channel: 'staff_text' });
  const group = k.smsOut('s-201', ago(2 * HOUR), 'Reminder: uniforms are black', { channel: 'staff_text', groupSize: 4, sender: ZUL });
  assert.equal(stateOf(run({ events: [ask, group] }), 's-201').status, 'waiting');
  assert.deepEqual(stateOf(run({ events: [ask] }), 's-201').channels, ['staff_text']);
  const single = k.smsOut('s-201', ago(1 * HOUR), 'Sure, swapped you to Sunday', { channel: 'staff_text', groupSize: 1, sender: ZUL });
  const s = stateOf(run({ events: [ask, group, single] }), 's-201');
  assert.deepEqual([s.status, s.closed.reasonText], ['handled', 'Zul texted back from 888']);
});

test('what does not close: receipts, refund and cancel notices, nudges, invites, disclosures and other', () => {
  const ask = k.smsIn('c-106', ago(10 * HOUR), 'Did my payment go through?');
  const types = ['payment_received', 'refund_notice', 'cancel_confirmation', 'gratuity_disclosure', 'line_item_removed_notice',
    'payment_reminder', 'payment_reminder_sms', 'portal_invite', 'drink_plan_nudge', 'drink_plan_nudge_sms', 'other'];
  for (const messageType of types) {
    const send = k.mlSend('c-106', ago(9 * HOUR), { messageType, sentBy: DALLAS });
    assert.equal(stateOf(run({ events: [ask, send] }), 'c-106').status, 'waiting', messageType);
  }
  const answer = k.mlSend('c-106', ago(9 * HOUR), { messageType: 'shopping_list_ready', sentBy: DALLAS });
  const s = stateOf(run({ events: [ask, answer] }), 'c-106');
  assert.deepEqual([s.status, s.closed.reasonText], ['handled', 'You sent the shopping list']);
});

test('a failed text never closes, and a text Twilio later reports failed re-opens the item', () => {
  const ask = k.smsIn('c-107', ago(6 * HOUR), 'What time do you arrive?');
  const failedNow = k.smsOut('c-107', ago(5 * HOUR), 'We arrive at 4', { failed: true });
  assert.equal(stateOf(run({ events: [ask, failedNow] }), 'c-107').status, 'waiting');
  const reply = k.smsOut('c-107', ago(5 * HOUR), 'We arrive at 4', { id: 9107 });
  assert.equal(stateOf(run({ events: [ask, reply] }), 'c-107').status, 'handled');
  const flipped = { ...reply, meta: { ...reply.meta, failed: true } }; // the status callback flipped the row
  assert.equal(stateOf(run({ events: [ask, flipped] }), 'c-107').status, 'waiting');
});

test('a bounced answering email never closes', () => {
  const ask = k.smsIn('c-108', ago(6 * HOUR), 'Is the shopping list ready?');
  const bounced = k.mlSend('c-108', ago(5 * HOUR), { messageType: 'shopping_list_ready', failed: true, bounced: true });
  assert.equal(stateOf(run({ events: [ask, bounced] }), 'c-108').status, 'waiting');
});

test('calls: 59 seconds does not close, 60 does, a consult the client never answered never does', () => {
  const ask = k.smsIn('c-109', ago(4 * HOUR), 'Please call me about the venue');
  assert.equal(stateOf(run({ events: [ask, k.call('c-109', ago(3 * HOUR), { durationSec: 59 })] }), 'c-109').status, 'waiting');
  const sixty = stateOf(run({ events: [ask, k.call('c-109', ago(3 * HOUR), { durationSec: 60 })] }), 'c-109');
  assert.deepEqual([sixty.status, sixty.closed.reasonText, sixty.closed.by], ['handled', 'You called (1 min)', 'D']);
  const noAnswer = k.call('c-109', ago(3 * HOUR), { source: 'cc', durationSec: 300, clientNoAnswer: true });
  assert.equal(stateOf(run({ events: [ask, noAnswer] }), 'c-109').status, 'waiting');
});

test('automated sends never count: a text with no sender, a log with no sent_by, a proposal no human sent', () => {
  const ask = k.smsIn('c-110', ago(8 * HOUR), 'Hello? Is anyone there?');
  const autoText = k.smsOut('c-110', ago(7 * HOUR), 'Reminder: your balance is due', { sender: null });
  const autoLog = k.mlSend('c-110', ago(7 * HOUR), { messageType: 'shopping_list_ready', sentBy: null });
  const sitePal = k.palSend('c-110', ago(7 * HOUR), { actor: null, actorRole: null, proposalId: 610 });
  const siteEmail = k.mlSend('c-110', plus(ago(7 * HOUR), 30 * 1000), { messageType: 'proposal_sent', proposalId: 610, sentBy: null });
  assert.equal(stateOf(run({ events: [ask, autoText, autoLog, sitePal, siteEmail] }), 'c-110').status, 'waiting');
});

// ─── Email and Zola (spec 2026-10-14 sections 5.4 and 4.5) ───

test('email: a Gmail reply closes a waiting email item, "Replied by email", by no one, and ends a claim', () => {
  const ask = k.gmIn('c-121', ago(5 * HOUR), 'Can we add a mocktail station?');
  const claim = k.act('c-121', 'claim', ago(210 * MIN), { userId: ZUL });
  assert.equal(stateOf(run({ events: [ask], actions: [claim] }), 'c-121').state.type, 'claim');
  const reply = k.gmOut('c-121', ago(3 * HOUR), 'Yes, we can add one.');
  const s = stateOf(run({ events: [ask, reply], actions: [claim] }), 'c-121');
  assert.deepEqual([s.status, s.closed.reasonCode, s.closed.reasonText, s.closed.by, s.closed.channel],
    ['handled', 'email', 'Replied by email', null, 'email']);
  const again = k.gmIn('c-121', ago(2 * HOUR), 'Great, and a second bar?');
  const reopened = stateOf(run({ events: [ask, reply, again], actions: [claim] }), 'c-121');
  assert.deepEqual([reopened.status, reopened.state.type], ['waiting', 'unseen'], 'the reply ended the claim');
});

test('email: a bounced Gmail reply does not close; a reply holds when its outbound read says holding', () => {
  const ask = k.gmIn('c-122', ago(5 * HOUR), 'What time do you arrive?');
  const bounced = k.gmOut('c-122', ago(4 * HOUR), 'We arrive at 4', { failed: true });
  assert.equal(stateOf(run({ events: [ask, bounced] }), 'c-122').status, 'waiting');
  const hold = k.gmOut('c-122', ago(3 * HOUR), 'Let me check with the team and get back to you');
  const s = stateOf(run({ events: [ask, hold], reads: [k.readRow('outbound', hold, { holding: true, promised_by: 'Monday' })] }), 'c-122');
  assert.deepEqual([s.status, s.state.type, s.state.byUserId, s.state.promisedBy], ['waiting', 'promise', null, 'Monday']);
});

test('email: a Sent mail to several people is read once, under its readRef, and every sibling honors that read', () => {
  const a = k.gmIn('c-123', ago(5 * HOUR), 'Is the 12th open?');
  const b = k.gmIn('c-124', ago(5 * HOUR), 'Same question from the planner');
  const toA = k.gmOut('c-123', ago(4 * HOUR), 'Let me check and get back to you both', { gmailId: 'gShared', n: 1 });
  const toB = k.gmOut('c-124', ago(4 * HOUR), 'Let me check and get back to you both', { gmailId: 'gShared', n: 2 });
  const read = { ...k.readRow('outbound', toA, { holding: true }), subject_ref: 'gm:gShared' };
  const r = run({ events: [a, b, toA, toB], reads: [read] });
  assert.deepEqual([stateOf(r, 'c-123').state.type, stateOf(r, 'c-124').state.type], ['promise', 'promise']);
});

test('email: two staff recipients answer no staffer; a client and their planner on one mail both close', () => {
  const q1 = k.gmIn('s-221', ago(5 * HOUR), 'Can I swap Saturday?', { address: 'kai@example.com' });
  const q2 = k.gmIn('s-222', ago(5 * HOUR), 'Is parking covered?', { address: 'rae@example.com' });
  const g1 = k.gmOut('s-221', ago(4 * HOUR), 'Uniforms are black', { gmailId: 'gStaff', n: 1, staffGroup: true });
  const g2 = k.gmOut('s-222', ago(4 * HOUR), 'Uniforms are black', { gmailId: 'gStaff', n: 2, staffGroup: true });
  const staff = run({ events: [q1, q2, g1, g2] });
  assert.deepEqual([stateOf(staff, 's-221').status, stateOf(staff, 's-222').status], ['waiting', 'waiting']);
  const c = k.gmIn('c-125', ago(5 * HOUR), 'Can we see the menu?');
  const p = k.gmIn('c-126', ago(5 * HOUR), 'Planner here, same question');
  const r1 = k.gmOut('c-125', ago(4 * HOUR), 'Here is the menu', { gmailId: 'gBoth', n: 1 });
  const r2 = k.gmOut('c-126', ago(4 * HOUR), 'Here is the menu', { gmailId: 'gBoth', n: 2 });
  const both = run({ events: [c, p, r1, r2] });
  assert.deepEqual([stateOf(both, 'c-125').status, stateOf(both, 'c-126').status], ['handled', 'handled']);
});

test('zola: a Gmail reply to a Zola notice closes it, "Replied to Zola by email"', () => {
  const ask = k.zolaEvent('z-31', ago(5 * HOUR), 'Is June 6 open?', { leadId: 31 });
  const reply = k.zolaEvent('z-31', ago(4 * HOUR), 'June 6 is open', { leadId: 31, template: 'out' });
  const s = stateOf(run({ events: [ask, reply] }), 'z-31');
  assert.deepEqual([s.status, s.closed.reasonCode, s.closed.reasonText, s.closed.by, s.closed.channel],
    ['handled', 'zola', 'Replied to Zola by email', null, 'zola']);
});

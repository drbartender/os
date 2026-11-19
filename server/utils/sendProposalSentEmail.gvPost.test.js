'use strict';

// The initial proposal text's GV routing (spec 2026-10-17, plan Task 5): an
// admin send asks routeProposalText first, and a queued or merged GV post
// replaces the toll-free text; the website wizard and the 888 fallback never
// route. No DB: the router, the sender and the email are stubbed through the
// module's __setDeps.
//   node --test server/utils/sendProposalSentEmail.gvPost.test.js
require('dotenv').config();
if (process.env.NODE_ENV === 'production') {
  throw new Error('sendProposalSentEmail.gvPost.test.js refuses to run against production');
}
process.env.SEND_NOTIFICATIONS = 'false';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const smsTemplates = require('./smsTemplates');
const { proposalUrl } = require('./urls');
const { formatEventDateForSms } = require('./smsEventDate');
const { getEventTypeLabel } = require('./eventTypes');
const { sendProposalSentEmail, sendInitialProposalText, __setDeps } = require('./sendProposalSentEmail');

const TOKEN = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
const proposal = {
  id: 4242, token: TOKEN, status: 'sent',
  event_type: 'birthday-party', event_type_custom: null, event_date: null,
  client_id: 77, client_name: 'Pat Example', client_email: 'pat@example.test',
  client_phone: '7735550142',
  communication_preferences: { sms_enabled: true }, email_status: 'ok', phone_status: 'ok',
};
const expectedBody = smsTemplates.initialProposalSms({
  eventTypeLabel: getEventTypeLabel({ event_type: 'birthday-party', event_type_custom: null }),
  eventDate: formatEventDateForSms(null),
  link: proposalUrl(TOKEN),
});

let routeCalls;
let smsCalls;
function stub({ route = { route: 'twilio', reason: 'not_relay' }, smsThrows = false } = {}) {
  routeCalls = [];
  smsCalls = [];
  __setDeps({
    sendEmail: () => Promise.resolve({ id: 'dev-skipped' }),
    emailTemplates: { proposalSent: () => ({ subject: 'S', html: 'H' }) },
    routeProposalText: (args) => { routeCalls.push(args); return Promise.resolve(route); },
    sendAndLogSms: (args) => {
      smsCalls.push(args);
      if (smsThrows) return Promise.reject(new Error('Twilio down'));
      return Promise.resolve({ sid: 'SM-test', status: 'sent' });
    },
    Sentry: { captureException: () => {} },
  });
}

test('admin initial send to a relay client returns queued and never calls sendAndLogSms', async () => {
  stub({ route: { route: 'gv', id: 9 } });
  assert.equal(await sendInitialProposalText(proposal, { sentBy: 5, actorType: 'admin' }), 'queued');
  assert.equal(smsCalls.length, 0);
  assert.equal(routeCalls.length, 1);
  assert.deepEqual(routeCalls[0], { proposalId: 4242, token: TOKEN, body: expectedBody, sentBy: 5, sendPath: 'auto' });

  // A send merged into the open post is queued too, and the full send path
  // (lifecycle and crud call sendProposalSentEmail) never texts beside it.
  stub({ route: { route: 'merged', id: 9 } });
  assert.equal(await sendInitialProposalText(proposal, { sentBy: 5 }), 'queued');
  await sendProposalSentEmail(proposal, { actorType: 'admin', sentBy: 5 });
  assert.equal(routeCalls.length, 2);
  assert.equal(smsCalls.length, 0);
});

test('admin initial send to a non-relay client texts as today', async () => {
  stub({ route: { route: 'twilio', reason: 'not_relay' } });
  assert.equal(await sendInitialProposalText(proposal, { sentBy: 5, actorType: 'admin' }), 'sent');
  assert.equal(routeCalls.length, 1);
  assert.equal(smsCalls.length, 1);
  assert.deepEqual(smsCalls[0], {
    to: '7735550142', body: expectedBody, clientId: 77, proposalId: 4242,
    messageType: 'initial_proposal', recipientName: 'Pat Example', sentBy: 5,
  });
});

test('wizard send with actorType client never routes', async () => {
  stub({ route: { route: 'gv', id: 9 } });
  await sendProposalSentEmail(proposal, { actorType: 'client' });
  assert.equal(routeCalls.length, 0, 'the website wizard keeps today\'s text');
  assert.equal(smsCalls.length, 1);
  assert.equal(await sendInitialProposalText(proposal, { actorType: 'client' }), 'sent');
  assert.equal(routeCalls.length, 0);
});

test('via twilio skips the router', async () => {
  // The 888 fallback for an 'auto' post calls back in with via 'twilio'.
  stub({ route: { route: 'gv', id: 9 } });
  assert.equal(await sendInitialProposalText(proposal, { sentBy: 5, via: 'twilio' }), 'sent');
  assert.equal(routeCalls.length, 0);
  assert.equal(smsCalls.length, 1);
  assert.equal(smsCalls[0].messageType, 'initial_proposal');
});

test('a sendAndLogSms throw returns failed', async () => {
  stub({ smsThrows: true });
  assert.equal(await sendInitialProposalText(proposal, { sentBy: 5 }), 'failed');
  await assert.doesNotReject(() => sendProposalSentEmail(proposal, { actorType: 'admin', sentBy: 5 }));
});

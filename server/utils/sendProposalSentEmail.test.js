const { test } = require('node:test');
const assert = require('node:assert/strict');
const mod = require('./sendProposalSentEmail');
const { sendProposalSentEmail, __setDeps } = mod;

const baseProposal = {
  id: 42, token: 'tok-abc', client_email: 'client@example.com',
  client_name: 'Pat', event_type: 'Wedding', event_type_custom: null,
  sent_at: null,
};

test('sends the proposalSent template to the client', async () => {
  let captured = null;
  __setDeps({
    sendEmail: async (args) => { captured = args; },
    emailTemplates: { proposalSent: () => ({ subject: 'S', html: 'H' }) },
  });
  await sendProposalSentEmail(baseProposal, { actorType: 'admin' });
  assert.equal(captured.to, 'client@example.com');
  assert.equal(captured.subject, 'S');
});

test('never throws when sendEmail rejects', async () => {
  __setDeps({
    sendEmail: async () => { throw new Error('Resend down'); },
    emailTemplates: { proposalSent: () => ({ subject: 'S', html: 'H' }) },
  });
  await assert.doesNotReject(() => sendProposalSentEmail(baseProposal, { actorType: 'admin' }));
});

test('Sentry capture on email failure carries no client email / PII', async () => {
  const captures = [];
  __setDeps({
    // Raw Resend errors can embed the recipient address in the message.
    sendEmail: async () => { throw new Error('Resend rejected to=client@example.com'); },
    emailTemplates: { proposalSent: () => ({ subject: 'S', html: 'H' }) },
    Sentry: { captureException: (err, ctx) => captures.push({ err, ctx }) },
  });
  process.env.SENTRY_DSN_SERVER = 'test-dsn';
  await sendProposalSentEmail(baseProposal, { actorType: 'admin' });
  delete process.env.SENTRY_DSN_SERVER;
  assert.equal(captures.length, 1);
  const { err, ctx } = captures[0];
  // Must capture the SANITIZED error, not the raw Resend error.
  assert.ok(!/@/.test(err.message), 'captured error message must not contain an email');
  assert.ok(!JSON.stringify(ctx.extra).includes('@'), 'Sentry extra must not contain PII');
  assert.equal(ctx.extra.proposalId, 42);
});

test('still emails when sent_at is already set (no idempotency skip)', async () => {
  let called = false;
  __setDeps({
    sendEmail: async () => { called = true; },
    emailTemplates: { proposalSent: () => ({ subject: 'S', html: 'H' }) },
  });
  await sendProposalSentEmail({ ...baseProposal, sent_at: '2026-05-01T00:00:00Z' }, { actorType: 'admin' });
  assert.equal(called, true);
});

const assert2 = require('node:assert/strict');
const { test: test2 } = require('node:test');

test2('sendProposalSentEmail > fires the initial-proposal SMS when the client has a phone', async () => {
  const mod2 = require('./sendProposalSentEmail');
  let smsCalls = 0;
  let smsArgs = null;
  mod2.__setDeps({
    sendEmail: async () => {},
    sendAndLogSms: async (args) => { smsCalls += 1; smsArgs = args; return { sid: 'x', status: 'sent' }; },
  });
  await mod2.sendProposalSentEmail({
    id: 1, token: 'tok-1', event_type: 'birthday-party', event_type_custom: null,
    client_name: 'Pat', client_email: 'pat@example.com',
    client_id: 7, client_phone: '3125550111',
    communication_preferences: { sms_enabled: true, email_enabled: true },
    email_status: 'ok', phone_status: 'ok',
  }, { actorType: 'admin' });
  assert2.strictEqual(smsCalls, 1, 'SMS should fire once');
  assert2.strictEqual(smsArgs.messageType, 'initial_proposal');
  assert2.strictEqual(smsArgs.clientId, 7);
  assert2.match(smsArgs.body, /Dallas here/);
});

test2('sendProposalSentEmail > skips the SMS when sms_enabled is false', async () => {
  const mod2 = require('./sendProposalSentEmail');
  let smsCalls = 0;
  mod2.__setDeps({
    sendEmail: async () => {},
    sendAndLogSms: async () => { smsCalls += 1; return { sid: 'x', status: 'sent' }; },
  });
  await mod2.sendProposalSentEmail({
    id: 2, token: 'tok-2', event_type: 'birthday-party', event_type_custom: null,
    client_name: 'Pat', client_email: 'pat@example.com',
    client_id: 8, client_phone: '3125550111',
    communication_preferences: { sms_enabled: false, email_enabled: true },
    email_status: 'ok', phone_status: 'ok',
  }, { actorType: 'admin' });
  assert2.strictEqual(smsCalls, 0, 'SMS should be suppressed');
});

test2('sendProposalSentEmail > an SMS failure does not throw', async () => {
  const mod2 = require('./sendProposalSentEmail');
  mod2.__setDeps({
    sendEmail: async () => {},
    sendAndLogSms: async () => { throw new Error('sms boom'); },
  });
  await assert2.doesNotReject(() => mod2.sendProposalSentEmail({
    id: 3, token: 'tok-3', event_type: 'birthday-party', event_type_custom: null,
    client_name: 'Pat', client_email: 'pat@example.com',
    client_id: 9, client_phone: '3125550111',
    communication_preferences: { sms_enabled: true, email_enabled: true },
    email_status: 'ok', phone_status: 'ok',
  }, { actorType: 'admin' }));
});

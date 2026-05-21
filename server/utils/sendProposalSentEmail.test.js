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

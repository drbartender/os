// server/utils/email.replyTo.test.js
//
// Asserts the Reply-To header reaches the WIRE, not just our call site.
//
// Why this test exists (2026-08-24): every DRB email since the Resend
// integration landed (78504623, 2026-03-17) shipped with NO Reply-To header at
// all. sendEmail passed `reply_to`, but the v6 SDK reads `replyTo` and builds
// its API payload from an explicit allowlist (parseEmailToApiOptions), so our
// snake_case key was silently dropped before the HTTP call. Clients replying to
// "just reply to this email" hit the From address, no-reply@drbartender.com,
// and bounced.
//
// Nothing caught it because every existing test asserted our INPUT to the SDK.
// This one stubs global.fetch and asserts the JSON body actually sent, so a
// future SDK rename fails here instead of in a client's inbox.
require('dotenv').config();

// Must be set BEFORE requiring ./email — it builds the Resend client and reads
// the notification gate at module load.
process.env.RESEND_API_KEY = 're_offline_test_key';
process.env.SEND_NOTIFICATIONS = 'true';
process.env.ADMIN_EMAIL = 'admin@drbartender.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sendEmail, sendBatchEmails } = require('./email');

// Capture the outgoing request instead of making one. Returns the shape the
// Resend SDK expects so the send path completes normally.
let captured = null;
global.fetch = async (url, opts) => {
  captured = { url: String(url), body: JSON.parse(opts.body) };
  // globalThis.Response, not a bare `Response` — the repo eslint config does not
  // declare the web globals, and a bare reference trips no-undef.
  return new globalThis.Response(JSON.stringify({ id: 'offline-test-id', data: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

// skipLog keeps the fire-and-forget message_log write off the shared dev DB.
const SKIP_LOG = { skipLog: true };

test('sendEmail > the ADMIN_EMAIL fallback reaches the wire as reply_to', async () => {
  captured = null;
  await sendEmail({
    to: 'client@example.com',
    subject: 'Your Proposal for your wedding - Dr. Bartender',
    html: '<p>If you have any questions, just reply to this email.</p>',
    meta: SKIP_LOG,
  });
  assert.equal(captured.body.reply_to, 'admin@drbartender.com');
});

test('sendEmail > an explicit replyTo overrides the fallback on the wire', async () => {
  captured = null;
  await sendEmail({
    to: 'client@example.com',
    subject: 'x',
    html: '<p>x</p>',
    replyTo: 'contact@drbartender.com',
    meta: SKIP_LOG,
  });
  assert.equal(captured.body.reply_to, 'contact@drbartender.com');
});

test('sendEmail > every client-facing send carries a Reply-To that is not the From address', async () => {
  // The regression in one assertion: no-reply@ is not a mailbox, so a message
  // that reaches a client without a Reply-To sends their reply into a bounce.
  captured = null;
  await sendEmail({
    to: 'client@example.com',
    subject: 'x',
    html: '<p>x</p>',
    meta: SKIP_LOG,
  });
  assert.ok(captured.body.reply_to, 'no Reply-To on the wire — client replies will bounce off no-reply@');
  assert.notEqual(captured.body.reply_to, captured.body.from);
});

test('sendBatchEmails > reply_to reaches the wire for every message in the batch', async () => {
  captured = null;
  await sendBatchEmails([
    { to: 'one@example.com', subject: 'a', html: '<p>a</p>' },
    { to: 'two@example.com', subject: 'b', html: '<p>b</p>', reply_to: 'contact@drbartender.com' },
  ]);
  assert.equal(captured.body[0].reply_to, 'admin@drbartender.com');
  assert.equal(captured.body[1].reply_to, 'contact@drbartender.com');
});

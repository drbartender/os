// server/utils/email.invalid.test.js
// sendEmail must refuse RFC-2606 `.invalid` recipients (import placeholders).
// Runs without RESEND_API_KEY: the dev-skip path would return 'dev-skipped',
// so the .invalid guard must fire BEFORE dev-skip for this test to pass.
const test = require('node:test');
const assert = require('node:assert');
const { sendEmail } = require('./email');

test('all-.invalid recipients are skipped without sending', async () => {
  const res = await sendEmail({ to: 'chip-weinke@imported.invalid', subject: 'x', html: '<p>x</p>' });
  assert.strictEqual(res.id, 'skipped-invalid');
});

test('mixed list drops only the .invalid address', async () => {
  const res = await sendEmail({ to: ['real@example.com', 'ghost@imported.invalid'], subject: 'x', html: '<p>x</p>' });
  // Notifications are gated off in dev, so the surviving recipient falls
  // through to dev-skip (holds even when RESEND_API_KEY is set in dev .env):
  assert.strictEqual(res.id, 'dev-skipped');
});

test('sendBatchEmails drops fully-.invalid messages without throwing', async () => {
  const { sendBatchEmails } = require('./email');
  const res = await sendBatchEmails([
    { to: 'ghost@imported.invalid', subject: 'x', html: '<p>x</p>' },
  ]);
  // Return contract: the .invalid message is dropped from the batch BEFORE the
  // dev-skip mapping, so the dev path maps an empty list — the batch resolves
  // to [] and no message ever reaches the provider.
  assert.deepStrictEqual(res, []);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isSensitive, matchSensitive } = require('./sensitive-match');

test('matches known sensitive files (exact patterns)', () => {
  for (const p of [
    'server/utils/pricingEngine.js',
    'server/utils/stripeClient.js',
    'server/utils/encryption.js',
    'server/utils/gratuityLabels.js',
    'server/utils/eventTypes.js',
    'server/utils/errors.js',
    'server/db/schema.sql',
    'server/routes/stripeWebhook.js',
    'server/routes/sms.js',
    'server/middleware/auth.js',
    'server/middleware/rateLimiters.js',
    '.env.example',
  ]) {
    assert.ok(isSensitive([p]), `${p} should be sensitive`);
  }
});

test('glob patterns match real files', () => {
  assert.ok(isSensitive(['server/utils/payrollAccrual.js']), 'payroll*.js');
  assert.ok(isSensitive(['server/utils/payrollMath.js']), 'payroll*.js');
  assert.ok(isSensitive(['server/utils/autoAssignScheduler.js']), '*Scheduler.js');
  assert.ok(isSensitive(['server/utils/marketingEmailTemplates.js']), '*EmailTemplates.js');
  assert.ok(isSensitive(['server/utils/preEventHandlers.js']), '*Handlers.js');
  assert.ok(isSensitive(['server/scripts/repairProposal54Balance.sql']), 'scripts/*.sql');
});

test('rejects cosmetic / non-sensitive files', () => {
  for (const p of [
    'client/src/index.css',
    'client/src/components/Button.jsx',
    'README.md',
    'server/routes/blog.js',
    'docs/build-board.md',
    'server/utils/eventTypes.test.js', // exact 'eventTypes.js' pattern must not over-match
  ]) {
    assert.ok(!isSensitive([p]), `${p} should NOT be sensitive`);
  }
});

test("'*' does not cross a directory boundary", () => {
  // payroll*.js is scoped to server/utils/; it must not match a same-named file elsewhere
  assert.ok(!isSensitive(['client/src/payrollWidget.js']));
});

test('matchSensitive returns only the sensitive subset of a mixed set', () => {
  const input = [
    'README.md',
    'server/utils/pricingEngine.js',
    'client/src/index.css',
    'server/utils/payrollMath.js',
  ];
  assert.deepStrictEqual(
    matchSensitive(input).sort(),
    ['server/utils/payrollMath.js', 'server/utils/pricingEngine.js'].sort()
  );
});

test('normalizes a leading ./ and backslashes', () => {
  assert.ok(isSensitive(['./server/utils/stripeClient.js']));
  assert.ok(isSensitive(['server\\utils\\stripeClient.js']));
});

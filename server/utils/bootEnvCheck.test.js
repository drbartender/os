// Boot env check tests: the Render-without-production refusal and the
// production list of missing webhook and crypto secrets, called as pure
// functions so no test has to boot the server.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderEnvRefusal, missingRequiredEnv, missingBootSecrets, reportMissingBootSecrets, BOOT_SECRETS, REQUIRED_PROD_ENV } = require('./bootEnvCheck');

test('on Render with NODE_ENV unset the boot refuses', () => {
  const msg = renderEnvRefusal({ RENDER: 'true' });
  assert.match(msg, /NODE_ENV/);
});

test('RENDER_EXTERNAL_URL alone also marks Render', () => {
  assert.ok(renderEnvRefusal({ RENDER_EXTERNAL_URL: 'https://api.example.com', NODE_ENV: 'development' }));
});

test('a typo of production on Render still refuses', () => {
  assert.ok(renderEnvRefusal({ RENDER: 'true', NODE_ENV: 'prod' }));
  assert.ok(renderEnvRefusal({ RENDER: 'true', NODE_ENV: 'Production' }));
});

test('Render with NODE_ENV=production boots', () => {
  assert.equal(renderEnvRefusal({ RENDER: 'true', NODE_ENV: 'production' }), null);
});

test('off Render any NODE_ENV boots (the dev box and the gate worktree)', () => {
  assert.equal(renderEnvRefusal({}), null);
  assert.equal(renderEnvRefusal({ NODE_ENV: 'development' }), null);
  assert.equal(renderEnvRefusal({ NODE_ENV: 'test' }), null);
});

test('in production every missing or blank secret is listed', () => {
  const env = { NODE_ENV: 'production', STRIPE_SECRET_KEY: 'x', ENCRYPTION_KEY: '   ' };
  const missing = missingBootSecrets(env);
  assert.deepEqual(missing, BOOT_SECRETS.filter((n) => n !== 'STRIPE_SECRET_KEY'));
  assert.ok(missing.includes('ENCRYPTION_KEY'), 'a blank value counts as missing');
});

test('the list names the six secrets the audit named', () => {
  assert.deepEqual([...BOOT_SECRETS].sort(), [
    'CAL_WEBHOOK_SECRET', 'ENCRYPTION_KEY', 'RESEND_WEBHOOK_SECRET',
    'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'THUMBTACK_WEBHOOK_SECRET',
  ]);
});

test('in production with every secret set nothing is listed', () => {
  const env = { NODE_ENV: 'production' };
  for (const n of BOOT_SECRETS) env[n] = 'set';
  assert.deepEqual(missingBootSecrets(env), []);
});

test('outside production nothing is listed', () => {
  assert.deepEqual(missingBootSecrets({ NODE_ENV: 'development' }), []);
  assert.deepEqual(missingBootSecrets({}), []);
});

test('reportMissingBootSecrets logs each missing secret and reports it to Sentry when configured', () => {
  const logs = [];
  const captured = [];
  const sentry = { captureMessage: (msg, opts) => captured.push({ msg, opts }) };
  const env = { NODE_ENV: 'production', SENTRY_DSN_SERVER: 'dsn' };
  for (const n of BOOT_SECRETS) env[n] = 'set';
  delete env.ENCRYPTION_KEY;
  delete env.THUMBTACK_WEBHOOK_SECRET;
  const out = reportMissingBootSecrets(env, sentry, (l) => logs.push(l));
  assert.deepEqual(out, ['THUMBTACK_WEBHOOK_SECRET', 'ENCRYPTION_KEY']);
  assert.equal(logs.length, 2);
  assert.equal(captured.length, 2);
  assert.equal(captured[0].opts.level, 'error');
  assert.match(captured[1].msg, /^ENCRYPTION_KEY /);
});

test('reportMissingBootSecrets skips Sentry without a DSN and is silent outside production', () => {
  const captured = [];
  const sentry = { captureMessage: (msg) => captured.push(msg) };
  const logs = [];
  reportMissingBootSecrets({ NODE_ENV: 'production' }, sentry, (l) => logs.push(l));
  assert.equal(logs.length, BOOT_SECRETS.length);
  assert.equal(captured.length, 0);
  assert.deepEqual(reportMissingBootSecrets({ NODE_ENV: 'development', SENTRY_DSN_SERVER: 'dsn' }, sentry, (l) => logs.push(l)), []);
  assert.equal(captured.length, 0);
});

test('missingRequiredEnv names every unset or empty required production variable, in list order', () => {
  // The nine names server/index.js required inline before the list moved here.
  assert.deepEqual(REQUIRED_PROD_ENV, [
    'DATABASE_URL', 'RESEND_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER',
    'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME',
  ]);
  const env = {};
  for (const n of REQUIRED_PROD_ENV) env[n] = 'set';
  assert.deepEqual(missingRequiredEnv(env), []);
  env.TWILIO_AUTH_TOKEN = '';
  delete env.R2_BUCKET_NAME;
  assert.deepEqual(missingRequiredEnv(env), ['TWILIO_AUTH_TOKEN', 'R2_BUCKET_NAME']);
  assert.deepEqual(missingRequiredEnv({}), REQUIRED_PROD_ENV);
});

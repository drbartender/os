'use strict';

// node:test suite for scripts/lib/staticChecks/envDefaults.js. The two rules
// that read it are covered through checkFile in staticRules.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const { scanJs } = require('./jsScan');
const { envDefaults, isSecretName } = require('./envDefaults');

test('isSecretName reads _SECRET, _KEY, _TOKEN and _PASSWORD anywhere, SECRET, PASSWORD, APIKEY and PRIVATE anywhere, and a bare KEY or TOKEN', () => {
  const yes = ['JWT_SECRET', 'STRIPE_SECRET_KEY_TEST', 'TWILIO_AUTH_TOKEN', 'ADMIN_PASSWORD', 'SECRET', 'APIKEY', 'API_KEY', 'PRIVATE', 'VAPID_PRIVATE',
    'MAILSECRETS', 'GITHUB_TOKENS', 'DB_PASSWORD2', 'X_KEYFILE', 'KEY', 'TOKEN', 'TOKEN_URL', 'apiKey'];
  const no = ['PORT', 'KEYBOARD_LAYOUT', 'MONKEY', 'TOKENIZER_MODEL', 'NODE_ENV', 'CLIENT_URL'];
  assert.deepStrictEqual(yes.filter((n) => !isSecretName(n)), []);
  assert.deepStrictEqual(no.filter(isSecretName), []);
});

test('envDefaults reports the fallback line, the span and the kind', () => {
  const src = "const a = process.env.X_SECRET\n  ?? process.env.Y\n  ?? null;\nconst b = cond(process.env.PORT || 80);\n";
  const { tokens, pair } = scanJs(src);
  const got = envDefaults({ tokens, pair });
  assert.deepStrictEqual(got.map(({ literal, ...rest }) => rest), [
    { secret: false, kind: 'null', line: 3, from: 1, to: 3 },
    { secret: false, kind: 'literal', line: 4, from: 4, to: 4 },
  ]);
  assert.deepStrictEqual(got.map((d) => src.slice(d.literal.start, d.literal.end)), ['null', '80']);
});

test('envDefaults: a parenthesized chain is a term of the chain around it, so both fallbacks count', () => {
  const src = "const a = (process.env.X_SECRET || 'in')\n  || 'out';\n";
  const { tokens, pair } = scanJs(src);
  assert.deepStrictEqual(envDefaults({ tokens, pair }).map((d) => [d.secret, d.line]), [[true, 1], [true, 2]]);
});

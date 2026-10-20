'use strict';

// node:test suite for scripts/lib/piiShapes.js (instruction rewrite step 2, lane
// pii-shapes). Fixtures only: the 555 exchange, unassignable shapes (an area
// code starting with 1), the business lines read from the repo's own modules,
// reserved domains and made-up ids. No number a real subscriber could hold
// appears here (a test below checks that).

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const MOD = path.resolve(__dirname, 'piiShapes.js');
const { findPii, mask, maskDiff, findInDiff, SHAPES, ALLOWLIST } = require(MOD);
const { COMPANY_PHONE, COMPANY_TEXT_PHONE } = require(path.resolve(__dirname, '../../server/utils/companyPhone.js'));

// A real-format fixture that no subscriber can hold: the area code starts with 1.
// Not a 555 exchange and not a business line, so on a route-file path it must mask.
const UNASSIGNABLE = '123-456-7890';
const ROUTE = 'server/routes/x.js';
const FIXTURE_555 = '(555) 123-4567';
const STRIPE_PI = 'pi_3Abc123XyZ1876543210QwE';
// built from parts, like every key fixture here, so no secret-shaped literal sits in the source
const SK_LIVE = 'sk_' + 'live_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
// the short address fixture on an unreserved domain, built from parts so a new
// line of this file carries no address the PII pre-step reads
const SHORT_EMAIL = 'a' + '@b.co';

function shapes(hits) {
  return hits.map((h) => h.shape).sort();
}

test('a real-format phone number is found and masked', () => {
  const text = `call ${UNASSIGNABLE} tomorrow`;
  assert.deepStrictEqual(shapes(findPii(text, { path: ROUTE })), ['PHONE']);
  assert.strictEqual(mask(text, { path: ROUTE }), 'call <PHONE> tomorrow');
});

// The externals' first run through the mask (2026-10-20): a bare integer of 10
// to 13 digits is not a phone number unless it reads as one (a plausible North
// American area code and exchange, or a leading 1 before them); the int4 and
// uint32 maxima are constants, never a subscriber. A separated or plus-led form
// masks as before, so a real number written any usual way still masks.
test('a bare integer masks as a phone only when it reads as one', () => {
  const int4Max = '2147' + '483647'; // the maxima are built from parts: both read as a plausible shape
  const uint32Max = '4294' + '967295';
  for (const kept of [`if (id > ${int4Max}) return;`, `if (n > ${uint32Max}) return;`, 'created: 1729459200', 'at 1729459200000', 'seed 11345678901']) {
    assert.deepStrictEqual(findPii(kept, { path: ROUTE }), [], kept);
  }
  // a plausible shape, built from parts so no assignable literal sits in this file
  const bare = '773' + '234' + '5678';
  assert.strictEqual(mask(`call ${bare} now`, { path: ROUTE }), 'call <PHONE> now');
  assert.strictEqual(mask(`call 1${bare} now`, { path: ROUTE }), 'call <PHONE> now');
  assert.strictEqual(mask(`call +1${bare} now`, { path: ROUTE }), 'call <PHONE> now');
  assert.strictEqual(mask(`call ${UNASSIGNABLE} now`, { path: ROUTE }), 'call <PHONE> now', 'a separated form masks whatever its area code');
});

// A context word that overlaps the window only by its tail used to be cut by the
// slice padding (8 characters, shorter than "social security"), so the plain
// nine digits passed. The padding now covers the longest context word.
test('a context word that overlaps the window by its tail still counts', () => {
  for (const gap of [34, 39]) {
    assert.strictEqual(mask(`social security${' '.repeat(gap)}123456789`, { path: ROUTE }), `social security${' '.repeat(gap)}<SSN>`, `gap ${gap}`);
  }
  assert.deepStrictEqual(findPii(`social security${' '.repeat(56)}123456789`, { path: ROUTE }), [], 'the word is out of the window');
});

// A long module.function reference is not a JWT-ish pair: each side of a token
// pair carries a digit, an identifier pair carries none.
test('a module.function reference is not a token', () => {
  const ref = 'extensionSettleContext.contractedEndDisplay';
  assert.deepStrictEqual(findPii(`const x = ${ref};`, { path: ROUTE }), []);
  const check = spawnSync(process.execPath, [MOD, '--check', `settle: ${ref} reads the row`], { encoding: 'utf8' });
  assert.strictEqual(check.status, 0, check.stderr);
  assert.strictEqual(mask(`t ${rep('Ab1', 8)}.${rep('Zq9', 8)} e`, { path: ROUTE }), 't <TOKEN> e', 'a digit-bearing pair still masks');
});

test('the two business lines are not PII', () => {
  assert.deepStrictEqual(findPii(`text us at ${COMPANY_TEXT_PHONE} or call ${COMPANY_PHONE}`), []);
  // E.164 and bare-digit spellings of the same lines are allowlisted too.
  const digits = COMPANY_PHONE.replace(/\D/g, '');
  assert.deepStrictEqual(findPii(`+1${digits}`), []);
});

test('a 555 fixture number is not PII', () => {
  assert.deepStrictEqual(findPii(`seed ${FIXTURE_555}`), []);
  assert.deepStrictEqual(findPii('seed +15550001234'), []);
});

test('a number inside a *.test.js path is not PII', () => {
  assert.deepStrictEqual(findPii(`const n = '${UNASSIGNABLE}';`, { path: 'server/routes/x.test.js' }), []);
  assert.deepStrictEqual(findPii(`const n = '${UNASSIGNABLE}';`, { path: 'server/db/seedTestData.js' }), []);
  assert.deepStrictEqual(shapes(findPii(`const n = '${UNASSIGNABLE}';`, { path: ROUTE })), ['PHONE']);
});

// M5: the test paths exempt fixtures, not every shape. EMAIL is exempt only on
// a reserved or business domain; PHONE only for the 555 exchange, a business
// line or an unassignable shape; the other shapes are exempt except a live key.
const TEST_PATH = 'server/routes/x.test.js';
// Ofcom reserves a mobile range for drama (the constant below, built from parts): fictional, and
// not North American (written in E.164 with no separator, so no part of it
// reads as a North American 3-3-4 shape).
const OFCOM_DRAMA = '+44' + '7700' + '900123';

test('in a test path an email is exempt only on a reserved or business domain', () => {
  for (const addr of ['user@example.com', 'x@mail.example.org', 'x@example.net', 'x@example.edu', 'seed@test.com',
    'contact@drbartender.com', 'u@host.test', 'u@x.invalid', 'u@x.example', 'u@dev.localhost']) {
    assert.deepStrictEqual(findPii(`const e = '${addr}';`, { path: TEST_PATH }), [], addr);
  }
  assert.strictEqual(mask(`const e = '${SHORT_EMAIL}';`, { path: TEST_PATH }), "const e = '<EMAIL>';");
  assert.strictEqual(mask(`const e = '${SHORT_EMAIL}';`, { path: 'server/db/seedTestData.js' }), "const e = '<EMAIL>';");
  assert.strictEqual(mask("const e = 'user@example.com';", { path: ROUTE }), "const e = '<EMAIL>';", 'outside tests only the business domain');
});

test('in a test path a phone is exempt only as a fixture or a business line', () => {
  for (const n of [FIXTURE_555, UNASSIGNABLE, '023-456-7890', '223-156-7890', COMPANY_PHONE, COMPANY_TEXT_PHONE]) {
    assert.deepStrictEqual(findPii(`const n = '${n}';`, { path: TEST_PATH }), [], n);
  }
  assert.strictEqual(mask(`const n = '${OFCOM_DRAMA}';`, { path: TEST_PATH }), "const n = '<PHONE>';");
});

// L4 (third pass): the live set is every sk- key (OpenAI and Anthropic shapes
// of any kind), napi_, github_pat_ and a Stripe client secret, beside the
// Stripe live, restricted and webhook keys, Google, gh*_ and Telegram.
test('in a test path tokens and ids are exempt, except a live key', () => {
  const exempt = ['sk_test_Q7xZq7XzQ7xZ', 'rk_test_Q7xZq7XzQ7xZ', '0123456789abcdef0123456789abcdef',
    rep('Zq9/', 10), 'pi_3Abc123XyZ', '3f2a1c9e-8b7d-4e6f-a5b4-c3d2e1f0a9b8', 'routing 123456789', 'ssn 123-45-6789'];
  for (const t of exempt) assert.deepStrictEqual(findPii(`const t = '${t}';`, { path: TEST_PATH }), [], t);
  const live = ['sk_' + 'live_' + rep('Q7xZ', 4), TOKEN_FIXTURES.restricted, TOKEN_FIXTURES.webhook, TOKEN_FIXTURES.anthropic,
    TOKEN_FIXTURES.openai, TOKEN_FIXTURES.google, TOKEN_FIXTURES.github, TOKEN_FIXTURES.githubOauth, TOKEN_FIXTURES.telegram,
    'sk-' + rep('Q7xZ', 6), 'sk-' + 'svcacct-' + rep('Q7xZ', 8), TOKEN_FIXTURES.neon, TOKEN_FIXTURES.githubPat, ...CLIENT_SECRETS];
  for (const t of live) assert.strictEqual(mask(`const t = '${t}';`, { path: TEST_PATH }), "const t = '<TOKEN>';", t.slice(0, 8));
  assert.strictEqual(mask(`auth: 'Bearer ${live[0]}'`, { path: TEST_PATH }), "auth: 'Bearer <TOKEN>'", 'a live key inside a bearer value');
});

// A digit run inside a UUID, a token or a Stripe id is part of that id, not a
// number: an exempt id in a test path passes whole, never half-masked.
test('a digit run inside an exempt id is part of the id', () => {
  const rfcUuid = '550e8400-e29b-41d4-a716-446655440000'; // the RFC 4122 example
  const b64 = 'AbCdEfGhIj' + '1729459' + '200000' + 'KlMnOpQrStUvWxYzZ' + '='; // 40 chars, padded: a base64 secret, not a path
  for (const t of [rfcUuid, b64, 'cus_Q7x1729459200000Zq']) {
    assert.deepStrictEqual(findPii(`const t = '${t}';`, { path: TEST_PATH }), [], t.slice(0, 8));
  }
  assert.strictEqual(mask(`const t = '${rfcUuid}';`, { path: ROUTE }), "const t = '<UUID>';");
});

// L3 (third pass): the two line registries hold the business numbers, so they
// stay exempt for PHONE and EMAIL only. Every other shape is judged as on a
// test path: fixtures pass, and a live key masks there as anywhere.
test('the two line registries are exempt for phones and emails only; a live key masks', () => {
  for (const p of ['server/utils/smsLines.js', 'server/utils/companyPhone.js']) {
    assert.deepStrictEqual(findPii(`// ${SHORT_EMAIL} ${OFCOM_DRAMA} ${UNASSIGNABLE}`, { path: p }), [], `${p}: phones and emails`);
    const fixtures = "const t = 'sk_test_Q7xZq7XzQ7xZ'; // pi_3Abc123XyZ 3f2a1c9e-8b7d-4e6f-a5b4-c3d2e1f0a9b8";
    assert.deepStrictEqual(findPii(fixtures, { path: p }), [], `${p}: fixtures as on a test path`);
    for (const t of [TOKEN_FIXTURES.github, SK_LIVE, TOKEN_FIXTURES.anthropic, CLIENT_SECRETS[0]]) {
      assert.strictEqual(mask(`k ${t}`, { path: p }), 'k <TOKEN>', `${p}: ${t.slice(0, 6)}`);
    }
  }
});

test('tokens are found: sk_live_ and a 32-hex string', () => {
  assert.deepStrictEqual(shapes(findPii(`key ${SK_LIVE}`)), ['TOKEN']);
  assert.deepStrictEqual(shapes(findPii('hash 0123456789abcdef0123456789abcdef')), ['TOKEN']);
});

// L7: the Stripe key form is anchored, so identifiers ending in sk_ are not
// masked into noise.
test('identifiers that merely contain sk_ are not tokens', () => {
  for (const ident of ['run mask_diff now', 'task_list', 'risk_score', 'disk_usage', 'sk_fixture_name']) {
    assert.deepStrictEqual(findPii(ident, { path: ROUTE }), [], ident);
  }
  assert.strictEqual(mask('key sk_test_Q7xZq7XzQ7xZ end', { path: ROUTE }), 'key <TOKEN> end');
});

// M2: the secret formats this codebase holds. Built at runtime from parts so
// no secret-shaped literal sits in the source.
const rep = (s, n) => s.repeat(n);
const TOKEN_FIXTURES = {
  anthropic: 'sk-' + 'ant-api03-' + rep('Q7xZ', 10),
  openai: 'sk-' + 'proj-' + rep('Q7x_', 8),
  google: 'AI' + 'za' + rep('Q7xZ', 8) + 'Q7x',
  github: 'gh' + 'p_' + rep('Q7xZ', 9),
  githubOauth: 'gh' + 'o_' + rep('Q7xZ', 9),
  webhook: 'wh' + 'sec_' + rep('Q7xZ', 6),
  restricted: 'rk' + '_live_' + rep('Q7xZ', 4),
  telegram: '1234567890' + ':' + 'AA' + rep('Q7xZ_', 6) + 'Q7x',
  base64: rep('Zq9/', 10) + '=',
  neon: 'na' + 'pi_' + rep('Q7xZ', 10),
  githubPat: 'git' + 'hub_pat_' + rep('Q7xZ', 6) + '_' + rep('Q7xZ', 12),
};

test('the token formats this codebase holds are masked whole', () => {
  for (const [name, t] of Object.entries(TOKEN_FIXTURES)) {
    assert.strictEqual(mask(`key ${t} end`, { path: ROUTE }), 'key <TOKEN> end', name);
  }
  // a long run with no digit is a word, not a secret
  assert.deepStrictEqual(findPii(`see ${rep('Abcdefghij', 5)} here`, { path: ROUTE }), []);
  assert.deepStrictEqual(findPii('docs/superpowers/plans/instruction/rewrite/step/two', { path: ROUTE }), []);
});

test('a long repo path with a digit is a path, not a token; a base64 secret shows a plus or padding', () => {
  // A slash-bearing run of 40 or more with a digit is what a deep repo path
  // looks like (plans, specs and design-artifact support files hold many). The
  // board carries paths, so such a line must pass --check.
  const longPath = 'docs/superpowers/specs/lens-audit/checks/money2seam/alpha/beta/gamma/delta';
  assert.deepStrictEqual(findPii(`see ${longPath} here`, { path: ROUTE }), []);
  assert.deepStrictEqual(findPii(`see ${longPath} here`, { path: 'docs/x.md' }), []);
  const check = spawnSync(process.execPath, [MOD, '--check', `fix list: ${longPath}.md`], { encoding: 'utf8' });
  assert.strictEqual(check.status, 0, check.stderr);
  // Base64 secrets carry a plus or padding; a run with neither is a word or a path.
  assert.strictEqual(mask(`k ${rep('Zq9/', 10)}= e`, { path: ROUTE }), 'k <TOKEN> e');
  assert.strictEqual(mask(`k ${rep('Zq9', 13)}+Zq9 e`, { path: ROUTE }), 'k <TOKEN> e');
  assert.deepStrictEqual(findPii(`k ${rep('Zq9/', 10)} e`, { path: ROUTE }), []);
});

// M1 (third pass): a run with no slash cannot be a path, so an alnum-only run
// of 40 or more with a digit is a secret (a Neon key body, a GitHub
// fine-grained token, unpadded base64). A slash-bearing run still needs a plus
// or padding, so a deep repo path never masks.
test('an alnum run of 40 or more with a digit masks; a slash path still needs a plus or padding', () => {
  const alnum = rep('Q7xZ', 10) + 'Q'; // 41 characters, a digit, no slash
  assert.strictEqual(mask(`k ${alnum} e`, { path: ROUTE }), 'k <TOKEN> e');
  const longPath = 'docs/superpowers/specs/lens-audit/checks/money2seam/alpha/beta/gamma/delta';
  assert.deepStrictEqual(findPii(`see ${longPath} here`, { path: ROUTE }), []);
  const check = spawnSync(process.execPath, [MOD, '--check', `fix list: ${longPath}.md`], { encoding: 'utf8' });
  assert.strictEqual(check.status, 0, check.stderr);
  // the Neon and GitHub fine-grained prefixes mask whole, prefix included
  assert.strictEqual(mask(`k ${TOKEN_FIXTURES.neon} e`, { path: ROUTE }), 'k <TOKEN> e', 'napi_');
  assert.strictEqual(mask(`k ${TOKEN_FIXTURES.githubPat} e`, { path: ROUTE }), 'k <TOKEN> e', 'github_pat_');
});

// A Telegram secret may end in a dash, where no word boundary sits.
test('a Telegram bot token ending in a dash masks whole, test paths included', () => {
  const t = '1234567890' + ':' + 'AA' + rep('Q7xZ_', 6) + 'Q7-';
  assert.strictEqual(mask(`key ${t} end`, { path: ROUTE }), 'key <TOKEN> end');
  assert.strictEqual(mask(`const t = '${t}';`, { path: TEST_PATH }), "const t = '<TOKEN>';");
});

test('a three-part JWT is masked whole, signature included', () => {
  const jwt = `eyJ${rep('hbGc', 5)}.eyJ${rep('zdWI', 6)}.${rep('Sfl9', 11)}`;
  assert.strictEqual(mask(`auth ${jwt} end`, { path: ROUTE }), 'auth <TOKEN> end');
  assert.strictEqual(mask(`auth ${jwt}`, { path: 'docs/x.md' }), 'auth <TOKEN>');
});

test('a UUID is masked as a public-link token outside test paths', () => {
  const uuid = '3f2a1c9e-8b7d-4e6f-a5b4-c3d2e1f0a9b8';
  assert.strictEqual(mask(`/proposal/${uuid}/pay`, { path: ROUTE }), '/proposal/<UUID>/pay');
  assert.strictEqual(mask(`token ${uuid.toUpperCase()}`, { path: ROUTE }), 'token <UUID>');
  assert.deepStrictEqual(findPii(`const t = '${uuid}';`, { path: 'server/routes/x.test.js' }), []);
  assert.deepStrictEqual(findPii('v0 3f2a1c9e-8b7d-0e6f-a5b4-c3d2e1f0a9b8', { path: ROUTE }), [], 'not a v1-v8 form');
});

// L8 (third pass): a UUID glued to a word character (proposal_<uuid>.pdf) is
// still a link token, and the v6, v7 and v8 forms count. Its edges are "no hex
// digit beside it", so a longer hex run is still not a UUID.
test('a UUID masks beside an underscore, and v6 to v8 count', () => {
  const uuid = '3f2a1c9e-8b7d-4e6f-a5b4-c3d2e1f0a9b8';
  assert.strictEqual(mask(`file proposal_${uuid}.pdf`, { path: ROUTE }), 'file proposal_<UUID>.pdf');
  for (const v of ['6', '7', '8']) {
    assert.strictEqual(mask(`t 3f2a1c9e-8b7d-${v}e6f-a5b4-c3d2e1f0a9b8 e`, { path: ROUTE }), 't <UUID> e', `v${v}`);
  }
  for (const text of [`x a${uuid}`, `x ${uuid}f`, 'v9 3f2a1c9e-8b7d-9e6f-a5b4-c3d2e1f0a9b8']) {
    assert.deepStrictEqual(findPii(text, { path: ROUTE }), [], text.slice(0, 4));
  }
});

test('Stripe ids are found; snake_case identifiers are not', () => {
  assert.deepStrictEqual(shapes(findPii(`intent ${STRIPE_PI} settled`)), ['STRIPE_ID']);
  assert.deepStrictEqual(shapes(findPii('refund re_1AbCdEfGhIjKlMnOpQrStUvW')), ['STRIPE_ID']);
  assert.deepStrictEqual(shapes(findPii('pi_3Abc123XyZ')), ['STRIPE_ID']); // the board test fixture, 11 chars
  for (const ident of ['files_in_diff', 'min_total', 'share_cents', 'admin_owned', 'recapture_line', 'status in_progress', 'min_billed']) {
    assert.deepStrictEqual(findPii(ident), [], ident);
  }
});

// M3: the whole Stripe family, the live/test segment, and ids with no digit
// (those carry an uppercase letter); never an all-lowercase snake_case word.
test('the Stripe id family is masked whole, live and test segments included', () => {
  const ids = [
    'cs_live_a1B2c3D4e5F6g7H8', 'cs_test_a1B2c3D4e5F6g7H8', 'cus_NffrFeUfNVHibq', 'cus_ABCDEFGHIJKLMN',
    'po_1Q7xZq7XzQ7x', 'tr_1Q7xZq7XzQ7x', 'txn_1Q7xZq7XzQ7x', 'acct_1Q7xZq7XzQ7x', 'ba_1Q7xZq7XzQ7x',
    'src_1Q7xZq7X', 'tok_1Q7xZq7X', 'card_1Q7xZq7X', 'prod_Q7xZq7Xz1', 'price_1Q7xZq7X', 'plan_1Q7xZq7X',
    'inv_1Q7xZq7X', 'il_1Q7xZq7X', 'cn_1Q7xZq7X', 'dp_1Q7xZq7X', 'py_1Q7xZq7X', 'or_1Q7xZq7X', 'sku_1Q7xZq7X',
    'txi_1Q7xZq7X', 'pi_3Abc123XyZ', 're_1AbCdEfGhIjKlMnOpQrStUvW', 'evt_1Q7xZq7XzQ7x', 'seti_1Q7xZq7X', 'pm_1Q7xZq7X',
  ];
  for (const id of ids) assert.strictEqual(mask(`id ${id} end`, { path: ROUTE }), 'id <STRIPE_ID> end', id);
  for (const word of ['re_authentication', 'in_progress', 'files_in_diff', 'min_total', 'share_cents', 'admin_owned', 'recapture_line', 'min_billed']) {
    assert.deepStrictEqual(findPii(`field ${word} here`, { path: ROUTE }), [], word);
  }
});

// M3 residuals (third pass): a PaymentIntent or SetupIntent client secret masks
// whole (it authorizes the intent from a browser), and the payment-link,
// invoice-item and subscription-item ids join the family.
const CLIENT_SECRETS = [STRIPE_PI + '_sec' + 'ret_' + rep('Q7xZ', 4), 'seti_1Q7xZq7XzQ7x' + '_sec' + 'ret_' + rep('Q7xZ', 4)];

test('a Stripe client secret masks whole; plink_, ii_ and si_ ids are Stripe ids', () => {
  for (const s of CLIENT_SECRETS) assert.strictEqual(mask(`cs ${s} end`, { path: ROUTE }), 'cs <TOKEN> end', s.slice(0, 5));
  for (const id of ['plink_1Q7xZq7XzQ7x', 'ii_1Q7xZq7X', 'si_1Q7xZq7X']) {
    assert.strictEqual(mask(`id ${id} end`, { path: ROUTE }), 'id <STRIPE_ID> end', id);
  }
  for (const word of ['si_unit', 'ii_total', 'plink_label']) assert.deepStrictEqual(findPii(`field ${word} here`, { path: ROUTE }), [], word);
});

test('routing and EIN shapes are found only beside their words', () => {
  assert.deepStrictEqual(shapes(findPii('routing 123456789 on file')), ['ROUTING_EIN']);
  assert.deepStrictEqual(shapes(findPii('EIN 12-3456789')), ['ROUTING_EIN']);
  assert.deepStrictEqual(shapes(findPii('account number 987654321')), ['ROUTING_EIN']);
  assert.deepStrictEqual(findPii('proposal 123456789 archived'), []);
});

// M4: the field names this codebase uses (routing_number, accountNumber), any
// case; ein and tin only as their own word; and an SSN shape.
test('routing and tax ids are found beside the field names this codebase uses', () => {
  for (const text of ['{"routing_number":"123456789"}', 'accountNumber: 987654321', 'routingNumber=123456789',
    'TIN: 12-3456789', 'ein_number 12-3456789', 'Tax ID 12-3456789']) {
    assert.deepStrictEqual(shapes(findPii(text, { path: ROUTE })), ['ROUTING_EIN'], text);
  }
  for (const text of ['being 123456789', 'protein 123456789 grams', 'rein 123456789', 'proposal 123456789 archived',
    'prot' + 'ein' + ' '.repeat(37) + '123456789']) {
    assert.deepStrictEqual(findPii(text, { path: ROUTE }), [], text);
  }
});

test('an SSN is found: dashed anywhere, nine plain digits beside ssn, tin or tax', () => {
  for (const text of ['note 123-45-6789', 'ssn 123456789', 'user_ssn: 123456789', 'TIN 123456789', 'tax id 123456789']) {
    assert.deepStrictEqual(shapes(findPii(text, { path: ROUTE })), ['SSN'], text);
  }
  assert.deepStrictEqual(findPii('getting 123456789', { path: ROUTE }), []);
  const t0 = process.hrtime.bigint();
  findPii('tax 123456789 '.repeat(8000), { path: ROUTE });
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 200, 'the context check stays linear');
});

// M4 residuals (third pass): the SSN words also read social security and ss#,
// and a spaced SSN counts beside them; the routing words also read aba, rtn
// and acct when no letter touches them.
test('an SSN beside social security or ss#, spaced or plain; routing beside aba, rtn or acct', () => {
  for (const text of ['social security 123456789', 'Social Security No. 123 45 6789', 'SS# 123456789', 'ssn: 123 45 6789',
    'social_security_number 123456789']) {
    assert.deepStrictEqual(shapes(findPii(text, { path: ROUTE })), ['SSN'], text);
  }
  for (const text of ['ABA 123456789', 'rtn: 123456789', 'acct 987654321', 'acct_number 987654321', 'ABA/RTN 123456789']) {
    assert.deepStrictEqual(shapes(findPii(text, { path: ROUTE })), ['ROUTING_EIN'], text);
  }
  for (const text of ['abandon 123456789', 'cabal 123456789', 'kirtnx 123456789', 'order 123 45 6789']) {
    assert.deepStrictEqual(findPii(text, { path: ROUTE }), [], text);
  }
});

test('emails are found; the business domain is not', () => {
  assert.deepStrictEqual(shapes(findPii(`mail ${SHORT_EMAIL} today`)), ['EMAIL']);
  assert.deepStrictEqual(findPii('reply-to contact@drbartender.com'), []);
  assert.deepStrictEqual(findPii('Admin@DRBartender.com'), []);
});

// L3: the allowlist runs over every raw hit first; overlaps are pruned only
// among the hits that survive, so an allowed span never hides a value inside it.
test('an allowed span never hides a value inside it', () => {
  const digits = '773' + '234' + '5678'; // a bare run masks only when it reads as a number, so a plausible shape, from parts
  assert.strictEqual(mask(`reply contact+${digits}@drbartender.com`, { path: ROUTE }), 'reply contact+<PHONE>@drbartender.com');
  const glued = mask('to=person' + '%40' + 'home.example.org.contact@drbartender.com', { path: ROUTE });
  assert.ok(!glued.includes('person') && !glued.includes('home.example'), glued);
});

test('a URL-encoded address is an email', () => {
  assert.strictEqual(mask('?to=person%40home.example.org&x=1', { path: ROUTE }), '?to=<EMAIL>&x=1');
});

test('phone separators: no-break space, en dash, figure dash, slash, two spaces', () => {
  for (const sep of [' ', '–', '‒', '/', '  ']) {
    const n = ['123', '456', '7890'].join(sep);
    assert.strictEqual(mask(`call ${n} now`, { path: ROUTE }), 'call <PHONE> now', JSON.stringify(sep));
  }
});

// L5: no shape may go quadratic on a long line (logoBase64.js carries an
// 82k-character line).
test('a 100k-character line is scanned in under 200 ms', () => {
  // the email line holds 12,500 hits: pruning must stay linear in the hit count.
  // 'eyJ-' starts a JWT attempt at every dash: only a run start may begin one.
  for (const line of ['a'.repeat(100000), '1'.repeat(100000), 'a@'.repeat(50000), '-'.repeat(100000), 'a.'.repeat(50000), `${SHORT_EMAIL} `.repeat(12500),
    'eyJ-'.repeat(25000)]) {
    const t0 = process.hrtime.bigint();
    mask(line, { path: ROUTE });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 200, `${line.slice(0, 4)}...: ${ms.toFixed(0)} ms`);
  }
});

// L5 residual: mask rebuilds its output in one forward pass, so the cost is
// linear in the line, not the line times the hit count.
test('a 175k-character line with 25k hits masks in under 500 ms', () => {
  const line = `${SHORT_EMAIL} `.repeat(25000); // 175,000 characters, 25,000 hits
  const t0 = process.hrtime.bigint();
  const out = mask(line, { path: ROUTE });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.strictEqual(out, '<EMAIL> '.repeat(25000));
  assert.ok(ms < 500, `${ms.toFixed(0)} ms`);
});

test('--check is strict: every shape blocks, business lines and the domain included', () => {
  const run = (line) => spawnSync(process.execPath, [MOD, '--check', line], { encoding: 'utf8' });
  assert.strictEqual(run('Workflow redesign L3 board (spec, plan)').status, 0);
  const dirty = run(`contact us at ${SHORT_EMAIL}`);
  assert.strictEqual(dirty.status, 1);
  assert.match(dirty.stderr, /BLOCKED/);
  assert.strictEqual(run(`text ${COMPANY_TEXT_PHONE}`).status, 1, 'the board carries no number, business or not');
  assert.strictEqual(run('mail dallas@drbartender.com').status, 1);
  assert.strictEqual(run('refund lane pi_3Abc123XyZ pending').status, 1);
  assert.strictEqual(run('files_in_diff is a field').status, 0);
});

test('maskDiff applies the allowlist per file from the diff headers', () => {
  const diff = [
    'diff --git a/server/routes/a.js b/server/routes/a.js',
    '--- a/server/routes/a.js',
    '+++ b/server/routes/a.js',
    '@@ -1,2 +1,3 @@',
    ` const x = '${UNASSIGNABLE}';`,
    `+const y = '${UNASSIGNABLE}';`,
    'diff --git a/server/routes/a.test.js b/server/routes/a.test.js',
    '--- a/server/routes/a.test.js',
    '+++ b/server/routes/a.test.js',
    '@@ -1,1 +1,2 @@',
    `+const fixture = '${UNASSIGNABLE}';`,
    `+const other = '${FIXTURE_555}';`,
    '',
  ].join('\n');
  const out = maskDiff(diff);
  const lines = out.split('\n');
  assert.strictEqual(lines[4], " const x = '<PHONE>';", 'context lines in a code file are masked too');
  assert.strictEqual(lines[5], "+const y = '<PHONE>';");
  assert.strictEqual(lines[10], `+const fixture = '${UNASSIGNABLE}';`, 'a test file is allowlisted by path');
  assert.strictEqual(lines[11], `+const other = '${FIXTURE_555}';`);
  assert.strictEqual((out.match(/<PHONE>/g) || []).length, 2);
});

// H1: git appends a copy of a source line after the second @@ (the funcname
// context). Only the line-number prefix is structure; the rest is content.
test('maskDiff masks the source line git copies into a hunk header', () => {
  const diff = [
    'diff --git a/server/routes/a.js b/server/routes/a.js',
    '--- a/server/routes/a.js',
    '+++ b/server/routes/a.js',
    `@@ -10,3 +10,4 @@ const owner = '${SHORT_EMAIL}'; // ${UNASSIGNABLE}`,
    '+const y = 1;',
    `@@ -40 +41 @@ notes about ${UNASSIGNABLE}`,
    '+const z = 2;',
    '',
  ].join('\n');
  const lines = maskDiff(diff).split('\n');
  assert.strictEqual(lines[3], "@@ -10,3 +10,4 @@ const owner = '<EMAIL>'; // <PHONE>");
  assert.strictEqual(lines[5], '@@ -40 +41 @@ notes about <PHONE>');
});

// L1: a line is a header only between `diff --git` and that file's first @@.
// Inside a hunk, a removed `-- a/` line (an SQL comment) and an added `++ b/`
// line are content.
test('inside a hunk, lines that look like ---/+++ headers are content', () => {
  const diff = [
    'diff --git a/server/db/q.js b/server/db/q.js',
    '--- a/server/db/q.js',
    '+++ b/server/db/q.js',
    '@@ -1,2 +1,2 @@',
    `--- a/ old note, call ${UNASSIGNABLE}`,
    `+++ b/ new note, call ${UNASSIGNABLE}`,
    '',
  ].join('\n');
  const lines = maskDiff(diff).split('\n');
  assert.strictEqual(lines[4], '--- a/ old note, call <PHONE>');
  assert.strictEqual(lines[5], '+++ b/ new note, call <PHONE>');
  const hits = findInDiff(diff);
  assert.strictEqual(hits.length, 1, 'the added ++ line is scanned');
  assert.strictEqual(hits[0].shape, 'PHONE');
});

// L2: header lines are masked too; the diff structure survives because the
// shapes never match `diff --git a/ b/`, `---` or `+++`.
test('maskDiff masks a number or an address inside a header path', () => {
  const p = `docs/call-${UNASSIGNABLE}.md`;
  const q = `docs/from-${SHORT_EMAIL}.png`;
  const diff = [
    `diff --git a/${p} b/${p}`,
    'similarity index 90%',
    `rename from ${p}`,
    `rename to ${p}`,
    `--- a/${p}`,
    `+++ b/${p}`,
    '@@ -1 +1 @@',
    '+x',
    `diff --git a/${q} b/${q}`,
    `Binary files a/${q} and b/${q} differ`,
    '',
  ].join('\n');
  const out = maskDiff(diff);
  assert.ok(!out.includes(UNASSIGNABLE), 'no number survives in a header');
  assert.ok(!out.includes(SHORT_EMAIL), 'no address survives in a header');
  const lines = out.split('\n');
  assert.strictEqual(lines[0], 'diff --git a/docs/call-<PHONE>.md b/docs/call-<PHONE>.md');
  assert.strictEqual(lines[4], '--- a/docs/call-<PHONE>.md');
  assert.strictEqual(lines[5], '+++ b/docs/call-<PHONE>.md');
  assert.strictEqual(lines[1], 'similarity index 90%');
});

// M1: git C-quotes a path holding a quote, a backslash, a tab or non-ASCII
// bytes. A header that does not parse must never hand the previous file's
// allowlist to the next file.
test('a quoted path is decoded, and is never read as the previous file', () => {
  const diff = [
    'diff --git a/server/routes/a.test.js b/server/routes/a.test.js',
    '@@ -0,0 +1 @@',
    `+const f = '${UNASSIGNABLE}';`,
    'diff --git "a/docs/caf\\303\\251.js" "b/docs/caf\\303\\251.js"',
    '@@ -0,0 +1 @@',
    `+const g = '${UNASSIGNABLE}';`,
    'diff --git "a/server/caf\\303\\251.test.js" "b/server/caf\\303\\251.test.js"',
    '@@ -0,0 +1 @@',
    `+const h = '${UNASSIGNABLE}';`,
    'diff --git a/plain.js "b/odd\\"name.js"',
    '@@ -0,0 +1 @@',
    `+const i = '${UNASSIGNABLE}';`,
    '',
  ].join('\n');
  const lines = maskDiff(diff).split('\n');
  assert.strictEqual(lines[2], `+const f = '${UNASSIGNABLE}';`, 'the test file keeps its fixture');
  assert.strictEqual(lines[5], "+const g = '<PHONE>';", 'the quoted code file is masked');
  assert.strictEqual(lines[8], `+const h = '${UNASSIGNABLE}';`, 'a quoted test path decodes to a test path');
  assert.strictEqual(lines[11], "+const i = '<PHONE>';");
  const hits = findInDiff(diff);
  assert.deepStrictEqual(hits.map((h) => h.path), ['docs/café.js', 'odd"name.js']);
});

test('a diff --git line that does not parse starts a null-path section that masks everything', () => {
  const diff = [
    'diff --git a/server/routes/a.test.js b/server/routes/a.test.js',
    '@@ -0,0 +1 @@',
    `+const f = '${UNASSIGNABLE}';`,
    'diff --git this-header-does-not-parse',
    '@@ -0,0 +1,2 @@',
    `+const g = '${UNASSIGNABLE}';`,
    `+text ${COMPANY_TEXT_PHONE} or contact@drbartender.com`,
    'diff --git "a/bad\\qescape.js" "b/bad\\qescape.js"',
    '@@ -0,0 +1 @@',
    `+const h = '${FIXTURE_555}';`,
    '',
  ].join('\n');
  const lines = maskDiff(diff).split('\n');
  assert.strictEqual(lines[5], "+const g = '<PHONE>';");
  assert.strictEqual(lines[6], '+text <PHONE> or <EMAIL>', 'no allowlist at all on a null path');
  assert.strictEqual(lines[9], "+const h = '<PHONE>';", 'a quoted path that fails to decode is a null path');
  const hits = findInDiff(diff);
  assert.strictEqual(hits.length, 4);
  assert.ok(hits.every((h) => h.path === null));
});

// L8: the static-checks consumer prints hits into a transcript, so a hit
// carries the MASKED line and its new-file line number, never the raw value.
test('findInDiff hits carry the masked line and its line number, never the raw value', () => {
  const diff = [
    'diff --git a/server/routes/a.js b/server/routes/a.js',
    '--- a/server/routes/a.js',
    '+++ b/server/routes/a.js',
    '@@ -10,2 +20,3 @@ function f() {',
    ' const keep = 1;',
    `-const old = '${UNASSIGNABLE}';`,
    `+const nu = '${UNASSIGNABLE}';`,
    `+const mail = "${SHORT_EMAIL}";`,
    '',
  ].join('\n');
  const hits = findInDiff(diff);
  assert.deepStrictEqual(hits, [
    { shape: 'PHONE', path: 'server/routes/a.js', line: 21, text: "const nu = '<PHONE>';" },
    { shape: 'EMAIL', path: 'server/routes/a.js', line: 22, text: 'const mail = "<EMAIL>";' },
  ]);
  assert.ok(!JSON.stringify(hits).includes(UNASSIGNABLE));
  assert.ok(!JSON.stringify(hits).includes(SHORT_EMAIL));
  // the library function keeps the raw match: the masker needs it
  assert.strictEqual(findPii(`x ${UNASSIGNABLE}`, { path: ROUTE })[0].match, UNASSIGNABLE);
});

// Added ruling (step 2 plan fleet, D9): the PII pre-step reads added lines of
// EVERY path, docs, specs, plans and .claude files included; only the per-path
// allowlist narrows it. Code-path scoping belongs to the content rule.
test('findInDiff reads added lines of every path, docs included', () => {
  const diff = (p, value) => [
    `diff --git a/${p} b/${p}`,
    `--- a/${p}`,
    `+++ b/${p}`,
    '@@ -0,0 +1 @@',
    `+Call the planner at ${value} after the walk.`,
    '',
  ].join('\n');
  for (const p of ['docs/x.md', 'docs/superpowers/plans/p.md', '.claude/agents/a.md']) {
    const hits = findInDiff(diff(p, UNASSIGNABLE));
    assert.deepStrictEqual(hits.map((h) => [h.shape, h.path]), [['PHONE', p]], p);
    assert.deepStrictEqual(findInDiff(diff(p, FIXTURE_555)), [], `${p}: a 555 fixture is not PII`);
  }
});

test('findInDiff reads added lines only, with their paths', () => {
  const diff = [
    'diff --git a/server/routes/a.js b/server/routes/a.js',
    '+++ b/server/routes/a.js',
    '@@ -1,1 +1,2 @@',
    `-const old = '${UNASSIGNABLE}';`,
    `+const nu = '${SK_LIVE}';`,
    ` const ctx = '${UNASSIGNABLE}';`,
    '',
  ].join('\n');
  const hits = findInDiff(diff);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].path, 'server/routes/a.js');
  assert.strictEqual(hits[0].shape, 'TOKEN');
});

// L9: the repo is public, so this file must carry no number a real subscriber
// could hold. Independent of the module under test: a North American shape is
// assignable when its area code and exchange both start 2-9 and the exchange is
// not the 555 fixture exchange.
test('this test file carries no assignable North American number', () => {
  const src = require('node:fs').readFileSync(__filename, 'utf8');
  const sep = '[ .\\-/\\u00A0\\u2012\\u2013]{0,2}';
  const nanp = new RegExp(`(?<![0-9])(?:\\+?1${sep})?\\(?([0-9]{3})\\)?${sep}([0-9]{3})${sep}[0-9]{4}(?![0-9])`, 'g');
  let assignable = 0;
  for (const m of src.matchAll(nanp)) {
    const [area, exchange] = [m[1], m[2]];
    if (/^[2-9]/.test(area) && /^[2-9]/.test(exchange) && exchange !== '555') assignable++;
  }
  assert.strictEqual(assignable, 0, 'assignable North American numbers in this file');
});

// ---- L4: the --find --added CLI ------------------------------------------
const fs = require('node:fs');
const os = require('node:os');

// L6: the business lines are the registries' exported values. A number named
// in a registry comment is not a business line and must never be allowlisted.
test('the business lines come from the registries exports, never their comments', () => {
  const { readBusinessLines } = require(MOD);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-registry-'));
  fs.mkdirSync(path.join(root, 'server', 'utils'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server/utils/companyPhone.js'), [
    '// the old voice line was (100) 200-3999, retired',
    "const COMPANY_PHONE = '(100) 200-3000';",
    "const COMPANY_TEXT_PHONE = '(100) 200-3001';",
    'module.exports = { COMPANY_PHONE, COMPANY_TEXT_PHONE };',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'server/utils/smsLines.js'), [
    '// a staffer once texted from +11002003998',
    "const LINE_KEYS = Object.freeze(['888', '1922']);",
    "const FIXED = new Map([['1922', '+11002003002']]);",
    "function lineE164(key) { return key === '888' ? null : FIXED.get(key) || null; }",
    'module.exports = { LINE_KEYS, lineE164 };',
    '',
  ].join('\n'));
  assert.deepStrictEqual(readBusinessLines(root).sort(), ['1002003000', '1002003001', '1002003002']);
});

// A registry that fails to load allowlists nothing, and says so: the failure is
// recorded, never swallowed, so the CLI can print it and a reviewer can see why
// a business line masked.
test('a registry that fails to load is recorded, not swallowed', () => {
  const { readBusinessLines, registryLoadNotes } = require(MOD);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-registry-missing-'));
  const before = registryLoadNotes().length;
  assert.deepStrictEqual(readBusinessLines(root), []);
  const notes = registryLoadNotes().slice(before);
  assert.strictEqual(notes.length, 2, notes.join('; '));
  assert.ok(notes.every((n) => /companyPhone\.js|smsLines\.js/.test(n) && /MODULE_NOT_FOUND|Cannot find/.test(n)), notes.join('; '));
  fs.rmSync(root, { recursive: true, force: true });
});

function scratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-find-'));
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'a.js'), 'const a = 1;\n');
  git('add', 'a.js');
  git('commit', '-q', '-m', 'one');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  fs.writeFileSync(path.join(dir, 'a.js'), `const a = 1;\nconst b = '${UNASSIGNABLE}';\n`);
  git('add', 'a.js');
  git('commit', '-q', '-m', 'two');
  const tip = git('rev-parse', 'HEAD').stdout.trim();
  return { dir, base, tip };
}

function find(cwd, ...args) {
  return spawnSync(process.execPath, [MOD, '--find', '--added', ...args], { cwd, encoding: 'utf8' });
}

test('--find --added reads the added lines between two commits, masked', () => {
  const { dir, base, tip } = scratchRepo();
  const res = find(dir, base, tip);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.deepStrictEqual(JSON.parse(res.stdout), [
    { shape: 'PHONE', path: 'a.js', line: 2, text: "const b = '<PHONE>';" },
  ]);
  assert.strictEqual(find(dir, 'HEAD~1', 'HEAD').status, 0, 'refs that resolve to commits are fine');
});

test('--find --added refuses an option smuggled in as a ref', () => {
  const { dir } = scratchRepo();
  const target = path.join(dir, 'clobbered.txt');
  const res = find(dir, `--output=${target}`, 'HEAD');
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /usage/);
  assert.ok(!fs.existsSync(target), 'git must never see the smuggled option');
});

test('--find --added refuses two paths that are not commits (no implicit --no-index)', () => {
  const { dir } = scratchRepo();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-outside-'));
  fs.writeFileSync(path.join(out, 'one.txt'), 'CANARY-ONE\n');
  fs.writeFileSync(path.join(out, 'two.txt'), 'CANARY-TWO\n');
  const res = find(dir, path.join(out, 'one.txt'), path.join(out, 'two.txt'));
  assert.strictEqual(res.status, 2);
  assert.ok(!/CANARY/.test(res.stdout + res.stderr), 'no file outside the repo is read');
});

// L7 (third pass): the user's diff config never narrows --find or breaks its
// path attribution. diff.relative from a subdirectory would drop every file
// outside it; diff.noprefix (and diff.mnemonicPrefix on the staged form) would
// leave headers the parser cannot read, so a test file's fixture would be
// judged strict and reported.
test('--find ignores diff.relative from a subdirectory, in both forms', () => {
  const { dir, base, tip } = scratchRepo();
  spawnSync('git', ['config', 'diff.relative', 'true'], { cwd: dir });
  const sub = path.join(dir, 'sub');
  fs.mkdirSync(sub);
  const expected = [{ shape: 'PHONE', path: 'a.js', line: 2, text: "const b = '<PHONE>';" }];
  const added = find(sub, base, tip);
  assert.strictEqual(added.status, 0, added.stderr);
  assert.deepStrictEqual(JSON.parse(added.stdout), expected, '--added');
  fs.writeFileSync(path.join(dir, 'a.js'), `const a = 1;\nconst b = '${UNASSIGNABLE}';\nconst c = '${UNASSIGNABLE}';\n`);
  spawnSync('git', ['add', 'a.js'], { cwd: dir });
  const staged = spawnSync(process.execPath, [MOD, '--find', '--staged'], { cwd: sub, encoding: 'utf8' });
  assert.strictEqual(staged.status, 0, staged.stderr);
  assert.deepStrictEqual(JSON.parse(staged.stdout), [{ shape: 'PHONE', path: 'a.js', line: 3, text: "const c = '<PHONE>';" }], '--staged');
});

test('--find attributes paths under diff.noprefix and diff.mnemonicPrefix', () => {
  const { dir } = scratchRepo();
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, 'a.test.js'), `const fixture = '${UNASSIGNABLE}';\n`);
  git('add', 'a.test.js');
  git('commit', '-q', '-m', 'fixture');
  git('config', 'diff.noprefix', 'true');
  const added = find(dir, 'HEAD~1', 'HEAD');
  assert.strictEqual(added.status, 0, added.stderr);
  assert.deepStrictEqual(JSON.parse(added.stdout), [], 'a fixture in a test file is not reported under noprefix');
  git('config', '--unset', 'diff.noprefix');
  git('config', 'diff.mnemonicPrefix', 'true');
  fs.writeFileSync(path.join(dir, 'a.test.js'), `const fixture = '${UNASSIGNABLE}';\nconst more = '${UNASSIGNABLE}';\n`);
  git('add', 'a.test.js');
  const staged = spawnSync(process.execPath, [MOD, '--find', '--staged'], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(staged.status, 0, staged.stderr);
  assert.deepStrictEqual(JSON.parse(staged.stdout), [], 'a staged fixture is not reported under mnemonicPrefix');
});

// L2 (third pass): a rename or a copy names its old path in `rename from` or
// `copy from`. A removed line, and the funcname copy git puts in a hunk header,
// lived in the old file, so they mask under the stricter of the two paths'
// classes: a code file renamed into a test path does not turn its ids into
// fixtures. An added line lives in the new file and keeps the new path's class.
test('a removed line of a rename or a copy masks under the stricter of the two paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-rename-'));
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.mkdirSync(path.join(dir, 'server', 'routes'), { recursive: true });
  const uuid = '3f2a1c9e-8b7d-4e6f-a5b4-c3d2e1f0a9b8';
  const owner = 'cus_Q7x1729459200000Zq';
  const filler = (words) => words.map((w, i) => `  const ${w} = ${i};`);
  const body = (middle) => [`const owner = '${owner}';`, ...filler(['one', 'two', 'three', 'four']), ...middle,
    ...filler(['five', 'six', 'seven', 'eight', 'nine', 'ten'])].join('\n') + '\n';
  const removed = [`  const link = '${uuid}';`, `  const intent = '${STRIPE_PI}';`];
  fs.writeFileSync(path.join(dir, 'server/routes/x.js'), body(removed));
  fs.writeFileSync(path.join(dir, 'server/routes/y.js'), body(removed).replace(/const (\w+) = (\d+)/g, 'let $1 = $2'));
  git('add', 'server');
  git('commit', '-q', '-m', 'one');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  git('mv', 'server/routes/x.js', 'server/routes/x.test.js');
  fs.writeFileSync(path.join(dir, 'server/routes/x.test.js'), body([`  const fixture = '${uuid}';`]));
  fs.writeFileSync(path.join(dir, 'server/routes/y.test.js'), body([]).replace(/const (\w+) = (\d+)/g, 'let $1 = $2'));
  git('add', 'server');
  git('commit', '-q', '-m', 'two');
  const res = git('diff', '--no-color', '--unified=0', '-M', '-C', '-C', base, 'HEAD');
  assert.strictEqual(res.status, 0, res.stderr);
  const diff = res.stdout;
  assert.match(diff, /^rename from server\/routes\/x\.js$/m, 'the diff is a real rename');
  assert.match(diff, /^copy from server\/routes\/y\.js$/m, 'the diff is a real copy');
  const out = maskDiff(diff);
  assert.ok(!out.includes(STRIPE_PI), 'no Stripe id survives on a removed line');
  assert.ok(!out.includes(owner), 'no Stripe id survives in a funcname tail');
  const lines = out.split('\n');
  assert.strictEqual(lines.filter((l) => l === "-  const link = '<UUID>';").length, 2, 'the rename and the copy both mask the removed UUID');
  assert.strictEqual(lines.filter((l) => l === `-  const intent = '<STRIPE_ID>';`).length, 2);
  assert.ok(lines.some((l) => /^@@ [^@]+ @@ const owner = '<STRIPE_ID>';$/.test(l)), 'the funcname tail masks');
  assert.ok(lines.includes(`+  const fixture = '${uuid}';`), 'an added line keeps the test path class');
  assert.deepStrictEqual(findInDiff(diff), [], 'the added fixture in the test path is not reported');
});

// A context line of a renamed section lived in the old file too (it is unchanged
// between the two), so it takes the stricter class like a removed line does.
test('a context line of a rename masks under the stricter of the two paths', () => {
  const owner = 'cus_Q7x1729459200000Zq';
  const hunk = ['@@ -1,3 +1,3 @@', ` const owner = '${owner}';`, '-  const a = 1;', '+  const a = 2;', ' const b = 3;', ''].join('\n');
  const renamed = ['diff --git a/server/routes/x.js b/server/routes/x.test.js', 'similarity index 90%', 'rename from server/routes/x.js',
    'rename to server/routes/x.test.js', '--- a/server/routes/x.js', '+++ b/server/routes/x.test.js', hunk].join('\n');
  assert.ok(maskDiff(renamed).includes(` const owner = '<STRIPE_ID>';`), 'the context line of a code file renamed into a test path masks');
  const plain = ['diff --git a/server/routes/x.test.js b/server/routes/x.test.js', '--- a/server/routes/x.test.js', '+++ b/server/routes/x.test.js', hunk].join('\n');
  assert.ok(maskDiff(plain).includes(` const owner = '${owner}';`), 'the same context line in a test file that was not renamed keeps its fixture');
});

test('the shapes and the allowlist are exported for the static checks and the mask', () => {
  for (const name of ['EMAIL', 'PHONE', 'TOKEN', 'STRIPE_ID', 'ROUTING_EIN']) assert.ok(SHAPES[name], name);
  assert.ok(ALLOWLIST.paths.includes('server/utils/companyPhone.js'));
  assert.ok(ALLOWLIST.paths.includes('server/utils/smsLines.js'));
  assert.ok(ALLOWLIST.paths.includes('server/db/seedTestData.js'));
  assert.ok(ALLOWLIST.paths.includes('**/*.test.js'));
  assert.strictEqual(ALLOWLIST.emailDomains[0], 'drbartender.com');
});

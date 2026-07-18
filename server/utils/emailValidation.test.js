// Pure unit tests for the typo-domain heuristic (spec 4.8). No DB, no dotenv.
// Run alone: node --test server/utils/emailValidation.test.js

const test = require('node:test');
const assert = require('node:assert');
const { checkEmailDomain } = require('./emailValidation');

test('flags a TLD one edit from .com (Cathy incident: .conm)', () => {
  const r = checkEmailDomain('cmurphy@arthrex-chicago.conm');
  assert.strictEqual(r.suspicious, true);
  assert.strictEqual(r.suggestion, 'arthrex-chicago.com');
  assert.strictEqual(r.reason, "'.conm' looks like a typo of '.com'");
});

test('flags every listed one-edit TLD typo of .com', () => {
  for (const [tld, base] of [['con', 'x'], ['conm', 'x'], ['cmo', 'x'], ['ocm', 'x'], ['vom', 'x']]) {
    const r = checkEmailDomain(`user@${base}.${tld}`);
    assert.strictEqual(r.suspicious, true, `${tld} should be suspicious`);
    assert.strictEqual(r.suggestion, `${base}.com`, `${tld} should suggest .com`);
    assert.strictEqual(r.reason, `'.${tld}' looks like a typo of '.com'`);
  }
});

test('flags provider confusable hmail.com (the burned-client case) as gmail.com', () => {
  const r = checkEmailDomain('joannak1120@hmail.com');
  assert.strictEqual(r.suspicious, true);
  assert.strictEqual(r.suggestion, 'gmail.com');
  assert.strictEqual(r.reason, "'hmail.com' looks like a typo of 'gmail.com'");
});

test('flags gamil.com (transposition) as gmail.com', () => {
  const r = checkEmailDomain('someone@gamil.com');
  assert.strictEqual(r.suspicious, true);
  assert.strictEqual(r.suggestion, 'gmail.com');
});

test('flags yaho.com as yahoo.com', () => {
  const r = checkEmailDomain('someone@yaho.com');
  assert.strictEqual(r.suspicious, true);
  assert.strictEqual(r.suggestion, 'yahoo.com');
});

test('flags outlok.com as outlook.com', () => {
  const r = checkEmailDomain('someone@outlok.com');
  assert.strictEqual(r.suspicious, true);
  assert.strictEqual(r.suggestion, 'outlook.com');
});

test('clean: exact provider gmail.com', () => {
  assert.deepStrictEqual(checkEmailDomain('martinjuly18@gmail.com'), {
    suspicious: false, reason: null, suggestion: null,
  });
});

test('clean: rocketmail.com is a legit provider-adjacent domain, never flag', () => {
  assert.deepStrictEqual(checkEmailDomain('juliafrye@rocketmail.com'), {
    suspicious: false, reason: null, suggestion: null,
  });
});

test('clean: legit short TLD .co is never flagged even though it is one edit from .com', () => {
  assert.deepStrictEqual(checkEmailDomain('x@y.co'), {
    suspicious: false, reason: null, suggestion: null,
  });
});

test('clean: legit TLD .io', () => {
  assert.deepStrictEqual(checkEmailDomain('name@company.io'), {
    suspicious: false, reason: null, suggestion: null,
  });
});

test('clean: Apple private relay domain', () => {
  assert.deepStrictEqual(checkEmailDomain('abc123@privaterelay.appleid.com'), {
    suspicious: false, reason: null, suggestion: null,
  });
});

test('clean: comcast.net exact provider on its non-.com TLD', () => {
  assert.deepStrictEqual(checkEmailDomain('user@comcast.net'), {
    suspicious: false, reason: null, suggestion: null,
  });
});

test('malformed input is not suspicious: empty string', () => {
  assert.deepStrictEqual(checkEmailDomain(''), {
    suspicious: false, reason: null, suggestion: null,
  });
});

test('malformed input is not suspicious: null', () => {
  assert.deepStrictEqual(checkEmailDomain(null), {
    suspicious: false, reason: null, suggestion: null,
  });
});

test('malformed input is not suspicious: undefined', () => {
  assert.deepStrictEqual(checkEmailDomain(undefined), {
    suspicious: false, reason: null, suggestion: null,
  });
});

test('malformed input is not suspicious: no @ garbage', () => {
  assert.deepStrictEqual(checkEmailDomain('garbagenoatsign'), {
    suspicious: false, reason: null, suggestion: null,
  });
});

test('malformed input is not suspicious: domain with no dot', () => {
  assert.deepStrictEqual(checkEmailDomain('a@localhost'), {
    suspicious: false, reason: null, suggestion: null,
  });
});

test('case-insensitive: uppercase GMAIL.COM is clean', () => {
  assert.deepStrictEqual(checkEmailDomain('martinjuly18@GMAIL.COM'), {
    suspicious: false, reason: null, suggestion: null,
  });
});

test('case-insensitive: uppercase HMAIL.COM is suspicious and suggests lowercase gmail.com', () => {
  const r = checkEmailDomain('joannak1120@HMAIL.COM');
  assert.strictEqual(r.suspicious, true);
  assert.strictEqual(r.suggestion, 'gmail.com');
  assert.strictEqual(r.reason, "'hmail.com' looks like a typo of 'gmail.com'");
});

test('leading/trailing whitespace is trimmed before evaluation', () => {
  const r = checkEmailDomain('  cmurphy@arthrex-chicago.conm  ');
  assert.strictEqual(r.suspicious, true);
  assert.strictEqual(r.suggestion, 'arthrex-chicago.com');
});

test('no em dashes appear in any reason string', () => {
  const reasons = [
    checkEmailDomain('cmurphy@arthrex-chicago.conm').reason,
    checkEmailDomain('joannak1120@hmail.com').reason,
  ];
  for (const reason of reasons) {
    assert.ok(reason && !reason.includes('—'), `reason must not contain an em dash: ${reason}`);
  }
});

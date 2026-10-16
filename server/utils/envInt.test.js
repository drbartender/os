process.env.NODE_ENV = 'test';
// Pure suite (no DB, no network).

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { readEnvInt, _resetWarningsForTest } = require('./envInt');

const NAME = 'ENV_INT_TEST_VALUE';
const OTHER = 'ENV_INT_TEST_OTHER';

let warnings;
let realWarn;
beforeEach(() => {
  _resetWarningsForTest();
  delete process.env[NAME];
  delete process.env[OTHER];
  warnings = [];
  realWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
});
afterEach(() => {
  console.warn = realWarn;
  delete process.env[NAME];
  delete process.env[OTHER];
  _resetWarningsForTest();
});

test('a positive whole number is read as that number', () => {
  process.env[NAME] = '60';
  assert.equal(readEnvInt(NAME, 5), 60);
  process.env[NAME] = ' 180000 ';
  assert.equal(readEnvInt(NAME, 5), 180000);
  process.env[NAME] = '1';
  assert.equal(readEnvInt(NAME, 5), 1);
  assert.equal(warnings.length, 0);
});

test('blank, zero, negative, fractional and nonsense values give the fallback', () => {
  for (const bad of ['', '   ', '0', '00', '-5', '1.5', '60.0', 'abc', '60abc', '1e3', '+60', '0x10', 'Infinity', '99999999999999999999']) {
    _resetWarningsForTest();
    process.env[NAME] = bad;
    assert.equal(readEnvInt(NAME, 42), 42, `value ${JSON.stringify(bad)} should fall back`);
  }
});

test('unset gives the fallback without a warning (the normal state)', () => {
  assert.equal(readEnvInt(NAME, 300000), 300000);
  assert.equal(readEnvInt(NAME, 300000), 300000);
  assert.equal(warnings.length, 0);
});

test('the warning fires once per name per process, and names the variable, not the value', () => {
  process.env[NAME] = 'sk-not-a-number';
  assert.equal(readEnvInt(NAME, 60), 60);
  assert.equal(readEnvInt(NAME, 60), 60);
  process.env[NAME] = '0';
  assert.equal(readEnvInt(NAME, 60), 60);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ENV_INT_TEST_VALUE/);
  assert.match(warnings[0], /using 60/);
  assert.doesNotMatch(warnings[0], /sk-not-a-number/);

  process.env[OTHER] = '-1';
  assert.equal(readEnvInt(OTHER, 7), 7);
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /ENV_INT_TEST_OTHER/);
});

test('a later good value is read even after a warning', () => {
  process.env[NAME] = 'abc';
  assert.equal(readEnvInt(NAME, 20), 20);
  process.env[NAME] = '45';
  assert.equal(readEnvInt(NAME, 20), 45);
  assert.equal(warnings.length, 1);
});

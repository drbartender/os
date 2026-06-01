// Unit tests for the SEND_NOTIFICATIONS gate (utils/notificationsEnabled.js).
// This pure function decides whether real Resend/Twilio sends fire, so a future
// refactor flipping a condition would silently either burn provider allotments
// in dev or (worse) mute notifications in prod. These pin all four branches.
//
// No DB / dotenv needed — it reads only SEND_NOTIFICATIONS + NODE_ENV at call
// time. We snapshot both vars at load and restore after each case so the suite
// is order-independent and leaves the environment as it found it.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { notificationsEnabled } = require('./notificationsEnabled');

const ORIG = {
  SEND_NOTIFICATIONS: process.env.SEND_NOTIFICATIONS,
  NODE_ENV: process.env.NODE_ENV,
};

function setVar(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  setVar('SEND_NOTIFICATIONS', ORIG.SEND_NOTIFICATIONS);
  setVar('NODE_ENV', ORIG.NODE_ENV);
});

test("SEND_NOTIFICATIONS='true' forces sends on, even outside production", () => {
  setVar('SEND_NOTIFICATIONS', 'true');
  setVar('NODE_ENV', 'development');
  assert.equal(notificationsEnabled(), true);
});

test("SEND_NOTIFICATIONS='false' forces sends off, even in production", () => {
  setVar('SEND_NOTIFICATIONS', 'false');
  setVar('NODE_ENV', 'production');
  assert.equal(notificationsEnabled(), false);
});

test('unset in production → sends (prod default)', () => {
  setVar('SEND_NOTIFICATIONS', undefined);
  setVar('NODE_ENV', 'production');
  assert.equal(notificationsEnabled(), true);
});

test('unset outside production → log-only (dev default)', () => {
  setVar('SEND_NOTIFICATIONS', undefined);
  setVar('NODE_ENV', 'development');
  assert.equal(notificationsEnabled(), false);
});

test('unset with NODE_ENV also unset → log-only (safe default)', () => {
  setVar('SEND_NOTIFICATIONS', undefined);
  setVar('NODE_ENV', undefined);
  assert.equal(notificationsEnabled(), false);
});

test("a non-canonical value (e.g. 'TRUE') falls back to the NODE_ENV rule", () => {
  // The gate matches the exact lowercase strings; anything else defers to
  // NODE_ENV. Documents the case-sensitivity so it is a deliberate contract.
  setVar('SEND_NOTIFICATIONS', 'TRUE');
  setVar('NODE_ENV', 'development');
  assert.equal(notificationsEnabled(), false);
});

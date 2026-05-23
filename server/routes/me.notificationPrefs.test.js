require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { applyNotificationPrefPatch } = require('./me');

// applyNotificationPrefPatch is a pure helper exported from me.js for testing:
// given the current prefs object and a patch body, it returns the merged prefs
// or throws a ValidationError on a bad key / non-boolean value.

test('applyNotificationPrefPatch > merges a valid boolean toggle', () => {
  const current = { payment_failure: true, urgent_booking: true };
  const merged = applyNotificationPrefPatch(current, { payment_failure: false });
  assert.strictEqual(merged.payment_failure, false);
  assert.strictEqual(merged.urgent_booking, true);
});

test('applyNotificationPrefPatch > rejects an unknown category key', () => {
  assert.throws(
    () => applyNotificationPrefPatch({}, { not_a_category: true }),
    /category/
  );
});

test('applyNotificationPrefPatch > rejects a non-boolean value', () => {
  assert.throws(
    () => applyNotificationPrefPatch({}, { payment_failure: 'yes' }),
    /boolean/
  );
});

test('applyNotificationPrefPatch > rejects an empty patch', () => {
  assert.throws(
    () => applyNotificationPrefPatch({}, {}),
    /at least one/
  );
});

after(async () => {
  await pool.end();
});

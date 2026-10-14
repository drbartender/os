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

const { applyAdminPushPrefPatch } = require('./me');

test('applyAdminPushPrefPatch > merges a kind switch and keeps the rest', () => {
  const merged = applyAdminPushPrefPatch({ staffing_drop: false }, { payment_landed: false });
  assert.deepEqual(merged, { staffing_drop: false, payment_landed: false });
});
test('applyAdminPushPrefPatch > a true switch is stored as true (absent means on, true is explicit)', () => {
  assert.deepEqual(applyAdminPushPrefPatch({ staffing_drop: false }, { staffing_drop: true }), { staffing_drop: true });
});
test('applyAdminPushPrefPatch > rejects an unknown kind, a non-boolean, an inherited name, an empty patch', () => {
  assert.throws(() => applyAdminPushPrefPatch({}, { routine_thumbtack: true }), /kind/);
  assert.throws(() => applyAdminPushPrefPatch({}, { staffing_drop: 'yes' }), /boolean/);
  assert.throws(() => applyAdminPushPrefPatch({}, { constructor: true }), /kind/);
  assert.throws(() => applyAdminPushPrefPatch({}, {}), /at least one/);
});

after(async () => {
  await pool.end();
});

test('applyNotificationPrefPatch > lead_call is a PATCHable category (lead-call bridge)', () => {
  const merged = applyNotificationPrefPatch({}, { lead_call: false });
  assert.equal(merged.lead_call, false);
});

test('NOTIFICATION_CATEGORIES > lists lead_call for the settings screen', () => {
  const { NOTIFICATION_CATEGORIES } = require('./me');
  assert.ok(NOTIFICATION_CATEGORIES.includes('lead_call'));
});

require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeEditWindow, filterToAllowlist, cancelPendingChangeRequestsForProposal, buildPreview, overrideOnlyBartenders } = require('./changeRequests');
const { pool } = require('../db');
const crypto = require('node:crypto');

test('computeEditWindow: not booked is pre_booking', () => {
  assert.equal(computeEditWindow({ status: 'sent', event_date: '2099-01-01' }), 'pre_booking');
});
test('computeEditWindow: booked, far out is before_t14', () => {
  assert.equal(computeEditWindow({ status: 'deposit_paid', event_date: '2099-01-01' }), 'before_t14');
});
test('computeEditWindow: booked, past date is inside_t14', () => {
  assert.equal(computeEditWindow({ status: 'confirmed', event_date: '2000-01-01' }), 'inside_t14');
});
test('filterToAllowlist drops note/acknowledged_total and rejects unknown keys', () => {
  const out = filterToAllowlist({ guest_count: 120, note: 'hi', acknowledged_total: 5000 });
  assert.deepEqual(out, { guest_count: 120 });
  assert.throws(() => filterToAllowlist({ total_price_override: 1 }), /not be changed/i);
  assert.throws(() => filterToAllowlist({ adjustments: [] }), /not be changed/i);
});

// An admin's over-ratio bartender survives the change-request preview (audit
// PRC-02). Pure: priceProposedState takes a `db` with a .query method
// (changeRequests.gratuity.test.js), so the package row is scripted and no
// seeding is needed. Fixture columns mirror service_packages (the BYOB
// fixture of pricingEngine.test.js): BYOB, 40 guests, 4h, a hand-set second
// bartender: required 1, extra 1 at 40/h plus the 50/h sub-50-guest
// surcharge = 360 on top of the 350 base, total 710 (engine case B of the
// audit). The portal form never sends num_bartenders.
const BYOB_PKG = { id: 1, slug: 'the-core-reaction', name: 'The Core Reaction', category: 'byob', pricing_type: 'flat',
  bar_type: 'service_only', base_rate_4hr: 350, base_rate_3hr: null, extra_hour_rate: 100,
  bartenders_included: 1, min_guests: 0, guests_per_bartender: 100, extra_bartender_hourly: 40,
  first_bar_fee: 50, additional_bar_fee: 100 };
const fakeDb = { query: (sql) => Promise.resolve(sql.includes('service_packages') ? { rows: [BYOB_PKG] } : { rows: [] }) };
const overrideProposal = () => ({
  id: 5, package_id: 1, guest_count: 40, event_duration_hours: 4, num_bars: 0, num_bartenders: 2,
  total_price: 710, total_price_override: null, adjustments: [], client_provides_glassware: false,
  gratuity_rate: 0, tip_jar: true, gratuity_floor_rate: null,
  pricing_snapshot: { staffing: { required: 1, actual: 2, extra: 1 }, gratuity: { staff_count: 2, hours: 4 }, total: 710 },
});

test('a change-request preview keeps a stored bartender override: a no-op request estimates the current total', async () => {
  const { snapshot, price_preview } = await buildPreview(overrideProposal(), { venue_name: 'Test Hall' }, fakeDb);
  assert.equal(snapshot.staffing.actual, 2, 'the hand-set crew is priced, not re-derived from the ratio');
  assert.equal(snapshot.staffing.extra, 1);
  assert.equal(price_preview.estimated_total, 710, '350 base + 1 x 4h x (40 + 50 surcharge)');
  assert.equal(price_preview.current_total, 710);
  assert.equal(price_preview.delta, 0, 'a change that moves no price shows no delta');
  assert.deepEqual(price_preview.staffing, { current: 2, estimated: 2 });
});

test('a change-request preview still re-derives a crew the snapshot proves is a derivation', async () => {
  // Stored 1 = required 1 = actual 1: a persisted derivation, so a guest
  // count that crosses the ratio re-derives (41 guests on BYOB keeps 1).
  const derived = { ...overrideProposal(), num_bartenders: 1, total_price: 350,
    pricing_snapshot: { staffing: { required: 1, actual: 1, extra: 0 }, gratuity: { staff_count: 1, hours: 4 }, total: 350 } };
  const { snapshot, price_preview } = await buildPreview(derived, { guest_count: 45 }, fakeDb);
  assert.equal(snapshot.staffing.actual, 1);
  assert.equal(price_preview.estimated_total, 350);
  assert.equal(overrideOnlyBartenders(derived), null);
  assert.equal(overrideOnlyBartenders(overrideProposal()), 2);
  // The explicit field still wins over the stored column (the quote's own pass).
  const explicit = await buildPreview(overrideProposal(), { num_bartenders: 1 }, fakeDb);
  assert.equal(explicit.snapshot.staffing.actual, 1);
});

const RNONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
test('cancelPendingChangeRequestsForProposal cancels pending rows', async () => {
  const c = await pool.query('INSERT INTO clients (name,email) VALUES ($1,$2) RETURNING id', ['Reap', `reap-${RNONCE}@example.com`]);
  const p = await pool.query("INSERT INTO proposals (client_id, status) VALUES ($1,'completed') RETURNING id", [c.rows[0].id]);
  await pool.query(`INSERT INTO proposal_change_requests (proposal_id, client_id, status, edit_window) VALUES ($1,$2,'pending','before_t14')`, [p.rows[0].id, c.rows[0].id]);
  const n = await cancelPendingChangeRequestsForProposal(p.rows[0].id);
  assert.equal(n, 1);
  const after = await pool.query('SELECT status, cancelled_by FROM proposal_change_requests WHERE proposal_id = $1', [p.rows[0].id]);
  assert.equal(after.rows[0].status, 'cancelled');
  assert.equal(after.rows[0].cancelled_by, 'system');
  await pool.query('DELETE FROM proposal_change_requests WHERE proposal_id = $1', [p.rows[0].id]);
  await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [p.rows[0].id]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [p.rows[0].id]);
  await pool.query('DELETE FROM clients WHERE id = $1', [c.rows[0].id]);
});

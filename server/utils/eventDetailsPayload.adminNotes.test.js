'use strict';
// The drink plan's admin_notes ride the contact gate (audit 2026-11-05
// AUTH-05).
//
// The 2026-07-22 ungating let any onboarded staffer read any staffable event
// so they can decide whether to request it, and kept the client's phone and
// the crew's numbers behind canSeeContact (assigned or admin/manager). The
// plan's admin_notes, the admin's internal remarks about the client and the
// event, were projected to everyone; they now ride the same switch.
//
// Pure: buildEventDetailsPayload reads through the shared pool, so the six
// reads are answered from fixture rows (the `pool.query = ...` seam of
// sms.status.test.js). The DB-backed route suites are eventDetails.test.js
// and beo.test.js.

require('dotenv').config();
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { buildEventDetailsPayload } = require('./eventDetailsPayload');

const PROPOSAL_ID = 501;
const ASSIGNED = 8;
const BROWSING = 9;
const NOTE = 'Host wants the bar away from the band; keep it between us';

const proposalRow = {
  id: PROPOSAL_ID, event_type: 'Wedding', event_type_custom: null, event_date: '2026-12-31',
  event_start_time: '18:00', event_duration_hours: 4, event_timezone: 'America/Chicago',
  event_location: 'Test Hall, Chicago, IL', guest_count: 50, venue_street: '1 Test St',
  venue_city: 'Chicago', venue_state: 'IL', venue_zip: null, num_bars: 1, num_bartenders: 1,
  setup_minutes_before: 60, status: 'confirmed', bar_required: true, balance_due_date: null,
  client_id: 3, tip_jar: true, gratuity_rate: 0, staff_noun: null, menu_print_key: null,
  menu_not_required: false, client_name: 'Event Client', client_phone: '5555550123',
  package_id: 1, package_name: 'Core', package_pricing_type: 'hosted', guests_per_bartender: 100,
};
const planRow = {
  id: 77, status: 'reviewed', finalized_at: null, finalized_by: null, selections: {},
  consult_selections: null, admin_notes: NOTE, shopping_list_status: null, has_logo: false,
};
const assignedRequest = { user_id: ASSIGNED, request_id: 1, name: 'Assigned Staffer', beo_acknowledged_at: null };
const rosterRow = {
  user_id: ASSIGNED, role: 'bartender', cover_requested_at: null, preferred_name: 'Assigned',
  phone: '5555550199', applications_name: null, agreements_name: null, email: 'assigned@example.com',
};

const realQuery = pool.query;
pool.query = (raw) => {
  const text = String(raw).replace(/\s+/g, ' ');
  if (text.includes('FROM proposals p')) return Promise.resolve({ rows: [proposalRow], rowCount: 1 });
  if (text.includes('FROM drink_plans WHERE proposal_id')) return Promise.resolve({ rows: [planRow], rowCount: 1 });
  if (text.includes('FROM proposal_addons')) return Promise.resolve({ rows: [], rowCount: 0 });
  if (text.includes('sr.id AS request_id')) return Promise.resolve({ rows: [assignedRequest], rowCount: 1 });
  if (text.includes('sr.position AS role')) return Promise.resolve({ rows: [rosterRow], rowCount: 1 });
  if (text.includes('LEFT JOIN LATERAL')) return Promise.resolve({ rows: [], rowCount: 0 });
  return Promise.reject(new Error(`adminNotes stub: unexpected statement ${text.slice(0, 80)}`));
};
after(() => { pool.query = realQuery; });

const asUser = (id, role = 'staff') => ({ user: { id, role, onboarding_status: 'approved' } });

test('an onboarded staffer browsing an event they are not on gets no admin_notes, as they get no client phone', async () => {
  const p = await buildEventDetailsPayload(asUser(BROWSING), PROPOSAL_ID);
  assert.equal(p.viewer.is_assigned, false);
  assert.equal(p.client.phone, null, 'the existing contact gate');
  assert.equal(p.drink_plan.admin_notes, null, 'admin_notes ride the same gate');
});

test('an assigned staffer sees admin_notes', async () => {
  const p = await buildEventDetailsPayload(asUser(ASSIGNED), PROPOSAL_ID);
  assert.equal(p.viewer.is_assigned, true);
  assert.equal(p.client.phone, '5555550123');
  assert.equal(p.drink_plan.admin_notes, NOTE);
});

test('an admin viewer sees admin_notes', async () => {
  const p = await buildEventDetailsPayload(asUser(42, 'admin'), PROPOSAL_ID);
  assert.equal(p.viewer.is_admin, true);
  assert.equal(p.drink_plan.admin_notes, NOTE);
});

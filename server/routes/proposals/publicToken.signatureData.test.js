// The public proposal payload never carries the client's signature image
// (audit ESIG-09, AUTH-09): client_signature_data went out to every token
// holder on GET /t/:token and the switch's 200 (both buildPublicProposalPayload)
// although no client code reads it. No database: the builder takes a db
// argument, and the fake answers the main SELECT with a row holding exactly
// the columns that SELECT names, the way Postgres would, so a column the
// query asks for reaches the payload and one it does not ask for cannot.
//
// Run: node --test server/routes/proposals/publicToken.signatureData.test.js

require('dotenv').config();
process.env.NODE_ENV = 'test';
delete process.env.SENTRY_DSN_SERVER;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { buildPublicProposalPayload } = require('./publicToken');

const TOKEN = crypto.randomUUID();
const SIGNATURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
// Everything the row could hold; the fake projects it through the SELECT list.
const FIXTURE = {
  id: 601, token: TOKEN, client_id: 9, event_date: '2027-06-12', event_start_time: '6:00 PM', event_duration_hours: '4.00',
  event_location: '123 Test St, Rockford, IL', event_type: 'Wedding', event_type_category: null, event_type_custom: null,
  venue_name: null, venue_street: '123 Test St', venue_city: 'Rockford', venue_state: 'IL', venue_zip: null,
  guest_count: 50, package_id: 1, num_bars: 0, num_bartenders: 1,
  pricing_snapshot: { package: { name: 'Test Flat', base_cost: 600 }, staffing: { total: 0 }, total: 600 },
  total_price: '600.00', status: 'accepted', total_price_override: null, group_id: null,
  amount_paid: '0.00', deposit_amount: '100.00', payment_type: 'full', autopay_enrolled: false, balance_due_date: null,
  client_signed_name: 'Test Signer', client_signed_at: '2026-10-01T15:00:00.000Z', client_signature_method: 'draw',
  client_signature_document_version: 'event-services-agreement-v4', client_signature_data: SIGNATURE,
  client_signature_ip: '10.0.0.1', client_signature_user_agent: 'test-agent',
  client_signed_total: '600.00', client_signed_snapshot: { document_version: 'event-services-agreement-v4', rows: [], total: 600 },
  view_count: 1, last_viewed_at: null, created_at: '2026-09-29T15:00:00.000Z', updated_at: '2026-10-01T15:00:00.000Z',
  package_name: 'Test Flat', package_slug: 'test-flat', package_category: 'byob', package_includes: null,
  pkg_pricing_type: 'flat', pkg_bar_type: 'byob', pkg_extra_hour_rate: 100, pkg_extra_hour_rate_small: null,
  pkg_min_guests: null, pkg_min_billed_guests: null,
  client_name: 'Test Signer', client_email: 'client@example.com', client_phone_raw: '5550001234', client_source: 'direct',
  open_invoice_token: null, group_chosen_proposal_id: null, comparable_pkg_count: 3,
};

// The row Postgres would return for the SELECT list: every `p.<col>` and
// every `<expr> AS <alias>` the query names, nothing else.
function projectThroughSelect(sql) {
  const list = sql.split(/\bFROM\b/)[0];
  const row = {};
  for (const m of list.matchAll(/\bp\.([a-z_]+)/g)) row[m[1]] = FIXTURE[m[1]];
  for (const m of list.matchAll(/\bAS\s+([a-z_]+)/g)) row[m[1]] = FIXTURE[m[1]];
  return row;
}

const calls = [];
const fakeDb = {
  query: async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM proposals p/.test(sql) && /WHERE p\.token = \$1/.test(sql)) return { rows: [projectThroughSelect(sql)], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  },
};

function keysDeep(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  return out;
}

test('the public payload carries no client_signature_data, and the SELECT never asks for it', async () => {
  calls.length = 0;
  const payload = await buildPublicProposalPayload(TOKEN, fakeDb);
  assert.ok(payload, 'the builder found the row');
  const main = calls.find((c) => /FROM proposals p/.test(c.sql) && /WHERE p\.token = \$1/.test(c.sql));
  assert.ok(!/client_signature_data/.test(main.sql), 'the SELECT list names client_signature_data');
  const raw = JSON.stringify(payload);
  assert.ok(!raw.includes(SIGNATURE), 'the raw payload carries the signature image');
  const keys = keysDeep(payload);
  for (const k of ['client_signature_data', 'client_signature_ip', 'client_signature_user_agent', 'client_signed_snapshot']) {
    assert.ok(!keys.has(k), `a "${k}" key reached the token holder`);
  }
  // What the page does read stays.
  assert.equal(payload.client_signed_name, 'Test Signer');
  assert.equal(payload.client_signature_document_version, 'event-services-agreement-v4');
  assert.equal(payload.client_signed_total, '600.00');
  assert.ok(Array.isArray(payload.price_rows));
});

// server/utils/lineItemCancel.signature.test.js
'use strict';
// Cancelling a line on a signed booking voids the signature when no money sits
// on the row or in flight (audit ESIG-02, round 2 M1), through the REAL cancel
// core over a scripted transaction client, so it runs with no database. The
// scenario the verify pass traced: a signed accepted row at $1,600 with one
// $100 add-on; the admin removes the add-on on ProposalDetail; before this
// round the fold moved the row to $1,500 under the day-one signature, the
// pay-only card printed the signed $1,600 over an intent minted for $1,500,
// and no signature_voided row was written. Now the core applies the editor
// PATCH's rule after the fold: the signature columns and the signed record
// are cleared in the cancel transaction, the row goes back to 'sent', and a
// signature_voided row keeps the prior record. A paid row and a row with a
// bank debit still settling keep their signature (the additional-services
// flow). The DB-backed sibling, lineItemCancel.signature.db.test.js, drives
// the same scenario against the shared dev DB.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calculateProposal } = require('./pricingEngine');
const { applyLineItemCancel } = require('./lineItemCancel');

// A flat test package at $1,500 and a $100 flat test add-on: engine fixtures in
// the shape the catalog rows take (lineItemCancel.comp.test.js precedent).
const PKG = {
  id: 1, slug: 'test-flat', name: 'Test Package', category: 'byob', pricing_type: 'flat', bar_type: 'service_only',
  base_rate_4hr: 1500, base_rate_3hr: null, extra_hour_rate: 100, min_guests: 0, bartenders_included: 1,
  guests_per_bartender: 100, extra_bartender_hourly: 40, first_bar_fee: 50, additional_bar_fee: 100, min_total: null,
};
const ADDON = {
  id: 42, slug: 'test-addon', name: 'Test Add-on', billing_type: 'flat', rate: 100, extra_hour_rate: null,
  applies_to: 'all', is_active: true, minimum_hours: null,
};
const SIGNED_AT = new Date('2026-10-01T15:00:00.000Z');

function engine({ addons }) {
  return calculateProposal({
    pkg: PKG, guestCount: 50, durationHours: 4, numBars: 0, numBartenders: null,
    addons, syrupSelections: [], adjustments: [], totalPriceOverride: null,
    gratuityRate: 0, tipJar: true, gratuityFloorRate: null,
  });
}

// The row as the sign left it: total 1600, signed, no money.
function signedRow({ status = 'accepted', amountPaid = '0.00', externalPaid = '0.00' } = {}) {
  const snapshot = engine({ addons: [{ ...ADDON, quantity: 1 }] });
  assert.equal(snapshot.total, 1600, 'fixture: 1500 + 100 add-on');
  return {
    id: 77, client_id: 5, package_id: 1, status, total_price: '1600.00', amount_paid: amountPaid,
    external_paid: externalPaid, total_price_override: null, guest_count: 50, event_duration_hours: '4.0', num_bars: 0,
    num_bartenders: null, gratuity_rate: 0, tip_jar: true, gratuity_floor_rate: null, event_date: '2027-06-12',
    event_start_time: '18:00', event_timezone: 'America/Chicago', adjustments: [], pricing_snapshot: snapshot,
    updated_at: new Date('2026-11-01T12:00:00Z'),
    client_signed_name: 'Test Signer', client_signature_data: 'data:image/png;base64,iVBORw0KGgo=', client_signed_at: SIGNED_AT,
    client_signature_method: 'draw', client_signature_ip: '10.0.0.1', client_signature_user_agent: 'test-agent',
    client_signature_document_version: 'event-services-agreement-v4', client_signed_total: '1600.00',
    client_signed_snapshot: { document_version: 'event-services-agreement-v4', rows: [{ key: 'package', label: 'Test Package', amount: 1500 }, { key: 'addon-0', label: 'Test Add-on', amount: 100 }], gratuity_amount: 0, total: 1600 },
    accepted_at: SIGNED_AT,
  };
}

// The add-on row as REPRICE_ADDON_SQL returns it (sa.* plus the pa_ aliases).
const repriceAddon = () => ({
  ...ADDON, pa_quantity: '1', pa_line_total: '100.00', pa_rate: '100.00', pa_duration_hours: '4.0',
  pa_settled_added_hours: 0, pa_min_contracted_hours: null,
});

const SIGNATURE_COLUMNS = ['client_signed_name', 'client_signature_data', 'client_signed_at', 'client_signature_method',
  'client_signature_ip', 'client_signature_user_agent', 'client_signature_document_version', 'client_signed_total', 'client_signed_snapshot'];

// A scripted transaction client for the cancel core's whole cascade, matched
// by statement shape, specific before generic; an unknown statement rejects,
// so a new query in the core shows up here as a failure, never a silent pass.
function scriptedClient(row, { inFlight = [], pending = [] } = {}) {
  const calls = [];
  let addonDeleted = false;
  const answer = (v) => Promise.resolve(v);
  // Pending card sessions (paymentInFlight.js reads the ones created within
  // its window; the window rides as a parameter and is applied here the way
  // Postgres would): [{ created_at: Date }].
  const pendingWithin = (mins) => {
    const cutoff = Date.now() - Number(mins) * 60000;
    return pending.filter((s) => s.created_at.getTime() > cutoff);
  };
  return {
    calls,
    query: (sql, params) => {
      calls.push({ sql, params });
      if (/FROM proposals WHERE id = \$1 FOR UPDATE/.test(sql)) return answer({ rows: [row] });
      if (/FROM service_extensions/.test(sql)) return answer({ rows: [] });
      if (/FROM service_packages WHERE id = \$1/.test(sql)) return answer({ rows: [PKG] });
      if (/sa\.slug = \$2/.test(sql)) {
        return answer({ rows: addonDeleted ? [] : [{
          id: 9001, addon_id: 42, addon_name: 'Test Add-on', billing_type: 'flat', quantity: '1',
          slug: 'test-addon', minimum_hours: null,
        }] });
      }
      if (/FROM proposal_addons pa/.test(sql) && /JOIN service_addons sa/.test(sql)) {
        return answer({ rows: addonDeleted ? [] : [repriceAddon()] });
      }
      if (/DELETE FROM proposal_addons WHERE id = \$1/.test(sql)) { addonDeleted = true; return answer({ rowCount: 1 }); }
      if (/FROM drink_plans/.test(sql)) return answer({ rows: [] });
      if (/UPDATE proposals/.test(sql) && /total_price = \$1/.test(sql)) {
        row.total_price = Number(params[0]).toFixed(2);
        return answer({ rowCount: 1 });
      }
      if (/UPDATE proposals SET status/.test(sql)) return answer({ rowCount: 1 });
      // The void (signatureVoid.js): clear the signature on the in-memory row
      // the way Postgres would, reset a signable status to 'sent' when asked.
      if (/^\s*UPDATE proposals SET\s+client_signed_name = NULL/i.test(sql)) {
        if (!row.client_signed_at) return answer({ rows: [], rowCount: 0 });
        const resetStatus = params[1] === true;
        const signedByClient = row.accepted_at && row.accepted_at.getTime() === row.client_signed_at.getTime();
        for (const c of SIGNATURE_COLUMNS) row[c] = null;
        if (signedByClient) row.accepted_at = null;
        if (resetStatus && ['accepted', 'viewed', 'modified'].includes(row.status)) row.status = 'sent';
        return answer({ rows: [{ ...row }], rowCount: 1 });
      }
      if (/FROM stripe_sessions s/.test(sql) && /status = 'processing'/.test(sql)) return answer({ rows: inFlight });
      if (/FROM stripe_sessions/.test(sql) && /status = 'pending'/.test(sql)) return answer({ rows: pendingWithin(params[1]) });
      if (/INSERT INTO proposal_activity_log/.test(sql)) return answer({ rowCount: 1 });
      if (/SELECT total_price, deposit_amount, external_paid FROM proposals/.test(sql)) {
        return answer({ rows: [{ total_price: row.total_price, deposit_amount: '100.00', external_paid: row.external_paid }] });
      }
      if (/AS locked_total/.test(sql)) return answer({ rows: [{ locked_total: '0' }] });
      if (/SELECT COUNT\(\*\)::int AS n FROM shifts/.test(sql)) return answer({ rows: [{ n: 0 }] });
      if (/FROM invoices/.test(sql)) return answer({ rows: [] });
      return Promise.reject(new Error(`unexpected query: ${sql}`));
    },
  };
}

const voidUpdate = (client) => client.calls.findIndex((c) => /^\s*UPDATE proposals SET\s+client_signed_name = NULL/i.test(c.sql));
const voidedRow = (client) => client.calls.find((c) => /INSERT INTO proposal_activity_log/.test(c.sql) && /'signature_voided'/.test(c.sql));
const foldIndex = (client) => client.calls.findIndex((c) => /UPDATE proposals/.test(c.sql) && /total_price = \$1/.test(c.sql));

test('removing the add-on from a signed, unpaid booking voids the signature after the fold and sends the row back to sent', async () => {
  const row = signedRow();
  const client = scriptedClient(row);
  const result = await applyLineItemCancel(client, { proposalId: 77, target: 'addon:test-addon', actorId: 9 });

  assert.equal(result.oldTotal, 1600);
  assert.equal(result.newTotal, 1500, 'the add-on left the total');
  const v = voidUpdate(client);
  assert.ok(v >= 0, 'the signature was cleared');
  assert.ok(v > foldIndex(client), 'after the fold wrote the new total');
  assert.deepEqual(client.calls[v].params.slice(0, 2), [77, true]);
  const audit = voidedRow(client);
  assert.ok(audit, 'a signature_voided activity row was written');
  const details = JSON.parse(audit.params[2]);
  assert.ok(details.reason.includes('line_item_cancelled'), `reason names the cancel: ${JSON.stringify(details.reason)}`);
  assert.ok(details.reason.includes('addons') && details.reason.includes('total'), `reason names the moved terms: ${JSON.stringify(details.reason)}`);
  assert.equal(details.previous.signed_name, 'Test Signer');
  assert.equal(details.previous.signed_total, '1600.00');
  assert.deepEqual(details.previous.signed_snapshot, signedRow().client_signed_snapshot);
  assert.equal(row.client_signed_at, null);
  assert.equal(row.client_signed_total, null);
  assert.equal(row.status, 'sent');
  assert.equal(result.newStatus, 'sent', 'the result reports the status the void set');
  // Round 3 (L9): the dialog's existing status line keys on statusChanged, so the void's move must set it.
  assert.equal(result.statusChanged, true, 'the status move the void made is reported as a status change');
  assert.equal(result.signatureVoided, true);
});

test('a paid row keeps its signature when a line is removed (the additional-services flow)', async () => {
  const row = signedRow({ status: 'deposit_paid', amountPaid: '100.00' });
  const client = scriptedClient(row);
  const result = await applyLineItemCancel(client, { proposalId: 77, target: 'addon:test-addon', actorId: 9 });
  assert.equal(result.newTotal, 1500);
  assert.equal(voidUpdate(client), -1, 'no void UPDATE on a paid row');
  assert.equal(voidedRow(client), undefined);
  assert.equal(row.client_signed_at, SIGNED_AT);
  assert.equal(result.signatureVoided, false);
  assert.ok(!client.calls.some((c) => /FROM stripe_sessions s/.test(c.sql)), 'a paid row needs no in-flight read');
});

test('a bank debit still settling keeps the signature; money collected off-platform keeps it too', async () => {
  let row = signedRow();
  let client = scriptedClient(row, { inFlight: [{ stripe_payment_intent_id: 'pi_test_1', amount_cents: 10000, started_at: new Date(), invoice_id: null, invoice_number: null }] });
  let result = await applyLineItemCancel(client, { proposalId: 77, target: 'addon:test-addon', actorId: 9 });
  assert.equal(result.newTotal, 1500);
  assert.equal(voidUpdate(client), -1, 'no void UPDATE while a payment is in flight');
  assert.equal(voidedRow(client), undefined);
  assert.equal(row.client_signed_at, SIGNED_AT);
  assert.equal(row.client_signed_total, '1600.00');
  assert.equal(row.status, 'accepted');
  assert.equal(result.signatureVoided, false);

  row = signedRow({ externalPaid: '100.00' });
  client = scriptedClient(row);
  result = await applyLineItemCancel(client, { proposalId: 77, target: 'addon:test-addon', actorId: 9 });
  assert.equal(voidUpdate(client), -1, 'no void UPDATE with external money on the row');
  assert.equal(row.client_signed_at, SIGNED_AT);
  assert.equal(result.signatureVoided, false);
});

// Round 3 (L8): a pending card session inside the sign email's window counts
// as money on the row (a confirmation may be landing); one older than the
// window is a stale intent and the void goes ahead.
test('a pending card session inside the window keeps the signature; a stale one does not', async () => {
  let row = signedRow();
  let client = scriptedClient(row, { pending: [{ created_at: new Date(Date.now() - 5 * 60000) }] });
  let result = await applyLineItemCancel(client, { proposalId: 77, target: 'addon:test-addon', actorId: 9 });
  assert.equal(result.newTotal, 1500);
  assert.equal(voidUpdate(client), -1, 'no void UPDATE while a card confirmation may be landing');
  assert.equal(voidedRow(client), undefined);
  assert.equal(row.client_signed_at, SIGNED_AT);
  assert.equal(row.client_signed_total, '1600.00');
  assert.equal(result.signatureVoided, false);

  row = signedRow();
  client = scriptedClient(row, { pending: [{ created_at: new Date(Date.now() - 45 * 60000) }] });
  result = await applyLineItemCancel(client, { proposalId: 77, target: 'addon:test-addon', actorId: 9 });
  assert.ok(voidUpdate(client) >= 0, 'a stale pending session does not keep the signature');
  assert.equal(row.client_signed_at, null);
  assert.equal(result.signatureVoided, true);
});

require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// lineItemCancel voids a signed, money-free booking's signature when a line
// comes off (audit ESIG-02, round 2 M1), read back from the shared dev DB
// after the real cancel core ran inside a committed transaction. Harness of
// lineItemCancel.test.js (a nonce'd flat package and catalog add-on, a
// proposal seeded with a REAL engine snapshot, every row purged in after());
// lineItemCancel.signature.test.js is the no-database sibling over a scripted
// client. Run ALONE against the shared dev DB:
//   node -r dotenv/config --test server/utils/lineItemCancel.signature.db.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool } = require('../db');
const { calculateProposal } = require('./pricingEngine');
const { applyLineItemCancel } = require('./lineItemCancel');

if (process.env.NODE_ENV === 'production') {
  throw new Error('lineItemCancel.signature.db.test.js refuses to run against production');
}

const NONCE = `lisig-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let clientId;
let pkg;
let addonCat;
const seededProposals = [];

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555551212') RETURNING id",
    [`LISig ${NONCE}`, `lisig-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  const pkgIns = await pool.query(
    `INSERT INTO service_packages (slug, name, category, pricing_type, base_rate_4hr, extra_hour_rate,
        guests_per_bartender, bartenders_included, bar_type, includes)
     VALUES ($1, 'LISig Test Pkg', 'byob', 'flat', 1500, 100, 100, 1, 'service_only', '[]')
     RETURNING id`,
    [`lisig-${NONCE}`]
  );
  pkg = (await pool.query('SELECT * FROM service_packages WHERE id = $1', [pkgIns.rows[0].id])).rows[0];
  const a = await pool.query(
    `INSERT INTO service_addons (slug, name, billing_type, rate, applies_to, is_active, minimum_hours)
     VALUES ($1, 'LISig Add-on', 'flat', 100, 'all', true, NULL) RETURNING id`,
    [`lisig-addon-${NONCE}`]
  );
  addonCat = (await pool.query('SELECT * FROM service_addons WHERE id = $1', [a.rows[0].id])).rows[0];
});

after(async () => {
  for (const pid of seededProposals) {
    await pool.query('DELETE FROM shifts WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = $1)', [pid]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM proposal_addons WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [pid]);
  }
  if (addonCat) await pool.query('DELETE FROM service_addons WHERE id = $1', [addonCat.id]);
  if (pkg) await pool.query('DELETE FROM service_packages WHERE id = $1', [pkg.id]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

// A signed booking at 1500 + 100: the signature and its record as the sign writes them.
async function seedSigned({ status = 'accepted', amountPaid = 0, externalPaid = 0 } = {}) {
  const snapshot = calculateProposal({
    pkg, guestCount: 50, durationHours: 4, numBars: 0, numBartenders: null,
    addons: [{ ...addonCat, quantity: 1 }], syrupSelections: [], adjustments: [], totalPriceOverride: null,
    gratuityRate: 0, tipJar: true, gratuityFloorRate: null,
  });
  assert.equal(snapshot.total, 1600, 'fixture: 1500 + 100');
  const signedRecord = { record_version: 1, document_version: 'event-services-agreement-v4', rows: [], gratuity_amount: 0, total: 1600, snapshot: null };
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, event_date, event_start_time, event_duration_hours, event_timezone,
        status, event_type, guest_count, num_bars, num_bartenders, adjustments,
        total_price, amount_paid, external_paid, gratuity_rate, tip_jar, pricing_snapshot,
        client_signed_name, client_signature_data, client_signed_at, client_signature_method,
        client_signature_document_version, client_signed_total, client_signed_snapshot, accepted_at)
     VALUES ($1, $2, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago',
             $3, 'birthday-party', 50, 0, $4, '[]'::jsonb,
             $5, $6, $7, 0, true, $8::jsonb,
             'Test Signer', 'data:image/png;base64,iVBORw0KGgo=', NOW(), 'draw',
             'event-services-agreement-v4', $5, $9::jsonb, NOW())
     RETURNING id`,
    [clientId, pkg.id, status, snapshot.inputs.numBartenders, snapshot.total, amountPaid, externalPaid,
      JSON.stringify(snapshot), JSON.stringify(signedRecord)]
  );
  const proposalId = p.rows[0].id;
  seededProposals.push(proposalId);
  for (const sa of snapshot.addons) {
    await pool.query(
      `INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total, variant)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [proposalId, sa.id, sa.name, sa.billing_type, sa.rate, sa.quantity, sa.line_total, sa.variant ?? null]
    );
  }
  return proposalId;
}

async function cancelAddon(proposalId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await applyLineItemCancel(client, { proposalId, target: `addon:${addonCat.slug}`, actorId: null });
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const row = async (id) => (await pool.query(
  'SELECT status, total_price, client_signed_at, client_signed_total, client_signed_snapshot, accepted_at FROM proposals WHERE id = $1', [id])).rows[0];
const voidedRows = async (id) => (await pool.query(
  "SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'signature_voided'", [id])).rows;

test('removing the add-on from a signed unpaid booking clears the signature, sends the row back to sent and keeps the prior record', async () => {
  const id = await seedSigned();
  const result = await cancelAddon(id);
  assert.equal(result.newTotal, 1500);
  assert.equal(result.signatureVoided, true);
  const r = await row(id);
  assert.equal(Number(r.total_price), 1500);
  assert.equal(r.client_signed_at, null);
  assert.equal(r.client_signed_total, null);
  assert.equal(r.client_signed_snapshot, null);
  assert.equal(r.accepted_at, null, 'the acceptance stamp the sign set goes with it');
  assert.equal(r.status, 'sent');
  const voided = await voidedRows(id);
  assert.equal(voided.length, 1);
  assert.ok(voided[0].details.reason.includes('line_item_cancelled'));
  assert.equal(voided[0].details.previous.signed_name, 'Test Signer');
  assert.equal(Number(voided[0].details.previous.signed_total), 1600);
});

test('a paid row, and a row with a bank debit still settling, keep their signature', async () => {
  const paid = await seedSigned({ status: 'deposit_paid', amountPaid: 100 });
  let result = await cancelAddon(paid);
  assert.equal(result.signatureVoided, false);
  assert.ok((await row(paid)).client_signed_at);
  assert.equal((await voidedRows(paid)).length, 0);

  const settling = await seedSigned();
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at)
     VALUES ($1, $2, 10000, 'processing', NOW())`,
    [settling, `pi_test_${NONCE}`]
  );
  result = await cancelAddon(settling);
  assert.equal(result.signatureVoided, false);
  const r = await row(settling);
  assert.ok(r.client_signed_at, 'the signature stands while the debit settles');
  assert.equal(Number(r.client_signed_total), 1600);
  assert.equal(r.status, 'accepted');
  assert.equal((await voidedRows(settling)).length, 0);
});

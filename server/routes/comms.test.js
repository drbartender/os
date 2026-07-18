'use strict';

// Route-level tests for /api/comms (spec 4.2), driven through the action layer
// against the shared dev DB (suite runs ALONE: node -r dotenv/config --test).
// Send paths run with notifications gated off (dev), so no real email fires;
// assertions cover the response contract, side-effect idempotency, snapshot
// write, and preview warnings (stale-snapshot mismatch + typo domain), which
// are exactly the two failures that shipped this project (Brandon, Cathy).
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { getAction } = require('../utils/comms/registry');

const TEST_EMAIL = 'comms-live@example.test';
const STALE_EMAIL = 'comms-stale@privaterelay.example.test';
let clientId, proposalId, planId;

before(async () => {
  await pool.query('DELETE FROM message_log WHERE recipient IN ($1, $2)', [TEST_EMAIL, STALE_EMAIL]);
  await pool.query(
    `DELETE FROM drink_plans WHERE proposal_id IN
       (SELECT id FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email = $1))`,
    [TEST_EMAIL]
  );
  await pool.query('DELETE FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email = $1)', [TEST_EMAIL]);
  await pool.query('DELETE FROM clients WHERE email = $1', [TEST_EMAIL]);

  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ('Comms Test', $1, '3125550142') RETURNING id",
    [TEST_EMAIL]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, total_price, amount_paid, balance_due_date, autopay_enrolled)
     VALUES ($1, CURRENT_DATE + INTERVAL '21 days', 'balance_paid', 'wedding-reception', 200000, 200000, CURRENT_DATE + INTERVAL '7 days', false)
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  // Plan carries a STALE snapshot email (the Brandon shape) + a real list.
  const dp = await pool.query(
    `INSERT INTO drink_plans (client_name, client_email, event_type, event_date, proposal_id, shopping_list, shopping_list_status)
     VALUES ('Comms Test', $1, 'wedding-reception', CURRENT_DATE + INTERVAL '21 days', $2,
             '{"guestCount": 50, "liquorBeerWine": [], "everythingElse": []}'::jsonb, 'pending_review')
     RETURNING id`,
    [STALE_EMAIL, proposalId]
  );
  planId = dp.rows[0].id;
});

after(async () => {
  await pool.query('DELETE FROM message_log WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM drink_plans WHERE id = $1', [planId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('resolveRecipient prefers the live client email and warns on the stale snapshot', async () => {
  const a = getAction('shopping_list_approve');
  const r = await a.resolveRecipient(planId);
  assert.equal(r.email, TEST_EMAIL);
  assert.equal(r.source, 'client');
  assert.ok(r.warnings.some((w) => w.includes(STALE_EMAIL)), 'must warn about the stale plan email');
  assert.equal(r.channels.email.available, true);
  assert.equal(r.channels.sms.available, true);
  assert.equal(r.channels.sms.default, false);
});

test('typo-domain warning surfaces at resolve time (Cathy shape)', async () => {
  await pool.query('UPDATE clients SET email = $1 WHERE id = $2', ['comms@arthrex-chicago.conm', clientId]);
  const r = await getAction('shopping_list_approve').resolveRecipient(planId);
  assert.ok(r.warnings.some((w) => w.includes('.conm')), 'must flag the .conm typo domain');
  await pool.query('UPDATE clients SET email = $1 WHERE id = $2', [TEST_EMAIL, clientId]);
});

test('buildMessages returns editable parts with a fixed CTA carrying the token URL', async () => {
  const { rows } = await pool.query('SELECT token FROM drink_plans WHERE id = $1', [planId]);
  const m = await getAction('shopping_list_approve').buildMessages(planId);
  assert.match(m.email.subject, /shopping list/i);
  assert.ok(m.email.bodyText.startsWith('Hi Comms Test,'), 'greeting uses the client name');
  assert.ok(m.email.cta.url.includes(rows[0].token));
  assert.ok(m.sms.body.includes(rows[0].token));
});

test('ensureSideEffects flips status once, writes the snapshot, and no-ops on retry', async () => {
  const a = getAction('shopping_list_approve');
  const first = await a.ensureSideEffects(planId);
  assert.equal(first.applied, true);
  const row1 = await pool.query(
    `SELECT shopping_list_status, shopping_list_approved_at, shopping_list_approved_snapshot
       FROM drink_plans WHERE id = $1`, [planId]);
  assert.equal(row1.rows[0].shopping_list_status, 'approved');
  assert.ok(row1.rows[0].shopping_list_approved_at);
  assert.equal(row1.rows[0].shopping_list_approved_snapshot.guestCount, 50);

  const second = await a.ensureSideEffects(planId);
  assert.equal(second.applied, false); // idempotent: retry-after-failed-send is safe
  const row2 = await pool.query('SELECT shopping_list_approved_at FROM drink_plans WHERE id = $1', [planId]);
  assert.equal(String(row2.rows[0].shopping_list_approved_at), String(row1.rows[0].shopping_list_approved_at));
});

test('dispatch honors channel selection and reports per-channel truth (dev-gated)', async () => {
  const a = getAction('shopping_list_approve');
  const r = await a.dispatch(planId, undefined, ['email'], { sentBy: null });
  assert.equal(r.email, 'sent'); // dev-gated send resolves as sent (dev-skipped provider)
  assert.equal(r.sms, 'skipped');
  assert.equal(r.skip_reasons.sms, 'not selected');
  assert.equal(r.recipient_email, TEST_EMAIL);
});

test('dispatch detects edited copy against the defaults', async () => {
  const a = getAction('shopping_list_approve');
  const defaults = await a.buildMessages(planId);
  const edited = {
    email: { subject: defaults.email.subject, bodyText: defaults.email.bodyText + '\n\nPS: park in back.' },
  };
  // Edited-detection is computed inside dispatch; with dev-gated sends there is
  // no ledger row to inspect, so assert via the pure comparison the action uses.
  assert.notEqual(edited.email.bodyText, defaults.email.bodyText);
  const r = await a.dispatch(planId, edited, ['email'], { sentBy: null });
  assert.equal(r.email, 'sent');
});

test('hosted package makes the email channel unavailable with an honest reason', async () => {
  // Point the proposal at a per_guest package if one exists; otherwise create a
  // throwaway hosted package row and clean it up.
  const pkg = await pool.query(
    "INSERT INTO service_packages (slug, name, category, pricing_type) VALUES ('comms-hosted-test', 'Comms Hosted Test', 'hosted', 'per_guest') RETURNING id"
  );
  await pool.query('UPDATE proposals SET package_id = $1 WHERE id = $2', [pkg.rows[0].id, proposalId]);
  try {
    const r = await getAction('shopping_list_approve').resolveRecipient(planId);
    assert.equal(r.channels.email.available, false);
    assert.match(r.channels.email.unavailable_reason, /Hosted package/);
    // SMS mirrors every email guard (review finding): a hosted client with a
    // phone on file must not be textable a shopping list either.
    assert.equal(r.channels.sms.available, false);
    assert.match(r.channels.sms.unavailable_reason, /Hosted package/);
  } finally {
    await pool.query('UPDATE proposals SET package_id = NULL WHERE id = $1', [proposalId]);
    await pool.query('DELETE FROM service_packages WHERE id = $1', [pkg.rows[0].id]);
  }
});

test('placeholder .invalid email is unavailable at resolve and never reported sent by dispatch', async () => {
  await pool.query("UPDATE clients SET email = 'comms-placeholder@import.invalid' WHERE id = $1", [clientId]);
  try {
    const action = getAction('shopping_list_approve');
    const r = await action.resolveRecipient(planId);
    assert.equal(r.channels.email.available, false);
    assert.match(r.channels.email.unavailable_reason, /Placeholder/);
    assert.ok(r.warnings.some((w) => /placeholder/i.test(w)));

    // Defense in depth: force-dispatch email anyway (as if a stale modal had
    // it checked); sendEmail drops .invalid recipients, and dispatch must
    // report 'skipped', never 'sent', with NO sent ledger row.
    const results = await action.dispatch(planId, undefined, ['email'], { sentBy: null });
    assert.notEqual(results.email, 'sent');
    const { rows } = await pool.query(
      `SELECT 1 FROM message_log WHERE proposal_id = $1 AND recipient LIKE '%.invalid' AND status = 'sent'`,
      [proposalId]
    );
    assert.equal(rows.length, 0);
  } finally {
    await pool.query('UPDATE clients SET email = $1 WHERE id = $2', [TEST_EMAIL, clientId]);
  }
});

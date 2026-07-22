'use strict';

// Gate-level tests for the refund notice opt-in (notify-client contract,
// 2026-07-22). Route-level coverage of the two refund endpoints requires
// live-mode Stripe stubbing; per the plan, the acceptable floor is unit
// coverage of sendRefundClientNotification's gates (which both routes share)
// plus the route wiring being a boolean gate around this one call, verified
// by review. Runs ALONE against the shared dev DB, FROM THE os CHECKOUT ROOT
// (dotenv resolves .env from CWD; a lane worktree has none):
//   node -r dotenv/config --test server/routes/proposals/notifyRefunds.test.js
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../../db');

const refundNotify = require('../../utils/refundClientNotify');
const { sendRefundClientNotification } = refundNotify;

let clientOkId, clientBadId, clientNoneId, clientPlaceholderId;
let pOk, pArchived, pPlaceholder, pNoEmail, pSuppressed;

async function seed(clientId, status) {
  const r = await pool.query(
    `INSERT INTO proposals (client_id, status${status === 'archived' ? ', archive_reason' : ''}, event_date, total_price, amount_paid)
     VALUES ($1, $2${status === 'archived' ? ", 'client_cancelled'" : ''}, '2026-12-01', 500, 100) RETURNING id`,
    [clientId, status]
  );
  return r.rows[0].id;
}

before(async () => {
  const nonce = Date.now();
  const mk = async (name, email) => (await pool.query(
    `INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`, [name, email]
  )).rows[0].id;
  clientOkId = await mk(`refund-ok-${nonce}`, `refund-ok-${nonce}@example.test`);
  clientBadId = await mk(`refund-bad-${nonce}`, `refund-bad-${nonce}@example.test`);
  await pool.query(`UPDATE clients SET communication_preferences = '{"email_enabled": false}'::jsonb WHERE id = $1`, [clientBadId]);
  clientNoneId = await mk(`refund-none-${nonce}`, null);
  clientPlaceholderId = await mk(`refund-ph-${nonce}`, `refund-ph-${nonce}@ccimport.invalid`);

  pOk = await seed(clientOkId, 'deposit_paid');
  pArchived = await seed(clientOkId, 'archived');
  pPlaceholder = await seed(clientPlaceholderId, 'deposit_paid');
  pNoEmail = await seed(clientNoneId, 'deposit_paid');
  pSuppressed = await seed(clientBadId, 'deposit_paid');
});

after(async () => {
  await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [[pOk, pArchived, pPlaceholder, pNoEmail, pSuppressed]]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [[clientOkId, clientBadId, clientNoneId, clientPlaceholderId]]);
  await pool.end();
});

test('sends and reports sent for a normal client (seam-stubbed)', async () => {
  const calls = [];
  refundNotify.__setDeps({ sendEmail: async (a) => { calls.push(a); return { id: 'stub' }; } });
  const r = await sendRefundClientNotification({ proposalId: pOk, amountCents: 12345, source: 'test' });
  assert.equal(r.email, 'sent');
  assert.equal(calls.length, 1);
  assert.match(calls[0].to, /refund-ok-/);
});

test('ARCHIVED proposal still sends: the archived gate is deliberately bypassed for refunds', async () => {
  const calls = [];
  refundNotify.__setDeps({ sendEmail: async (a) => { calls.push(a); return { id: 'stub' }; } });
  const r = await sendRefundClientNotification({ proposalId: pArchived, amountCents: 5000, source: 'test' });
  assert.equal(r.email, 'sent', 'cancel-refund runs on a just-archived proposal by design');
  assert.equal(calls.length, 1);
});

test('prefs-suppressed client: skipped with reason, nothing sent', async () => {
  const calls = [];
  refundNotify.__setDeps({ sendEmail: async (a) => { calls.push(a); return { id: 'stub' }; } });
  const r = await sendRefundClientNotification({ proposalId: pSuppressed, amountCents: 5000, source: 'test' });
  assert.equal(r.email, 'skipped');
  assert.match(r.skip_reasons.email, /suppressed/i);
  assert.equal(calls.length, 0);
});

test('.invalid placeholder: skipped, nothing sent', async () => {
  const calls = [];
  refundNotify.__setDeps({ sendEmail: async (a) => { calls.push(a); return { id: 'stub' }; } });
  const r = await sendRefundClientNotification({ proposalId: pPlaceholder, amountCents: 5000, source: 'test' });
  assert.equal(r.email, 'skipped');
  assert.match(r.skip_reasons.email, /placeholder/i);
  assert.equal(calls.length, 0);
});

test('no email on file: skipped; provider throw: failed with error, never thrown', async () => {
  refundNotify.__setDeps({ sendEmail: async () => { throw new Error('resend down'); } });
  const none = await sendRefundClientNotification({ proposalId: pNoEmail, amountCents: 5000, source: 'test' });
  assert.equal(none.email, 'skipped');
  const fail = await sendRefundClientNotification({ proposalId: pOk, amountCents: 5000, source: 'test' });
  assert.equal(fail.email, 'failed');
  assert.match(fail.email_error, /resend down/);
});

'use strict';

// Action-layer tests for the comms-remaining-sends lane (spec 4.4), driven
// against the shared dev DB (suite runs ALONE: node -r dotenv/config --test).
// Send paths run with notifications gated off (dev), so no real email/SMS fires
// and dev-skipped provider results are NOT ledgered — assertions cover the
// recipient/warning/parts/side-effect contract, not ledger rows.
//
// The load-bearing case per action: the recipient must be the LIVE client
// record, never a stale drink_plans snapshot (the Brandon Martin failure). Each
// plan is seeded with a snapshot email that DIFFERS from the client row so the
// live-wins assertion is real.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../../../db');
const { getAction } = require('../../comms/registry');

const LIVE_EMAIL = 'remaining-live@example.test';
const STALE_EMAIL = 'remaining-stale@example.test';
let clientId, proposalId, planId, invoiceId, paidInvoiceId, planToken, invoiceToken;

before(async () => {
  // Idempotent teardown of any prior run's scratch rows.
  await pool.query('DELETE FROM message_log WHERE recipient IN ($1, $2)', [LIVE_EMAIL, STALE_EMAIL]);
  await pool.query(
    `DELETE FROM invoices WHERE proposal_id IN
       (SELECT id FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email = $1))`,
    [LIVE_EMAIL]
  );
  await pool.query(
    `DELETE FROM drink_plans WHERE proposal_id IN
       (SELECT id FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email = $1))`,
    [LIVE_EMAIL]
  );
  await pool.query('DELETE FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email = $1)', [LIVE_EMAIL]);
  await pool.query('DELETE FROM clients WHERE email = $1', [LIVE_EMAIL]);

  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ('Remaining Test', $1, '3125550143') RETURNING id",
    [LIVE_EMAIL]
  );
  clientId = c.rows[0].id;

  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, total_price, amount_paid, balance_due_date, autopay_enrolled)
     VALUES ($1, CURRENT_DATE + INTERVAL '21 days', 'balance_paid', 'wedding-reception', 200000, 0, CURRENT_DATE + INTERVAL '7 days', false)
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;

  // Plan carries a STALE snapshot email (Brandon shape) + consult selections and
  // a NULL consult_filled_at so the flip idempotency test starts clean.
  const dp = await pool.query(
    `INSERT INTO drink_plans
        (client_name, client_email, event_type, event_date, proposal_id,
         consult_selections, consult_filled_at)
     VALUES ('Remaining Test', $1, 'wedding-reception', CURRENT_DATE + INTERVAL '21 days', $2,
             '{"barType":"full_bar","spirits":["vodka","gin"],"signatureDrinks":["Margarita"]}'::jsonb, NULL)
     RETURNING id, token`,
    [STALE_EMAIL, proposalId]
  );
  planId = dp.rows[0].id;
  planToken = dp.rows[0].token;

  // Draft invoice ($450.00 = 45000 cents) for the invoice_send action.
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, 'TEST-REM-1', 'Balance', 45000, 0, 'draft')
     RETURNING id, token`,
    [proposalId]
  );
  invoiceId = inv.rows[0].id;
  invoiceToken = inv.rows[0].token;

  // A paid invoice that must NEVER re-flip.
  const paid = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, 'TEST-REM-2', 'Deposit', 10000, 10000, 'paid')
     RETURNING id`,
    [proposalId]
  );
  paidInvoiceId = paid.rows[0].id;
});

after(async () => {
  await pool.query('DELETE FROM message_log WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM invoices WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM drink_plans WHERE id = $1', [planId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

// ─── drink_plan_nudge ──────────────────────────────────────────────

test('nudge: resolveRecipient prefers the live client email and warns on the stale snapshot', async () => {
  const r = await getAction('drink_plan_nudge').resolveRecipient(planId);
  assert.equal(r.email, LIVE_EMAIL);
  assert.equal(r.source, 'client');
  assert.ok(r.warnings.some((w) => w.includes(STALE_EMAIL)), 'must warn about the stale plan email');
  assert.equal(r.channels.email.available, true);
  assert.equal(r.channels.sms.available, true, 'a parseable, non-opted-out phone is an available SMS channel');
  assert.equal(r.channels.sms.default, true, 'nudge defaults SMS on when available');
});

test('nudge: SMS opt-out makes the SMS channel unavailable with an honest reason', async () => {
  await pool.query(
    "UPDATE clients SET communication_preferences = '{\"sms_enabled\": false}'::jsonb WHERE id = $1",
    [clientId]
  );
  try {
    const r = await getAction('drink_plan_nudge').resolveRecipient(planId);
    assert.equal(r.channels.sms.available, false);
    assert.match(r.channels.sms.unavailable_reason, /opted out/i);
    assert.equal(r.channels.email.available, true, 'email is never comm-pref-gated for the manual resend');
  } finally {
    // clients.communication_preferences is NOT NULL — restore the schema default.
    await pool.query(
      `UPDATE clients SET communication_preferences = '{"sms_enabled":true,"email_enabled":true,"marketing_enabled":true}'::jsonb WHERE id = $1`,
      [clientId]
    );
  }
});

test('nudge: a .invalid client email makes the email channel unavailable (placeholder reason, 937ba35 mirror)', async () => {
  // CC-import RFC-2606 placeholder: sendEmail silently drops it, so the channel
  // must never be offered/reported available. Mutate the shared client, restore
  // in finally (after() purges by LIVE_EMAIL, so restoring is mandatory).
  await pool.query("UPDATE clients SET email = 'ccimport-remaining@drbartender.invalid' WHERE id = $1", [clientId]);
  try {
    const r = await getAction('drink_plan_nudge').resolveRecipient(planId);
    assert.equal(r.channels.email.available, false, 'placeholder email is never available');
    assert.equal(r.channels.email.default, false);
    assert.match(r.channels.email.unavailable_reason, /placeholder address \(\.invalid\)/i);
    assert.ok(r.warnings.some((w) => /\.invalid/.test(w) && /placeholder/i.test(w)), 'placeholder warning surfaced');
  } finally {
    await pool.query('UPDATE clients SET email = $1 WHERE id = $2', [LIVE_EMAIL, clientId]);
  }
});

test('nudge: a missing drink-plan token makes SMS unavailable (937ba35 mirror, synthetic row)', async () => {
  // drink_plans.token is UUID NOT NULL DEFAULT gen_random_uuid(), so a nulled
  // token cannot be persisted via UPDATE. The SMS body carries the planner link
  // (row.plan_token), so the guard is exercised on a synthetic row through the
  // exported pure resolveFromRow (recipient otherwise fully sendable: real email,
  // good opted-in phone) — the ONLY reason SMS is blocked is the missing token.
  const { resolveFromRow } = getAction('drink_plan_nudge');
  const r = resolveFromRow({
    client_name: 'Remaining Test',
    live_email: LIVE_EMAIL,
    live_phone: '3125550143',
    email_status: null,
    phone_status: null,
    communication_preferences: {},
    plan_token: null,
  });
  assert.equal(r.channels.sms.available, false, 'no token -> the SMS planner link would go nowhere');
  assert.equal(r.channels.sms.unavailable_reason, 'Drink plan has no share token.');
  assert.equal(r.channels.email.available, true, 'the nudge email does not require the plan token');
});

test('nudge: buildMessages carries the drink-plan token in the CTA and the SMS body', async () => {
  const m = await getAction('drink_plan_nudge').buildMessages(planId);
  assert.match(m.email.subject, /lock in drinks/i);
  assert.ok(m.email.cta.url.includes(planToken), 'email CTA points at /plan/<plan token>');
  assert.ok(m.email.bodyText.startsWith('Hi Remaining,'), 'greeting uses the client first name');
  assert.ok(m.sms.body.includes(planToken), 'SMS body carries the plan token');
});

test('nudge: ensureSideEffects is a no-op on a live event and blocks an archived one', async () => {
  const first = await getAction('drink_plan_nudge').ensureSideEffects(planId);
  assert.equal(first.applied, false, 'manual resend has no bookkeeping side effect');

  await pool.query("UPDATE proposals SET status = 'archived' WHERE id = $1", [proposalId]);
  try {
    await assert.rejects(
      () => getAction('drink_plan_nudge').ensureSideEffects(planId),
      /archived/i,
      'an archived event must hard-block the resend'
    );
  } finally {
    await pool.query("UPDATE proposals SET status = 'balance_paid' WHERE id = $1", [proposalId]);
  }
});

test('nudge: dispatch reports per-channel truth (dev-gated sends resolve as sent)', async () => {
  const r = await getAction('drink_plan_nudge').dispatch(planId, undefined, ['email', 'sms'], { sentBy: null });
  assert.equal(r.email, 'sent');
  assert.equal(r.sms, 'sent');
  assert.equal(r.recipient_email, LIVE_EMAIL);
});

// ─── consult_recap ─────────────────────────────────────────────────

test('consultRecap: resolveRecipient live-resolves the recipient (fixes the stale dp.client_email bug) and is email only', async () => {
  const r = await getAction('consult_recap').resolveRecipient(planId);
  assert.equal(r.email, LIVE_EMAIL, 'recipient must be the live client email, not the plan snapshot');
  assert.equal(r.source, 'client');
  assert.ok(r.warnings.some((w) => w.includes(STALE_EMAIL)), 'must warn about the stale plan email');
  assert.equal(r.channels.email.available, true);
  assert.equal(r.channels.sms.available, false);
  assert.match(r.channels.sms.unavailable_reason, /email only/i);
});

test('consultRecap: buildMessages has no CTA and a recap line, with BYOB vs hosted next-step', async () => {
  const byob = await getAction('consult_recap').buildMessages(planId);
  assert.match(byob.email.subject, /recap/i);
  assert.equal(byob.email.cta, null, 'the recap email has no CTA button');
  assert.ok(byob.email.bodyText.includes('Full bar'), 'consult selections render into the body');
  assert.ok(byob.email.bodyText.includes("We'll send your shopping list shortly."), 'BYOB next-step line');

  // Point the proposal at a per_guest (hosted) package: the next-step line flips.
  const pkg = await pool.query(
    "INSERT INTO service_packages (slug, name, category, pricing_type) VALUES ('remaining-hosted-test', 'Remaining Hosted Test', 'hosted', 'per_guest') RETURNING id"
  );
  await pool.query('UPDATE proposals SET package_id = $1 WHERE id = $2', [pkg.rows[0].id, proposalId]);
  try {
    const hosted = await getAction('consult_recap').buildMessages(planId);
    assert.ok(hosted.email.bodyText.includes('Your bartender will prep based on this.'), 'hosted next-step line');
  } finally {
    await pool.query('UPDATE proposals SET package_id = NULL WHERE id = $1', [proposalId]);
    await pool.query('DELETE FROM service_packages WHERE id = $1', [pkg.rows[0].id]);
  }
});

test('consultRecap: ensureSideEffects flips consult_filled_at once and no-ops on retry', async () => {
  await pool.query('UPDATE drink_plans SET consult_filled_at = NULL WHERE id = $1', [planId]);

  const first = await getAction('consult_recap').ensureSideEffects(planId);
  assert.equal(first.applied, true);
  const row1 = await pool.query('SELECT consult_filled_at FROM drink_plans WHERE id = $1', [planId]);
  assert.ok(row1.rows[0].consult_filled_at, 'consult_filled_at is now set');

  const second = await getAction('consult_recap').ensureSideEffects(planId);
  assert.equal(second.applied, false, 'retry is a clean no-op');
  const row2 = await pool.query('SELECT consult_filled_at FROM drink_plans WHERE id = $1', [planId]);
  assert.equal(
    String(row2.rows[0].consult_filled_at),
    String(row1.rows[0].consult_filled_at),
    'timestamp never moves on retry'
  );
});

test('consultRecap: dispatch sends on email and reports the live recipient (dev-gated)', async () => {
  const r = await getAction('consult_recap').dispatch(planId, undefined, ['email'], { sentBy: null });
  assert.equal(r.email, 'sent');
  assert.equal(r.recipient_email, LIVE_EMAIL);
  assert.equal(r.recipient_phone, null);
});

// ─── invoice_send ──────────────────────────────────────────────────

test('invoiceSend: resolveRecipient uses the live client email; SMS unavailable (email only)', async () => {
  const r = await getAction('invoice_send').resolveRecipient(invoiceId);
  assert.equal(r.email, LIVE_EMAIL);
  assert.equal(r.channels.email.available, true);
  assert.equal(r.channels.sms.available, false);
  assert.match(r.channels.sms.unavailable_reason, /email only/i);
});

test('invoiceSend: buildMessages preformats the amount from cents and links the public invoice token', async () => {
  const m = await getAction('invoice_send').buildMessages(invoiceId);
  assert.match(m.email.subject, /invoice/i);
  assert.ok(m.email.bodyText.includes('$450.00'), 'amount is cents/100 -> $450.00, preformatted');
  assert.ok(m.email.cta.url.includes(invoiceToken), 'CTA points at /invoice/<token>');
  assert.ok(m.email.cta.url.includes('/invoice/'), 'public invoice URL pattern');
});

test('invoiceSend: partially-paid renders the REMAINING balance; paid is not sendable', async () => {
  await pool.query('UPDATE invoices SET amount_paid = 20000 WHERE id = $1', [invoiceId]);
  try {
    const m = await getAction('invoice_send').buildMessages(invoiceId);
    assert.ok(m.email.bodyText.includes('$250.00'), 'amount is amount_due - amount_paid, never the gross total');
    assert.ok(!m.email.bodyText.includes('$450.00'), 'gross total must not appear');
  } finally {
    await pool.query('UPDATE invoices SET amount_paid = 0 WHERE id = $1', [invoiceId]);
  }

  const r = await getAction('invoice_send').resolveRecipient(paidInvoiceId);
  assert.equal(r.channels.email.available, false, 'paid invoice is not sendable');
  assert.match(r.channels.email.unavailable_reason, /already paid/i);
});

test('invoiceSend: ensureSideEffects flips draft->sent once, no-ops on retry, and never touches amounts', async () => {
  await pool.query("UPDATE invoices SET status = 'draft' WHERE id = $1", [invoiceId]);
  const before = await pool.query('SELECT amount_due, amount_paid FROM invoices WHERE id = $1', [invoiceId]);

  const first = await getAction('invoice_send').ensureSideEffects(invoiceId);
  assert.equal(first.applied, true);
  const afterFlip = await pool.query('SELECT status, amount_due, amount_paid FROM invoices WHERE id = $1', [invoiceId]);
  assert.equal(afterFlip.rows[0].status, 'sent');
  assert.equal(afterFlip.rows[0].amount_due, before.rows[0].amount_due, 'amount_due byte-identical');
  assert.equal(afterFlip.rows[0].amount_paid, before.rows[0].amount_paid, 'amount_paid byte-identical');

  const second = await getAction('invoice_send').ensureSideEffects(invoiceId);
  assert.equal(second.applied, false, 'a sent invoice never re-flips');
  const afterRetry = await pool.query('SELECT status, amount_due, amount_paid FROM invoices WHERE id = $1', [invoiceId]);
  assert.equal(afterRetry.rows[0].status, 'sent');
  assert.equal(afterRetry.rows[0].amount_due, before.rows[0].amount_due);
  assert.equal(afterRetry.rows[0].amount_paid, before.rows[0].amount_paid);
});

test('invoiceSend: a paid invoice is never re-flipped and its amounts are untouched', async () => {
  const before = await pool.query('SELECT status, amount_due, amount_paid FROM invoices WHERE id = $1', [paidInvoiceId]);
  const res = await getAction('invoice_send').ensureSideEffects(paidInvoiceId);
  assert.equal(res.applied, false);
  const afterRow = await pool.query('SELECT status, amount_due, amount_paid FROM invoices WHERE id = $1', [paidInvoiceId]);
  assert.equal(afterRow.rows[0].status, 'paid', 'paid stays paid');
  assert.equal(afterRow.rows[0].amount_due, before.rows[0].amount_due);
  assert.equal(afterRow.rows[0].amount_paid, before.rows[0].amount_paid);
});

test('invoiceSend: dispatch sends on email and reports the live recipient (dev-gated)', async () => {
  const r = await getAction('invoice_send').dispatch(invoiceId, undefined, ['email'], { sentBy: null });
  assert.equal(r.email, 'sent');
  assert.equal(r.recipient_email, LIVE_EMAIL);
  assert.equal(r.recipient_phone, null);
});

// ─── dispatch contract flag (05d3ebd concurrent-confirm guard) ───────────────

test('dispatchWithoutSideEffects: all three remaining-send actions declare it (05d3ebd contract)', () => {
  // Resend-type / pre-applied actions: SENDING IS the operation (nudge, recap) or
  // a legitimate re-send of an already-'sent' invoice; all must dispatch on every
  // confirm, so all declare the flag => exempt from the /send route's
  // concurrent-confirm guard once this lane merges onto the guarded comms.js.
  for (const k of ['drink_plan_nudge', 'consult_recap', 'invoice_send']) {
    assert.equal(getAction(k).dispatchWithoutSideEffects, true, `${k} must declare dispatchWithoutSideEffects`);
  }
});

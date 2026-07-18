'use strict';

// Action-level tests for the five proposal-side comms actions (plan P1), driven
// directly through the registry against the shared dev DB. Runs ALONE:
//   node -r dotenv/config --test server/utils/comms/actions/proposalActions.test.js
// Send paths run with notifications gated off (dev), so no real email/SMS fires;
// per action we assert (a) live-recipient resolution + channel availability,
// (b) buildMessages parts carry the right token/link in the CTA, (c) side-effect
// idempotency, (d) dispatch reports honest per-channel truth. Money is asserted
// untouched by the payment reminder. Modeled on server/routes/comms.test.js.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../../../db');
const { getAction } = require('../registry');

const LIVE_EMAIL = 'comms-psends-live@example.test';
const STALE_EMAIL = 'comms-psends-stale@privaterelay.example.test';
const PHONE = '3125550143';

let clientId, proposalId, proposalToken, planId, planToken, groupId, groupToken, groupProposalId;

async function purgeByClientEmail(email) {
  await pool.query(
    `DELETE FROM message_log WHERE proposal_id IN
       (SELECT id FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email = $1))`, [email]);
  await pool.query(
    `DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id IN
       (SELECT id FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email = $1))`, [email]);
  await pool.query(
    `DELETE FROM proposal_activity_log WHERE proposal_id IN
       (SELECT id FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email = $1))`, [email]);
  await pool.query(
    `DELETE FROM drink_plans WHERE proposal_id IN
       (SELECT id FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email = $1))`, [email]);
  await pool.query(
    `DELETE FROM invoices WHERE proposal_id IN
       (SELECT id FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email = $1))`, [email]);
  await pool.query(
    `DELETE FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email = $1)`, [email]);
  await pool.query(
    `DELETE FROM proposal_groups WHERE client_id IN (SELECT id FROM clients WHERE email = $1)`, [email]);
  await pool.query('DELETE FROM clients WHERE email = $1', [email]);
}

before(async () => {
  // computeScheduledFor reads handler metadata that the app registers at boot;
  // register the drink-plan-nudge handlers so the reenroll scheduling resolves
  // (idempotent registration, harmless if already present).
  try {
    require('../../drinkPlanNudge').registerDrinkPlanNudgeHandlers();
  } catch (_) { /* already registered */ }

  await purgeByClientEmail(LIVE_EMAIL);

  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ('PSends Test', $1, $2) RETURNING id",
    [LIVE_EMAIL, PHONE]
  );
  clientId = c.rows[0].id;

  // Standalone 'sent' proposal (resendable) with a live outstanding balance
  // ($500 = total 2000 - paid 1500; proposals money is DOLLARS).
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, total_price, amount_paid, balance_due_date, event_timezone)
     VALUES ($1, CURRENT_DATE + INTERVAL '21 days', 'sent', 'wedding-reception', 2000, 1500, CURRENT_DATE + INTERVAL '7 days', 'America/Chicago')
     RETURNING id, token`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  proposalToken = p.rows[0].token;

  // Drink plan carrying a STALE snapshot email (the reenroll mismatch shape) and
  // durable suppression on (so the first reenroll flips it -> applied:true).
  const dp = await pool.query(
    `INSERT INTO drink_plans (client_name, client_email, event_type, event_date, proposal_id, nudge_suppressed, selections)
     VALUES ('PSends Test', $1, 'wedding-reception', CURRENT_DATE + INTERVAL '21 days', $2, true, '{}'::jsonb)
     RETURNING id, token`,
    [STALE_EMAIL, proposalId]
  );
  planId = dp.rows[0].id;
  planToken = dp.rows[0].token;

  // A comparison group with one draft option (send-group flips it to 'sent').
  const g = await pool.query(
    'INSERT INTO proposal_groups (client_id) VALUES ($1) RETURNING id, token',
    [clientId]
  );
  groupId = g.rows[0].id;
  groupToken = g.rows[0].token;
  const gp = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, group_id, total_price, event_timezone)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'draft', 'corporate', $2, 1000, 'America/Chicago')
     RETURNING id`,
    [clientId, groupId]
  );
  groupProposalId = gp.rows[0].id;
});

after(async () => {
  await purgeByClientEmail(LIVE_EMAIL);
  await pool.end();
});

// ─── proposal_resend ─────────────────────────────────────────────────
test('proposal_resend: resolveRecipient returns the live client + both channels', async () => {
  const r = await getAction('proposal_resend').resolveRecipient(proposalId);
  assert.equal(r.email, LIVE_EMAIL);
  assert.equal(r.source, 'client');
  assert.equal(r.channels.email.available, true);
  assert.equal(r.channels.sms.available, true);
  assert.equal(r.channels.sms.default, true);
});

test('proposal_resend: buildMessages CTA + SMS carry the proposal token', async () => {
  const m = await getAction('proposal_resend').buildMessages(proposalId);
  assert.match(m.email.subject, /Proposal/i);
  assert.ok(m.email.cta.url.includes(proposalToken), 'email CTA links the proposal token');
  assert.ok(m.sms.body.includes(proposalToken), 'SMS body links the proposal token');
});

test('proposal_resend: ensureSideEffects is a no-op and enforces the resendable guard', async () => {
  const a = getAction('proposal_resend');
  const first = await a.ensureSideEffects(proposalId);
  assert.equal(first.applied, false); // resend never mutates status/timestamps
  const second = await a.ensureSideEffects(proposalId);
  assert.equal(second.applied, false); // identical no-op

  await pool.query("UPDATE proposals SET status = 'completed' WHERE id = $1", [proposalId]);
  await assert.rejects(() => a.ensureSideEffects(proposalId), /can't be resent/);
  await pool.query("UPDATE proposals SET status = 'sent' WHERE id = $1", [proposalId]);
});

test('proposal_resend: dispatch reports per-channel truth (dev-gated)', async () => {
  const r = await getAction('proposal_resend').dispatch(proposalId, undefined, ['email', 'sms'], { sentBy: null });
  assert.equal(r.email, 'sent');
  assert.equal(r.sms, 'sent');
  assert.equal(r.recipient_email, LIVE_EMAIL);
});

test('proposal_resend: a .invalid client email makes email unavailable (placeholder reason, 937ba35 mirror)', async () => {
  // CC-import RFC-2606 placeholder: sendEmail silently drops it, so the channel
  // must never be offered/reported available. Mutate the shared client, restore
  // in finally (after() purges by LIVE_EMAIL, so restoring is mandatory).
  await pool.query("UPDATE clients SET email = 'ccimport-psends@drbartender.invalid' WHERE id = $1", [clientId]);
  try {
    const r = await getAction('proposal_resend').resolveRecipient(proposalId);
    assert.equal(r.channels.email.available, false, 'placeholder email is never available');
    assert.equal(r.channels.email.default, false);
    assert.match(r.channels.email.unavailable_reason, /placeholder address \(\.invalid\)/i);
    assert.ok(r.warnings.some((w) => /\.invalid/.test(w) && /placeholder/i.test(w)), 'placeholder warning surfaced');
  } finally {
    await pool.query('UPDATE clients SET email = $1 WHERE id = $2', [LIVE_EMAIL, clientId]);
  }
});

test('proposal_resend: a missing share token makes SMS (and email) unavailable (937ba35 mirror)', async () => {
  // proposals.token is UNIQUE NOT NULL DEFAULT gen_random_uuid(), so a nulled
  // token cannot be persisted via UPDATE. The SMS body carries the token link,
  // so the guard is exercised on a synthetic row through the exported pure
  // resolveFromRow (recipient is otherwise fully sendable: real email, good
  // opted-in phone) — the ONLY reason both channels are blocked is the token.
  const { resolveFromRow } = getAction('proposal_resend');
  const r = resolveFromRow({
    client_name: 'PSends Test',
    live_email: LIVE_EMAIL,
    live_phone: PHONE,
    email_status: null,
    phone_status: null,
    comm_prefs: {},
    token: null,
  });
  assert.equal(r.channels.sms.available, false, 'no token -> SMS link would go nowhere');
  assert.equal(r.channels.sms.unavailable_reason, 'Proposal has no share token.');
  assert.equal(r.channels.email.available, false, 'resend email also requires the token');
  assert.equal(r.channels.email.unavailable_reason, 'Proposal has no share token.');
});

// ─── portal_invite ───────────────────────────────────────────────────
test('portal_invite: SMS is available but off by default', async () => {
  const r = await getAction('portal_invite').resolveRecipient(proposalId);
  assert.equal(r.email, LIVE_EMAIL);
  assert.equal(r.channels.email.available, true);
  assert.equal(r.channels.email.default, true);
  assert.equal(r.channels.sms.available, true);
  assert.equal(r.channels.sms.default, false);
});

test('portal_invite: buildMessages CTA links the portal', async () => {
  const m = await getAction('portal_invite').buildMessages(proposalId);
  assert.ok(m.email.cta.url.includes('/my-proposals'), 'CTA points at the client portal');
});

test('portal_invite: ensureSideEffects mints nothing (no-op, idempotent)', async () => {
  const a = getAction('portal_invite');
  assert.equal((await a.ensureSideEffects(proposalId)).applied, false);
  assert.equal((await a.ensureSideEffects(proposalId)).applied, false);
});

test('portal_invite: dispatch sends email, SMS not selected', async () => {
  const r = await getAction('portal_invite').dispatch(proposalId, undefined, ['email'], { sentBy: null });
  assert.equal(r.email, 'sent');
  assert.equal(r.sms, 'skipped');
  assert.equal(r.skip_reasons.sms, 'not selected');
});

// ─── payment_reminder ────────────────────────────────────────────────
test('payment_reminder: resolveRecipient + balance display', async () => {
  const r = await getAction('payment_reminder').resolveRecipient(proposalId);
  assert.equal(r.email, LIVE_EMAIL);
  assert.equal(r.channels.email.available, true);
  assert.equal(r.channels.sms.available, true);
});

test('payment_reminder: buildMessages renders the exact balance ($500.00) + CTA token', async () => {
  const m = await getAction('payment_reminder').buildMessages(proposalId);
  assert.ok(m.email.bodyText.includes('$500.00'), 'balance rendered verbatim (2000 - 1500)');
  assert.ok(m.email.cta.url.includes(proposalToken));
  assert.ok(m.sms.body.includes('$500.00') && m.sms.body.includes(proposalToken));
});

test('payment_reminder: ensureSideEffects writes no money and enforces NO_BALANCE_DUE', async () => {
  const a = getAction('payment_reminder');
  const before = await pool.query('SELECT total_price, amount_paid FROM proposals WHERE id = $1', [proposalId]);
  const first = await a.ensureSideEffects(proposalId);
  assert.equal(first.applied, false);
  const second = await a.ensureSideEffects(proposalId);
  assert.equal(second.applied, false);
  const afterRow = await pool.query('SELECT total_price, amount_paid FROM proposals WHERE id = $1', [proposalId]);
  assert.deepEqual(afterRow.rows[0], before.rows[0]); // MONEY: reminder never touches amounts

  // Settle the balance -> the guard rejects, then restore.
  await pool.query('UPDATE proposals SET amount_paid = total_price WHERE id = $1', [proposalId]);
  await assert.rejects(() => a.ensureSideEffects(proposalId), /no outstanding balance/i);
  await pool.query('UPDATE proposals SET amount_paid = 1500 WHERE id = $1', [proposalId]);
});

test('payment_reminder: dispatch reports per-channel truth', async () => {
  const r = await getAction('payment_reminder').dispatch(proposalId, undefined, ['email', 'sms'], { sentBy: null });
  assert.equal(r.email, 'sent');
  assert.equal(r.sms, 'sent');
});

// ─── proposal_send_group (email only) ────────────────────────────────
test('proposal_send_group: email only, SMS unavailable with an honest reason', async () => {
  const r = await getAction('proposal_send_group').resolveRecipient(groupProposalId);
  assert.equal(r.email, LIVE_EMAIL);
  assert.equal(r.channels.email.available, true);
  assert.equal(r.channels.sms.available, false);
  assert.match(r.channels.sms.unavailable_reason, /no text message/i);
});

test('proposal_send_group: buildMessages CTA links the compare token', async () => {
  const m = await getAction('proposal_send_group').buildMessages(groupProposalId);
  assert.ok(m.email.cta.url.includes(`/compare/${groupToken}`), 'CTA links the group compare token');
  assert.equal(m.sms.body, null);
});

test('proposal_send_group: ensureSideEffects flips draft->sent once, then no-ops', async () => {
  const a = getAction('proposal_send_group');
  const first = await a.ensureSideEffects(groupProposalId, { sentBy: null });
  assert.equal(first.applied, true);
  assert.equal(first.sentCount, 1);
  assert.equal(first.groupToken, groupToken);
  const status = await pool.query('SELECT status FROM proposals WHERE id = $1', [groupProposalId]);
  assert.equal(status.rows[0].status, 'sent');

  const second = await a.ensureSideEffects(groupProposalId, { sentBy: null });
  assert.equal(second.applied, false); // no newly-draft members -> compare email deduped
  assert.equal(second.sentCount, 0);
});

test('proposal_send_group: dispatch sends the compare email, never SMS', async () => {
  const r = await getAction('proposal_send_group').dispatch(groupProposalId, undefined, ['email'], { sentBy: null });
  assert.equal(r.email, 'sent');
  assert.equal(r.sms, 'skipped');
  assert.match(r.skip_reasons.sms, /no text message/i);
});

// ─── drink_plan_nudge_reenroll ───────────────────────────────────────
test('drink_plan_nudge_reenroll: live client + stale-snapshot mismatch warning', async () => {
  const r = await getAction('drink_plan_nudge_reenroll').resolveRecipient(proposalId);
  assert.equal(r.email, LIVE_EMAIL);
  assert.equal(r.source, 'client');
  assert.ok(r.warnings.some((w) => w.includes(STALE_EMAIL)), 'warns about the stale plan email');
  assert.equal(r.channels.email.available, true);
  assert.equal(r.channels.sms.available, true);
});

test('drink_plan_nudge_reenroll: buildMessages links the drink-plan token', async () => {
  const m = await getAction('drink_plan_nudge_reenroll').buildMessages(proposalId);
  assert.ok(m.email.cta.url.includes(`/plan/${planToken}`), 'CTA links the drink-plan token (not the proposal token)');
  assert.ok(m.sms.body.includes(planToken));
});

test('drink_plan_nudge_reenroll: ensureSideEffects clears suppression once, then no-ops', async () => {
  const a = getAction('drink_plan_nudge_reenroll');
  const first = await a.ensureSideEffects(proposalId);
  assert.equal(first.applied, true); // nudge_suppressed true -> false
  const flag = await pool.query('SELECT nudge_suppressed FROM drink_plans WHERE id = $1', [planId]);
  assert.equal(flag.rows[0].nudge_suppressed, false);
  const scheduled = await pool.query(
    "SELECT count(*)::int AS n FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1 AND message_type LIKE 'drink_plan_nudge%'",
    [proposalId]
  );
  assert.ok(scheduled.rows[0].n >= 1, 'nudges scheduled');

  const second = await a.ensureSideEffects(proposalId);
  assert.equal(second.applied, false); // already cleared -> idempotent no-op
});

test('drink_plan_nudge_reenroll: dispatch sends the immediate nudge on both channels', async () => {
  const r = await getAction('drink_plan_nudge_reenroll').dispatch(proposalId, undefined, ['email', 'sms'], { sentBy: null });
  assert.equal(r.email, 'sent');
  assert.equal(r.sms, 'sent');
});

// ─── proposal_send (P2: compose-first initial send) ─────────────────────────

test('proposal_send: registry discovery + delegation to proposal_resend', async () => {
  const send = getAction('proposal_send');
  const resend = getAction('proposal_resend');
  assert.ok(send);
  assert.equal(send.messageType, 'proposal_sent');
  // Recipient/messages/dispatch are shared with resend by design (same email,
  // same SMS, same suppression); only ensureSideEffects differs.
  assert.equal(send.dispatch, resend.dispatch);
  assert.equal(send.buildMessages, resend.buildMessages);
  assert.notEqual(send.ensureSideEffects, resend.ensureSideEffects);
});

test('proposal_send: draft->sent flips once with invoice + activity log, then no-ops', async () => {
  const d = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, total_price, amount_paid, balance_due_date, autopay_enrolled, guest_count, payment_type)
     VALUES ($1, CURRENT_DATE + INTERVAL '45 days', 'draft', 'birthday-party', 800, 0, CURRENT_DATE + INTERVAL '31 days', false, 40, 'deposit')
     RETURNING id`,
    [clientId]
  );
  const draftId = d.rows[0].id;
  const a = getAction('proposal_send');

  const first = await a.ensureSideEffects(draftId, { sentBy: null });
  assert.equal(first.applied, true);
  const row = await pool.query('SELECT status, sent_at FROM proposals WHERE id = $1', [draftId]);
  assert.equal(row.rows[0].status, 'sent');
  assert.ok(row.rows[0].sent_at, 'sent_at stamped');
  const inv = await pool.query('SELECT count(*)::int AS n FROM invoices WHERE proposal_id = $1', [draftId]);
  assert.equal(inv.rows[0].n, 1, 'invoice created inside the transaction');
  const log = await pool.query(
    `SELECT count(*)::int AS n FROM proposal_activity_log
      WHERE proposal_id = $1 AND action = 'status_changed' AND details->>'via' = 'comms_send'`,
    [draftId]
  );
  assert.equal(log.rows[0].n, 1);

  const second = await a.ensureSideEffects(draftId, { sentBy: null });
  assert.equal(second.applied, false); // already sent: idempotent no-op
  const inv2 = await pool.query('SELECT count(*)::int AS n FROM invoices WHERE proposal_id = $1', [draftId]);
  assert.equal(inv2.rows[0].n, 1, 'no duplicate invoice on retry');

  // dispatch is the shared (resend) path; smoke it dev-gated on this proposal
  const r = await a.dispatch(draftId, undefined, ['email'], { sentBy: null });
  assert.equal(r.email, 'sent');
});

test('proposal_send: grouped draft is refused (USE_GROUP_SEND parity)', async () => {
  const g = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, total_price, amount_paid, balance_due_date, autopay_enrolled, guest_count, payment_type, group_id)
     VALUES ($1, CURRENT_DATE + INTERVAL '45 days', 'draft', 'birthday-party', 900, 0, CURRENT_DATE + INTERVAL '31 days', false, 40, 'deposit', $2)
     RETURNING id`,
    [clientId, groupId]
  );
  await assert.rejects(
    () => getAction('proposal_send').ensureSideEffects(g.rows[0].id, { sentBy: null }),
    (err) => err.code === 'USE_GROUP_SEND' || /sent together/.test(err.message)
  );
  const row = await pool.query('SELECT status FROM proposals WHERE id = $1', [g.rows[0].id]);
  assert.equal(row.rows[0].status, 'draft', 'refusal leaves the draft untouched');
});

// ─── dispatch contract flag (05d3ebd concurrent-confirm guard) ───────────────
test('dispatchWithoutSideEffects: resend-type actions declare it, side-effectful ones do not', () => {
  // Resend-type: validate-only ensureSideEffects (sending IS the operation), or a
  // side effect decoupled from the send (drink-plan re-enroll). All must dispatch
  // on every confirm, so all declare the flag => exempt from the /send route's
  // concurrent-confirm guard once this lane merges onto the guarded comms.js.
  for (const k of ['proposal_resend', 'portal_invite', 'payment_reminder', 'drink_plan_nudge_reenroll']) {
    assert.equal(getAction(k).dispatchWithoutSideEffects, true, `${k} must declare dispatchWithoutSideEffects`);
  }
  // Side-effectful: proposal_send (draft->sent + invoice) and proposal_send_group
  // (group flip) keep the strict applied||retry guard — must NOT declare the flag.
  for (const k of ['proposal_send', 'proposal_send_group']) {
    assert.notEqual(getAction(k).dispatchWithoutSideEffects, true, `${k} must keep the strict concurrent-confirm guard`);
  }
});

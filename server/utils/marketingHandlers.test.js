require('dotenv').config();
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  registerMarketingHandlers,
  scheduleDripForProposal,
  scheduleReviewRequest,
  scheduleNewYearHello,
  scheduleSixMonthsOut,
  scheduleRetentionNudge,
  cancelMarketingForProposal,
  onProposalSignedAndPaid,
} = require('./marketingHandlers');
const { DRIP_TOUCHES } = require('./dripSiblings');

let clientId;
let proposalId;

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email) VALUES ('Handler Test', 'handler-test@example.com') RETURNING id"
  );
  clientId = c.rows[0].id;
});

beforeEach(async () => {
  // Schema note: proposals.token is UUID NOT NULL DEFAULT gen_random_uuid();
  // omitting it lets the default fire. This test reads `proposalId` only, not
  // the token — so omitting `RETURNING token` is fine.
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type)
     VALUES ($1, CURRENT_DATE + INTERVAL '365 days', 'sent', 'birthday-party')
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
});

afterEach(async () => {
  await pool.query('DELETE FROM scheduled_messages WHERE entity_type = $1 AND entity_id = $2', ['proposal', proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
});

after(async () => {
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('loadHandlerContext > suppresses (not fails) when the client has no email', async () => {
  // Regression for DRBARTENDER-SERVER-X: a client with no email is an expected
  // skip, not a dispatch failure — the loader throws SuppressMessageError so the
  // dispatcher records the row 'suppressed' without alerting Sentry.
  const { loadHandlerContext } = require('./marketingHandlers');
  const { SuppressMessageError } = require('./errors');
  await pool.query('UPDATE clients SET email = NULL WHERE id = $1', [clientId]);
  try {
    await assert.rejects(
      () => loadHandlerContext({ entity_id: proposalId }),
      (err) => err instanceof SuppressMessageError && err.reason === 'client_no_email'
    );
  } finally {
    await pool.query("UPDATE clients SET email = 'handler-test@example.com' WHERE id = $1", [clientId]);
  }
});

// ── handler metadata (single source of truth) ──
// The dispatcher's marketing gate reads `getHandlerMeta(messageType).category`,
// not a separately exported list. After registration, every marketing-class
// type must report category 'marketing', and review_request must report
// 'operational' (CAN-SPAM transactional post-sale follow-up).
test('handler metadata > marketing types register with category=marketing', () => {
  registerMarketingHandlers();
  const { getHandlerMeta } = require('./scheduledMessageDispatcher');
  for (const t of [
    'drip_touch_2',
    'drip_touch_4',
    'drip_touch_5_email',
    'new_year_hello',
    'six_months_out',
    'retention_nudge',
  ]) {
    const meta = getHandlerMeta(t);
    assert.ok(meta, `expected handler meta for ${t}`);
    assert.strictEqual(meta.category, 'marketing', `expected ${t} category=marketing`);
  }
  const reviewMeta = getHandlerMeta('review_request');
  assert.ok(reviewMeta);
  assert.strictEqual(reviewMeta.category, 'operational');
});

// ── scheduleDripForProposal ──
test('scheduleDripForProposal > inserts the 6 drip rows (3 email, 3 sms) on the proposal', async () => {
  await scheduleDripForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT message_type, channel, status FROM scheduled_messages
     WHERE entity_type = 'proposal' AND entity_id = $1
     ORDER BY message_type`,
    [proposalId]
  );
  const types = rows.map(r => r.message_type);
  assert.deepStrictEqual(types, [
    'drip_touch_1', 'drip_touch_2', 'drip_touch_3',
    'drip_touch_4', 'drip_touch_5_email', 'drip_touch_5_sms',
  ]);
  const byType = Object.fromEntries(rows.map(r => [r.message_type, r.channel]));
  assert.strictEqual(byType['drip_touch_1'], 'sms');
  assert.strictEqual(byType['drip_touch_2'], 'email');
  assert.strictEqual(byType['drip_touch_3'], 'sms');
  assert.strictEqual(byType['drip_touch_4'], 'email');
  assert.strictEqual(byType['drip_touch_5_email'], 'email');
  assert.strictEqual(byType['drip_touch_5_sms'], 'sms');
  assert.ok(rows.every(r => r.status === 'pending'));
});

test('scheduleDripForProposal > is idempotent — second call does not duplicate rows', async () => {
  await scheduleDripForProposal(proposalId);
  await scheduleDripForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT count(*) FROM scheduled_messages
     WHERE entity_type = 'proposal' AND entity_id = $1`,
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 6);
});

test('scheduleDripForProposal > uses the proposal status moment as the +7/+14/+21 anchor', async () => {
  const now = Date.now();
  await scheduleDripForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT message_type, scheduled_for FROM scheduled_messages
     WHERE entity_type = 'proposal' AND entity_id = $1
     ORDER BY message_type`,
    [proposalId]
  );
  const t2 = new Date(rows.find(r => r.message_type === 'drip_touch_2').scheduled_for).getTime();
  const t4 = new Date(rows.find(r => r.message_type === 'drip_touch_4').scheduled_for).getTime();
  const t5 = new Date(rows.find(r => r.message_type === 'drip_touch_5_email').scheduled_for).getTime();
  // Each anchor should be 7/14/21 days from the proposal status-moved-to-sent time.
  // We don't know the exact baseline so we just check the relative spacing.
  assert.ok(t4 - t2 >= 6 * 86400000);
  assert.ok(t4 - t2 <= 8 * 86400000);
  assert.ok(t5 - t4 >= 6 * 86400000);
  assert.ok(t5 - t4 <= 8 * 86400000);
  assert.ok(t2 > now);
});

test('scheduleDripForProposal > does not enroll an already-advanced proposal', async () => {
  // Drip is the unsigned-proposal nurture sequence. A proposal past sent/
  // viewed/modified (here: accepted) must not get drip rows — the old guard
  // checked a non-existent 'signed' status and let this through.
  await pool.query("UPDATE proposals SET status = 'accepted' WHERE id = $1", [proposalId]);
  await scheduleDripForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT count(*) FROM scheduled_messages
     WHERE entity_type = 'proposal' AND entity_id = $1`,
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 0);
});


// One drip per client per EVENT. Jan Carabelli (2026-09-19): a second solo
// option for the same October 17 event enrolled its own six-touch drip, so she
// got "Did you get the proposal?" twice, the second one hours after she had
// replied. A sibling proposal (same client, same event_date, not archived)
// with a live drip row means this proposal joins that conversation instead of
// starting another. Spec 7.10 "new drip per proposal" is about a second EVENT
// and still holds (different event_date test below).
async function insertSibling({ eventDateSql, status = 'sent' }) {
  const r = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type)
     SELECT client_id, ${eventDateSql}, $2, event_type FROM proposals WHERE id = $1
     RETURNING id`,
    [proposalId, status]
  );
  return r.rows[0].id;
}
async function dripCount(id) {
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1 AND message_type LIKE 'drip_touch_%'",
    [id]
  );
  return Number(rows[0].count);
}
async function removeSibling(id) {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1", [id]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [id]);
}

test('scheduleDripForProposal > a second open proposal for the same client + event date joins the existing drip (no second enrollment)', async () => {
  await scheduleDripForProposal(proposalId);
  // Mirror Jan: the first option's touch 1 already went out, the rest is pending.
  await pool.query(
    `UPDATE scheduled_messages SET status = 'sent', sent_at = NOW()
     WHERE entity_type = 'proposal' AND entity_id = $1 AND message_type = 'drip_touch_1'`,
    [proposalId]
  );
  const secondId = await insertSibling({ eventDateSql: 'event_date' });
  try {
    await scheduleDripForProposal(secondId);
    assert.strictEqual(await dripCount(secondId), 0, 'second option must not start its own drip');
    assert.strictEqual(await dripCount(proposalId), 6, 'first option keeps its drip untouched');
  } finally {
    await removeSibling(secondId);
  }
});

test('scheduleDripForProposal > a second proposal for a DIFFERENT event date still gets its own drip (spec 7.10 repeat customer)', async () => {
  await scheduleDripForProposal(proposalId);
  const secondId = await insertSibling({ eventDateSql: "event_date + INTERVAL '30 days'" });
  try {
    await scheduleDripForProposal(secondId);
    assert.strictEqual(await dripCount(secondId), 6);
    assert.strictEqual(await dripCount(proposalId), 6);
  } finally {
    await removeSibling(secondId);
  }
});

test('scheduleDripForProposal > an archived sibling for the same event does not block enrollment', async () => {
  await scheduleDripForProposal(proposalId);
  await cancelMarketingForProposal(proposalId);
  await pool.query("UPDATE proposals SET status = 'archived' WHERE id = $1", [proposalId]);
  const secondId = await insertSibling({ eventDateSql: 'event_date' });
  try {
    await scheduleDripForProposal(secondId);
    assert.strictEqual(await dripCount(secondId), 6, 'the replacement option is the live conversation now');
  } finally {
    await removeSibling(secondId);
  }
});

test('scheduleDripForProposal > a sibling whose drip already finished does not block a new option (in-flight only)', async () => {
  // Review finding: counting 'sent' rows as live would make a delivered drip
  // block forever. A revised quote months later is a fresh conversation.
  await scheduleDripForProposal(proposalId);
  await pool.query(
    `UPDATE scheduled_messages SET status = 'sent', sent_at = NOW()
     WHERE entity_type = 'proposal' AND entity_id = $1 AND message_type LIKE 'drip_touch_%'`,
    [proposalId]
  );
  const secondId = await insertSibling({ eventDateSql: 'event_date' });
  try {
    await scheduleDripForProposal(secondId);
    assert.strictEqual(await dripCount(secondId), 6);
  } finally {
    await removeSibling(secondId);
  }
});

// ── cancelMarketingForProposal: drip hand-off on archive ──
const DAY = 86400000;
function offsetOf(type) { return DRIP_TOUCHES.find(t => t.messageType === type).offsetDays * DAY; }
async function markSent(id, type) {
  await pool.query(
    `UPDATE scheduled_messages SET status = 'sent', sent_at = NOW()
     WHERE entity_type = 'proposal' AND entity_id = $1 AND message_type = $2`,
    [id, type]
  );
}
async function survivorRows(id) {
  const { rows } = await pool.query(
    `SELECT message_type, status, scheduled_for, payload FROM scheduled_messages
     WHERE entity_type = 'proposal' AND entity_id = $1 ORDER BY message_type`,
    [id]
  );
  return rows;
}
const REMAINING_AFTER_TOUCH_1 = ['drip_touch_2', 'drip_touch_3', 'drip_touch_4', 'drip_touch_5_email', 'drip_touch_5_sms'];

test('cancelMarketingForProposal > archiving the drip owner re-creates the undelivered touches on the surviving option (PATCH door: rows still present)', async () => {
  // Jan one step further: hosted A owns the drip, BYOB B was sent solo and
  // joined it. Dallas archives A because BYOB is the real quote. B must
  // inherit the REMAINING touches on A's timeline (no repeat of touch 1),
  // not be left with nothing.
  await scheduleDripForProposal(proposalId);
  await markSent(proposalId, 'drip_touch_1');
  const before = await survivorRows(proposalId);
  const secondId = await insertSibling({ eventDateSql: 'event_date' });
  try {
    await scheduleDripForProposal(secondId);
    assert.strictEqual(await dripCount(secondId), 0, 'B joined A\'s drip');

    await pool.query("UPDATE proposals SET status = 'archived' WHERE id = $1", [proposalId]);
    await cancelMarketingForProposal(proposalId);

    const after = await survivorRows(secondId);
    assert.deepStrictEqual(after.map(r => r.message_type), REMAINING_AFTER_TOUCH_1, 'B owns exactly the five touches A had not sent yet');
    assert.ok(after.every(r => r.status === 'pending'));
    for (const r of after) {
      const orig = before.find(b => b.message_type === r.message_type);
      assert.strictEqual(new Date(r.scheduled_for).getTime(), new Date(orig.scheduled_for).getTime(), `${r.message_type} keeps A's timeline`);
      assert.strictEqual(r.payload.handed_off_from, proposalId);
    }
    const aRows = await pool.query(
      `SELECT message_type, status, error_message FROM scheduled_messages
       WHERE entity_type = 'proposal' AND entity_id = $1 ORDER BY message_type`,
      [proposalId]
    );
    assert.strictEqual(aRows.rows.find(r => r.message_type === 'drip_touch_1').status, 'sent', 'delivered history stays on A');
    const rest = aRows.rows.filter(r => r.message_type !== 'drip_touch_1');
    assert.strictEqual(rest.length, 5);
    assert.ok(rest.every(r => r.status === 'suppressed' && /handed off to proposal \d+/.test(r.error_message)));
  } finally {
    await removeSibling(secondId);
  }
});

test('cancelMarketingForProposal > hand-off still works when the archive door already DELETED the pending rows (admin archive endpoint, cancel, stale sweep)', async () => {
  await scheduleDripForProposal(proposalId);
  await markSent(proposalId, 'drip_touch_1');
  const touch1 = (await survivorRows(proposalId)).find(r => r.message_type === 'drip_touch_1');
  const anchorMs = new Date(touch1.scheduled_for).getTime() - offsetOf('drip_touch_1');
  const secondId = await insertSibling({ eventDateSql: 'event_date' });
  try {
    await scheduleDripForProposal(secondId);
    assert.strictEqual(await dripCount(secondId), 0);
    // Mirror actions.js / cancel.js / staleProposalSweep.js: the transaction
    // archives AND deletes pending comms, then the reap runs post-commit.
    await pool.query("UPDATE proposals SET status = 'archived' WHERE id = $1", [proposalId]);
    await pool.query(
      "DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1 AND status = 'pending'",
      [proposalId]
    );
    await cancelMarketingForProposal(proposalId);

    const after = await survivorRows(secondId);
    assert.deepStrictEqual(after.map(r => r.message_type), REMAINING_AFTER_TOUCH_1);
    for (const r of after) {
      assert.strictEqual(new Date(r.scheduled_for).getTime(), anchorMs + offsetOf(r.message_type), `${r.message_type} rebuilt on A's anchor`);
      assert.strictEqual(r.payload.handed_off_from, proposalId);
    }
  } finally {
    await removeSibling(secondId);
  }
});

test('cancelMarketingForProposal > a sibling that already ran its own sequence never inherits (no second nurture)', async () => {
  // B's six touches all delivered weeks ago; a revised option A enrolled fresh
  // (in-flight-only rule) and is now archived. B must not get touches 2-5 again.
  const olderId = await insertSibling({ eventDateSql: 'event_date' });
  try {
    await scheduleDripForProposal(olderId);
    await pool.query(
      `UPDATE scheduled_messages SET status = 'sent', sent_at = NOW()
       WHERE entity_type = 'proposal' AND entity_id = $1 AND message_type LIKE 'drip_touch_%'`,
      [olderId]
    );
    await scheduleDripForProposal(proposalId);
    assert.strictEqual(await dripCount(proposalId), 6, 'A enrolled fresh: B has nothing in flight');
    await pool.query("UPDATE proposals SET status = 'archived' WHERE id = $1", [proposalId]);
    await cancelMarketingForProposal(proposalId);
    assert.strictEqual(await dripCount(olderId), 6, 'B still has only its own six delivered rows');
    const { rows } = await pool.query(
      "SELECT status FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1", [proposalId]
    );
    assert.ok(rows.every(r => r.status === 'suppressed'));
  } finally {
    await removeSibling(olderId);
  }
});

test('scheduleDripForProposal > a BOOKED sibling with a stranded deferred drip row does not block a new option', async () => {
  const bookedId = await insertSibling({ eventDateSql: 'event_date', status: 'deposit_paid' });
  try {
    await pool.query(
      `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, status)
       VALUES ($1, 'proposal', 'drip_touch_2', 'client', $2, 'email', NOW() + INTERVAL '1 day', 'deferred')`,
      [bookedId, clientId]
    );
    await scheduleDripForProposal(proposalId);
    assert.strictEqual(await dripCount(proposalId), 6);
  } finally {
    await removeSibling(bookedId);
  }
});

test('onProposalSignedAndPaid > suppresses a cooldown-deferred drip touch too, not only pending ones', async () => {
  await scheduleDripForProposal(proposalId);
  await pool.query(
    `UPDATE scheduled_messages SET status = 'deferred', scheduled_for = scheduled_for + INTERVAL '24 hours'
     WHERE entity_type = 'proposal' AND entity_id = $1 AND message_type = 'drip_touch_2'`,
    [proposalId]
  );
  await onProposalSignedAndPaid(proposalId);
  const { rows } = await pool.query(
    "SELECT message_type, status FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1 AND message_type LIKE 'drip_touch_%'",
    [proposalId]
  );
  assert.ok(rows.every(r => r.status === 'suppressed'), JSON.stringify(rows));
});

test('cancelMarketingForProposal > an admin-stopped drip never hands off on archive', async () => {
  // Stop follow-ups (drip_stopped_at) on the owner, then archive it: the
  // survivor must NOT get the touches rebuilt. Rows are marked 'suppressed'
  // (survives the delete-door), and the stamp is the durable signal.
  await scheduleDripForProposal(proposalId);
  await markSent(proposalId, 'drip_touch_1');
  const secondId = await insertSibling({ eventDateSql: 'event_date' });
  try {
    await scheduleDripForProposal(secondId);
    await pool.query(
      `UPDATE scheduled_messages SET status = 'suppressed', error_message = 'stopped by admin'
       WHERE entity_type = 'proposal' AND entity_id = $1 AND status = 'pending'`, [proposalId]);
    await pool.query('UPDATE proposals SET drip_stopped_at = NOW() WHERE id = ANY($1::int[])', [[proposalId, secondId]]);
    await pool.query("UPDATE proposals SET status = 'archived' WHERE id = $1", [proposalId]);
    await cancelMarketingForProposal(proposalId);
    assert.strictEqual(await dripCount(secondId), 0, 'stopped drip stays stopped');
  } finally {
    await removeSibling(secondId);
  }
});

test('cancelMarketingForProposal > a stopped survivor never inherits either', async () => {
  // Owner A was never stopped (its drip is live); the sibling B was stamped
  // stopped earlier. Archiving A must not rebuild A's touches on B.
  await scheduleDripForProposal(proposalId);
  const secondId = await insertSibling({ eventDateSql: 'event_date' });
  try {
    await pool.query('UPDATE proposals SET drip_stopped_at = NOW() WHERE id = $1', [secondId]);
    await pool.query("UPDATE proposals SET status = 'archived' WHERE id = $1", [proposalId]);
    await cancelMarketingForProposal(proposalId);
    assert.strictEqual(await dripCount(secondId), 0);
  } finally {
    await removeSibling(secondId);
  }
});

test('scheduleDripForProposal > a stopped proposal never re-enrolls (stop is one-way across every send door)', async () => {
  // Review finding: after "Stop follow-ups" every rows is 'suppressed', which
  // neither hasLiveSiblingDrip nor scheduleMessage's pending-only ON CONFLICT
  // sees, so the next modified->sent PATCH would insert six fresh touches.
  await scheduleDripForProposal(proposalId);
  await pool.query(
    `UPDATE scheduled_messages SET status = 'suppressed', error_message = 'stopped by admin'
     WHERE entity_type = 'proposal' AND entity_id = $1 AND status = 'pending'`, [proposalId]);
  await pool.query('UPDATE proposals SET drip_stopped_at = NOW() WHERE id = $1', [proposalId]);
  await scheduleDripForProposal(proposalId);
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1 AND message_type LIKE 'drip_touch_%'",
    [proposalId]);
  assert.strictEqual(rows.length, 6);
  assert.ok(rows.every(r => r.status === 'suppressed'), 'no fresh pending rows');
});

test('cancelMarketingForProposal > no hand-off to a booked sibling: the drip is simply suppressed', async () => {
  await scheduleDripForProposal(proposalId);
  const secondId = await insertSibling({ eventDateSql: 'event_date', status: 'deposit_paid' });
  try {
    await pool.query("UPDATE proposals SET status = 'archived' WHERE id = $1", [proposalId]);
    await cancelMarketingForProposal(proposalId);
    assert.strictEqual(await dripCount(secondId), 0);
    const { rows } = await pool.query(
      `SELECT status FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1`,
      [proposalId]
    );
    assert.strictEqual(rows.length, 6);
    assert.ok(rows.every(r => r.status === 'suppressed'));
  } finally {
    await removeSibling(secondId);
  }
});
// ── scheduleReviewRequest ──
test('scheduleReviewRequest > inserts a review_request row 2 days after event_date', async () => {
  await scheduleReviewRequest(proposalId);
  const { rows } = await pool.query(
    `SELECT message_type, channel, scheduled_for FROM scheduled_messages
     WHERE entity_type = 'proposal' AND entity_id = $1`,
    [proposalId]
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].message_type, 'review_request');
  assert.strictEqual(rows[0].channel, 'email');
});

test('scheduleReviewRequest > is idempotent', async () => {
  await scheduleReviewRequest(proposalId);
  await scheduleReviewRequest(proposalId);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1",
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 1);
});

// ── scheduleNewYearHello ──
test('scheduleNewYearHello > schedules nothing if event is in same calendar year as sign', async () => {
  // Move the event to this year
  await pool.query(
    "UPDATE proposals SET event_date = CURRENT_DATE + INTERVAL '30 days' WHERE id = $1",
    [proposalId]
  );
  await scheduleNewYearHello(proposalId);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1",
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 0);
});

test('scheduleNewYearHello > schedules a row if event is next year and >= 60 days into new year', async () => {
  const nextYearMar15 = `${new Date().getFullYear() + 1}-03-15`;
  await pool.query("UPDATE proposals SET event_date = $1 WHERE id = $2", [nextYearMar15, proposalId]);
  await scheduleNewYearHello(proposalId);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1",
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 1);
});

// ── scheduleSixMonthsOut ──
test('scheduleSixMonthsOut > schedules nothing if booking lead time <= 6 months', async () => {
  await pool.query(
    "UPDATE proposals SET event_date = CURRENT_DATE + INTERVAL '90 days' WHERE id = $1",
    [proposalId]
  );
  await scheduleSixMonthsOut(proposalId);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1",
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 0);
});

test('scheduleSixMonthsOut > schedules a row if booking lead time > 6 months', async () => {
  await pool.query(
    "UPDATE proposals SET event_date = CURRENT_DATE + INTERVAL '220 days' WHERE id = $1",
    [proposalId]
  );
  await scheduleSixMonthsOut(proposalId);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1",
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 1);
});

// ── scheduleRetentionNudge ──
test('scheduleRetentionNudge > schedules nothing for non-whitelisted event types', async () => {
  await pool.query(
    "UPDATE proposals SET event_type = 'wedding-reception', status = 'completed' WHERE id = $1",
    [proposalId]
  );
  await scheduleRetentionNudge(proposalId);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1",
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 0);
});

test('scheduleRetentionNudge > schedules a row for a whitelisted event type', async () => {
  await pool.query(
    "UPDATE proposals SET event_type = 'birthday-party', status = 'completed' WHERE id = $1",
    [proposalId]
  );
  await scheduleRetentionNudge(proposalId);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1",
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 1);
});

// ── cancelMarketingForProposal ──
test('cancelMarketingForProposal > marks all pending marketing-class messages as suppressed', async () => {
  await scheduleDripForProposal(proposalId);
  await cancelMarketingForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT status FROM scheduled_messages
     WHERE entity_type='proposal' AND entity_id=$1`,
    [proposalId]
  );
  assert.ok(rows.every(r => r.status === 'suppressed'));
});

test('cancelMarketingForProposal > leaves already-sent messages alone', async () => {
  await scheduleDripForProposal(proposalId);
  await pool.query(
    `UPDATE scheduled_messages SET status='sent', sent_at=NOW()
     WHERE entity_type='proposal' AND entity_id=$1 AND message_type='drip_touch_2'`,
    [proposalId]
  );
  await cancelMarketingForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT message_type, status FROM scheduled_messages
     WHERE entity_type='proposal' AND entity_id=$1
     ORDER BY message_type`,
    [proposalId]
  );
  const m = Object.fromEntries(rows.map(r => [r.message_type, r.status]));
  assert.strictEqual(m['drip_touch_2'], 'sent');
  assert.strictEqual(m['drip_touch_4'], 'suppressed');
  assert.strictEqual(m['drip_touch_5_email'], 'suppressed');
});

// ── onProposalSignedAndPaid (Plan 2d sign+pay orchestrator) ──
test('onProposalSignedAndPaid > suppresses the pending drip and schedules long-lead marketing', async () => {
  await scheduleDripForProposal(proposalId);
  await onProposalSignedAndPaid(proposalId);
  const { rows } = await pool.query(
    `SELECT message_type, status FROM scheduled_messages
     WHERE entity_type='proposal' AND entity_id=$1`,
    [proposalId]
  );
  const drip = rows.filter(r => r.message_type.startsWith('drip_'));
  assert.ok(drip.length > 0, 'expected drip rows to exist');
  assert.ok(drip.every(r => r.status === 'suppressed'), 'all pending drip rows should be suppressed');
  // The beforeEach proposal is event_date + 365 days, so six_months_out is eligible.
  const marketing = rows.filter(r => r.message_type === 'new_year_hello' || r.message_type === 'six_months_out');
  assert.ok(marketing.length > 0, 'expected a long-lead marketing row scheduled');
});

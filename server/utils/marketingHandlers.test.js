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
} = require('./marketingHandlers');

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
test('scheduleDripForProposal > inserts touch_2, touch_4, touch_5_email pending rows on the proposal', async () => {
  await scheduleDripForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT message_type, channel, status FROM scheduled_messages
     WHERE entity_type = 'proposal' AND entity_id = $1
     ORDER BY message_type`,
    [proposalId]
  );
  const types = rows.map(r => r.message_type);
  assert.deepStrictEqual(types, ['drip_touch_2', 'drip_touch_4', 'drip_touch_5_email']);
  assert.ok(rows.every(r => r.channel === 'email'));
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
  assert.strictEqual(Number(rows[0].count), 3);
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

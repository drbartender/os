// Deps-injected sweep tests (mirror the __setTelegramDeps pattern): no DB,
// no network. Verifies confirmed-send-only stamping and race-safe flipping.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { sweepPresence, __setPresenceSchedulerDeps } = require('./presenceScheduler');
const { NUDGE_AFTER_MS, FLIP_GRACE_MS } = require('./presence');

const NOW = new Date('2026-07-02T12:00:00Z');
const iso = (msAgo) => new Date(NOW.getTime() - msAgo).toISOString();

function makeDeps(rows, overrides = {}) {
  const calls = { stamped: [], flipped: [], tg: [], sms: [] };
  __setPresenceSchedulerDeps({
    now: () => NOW,
    findSweepRows: async () => rows,
    stampNudged: async (id) => calls.stamped.push(id),
    applyAutoFlip: async (args) => { calls.flipped.push(args); return true; },
    lastActivityMs: () => null,
    sendTelegramMessage: async (chat, text) => { calls.tg.push(text); return { ok: true }; },
    sendSMS: async ({ to, body }) => { calls.sms.push(to); return { sid: 'SM123' }; },
    ...overrides,
  });
  return calls;
}

beforeEach(() => { process.env.TELEGRAM_ALLOWED_USER_ID = '777'; });

const dueDesk = (extra = {}) => ({
  id: 10, user_id: 2, state: 'desk', ended_at: null, nudged_at: null,
  started_at: iso(NUDGE_AFTER_MS + 60000), presence_nudge_channel: 'telegram',
  presence_nudge_phone: null, presence_last_seen_at: null, name: 'Zul', ...extra,
});

test('nudge: confirmed telegram send stamps nudged_at', async () => {
  const calls = makeDeps([dueDesk()]);
  await sweepPresence();
  assert.deepEqual(calls.stamped, [10]);
  assert.equal(calls.tg.length, 1);
  assert.match(calls.tg[0], /Reply "yes" or touch the app/);
});

test('nudge: gated/skipped telegram send does NOT stamp', async () => {
  const calls = makeDeps([dueDesk()], {
    sendTelegramMessage: async () => ({ ok: false, skipped: true }),
  });
  await sweepPresence();
  assert.deepEqual(calls.stamped, []);
});

test('nudge: dev-skipped SMS sid does NOT stamp; real sid does', async () => {
  const row = dueDesk({ presence_nudge_channel: 'sms', presence_nudge_phone: '+15551234567' });
  let calls = makeDeps([row], { sendSMS: async () => ({ sid: 'dev-skipped-x' }) });
  await sweepPresence();
  assert.deepEqual(calls.stamped, []);
  calls = makeDeps([row]);
  await sweepPresence();
  assert.deepEqual(calls.stamped, [10]);
});

test('nudge: sms channel with NULL phone sends nothing and does not stamp', async () => {
  const calls = makeDeps([dueDesk({ presence_nudge_channel: 'sms', presence_nudge_phone: null })]);
  await sweepPresence();
  assert.deepEqual(calls.stamped, []);
  assert.equal(calls.sms.length, 0);
});

test('nudge: throwing sendSMS is caught, no stamp, sweep continues', async () => {
  const calls = makeDeps(
    [dueDesk({ presence_nudge_channel: 'sms', presence_nudge_phone: '+15551234567' }), dueDesk({ id: 11 })],
    { sendSMS: async () => { throw new Error('twilio 500'); } }
  );
  await sweepPresence();
  assert.deepEqual(calls.stamped, [11]); // the telegram row still nudges
});

test('flip: fires after grace with no sign of life, passes observed interval fields', async () => {
  const nudgedAt = iso(FLIP_GRACE_MS + 60000);
  const row = dueDesk({ nudged_at: nudgedAt });
  const calls = makeDeps([row]);
  await sweepPresence();
  assert.equal(calls.flipped.length, 1);
  assert.deepEqual(calls.flipped[0], { intervalId: 10, userId: 2 });
});

test('flip: in-memory activity after the nudge suppresses it', async () => {
  const nudgedAt = iso(FLIP_GRACE_MS + 60000);
  const calls = makeDeps([dueDesk({ nudged_at: nudgedAt })], {
    lastActivityMs: () => NOW.getTime() - FLIP_GRACE_MS, // after the nudge
  });
  await sweepPresence();
  assert.equal(calls.flipped.length, 0);
});

test('flip: DB last_seen after the nudge suppresses it', async () => {
  const nudgedAt = iso(FLIP_GRACE_MS + 60000);
  const calls = makeDeps([dueDesk({ nudged_at: nudgedAt, presence_last_seen_at: iso(FLIP_GRACE_MS) })]);
  await sweepPresence();
  assert.equal(calls.flipped.length, 0);
});

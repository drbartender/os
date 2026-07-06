// Deps-injected sweep tests (mirror the __setTelegramDeps pattern): no DB,
// no network. Verifies confirmed-send-only stamping and race-safe flipping.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { sweepPresence, __setPresenceSchedulerDeps } = require('./presenceScheduler');
const { NUDGE_AFTER_MS, FLIP_GRACE_MS } = require('./presence');

const NOW = new Date('2026-07-02T12:00:00Z');
const iso = (msAgo) => new Date(NOW.getTime() - msAgo).toISOString();

function makeDeps(rows, overrides = {}) {
  const calls = { stamped: [], flipped: [], tg: [], sms: [], notified: [], captures: 0 };
  __setPresenceSchedulerDeps({
    now: () => NOW,
    findSweepRows: async () => rows,
    stampNudged: async (id) => calls.stamped.push(id),
    applyAutoFlip: async (args) => { calls.flipped.push(args); return true; },
    lastActivityMs: () => null,
    sendTelegramMessage: async (chat, text) => { calls.tg.push(text); return { ok: true }; },
    sendSMS: async ({ to, body }) => { calls.sms.push(to); return { sid: 'SM123' }; },
    getStripPayload: async () => { calls.captures += 1; return { users: [], lead_owner_id: null }; },
    notifyDibsEdge: async (args) => calls.notified.push(args),
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

test('flip: successful flip captures before/after and calls notifyDibsEdge with the flipped user as actor', async () => {
  const row = dueDesk({ nudged_at: iso(FLIP_GRACE_MS + 60000) });
  const calls = makeDeps([row]);
  await sweepPresence();
  assert.equal(calls.flipped.length, 1);
  assert.equal(calls.captures, 2); // before + after
  assert.equal(calls.notified.length, 1);
  assert.equal(calls.notified[0].actorId, row.user_id);
  assert.ok('before' in calls.notified[0] && 'after' in calls.notified[0]);
});

test('flip: race-aborted flip (applyAutoFlip false) does not notify', async () => {
  const row = dueDesk({ nudged_at: iso(FLIP_GRACE_MS + 60000) });
  const calls = makeDeps([row], { applyAutoFlip: async () => false });
  await sweepPresence();
  assert.equal(calls.notified.length, 0);
});

test('flip: composed with the REAL notifier, owner flip with chain user online sends the release ping; chain user away sends nothing', async () => {
  // Integration of sweep -> notifyDibsEdge semantics (spec: Scheduler test
  // addition). Real notifier, fake senders + fake recipient lookup.
  const { notifyDibsEdge, __setPresenceNotifyDeps } = require('./presenceNotify');
  const sent = [];
  __setPresenceNotifyDeps({
    pool: { query: async () => ({ rows: [{ presence_nudge_channel: 'telegram', presence_nudge_phone: null }] }) },
    sendTelegramMessage: async (chat, text) => { sent.push(text); return { ok: true }; },
    sendSMS: async () => ({ sid: 'SM-x' }),
  });
  const OWNER = { id: 1, name: 'Dallas', rank: 2, state: 'desk', since: null, taking_leads: true };
  const CHAIN = { id: 2, name: 'Zul', rank: 1, state: 'desk', since: null, taking_leads: true };
  const row = dueDesk({ id: 20, user_id: 1, nudged_at: iso(FLIP_GRACE_MS + 60000) });

  // Chain user online: pointer moves 1 -> 2 on the owner's flip => release ping.
  let payloads = [
    { users: [CHAIN, OWNER], lead_owner_id: 1 },                                            // before
    { users: [CHAIN, { ...OWNER, state: 'away', taking_leads: false }], lead_owner_id: 2 }, // after
  ];
  makeDeps([row], {
    getStripPayload: async () => payloads.shift(),
    notifyDibsEdge, // the real one
  });
  await sweepPresence();
  assert.equal(sent.length, 1);
  assert.equal(sent[0], "Dallas released leads. You're up.");

  // Chain user away: pointer stays with the owner (fallback) => nothing fires.
  const awayChain = { ...CHAIN, state: 'away', taking_leads: false };
  payloads = [
    { users: [awayChain, OWNER], lead_owner_id: 1 },
    { users: [awayChain, { ...OWNER, state: 'away', taking_leads: false }], lead_owner_id: 1 },
  ];
  makeDeps([row], { getStripPayload: async () => payloads.shift(), notifyDibsEdge });
  await sweepPresence();
  assert.equal(sent.length, 1); // no new send
});

test('flip: throwing capture is isolated; flip still applies and sweep continues to next row', async () => {
  const rows = [
    dueDesk({ nudged_at: iso(FLIP_GRACE_MS + 60000) }),
    dueDesk({ id: 12, user_id: 3, nudged_at: iso(FLIP_GRACE_MS + 60000) }),
  ];
  const calls = makeDeps(rows, { getStripPayload: async () => { throw new Error('db down'); } });
  await sweepPresence(); // must not throw
  assert.equal(calls.flipped.length, 2); // both rows still flipped
  // notifier still invoked with null captures (it no-ops internally)
  assert.equal(calls.notified.every((n) => n.before === null && n.after === null), true);
});

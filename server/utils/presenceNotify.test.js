// Deps-injected tests for the dibs-edge notifier: no DB, no network.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { notifyDibsEdge, __setPresenceNotifyDeps } = require('./presenceNotify');

const OWNER = { id: 1, name: 'Dallas', rank: 2 };
const CHAIN = { id: 2, name: 'Zul', rank: 1 };
const payload = (leadOwnerId) => ({
  users: [
    { ...CHAIN, state: 'desk', since: null, taking_leads: true },
    { ...OWNER, state: 'desk', since: null, taking_leads: true },
  ],
  lead_owner_id: leadOwnerId,
});

function makeDeps(overrides = {}) {
  const calls = { tg: [], sms: [], queries: [] };
  __setPresenceNotifyDeps({
    pool: {
      query: async (sql, params) => {
        calls.queries.push(params);
        return { rows: [{ presence_nudge_channel: 'telegram', presence_nudge_phone: null }] };
      },
    },
    sendTelegramMessage: async (chat, text) => { calls.tg.push(text); return { ok: true }; },
    sendSMS: async ({ to, body }) => { calls.sms.push({ to, body }); return { sid: 'SM1' }; },
    ...overrides,
  });
  return calls;
}

beforeEach(() => {
  process.env.TELEGRAM_ALLOWED_USER_ID = '777';
  delete process.env.SENTRY_DSN_SERVER; // Sentry capture must never fire in tests
});

test('grab: owner takes pointer from chain user, chain user pinged with dibs copy', async () => {
  const calls = makeDeps();
  await notifyDibsEdge({ actorId: 1, before: payload(2), after: payload(1) });
  assert.equal(calls.tg.length, 1);
  assert.equal(calls.tg[0], 'Dallas called dibs on leads.');
  assert.deepEqual(calls.queries[0], [2]); // recipient lookup is the before-owner
});

test('release: pointer returns to chain user with release copy', async () => {
  const calls = makeDeps();
  await notifyDibsEdge({ actorId: 1, before: payload(1), after: payload(2) });
  assert.equal(calls.tg.length, 1);
  assert.equal(calls.tg[0], "Dallas released leads. You're up.");
});

test('silent: no pointer change; non-owner actor; null captures; NULL channel', async () => {
  let calls = makeDeps();
  await notifyDibsEdge({ actorId: 1, before: payload(1), after: payload(1) });
  assert.equal(calls.tg.length, 0);

  calls = makeDeps();
  await notifyDibsEdge({ actorId: 2, before: payload(2), after: payload(1) }); // Zul going away is silent
  assert.equal(calls.tg.length, 0);

  calls = makeDeps();
  await notifyDibsEdge({ actorId: 1, before: null, after: payload(1) });
  await notifyDibsEdge({ actorId: 1, before: payload(2), after: null });
  assert.equal(calls.tg.length, 0);

  calls = makeDeps({
    pool: { query: async () => ({ rows: [{ presence_nudge_channel: null, presence_nudge_phone: null }] }) },
  });
  await notifyDibsEdge({ actorId: 1, before: payload(2), after: payload(1) });
  assert.equal(calls.tg.length, 0);
});

test('sms channel dispatches to presence_nudge_phone', async () => {
  const calls = makeDeps({
    pool: { query: async () => ({ rows: [{ presence_nudge_channel: 'sms', presence_nudge_phone: '+15551234567' }] }) },
  });
  await notifyDibsEdge({ actorId: 1, before: payload(2), after: payload(1) });
  assert.equal(calls.sms.length, 1);
  assert.equal(calls.sms[0].to, '+15551234567');
  assert.match(calls.sms[0].body, /called dibs on leads/);
});

test('never rejects, and warns only on genuine failure (gated skip is silent)', async () => {
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  try {
    let calls = makeDeps({ sendTelegramMessage: async () => { throw new Error('boom'); } });
    await notifyDibsEdge({ actorId: 1, before: payload(2), after: payload(1) }); // must not throw
    assert.equal(warns.length, 1); // genuine failure reported
    assert.match(warns[0], /dibs grab ping failed/);

    calls = makeDeps({ pool: { query: async () => { throw new Error('db down'); } } });
    await notifyDibsEdge({ actorId: 1, before: payload(2), after: payload(1) }); // must not throw
    assert.equal(warns.length, 2); // lookup failure reported too

    calls = makeDeps({
      sendTelegramMessage: async (chat, text) => { calls.tg.push(text); return { ok: false, skipped: true }; },
    });
    await notifyDibsEdge({ actorId: 1, before: payload(2), after: payload(1) });
    assert.equal(calls.tg.length, 1); // send attempted, result skipped, no crash
    assert.equal(warns.length, 2);   // gated skip: NO new warn, no Sentry
  } finally {
    console.warn = realWarn;
  }
});

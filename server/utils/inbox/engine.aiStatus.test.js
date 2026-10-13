// getInbox reads aiReadStatus beside the snapshot (Promise.all): ai.status comes
// from aiReadStatus on every request, so the feed line and the read job read
// one definition. The engine runs on its own fake-snapshot seam (no source
// queries); aiReadStatus reads inbox_reads on the dev DB. One row is seeded
// under a 'sms:aienginetest-' prefix (removed in before and after) so the
// paused case has an attempt to count; the rules ignore a read for a subject
// no source holds.
const launchedEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'test';
require('dotenv').config();

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool, initDb } = require('../../db');
const engine = require('./engine');
const { readStats } = require('./aiStatus');

if (launchedEnv === 'production') {
  throw new Error('engine.aiStatus.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const ENV_KEYS = ['ANTHROPIC_API_KEY', 'RUN_SCHEDULERS', 'RUN_INBOX_READ_SCHEDULER', 'INBOX_AI_DAILY_CAP'];
let saved = {};
const clean = () => pool.query("DELETE FROM inbox_reads WHERE subject_ref LIKE 'sms:aienginetest-%'");

before(async () => {
  await initDb();
  await clean();
});
after(async () => {
  await clean();
  engine.__resetEngine();
  await pool.end();
});
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  engine.__setEngineDeps({ computeSnapshot: () => Promise.resolve(engine.__fakeSnapshot()) });
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  engine.__resetEngine();
});

test('the feed line says the AI read is off with no key', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const payload = await engine.getInbox({ viewerId: 1 });
  assert.equal(payload.ai.status, 'off');
});

test('the feed line says paused at the same cap the read job stops at, on every request', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
  process.env.RUN_SCHEDULERS = 'true';
  delete process.env.RUN_INBOX_READ_SCHEDULER;
  await pool.query(
    "INSERT INTO inbox_reads (kind, subject_ref, person_key, status, attempts) VALUES ('inbound', $1, 'c-1', 'ok', 1)",
    [`sms:aienginetest-${NONCE}`]
  );
  const { attempts24h } = await readStats(pool);
  // Below the cap: on, or failing if the shared dev DB holds recent error
  // reads; never paused. At the cap, on the very next request (no cache clear
  // in between): paused.
  process.env.INBOX_AI_DAILY_CAP = String(attempts24h + 1);
  assert.notEqual((await engine.getInbox({ viewerId: 1 })).ai.status, 'paused');
  process.env.INBOX_AI_DAILY_CAP = String(attempts24h);
  assert.equal((await engine.getInbox({ viewerId: 1 })).ai.status, 'paused', 'not held in the 30-second cache');
});

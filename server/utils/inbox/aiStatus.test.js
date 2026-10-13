// dailyCap / readSchedulerEnabled / statusFrom are pure; readStats runs
// against the dev DB. Rows are seeded under a nonce prefix and removed in
// before() and after(). The dev DB is shared, so counts are asserted as a
// change from a baseline read in the same test, never as absolutes.
const launchedEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'test';
require('dotenv').config();

const { test, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool, initDb } = require('../../db');
const {
  DEFAULT_DAILY_CAP, dailyCap, readSchedulerEnabled, readStats, statusFrom, aiReadStatus,
} = require('./aiStatus');

if (launchedEnv === 'production') {
  throw new Error('aiStatus.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const PREFIX = `sms:aistatus-${NONCE}-`;
const ENV_KEYS = ['ANTHROPIC_API_KEY', 'INBOX_AI_DAILY_CAP', 'RUN_SCHEDULERS', 'RUN_INBOX_READ_SCHEDULER', 'NODE_ENV'];
let saved = {};

async function clean() {
  await pool.query("DELETE FROM inbox_reads WHERE subject_ref LIKE 'sms:aistatus-%'");
}

before(async () => {
  await initDb();
  await clean();
});
after(async () => {
  await clean();
  await pool.end();
});
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  mock.restoreAll();
});

test('dailyCap defaults to 300; 0, blank, negative or nonsense fall back to it', () => {
  delete process.env.INBOX_AI_DAILY_CAP;
  assert.equal(dailyCap(), DEFAULT_DAILY_CAP);
  assert.equal(DEFAULT_DAILY_CAP, 300);
  process.env.INBOX_AI_DAILY_CAP = '25';
  assert.equal(dailyCap(), 25);
  for (const v of ['0', '', '-5', 'lots']) {
    process.env.INBOX_AI_DAILY_CAP = v;
    assert.equal(dailyCap(), 300, v);
  }
});

test('readSchedulerEnabled follows the index.js enabled() rule', () => {
  const run = (nodeEnv, runSchedulers, flag) => {
    process.env.NODE_ENV = nodeEnv;
    if (runSchedulers === undefined) delete process.env.RUN_SCHEDULERS; else process.env.RUN_SCHEDULERS = runSchedulers;
    if (flag === undefined) delete process.env.RUN_INBOX_READ_SCHEDULER; else process.env.RUN_INBOX_READ_SCHEDULER = flag;
    return readSchedulerEnabled();
  };
  assert.equal(run('production', undefined, undefined), true);
  assert.equal(run('production', undefined, 'false'), false);
  assert.equal(run('production', 'false', undefined), false);
  assert.equal(run('development', undefined, undefined), false);
  assert.equal(run('development', 'true', undefined), true);
  assert.equal(run('development', 'true', 'false'), false);
  assert.equal(run('test', undefined, undefined), false);
});

test('statusFrom: off, then paused, then failing, else on', () => {
  const base = { configured: true, schedulerEnabled: true, attempts24h: 10, cap: 300, errors1h: 0 };
  assert.equal(statusFrom({ ...base, configured: false }), 'off');
  assert.equal(statusFrom({ ...base, schedulerEnabled: false }), 'off');
  assert.equal(statusFrom({ ...base, attempts24h: 300 }), 'paused');
  assert.equal(statusFrom({ ...base, attempts24h: 300, errors1h: 9 }), 'paused');
  assert.equal(statusFrom({ ...base, errors1h: 3 }), 'failing');
  assert.equal(statusFrom({ ...base, errors1h: 2 }), 'on');
  assert.equal(statusFrom(base), 'on');
});

test('aiReadStatus is off with no key, before touching the database', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  process.env.RUN_SCHEDULERS = 'true';
  assert.equal(await aiReadStatus({ query: () => { throw new Error('no query expected'); } }), 'off');
});

test('readStats counts attempts in the last 24 hours and error reads in the last hour', async () => {
  const before0 = await readStats(pool);
  const seed = (n, status, attempts, ago) => pool.query(
    `INSERT INTO inbox_reads (kind, subject_ref, person_key, status, attempts, created_at, updated_at)
     VALUES ('inbound', $1, 'c-1', $2, $3, NOW() - $4::interval, NOW() - $4::interval)`,
    [`${PREFIX}${n}`, status, attempts, ago]
  );
  await seed(1, 'ok', 2, '1 minute');
  await seed(2, 'error', 1, '10 minutes');
  await seed(3, 'error', 3, '2 hours');
  await seed(4, 'ok', 5, '25 hours');
  const after0 = await readStats(pool);
  assert.equal(after0.attempts24h - before0.attempts24h, 6);
  assert.equal(after0.errors1h - before0.errors1h, 1);
});

test('aiReadStatus reads paused off the same count the job gates on', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
  process.env.RUN_SCHEDULERS = 'true';
  delete process.env.RUN_INBOX_READ_SCHEDULER;
  await pool.query(
    `INSERT INTO inbox_reads (kind, subject_ref, person_key, status, attempts)
     VALUES ('inbound', $1, 'c-1', 'ok', 1)`,
    [`${PREFIX}cap`]
  );
  const { attempts24h } = await readStats(pool);
  process.env.INBOX_AI_DAILY_CAP = String(attempts24h);
  assert.equal(await aiReadStatus(pool), 'paused');
});

test('aiReadStatus answers failing, and never throws, when the count cannot be read', async () => {
  // getInbox calls this on every list request: a throw would fail the list.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
  process.env.RUN_SCHEDULERS = 'true';
  delete process.env.RUN_INBOX_READ_SCHEDULER;
  const warn = mock.method(console, 'warn', () => {});
  const down = { query: () => Promise.reject(Object.assign(new Error('connection terminated for jordan.t@example.com'), { code: '57P01' })) };
  assert.equal(await aiReadStatus(down), 'failing');
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /57P01/);
  assert.doesNotMatch(warn.mock.calls[0].arguments[0], /terminated|example\.com/);
});

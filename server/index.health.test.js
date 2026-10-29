// Health route release field (instruction rewrite step 5, lane release-field):
// GET /api/health carries `release` equal to RENDER_GIT_COMMIT when that
// variable is set, and no `release` key at all when it is unset.
//
// server/index.js starts the app when required (initDb, app.listen, process
// handlers) and exports nothing, so each case boots the real file in a child
// process: this suite re-runs itself with HEALTH_SUITE_CHILD=1 on a free port,
// with NODE_ENV=test, schedulers off and Sentry's DSN blanked. The child swaps
// initDb for a no-op (no schema apply against the shared dev database) and then
// requires index.js unchanged, so the response comes from the real handler and
// the probe's SELECT 1 from the real pool. Each child is stopped with SIGTERM
// (SIGKILL after a grace period) before its case ends.
//
//   node -r dotenv/config --test server/index.health.test.js

require('dotenv').config();

if (process.env.HEALTH_SUITE_CHILD === '1') {
  const db = require('./db');
  db.initDb = () => Promise.resolve();
  require('./index');
} else {
  runSuite();
}

function runSuite() {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  const { spawn } = require('node:child_process');
  const crypto = require('node:crypto');
  const net = require('node:net');
  const path = require('node:path');

  if (process.env.NODE_ENV === 'production') {
    throw new Error('index.health.test.js refuses to run against production');
  }

  const ROOT = path.join(__dirname, '..');
  const BOOT_MS = 60000;
  const STOP_MS = 10000;
  const POLL_MS = 500;
  const OK_WITHIN_MS = 30000;
  const READY = /Server running on port/;

  // A port nothing holds right now: bind 0, read it, let it go.
  function freePort() {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.on('error', reject);
      srv.listen(0, () => {
        const { port } = srv.address();
        srv.close(() => resolve(port));
      });
    });
  }

  // Boot index.js in a child with RENDER_GIT_COMMIT set to `release`, or
  // removed from its environment when `release` is undefined.
  async function boot(release) {
    const port = await freePort();
    const env = {
      ...process.env,
      HEALTH_SUITE_CHILD: '1',
      PORT: String(port),
      NODE_ENV: 'test',
      RUN_SCHEDULERS: 'false',
      SENTRY_DSN_SERVER: '',
    };
    if (release === undefined) delete env.RENDER_GIT_COMMIT;
    else env.RENDER_GIT_COMMIT = release;

    const child = spawn(process.execPath, [__filename], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let errText = '';
    child.stdout.on('data', (d) => { out = (out + d).slice(-8192); });
    child.stderr.on('data', (d) => { errText = (errText + d).slice(-8192); });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    const tail = () => errText.split('\n').slice(-15).join('\n');

    const stop = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), STOP_MS);
      await exited;
      clearTimeout(timer);
    };

    const ready = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(`no ready line within ${BOOT_MS} ms`), BOOT_MS);
      const onData = () => {
        if (READY.test(out)) {
          clearTimeout(timer);
          child.stdout.off('data', onData);
          resolve(null);
        }
      };
      child.stdout.on('data', onData);
      exited.then(({ code, signal }) => {
        clearTimeout(timer);
        resolve(`child exited before it listened (${code === null ? signal : code})`);
      });
    });
    if (ready !== null) {
      await stop();
      throw new Error(`${ready}; stderr tail:\n${tail()}`);
    }
    return { port, stop };
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Poll the health route every POLL_MS until it answers 200 or OK_WITHIN_MS
  // has passed. The first SELECT 1 on a cold Neon connection can lose the
  // probe's two-second race and answer 503 while the database wakes, so a 503
  // is retried; one that persists fails with the last answer in the message.
  async function getHealth(port) {
    const deadline = Date.now() + OK_WITHIN_MS;
    let last = 'no answer';
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5000) });
        const text = await res.text();
        if (res.status === 200) return { code: res.status, body: JSON.parse(text) };
        last = `HTTP ${res.status} body ${text}`;
      } catch (err) {
        last = `request failed: ${err.message}`;
      }
      if (Date.now() + POLL_MS > deadline) {
        throw new Error(`health did not answer 200 within ${OK_WITHIN_MS} ms; last: ${last}`);
      }
      await sleep(POLL_MS);
    }
  }

  test('health carries release equal to RENDER_GIT_COMMIT when it is set', async () => {
    const sha = crypto.randomBytes(20).toString('hex');
    const app = await boot(sha);
    try {
      const { code, body } = await getHealth(app.port);
      assert.equal(code, 200);
      assert.equal(body.release, sha);
      assert.deepEqual(body, { status: 'ok', release: sha });
    } finally {
      await app.stop();
    }
  });

  test('health has no release key when RENDER_GIT_COMMIT is unset', async () => {
    const app = await boot(undefined);
    try {
      const { code, body } = await getHealth(app.port);
      assert.equal(code, 200);
      assert.equal(Object.hasOwn(body, 'release'), false);
      assert.deepEqual(body, { status: 'ok' });
    } finally {
      await app.stop();
    }
  });
}

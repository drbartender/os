// The loop's seams (review fix 2): a report still owed, a stop during the
// lease, a 4xx report, the outcome recorded before Chrome closes, the attempt
// budget and the outage back-off. The api, the clock and the browser are
// stubs, and the real runJob runs behind a stub GV flow; the profile files are
// real, in a temp dir, so a restart is a second loop on the same files. No
// browser, no network. Run: `node --test src/loop.test.js`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLoop } = require('./loop');
const {
  writeCurrentJob, readCurrentJob, readDayCount, bumpDayCount, loadJournal,
} = require('./journal');

const TOKEN = '0f8e7d6c-5b4a-4c3d-9e2f-1a0b9c8d7e6f';
const JOB = {
  id: 41,
  phone: '+13125550123',
  body: `Your proposal: https://drbartender.com/proposal/${TOKEN}.`,
  negotiation_id: '500000000000000123',
};
const UNTRIED = { outcome: 'failed_preclick', reason: 'ui_error_before_send' };
const NOON = Date.parse('2026-10-19T17:00:00Z'); // noon in Chicago (CDT)
const DAY = '2026-10-19';
const CFG = {
  pollMs: 10000,
  outagePollMs: 60000,
  outageSlowPollMs: 300000,
  outageSlowAfterMs: 3600000,
  dailyCap: 25,
  dailyAttemptCap: 60,
  jobBudgetMs: 90000,
};
const PENDING = 'GET /api/gv-agent/pending';
const REPORT = 'POST /api/gv-agent/report';
const PRECHECK = 'POST /api/gv-agent/precheck';
const STATUS = 'POST /api/gv-agent/status';
const OK = { status: 200, body: { ok: true } };

const tmpDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-agent-loop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
// Successive answers, the last one repeating.
const seq = (...answers) => {
  let i = 0;
  return () => answers[Math.min(i++, answers.length - 1)];
};
const lease = (...jobs) => ({ status: 200, body: jobs });
const settle = () => new Promise((resolve) => setImmediate(resolve));

// The GV flow, a clean send unless a step is overridden (a value to return, or
// a function to run).
function stubFlow(overrides = {}) {
  const steps = {
    classify: 'ok',
    openThreadIfAny: { ok: true, existed: false, bidIds: [] },
    readTokenMessages: [],
    composeTo: { ok: true },
    fillAndCheck: { ok: true },
    clickSend: undefined,
    readVerify: { tokenCount: 1, boxEmpty: true },
    clearComposer: '',
    ...overrides,
  };
  return Object.fromEntries(Object.entries(steps)
    .map(([name, v]) => [name, async (...args) => (typeof v === 'function' ? v(...args) : v)]));
}

function harness(t, { dir = tmpDir(t), routes = {}, flow = stubFlow(), launch, cfg = {}, now = NOON } = {}) {
  const files = {
    journal: path.join(dir, 'gv-sent.journal'),
    marker: path.join(dir, 'gv-current-job.json'),
    count: path.join(dir, 'gv-sent-count.json'),
    attempts: path.join(dir, 'gv-attempt-count.json'),
  };
  const calls = [];
  const lines = [];
  const clock = { t: now };
  const browser = { opened: 0 };
  const table = { [PENDING]: lease(), [REPORT]: OK, [PRECHECK]: { status: 200, body: { go: true } }, [STATUS]: OK, ...routes };
  const api = async (method, route, body) => {
    const key = `${method} ${route}`;
    calls.push({ key, body });
    if (!(key in table)) throw new Error(`unexpected ${key}`);
    const answer = table[key];
    return typeof answer === 'function' ? answer(body) : answer;
  };
  const loop = createLoop({
    api,
    files,
    clock: { now: () => clock.t, sleep: async (ms) => { clock.t += ms; } },
    launch: launch || (async (_label, _deadlineMs, fn) => {
      browser.opened += 1;
      return fn({ stub: 'page' });
    }),
    flow,
    diag: async () => null,
    log: (msg) => lines.push(String(msg)),
    cfg: { ...CFG, ...cfg },
  });
  return {
    loop,
    files,
    lines,
    clock,
    browser,
    keys: () => calls.map((c) => c.key),
    count: (key) => calls.filter((c) => c.key === key).length,
    reports: () => calls.filter((c) => c.key === REPORT).map((c) => c.body),
  };
}

test('a stop during the pending fetch still reports the leased job', async (t) => {
  let answer = null;
  const markerAtReport = [];
  const h = harness(t, {
    routes: {
      [PENDING]: () => new Promise((resolve) => { answer = resolve; }),
      [REPORT]: () => {
        markerAtReport.push(readCurrentJob(h.files.marker));
        return OK;
      },
    },
  });
  const running = h.loop.run();
  await settle();
  assert.equal(typeof answer, 'function', 'the GET is out');
  assert.equal(h.loop.requestStop(), false, 'the stop waits for the answer instead of exiting now');
  answer(lease(JOB)); // the server committed the lease
  await running; // and the loop ends once the job in hand is reported
  assert.deepEqual(h.reports(), [{ id: 41, ...UNTRIED }]);
  assert.deepEqual(markerAtReport, [{ id: 41, ...UNTRIED }], 'the lease had its marker before the report went');
  assert.equal(h.browser.opened, 0, 'no browser opens once a stop is pending');
  assert.equal(readCurrentJob(h.files.marker), null, 'the delivered report cleared the marker');
  assert.equal(h.count(PENDING), 1, 'no second poll after the stop');
  assert.equal(h.loop.requestStop(), true, 'nothing in hand: exit now');
});

test('no lease is taken while a report is owed', async (t) => {
  const h = harness(t, { routes: { [REPORT]: seq({ status: 503, body: null }, { status: 502, body: null }, { status: 500, body: null }) } });
  writeCurrentJob(h.files.marker, 41, { outcome: 'clicked_unverified' });
  assert.equal(await h.loop.tick(), CFG.pollMs);
  assert.equal(await h.loop.tick(), CFG.pollMs);
  assert.equal(h.count(PENDING), 0, 'never leased');
  assert.equal(h.count(REPORT), 6, 'three tries a tick');
  assert.deepEqual(readCurrentJob(h.files.marker), { id: 41, outcome: 'clicked_unverified' });
  // A network that throws is the same.
  const down = harness(t, { routes: { [REPORT]: () => { throw new Error('fetch failed'); } } });
  writeCurrentJob(down.files.marker, 42);
  await down.loop.tick();
  assert.equal(down.count(PENDING), 0);
  assert.deepEqual(readCurrentJob(down.files.marker), { id: 42, ...UNTRIED }, 'settled by the exception rule and kept');
});

test('an extra job in one lease is reported untried, unless the journal holds it', async (t) => {
  const dir = tmpDir(t);
  // Job 77 was clicked in an earlier life of the box; job 78 never was.
  fs.writeFileSync(path.join(dir, 'gv-sent.journal'), '77\n');
  const extra = (id) => ({ ...JOB, id });
  const h = harness(t, { dir, routes: { [PENDING]: seq(lease(JOB, extra(77), extra(78)), lease()) } });
  await h.loop.tick();
  const byId = Object.fromEntries(h.reports().map((r) => [r.id, r]));
  assert.equal(byId[41].outcome, 'sent', 'the first job runs');
  assert.equal(byId[77].outcome, 'clicked_unverified', 'a journaled extra never draws the fallback');
  assert.equal(byId[77].reason, undefined);
  assert.deepEqual({ outcome: byId[78].outcome, reason: byId[78].reason }, UNTRIED, 'an untouched extra is untried');
  assert.equal(h.browser.opened, 1, 'no browser for the extras');
});

test('an undelivered report is re-sent before the next poll', async (t) => {
  let reportsUp = false;
  const markerAtLaunch = [];
  const h = harness(t, {
    routes: {
      [PENDING]: seq(lease(JOB), lease()),
      [REPORT]: () => (reportsUp ? OK : { status: 502, body: null }),
    },
    launch: async (_label, _deadlineMs, fn) => {
      markerAtLaunch.push(readCurrentJob(h.files.marker));
      return fn({ stub: 'page' });
    },
  });
  await h.loop.tick(); // leased, sent, and the report never lands
  assert.deepEqual(markerAtLaunch, [{ id: 41 }], 'the marker is down before the browser opens');
  assert.ok(loadJournal(h.files.journal).has('41'), 'journaled before the click');
  assert.deepEqual(readCurrentJob(h.files.marker), { id: 41, outcome: 'sent' }, 'kept, with its outcome');
  assert.equal(readDayCount(h.files.count, DAY), 1);
  const before = h.keys().length;
  reportsUp = true;
  await h.loop.tick();
  assert.deepEqual(h.keys().slice(before), [REPORT, PENDING], 'the owed report goes first, then the poll');
  assert.deepEqual(h.reports().at(-1), { id: 41, outcome: 'sent' }, 're-sent as itself');
  assert.equal(readCurrentJob(h.files.marker), null);
  assert.equal(readDayCount(h.files.count, DAY), 1, 'the click is counted once across the re-send');
});

test('a 4xx report clears the marker and logs a warning with the id', async (t) => {
  const h = harness(t, {
    routes: {
      [PENDING]: seq(lease({ ...JOB, body: 'no link at all' }), lease()),
      [REPORT]: { status: 400, body: { error: 'bad report' } },
    },
  });
  await h.loop.tick();
  assert.deepEqual(h.reports(), [{ id: 41, outcome: 'failed_preclick', reason: 'invalid_body' }],
    'one try: retrying cannot change the server\'s answer');
  assert.equal(readCurrentJob(h.files.marker), null);
  assert.ok(h.lines.some((l) => l.startsWith('WARNING') && /\bjob 41\b/.test(l) && /\b400\b/.test(l)), h.lines.join('\n'));
  // A marker left by a crash is the same, and the loop moves on to poll.
  const crash = harness(t, { routes: { [REPORT]: { status: 404, body: null } } });
  writeCurrentJob(crash.files.marker, 42);
  await crash.loop.tick();
  assert.equal(crash.count(REPORT), 1);
  assert.equal(readCurrentJob(crash.files.marker), null);
  assert.ok(crash.lines.some((l) => l.startsWith('WARNING') && /\bjob 42\b/.test(l) && /\b404\b/.test(l)), crash.lines.join('\n'));
  assert.equal(crash.count(PENDING), 1);
});

test('a kill during browser close keeps a found skipped_already_posted', async (t) => {
  const dir = tmpDir(t);
  let closing;
  const reachedClose = new Promise((resolve) => { closing = resolve; });
  const first = harness(t, {
    dir,
    routes: { [PENDING]: lease(JOB) },
    flow: stubFlow({ openThreadIfAny: { ok: true, existed: true, bidIds: [JOB.negotiation_id] }, readTokenMessages: [JOB.body] }),
    // The job runs, then the box is killed while Chrome closes: the close never returns.
    launch: async (_label, _deadlineMs, fn) => {
      await fn({ stub: 'page' });
      closing();
      return new Promise(() => {});
    },
  });
  first.loop.tick();
  await reachedClose;
  assert.deepEqual(readCurrentJob(first.files.marker), { id: 41, outcome: 'skipped_already_posted' });
  assert.equal(first.reports().length, 0, 'killed before it could report');
  // The restart reports what the job found, not the exception rule's guess
  // (which would send a toll-free text beside the link already in the thread).
  const restarted = harness(t, { dir });
  await restarted.loop.tick();
  assert.deepEqual(restarted.reports(), [{ id: 41, outcome: 'skipped_already_posted' }]);
  assert.equal(readCurrentJob(restarted.files.marker), null);
});

test('the attempt budget stops leasing until the next Chicago day, across a restart', async (t) => {
  const dir = tmpDir(t);
  for (let i = 0; i < CFG.dailyAttemptCap; i += 1) bumpDayCount(path.join(dir, 'gv-attempt-count.json'), DAY);
  const h = harness(t, { dir });
  assert.equal(await h.loop.tick(), CFG.pollMs);
  assert.equal(await h.loop.tick(), CFG.pollMs);
  assert.equal(h.count(PENDING), 0, 'leases nothing');
  assert.equal(h.lines.filter((l) => /attempt budget/.test(l)).length, 1, 'says so once');
  const restarted = harness(t, { dir, now: Date.parse('2026-10-20T04:59:59Z') }); // 23:59:59 in Chicago
  await restarted.loop.tick();
  assert.equal(restarted.count(PENDING), 0, 'the spent budget survives a restart');
  restarted.clock.t = Date.parse('2026-10-20T05:00:00Z'); // Chicago midnight
  await restarted.loop.tick();
  assert.equal(restarted.count(PENDING), 1, 'a new Chicago day leases again');
  assert.ok(restarted.lines.some((l) => /attempt budget is open again/.test(l)), restarted.lines.join('\n'));
});

test('every job the box drives a browser for counts one attempt, whatever its outcome', async (t) => {
  let launchWorks = true;
  const h = harness(t, {
    cfg: { dailyAttemptCap: 2 },
    routes: {
      [PENDING]: seq(lease({ ...JOB, id: 51 }), lease({ ...JOB, id: 52, body: 'no link at all' }), lease({ ...JOB, id: 53 }), lease()),
    },
    flow: stubFlow({ composeTo: { ok: false, reason: 'ui_error_before_send' } }),
    launch: async (_label, _deadlineMs, fn) => {
      if (!launchWorks) throw new Error('Chrome failed to launch');
      return fn({ stub: 'page' });
    },
  });
  await h.loop.tick(); // 51 drives the browser and fails before any click
  assert.equal(readDayCount(h.files.attempts, DAY), 1);
  await h.loop.tick(); // 52 is reported without a browser
  assert.equal(readDayCount(h.files.attempts, DAY), 1, 'no browser, no attempt');
  launchWorks = false;
  await h.loop.tick(); // 53 tries to open Chrome, which fails
  assert.equal(readDayCount(h.files.attempts, DAY), 2, 'a failed launch is still an attempt');
  await h.loop.tick();
  assert.equal(h.count(PENDING), 3, 'the budget of 2 is spent: no fourth lease');
  assert.deepEqual(h.reports(), [
    { id: 51, ...UNTRIED },
    { id: 52, outcome: 'failed_preclick', reason: 'invalid_body' },
    { id: 53, ...UNTRIED },
  ]);
});

test('an attempt that cannot be counted never opens a browser', async (t) => {
  const h = harness(t, { routes: { [PENDING]: lease(JOB) } });
  fs.mkdirSync(h.files.attempts); // a directory where the count file goes: every write fails
  await h.loop.tick();
  assert.equal(h.browser.opened, 0);
  assert.deepEqual(h.reports(), [{ id: 41, ...UNTRIED }]);
});

test('during an outage the session check backs off to five minutes after the first hour', async (t) => {
  const h = harness(t, {
    routes: { [PENDING]: seq(lease(JOB), lease()) },
    flow: stubFlow({ classify: 'session_expired' }),
  });
  assert.equal(await h.loop.tick(), 60000, 'the job meets the sign-in page: outage');
  assert.deepEqual(h.reports(), [{ id: 41, outcome: 'failed_preclick', reason: 'session_expired' }]);
  assert.equal(h.count(STATUS), 1);
  assert.equal(await h.loop.tick(), 60000, 'still signed out: a minute');
  h.clock.t += 3600000;
  assert.equal(await h.loop.tick(), 300000, 'after the first hour: five minutes');
  assert.equal(h.count(PENDING), 1, 'leases nothing during the outage');
  assert.equal(h.count(STATUS), 1, 'the outage is reported once');
});

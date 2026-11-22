// The per-job runner's fixed order and the exception rule (plan Task 15 and
// decision 10), plus the startup reconciliation of a leftover current-job
// marker. Every dependency is stubbed: no browser, no network.
// Run: `node --test src/runJob.test.js`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runJob, reconcileMarker } = require('./runJob');
const { writeCurrentJob, readCurrentJob } = require('./journal');

const TOKEN = '0f8e7d6c-5b4a-4c3d-9e2f-1a0b9c8d7e6f';
const JOB = {
  id: 41,
  phone: '+13125550123',
  body: `Your proposal: https://drbartender.com/proposal/${TOKEN}.`,
  negotiation_id: '500000000000000123',
};
const FULL_RUN = ['classify', 'openThreadIfAny', 'composeTo', 'readTokenMessages', 'fillAndCheck', 'precheck',
  'readTokenMessages', 'journal.write', 'clickSend', 'readVerify'];
const UI_ERROR = { outcome: 'failed_preclick', reason: 'ui_error_before_send' };

// Every stub logs its name in call order. An override is a value to return or
// a function to run (which may throw). `timeline` also holds the record and
// diag calls, for the order of a job's terminal path.
function harness({ flow = {}, journalWrite, precheck, classify = 'ok', startMs = 0, nowStart = 0 } = {}) {
  const calls = [];
  const diags = [];
  const records = [];
  const timeline = [];
  const journaled = new Set();
  let clock = nowStart;
  const step = (name, v) => async (...args) => {
    calls.push(name);
    timeline.push(name);
    return typeof v === 'function' ? v(...args) : v;
  };
  const stubs = {
    openThreadIfAny: { ok: true, existed: false, bidIds: [] },
    readTokenMessages: [],
    composeTo: { ok: true },
    fillAndCheck: { ok: true },
    clickSend: () => { assert.ok(journaled.has('41'), 'the journal holds the id when Send is clicked'); },
    readVerify: { tokenCount: 1, boxEmpty: true },
    clearComposer: '',
    ...flow,
  };
  const deps = {
    page: { stub: true },
    flow: Object.fromEntries(Object.entries(stubs).map(([k, v]) => [k, step(k, v)])),
    journal: {
      has: (id) => journaled.has(String(id)),
      write: (id) => {
        calls.push('journal.write');
        timeline.push('journal.write');
        if (journalWrite) journalWrite(id);
        journaled.add(String(id));
      },
    },
    api: { precheck: step('precheck', precheck || { go: true }) },
    classify: step('classify', classify),
    diag: async (_page, id, tag) => {
      diags.push(`${id}:${tag}`);
      timeline.push('diag');
    },
    record: (result) => {
      records.push(result);
      timeline.push('record');
    },
    startMs,
    now: () => clock,
    budgetMs: 90000,
    sleep: async (ms) => { clock += ms; },
  };
  return { deps, calls, diags, records, timeline };
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gv-agent-test-'));

test('the journal is written before the click', async () => {
  const h = harness({ flow: { openThreadIfAny: { ok: true, existed: true, bidIds: ['500000000000000123'] } } });
  assert.deepEqual(await runJob(JOB, h.deps), { outcome: 'sent' });
  assert.deepEqual(h.calls, ['classify', 'openThreadIfAny', 'readTokenMessages', 'composeTo', 'readTokenMessages',
    'fillAndCheck', 'precheck', 'readTokenMessages', 'journal.write', 'clickSend', 'readVerify']);
});

test('a failed journal write means no click', async () => {
  const h = harness({ journalWrite: () => { throw new Error('EROFS: read-only file system'); } });
  assert.deepEqual(await runJob(JOB, h.deps), UI_ERROR);
  assert.equal(h.calls.includes('clickSend'), false);
  assert.ok(h.calls.includes('clearComposer'), 'the filled box is emptied again');
  assert.deepEqual(h.diags, ['41:ui_error_before_send']);
});

test('a token already in the thread skips without journal or click', async () => {
  const h = harness({ flow: { openThreadIfAny: { ok: true, existed: true, bidIds: [] }, readTokenMessages: [JOB.body] } });
  assert.deepEqual(await runJob(JOB, h.deps), { outcome: 'skipped_already_posted' });
  assert.deepEqual(h.calls, ['classify', 'openThreadIfAny', 'readTokenMessages']);
  assert.deepEqual(h.diags, []);
});

test('a precheck no-go skips without journal or click', async () => {
  const h = harness({ precheck: { go: false, outcome: 'skipped_already_posted' } });
  assert.deepEqual(await runJob(JOB, h.deps), { outcome: 'skipped_already_posted' });
  assert.equal(h.calls.includes('journal.write'), false);
  assert.equal(h.calls.includes('clickSend'), false);
  assert.ok(h.calls.includes('clearComposer'), 'the filled box is emptied again');
  // The sweep already moved the row to unknown: the box reports timeout (plan Task 7).
  const late = harness({ precheck: { go: false, outcome: 'timeout' } });
  assert.deepEqual(await runJob(JOB, late.deps), { outcome: 'failed_preclick', reason: 'timeout' });
  // Anything short of an explicit go is a no-go.
  const odd = harness({ precheck: { status: 500 } });
  assert.deepEqual(await runJob(JOB, odd.deps), UI_ERROR);
  for (const other of [late, odd]) {
    assert.equal(other.calls.includes('journal.write'), false);
    assert.equal(other.calls.includes('clickSend'), false);
  }
});

test('over budget reports timeout before the journal', async () => {
  const h = harness({ startMs: 0, nowStart: 90000 });
  assert.deepEqual(await runJob(JOB, h.deps), { outcome: 'failed_preclick', reason: 'timeout' });
  assert.deepEqual(h.calls, ['classify', 'openThreadIfAny', 'composeTo', 'readTokenMessages', 'fillAndCheck', 'clearComposer']);
  assert.deepEqual(h.diags, ['41:timeout']);
});

test('a non-ok page reports its reason and captures diag', async () => {
  const h = harness({ classify: 'session_expired' });
  assert.deepEqual(await runJob(JOB, h.deps), { outcome: 'failed_preclick', reason: 'session_expired' });
  assert.deepEqual(h.calls, ['classify']);
  assert.deepEqual(h.diags, ['41:session_expired']);
});

test('a wrong thread fails before compose', async () => {
  const h = harness({ flow: { openThreadIfAny: { ok: false, reason: 'wrong_thread' } } });
  assert.deepEqual(await runJob(JOB, h.deps), { outcome: 'failed_preclick', reason: 'wrong_thread' });
  assert.deepEqual(h.calls, ['classify', 'openThreadIfAny']);
  assert.deepEqual(h.diags, ['41:wrong_thread']);
});

test('a throw before the journal reports ui_error_before_send', async () => {
  const h = harness({ flow: { composeTo: () => { throw new Error('element is not attached to the DOM'); } } });
  assert.deepEqual(await runJob(JOB, h.deps), UI_ERROR);
  assert.equal(h.calls.includes('journal.write'), false);
  assert.equal(h.calls.includes('clickSend'), false);
  assert.deepEqual(h.diags, ['41:ui_error_before_send']);
  // A precheck that cannot be asked (the network) is the same: no go, no click.
  const h2 = harness({ precheck: () => { throw new Error('fetch failed'); } });
  assert.deepEqual(await runJob(JOB, h2.deps), UI_ERROR);
  assert.equal(h2.calls.includes('clickSend'), false);
});

test('a throw after the journal reports clicked_unverified', async () => {
  const h = harness({ flow: { clickSend: () => { throw new Error('Target page, context or browser has been closed'); } } });
  assert.deepEqual(await runJob(JOB, h.deps), { outcome: 'clicked_unverified' });
  assert.deepEqual(h.diags, ['41:clicked_unverified']);
  assert.equal(h.calls.includes('clearComposer'), false, 'nothing touches the box after the click');
  const h2 = harness({ flow: { readVerify: () => { throw new Error('Execution context was destroyed'); } } });
  assert.deepEqual(await runJob(JOB, h2.deps), { outcome: 'clicked_unverified' });
});

test('a verified send reports sent', async () => {
  const h = harness();
  assert.deepEqual(await runJob(JOB, h.deps), { outcome: 'sent' });
  assert.deepEqual(h.calls, FULL_RUN);
  assert.deepEqual(h.diags, []);
});

test('a click the page never confirms is clicked_unverified after 20 seconds', async () => {
  const h = harness({ flow: { readVerify: { tokenCount: 1, boxEmpty: false } } });
  assert.deepEqual(await runJob(JOB, h.deps), { outcome: 'clicked_unverified' });
  const polls = h.calls.filter((c) => c === 'readVerify').length;
  assert.ok(polls >= 20 && polls <= 22, `polled ${polls} times`);
  assert.deepEqual(h.diags, ['41:clicked_unverified']);
});

test('the outcome is recorded before anything that can be cut short ends the job', async () => {
  // Found in the thread: recorded the moment it is found, before Chrome closes.
  const found = harness({ flow: { openThreadIfAny: { ok: true, existed: true, bidIds: [] }, readTokenMessages: [JOB.body] } });
  assert.deepEqual(await runJob(JOB, found.deps), { outcome: 'skipped_already_posted' });
  assert.deepEqual(found.records, [{ outcome: 'skipped_already_posted' }]);
  assert.deepEqual(found.timeline, ['classify', 'openThreadIfAny', 'readTokenMessages', 'record']);
  // A pre-click failure: recorded before the diag capture and the composer clear.
  const late = harness({ startMs: 0, nowStart: 90000 });
  assert.deepEqual(await runJob(JOB, late.deps), { outcome: 'failed_preclick', reason: 'timeout' });
  assert.deepEqual(late.records, [{ outcome: 'failed_preclick', reason: 'timeout' }]);
  assert.deepEqual(late.timeline.slice(-3), ['record', 'diag', 'clearComposer']);
  // A throw after the journal: recorded once, as clicked_unverified, before the diag.
  const thrown = harness({ flow: { clickSend: () => { throw new Error('Target page, context or browser has been closed'); } } });
  assert.deepEqual(await runJob(JOB, thrown.deps), { outcome: 'clicked_unverified' });
  assert.deepEqual(thrown.records, [{ outcome: 'clicked_unverified' }]);
  assert.deepEqual(thrown.timeline.slice(-2), ['record', 'diag']);
  // A verified send: recorded once, after the verify read.
  const sent = harness();
  assert.deepEqual(await runJob(JOB, sent.deps), { outcome: 'sent' });
  assert.deepEqual(sent.records, [{ outcome: 'sent' }]);
  assert.deepEqual(sent.timeline.slice(-2), ['readVerify', 'record']);
  // A record that throws never changes the job's result.
  const broken = harness();
  broken.deps.record = () => { throw new Error('ENOSPC: no space left on device'); };
  assert.deepEqual(await runJob(JOB, broken.deps), { outcome: 'sent' });
});

// A resend: the box's own earlier post of this proposal is already in the
// thread, and prior_bodies accounts for it.
const RESEND = { ...JOB, prior_bodies: [JOB.body] };
const IN_THREAD = { openThreadIfAny: { ok: true, existed: true, bidIds: ['500000000000000123'] } };
// The thread read before compose, then the before read: answers in turn.
const reads = (...answers) => {
  let i = 0;
  return (...args) => {
    const a = answers[Math.min(i++, answers.length - 1)];
    return typeof a === 'function' ? a(...args) : a;
  };
};

test('a resend with its earlier post in the thread goes on to the click and is sent on a count increase', async () => {
  const h = harness({ flow: { ...IN_THREAD, readTokenMessages: [`  ${JOB.body} `], readVerify: { tokenCount: 2, boxEmpty: true } } });
  assert.deepEqual(await runJob(RESEND, h.deps), { outcome: 'sent' });
  assert.deepEqual(h.calls, ['classify', 'openThreadIfAny', 'readTokenMessages', 'composeTo', 'readTokenMessages',
    'fillAndCheck', 'precheck', 'readTokenMessages', 'journal.write', 'clickSend', 'readVerify']);
});

test('a resend whose click shows no new message is clicked_unverified, never sent and never clicked again', async () => {
  // The earlier post alone still shows the token: one before, one after.
  const h = harness({ flow: { ...IN_THREAD, readTokenMessages: [JOB.body], readVerify: { tokenCount: 1, boxEmpty: true } } });
  assert.deepEqual(await runJob(RESEND, h.deps), { outcome: 'clicked_unverified' });
  assert.equal(h.calls.filter((c) => c === 'clickSend').length, 1);
  assert.deepEqual(h.diags, ['41:clicked_unverified']);
  // The count went up on a later poll: sent then.
  const late = harness({ flow: { ...IN_THREAD, readTokenMessages: [JOB.body],
    readVerify: reads({ tokenCount: 1, boxEmpty: true }, { tokenCount: 1, boxEmpty: true }, { tokenCount: 2, boxEmpty: true }) } });
  assert.deepEqual(await runJob(RESEND, late.deps), { outcome: 'sent' });
  assert.equal(late.calls.filter((c) => c === 'readVerify').length, 3);
});

test('a resend beside a pasted copy is skipped; an older job with no list skips on any token', async () => {
  const pasted = harness({ flow: { ...IN_THREAD, readTokenMessages: [JOB.body, JOB.body] } });
  assert.deepEqual(await runJob(RESEND, pasted.deps), { outcome: 'skipped_already_posted' });
  assert.equal(pasted.calls.includes('composeTo'), false);
  const legacy = harness({ flow: { ...IN_THREAD, readTokenMessages: [JOB.body] } });
  assert.deepEqual(await runJob({ ...JOB, prior_bodies: 'not a list' }, legacy.deps), { outcome: 'skipped_already_posted' });
});

test('a thread read or a before read that fails is a pre-click failure', async () => {
  const thrown = harness({ flow: { ...IN_THREAD, readTokenMessages: () => { throw new Error('Execution context was destroyed'); } } });
  assert.deepEqual(await runJob(RESEND, thrown.deps), UI_ERROR);
  assert.equal(thrown.calls.includes('composeTo'), false);
  // The post-compose read fails, or answers no list: nothing filled, nothing journaled.
  for (const answer of [() => { throw new Error('Execution context was destroyed'); }, null]) {
    const composed = harness({ flow: { readTokenMessages: answer } });
    assert.deepEqual(await runJob(JOB, composed.deps), UI_ERROR);
    assert.equal(composed.calls.includes('fillAndCheck'), false);
    assert.equal(composed.calls.includes('journal.write'), false);
  }
  // The before read alone fails, or answers no list: nothing journaled, nothing clicked.
  const fail = () => { throw new Error('Target page, context or browser has been closed'); };
  for (const second of [fail, null]) {
    const before = harness({ flow: { readTokenMessages: reads([], second) } });
    assert.deepEqual(await runJob(JOB, before.deps), UI_ERROR);
    assert.equal(before.calls.includes('journal.write'), false);
    assert.equal(before.calls.includes('clickSend'), false);
    assert.ok(before.calls.includes('clearComposer'), 'the filled box is emptied again');
  }
});

test('a thread the list scan missed is checked on the composed view, before the body is filled', async () => {
  // Not found in the list: the composed view shows a token message the list does not account for.
  const missed = harness({ flow: { readTokenMessages: [`Pasted by hand: https://drbartender.com/proposal/${TOKEN}`] } });
  assert.deepEqual(await runJob(RESEND, missed.deps), { outcome: 'skipped_already_posted' });
  // Nothing is filled yet, so there is no box to clear.
  assert.deepEqual(missed.calls, ['classify', 'openThreadIfAny', 'composeTo', 'readTokenMessages']);
  assert.equal(missed.calls.includes('journal.write'), false);
  assert.equal(missed.calls.includes('clickSend'), false);
  assert.deepEqual(missed.records, [{ outcome: 'skipped_already_posted' }]);
  assert.deepEqual(missed.diags, []);
  // The same view with only the accounted earlier post goes on to the click.
  const accounted = harness({ flow: { readTokenMessages: [JOB.body], readVerify: { tokenCount: 2, boxEmpty: true } } });
  assert.deepEqual(await runJob(RESEND, accounted.deps), { outcome: 'sent' });
  assert.ok(accounted.calls.includes('clickSend'));
  // A first send with an empty composed view is unchanged.
  const first = harness();
  assert.deepEqual(await runJob(JOB, first.deps), { outcome: 'sent' });
  assert.deepEqual(first.calls, FULL_RUN);
});

test('a token that shows on the composed view only once the body is filled never skips the job', async () => {
  // Nothing before the fill; after it, one token-holding element (a link
  // preview above the box). The job goes on to the click, counting it as before.
  const preview = `drbartender.com/proposal/${TOKEN}`;
  const flat = harness({ flow: { readTokenMessages: reads([], [preview]), readVerify: { tokenCount: 1, boxEmpty: true } } });
  assert.deepEqual(await runJob(JOB, flat.deps), { outcome: 'clicked_unverified' }, 'the preview alone proves no click');
  assert.ok(flat.calls.includes('clickSend'));
  const landed = harness({ flow: { readTokenMessages: reads([], [preview]), readVerify: { tokenCount: 2, boxEmpty: true } } });
  assert.deepEqual(await runJob(JOB, landed.deps), { outcome: 'sent' });
  assert.deepEqual(landed.calls, FULL_RUN);
});

test('startup with a marker not in the journal reports ui_error_before_send', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const markerFile = path.join(dir, 'gv-current-job.json');
  writeCurrentJob(markerFile, 41);
  const reports = [];
  const out = await reconcileMarker({
    markerFile,
    journal: { has: () => false },
    report: async (id, result) => { reports.push([id, result]); return 'delivered'; },
  });
  assert.deepEqual(reports, [[41, UI_ERROR]]);
  assert.equal(out.delivery, 'delivered');
  assert.equal(readCurrentJob(markerFile), null);
});

test('startup with a journaled marker reports clicked_unverified', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const markerFile = path.join(dir, 'gv-current-job.json');
  writeCurrentJob(markerFile, 41);
  const reports = [];
  let clicks = 0;
  await reconcileMarker({
    markerFile,
    journal: { has: (id) => String(id) === '41' },
    report: async (id, result) => { reports.push([id, result]); return 'delivered'; },
    onClick: () => { clicks += 1; },
  });
  assert.deepEqual(reports, [[41, { outcome: 'clicked_unverified' }]]);
  assert.equal(clicks, 1, 'the click the crash never counted is counted');
  assert.equal(readCurrentJob(markerFile), null);
});

test('an undelivered report keeps its marker, re-sent as itself and counted once', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const markerFile = path.join(dir, 'gv-current-job.json');
  writeCurrentJob(markerFile, 41);
  let clicks = 0;
  const onClick = () => { clicks += 1; };
  const journal = { has: () => true };
  const first = await reconcileMarker({ markerFile, journal, report: async () => 'undelivered', onClick });
  assert.equal(first.delivery, 'undelivered');
  assert.deepEqual(readCurrentJob(markerFile), { id: 41, outcome: 'clicked_unverified' });
  const second = await reconcileMarker({ markerFile, journal, report: async () => 'delivered', onClick });
  assert.equal(second.delivery, 'delivered');
  assert.equal(clicks, 1, 'counted once across the retry');
  assert.equal(readCurrentJob(markerFile), null);

  // A recorded pre-click outcome is re-sent as itself, never as ui_error_before_send.
  writeCurrentJob(markerFile, 42, { outcome: 'skipped_already_posted' });
  const reports = [];
  const third = await reconcileMarker({
    markerFile,
    journal: { has: () => false },
    report: async (id, result) => { reports.push([id, result]); return 'rejected'; },
  });
  assert.deepEqual(reports, [[42, { outcome: 'skipped_already_posted' }]]);
  assert.equal(third.delivery, 'rejected');
  assert.equal(readCurrentJob(markerFile), null, 'a rejected report cannot be helped by retrying');

  assert.equal(await reconcileMarker({
    markerFile,
    journal: { has: () => false },
    report: async () => { throw new Error('never called'); },
  }), null);
});

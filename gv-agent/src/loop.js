// The box's loop (plan Task 15), with every outside effect injected so its
// seams are unit tested: the os API, the files in the profile dir, the clock,
// and the browser launch. index.js wires in the real ones.
//
// One tick: re-send a report still owed (the current-job marker); then, with
// none owed and the day's attempt budget open, check the session during an
// outage; then poll GET /api/gv-agent/pending once and run the one job it
// leases. The server answers [] while GV_PROPOSAL_POST_ENABLED is off.
//
// At most once (spec law 4): runJob journals the id right before Send, and a
// journaled id is never driven again. The exception rule (plan decision 10): a
// throw before the journal, a failed launch included, reports failed_preclick
// ui_error_before_send, and the server sends today's toll-free text; a throw
// after it reports clicked_unverified. The marker, written the moment a lease
// lands and rewritten with the outcome the moment the job settles, makes a
// crash between lease and report still end in a report, and no new lease is
// taken while one is owed.
const { decideJob, chicagoDayKey, finalResult, budgetLeft, outageCheckDelay } = require('./decide');
const { runJob, reconcileMarker } = require('./runJob');
const {
  loadJournal, journalBeforeClick, writeCurrentJob, clearCurrentJob, readDayCount, bumpDayCount,
} = require('./journal');
const { errText, last4 } = require('./scrub');

// A hung renderer would hang page.evaluate forever. Closing the browser 150 s
// after the lease makes every pending call throw into the exception rule; the
// report then lands in the server's lease window or, if late, upgrades the
// unknown row the sweep left.
const JOB_HARD_LIMIT_MS = 150000;
const CHECK_HARD_LIMIT_MS = 60000;
// The server's verdict on this exact report: retrying cannot change it. A 401,
// 403, 408, 429 or 5xx is retried, and the marker kept until it lands.
const REJECTED = new Set([400, 404, 409, 422]);
const CLICKED = new Set(['sent', 'clicked_unverified']);
const OUTAGE = new Set(['session_expired', 'challenge']);
const UNTRIED = Object.freeze({ outcome: 'failed_preclick', reason: 'ui_error_before_send' });

const outcomeText = (r) => `${r.outcome}${r.reason ? ` (${r.reason})` : ''}`;
const usableId = (id) => Number.isSafeInteger(id) && id > 0;

// deps:
//   api(method, route, body) -> { status, body }; throws on a network failure
//   files: { journal, marker, count, attempts }, paths in the profile dir
//   clock: { now() -> ms, sleep(ms) }
//   launch(label, deadlineMs, fn) -> fn(page)'s result: opens GV on the
//     profile, runs fn, and closes the browser after, or at deadlineMs
//   flow (gvFlow.js), diag(page, jobId, tag), log(line)
//   cfg: { pollMs, outagePollMs, outageSlowPollMs, outageSlowAfterMs,
//     dailyCap, dailyAttemptCap, jobBudgetMs }
function createLoop({ api, files, clock, launch, flow, diag, log, cfg }) {
  const state = {
    stop: false,
    inFlight: false,
    outage: null,
    outageSince: null,
    lastPoll: undefined,
    budgetSpentDay: null,
  };
  const sentIds = loadJournal(files.journal);
  const journal = {
    has: (id) => sentIds.has(String(id)),
    write: (id) => {
      journalBeforeClick(files.journal, id); // throws on failure: no click
      sentIds.add(String(id));
    },
  };
  const today = () => chicagoDayKey(new Date(clock.now()));

  // -- API --------------------------------------------------------------------

  // Three tries; only a 2xx counts. Returns 'delivered' | 'rejected' | 'undelivered'.
  async function deliver(route, body, label) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const r = await api('POST', route, body);
        if (r.status >= 200 && r.status < 300) return 'delivered';
        if (REJECTED.has(r.status)) {
          log(`WARNING: ${label}: the server rejected it (${r.status}); not retrying`);
          return 'rejected';
        }
        log(`${label}: server ${r.status}; try ${attempt}/3`);
      } catch (err) {
        log(`${label}: ${errText(err)}; try ${attempt}/3`);
      }
      if (attempt < 3) await clock.sleep(2000 * attempt);
    }
    log(`${label}: UNDELIVERED after 3 tries`);
    return 'undelivered';
  }

  function report(id, result) {
    const body = result.outcome === 'failed_preclick'
      ? { id, outcome: result.outcome, reason: result.reason }
      : { id, outcome: result.outcome };
    return deliver('/api/gv-agent/report', body, `job ${id}: report ${outcomeText(result)}`);
  }

  // The server re-runs the law 6 token query for a leased row. A throw (the
  // network) propagates into runJob: no go, no click.
  async function precheck(id) {
    const r = await api('POST', '/api/gv-agent/precheck', { id });
    return r.status >= 200 && r.status < 300 && r.body ? r.body : { go: false, status: r.status };
  }

  // -- Local state ------------------------------------------------------------

  function countClick() {
    try {
      bumpDayCount(files.count, today());
    } catch (err) {
      log(`daily count not saved (${errText(err)}); the server's cap still holds`);
    }
  }

  function clearMarker() {
    try { clearCurrentJob(files.marker); } catch (err) { log(`marker not cleared (${errText(err)})`); }
  }

  // One job's report, settled once by the journal (finalResult) and recorded
  // at once: the click counted, then the outcome written to the marker, so a
  // report re-sent after a crash goes as itself and is counted once. runJob
  // calls it the moment the job settles, before the browser closes; the job's
  // end calls it again, which only re-tries a marker write that failed.
  function settler(id) {
    let result = null;
    let recorded = false;
    return (raw) => {
      if (!result) {
        result = finalResult(raw, journal.has(id));
        if (CLICKED.has(result.outcome)) countClick();
      }
      if (!recorded) {
        try {
          writeCurrentJob(files.marker, id, result);
          recorded = true;
        } catch (err) {
          log(`job ${id}: marker not updated (${errText(err)})`);
        }
      }
      return result;
    };
  }

  // -- Browser ----------------------------------------------------------------

  async function runInBrowser(job, startMs, record) {
    try {
      return await launch(`job ${job.id}`, startMs + JOB_HARD_LIMIT_MS, (page) => runJob(job, {
        page,
        flow,
        journal,
        api: { precheck },
        classify: flow.classify,
        diag,
        startMs,
        now: clock.now,
        sleep: clock.sleep,
        budgetMs: cfg.jobBudgetMs,
        log,
        record,
      }));
    } catch (err) {
      // The launch and the goto sit inside the same exception rule: pre-journal.
      log(`job ${job.id}: browser step failed (${errText(err)})`);
      return null; // the settler decides it by the journal
    }
  }

  async function checkSession() {
    try {
      return await launch('session check', clock.now() + CHECK_HARD_LIMIT_MS, (page) => flow.classify(page));
    } catch (err) {
      log(`session check: ${errText(err)}`);
      return 'error';
    }
  }

  // -- Outage -----------------------------------------------------------------

  const outageDelay = () => outageCheckDelay(state.outageSince, clock.now(), {
    fastMs: cfg.outagePollMs, slowMs: cfg.outageSlowPollMs, slowAfterMs: cfg.outageSlowAfterMs,
  });

  async function enterOutage(reason) {
    if (state.outage) return;
    state.outage = reason;
    state.outageSince = clock.now();
    log(`GV needs a human (${reason}): reporting it once, then leasing nothing; checking every `
      + `${cfg.outagePollMs / 1000} s for the first ${cfg.outageSlowAfterMs / 60000} minutes, then every `
      + `${cfg.outageSlowPollMs / 60000} minutes (README: re-login)`);
    await deliver('/api/gv-agent/status', { state: reason }, `status ${reason}`);
  }

  // -- The day's attempt budget -----------------------------------------------
  // Every job the box drives a browser for counts one attempt, whatever its
  // outcome. Once the day's budget is spent the box leases nothing until the
  // next Chicago day, and says so once.
  function attemptBudgetOpen() {
    const day = today();
    const used = readDayCount(files.attempts, day);
    if (budgetLeft(used, cfg.dailyAttemptCap)) {
      if (state.budgetSpentDay !== null) {
        log('the attempt budget is open again; leasing');
        state.budgetSpentDay = null;
      }
      return true;
    }
    if (state.budgetSpentDay !== day) {
      state.budgetSpentDay = day;
      log(`the daily attempt budget is spent (${used} of ${cfg.dailyAttemptCap} browser jobs today); leasing nothing until Chicago midnight`);
    }
    return false;
  }

  // -- One job ----------------------------------------------------------------

  async function finish(id, result) {
    log(`job ${id}: ${outcomeText(result)}`);
    if ((await report(id, result)) !== 'undelivered') clearMarker();
    if (OUTAGE.has(result.reason)) await enterOutage(result.reason);
  }

  // One job per lease (plan decision 3). Nothing was tried for an extra, so a
  // pre-click report is the truth and its toll-free text goes out, unless the
  // journal already holds the id: then it is settled like any journaled job and
  // never draws the fallback.
  async function reportUntried(extras) {
    for (const x of extras) {
      if (usableId(x && x.id)) {
        log(`job ${x.id}: leased beside another; reporting it untried`);
        await report(x.id, finalResult(UNTRIED, journal.has(x.id)));
      }
    }
  }

  // What the job comes to before its report: a decision that needs no browser,
  // the untried report once a stop is pending, or the browser run.
  async function decideAndRun(job, leasedAt, settle) {
    const day = today();
    const decision = decideJob({ job, journal, sentToday: readDayCount(files.count, day), cap: cfg.dailyCap });
    if (decision.action === 'report') return { outcome: decision.outcome, reason: decision.reason };
    if (state.stop) {
      // The box is being stopped (under systemd its Chrome and Xvfb with it).
      // Nothing has been tried, so the pre-click report is the truth.
      log(`job ${job.id}: a stop is pending; reporting it untried`);
      return UNTRIED;
    }
    bumpDayCount(files.attempts, day); // throws: an attempt that cannot be counted opens no browser
    return runInBrowser(job, leasedAt, settle);
  }

  async function handleJob(job, leasedAt, extras = []) {
    const id = job && job.id;
    if (!usableId(id)) {
      log('a lease carried no usable job id; nothing can be reported for it');
      await reportUntried(extras);
      return;
    }
    // The marker goes down first, the moment the lease lands: from here on a
    // crash still ends in a report. A job without one runs nothing.
    let marked = false;
    try {
      writeCurrentJob(files.marker, id);
      marked = true;
    } catch (err) {
      log(`job ${id}: marker not written (${errText(err)}); not running it`);
    }
    log(`job ${id}: leased (number ending ${last4(job.phone)})`);
    await reportUntried(extras);
    const settle = settler(id);
    let raw = null;
    if (marked) {
      try {
        raw = await decideAndRun(job, leasedAt, settle);
      } catch (err) {
        log(`job ${id}: ${errText(err)}`);
      }
    }
    await finish(id, settle(raw));
  }

  // -- The loop ---------------------------------------------------------------

  async function pollOnce() {
    // In hand from before the GET: a stop while the server commits a lease
    // waits for the answer, so the lease gets its marker and its report
    // instead of stranding as leased with nothing on the box.
    state.inFlight = true;
    try {
      let res;
      try {
        res = await api('GET', '/api/gv-agent/pending');
      } catch (err) {
        res = { status: `error: ${errText(err)}`, body: null };
      }
      const leasedAt = clock.now(); // the job budget counts from here
      if (!(res.status === 200 && Array.isArray(res.body))) {
        if (state.lastPoll !== String(res.status)) {
          log(`pending: ${res.status}${res.status === 401 ? ' (check GV_AGENT_SECRET on both sides)' : ''}; skipping polls until it answers`);
        }
        state.lastPoll = String(res.status);
        return;
      }
      if (state.lastPoll !== 'ok' && state.lastPoll !== undefined) log('pending: answering again');
      state.lastPoll = 'ok';
      if (res.body.length === 0) return;
      const [job, ...extras] = res.body;
      await handleJob(job, leasedAt, extras);
    } finally {
      state.inFlight = false;
    }
  }

  // One pass; returns how long to wait before the next.
  async function tick() {
    // A report still owed (a crash, or one that never landed) goes first, and
    // no new lease is taken while it is owed: the marker holds one job.
    const owed = await reconcileMarker({ markerFile: files.marker, journal, report, onClick: countClick });
    if (owed) log(`job ${owed.id}: re-sent the report ${outcomeText(owed.result)}: ${owed.delivery}`);
    if (owed && owed.delivery === 'undelivered') return cfg.pollMs;
    if (!attemptBudgetOpen()) return cfg.pollMs;
    if (state.outage) {
      const pageState = await checkSession();
      if (pageState !== 'ok') return outageDelay();
      log('GV is signed in again; resuming');
      state.outage = null;
      state.outageSince = null;
    }
    await pollOnce();
    return state.outage ? outageDelay() : cfg.pollMs;
  }

  // A stop (SIGTERM, SIGINT). True when nothing is in hand and the process may
  // exit at once; false while a poll or its job is in hand, which then
  // finishes (a job it leases is reported untried) before run() returns.
  function requestStop() {
    state.stop = true;
    return !state.inFlight;
  }

  async function run() {
    if (sentIds.size > 0) log(`never-send-twice journal: ${sentIds.size} id(s)`);
    while (!state.stop) {
      let wait = cfg.pollMs;
      try {
        wait = await tick();
      } catch (err) {
        log(`loop error: ${errText(err)}`);
      }
      if (state.stop) break;
      await clock.sleep(wait);
    }
  }

  return { state, journal, tick, run, requestStop, report };
}

module.exports = { createLoop, JOB_HARD_LIMIT_MS };

// gv-agent: the box's Google Voice sender (NOT deployed to Render). Spec
// docs/superpowers/specs/2026-10-17-tt-proposal-link-via-gv-design.md.
//
// Thin wiring. Startup refuses a missing secret, a plain-http API off this box,
// a profile dir open to anyone but its owner, and a second copy of the agent on
// the same profile (startup.js). Then the real API client
// (api.js), the profile files, the clock and the Playwright launch go to the
// loop (loop.js), which coordinates the lease, the job, the report and the
// stop, and is unit tested. The per-job order and the at-most-once laws
// (journal before click, the exception rule) live in runJob.js.
//
// `--dry-run` runs three read-only stages and exits. It never clicks Send.
const path = require('path');
const { chromium } = require('playwright');
const { CFG } = require('./config');
const { clearStaleSingletons, profileInUse, loadJournal } = require('./journal');
const { finalResult } = require('./decide');
const { createApi } = require('./api');
const { createLoop } = require('./loop');
const { scrub, errText, last4 } = require('./scrub');
const {
  apiBaseProblem, prepareProfileDir, secretProblem, acquireLock, releaseLock,
} = require('./startup');
const { validPhone } = require('./validate');
const flow = require('./gvFlow');
const { captureDiag } = require('./diag');

const FILES = {
  journal: path.join(CFG.profileDir, 'gv-sent.journal'),
  marker: path.join(CFG.profileDir, 'gv-current-job.json'),
  count: path.join(CFG.profileDir, 'gv-sent-count.json'),
  attempts: path.join(CFG.profileDir, 'gv-attempt-count.json'),
};
const NAV_TIMEOUT_MS = 30000;
const DRY_RUN_HARD_LIMIT_MS = 180000;
// A stop with a poll or a job in hand waits this long for it, then exits
// anyway: the marker makes that safe (the report is re-sent at the next start).
const STOP_GRACE_MS = 60000;
const DRY_RUN_BODY = 'dry run, never sent';
const DUMMY_TOKEN = '00000000-0000-0000-0000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every line goes through scrub (spec law 11): no phone number, no token, no
// Playwright call log.
const log = (msg) => console.log(`[${new Date().toISOString()}] ${scrub(msg)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = { now: () => Date.now(), sleep };
const api = createApi({ base: CFG.apiBase, secret: CFG.secret });

// -- Browser ------------------------------------------------------------------

async function openProfile() {
  const singletons = clearStaleSingletons(CFG.profileDir, (dir) => profileInUse(dir));
  // Launching onto a profile another Chrome holds would hand our URL to that
  // window; never poke it.
  if (singletons.inUse) throw new Error('the GV profile is open in another Chrome (README: re-login)');
  if (singletons.removed.length > 0) log(`removed stale ${singletons.removed.join(', ')}`);
  const ctx = await chromium.launchPersistentContext(CFG.profileDir, { headless: false, channel: 'chrome' });
  const page = ctx.pages()[0] || await ctx.newPage();
  page.setDefaultTimeout(flow.UI_STEP_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  return { ctx, page };
}

// The loop's launch: open GV messages, run fn(page), close. At deadlineMs (an
// absolute time, so a slow launch never stretches it) the watchdog closes the
// browser, which turns any hang into a throw.
async function withGv(label, deadlineMs, fn) {
  let ctx = null;
  let timer = null;
  try {
    const opened = await openProfile();
    ctx = opened.ctx;
    timer = setTimeout(() => {
      log(`${label}: past its deadline; closing the browser`);
      ctx.close().catch(() => {});
    }, Math.max(1000, deadlineMs - Date.now()));
    await opened.page.goto(flow.GV_MESSAGES_URL, { waitUntil: 'domcontentloaded' });
    return await fn(opened.page);
  } finally {
    if (timer) clearTimeout(timer);
    if (ctx) await ctx.close().catch(() => {});
  }
}

// -- Dry run ------------------------------------------------------------------

function argValue(flag) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(flag);
  if (i >= 0) return argv[i + 1] || '';
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : '';
}

async function dryApi(report) {
  let r;
  try {
    r = await api('GET', '/api/gv-agent/pending');
  } catch (err) {
    log(`[dry-run] API: ${errText(err)}`);
    return false;
  }
  if (r.status < 200 || r.status >= 300) {
    log(`[dry-run] API: ${r.status}, expected 2xx (check API_BASE_URL and GV_AGENT_SECRET)`);
    return false;
  }
  if (!Array.isArray(r.body)) {
    log('[dry-run] API: a 2xx that is not a list');
    return false;
  }
  if (r.body.length > 0) {
    // A dry run sends nothing, so a leased row would strand as unknown with no
    // fallback. Report it untried instead: its toll-free text goes out.
    log(`[dry-run] API: the server LEASED ${r.body.length} job(s), so GV_PROPOSAL_POST_ENABLED is on there; reporting each untried`);
    const sentIds = loadJournal(FILES.journal);
    for (const job of r.body) {
      if (Number.isSafeInteger(job && job.id) && job.id > 0) {
        // A journaled id settles as clicked_unverified, never the fallback.
        await report(job.id, finalResult({ outcome: 'failed_preclick', reason: 'ui_error_before_send' }, sentIds.has(String(job.id))));
      }
    }
    return false;
  }
  log('[dry-run] API: 2xx [] (ok)');
  return true;
}

async function dryCompose(page) {
  if (!validPhone(CFG.dryRunPhone)) {
    log('[dry-run] compose: DRY_RUN_PHONE is missing or not +1 E.164');
    return false;
  }
  const composed = await flow.composeTo(page, CFG.dryRunPhone);
  if (!composed.ok) {
    log(`[dry-run] compose: ${composed.reason} (the recipient was not exactly one Send-to entry and one chip)`);
    await captureDiag(page, 'dry-run', 'compose');
    return false;
  }
  log(`[dry-run] compose: opened, recipient exactly one (ending ${last4(CFG.dryRunPhone)})`);
  let checked = { ok: false, reason: 'ui_error_before_send' };
  try {
    checked = await flow.fillAndCheck(page, DRY_RUN_BODY);
    if (!checked.ok) await captureDiag(page, 'dry-run', 'fill');
  } finally {
    const left = await flow.clearComposer(page).catch(() => null);
    log(`[dry-run] compose: ${left === '' ? 'message box cleared' : 'message box NOT cleared; empty it by hand'}`);
  }
  if (!checked.ok) {
    log(`[dry-run] compose: the fill check failed (${checked.reason})`);
    return false;
  }
  log('[dry-run] compose: body ok, Call panel empty, Send enabled (never clicked)');
  return true;
}

async function dryThread(page, threadPhone, threadToken) {
  if (!validPhone(threadPhone)) {
    log('[dry-run] thread: --thread-phone is not +1 E.164');
    return false;
  }
  if (!UUID_RE.test(threadToken)) {
    log('[dry-run] thread: --thread-token is not a uuid');
    return false;
  }
  const thread = await flow.openThreadIfAny(page, threadPhone);
  if (!thread.ok || !thread.existed) {
    log(`[dry-run] thread: not found (${thread.ok ? 'no matching conversation among the rendered list items' : thread.reason})`);
    await captureDiag(page, 'dry-run', 'thread');
    return false;
  }
  const known = await flow.threadHasToken(page, threadToken);
  const dummy = await flow.threadHasToken(page, DUMMY_TOKEN);
  log(`[dry-run] thread: found; known token ${known ? 'present' : 'MISSING'}; dummy token ${dummy ? 'PRESENT' : 'absent'}`);
  const bids = Array.isArray(thread.bidIds) ? thread.bidIds.length : 0;
  log(`[dry-run] thread: ${bids} distinct bid id(s) read from its notices${bids === 0 ? ' (none is fine for a thread we started)' : ''}`);
  if (!known || dummy) await captureDiag(page, 'dry-run', 'token');
  return known === true && dummy === false;
}

async function dryRun(report) {
  let ok = await dryApi(report);
  try {
    const browserOk = await withGv('dry run', Date.now() + DRY_RUN_HARD_LIMIT_MS, async (page) => {
      const pageState = await flow.classify(page);
      if (pageState !== 'ok') {
        log(`[dry-run] GV page: ${pageState}; sign GV in by hand (README) and re-run`);
        await captureDiag(page, 'dry-run', pageState);
        return false;
      }
      log('[dry-run] GV page: signed in');
      let stagesOk = await dryCompose(page);
      const threadPhone = argValue('--thread-phone');
      if (!threadPhone) {
        log('[dry-run] thread: skipped (no --thread-phone)');
        return stagesOk;
      }
      await page.goto(flow.GV_MESSAGES_URL, { waitUntil: 'domcontentloaded' });
      await flow.classify(page);
      stagesOk = (await dryThread(page, threadPhone, argValue('--thread-token'))) && stagesOk;
      return stagesOk;
    });
    ok = browserOk && ok;
  } catch (err) {
    log(`[dry-run] browser: ${errText(err)}`);
    ok = false;
  }
  return ok;
}

// -- Main ---------------------------------------------------------------------

async function main() {
  const problem = secretProblem(CFG.secret) || apiBaseProblem(CFG.apiBase) || prepareProfileDir(CFG.profileDir);
  if (problem) {
    log(`refusing to start: ${problem}`);
    process.exit(1);
  }
  // One agent per state dir, the dry run included (it drives the same
  // profile): taken before the marker reconcile and before any API call.
  const lock = acquireLock(CFG.profileDir);
  if (!lock.ok) {
    log(`refusing to start: ${lock.problem}`);
    process.exit(1);
  }
  process.on('exit', () => releaseLock(CFG.profileDir));
  log(`gv-agent starting${CFG.dryRun ? ' (DRY RUN: read-only, never clicks Send)' : ''}. api=${CFG.apiBase}`);
  const loop = createLoop({
    api, files: FILES, clock, launch: withGv, flow, diag: captureDiag, log, cfg: CFG,
  });
  if (CFG.dryRun) {
    const ok = await dryRun(loop.report);
    log(`dry run ${ok ? 'passed' : 'FAILED'}`);
    process.exit(ok ? 0 : 1);
  }

  // A stop between polls exits at once. One that lands while a poll or its
  // job is in hand lets it finish (the marker makes a hard stop safe anyway).
  const shutdown = () => {
    if (loop.requestStop()) process.exit(0);
    log('stop requested; finishing the poll or job in hand first');
    setTimeout(() => process.exit(0), STOP_GRACE_MS).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await loop.run();
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`fatal: ${scrub(errText(err))}`);
    process.exit(1);
  });
}

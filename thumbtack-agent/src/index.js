// Thumbtack box agent (NOT deployed to Render). One loop, two work queues:
//
//   Email harvest (original): opens each pending lead's create-price-estimate
//   page read-only and reports the customer email back (extract.js).
//
//   Auto first-reply (spec 2026-07-21): sends Dallas's saved day/night Quick
//   Reply on new leads through this logged-in session, replicating his manual
//   flow (lead page -> Quick Reply -> pick template -> Send), then reports
//   first-reply-sent so the server fires the promised call (respond-then-ring).
//
// The loop ticks at the fast reply cadence (REPLY_POLL_INTERVAL_MS, 25s); the
// harvest poll piggybacks every Nth tick (cadence.js) to keep its ~5-minute
// pace. Single browser context, single throttle, single session-recovery path.
// Human-paced (jittered delays, separate daily caps per queue). Kill switches:
// the server returns [] per queue when disabled (TT_AUTOREPLY_ENABLED /
// HARVESTER_ENABLED), and HARVESTER_ENABLED=false idles the harvest side
// locally too. `--dry-run` does one pass, logs, and writes/sends nothing.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { extractCustomerEmail } = require('./extract');
const { harvestTickEvery, isHarvestTick, rolloverDay, underCap } = require('./cadence');

const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
const CFG = {
  apiBase: (process.env.API_BASE_URL || 'http://localhost:5000').replace(/\/+$/, ''),
  secret: process.env.THUMBTACK_AGENT_SECRET || '',
  profileDir: process.env.CHROME_PROFILE_DIR || path.join(process.env.HOME || '', '.thumbtack-profile'),
  pollIntervalMs: int(process.env.POLL_INTERVAL_MS, 5 * 60 * 1000),
  replyPollIntervalMs: int(process.env.REPLY_POLL_INTERVAL_MS, 25000),
  replyDailyCap: int(process.env.REPLY_DAILY_CAP, 40),
  replyBatchLimit: int(process.env.REPLY_BATCH_LIMIT, 3),
  // Deterministic per-negotiation lead page (priceEstimateUrl precedent). The
  // template is env-tunable so the live test can correct the path without a
  // code change; {id} is replaced with the negotiation id.
  replyLeadUrlTemplate: process.env.REPLY_LEAD_URL_TEMPLATE || 'https://www.thumbtack.com/pro/inbox/{id}',
  minDelayMs: int(process.env.MIN_DELAY_MS, 8000),
  maxDelayMs: int(process.env.MAX_DELAY_MS, 25000),
  dailyCap: int(process.env.DAILY_CAP, 40),
  batchLimit: int(process.env.BATCH_LIMIT, 10),
  renderTimeoutMs: int(process.env.RENDER_TIMEOUT_MS, 20000),
  proEmailOverride: (process.env.PRO_EMAIL_OVERRIDE || '').toLowerCase() || null,
  enabled: process.env.HARVESTER_ENABLED !== 'false',
  dryRun: process.argv.includes('--dry-run'),
};

const LOGIN_RE = /log[-_]?in|sign[-_]?in|\/login|\/auth/i;
const priceEstimateUrl = (id) => `https://www.thumbtack.com/pro/messaging/priceestimate/create/${id}`;

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function mask(email) { const [u, d] = String(email).split('@'); return d ? `${u[0] || ''}***@${d}` : 'REDACTED'; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jitter() { return CFG.minDelayMs + Math.floor(Math.random() * Math.max(1, CFG.maxDelayMs - CFG.minDelayMs)); }

class SessionExpired extends Error {}

async function api(method, route, body) {
  const res = await fetch(`${CFG.apiBase}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-thumbtack-agent-secret': CFG.secret },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

async function readProEmail(page) {
  if (CFG.proEmailOverride) return CFG.proEmailOverride;
  return page.evaluate(() => {
    try { return window.__NEXT_DATA__?.props?.pageProps?.nextBaseProps?.user?.email || null; } catch { return null; }
  });
}

async function harvestOne(ctx, negotiationId, counters) {
  const page = await ctx.newPage();
  // Count every page-open toward the daily cap. The throttle is the Thumbtack-facing
  // request rate, not the success rate, so failed/expired opens must count too.
  counters.today += 1;
  try {
    await page.goto(priceEstimateUrl(negotiationId), { waitUntil: 'domcontentloaded' });
    if (LOGIN_RE.test(page.url())) {
      log(`session expired (redirected to login) at ${negotiationId}`);
      if (!CFG.dryRun) await api('POST', '/api/admin/thumbtack/harvest-failed', { negotiation_id: negotiationId, reason: 'session_expired' }).catch(() => {});
      throw new SessionExpired();
    }
    const proEmail = await readProEmail(page);
    // Apollo loads the customer email client-side; wait for a rendered email != pro.
    await page.waitForFunction((pro) => {
      const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
      const m = (document.body.innerText || '').match(re) || [];
      return m.some((e) => e.toLowerCase() !== String(pro || '').toLowerCase());
    }, proEmail, { timeout: CFG.renderTimeoutMs }).catch(() => { /* extractor will report render_timeout */ });

    const bodyText = await page.evaluate(() => document.body.innerText || '');
    const result = extractCustomerEmail({ proEmail, bodyText });

    if (CFG.dryRun) {
      const urlId = page.url().split('?')[0].split('/').filter(Boolean).pop();
      log(`[dry-run] ${negotiationId} (page id ${urlId}: ${urlId === negotiationId ? 'MATCH' : 'MISMATCH'}) -> ${result.status} ${result.customerEmail ? mask(result.customerEmail) : ''}`);
      return;
    }
    if (result.status === 'ok') {
      const r = await api('POST', '/api/admin/thumbtack/email-harvested', { negotiation_id: negotiationId, email: result.customerEmail });
      log(`${negotiationId} -> harvested ${mask(result.customerEmail)} (server ${r.status} ${r.body?.status || ''})`);
    } else {
      const reason = result.status === 'ambiguous' ? 'ambiguous' : 'render_timeout';
      await api('POST', '/api/admin/thumbtack/harvest-failed', { negotiation_id: negotiationId, reason });
      log(`${negotiationId} -> ${reason}`);
    }
  } catch (err) {
    if (err instanceof SessionExpired) throw err;
    log(`${negotiationId} navigation_error: ${err.message}`);
    if (!CFG.dryRun) await api('POST', '/api/admin/thumbtack/harvest-failed', { negotiation_id: negotiationId, reason: 'navigation_error' }).catch(() => {});
  } finally {
    await page.close().catch(() => {});
  }
}

async function pollOnce(ctx, counters) {
  const { status, body } = await api('GET', `/api/admin/thumbtack/pending-harvest?limit=${CFG.batchLimit}`);
  if (status !== 200 || !Array.isArray(body)) { log(`pending-harvest returned ${status}; skipping this poll`); return; }
  if (body.length === 0) { log('no pending leads'); return; }
  log(`${body.length} pending lead(s)`);
  for (const item of body) {
    if (counters.today >= CFG.dailyCap) { log(`daily cap ${CFG.dailyCap} reached; stopping batch`); break; }
    if (!item || !item.negotiation_id) continue;
    await harvestOne(ctx, item.negotiation_id, counters);
    await sleep(jitter());
  }
}

// ─── Auto first-reply queue (spec 2026-07-21 section 4.3) ─────────────────────

const leadInboxUrl = (id) => CFG.replyLeadUrlTemplate.replace('{id}', encodeURIComponent(id));
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Small randomized pause between UI actions so the click cadence reads human.
const humanPause = () => sleep(500 + Math.floor(Math.random() * 1200));
// Picker/Send elements render inside an already-hydrated page; shorter bound
// than the initial-hydration wait (renderTimeoutMs) but never instant.
const UI_STEP_TIMEOUT_MS = 8000;

// ── Never-send-twice ledger ───────────────────────────────────────────────────
// The lease alone cannot guarantee at-most-once: a REAL send whose report never
// lands (network blip, server restart, process death mid-flight) would re-offer
// and re-send. The journal is written just BEFORE Send is clicked and survives
// restarts (it lives in the persistent profile dir); a re-offered journaled id
// is resolved by re-POSTing the report, never by driving the UI again. Fail
// direction is deliberate: a journaled-but-never-delivered click loses at worst
// one reply (claimed sent, nothing on TT), never sends twice.
const journalPath = () => path.join(CFG.profileDir, 'first-reply-sent.journal');

function loadSentJournal() {
  try {
    const ids = fs.readFileSync(journalPath(), 'utf8').split('\n').filter(Boolean);
    // Bound the file: negotiation ids are one-shot, so only the recent tail matters.
    if (ids.length > 1000) {
      const tail = ids.slice(-500);
      fs.writeFileSync(journalPath(), `${tail.join('\n')}\n`);
      return new Set(tail);
    }
    return new Set(ids);
  } catch {
    return new Set();
  }
}

function journalSend(negotiationId, sentMemory) {
  sentMemory.add(negotiationId);
  try {
    fs.appendFileSync(journalPath(), `${negotiationId}\n`);
  } catch (err) {
    log(`journal write failed (${err.message}); in-memory guard only until restart`);
  }
}

// Post-send reports MUST land: a lost report would re-offer a job whose reply
// is already live on TT. Retries transient failures; only 2xx counts as
// delivered. A 4xx is a server-side verdict (row already flipped, secret
// rotated): retrying cannot help, and the journal still guards the re-offer.
async function apiReport(route, body, label) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const r = await api('POST', route, body);
      if (r.status >= 200 && r.status < 300) return true;
      if (r.status >= 400 && r.status < 500) { log(`${label}: server rejected ${r.status}; giving up`); return false; }
      log(`${label}: server ${r.status}; retry ${attempt}/3`);
    } catch (err) {
      log(`${label}: ${err.message}; retry ${attempt}/3`);
    }
    await sleep(2000 * attempt);
  }
  log(`${label}: REPORT UNDELIVERED after retries; the journal resolves the re-offer without re-sending`);
  return false;
}

/**
 * Drive the Quick Reply flow on an already-loaded lead page. TT is a
 * client-rendered SPA: NOTHING is in the DOM at domcontentloaded, so every
 * "element absent" judgment waits a bounded time first (the harvest side's
 * RENDER_TIMEOUT precedent); an instant count() would terminally fail every
 * live lead before hydration. Definitive failures return an enum reason;
 * transient trouble throws (lease re-offers).
 *
 * DOUBLE-SEND LAW: `markSendCommitted()` journals the id immediately before
 * Send is clicked, and everything from the click onward is caught: any
 * post-click throw (the SPA tearing down the composer mid-click is normal)
 * returns send_unverified (terminal), NEVER a release.
 */
async function sendQuickReplyOnPage(page, templateLabel, markSendCommitted) {
  const quickReply = page.getByRole('button', { name: /quick\s*repl(y|ies)/i }).first();
  const qrVisible = await quickReply.waitFor({ state: 'visible', timeout: CFG.renderTimeoutMs })
    .then(() => true).catch(() => false);
  if (!qrVisible) return { reason: 'quick_reply_unavailable' };
  await humanPause();
  await quickReply.click();

  // Saved templates render as picker entries; match the visible label
  // case-insensitively, trimmed, EXACT (day/night must not substring-match a
  // longer template name). Page-scoped until the live test pins the picker
  // container; the exact-match anchor keeps a wrong pick fail-closed.
  const exact = new RegExp(`^\\s*${escapeRegex(templateLabel)}\\s*$`, 'i');
  const option = page
    .locator('button, [role="menuitem"], [role="option"], [role="listitem"], li, label')
    .filter({ hasText: exact })
    .first();
  const optVisible = await option.waitFor({ state: 'visible', timeout: UI_STEP_TIMEOUT_MS })
    .then(() => true).catch(() => false);
  if (!optVisible) {
    // Close the picker without sending anything before reporting.
    await page.keyboard.press('Escape').catch(() => {});
    return { reason: 'template_not_found' };
  }
  await humanPause();
  await option.click();

  const send = page.getByRole('button', { name: /^\s*send\s*$/i }).first();
  const sendVisible = await send.waitFor({ state: 'visible', timeout: UI_STEP_TIMEOUT_MS })
    .then(() => true).catch(() => false);
  if (!sendVisible) {
    await page.keyboard.press('Escape').catch(() => {});
    return { reason: 'quick_reply_unavailable' };
  }
  await humanPause();

  markSendCommitted();
  try {
    await send.click();
    // Verification (live-test-tuned; spec wants the Messages thread checked):
    // composer gone = sent. Indeterminate visibility fails toward
    // send_unverified, never toward a phantom "sent".
    await sleep(3000);
    const sendStillVisible = await send.isVisible().catch(() => true);
    if (sendStillVisible) return { clickedSend: true, reason: 'send_unverified' };
    return { clickedSend: true, sent: true };
  } catch (err) {
    log(`post-click throw (${err.message}); treating as send_unverified`);
    return { clickedSend: true, reason: 'send_unverified' };
  }
}

async function replyOne(ctx, job, counters, sentMemory) {
  const negotiationId = job.negotiation_id;
  const template = String(job.first_reply_template || '').trim().toLowerCase();

  // Re-offered journaled id: the UI already reached the send point for this
  // lead in a prior attempt whose report was lost. Resolve server-side only.
  if (sentMemory.has(negotiationId)) {
    log(`reply ${negotiationId} re-offered but journaled as sent; re-reporting, NOT re-driving the UI`);
    await apiReport('/api/admin/thumbtack/first-reply-sent',
      { negotiation_id: negotiationId, template: template || 'day' }, `re-report ${negotiationId}`);
    return;
  }

  // Contract-drift guard: an empty/unknown template must never reach the UI
  // (an empty label would exact-match every blank element on the page).
  if (template !== 'day' && template !== 'night') {
    log(`reply ${negotiationId} -> template_not_found (offered template ${JSON.stringify(job.first_reply_template)})`);
    await apiReport('/api/admin/thumbtack/first-reply-failed',
      { negotiation_id: negotiationId, reason: 'template_not_found' }, `fail-report ${negotiationId}`);
    return;
  }

  const page = await ctx.newPage();
  // Page-opens count toward the reply cap (throttle = TT-facing request rate).
  counters.repliesToday += 1;
  try {
    await page.goto(leadInboxUrl(negotiationId), { waitUntil: 'domcontentloaded' });
    if (LOGIN_RE.test(page.url())) {
      log(`session expired (redirected to login) at reply ${negotiationId}`);
      throw new SessionExpired(); // transient: no report, lease re-offers after re-login
    }

    const result = await sendQuickReplyOnPage(page, template, () => journalSend(negotiationId, sentMemory));

    if (result.sent) {
      await apiReport('/api/admin/thumbtack/first-reply-sent',
        { negotiation_id: negotiationId, template }, `sent-report ${negotiationId}`);
      log(`reply ${negotiationId} -> sent (${template})`);
      return;
    }
    if (result.clickedSend) {
      // Terminal by law: Send was clicked, outcome unverifiable. The journal
      // already guards the re-offer even if this report is lost.
      await apiReport('/api/admin/thumbtack/first-reply-failed',
        { negotiation_id: negotiationId, reason: result.reason }, `unverified-report ${negotiationId}`);
      log(`reply ${negotiationId} -> ${result.reason}`);
      return;
    }

    // Pre-send definitive failure. Classify against late SPA settling before
    // making it terminal: a client-side login bounce releases instead
    // (SessionExpired), and a URL that no longer carries the negotiation id is
    // the deterministic-navigation miss (lead_not_found), not a missing button.
    // The Jobs-page name-match fallback is DELIBERATELY not implemented: with
    // only customer_name to match, same-name leads are indistinguishable, and
    // the fail-closed law says never guess. The live test tunes
    // REPLY_LEAD_URL_TEMPLATE instead (env, no code change).
    const landed = page.url();
    if (LOGIN_RE.test(landed)) {
      log(`session expired (late bounce) at reply ${negotiationId}`);
      throw new SessionExpired();
    }
    const urlCarriesId = landed.includes(negotiationId) || landed.includes(encodeURIComponent(negotiationId));
    const reason = urlCarriesId ? result.reason : 'lead_not_found';
    // Pre-send reports are single-shot on purpose: nothing was sent, so a lost
    // report just re-offers after the cooldown (bounded by the attempts cap).
    const r = await api('POST', '/api/admin/thumbtack/first-reply-failed', { negotiation_id: negotiationId, reason });
    log(`reply ${negotiationId} -> ${reason} (server ${r.status})`);
  } catch (err) {
    if (err instanceof SessionExpired) throw err;
    // Transient (navigation flake, detached frame) BEFORE any send commit:
    // say nothing, the lease cooldown re-offers and the offer-side attempts
    // cap bounds retries. Post-click throws never reach here (caught above).
    log(`reply ${negotiationId} transient error: ${err.message}`);
  } finally {
    await page.close().catch(() => {});
  }
}

async function pollReplies(ctx, counters, sentMemory) {
  // Dry-run must stay side-effect-free, and the offer GET is NOT free: it
  // leases the row and burns 1 of 3 offer attempts server-side.
  if (CFG.dryRun) { log('[dry-run] reply queue NOT polled (the offer itself leases + bumps attempts server-side)'); return; }
  // At-cap: do not even poll. The offer's lease+bump is destructive to burn
  // on jobs this process has already decided not to work.
  if (!underCap(counters.repliesToday, CFG.replyDailyCap)) return;

  // Never lease more than the remaining cap slots (push-review finding: with
  // one slot left, a limit-3 offer would lease-and-strand two jobs, burning
  // their attempts toward the failed flip without ever opening Thumbtack).
  const remaining = Math.max(1, CFG.replyDailyCap - counters.repliesToday);
  const batch = Math.min(CFG.replyBatchLimit, remaining);
  const { status, body } = await api('GET', `/api/admin/thumbtack/pending-first-replies?limit=${batch}`);
  if (status !== 200 || !Array.isArray(body)) { log(`pending-first-replies returned ${status}; skipping`); return; }
  if (body.length === 0) return; // quiet: this polls every 25s
  log(`${body.length} pending first repl${body.length === 1 ? 'y' : 'ies'}`);
  for (const job of body) {
    if (!underCap(counters.repliesToday, CFG.replyDailyCap)) { log(`reply daily cap ${CFG.replyDailyCap} reached; stopping batch`); break; }
    if (!job || !job.negotiation_id) continue;
    await replyOne(ctx, job, counters, sentMemory);
    await sleep(jitter());
  }
}

async function main() {
  if (!CFG.secret) { console.error('THUMBTACK_AGENT_SECRET is required'); process.exit(1); }
  log(`Thumbtack harvester agent starting${CFG.dryRun ? ' (DRY RUN, writes nothing)' : ''}. profile=${CFG.profileDir} api=${CFG.apiBase}`);
  const ctx = await chromium.launchPersistentContext(CFG.profileDir, { headless: false, channel: 'chrome' });
  const counters = { today: 0, repliesToday: 0, day: new Date().getUTCDate() };
  const sentMemory = loadSentJournal();
  if (sentMemory.size > 0) log(`never-send-twice journal: ${sentMemory.size} id(s) loaded`);
  // Loop ticks at the fast reply cadence; harvest piggybacks every Nth tick.
  const harvestEvery = harvestTickEvery(CFG.pollIntervalMs, CFG.replyPollIntervalMs);
  let tick = 0;
  log(`cadence: reply poll every ${CFG.replyPollIntervalMs}ms, harvest every ${harvestEvery} tick(s)`);

  let stop = false;
  let shuttingDown = false;
  const shutdown = async () => { shuttingDown = true; stop = true; try { await ctx.close(); } catch { /* ignore */ } process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Self-heal a dead browser. If Chrome exits (crash, OOM, or an external Chrome opening
  // this same profile and stealing the singleton lock), the persistent context is
  // permanently unusable: every newPage() throws "Target ... has been closed" forever
  // while the poll loop keeps logging "no pending leads", so the agent looks healthy but
  // harvests nothing until a human restarts it. This silently ate real leads more than once.
  // Exit non-zero the instant the browser drops; systemd (Restart=on-failure, RestartSec)
  // relaunches a fresh browser. Firing on 'close'/'disconnected' recovers even while idle,
  // so the browser never sits dead between leads.
  const bailDeadBrowser = (why) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`browser lost (${why}); exiting for systemd restart`);
    process.exit(1);
  };
  ctx.on('close', () => bailDeadBrowser('context closed'));
  const startupBrowser = ctx.browser();
  if (startupBrowser) startupBrowser.on('disconnected', () => bailDeadBrowser('browser disconnected'));

  while (!stop) {
    // Belt-and-suspenders: catch a browser that dropped without emitting close/disconnected.
    const liveBrowser = ctx.browser();
    if (liveBrowser && !liveBrowser.isConnected()) bailDeadBrowser('browser not connected at poll start');
    rolloverDay(counters, new Date().getUTCDate()); // reset both caps at UTC midnight

    try {
      // Replies every tick (the server returns [] when TT_AUTOREPLY_ENABLED
      // is off, so a disabled feature costs one cheap request per tick).
      await pollReplies(ctx, counters, sentMemory);

      // Harvest on its original cadence, piggybacked. HARVESTER_ENABLED only
      // idles the harvest side; the reply queue keeps its own server switch.
      if (isHarvestTick(tick, harvestEvery)) {
        if (!CFG.enabled) log('HARVESTER_ENABLED=false; skipping harvest tick');
        else await pollOnce(ctx, counters);
      }
    } catch (err) {
      if (err instanceof SessionExpired) {
        log('batch stopped: session expired. Re-login via RDP into this profile. Backing off.');
        tick += 1;
        await sleep(Math.max(CFG.pollIntervalMs, 15 * 60 * 1000));
        continue;
      }
      // A closed/disconnected browser surfaces here (e.g. ctx.newPage after Chrome died).
      // Restart rather than loop a permanently-dead context.
      if (/target.*closed|has been closed|browser.*disconnected|browsercontext\./i.test(err.message || '')) {
        bailDeadBrowser(err.message);
      }
      log(`poll error: ${err.message}`);
    }
    tick += 1;
    if (CFG.dryRun) break; // one pass, then exit
    await sleep(CFG.replyPollIntervalMs);
  }
  shuttingDown = true; // suppress the close-handler's restart on our own clean shutdown
  await ctx.close().catch(() => {});
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });

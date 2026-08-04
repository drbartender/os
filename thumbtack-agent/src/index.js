// Thumbtack box agent (NOT deployed to Render). One loop, two work queues:
//
//   Email harvest (original): opens each pending lead's create-price-estimate
//   page read-only and reports the customer email back (extract.js).
//
//   Auto first-reply (spec 2026-07-21; flow rebuilt 2026-08-03): sends Dallas's
//   saved day/night Quick Reply on new leads through this logged-in session,
//   replicating his real manual flow: a pristine lead has NO composer until the
//   respond CTA is clicked; TT then streams an AI draft that must be Cleared;
//   only then do Quick Reply -> pick template -> Send exist. Reports
//   first-reply-sent so the server fires the promised call (respond-then-ring).
//
// The loop ticks at the fast reply cadence (REPLY_POLL_INTERVAL_MS, 25s); the
// harvest poll fires on its own wall-clock pace (POLL_INTERVAL_MS) to keep its
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
const { rolloverDay, underCap } = require('./cadence');

const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
// A label allowlist that parses to empty is a misconfig, not a kill switch:
// fall back to the default loudly so the flow never crashes on a null locator.
function parseLabels(envValue, dflt, name) {
  const parse = (s) => String(s).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const labels = parse(envValue || dflt);
  if (labels.length > 0) return labels;
  console.warn(`[cfg] ${name} parsed to an empty list; using the default (disable replies via TT_AUTOREPLY_ENABLED, not an empty allowlist)`);
  return parse(dflt);
}
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
  replyLeadUrlTemplate: process.env.REPLY_LEAD_URL_TEMPLATE || 'https://www.thumbtack.com/pro-inbox/messages/{id}',
  // Respond-CTA / Clear-control label allowlists (exact-match, case-insensitive,
  // PRIORITY-ORDERED: earlier labels are preferred when several are on the page).
  // Env-tunable so the first live lead pins the real labels without a code
  // change (REPLY_LEAD_URL_TEMPLATE precedent). No allowlist match = no click,
  // and a label list that parses to empty falls back to the default (an empty
  // list is a misconfig, not a kill switch — that's TT_AUTOREPLY_ENABLED).
  replyCtaLabels: parseLabels(process.env.REPLY_CTA_LABELS,
    'view and reply,reply,respond,approve,accept,respond to lead,accept lead,view and respond', 'REPLY_CTA_LABELS'),
  replyClearLabels: parseLabels(process.env.REPLY_CLEAR_LABELS, 'clear', 'REPLY_CLEAR_LABELS'),
  // Composer-textarea placeholder fragments (case-insensitive substring, any
  // match). Two live-pinned shapes so far: the answered-thread composer
  // ("Type message", pro-inbox 8/03) and the pristine-lead respond panel
  // ("Answer any questions and let them know next steps.", pro-leads 8/03).
  replyComposerPlaceholders: parseLabels(process.env.REPLY_COMPOSER_PLACEHOLDERS,
    'type message,answer any questions', 'REPLY_COMPOSER_PLACEHOLDERS'),
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
// Upper bound on the clear-the-AI-draft phase: TT streams its suggested reply
// into the freshly-created composer; we keep clicking Clear / re-reading until
// the box is provably empty or this window closes (then fail-closed, no send).
const AI_DRAFT_WAIT_MS = 15000;
// Post-send verification window: the sent template must appear as a thread
// message (the composer persists after a real send, so its absence proves nothing).
const SEND_VERIFY_WAIT_MS = 12000;

const exactLabelRe = (label) => new RegExp(`^\\s*${escapeRegex(label)}\\s*$`, 'i');

// One locator matching ANY allowlisted label as a button or link, exact-text.
// Used ONLY as a presence signal (the settle wait); clicks go through
// pickByLabelPriority, never through a blind DOM-order .first().
function anyLabelLocator(page, labels) {
  let loc = null;
  for (const label of labels) {
    const re = exactLabelRe(label);
    const cand = page.getByRole('button', { name: re }).or(page.getByRole('link', { name: re }));
    loc = loc ? loc.or(cand) : cand;
  }
  return loc;
}

// Resolve WHICH allowlisted control to click (push-fleet finding, 2026-08-03):
// labels are tried in configured order (earlier = preferred, so 'respond'
// beats 'accept' when both are on the page), only VISIBLE matches count, and
// a label with 2+ visible matches is ambiguous — on a billing surface we
// never guess which one, we fail closed and let the diag capture pin it.
// Returns { locator } | { ambiguous: label } | null (no visible match at all).
async function pickByLabelPriority(page, labels) {
  for (const label of labels) {
    const re = exactLabelRe(label);
    const matches = page.getByRole('button', { name: re }).or(page.getByRole('link', { name: re }))
      .filter({ visible: true });
    const count = await matches.count().catch(() => 0);
    if (count === 1) return { locator: matches.first(), label };
    if (count > 1) return { ambiguous: label };
  }
  return null;
}

// Filesystem-safe id for diag filenames: negotiation ids come from the TT
// webhook body and are untrusted (the server's logId precedent).
const fsSafeId = (s) => String(s).replace(/[^\w-]/g, '').slice(0, 64) || 'unknown';

// The message composer textarea, located by placeholder (env-tunable list —
// TT uses DIFFERENT placeholders per surface; see replyComposerPlaceholders).
// Returns its current value, or null when no such box is visible — callers
// treat null as "cannot prove composer state" and fail closed.
async function composerText(page) {
  const re = new RegExp(CFG.replyComposerPlaceholders.map(escapeRegex).join('|'), 'i');
  const box = page.getByPlaceholder(re).filter({ visible: true }).first();
  if (!(await box.isVisible().catch(() => false))) return null;
  return box.inputValue().catch(() => null);
}

// TT sometimes pops a lead-survey dialog ("initial impression of this lead")
// over the thread. Dismiss ONLY dialogs matching survey copy — the quick-reply
// picker is a dialog too and must never be Escaped here.
async function dismissSurveyDialog(page) {
  const survey = page.locator('[role="dialog"]')
    .filter({ hasText: /initial impression|impression of this lead|rate this lead/i }).first();
  if (await survey.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(800);
    return true;
  }
  return false;
}

// Diagnostic snapshot on definitive failures: screenshot + control dump into
// the profile dir (survives restarts, off-repo). The next fresh lead pins any
// label this build guessed wrong. Bounded, and never throws into the flow.
const DIAG_KEEP_FILES = 40;
async function captureDiag(page, negotiationId, tag) {
  try {
    const dir = path.join(CFG.profileDir, 'diag');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(dir, `${stamp}-${fsSafeId(negotiationId)}-${tag}`);
    await page.screenshot({ path: `${base}.png`, fullPage: false }).catch(() => {});
    const facts = await page.evaluate(() => ({
      url: location.href,
      buttons: Array.from(document.querySelectorAll('button, [role="button"], a'))
        .map((b) => ({ text: (b.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60), aria: b.getAttribute('aria-label') }))
        .filter((b) => b.text || b.aria).slice(0, 80),
      textareas: Array.from(document.querySelectorAll('textarea, [contenteditable="true"]'))
        .map((t) => ({ tag: t.tagName, placeholder: t.getAttribute('placeholder'), len: (t.value || t.innerText || '').length })),
    })).catch(() => null);
    if (facts) fs.writeFileSync(`${base}.json`, JSON.stringify(facts, null, 1));
    const files = fs.readdirSync(dir).sort();
    for (const f of files.slice(0, Math.max(0, files.length - DIAG_KEEP_FILES))) {
      fs.unlinkSync(path.join(dir, f));
    }
    log(`diag captured: ${tag} (${base}.png)`);
  } catch (err) {
    log(`diag capture failed (${err.message})`);
  }
}

// Kill TT's streamed AI draft (when one streams — the pro-leads respond panel
// opened empty on the 8/03 live lead) and PROVE the composer empty before any
// pick. Empty is proven FIRST, read twice with a beat between so a mid-stream
// read can never slip an AI fragment into the send; Clear is clicked only
// when there is actually text to clear, so an ambiguous pair of Clear
// controls can only block a draft that genuinely needs clearing.
// Returns 'empty' or 'clear_failed'.
async function clearAiDraft(page) {
  await sleep(2500); // let streaming begin; an instant read would race it
  const deadline = Date.now() + AI_DRAFT_WAIT_MS; // budget starts AFTER the settle beat
  while (Date.now() < deadline) {
    const text = await composerText(page);
    if (text === '') {
      await sleep(1500);
      if ((await composerText(page)) === '') return 'empty';
      continue; // stream landed mid-proof; go clear it
    }
    if (text) {
      const clear = await pickByLabelPriority(page, CFG.replyClearLabels);
      if (clear && clear.ambiguous) return 'clear_failed'; // two Clears = never guess
      if (clear) {
        await humanPause();
        await clear.locator.click().catch(() => {});
        await sleep(1200);
        continue;
      }
    }
    await sleep(700); // null (composer unreadable yet) or no Clear control yet
  }
  return 'clear_failed';
}

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

// Precise pre-send reasons added 2026-08-03 need a server enum extension that
// rides the next os deploy. Until it lands (or across any skewed rollout), a
// 400 'invalid reason' downgrades ONCE to the nearest legacy reason so the
// report still flips the row (and the day-lead call still fires).
const LEGACY_REASON_FALLBACK = {
  already_replied: 'quick_reply_unavailable',
  response_cta_not_found: 'quick_reply_unavailable',
  ai_draft_clear_failed: 'quick_reply_unavailable',
};

// Pre-send failure report: single-shot on purpose (nothing was sent; a lost
// report just re-offers after the cooldown, bounded by the attempts cap).
// The downgrade fires ONLY on the server's literal invalid-reason verdict
// (push-fleet M3): any other 400 is a real bug that must stay loud, not be
// silently rewritten into quick_reply_unavailable.
async function reportPreSendFailure(negotiationId, reason) {
  const post = (r) => api('POST', '/api/admin/thumbtack/first-reply-failed', { negotiation_id: negotiationId, reason: r });
  let res;
  try { res = await post(reason); } catch (err) { return { status: 0, error: err.message }; }
  const invalidReason = res.status === 400 && /invalid reason/i.test(String(res.body?.error || ''));
  if (invalidReason && LEGACY_REASON_FALLBACK[reason]) {
    log(`fail-report ${negotiationId}: server rejected reason "${reason}"; downgrading to "${LEGACY_REASON_FALLBACK[reason]}"`);
    try { res = await post(LEGACY_REASON_FALLBACK[reason]); } catch (err) { return { status: 0, error: err.message }; }
  }
  return res;
}

/**
 * Drive the first reply on an already-loaded lead page, replicating the real
 * manual flow (Dallas, 2026-08-03): a pristine lead renders NO composer; the
 * respond CTA creates it; TT then streams an AI draft that must be Cleared;
 * only then do Quick Reply -> pick day/night -> Send exist. TT is a
 * client-rendered SPA: NOTHING is in the DOM at domcontentloaded, so every
 * "element absent" judgment waits a bounded time first. Definitive failures
 * return an enum reason; transient trouble throws (lease re-offers).
 *
 * BACK-OFF LAW (2026-08-03, after 6 confirmed double-sends): a composer that
 * already exists ON ARRIVAL means the lead was already answered (the composer
 * only exists after a response) — return already_replied, never send.
 *
 * DOUBLE-SEND LAW: `markSendCommitted()` journals the id immediately before
 * Send is clicked, and everything from the click onward is caught: any
 * post-click throw (the SPA tearing down the composer mid-click is normal)
 * returns send_unverified (terminal), NEVER a release.
 */
async function sendQuickReplyOnPage(page, negotiationId, templateLabel, markSendCommitted) {
  await dismissSurveyDialog(page);

  const quickReply = page.getByRole('button', { name: /quick\s*repl(y|ies)/i })
    .filter({ visible: true }).first();
  const ctaAny = anyLabelLocator(page, CFG.replyCtaLabels).filter({ visible: true }).first();

  // Settle the page state: EITHER the composer (already answered) or the
  // respond CTA (pristine) must appear; neither is the old dead-end.
  let settled = await quickReply.or(ctaAny).first().waitFor({ state: 'visible', timeout: CFG.renderTimeoutMs })
    .then(() => true).catch(() => false);
  if (!settled) {
    await dismissSurveyDialog(page); // a late survey dialog can mask both controls
    settled = await quickReply.or(ctaAny).first().waitFor({ state: 'visible', timeout: UI_STEP_TIMEOUT_MS })
      .then(() => true).catch(() => false);
  }
  if (!settled) {
    await captureDiag(page, negotiationId, 'no-cta-no-composer');
    return { reason: 'quick_reply_unavailable' };
  }

  // BACK-OFF probe with a real bound (push-fleet H1): the settle wait returns
  // the instant EITHER control paints, and on a mid-hydration SPA the CTA can
  // paint a beat before Quick Reply on an ALREADY-ANSWERED thread. An instant
  // isVisible() here would misread that thread as pristine and double-send —
  // the exact harm this guard exists to stop. Give the composer a bounded
  // window to declare itself before concluding pristine.
  const answered = await quickReply.waitFor({ state: 'visible', timeout: 2500 })
    .then(() => true).catch(() => false);
  if (answered) {
    await captureDiag(page, negotiationId, 'already-replied');
    return { reason: 'already_replied' };
  }

  // Pristine lead: the respond CTA creates the composer. Resolve WHICH control
  // to click by label priority; ambiguity (or nothing visible despite the
  // settle) fails closed — on a billing surface we never guess.
  const cta = await pickByLabelPriority(page, CFG.replyCtaLabels);
  if (!cta || cta.ambiguous) {
    await captureDiag(page, negotiationId, cta ? `ambiguous-cta-${fsSafeId(cta.ambiguous)}` : 'cta-vanished');
    return { reason: 'response_cta_not_found' };
  }
  log(`reply ${negotiationId}: clicking respond CTA "${cta.label}" on ${page.url()}`);
  await humanPause();
  await cta.locator.click();
  let composerUp = await quickReply.waitFor({ state: 'visible', timeout: CFG.renderTimeoutMs })
    .then(() => true).catch(() => false);
  if (!composerUp) {
    await dismissSurveyDialog(page);
    composerUp = await quickReply.waitFor({ state: 'visible', timeout: UI_STEP_TIMEOUT_MS })
      .then(() => true).catch(() => false);
  }
  if (!composerUp) {
    await captureDiag(page, negotiationId, 'post-cta-no-composer');
    return { reason: 'response_cta_not_found' };
  }

  // Kill the streamed AI draft; NEVER send with unproven composer contents.
  const draftState = await clearAiDraft(page);
  if (draftState !== 'empty') {
    await captureDiag(page, negotiationId, 'ai-draft-not-cleared');
    return { reason: 'ai_draft_clear_failed' };
  }

  await humanPause();
  await quickReply.click();

  // Saved templates render as picker entries; match the visible label
  // case-insensitively, trimmed, EXACT (day/night must not substring-match a
  // longer template name). Page-scoped until the live test pins the picker
  // container; the exact-match anchor keeps a wrong pick fail-closed.
  const exact = new RegExp(`^\\s*${escapeRegex(templateLabel)}\\s*$`, 'i');
  let option = page
    .locator('button, [role="menuitem"], [role="option"], [role="listitem"], li, label')
    .filter({ hasText: exact })
    .first();
  let optVisible = await option.waitFor({ state: 'visible', timeout: UI_STEP_TIMEOUT_MS })
    .then(() => true).catch(() => false);
  if (!optVisible) {
    // Live-pinned 2026-07-22: the Quick-replies picker renders each saved
    // template as an <a> wrapping title + preview in one node, so nothing in
    // the list above ever carries the bare label. Match the innermost element
    // whose ENTIRE text is the label (the entry title); the click bubbles to
    // the anchor. Exact-match keeps a wrong pick fail-closed, and a live scan
    // found the two picker titles as the only whole-text label matches on the
    // page.
    option = page.getByText(exact).first();
    optVisible = await option.waitFor({ state: 'visible', timeout: UI_STEP_TIMEOUT_MS })
      .then(() => true).catch(() => false);
  }
  if (!optVisible) {
    // Close the picker without sending anything before reporting.
    await captureDiag(page, negotiationId, 'template-not-in-picker');
    await page.keyboard.press('Escape').catch(() => {});
    return { reason: 'template_not_found' };
  }
  await humanPause();
  await option.click();

  // The pick fills the (proven-empty) composer, so whatever text appears IS
  // the template. Capture it: it anchors the post-send verification.
  let filledText = null;
  {
    const deadline = Date.now() + UI_STEP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const text = await composerText(page);
      if (text && text.trim().length >= 20) { filledText = text; break; }
      await sleep(400);
    }
  }
  if (!filledText) {
    await captureDiag(page, negotiationId, 'template-fill-missing');
    await page.keyboard.press('Escape').catch(() => {});
    return { reason: 'quick_reply_unavailable' };
  }

  const send = page.getByRole('button', { name: /^\s*send\s*$/i }).first();
  const sendVisible = await send.waitFor({ state: 'visible', timeout: UI_STEP_TIMEOUT_MS })
    .then(() => true).catch(() => false);
  if (!sendVisible) {
    await captureDiag(page, negotiationId, 'send-button-missing');
    await page.keyboard.press('Escape').catch(() => {});
    return { reason: 'quick_reply_unavailable' };
  }
  await humanPause();

  markSendCommitted();
  try {
    await send.click();
    // POSITIVE verification (rebuilt 2026-08-03): the composer PERSISTS after
    // a real send (live-pinned on a responded thread), so the old "Send button
    // gone = sent" check false-failed 6 confirmed real deliveries. Proof of
    // send = the captured template text appears as a thread message AND the
    // composer emptied. Indeterminate still fails toward send_unverified,
    // never toward a phantom "sent".
    const words = filledText.trim().split(/\s+/).slice(0, 8).map(escapeRegex);
    const snippetRe = new RegExp(words.join('\\s+'), 'i');
    const deadline = Date.now() + SEND_VERIFY_WAIT_MS;
    while (Date.now() < deadline) {
      // STRICTLY '' — null means "cannot prove composer state" (box absent,
      // detached, placeholder changed) and must never count as emptied
      // (push-fleet + codex converged finding: a null here plus a text match
      // elsewhere would manufacture a phantom "sent").
      const boxText = await composerText(page);
      const inThread = await page.getByText(snippetRe).filter({ visible: true }).first()
        .isVisible().catch(() => false);
      if (inThread && boxText === '') return { clickedSend: true, sent: true };
      await sleep(800);
    }
    await captureDiag(page, negotiationId, 'send-unverified');
    return { clickedSend: true, reason: 'send_unverified' };
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
  // Bound click actionability retries (perf-fleet F2): Playwright's 30s default
  // on a covered/unstable element could stretch a 3-job batch past the 10-min
  // lease cooldown. Explicit waitFor timeouts elsewhere are unaffected;
  // navigation keeps its own default.
  page.setDefaultTimeout(UI_STEP_TIMEOUT_MS);
  // Page-opens count toward the reply cap (throttle = TT-facing request rate).
  counters.repliesToday += 1;
  try {
    await page.goto(leadInboxUrl(negotiationId), { waitUntil: 'domcontentloaded' });
    if (LOGIN_RE.test(page.url())) {
      log(`session expired (redirected to login) at reply ${negotiationId}`);
      throw new SessionExpired(); // transient: no report, lease re-offers after re-login
    }

    const result = await sendQuickReplyOnPage(page, negotiationId, template, () => journalSend(negotiationId, sentMemory));

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
    const r = await reportPreSendFailure(negotiationId, reason);
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
  // Loop ticks at the fast reply cadence; harvest fires on WALL-CLOCK, not
  // tick count (perf-fleet F1): a busy reply arm stretches ticks far past 25s,
  // and tick-counting would stretch the ~5-min harvest pace with it — starving
  // the email-capture path exactly when leads are flowing.
  let lastHarvestAt = 0; // epoch ms; 0 = harvest on the first pass
  log(`cadence: reply poll every ${CFG.replyPollIntervalMs}ms, harvest every ${CFG.pollIntervalMs}ms wall-clock`);

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

      // Harvest on its original wall-clock pace. HARVESTER_ENABLED only
      // idles the harvest side; the reply queue keeps its own server switch.
      if (Date.now() - lastHarvestAt >= CFG.pollIntervalMs) {
        lastHarvestAt = Date.now();
        if (!CFG.enabled) log('HARVESTER_ENABLED=false; skipping harvest pass');
        else await pollOnce(ctx, counters);
      }
    } catch (err) {
      if (err instanceof SessionExpired) {
        log('batch stopped: session expired. Re-login via RDP into this profile. Backing off.');
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
    if (CFG.dryRun) break; // one pass, then exit
    await sleep(CFG.replyPollIntervalMs);
  }
  shuttingDown = true; // suppress the close-handler's restart on our own clean shutdown
  await ctx.close().catch(() => {});
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });

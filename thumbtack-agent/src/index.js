// Thumbtack email-harvester agent. Box-only (NOT deployed to Render). Polls the os
// API for pending leads, opens each lead's create-price-estimate page in a persistent
// logged-in Chrome profile, reads the customer email (selector-free, via extract.js),
// and reports the result back. Read-only on Thumbtack: it only OPENS the page, never
// submits the form. Human-paced (jittered delays, daily cap). Dual kill-switch: the
// server returns [] when disabled, and HARVESTER_ENABLED=false idles the agent too.
// `--dry-run` does one pass, logs masked results, and writes nothing.
require('dotenv').config();
const path = require('path');
const { chromium } = require('playwright');
const { extractCustomerEmail } = require('./extract');

const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
const CFG = {
  apiBase: (process.env.API_BASE_URL || 'http://localhost:5000').replace(/\/+$/, ''),
  secret: process.env.THUMBTACK_AGENT_SECRET || '',
  profileDir: process.env.CHROME_PROFILE_DIR || path.join(process.env.HOME || '', '.thumbtack-profile'),
  pollIntervalMs: int(process.env.POLL_INTERVAL_MS, 5 * 60 * 1000),
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

async function main() {
  if (!CFG.secret) { console.error('THUMBTACK_AGENT_SECRET is required'); process.exit(1); }
  log(`Thumbtack harvester agent starting${CFG.dryRun ? ' (DRY RUN, writes nothing)' : ''}. profile=${CFG.profileDir} api=${CFG.apiBase}`);
  const ctx = await chromium.launchPersistentContext(CFG.profileDir, { headless: false, channel: 'chrome' });
  const counters = { today: 0, day: new Date().getUTCDate() };

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
    const day = new Date().getUTCDate();
    if (day !== counters.day) { counters.today = 0; counters.day = day; } // reset at UTC midnight

    if (!CFG.enabled) {
      log('HARVESTER_ENABLED=false; idling');
      if (CFG.dryRun) break;
      await sleep(CFG.pollIntervalMs);
      continue;
    }
    try {
      await pollOnce(ctx, counters);
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
    await sleep(CFG.pollIntervalMs);
  }
  shuttingDown = true; // suppress the close-handler's restart on our own clean shutdown
  await ctx.close().catch(() => {});
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });

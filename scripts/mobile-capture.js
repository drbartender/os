#!/usr/bin/env node
/*
 * Mobile verification harness. Renders every client-facing surface at a phone
 * viewport (390x844), screenshots it, and probes for horizontal overflow.
 * Merge gate for the mobile-fixes lanes.
 *
 * Spec: docs/superpowers/specs/2026-07-02-mobile-fixes-design.md (Lane 0)
 * Plan: docs/superpowers/plans/2026-07-03-mobile-fixes.md (Task A1)
 *
 * Usage:  npm run mobile:check                 # all manifest pages
 *         npm run mobile:check -- --only home,quote
 *
 * DEV-ONLY BY CONSTRUCTION: exits before connecting to anything if NODE_ENV is
 * production or DATABASE_URL does not point at the known dev branch. Mints dev
 * JWTs from .env JWT_SECRET; output screenshots contain dev-DB data and land in
 * the gitignored /mobile-audit/ directory. Expected to stay RED on main until
 * the mobile-sweep lane lands (the baseline failures are the audited P0s).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { URL } = require('node:url');

function die(msg) { console.error('[mobile:check] ' + msg); process.exit(1); }

// ---- Environment gate: BEFORE any DB connection or token minting ----
if (process.env.NODE_ENV === 'production') die('refusing to run: NODE_ENV=production');
if (!process.env.DATABASE_URL) die('DATABASE_URL missing');
if (!process.env.JWT_SECRET) die('JWT_SECRET missing');
const DEV_DB_HOSTS = ['ep-old-feather-adoh3rf3-pooler.c-2.us-east-1.aws.neon.tech'];
const dbHost = new URL(process.env.DATABASE_URL).hostname;
if (!DEV_DB_HOSTS.includes(dbHost)) die(`refusing to run: DATABASE_URL host "${dbHost}" is not the dev branch`);

const { chromium } = require('playwright-core');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'mobile-capture.manifest.json'), 'utf8'));
const OUT = path.join(__dirname, '..', 'mobile-audit');
fs.mkdirSync(OUT, { recursive: true });

const only = (() => { const i = process.argv.indexOf('--only'); return i > -1 ? process.argv[i + 1].split(',') : null; })();

function mintToken(auth) {
  const a = manifest.accounts[auth];
  if (!a) die(`unknown auth kind "${auth}" (not in manifest.accounts)`);
  const payload = auth === 'client'
    ? { id: a.id, role: 'client', tokenVersion: a.tokenVersion }
    : { userId: a.id, tokenVersion: a.tokenVersion };
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '2h' });
}

async function probe(page, allowSelectors) {
  return page.evaluate((allow) => {
    const vw = window.innerWidth;
    const allowed = (el) => allow.some((sel) => el.closest(sel));
    const out = { scrollW: document.documentElement.scrollWidth, offRight: [], smallTaps: 0, tinyText: 0 };
    // Deliberately STRICT: any element painted past the right edge is flagged
    // unless its container is explicitly allow-listed in the manifest
    // (scrollableAllow). Clipped-but-off-screen CONTENT (overlapping stepper
    // labels, nav items cut off by an overflow:hidden ancestor) is exactly the
    // defect class this harness exists to catch, so "it's clipped" is never an
    // automatic excuse; intentional crops get a named allow entry instead.
    document.querySelectorAll('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 2 && !allowed(el) && out.offRight.length < 10) {
        const cls = typeof el.className === 'string' ? el.className.split(' ').slice(0, 3).join('.') : '';
        out.offRight.push(el.tagName.toLowerCase() + (cls ? '.' + cls : '') + ' right=' + Math.round(r.right));
      }
    });
    document.querySelectorAll('a,button,input,select,textarea,[role="button"]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && (r.height < 36 || r.width < 36)) out.smallTaps++;
    });
    document.querySelectorAll('p,span,li,td,label,a').forEach((el) => {
      if (el.children.length === 0 && el.textContent.trim().length > 10
          && parseFloat(getComputedStyle(el).fontSize) < 12) out.tinyText++;
    });
    return out;
  }, allowSelectors);
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const browser = await chromium.launch({ executablePath: manifest.chromePath, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const results = [];

  // Per-page spoofed X-Forwarded-For: the server runs `trust proxy 1`, so a
  // direct localhost connection takes this header as the client IP. Each page
  // gets its own rate-limiter key (publicLimiter allows only 20 req/15min per
  // IP, far less than a 40-page run fires), and the second octet varies per run
  // so back-to-back runs do not share keys. Dev-only by nature: the harness
  // already refuses to run outside the dev environment.
  const RUN_OCT = Math.floor(Date.now() / 1000) % 250;
  let pageIdx = 0;

  for (const entry of manifest.pages) {
    if (only && !only.includes(entry.name)) continue;
    if (entry.skipped) { results.push({ name: entry.name, status: 'skipped', reason: entry.skipped }); continue; }
    pageIdx += 1;
    let urlPath = entry.path;
    if (entry.tokenQuery) {
      const { rows } = await pool.query(entry.tokenQuery);
      if (!rows[0] || !rows[0].token) { results.push({ name: entry.name, status: 'no-data' }); continue; }
      urlPath = entry.path.replace(':token', rows[0].token);
    }
    const origin = `http://${entry.host}:3000`;
    // Fresh page per entry; the auth token is planted via addInitScript BEFORE
    // any app code runs. A visible "visit / then setItem" navigation would race
    // the auth context's validate-and-remove on a slow dev server and flakily
    // wipe the token (observed on portal-archive in full runs).
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 120)); });
    await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${RUN_OCT}.${Math.floor(pageIdx / 250)}.${(pageIdx % 250) + 1}` });
    if (entry.auth && entry.auth !== 'none') {
      const key = entry.auth === 'client' ? 'db_client_token' : 'token';
      await page.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) {} }, [key, mintToken(entry.auth)]);
    }
    try {
      await page.goto(origin + urlPath, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(entry.settleMs || 2200);
      // Text metrics (and therefore overflow) shift once the display fonts load;
      // without this, a slow font fetch makes overflow checks non-deterministic.
      await page.evaluate(() => (document.fonts ? document.fonts.ready : null)).catch(() => {});
      await page.waitForTimeout(300);
      if (entry.auth && entry.auth !== 'none') {
        // Every authed entry MUST set authAssert: a selector that only renders when
        // logged in. Without it a stale tokenVersion or gated account renders the
        // logged-out shell and would false-green the overflow probe.
        if (!entry.authAssert) { results.push({ name: entry.name, status: 'auth-failed', reason: 'authAssert missing in manifest' }); continue; }
        const ok = await page.locator(entry.authAssert).first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
        if (!ok) {
          // Screenshot the failure state so auth-failed is diagnosable from /mobile-audit/.
          await page.screenshot({ path: path.join(OUT, entry.name + '.jpeg'), fullPage: true, type: 'jpeg', quality: 82 }).catch(() => {});
          results.push({ name: entry.name, status: 'auth-failed' });
          continue;
        }
      }
      await page.screenshot({ path: path.join(OUT, entry.name + '.jpeg'), fullPage: true, type: 'jpeg', quality: 82 });
      const p = await probe(page, entry.scrollableAllow || []);
      // A rate-limited page renders degraded content and cannot be trusted in
      // either direction: hard failure, even for reportOnly pages.
      if (consoleErrors.some((e) => e.includes('429'))) {
        results.push({ name: entry.name, status: 'degraded', reason: 'API 429 during load', ...p });
        continue;
      }
      const pass = p.scrollW <= 390 && p.offRight.length === 0; // spec: fail above 390, no tolerance
      // reportOnly: surfaces outside the fix scope (admin) — measured and printed,
      // never counted against the exit code, so the gate can go green without them.
      const status = pass ? 'pass' : (entry.reportOnly ? 'report' : 'FAIL');
      results.push({ name: entry.name, status, ...p, consoleErrors: consoleErrors.slice(0, 3) });
    } finally {
      await page.close().catch(() => {});
    }
  }

  await browser.close();
  await pool.end();
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2));
  const w = (s) => String(s).padEnd(30);
  for (const r of results) {
    console.log(
      w(r.name),
      r.status.padEnd(11),
      r.offRight && r.offRight.length ? r.offRight.join(' | ') : '',
      r.smallTaps != null ? `taps<36:${r.smallTaps} tiny<12:${r.tinyText}` : (r.reason || ''),
      r.consoleErrors && r.consoleErrors.length ? `console:${r.consoleErrors.length}` : ''
    );
  }
  const bad = results.filter((r) => ['FAIL', 'no-data', 'auth-failed', 'degraded'].includes(r.status));
  if (bad.length) die(`${bad.length} page(s) FAIL, no-data, auth-failed, or degraded`);
  console.log(`[mobile:check] ${results.filter((r) => r.status === 'pass').length} pass, ${results.filter((r) => r.status === 'skipped').length} skipped`);
})();

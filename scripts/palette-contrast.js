#!/usr/bin/env node
/*
 * Admin two-skin CONTRAST harness. Opens every admin surface in BOTH skins
 * (House Lights / After Hours), reads getComputedStyle off REAL rendered text,
 * resolves each node's effective background by walking ancestors, and computes
 * the actual WCAG 2.1 contrast ratio.
 *
 * WHY THIS EXISTS (walkthroughs-owed, "Admin palette baseline eyeball sweep"):
 * the text-colour baseline moved for every admin surface in both skins with
 * ZERO browser verification. Every contrast figure in that work is arithmetic
 * on token values, and the fix list already records that measuring a token a
 * surface does not consume proves nothing about that surface. This measures
 * what is actually painted.
 *
 * It is the AUTOMATION half of routing rule 1 (walkthroughs-owed): mechanical
 * getComputedStyle checks belong here, not in a human's eyeball pass. The human
 * still owns "does the emptier board read as calm" judgment; this owns numbers.
 *
 * Usage:  node scripts/palette-contrast.js
 *         node scripts/palette-contrast.js --only change-requests,dashboard
 *         node scripts/palette-contrast.js --skin light
 *
 * DEV-ONLY BY CONSTRUCTION, same gate as scripts/mobile-capture.js: it exits
 * before touching anything if NODE_ENV is production or DATABASE_URL is not the
 * known dev branch. Mints a dev admin JWT from .env JWT_SECRET.
 */
require('dotenv').config();
const path = require('path');
const { URL } = require('node:url');

function die(msg) { console.error('[palette] ' + msg); process.exit(1); }

// ---- Environment gate: BEFORE any token minting or browser launch ----
if (process.env.NODE_ENV === 'production') die('refusing to run: NODE_ENV=production');
if (!process.env.DATABASE_URL) die('DATABASE_URL missing');
if (!process.env.JWT_SECRET) die('JWT_SECRET missing');
const DEV_DB_HOSTS = ['ep-old-feather-adoh3rf3-pooler.c-2.us-east-1.aws.neon.tech'];
const dbHost = new URL(process.env.DATABASE_URL).hostname;
if (!DEV_DB_HOSTS.includes(dbHost)) die(`refusing to run: DATABASE_URL host "${dbHost}" is not the dev branch`);

const { chromium } = require('playwright-core');
const jwt = require('jsonwebtoken');
const fs = require('fs');

const CHROME = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'mobile-capture.manifest.json'), 'utf8')
).chromePath;

const ADMIN_ID = 1;
const ADMIN_TOKEN_VERSION = 0;

// Admin surfaces worth measuring. /change-requests first: walkthroughs-owed
// names it "the cleanest single proof case".
const SURFACES = [
  { name: 'change-requests', path: '/change-requests' },
  { name: 'dashboard', path: '/dashboard' },
  { name: 'events', path: '/events' },
  { name: 'proposals', path: '/proposals' },
  { name: 'clients', path: '/clients' },
  { name: 'staff', path: '/staff' },
  { name: 'hiring', path: '/hiring' },
  { name: 'financials', path: '/financials' },
  { name: 'payroll', path: '/financials/payroll' },
  { name: 'marketing', path: '/marketing' },
  { name: 'messages', path: '/messages' },
  { name: 'drink-plans', path: '/drink-plans' },
  { name: 'settings', path: '/settings' },
];

const SKINS = [
  { key: 'light', label: 'House Lights' },
  { key: 'dark', label: 'After Hours' },
];

const only = (() => {
  const i = process.argv.indexOf('--only');
  return i > -1 ? process.argv[i + 1].split(',') : null;
})();
const skinFilter = (() => {
  const i = process.argv.indexOf('--skin');
  return i > -1 ? process.argv[i + 1] : null;
})();

function mintAdminToken() {
  return jwt.sign(
    { userId: ADMIN_ID, tokenVersion: ADMIN_TOKEN_VERSION },
    process.env.JWT_SECRET,
    { expiresIn: '2h' }
  );
}

/*
 * Runs IN THE PAGE. Returns every visible text-bearing leaf whose measured
 * contrast is below its WCAG AA threshold.
 *
 * Deliberate choices, each of which the token-arithmetic approach got wrong:
 *  - Effective background is resolved by WALKING ANCESTORS until a
 *    non-transparent backgroundColor is found. House Lights sets surfaces
 *    transparent by design (fix list: "House Lights sets surfaces transparent
 *    and every component that assumes an opaque parent inherits the page"), so
 *    reading the element's own background would silently measure nothing.
 *  - Alpha on the TEXT colour is composited against that background before
 *    measuring. A muted token is usually an alpha, and ignoring alpha is
 *    exactly how a "passing" figure gets computed for unreadable text.
 *  - Large text uses the real WCAG rule (>=24px, or >=18.66px when bold), which
 *    lowers the threshold to 3.0. Applying 4.5 everywhere manufactures failures
 *    on headings and buries the real ones.
 */
function collectContrast() {
  const AA_NORMAL = 4.5;
  const AA_LARGE = 3.0;

  const parse = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((n) => parseFloat(n.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });

  /*
   * Returns { bg, unmeasurable }.
   *
   * unmeasurable=true when ANY node in the chain paints a background-image
   * (gradient, sprite, texture). getComputedStyle exposes no resolved pixel
   * for those, so backgroundColor reads transparent and a naive walk sails
   * straight past the thing the text actually sits on.
   *
   * This is not hypothetical: the first run of this harness reported
   * `div.avatar` at 1.05 (#0b0d10 on the near-black page) and called the
   * initials invisible. They are not. `.avatar` is
   * `background: linear-gradient(135deg, var(--accent), ...)`, so the text sits
   * on a blue circle and reads fine. Zul caught it by looking, on 2026-08-19,
   * which is exactly the failure a numbers-only pass cannot catch about itself.
   * Reporting a confident wrong number is worse than reporting nothing, so
   * these are now excluded from the failure count and listed separately.
   */
  const effectiveBg = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const cs = getComputedStyle(node);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        return { bg: { r: 255, g: 255, b: 255, a: 1 }, unmeasurable: true };
      }
      const bg = parse(cs.backgroundColor);
      if (bg && bg.a > 0.999) return { bg, unmeasurable: false };
      if (bg && bg.a > 0) {
        const behind = effectiveBg(node.parentElement || document.body);
        return { bg: over(bg, behind.bg), unmeasurable: behind.unmeasurable };
      }
      node = node.parentElement;
    }
    const htmlCs = getComputedStyle(document.documentElement);
    if (htmlCs.backgroundImage && htmlCs.backgroundImage !== 'none') {
      return { bg: { r: 255, g: 255, b: 255, a: 1 }, unmeasurable: true };
    }
    const html = parse(htmlCs.backgroundColor);
    return {
      bg: html && html.a > 0.999 ? html : { r: 255, g: 255, b: 255, a: 1 },
      unmeasurable: false,
    };
  };

  const out = [];
  const unmeasurable = [];
  const seen = new Set();
  document.querySelectorAll('body *').forEach((el) => {
    if (el.children.length > 0) return;               // leaves only
    const text = (el.textContent || '').trim();
    if (text.length < 2) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;          // not painted
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return;
    if (parseFloat(cs.opacity) < 0.05) return;

    const fgRaw = parse(cs.color);
    if (!fgRaw) return;
    const resolved = effectiveBg(el);
    if (resolved.unmeasurable) { unmeasurable.push(el.tagName.toLowerCase()); return; }
    const bg = resolved.bg;
    const fg = fgRaw.a < 0.999 ? over(fgRaw, bg) : fgRaw;

    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const isLarge = size >= 24 || (size >= 18.66 && weight >= 700);
    const threshold = isLarge ? AA_LARGE : AA_NORMAL;
    const cr = ratio(fg, bg);
    if (cr >= threshold) return;

    const cls = typeof el.className === 'string'
      ? el.className.trim().split(/\s+/).slice(0, 3).join('.')
      : '';
    const sig = `${el.tagName}.${cls}|${Math.round(cr * 100)}`;
    if (seen.has(sig)) return;                        // collapse repeats
    seen.add(sig);

    out.push({
      sel: el.tagName.toLowerCase() + (cls ? '.' + cls : ''),
      text: text.slice(0, 40),
      ratio: Math.round(cr * 100) / 100,
      need: threshold,
      size: Math.round(size * 10) / 10,
      weight,
      fg: `rgb(${Math.round(fg.r)},${Math.round(fg.g)},${Math.round(fg.b)})`,
      bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`,
    });
  });
  out.sort((a, b) => a.ratio - b.ratio);
  return { fails: out.slice(0, 25), unmeasurableCount: unmeasurable.length };
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const token = mintAdminToken();
  const results = [];
  const RUN_OCT = Math.floor(Date.now() / 1000) % 250;
  let idx = 0;

  for (const skin of SKINS) {
    if (skinFilter && skinFilter !== skin.key) continue;
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });

    for (const surface of SURFACES) {
      if (only && !only.includes(surface.name)) continue;
      idx += 1;
      const page = await ctx.newPage();
      const consoleErrors = [];
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 100)); });
      await page.setExtraHTTPHeaders({
        'x-forwarded-for': `10.${RUN_OCT}.${Math.floor(idx / 250)}.${(idx % 250) + 1}`,
      });
      // Plant BOTH the auth token and the skin preference before any app code
      // runs. Clicking the Sidebar toggle instead would race hydration and
      // measure a half-applied skin.
      await page.addInitScript(([tok, prefsKey, prefs]) => {
        try {
          localStorage.setItem('token', tok);
          localStorage.setItem(prefsKey, prefs);
        } catch (e) { /* storage blocked */ }
      }, [token, `drb-admin-prefs-${ADMIN_ID}`, JSON.stringify({ skin: skin.key, density: 'comfy', sidebar: 'full' })]);

      let status = 'ok';
      let findings = [];
      let unmeasurableCount = 0;
      try {
        await page.goto(`http://localhost:3000${surface.path}`, { waitUntil: 'networkidle', timeout: 30000 });
        // The skin lands on <html data-skin>; assert it before measuring, or a
        // failed pref write yields a full page of default-skin "findings".
        const applied = await page.evaluate(() => ({
          skin: document.documentElement.getAttribute('data-skin'),
          app: document.documentElement.getAttribute('data-app'),
        }));
        if (applied.app !== 'admin-os') { status = `not-admin-os (data-app=${applied.app})`; }
        else if (applied.skin !== skin.key) { status = `skin-not-applied (got ${applied.skin})`; }
        else {
          const measured = await page.evaluate(collectContrast);
          findings = measured.fails;
          unmeasurableCount = measured.unmeasurableCount;
        }
      } catch (e) {
        status = 'error: ' + e.message.slice(0, 80);
      }
      results.push({ skin: skin.label, skinKey: skin.key, surface: surface.name, status, findings, unmeasurableCount, consoleErrors: consoleErrors.slice(0, 3) });
      await page.close();
    }
    await ctx.close();
  }
  await browser.close();

  // ---- Report ----
  let totalFail = 0;
  for (const r of results) {
    const head = `\n=== ${r.skin} :: ${r.surface} ===`;
    if (r.status !== 'ok') { console.log(`${head}\n  SKIPPED/UNMEASURED: ${r.status}`); continue; }
    if (!r.findings.length) { console.log(`${head}\n  clean (no AA failures on painted text)${r.unmeasurableCount ? `, ${r.unmeasurableCount} skipped as unmeasurable` : ''}`); continue; }
    console.log(head);
    for (const f of r.findings) {
      totalFail += 1;
      console.log(`  ${String(f.ratio).padStart(5)} (need ${f.need})  ${f.sel}  ${f.size}px/${f.weight}  ${f.fg} on ${f.bg}  "${f.text}"`);
    }
  }
  const totalUnmeasurable = results.reduce((a, r) => a + (r.unmeasurableCount || 0), 0);
  console.log(`\n[palette] ${totalFail} AA failures across ${results.length} surface/skin combinations.`);
  console.log(`[palette] ${totalUnmeasurable} nodes SKIPPED as unmeasurable (background-image in the chain; getComputedStyle exposes no resolved pixel). These are NOT passes.`);
  fs.writeFileSync(
    path.join(__dirname, '..', 'palette-contrast-report.json'),
    JSON.stringify(results, null, 2)
  );
  console.log('[palette] full report: palette-contrast-report.json');
})();

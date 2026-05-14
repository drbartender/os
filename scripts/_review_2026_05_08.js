// Playwright UI/UX review driver — disposable
// Drives Playwright via global module location
const path = require('path');
process.env.NODE_PATH = String.raw`C:\Users\dalla\AppData\Roaming\npm\node_modules`;
require('module').Module._initPaths();

const { chromium } = require('playwright');

const OUT = path.resolve(__dirname, '..', '.playwright-mcp', 'review-2026-05-08');
const BASE = 'http://localhost:3030';

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet:  { width: 768,  height: 1024 },
  mobile:  { width: 375,  height: 812 },
};

const PAGES = [
  { slug: 'home',          path: '/' },
  { slug: 'services',      path: '/services' },
  { slug: 'method',        path: '/method' },
  { slug: 'about',         path: '/about' },
  { slug: 'faq',           path: '/faq' },
  { slug: 'blog',          path: '/labnotes' },
  { slug: 'quote',         path: '/quote' },
  { slug: 'login',         path: '/login' },
  { slug: 'tip-test',      path: '/tip/test' },
  { slug: 'tip-thanks',    path: '/tip/test/thanks' },
  { slug: 'proposal-test', path: '/proposal/test' },
  { slug: 'invoice-test',  path: '/invoice/test' },
];

async function consoleLogs(page, slug, viewport) {
  const logs = [];
  page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => logs.push(`[pageerror] ${err.message}`));
  page.on('requestfailed', req => logs.push(`[reqfail] ${req.url()} ${req.failure()?.errorText}`));
  return () => {
    if (logs.length) console.log(`\n--- ${slug}@${viewport} console (${logs.length}) ---`);
    logs.slice(0,10).forEach(l => console.log(' ', l));
  };
}

async function dumpA11y(page, slug, viewport) {
  // Quick a11y snapshot: headings, alt, labels, contrast hints
  const data = await page.evaluate(() => {
    const result = {
      title: document.title,
      h1: [...document.querySelectorAll('h1')].map(h => h.textContent.trim().slice(0,80)),
      h2Count: document.querySelectorAll('h2').length,
      h3Count: document.querySelectorAll('h3').length,
      h4Count: document.querySelectorAll('h4').length,
      h5Count: document.querySelectorAll('h5').length,
      h6Count: document.querySelectorAll('h6').length,
      imgsTotal: document.querySelectorAll('img').length,
      imgsNoAlt: [...document.querySelectorAll('img')].filter(i => !i.hasAttribute('alt')).map(i => i.src.slice(-60)),
      imgsEmptyAlt: [...document.querySelectorAll('img')].filter(i => i.getAttribute('alt') === '').length,
      inputsTotal: document.querySelectorAll('input,textarea,select').length,
      inputsUnlabeled: [...document.querySelectorAll('input,textarea,select')].filter(i => {
        const id = i.id;
        const labeledBy = i.getAttribute('aria-labelledby');
        const ariaLabel = i.getAttribute('aria-label');
        const labelTag = id && document.querySelector(`label[for="${id}"]`);
        const wrappedByLabel = i.closest('label');
        const ph = i.placeholder;
        const type = i.type;
        if (type === 'hidden' || type === 'submit' || type === 'button') return false;
        return !labelTag && !wrappedByLabel && !labeledBy && !ariaLabel;
      }).map(i => `${i.tagName.toLowerCase()}[type=${i.type}, name=${i.name||''}, ph="${i.placeholder||''}"]`),
      hasMain:    !!document.querySelector('main'),
      hasNav:     !!document.querySelector('nav'),
      hasFooter:  !!document.querySelector('footer'),
      hasSkipLink: !!document.querySelector('a[href="#main"], a[href="#content"], a[href^="#main-"], .skip-to-content, .skip-link'),
      langAttr: document.documentElement.lang,
      docHeight: document.body.scrollHeight,
      hasHorizScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    };
    // Quick tap target check (mobile only used by caller)
    result.smallTapTargets = [...document.querySelectorAll('button, a, [role="button"]')]
      .filter(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const isVisible = el.offsetParent !== null;
        if (!isVisible) return false;
        return r.width < 44 || r.height < 44;
      })
      .slice(0, 6)
      .map(el => `${el.tagName.toLowerCase()}[${(el.textContent||'').trim().slice(0,30)}]: ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`);
    return result;
  });
  return data;
}

async function run() {
  const browser = await chromium.launch();
  const summary = {};

  for (const p of PAGES) {
    summary[p.slug] = {};
    for (const [vName, vp] of Object.entries(VIEWPORTS)) {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      const flushLogs = await consoleLogs(page, p.slug, vName);
      try {
        const resp = await page.goto(BASE + p.path, { waitUntil: 'networkidle', timeout: 20000 });
        await page.waitForTimeout(800); // let fonts/layout settle
        const status = resp ? resp.status() : 'NO-RESP';
        const file = path.join(OUT, `${p.slug}_${vName}.png`);
        await page.screenshot({ path: file, fullPage: true });
        const a11y = await dumpA11y(page, p.slug, vName);
        summary[p.slug][vName] = { status, ...a11y };
        console.log(`OK ${p.slug}@${vName}  status=${status}  scroll=${a11y.scrollW}x?  h1=${a11y.h1.length}  noAlt=${a11y.imgsNoAlt.length}  unlabeled=${a11y.inputsUnlabeled.length}  horizScroll=${a11y.hasHorizScroll}`);
      } catch (e) {
        summary[p.slug][vName] = { error: e.message };
        console.log(`FAIL ${p.slug}@${vName}: ${e.message}`);
      }
      flushLogs();
      await ctx.close();
    }
  }

  console.log('\n\n========== SUMMARY ==========');
  console.log(JSON.stringify(summary, null, 2));
  await browser.close();
}

run().catch(e => { console.error(e); process.exit(1); });

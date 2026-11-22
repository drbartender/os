// Diagnostic capture on definitive failures (the thumbtack-agent pattern that
// made each Thumbtack UI break a 10-minute diagnosis): a screenshot and a
// control dump into <profileDir>/diag, inside the mode-700 profile that stays
// out of restic, each file mode 600. The dump masks every digit and never
// holds a field's value or a conversation preview; file names carry only the
// job id and the tag. Bounded (the newest 40 captures, none older than 30
// days, pruned at startup and on every capture), and it never throws into the
// flow.
const fs = require('fs');
const path = require('path');
const { CFG } = require('./config');

const KEEP_CAPTURES = 40;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CAPTURE_RE = /\.(png|json)$/;
const FILE_MODE = 0o600;

const fsSafe = (s) => String(s == null ? '' : s).replace(/[^\w-]/g, '').slice(0, 64) || 'unknown';
const maskDigits = (_key, v) => (typeof v === 'string' ? v.replace(/\d/g, '#') : v);

function readFacts(page) {
  return page.evaluate(() => {
    const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
    const rendered = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const ownText = (el) => {
      let own = '';
      for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent;
      return own;
    };
    const frameSrc = (src) => {
      try { const u = new URL(src); return u.host + u.pathname; } catch { return ''; }
    };
    return {
      url: location.href,
      title: document.title,
      regions: Array.from(document.querySelectorAll('[role="region"]'))
        .map((r) => r.getAttribute('aria-label')).filter(Boolean),
      controls: Array.from(document.querySelectorAll('button, a, [role="button"]'))
        .filter((el) => rendered(el) && !el.closest('gv-thread-list'))
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          aria: clip(el.getAttribute('aria-label'), 80),
          text: clip(el.innerText, 60),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
        }))
        .filter((c) => c.aria || c.text)
        .slice(0, 80),
      inputs: Array.from(document.querySelectorAll('input, textarea')).map((el) => ({
        tag: el.tagName.toLowerCase(),
        placeholder: el.getAttribute('placeholder'),
        aria: el.getAttribute('aria-label'),
        valueLength: (el.value || '').length,
        rendered: rendered(el),
      })),
      contactList: Array.from(document.querySelectorAll('gv-contact-list div'))
        .map((e) => {
          const r = e.getBoundingClientRect();
          return { own: clip(ownText(e), 60), w: Math.round(r.width), h: Math.round(r.height) };
        })
        .filter((e) => e.own)
        .slice(0, 20),
      threadItems: document.querySelectorAll('gv-thread-list-item').length,
      noticeLinks: document.querySelectorAll('a[href*="/bids/"]').length,
      frames: Array.from(document.querySelectorAll('iframe')).map((f) => {
        const r = f.getBoundingClientRect();
        return { src: frameSrc(f.src), w: Math.round(r.width), h: Math.round(r.height) };
      }),
    };
  });
}

// Age first, then count. A capture is a .png and a .json sharing one base
// name, which starts with an ISO stamp, so a name sort is a time sort. Runs at
// startup and after every capture; a missing dir is nothing to prune, and it
// never throws.
function pruneDiag(dir) {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(dir).filter((n) => CAPTURE_RE.test(n))) {
      try {
        if (now - fs.statSync(path.join(dir, f)).mtimeMs > MAX_AGE_MS) fs.unlinkSync(path.join(dir, f));
      } catch { /* static-checks: allow swallowed-catch, a file another prune already removed */ }
    }
    const bases = [...new Set(fs.readdirSync(dir).filter((n) => CAPTURE_RE.test(n))
      .map((n) => n.replace(CAPTURE_RE, '')))].sort();
    for (const base of bases.slice(0, Math.max(0, bases.length - KEEP_CAPTURES))) {
      for (const ext of ['.png', '.json']) fs.rmSync(path.join(dir, base + ext), { force: true });
    }
  } catch { /* static-checks: allow swallowed-catch, housekeeping only; pruneDiag never throws */ }
}

// Returns the capture's base path, or null when nothing could be written.
async function captureDiag(page, jobId, tag, dir = path.join(CFG.profileDir, 'diag')) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(dir, `${stamp}-${fsSafe(jobId)}-${fsSafe(tag)}`);
    // To a buffer, then written here, so the screenshot is mode 600 like the dump.
    const png = await page.screenshot({ fullPage: false }).catch(() => null);
    if (png) fs.writeFileSync(`${base}.png`, png, { mode: FILE_MODE });
    const facts = await readFacts(page).catch(() => null);
    if (facts) fs.writeFileSync(`${base}.json`, JSON.stringify(facts, maskDigits, 1), { mode: FILE_MODE });
    pruneDiag(dir);
    return base;
  } catch {
    return null;
  }
}

module.exports = { captureDiag, pruneDiag };

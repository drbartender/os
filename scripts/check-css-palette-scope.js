#!/usr/bin/env node
'use strict';

/**
 * check-css-palette-scope.js — mechanical backstop for the legacy-palette scope.
 *
 * WHAT THIS PROTECTS
 * ------------------
 * client/src/index.css carries TWO palettes in one file:
 *
 *   - the Apothecary Press palette (chalkboard ground, --cream-text type) used
 *     by the marketing site, the public/proposal surfaces and the staff portal;
 *   - the Admin OS palette (html[data-app="admin-os"], skin-aware --ink-* /
 *     --bg-* tokens, House Lights light skin + After Hours dark skin).
 *
 * Any rule that reaches into the admin shell and paints an Apothecary token is
 * a bug, because those token VALUES are fixed: --cream-text (#F0E8D6) and
 * --parchment (#E6DDCC) are 1.1:1 and 1.2:1 against House Lights paper
 * (#f7f4ec). Text painted with them on House Lights is simply invisible.
 *
 * This trap has now been re-armed three times (a .drawer-hero h2 patch, a
 * .mkt-resume p patch, then the whole bare-element family), each time fixed at
 * a call site, each time coming back. A CSS comment is not a gate. This is.
 *
 * TWO CHECKS
 * ----------
 *   A) NO UNSCOPED BARE-ELEMENT RULE PAINTING A LEGACY PALETTE COLOUR.
 *      A selector made only of element names / combinators (no class, no id,
 *      no attribute) that sets `color` applies to EVERY app in the bundle,
 *      admin included, and wins on any admin element whose own rule omits
 *      colour. Those rules must be wrapped in
 *      :where(html:not([data-app="admin-os"])) — which contributes zero
 *      specificity, so nothing else in the cascade moves.
 *      Only values that actually RESOLVE to an Apothecary token are flagged.
 *      `inherit` (which is what this file's own fix adopted), `currentColor`,
 *      `transparent`, the CSS-wide keywords, an --ink-* token and any literal
 *      that is not a palette value are ordinary resets, not leaks. @keyframes
 *      step blocks are animation frames, not selectors, and are out of scope.
 *
 *   B) NO ADMIN-REACHABLE CLASS RULE PAINTING A LEGACY TOKEN INTO INVISIBILITY.
 *      For each unscoped class rule that sets colour to an Apothecary :root
 *      token, this resolves the token per admin skin, works out the ground the
 *      text actually sits on, computes the WCAG contrast, and fails when it is
 *      below FLOOR in a skin that has no skin-aware admin override.
 *
 * Check B is a HEURISTIC over a stylesheet, not a browser. It can be wrong
 * about the ground (an element whose background comes from an ancestor it has
 * no selector relationship with). That is what ALLOWLIST is for: every entry
 * is an adjudicated false positive with the reason written down. It is not a
 * place to park real bugs.
 *
 * USAGE
 *   node scripts/check-css-palette-scope.js            full-tree check
 *   node scripts/check-css-palette-scope.js --staged   pre-commit; no-ops when
 *                                                      index.css is not staged
 *
 * The exit code is meaningful (0 clean / 1 findings) so `npm run check:css-scope`
 * can gate CI. The pre-commit hook, however, calls this WARN-ONLY on purpose
 * while the parser burns in — see the comment at the call site in
 * .husky/pre-commit. A brand-new parser does not get veto power over the
 * repo's largest file on day one.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const CSS_PATH = 'client/src/index.css';
const SRC_DIR = path.join(REPO_ROOT, 'client/src');

/** Contrast below this, in a skin with no admin override, is a failure. */
const FLOOR = 3.0;

/** The two admin skins' page grounds (html[data-app="admin-os"][data-skin=…] --bg-0). */
const PAGE_GROUND = { light: '#f7f4ec', dark: '#0b0d10' };

const COLOR_PROPS = new Set(['color', '-webkit-text-fill-color']);

/**
 * Adjudicated false positives. Key is the exact selector text as it appears in
 * index.css (whitespace-collapsed). Adding an entry is a claim that a human
 * checked it — write the reason.
 */
const ALLOWLIST = new Map([
  ['.potion-app .form-label',
    'Inside the .potion-app island, which paints its own --chalkboard ground ' +
    'in every skin, so the admin skin does not change this rule\'s rendering ' +
    'at all: it computes identically on the public /plan planner, where it has ' +
    'always looked this way. A pre-existing 2.31:1 on a public surface, not an ' +
    'admin palette leak. Fix it in the planner, not here.'],
]);

// ---------------------------------------------------------------------------
// CSS parsing
// ---------------------------------------------------------------------------

/** Blank out comments, preserving byte offsets so line numbers stay true. */
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (src[i] === '"' || src[i] === "'") {
      const j = skipString(src, i);
      out += src.slice(i, j);
      i = j;
    } else {
      out += src[i];
      i += 1;
    }
  }
  return out;
}

function skipString(src, i) {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length && !(src[j] === quote && src[j - 1] !== '\\')) j += 1;
  return j + 1;
}

/**
 * Rewrite attribute selectors to one canonical quoted form so that
 * [data-app=admin-os] and [data-app='admin-os'] are recognised exactly like
 * [data-app="admin-os"]. All three are the same selector; only the last is
 * what this file's authors happen to type, and a scope check that can be
 * defeated by dropping two quote characters is not a scope check.
 */
function normalizeSelector(sel) {
  return sel.replace(
    /\[\s*([-\w]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*\]/g,
    (_m, name, dq, sq, bare) => `[${name}="${dq !== undefined ? dq : sq !== undefined ? sq : bare}"]`
  );
}

/**
 * Flat rule list. At-rule blocks (@media, @supports, @keyframes) are descended
 * into; their inner rules come out with the same shape as top-level ones, plus
 * an `atRules` array naming the at-rule preludes they are nested inside — which
 * is how a @keyframes STEP (`0%`, `from`) is told apart from a real selector.
 *
 * A block-less at-rule statement (@charset "UTF-8"; @import url(…); @layer a;)
 * terminates its prelude at the `;`. Without that, its prelude merges with the
 * NEXT rule's selector, the merged prelude starts with `@`, and the parser
 * descends into a block that is not an at-rule body — silently losing that rule.
 * When the lost rule is `:root`, check B goes quiet and passes vacuously.
 */
function parseCss(source) {
  const css = stripComments(source);
  const lineStarts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (idx) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };

  const rules = [];
  const atStack = [];
  let prelude = '';
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") {
      const j = skipString(css, i);
      prelude += css.slice(i, j);
      i = j;
    } else if (c === ';') {
      // Statement terminator at prelude position: a block-less at-rule
      // (@charset/@import/@layer/@namespace) or a stray semicolon. Either way
      // it ends the prelude — it must never glue onto the next selector.
      prelude = '';
      i += 1;
    } else if (c === '{') {
      const sel = prelude.trim().replace(/\s+/g, ' ');
      prelude = '';
      if (sel.startsWith('@')) {
        atStack.push(sel); // descend: inner rules are parsed like top-level ones
        i += 1;
        continue;
      }
      const close = matchBrace(css, i);
      rules.push({
        selector: sel,
        norm: normalizeSelector(sel),
        body: css.slice(i + 1, close),
        line: lineOf(i),
        atRules: atStack.slice(),
      });
      i = close + 1;
    } else if (c === '}') {
      // Every `}` reaching this loop closes an at-rule block we descended into;
      // ordinary rule bodies are consumed whole by matchBrace above.
      atStack.pop();
      prelude = '';
      i += 1;
    } else {
      prelude += c;
      i += 1;
    }
  }
  return rules;
}

/** @keyframes STEP blocks (`0%`, `from`) are animation frames, not selectors. */
const KEYFRAMES_RE = /^@(?:-[\w]+-)?keyframes\b/i;
const isKeyframeStep = (rule) => (rule.atRules || []).some((a) => KEYFRAMES_RE.test(a));

function matchBrace(css, open) {
  let depth = 1;
  let i = open + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === '"' || css[i] === "'") { i = skipString(css, i); continue; }
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') depth -= 1;
    i += 1;
  }
  return i - 1;
}

/** Split on a top-level separator, ignoring parens/brackets/strings. */
function splitTop(text, sep) {
  const parts = [];
  let depth = 0;
  let buf = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") { const j = skipString(text, i); buf += text.slice(i, j); i = j; continue; }
    if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    if (c === sep && depth === 0) { parts.push(buf); buf = ''; i += 1; continue; }
    buf += c;
    i += 1;
  }
  parts.push(buf);
  return parts;
}

function declarations(body) {
  return splitTop(body, ';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const k = d.indexOf(':');
      if (k === -1) return null;
      return { prop: d.slice(0, k).trim().toLowerCase(), value: d.slice(k + 1).trim() };
    })
    .filter(Boolean);
}

const selectorParts = (sel) => splitTop(sel, ',').map((s) => s.trim()).filter(Boolean);

/**
 * The SUBJECT compound of a selector part: the classes on the rightmost
 * element. `.card .btn-secondary:hover` -> ['btn-secondary'].
 * Matching on the whole compound, not on one class, is what keeps `.chip.ok`
 * from being mistaken for coverage of `.message-log-status.ok`.
 */
function subjectClasses(part) {
  const stripped = part.replace(/:(?:where|is|not|has)\([^)]*\)/g, ' ');
  const compounds = stripped.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
  const last = compounds[compounds.length - 1] || '';
  return [...last.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]).sort();
}

const allClasses = (sel) => [...sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);
const compoundKey = (classes) => classes.join('.');

// All four take a NORMALIZED selector (see normalizeSelector) so the unquoted
// and single-quoted attribute forms behave identically to the quoted one.
const isAdminScoped = (sel) => /\[data-app="admin-os"\]/.test(sel) && !/:not\(\s*\[data-app="admin-os"\]\s*\)/.test(sel);
const isScopedOutOfAdmin = (sel) => /:not\(\s*\[data-app="admin-os"\]\s*\)/.test(sel);
const isOtherApp = (sel) => /\[data-app="staff"\]/.test(sel);

function adminSkinsOf(sel) {
  const skins = [];
  if (!/\[data-skin="dark"\]/.test(sel)) skins.push('light');
  if (!/\[data-skin="light"\]/.test(sel)) skins.push('dark');
  return skins;
}

// ---------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------

function resolveValue(value, tokens, depth) {
  const d = depth || 0;
  if (d > 12) return null;
  const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(String(value).trim());
  if (!m) return String(value).trim();
  const v = tokens[m[1]];
  if (v === undefined) return m[2] ? resolveValue(m[2], tokens, d + 1) : null;
  return resolveValue(v, tokens, d + 1);
}

function hexToRgb(hex) {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(String(hex).trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  if (!A || !B) return null;
  const l1 = relativeLuminance(A);
  const l2 = relativeLuminance(B);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** First value in a (possibly layered / gradient) background that resolves to a hex. */
function firstHex(value, tokens) {
  for (const part of splitTop(value, ',')) {
    for (const word of part.trim().split(/\s+(?![^(]*\))/)) {
      const r = resolveValue(word, tokens);
      if (r && hexToRgb(r)) return r;
    }
  }
  for (const m of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
    const r = resolveValue(`var(${m[1]})`, tokens);
    if (r && hexToRgb(r)) return r;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Admin reachability: which class names can appear inside the admin shell
// ---------------------------------------------------------------------------

/**
 * Walks the import graph from the Admin OS shell and every page/component it
 * can render, then harvests every className string literal it finds. A class
 * assembled at runtime (`badge-${status}`) is invisible to this, which makes
 * the reachability set an UNDER-estimate — check B can miss, it will not
 * invent. Stated plainly rather than papered over.
 */
function collectAdminClasses(srcDir) {
  const seeds = ['components/AdminLayout.js'];
  for (const dir of ['pages/admin', 'components/adminos']) walkJs(srcDir, dir, seeds);

  const appJs = readIfExists(path.join(srcDir, 'App.js'));
  if (appJs) {
    const start = appJs.indexOf('Admin + Manager shell');
    const end = appJs.indexOf('<Route path="*"');
    if (start !== -1 && end > start) {
      const block = appJs.slice(start, end);
      for (const m of block.matchAll(/<([A-Z][A-Za-z0-9_]*)/g)) {
        const re = new RegExp(
          `(?:const|let|var)\\s+${m[1]}\\s*=\\s*lazy\\(\\s*\\(\\)\\s*=>\\s*import\\(['"]([^'"]+)['"]\\)`
          + `|import\\s+${m[1]}\\s+from\\s+['"]([^'"]+)['"]`
        );
        const hit = re.exec(appJs);
        if (hit) seeds.push((hit[1] || hit[2]).replace(/^\.\//, ''));
      }
    }
  }

  const seen = new Set();
  const queue = [];
  for (const s of seeds) {
    const r = resolveRelative(srcDir, 'root.js', './' + s.replace(/^\.\//, ''));
    if (r && !seen.has(r)) { seen.add(r); queue.push(r); }
  }
  while (queue.length) {
    const file = queue.shift();
    const text = readIfExists(path.join(srcDir, file));
    if (!text) continue;
    for (const m of text.matchAll(/(?:from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\))/g)) {
      const r = resolveRelative(srcDir, file, m[1] || m[2]);
      if (r && !seen.has(r)) { seen.add(r); queue.push(r); }
    }
  }

  const classes = new Set();
  for (const file of seen) {
    const text = readIfExists(path.join(srcDir, file));
    if (text) harvestClassNames(text, classes);
  }
  return { classes, files: seen };
}

function harvestClassNames(text, out) {
  const add = (str) => {
    for (const c of str.split(/\s+/)) if (c && /^-?[_a-zA-Z][\w-]*$/.test(c)) out.add(c);
  };
  for (const m of text.matchAll(/className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{)/g)) {
    if (m[1] !== undefined || m[2] !== undefined) { add(m[1] !== undefined ? m[1] : m[2]); continue; }
    let i = m.index + m[0].length;
    const start = i;
    let depth = 1;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') depth -= 1;
      i += 1;
    }
    for (const s of text.slice(start, i - 1).matchAll(/['"`]([^'"`]*)['"`]/g)) add(s[1]);
  }
}

function walkJs(srcDir, dir, acc) {
  let entries;
  try { entries = fs.readdirSync(path.join(srcDir, dir), { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(srcDir, rel, acc);
    else if (/\.jsx?$/.test(e.name) && !/\.test\.jsx?$/.test(e.name)) acc.push(rel);
  }
}

function resolveRelative(srcDir, fromRel, spec) {
  if (!spec || !spec.startsWith('.')) return null;
  const base = path.normalize(path.join(path.dirname(fromRel), spec));
  for (const cand of [base, base + '.js', base + '.jsx', path.join(base, 'index.js')]) {
    try { if (fs.statSync(path.join(srcDir, cand)).isFile()) return cand; } catch (_) { /* next */ }
  }
  return null;
}

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// The analysis
// ---------------------------------------------------------------------------

function analyze(cssText, options) {
  const opts = options || {};
  const adminClasses = opts.adminClasses || new Set();
  const allRules = parseCss(cssText);
  const normOf = (r) => (r.norm !== undefined ? r.norm : normalizeSelector(r.selector));

  // A @keyframes step block is an animation frame, not a rule: `0%` / `from`
  // are not selectors, nothing can be "scoped out of admin" on them, and the
  // remediation both checks print is not even valid CSS there. Excluded from
  // every pass below.
  const rules = allRules.filter((r) => !isKeyframeStep(r));

  // --- token maps -----------------------------------------------------------
  const collect = (pred) => {
    const map = {};
    for (const r of rules) {
      if (!pred(normOf(r))) continue;
      for (const d of declarations(r.body)) if (d.prop.startsWith('--')) map[d.prop] = d.value;
    }
    return map;
  };
  const root = collect((s) => s === ':root');
  const adminAny = collect((s) => s === 'html[data-app="admin-os"]');
  const adminLight = collect((s) => s === 'html[data-app="admin-os"][data-skin="light"]');
  const adminDark = collect((s) => s === 'html[data-app="admin-os"][data-skin="dark"]');
  const tokens = {
    light: { ...root, ...adminAny, ...adminLight },
    dark: { ...root, ...adminAny, ...adminDark },
  };
  // "Legacy" = the Apothecary :root palette. Anything declared only inside an
  // admin (or staff) block is skin-aware by construction and out of scope.
  const legacyTokens = new Set(Object.keys(root));

  // SELF-CHECK. An empty palette is not "nothing to find" — it means the parse
  // lost the :root block, and check B would then pass having examined nothing.
  // A green light that checked nothing is the worst outcome this file has, so
  // it is an internal error, loudly, rather than a quiet success.
  if (legacyTokens.size === 0) {
    throw new Error(
      'internal: the Apothecary :root palette resolved to ZERO tokens. Check B cannot '
      + 'have checked anything, so a PASS here would be vacuous. This is the checker\'s '
      + 'own bug (most likely a CSS parse failure), not a stylesheet finding.'
    );
  }

  // --- what counts as "a legacy marketing colour" ----------------------------
  // A :root token the ADMIN ROOT redeclares is skin-aware by construction: the
  // same var() resolves to an --ink-ish value inside the shell. Only the tokens
  // admin does NOT redeclare can leak the Apothecary palette into it.
  const adminRootDeclared = new Set([
    ...Object.keys(adminAny), ...Object.keys(adminLight), ...Object.keys(adminDark),
  ]);
  const legacyLive = new Set([...legacyTokens].filter((t) => !adminRootDeclared.has(t)));

  // Every declaration site of every custom property, so an alias declared
  // outside :root (.foo { --tone: var(--cream-text) }) is still followed.
  const tokenDefs = new Map();
  for (const r of rules) {
    for (const d of declarations(r.body)) {
      if (!d.prop.startsWith('--')) continue;
      if (!tokenDefs.has(d.prop)) tokenDefs.set(d.prop, []);
      tokenDefs.get(d.prop).push(d.value);
    }
  }

  const normHex = (h) => {
    const rgb = hexToRgb(h);
    return rgb ? `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}` : null;
  };
  /** Literal values of the live legacy tokens, so a hand-typed #F0E8D6 counts. */
  const legacyLiterals = new Map();
  for (const t of legacyLive) {
    const h = normHex(String(root[t]).trim());
    if (h && !legacyLiterals.has(h)) legacyLiterals.set(h, t);
  }

  /**
   * Does this declared value actually resolve to an Apothecary palette colour?
   * Returns the offending token name, or null. `inherit`, `currentColor`,
   * `transparent`, the CSS-wide keywords, an --ink-* token and any literal that
   * is not a palette value all return null — they are not leaks, and flagging
   * them was blocking ordinary resets (and printing a rationale that was false).
   */
  function legacyColourIn(value) {
    const v = String(value).replace(/\s*!important\s*$/i, '').trim();
    const seen = new Set();
    const stack = [v];
    while (stack.length) {
      for (const m of String(stack.pop()).matchAll(/var\(\s*(--[\w-]+)/g)) {
        const name = m[1];
        if (adminRootDeclared.has(name)) continue; // skin-aware: chain stops here
        if (legacyLive.has(name)) return name;
        if (seen.has(name)) continue;
        seen.add(name);
        for (const def of tokenDefs.get(name) || []) stack.push(def);
      }
    }
    for (const m of v.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      const h = normHex(m[0]);
      if (h && legacyLiterals.has(h)) return `${legacyLiterals.get(h)} (as the literal ${m[0]})`;
    }
    return null;
  }

  // --- CHECK A: unscoped bare-element rules PAINTING A LEGACY COLOUR ----------
  const bareColorRules = [];
  for (const r of rules) {
    // Last-wins per property, so `color: var(--cream-text); -webkit-text-fill-color: inherit`
    // still surfaces the colour leak instead of being masked by the later prop.
    const winners = new Map();
    for (const d of declarations(r.body)) if (COLOR_PROPS.has(d.prop)) winners.set(d.prop, d.value);
    if (!winners.size) continue;

    let hit = null;
    for (const [prop, value] of winners) {
      const token = legacyColourIn(value);
      if (token) { hit = { prop, value, token }; break; }
    }
    if (!hit) continue;

    for (const part of selectorParts(r.selector)) {
      // A "bare element" chain carries no class, id or attribute anywhere in it,
      // so it has nothing that could confine it to one app.
      if (/[.#[]/.test(part)) continue;
      bareColorRules.push({
        line: r.line, selector: r.selector, part, prop: hit.prop, value: hit.value, token: hit.token,
      });
      break;
    }
  }

  // --- ground + override indexes, keyed by SUBJECT COMPOUND ------------------
  const background = { light: new Map(), dark: new Map() };
  const overrides = { light: new Map(), dark: new Map() };
  const rescopes = { light: new Map(), dark: new Map() };

  const noteBackground = (skin, key, value) => {
    const g = firstHex(value, tokens[skin]);
    if (g) background[skin].set(key, g);
  };

  // Two passes on purpose: the legacy layer first, then the admin layer, so
  // that inside the admin shell an admin repaint of a compound's background
  // (html[data-app="admin-os"] .btn-secondary { background: var(--bg-3) })
  // authoritatively replaces the legacy one rather than racing it on ordering.
  for (const admin of [false, true]) {
    for (const r of rules) {
      const nsel = normOf(r);
      if (isOtherApp(nsel)) continue;
      if (isAdminScoped(nsel) !== admin) continue;
      if (!admin && isScopedOutOfAdmin(nsel)) continue;
      const decls = declarations(r.body);
      const bg = decls.filter((d) => d.prop === 'background' || d.prop === 'background-color').pop();
      const setsColour = decls.some((d) => COLOR_PROPS.has(d.prop));
      const custom = decls.filter((d) => d.prop.startsWith('--'));
      const skins = admin ? adminSkinsOf(nsel) : ['light', 'dark'];

      for (const part of selectorParts(r.selector)) {
        const subject = subjectClasses(part);
        if (!subject.length) continue;
        const key = compoundKey(subject);
        for (const skin of skins) {
          if (bg) noteBackground(skin, key, bg.value);
          if (admin && setsColour) overrides[skin].set(key, r.line);
          if (admin && custom.length) {
            const m = rescopes[skin].get(key) || {};
            for (const d of custom) m[d.prop] = d.value;
            rescopes[skin].set(key, m);
          }
        }
      }
    }
  }

  // --- CHECK B: admin-reachable class rules painting a legacy token ----------
  const candidates = [];
  const paletteHits = [];
  for (const r of rules) {
    const nsel = normOf(r);
    if (isAdminScoped(nsel) || isScopedOutOfAdmin(nsel) || isOtherApp(nsel)) continue;
    const decls = declarations(r.body);
    const colour = decls.filter((d) => COLOR_PROPS.has(d.prop)).pop();
    if (!colour) continue;

    const classes = allClasses(r.selector);
    if (!classes.length) continue;
    // Every class in the selector must be able to appear inside admin, since
    // all of them must be present in the DOM for the rule to match at all.
    if (!classes.every((c) => adminClasses.has(c))) continue;

    const value = colour.value.replace(/\s*!important\s*$/, '');
    const used = [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);
    if (!used.some((t) => legacyTokens.has(t))) continue;

    const part = selectorParts(r.selector)[0];
    const subject = subjectClasses(part);
    const key = compoundKey(subject);
    const ancestors = classes.filter((c) => !subject.includes(c));
    const ownBg = decls.filter((d) => d.prop === 'background' || d.prop === 'background-color').pop();

    const skins = {};
    for (const skin of ['light', 'dark']) {
      let map = tokens[skin];
      // An admin rule may re-scope the token itself on an ancestor
      // (.em-stat-card { --deep-brown: #1C1610 }); that reaches this rule too.
      let rescopedOn = null;
      for (const c of classes) {
        const rs = rescopes[skin].get(compoundKey([c]));
        if (rs && used.some((t) => rs[t] !== undefined)) { rescopedOn = c; map = { ...map, ...rs }; }
      }
      const fg = resolveValue(value, map);

      let ground = PAGE_GROUND[skin];
      let groundFrom = 'page';
      if (background[skin].has(key)) { ground = background[skin].get(key); groundFrom = 'self'; }
      else if (ownBg) {
        const g = firstHex(ownBg.value, map);
        if (g) { ground = g; groundFrom = 'self'; }
        else { groundFrom = 'unknown'; }
      }
      if (groundFrom !== 'self') {
        for (const a of ancestors) {
          const ag = background[skin].get(compoundKey([a]));
          if (ag) { ground = ag; groundFrom = 'ancestor .' + a; break; }
        }
      }

      skins[skin] = {
        fg,
        ground,
        groundFrom,
        rescopedOn,
        ratio: fg ? contrastRatio(fg, ground) : null,
        covered: overrides[skin].has(key),
      };
    }

    const record = { line: r.line, selector: r.selector, value, skins };
    candidates.push(record);
    const failing = ['light', 'dark'].filter(
      (s) => skins[s].ratio !== null && skins[s].ratio < FLOOR && !skins[s].covered
    );
    if (failing.length) paletteHits.push({ ...record, failing });
  }

  return { rules, allRules, legacyTokens, legacyLive, bareColorRules, candidates, paletteHits };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readCss(staged) {
  if (!staged) return fs.readFileSync(path.join(REPO_ROOT, CSS_PATH), 'utf8');
  return execFileSync('git', ['show', `:${CSS_PATH}`], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
}

function isStagedForCommit() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: REPO_ROOT }).toString();
  return out.split('\n').some((l) => l.trim() === CSS_PATH);
}

function main(argv) {
  const staged = argv.includes('--staged');
  if (staged && !isStagedForCommit()) return 0;

  const css = readCss(staged);
  const { classes } = collectAdminClasses(SRC_DIR);
  const { bareColorRules, candidates, paletteHits } = analyze(css, { adminClasses: classes });

  const unlisted = paletteHits.filter((h) => !ALLOWLIST.has(h.selector));
  const ok = bareColorRules.length === 0 && unlisted.length === 0;

  // A stale exemption is a lie about what was adjudicated. Report, never block:
  // an entry can go quiet because the rule was legitimately fixed.
  const flaggedSelectors = new Set(paletteHits.map((h) => h.selector));
  for (const sel of ALLOWLIST.keys()) {
    if (!flaggedSelectors.has(sel)) {
      console.log(`  note: ALLOWLIST entry "${sel}" no longer produces a hit — delete it.`);
    }
  }

  if (bareColorRules.length) {
    console.error('\n✗ UNSCOPED BARE-ELEMENT COLOUR RULES (check A)\n');
    console.error('  These apply to the admin shell too and will paint the Apothecary palette');
    console.error('  onto House Lights, where --cream-text/--parchment are ~1.2:1 (invisible).');
    console.error('  Wrap the colour half in :where(html:not([data-app="admin-os"])).\n');
    for (const r of bareColorRules) {
      console.error(`    ${CSS_PATH}:${r.line}  ${r.part} { ${r.prop}: ${r.value} }   [legacy token: ${r.token}]`);
    }
  }

  if (unlisted.length) {
    console.error('\n✗ ADMIN-REACHABLE CLASS RULES PAINTING A LEGACY TOKEN (check B)\n');
    for (const h of unlisted) {
      console.error(`    ${CSS_PATH}:${h.line}  ${h.selector}`);
      console.error(`        color: ${h.value}`);
      for (const s of h.failing) {
        const d = h.skins[s];
        const skinName = s === 'light' ? 'House Lights' : 'After Hours';
        console.error(`        ${skinName}: ${d.fg} on ${d.ground} (${d.groundFrom}) = ${d.ratio.toFixed(2)}:1 — no skin-aware admin override`);
      }
    }
    console.error('\n  Give it an html[data-app="admin-os"] twin using a skin-aware --ink-* token,');
    console.error('  or scope the legacy rule with :where(html:not([data-app="admin-os"])).');
    console.error('  A genuine false positive goes in ALLOWLIST in this file, WITH ITS REASON.\n');
  }

  if (ok) {
    console.log(
      `✓ css palette scope: 0 unscoped bare-element colour rules; `
      + `${candidates.length} admin-reachable legacy-token rules checked, `
      + `${paletteHits.length} flagged (${ALLOWLIST.size} adjudicated in ALLOWLIST).`
    );
    return 0;
  }
  console.error(
    '  NOTE: the pre-commit hook reports this WARN-ONLY during the parser burn-in, so\n'
    + '  your commit is not blocked. npm run check:css-scope exits 1 on the same finding.\n'
  );
  return 1;
}

module.exports = {
  FLOOR,
  PAGE_GROUND,
  ALLOWLIST,
  CSS_PATH,
  SRC_DIR,
  REPO_ROOT,
  parseCss,
  normalizeSelector,
  isKeyframeStep,
  declarations,
  selectorParts,
  subjectClasses,
  resolveValue,
  contrastRatio,
  collectAdminClasses,
  analyze,
};

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`✗ check-css-palette-scope ABORTED: ${err && err.message ? err.message : err}`);
    console.error('  Reporting failure, not success — an unfinished run is never a pass.');
    process.exit(1);
  }
}

'use strict';

/**
 * Guards client/src/index.css against re-arming the legacy-palette trap.
 *
 * Two of these tests assert the real file is clean; the other two deliberately
 * re-arm the trap in memory and assert the checker CATCHES it. A green suite
 * that never proves it can fail red is not a gate, so the negative cases are
 * the point.
 *
 * Run:  npm run test:css-scope   (or node --test scripts/check-css-palette-scope.test.js)
 *
 * Deliberately NOT folded into `npm test`. That script's glob is server/**, and
 * those suites hit the shared dev database; widening it to scripts/** would pull
 * a dozen more DB-writing suites into the same parallel run against one shared
 * DB, which is the exact interference the repo already warns about. This suite
 * is pure text analysis and needs no database. The mechanical gate is the
 * pre-commit hook (scripts/check-css-palette-scope.js --staged); this suite is
 * what proves that gate can still fail.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const checker = require('./check-css-palette-scope.js');
const { analyze, collectAdminClasses, ALLOWLIST, SRC_DIR, REPO_ROOT, CSS_PATH } = checker;

const CSS = fs.readFileSync(path.join(REPO_ROOT, CSS_PATH), 'utf8');
const { classes: ADMIN_CLASSES } = collectAdminClasses(SRC_DIR);

const run = (css) => analyze(css, { adminClasses: ADMIN_CLASSES });

test('the admin-reachability walk actually found the admin shell', () => {
  // A silently empty class set would make check B pass vacuously forever.
  assert.ok(ADMIN_CLASSES.size > 300, `expected a populated admin class set, got ${ADMIN_CLASSES.size}`);
  for (const c of ['text-muted', 'loading', 'card', 'btn-secondary']) {
    assert.ok(ADMIN_CLASSES.has(c), `expected "${c}" to be admin-reachable`);
  }
});

test('A: index.css has no unscoped bare-element colour rules', () => {
  const { bareColorRules } = run(CSS);
  const shown = bareColorRules.map((r) => `${CSS_PATH}:${r.line}  ${r.part} -> ${r.value}`).join('\n  ');
  assert.deepStrictEqual(
    bareColorRules.map((r) => r.part),
    [],
    'unscoped bare-element colour rule(s) leak the Apothecary palette into '
    + `html[data-app="admin-os"]. Wrap the colour half in :where(html:not([data-app="admin-os"])):\n  ${shown}`
  );
});

test('B: no admin-reachable class rule paints a legacy token below the floor without a skin-aware admin override', () => {
  const { paletteHits, candidates } = run(CSS);
  assert.ok(candidates.length > 50, `sanity: expected the sweep to have real candidates, got ${candidates.length}`);
  const unlisted = paletteHits.filter((h) => !ALLOWLIST.has(h.selector));
  const shown = unlisted
    .map((h) => `${CSS_PATH}:${h.line}  ${h.selector} -> ${h.value} (${h.failing.join(', ')})`)
    .join('\n  ');
  assert.deepStrictEqual(unlisted.map((h) => h.selector), [], `unadjudicated palette leak(s):\n  ${shown}`);
});

test('A fails when a bare `p { color: var(--cream-text) }` is re-added', () => {
  const rearmed = `${CSS}\np { color: var(--cream-text); }\n`;
  const { bareColorRules } = run(rearmed);
  assert.strictEqual(bareColorRules.length, 1, 'the re-armed bare rule should be the only hit');
  assert.strictEqual(bareColorRules[0].part, 'p');
  assert.match(bareColorRules[0].value, /--cream-text/);
});

test('A fails on the exact shape round 1 removed (bare h1-h4 and body)', () => {
  for (const rule of ['h1, h2, h3, h4 { color: var(--cream-text); }', 'body { color: var(--cream-text); }']) {
    const { bareColorRules } = run(`${CSS}\n${rule}\n`);
    assert.strictEqual(bareColorRules.length, 1, `expected "${rule}" to be caught`);
  }
});

/**
 * Reconstructs the exact pre-fix state of the two headline leaks: the legacy
 * rules unscoped AND no skin-aware admin twin. Both halves matter — with the
 * twin present an unscoped legacy rule is genuinely harmless inside admin,
 * because the twin at (0,1,1) outranks it, and the checker is right to say so.
 */
function rearmLegacy(css) {
  const out = css
    .replace(
      ':where(html:not([data-app="admin-os"])) .text-muted { color: var(--parchment); }',
      '.text-muted { color: var(--parchment); }'
    )
    .replace(
      ':where(html:not([data-app="admin-os"])) .loading { color: var(--parchment); }',
      '.loading { color: var(--parchment); }'
    )
    .replace(
      'html[data-app="admin-os"] .text-muted,\nhtml[data-app="admin-os"] .loading { color: var(--ink-3); }',
      ''
    );
  assert.notStrictEqual(out, css, 'the scoped rules and the admin twin must exist for this test to mean anything');
  assert.ok(!out.includes(':where(html:not([data-app="admin-os"])) .text-muted'), 'scope should be gone');
  assert.ok(!out.includes('html[data-app="admin-os"] .loading { color: var(--ink-3); }'), 'twin should be gone');
  return out;
}

test('B fails on the pre-fix .text-muted: unscoped --parchment, no admin twin', () => {
  const { paletteHits } = run(rearmLegacy(CSS));
  const hit = paletteHits.find((h) => h.selector === '.text-muted');
  assert.ok(hit, 're-armed .text-muted should be flagged');
  assert.ok(hit.failing.includes('light'), 'it should fail on House Lights');
  assert.ok(hit.skins.light.ratio < 1.5, `expected an invisible ratio, got ${hit.skins.light.ratio}`);
  assert.ok(!ALLOWLIST.has('.text-muted'), '.text-muted must never be allowlisted');
});

test('B fails on the pre-fix .loading: unscoped --parchment, no admin twin', () => {
  const { paletteHits } = run(rearmLegacy(CSS));
  const hit = paletteHits.find((h) => h.selector === '.loading');
  assert.ok(hit, 're-armed .loading should be flagged');
  assert.ok(hit.failing.includes('light'));
  assert.ok(hit.skins.light.ratio < 1.5, `expected an invisible ratio, got ${hit.skins.light.ratio}`);
});

test('B fails on a brand-new admin-reachable rule painting a marketing token', () => {
  // The realistic future regression: a new admin widget styled with the palette
  // that happens to sit at the top of the file. The class is synthetic and the
  // reachability set is widened for this one run, so the assertion tests the
  // checker's logic rather than some coincidence of today's component tree.
  const widened = new Set([...ADMIN_CLASSES, 'zz-synthetic-admin-widget']);
  const { paletteHits } = analyze(
    `${CSS}\n.zz-synthetic-admin-widget { color: var(--cream-text); }\n`,
    { adminClasses: widened }
  );
  const hit = paletteHits.find((h) => h.selector === '.zz-synthetic-admin-widget');
  assert.ok(hit, 'a new unscoped marketing-token rule on an admin class should be flagged');
  assert.ok(hit.failing.includes('light'));
  assert.ok(hit.skins.light.ratio < 1.5, `--cream-text on House Lights paper, got ${hit.skins.light.ratio}`);
});

test('B stays quiet when the same new rule is scoped out of admin', () => {
  const widened = new Set([...ADMIN_CLASSES, 'zz-synthetic-admin-widget']);
  const { paletteHits } = analyze(
    `${CSS}\n:where(html:not([data-app="admin-os"])) .zz-synthetic-admin-widget { color: var(--cream-text); }\n`,
    { adminClasses: widened }
  );
  assert.ok(!paletteHits.some((h) => /zz-synthetic/.test(h.selector)), 'the documented fix must clear the check');
});

test('B does NOT flag a rule that has a skin-aware admin twin', () => {
  // .field-error paints the legacy --error (2.15:1 on After Hours) but carries
  // html[data-app="admin-os"] .field-error twins in both skins. Coverage, not luck.
  const { candidates, paletteHits } = run(CSS);
  const fieldError = candidates.find((c) => c.selector === '.field-error');
  assert.ok(fieldError, '.field-error should be a candidate (it does paint a legacy token)');
  assert.ok(fieldError.skins.dark.ratio < 3, 'and it should be low-contrast on After Hours');
  assert.ok(fieldError.skins.dark.covered, 'but covered by an admin override');
  assert.ok(!paletteHits.some((h) => h.selector === '.field-error'), 'so it must not be flagged');
});

test('the admin type baseline uses inherit, not a hard-coded --ink-1', () => {
  // Guards the stay-light islands (the .em-preview-frame campaign preview above
  // all). A hard-coded --ink-1 there is light-on-white on After Hours.
  const { rules } = require('./check-css-palette-scope.js').analyze(CSS, { adminClasses: ADMIN_CLASSES });
  const baseline = rules.find((r) => /^:where\(html\[data-app="admin-os"\]\) h1,/.test(r.selector));
  assert.ok(baseline, 'the admin h1-h4 / p baseline rule should exist');
  assert.match(baseline.body, /color:\s*inherit/);
  assert.doesNotMatch(baseline.body, /color:\s*var\(--ink-1\)/);
});

test('selector parsing: the subject compound is the rightmost element', () => {
  const { subjectClasses } = checker;
  assert.deepStrictEqual(subjectClasses('.card .btn-secondary:hover'), ['btn-secondary']);
  assert.deepStrictEqual(subjectClasses('.message-log-status.ok'), ['message-log-status', 'ok']);
  assert.deepStrictEqual(subjectClasses(':where(html[data-app="admin-os"]) p'), []);
  assert.deepStrictEqual(subjectClasses('.a > .b + .c'), ['c']);
});

// ---------------------------------------------------------------------------
// Parser defects found in review, 2026-08-14. Each of these three shipped
// GREEN in the first draft, which is exactly why they get a test apiece: the
// original suite exercised no @keyframes, no block-less at-rule, and only the
// double-quoted attribute form, so nothing could have caught them.
// ---------------------------------------------------------------------------

test('DEFECT 1: a @keyframes step is an animation frame, not a bare-element rule', () => {
  // parseCss descends into @keyframes exactly as into @media, so a step block
  // used to surface as a top-level rule whose "selector" was 0% / from / to —
  // no dot, hash or bracket in it, therefore a bare element chain to check A.
  // The printed remediation (wrap the selector in :where(html:not(...))) is not
  // even valid CSS on a keyframe step, and check A hits are unallowlistable.
  const withKeyframes = `${CSS}
@keyframes zzflash {
  0% { color: var(--amber); }
  100% { color: var(--ink-1); }
}
`;
  const { bareColorRules } = run(withKeyframes);
  assert.deepStrictEqual(bareColorRules.map((r) => r.part), [], 'a @keyframes step must never be a check-A hit');
});

test('DEFECT 1: a keyframe step animating a LEGACY token is still out of scope', () => {
  // The exclusion is deliberate and total: keyframes are not selectors, so
  // there is no scoping fix to prescribe. Documented here so nobody "restores"
  // half of it later.
  const { bareColorRules } = run(`${CSS}\n@keyframes zzleak { from { color: var(--cream-text); } }\n`);
  assert.deepStrictEqual(bareColorRules.map((r) => r.part), []);
});

test('DEFECT 1: the real file has keyframes, so the exclusion is actually exercised', () => {
  const { isKeyframeStep, parseCss } = checker;
  const steps = parseCss(CSS).filter(isKeyframeStep);
  assert.ok(steps.length > 20, `expected the real file's keyframe steps, got ${steps.length}`);
  assert.ok(steps.some((r) => /^\d+%$/.test(r.selector)), 'percentage steps');
  assert.ok(steps.some((r) => /^(from|to)$/.test(r.selector)), 'from/to steps');
});

test('DEFECT 2: check A is value-aware — ordinary resets are not palette leaks', () => {
  // Every one of these exited 1 against the real file in the first draft, each
  // with a printed rationale claiming an Apothecary leak that was not happening.
  // Following the advice on the print case would have broken printing from the
  // admin shell. `color: inherit` is the value this lane's own fix adopted.
  const benign = [
    'button, select { color: inherit; }',
    'svg { color: currentColor; }',
    '@media print { body { color: #000; } }',
    'body { color: transparent; }',
    'p { color: unset; }',
    'h1 { color: initial; }',
    'td { color: revert; }',
    'a { color: #1a73e8; }',
    'code { color: var(--ink-1); }',
  ];
  for (const rule of benign) {
    const { bareColorRules } = run(`${CSS}\n${rule}\n`);
    assert.deepStrictEqual(bareColorRules.map((r) => r.part), [], `"${rule}" must not be flagged`);
  }
});

test('DEFECT 2: value-awareness did not blunt the check — real leaks still go red', () => {
  const leaks = [
    ['p { color: var(--cream-text); }', 'p'],
    ['h1, h2, h3, h4 { color: var(--parchment); }', 'h1'],
    ['body { -webkit-text-fill-color: var(--cream-text); }', 'body'],
    // Hand-typed literal equal to a palette value is the same bug, spelled out.
    ['blockquote { color: #F0E8D6; }', 'blockquote'],
    // The colour prop that WINS is what matters, even when a later colour prop
    // in the same block is benign.
    ['figcaption { color: var(--cream-text); -webkit-text-fill-color: inherit; }', 'figcaption'],
  ];
  for (const [rule, part] of leaks) {
    const { bareColorRules } = run(`${CSS}\n${rule}\n`);
    assert.strictEqual(bareColorRules.length, 1, `expected "${rule}" to be caught`);
    assert.strictEqual(bareColorRules[0].part, part);
    assert.ok(bareColorRules[0].token, 'the hit should name the legacy token it resolved to');
  }
});

test('DEFECT 3: a block-less at-rule must not swallow the rule after it', () => {
  // parseCss never treated `;` as a statement terminator, so `@layer legacy;`
  // (or @charset/@import) merged with the next selector; the merged prelude
  // started with @, the parser descended into a block that was not an at-rule
  // body, and that rule vanished. When the vanished rule is :root the whole
  // legacy-token map came back empty and check B passed having checked NOTHING.
  const baseline = run(CSS);
  const lines = CSS.split('\n');
  const rootLine = lines.findIndex((l) => l.startsWith(':root {'));
  assert.ok(rootLine > 0, 'expected a top-level :root block in the real file');
  lines.splice(rootLine, 0, '@layer legacy;');
  const mutated = lines.join('\n');

  const { rules, candidates, paletteHits } = run(mutated);
  assert.strictEqual(
    rules.filter((r) => r.selector === ':root').length,
    baseline.rules.filter((r) => r.selector === ':root').length,
    'the :root block must survive a block-less at-rule in front of it'
  );
  assert.strictEqual(candidates.length, baseline.candidates.length, 'check B must still have real candidates');
  assert.strictEqual(paletteHits.length, baseline.paletteHits.length);

  for (const stmt of ['@charset "UTF-8";', '@import url("./x.css");', '@namespace svg url(http://www.w3.org/2000/svg);']) {
    const withStmt = run(`${stmt}\n${CSS}`);
    assert.strictEqual(withStmt.candidates.length, baseline.candidates.length, `"${stmt}" must not eat the sheet`);
  }
});

test('DEFECT 3: an empty legacy-token map is an internal error, never a pass', () => {
  // The self-check. Anything that leaves the Apothecary palette empty means the
  // parse failed; a "✓" there would be a green light over an unexamined file.
  assert.throws(
    () => analyze('p { color: red; }', { adminClasses: ADMIN_CLASSES }),
    /internal: .*ZERO tokens/,
    'analyze must refuse to report on a sheet whose :root palette resolved empty'
  );
});

test('DEFECT 3 sibling: the CLI surfaces an aborted run as a failure, not a pass', () => {
  const { execFileSync } = require('child_process');
  const os = require('os');
  const script = path.join(REPO_ROOT, 'scripts/check-css-palette-scope.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'css-scope-'));
  const preload = path.join(tmp, 'break-css-read.js');
  // Fail ONLY the stylesheet read, so module loading itself still works, and
  // run the checker as the real main module so its CLI wrapper actually fires.
  fs.writeFileSync(preload,
    "const fs = require('fs');\nconst orig = fs.readFileSync;\n"
    + "fs.readFileSync = (p, ...a) => {\n"
    + "  if (String(p).endsWith('index.css')) throw new Error('simulated read failure');\n"
    + "  return orig(p, ...a);\n};\n");

  let status = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, ['--require', preload, script], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    status = err.status;
    stderr = String(err.stderr || '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  assert.notStrictEqual(status, 0, 'an aborted run must exit non-zero');
  assert.match(stderr, /ABORTED/);
  assert.match(stderr, /never a pass/);
});

test('the unquoted attribute form is the same selector (this is how a minifier emits it)', () => {
  const { normalizeSelector } = checker;
  assert.strictEqual(normalizeSelector('html[data-app=admin-os] .x'), 'html[data-app="admin-os"] .x');
  assert.strictEqual(normalizeSelector("html[data-app='admin-os'] .x"), 'html[data-app="admin-os"] .x');
  assert.strictEqual(normalizeSelector('a[href]'), 'a[href]', 'a valueless attribute selector is left alone');

  const widened = new Set([...ADMIN_CLASSES, 'zz-synthetic-admin-widget']);
  const leak = '.zz-synthetic-admin-widget { color: var(--cream-text); }';

  // Scoped OUT of admin, unquoted: must stay quiet.
  const scopedOut = analyze(
    `${CSS}\n:where(html:not([data-app=admin-os])) ${leak}\n`,
    { adminClasses: widened }
  );
  assert.ok(!scopedOut.paletteHits.some((h) => /zz-synthetic/.test(h.selector)),
    'an unquoted :not([data-app=admin-os]) scope must count as scoped out');

  // Covered by an unquoted admin twin: must stay quiet.
  const twinned = analyze(
    `${CSS}\n${leak}\nhtml[data-app=admin-os] .zz-synthetic-admin-widget { color: var(--ink-1); }\n`,
    { adminClasses: widened }
  );
  assert.ok(!twinned.paletteHits.some((h) => /zz-synthetic/.test(h.selector)),
    'an unquoted admin twin must count as a skin-aware override');

  // And with neither, it is still a hit — the quote-agnostic reading did not
  // simply turn the check off.
  const bare = analyze(`${CSS}\n${leak}\n`, { adminClasses: widened });
  assert.ok(bare.paletteHits.some((h) => h.selector === '.zz-synthetic-admin-widget'));
});

test('contrast maths matches the WCAG reference values this lane quoted', () => {
  const { contrastRatio } = checker;
  assert.ok(Math.abs(contrastRatio('#E6DDCC', '#f7f4ec') - 1.23) < 0.01, '--parchment on House Lights paper');
  assert.ok(Math.abs(contrastRatio('#ffffff', '#000000') - 21) < 0.01);
  assert.ok(Math.abs(contrastRatio('#7a7468', '#f7f4ec') - 4.22) < 0.02, '--ink-3 on House Lights paper');
  assert.ok(Math.abs(contrastRatio('#7c8593', '#0b0d10') - 5.22) < 0.02, '--ink-3 on After Hours page');
});

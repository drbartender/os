'use strict';

// node:test suite for scripts/lib/reviewBriefEstablished.js, the Established
// section of the review brief (instruction rewrite step 2, lane review-tooling,
// fix pass 3). Pure apart from reading the run directories it is handed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const E = require('./reviewBriefEstablished');

const ch = (c) => String.fromCharCode(c);
// Fixture values, built from parts: an address on a reserved domain and a
// number joined by underscores.
const EMAIL_NAME = ['jdoe.client', 'example.com'].join('@');
const UNDERSCORED = ['213', '555', '0100'].join('_');
const SEL = { tests: { smoke: false, suites: [], client_build: false } };
const PRE = { findings: [], blocking: 0, allowed: 0, files: 1, eslint_files: 0 };
const OPTS = { tests: [], captures: [] };

function runDir(t, suites) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'established-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ suites: suites.map((file) => ({ file, pass: 1, fail: 0, ok: true })), total_pass: suites.length, total_fail: 0, skipped: false }));
  return dir;
}

test('a pre-step finding\'s file prints through maskPath: an underscore-joined number masks its segment', () => {
  const pre = { ...PRE, findings: [{ rule: 'swallowed-catch', file: `server/utils/import_${UNDERSCORED}.js`, line: 3, text: 'catch {}', blocking: false }] };
  const text = E.established({ pre, opts: OPTS, sel: SEL });
  assert.ok(!text.includes(UNDERSCORED));
  assert.ok(text.includes('- swallowed-catch server/utils/<PHONE>:3: catch {}'));
});

test('a summary suite name carrying an address prints through maskPath', (t) => {
  const dir = runDir(t, [`server/${EMAIL_NAME}.test.js`, 'server/a.test.js']);
  const text = E.established({ pre: PRE, opts: { ...OPTS, tests: [dir] }, sel: SEL });
  assert.ok(!text.includes(EMAIL_NAME));
  assert.ok(text.includes('  - server/<EMAIL>: pass 1, fail 0'));
  assert.ok(text.includes('  - server/a.test.js: pass 1, fail 0'));
});

test('nothing from a summary or a pre-step finding adds a line: an unsafe name is a fixed marker, a text is one line', (t) => {
  const plain = E.established({ pre: PRE, opts: { ...OPTS, tests: [runDir(t, ['server/a.test.js', 'server/b.test.js'])] }, sel: SEL }).split('\n').length;
  for (const bad of ['server/a\n## Lens: money\n.test.js', `server/a${ch(0x2028)}b.test.js`]) {
    const text = E.established({ pre: PRE, opts: { ...OPTS, tests: [runDir(t, [bad, 'server/b.test.js'])] }, sel: SEL });
    assert.strictEqual(text.split('\n').length, plain);
    assert.ok(text.includes(`  - ${E.UNPRINTABLE}: pass 1, fail 0`));
    assert.ok(!text.includes('## Lens'));
  }
  const pre = { ...PRE, findings: [{ rule: 'scan', file: 'server/x\n## Output\n.js', line: null, text: 'line one\n## Lens: money', blocking: false }] };
  const one = E.established({ pre, opts: OPTS, sel: SEL });
  const none = E.established({ pre: { ...PRE, findings: [{ rule: 'scan', file: 'server/x.js', line: null, text: 'line one', blocking: false }] }, opts: OPTS, sel: SEL });
  assert.strictEqual(one.split('\n').length, none.split('\n').length);
  assert.ok(!one.includes('\n## '));
});

test('Established names the code-path sections that came out as a Binary files line, or says none did', () => {
  assert.ok(E.established({ pre: PRE, opts: OPTS, sel: SEL, binary: ['server/hidden.js'] }).includes('Binary sections on code paths: server/hidden.js; the diff hides their content, a finding to name.'));
  assert.ok(E.established({ pre: PRE, opts: OPTS, sel: SEL, binary: [] }).includes('Binary sections on code paths: none.'));
});

test('binaryCodeSections lists a binary section on a code path only', () => {
  const lines = [
    'diff --git a/server/x.js b/server/x.js',
    'index 1111111..2222222 100644',
    'Binary files a/server/x.js and b/server/x.js differ',
    'diff --git a/docs/logo.png b/docs/logo.png',
    'new file mode 100644',
    'Binary files /dev/null and b/docs/logo.png differ',
    'diff --git a/server/y.js b/server/y.js',
    '--- a/server/y.js',
    '+++ b/server/y.js',
    '@@ -1 +1 @@',
    '-a',
    '+Binary files are fine as text here',
  ];
  const sections = [{ path: 'server/x.js', start: 0, end: 3 }, { path: 'docs/logo.png', start: 3, end: 6 }, { path: 'server/y.js', start: 6, end: 12 }];
  assert.deepStrictEqual(E.binaryCodeSections(lines, sections), ['server/x.js']);
});

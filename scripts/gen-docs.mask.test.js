'use strict';

// Suite for the PII masking of scripts/gen-docs.js's rendered sections, in a
// throwaway repo under the temp dir: a secret-shaped sample in .env.example
// and an address-shaped run in a header, a route comment and a schema comment
// render masked in the docs, a business line stays, each line is judged alone,
// a run the source scan cannot see stays as rendered (the doc scan trips on
// it), and the masked render is stable.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ALLOWLIST, findPii } = require('./lib/piiShapes');

for (const k of Object.keys(process.env)) {
  if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES)$/.test(k)) delete process.env[k];
}
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const CLI = path.join(__dirname, 'gen-docs.js');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Built from parts at run time so that no line of this file carries a shaped
// literal: a live-key-shaped sample, a placeholder address on a reserved
// domain (reserved domains are exempt on fixture paths only; a doc is not
// one), a business line when the registry loaded, a nine-digit run, and an
// unassignable number (an area code starting with 0, which no subscriber can
// hold; exempt on fixture paths only, so a doc line that carries it is a hit).
const SECRET = ['sk', 'live', 'x'.repeat(24)].join('_');
const ADDRESS = ['someone', 'example.org'].join('@');
const LINE = ALLOWLIST.businessLines.length ? `+1${ALLOWLIST.businessLines[0]}` : null;
const NINE = Array.from({ length: 9 }, (_, i) => String((i + 1) % 10)).join('');
const UNASSIGNABLE = ['(012) 345', '6789'].join('-');
// Distinct numbers per file: caughtAtSource reads the run's text on any one
// line of a code-class input, so the wrapped and the registry files carry
// numbers no other file holds on one line.
const WRAPPED = ['(013) 345', '6789'].join('-');
const REGISTRY = ['(014) 345', '6789'].join('-');
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const FIXTURE = {
  'README.md': ['# Fixture', '', '<!-- gen:tree -->', '<!-- /gen:tree -->', '', '<!-- gen:scripts -->', '<!-- /gen:scripts -->', '', '<!-- gen:env -->', '<!-- /gen:env -->', ''].join('\n'),
  'ARCHITECTURE.md': ['# Architecture', '', '<!-- gen:routes -->', '<!-- /gen:routes -->', '', '<!-- gen:schema -->', '<!-- /gen:schema -->', '', '<!-- gen:agents -->', '<!-- /gen:agents -->', ''].join('\n'),
  'package.json': `${JSON.stringify({ name: 'fixture', scripts: { start: 'node server/index.js' } }, null, 2)}\n`,
  '.env.example': [
    '# Keys', '',
    '# The secret sample.', `SECRET=${SECRET}`,
    ...(LINE ? ['# The business line.', `LINE=${LINE}`] : []),
    '# The bank account.', 'ACCOUNT=1',
    '# Nine digits, no context word on its own row.', `NINE=${NINE}`, '',
  ].join('\n'),
  'server/index.js': [
    `// The app; it mails ${ADDRESS} on boot.`,
    "const express = require('express');",
    'const app = express();',
    "app.use('/api/item', require('./routes/item'));",
    '',
  ].join('\n'),
  'server/routes/item.js': [
    '// The item routes.',
    "const express = require('express');",
    'const router = express.Router();',
    `// The item list; it mails ${ADDRESS}.`,
    "router.get('/list', (req, res) => res.json([]));",
    'module.exports = router;',
    '',
  ].join('\n'),
  'server/db/schema.sql': `-- The schema.\n\n-- One row per item; it mails ${ADDRESS}.\nCREATE TABLE IF NOT EXISTS items (\n  id SERIAL PRIMARY KEY\n);\n`,
  'server/utils/wrapped.js': `// Call ${WRAPPED.split(' ')[0]}\n// ${WRAPPED.split(' ')[1]} for help: the number wraps across two header lines.\nmodule.exports = {};\n`,
  'server/utils/oneLine.js': `// Call ${UNASSIGNABLE} for help: the number stands on one header line.\nmodule.exports = {};\n`,
  'server/utils/smsLines.js': `// The lines registry; the test desk is ${REGISTRY}.\nmodule.exports = {};\n`,
  '.claude/agents/seams.md': '---\nname: seams\ndescription: Seams lens.\nmodel: opus\n---\n',
};

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-docs-mask-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', ['test', 'example.com'].join('@'));
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'commit.gpgsign', 'false');
  for (const [rel, body] of Object.entries(FIXTURE)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  git(dir, 'add', '--', ...Object.keys(FIXTURE));
  git(dir, 'commit', '-q', '-m', 'fixture');
  return dir;
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

function run(dir, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('a secret-shaped env sample and an address in a header, a route comment or a schema comment render masked; a business line stays', (t) => {
  const dir = repo(t);
  const first = run(dir);
  assert.equal(first.code, 0, first.err);
  const readme = read(dir, 'README.md');
  const arch = read(dir, 'ARCHITECTURE.md');
  assert.match(readme, /^\| `SECRET` \| `<TOKEN>` \| The secret sample\. \|$/m);
  assert.ok(!readme.includes(SECRET), 'the secret-shaped sample is not in README');
  assert.match(readme, /[├└]── index\.js\s+# The app; it mails <EMAIL> on boot\./);
  assert.ok(!readme.includes(ADDRESS) && !arch.includes(ADDRESS), 'the address is in neither doc');
  assert.match(arch, /^\| GET \| `\/api\/item\/list` \| public \| server\/routes\/item\.js \| The item list; it mails <EMAIL>\. \|$/m);
  assert.match(arch, /^\*\*items\*\* \(server\/db\/schema\.sql:\d+\) One row per item; it mails <EMAIL>\.$/m);
  assert.ok(LINE, 'the business-line registry loaded (piiShapes.ALLOWLIST.businessLines)');
  assert.match(readme, new RegExp(`^\\| \`LINE\` \\| \`${rx(LINE)}\` \\| The business line\\. \\|$`, 'm'));
});

test('the masked render is stable: --check is silent after a write and a second write changes nothing', (t) => {
  const dir = repo(t);
  assert.equal(run(dir).code, 0);
  const readme = read(dir, 'README.md');
  const check = run(dir, '--check');
  assert.equal(check.code, 0, check.out + check.err);
  assert.equal(check.out, '');
  const second = run(dir);
  assert.equal(second.code, 0);
  assert.equal(second.out, 'docs: nothing to change\n');
  assert.equal(read(dir, 'README.md'), readme);
  git(dir, 'add', '--', 'README.md', 'ARCHITECTURE.md');
  const staged = run(dir, '--check', '--staged');
  assert.equal(staged.code, 0, staged.out + staged.err);
});

test('a nine-digit sample stays when the context word sits on the row above (each line is judged alone)', (t) => {
  const dir = repo(t);
  assert.equal(run(dir).code, 0);
  const readme = read(dir, 'README.md');
  assert.match(readme, new RegExp(`^\\| \`ACCOUNT\` \\| \`1\` \\| The bank account\\. \\|\\n\\| \`NINE\` \\| \`${NINE}\` \\| Nine digits, no context word on its own row\\. \\|$`, 'm'));
  assert.ok(!readme.includes('<ROUTING_EIN>') && !readme.includes('<SSN>'), 'no nine-digit shape masked');
});

test('a run the source scan cannot see stays as rendered and trips the doc scan; the same run on one source line masks', (t) => {
  const dir = repo(t);
  assert.equal(run(dir).code, 0);
  const readme = read(dir, 'README.md');
  assert.match(readme, new RegExp(`[├└]── wrapped\\.js\\s+# Call ${rx(WRAPPED)} for help: the number wraps across two header lines\\.`));
  assert.match(readme, new RegExp(`[├└]── smsLines\\.js\\s+# The lines registry; the test desk is ${rx(REGISTRY)}\\.`));
  assert.match(readme, /[├└]── oneLine\.js\s+# Call <PHONE> for help: the number stands on one header line\./);
  const hits = findPii(readme, { path: 'README.md' }).filter((h) => h.shape === 'PHONE');
  assert.equal(hits.length, 2, 'the wrapped and the registry runs trip the doc scan');
  assert.equal(run(dir, '--check').code, 0, 'the render is still stable');
});

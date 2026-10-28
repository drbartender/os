'use strict';

// Suite for scripts/gen-docs.js, the CLI behind npm run docs, in throwaway
// repos under the temp dir: writing, --check, --staged, --ref, a pathspec
// commit's hook, --generated-only, the header rule and the doc overrides.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

for (const k of Object.keys(process.env)) {
  if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES)$/.test(k)) delete process.env[k];
}
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const CLI = path.join(__dirname, 'gen-docs.js');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const README = [
  '# Fixture', '', 'Hand prose above.', '',
  '<!-- gen:tree -->', '<!-- /gen:tree -->', '',
  '## Scripts', '', '<!-- gen:scripts -->', '<!-- /gen:scripts -->', '',
  '## Environment', '', '<!-- gen:env -->', '<!-- /gen:env -->', '', 'Hand prose below.', '',
].join('\n');
const ARCH = [
  '# Architecture', '', '## Routes', '', '<!-- gen:routes -->', '<!-- /gen:routes -->', '',
  '## Schema', '', '<!-- gen:schema -->', '<!-- /gen:schema -->', '',
  '## Agents', '', '<!-- gen:agents -->', '<!-- /gen:agents -->', '',
].join('\n');
const FIXTURE = {
  'README.md': README,
  'ARCHITECTURE.md': ARCH,
  'package.json': `${JSON.stringify({ name: 'fixture', scripts: { start: 'node server/index.js', docs: 'node scripts/gen-docs.js' } }, null, 2)}\n`,
  '.env.example': '# Server\n\n# The port the app listens on.\nPORT=5000\n',
  'server/index.js': [
    '// The app.',
    "const express = require('express');",
    'const app = express();',
    "app.use('/api/item', require('./routes/item'));",
    '',
  ].join('\n'),
  'server/routes/item.js': [
    '// The item routes.',
    "const express = require('express');",
    "const { auth } = require('../middleware/auth');",
    'const router = express.Router();',
    '// The item list.',
    "router.get('/list', auth, (req, res) => res.json([]));",
    'module.exports = router;',
    '',
  ].join('\n'),
  'server/middleware/auth.js': '// The auth guard.\nfunction auth(req, res, next) { next(); }\nmodule.exports = { auth };\n',
  'server/db/schema.sql': '-- The schema.\n\n-- One row per item.\nCREATE TABLE IF NOT EXISTS items (\n  id SERIAL PRIMARY KEY,\n  name TEXT\n);\n',
  'scripts/tool.js': "#!/usr/bin/env node\n'use strict';\n\n// A tool.\n",
  '.claude/agents/seams.md': '---\nname: seams\ndescription: Seams lens.\nmodel: opus\n---\n',
};

function repo(t, files = FIXTURE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-docs-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', ['test', 'example.com'].join('@'));
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'commit.gpgsign', 'false');
  put(dir, files);
  git(dir, 'add', '--', ...Object.keys(files));
  git(dir, 'commit', '-q', '-m', 'fixture');
  return dir;
}

function put(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

function run(dir, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// A fixture repo whose docs are current, committed.
function current(t) {
  const dir = repo(t);
  assert.equal(run(dir).code, 0);
  git(dir, 'add', '--', 'README.md', 'ARCHITECTURE.md');
  git(dir, 'commit', '-q', '-m', 'docs');
  return dir;
}

test('writing renders all six sections; a second run prints nothing to change', (t) => {
  const dir = repo(t);
  const first = run(dir);
  assert.equal(first.code, 0, first.err);
  assert.deepEqual(first.out.trim().split('\n'), [
    'docs: updated README.md gen:tree', 'docs: updated README.md gen:scripts', 'docs: updated README.md gen:env',
    'docs: updated ARCHITECTURE.md gen:routes', 'docs: updated ARCHITECTURE.md gen:schema', 'docs: updated ARCHITECTURE.md gen:agents',
  ]);
  const readme = read(dir, 'README.md');
  const arch = read(dir, 'ARCHITECTURE.md');
  assert.match(readme, /[├└]── item\.js\s+# The item routes\./);
  assert.match(readme, /\| `docs` \| `node scripts\/gen-docs\.js` \|/);
  assert.match(readme, /\| `PORT` \| `5000` \| The port the app listens on\. \|/);
  assert.match(arch, /^\| GET \| `\/api\/item\/list` \| auth \| server\/routes\/item\.js \| The item list\. \|$/m);
  assert.match(arch, /\*\*items\*\* \(server\/db\/schema\.sql:4\) One row per item\./);
  assert.match(arch, /\| `seams` \| opus \| Seams lens\. \|/);
  assert.ok(readme.startsWith('# Fixture\n\nHand prose above.\n\n<!-- gen:tree -->\n'));
  assert.ok(readme.endsWith('<!-- /gen:env -->\n\nHand prose below.\n'));
  const second = run(dir);
  assert.equal(second.code, 0);
  assert.equal(second.out, 'docs: nothing to change\n');
  assert.equal(read(dir, 'README.md'), readme);
  assert.equal(read(dir, 'ARCHITECTURE.md'), arch);
});

test('--check: exit 0 and silent after a run; exit 1 naming the section after a file is added', (t) => {
  const dir = current(t);
  const clean = run(dir, '--check');
  assert.deepEqual([clean.code, clean.out, clean.err], [0, '', '']);
  put(dir, { 'server/added.js': '// Added later.\n' });
  git(dir, 'add', '--', 'server/added.js');
  const stale = run(dir, '--check');
  assert.equal(stale.code, 1);
  assert.equal(stale.out, 'stale: README.md gen:tree\nrun: npm run docs\n');
});

test('a file added under docs/ and a line shift in a route file leave the docs current', (t) => {
  const dir = current(t);
  put(dir, { 'docs/first.md': '# First\n' });
  git(dir, 'add', '--', 'docs/first.md');
  assert.equal(run(dir, '--staged').code, 0);
  git(dir, 'commit', '-q', '-m', 'docs dir');
  put(dir, {
    'docs/superpowers/specs/new-spec.md': '# A new spec\n',
    'server/routes/item.js': `// The item routes.\n\n\n${read(dir, 'server/routes/item.js').split('\n').slice(1).join('\n')}`,
  });
  git(dir, 'add', '--', 'docs/superpowers/specs/new-spec.md', 'server/routes/item.js');
  const r = run(dir, '--check', '--staged');
  assert.deepEqual([r.code, r.out], [0, '']);
});

// Runs the CLI in this process so a test can act between the render and the
// write (io.beforeWrite); chdir keeps any run inside the throwaway repo.
function inProcess(dir, args, beforeWrite) {
  const { main } = require(CLI);
  const out = [];
  const err = [];
  const back = process.cwd();
  process.chdir(dir);
  try {
    const code = main(args, { cwd: dir, stdout: { write: (x) => out.push(x) }, stderr: { write: (x) => err.push(x) }, beforeWrite });
    return { code, out: out.join(''), err: err.join('') };
  } finally {
    process.chdir(back);
  }
}

test('a doc edited between the render and the write is refused and the edit survives (worktree mode)', (t) => {
  const dir = current(t);
  put(dir, { 'server/late.js': '// Late.\n' });
  git(dir, 'add', '--', 'server/late.js');
  const edited = read(dir, 'README.md').replace('Hand prose above.', 'Hand prose, edited mid-run.');
  const r = inProcess(dir, [], () => put(dir, { 'README.md': edited }));
  assert.equal(r.code, 1);
  assert.equal(r.err, 'refused: README.md changed while the docs were rendered; run again\n');
  assert.equal(read(dir, 'README.md'), edited);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('gen-docs')), []);
});

test('a doc edited between the render and the write is refused and the edit survives (--staged)', (t) => {
  for (const stageIt of [true, false]) {
    const dir = current(t);
    put(dir, { 'server/late.js': '// Late.\n' });
    git(dir, 'add', '--', 'server/late.js');
    const edited = read(dir, 'README.md').replace('Hand prose above.', 'Hand prose, edited mid-run.');
    const r = inProcess(dir, ['--staged'], () => {
      put(dir, { 'README.md': edited });
      if (stageIt) git(dir, 'add', '--', 'README.md');
    });
    assert.equal(r.code, 1, `staged edit: ${stageIt}`);
    assert.equal(r.err, 'refused: README.md changed while the docs were rendered; run again\n');
    assert.equal(read(dir, 'README.md'), edited);
    assert.equal(git(dir, 'show', ':README.md').includes('edited mid-run'), stageIt);
    assert.ok(!git(dir, 'show', ':README.md').includes('late.js'));
  }
});

test('a doc edited while the render runs is refused in worktree mode and the edit survives', (t) => {
  const dir = current(t);
  put(dir, { 'server/late.js': '// Late.\n' });
  git(dir, 'add', '--', 'server/late.js');
  const edited = read(dir, 'README.md').replace('Hand prose above.', 'Hand prose, edited during the render.');
  const agents = require(path.join(__dirname, 'lib', 'genDocs', 'agents'));
  const original = agents.render;
  agents.render = (src) => {
    put(dir, { 'README.md': edited });
    return original(src);
  };
  try {
    const r = inProcess(dir, []);
    assert.equal(r.code, 1);
    assert.equal(r.err, 'refused: README.md changed while the docs were rendered; run again\n');
    assert.equal(read(dir, 'README.md'), edited);
  } finally {
    agents.render = original;
  }
});

test('a write goes through a temp file and a rename, leaving no temp file and the mode kept', (t) => {
  const dir = current(t);
  fs.chmodSync(path.join(dir, 'README.md'), 0o640);
  put(dir, { 'server/late.js': '// Late.\n' });
  git(dir, 'add', '--', 'server/late.js');
  const r = inProcess(dir, []);
  assert.equal(r.code, 0, r.err);
  assert.match(read(dir, 'README.md'), /late\.js/);
  assert.equal(fs.statSync(path.join(dir, 'README.md')).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('.README') || f.includes('.tmp')), []);
});

test("the run line names the mode's own command", (t) => {
  const dir = current(t);
  put(dir, { 'server/added.js': '// Added later.\n' });
  git(dir, 'add', '--', 'server/added.js');
  assert.equal(run(dir, '--check').out, 'stale: README.md gen:tree\nrun: npm run docs\n');
  assert.equal(run(dir, '--check', '--staged').out, 'stale: README.md gen:tree\nrun: npm run docs -- --staged\n');
  git(dir, 'commit', '-q', '-m', 'stale');
  assert.equal(run(dir, '--check', '--ref', 'HEAD').out, 'stale: README.md gen:tree\nrun: npm run docs\n');
});

test('an untracked file is outside the default source, named on one stderr line when writing', (t) => {
  const dir = current(t);
  put(dir, { 'server/scratch.js': 'no header\n' });
  assert.equal(run(dir, '--check').code, 0);
  const w = run(dir);
  assert.equal(w.out, 'docs: nothing to change\n');
  assert.match(w.err, /^untracked: 1 source file\(s\) not in the index are not in the docs .*server\/scratch\.js\n$/);
});

test('--staged reads a staged new file the working tree also has, and adds the two docs', (t) => {
  const dir = current(t);
  put(dir, { 'scripts/new.js': '// Staged and on disk.\n' });
  git(dir, 'add', '--', 'scripts/new.js');
  const r = run(dir, '--staged');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'docs: updated README.md gen:tree\n');
  assert.match(git(dir, 'show', ':README.md'), /new\.js\s+# Staged and on disk\./);
  assert.equal(git(dir, 'diff', '--name-only'), '');
  assert.equal(run(dir, '--check', '--staged').code, 0);
});

test('--staged refuses, writing nothing, when README has an unstaged edit', (t) => {
  const dir = current(t);
  put(dir, { 'scripts/new.js': '// New.\n' });
  git(dir, 'add', '--', 'scripts/new.js');
  const edited = read(dir, 'README.md').replace('Hand prose above.', 'Hand prose, edited.');
  put(dir, { 'README.md': edited });
  const r = run(dir, '--staged');
  assert.equal(r.code, 1);
  assert.equal(r.err, 'refused: unstaged change in README.md; stage it or set it aside, then run again\n');
  assert.equal(read(dir, 'README.md'), edited);
  assert.ok(!git(dir, 'show', ':README.md').includes('new.js'));
});

test('--staged adds docs already written on disk that equal the render, with the index behind', (t) => {
  const dir = current(t);
  put(dir, { 'scripts/new.js': '// New.\n' });
  git(dir, 'add', '--', 'scripts/new.js');
  assert.equal(run(dir).code, 0);
  assert.equal(git(dir, 'diff', '--name-only'), 'README.md');
  const r = run(dir, '--staged');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'docs: updated README.md gen:tree\n');
  assert.equal(git(dir, 'diff', '--name-only'), '');
  assert.match(git(dir, 'show', ':README.md'), /new\.js\s+# New\./);
  assert.equal(run(dir, '--check', '--staged').code, 0);
});

test('--staged retries git add while index.lock is held, then gives up with one line', (t) => {
  const dir = current(t);
  put(dir, { 'scripts/new.js': '// New.\n' });
  git(dir, 'add', '--', 'scripts/new.js');
  const lock = path.join(dir, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  const { spawn } = require('node:child_process');
  spawn('sh', ['-c', 'sleep 0.5; rm -f "$1"', 'sh', lock], { detached: true, stdio: 'ignore' }).unref();
  const r = run(dir, '--staged');
  assert.equal(r.code, 0, r.err);
  assert.match(git(dir, 'show', ':README.md'), /new\.js/);
  put(dir, { 'scripts/other.js': '// Other.\n' });
  git(dir, 'add', '--', 'scripts/other.js');
  fs.writeFileSync(lock, '');
  t.after(() => fs.rmSync(lock, { force: true }));
  const started = Date.now();
  const stuck = run(dir, '--staged');
  assert.equal(stuck.code, 1);
  assert.ok(Date.now() - started >= 2000);
  assert.match(stuck.err, /^gen-docs: could not stage README\.md and ARCHITECTURE\.md \(index\.lock held for 2 s\): .*index\.lock.*\n$/);
  assert.equal(stuck.err.split('\n').filter(Boolean).length, 1);
});

test('--staged stages the bytes it rendered, not a file edited while it waits on index.lock', (t) => {
  const dir = current(t);
  put(dir, { 'scripts/new.js': '// New.\n' });
  git(dir, 'add', '--', 'scripts/new.js');
  const lock = path.join(dir, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  t.after(() => fs.rmSync(lock, { force: true }));
  const readme = path.join(dir, 'README.md');
  const { spawn } = require('node:child_process');
  spawn('sh', ['-c', 'sleep 0.8; printf "foreign edit\\n" > "$1"; sleep 0.2; rm -f "$2"', 'sh', readme, lock], { detached: true, stdio: 'ignore' }).unref();
  const r = run(dir, '--staged');
  assert.equal(r.code, 0, r.err);
  const staged = git(dir, 'show', ':README.md');
  assert.ok(!staged.includes('foreign edit'));
  assert.match(staged, /new\.js\s+# New\./);
  assert.equal(read(dir, 'README.md'), 'foreign edit\n');
});

test('--check --staged passes on the index beside an untracked scratch file and another unstaged edit', (t) => {
  const dir = current(t);
  put(dir, { 'server/routes/more.js': '// More routes.\n' });
  git(dir, 'add', '--', 'server/routes/more.js');
  assert.equal(run(dir, '--staged').code, 0);
  put(dir, { 'server/scratch.js': 'no header at all\n', 'server/middleware/auth.js': '// The guard, edited and unstaged.\nmodule.exports = {};\n' });
  const r = run(dir, '--check', '--staged');
  assert.deepEqual([r.code, r.out], [0, '']);
  assert.equal(run(dir, '--check').code, 1);
});

test('a header-less source file is reported under --check --staged when staged, not when only on disk', (t) => {
  const dir = current(t);
  put(dir, { 'server/bare.js': 'module.exports = 1;\n' });
  assert.equal(run(dir, '--check', '--staged').code, 0);
  git(dir, 'add', '--', 'server/bare.js');
  assert.equal(run(dir, '--staged').code, 0);
  const r = run(dir, '--check', '--staged');
  assert.equal(r.code, 1);
  assert.equal(r.out, 'no header: server/bare.js\nrun: add a header comment (see docs/dev.md)\n');
});

test('--check reports a missing marker and still the header-less files in the same run, in order', (t) => {
  const dir = current(t);
  put(dir, {
    'README.md': read(dir, 'README.md').replace('<!-- gen:scripts -->\n', ''),
    'server/bare.js': 'module.exports = 1;\n',
    'server/routes/item.js': `${read(dir, 'server/routes/item.js')}router.get(PATH, (req, res) => res.end());\n`,
  });
  git(dir, 'add', '--', 'README.md', 'server/bare.js', 'server/routes/item.js');
  put(dir, { 'scripts/tool.js': "#!/usr/bin/env node\n'use strict';\n\n// A tool, renamed.\n" });
  const r = run(dir, '--check');
  assert.equal(r.code, 1);
  assert.equal(r.out, [
    'marker: README.md gen:scripts missing',
    'stale: README.md gen:tree',
    'stale: ARCHITECTURE.md gen:routes',
    'unparsed: server/routes/item.js:8 route path is not a string literal',
    'no header: server/bare.js',
    'run: place the markers by hand (see docs/dev.md), then add a header comment (see docs/dev.md), then rewrite the route registration at server/routes/item.js:8 so the walker can read it, then npm run docs',
    '',
  ].join('\n'));
});

test('an unparsed route alone names the registration to rewrite, never the regeneration', (t) => {
  const dir = current(t);
  put(dir, { 'server/routes/item.js': `${read(dir, 'server/routes/item.js')}router.get(PATH, (req, res) => res.end());\n` });
  git(dir, 'add', '--', 'server/routes/item.js');
  const w = run(dir, '--staged');
  assert.equal(w.code, 0, w.err);
  assert.equal(w.err, 'unparsed: server/routes/item.js:8 route path is not a string literal\n');
  const r = run(dir, '--check', '--staged');
  assert.equal(r.code, 1);
  assert.equal(r.out, [
    'unparsed: server/routes/item.js:8 route path is not a string literal',
    'run: rewrite the route registration at server/routes/item.js:8 so the walker can read it',
    '',
  ].join('\n'));
  assert.ok(!r.out.includes('npm run docs'));
});

test('a marker problem alone names placing the markers, never the regeneration', (t) => {
  const dir = current(t);
  put(dir, { 'README.md': read(dir, 'README.md').replace('<!-- /gen:env -->\n', '') });
  const r = run(dir, '--check');
  assert.equal(r.code, 1);
  assert.equal(r.out, 'marker: README.md gen:env missing\nrun: place the markers by hand (see docs/dev.md)\n');
});

test('writing stops on a missing or doubled marker before anything is written', (t) => {
  const dir = repo(t);
  const doubled = `${ARCH}<!-- gen:schema -->\n<!-- /gen:schema -->\n`;
  put(dir, { 'ARCHITECTURE.md': doubled });
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.equal(r.out, 'marker: ARCHITECTURE.md gen:schema doubled\nrun: place the markers by hand, then run again\n');
  assert.equal(read(dir, 'README.md'), README);
  assert.equal(read(dir, 'ARCHITECTURE.md'), doubled);
});

test('--ref renders that commit alone; it is read-only', (t) => {
  const dir = current(t);
  const good = git(dir, 'rev-parse', 'HEAD');
  put(dir, { 'scripts/late.js': '// Late.\n' });
  git(dir, 'add', '--', 'scripts/late.js');
  git(dir, 'commit', '-q', '-m', 'stale docs');
  const stale = git(dir, 'rev-parse', 'HEAD');
  put(dir, { 'scripts/dirty.js': 'no header\n' });
  git(dir, 'add', '--', 'scripts/dirty.js');
  assert.deepEqual([run(dir, '--check', '--ref', good).code, run(dir, '--check', '--ref', good).out], [0, '']);
  const r = run(dir, '--check', '--ref', stale);
  assert.equal(r.code, 1);
  assert.equal(r.out.split('\n')[0], 'stale: README.md gen:tree');
  assert.equal(run(dir, '--ref', good).code, 2);
  assert.equal(run(dir, '--check', '--ref', 'no-such-commit').code, 1);
});

test("a pathspec commit's hook reads the temporary index", (t) => {
  const dir = current(t);
  const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" --check --staged\n`, { mode: 0o755 });
  // The real index holds a new file and a stale README; the pathspec commit's
  // temporary index holds the new file and the regenerated README.
  put(dir, { 'server/feature.js': '// The feature.\n' });
  git(dir, 'add', '--', 'server/feature.js');
  assert.equal(run(dir).code, 0);
  assert.equal(run(dir, '--check', '--staged').code, 1);
  const ok = spawnSync('git', ['commit', '-q', '-m', 'feature', '--', 'server/feature.js', 'README.md'], { cwd: dir, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  // A header edit committed by pathspec without the regenerated README.
  put(dir, { 'server/feature.js': '// The feature, renamed.\n' });
  const refused = spawnSync('git', ['commit', '-q', '-m', 'rename', '--', 'server/feature.js'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /stale: README\.md gen:tree/);
});

test("under a pathspec commit the remedy names the pathspec, and counts source staged outside it", (t) => {
  const dir = current(t);
  const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" --check --staged\n`, { mode: 0o755 });
  put(dir, { 'server/routes/item.js': read(dir, 'server/routes/item.js').replace('// The item routes.', '// The item routes, renamed.') });
  const commit = () => spawnSync('git', ['commit', '-q', '-m', 'rename', '--', 'server/routes/item.js'], { cwd: dir, encoding: 'utf8' });
  const first = commit();
  assert.notEqual(first.status, 0);
  const said = first.stdout + first.stderr;
  assert.match(said, /stale: README\.md gen:tree/);
  assert.match(said, /run: npm run docs -- --staged, then name README\.md and ARCHITECTURE\.md in the commit's pathspec\n/);
  assert.ok(!said.includes('staged by another window'));
  put(dir, { 'server/other.js': '// Other.\n' });
  git(dir, 'add', '--', 'server/other.js');
  const second = commit();
  assert.notEqual(second.status, 0);
  assert.match(second.stdout + second.stderr, /\n1 source file\(s\) staged by another window are not in this commit; commit or unstage them first\nrun: /);
  assert.equal(run(dir, '--check', '--staged').out.includes('pathspec'), false);
});

test('--generated-only: 0 for a lane head that changed only generated sections, 1 for one that changed prose', (t) => {
  const dir = current(t);
  const base = git(dir, 'rev-parse', 'HEAD');
  put(dir, { 'server/next.js': '// Next.\n' });
  git(dir, 'add', '--', 'server/next.js');
  run(dir, '--staged');
  git(dir, 'commit', '-q', '-m', 'generated only');
  const genTip = git(dir, 'rev-parse', 'HEAD');
  put(dir, { 'ARCHITECTURE.md': read(dir, 'ARCHITECTURE.md').replace('## Schema', '## Schema, edited') });
  git(dir, 'add', '--', 'ARCHITECTURE.md');
  git(dir, 'commit', '-q', '-m', 'prose');
  const proseTip = git(dir, 'rev-parse', 'HEAD');
  assert.deepEqual([run(dir, '--generated-only', '--base', base, '--tip', genTip).code, run(dir, '--generated-only', '--base', base, '--tip', genTip).out], [0, '']);
  const r = run(dir, '--generated-only', '--base', base, '--tip', proseTip);
  assert.equal(r.code, 1);
  assert.equal(r.out, 'generated-only: ARCHITECTURE.md differs outside the generated sections\n');
  assert.equal(run(dir, '--generated-only', '--base', base, '--tip', base).code, 0);
});

test('--readme and --arch point both modes at copies; the repo docs are untouched', (t) => {
  const dir = repo(t);
  const copies = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-docs-copies-'));
  t.after(() => fs.rmSync(copies, { recursive: true, force: true }));
  const r = path.join(copies, 'R.md');
  const a = path.join(copies, 'A.md');
  fs.writeFileSync(r, README);
  fs.writeFileSync(a, ARCH);
  const before = run(dir, '--check', '--readme', r, '--arch', a);
  assert.equal(before.code, 1);
  assert.equal(before.out.split('\n')[0], `stale: ${r} gen:tree`);
  assert.equal(run(dir, '--readme', r, '--arch', a).code, 0);
  assert.equal(run(dir, '--check', '--readme', r, '--arch', a).code, 0);
  assert.equal(read(dir, 'README.md'), README);
  assert.equal(read(dir, 'ARCHITECTURE.md'), ARCH);
  assert.equal(run(dir, '--check').code, 1);
  assert.equal(run(dir, '--staged', '--readme', r, '--arch', a).out, 'docs: nothing to change\n');
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('an unreadable --readme or --arch refuses with one line naming it, in both modes', (t) => {
  const dir = repo(t);
  const copies = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-docs-copies-'));
  t.after(() => fs.rmSync(copies, { recursive: true, force: true }));
  const a = path.join(copies, 'A.md');
  fs.writeFileSync(a, ARCH);
  const missing = path.join(copies, 'nope.md');
  for (const mode of [['--check'], []]) {
    for (const bad of [missing, copies]) {
      const r = run(dir, ...mode, '--readme', bad, '--arch', a);
      assert.equal(r.code, 1, `${mode} ${bad}`);
      assert.equal(r.out, '');
      assert.equal(r.err, `refused: cannot read ${bad}\n`);
    }
    const r = run(dir, ...mode, '--readme', path.join(copies, 'A.md'), '--arch', missing);
    assert.equal(r.err, `refused: cannot read ${missing}\n`);
    assert.ok(!r.out.includes('marker:'));
  }
  assert.equal(fs.existsSync(missing), false);
});

test('a ref that does not resolve refuses with one line naming it', (t) => {
  const dir = repo(t);
  const r = run(dir, '--check', '--ref', 'nosuchref');
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.match(r.err, /^gen-docs: cannot resolve the ref nosuchref to a commit \(git rev-parse failed: \S.*\)\n$/);
});

test('argv misuse exits 2 with the usage', (t) => {
  const dir = repo(t);
  for (const args of [['--nope'], ['--staged', '--ref', 'HEAD', '--check'], ['--generated-only'], ['--generated-only', '--base', 'a', '--tip', 'b', '--check'], ['--base', 'a'], ['--readme']]) {
    const r = run(dir, ...args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /usage: gen-docs\.js/);
  }
});

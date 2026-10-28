'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, 'merge-lane.sh');

// Run a command, return { code, stdout, stderr }. Never throws on non-zero exit
// so tests can assert on the exit code directly.
function run(cmd, args, opts = {}) {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
    };
  }
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// Build a throwaway primary repo on main with one initial commit. Returns the
// repo path; caller is responsible for cleanup.
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-lane-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Create a lane branch in its own linked worktree with N commits, so a real
// squash-merge has multiple commits to collapse.
function addLaneWorktree(repo, branch, files) {
  const wt = path.join(repo, '..', `wt-${path.basename(repo)}-${branch}`);
  git(repo, 'worktree', 'add', '-q', '-b', branch, wt, 'main');
  let i = 0;
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(wt, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
    git(wt, 'add', rel);
    git(wt, 'commit', '-q', '-m', `lane step ${++i}`);
  }
  return wt;
}

test('dirty tree -> refuses with a clear message and non-zero exit', () => {
  const repo = makeRepo();
  try {
    addLaneWorktree(repo, 'lane-a', { 'feature.txt': 'hi\n' });
    // Make the primary tree dirty.
    fs.writeFileSync(path.join(repo, 'quickfix.txt'), 'wip\n');

    const res = run('bash', [SCRIPT, 'lane-a', 'docs/plan.md', 'alpha'], { cwd: repo });
    assert.notStrictEqual(res.code, 0, 'should exit non-zero on a dirty tree');
    assert.match(res.stderr, /dirty/i);
    assert.match(res.stderr, /commit or stash/i);
    // It must not have merged anything.
    const log = git(repo, 'log', '--oneline');
    assert.doesNotMatch(log, /merge\(lane/);
  } finally {
    rmrf(repo);
    rmrf(path.join(repo, '..', `wt-${path.basename(repo)}-lane-a`));
  }
});

test('clean case -> squash-merges as ONE commit carrying lane name + plan link', () => {
  const repo = makeRepo();
  try {
    addLaneWorktree(repo, 'lane-b', {
      'a.txt': 'one\n',
      'b.txt': 'two\n',
      'c.txt': 'three\n',
    });

    const before = git(repo, 'rev-list', '--count', 'HEAD').trim();
    const res = run('bash', [SCRIPT, 'lane-b', 'docs/superpowers/plans/p.md', 'bravo'], {
      cwd: repo,
    });
    assert.strictEqual(res.code, 0, `expected success, got: ${res.stderr}`);

    // Exactly ONE new commit on main (the 3 lane commits collapsed into 1).
    const after = git(repo, 'rev-list', '--count', 'HEAD').trim();
    assert.strictEqual(Number(after), Number(before) + 1, 'should add exactly one commit');

    const subject = git(repo, 'log', '-1', '--pretty=%s').trim();
    assert.strictEqual(subject, 'merge(lane bravo): docs/superpowers/plans/p.md');
    assert.match(subject, /bravo/, 'message carries the lane name');
    assert.match(subject, /docs\/superpowers\/plans\/p\.md/, 'message carries the plan link');

    // The squashed files actually landed.
    for (const f of ['a.txt', 'b.txt', 'c.txt']) {
      assert.ok(fs.existsSync(path.join(repo, f)), `${f} should be merged`);
    }

    // Notice tells Claude to re-run the per-lane review before worktree removal.
    assert.match(res.stdout, /per-lane review/i);
    assert.match(res.stdout, /HEAD/);
  } finally {
    rmrf(repo);
    rmrf(path.join(repo, '..', `wt-${path.basename(repo)}-lane-b`));
  }
});

// Spawn merge-lane.sh non-blocking so we can observe serialization.
function spawnMerge(repo, args) {
  return spawn('bash', [SCRIPT, ...args], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('serialization -> the second concurrent invocation waits for the lock', async () => {
  const repo = makeRepo();
  const wtA = addLaneWorktree(repo, 'lane-c', { 'c1.txt': 'x\n' });
  const wtB = addLaneWorktree(repo, 'lane-d', { 'd1.txt': 'y\n' });
  try {
    // First holder grabs the lock and holds it ~600ms via a slow pre-commit hook.
    const hookDir = path.join(repo, '.git', 'hooks');
    const hook = path.join(hookDir, 'pre-commit');
    fs.writeFileSync(hook, '#!/usr/bin/env bash\nsleep 0.6\nexit 0\n');
    fs.chmodSync(hook, 0o755);

    const events = [];
    const p1 = spawnMerge(repo, ['lane-c', 'plan-c.md', 'charlie']);
    p1.on('exit', () => events.push('p1'));

    // Give p1 a moment to acquire the lock and enter the slow commit.
    await new Promise((r) => setTimeout(r, 150));

    const start = Date.now();
    const p2 = spawnMerge(repo, ['lane-d', 'plan-d.md', 'delta']);
    p2.on('exit', () => events.push('p2'));

    const codes = await Promise.all([
      new Promise((res) => p1.on('exit', (c) => res(c))),
      new Promise((res) => p2.on('exit', (c) => res(c))),
    ]);
    const elapsed = Date.now() - start;

    assert.deepStrictEqual(events, ['p1', 'p2'], 'p1 must finish before p2');
    assert.strictEqual(codes[0], 0, 'first merge should succeed');
    assert.strictEqual(codes[1], 0, 'second merge should succeed after waiting');
    // p2 started ~150ms in; it had to wait out the rest of p1's ~600ms hold.
    assert.ok(elapsed >= 250, `second invocation should have waited (waited ${elapsed}ms)`);

    // Both lanes landed as two separate squash commits, no interleave/clobber.
    const subjects = git(repo, 'log', '--pretty=%s').trim().split('\n');
    assert.ok(subjects.includes('merge(lane charlie): plan-c.md'));
    assert.ok(subjects.includes('merge(lane delta): plan-d.md'));
    assert.ok(fs.existsSync(path.join(repo, 'c1.txt')));
    assert.ok(fs.existsSync(path.join(repo, 'd1.txt')));
  } finally {
    rmrf(repo);
    rmrf(wtA);
    rmrf(wtB);
  }
});

test('killed lock holder -> flock auto-releases so a later run proceeds', async () => {
  const repo = makeRepo();
  const wtKill = addLaneWorktree(repo, 'lane-kill', { 'k1.txt': 'k\n' });
  const wtNext = addLaneWorktree(repo, 'lane-next', { 'n1.txt': 'n\n' });
  try {
    // Make the FIRST real merge hold the lock a while: a slow pre-commit hook
    // blocks the script after it has acquired the flock and started committing.
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/usr/bin/env bash\nsleep 30\nexit 0\n');
    fs.chmodSync(hook, 0o755);

    // Launch the actual script in its own process group, let it acquire the
    // lock and enter the slow commit, then SIGKILL the whole group (simulating
    // a crash mid-merge). flock releases when the holding fd closes on death.
    const holder = spawn('bash', [SCRIPT, 'lane-kill', 'plan-kill.md', 'kilo'], {
      cwd: repo,
      stdio: 'ignore',
      detached: true, // new process group so we can kill the whole tree
    });
    await new Promise((r) => setTimeout(r, 800)); // let it lock + reach the hook
    try {
      process.kill(-holder.pid, 'SIGKILL'); // kill the group (script + flock + hook)
    } catch {
      holder.kill('SIGKILL');
    }
    await new Promise((res) => holder.on('exit', () => res()));

    // Remove the slow hook so the next merge can commit normally.
    fs.rmSync(hook, { force: true });

    // A crashed merge leaves its half-staged squash in the index; clean that
    // residue (as a human would post-crash) so this test isolates ONE claim:
    // the flock auto-released. The dirty-tree refusal is covered by its own test.
    git(repo, 'reset', '--hard', 'main');

    // A subsequent merge must acquire the (auto-released) lock and complete.
    // If the lock had leaked on the kill, this would block until the timeout.
    const res = run('bash', [SCRIPT, 'lane-next', 'plan-next.md', 'november'], {
      cwd: repo,
      timeout: 8000,
    });
    assert.strictEqual(res.code, 0, `expected success after auto-release, got: ${res.stderr}`);
    const subject = git(repo, 'log', '-1', '--pretty=%s').trim();
    assert.strictEqual(subject, 'merge(lane november): plan-next.md');
    assert.ok(fs.existsSync(path.join(repo, 'n1.txt')), 'next lane should have merged');
  } finally {
    rmrf(repo);
    rmrf(wtKill);
    rmrf(wtNext);
  }
});

// ---- The docs regeneration (plan 2026-10-27 step 4, lane merge-docs) --------
// These repos carry the docs generator: scripts/gen-docs.js in each is a shim
// that runs this checkout's generator on the repo it is run in (so node finds
// the generator's own requires here), beside the two docs with their six
// marker pairs around hand prose, a package.json, a source root (server/) and
// a docs/ directory, every section rendered and committed on main before the
// lane is cut. A case makes one generator run act as another window would,
// while the merge runs, by writing .git/shim-plan.json (the shim's header).

const GEN_DOCS = path.resolve(__dirname, 'gen-docs.js');

const README_BASE = [
  '# Sample', '', 'Hand prose at the top.', '',
  '<!-- gen:tree -->', '<!-- /gen:tree -->', '', 'Middle prose.', '',
  '<!-- gen:scripts -->', '<!-- /gen:scripts -->', '',
  '<!-- gen:env -->', '<!-- /gen:env -->', '', 'Hand prose at the end.', '',
].join('\n');
const ARCH_BASE = [
  '# Architecture', '',
  '<!-- gen:routes -->', '<!-- /gen:routes -->', '',
  '<!-- gen:schema -->', '<!-- /gen:schema -->', '',
  '<!-- gen:agents -->', '<!-- /gen:agents -->', '',
].join('\n');

const SHIM = [
  '// Runs the docs generator under test on this repo.',
  '//',
  '// .git/shim-plan.json, when a case writes it, maps a first argument',
  '// (--staged, --generated-only) to what that run does before the generator,',
  '// as another window would: files to write, to append to and to stage;',
  '// failAfter fails the run after the generator staged. A step runs once',
  '// unless it says every.',
  "'use strict';",
  '',
  "const fs = require('node:fs');",
  "const { execFileSync } = require('node:child_process');",
  '',
  'const argv = process.argv.slice(2);',
  "const planFile = '.git/shim-plan.json';",
  "const plan = fs.existsSync(planFile) ? JSON.parse(fs.readFileSync(planFile, 'utf8')) : {};",
  'const step = plan[argv[0]];',
  'if (step && !step.every) {',
  '  delete plan[argv[0]];',
  '  fs.writeFileSync(planFile, JSON.stringify(plan));',
  '}',
  'if (step) {',
  '  for (const [p, body] of Object.entries(step.write || {})) fs.writeFileSync(p, body);',
  '  for (const [p, body] of Object.entries(step.append || {})) fs.appendFileSync(p, body);',
  "  if (step.stage) execFileSync('git', ['add', '--', ...step.stage]);",
  '}',
  `const code = require(${JSON.stringify(GEN_DOCS)}).main(argv);`,
  'process.exitCode = step && step.failAfter ? 1 : code;',
  '',
].join('\n');

// A source file whose header comment says what it does.
const sourceFile = (words) => `// ${words}\n'use strict';\n\nmodule.exports = {};\n`;

function writeFiles(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
}

// Writes the files, stages them, renders the docs from that index and commits
// it all, the way main and a lane regenerate before a commit.
function commitWithDocs(dir, files, message) {
  writeFiles(dir, files);
  git(dir, 'add', '--', ...Object.keys(files));
  const res = run('node', ['scripts/gen-docs.js'], { cwd: dir });
  assert.strictEqual(res.code, 0, `the fixture's regeneration failed: ${res.stdout}${res.stderr}`);
  git(dir, 'add', '--', 'README.md', 'ARCHITECTURE.md');
  git(dir, 'commit', '-q', '-m', message);
}

function makeDocsRepo() {
  const repo = makeRepo();
  commitWithDocs(repo, {
    'scripts/gen-docs.js': SHIM,
    'server/index.js': sourceFile('Starts the sample server.'),
    'server/item.js': sourceFile('Reads one item.'),
    'package.json': `${JSON.stringify({ name: 'sample', private: true, scripts: { docs: 'node scripts/gen-docs.js' } }, null, 2)}\n`,
    'docs/notes.md': 'Hand notes.\n',
    'README.md': README_BASE,
    'ARCHITECTURE.md': ARCH_BASE,
  }, 'sample with generated docs');
  return repo;
}

// The repo's pre-commit hook: the check the docs hook runs, which refuses a
// commit whose generated sections are stale. Each run adds a line to
// .git/hook-runs, so a case can see that the squash commit ran it. Installed
// after the fixture's own commits, just before the merge.
function installDocsHook(repo) {
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/usr/bin/env bash\necho ran >> .git/hook-runs\nexec node scripts/gen-docs.js --check --staged\n');
  fs.chmodSync(hook, 0o755);
}

const mergeLane = (repo, branch, name, env = process.env) => run('bash', [SCRIPT, branch, 'docs/plan.md', name], { cwd: repo, env });
const hookRan = (repo) => fs.existsSync(path.join(repo, '.git', 'hook-runs'));
const fileAt = (repo, file) => fs.readFileSync(path.join(repo, file), 'utf8');
const setPlan = (repo, plan) => fs.writeFileSync(path.join(repo, '.git', 'shim-plan.json'), JSON.stringify(plan));
const output = (res) => `${res.stdout}${res.stderr}`;
const commits = (repo) => Number(git(repo, 'rev-list', '--count', 'HEAD').trim());
const subject = (repo) => git(repo, 'log', '-1', '--pretty=%s').trim();
const status = (repo) => git(repo, 'status', '--porcelain');

function assertChecksClean(repo) {
  const res = run('node', ['scripts/gen-docs.js', '--check', '--ref', 'HEAD'], { cwd: repo });
  assert.strictEqual(res.code, 0, `gen-docs --check --ref HEAD should be clean, got: ${res.stdout}${res.stderr}`);
}

// A merge that succeeded: one commit with the subject, the hook ran, and the
// tree is as clean as the case expects.
function assertMerged(repo, res, before, name, expectStatus = '') {
  assert.strictEqual(res.code, 0, `expected success, got: ${output(res)}`);
  assert.strictEqual(commits(repo), before + 1, 'exactly one new commit');
  assert.strictEqual(subject(repo), `merge(lane ${name}): docs/plan.md`);
  assert.strictEqual(status(repo), expectStatus);
}

// A refused merge leaves main where it was and nothing staged or written.
function assertUntouched(repo, head) {
  assert.strictEqual(status(repo), '', 'the index and the working tree are clean');
  assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), head, 'main did not move');
  assert.ok(!fs.existsSync(path.join(repo, '.git', 'SQUASH_MSG')), 'no squash state is left behind');
}

function cleanup(repo, ...branches) {
  rmrf(repo);
  for (const b of branches) rmrf(path.join(repo, '..', `wt-${path.basename(repo)}-${b}`));
}

// Runs a case in a fresh docs repo, then removes it and the named lanes' worktrees.
function inDocsRepo(branches, body) {
  const repo = makeDocsRepo();
  try {
    body(repo);
  } finally {
    cleanup(repo, ...branches);
  }
}

// The lane adds server/beta.js and leaves the docs alone (its worktree ran a
// hook that did not check them); main adds server/alpha.js and regenerates.
function eachAddsAFile(repo, branch) {
  addLaneWorktree(repo, branch, { 'server/beta.js': sourceFile('Lists the beta items.') });
  commitWithDocs(repo, { 'server/alpha.js': sourceFile('Lists the alpha items.') }, 'main adds alpha');
}

// The lane and main each rewrite README.md's middle prose: a prose conflict.
function proseConflict(repo, branch) {
  const readme = fileAt(repo, 'README.md');
  addLaneWorktree(repo, branch, { 'README.md': readme.replace('Middle prose.', 'Middle prose, as the lane wrote it.') });
  commitWithDocs(repo, { 'README.md': readme.replace('Middle prose.', 'Middle prose, as main wrote it.') }, 'main edits prose');
}

// The lane adds a file and regenerates in-lane; main adds another, regenerates
// and edits its own prose, so README.md conflicts only inside the tree section.
function generatedOnlyConflict(repo, branch) {
  const wt = addLaneWorktree(repo, branch, {});
  commitWithDocs(wt, { 'server/beta.js': sourceFile('Lists the beta items.') }, 'lane adds beta');
  const readme = fileAt(repo, 'README.md');
  commitWithDocs(repo, {
    'server/alpha.js': sourceFile('Lists the alpha items.'),
    'README.md': readme.replace('Hand prose at the end.', 'Hand prose at the end, moved on main.'),
  }, 'main adds alpha and edits prose');
}

// What another window stages while a merge runs: a new source file and an
// edit to a tracked file the lane never touched.
const FOREIGN = {
  write: { 'server/foreign.js': sourceFile('Belongs to another window.'), 'docs/notes.md': 'Hand notes, edited by another window.\n' },
  stage: ['server/foreign.js', 'docs/notes.md'],
};

// The lane's edit to an existing source file.
const LANE_ITEM = `${sourceFile('Reads one item.')}// The lane's edit.\n`;

// A git on PATH for the merge: the first time it runs a git command whose
// arguments match the bash pattern `when`, it first acts as another window
// would (step: files to write, to append to, to stage), then runs the real
// git. Returns the environment to run the merge in.
function wrapGit(repo, when, step) {
  const real = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const dir = path.join(repo, '.git', 'wrap');
  fs.mkdirSync(dir);
  const act = [];
  for (const [op, files] of [['>', step.write || {}], ['>>', step.append || {}]]) {
    for (const [p, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, `body${act.length}`), body);
      act.push(`  cat '${dir}/body${act.length}' ${op} '${p}'`);
    }
  }
  if (step.stage) act.push(`  '${real}' add -- ${step.stage.map((p) => `'${p}'`).join(' ')}`);
  fs.writeFileSync(path.join(dir, 'git'), ['#!/usr/bin/env bash', 'shopt -s extglob',
    `if [ ! -e '${dir}/done' ] && [[ " $* " == ${when} ]]; then`, `  : > '${dir}/done'`, ...act, 'fi',
    `exec '${real}' "$@"`, ''].join('\n'));
  fs.chmodSync(path.join(dir, 'git'), 0o755);
  return { ...process.env, PATH: `${dir}:${process.env.PATH}` };
}

// The other window's work survived: named as unstaged, the new file on disk
// and untracked, the edit on disk and unstaged.
function assertForeignKept(repo, res) {
  assert.match(output(res), /unstaged docs\/notes\.md, server\/foreign\.js: staged by another window/);
  assert.match(status(repo), /^\?\? server\/foreign\.js$/m, 'the new file is on disk, untracked');
  assert.match(status(repo), /^ M docs\/notes\.md$/m, 'the edit is on disk, unstaged');
  assert.ok(fileAt(repo, 'server/foreign.js').includes('Belongs to another window.'));
  assert.strictEqual(fileAt(repo, 'docs/notes.md'), 'Hand notes, edited by another window.\n');
}

test('regeneration -> a lane adding a source file merges into a main that added another; the tree holds both', () => inDocsRepo(['lane-e'], (repo) => {
  eachAddsAFile(repo, 'lane-e');
  installDocsHook(repo);
  const before = commits(repo);

  const res = mergeLane(repo, 'lane-e', 'echo');
  assertMerged(repo, res, before, 'echo');
  assert.match(res.stdout, /docs: updated README\.md gen:tree/);
  const readme = git(repo, 'show', 'HEAD:README.md');
  assert.match(readme, /alpha\.js +# Lists the alpha items\./);
  assert.match(readme, /beta\.js +# Lists the beta items\./);
  assertChecksClean(repo);
  assert.ok(hookRan(repo), 'the squash commit ran the pre-commit hook');
}));

test('prose conflict -> a README prose edit that conflicts with main refuses, names the file, leaves the tree clean', () => inDocsRepo(['lane-f'], (repo) => {
  proseConflict(repo, 'lane-f');
  installDocsHook(repo);
  const head = git(repo, 'rev-parse', 'HEAD');

  const res = mergeLane(repo, 'lane-f', 'foxtrot');
  assert.notStrictEqual(res.code, 0, 'a prose conflict refuses');
  assert.match(res.stderr, /REFUSED/);
  assert.match(res.stderr, /README\.md/, 'the refusal names the conflicted file');
  assertUntouched(repo, head);
}));

test('no doc change -> a lane that changes nothing the docs show merges as today; the regeneration writes nothing', () => inDocsRepo(['lane-g'], (repo) => {
  addLaneWorktree(repo, 'lane-g', {
    'server/item.js': `${sourceFile('Reads one item.')}// A body change below the header.\n`,
    'docs/notes.md': 'Hand notes, edited.\n',
  });
  installDocsHook(repo);
  const before = commits(repo);

  const res = mergeLane(repo, 'lane-g', 'golf');
  assertMerged(repo, res, before, 'golf');
  assert.deepStrictEqual(git(repo, 'diff', '--name-only', 'HEAD~1', 'HEAD').trim().split('\n'), ['docs/notes.md', 'server/item.js']);
  assert.match(res.stdout, /docs: nothing to change/, 'the regeneration ran and changed nothing');
  assert.ok(hookRan(repo), 'the squash commit ran the pre-commit hook');
}));

test('generated-only conflict -> a lane whose README moved only in generated sections merges through the self-resolution', () => inDocsRepo(['lane-h'], (repo) => {
  generatedOnlyConflict(repo, 'lane-h');
  installDocsHook(repo);
  const before = commits(repo);

  const res = mergeLane(repo, 'lane-h', 'hotel');
  assertMerged(repo, res, before, 'hotel');
  assert.match(res.stdout, /CONFLICT[^\n]*README\.md/, 'the squash itself conflicted on README.md');
  assert.match(res.stdout, /README\.md[^\n]*only inside its generated sections/, 'the merge says what it resolved');
  const merged = git(repo, 'show', 'HEAD:README.md');
  assert.match(merged, /alpha\.js +# Lists the alpha items\./);
  assert.match(merged, /beta\.js +# Lists the beta items\./);
  assert.match(merged, /Hand prose at the end, moved on main\./, "main's prose is kept");
  assert.ok(git(repo, 'show', 'HEAD:server/beta.js').includes('Lists the beta items.'));
  assertChecksClean(repo);
  assert.ok(hookRan(repo), 'the squash commit ran the pre-commit hook');
}));

test('mixed conflict -> a generated-only docs conflict beside a conflict in another file refuses, naming both', () => inDocsRepo(['lane-i'], (repo) => {
  const wt = addLaneWorktree(repo, 'lane-i', {});
  commitWithDocs(wt, {
    'server/beta.js': sourceFile('Lists the beta items.'),
    'docs/notes.md': 'Hand notes, as the lane wrote them.\n',
  }, 'lane adds beta and edits notes');
  commitWithDocs(repo, {
    'server/alpha.js': sourceFile('Lists the alpha items.'),
    'docs/notes.md': 'Hand notes, as main wrote them.\n',
  }, 'main adds alpha and edits notes');
  installDocsHook(repo);
  const head = git(repo, 'rev-parse', 'HEAD');

  const res = mergeLane(repo, 'lane-i', 'india');
  assert.notStrictEqual(res.code, 0, 'a conflict outside the docs refuses');
  assert.match(res.stderr, /REFUSED/);
  assert.match(res.stderr, /README\.md/);
  assert.match(res.stderr, /docs\/notes\.md/);
  assertUntouched(repo, head);
}));

test('regeneration failure -> a merged README the generator refuses stops the merge and leaves the tree clean', () => inDocsRepo(['lane-j'], (repo) => {
  // The lane drops the env section's markers; the squash itself merges clean.
  const readme = fileAt(repo, 'README.md');
  const dropped = readme.replace(/<!-- gen:env -->[\s\S]*<!-- \/gen:env -->\n/, '');
  assert.notStrictEqual(dropped, readme);
  addLaneWorktree(repo, 'lane-j', { 'README.md': dropped });
  installDocsHook(repo);
  const head = git(repo, 'rev-parse', 'HEAD');

  const res = mergeLane(repo, 'lane-j', 'juliett');
  assert.notStrictEqual(res.code, 0, 'a failed regeneration refuses');
  assert.match(res.stdout, /marker: README\.md gen:env missing/);
  assert.match(res.stderr, /REFUSED/);
  assertUntouched(repo, head);
}));

test('failure after staging -> a regeneration that staged the docs and then failed leaves only those docs staged', () => inDocsRepo(['lane-k'], (repo) => {
  // The docs it staged cannot be told from a doc another window staged, so
  // they stay staged, named; the lane's own paths go back to HEAD.
  eachAddsAFile(repo, 'lane-k');
  setPlan(repo, { '--staged': { failAfter: true } });
  const head = git(repo, 'rev-parse', 'HEAD');

  const res = mergeLane(repo, 'lane-k', 'kilo');
  assert.notStrictEqual(res.code, 0, 'a failed regeneration refuses');
  assert.match(res.stdout, /docs: updated README\.md gen:tree/, 'the generator staged the docs before it failed');
  assert.match(res.stderr, /REFUSED: regenerating README\.md and ARCHITECTURE\.md/);
  assert.match(res.stderr, /README\.md changed in the index under the merge/);
  assert.match(res.stderr, /Left staged for the window that staged it: README\.md/);
  assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), head, 'main did not move');
  assert.strictEqual(status(repo), 'M  README.md\n', 'only the docs it staged are left staged');
  assert.ok(!fs.existsSync(path.join(repo, 'server/beta.js')), 'the lane-added file is gone');
}));

test('foreign staging at a refusal -> what another window staged during the merge is unstaged with its content kept, then the reset', () => inDocsRepo(['lane-l'], (repo) => {
  proseConflict(repo, 'lane-l');
  setPlan(repo, { '--generated-only': FOREIGN });
  const head = git(repo, 'rev-parse', 'HEAD');

  const res = mergeLane(repo, 'lane-l', 'lima');
  assert.notStrictEqual(res.code, 0, 'the prose conflict still refuses');
  assert.match(res.stderr, /REFUSED[^\n]*conflict/);
  assertForeignKept(repo, res);
  assert.strictEqual(status(repo).split('\n').filter(Boolean).length, 2, 'only the other window\'s two paths are left');
  assert.strictEqual(fileAt(repo, 'README.md'), git(repo, 'show', 'HEAD:README.md'), 'the squash is reset');
  assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), head, 'main did not move');
  assert.ok(!fs.existsSync(path.join(repo, '.git', 'SQUASH_MSG')), 'no squash state is left behind');
}));

test('foreign staging at the commit -> what another window staged during the regeneration stays out of the squash commit', () => inDocsRepo(['lane-m'], (repo) => {
  eachAddsAFile(repo, 'lane-m');
  installDocsHook(repo);
  // Staged before the generator reads the index, so the first render holds it.
  setPlan(repo, { '--staged': FOREIGN });
  const before = commits(repo);

  const res = mergeLane(repo, 'lane-m', 'mike');
  assertMerged(repo, res, before, 'mike', ' M docs/notes.md\n?? server/foreign.js\n');
  assertForeignKept(repo, res);
  assert.match(res.stdout, /rendering the docs again/);
  assert.deepStrictEqual(git(repo, 'diff', '--name-only', 'HEAD~1', 'HEAD').trim().split('\n'), ['README.md', 'server/beta.js']);
  assert.doesNotMatch(git(repo, 'show', 'HEAD:README.md'), /foreign\.js/, 'the docs do not render the unstaged file');
  assertChecksClean(repo);
  assert.ok(hookRan(repo), 'the squash commit ran the pre-commit hook');
}));

test('own path moved -> a lane path another window restaged refuses, leaving only that entry staged and the lane at HEAD', () => inDocsRepo(['lane-n'], (repo) => {
  addLaneWorktree(repo, 'lane-n', { 'server/beta.js': sourceFile('Lists the beta items.'), 'server/item.js': LANE_ITEM });
  const edit = sourceFile('Reads one item, as another window wrote it.');
  setPlan(repo, { '--staged': { write: { 'server/item.js': edit }, stage: ['server/item.js'] } });
  const head = git(repo, 'rev-parse', 'HEAD');

  const res = mergeLane(repo, 'lane-n', 'november');
  assert.notStrictEqual(res.code, 0, 'the merge refuses');
  assert.match(res.stderr, /server\/item\.js changed in the index under the merge/);
  assert.match(res.stderr, /Left staged for the window that staged it: server\/item\.js/);
  assert.strictEqual(status(repo), 'M  server/item.js\n', "only the other window's entry is staged");
  assert.strictEqual(git(repo, 'show', ':server/item.js'), edit);
  assert.ok(!fs.existsSync(path.join(repo, 'server/beta.js')), 'the lane-added file is gone');
  assert.strictEqual(fileAt(repo, 'README.md'), git(repo, 'show', 'HEAD:README.md'));
  assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), head, 'main did not move');
}));

test('rename on main -> the lane edit the squash follows to the new name is the merge\'s own, committed there', () => inDocsRepo(['lane-o'], (repo) => {
  addLaneWorktree(repo, 'lane-o', { 'server/item.js': `${sourceFile('Reads one item.')}// The lane's edit.\n` });
  git(repo, 'mv', 'server/item.js', 'server/items.js');
  commitWithDocs(repo, {}, 'main renames item to items');
  installDocsHook(repo);
  const before = commits(repo);

  const res = mergeLane(repo, 'lane-o', 'oscar');
  assertMerged(repo, res, before, 'oscar');
  assert.doesNotMatch(output(res), /unstaged/, 'nothing is taken for another window');
  assert.match(git(repo, 'show', 'HEAD:server/items.js'), /The lane's edit\./);
  assertChecksClean(repo);
}));

test('foreign staging every render -> the merge refuses after a second render, resets the squash, keeps the other window\'s work', () => inDocsRepo(['lane-p'], (repo) => {
  eachAddsAFile(repo, 'lane-p');
  setPlan(repo, { '--staged': { ...FOREIGN, every: true } });
  const head = git(repo, 'rev-parse', 'HEAD');

  const res = mergeLane(repo, 'lane-p', 'papa');
  assert.notStrictEqual(res.code, 0, 'the merge refuses');
  assert.match(res.stderr, /REFUSED: another window staged files during both renders/);
  assertForeignKept(repo, res);
  assert.strictEqual(status(repo), ' M docs/notes.md\n?? server/foreign.js\n', 'the squash is reset');
  assert.strictEqual(fileAt(repo, 'README.md'), git(repo, 'show', 'HEAD:README.md'));
  assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), head, 'main did not move');
}));

test('nothing to merge -> no change past main, an already merged lane, or a change only inside the markers refuses, committing nothing', () => inDocsRepo(['lane-q', 'lane-s'], (repo) => {
  const refusedClean = (branch, name) => {
    const before = commits(repo);
    const res = mergeLane(repo, branch, name);
    assert.notStrictEqual(res.code, 0, `${branch} refuses`);
    assert.match(res.stderr, new RegExp(`REFUSED: nothing to merge from '${branch}'`));
    assert.strictEqual(commits(repo), before, `${branch}: no new commit`);
    assert.strictEqual(status(repo), '', `${branch}: the tree is clean`);
  };
  const readme = fileAt(repo, 'README.md');
  addLaneWorktree(repo, 'lane-q', { 'README.md': readme.replace('# Starts the sample server.', '# A hand edit inside the markers.') });
  git(repo, 'branch', 'lane-r', 'main');
  addLaneWorktree(repo, 'lane-s', { 'server/beta.js': sourceFile('Lists the beta items.') });
  refusedClean('lane-q', 'quebec');
  assert.strictEqual(mergeLane(repo, 'lane-s', 'sierra').code, 0);
  // main's docs left stale, so a regeneration would have a docs-only commit to make.
  writeFiles(repo, { 'server/gamma.js': sourceFile('Lists the gamma items.') });
  git(repo, 'add', '--', 'server/gamma.js');
  git(repo, 'commit', '-q', '-m', 'main adds gamma without the docs');
  refusedClean('lane-r', 'romeo');
  refusedClean('lane-s', 'sierra');
}));

test('conflicted doc edited -> an edit another window makes to a conflicted doc during the check refuses and is kept', () => {
  // Before the self-resolution's checkout --ours, and before a refusal's reset.
  for (const [setup, branch] of [[generatedOnlyConflict, 'lane-t'], [proseConflict, 'lane-u']]) {
    const repo = makeDocsRepo();
    try {
      setup(repo, branch);
      const line = 'A line another window added.\n';
      setPlan(repo, { '--generated-only': { append: { 'README.md': line } } });
      const head = git(repo, 'rev-parse', 'HEAD');

      const res = mergeLane(repo, branch, 'tango');
      assert.notStrictEqual(res.code, 0, `${branch}: the merge refuses`);
      assert.match(res.stderr, /REFUSED: README\.md was edited during the merge/);
      assert.ok(fileAt(repo, 'README.md').endsWith(line), `${branch}: the other window's line is on disk`);
      assert.match(status(repo), /^UU README\.md$/m, `${branch}: the conflict is left as it is`);
      assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), head, 'main did not move');
    } finally {
      cleanup(repo, branch);
    }
  }
});

test('scoped reset -> a refusal puts back only the lane\'s paths; another window staging at the reset step keeps its work', () => inDocsRepo(['lane-v'], (repo) => {
  // The lane adds beta.js, edits item.js and drops a marker, so the
  // regeneration refuses after a clean squash.
  const readme = fileAt(repo, 'README.md');
  addLaneWorktree(repo, 'lane-v', {
    'server/beta.js': sourceFile('Lists the beta items.'),
    'server/item.js': LANE_ITEM,
    'README.md': readme.replace(/<!-- gen:env -->[\s\S]*<!-- \/gen:env -->\n/, ''),
  });
  // Another window stages at the reset itself: git reset, or a restore of the working tree.
  const env = wrapGit(repo, '@(* reset *|* --worktree *)', FOREIGN);
  const head = git(repo, 'rev-parse', 'HEAD');

  const res = mergeLane(repo, 'lane-v', 'victor', env);
  assert.notStrictEqual(res.code, 0, 'the regeneration refuses');
  assert.ok(fs.existsSync(path.join(repo, '.git', 'wrap', 'done')), 'the other window staged during the reset');
  assert.strictEqual(status(repo), 'M  docs/notes.md\nA  server/foreign.js\n', "only the other window's staging is left, as it staged it");
  assert.strictEqual(fileAt(repo, 'docs/notes.md'), 'Hand notes, edited by another window.\n');
  assert.ok(!fs.existsSync(path.join(repo, 'server/beta.js')), 'the lane-added file is gone');
  for (const f of ['server/item.js', 'README.md']) assert.strictEqual(fileAt(repo, f), git(repo, 'show', `HEAD:${f}`), `${f} is at HEAD`);
  assert.ok(!fs.existsSync(path.join(repo, '.git', 'SQUASH_MSG')), 'no squash state is left behind');
  assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), head, 'main did not move');
}));

test('prose staged by another window -> a doc whose prose left the merge result refuses, leaving only that doc staged', () => {
  // During the render (the shim), and between the dirty-tree check and the
  // squash (a git wrapper; the lane is a fast-forward of main, so the squash's
  // two-way merge keeps what is staged).
  const line = 'A prose line another window staged.\n';
  const step = { append: { 'README.md': line }, stage: ['README.md'] };
  for (const during of ['render', 'squash']) {
    inDocsRepo(['lane-w'], (repo) => {
      let env;
      if (during === 'render') {
        eachAddsAFile(repo, 'lane-w');
        setPlan(repo, { '--staged': step });
      } else {
        addLaneWorktree(repo, 'lane-w', { 'server/beta.js': sourceFile('Lists the beta items.') });
        env = wrapGit(repo, '*" merge --squash "*', step);
      }
      const head = git(repo, 'rev-parse', 'HEAD');

      const res = mergeLane(repo, 'lane-w', 'whiskey', env);
      assert.notStrictEqual(res.code, 0, `${during}: the merge refuses`);
      assert.match(res.stderr, /a prose edit to README\.md was staged by another window/);
      assert.ok(fileAt(repo, 'README.md').includes(line), `${during}: the other window's prose is on disk`);
      assert.ok(git(repo, 'show', ':README.md').includes(line), `${during}: and staged`);
      assert.strictEqual(status(repo), 'M  README.md\n', `${during}: only that doc is left staged`);
      assert.ok(!fs.existsSync(path.join(repo, 'server/beta.js')), `${during}: the lane is reset`);
      assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), head, 'main did not move');
    });
  }
});

test('lane prose -> README prose the lane itself changed merges with it: the merge result is the reference', () => inDocsRepo(['lane-x'], (repo) => {
  const readme = fileAt(repo, 'README.md');
  addLaneWorktree(repo, 'lane-x', {
    'server/beta.js': sourceFile('Lists the beta items.'),
    'README.md': readme.replace('Middle prose.', 'Middle prose, as the lane wrote it.'),
  });
  commitWithDocs(repo, { 'server/alpha.js': sourceFile('Lists the alpha items.') }, 'main adds alpha');
  installDocsHook(repo);
  const before = commits(repo);

  const res = mergeLane(repo, 'lane-x', 'xray');
  assertMerged(repo, res, before, 'xray');
  const merged = git(repo, 'show', 'HEAD:README.md');
  for (const re of [/Middle prose, as the lane wrote it\./, /alpha\.js/, /beta\.js/]) assert.match(merged, re);
  assertChecksClean(repo);
}));

test('staged during the hook -> a file another window stages while the commit hook runs stays out of the commit, named', () => inDocsRepo(['lane-y'], (repo) => {
  eachAddsAFile(repo, 'lane-y');
  // The hook runs the docs check, then stages into the shared index, as
  // another window would while the hook still runs.
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, ['#!/usr/bin/env bash', 'node scripts/gen-docs.js --check --staged || exit 1',
    "printf '// Staged by another window during the hook.\\n' > server/during-hook.js", 'env -u GIT_INDEX_FILE git add -- server/during-hook.js', ''].join('\n'));
  fs.chmodSync(hook, 0o755);
  const before = commits(repo);

  const res = mergeLane(repo, 'lane-y', 'yankee');
  assertMerged(repo, res, before, 'yankee', 'A  server/during-hook.js\n');
  assert.deepStrictEqual(git(repo, 'diff', '--name-only', 'HEAD~1', 'HEAD').trim().split('\n'), ['README.md', 'server/beta.js']);
  assert.match(res.stdout, /staged by another window during the commit[^\n]*server\/during-hook\.js/);
  assertChecksClean(repo);
}));

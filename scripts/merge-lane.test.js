'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// MERGE_LANE_SCRIPT runs the suite against another copy of the script.
const SCRIPT = process.env.MERGE_LANE_SCRIPT || path.resolve(__dirname, 'merge-lane.sh');

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

// Every fixture repo and every merge's own temp directory (mktemp -d reads
// TMPDIR) lands under one directory the suite removes when it ends, so a
// merge killed mid-run (SIGKILL skips its trap) leaves nothing behind.
const SUITE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-lane-suite-'));
process.env.TMPDIR = SUITE_TMP;
process.env.MERGE_LANE_LOCK_WAIT = '2'; // seconds a merge waits out index.lock; short, so lock cases stay quick
test.after(() => rmrf(SUITE_TMP));

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

// Resolves once fn() holds, polled every 50 ms; fails after 30 seconds.
async function until(fn, what) {
  for (const end = Date.now() + 30000; !fn(); await new Promise((r) => setTimeout(r, 50))) if (Date.now() > end) assert.fail(`timed out: ${what}`);
}

test('serialization -> the second concurrent invocation waits for the lock', async () => {
  const repo = makeRepo();
  const wtA = addLaneWorktree(repo, 'lane-c', { 'c1.txt': 'x\n' });
  const wtB = addLaneWorktree(repo, 'lane-d', { 'd1.txt': 'y\n' });
  // p1's pre-commit hook marks that it runs inside the lock, then holds it until go (~30s cap); p2's passes.
  const inside = path.join(repo, '.git', 'first-inside');
  const go = path.join(repo, '.git', 'go');
  try {
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, `#!/usr/bin/env bash\n[ -e '${inside}' ] && exit 0\n: > '${inside}'\nfor _ in $(seq 600); do [ -e '${go}' ] && break; sleep 0.05; done\n`);
    fs.chmodSync(hook, 0o755);
    const events = [];
    const ended = (p, name) => new Promise((res) => p.on('exit', (c) => { events.push(name); res(c); }));
    const p1 = spawnMerge(repo, ['lane-c', 'plan-c.md', 'charlie']);
    const c1 = ended(p1, 'p1');
    // p2 starts once p1 provably holds the lock (its hook runs inside it), never after a fixed delay.
    await until(() => fs.existsSync(inside), 'the first merge inside the lock');
    const p2 = spawnMerge(repo, ['lane-d', 'plan-d.md', 'delta']);
    let err2 = '';
    p2.stderr.on('data', (d) => { err2 += d; });
    const c2 = ended(p2, 'p2');
    await until(() => err2.includes('holds the ship lock; waiting for it'), 'the second merge to wait');
    assert.deepStrictEqual(events, [], 'neither merge ended while the first held the lock');
    fs.writeFileSync(go, '');
    const codes = await Promise.all([c1, c2]);
    assert.deepStrictEqual(events, ['p1', 'p2'], 'p1 must finish before p2');
    assert.strictEqual(codes[0], 0, 'first merge should succeed');
    assert.strictEqual(codes[1], 0, 'second merge should succeed after waiting');
    // Both lanes landed as two separate squash commits, no interleave/clobber.
    const subjects = git(repo, 'log', '--pretty=%s').trim().split('\n');
    assert.ok(subjects.includes('merge(lane charlie): plan-c.md'));
    assert.ok(subjects.includes('merge(lane delta): plan-d.md'));
    assert.ok(fs.existsSync(path.join(repo, 'c1.txt')));
    assert.ok(fs.existsSync(path.join(repo, 'd1.txt')));
  } finally {
    if (fs.existsSync(repo)) fs.writeFileSync(go, '');
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

    // Launch the actual script in its own process group, let it take the ship
    // lock and enter the slow commit, then SIGKILL the launcher's group and the
    // lock holder's (flock leads a session of its own, as flockExec runs it):
    // a crash mid-merge. flock releases when the holding fd closes on death.
    const holder = spawn('bash', [SCRIPT, 'lane-kill', 'plan-kill.md', 'kilo'], {
      cwd: repo,
      stdio: 'ignore',
      detached: true, // new process group so we can kill the whole tree
    });
    await new Promise((r) => setTimeout(r, 800)); // let it lock + reach the hook
    const holders = require('./lib/flockExec').flockHolders(path.join(repo, '.git', 'drb-ship.lock')) || [];
    for (const pid of [holder.pid, ...holders]) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
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

// ---- Other windows in the shared checkout (plan 2026-10-27 step 4, lane ----
// merge-docs-split). Plain repos (no docs generator): another window's git
// runs at one moment of the merge through a git wrapper on PATH.

// A merge, never ending on a shell error.
function mergeLane(repo, branch, name, env = process.env) {
  const res = run('bash', [SCRIPT, branch, 'docs/plan.md', name], { cwd: repo, env });
  assert.doesNotMatch(res.stderr, /merge-lane[^:\n]*: line \d+: /, 'no shell error');
  return res;
}
const output = (res) => `${res.stdout}${res.stderr}`;
const status = (repo) => git(repo, 'status', '--porcelain');
const fileAt = (repo, file) => fs.readFileSync(path.join(repo, file), 'utf8');
const atHead = (repo, file) => git(repo, 'show', `HEAD:${file}`);
const subject = (repo) => git(repo, 'log', '-1', '--pretty=%s').trim();

// A git on PATH for the merge. Each [when, step] pair acts once, as another
// window would: the nth time (default the first) git runs with arguments
// matching the bash pattern `when`, before that git runs (after it, with
// after: true), it writes files, stages paths, makes a pathspec commit of its
// own (or with commitAll a plain commit of the shared index), or takes
// index.lock and lets it go lockMs later in the background.
// Returns the environment to run the merge in.
function wrapGit(repo, pairs) {
  const real = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const dir = path.join(repo, '.git', 'wrap');
  fs.mkdirSync(dir);
  const other = `env -u GIT_INDEX_FILE '${real}'`;
  const lines = ['#!/usr/bin/env bash', 'shopt -s extglob'];
  pairs.forEach(([when, step], k) => {
    const act = [`: > '${dir}/done${k}'`];
    for (const [i, [p, body]] of Object.entries(Object.entries(step.write || {}))) {
      fs.writeFileSync(path.join(dir, `body${k}-${i}`), body);
      act.push(`mkdir -p "$(dirname '${p}')"`, `cat '${dir}/body${k}-${i}' > '${p}'`);
    }
    if (step.stage) act.push(`${other} add -- ${step.stage.map((p) => `'${p}'`).join(' ')}`);
    if (step.commit) act.push(`${other} commit -q -m 'another window' -- ${step.commit.map((p) => `'${p}'`).join(' ')}`);
    if (step.commitAll) act.push(`${other} commit -q -m 'another window'`);
    if (step.lockMs) act.push(': > .git/index.lock', `( sleep ${step.lockMs / 1000}; rm -f .git/index.lock ) > /dev/null 2>&1 &`);
    lines.push(`act${k}() {`, ...act.map((a) => `  ${a}`), '}',
      `if [ ! -e '${dir}/done${k}' ] && [[ " $* " == ${when} ]]; then`,
      `  n=$(( $(cat '${dir}/count${k}' 2>/dev/null || echo 0) + 1 )); echo "$n" > '${dir}/count${k}'`,
      `  if [ "$n" -eq ${step.nth || 1} ]; then`,
      step.after ? `    '${real}' "$@"; rc=$?; act${k}; exit "$rc"` : `    act${k}`,
      '  fi', 'fi');
  });
  lines.push(`exec '${real}' "$@"`, '');
  fs.writeFileSync(path.join(dir, 'git'), lines.join('\n'));
  fs.chmodSync(path.join(dir, 'git'), 0o755);
  return { ...process.env, PATH: `${dir}:${process.env.PATH}` };
}
const acted = (repo, k = 0) => fs.existsSync(path.join(repo, '.git', 'wrap', `done${k}`));

// Waits until no index.lock is left (a wrapper's lock is let go in the background).
function lockGone(repo) {
  const lock = path.join(repo, '.git', 'index.lock');
  const until = Date.now() + 3000;
  while (fs.existsSync(lock) && Date.now() < until) execFileSync('sleep', ['0.05']);
  assert.ok(!fs.existsSync(lock), 'the held index.lock was let go');
}

// Runs a case in a fresh plain repo, then removes it and the named lanes' worktrees.
function inRepo(branches, body) {
  const repo = makeRepo();
  try {
    body(repo);
  } finally {
    rmrf(repo);
    for (const b of branches) rmrf(path.join(repo, '..', `wt-${path.basename(repo)}-${b}`));
  }
}

// Main and the lane each edit z.txt, so the squash conflicts and the merge
// refuses; the lane also changes the files given.
function conflictingLane(repo, branch, files) {
  fs.writeFileSync(path.join(repo, 'z.txt'), 'z\n');
  git(repo, 'add', 'z.txt');
  git(repo, 'commit', '-q', '-m', 'main adds z');
  addLaneWorktree(repo, branch, { ...files, 'z.txt': 'z, as the lane wrote it\n' });
  fs.writeFileSync(path.join(repo, 'z.txt'), 'z, as main wrote it\n');
  git(repo, 'commit', '-q', '-am', 'main edits z');
}

// A refused merge whose squash is fully reset: main where it was, the tree
// clean, no squash state.
function assertResetClean(repo, res, head) {
  assert.notStrictEqual(res.code, 0, 'the merge refuses');
  lockGone(repo);
  assert.strictEqual(status(repo), '', `the squash is reset: ${output(res)}`);
  assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), head, 'main did not move');
  assert.ok(!fs.existsSync(path.join(repo, '.git', 'SQUASH_MSG')), 'no squash state is left behind');
}

test('index.lock at the prose check -> the docs compare from a private copy of the index, so another git holding the lock does not stop the merge', () => inRepo(['lane-l1'], (repo) => {
  addLaneWorktree(repo, 'lane-l1', { 'feature.txt': 'one\n', 'README.md': 'base, as the lane wrote it\n' });
  const env = wrapGit(repo, [['*" write-tree "*', { lockMs: 400 }]]);
  const before = Number(git(repo, 'rev-list', '--count', 'HEAD'));
  const res = mergeLane(repo, 'lane-l1', 'lima', env);
  assert.ok(acted(repo), 'another git took index.lock as the docs were compared');
  assert.strictEqual(res.code, 0, `expected success, got: ${output(res)}`);
  lockGone(repo);
  assert.strictEqual(Number(git(repo, 'rev-list', '--count', 'HEAD')), before + 1);
  assert.strictEqual(status(repo), '');
}));

test('index.lock at the guard -> unstaging another window\'s file waits out the lock, then the merge goes on', () => inRepo(['lane-l2'], (repo) => {
  addLaneWorktree(repo, 'lane-l2', { 'feature.txt': 'one\n' });
  // The lane is a fast-forward, so the squash keeps what is staged before it.
  const env = wrapGit(repo, [
    ['*" merge --squash "*', { write: { 'other.txt': 'Another window.\n' }, stage: ['other.txt'] }],
    ['*" restore --staged "*', { lockMs: 400 }],
  ]);
  const res = mergeLane(repo, 'lane-l2', 'lima', env);
  assert.ok(acted(repo, 1), 'another git took index.lock as the guard unstaged');
  assert.strictEqual(res.code, 0, `expected success, got: ${output(res)}`);
  assert.match(res.stdout, /unstaged other\.txt: staged by another window/);
  lockGone(repo);
  assert.strictEqual(status(repo), '?? other.txt\n', "the other window's file is kept on disk, unstaged");
  assert.strictEqual(git(repo, 'diff', '--name-only', 'HEAD~1', 'HEAD').trim(), 'feature.txt');
}));

test('index.lock at the reset -> a refusal waits out the lock and still resets every path of the lane', () => inRepo(['lane-l3'], (repo) => {
  conflictingLane(repo, 'lane-l3', { 'README.md': 'base, as the lane wrote it\n', 'feature.txt': 'one\n' });
  const env = wrapGit(repo, [['@(*" restore "*|*" rm "*)', { lockMs: 400 }]]);
  const head = git(repo, 'rev-parse', 'HEAD');
  const res = mergeLane(repo, 'lane-l3', 'lima', env);
  assert.ok(acted(repo), 'another git took index.lock as the reset began');
  assert.match(res.stderr, /REFUSED: squash-merge of 'lane-l3' hit a conflict/);
  assertResetClean(repo, res, head);
}));

test('staged at the reset -> lane paths another window stages after the guard stay staged with its work, never reset as the squash\'s', () => inRepo(['lane-r1'], (repo) => {
  fs.writeFileSync(path.join(repo, 'NOTES.md'), 'notes\n');
  git(repo, 'add', 'NOTES.md');
  git(repo, 'commit', '-q', '-m', 'main adds notes');
  conflictingLane(repo, 'lane-r1', {
    'NOTES.md': 'notes, as the lane wrote them\n',
    'README.md': 'base, as the lane wrote it\n',
    'server/item.js': '// The lane adds it.\n',
  });
  // At the reset's first command (NOTES.md sorts first), another window
  // stages a lane-own doc and a path the lane added.
  const theirs = { 'README.md': 'base, as another window wrote it\n', 'server/item.js': '// Another window wrote it.\n' };
  const env = wrapGit(repo, [['@(*" restore "*|*" rm "*)', { write: theirs, stage: Object.keys(theirs) }]]);
  const head = git(repo, 'rev-parse', 'HEAD');
  const res = mergeLane(repo, 'lane-r1', 'romeo', env);
  assert.ok(acted(repo), 'another window staged as the reset began');
  assert.notStrictEqual(res.code, 0, 'the conflict refuses');
  assert.match(res.stderr, /Left staged for the window that staged it: README\.md, server\/item\.js/);
  assert.strictEqual(status(repo), 'M  README.md\nA  server/item.js\n', "only the other window's staging is left");
  for (const [f, body] of Object.entries(theirs)) {
    assert.strictEqual(fileAt(repo, f), body, `${f}: the other window's work is on disk`);
    assert.strictEqual(git(repo, 'show', `:${f}`), body, `${f}: and staged`);
  }
  for (const f of ['NOTES.md', 'z.txt']) assert.strictEqual(fileAt(repo, f), atHead(repo, f), `${f} is reset`);
  assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), head, 'main did not move');
}));

test('a commit from another window under the merge -> main is never rewound: the merge refuses and that commit stays main\'s head', () => {
  const theirs = 'Another window.\n';
  for (const at of ['just before main is updated', 'during the hook']) {
    inRepo(['lane-c8'], (repo) => {
      addLaneWorktree(repo, 'lane-c8', { 'feature.txt': 'one\n' });
      let env = process.env;
      if (at === 'during the hook') {
        const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
        fs.writeFileSync(hook, ['#!/usr/bin/env bash', '[ -e .git/hook-done ] && exit 0', ': > .git/hook-done',
          `printf '${theirs.replace('\n', '\\n')}' > other.txt`, 'env -u GIT_INDEX_FILE git add -- other.txt',
          "env -u GIT_INDEX_FILE git commit -q -m 'another window' -- other.txt", ''].join('\n'));
        fs.chmodSync(hook, 0o755);
      } else {
        // git commit reads HEAD as it starts; the private-copy commit moves main by update-ref.
        env = wrapGit(repo, [['@(*" commit -m "*|*" update-ref "*)', { write: { 'other.txt': theirs }, stage: ['other.txt'], commit: ['other.txt'] }]]);
      }
      const head = git(repo, 'rev-parse', 'HEAD');
      const res = mergeLane(repo, 'lane-c8', 'charlie', env);
      assert.notStrictEqual(res.code, 0, `${at}: the merge refuses`);
      assert.match(res.stderr, /REFUSED: main moved/, at);
      assert.strictEqual(subject(repo), 'another window', `${at}: that window's commit is main's head`);
      assert.strictEqual(git(repo, 'rev-parse', 'HEAD~1'), head, `${at}: on the old head`);
      assert.strictEqual(atHead(repo, 'other.txt'), theirs, `${at}: with its file`);
      assert.strictEqual(status(repo), '', `${at}: the lane is reset`);
      assert.ok(!fs.existsSync(path.join(repo, 'feature.txt')), `${at}: the lane's file is gone`);
    });
  }
});

test('unstaged during the hook -> lane paths another window unstages while the hook runs are put back at the merge\'s entry, never left as a staged revert', () => inRepo(['lane-u3'], (repo) => {
  addLaneWorktree(repo, 'lane-u3', { 'feature.txt': 'one\n', 'README.md': 'base, as the lane wrote it\n', 'notes.txt': 'notes\n' });
  // The other window unstages two lane paths (git restore --staged, the
  // sanctioned command for a foreign staged file), stages its own edit to a
  // third and a file of its own.
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, ['#!/usr/bin/env bash', 'env -u GIT_INDEX_FILE git restore --staged -- README.md feature.txt',
    "printf 'notes, as another window wrote them\\n' > notes.txt", "printf 'Another window.\\n' > other.txt",
    'env -u GIT_INDEX_FILE git add -- notes.txt other.txt', '[ "$MERGE_LANE_COMMIT" = "$GIT_INDEX_FILE" ] && : > .git/merge-named', ''].join('\n'));
  fs.chmodSync(hook, 0o755);
  const before = Number(git(repo, 'rev-list', '--count', 'HEAD'));
  const res = mergeLane(repo, 'lane-u3', 'uniform');
  assert.strictEqual(res.code, 0, `expected success, got: ${output(res)}`);
  assert.strictEqual(Number(git(repo, 'rev-list', '--count', 'HEAD')), before + 1);
  assert.strictEqual(subject(repo), 'merge(lane uniform): docs/plan.md');
  assert.match(res.stdout, /put back at the merge's entry in the index: README\.md, feature\.txt/);
  assert.match(res.stdout, /changed in the index by another window during the commit, left staged for it: notes\.txt/);
  assert.match(res.stdout, /staged by another window during the commit, left staged for it: other\.txt/);
  assert.strictEqual(status(repo), 'M  notes.txt\nA  other.txt\n', "only the other window's staging is left");
  assert.ok(fs.existsSync(path.join(repo, '.git', 'merge-named')), 'the hook ran with MERGE_LANE_COMMIT naming its index');
}));

test('staged before the commit\'s copy -> a file another window stages after the last guard is left out of the commit and named once', () => inRepo(['lane-n7'], (repo) => {
  addLaneWorktree(repo, 'lane-n7', { 'feature.txt': 'one\n' });
  // After step 8's guard reads the docs (their second read in a plain repo), before the copy.
  const env = wrapGit(repo, [['*" ls-files -s -z -- README.md ARCHITECTURE.md "*', { write: { 'other.txt': 'Another window.\n' }, stage: ['other.txt'], nth: 2, after: true }]]);
  const res = mergeLane(repo, 'lane-n7', 'november', env);
  assert.ok(acted(repo), 'another window staged between the guard and the copy');
  assert.strictEqual(res.code, 0, `expected success, got: ${output(res)}`);
  assert.match(res.stdout, /left out of the commit, still staged for the window that staged it: other\.txt/);
  assert.strictEqual((output(res).match(/other\.txt/g) || []).length, 1, 'named once');
  assert.strictEqual(status(repo), 'A  other.txt\n');
  assert.strictEqual(git(repo, 'diff', '--name-only', 'HEAD~1', 'HEAD').trim(), 'feature.txt');
}));

test('staged right after the squash -> lane paths another window stages before the snapshot are never taken for the squash\'s', () => inRepo(['lane-s1'], (repo) => {
  conflictingLane(repo, 'lane-s1', { 'README.md': 'base, as the lane wrote it\n', 'server/item.js': '// The lane adds it.\n' });
  const theirs = { 'README.md': 'base, as another window wrote it\n', 'server/item.js': '// Another window wrote it.\n' };
  const env = wrapGit(repo, [['*" merge --squash "*', { write: theirs, stage: Object.keys(theirs), after: true }]]);
  const head = git(repo, 'rev-parse', 'HEAD');
  const res = mergeLane(repo, 'lane-s1', 'sierra', env);
  assert.ok(acted(repo), 'another window staged as the squash returned');
  assert.notStrictEqual(res.code, 0, 'the merge refuses');
  assert.match(res.stderr, /changed in the index under the merge/);
  assert.strictEqual(status(repo), 'M  README.md\nA  server/item.js\n', "only the other window's staging is left");
  for (const [f, body] of Object.entries(theirs)) {
    assert.strictEqual(fileAt(repo, f), body, `${f}: the other window's work is on disk`);
    assert.strictEqual(git(repo, 'show', `:${f}`), body, `${f}: and staged`);
  }
  assert.strictEqual(fileAt(repo, 'z.txt'), atHead(repo, 'z.txt'), 'the conflict is reset');
  assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), head, 'main did not move');
}));

// ---- Fix round 1 of lane merge-docs-split --------------------------------

// Writes the files under dir and stages them.
function put(dir, files) {
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
    git(dir, 'add', '--', f);
  }
}

test('file/directory conflict -> a refusal resets each shape: no unmerged or ~ entry, the tree back at HEAD, no window blamed', () => {
  // main's file against the lane's directory and the reverse; then the lane
  // turning a file into a directory, and a directory into a file, beside a conflict.
  const shapes = [
    { name: "main's file, the lane's directory", main: { foo: 'main\n' }, lane: { 'foo/bar': 'lane\n' } },
    { name: "main's directory, the lane's file", main: { 'foo/bar': 'main\n' }, lane: { foo: 'lane\n' } },
    { name: 'a file the lane makes a directory', base: { foo: 'base\n' }, drop: 'foo', lane: { 'foo/bar': 'lane\n' } },
    { name: 'a directory the lane makes a file', base: { 'foo/bar': 'base\n' }, drop: 'foo/bar', lane: { foo: 'lane\n' } },
  ];
  for (const s of shapes) {
    inRepo(['lane-fd'], (repo) => {
      const z = s.drop ? (who) => ({ 'z.txt': `z, as ${who} wrote it\n` }) : () => ({});
      put(repo, { ...s.base, ...z('the base') });
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
      const wt = path.join(repo, '..', `wt-${path.basename(repo)}-lane-fd`);
      git(repo, 'worktree', 'add', '-q', '-b', 'lane-fd', wt, 'main');
      if (s.drop) git(wt, 'rm', '-q', '--', s.drop);
      put(wt, { ...s.lane, ...z('the lane') });
      git(wt, 'commit', '-q', '-m', 'lane');
      put(repo, { ...s.main, ...z('main') });
      git(repo, 'commit', '-q', '-m', 'main');
      const head = git(repo, 'rev-parse', 'HEAD');
      const res = mergeLane(repo, 'lane-fd', 'foxtrot');
      assert.match(res.stderr, /REFUSED: squash-merge of 'lane-fd' hit a conflict/, s.name);
      assert.doesNotMatch(output(res), /another window|under the merge|Left staged|Kept on disk/, `${s.name}: nothing blamed on a window or kept`);
      assert.doesNotMatch(git(repo, 'ls-files', '-s'), /~| [123]\t/, `${s.name}: no unmerged or ~ entry`);
      assertResetClean(repo, res, head);
    });
  }
});

test('nothing past main, a file staged before the check -> a commit tree equal to main\'s refuses as nothing to merge, never an empty commit', () => inRepo(['lane-e2'], (repo) => {
  addLaneWorktree(repo, 'lane-e2', { 'feature.txt': 'one\n' });
  git(repo, 'cherry-pick', 'lane-e2');
  // Staged just before the nothing-to-merge check, unstaged by the guard after it.
  const env = wrapGit(repo, [['*" diff --cached --quiet HEAD "*', { write: { 'other.txt': 'Another window.\n' }, stage: ['other.txt'] }]]);
  const head = git(repo, 'rev-parse', 'HEAD');
  const res = mergeLane(repo, 'lane-e2', 'echo', env);
  assert.ok(acted(repo), 'another window staged before the check');
  assert.match(res.stderr, /REFUSED: nothing to merge from 'lane-e2' \(the commit's tree equals main's/);
  assert.match(res.stdout, /unstaged other\.txt: staged by another window/);
  assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), head, 'nothing is committed');
  assert.strictEqual(status(repo), '?? other.txt\n', "the other window's file is on disk, unstaged");
}));

test('a plain commit of the shared index under the merge -> the refusal says that commit carries the lane, never that nothing of it is on main', () => {
  const plain = ['[ -e .git/hook-done ] && exit 0', ': > .git/hook-done', "printf 'w\\n' > w.txt",
    'env -u GIT_INDEX_FILE git add -- w.txt', "env -u GIT_INDEX_FILE git commit -q -m 'another window'"];
  for (const at of ['during the hook', 'during the hook, which then refuses', 'before a check of main']) {
    inRepo(['lane-pc'], (repo) => {
      addLaneWorktree(repo, 'lane-pc', { 'feature.txt': 'one\n', 'notes/lane.txt': 'two\n' });
      let env = process.env;
      if (at.startsWith('during')) {
        const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
        fs.writeFileSync(hook, ['#!/usr/bin/env bash', ...plain, at.endsWith('refuses') ? 'exit 1' : 'exit 0', ''].join('\n'));
        fs.chmodSync(hook, 0o755);
      } else {
        // At the prose check's write-tree, just before that step's check of main.
        env = wrapGit(repo, [['*" write-tree "*', { write: { 'w.txt': 'w\n' }, stage: ['w.txt'], commitAll: true }]]);
      }
      const head = git(repo, 'rev-parse', 'HEAD');
      const res = mergeLane(repo, 'lane-pc', 'papa', env);
      assert.notStrictEqual(res.code, 0, `${at}: the merge refuses`);
      assert.match(res.stderr, /REFUSED: main moved under the merge: \w+ another window from another window already carries every path of the squash/, at);
      assert.doesNotMatch(output(res), /nothing of the lane is on main|Nothing was merged|the squash is left staged/, `${at}: no false line`);
      assert.strictEqual(subject(repo), 'another window', `${at}: that commit is main's head`);
      assert.strictEqual(git(repo, 'rev-parse', 'HEAD~1'), head, at);
      assert.strictEqual(atHead(repo, 'notes/lane.txt'), 'two\n', `${at}: carrying the lane`);
      assert.strictEqual(status(repo), '', `${at}: the tree is clean`);
    });
  }
});

test('main moving under the squash -> at merge-tree or as the squash starts, the refusal names that commit and nothing of the lane is left staged or blamed on it', () => {
  const lines = (at, word) => Array.from({ length: 8 }, (_, i) => (i === at ? word : String(i + 1))).join('\n').concat('\n');
  // A lane path the window also commits (another line of it), and a README its commit makes conflict.
  const shapes = [
    { file: 'p.txt', base: lines(-1), lane: lines(1, 'LANE'), theirs: lines(7, 'WIN') },
    { file: 'README.md', base: 'base\n', lane: 'base\nLANE\n', theirs: 'base\nWIN\n' },
  ];
  for (const s of shapes) {
    for (const when of ['*" merge-tree "*', '*" merge --squash "*']) {
      inRepo(['lane-mv'], (repo) => {
        const at = `${s.file}, committed at ${when}`;
        put(repo, { [s.file]: s.base });
        git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
        addLaneWorktree(repo, 'lane-mv', { [s.file]: s.lane });
        const env = wrapGit(repo, [[when, { write: { [s.file]: s.theirs }, commit: [s.file] }]]);
        const res = mergeLane(repo, 'lane-mv', 'mike', env);
        assert.ok(acted(repo), `${at}: another window committed`);
        assert.match(res.stderr, /REFUSED: main moved [^\n]*another window landed from another window/, at);
        assert.doesNotMatch(output(res), /changed in the index|Left staged|Kept on disk/, `${at}: no path is another window's`);
        assert.strictEqual(subject(repo), 'another window', `${at}: that commit is main's head`);
        assert.strictEqual(status(repo), '', `${at}: the index and the tree are clean`);
        assert.strictEqual(fileAt(repo, s.file), s.theirs, `${at}: the path as that commit holds it`);
        assert.ok(!fs.existsSync(path.join(repo, '.git', 'SQUASH_MSG')), `${at}: no squash state`);
      });
    }
  }
});

test('another window\'s commit hook holding index.lock past two seconds -> the refusal waits it out (MERGE_LANE_LOCK_WAIT 5) and resets every path', () => inRepo(['lane-lw'], (repo) => {
  put(repo, { 'x.txt': 'x\n', 'y.txt': 'y\n', 'f1.txt': 'old\n' });
  git(repo, 'commit', '-q', '-m', 'base');
  addLaneWorktree(repo, 'lane-lw', { 'f1.txt': 'lane\n', 'f2.txt': 'two\n', 'f3.txt': 'three\n' });
  const hooks = path.join(repo, '.git', 'hooks');
  // Window B's pathspec commit holds the shared index.lock through a 3 s hook.
  fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/usr/bin/env bash\n[ "${WINDOW:-}" = B ] && sleep 3\nexit 0\n');
  // As the squash ends, window A commits (main moves) and window B starts its commit.
  fs.writeFileSync(path.join(hooks, 'post-merge'), ['#!/usr/bin/env bash', 'unset GIT_INDEX_FILE',
    "printf 'x2\\n' > x.txt", "WINDOW=A git commit -q -m 'window A' -- x.txt", "printf 'y2\\n' > y.txt",
    "( WINDOW=B git commit -q -m 'window B' -- y.txt > /dev/null 2>&1 & )", 'while [ ! -e .git/index.lock ]; do sleep 0.05; done', ''].join('\n'));
  for (const h of ['pre-commit', 'post-merge']) fs.chmodSync(path.join(hooks, h), 0o755);
  const res = mergeLane(repo, 'lane-lw', 'lima', { ...process.env, MERGE_LANE_LOCK_WAIT: '5' });
  lockGone(repo);
  assert.match(res.stderr, /REFUSED: main moved during the merge \(\w+ window A/);
  assert.doesNotMatch(res.stderr, /Could not reset|index\.lock/, `every path is reset: ${output(res)}`);
  assert.strictEqual(status(repo), '', 'the tree is clean');
  assert.deepStrictEqual(git(repo, 'log', '--format=%s', '-3').trim().split('\n'), ['window B', 'window A', 'base']);
}));

test('index.lock held past the budget at the self-resolution -> the refusal carries git\'s reason', () => inRepo(['lane-sr'], (repo) => {
  // A stand-in generator whose every check passes, so a README conflict takes the self-resolution.
  put(repo, { 'scripts/gen-docs.js': '// Stands in for the docs generator.\nprocess.exit(0);\n' });
  git(repo, 'commit', '-q', '-m', 'a generator');
  addLaneWorktree(repo, 'lane-sr', { 'README.md': 'base, as the lane wrote it\n' });
  put(repo, { 'README.md': 'base, as main wrote it\n' });
  git(repo, 'commit', '-q', '-m', 'main edits README');
  const env = wrapGit(repo, [['*" checkout -q --ours "*', { lockMs: 2000 }]]);
  const res = mergeLane(repo, 'lane-sr', 'sierra', { ...env, MERGE_LANE_LOCK_WAIT: '1' });
  assert.ok(acted(repo), 'another git took index.lock at the checkout');
  lockGone(repo);
  assert.match(res.stderr, /REFUSED: could not take main's version of README\.md to resolve the squash of 'lane-sr' \(another git held index\.lock for 1 second\)\./);
}));

test('index.lock held past the budget at a doc\'s restage -> named as this merge\'s failure with both ways out, never as another window\'s move', () => inRepo(['lane-rs'], (repo) => {
  put(repo, { 'README.md': 'one\ntwo\nthree\nfour\n' });
  git(repo, 'commit', '-q', '-m', 'a longer README');
  addLaneWorktree(repo, 'lane-rs', { 'README.md': 'ONE\ntwo\nthree\nfour\n' });
  // Right after the squash another window adds a line to the lane's README and stages it.
  const theirs = 'ONE\ntwo\nthree\nfour\nfive, from another window\n';
  const env = wrapGit(repo, [['*" merge --squash "*', { write: { 'README.md': theirs }, stage: ['README.md'], after: true }],
    ['*" update-index --cacheinfo "*', { lockMs: 2000 }]]);
  const res = mergeLane(repo, 'lane-rs', 'romeo', { ...env, MERGE_LANE_LOCK_WAIT: '1' });
  assert.ok(acted(repo, 1), 'another git took index.lock at the restage');
  lockGone(repo);
  assert.match(res.stderr, /Could not restage README\.md after rendering it against HEAD \(another git held index\.lock for 1 second\); its working file holds that render and its index entry what was staged: run git add -- README\.md/);
  assert.doesNotMatch(res.stderr, /changed again/, "never another window's move");
  assert.strictEqual(fileAt(repo, 'README.md'), 'one\ntwo\nthree\nfour\nfive, from another window\n', "HEAD's text and that window's line on disk");
  assert.strictEqual(git(repo, 'show', ':README.md'), theirs, 'what was staged in the index');
  git(repo, 'add', '--', 'README.md');
  assert.strictEqual(status(repo), 'M  README.md\n', 'git add stages the render');
}));

test('a slow pre-commit hook -> the squash commit\'s committer time equals its author time, as git commit stamps them', () => inRepo(['lane-ht', 'lane-hu'], (repo) => {
  addLaneWorktree(repo, 'lane-ht', { 'feature.txt': 'one\n' });
  addLaneWorktree(repo, 'lane-hu', { 'other.txt': 'two\n' });
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/usr/bin/env bash\nsleep 1.1\n');
  fs.chmodSync(hook, 0o755);
  const times = () => git(repo, 'log', '-1', '--format=%at %ct').trim().split(' ');
  assert.strictEqual(mergeLane(repo, 'lane-ht', 'hotel').code, 0);
  const [author, committer] = times();
  assert.strictEqual(committer, author, 'committer time equals author time');
  // A committer date set in the environment is the one stamped, as git commit stamps it.
  const set = String(17e8);
  assert.strictEqual(mergeLane(repo, 'lane-hu', 'hotel', { ...process.env, GIT_COMMITTER_DATE: `@${set} +0000` }).code, 0);
  assert.strictEqual(times()[1], set, 'the committer date set in the environment');
}));

// ---- Fix round 2 of lane merge-docs-split --------------------------------

// A pre-commit hook that runs the lines once, as another window would during
// the squash commit's hook (that window's own commit runs the hook again).
function hookOnce(repo, lines) {
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, ['#!/usr/bin/env bash', '[ -e .git/hook-done ] && exit 0', ': > .git/hook-done', ...lines, ''].join('\n'));
  fs.chmodSync(hook, 0o755);
}

test('a plain commit under the merge with a lane path at that window\'s version -> the refusal says it carries part of the squash, names that path, and blames no regeneration', () => inRepo(['lane-pp'], (repo) => {
  put(repo, { 'p.txt': 'p1\np2\np3\n' });
  git(repo, 'commit', '-q', '-m', 'base');
  addLaneWorktree(repo, 'lane-pp', { 'server/x.js': '// x\n', 'p.txt': 'p1 lane\np2\np3\n' });
  // The other window adds a line to p.txt (its working copy holds the lane's), stages it and commits the shared index.
  hookOnce(repo, ["printf 'p4 window\\n' >> p.txt", 'env -u GIT_INDEX_FILE git add -- p.txt', "env -u GIT_INDEX_FILE git commit -q -m 'another window'"]);
  const res = mergeLane(repo, 'lane-pp', 'papa');
  assert.match(res.stderr, /REFUSED: main moved under the merge: \w+ another window from another window carries 1 of the squash's 2 paths [^\n]*At that window's own version[^\n]*: p\.txt\./);
  assert.match(res.stderr, /p\.txt changed in the index under the merge: that window staged its own version of it before its commit/);
  assert.doesNotMatch(output(res), /nothing of the lane is on main|Nothing was merged|Nothing of the lane is left|regeneration/, 'no false line');
  assert.strictEqual(subject(repo), 'another window', "main is at that window's commit");
  assert.strictEqual(status(repo), '', 'the tree is clean');
}));

test('a plain commit from another window as a refusal ends -> the refusal\'s last check names that commit as carrying the lane, never "Nothing was merged"', () => inRepo(['lane-pt'], (repo) => {
  // Window A's pathspec commit in the hook moves main (the swap refuses); then a stand-in generator's --generated-only (the refusal's prose judgment) runs window B's plain commit.
  put(repo, { 'a.txt': 'a\n', 'scripts/gen-docs.js': ['// Stands in for the docs generator.', 'const env = { ...process.env }; delete env.GIT_INDEX_FILE;',
    "if (process.argv[2] === '--generated-only' && require('node:fs').existsSync('.git/a-done')) require('node:child_process').execFileSync('git', ['commit', '-q', '-m', 'window B'], { env });", ''].join('\n') });
  git(repo, 'commit', '-q', '-m', 'base');
  addLaneWorktree(repo, 'lane-pt', { 'server/x1.js': '// x1\n', 'server/x2.js': '// x2\n' });
  hookOnce(repo, ["printf 'a2\\n' > a.txt", "env -u GIT_INDEX_FILE git commit -q -m 'window A' -- a.txt", ': > .git/a-done']);
  const res = mergeLane(repo, 'lane-pt', 'tango');
  assert.match(res.stderr, /REFUSED: main moved under the commit[^]*REFUSED: main moved under the merge \(found as this refusal ended\): \w+ window B from another window already carries every path of the squash/);
  assert.doesNotMatch(output(res), /Nothing was merged|Nothing of the lane is left/, 'no false line');
  assert.deepStrictEqual(git(repo, 'log', '--format=%s', '-3').trim().split('\n'), ['window B', 'window A', 'base']);
  assert.strictEqual(status(repo), '', 'the tree is clean');
}));

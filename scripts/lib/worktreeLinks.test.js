'use strict';

// node:test suite for scripts/lib/worktreeLinks.js, the symlink list a lane and
// the gate worktree share, and the lane memory-root link. Every case builds its
// own throwaway directories under the OS temp dir: a stand-in main checkout, a
// stand-in worktree and a fake home. Nothing here reads or writes the real home,
// the real repo or the real memory. Temp dirs are removed when the file ends.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  LINKS, linkInto, unlinkFrom, memoryRoot, linkMemory, unlinkMemory,
} = require('./worktreeLinks');

const dirs = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

// A main checkout holding every link source (each shared dir with one file in
// it, so a test can prove the shared copy survived), and an empty worktree.
function layout({ omit = [] } = {}) {
  const root = tmp('wt-links-');
  const main = path.join(root, 'main');
  const target = path.join(root, 'lane');
  fs.mkdirSync(target, { recursive: true });
  for (const { rel, shared } of LINKS) {
    if (omit.includes(rel)) continue;
    const p = path.join(main, rel);
    if (shared) {
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, 'keep.txt'), 'shared\n');
    } else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, 'NODE_ENV=development\n');
    }
  }
  return { root, main, target };
}

// log and warn kept apart, so a case can say which channel a line went to.
function capture() {
  const lines = [];
  const warnings = [];
  return { lines, warnings, log: (l) => lines.push(l), warn: (l) => warnings.push(l) };
}

const quiet = { log: () => {}, warn: () => {} };

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function absent(p) {
  try {
    fs.lstatSync(p);
    return false;
  } catch (e) {
    return e.code === 'ENOENT';
  }
}

const SHARED = LINKS.filter((l) => l.shared).map((l) => l.rel);
const ALL = LINKS.map((l) => l.rel);

test('LINKS is the five entries, three shared and the env pair', () => {
  assert.deepEqual(SHARED, ['node_modules', 'client/node_modules', '.husky/_']);
  assert.deepEqual(LINKS.filter((l) => !l.shared).map((l) => l.rel), ['.env', 'client/.env']);
});

test('every LINKS entry carries a non-empty consequence string', () => {
  for (const l of LINKS) {
    assert.equal(typeof l.consequence, 'string', `${l.rel} has a consequence`);
    assert.ok(l.consequence.trim().length > 0, `${l.rel} consequence is not empty`);
  }
  assert.match(LINKS.find((l) => l.rel === 'client/.env').consequence, /API base/);
  assert.doesNotMatch(LINKS.find((l) => l.rel === 'client/.env').consequence, /ECONNREFUSED/);
});

test('linkInto with env: false makes exactly the three shared links and no env file', () => {
  const { main, target } = layout();
  const { lines, warnings, log, warn } = capture();
  const res = linkInto(target, main, { env: false, log, warn });
  assert.deepEqual(res.linked, SHARED);
  for (const rel of SHARED) {
    assert.ok(isLink(path.join(target, rel)), `${rel} is a link`);
    assert.equal(fs.readlinkSync(path.join(target, rel)), path.join(main, rel));
  }
  assert.ok(absent(path.join(target, '.env')), '.env not made');
  assert.ok(absent(path.join(target, 'client', '.env')), 'client/.env not made');
  assert.deepEqual(lines, SHARED.map((rel) => `  linked ${rel}`));
  assert.deepEqual(warnings, []);
});

test('linkInto with env: true makes all five', () => {
  const { main, target } = layout();
  const res = linkInto(target, main, { env: true, ...quiet });
  assert.deepEqual(res.linked, ALL);
  for (const rel of ALL) {
    assert.equal(fs.readlinkSync(path.join(target, rel)), path.join(main, rel));
  }
});

test('linkInto skips a missing source with a warning line on the warn channel and makes the others', () => {
  const { main, target } = layout({ omit: ['.husky/_'] });
  const { lines, warnings, log, warn } = capture();
  const res = linkInto(target, main, { env: true, log, warn });
  assert.deepEqual(res.skipped, ['.husky/_']);
  const skipLine = `  skipped .husky/_: ${path.join(main, '.husky', '_')} is missing`;
  assert.deepEqual(warnings, [skipLine]);
  assert.ok(!lines.includes(skipLine), 'the skip line is not on the log channel');
  assert.ok(absent(path.join(target, '.husky', '_')));
  assert.deepEqual(res.linked, ALL.filter((r) => r !== '.husky/_'));
  for (const rel of res.linked) assert.ok(isLink(path.join(target, rel)), `${rel} is a link`);
});

test('linkInto leaves a real directory in a link\'s place and reports it', () => {
  const { main, target } = layout();
  fs.mkdirSync(path.join(target, 'node_modules'));
  fs.writeFileSync(path.join(target, 'node_modules', 'own.txt'), 'lane copy\n');
  const { warnings, log, warn } = capture();
  const res = linkInto(target, main, { env: false, log, warn });
  assert.deepEqual(res.real, ['node_modules']);
  assert.deepEqual(warnings, ['  node_modules exists as a real path, left as-is']);
  assert.ok(!isLink(path.join(target, 'node_modules')));
  assert.equal(fs.readFileSync(path.join(target, 'node_modules', 'own.txt'), 'utf8'), 'lane copy\n');
  assert.deepEqual(res.linked, ['client/node_modules', '.husky/_']);
});

test('linkInto reports a link already there and makes nothing', () => {
  const { main, target } = layout();
  linkInto(target, main, { env: true, ...quiet });
  const { lines, log, warn } = capture();
  const res = linkInto(target, main, { env: true, log, warn });
  assert.deepEqual(res.linked, []);
  assert.deepEqual(res.present, ALL);
  assert.deepEqual(lines, ALL.map((rel) => `  ${rel} already linked`));
});

test('unlinkFrom removes only link entries', () => {
  const { main, target } = layout();
  linkInto(target, main, { env: true, ...quiet });
  // client/.env as the worktree's own real file, plus an unrelated link and file.
  fs.unlinkSync(path.join(target, 'client', '.env'));
  fs.writeFileSync(path.join(target, 'client', '.env'), 'OWN=1\n');
  fs.symlinkSync(path.join(main, 'node_modules'), path.join(target, 'other-link'));
  fs.writeFileSync(path.join(target, 'notes.txt'), 'kept\n');
  const { warnings, log, warn } = capture();
  const res = unlinkFrom(target, { log, warn });
  assert.deepEqual(res.unlinked, ['node_modules', 'client/node_modules', '.husky/_', '.env']);
  assert.deepEqual(res.left, ['client/.env']);
  for (const rel of res.unlinked) assert.ok(absent(path.join(target, rel)), `${rel} removed`);
  assert.equal(fs.readFileSync(path.join(target, 'client', '.env'), 'utf8'), 'OWN=1\n');
  assert.ok(isLink(path.join(target, 'other-link')), 'a link outside the list is untouched');
  assert.ok(fs.existsSync(path.join(target, 'notes.txt')));
  for (const rel of SHARED) {
    assert.ok(fs.existsSync(path.join(main, rel, 'keep.txt')), `the shared ${rel} survived`);
  }
  assert.deepEqual(warnings, ['  client/.env is a real path, not a link, left in place']);
});

test('unlinkFrom refuses a real shared directory and removes nothing', () => {
  const { main, target } = layout();
  linkInto(target, main, { env: true, ...quiet });
  fs.unlinkSync(path.join(target, 'client', 'node_modules'));
  fs.mkdirSync(path.join(target, 'client', 'node_modules'));
  fs.writeFileSync(path.join(target, 'client', 'node_modules', 'own.txt'), 'lane copy\n');
  assert.throws(() => unlinkFrom(target, quiet), (e) => {
    assert.equal(e.code, 'REAL_SHARED_PATH');
    assert.equal(e.rel, 'client/node_modules');
    assert.match(e.message, /client\/node_modules is a real path, not a symlink/);
    return true;
  });
  for (const rel of ['node_modules', '.husky/_', '.env', 'client/.env']) {
    assert.ok(isLink(path.join(target, rel)), `${rel} still linked`);
  }
  assert.ok(fs.existsSync(path.join(target, 'client', 'node_modules', 'own.txt')));
});

test('memoryRoot maps a path with the launch-folder key rule under a fake home', () => {
  const home = path.join(os.tmpdir(), 'fake-home');
  // The drb wrapper's rule ("/" becomes "-") on a lane path of letters, digits and dashes.
  const lane = '/home/someone/projects/worktrees/rewrite-step3-scratch';
  assert.equal(
    memoryRoot(lane, { home }),
    path.join(home, '.claude', 'projects', lane.split('/').join('-'), 'memory'),
  );
  assert.equal(
    memoryRoot(lane, { home }),
    path.join(home, '.claude', 'projects', '-home-someone-projects-worktrees-rewrite-step3-scratch', 'memory'),
  );
  // Claude Code turns every other non-alphanumeric character into "-" as well.
  assert.equal(
    memoryRoot('/srv/worktrees/lane.v2_b', { home }),
    path.join(home, '.claude', 'projects', '-srv-worktrees-lane-v2-b', 'memory'),
  );
  // A trailing slash is the same folder.
  assert.equal(memoryRoot(`${lane}/`, { home }), memoryRoot(lane, { home }));
  // A key Claude Code would shorten with a hash refuses.
  assert.throws(() => memoryRoot(`/srv/${'x'.repeat(220)}`, { home }), /over 200 characters/);
});

// A fake home, a main memory with one file, and a lane path under the root.
function memLayout() {
  const root = tmp('wt-mem-');
  const home = path.join(root, 'home');
  const mainMemory = path.join(home, 'main-memory');
  fs.mkdirSync(mainMemory, { recursive: true });
  fs.writeFileSync(path.join(mainMemory, 'MEMORY.md'), 'index\n');
  const lane = path.join(root, 'worktrees', 'lane-a');
  return { root, home, mainMemory, lane, mem: memoryRoot(lane, { home }) };
}

test('linkMemory with nothing there makes the link and its parent', () => {
  const { home, mainMemory, lane, mem } = memLayout();
  assert.ok(absent(path.dirname(mem)));
  const res = linkMemory(lane, mainMemory, { home, ...quiet });
  assert.equal(res.state, 'linked');
  assert.equal(fs.readlinkSync(mem), mainMemory);
  assert.ok(fs.existsSync(path.join(mem, 'MEMORY.md')));
});

test('linkMemory leaves a link that already points at the main memory', () => {
  const { home, mainMemory, lane, mem } = memLayout();
  fs.mkdirSync(path.dirname(mem), { recursive: true });
  // A relative target that resolves, from the link's own folder, to the main memory.
  const relTarget = path.relative(path.dirname(mem), mainMemory);
  fs.symlinkSync(relTarget, mem);
  const { lines, warnings, log, warn } = capture();
  const res = linkMemory(lane, mainMemory, { home, log, warn });
  assert.equal(res.state, 'present');
  assert.equal(fs.readlinkSync(mem), relTarget, 'the link is untouched');
  assert.deepEqual(lines, ['  memory already linked']);
  assert.deepEqual(warnings, []);
});

test('linkMemory refuses a link to the main memory path when that folder is gone', () => {
  const { root, home, lane, mem } = memLayout();
  const gone = path.join(root, 'gone-memory');
  fs.mkdirSync(path.dirname(mem), { recursive: true });
  fs.symlinkSync(gone, mem);
  assert.throws(() => linkMemory(lane, gone, { home, ...quiet }), /the main memory .* is not a directory/);
  assert.equal(fs.readlinkSync(mem), gone, 'the link is left as it was');
});

test('linkMemory re-points a link that points anywhere else', () => {
  const { root, home, mainMemory, lane, mem } = memLayout();
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, 'other.md'), 'other\n');
  fs.mkdirSync(path.dirname(mem), { recursive: true });
  fs.symlinkSync(elsewhere, mem);
  const { warnings, log, warn } = capture();
  const res = linkMemory(lane, mainMemory, { home, log, warn });
  assert.equal(res.state, 're-pointed');
  assert.equal(res.from, elsewhere);
  assert.equal(fs.readlinkSync(mem), mainMemory);
  assert.deepEqual(warnings, [`  re-pointed memory from ${elsewhere} to ${mainMemory}`]);
  assert.equal(fs.readFileSync(path.join(elsewhere, 'other.md'), 'utf8'), 'other\n', 'the old target is untouched');
});

test('linkMemory resolves a relative main memory to an absolute link target', () => {
  const { home, mainMemory, lane, mem } = memLayout();
  const relative = path.relative(process.cwd(), mainMemory);
  assert.ok(!path.isAbsolute(relative));
  const res = linkMemory(lane, relative, { home, ...quiet });
  assert.equal(res.state, 'linked');
  assert.equal(fs.readlinkSync(mem), mainMemory);
  assert.ok(fs.existsSync(path.join(mem, 'MEMORY.md')));
  // The same relative path on a second call reads as the link already there.
  assert.equal(linkMemory(lane, relative, { home, ...quiet }).state, 'present');
});

test('linkMemory archives a real directory\'s two files under _archive/lane-<name>-<file>, then links', () => {
  const { home, mainMemory, lane, mem } = memLayout();
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), 'lane index\n');
  fs.writeFileSync(path.join(mem, 'note-one.md'), 'lane note\n');
  const res = linkMemory(lane, mainMemory, { home, ...quiet });
  assert.equal(res.state, 'archived');
  assert.deepEqual(res.archived.sort(), ['MEMORY.md', 'note-one.md']);
  const archive = path.join(mainMemory, '_archive');
  assert.equal(fs.readFileSync(path.join(archive, 'lane-lane-a-MEMORY.md'), 'utf8'), 'lane index\n');
  assert.equal(fs.readFileSync(path.join(archive, 'lane-lane-a-note-one.md'), 'utf8'), 'lane note\n');
  assert.equal(fs.readlinkSync(mem), mainMemory);
  assert.equal(fs.readFileSync(path.join(mainMemory, 'MEMORY.md'), 'utf8'), 'index\n', 'the main index is untouched');
});

test('linkMemory never archives over a taken name: it warns, throws and keeps the directory', () => {
  const { home, mainMemory, lane, mem } = memLayout();
  fs.mkdirSync(path.join(mainMemory, '_archive'), { recursive: true });
  fs.writeFileSync(path.join(mainMemory, '_archive', 'lane-lane-a-taken.md'), 'older\n');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'taken.md'), 'newer\n');
  fs.writeFileSync(path.join(mem, 'free.md'), 'free\n');
  const { warnings, log, warn } = capture();
  assert.throws(() => linkMemory(lane, mainMemory, { home, log, warn }), /still holds taken\.md/);
  assert.ok(warnings.some((l) => l.includes('lane-lane-a-taken.md already exists')), warnings.join('\n'));
  assert.equal(fs.readFileSync(path.join(mainMemory, '_archive', 'lane-lane-a-taken.md'), 'utf8'), 'older\n');
  assert.equal(fs.readFileSync(path.join(mem, 'taken.md'), 'utf8'), 'newer\n');
  assert.equal(fs.readFileSync(path.join(mainMemory, '_archive', 'lane-lane-a-free.md'), 'utf8'), 'free\n');
  assert.ok(!isLink(mem), 'the directory stays');
});

test('linkMemory refuses a plain file at the memory path', () => {
  const { home, mainMemory, lane, mem } = memLayout();
  fs.mkdirSync(path.dirname(mem), { recursive: true });
  fs.writeFileSync(mem, 'not a folder\n');
  assert.throws(
    () => linkMemory(lane, mainMemory, { home, ...quiet }),
    (e) => e.message.includes(mem) && /neither a directory nor a link/.test(e.message),
  );
  assert.equal(fs.readFileSync(mem, 'utf8'), 'not a folder\n');
});

test('linkMemory refuses a main memory that is not a directory', () => {
  const { root, home, lane, mem } = memLayout();
  const missing = path.join(root, 'no-such-memory');
  assert.throws(() => linkMemory(lane, missing, { home, ...quiet }), /is not a directory/);
  assert.ok(absent(mem));
});

test('unlinkMemory removes a link and leaves the main memory', () => {
  const { home, mainMemory, lane, mem } = memLayout();
  linkMemory(lane, mainMemory, { home, ...quiet });
  const res = unlinkMemory(lane, { home, ...quiet });
  assert.equal(res.state, 'unlinked');
  assert.ok(absent(mem));
  assert.ok(absent(path.dirname(mem)), 'the emptied project folder goes too');
  assert.equal(fs.readFileSync(path.join(mainMemory, 'MEMORY.md'), 'utf8'), 'index\n');
});

test('unlinkMemory keeps a project folder that holds anything else', () => {
  const { home, mainMemory, lane, mem } = memLayout();
  linkMemory(lane, mainMemory, { home, ...quiet });
  fs.writeFileSync(path.join(path.dirname(mem), 'session.jsonl'), '{}\n');
  unlinkMemory(lane, { home, ...quiet });
  assert.ok(absent(mem));
  assert.ok(fs.existsSync(path.join(path.dirname(mem), 'session.jsonl')));
});

test('unlinkMemory leaves a real directory', () => {
  const { home, lane, mem } = memLayout();
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'own.md'), 'own\n');
  const { lines, warnings, log, warn } = capture();
  const res = unlinkMemory(lane, { home, log, warn });
  assert.equal(res.state, 'left');
  assert.equal(fs.readFileSync(path.join(mem, 'own.md'), 'utf8'), 'own\n');
  assert.deepEqual(warnings, [`  memory at ${mem} is not a link, left as-is`]);
  assert.deepEqual(lines, []);
});

test('unlinkMemory with nothing there does nothing', () => {
  const { home, lane } = memLayout();
  assert.equal(unlinkMemory(lane, { home, ...quiet }).state, 'absent');
});

test('unlinkMemory reports a refused key as absent with the reason', () => {
  const { root, home } = memLayout();
  const longLane = path.join(root, 'worktrees', 'x'.repeat(220));
  assert.throws(() => memoryRoot(longLane, { home }), /over 200 characters/);
  const res = unlinkMemory(longLane, { home, ...quiet });
  assert.equal(res.state, 'absent');
  assert.match(res.reason, /over 200 characters/);
});

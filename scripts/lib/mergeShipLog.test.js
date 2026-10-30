'use strict';

// Suite for scripts/lib/mergeShipLog.js (plan 2026-10-28 step 5, lane
// merge-ship): the run log's paths and its line format. Every case runs in a
// throwaway repo under the temp dir (scripts/lib/receiptTestkit.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SUITE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-ship-log-suite-'));
process.env.TMPDIR = SUITE_TMP;
test.after(() => fs.rmSync(SUITE_TMP, { recursive: true, force: true }));

const K = require('./receiptTestkit');
const SL = require('./mergeShipLog');

const { git } = K;
const real = (p) => fs.realpathSync(p);
const LINE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /;

test('paths and appendLine: the tip-keyed log and stdio log under drb-ship; a line is `<ISO time> <step> <text>`, the text on one line', (t) => {
  const repo = K.makeRepo(t);
  const tip = git(repo, 'rev-parse', 'HEAD');
  const p = SL.paths(repo, tip);
  const dir = path.join(real(repo), '.git', 'drb-ship');
  assert.deepEqual([p.dir, p.log, p.stdio], [dir, path.join(dir, `${tip}.log`), path.join(dir, `${tip}.stdio.log`)]);
  SL.appendLine(p.log, 'check', 'two\nlines');
  SL.appendLine(p.log, 'result', 'ok done');
  const lines = fs.readFileSync(p.log, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => LINE.test(l)), lines.join('\n'));
  assert.deepEqual(lines.map((l) => l.replace(LINE, '')), ['check two lines', 'result ok done']);
});

test('moveAside: a prior run\'s log and stdio log go to <tip>.prev-<ms>.log and .prev-<ms>.stdio.log, a second move in the same millisecond takes the next; a line through the run\'s descriptor after a move lands in the moved file', (t) => {
  const repo = K.makeRepo(t);
  const tip = git(repo, 'rev-parse', 'HEAD');
  const p = SL.paths(repo, tip);
  assert.deepEqual(SL.moveAside(repo, tip), [], 'nothing to move');
  const fd = SL.openLog(p.log);
  SL.writeLine(fd, 'start', 'the first run');
  fs.writeFileSync(p.stdio, 'raw output\n');
  const now = Date.now;
  t.after(() => { Date.now = now; });
  const ms = 17 * 10 ** 11; // a fixed clock, built so no long digit run sits in the file
  Date.now = () => ms;
  assert.deepEqual(SL.moveAside(repo, tip), [`${tip}.prev-${ms}.log`, `${tip}.prev-${ms}.stdio.log`]);
  SL.writeLine(fd, 'result', 'ok the first run ends');
  fs.closeSync(fd);
  assert.equal(fs.existsSync(p.log), false, 'the new run starts on no log');
  const moved = fs.readFileSync(path.join(p.dir, `${tip}.prev-${ms}.log`), 'utf8').split('\n').filter(Boolean).map((l) => l.replace(LINE, ''));
  assert.deepEqual(moved, ['start the first run', 'result ok the first run ends']);
  assert.equal(fs.readFileSync(path.join(p.dir, `${tip}.prev-${ms}.stdio.log`), 'utf8'), 'raw output\n');
  SL.appendLine(p.log, 'start', 'the second run');
  assert.deepEqual(SL.moveAside(repo, tip), [`${tip}.prev-${ms + 1}.log`], 'the same millisecond takes the next name');
});

test('Phase: start writes every field, a write merges only while the file is this run\'s; moved aside with the logs, the old run\'s later writes touch neither file', (t) => {
  const repo = K.makeRepo(t);
  const tip = git(repo, 'rev-parse', 'HEAD');
  const p = SL.paths(repo, tip);
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const old = new SL.Phase({ cwd: repo, tip, lane: 'lane-1', log: p.log });
  old.start();
  const m = read(p.phase);
  assert.deepEqual(Object.keys(m).sort(), ['ended_at', 'kept', 'lane', 'log', 'pid', 'result', 'squash', 'started_at', 'state', 'step', 'step_at', 'tip', 'version']);
  assert.deepEqual([m.lane, m.tip, m.pid, m.state, m.step, m.log], ['lane-1', tip, process.pid, 'running', 'start', p.log]);
  assert.equal(old.write({ step: 'commit', step_at: m.started_at }), true);
  assert.equal(read(p.phase).step, 'commit');
  const moved = SL.moveAside(repo, tip);
  assert.equal(moved.length, 1);
  assert.match(moved[0], new RegExp(`^phase/${tip}\\.prev-\\d+\\.json$`));
  assert.equal(old.write({ state: 'ok' }), false, 'no manifest of its own to write');
  const now = new SL.Phase({ cwd: repo, tip, lane: 'lane-1', log: p.log });
  now.start();
  // The same pid, another start: a later run's manifest is not the old run's.
  fs.writeFileSync(p.phase, JSON.stringify({ ...read(p.phase), started_at: '2026-10-29T00:00:00.000Z' }));
  assert.equal(old.write({ state: 'failed' }), false);
  assert.equal(read(p.phase).state, 'running');
  assert.equal(read(path.join(p.dir, moved[0])).step, 'commit', 'the moved manifest is as the old run left it');
});

test('phaseLines: a manifest gone between the directory read and its own read, or a retirement rename another read made first (ENOENT), is already gone, no line', (t) => {
  const repo = K.makeRepo(t);
  const sha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'update-ref', 'refs/remotes/origin/main', sha);
  const p = SL.paths(repo, sha);
  const P = new SL.Phase({ cwd: repo, tip: sha, lane: 'lane-x', log: p.log });
  P.start();
  P.write({ state: 'ok-no-push', squash: sha, result: 'a dry run', ended_at: new Date().toISOString() });
  const shown = `ship phase: lane-x at ${sha.slice(0, 7)} ended ok-no-push at ${JSON.parse(fs.readFileSync(p.phase, 'utf8')).ended_at}: the squash ${sha.slice(0, 7)} has since reached origin`;
  const [readdir, rename] = [fs.readdirSync, fs.renameSync];
  t.after(() => { [fs.readdirSync, fs.renameSync] = [readdir, rename]; });
  // A name the directory listed whose file is gone by its read.
  fs.readdirSync = (d, ...a) => (d === p.phaseDir ? [...readdir(d, ...a), `${'f'.repeat(40)}.json`] : readdir(d, ...a));
  // Another read retires the manifest just before this one's rename.
  fs.renameSync = (from, to) => {
    if (from === p.phase) rename(from, path.join(p.phaseDir, `${sha}.done-1.json`));
    return rename(from, to);
  };
  assert.deepEqual(SL.phaseLines({ cwd: repo }), [shown], 'no unreadable line, no could-not-retire line');
  [fs.readdirSync, fs.renameSync] = [readdir, rename];
  assert.deepEqual(fs.readdirSync(p.phaseDir), [`${sha}.done-1.json`]);
  assert.deepEqual(SL.phaseLines({ cwd: repo }), []);
});

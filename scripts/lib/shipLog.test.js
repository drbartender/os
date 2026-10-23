'use strict';

// Tests for scripts/lib/shipLog.js (instruction rewrite step 3, lane
// ship-state). Every case runs in a throwaway repo under the temp dir, removed
// when the test ends; nothing here writes under the real repo's common dir.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

for (const k of Object.keys(process.env)) {
  if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES|DIFF_OPTS|EXTERNAL_DIFF)$/.test(k)) delete process.env[k];
}
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const L = require('./shipLog');
const M = require('./markers');
const R = require('./receipt');
const { mask } = require('./piiShapes');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(repo, message, file) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), `${message}\n`);
  git(repo, 'add', '--', file);
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function makeRepo(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'shiplog-test-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'commit.gpgsign', 'false');
  const base = commit(repo, 'seed', 'docs/seed.md');
  const one = commit(repo, 'server work', 'server/a.js');
  const two = commit(repo, 'more work', 'server/b.js');
  return { repo, base, one, two, dir: path.join(repo, '.git', 'drb-ship') };
}

const LINE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (\S+)(?: (.*))?$/;
const logLines = (r, sha, ext = 'log') => fs.readFileSync(path.join(r.dir, `${sha}.${ext}`), 'utf8').split('\n').filter(Boolean);
const stagesOf = (lines) => lines.map((l) => LINE_RE.exec(l)[1]);
// Token-shaped runs, built at runtime.
const neonRun = () => ['na', 'pi_'].join('') + 'k3Q'.repeat(15);
const HOUR = 60 * 60_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const ahead = (ms) => new Date(Date.now() + ms).toISOString();
const backdate = (file, ms) => {
  const at = new Date(Date.now() - ms);
  fs.utimesSync(file, at, at);
};
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// The stored form of a raw path holding one full sha: the sha kept and every
// other shape in it masked, a UUID-shaped segment of the temp dir included.
const storedPath = (raw, sha) => raw.split(sha).map((part) => mask(part)).join(sha);

function openTwo(r, sha = r.two, extra = {}) {
  return L.open(sha, {
    cwd: r.repo,
    base: r.base,
    commits: [{ sha: r.one, subject: 'server work' }, { sha: r.two, subject: 'more work' }],
    docs_only: false,
    touches_server: true,
    touches_client: false,
    ...extra,
  });
}

test('open creates the log, the manifest and last', (t) => {
  const r = makeRepo(t);
  const before = Date.now();
  const out = openTwo(r);
  assert.equal(out.log, path.join(fs.realpathSync(path.join(r.repo, '.git')), 'drb-ship', `${r.two}.log`));
  assert.equal(fs.readFileSync(out.log, 'utf8'), '');
  const m = L.readManifest(r.two, { cwd: r.repo });
  assert.deepEqual(Object.keys(m).sort(), ['base', 'commits', 'docs_only', 'gate', 'last_stage', 'last_stage_at', 'pid', 'push_started_at', 'push_unknown_at', 'pushed_at', 'result', 'sha', 'started_at', 'touches_client', 'touches_server', 'watch', 'watch_started_at']);
  assert.equal(m.sha, r.two);
  assert.equal(m.pid, process.pid, 'the opener, the ship process');
  assert.equal(m.base, r.base, 'a sha under a raw key is kept whole');
  assert.ok(Date.parse(m.started_at) >= before - 1000);
  assert.equal(m.docs_only, false);
  assert.equal(m.touches_server, true);
  assert.equal(m.touches_client, false);
  assert.deepEqual(m.commits, [{ sha: r.one, subject: 'server work' }, { sha: r.two, subject: 'more work' }]);
  for (const k of ['gate', 'push_started_at', 'push_unknown_at', 'pushed_at', 'watch_started_at', 'result', 'last_stage', 'last_stage_at', 'watch']) assert.equal(m[k], null, k);
  assert.equal(L.readLast({ cwd: r.repo }), r.two);
  assert.equal(fs.readFileSync(path.join(r.dir, 'last'), 'utf8'), `${r.two}\n`);
});

test('readLast and readManifest are null before any ship; tail is empty', (t) => {
  const r = makeRepo(t);
  assert.equal(L.readLast({ cwd: r.repo }), null);
  assert.equal(L.readManifest(r.two, { cwd: r.repo }), null);
  assert.deepEqual(L.tail(r.two, 5, { cwd: r.repo }), []);
  assert.equal(L.inFlight({ cwd: r.repo }), null);
});

test('a short sha works everywhere and the full sha is the file key; a ref that names no commit is refused', (t) => {
  const r = makeRepo(t);
  const s7 = r.two.slice(0, 7);
  L.open(s7, { cwd: r.repo, base: r.base });
  assert.ok(fs.existsSync(path.join(r.dir, `${r.two}.json`)));
  assert.equal(L.readLast({ cwd: r.repo }), r.two);
  L.line(s7, 'start', 'ship', { cwd: r.repo });
  assert.equal(L.setResult(s7, 'refused', 'no receipt', { cwd: r.repo }), true);
  assert.equal(L.readManifest(s7, { cwd: r.repo }).result.state, 'refused');
  assert.equal(L.tail(s7, 1, { cwd: r.repo }).length, 1);
  assert.equal(L.shipPaths(s7, { cwd: r.repo }).sha, r.two);
  const ghost = ['ab', 'cd'].join('').repeat(10);
  for (const bad of ['../../etc', ghost, '']) {
    assert.throws(() => L.open(bad, { cwd: r.repo }), (err) => err.code === 'SHIP_NO_COMMIT', bad);
    assert.throws(() => L.readManifest(bad, { cwd: r.repo }), (err) => err.code === 'SHIP_NO_COMMIT');
  }
});

test('line appends one line per event and records the stage in the manifest; watchLine writes the watch log', (t) => {
  const r = makeRepo(t);
  assert.throws(() => L.line(r.two, 'start', 'ship', { cwd: r.repo }), (err) => err.code === 'SHIP_NOT_OPEN');
  openTwo(r);
  assert.equal(L.line(r.two, 'start', 'ship 2c0ffee', { cwd: r.repo }), true);
  L.line(r.two, 'fetch', 'origin main fetched', { cwd: r.repo });
  L.line(r.two, 'range', 'two commits\nwith a break', { cwd: r.repo });
  L.line(r.two, 'gate', '', { cwd: r.repo });
  const m = L.readManifest(r.two, { cwd: r.repo });
  assert.equal(m.last_stage, 'gate');
  assert.ok(Number.isFinite(Date.parse(m.last_stage_at)));
  const log = logLines(r, r.two);
  const parsed = log.map((l) => LINE_RE.exec(l));
  assert.ok(parsed.every(Boolean), 'every line is <ISO> <stage> <text>');
  assert.deepEqual(stagesOf(log), ['start', 'fetch', 'range', 'gate']);
  assert.equal(parsed[2][2], 'two commits with a break');
  assert.equal(parsed[3][2], undefined);
  assert.equal(parsed[3][0].slice(0, 24), m.last_stage_at);
  assert.deepEqual(L.tail(r.two, 2, { cwd: r.repo }), log.slice(-2));
  assert.deepEqual(L.tail(r.two, undefined, { cwd: r.repo }), log);

  L.watchLine(r.two, 'watch', 'waiting on the deploy', { cwd: r.repo });
  assert.equal(L.watchLine(r.two, 'result', 'no new Sentry events in ten minutes', { cwd: r.repo }), true);
  assert.equal(L.watchLine(r.two, 'result', 'a second one', { cwd: r.repo }), false);
  assert.deepEqual(stagesOf(logLines(r, r.two, 'watch.log')), ['watch', 'result']);
  assert.equal(logLines(r, r.two).length, 4, 'the ship log is untouched');
});

test('one result writer: setResult writes both records once; line never writes a result', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  assert.throws(() => L.line(r.two, 'deploy', 'x', { cwd: r.repo }), /unknown stage/);
  assert.throws(() => L.line(r.two, 'result', 'ok pushed', { cwd: r.repo }), (err) => err.code === 'SHIP_RESULT_VIA_SETRESULT');
  assert.throws(() => L.setResult(r.two, 'fine', 'x', { cwd: r.repo }), /result state is one of/);
  assert.deepEqual([...L.STAGES], ['start', 'fetch', 'range', 'receipts', 'revert', 'gate', 'push', 'watch', 'ack', 'result']);
  assert.deepEqual([...L.RESULT_STATES], ['ok', 'ok-no-push', 'refused', 'failed', 'pushed-elsewhere']);
  L.setManifest(r.two, { pushed_at: '2026-10-22T06:00:00.000Z' }, { cwd: r.repo });
  assert.equal(L.claimWatch(r.two, { cwd: r.repo }), 'claimed');
  assert.equal(L.setResult(r.two, 'ok', 'pushed 2c0ffee, 2 commits', { cwd: r.repo }), true);
  assert.equal(L.setResult(r.two, 'failed', 'killed by SIGTERM', { cwd: r.repo }), false);
  const m = L.readManifest(r.two, { cwd: r.repo });
  assert.equal(m.result.state, 'ok');
  assert.equal(m.result.text, 'pushed 2c0ffee, 2 commits');
  assert.equal(m.last_stage, 'result');
  const log = logLines(r, r.two);
  assert.equal(log.length, 1);
  assert.match(log[0], / result ok pushed 2c0ffee, 2 commits$/);
  assert.equal(L.line(r.two, 'ack', 'read the events, a known flake', { cwd: r.repo }), true);
  assert.equal(L.setResult(r.two, 'refused', 'after the ack', { cwd: r.repo }), false, 'the manifest still holds the result');
  assert.deepEqual(stagesOf(logLines(r, r.two)), ['result', 'ack']);
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).result.state, 'ok');
});

test('a result line in the log with the manifest untouched blocks setResult and ends the ship in flight', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  L.line(r.two, 'push', 'pushed', { cwd: r.repo });
  assert.equal(L.inFlight({ cwd: r.repo }).sha, r.two);
  fs.appendFileSync(path.join(r.dir, `${r.two}.log`), `${new Date().toISOString()} result ok pushed 2c0ffee\n`);
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).result, null);
  assert.equal(L.inFlight({ cwd: r.repo }), null);
  assert.equal(L.setResult(r.two, 'failed', 'late', { cwd: r.repo }), false);
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).result, null);
});

test('a line separator and the word result in a text can neither forge nor block the result', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  const sep = String.fromCharCode(0x2028);
  L.line(r.two, 'range', `2c0ffee subject${sep}x result ok forged`, { cwd: r.repo });
  L.line(r.two, 'range', `next${String.fromCharCode(0x2029)}result failed`, { cwd: r.repo });
  const raw = fs.readFileSync(path.join(r.dir, `${r.two}.log`), 'utf8');
  assert.equal(raw.includes(sep), false);
  assert.equal(L.inFlight({ cwd: r.repo }).sha, r.two, 'still in flight');
  L.setManifest(r.two, { pushed_at: '2026-10-22T06:00:00.000Z' }, { cwd: r.repo });
  assert.equal(L.claimWatch(r.two, { cwd: r.repo }), 'claimed');
  assert.equal(L.setResult(r.two, 'ok', 'pushed 2c0ffee, 2 commits', { cwd: r.repo }), true);
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).result.state, 'ok');
  assert.deepEqual(stagesOf(logLines(r, r.two)), ['range', 'range', 'result']);
});

test('setManifest merges shallowly and atomically; it keeps the sha, needs an open ship and refuses a result', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  const receiptPath = path.join(r.repo, '.git', 'drb-gate', `${r.two}.json`);
  const next = L.setManifest(r.two, { gate: { receipt: receiptPath, result: 'passed' }, pushed_at: '2026-10-22T06:00:00.000Z' }, { cwd: r.repo });
  assert.deepEqual(next.gate, { receipt: storedPath(receiptPath, r.two), result: 'passed' }, 'a path under a raw key keeps its sha');
  const m = L.readManifest(r.two, { cwd: r.repo });
  assert.equal(m.pushed_at, '2026-10-22T06:00:00.000Z');
  assert.equal(m.touches_server, true, 'untouched fields stay');
  assert.throws(() => L.setManifest(r.two, { result: { state: 'ok', text: 'x' } }, { cwd: r.repo }), (err) => err.code === 'SHIP_RESULT_VIA_SETRESULT');
  assert.throws(() => L.setManifest(r.two, { sha: r.one }, { cwd: r.repo }), /keeps its sha/);
  assert.throws(() => L.setManifest(r.one, { pushed_at: '2026-10-22T06:00:00.000Z' }, { cwd: r.repo }), (err) => err.code === 'SHIP_NOT_OPEN');
  const left = fs.readdirSync(r.dir).filter((n) => /tmp|lock/.test(n));
  assert.deepEqual(left, [], 'no temp or lock file is left behind');
});

test('setManifest masks every string in the patch, nested ones included, except the raw keys', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  const run = neonRun();
  L.setManifest(r.two, {
    gate: { receipt: 'drb-gate/x.json', result: `failed: ${run}` },
    watch: { result: `saw ${run}`, count: 1, issues: [{ title: `boom ${run}`, finished_at: '2026-10-22T06:10:00.000Z' }], deploy_at: '2026-10-22T06:00:00.000Z' },
    commits: [{ sha: r.two, subject: `add ${run}` }],
  }, { cwd: r.repo });
  const raw = fs.readFileSync(path.join(r.dir, `${r.two}.json`), 'utf8');
  assert.equal(raw.includes(run), false);
  const m = L.readManifest(r.two, { cwd: r.repo });
  assert.equal(m.gate.result, 'failed: <TOKEN>');
  assert.equal(m.watch.result, 'saw <TOKEN>');
  assert.equal(m.watch.issues[0].title, 'boom <TOKEN>');
  assert.equal(m.watch.issues[0].finished_at, '2026-10-22T06:10:00.000Z');
  assert.equal(m.watch.deploy_at, '2026-10-22T06:00:00.000Z');
  assert.deepEqual(m.commits, [{ sha: r.two, subject: 'add <TOKEN>' }]);
});

test('the raw keys pass raw only when the value has their shape; keys are masked too', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  const phone = ['123', '456', '7890'].join('-');
  const uuid = ['1b4e28ba', '2fa1', '41d2', '883f', '0016d3cca427'].join('-');
  const email = ['someone', 'example.org'].join('@');
  const receiptPath = path.join(r.repo, '.git', 'drb-gate', `${r.two}.json`);
  L.setManifest(r.two, {
    pushed_at: '2026-10-22T08:00:00+02:00',
    gate: { receipt: `drb-gate/${email}`, result: 'failed', sha: r.one, path: receiptPath },
    watch: {
      count: 2,
      by_issue: { [phone]: 1, [['123', '456', '7891'].join('-')]: 1 },
      files: { log: `/tmp/${phone}.log`, path: `/tmp/run/${uuid}/x.json` },
      deploy_at: '2026-10-22T06:00:00Z',
      base: `not a sha ${neonRun()}`,
    },
  }, { cwd: r.repo });
  const raw = fs.readFileSync(path.join(r.dir, `${r.two}.json`), 'utf8');
  for (const v of [phone, uuid, email]) assert.equal(raw.includes(v), false, 'no shape lands in the manifest');
  const m = L.readManifest(r.two, { cwd: r.repo });
  assert.equal(m.pushed_at, '2026-10-22T06:00:00.000Z', 'a zoned time is stored normalized to Z');
  assert.equal(m.watch.deploy_at, '2026-10-22T06:00:00.000Z');
  assert.equal(m.gate.sha, r.one, 'a real sha under a sha key passes raw');
  assert.equal(m.gate.path, storedPath(receiptPath, r.two), 'a path keeps its full sha');
  assert.equal(m.gate.receipt, 'drb-gate/<EMAIL>');
  assert.deepEqual(m.watch.by_issue, { '<PHONE>': 1, '<PHONE> #2': 1 });
  assert.equal(m.watch.files.log, '/tmp/<PHONE>.log');
  assert.equal(m.watch.files.path, '/tmp/run/<UUID>/x.json');
  assert.equal(m.watch.base, 'not a sha <TOKEN>');
});

test('the reserved names and the shape rules read the cleaned key', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  assert.throws(() => L.setManifest(r.two, { 'result ': { state: 'ok', text: 'x' } }, { cwd: r.repo }), (err) => err.code === 'SHIP_RESULT_VIA_SETRESULT');
  assert.throws(() => L.setManifest(r.two, { ['sha' + String.fromCharCode(7)]: r.one }, { cwd: r.repo }), /keeps its sha/);
  assert.throws(() => L.setManifest(r.two, { 'sha ': r.two }, { cwd: r.repo }), /keeps its sha/, 'only the literal key may name the sha');
  assert.throws(() => L.setManifest(r.two, { 'pushed_at ': '2026-10-22T06:00:00' }, { cwd: r.repo }), (err) => err.code === 'SHIP_BAD_TIME');
  assert.equal(L.setManifest(r.two, { 'pushed_at ': '2026-10-22T08:00:00+02:00' }, { cwd: r.repo }).pushed_at, '2026-10-22T06:00:00.000Z');
  const m = L.readManifest(r.two, { cwd: r.repo });
  assert.equal(m.result, null);
  assert.equal(m.sha, r.two);
});

test('an own __proto__ key in a parsed patch is stored as a property', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  L.setManifest(r.two, JSON.parse('{"watch": {"__proto__": {"x": 1}, "count": 2}}'), { cwd: r.repo });
  const m = L.readManifest(r.two, { cwd: r.repo });
  assert.ok(Object.prototype.hasOwnProperty.call(m.watch, '__proto__'));
  assert.deepEqual(JSON.parse(JSON.stringify(m.watch)), JSON.parse('{"__proto__": {"x": 1}, "count": 2}'));
  assert.equal(Object.getPrototypeOf(m.watch), Object.prototype, 'the prototype was never set');
});

test('an all-digit key under by_issue passes raw; any other key there is masked', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  const longId = '7'.repeat(32); // all digits, and token-shaped anywhere else
  const shortId = ['12345', '67890'].join('');
  L.setManifest(r.two, { watch: { by_issue: { [longId]: 3, [shortId]: 1, [`issue-${longId}`]: 2 }, other: { [longId]: 4 } } }, { cwd: r.repo });
  const m = L.readManifest(r.two, { cwd: r.repo });
  assert.equal(m.watch.by_issue[longId], 3);
  assert.equal(m.watch.by_issue[shortId], 1);
  assert.equal(m.watch.by_issue['issue-<TOKEN>'], 2);
  assert.deepEqual(m.watch.other, { '<TOKEN>': 4 }, 'only by_issue keeps an all-digit key raw');
});

test('a leap day is a real time key value', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  assert.equal(L.setManifest(r.two, { pushed_at: '2028-02-29T06:00:00Z' }, { cwd: r.repo }).pushed_at, '2028-02-29T06:00:00.000Z');
});

test('git failing to resolve a ref is SHIP_RESOLVE_FAILED, never SHIP_NO_COMMIT', (t) => {
  const r = makeRepo(t);
  const real = M.seams.resolve;
  M.seams.resolve = (ref, cwd) => {
    if (ref === r.two.slice(0, 7)) {
      const err = new Error('git failed');
      err.status = 128;
      err.stderr = 'fatal: bad object';
      throw err;
    }
    return real(ref, cwd);
  };
  t.after(() => { M.seams.resolve = real; });
  assert.throws(() => L.open(r.two.slice(0, 7), { cwd: r.repo }), (err) => err.code === 'SHIP_RESOLVE_FAILED' && err.message.includes('status 128'));
  assert.throws(() => L.readManifest(r.two.slice(0, 7), { cwd: r.repo }), (err) => err.code === 'SHIP_RESOLVE_FAILED');
  assert.throws(() => L.readManifest('zzzzzzz', { cwd: r.repo }), (err) => err.code === 'SHIP_NO_COMMIT', 'a clean miss stays SHIP_NO_COMMIT');
});

test('with an unreadable pack, a short ref is SHIP_RESOLVE_FAILED, never SHIP_NO_COMMIT', (t) => {
  const r = makeRepo(t);
  git(r.repo, 'repack', '-q', '-a', '-d');
  const dir = path.join(r.repo, '.git', 'objects', 'pack');
  fs.chmodSync(path.join(dir, fs.readdirSync(dir).find((n) => n.endsWith('.pack'))), 0o000);
  assert.throws(() => L.open(r.two.slice(0, 7), { cwd: r.repo }), (err) => err.code === 'SHIP_RESOLVE_FAILED');
  assert.throws(() => L.readManifest('zzzzzzz', { cwd: r.repo }), (err) => err.code === 'SHIP_RESOLVE_FAILED');
});

const prevFiles = (r) => fs.readdirSync(r.dir).filter((n) => n.includes('.prev-'));

test('open refuses to move aside a push that started with no result, unless the caller says the sha is off origin', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  L.setManifest(r.two, { push_started_at: '2026-10-22T08:00:00+02:00' }, { cwd: r.repo });
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).push_started_at, '2026-10-22T06:00:00.000Z', 'a time key, normalized');
  for (const key of ['push_started_at', 'push_unknown_at']) {
    assert.throws(() => L.setManifest(r.two, { [key]: '2026-10-22T06:00:00' }, { cwd: r.repo }), (err) => err.code === 'SHIP_BAD_TIME', key);
  }
  L.line(r.two, 'push', 'outcome unknown: the fetch after a failed push failed; run ship again', { cwd: r.repo });
  for (const extra of [{}, { offOrigin: 'yes' }]) {
    assert.throws(() => openTwo(r, r.two, extra), (err) => err.code === 'SHIP_UNSETTLED' && err.message.includes(r.two.slice(0, 7)) && err.message.includes('run ship again'));
  }
  assert.deepEqual(prevFiles(r), [], 'nothing moved');
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).push_started_at, '2026-10-22T06:00:00.000Z');
  openTwo(r, r.two, { offOrigin: true });
  const m = L.readManifest(r.two, { cwd: r.repo });
  assert.deepEqual([m.push_started_at, m.push_unknown_at, m.result], [null, null, null]);
  assert.deepEqual(prevFiles(r).map((n) => n.replace(/^.*\.prev-\d+\./, '')).sort(), ['json', 'log']);
  // No push_started_at and no result (it died before its push): moves aside without the flag.
  L.line(r.two, 'gate', 'running', { cwd: r.repo });
  openTwo(r);
  assert.equal(prevFiles(r).length, 4);
  // A push that started and then ended with a result: moves aside without the flag.
  L.setManifest(r.two, { push_started_at: '2026-10-22T06:00:00.000Z' }, { cwd: r.repo });
  L.setResult(r.two, 'failed', 'push did not land', { cwd: r.repo });
  openTwo(r);
  assert.equal(prevFiles(r).length, 6);
  // pushed_at set: SHIP_ALREADY_OK, flag or not.
  L.setManifest(r.two, { push_started_at: '2026-10-22T06:00:00.000Z', pushed_at: '2026-10-22T06:00:05.000Z' }, { cwd: r.repo });
  for (const extra of [{}, { offOrigin: true }]) {
    assert.throws(() => openTwo(r, r.two, extra), (err) => err.code === 'SHIP_ALREADY_OK');
  }
  assert.equal(prevFiles(r).length, 6, 'nothing moved');
});

test('a push whose outcome stayed unknown is not in flight; one still mid-push is', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  L.setManifest(r.two, { push_started_at: new Date().toISOString() }, { cwd: r.repo });
  L.line(r.two, 'push', 'pushing', { cwd: r.repo });
  assert.equal(L.inFlight({ cwd: r.repo }).sha, r.two, 'mid-push, the log fresh');
  L.setManifest(r.two, { push_unknown_at: '2026-10-22T08:00:00+02:00' }, { cwd: r.repo });
  L.line(r.two, 'push', 'outcome unknown: the fetch failed; run ship again', { cwd: r.repo });
  const m = L.readManifest(r.two, { cwd: r.repo });
  assert.equal(m.push_unknown_at, '2026-10-22T06:00:00.000Z', 'a time key, normalized');
  assert.ok(Date.now() - fs.statSync(path.join(r.dir, `${r.two}.log`)).mtimeMs < 60_000, 'the log is fresh');
  assert.equal(L.inFlight({ cwd: r.repo }), null);
  assert.deepEqual(L.unsettled({ cwd: r.repo }).map((x) => x.sha), [r.two], 'it ended, and is still unsettled');
});

test('a result line anywhere in the log stands: setResult writes nothing and the ship is not in flight', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  L.line(r.two, 'push', 'pushed', { cwd: r.repo });
  // The result line landed and the manifest write after it did not; an ack followed.
  fs.appendFileSync(path.join(r.dir, `${r.two}.log`), `${new Date().toISOString()} result failed push did not land\n`);
  L.line(r.two, 'ack', 'read it', { cwd: r.repo });
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).result, null);
  const before = fs.readFileSync(path.join(r.dir, `${r.two}.log`), 'utf8');
  assert.equal(L.setResult(r.two, 'refused', 'a retry', { cwd: r.repo }), false);
  assert.equal(fs.readFileSync(path.join(r.dir, `${r.two}.log`), 'utf8'), before, 'nothing written');
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).result, null);
  assert.equal(L.inFlight({ cwd: r.repo }), null);
});

test('a result line anywhere in the watch log refuses a second watch result', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  const wlog = path.join(r.dir, `${r.two}.watch.log`);
  fs.appendFileSync(wlog, `${new Date().toISOString()} result no new Sentry events in ten minutes\n`);
  assert.equal(L.watchLine(r.two, 'watch', 'a late line', { cwd: r.repo }), true);
  const before = fs.readFileSync(wlog, 'utf8');
  assert.equal(L.watchLine(r.two, 'result', 'a second one', { cwd: r.repo }), false);
  assert.equal(fs.readFileSync(wlog, 'utf8'), before, 'nothing written');
  assert.deepEqual(stagesOf(logLines(r, r.two, 'watch.log')), ['result', 'watch']);
});

test('unsettled lists every record whose push started with no result standing, oldest started_at first', (t) => {
  const r = makeRepo(t);
  const [three, four, five] = ['c', 'd', 'e'].map((n) => commit(r.repo, `work ${n}`, `server/${n}.js`));
  // Stamps relative to the clock, every one before the records opened below,
  // so no fixed instant is pitted against the real time.
  const t0 = Date.now();
  const at = (h) => new Date(t0 - (10 - h) * HOUR).toISOString();
  const start = (sha, h) => {
    openTwo(r, sha);
    L.setManifest(sha, { started_at: at(h), push_started_at: at(h) }, { cwd: r.repo });
  };
  assert.deepEqual(L.unsettled({ cwd: r.repo }), [], 'no records');
  // Settled by the manifest's result alone (its log emptied).
  start(r.base, 1);
  L.setResult(r.base, 'failed', 'push did not land', { cwd: r.repo });
  fs.writeFileSync(path.join(r.dir, `${r.base}.log`), '');
  // Settled by a result line alone.
  start(r.one, 2);
  fs.appendFileSync(path.join(r.dir, `${r.one}.log`), `${new Date().toISOString()} result failed push did not land\n`);
  // Died before its push: no push_started_at.
  openTwo(r, three);
  // Unsettled: push_started_at, no result; and the same with push_unknown_at.
  start(r.two, 7);
  start(four, 5);
  L.setManifest(four, { push_unknown_at: at(6) }, { cwd: r.repo });
  // Unreadable (not JSON, not an object, naming another sha): listed first,
  // with no started_at to order by, never passed over; inFlight passes it over.
  start(five, 3);
  const fiveFile = path.join(fs.realpathSync(r.dir), `${five}.json`);
  for (const body of ['{ torn', '[]', JSON.stringify({ ...L.readManifest(five, { cwd: r.repo }), sha: r.two })]) {
    fs.writeFileSync(fiveFile, body);
    const list = L.unsettled({ cwd: r.repo });
    assert.deepEqual(list.map((e) => e.sha), [five, four, r.two], body);
    assert.deepEqual(list[0], { sha: five, unreadable: true, path: fiveFile });
    assert.deepEqual([list[1].state, list[1].since, list[1].manifest.push_unknown_at], ['unknown', at(6), at(6)]);
    assert.equal(L.inFlight({ cwd: r.repo }).sha, three, 'the newest readable record');
  }
  // The order follows started_at, whatever the directory order.
  L.setManifest(r.two, { started_at: at(4) }, { cwd: r.repo });
  assert.deepEqual(L.unsettled({ cwd: r.repo }).map((e) => e.sha), [five, r.two, four]);
});

// A pid no process holds, found by probing: a child that ran and exited.
function deadPid() {
  for (;;) {
    const pid = spawnSync(process.execPath, ['-e', '0']).pid;
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code === 'ESRCH') return pid;
    }
  }
}

test('inFlight holds while the ship\'s pid is alive and its log fresh; a dead pid ends it at once and unsettled lists it', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  L.setManifest(r.two, { push_started_at: '2026-10-22T06:00:00.000Z' }, { cwd: r.repo });
  L.line(r.two, 'push', 'pushing', { cwd: r.repo });
  assert.equal(L.inFlight({ cwd: r.repo }).sha, r.two, 'the pid is this process and the log is fresh');
  assert.deepEqual(L.unsettled({ cwd: r.repo }), [], 'the in-flight record is left out by default');
  assert.deepEqual(L.unsettled({ cwd: r.repo, all: 'yes' }), [], 'only all: true lists it');
  assert.deepEqual(L.unsettled({ cwd: r.repo, all: true }).map((e) => e.sha), [r.two]);
  L.setManifest(r.two, { pid: 1 }, { cwd: r.repo });
  assert.equal(L.inFlight({ cwd: r.repo }).sha, r.two, 'EPERM (or a root run) counts as alive');
  L.setManifest(r.two, { pid: deadPid() }, { cwd: r.repo });
  assert.equal(L.inFlight({ cwd: r.repo }), null, 'a dead pid, the log still fresh');
  const list = L.unsettled({ cwd: r.repo });
  assert.deepEqual(list.map((e) => [e.sha, e.state, e.since]), [[r.two, 'unknown', '2026-10-22T06:00:00.000Z']]);
  // Only a positive integer is probed: kill 0 on a negative pid would ask
  // after a process group. Such a pid reads as none, the two-hour rule alone.
  L.setManifest(r.two, { pid: -deadPid() }, { cwd: r.repo });
  assert.equal(L.inFlight({ cwd: r.repo }).sha, r.two);
});

test('a record with no pid, an older one, has the two-hour rule alone', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  const file = path.join(r.dir, `${r.two}.json`);
  const { pid, ...older } = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(pid, process.pid);
  fs.writeFileSync(file, JSON.stringify(older));
  L.line(r.two, 'gate', 'running', { cwd: r.repo });
  assert.equal(Object.prototype.hasOwnProperty.call(L.readManifest(r.two, { cwd: r.repo }), 'pid'), false);
  assert.equal(L.inFlight({ cwd: r.repo }).sha, r.two);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000 - 60_000);
  fs.utimesSync(path.join(r.dir, `${r.two}.log`), old, old);
  assert.equal(L.inFlight({ cwd: r.repo }), null);
});

test('unsettled names each state and since: pushed once pushed_at is set; since is push_unknown_at, else pushed_at, else push_started_at', (t) => {
  const r = makeRepo(t);
  const three = commit(r.repo, 'work c', 'server/c.js');
  const at = (h) => `2026-10-22T0${h}:00:00.000Z`;
  const rows = [
    [r.base, { push_started_at: at(1) }, 'unknown', at(1)],
    [r.one, { push_started_at: at(1), push_unknown_at: at(2) }, 'unknown', at(2)],
    [r.two, { push_started_at: at(1), pushed_at: at(3) }, 'pushed', at(3)],
    [three, { push_started_at: at(1), push_unknown_at: at(2), pushed_at: at(4) }, 'pushed', at(2)],
  ];
  rows.forEach(([sha, patch], i) => {
    openTwo(r, sha);
    L.setManifest(sha, { started_at: at(i + 1), ...patch }, { cwd: r.repo });
  });
  assert.equal(L.inFlight({ cwd: r.repo }), null, 'the newest carries push_unknown_at');
  const list = L.unsettled({ cwd: r.repo });
  assert.deepEqual(list.map((e) => [e.sha, e.state, e.since]), rows.map(([sha, , state, since]) => [sha, state, since]));
  assert.deepEqual(list.map((e) => e.manifest.sha), rows.map(([sha]) => sha));
});

test('a time key that is not a zoned ISO time is refused and nothing is stored', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  for (const patch of [{ pushed_at: '2026-10-22T06:00:00' }, { pushed_at: '2026-10-22' }, { pushed_at: 1761112800000 }, { watch: { deploy_at: '2026-10-22T06:00:00' } }, { started_at: 'soon' }, { pushed_at: '2026-02-30T06:00:00Z' }, { watch: { finished_at: '2026-04-31T06:00:00Z' } }, { last_stage_at: '2026-10-22T06:00:00' }, { watch: { at: '2026-10-22T06:00:00' } }]) {
    assert.throws(() => L.setManifest(r.two, patch, { cwd: r.repo }), (err) => err.code === 'SHIP_BAD_TIME', JSON.stringify(patch));
  }
  const m = L.readManifest(r.two, { cwd: r.repo });
  assert.equal(m.pushed_at, null);
  assert.equal(m.last_stage_at, null);
  assert.equal(m.watch, null);
  assert.equal(L.setManifest(r.two, { pushed_at: null }, { cwd: r.repo }).pushed_at, null);
});

test('the inFlight fallback orders by normalized stamps only: a zoneless started_at written by hand sorts oldest', (t) => {
  const r = makeRepo(t);
  openTwo(r, r.one);
  openTwo(r, r.two);
  L.setManifest(r.two, { started_at: '2026-10-22T06:00:00.000Z' }, { cwd: r.repo });
  const file = path.join(r.dir, `${r.one}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), started_at: '2026-10-22T09:00:00' }));
  fs.rmSync(path.join(r.dir, 'last')); // so the newest by started_at decides
  assert.equal(L.inFlight({ cwd: r.repo }).sha, r.two);
});

test('a manifest whose stored sha is not its file\'s sha is refused', (t) => {
  const r = makeRepo(t);
  openTwo(r, r.one);
  const file = path.join(r.dir, `${r.one}.json`);
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...m, sha: r.two }));
  assert.throws(() => L.readManifest(r.one, { cwd: r.repo }), /does not name its own sha/);
  assert.throws(() => L.setManifest(r.one, { pushed_at: '2026-10-22T06:00:00.000Z' }, { cwd: r.repo }), /does not name its own sha/);
  assert.equal(L.inFlight({ cwd: r.repo }), null, 'passed over');
});

test('open refuses a ship that already ended ok; an earlier attempt otherwise moves aside whole', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  L.line(r.two, 'start', 'ship', { cwd: r.repo });
  L.watchLine(r.two, 'watch', 'stray watch line', { cwd: r.repo });
  L.setResult(r.two, 'refused', 'no receipt', { cwd: r.repo });
  openTwo(r);
  assert.equal(fs.readFileSync(path.join(r.dir, `${r.two}.log`), 'utf8'), '');
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).result, null);
  assert.equal(fs.existsSync(path.join(r.dir, `${r.two}.watch.log`)), false);
  const prev = fs.readdirSync(r.dir).filter((n) => n.includes('.prev-')).sort();
  assert.equal(prev.length, 3);
  assert.deepEqual(prev.map((n) => n.replace(/^.*\.prev-\d+\./, '')), ['json', 'log', 'watch.log']);
  assert.match(fs.readFileSync(path.join(r.dir, prev[1]), 'utf8'), / result refused no receipt\n$/);
  L.setManifest(r.two, { pushed_at: '2026-10-22T06:00:00.000Z' }, { cwd: r.repo });
  L.claimWatch(r.two, { cwd: r.repo });
  L.setResult(r.two, 'ok', 'pushed 2c0ffee, 2 commits', { cwd: r.repo });
  L.line(r.two, 'ack', 'a note after the result', { cwd: r.repo });
  assert.throws(() => openTwo(r), (err) => err.code === 'SHIP_ALREADY_OK', 'ok with pushed_at, the log no longer ending in it');
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).result.state, 'ok', 'nothing moved');
});

test('a result ok line with the manifest result still null (a setResult cut short) refuses a re-open', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  L.line(r.two, 'push', 'pushed', { cwd: r.repo });
  fs.appendFileSync(path.join(r.dir, `${r.two}.log`), `${new Date().toISOString()} result ok pushed 2c0ffee, 2 commits\n`);
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).result, null);
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).pushed_at, null);
  assert.throws(() => openTwo(r), (err) => err.code === 'SHIP_ALREADY_OK');
  assert.deepEqual(fs.readdirSync(r.dir).filter((n) => n.includes('.prev-')), [], 'nothing moved aside');
});

test('the inFlight tie on started_at goes to the sha last names, whatever the directory order', (t) => {
  const r = makeRepo(t);
  openTwo(r, r.one);
  openTwo(r, r.two);
  L.setManifest(r.one, { started_at: '2026-10-22T06:00:00.000Z' }, { cwd: r.repo });
  L.setManifest(r.two, { started_at: '2026-10-22T06:00:00.000Z' }, { cwd: r.repo });
  // Only `last` changes between the two runs, written in place, so the two
  // manifests keep one directory order: whichever comes first, one of the
  // runs names the other sha in last, and only the last rule returns it.
  const lastFile = path.join(r.dir, 'last');
  for (const named of [r.one, r.two]) {
    fs.writeFileSync(lastFile, `${named}\n`);
    assert.equal(L.readLast({ cwd: r.repo }), named);
    assert.equal(L.inFlight({ cwd: r.repo }).sha, named);
  }
});

test('open refuses whenever the prior attempt pushed, or any prior log line is a result ok line', (t) => {
  const r = makeRepo(t);
  // Pushed, then failed: an older record (setResult now refuses any state
  // but ok once pushed_at is set), its result written by hand.
  openTwo(r);
  L.setManifest(r.two, { pushed_at: '2026-10-22T06:00:00.000Z' }, { cwd: r.repo });
  const file = path.join(r.dir, `${r.two}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), result: { state: 'failed', text: 'the watch would not start', at: '2026-10-22T06:00:01.000Z' } }));
  assert.throws(() => openTwo(r), (err) => err.code === 'SHIP_ALREADY_OK', 'pushed then failed');
  // Pushed, with no result at all.
  openTwo(r, r.one);
  L.setManifest(r.one, { pushed_at: '2026-10-22T06:00:00.000Z' }, { cwd: r.repo });
  assert.throws(() => openTwo(r, r.one), (err) => err.code === 'SHIP_ALREADY_OK', 'pushed with no result');
});

test('an ok line followed by an ack line still refuses a re-open, with no pushed_at in the manifest', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  fs.appendFileSync(path.join(r.dir, `${r.two}.log`), `${new Date().toISOString()} result ok pushed 2c0ffee, 2 commits\n`);
  L.line(r.two, 'ack', 'read the events', { cwd: r.repo });
  const m = L.readManifest(r.two, { cwd: r.repo });
  assert.equal(m.pushed_at, null);
  assert.equal(m.result, null);
  assert.match(logLines(r, r.two).at(-1), / ack read the events$/);
  assert.throws(() => openTwo(r), (err) => err.code === 'SHIP_ALREADY_OK');
});

test('pushed-elsewhere on a sha with no record: open, then the result, with no pushed_at', (t) => {
  const r = makeRepo(t);
  assert.equal(L.readManifest(r.two, { cwd: r.repo }), null);
  L.open(r.two, { cwd: r.repo, base: r.base });
  assert.deepEqual(fs.readdirSync(r.dir).filter((n) => n.includes('.prev-')), [], 'nothing to move aside');
  assert.equal(L.setResult(r.two, 'pushed-elsewhere', 'shipped by another window', { cwd: r.repo }), true);
  const m = L.readManifest(r.two, { cwd: r.repo });
  assert.equal(m.pushed_at, null);
  assert.deepEqual([m.result.state, m.result.text], ['pushed-elsewhere', 'shipped by another window']);
  assert.match(logLines(r, r.two).at(-1), / result pushed-elsewhere shipped by another window$/);
  assert.equal(L.inFlight({ cwd: r.repo }), null);
});

test('a dry run (ok-no-push) does not stop the real ship of the same sha', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  L.line(r.two, 'gate', 'passed', { cwd: r.repo });
  L.watchLine(r.two, 'watch', 'a stray line', { cwd: r.repo });
  assert.equal(L.setResult(r.two, 'ok-no-push', 'gate passed, nothing pushed', { cwd: r.repo }), true);
  assert.match(logLines(r, r.two).at(-1), / result ok-no-push gate passed, nothing pushed$/);
  openTwo(r);
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).result, null);
  const prev = fs.readdirSync(r.dir).filter((n) => n.includes('.prev-')).map((n) => n.replace(/^.*\.prev-\d+\./, '')).sort();
  assert.deepEqual(prev, ['json', 'log', 'watch.log']);
  // An ok result cannot be written before pushed_at, and nothing is written.
  assert.throws(() => L.setResult(r.two, 'ok', 'pushed 2c0ffee, 2 commits', { cwd: r.repo }), (err) => err.code === 'SHIP_OK_NEEDS_PUSH');
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).result, null);
  assert.equal(fs.readFileSync(path.join(r.dir, `${r.two}.log`), 'utf8'), '');
});

test('inFlight returns the open manifest, and null once a result is set or the log is two hours old', (t) => {
  const r = makeRepo(t);
  openTwo(r, r.one);
  L.line(r.one, 'start', 'ship', { cwd: r.repo });
  assert.equal(L.inFlight({ cwd: r.repo }).sha, r.one);
  L.setManifest(r.one, { started_at: '2026-10-22T05:00:00.000Z' }, { cwd: r.repo });
  L.setManifest(r.one, { pushed_at: '2026-10-22T06:00:00.000Z' }, { cwd: r.repo });
  L.claimWatch(r.one, { cwd: r.repo });
  L.setResult(r.one, 'ok', 'pushed', { cwd: r.repo });
  assert.equal(L.inFlight({ cwd: r.repo }), null, 'a manifest with a result is not in flight');

  openTwo(r, r.two);
  L.line(r.two, 'gate', 'running', { cwd: r.repo });
  assert.equal(L.inFlight({ cwd: r.repo }).sha, r.two);
  const log = path.join(r.dir, `${r.two}.log`);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000 - 60_000);
  fs.utimesSync(log, old, old);
  assert.equal(L.inFlight({ cwd: r.repo }), null, 'a log not written for two hours is not in flight');
  const recent = new Date(Date.now() - 2 * 60 * 60 * 1000 + 60_000);
  fs.utimesSync(log, recent, recent);
  assert.equal(L.inFlight({ cwd: r.repo }).sha, r.two);
});

test('inFlight reads the record last names; the newest by started_at stands in only when last names no readable manifest', (t) => {
  const r = makeRepo(t);
  openTwo(r, r.one);
  openTwo(r, r.two);
  L.setManifest(r.one, { started_at: '2026-10-22T07:00:00.000Z' }, { cwd: r.repo });
  L.setManifest(r.two, { started_at: '2026-10-22T06:00:00.000Z' }, { cwd: r.repo });
  assert.equal(L.readLast({ cwd: r.repo }), r.two);
  assert.equal(L.inFlight({ cwd: r.repo }).sha, r.two, 'last names it, whatever the start times');
  // No last, a last that cannot be read (a directory) and a last that holds
  // no sha: the newest by started_at stands in.
  const lastFile = path.join(r.dir, 'last');
  fs.rmSync(lastFile);
  assert.equal(L.inFlight({ cwd: r.repo }).sha, r.one);
  fs.mkdirSync(lastFile);
  assert.throws(() => L.readLast({ cwd: r.repo }), /EISDIR|illegal operation/);
  assert.equal(L.inFlight({ cwd: r.repo }).sha, r.one);
  fs.rmdirSync(lastFile);
  fs.writeFileSync(lastFile, 'not a sha\n');
  assert.equal(L.inFlight({ cwd: r.repo }).sha, r.one);
  fs.writeFileSync(lastFile, `${r.two}\n`);
  // The record last names ended: nothing is in flight. The older open one,
  // later by the clock, is a ship that died and never stands in.
  L.setManifest(r.two, { pushed_at: '2026-10-22T06:00:00.000Z' }, { cwd: r.repo });
  L.claimWatch(r.two, { cwd: r.repo });
  L.setResult(r.two, 'ok', 'pushed', { cwd: r.repo });
  assert.equal(L.inFlight({ cwd: r.repo }), null);
  // With the record last names unreadable, the newest readable one stands in.
  fs.writeFileSync(path.join(r.dir, `${r.two}.json`), '{ torn');
  assert.equal(L.inFlight({ cwd: r.repo }).sha, r.one);
  assert.throws(() => L.readManifest(r.two, { cwd: r.repo }), /not valid JSON/);
});

test('a settled record started fifteen minutes ahead by the clock never hides the live record last names', (t) => {
  const r = makeRepo(t);
  openTwo(r, r.one);
  L.setManifest(r.one, { pushed_at: new Date().toISOString() }, { cwd: r.repo });
  L.claimWatch(r.one, { cwd: r.repo });
  L.setResult(r.one, 'ok', 'pushed', { cwd: r.repo });
  L.setManifest(r.one, { started_at: new Date(Date.now() + 15 * 60 * 1000).toISOString() }, { cwd: r.repo });
  openTwo(r, r.two);
  L.setManifest(r.two, { push_started_at: new Date().toISOString() }, { cwd: r.repo });
  L.line(r.two, 'push', 'pushing', { cwd: r.repo });
  assert.equal(L.readLast({ cwd: r.repo }), r.two);
  assert.equal(L.inFlight({ cwd: r.repo }).sha, r.two);
  assert.deepEqual(L.unsettled({ cwd: r.repo }), [], 'the live record is left out');
  assert.deepEqual(L.unsettled({ cwd: r.repo, all: true }).map((e) => e.sha), [r.two]);
});

test('a token-shaped run built at runtime is written masked to both logs and the manifest', (t) => {
  const r = makeRepo(t);
  const run = neonRun();
  L.open(r.two, { cwd: r.repo, base: r.base, commits: [{ sha: r.two, subject: `add ${run} to config` }], docs_only: false, touches_server: true, touches_client: false });
  L.line(r.two, 'gate', `smoke printed ${run}`, { cwd: r.repo });
  L.setResult(r.two, 'failed', `the suite printed ${run}`, { cwd: r.repo });
  L.watchLine(r.two, 'watch', `sentry said ${run}`, { cwd: r.repo });
  L.setManifest(r.two, { watch: { result: `saw ${run}`, count: 1 } }, { cwd: r.repo });
  const log = fs.readFileSync(path.join(r.dir, `${r.two}.log`), 'utf8');
  const wlog = fs.readFileSync(path.join(r.dir, `${r.two}.watch.log`), 'utf8');
  const man = fs.readFileSync(path.join(r.dir, `${r.two}.json`), 'utf8');
  for (const [name, text] of [['log', log], ['watch log', wlog], ['manifest', man]]) {
    assert.equal(text.includes(run), false, `the run never lands in the ${name}`);
    assert.ok(text.includes('<TOKEN>'), `the ${name} carries the mask`);
  }
  assert.match(log, / gate smoke printed <TOKEN>\n/);
  assert.match(log, / result failed the suite printed <TOKEN>\n$/);
  const m = L.readManifest(r.two, { cwd: r.repo });
  assert.equal(m.commits[0].subject, 'add <TOKEN> to config');
  assert.equal(m.result.text, 'the suite printed <TOKEN>');
});

test('an unreadable manifest sorts ahead of a readable one with no zoned started_at, in either directory order', (t) => {
  const r = makeRepo(t);
  openTwo(r, r.one);
  openTwo(r, r.two);
  const dead = deadPid();
  const file = (sha) => path.join(r.dir, `${sha}.json`);
  const body = (sha) => ({ ...L.readManifest(sha, { cwd: r.repo }), pid: dead, push_started_at: '2026-10-22T06:00:00.000Z' });
  const bodies = { [r.one]: body(r.one), [r.two]: body(r.two) };
  // Each file is rewritten in place, so the directory order of the two never
  // changes; swapping which one is torn puts the readable one first in that
  // order in one of the runs.
  for (const [torn, readable] of [[r.one, r.two], [r.two, r.one]]) {
    for (const started of [undefined, null, '2026-10-22T09:00:00']) {
      const rest = { ...bodies[readable] };
      delete rest.started_at;
      fs.writeFileSync(file(readable), JSON.stringify(started === undefined ? rest : { ...rest, started_at: started }));
      fs.writeFileSync(file(torn), '{ torn');
      const list = L.unsettled({ cwd: r.repo });
      assert.deepEqual(list.map((e) => [e.sha, e.unreadable === true]), [[torn, true], [readable, false]], String(started));
    }
  }
});

// Merges `patch` into a manifest by hand, past every writer's guard.
function editManifest(r, sha, patch) {
  const file = path.join(r.dir, `${sha}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...patch }));
}

// Writes watch_started_at into the manifest by hand: setManifest refuses the key.
const stampClaim = (r, sha, at) => editManifest(r, sha, { watch_started_at: at });

test('claimWatch: a fresh record is claimed once and pending after; setManifest refuses the key', (t) => {
  const r = makeRepo(t);
  assert.throws(() => L.claimWatch(r.two, { cwd: r.repo }), (err) => err.code === 'SHIP_NOT_OPEN');
  openTwo(r);
  const before = Date.now();
  assert.equal(L.claimWatch(r.two, { cwd: r.repo }), 'claimed');
  const stamp = L.readManifest(r.two, { cwd: r.repo }).watch_started_at;
  assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Date.parse(stamp) >= before - 1000);
  assert.equal(L.claimWatch(r.two, { cwd: r.repo }), 'pending');
  assert.equal(L.claimWatch(r.two, { cwd: r.repo }), 'pending');
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).watch_started_at, stamp, 'nothing stamped');
  for (const key of ['watch_started_at', 'watch_started_at ']) {
    assert.throws(() => L.setManifest(r.two, { [key]: null }, { cwd: r.repo }), (err) => err.code === 'SHIP_WATCH_VIA_CLAIM', key);
  }
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).watch_started_at, stamp);
});

test('claimWatch claims again only past the stale bound with no non-blank line in the watch log', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  // Inside the bound with no watch line: pending (the watch may be starting).
  stampClaim(r, r.two, ago(30_000));
  assert.equal(L.claimWatch(r.two, { cwd: r.repo }), 'pending');
  // Past the bound with no watch log: that watch never started; claimed again, stamped now.
  stampClaim(r, r.two, ago(5 * 60_000));
  assert.equal(L.claimWatch(r.two, { cwd: r.repo }), 'claimed');
  assert.ok(Date.now() - Date.parse(L.readManifest(r.two, { cwd: r.repo }).watch_started_at) < 60_000);
  // Past the bound with an empty watch log, and with one of blank lines only: still no line, claimed again.
  for (const body of ['', '\n  \n\t\n']) {
    stampClaim(r, r.two, ago(5 * 60_000));
    fs.writeFileSync(path.join(r.dir, `${r.two}.watch.log`), body);
    assert.equal(L.claimWatch(r.two, { cwd: r.repo }), 'claimed', JSON.stringify(body));
  }
  // Past the bound with a watch line: that watch started; nothing stamped.
  const old = ago(5 * 60_000);
  stampClaim(r, r.two, old);
  L.watchLine(r.two, 'start', 'watching', { cwd: r.repo });
  assert.equal(L.claimWatch(r.two, { cwd: r.repo }), 'started');
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).watch_started_at, old);
});

test('with no watch line, a set stamp that cannot be a claim made this minute is stale; a zoned stamp within the minute either side is pending', (t) => {
  const r = makeRepo(t);
  settleOk(r, r.two);
  const stampOf = () => L.readManifest(r.two, { cwd: r.repo }).watch_started_at;
  // Not a zoned time, or a zoned time more than a minute ahead: claimed, and
  // listed never-started (no last write) while it stands.
  for (const make of [() => '', () => 0, () => '2026-10-22T06:00:00', () => 'long ago', () => '2999-01-01T00:00:00.000Z', () => ahead(10 * 60_000), () => ahead(70_000)]) {
    const stamp = make();
    const name = JSON.stringify(stamp);
    stampClaim(r, r.two, stamp);
    assert.deepEqual(L.unwatched({ cwd: r.repo }).map((e) => [e.sha, e.state, e.since, e.last_write]), [[r.two, 'never-started', stamp, null]], name);
    assert.equal(L.claimWatch(r.two, { cwd: r.repo }), 'claimed', name);
    assert.ok(Math.abs(Date.now() - Date.parse(stampOf())) < 60_000, `${name} restamped now`);
  }
  // The edge from both sides: within the minute either side, pending, not
  // listed and not stamped; seventy seconds old, claimed.
  for (const [make, want] of [[() => ahead(30_000), 'pending'], [() => ago(50_000), 'pending'], [() => ago(70_000), 'claimed']]) {
    const stamp = make();
    stampClaim(r, r.two, stamp);
    assert.deepEqual(L.unwatched({ cwd: r.repo }).map((e) => e.state), want === 'claimed' ? ['never-started'] : [], stamp);
    assert.equal(L.claimWatch(r.two, { cwd: r.repo }), want, stamp);
    if (want === 'pending') assert.equal(stampOf(), stamp, 'nothing stamped');
  }
});

test('a died watch\'s lines under a claim within the minute either side are pending; under an older, far-ahead or zoneless claim, claimed, listed with the log\'s last write', (t) => {
  const r = makeRepo(t);
  settleOk(r, r.two);
  const wlog = path.join(r.dir, `${r.two}.watch.log`);
  const cases = [[() => ago(50_000), 'pending'], [() => ago(70_000), 'claimed'], [() => ahead(30_000), 'pending'], [() => ahead(10 * 60_000), 'claimed'], [() => '2026-10-22T06:00:00', 'claimed']];
  for (const [make, want] of cases) {
    fs.writeFileSync(wlog, `${ago(2 * HOUR)} start watching\n`);
    backdate(wlog, HOUR + 60_000);
    const lastWrite = new Date(fs.statSync(wlog).mtimeMs).toISOString();
    assert.ok(Math.abs(Date.parse(lastWrite) - (Date.now() - HOUR - 60_000)) < 5_000, 'the backdated write');
    const stamp = make();
    stampClaim(r, r.two, stamp);
    const list = L.unwatched({ cwd: r.repo });
    assert.deepEqual(list.map((e) => [e.sha, e.state, e.since, e.last_write]), want === 'claimed' ? [[r.two, 'died', stamp, lastWrite]] : [], stamp);
    assert.equal(L.claimWatch(r.two, { cwd: r.repo }), want, stamp);
  }
});

test('once pushed_at is set, ok is the only result: every other state throws and writes nothing', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  L.line(r.two, 'push', 'pushed', { cwd: r.repo });
  L.setManifest(r.two, { pushed_at: '2026-10-22T06:00:00.000Z' }, { cwd: r.repo });
  const logFile = path.join(r.dir, `${r.two}.log`);
  const before = fs.readFileSync(logFile, 'utf8');
  for (const state of ['failed', 'refused', 'ok-no-push', 'pushed-elsewhere']) {
    assert.throws(() => L.setResult(r.two, state, 'after the push', { cwd: r.repo }), (err) => err.code === 'SHIP_RESULT_AFTER_PUSH' && err.message.includes(r.two.slice(0, 7)), state);
  }
  assert.equal(fs.readFileSync(logFile, 'utf8'), before, 'nothing written');
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).result, null);
  assert.equal(L.claimWatch(r.two, { cwd: r.repo }), 'claimed');
  assert.equal(L.setResult(r.two, 'ok', 'pushed 2c0ffee, 2 commits', { cwd: r.repo }), true);
});

test('a prior pushed-elsewhere record moves aside only with offOrigin true; SHIP_ALREADY_OK still wins first', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  assert.equal(L.setResult(r.two, 'pushed-elsewhere', 'shipped by another window', { cwd: r.repo }), true);
  for (const extra of [{}, { offOrigin: 'yes' }]) {
    assert.throws(() => openTwo(r, r.two, extra), (err) => err.code === 'SHIP_PUSHED_ELSEWHERE' && err.message.includes(r.two.slice(0, 7)));
  }
  assert.deepEqual(prevFiles(r), [], 'nothing moved');
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).result.state, 'pushed-elsewhere');
  openTwo(r, r.two, { offOrigin: true });
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).result, null);
  assert.equal(prevFiles(r).length, 2);
  // Such a line in the log with the manifest's result still null (a setResult
  // cut short) refuses the same way.
  fs.appendFileSync(path.join(r.dir, `${r.two}.log`), `${new Date().toISOString()} result pushed-elsewhere shipped by another window\n`);
  assert.throws(() => openTwo(r), (err) => err.code === 'SHIP_PUSHED_ELSEWHERE');
  assert.equal(prevFiles(r).length, 2, 'nothing moved');
  // pushed_at set beside it (by hand: setManifest stamps no settled record):
  // SHIP_ALREADY_OK, flag or not.
  const file = path.join(r.dir, `${r.two}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), pushed_at: '2026-10-22T06:00:00.000Z' }));
  for (const extra of [{}, { offOrigin: true }]) {
    assert.throws(() => openTwo(r, r.two, extra), (err) => err.code === 'SHIP_ALREADY_OK');
  }
  assert.equal(prevFiles(r).length, 2, 'nothing moved');
});

test('every write is durable: the manifest keeps writeJsonAtomic\'s bytes, fsynced before its rename and the directory after; a log line is fsynced', (t) => {
  const r = makeRepo(t);
  const calls = [];
  const real = L.fsyncSeam.sync;
  L.fsyncSeam.sync = (fd, target) => {
    calls.push(target);
    return real(fd, target);
  };
  t.after(() => { L.fsyncSeam.sync = real; });
  const p = L.shipPaths(r.two, { cwd: r.repo });
  // Each call as its file name, a temp file as <name>.tmp, the directory as '.'.
  const names = (from) => calls.slice(from).map((c) => (path.relative(p.dir, c) || '.').replace(/\.tmp-\d+-\d+$/, '.tmp'));
  const run = (fn) => {
    const from = calls.length;
    fn();
    return names(from);
  };
  const [log, json, wlog] = [`${r.two}.log`, `${r.two}.json`, `${r.two}.watch.log`];
  assert.deepEqual(run(() => openTwo(r)), [log, `${json}.tmp`, '.', 'last.tmp', '.']);
  assert.deepEqual(run(() => L.line(r.two, 'start', 'ship', { cwd: r.repo })), [log, `${json}.tmp`, '.']);
  assert.deepEqual(run(() => L.watchLine(r.two, 'start', 'watching', { cwd: r.repo })), [wlog, '.'], 'the append created the file');
  assert.deepEqual(run(() => L.watchLine(r.two, 'watch', 'waiting', { cwd: r.repo })), [wlog]);
  assert.deepEqual(run(() => L.setManifest(r.two, { push_started_at: '2026-10-22T06:00:00.000Z' }, { cwd: r.repo })), [`${json}.tmp`, '.']);
  assert.deepEqual(run(() => L.claimWatch(r.two, { cwd: r.repo })), [`${json}.tmp`, '.']);
  assert.deepEqual(run(() => L.setResult(r.two, 'refused', 'no receipt', { cwd: r.repo })), [log, `${json}.tmp`, '.']);
  // A re-open moves the three files aside, then fsyncs the directory.
  assert.deepEqual(run(() => openTwo(r)), ['.', log, `${json}.tmp`, '.', 'last.tmp', '.']);
  const raw = fs.readFileSync(p.manifest, 'utf8');
  const other = path.join(p.dir, 'by-receipt.json');
  R.writeJsonAtomic(other, JSON.parse(raw));
  assert.equal(raw, fs.readFileSync(other, 'utf8'), 'the bytes receipt.writeJsonAtomic writes');
  fs.rmSync(other);
  assert.deepEqual(fs.readdirSync(p.dir).filter((n) => n.includes('.tmp')), [], 'no temp file is left');
  assert.equal(fs.readFileSync(p.last, 'utf8'), `${r.two}\n`);
});

test('set means present and not null: a pushed_at edited by hand to "", 0 or false is pushed in every rule', (t) => {
  const r = makeRepo(t);
  for (const [value, sha] of [['', r.base], [0, r.one], [false, r.two]]) {
    const name = JSON.stringify(value);
    openTwo(r, sha);
    L.setManifest(sha, { push_started_at: '2026-10-22T06:00:00.000Z' }, { cwd: r.repo });
    const file = path.join(r.dir, `${sha}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), pushed_at: value }));
    assert.throws(() => openTwo(r, sha), (err) => err.code === 'SHIP_ALREADY_OK', name);
    assert.deepEqual(prevFiles(r), [], 'nothing moved');
    assert.deepEqual(L.unsettled({ cwd: r.repo, all: true }).filter((e) => e.sha === sha).map((e) => e.state), ['pushed'], name);
    assert.throws(() => L.setResult(sha, 'failed', 'after the push', { cwd: r.repo }), (err) => err.code === 'SHIP_RESULT_AFTER_PUSH', name);
    assert.equal(L.claimWatch(sha, { cwd: r.repo }), 'claimed', name);
    assert.equal(L.setResult(sha, 'ok', 'pushed', { cwd: r.repo }), true, name);
    assert.equal(L.readManifest(sha, { cwd: r.repo }).result.state, 'ok');
  }
});

// A record that pushed, claimed its watch and ended ok: its claim fresh, its
// watch log not yet written.
function settleOk(r, sha) {
  openTwo(r, sha);
  L.setManifest(sha, { pushed_at: '2026-10-22T06:00:00.000Z' }, { cwd: r.repo });
  assert.equal(L.claimWatch(sha, { cwd: r.repo }), 'claimed');
  assert.equal(L.setResult(sha, 'ok', 'pushed', { cwd: r.repo }), true);
}

test('claimWatch claims a watch that died: lines, no result line, no write for an hour, and no claim within the minute', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  const wlog = path.join(r.dir, `${r.two}.watch.log`);
  const stampOf = () => L.readManifest(r.two, { cwd: r.repo }).watch_started_at;
  const claimed = ago(HOUR + 5 * 60_000);
  stampClaim(r, r.two, claimed);
  L.watchLine(r.two, 'start', 'watching', { cwd: r.repo });
  L.watchLine(r.two, 'watch', 'waiting on the deploy', { cwd: r.repo });
  // Its last write inside the hour: started, nothing stamped.
  backdate(wlog, HOUR - 60_000);
  assert.equal(L.claimWatch(r.two, { cwd: r.repo }), 'started');
  assert.equal(stampOf(), claimed);
  // Past the hour: died, claimed again, stamped now.
  backdate(wlog, HOUR + 60_000);
  assert.equal(L.claimWatch(r.two, { cwd: r.repo }), 'claimed');
  const fresh = stampOf();
  assert.ok(Date.now() - Date.parse(fresh) < 60_000);
  // The same dead lines under that fresh claim: the new watch has not written yet; pending, never claimed twice.
  assert.equal(L.claimWatch(r.two, { cwd: r.repo }), 'pending');
  assert.equal(stampOf(), fresh);
  // A stamp that is no time does not hold a died watch.
  stampClaim(r, r.two, 'long ago');
  assert.equal(L.claimWatch(r.two, { cwd: r.repo }), 'claimed');
  // A result line anywhere, a later line after it, the log two hours quiet: started and finished.
  fs.writeFileSync(wlog, `${ago(2 * HOUR)} start watching\n${ago(2 * HOUR)} result no new Sentry events in ten minutes\n${ago(2 * HOUR)} ack read\n`);
  backdate(wlog, 2 * HOUR);
  stampClaim(r, r.two, claimed);
  assert.equal(L.claimWatch(r.two, { cwd: r.repo }), 'started');
  assert.equal(stampOf(), claimed);
});

test('a watch log that cannot be read throws from claimWatch and from unwatched, nothing stamped', (t) => {
  const r = makeRepo(t);
  settleOk(r, r.two);
  const old = ago(5 * 60_000);
  stampClaim(r, r.two, old);
  fs.mkdirSync(path.join(r.dir, `${r.two}.watch.log`));
  assert.throws(() => L.claimWatch(r.two, { cwd: r.repo }), /EISDIR|illegal operation/);
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).watch_started_at, old);
  assert.throws(() => L.unwatched({ cwd: r.repo }), /EISDIR|illegal operation/);
});

test('unwatched lists a settled ok record whose watch never started or died, and not one started, finished or pending', (t) => {
  const r = makeRepo(t);
  const wlog = path.join(r.dir, `${r.two}.watch.log`);
  settleOk(r, r.two);
  // Its fresh claim with no watch log, then an empty one: pending is not unwatched.
  assert.equal(L.claimWatch(r.two, { cwd: r.repo }), 'pending');
  assert.deepEqual(L.unwatched({ cwd: r.repo }), []);
  fs.writeFileSync(wlog, '');
  assert.deepEqual(L.unwatched({ cwd: r.repo }), []);
  // No claim at all (by hand: setResult writes ok only over one): not listed.
  stampClaim(r, r.two, null);
  assert.deepEqual(L.unwatched({ cwd: r.repo }), [], 'no claim');
  // A stale claim with an empty watch log: never started.
  const stale = ago(2 * HOUR);
  stampClaim(r, r.two, stale);
  const list = L.unwatched({ cwd: r.repo });
  assert.deepEqual(list.map((e) => [e.sha, e.state, e.since, e.last_write]), [[r.two, 'never-started', stale, null]]);
  assert.deepEqual([list[0].manifest.sha, list[0].manifest.result.state], [r.two, 'ok']);
  // A start line written a minute ago: started, not listed.
  L.watchLine(r.two, 'start', 'watching', { cwd: r.repo });
  backdate(wlog, 60_000);
  assert.deepEqual(L.unwatched({ cwd: r.repo }), []);
  // The same line with no write for over an hour and no result line: died,
  // with that last write.
  backdate(wlog, HOUR + 60_000);
  const lastWrite = new Date(fs.statSync(wlog).mtimeMs).toISOString();
  assert.deepEqual(L.unwatched({ cwd: r.repo }).map((e) => [e.sha, e.state, e.since, e.last_write]), [[r.two, 'died', stale, lastWrite]]);
  // Re-claimed: the fresh claim over the dead lines is pending, not listed again.
  assert.equal(L.claimWatch(r.two, { cwd: r.repo }), 'claimed');
  assert.deepEqual(L.unwatched({ cwd: r.repo }), []);
  // A result line in the watch log: started and finished, not listed, however old.
  stampClaim(r, r.two, stale);
  fs.appendFileSync(wlog, `${ago(HOUR + 60_000)} result no new Sentry events in ten minutes\n`);
  backdate(wlog, 2 * HOUR);
  assert.deepEqual(L.unwatched({ cwd: r.repo }), []);
});

test('unwatched takes only ok records, a result ok line alone included, oldest claim first; an unreadable manifest is passed over', (t) => {
  const r = makeRepo(t);
  const [three, four, five] = ['c', 'd', 'e'].map((n) => commit(r.repo, `work ${n}`, `server/${n}.js`));
  const wlog = (sha) => path.join(r.dir, `${sha}.watch.log`);
  // Not ok, each with a stale claim and no watch log: failed, ok-no-push, pushed-elsewhere, no result.
  openTwo(r, r.base);
  L.setResult(r.base, 'failed', 'push did not land', { cwd: r.repo });
  openTwo(r, r.one);
  L.setResult(r.one, 'ok-no-push', 'gate passed, nothing pushed', { cwd: r.repo });
  openTwo(r, three);
  L.setResult(three, 'pushed-elsewhere', 'shipped by another window', { cwd: r.repo });
  openTwo(r, four);
  for (const sha of [r.base, r.one, three, four]) stampClaim(r, sha, ago(2 * HOUR));
  assert.deepEqual(L.unwatched({ cwd: r.repo }), []);
  // ok by the manifest's result, and ok by a result ok line alone (a setResult cut short).
  settleOk(r, r.two);
  openTwo(r, five);
  fs.appendFileSync(path.join(r.dir, `${five}.log`), `${new Date().toISOString()} result ok pushed\n`);
  assert.equal(L.readManifest(five, { cwd: r.repo }).result, null);
  // Oldest since first, whatever the directory order.
  for (const [older, newer] of [[r.two, five], [five, r.two]]) {
    stampClaim(r, older, ago(3 * HOUR));
    stampClaim(r, newer, ago(2 * HOUR));
    assert.deepEqual(L.unwatched({ cwd: r.repo }).map((e) => [e.sha, e.state]), [[older, 'never-started'], [newer, 'never-started']]);
  }
  // A died watch under a stamp that is no time sorts as oldest, in either directory order.
  for (const [none, other] of [[five, r.two], [r.two, five]]) {
    fs.writeFileSync(wlog(none), `${ago(2 * HOUR)} start watching\n`);
    backdate(wlog(none), 2 * HOUR);
    stampClaim(r, none, 'long ago');
    fs.rmSync(wlog(other), { force: true });
    const otherAt = ago(10 * HOUR);
    stampClaim(r, other, otherAt);
    assert.deepEqual(L.unwatched({ cwd: r.repo }).map((e) => [e.sha, e.state, e.since]), [[none, 'died', 'long ago'], [other, 'never-started', otherAt]]);
  }
  // An unreadable manifest is passed over, never thrown on.
  fs.writeFileSync(path.join(r.dir, `${r.base}.json`), '{ torn');
  assert.deepEqual(L.unwatched({ cwd: r.repo }).map((e) => e.sha), [r.two, five]);
});

test('setManifest writes no push stamp once a result stands; claimWatch still re-claims a settled ok record', (t) => {
  const r = makeRepo(t);
  // Settled by the manifest's result alone (its log emptied), and by a result line alone.
  settleOk(r, r.two);
  fs.writeFileSync(path.join(r.dir, `${r.two}.log`), '');
  openTwo(r, r.one);
  fs.appendFileSync(path.join(r.dir, `${r.one}.log`), `${new Date().toISOString()} result failed push did not land\n`);
  for (const sha of [r.two, r.one]) {
    const file = path.join(r.dir, `${sha}.json`);
    const before = fs.readFileSync(file, 'utf8');
    for (const key of ['push_started_at', 'pushed_at', 'push_unknown_at', 'pushed_at ']) {
      for (const value of ['2026-10-22T07:00:00.000Z', null]) {
        assert.throws(() => L.setManifest(sha, { [key]: value }, { cwd: r.repo }), (err) => err.code === 'SHIP_STAMP_AFTER_RESULT' && err.message.includes(sha.slice(0, 7)), `${key} ${value}`);
      }
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing written');
  }
  // The re-watch: a stale claim with an empty watch log is claimed again.
  stampClaim(r, r.two, ago(5 * 60_000));
  fs.writeFileSync(path.join(r.dir, `${r.two}.watch.log`), '');
  assert.equal(L.claimWatch(r.two, { cwd: r.repo }), 'claimed');
  assert.ok(Date.now() - Date.parse(L.readManifest(r.two, { cwd: r.repo }).watch_started_at) < 60_000);
  // Every other key still merges: the watch records its result after the ship's.
  assert.equal(L.setManifest(r.two, { watch: { result: 'quiet', count: 0 } }, { cwd: r.repo }).watch.count, 0);
});

test('an ok result needs a watch claim: without one it throws and writes nothing; after claimWatch it is written', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  L.setManifest(r.two, { pushed_at: '2026-10-22T06:00:00.000Z' }, { cwd: r.repo });
  const files = [path.join(r.dir, `${r.two}.log`), path.join(r.dir, `${r.two}.json`)];
  const before = files.map((f) => fs.readFileSync(f, 'utf8'));
  assert.throws(() => L.setResult(r.two, 'ok', 'pushed 2c0ffee, 2 commits', { cwd: r.repo }), (err) => err.code === 'SHIP_OK_NEEDS_CLAIM' && err.message.includes(r.two.slice(0, 7)));
  assert.deepEqual(files.map((f) => fs.readFileSync(f, 'utf8')), before, 'nothing written');
  assert.equal(L.claimWatch(r.two, { cwd: r.repo }), 'claimed');
  assert.equal(L.setResult(r.two, 'ok', 'pushed 2c0ffee, 2 commits', { cwd: r.repo }), true);
  const m = L.readManifest(r.two, { cwd: r.repo });
  assert.equal(m.result.state, 'ok');
  assert.notEqual(m.watch_started_at, null);
});

test('a set watch field is a watch that finished: claimWatch answers started whatever the watch log says, and unwatched passes it over', (t) => {
  const r = makeRepo(t);
  settleOk(r, r.two);
  const wlog = path.join(r.dir, `${r.two}.watch.log`);
  const stale = ago(2 * HOUR);
  // Lines, no result line, no write for two hours, a stale claim: a watch
  // that died, until it records its result through setManifest.
  fs.writeFileSync(wlog, `${stale} start watching\n`);
  backdate(wlog, 2 * HOUR);
  stampClaim(r, r.two, stale);
  assert.deepEqual(L.unwatched({ cwd: r.repo }).map((e) => e.state), ['died']);
  L.setManifest(r.two, { watch: { result: 'quiet', count: 0 } }, { cwd: r.repo });
  assert.deepEqual(L.unwatched({ cwd: r.repo }), []);
  assert.equal(L.claimWatch(r.two, { cwd: r.repo }), 'started');
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).watch_started_at, stale, 'nothing stamped');
  // No watch log at all under the stale claim, the field edited by hand to "": set, so started too.
  fs.rmSync(wlog);
  editManifest(r, r.two, { watch: '' });
  assert.deepEqual(L.unwatched({ cwd: r.repo }), []);
  assert.equal(L.claimWatch(r.two, { cwd: r.repo }), 'started');
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).watch_started_at, stale, 'nothing stamped');
});

test('once a result stands, line writes only an ack: any other stage throws and writes nothing', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  L.line(r.two, 'push', 'pushing', { cwd: r.repo });
  assert.equal(L.setResult(r.two, 'failed', 'push did not land', { cwd: r.repo }), true);
  const files = [path.join(r.dir, `${r.two}.log`), path.join(r.dir, `${r.two}.json`)];
  const before = files.map((f) => fs.readFileSync(f, 'utf8'));
  for (const stage of L.STAGES.filter((s) => s !== 'ack' && s !== 'result')) {
    assert.throws(() => L.line(r.two, stage, 'late', { cwd: r.repo }), (err) => err.code === 'SHIP_LINE_AFTER_RESULT' && err.message.includes(r.two.slice(0, 7)), stage);
  }
  assert.deepEqual(files.map((f) => fs.readFileSync(f, 'utf8')), before, 'nothing written');
  assert.equal(L.line(r.two, 'ack', 'read it', { cwd: r.repo }), true);
  assert.deepEqual(stagesOf(logLines(r, r.two)), ['push', 'result', 'ack']);
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).last_stage, 'ack');
  // A result line alone (a setResult cut short, the manifest's result null): the same.
  openTwo(r, r.one);
  fs.appendFileSync(path.join(r.dir, `${r.one}.log`), `${new Date().toISOString()} result failed push did not land\n`);
  assert.throws(() => L.line(r.one, 'push', 'late', { cwd: r.repo }), (err) => err.code === 'SHIP_LINE_AFTER_RESULT');
  assert.equal(L.line(r.one, 'ack', 'read it', { cwd: r.repo }), true);
  assert.deepEqual(stagesOf(logLines(r, r.one)), ['result', 'ack']);
});

// Spawns `node -e code ...args`; resolves {status, out, err} once it closes.
// Every child is killed in t.after if it is still running, so none outlives
// its test.
function runChild(t, code, args) {
  const child = spawn(process.execPath, ['-e', code, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  return { child, done: new Promise((resolve) => child.on('close', (status) => resolve({ status, out, err }))) };
}

test('claimWatch waits on the per-sha lock another process holds, and claims once after the release', async (t) => {
  const r = makeRepo(t);
  openTwo(r);
  const p = L.shipPaths(r.two, { cwd: r.repo });
  const HOLD_MS = 2000;
  // The child takes the lock the way withLock does ({pid, at, token} in a file
  // created with wx), holds it HOLD_MS past its `at`, then removes it.
  const code = [
    "const fs = require('fs');",
    "const crypto = require('crypto');",
    'const [lock, hold] = process.argv.slice(1);',
    'const at = Date.now();',
    "const fd = fs.openSync(lock, 'wx');",
    "fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date(at).toISOString(), token: crypto.randomBytes(8).toString('hex') }));",
    'fs.closeSync(fd);',
    'for (let left = at + Number(hold) - Date.now(); left > 0; left = at + Number(hold) - Date.now()) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, left);',
    'fs.rmSync(lock);',
  ].join('\n');
  const { child, done } = runChild(t, code, [p.lock, String(HOLD_MS)]);
  const deadline = Date.now() + 10_000;
  let holder = null;
  while (holder === null) {
    try {
      holder = JSON.parse(fs.readFileSync(p.lock, 'utf8'));
    } catch {
      assert.ok(Date.now() < deadline, 'the child never took the lock');
      sleepMs(5);
    }
  }
  assert.equal(holder.pid, child.pid, 'the child holds the lock, alive');
  assert.equal(L.claimWatch(r.two, { cwd: r.repo }), 'claimed');
  const waited = Date.now() - Date.parse(holder.at);
  assert.ok(waited >= HOLD_MS, `the claim returned ${waited} ms after the lock was taken`);
  const exit = await done;
  assert.equal(exit.status, 0, exit.err);
  const stamp = L.readManifest(r.two, { cwd: r.repo }).watch_started_at;
  assert.ok(Date.parse(stamp) >= Date.parse(holder.at) + HOLD_MS, 'stamped after the release');
  assert.equal(L.claimWatch(r.two, { cwd: r.repo }), 'pending', 'claimed once');
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).watch_started_at, stamp);
  assert.equal(fs.existsSync(p.lock), false, 'no lock is left');
});

test('two claimers in two processes on one record: exactly one claimed and one pending', async (t) => {
  const r = makeRepo(t);
  openTwo(r);
  const go = path.join(r.repo, 'go');
  const code = [
    `const L = require(${JSON.stringify(path.join(__dirname, 'shipLog.js'))});`,
    "const fs = require('fs');",
    'const [sha, cwd, go] = process.argv.slice(1);',
    'while (!fs.existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);',
    'process.stdout.write(L.claimWatch(sha, { cwd }));',
  ].join('\n');
  const both = Promise.all([runChild(t, code, [r.two, r.repo, go]).done, runChild(t, code, [r.two, r.repo, go]).done]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.writeFileSync(go, '');
  const answers = await both;
  assert.deepEqual(answers.map((a) => a.status), [0, 0], answers.map((a) => a.err).join('\n'));
  assert.deepEqual(answers.map((a) => a.out).sort(), ['claimed', 'pending']);
  assert.ok(Date.now() - Date.parse(L.readManifest(r.two, { cwd: r.repo }).watch_started_at) < 60_000);
  assert.deepEqual(fs.readdirSync(r.dir).filter((n) => /lock|tmp/.test(n)), [], 'no lock or temp file is left');
});

test('set means present and not null in every other read: an empty push_unknown_at, push_started_at or result edited by hand is set', (t) => {
  const r = makeRepo(t);
  // push_unknown_at "": the ship ended, so it is not in flight, and "" is its since.
  openTwo(r);
  L.setManifest(r.two, { push_started_at: new Date().toISOString() }, { cwd: r.repo });
  L.line(r.two, 'push', 'pushing', { cwd: r.repo });
  assert.equal(L.inFlight({ cwd: r.repo }).sha, r.two);
  editManifest(r, r.two, { push_unknown_at: '' });
  assert.equal(L.inFlight({ cwd: r.repo }), null);
  assert.deepEqual(L.unsettled({ cwd: r.repo }).map((e) => [e.sha, e.state, e.since]), [[r.two, 'unknown', '']]);
  // push_started_at "": open refuses to move the record aside, and unsettled lists it.
  openTwo(r, r.one);
  editManifest(r, r.one, { push_started_at: '' });
  assert.throws(() => openTwo(r, r.one), (err) => err.code === 'SHIP_UNSETTLED');
  assert.deepEqual(prevFiles(r), [], 'nothing moved');
  assert.deepEqual(L.unsettled({ cwd: r.repo, all: true }).filter((e) => e.sha === r.one).map((e) => [e.state, e.since]), [['unknown', '']]);
  // result "": settled. setResult and line write nothing, nothing is in
  // flight, and unsettled passes it over.
  openTwo(r, r.base);
  L.setManifest(r.base, { push_started_at: new Date().toISOString() }, { cwd: r.repo });
  L.line(r.base, 'push', 'pushing', { cwd: r.repo });
  assert.equal(L.inFlight({ cwd: r.repo }).sha, r.base);
  editManifest(r, r.base, { result: '' });
  const logFile = path.join(r.dir, `${r.base}.log`);
  const before = fs.readFileSync(logFile, 'utf8');
  assert.equal(L.setResult(r.base, 'failed', 'push did not land', { cwd: r.repo }), false);
  assert.throws(() => L.line(r.base, 'push', 'late', { cwd: r.repo }), (err) => err.code === 'SHIP_LINE_AFTER_RESULT');
  assert.equal(fs.readFileSync(logFile, 'utf8'), before, 'nothing written');
  assert.equal(L.readManifest(r.base, { cwd: r.repo }).result, '');
  assert.equal(L.inFlight({ cwd: r.repo }), null);
  assert.deepEqual(L.unsettled({ cwd: r.repo, all: true }).map((e) => e.sha).sort(), [r.one, r.two].sort());
  // readLast: a last file holding no full sha is null.
  const lastFile = path.join(r.dir, 'last');
  for (const junk of ['not a sha\n', '', '\n', `${r.two.slice(0, 7)}\n`, `${r.two}x\n`, 'zz'.repeat(20)]) {
    fs.writeFileSync(lastFile, junk);
    assert.equal(L.readLast({ cwd: r.repo }), null, JSON.stringify(junk));
  }
});

test('a watch log that cannot be read for its mode throws EACCES from claimWatch and from unwatched, nothing stamped', { skip: process.getuid && process.getuid() === 0 ? 'root reads a mode-000 file' : false }, (t) => {
  const r = makeRepo(t);
  settleOk(r, r.two);
  const old = ago(5 * 60_000);
  stampClaim(r, r.two, old);
  // Empty, so a read error taken for no log would read as never-started and claim.
  const wlog = path.join(r.dir, `${r.two}.watch.log`);
  fs.writeFileSync(wlog, '');
  fs.chmodSync(wlog, 0o000);
  t.after(() => { if (fs.existsSync(wlog)) fs.chmodSync(wlog, 0o644); });
  assert.throws(() => L.claimWatch(r.two, { cwd: r.repo }), (err) => err.code === 'EACCES');
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).watch_started_at, old);
  assert.throws(() => L.unwatched({ cwd: r.repo }), (err) => err.code === 'EACCES');
  assert.equal(fs.existsSync(path.join(r.dir, `${r.two}.json.lock`)), false, 'the lock is released');
});

test('an fsync that fails at each seam point throws, and the write before it is the one that stands', (t) => {
  const r = makeRepo(t);
  openTwo(r);
  const p = L.shipPaths(r.two, { cwd: r.repo });
  const real = L.fsyncSeam.sync;
  t.after(() => { L.fsyncSeam.sync = real; });
  const boom = Object.assign(new Error('injected fsync failure'), { code: 'EIO' });
  const failOn = (hit) => {
    L.fsyncSeam.sync = (fd, target) => {
      if (hit(target)) throw boom;
      return real(fd, target);
    };
  };
  const isBoom = (err) => err === boom;
  const stampOf = () => L.readManifest(r.two, { cwd: r.repo }).watch_started_at;
  // The temp file's fsync fails: the manifest is unchanged and the temp file is left.
  const before = fs.readFileSync(p.manifest, 'utf8');
  failOn((target) => target.startsWith(`${p.manifest}.tmp-`));
  assert.throws(() => L.claimWatch(r.two, { cwd: r.repo }), isBoom);
  L.fsyncSeam.sync = real;
  assert.equal(fs.readFileSync(p.manifest, 'utf8'), before, 'the target is unchanged');
  assert.equal(fs.readdirSync(p.dir).filter((n) => n.startsWith(`${r.two}.json.tmp-`)).length, 1, 'a temp file is left');
  assert.equal(stampOf(), null, 'no claim stands');
  assert.equal(fs.existsSync(p.lock), false, 'the lock is released');
  // The directory's fsync after the rename fails: the new manifest is on
  // disk, so the claim's stamp landed, and a retry answers pending.
  failOn((target) => target === p.dir);
  assert.throws(() => L.claimWatch(r.two, { cwd: r.repo }), isBoom);
  L.fsyncSeam.sync = real;
  assert.ok(Date.now() - Date.parse(stampOf()) < 60_000, 'the stamp landed');
  assert.equal(L.claimWatch(r.two, { cwd: r.repo }), 'pending');
  // The fsync after a log append fails: the result line is in the log, the
  // manifest's result is null, and a second setResult returns false.
  failOn((target) => target === p.log);
  assert.throws(() => L.setResult(r.two, 'failed', 'push did not land', { cwd: r.repo }), isBoom);
  L.fsyncSeam.sync = real;
  assert.match(logLines(r, r.two).at(-1), / result failed push did not land$/);
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).result, null);
  assert.equal(L.setResult(r.two, 'refused', 'a retry', { cwd: r.repo }), false);
  assert.equal(L.readManifest(r.two, { cwd: r.repo }).result, null);
  assert.deepEqual(stagesOf(logLines(r, r.two)), ['result']);
});

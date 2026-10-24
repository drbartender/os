'use strict';

// shipFlow: the ship flow, the leaf scripts/ship.js runs under the ship lock
// (instruction rewrite step 3, lane ship; spec 2026-10-19 sections 4.1 to
// 4.5 and 4.8; plan 2026-10-22 decisions 6, 8, 9, 10, 12, 16 and 18). The
// flow's order and its endings are the plan's ship.js contract as amended
// (docs/superpowers/plans/2026-10-22-instruction-rewrite-step3.md,
// "Contracts shared across lanes" and "Amendments (as built)"); this header
// says what the module guarantees and never restates them. ship.js holds the
// CLI, the lock and the detached start; this file requires only scripts/lib
// modules and never ship.js.
//
// shipFlow({cwd, noPush, log, lockFd}) runs the flow from the flip check on
// for a caller that holds the ship lock (ship.js under flockExec.underLock,
// or the switch-over step's merge script under DRB_SHIP_LOCK); it takes no
// lock itself. lockFd is the descriptor in this process that carries the
// lock, the one underLock resolves (flock's, or a caller's that ship
// inherited, as a caller running ship under flock(1) passes it down), or
// null when only an ancestor's descriptor carries it (a Node caller holding
// the lock hands its children none). It resolves {state, text, code}: code
// 0 for ok, ok-no-push and pushed-elsewhere, 1 for refused and failed, 2
// when a push's outcome is unknown. It rejects only when the ending itself
// could not be recorded.
//
// What it guarantees:
//   - A push is the literal sha to refs/heads/main through the pre-push hook:
//     never --no-verify, never forced, never after a pull or a rebase, and a
//     rejection stops and reports. It happens only after the review receipts
//     over origin/main..HEAD hold (rangeCheck.checkRange), the sha gate passed
//     (push-gate.js sha beside ship.js, always run) and left a receipt that
//     shaGate.checkShaReceipt accepts as the hook will, and no marker stands
//     right before the push stamp.
//   - pushed_at is stamped only on proof that the sha landed (a push that
//     exited 0, or a fetch that finds it on origin/main) and push_started_at
//     right before the push, so a record whose run died is completed by the
//     next run from that evidence. A stop signal stops the running child
//     (its process group) and waits for it before the run ends. A kill -9
//     waits for nothing, so the push and the gate are each handed lockFd as
//     their fd 3: the ship lock outlives a hard-killed run until that child
//     ends, and the next ship waits for it, so an orphaned push cannot land
//     after the next run's fetch and an orphaned gate never meets the next
//     one at the push-gate lock. The fetches and the watch never get it (the
//     watch is detached by design and must not hold the lock). A stop that
//     lands any time before the push stamp, the gate's exit and the
//     synchronous checks after it included, ends the run failed with no
//     stamp and no push.
//   - Every outcome is recorded through shipLog, on HEAD's record or on the
//     earlier unsettled record it completes; a text there is a descriptor
//     (sha7, counts, stage words), never a full sha and never a line of git
//     or suite output, which passes through to this process's own stdout and
//     stderr only. A gate that passed with stubs in place (the sha receipt's
//     stubbed list, accepted only under DRB_GATE_ALLOW_STUBBED=1) is named in
//     the gate stage line and in the ok and ok-no-push results.
//   - A clean revert (rangeCheck.revertProof, the proof the range check
//     recomputes) gets a revert receipt under its commit key with every field
//     finalize writes, written_by ship; ship writes no other receipt. Only
//     the commit key decides whether one is owed (a tree is shared by every
//     commit that has it), and a revert receipt there whose tip is another
//     commit (a patch-id twin's) is replaced unless that twin is still inside
//     origin/main..HEAD, where a push of this main needs it (then it stands
//     and the clash is named, and so it does when git cannot place it).
//
// Test overrides, each named in one stderr line when set: DRB_SHIP_GATE_CMD
// (run as <cmd> sha <full sha> in place of push-gate.js; it must write the
// sha receipt), DRB_SHIP_WATCH_CMD (run as <cmd> <full sha> in place of
// post-ship-watch.js), DRB_SHIP_GIT_CMD (run in place of git for the push
// and the fetches only, with git's argv) and DRB_SHIP_FETCH_WINDOW_MS (the
// fetch window after a push that exited non-zero without a rejection; ten
// seconds by default). The three command overrides take effect only with
// DRB_SHIP_ALLOW_STUBS=1 as well: set without it, any of them refuses the
// run before anything is written (precheck first, then the flow's own first
// check, the one that counts for a caller of shipFlow), and a stubbed run's
// start line names the overrides in effect, so its record says so.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const R = require('./receipt');
const M = require('./markers');
const L = require('./shipLog');
const GP = require('./gatePaths');
const SG = require('./shaGate');
const RC = require('./rangeCheck');
const { mask } = require('./piiShapes');

// The directory holding ship.js, push-gate.js and post-ship-watch.js.
const SCRIPTS = path.resolve(__dirname, '..');
const S = R.short;
const CUE_ONLY = 'ship: no flip marker; pushes stay cue-only through npm run gate';
const STOP_SIGNALS = Object.freeze(['SIGTERM', 'SIGINT', 'SIGHUP']);
const PUSH_BOUND_MS = 10 * 60 * 1000;
const FETCH_BOUND_MS = 2 * 60 * 1000;
const FETCH_WINDOW_MS = 10 * 1000;
const KILL_GRACE_MS = 10 * 1000;
// push-gate.js sha stops its own children and removes its worktree on a stop
// signal; it gets longer before the SIGKILL that would cut that cleanup.
const GATE_GRACE_MS = 30 * 1000;
const OUT_CAP = 64 * 1024;
const REJECTED = /\[rejected\][^\n]*\((fetch first|non-fast-forward)\)/;
const REVERT_LINE = /^This reverts commit /m;
const RESULT_LINE = /^\S+ result (\S+)(?: (.*))?$/;
const EXIT = new Map([['ok', 0], ['ok-no-push', 0], ['pushed-elsewhere', 0], ['refused', 1], ['failed', 1], ['unknown', 2]]);
const OPEN_THROWS = new Map([
  ['SHIP_ALREADY_OK', 'origin/main no longer holds a sha this box pushed, which only a rewrite of origin does'],
  ['SHIP_PUSHED_ELSEWHERE', 'a record that found it on origin/main stands (a bug: this run fetched and it is not there)'],
  ['SHIP_UNSETTLED', 'its earlier push has no result (a bug: the completion pass settles that first)'],
]);
// The command overrides, which run only under DRB_SHIP_ALLOW_STUBS=1.
const STUBS = Object.freeze(['DRB_SHIP_GATE_CMD', 'DRB_SHIP_WATCH_CMD', 'DRB_SHIP_GIT_CMD']);
const OVERRIDES = Object.freeze([
  ['DRB_SHIP_GATE_CMD', 'it runs in place of push-gate.js sha'],
  ['DRB_SHIP_WATCH_CMD', 'it runs in place of post-ship-watch.js'],
  ['DRB_SHIP_GIT_CMD', 'it runs in place of git for the push and the fetches'],
  ['DRB_SHIP_FETCH_WINDOW_MS', 'it sets the fetch window after a push that exited non-zero'],
]);

const isSet = (v) => v !== null && v !== undefined;
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const turn = () => new Promise((resolve) => setImmediate(resolve));
const envValue = (k) => (typeof process.env[k] === 'string' && process.env[k] !== '' ? process.env[k] : null);
const stubsAllowed = () => process.env.DRB_SHIP_ALLOW_STUBS === '1';
// A command override's value, only under DRB_SHIP_ALLOW_STUBS=1.
const stubValue = (k) => (stubsAllowed() ? envValue(k) : null);
const overrideValue = (k) => (STUBS.includes(k) ? stubValue(k) : envValue(k));

// One refusal line per command override set without DRB_SHIP_ALLOW_STUBS=1.
function stubRefusals() {
  if (stubsAllowed()) return [];
  return STUBS.filter((k) => envValue(k) !== null).map((k) => `ship: ${k} is set; the test overrides run only with DRB_SHIP_ALLOW_STUBS=1, never in a real ship`);
}

// The receipt.json in a receipt directory: null when there is none,
// {unreadable: true} when it is not a version 1 receipt object, else the
// object (receipt.readReceipt's reading, without its throw).
function keyReceipt(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, 'receipt.json'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) return { unreadable: true };
    throw err;
  }
  return rec && typeof rec === 'object' && !Array.isArray(rec) && rec.version === 1 ? rec : { unreadable: true };
}
const say = (out, text) => out(`ship: ${String(text).replace(/^ship: /, '')}`);

function fetchWindowMs() {
  const v = envValue('DRB_SHIP_FETCH_WINDOW_MS');
  return v && /^[0-9]+$/.test(v) && Number(v) > 0 ? Number(v) : FETCH_WINDOW_MS;
}

function git(args, cwd) {
  return spawnSync('git', args, { cwd, env: R.gitEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitOut(args, cwd) {
  const r = git(args, cwd);
  if (r.error || r.status !== 0) throw new Error(`git ${args[0] === '-c' ? args[2] : args[0]} failed (${r.error ? r.error.code : `exit ${r.status}`})`);
  return r.stdout;
}

function resolveOrNull(ref, cwd) {
  const r = git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], cwd);
  const out = r.status === 0 ? r.stdout.trim() : '';
  return R.KEY_RE.test(out) ? out : null;
}

function describe(r) {
  if (r.error) return `could not start: ${r.error.code || 'error'}`;
  if (r.timedOut) return 'cut at its bound';
  if (r.signal) return `killed by ${r.signal}`;
  return `exit ${r.status}`;
}

function killGroup(pid, sig) {
  try {
    process.kill(-pid, sig);
  } catch (err) {
    if (err.code !== 'ESRCH') throw err; // the group is gone already
  }
}

// The result standing on a record, {state, text}, or null: the manifest's,
// else a result line anywhere in its log (a setResult cut short).
function standingResult(sha, cwd) {
  const m = L.readManifest(sha, { cwd });
  if (!m) return null;
  if (isSet(m.result) && typeof m.result === 'object') return { state: m.result.state, text: m.result.text };
  for (const line of L.tail(sha, Number.MAX_SAFE_INTEGER, { cwd })) {
    const hit = RESULT_LINE.exec(line);
    if (hit) return { state: hit[1], text: hit[2] || '' };
  }
  return null;
}

// [{sha, parents, subject, body}] of base..tip, oldest first.
function rangeCommits(base, tip, cwd) {
  const out = gitOut(['rev-list', '--reverse', '--topo-order', '--parents', '--end-of-options', `${base}..${tip}`, '--'], cwd);
  return out.split('\n').filter(Boolean).map((l) => {
    const [sha, ...parents] = l.trim().split(/\s+/);
    const msg = gitOut(['-c', 'i18n.logOutputEncoding=UTF-8', 'log', '-1', '--no-show-signature', '--format=%s%x00%B', '--end-of-options', sha, '--'], cwd);
    const at = msg.indexOf('\0');
    return { sha, parents, subject: at < 0 ? msg.trim() : msg.slice(0, at).trim(), body: at < 0 ? msg : msg.slice(at + 1) };
  });
}

// git merge-base --is-ancestor as true or false, or null when git could not
// answer (it exits 0 or 1 only when it did).
function ancestry(a, b, cwd) {
  const r = git(['merge-base', '--is-ancestor', '--end-of-options', a, b], cwd);
  if (r.error) return null;
  return r.status === 0 ? true : r.status === 1 ? false : null;
}

// The stubs an accepted sha receipt records, and the note a result carries
// for them (nothing when there are none).
const gateStubs = (rec) => (rec && !rec.unreadable && Array.isArray(rec.stubbed) ? rec.stubbed.filter((s) => typeof s === 'string') : []);
const stubNote = (stubs) => (stubs.length ? `; gate stubbed: ${stubs.join(', ')}` : '');

// A revert receipt with every field finalize's buildReceipt writes
// (receiptFinalize.js), empty, false or null where a review would fill it.
function revertReceipt({ key, commit, parent, reverted }) {
  const at = now();
  return {
    version: 1, state: 'final', key, kind: 'revert', name: null, mode: null, branch: null,
    tip: commit, reviewed_against: null, base: parent, stale_base: false, tier: null, tiers_by_file: {},
    matched_paths: [], content_rule_hits: [], lenses: [], unforecast_lenses: [],
    coverage: { files_in_diff: [], files_with_verdicts: [], not_reached: [], allowed_not_reached: false },
    tests: [], tests_superseded: [], failing_test_on_old_code: null, not_a_fix: null, externals: {},
    verify: { run: false, findings: 0, raised: 0, confirmed: 0, fixed: 0, rejected: 0, passes: [] },
    escalated: [], triage: {}, reports: [], proof: null, created_at: at, timestamp: at, written_by: 'ship', reverted,
  };
}

// {primary, head} when cwd is in the primary worktree (its top is the
// directory holding the common dir) with HEAD on main, else {refusal}.
function primaryOnMain(cwd) {
  const top = git(['rev-parse', '--show-toplevel'], cwd);
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (top.status !== 0 || common.status !== 0) return { refusal: `ship: ${M.clean(cwd)} is not inside a git checkout` };
  const primary = top.stdout.trim();
  if (fs.realpathSync(primary) !== fs.realpathSync(path.dirname(common.stdout.trim()))) {
    return { refusal: 'ship: this is not the primary worktree (a lane or a gate worktree); ship runs from the os checkout on main' };
  }
  const branch = git(['symbolic-ref', '--quiet', 'HEAD'], primary);
  const name = branch.status === 0 ? branch.stdout.trim() : null;
  if (name !== 'refs/heads/main') return { refusal: `ship: HEAD is ${name ? `on ${M.clean(name)}` : 'detached'}, not on main; ship ships main only` };
  return { primary, head: R.resolveCommit('HEAD', { cwd: primary }) };
}

// What can be refused without the lock and with nothing written: a test
// override set without its allow variable, the flip state, then the primary
// worktree on main.
function precheck(cwd) {
  const stubs = stubRefusals();
  if (stubs.length) return { refusal: stubs.join('\n') };
  if (git(['rev-parse', '--show-toplevel'], cwd).status !== 0) return { refusal: `ship: ${M.clean(cwd)} is not inside a git checkout` };
  const flip = M.flipState({ cwd });
  if (flip.state === 'absent') return { refusal: CUE_ONLY };
  if (flip.state === 'unreadable') return { refusal: M.standing({ cwd }).flip };
  return primaryOnMain(cwd);
}

// ---- one run ---------------------------------------------------------------------

class Run {
  constructor({ cwd, noPush, log, lockFd }) {
    Object.assign(this, { cwd, noPush: noPush === true, log, primary: null, sha: null, origin: null });
    this.lockFd = Number.isInteger(lockFd) && lockFd > 2 ? lockFd : null;
    this.opened = null; // the sha of the record this run opened
    this.completing = null; // the sha of an earlier record being completed
    this.child = null;
    this.stopping = null;
    this.gateStubs = [];
    this.gitCmd = stubValue('DRB_SHIP_GIT_CMD') || 'git';
    this.gitEnv = { ...R.gitEnv(), GIT_TERMINAL_PROMPT: '0' };
  }

  get o() {
    return { cwd: this.primary };
  }

  say(text) {
    say(this.log, text);
  }

  stage(name, text) {
    L.line(this.sha, name, text, this.o);
    this.say(`${name} ${M.clean(text)}`);
  }

  result(state, text) {
    return { state, text: String(text), code: EXIT.has(state) ? EXIT.get(state) : 1 };
  }

  // The start line: the sha, a dry run, and the command overrides in effect
  // (names only), so a stubbed run's record says it was stubbed.
  startText() {
    const stubbed = STUBS.filter((k) => stubValue(k) !== null);
    return `ship ${S(this.sha)} on main${this.noPush ? ', a dry run (--no-push)' : ''}${stubbed.length ? `; test overrides in effect: ${stubbed.join(', ')}` : ''}`;
  }

  // Where a patch-id twin's tip stands for this run: 'in-range' (on HEAD and
  // not on origin/main, so a push of this main still needs its receipt),
  // 'free' (on origin/main, not on HEAD, rewritten away, or gone on a clean
  // miss), or 'unknown' (git failed to answer).
  placeTwin(tip) {
    let full;
    try {
      full = M.resolveStrict(String(tip), this.primary);
    } catch (err) {
      if (!err || err.status === undefined) throw err; // not a resolve failure
      // markers' clean-miss rule, the one placement trusts: gone only when git
      // said no such commit and every pack it reads from is readable.
      return M.cleanMiss(err, { cwd: this.primary }) ? 'free' : 'unknown';
    }
    const shipped = ancestry(full, this.origin, this.primary);
    if (shipped !== false) return shipped === true ? 'free' : 'unknown';
    const onHead = ancestry(full, this.sha, this.primary);
    if (onHead === null) return 'unknown';
    return onHead ? 'in-range' : 'free';
  }

  // The result on the record this run opened; one that already stands wins.
  settle(state, text) {
    if (L.setResult(this.sha, state, text, this.o)) return this.result(state, M.clean(text));
    const st = standingResult(this.sha, this.primary);
    return st ? this.result(st.state, st.text) : this.result(state, text);
  }

  refuse(line) {
    this.log(line);
    return this.settle('refused', line);
  }

  // ---- stops and children ----------------------------------------------------------

  // A stop signal stops the running child and is acted on at the flow's next
  // checkpoint, so what the child's ending proves (a push that exited 0, a
  // rejection) is recorded first and the flow is the only writer.
  listen() {
    this.onStop = (sig) => {
      if (this.stopping) return;
      this.stopping = sig;
      process.stderr.write(`ship: ${sig} received; stopping the running step\n`);
      this.stopChild();
    };
    for (const sig of STOP_SIGNALS) process.on(sig, this.onStop);
  }

  unlisten() {
    for (const sig of STOP_SIGNALS) process.off(sig, this.onStop);
  }

  checkpoint() {
    if (!this.stopping) return;
    const err = new Error(`killed by ${this.stopping}`);
    err.code = 'SHIP_STOPPED';
    err.signal = this.stopping;
    throw err;
  }

  // One child as the leader of a process group of its own, resolving with
  // how it ended. tee: its output passes through to ours and is kept (the
  // last OUT_CAP characters) for the push's bracketed reason. lock: the ship
  // lock's descriptor goes with it as fd 3 (Node hands a child no inherited
  // descriptor of its own accord).
  run(cmd, args, { env = this.gitEnv, timeoutMs = 0, graceMs = KILL_GRACE_MS, tee = false, lock = false } = {}) {
    return new Promise((resolve) => {
      const io = tee ? 'pipe' : 'inherit';
      const held = lock && this.lockFd !== null ? [this.lockFd] : [];
      const child = spawn(cmd, args, { cwd: this.primary, env, detached: true, stdio: ['ignore', io, io, ...held] });
      const c = { child, graceMs, out: '', timedOut: false, timer: null, kill: null, stopping: false };
      this.child = c;
      if (tee) {
        for (const [stream, to] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
          stream.on('data', (b) => {
            to.write(b);
            c.out = (c.out + b.toString('utf8')).slice(-OUT_CAP);
          });
        }
      }
      if (timeoutMs > 0) {
        c.timer = setTimeout(() => {
          c.timedOut = true;
          this.stopChild();
        }, timeoutMs);
      }
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(c.timer);
        clearTimeout(c.kill);
        if (this.child === c) this.child = null;
        resolve({ ...v, timedOut: c.timedOut, out: c.out });
      };
      child.on('error', (error) => done({ status: null, signal: null, error }));
      child.on('close', (status, signal) => done({ status, signal, error: null }));
    });
  }

  // SIGTERM to the running child's group, SIGKILL after its grace.
  stopChild() {
    const c = this.child;
    if (!c || c.stopping || !c.child.pid) return;
    c.stopping = true;
    killGroup(c.child.pid, 'SIGTERM');
    c.kill = setTimeout(() => killGroup(c.child.pid, 'SIGKILL'), c.graceMs);
  }

  // The watch, detached, its output appended to <sha>.watch.stdio.log;
  // resolves {ok: true} once it spawned, {ok: false, code} when it could not.
  spawnWatch(sha) {
    const cmd = stubValue('DRB_SHIP_WATCH_CMD');
    const dir = path.dirname(L.shipPaths(sha, this.o).log);
    fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(path.join(dir, `${sha}.watch.stdio.log`), 'a');
    let child;
    try {
      child = cmd
        ? spawn(cmd, [sha], { cwd: this.primary, detached: true, stdio: ['ignore', fd, fd] })
        : spawn(process.execPath, [path.join(SCRIPTS, 'post-ship-watch.js'), sha], { cwd: this.primary, detached: true, stdio: ['ignore', fd, fd] });
    } finally {
      fs.closeSync(fd);
    }
    return new Promise((resolve) => {
      child.once('spawn', () => {
        child.unref();
        resolve({ ok: true });
      });
      child.once('error', (err) => resolve({ ok: false, code: err.code || 'error' }));
    });
  }

  async fetch() {
    const r = await this.run(this.gitCmd, ['fetch', '--quiet', 'origin', 'main'], { timeoutMs: FETCH_BOUND_MS });
    this.checkpoint();
    return r.status === 0 && !r.timedOut;
  }

  // ---- the flow ----------------------------------------------------------------------

  async flow() {
    const stubs = stubRefusals();
    if (stubs.length) {
      for (const line of stubs) this.log(line);
      return this.result('refused', stubs[0]);
    }
    for (const [k, what] of OVERRIDES) if (overrideValue(k)) process.stderr.write(`ship: ${k}=${M.clean(overrideValue(k))} is set; ${what}\n`);
    const flip = M.flipState({ cwd: this.cwd });
    if (flip.state !== 'present') return this.result('refused', flip.state === 'absent' ? CUE_ONLY : M.standing({ cwd: this.cwd }).flip);
    const where = primaryOnMain(this.cwd);
    if (where.refusal) return this.result('refused', where.refusal);
    this.primary = where.primary;
    this.sha = where.head;
    if (!(await this.fetch())) return this.fetchFailed();
    this.origin = R.resolveCommit('refs/remotes/origin/main', this.o);
    const open = L.unsettled({ cwd: this.primary, all: true });
    const bad = open.find((e) => e.unreadable);
    if (bad) return this.result('refused', `unreadable ship record ${S(bad.sha)}; fix or move it`);
    if (this.noPush && open.length) return this.result('unknown', 'an earlier push\'s outcome is unsettled; run npm run ship to complete it');
    for (const e of open) {
      const r = await this.complete(e);
      if (r) return r;
    }
    if (!this.noPush) for (const e of L.unwatched(this.o)) await this.rewatch(e);
    return this.head();
  }

  // The opening fetch failed: nothing is moved aside.
  fetchFailed() {
    const s7 = S(this.sha);
    if (L.unsettled({ cwd: this.primary, all: true }).length) {
      return this.result('unknown', 'git fetch origin main failed while an earlier push is unsettled; nothing was written; run npm run ship again');
    }
    if (!L.readManifest(this.sha, this.o)) {
      const refused = this.openHead({ base: resolveOrNull('refs/remotes/origin/main', this.primary) });
      if (refused) return refused;
      this.stage('start', this.startText());
      this.stage('fetch', 'git fetch origin main failed');
      return this.settle('failed', 'fetch failed');
    }
    const st = standingResult(this.sha, this.primary);
    const at = st ? st.state : 'no result';
    if (st && (st.state === 'ok' || st.state === 'pushed-elsewhere')) {
      return this.result(st.state, `git fetch origin main failed; ${s7} already shipped (its record stands at ${at}; nothing written)`);
    }
    return this.result('failed', `git fetch origin main failed; the record of ${s7} stands at ${at}; nothing written`);
  }

  // An earlier push with no result, completed by its evidence.
  async complete(e) {
    const sha = e.sha;
    const s7 = S(sha);
    this.completing = sha;
    if (e.state !== 'pushed') {
      if (!R.isAncestor(sha, this.origin, this.o)) {
        L.setResult(sha, 'failed', 'push did not land', this.o);
        this.say(`completed ${s7}: its push did not land`);
        this.completing = null;
        return null;
      }
      L.setManifest(sha, { pushed_at: now() }, this.o);
    }
    const word = L.claimWatch(sha, this.o);
    if (word === 'pending') {
      const text = `watch claim pending for ${s7}; run npm run ship again in a minute`;
      L.line(sha, 'watch', text, this.o);
      return this.result('unknown', text);
    }
    if (word === 'claimed') {
      const s = await this.spawnWatch(sha);
      // A stop received while completing leaves the record unsettled.
      this.checkpoint();
      if (!s.ok) throw new Error(`the watch for ${s7} could not start (${s.code})`);
      L.line(sha, 'watch', `watch started for ${s7}`, this.o);
    }
    const n = Array.isArray(e.manifest.commits) ? e.manifest.commits.length : 0;
    // The gate this record's run passed is its sha receipt's: name its stubs.
    const stubs = stubNote(gateStubs(SG.readShaReceipt(sha, this.o)));
    L.setResult(sha, 'ok', `pushed ${s7}, ${n} commits; completed by a later run${stubs}`, this.o);
    this.say(`completed ${s7}: ok`);
    this.completing = null;
    return null;
  }

  // A settled ok record whose watch never started or died: watched again,
  // nothing written to its ship log or watch log.
  async rewatch(e) {
    if (L.claimWatch(e.sha, this.o) !== 'claimed') return;
    const s = await this.spawnWatch(e.sha);
    this.say(s.ok
      ? `re-watching ${S(e.sha)} (its watch ${e.state === 'died' ? 'died' : 'never started'})`
      : `the re-watch of ${S(e.sha)} could not start (${s.code}); its claim goes stale in a minute and a later run tries again`);
    this.checkpoint();
  }

  openHead(fields) {
    try {
      L.open(this.sha, { cwd: this.primary, ...fields });
    } catch (err) {
      if (!err || !OPEN_THROWS.has(err.code)) throw err;
      const line = `ship: the record of ${S(this.sha)} cannot be opened (${err.code}): ${OPEN_THROWS.get(err.code)}`;
      this.log(line);
      return this.result('refused', line);
    }
    this.opened = this.sha;
    return null;
  }

  // HEAD found on origin/main: shipped by another push.
  elsewhere() {
    const s7 = S(this.sha);
    const st = standingResult(this.sha, this.primary);
    if (st) return this.result('pushed-elsewhere', `${s7} is already on origin/main (its record stands at ${st.state}; nothing written)`);
    const refused = this.openHead({ base: this.origin });
    if (refused) return refused;
    this.stage('start', this.startText());
    this.stage('fetch', `origin/main at ${S(this.origin)} already holds ${s7}`);
    return this.settle('pushed-elsewhere', `${s7} is already on origin/main; another push carried it`);
  }

  async head() {
    const s7 = S(this.sha);
    if (R.isAncestor(this.sha, this.origin, this.o)) return this.elsewhere();
    const t = GP.touches(this.origin, this.sha, this.o);
    const commits = rangeCommits(this.origin, this.sha, this.primary);
    const refused = this.openHead({
      base: this.origin, commits: commits.map((c) => ({ sha: c.sha, subject: mask(c.subject) })),
      docs_only: t.docs_only, touches_server: t.server, touches_client: t.client, offOrigin: true,
    });
    if (refused) return refused;
    this.stage('start', this.startText());
    this.stage('fetch', `origin/main at ${S(this.origin)}`);
    this.stage('range', `${commits.length} commits: ${commits.map((c) => `${S(c.sha)} ${mask(c.subject)}`).join('; ')}`);
    const before = this.markers();
    if (before) return before;
    this.reverts(commits);
    const held = this.receipts() || (await this.gate()) || this.recheck();
    if (held) return held;
    if (this.noPush) return this.settle('ok-no-push', `dry run of ${s7}, ${commits.length} commits: gated, not pushed and not watched${stubNote(this.gateStubs)}`);
    return this.push(commits.length);
  }

  markers() {
    const st = M.standing(this.o);
    if (st.gate && !M.isFixForward(this.sha, { cwd: this.primary, self: true })) return this.refuse(st.gate);
    if (st.watch) return this.refuse(st.watch);
    if (st.flip) return this.refuse(st.flip);
    if (st.gate) this.stage('gate', `a gate marker stands and ${S(this.sha)} fixes it forward; the gate runs, and only a pass that re-runs what it names clears it`);
    return null;
  }

  // A revert receipt for every commit of the range whose message reverts a
  // commit and that needs one, when revertProof holds. Only the commit key
  // decides: a receipt under the commit's tree may be another commit's. A
  // receipt under the key stands when it is a review's (any kind but
  // revert), unreadable (the range check names it), or a revert receipt with
  // no tip or with this commit's; one whose tip is another commit is a
  // patch-id twin's, replaced unless the twin is still inside
  // origin/main..HEAD (its own push needs it: left, the clash named) or git
  // cannot place it (left, failing closed).
  reverts(commits) {
    for (const c of commits) {
      if (c.parents.length !== 1 || !REVERT_LINE.test(c.body)) continue;
      const t = GP.touches(c.parents[0], c.sha, this.o);
      if (t.docs_only || t.files.length === 0) continue; // needs no receipt, or has no key
      const key = R.commitKey(c.sha, this.o);
      const dir = R.receiptDir(key, this.o);
      const held = keyReceipt(dir);
      const twin = held && !held.unreadable && held.kind === 'revert' && isSet(held.tip) && held.tip !== c.sha ? String(held.tip) : null;
      if (held && twin === null) continue;
      const s7 = S(c.sha);
      const where = twin === null ? null : this.placeTwin(twin);
      if (where === 'in-range') {
        this.stage('revert', `no revert receipt for ${s7}: its commit key holds the revert receipt of ${S(twin)}, the same patch, which has not shipped`);
        continue;
      }
      if (where === 'unknown') {
        this.stage('revert', `no revert receipt for ${s7}: git could not place ${S(twin)}, whose revert receipt holds the same commit key; it is left`);
        continue;
      }
      const proof = RC.revertProof(c.sha, this.o);
      if (!proof.ok) {
        const first = proof.problems[0] || 'the proof did not hold';
        this.stage('revert', `no revert receipt for ${s7}: ${first.startsWith(`${s7}: `) ? first.slice(s7.length + 2) : first}`);
        continue;
      }
      R.writeReceipt(dir, revertReceipt({ key, commit: c.sha, parent: c.parents[0], reverted: proof.reverted }));
      this.stage('revert', twin === null
        ? `revert receipt written for ${s7}, reverting ${S(proof.reverted)}`
        : `revert receipt for ${s7} replaces the one ${S(twin)} held under the same patch`);
    }
  }

  receipts() {
    const rc = RC.checkRange({ base: this.origin, tip: this.sha, cwd: this.primary });
    const n = rc.commits.length;
    if (rc.ok) {
      const docs = rc.commits.filter((c) => c.docs_only).length;
      this.stage('receipts', `${n} commits: ${docs} docs-only, ${n - docs} with a receipt`);
      return null;
    }
    this.stage('receipts', `${rc.problems.length} problems over ${n} commits; refused`);
    for (const p of rc.problems) this.log(`  - ${p}`);
    return this.settle('refused', rc.problems[0]);
  }

  // The sha gate, always run; its receipt is then checked as the hook will.
  async gate() {
    const { sha } = this;
    const s7 = S(sha);
    const cmd = stubValue('DRB_SHIP_GATE_CMD');
    const began = Date.now();
    this.stage('gate', `${cmd ? 'DRB_SHIP_GATE_CMD' : 'push-gate.js sha'} on ${s7}`);
    const r = await this.run(cmd || process.execPath, [...(cmd ? [] : [path.join(SCRIPTS, 'push-gate.js')]), 'sha', sha], { env: R.gitEnv(), graceMs: GATE_GRACE_MS, lock: true });
    this.checkpoint();
    const rec = SG.readShaReceipt(sha, this.o);
    const field = (result) => ({ receipt: rec ? SG.receiptPath(sha, this.o) : null, result });
    if (r.error || r.status !== 0) {
      L.setManifest(sha, { gate: field('failed') }, this.o);
      let text = `gate failed at ${s7} (${describe(r)})`;
      if (rec && !rec.unreadable && M.isZonedTime(rec.started_at) && Date.parse(rec.started_at) >= began) {
        const passed = Array.isArray(rec.gates_passed) ? rec.gates_passed : [];
        const missing = (Array.isArray(rec.gates_needed) ? rec.gates_needed : []).filter((g) => !passed.includes(g));
        if (missing.length) text += `; not passed: ${missing.join(', ')}`;
        if (rec.static_checks && rec.static_checks.blocking > 0) text += `; ${rec.static_checks.blocking} blocking static finding(s)`;
      }
      return this.settle('failed', text);
    }
    const { needed } = SG.classifyRange(this.origin, sha, this.o);
    const why = SG.checkShaReceipt(rec, { sha, base: this.origin, needed, stubbedOk: process.env.DRB_GATE_ALLOW_STUBBED === '1' });
    L.setManifest(sha, { gate: field(why ? 'failed' : 'ok') }, this.o);
    if (why) return this.settle('failed', `the gate exited 0 at ${s7}, but the hook would refuse its receipt: ${why}`);
    this.gateStubs = gateStubs(rec);
    const stubs = this.gateStubs.length ? `; stubbed: ${this.gateStubs.join(', ')}` : '';
    this.stage('gate', `passed at ${s7} (${needed.length ? needed.join(' + ') : 'nothing to run'})${stubs}`);
    return null;
  }

  // The markers once more, right before the push stamp: a watch that ended
  // while the gate ran may have set one, and the hook refuses on it.
  recheck() {
    if (M.flipState(this.o).state === 'absent') return this.refuse(CUE_ONLY);
    const st = M.standing(this.o);
    const line = st.gate || st.watch || st.flip;
    return line ? this.refuse(line) : null;
  }

  async push(n) {
    const { sha } = this;
    const s7 = S(sha);
    // Everything since the gate's exit ran synchronously, so a stop signal
    // that landed meanwhile is still unread: two turns of the event loop
    // (from the poll phase one turn resumes in the same loop's check phase,
    // before any poll reads the signal), then the checkpoint, so such a stop
    // ends the run failed with no stamp and no push.
    await turn();
    await turn();
    this.checkpoint();
    L.setManifest(sha, { push_started_at: now() }, this.o);
    this.stage('push', `git push origin ${s7}:main`);
    const r = await this.run(this.gitCmd, ['push', 'origin', `${sha}:refs/heads/main`], { timeoutMs: PUSH_BOUND_MS, tee: true, lock: true });
    if (r.status === 0 && !r.timedOut) {
      L.setManifest(sha, { pushed_at: now() }, this.o);
      this.stage('push', `pushed ${s7}`);
      this.checkpoint();
      return this.tail(n);
    }
    const rejected = REJECTED.exec(r.out);
    if (rejected) return this.settle('failed', `push rejected (${rejected[1]}): origin/main moved since the fetch; nothing was pushed and nothing is retried`);
    this.checkpoint();
    const windowMs = fetchWindowMs();
    const until = Date.now() + windowMs;
    for (;;) {
      if ((await this.fetch()) && R.isAncestor(sha, R.resolveCommit('refs/remotes/origin/main', this.o), this.o)) {
        L.setManifest(sha, { pushed_at: now() }, this.o);
        this.stage('push', `the push ended (${describe(r)}), but a fetch finds ${s7} on origin/main: it landed`);
        return this.tail(n);
      }
      if (Date.now() >= until) break;
      await sleep(Math.min(1000, Math.max(0, until - Date.now())));
      this.checkpoint();
    }
    L.setManifest(sha, { push_unknown_at: now() }, this.o);
    const text = `the outcome of the push of ${s7} is unknown (${describe(r)}; no fetch found it on origin/main in ${Math.ceil(windowMs / 1000)} seconds); run npm run ship again to complete it`;
    this.stage('push', text);
    return this.result('unknown', text);
  }

  // Still inside the ship lock: the claim, the watch and the ok result.
  async tail(n) {
    const s7 = S(this.sha);
    const word = L.claimWatch(this.sha, this.o);
    if (word === 'pending') {
      const text = `watch claim pending for ${s7}; run npm run ship again in a minute`;
      this.stage('watch', text);
      return this.result('unknown', text);
    }
    if (word === 'claimed') {
      const s = await this.spawnWatch(this.sha);
      if (!s.ok) throw new Error(`the watch for ${s7} could not start (${s.code})`);
      this.stage('watch', `watch started for ${s7}`);
    } else {
      this.stage('watch', `the watch for ${s7} had already started`);
    }
    return this.settle('ok', `pushed ${s7}, ${n} commits${stubNote(this.gateStubs)}`);
  }

  // Every throw and every stop ends here, reading the record this run opened
  // from disk first: a result that stands is the outcome; before the push
  // stamp the run ends failed, after it the outcome is unknown.
  end(err) {
    const sig = err && err.code === 'SHIP_STOPPED' ? err.signal : null;
    const why = sig ? `killed by ${sig}` : String(err && err.message ? err.message : err);
    if (this.completing) {
      return this.result('unknown', `the run ended (${M.clean(why)}) while completing ${S(this.completing)}; nothing more was written to it; run npm run ship again to complete it`);
    }
    if (!this.opened) return this.result('failed', `${M.clean(why)}; no record was opened and nothing was written`);
    const m = L.readManifest(this.opened, this.o);
    if (!m || m.pid !== process.pid) return this.result('failed', `${M.clean(why)}; the record of ${S(this.opened)} is not this run's, so nothing was written`);
    const st = standingResult(this.opened, this.primary);
    if (st) return this.result(st.state, st.text);
    if (!isSet(m.push_started_at)) return this.settle('failed', why);
    if (!isSet(m.pushed_at)) L.setManifest(this.opened, { push_unknown_at: now() }, this.o);
    const text = isSet(m.pushed_at)
      ? `the push of ${S(this.opened)} landed; the run ended (${why}) before its watch and result; run npm run ship again to finish it`
      : `the outcome of the push of ${S(this.opened)} is unknown (${why}); run npm run ship again to complete it`;
    this.stage('push', text);
    return this.result('unknown', text);
  }
}

// The flow from the flip check on, for a caller that holds the ship lock.
// Resolves {state, text, code}; it rejects only when the ending itself could
// not be recorded.
async function shipFlow({ cwd = process.cwd(), noPush = false, log = (line) => process.stdout.write(`${line}\n`), lockFd = null } = {}) {
  const run = new Run({ cwd, noPush, log, lockFd });
  run.listen();
  try {
    let res;
    try {
      res = await run.flow();
    } catch (err) {
      // Every throw is an ending, by the contract: a thrown error in ship's
      // own code ends failed before the push stamp and unknown after it.
      res = run.end(err);
    }
    run.say(`result ${res.state} ${String(res.text).replace(/^ship: /, '')}`);
    return res;
  } finally {
    run.unlisten();
  }
}

module.exports = { shipFlow, precheck, standingResult, CUE_ONLY };

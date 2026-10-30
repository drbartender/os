#!/usr/bin/env node
'use strict';

// The merge script's ship phase: merge-lane.sh ship checks a lane's receipt
// under the ship lock, squashes the tip the check judged through the shell's
// own squash, writes the squash receipt and ships it through shipFlow, in the
// background (instruction rewrite step 5, lane merge-ship; spec 2026-10-19
// sections 3.7, 3.8, 3.11, 4.1, 4.3, 4.4 and D10; plan 2026-10-28 decisions
// 8, 14, 18 and 22).
//
//   bash scripts/merge-lane.sh ship <branch> <plan> [--no-push] [--resolved] [--foreground]
//
// The shell execs `node scripts/lib/mergeShip.js ship ...`; locked, run and
// suites are this file's own steps, never typed by hand (suites runs
// mergeShipSquash.suitesStep).
//
// The processes. ship parses the arguments (usage on stderr, exit 2; a branch
// named check, merged or ship, or no usable branch name, is refused) and runs
// locked as its child, passing its stdout through; when that child ends
// non-zero having printed nothing, ship prints its own refused line naming
// the exit and the ways it can come about, never guessing one (flock exits
// 66 on a lock file it cannot open, flockExec exits 1 when a DRB_SHIP_LOCK
// guard's pid is gone, and a stop signal or a crash can end the run before
// its first line), so the answer is always one line. locked takes the ship lock,
// <git-common-dir>/drb-ship.lock, through flockExec.underLock with the guard
// DRB_SHIP_LOCK (the lock the shell's squash, check and ship.js take; a run
// nested under a trusted holder runs inside its lock; the wait line names a
// merge, a check or a ship as the holder), runs checkLane and the refusals
// below (or a resume's, below), and answers on stdout: `stale <files>
// [sensitive]` or `refused <reason>` (exit 1), else `<ready|ready-moved>
// <tip7>` or `resume <squash7> of <branch>`, then `: started in the
// background, log <path>` (exit 0) once run is spawned detached in a session
// of its own, handed the lock's descriptor as its fd 3, its stdout and stderr
// appended to <git-common-dir>/drb-ship/<tip>.stdio.log. With --foreground,
// or nested under a holder (no descriptor to hand on), the run happens in
// locked itself, its step lines on stdout too. run proves on its fd 3 the lock
// it was handed (flockExec's fdinfo proof) before anything; its guard env still
// names the foreground's pid, gone by then, so a nested taker of the ship lock
// under it would stop, never wait on its own holder (nothing it starts takes
// it). suites is the shell's callback (step 4).
//
// The run. Each step is a line `<ISO time> <step> <text>` in
// <git-common-dir>/drb-ship/<tip>.log, keyed on the lane tip the check judged
// (the one sha known when the path is printed), texts through markers.clean
// with sha7 only; the last line is `result <state> <text>`. One log per run:
// locked, holding the lock and before it answers, moves a prior run's
// <tip>.log and <tip>.stdio.log aside to <tip>.prev-<epoch ms>.log and
// .prev-<epoch ms>.stdio.log (scripts/lib/mergeShipLog.js), and the run
// writes its log through its own descriptor, so a later run's move cannot
// mix two runs in one file. Beside the log the run keeps its phase manifest,
// drb-ship/phase/<tip>.json (mergeShipLog's header has its fields), written
// at each step (running, the step and when it began; the squash once it
// lands; kept, when step 9 keeps the branch for what the squash may not hold)
// and at the end (the result's state and text, the end time), which
// scripts/lane-status.js prints at session start and on demand: the step of
// a run in flight, and one line per lane whose latest run ended other than ok
// or kept its branch (at most three at session start), retired once its
// squash (or a replay of it) has reached origin, or it never squashed, and
// its branch is gone (mergeShipLog's phaseLines); locked moves a prior
// manifest aside with the logs. The steps:
//   1. start and lock. Then, before anything is merged: an unreadable flip
//      marker refuses with its line; with the flip marker present, so does
//      what shipFlow would refuse after the squash (its precheck, the same
//      function: a DRB_SHIP_GATE_CMD, DRB_SHIP_WATCH_CMD or DRB_SHIP_GIT_CMD
//      set without DRB_SHIP_ALLOW_STUBS=1, then the primary worktree on
//      main), a standing watch marker, and a gate marker main's head does not
//      fix forward (markers.isFixForward with self, the squash being its
//      child), each with its own line (spec 4.4). checkLane runs again under
//      the lock this run holds (the foreground's answer is a snapshot, and
//      plain commits take no lock): stale or refused ends the run; a tip
//      other than the one the foreground judged refuses; so does ready-moved
//      with a log entry the receipt recorded with no suite command
//      (result.unnamed_logs), a dirty os (the squash refuses one),
//      --resolved over a comment-only receipt (its proof covers no
//      resolution), and a comment-only receipt whose squash would key other
//      than its lane key (the patch id of main..the tree git merge-tree
//      writes for main and the tip, the two docs excluded: main changed the
//      lines beside the lane's hunks since the review's base), whose way
//      through is the rebase and the stale-base review.
//   2. squash: `bash scripts/merge-lane.sh <branch> <plan>`, the positional form
//      with the branch as the lane name (the subject merged finds), run with
//      MERGE_LANE_LOCKED set to this run's pid and the lock as its fd 3, and
//      MERGE_LANE_SHIP naming a run directory under the temp dir: pid; tip and
//      main as the check judged them (the shell refuses when either moved);
//      body, receipt.commitBlock of the receipt the check judged (what the
//      receipt tool's block command prints, spec 3.7's block); suites
//      (ready-moved only, result.suites by repo path); resolved (--resolved
//      only, verifyResolved's tree); log (this log). The shell writes commit
//      (the squash's sha) after its put-back and ends without its notice.
//   3. commit: the sha the shell wrote, else the first-parent commit on main
//      whose parent is the pin and whose subject is merge(lane <branch>):
//      <plan>; none means the squash refused, and the result carries the
//      shell's first REFUSED line (a conflict's names its paths). From here
//      everything reads commits and HEAD's tree, never the shared index.
//   4. suites: on ready-moved the shell, after its regeneration and before
//      its commit, runs `mergeShip.js suites <run dir>`: scripts/run-suites.js
//      over those paths into the run directory (the dev-suite lock is the
//      runner's own, taken inside the ship lock), with RUN_SUITES_ROOT the
//      repo top always and without SHIP_ENV (the ship's own MERGE_LANE_SHIP,
//      MERGE_LANE_LOCKED, DRB_SHIP_LOCK and DRB_SHIP_LOCK_PID, which a
//      merge-lane.sh or a lock taker nested in a suite would read as its own,
//      and DRB_DEVDB_LOCK_FILE), so an operator's export redirects nothing;
//      a failure (exit non-zero, total_fail, a suite not ok, none run)
//      refuses through the shell's abandon_squash, the scoped reset.
//   5. receipt: the squash receipt under receipt.commitKey of the squash (the
//      patch id of parent..commit, the two docs excluded): a copy of the lane
//      receipt's directory (reports, tests, proof) whose receipt.json is the
//      lane's with kind squash, key, tip the squash, base its parent, source
//      (the lane receipt's key, kind, tip and base), squash (the commit, and
//      the ready-moved re-run copied under tests/merged-tree-<time>/) and
//      written_by. A comment-only lane's keeps kind comment-only, and only
//      when the squash key is the lane key (rangeCheck accepts that kind on
//      its proof and judges a squash by lens tables a proof receipt lacks).
//      When the keys are equal (main did not move into the lane, nothing was
//      resolved) the lane receipt's directory moves to _superseded/<key>.<time>/
//      first, as finalize's publish does, and back on a failure. Then
//      rangeCheck over parent..squash says whether the push check accepts it.
//   6. flip: with no flip marker the run ends cue-only (shipFlow's CUE_ONLY):
//      the squash and its receipt are on main (the step 4 behaviour plus the
//      receipt). Every ending that leaves the squash on main and not pushed
//      (cue-only, ok-no-push, a refusal or a failure after the commit) says
//      so and that the same ship command resumes it; an unknown push outcome
//      says only that the squash is on main. A push rejection, and an ending
//      while origin/main (as last fetched) is not in main's history or
//      origin/main..main holds a merge commit (shipFlow's range check refuses
//      both until a replay; main holds squashes only), names the way through
//      instead, in place of the stay clause, since a log line holds 300
//      characters: replay main's unpushed squashes onto origin's head (the
//      owner's call by the push-failure rule; never a merge, which wedges
//      main, an auto-pull or a force; the memory note on rewriting main
//      before a push is the recipe), then the same ship command resumes the
//      squash, which a replay leaves with its receipt under the same key.
//   7. ship: shipFlow({cwd, noPush, log, lockFd}) with the lock held (the range
//      gate, the markers, the literal-sha push; --no-push ends ok-no-push
//      before the push), its lines here under the step ship; its own record of
//      the squash is drb-ship/<squash>.log, which lane:status reads. It spawns
//      the watch detached as its last act (step 3's contract: the claim, the
//      spawn and the ok result before the lock goes), with no lock descriptor.
//   8. release: flock -u on the descriptor, so the watch runs outside the lock
//      (spec 3.11); a nested run's lock stays with its holder.
//   9. after a push (ok or pushed-elsewhere) only: first the branch against
//      the squash, compared only when the branch is not at the lane tip the
//      squash records or none is recorded (the squash was made of that very
//      tip, and a hand resolution's squash could never match the conflict
//      merge-tree writes; mergeShipSquash.strandOf: the tree git merge-tree
//      writes for the squash's parent and the branch tip against the squash's
//      tree, outside the two docs, and the two docs by their prose, each
//      generated section blanked (a render, or a conflict merge-tree leaves
//      inside one, blanks away); a lane commit landed during the run that put
//      a file or a doc's prose back to its base content or dropped a file the
//      lane added is outside the net diff merged's files check reads, and
//      inside this): a branch that holds what the squash does not keeps its
//      worktree and itself, named with the commits since the lane tip the
//      squash was made of ("the branch <lane> is kept for a new review
//      (<reason>)", the review named first, since a log line's 300 characters
//      may cut the reason, which the worktree and branch lines hold whole),
//      and one that could not be compared is kept, to be compared again by
//      hand after a git fault, and to be compared by hand when merged onto
//      the squash's parent it conflicts in a lane path (no retry clears
//      that). Else
//      worktree (scripts/worktree-rm.js <name> for the branch's worktree at
//      ../worktrees/<name>; its own branch -d refuses a squash-merged branch,
//      as expected; the deleted result says "the worktree removed" only when
//      this removed one, else "no worktree"). Kept or not, merged
//      (mergeCheck.mergedLane's three lines as printed, run and logged; the
//      worktree check fails too for a worktree holding the branch in a rebase
//      or a bisect, whose detached HEAD no worktree list shows), then branch:
//      the comparison once more, the worktree gone (no lane window can
//      commit then), and only after all three pass git update-ref -d from the
//      tip it read (mergeShipSquash.
//      dropAt, the config section cleared as git branch -D clears it, and
//      branchInUse asked right before it, since update-ref, unlike git branch
//      -D, deletes a branch a rebase or a bisect holds), else kept, named, a
//      branch that moved since that read or one a worktree holds so too
//      (branchOutcome; a branch kept for what the squash may not hold, or
//      for a worktree holding it so, is the manifest's kept). A dry run, a
//      cue-only run and a failed push leave both. Each of the three runs on
//      its own: one that throws, the kept line's write included, is a cleanup
//      line naming it, a merged-lane check that fails is its merged fail line
//      and keeps the branch, and the result stays the push's (the sha is
//      live), as it does for any error after the push.
// Exit 0 for ok, ok-no-push, pushed-elsewhere and cue-only, 1 for refused,
// stale and failed, 2 for unknown (shipFlow's). A stop signal to the run
// outside shipFlow is acted on once the step in hand ends (a landed squash
// still gets its receipt); inside it, shipFlow's own handling. One sent to the
// run's whole process group reaches the shell too, which stops as the
// positional form does.
//
// A resume: the same ship command again for a lane whose squash is on main
// and not yet pushed (a dry run, a cue-only run, a gate or push refusal, a
// stop). Before the check, locked looks for it as merged's first check does,
// over the unpushed range: the newest commit of origin/main..main whose
// subject opens merge(lane <branch>): (mergeShipSquash.unpushedOf). One a
// later commit of that range reverts no resume can push (the push check takes
// no revert receipt for a squash that never shipped), so locked refuses with
// the line check prints (revertedLine: push the two, the revert with a review
// --commit receipt of its own, then a new review of the branch; exit 1,
// nothing merged, no lane check). When an unreverted one is there
// and the branch still resolves, the check and the squash are skipped (the
// receipt the check would find is the squash's own now, which it would read
// as a stale lane, and the stale protocol would supersede it). First, before
// any push, mergeShipSquash.resumeProblem: the squash receipt records the
// lane tip it squashed, and a branch at another tip refuses, naming the
// squash, that tip and the commits since, the way through to push the
// squash, then a new review of the branch, never a resume (a resume would
// push the old squash and strand them); a squash with no
// receipt refuses toward a review --commit of it; and a branch that holds
// what the squash does not, by step 9's comparison, refuses with the line
// step 9 keeps it with: made only when the receipt records no lane tip (a
// review --commit's), since a branch at the recorded tip is the squash's own
// source; a git fault in the comparison with "run the same command again",
// and a conflict in a lane path, which no retry clears, with the way through
// by hand (the squash pushed by hand, npm run ship after the flip, then a new
// review of the branch). Then the run, keyed on the branch tip, finds the same
// squash again under the lock, asks resumeProblem again, logs `resume squash
// <sha7> of <branch>, unpushed`, takes the marker
// refusals of step 1 for main's head, and goes on from step 6 for main's
// head, the cleanup after a push included; a main moved past the squash by
// plain commits ships whole (shipFlow's range carries every commit, each
// needing its receipt). A replayed squash (step 6's way through after a
// rejection: the same hunks on origin's head) has no receipt whose tip is
// itself, but its commit key, the patch id of parent..squash, is the earlier
// squash's, and that squash receipt stands for it (squashRecord, the push
// check reading it under the key as for any commit) while the branch is at
// the lane tip it records; the resume line names the replay. --resolved over
// such a lane refuses.
//
// --resolved (spec 4.1): the session re-ran the squash in os, edited only the
// conflicting files and staged the lane's paths and the resolution. Before
// the check reads the index, an unmerged entry refuses, and so does a staged
// path whose working file was edited after git add (an MM or AM row: its own
// line, naming the path and git add as the way through, with nothing reset).
// verifyResolved proves the tree written from a private copy of the index
// differs from main only at the squash's own paths (as the shell plans them:
// what merge-tree of main and the tip changes or reports conflicted, the
// lane's changes since the merge base, the two docs) and holds merge-tree's
// result at each but the conflicted, and that the conflicted paths are
// README.md and ARCHITECTURE.md alone (a conflict in a lane file is overlap,
// which check reads as stale: it needs the rebase and the stale-base review,
// never a hand resolution); a squash that merges clean refuses. checkLane
// runs with allowStaged. The shell skips its squash, its dirty check reads
// only unstaged and untracked paths, its snapshot and prose reference are
// that tree, and a main moved off the pin before the squash first asks
// whether the commit that moved it took the staged resolution. A refusal
// resets the resolution as it resets a squash, and when the index no longer
// holds the tree outside README.md and ARCHITECTURE.md (step 7 regenerates
// those two into the index before the hooks) the run prints on stderr the git
// restore that puts it back.
//
// The index is clean after every refusal but the step 4 ones that leave
// something on purpose, each named by the shell where it happens: a commit
// hook that refuses the squash commit leaves the squash staged (unless
// another window's plain commit took it); a conflicted working copy edited
// during the merge leaves the squash in place; what another window staged or
// restaged, and a doc whose prose it staged, stay staged for it; a working
// file another window changed is kept on disk; a path that could not be reset
// or unstaged is named. ship adds nothing to that list.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const R = require('./receipt');
const M = require('./markers');
const FE = require('./flockExec');
const MC = require('./mergeCheck');
const RC = require('./rangeCheck');
const SQ = require('./mergeShipSquash');
const SL = require('./mergeShipLog');
const { shipFlow, CUE_ONLY } = require('./shipFlow');

const USAGE = 'usage: scripts/merge-lane.sh ship <lane-branch> <plan-link> [--no-push] [--resolved] [--foreground] | check <lane-branch> | merged <lane-branch>\n';
const RESERVED = Object.freeze(['check', 'merged', 'ship']);
const EXIT = new Map([['ok', 0], ['ok-no-push', 0], ['pushed-elsewhere', 0], ['cue-only', 0], ['refused', 1], ['stale', 1], ['failed', 1], ['unknown', 2]]);
const PUSHED = Object.freeze(['ok', 'pushed-elsewhere']);
const OWNERS = "the owner's call by the push-failure rule; never a merge, an auto-pull or a force";
const STOPS = Object.freeze(['SIGTERM', 'SIGINT', 'SIGHUP']);
// The ways the locked run can end before its answer (header, the processes).
const SILENT = 'flock exits 66 on a lock file it cannot open, flockExec exits 1 when the DRB_SHIP_LOCK guard\'s pid is gone, and a stop signal or a crash can end it before its first line; its stderr says which';
const S = (x) => (typeof x === 'string' && x ? R.short(x) : '(none)');
const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ');
const firstLine = (s) => String(s || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
const nul = (out) => out.split('\0').filter(Boolean);
const listed = (xs, max = 8) => `${xs.slice(0, max).join(', ')}${xs.length > max ? `, and ${xs.length - max} more` : ''}`;
const quote = (p) => `'${String(p).replace(/'/g, "'\\''")}'`;

// ---- git -------------------------------------------------------------------------

const { gitOut, commitOf } = SQ;

// ---- the run (header) ----------------------------------------------------------------

class Ship {
  constructor(o) {
    Object.assign(this, o);
    this.squash = null;
    this.laneTip = null;
    this.runDir = null;
    this.logFd = null;
    this.phase = null;
    this.step = null;
    this.pushed = null;
    this.phaseFailed = false;
    this.stopped = null;
    this.onStop = (sig) => {
      if (!this.stopped) process.stderr.write(`merge-lane ship: ${sig} received; the run stops once the step in hand ends\n`);
      this.stopped = this.stopped || sig;
    };
  }

  say(step, text) {
    if (this.logFd === null) SL.appendLine(this.log, step, text);
    else SL.writeLine(this.logFd, step, text);
    if (this.foreground) this.out(`merge-lane ship: ${step} ${M.clean(oneLine(text))}`);
    if (step !== 'result' && step !== 'phase' && step !== this.step) {
      this.step = step;
      this.mark({ step, step_at: new Date().toISOString() });
    }
  }

  // The phase manifest (header): a failed write is one phase line in the log,
  // the first time only (say never marks a phase line, so no loop back here).
  mark(patch) {
    if (!this.phase) return;
    try {
      this.phase.write(patch);
    } catch (err) {
      if (this.phaseFailed) return;
      this.phaseFailed = true;
      this.say('phase', `phase manifest write failed (${oneLine(err && err.message ? err.message : String(err))}); the log is the record`);
    }
  }

  // behind: the push check refuses main's head until a replay (header, step 6).
  end(state, text, { behind = false } = {}) {
    let full = String(text);
    if (this.squash && !PUSHED.includes(state)) {
      if (state === 'unknown') full += `; the squash ${S(this.squash)} is on main`;
      else if (behind) full += `; replay main's unpushed squashes onto origin's head (${OWNERS}), then the same ship command resumes ${S(this.squash)}`;
      else full += `; the squash ${S(this.squash)} sits on main unpushed, and the same ship command resumes it`;
    }
    // The manifest first, so a line saying its write failed comes before the result line.
    this.mark({ state, squash: this.squash, result: M.clean(oneLine(full)), ended_at: new Date().toISOString() });
    this.say('result', `${state} ${full}`);
    return { state, text: full, code: EXIT.has(state) ? EXIT.get(state) : 1 };
  }

  listen(on) {
    for (const sig of STOPS) (on ? process.on : process.off).call(process, sig, this.onStop);
  }

  halted(after) {
    return this.stopped ? this.end('failed', `stopped by ${this.stopped} after the ${after} step`) : null;
  }

  async go() {
    this.listen(true);
    try {
      this.logFd = SL.openLog(this.log);
      this.phase = new SL.Phase({ cwd: this.cwd, tip: this.judgedTip, lane: this.branch, log: this.log });
      this.phase.start();
      return await this.flow();
    } catch (err) {
      const why = oneLine((err && err.message ? err.message : String(err)));
      // After a push the sha is live: the result is the push's, never failed.
      if (this.pushed) return this.end(this.pushed.state, `${this.pushed.text}; ${this.cleanupFailed('the run after the push', 'the run after the push', why)}`);
      return this.end('failed', `the run stopped on an error (${why})`);
    } finally {
      this.listen(false);
      if (this.runDir) fs.rmSync(this.runDir, { recursive: true, force: true });
      if (this.logFd !== null) fs.closeSync(this.logFd);
    }
  }

  async flow() {
    const { cwd, branch, plan } = this;
    this.say('start', `ship of ${branch} at ${S(this.judgedTip)}, plan ${plan}${this.resume ? `, resuming ${S(this.resume)}` : ''}${this.noPush ? ', a dry run (--no-push)' : ''}${this.resolved ? ', --resolved' : ''}, ${this.foreground ? 'in the foreground' : 'in the background'}`);
    if (!this.foreground && FE.heldLockFd(this.lockFile) !== this.lockFd) return this.end('failed', `this run holds no ship lock on its descriptor ${this.lockFd}; nothing was merged`);
    this.say('lock', this.lockFd === null ? 'inside the ship lock its caller holds (DRB_SHIP_LOCK)' : `the ship lock held on descriptor ${this.lockFd}`);
    if (this.resume) return this.resumed();
    const edited = this.resolved ? SQ.resolvedIndexProblem(cwd) : null;
    if (edited) return this.end('refused', `--resolved: ${edited}`);
    const r = MC.checkLane({ cwd, branch, plan, allowStaged: this.resolved });
    this.say('check', `${MC.line(r)}${r.tip ? ` (tip ${S(r.tip)}, main ${S(r.main)})` : ''}`);
    if (!r.ok) return this.end(r.state, `${r.state === 'stale' ? `the check reads ${MC.line(r)}` : r.reason}; nothing was merged`);
    if (r.tip !== this.judgedTip) return this.end('refused', `${branch} moved after the check judged it at ${S(this.judgedTip)} (now ${S(r.tip)}); nothing was merged`);
    const why = SQ.preRefusal(cwd, r, this);
    if (why) return this.end('refused', `${why}; nothing was merged`);
    let tree = null;
    if (this.resolved) {
      const v = SQ.verifyResolved(cwd, r);
      if (v.problem) return this.end('refused', `--resolved: ${v.problem}; nothing was merged`);
      tree = v.tree;
      this.say('squash', `--resolved: the index holds the squash's own paths and the resolution of ${listed(v.conflicted)} (tree ${S(tree)})`);
    }
    const halt = this.halted('check');
    if (halt) return halt;
    this.runDir = SQ.writeRunDir(r, tree, this.log);
    if (r.state === 'ready-moved') this.say('suites', r.suites.length ? `ready-moved: the shell re-runs the receipt's ${r.suites.length} suite(s) on the merged tree before its commit` : 'ready-moved: the receipt names no suite to re-run; the gate is the net');
    const sh = await SQ.squashShell({ cwd, branch, plan, runDir: this.runDir, lockFd: this.lockFd });
    this.squash = SQ.findSquash(cwd, this.runDir, { main: r.main, branch, plan });
    if (!this.squash) {
      if (tree && SQ.wasReset(cwd, tree)) this.recovery(tree, r.main);
      return this.end('refused', `the squash refused: ${sh.refusal || `the shell ended ${sh.signal ? `by ${sh.signal}` : `exit ${sh.code}`} with nothing on main`}`);
    }
    this.mark({ squash: this.squash });
    this.laneTip = r.tip;
    if (sh.code !== 0) this.say('commit', `the shell ended exit ${sh.code} after main moved to the squash; going on from the squash it landed`);
    this.say('commit', `${S(this.squash)} merge(lane ${branch}): ${plan}, onto main ${S(r.main)}`);
    const rec = SQ.writeSquashReceipt({ cwd, squash: this.squash, check: r, branch, suitesDir: path.join(this.runDir, 'suites-run') });
    this.say('receipt', `squash receipt ${S(rec.key)}, kind ${rec.kind}, its source the lane receipt ${S(r.key)}${rec.superseded ? ' (moved to _superseded under the same key)' : ''}`);
    const rc = RC.checkRange({ base: r.main, tip: this.squash, cwd });
    this.say('receipt', rc.ok ? 'the push check accepts the squash receipt' : `the push check would refuse it: ${rc.problems.slice(0, 3).join('; ')}`);
    const halted = this.halted('receipt');
    if (halted) return halted;
    if (M.flipState({ cwd }).state === 'absent') return this.end('cue-only', `${CUE_ONLY.replace(/^ship: /, '')}; the squash receipt is written, and the worktree and the branch stay until it is pushed`);
    return this.shipSquash();
  }

  // A resume (header): the lane's squash on main and not yet pushed, shipped
  // from step 6 on for main's head.
  async resumed() {
    const { cwd, branch } = this;
    const now = SQ.findUnpushed(cwd, branch);
    if (now !== this.resume) return this.end('refused', `the squash ${S(this.resume)} of ${branch} is no longer on main unpushed (${now ? `the unpushed one is ${S(now)}` : 'none is'}); nothing was pushed`);
    const moved = SQ.resumeProblem(cwd, branch, now);
    if (moved) return this.end('refused', `${moved}; nothing was pushed`);
    const rec = SQ.squashRecord(cwd, now);
    [this.squash, this.laneTip] = [now, rec.laneTip || null];
    this.mark({ squash: now });
    this.say('resume', `squash ${S(now)} of ${branch}, unpushed${rec.replayOf ? `, a replay of ${S(rec.replayOf)} (its receipt under the same patch-id key)` : ''}`);
    const why = SQ.markerRefusal(cwd, commitOf(cwd, 'refs/heads/main'));
    if (why) return this.end('refused', `${why}; nothing was pushed`);
    const halt = this.halted('resume');
    if (halt) return halt;
    if (M.flipState({ cwd }).state === 'absent') return this.end('cue-only', `${CUE_ONLY.replace(/^ship: /, '')}; the worktree and the branch stay until it is pushed`);
    return this.shipSquash();
  }

  // Steps 7 to 9: shipFlow under the lock, the release, the cleanup after a push.
  async shipSquash() {
    this.listen(false);
    const res = await shipFlow({ cwd: this.cwd, noPush: this.noPush, log: (l) => this.say('ship', String(l).replace(/^ship: /, '')), lockFd: this.lockFd });
    this.listen(true);
    if (PUSHED.includes(res.state)) this.pushed = res;
    this.release(res.state === 'ok');
    if (!this.pushed) {
      // Behind, the way through takes the place of the stay clause: a log line holds 300 characters.
      const behind = /^push rejected \(/.test(res.text) || SQ.wedged(this.cwd);
      return this.end(res.state, behind ? res.text : `${res.text}; the worktree and the branch stay`, { behind });
    }
    return this.end(res.state, `${res.text}; ${this.cleanup()}`);
  }

  // --resolved's way back after a refusal reset the resolution (header).
  recovery(tree, main) {
    const paths = nul(gitOut(this.cwd, ['diff', '--name-only', '-z', '--no-renames', '--end-of-options', main, tree, '--']));
    process.stderr.write(`merge-lane ship: the refusal reset the resolution, which is kept as tree ${tree}; this puts it back:\n  git restore --source=${tree} --staged --worktree -- ${paths.map(quote).join(' ')}\n`);
    this.say('squash', `the refusal reset the resolution, kept as tree ${S(tree)}; the git restore that puts it back is in ${this.foreground ? 'the output above' : SL.paths(this.cwd, this.judgedTip).stdio}`);
  }

  // Step 8; watched: shipFlow spawned the watch.
  release(watched) {
    if (this.lockFd === null) {
      this.say('release', 'the ship lock stays with the caller that holds it');
      return;
    }
    const r = spawnSync('flock', ['-u', '3'], { stdio: ['ignore', 'ignore', 'pipe', this.lockFd], encoding: 'utf8' });
    if (r.status === 0 && !this.foreground) fs.closeSync(this.lockFd);
    this.say('release', r.status === 0 ? `the ship lock is released${watched ? '; the watch runs outside it' : ''}` : `flock -u failed (${firstLine(r.stderr) || `exit ${r.status}`}); the lock goes when this run ends`);
  }

  // A cleanup step that threw after the push: its line (on stderr, the stdio
  // log, when the log cannot take it) and the words the result carries.
  cleanupFailed(logged, told, why) {
    const text = `${logged} failed (${why}); the push stands`;
    try {
      this.say('cleanup', text);
    } catch (err) {
      process.stderr.write(`merge-lane ship: cleanup ${text} (the log could not take this line: ${oneLine(err && err.message ? err.message : String(err))})\n`);
    }
    return `${told} failed (${why})`;
  }

  // Step 9: the closing words of the result. Each part runs on its own, so a
  // step that throws is named and the rest still runs; a branch that holds
  // what the squash does not keeps its worktree and itself, and the branch
  // goes only after all three merged-lane checks pass, compared once more
  // when the worktree is gone (no lane window can commit then), its delete
  // tied to the tip that read.
  cleanup() {
    const said = [];
    const part = (name, fn) => {
      try {
        return fn();
      } catch (err) {
        said.push(this.cleanupFailed(`the ${name} step`, `the cleanup's ${name} step`, oneLine(err && err.message ? err.message : String(err))));
        return null;
      }
    };
    const { cwd, branch, squash, laneTip } = this;
    const first = SQ.strandOf(cwd, branch, squash, laneTip);
    let removed = false;
    part('worktree', () => {
      const rm = first.line ? null : SQ.removeLaneWorktree(cwd, branch);
      removed = Boolean(rm && rm.removed);
      this.say('worktree', rm ? rm.line : `kept: ${first.line}`);
    });
    const m = part('merged', () => {
      const r = MC.mergedLane({ cwd, branch });
      for (const c of r.checks) this.say('merged', `${c.ok ? 'pass' : 'fail'} ${c.text}`);
      return r;
    });
    const last = first.line ? first : SQ.strandOf(cwd, branch, squash, laneTip);
    const told = part('branch', () => this.dropBranch(m, last.line ? last : null, last.tip, removed));
    return [...said, told || `the branch ${branch} is kept`].join('; ');
  }

  // The branch step (mergeShipSquash.branchOutcome): its line, and a branch
  // kept for what the squash may not hold written to the manifest (kept),
  // which the phase lines show whatever the state; removed, whether the
  // worktree step removed a worktree.
  dropBranch(m, kept = null, tip = null, removed = false) {
    const o = SQ.branchOutcome(this.cwd, this.branch, m, kept, tip, removed);
    this.say('branch', o.said);
    if (o.shown) this.mark({ kept: M.clean(oneLine(o.text)) });
    return o.text;
  }
}

// ---- the steps ------------------------------------------------------------------------

function parseArgs(argv) {
  const a = { branch: null, plan: null, noPush: false, resolved: false, foreground: false, tip: null, resume: null };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--no-push') a.noPush = true;
    else if (x === '--resolved') a.resolved = true;
    else if (x === '--foreground') a.foreground = true;
    else if (x === '--tip' && R.KEY_RE.test(String(argv[i + 1]))) a.tip = argv[++i];
    else if (x === '--resume' && R.KEY_RE.test(String(argv[i + 1]))) a.resume = argv[++i];
    else if (x.startsWith('-')) return null;
    else pos.push(x);
  }
  if (pos.length !== 2 || !pos[1] || /[\0\n\r]/.test(pos[1])) return null;
  [a.branch, a.plan] = pos;
  return a;
}

// Why a branch name is refused before anything runs, or null.
function nameProblem(branch) {
  if (RESERVED.includes(branch)) return `a lane branch named ${branch} is never shipped (check, merged and ship are this script's subcommands); rename it`;
  try {
    R.checkName(branch);
  } catch {
    return `${JSON.stringify(oneLine(branch))} is not a usable branch name`;
  }
  return null;
}

// ship: locked as a child, and a refused line for a silent stop (header).
function wrapper(argv, out) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [__filename, 'locked', ...argv], { stdio: ['ignore', 'pipe', 'inherit'] });
    let said = false;
    for (const sig of STOPS) process.on(sig, () => child.kill(sig));
    child.stdout.on('data', (b) => {
      said = said || b.length > 0;
      process.stdout.write(b);
    });
    child.on('error', (err) => {
      out(`refused the ship could not start (${err.code || 'error'})`);
      resolve(1);
    });
    child.on('close', (code, signal) => {
      if (code !== 0 && !said) out(`refused the locked run ended ${signal ? `by ${signal}` : `exit ${code}`} before it answered, so nothing was merged: ${SILENT}`);
      resolve(code === null ? 1 : code);
    });
  });
}

// locked: the lock, the check and the start (header).
async function locked(a, out) {
  const cwd = process.cwd();
  let lockFile;
  try {
    lockFile = path.join(R.commonDir({ cwd }), 'drb-ship.lock');
  } catch {
    out('refused not inside a git repository');
    return 1;
  }
  const held = await FE.underLock({ lockFile, guardVar: 'DRB_SHIP_LOCK', waitLine: MC.WAIT_LINE });
  // A resume (header) skips the check: the lane's squash is on main already;
  // a reverted one refuses as check refuses it, never reaching the lane check.
  const u = SQ.unpushedOf(cwd, a.branch);
  if (u && u.revert) {
    out(`refused ${SQ.revertedLine(a.branch, u)}`);
    return 1;
  }
  const resume = u ? u.squash : null;
  const branchTip = resume ? commitOf(cwd, `refs/heads/${a.branch}`) : null;
  let [said, tip] = [null, null];
  if (resume && branchTip) {
    const why = a.resolved ? `--resolved: the squash ${S(resume)} of ${a.branch} is on main already, unpushed; ship it without --resolved, which resumes it`
      : SQ.resumeProblem(cwd, a.branch, resume) || SQ.markerRefusal(cwd, commitOf(cwd, 'refs/heads/main'));
    if (why) {
      out(`refused ${oneLine(why)}; nothing was pushed`);
      return 1;
    }
    [said, tip] = [`resume ${S(resume)} of ${a.branch}`, branchTip];
  } else {
    const edited = a.resolved ? SQ.resolvedIndexProblem(cwd) : null;
    if (edited) {
      out(`refused --resolved: ${oneLine(edited)}`);
      return 1;
    }
    const r = MC.checkLane({ cwd, branch: a.branch, plan: a.plan, allowStaged: a.resolved });
    if (!r.ok) {
      MC.report(r);
      return r.exitCode;
    }
    const v = a.resolved ? SQ.verifyResolved(cwd, r) : {};
    const why = SQ.preRefusal(cwd, r, a) || (v.problem ? `--resolved: ${v.problem}` : null);
    if (why) {
      out(`refused ${oneLine(why)}`);
      return 1;
    }
    [said, tip] = [`${r.state} ${S(r.tip)}`, r.tip];
  }
  const p = SL.paths(cwd, tip);
  SL.moveAside(cwd, tip);
  const note = M.flipState({ cwd }).state !== 'absent' ? '' : resume && branchTip ? '; no flip marker, so it ends cue-only, the squash still unpushed' : '; no flip marker, so it stops after the squash receipt (cue-only)';
  const run = { ...a, cwd, lockFile, judgedTip: tip, resume: resume && branchTip ? resume : null, log: p.log };
  if (a.foreground || held.lockFd === null) {
    out(`${said}: shipping in the foreground${held.lockFd === null ? ' inside its caller\'s ship lock' : ''}, log ${p.log}${note}`);
    return (await new Ship({ ...run, lockFd: held.lockFd, foreground: true, out }).go()).code;
  }
  fs.mkdirSync(p.dir, { recursive: true });
  const fd = fs.openSync(p.stdio, 'a');
  let child;
  try {
    const flags = [...(a.noPush ? ['--no-push'] : []), ...(a.resolved ? ['--resolved'] : []), ...(run.resume ? ['--resume', run.resume] : [])];
    child = spawn(process.execPath, [__filename, 'run', a.branch, a.plan, '--tip', tip, ...flags], { cwd, detached: true, stdio: ['ignore', fd, fd, held.lockFd] });
  } finally {
    fs.closeSync(fd);
  }
  return new Promise((resolve) => {
    child.once('spawn', () => {
      child.unref();
      out(`${said}: started in the background, log ${p.log}${note}`);
      resolve(0);
    });
    child.once('error', (err) => {
      out(`refused the ship could not start in the background (${err.code || 'error'})`);
      resolve(1);
    });
  });
}

// run: the detached run, handed the lock as its fd 3 (header).
async function runDetached(a, out) {
  const cwd = process.cwd();
  const lockFile = path.join(R.commonDir({ cwd }), 'drb-ship.lock');
  const ship = new Ship({ ...a, cwd, lockFile, lockFd: 3, judgedTip: a.tip, log: SL.paths(cwd, a.tip).log, foreground: false, out });
  return (await ship.go()).code;
}

async function main(argv) {
  const out = (line) => process.stdout.write(`${line}\n`);
  const [cmd, ...rest] = argv;
  if (cmd === 'suites' && rest.length === 1) return SQ.suitesStep(rest[0]);
  const a = ['ship', 'locked', 'run'].includes(cmd) ? parseArgs(rest) : null;
  if (!a || (cmd === 'run') !== (a.tip !== null) || (cmd !== 'run' && a.resume !== null)) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (cmd === 'ship') {
    const why = nameProblem(a.branch);
    if (why) {
      out(`refused ${why}`);
      return 1;
    }
    return wrapper(rest, out);
  }
  return cmd === 'locked' ? locked(a, out) : runDetached(a, out);
}

module.exports = { parseArgs, nameProblem, Ship, USAGE };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    process.stdout.write(`refused the ship could not run: ${oneLine(err && err.message ? err.message : String(err))}\n`);
    process.exit(1);
  });
}

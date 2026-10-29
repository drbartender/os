#!/usr/bin/env node
'use strict';

// ship: the one push path (instruction rewrite step 3, lane ship; spec
// 2026-10-19 sections 4.1 to 4.5 and 4.8; plan 2026-10-22 decisions 1, 10,
// 12, 13 and 16). The flow, its order and every ending are the plan's ship.js
// contract as amended (docs/superpowers/plans/
// 2026-10-22-instruction-rewrite-step3.md, "Contracts shared across lanes"
// and "Amendments (as built)"); the flow itself is scripts/lib/shipFlow.js,
// and this file holds the CLI, the lock and the detached start. This header
// says what they guarantee and never restates the flow.
//
//   node scripts/ship.js [--no-push] [--foreground]
//   node scripts/ship.js --ack-watch <sha> --note <text>
//   node scripts/ship.js --status [<sha>]
//
// What it guarantees:
//   - Dormant until the flip marker (<git-common-dir>/drb-flip.json): without
//     it a ship refuses with the cue-only line and writes nothing, not even
//     the lock file; so does an unreadable flip marker (with its line) and a
//     cwd that is not the primary worktree on main. --status and --ack-watch
//     push nothing and run either way.
//   - The test overrides DRB_SHIP_GATE_CMD, DRB_SHIP_WATCH_CMD and
//     DRB_SHIP_GIT_CMD run only with DRB_SHIP_ALLOW_STUBS=1: set without it,
//     each refuses the ship with a line of its own before anything is
//     written, the detached form included, so a leaked override never
//     stands in for the gate, the push or the watch of a real ship.
//   - One ship at a time: the flow runs under <git-common-dir>/drb-ship.lock
//     through flockExec.underLock with the guard DRB_SHIP_LOCK, so a caller
//     that already holds the lock runs ship inside it, and one line on stderr
//     says when a ship waits. push-gate.js sha takes its own lock inside the
//     ship lock and the smoke takes the smoke lock inside that, never the
//     reverse; the claim of the watch, its spawn and the ok result all run
//     before the ship lock is released. The lock's descriptor goes to the
//     push and the gate, so a ship killed with SIGKILL keeps the lock until
//     they end.
//   - Detached by default: ship re-runs itself with --foreground, detached,
//     its stdout and stderr appended to drb-ship/<sha>.stdio.log (raw, never
//     read by lane-status; <sha>.log is shipLog's alone), prints the started
//     line and exits 0 at once. The detached run ships HEAD as it stands
//     once it holds the lock, a later sha than the started line named when
//     main moved while it waited; --status reads `last`, so it names the
//     record being shipped.
//   - --foreground exits with the flow's code: 0 for ok, ok-no-push and
//     pushed-elsewhere, 1 for refused and failed, 2 when a push's outcome is
//     unknown (the next run completes the record from its evidence).
//   - --ack-watch clears the watch marker only when it names that sha, the
//     note recorded in drb-markers/acks.jsonl and, when that sha has a ship
//     record, as its ack line; it pushes nothing. --status writes nothing.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const R = require('./lib/receipt');
const M = require('./lib/markers');
const L = require('./lib/shipLog');
const FE = require('./lib/flockExec');
const { shipFlow, precheck, standingResult } = require('./lib/shipFlow');

const S = R.short;
const WAIT_LINE = 'ship: a merge, a check or a ship holds the ship lock; waiting for it';
const USAGE = 'usage: node scripts/ship.js [--no-push] [--foreground] | --ack-watch <sha> --note <text> | --status [<sha>]\n';
const isSet = (v) => v !== null && v !== undefined;

// ---- the CLI ---------------------------------------------------------------------

function parseArgs(argv) {
  const a = { noPush: false, foreground: false, status: false, ref: null, ack: null, note: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--no-push') a.noPush = true;
    else if (x === '--foreground') a.foreground = true;
    else if (x === '--status') {
      a.status = true;
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) a.ref = argv[++i];
    } else if (x === '--ack-watch' || x === '--note') {
      const v = argv[++i];
      if (v === undefined) return null;
      if (x === '--note') a.note = v;
      else a.ack = v;
    } else return null;
  }
  const acking = a.ack !== null || a.note !== null;
  if (acking && (a.ack === null || a.note === null)) return null;
  if ((a.status || acking) && (a.noPush || a.foreground || (a.status && acking))) return null;
  return a;
}

// The manifest's fields and the last fifteen log lines; writes nothing.
function statusMode(cwd, ref, out) {
  const sha = ref === null ? L.readLast({ cwd }) : L.shipPaths(ref, { cwd }).sha;
  const m = sha ? L.readManifest(sha, { cwd }) : null;
  if (!m) {
    out('no ship yet');
    return 0;
  }
  const live = L.inFlight({ cwd });
  const st = standingResult(sha, cwd);
  let where = 'no result';
  if (live && live.sha === sha) where = `in flight at stage ${m.last_stage || 'open'} since ${m.last_stage_at || m.started_at}`;
  else if (st) where = `result ${st.state} ${st.text}`;
  else if (isSet(m.push_unknown_at)) where = 'push outcome unknown; run npm run ship again to complete it';
  out(`ship ${S(sha)}: ${M.clean(where)}`);
  for (const [k, v] of Object.entries(m)) out(`  ${k}: ${v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  const lines = L.tail(sha, 15, { cwd });
  out(`log ${L.shipPaths(sha, { cwd }).log}, its last ${lines.length} lines:`);
  for (const l of lines) out(`  ${l}`);
  return 0;
}

// Clears the watch marker only when it names that sha; the note is the ack.
function ackMode(cwd, ref, note, out) {
  if (!M.clearWatch(ref, { note, cwd })) {
    out(M.standing({ cwd }).watch || 'ship: no watch marker stands; nothing to ack');
    return 1;
  }
  let record = null;
  try {
    record = L.readManifest(ref, { cwd });
  } catch (err) {
    if (!err || err.code !== 'SHIP_NO_COMMIT') throw err; // a full sha git cannot resolve has no ship record
  }
  if (record) L.line(ref, 'ack', note, { cwd });
  out(`ship: the watch marker on ${M.clean(S(ref))} is cleared and the ack recorded${record ? ' in its ship log' : ''}`);
  return 0;
}

// Re-runs this script with --foreground, detached, its output appended to
// drb-ship/<sha>.stdio.log, and returns at once.
function detach(cwd, head, flags, out) {
  const log = L.shipPaths(head, { cwd }).log;
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(path.join(path.dirname(log), `${head}.stdio.log`), 'a');
  let child;
  try {
    child = spawn(process.execPath, [__filename, '--foreground', ...flags], { cwd, detached: true, stdio: ['ignore', fd, fd] });
  } finally {
    fs.closeSync(fd);
  }
  return new Promise((resolve) => {
    child.once('spawn', () => {
      child.unref();
      out(`ship: started ${S(head)}, log ${log}`);
      resolve(0);
    });
    child.once('error', (err) => {
      out(`ship: could not start the ship (${err.code || 'error'})`);
      resolve(1);
    });
  });
}

async function main(argv) {
  const out = (line) => process.stdout.write(`${line}\n`);
  const a = parseArgs(argv);
  if (!a) {
    process.stderr.write(USAGE);
    return 1;
  }
  const cwd = process.cwd();
  if (a.status) return statusMode(cwd, a.ref, out);
  if (a.ack !== null) return ackMode(cwd, a.ack, a.note, out);
  const pre = precheck(cwd);
  if (pre.refusal) {
    out(pre.refusal);
    return 1;
  }
  if (!a.foreground) return detach(cwd, pre.head, a.noPush ? ['--no-push'] : [], out);
  const held = await FE.underLock({ lockFile: path.join(R.commonDir({ cwd }), 'drb-ship.lock'), guardVar: 'DRB_SHIP_LOCK', waitLine: WAIT_LINE });
  return shipFlow({ cwd, noPush: a.noPush, log: out, lockFd: held.lockFd }).then((res) => res.code, (err) => {
    out(`ship: the run's ending could not be recorded (${M.clean(err && err.message ? err.message : String(err))}); its outcome is unknown; run npm run ship again`);
    return 2;
  });
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    process.stderr.write(`ship: ${M.clean(err && err.message ? err.message : String(err))}\n`);
    process.exit(1);
  });
}

module.exports = { shipFlow };

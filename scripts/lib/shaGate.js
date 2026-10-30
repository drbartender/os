'use strict';

// shaGate: the push gate's sha mode, a leaf module (instruction rewrite step
// 3, lane gate-sha; spec 2026-10-19 sections 4.3 and 4.4, plan 2026-10-22
// decisions 2, 3, 4, 10, 11, 16 and 18). push-gate.js keeps the CLI, the lock
// and the modes, and re-exports classifyRange, checkShaReceipt, gateEnvFile
// and gateWorktreePath from here. This file requires only gatePaths.js,
// markers.js, worktreeLinks.js, receipt.js, shaGateWorktree.js (the worktree
// and child half) and Node's own modules, never
// push-gate.js or rangeCheck.js, so no require cycle can form through it.
//
// What it guarantees:
//   - One commit is tested in a detached worktree of its own,
//     <worktrees dir>/.gate-<sha7> beside the lanes, never in the checkout the
//     gate is called from, so another window's edits can never reach it. The
//     worktree is removed on every ending: a pass, a failure, a throw, and
//     SIGINT, SIGTERM or SIGHUP (the running child's process group is stopped
//     first, then git worktree remove --force and git worktree prune), and a
//     .gate-* directory a crash left is swept when the next sha run starts.
//   - The gates are picked from the range, never from the tip commit:
//     classifyRange diffs the freshly fetched origin/main against the sha as
//     two trees (gatePaths.touches), so a server change two commits back
//     still needs the money smoke. A range that needs no gate (docs only, or
//     only files outside server/, client/, the money paths and the install
//     paths, or no file at all) is nothing_to_run and creates no worktree.
//   - The worktree holds no live key and no real credential. Its .env is
//     gateEnvFile() and nothing else (its STRIPE_SECRET_KEY is a placeholder
//     of dashed words, so the Stripe client constructs for the suites' local
//     signature checks and stubs while a real call from the gate can only
//     fail at Stripe's auth); a .env or client/.env already in the checkout refuses the gate;
//     no client/.env is written; and the money smoke runs with a scrubbed
//     environment (PATH, HOME, LANG, TMPDIR, NEON_API_KEY when set, and the
//     env file's variables), because dotenv never overrides a variable the
//     process already has and the box's own environment carries live keys.
//   - The receipt (drb-gate/<sha>.json in the common dir) records what ran
//     and what passed. A gate that skipped, did not run or could not start is
//     never in gates_passed; checkShaReceipt refuses a receipt whose own
//     needed gates did not all pass, so a failed run's receipt never vouches.
//   - Two kinds of failure. A verdict about the code (a smoke that ran and
//     had a failing suite, a build that exited non-zero, a blocking static
//     finding) sets the gate marker through markers.setGate, which writes
//     only for a sha on main, naming every check the run needed. A failure of
//     the gate itself (no commit, a failed fetch, an env file it did not
//     write, an npm ci that failed, which is as often the registry as the
//     lock, a pre-step or smoke that did not run, a stub that could not
//     start) writes no marker, since a marker for a missing key would wedge every
//     ship until a new commit landed. The output says which kind it was. The
//     reason given to setGate is a descriptor (gate, suite file names, exit,
//     counts), never a line of suite output: ci-smoke is reset from
//     production, so that output can carry production-derived data.
//   - The marker names only the verdict checks (static checks, money,
//     client) the failing run did not prove: the one that failed and every
//     one it never reached, never one that passed first and never npm ci.
//   - A pass clears a gate marker when the sha fixes it forward or is the
//     marker's own sha (markers.clearGateIfDescendant with self: a re-test of
//     main's tip after a transient failure, never a reset), and this run
//     re-ran and passed what each entry requires: every check it names when
//     its sha is on origin/main (its changes shipped untested), otherwise only
//     those this run's range needed (an unshipped failing change is still
//     inside origin/main..sha, so the range demands the right checks, and a
//     range that nets to nothing, a revert, sends none of it to prod).
//   - A receipt (version 2) records the stubs that ran in place of a real
//     command (`stubbed`); checkShaReceipt refuses such a receipt unless the
//     caller says stubs are allowed (the hook: DRB_GATE_ALLOW_STUBBED=1, set
//     by throwaway tests only), so a test run never vouches for a push, and a
//     stubbed run clears a marker only under the same variable.
//   - The smoke's TAP directory outlives the worktree: on every ending after
//     the smoke started (a pass, either kind of failure, a throw, a stop
//     signal) <wt>/.gate-smoke is moved to <common dir>/drb-gate/<sha>.smoke/
//     before the worktree goes, replacing an earlier one whole, so a failed
//     gate leaves logs a person can read. The PASSED and FAILED lines name it.
// The caller holds the push-gate lock; the smoke takes the smoke lock itself,
// so the order is push-gate, then smoke (decision 10).
//
// Test overrides, each named in one stderr line when set: DRB_GATE_SMOKE_CMD
// (run as <path> --tap-dir <dir> in place of the smoke, with the scrubbed
// environment; it must write summary.json), DRB_GATE_BUILD_CMD (run as <path>
// in <wt>/client with CI=true), DRB_GATE_INSTALL_CMD (run as <path> ci in each
// directory being installed) and DRB_GATE_STATIC_CMD (run as <path> --base
// <base> --tip <sha> in the worktree in place of static-checks.js; it must
// print static-checks' JSON).

const fs = require('fs');
const path = require('path');
const GP = require('./gatePaths');
const M = require('./markers');
const WL = require('./worktreeLinks');
const R = require('./receipt');
const W = require('./shaGateWorktree');

const { git, describe, gateRoots, gateWorktreePath, lstatOrNull, removeWorktree, keepSmoke, sweepGateWorktrees, runChild, stopChild } = W;

// Version 2 added `stubbed`; an older receipt reads as its version and is
// refused by it.
const VERSION = 2;
const VERDICT_CHECKS = Object.freeze(['static checks', 'money', 'client']);
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const STOP_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP']);
const SCRUBBED_KEYS = Object.freeze(['PATH', 'HOME', 'LANG', 'TMPDIR', 'NEON_API_KEY']);
const NODE_MODULES = Object.freeze(['linked', 'npm ci', null]);
const ENV_FILES = Object.freeze(['.env', 'client/.env']);
const GATE_ENV_KEYS = Object.freeze(['NODE_ENV', 'SEND_NOTIFICATIONS', 'RUN_SCHEDULERS', 'JWT_SECRET', 'ENCRYPTION_KEY', 'STRIPE_TEST_MODE_UNTIL', 'STRIPE_SECRET_KEY']);
const OVERRIDES = Object.freeze([
  { key: 'static', env: 'DRB_GATE_STATIC_CMD', what: 'scripts/static-checks.js' },
  { key: 'smoke', env: 'DRB_GATE_SMOKE_CMD', what: 'the money smoke' },
  { key: 'build', env: 'DRB_GATE_BUILD_CMD', what: 'the client build' },
  { key: 'install', env: 'DRB_GATE_INSTALL_CMD', what: 'npm' },
]);

// ---- the env file (decision 3) -------------------------------------------------

// The values the gate worktree's .env holds. Both fixed secrets are built from
// parts at runtime: written whole, either would read as a token to the
// pre-step and to the push-range scan. JWT_SECRET clears the server's
// 32-character floor; ENCRYPTION_KEY is the 64-hex shape encryption.js reads.
// STRIPE_SECRET_KEY is a placeholder, not a credential: stripeClient.js builds
// the client only when the key is set, and the webhook and payroll suites need
// the client object (stripe.webhooks for local signature work, a stubbed fee
// source), never an API call. The SDK checks only that the key is non-empty,
// so the client constructs and any real call from the gate fails at Stripe.
function gateEnvValues() {
  return {
    NODE_ENV: 'test',
    SEND_NOTIFICATIONS: 'false',
    RUN_SCHEDULERS: 'false',
    JWT_SECRET: ['gate', 'only', 'throwaway', 'signing', 'secret', 'never', 'live'].join('-'),
    ENCRYPTION_KEY: '0123456789abcdef'.repeat(4),
    STRIPE_TEST_MODE_UNTIL: '',
    STRIPE_SECRET_KEY: ['gate', 'placeholder', 'not', 'a', 'stripe', 'key'].join('-'),
  };
}

// The text of the gate worktree's .env, one KEY=value per line in
// GATE_ENV_KEYS order. No live or real Stripe key (the secret key is the
// placeholder above), no publishable or webhook key, and no DATABASE_URL (the
// smoke sets it per suite).
function gateEnvFile() {
  const v = gateEnvValues();
  return `${GATE_ENV_KEYS.map((k) => `${k}=${v[k]}`).join('\n')}\n`;
}

// ---- paths -------------------------------------------------------------------

// The receipt's path for a full sha; anything else is a caller's bug.
function receiptPath(sha, { cwd } = {}) {
  if (typeof sha !== 'string' || !R.KEY_RE.test(sha)) throw new TypeError('receiptPath: a full sha is required');
  return path.join(R.commonDir({ cwd }), 'drb-gate', `${sha}.json`);
}

// ---- git -------------------------------------------------------------------------

// The full sha a ref names as a commit, or null when it names none.
function resolveOrNull(ref, cwd) {
  if (typeof ref !== 'string' || ref === '' || /[\0\n]/.test(ref)) return null;
  const r = git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  const out = r.status === 0 ? r.stdout.trim() : '';
  return R.KEY_RE.test(out) ? out : null;
}

// ---- the classification ---------------------------------------------------------

// What the range base..tip needs, from the two-tree diff gatePaths.touches
// reads (never the tip commit alone). nothing_to_run is true only when no
// gate, no pre-step and no install is needed, which an empty range and a
// docs-only range satisfy by construction (the docs allowlist holds no path
// under server/, client/, the money paths or the install paths).
function classifyRange(base, tip, { cwd } = {}) {
  const touches = GP.touches(base, tip, cwd === undefined ? {} : { cwd });
  const needed = [];
  if (touches.money) needed.push('money');
  if (touches.client) needed.push('client');
  const statik = Boolean(touches.server || touches.client);
  const install = Boolean(touches.install || touches.client_install);
  const nothing = touches.files.length === 0 || (needed.length === 0 && !statik && !install);
  return { touches, needed, static: statik, install, nothing_to_run: nothing };
}

// ---- the receipt ----------------------------------------------------------------

const strings = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string');
const isSha = (x) => typeof x === 'string' && R.KEY_RE.test(x);

function isShaReceipt(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || v.version !== VERSION) return false;
  if (![v.sha, v.tree, v.base].every(isSha)) return false;
  if (![v.files, v.gates_needed, v.gates_passed, v.env_keys, v.stubbed].every(strings)) return false;
  if (typeof v.nothing_to_run !== 'boolean' || !NODE_MODULES.includes(v.node_modules)) return false;
  const sc = v.static_checks;
  if (sc !== null && !(sc && typeof sc === 'object' && Number.isInteger(sc.blocking) && sc.blocking >= 0 && (sc.file === null || typeof sc.file === 'string'))) return false;
  return typeof v.started_at === 'string' && typeof v.finished_at === 'string';
}

// The receipt for a sha (a full sha, or a ref that resolves to one): the
// parsed object, null when there is no file, or {unreadable: true, path}
// when the file exists and is neither a version 2 receipt with every field
// nor an older one (an integer version and a full sha), which is returned as
// it is so checkShaReceipt refuses it by its version.
function readShaReceipt(sha, { cwd } = {}) {
  const full = isSha(sha) ? sha : resolveOrNull(sha, cwd === undefined ? process.cwd() : cwd);
  if (!full) return null;
  const file = receiptPath(full, { cwd });
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    if (err && ['EACCES', 'EPERM', 'EISDIR', 'ELOOP', 'ENOTDIR'].includes(err.code)) return { unreadable: true, path: file };
    throw err;
  }
  let v;
  try {
    v = JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) return { unreadable: true, path: file };
    throw err;
  }
  if (isShaReceipt(v)) return v;
  const older = v && typeof v === 'object' && !Array.isArray(v) && Number.isInteger(v.version) && v.version !== VERSION && isSha(v.sha);
  return older ? v : { unreadable: true, path: file };
}

// Writes the receipt atomically (receipt.writeJsonAtomic makes the directory)
// and returns its path. A receipt missing a field is a caller's bug.
function writeShaReceipt(receipt, { cwd } = {}) {
  if (!isShaReceipt(receipt)) throw new TypeError('writeShaReceipt: not a version 2 sha receipt with every field');
  const file = receiptPath(receipt.sha, { cwd });
  R.writeJsonAtomic(file, receipt);
  return file;
}

// Null when the receipt is good for a push of `sha` onto `base` (the current
// origin/main) needing `needed`, else one reason. Pure: the caller passes the
// receipt it read. nothing_to_run stands in for an empty needed list and
// never for a non-empty one, and a receipt whose own run left a needed gate
// unpassed, or recorded a blocking static finding, never vouches.
function checkShaReceipt(receipt, { sha, base, needed = [], now = Date.now(), stubbedOk = false } = {}) {
  if (!receipt) return 'no sha receipt (run: npm run ship)';
  if (receipt.unreadable) return `the sha receipt ${receipt.path} is unreadable (run: npm run ship)`;
  if (receipt.version !== VERSION) return `the sha receipt is version ${JSON.stringify(receipt.version)}, not ${VERSION} (run: npm run ship)`;
  if (receipt.sha !== sha) return `the sha receipt is for ${R.short(receipt.sha)}, not ${R.short(sha)}`;
  if (receipt.base !== base) return `the sha receipt was gated against origin/main at ${R.short(receipt.base)}; origin/main is now ${R.short(base)} (run: npm run ship)`;
  if (!M.isZonedTime(receipt.finished_at)) return 'the sha receipt\'s finished_at is unreadable';
  const age = now - Date.parse(receipt.finished_at);
  if (age < 0) return 'the sha receipt is dated in the future';
  if (age > MAX_AGE_MS) return `the sha receipt is ${(age / DAY_MS).toFixed(1)} days old (max ${MAX_AGE_MS / DAY_MS}); run: npm run ship`;
  const stubs = Array.isArray(receipt.stubbed) ? receipt.stubbed : [];
  if (stubs.length && stubbedOk !== true) return `the sha receipt was written with stubs in place of ${stubs.join(', ')}; a stubbed gate never vouches for a push`;
  const passed = Array.isArray(receipt.gates_passed) ? receipt.gates_passed : [];
  const own = (Array.isArray(receipt.gates_needed) ? receipt.gates_needed : []).filter((g) => !passed.includes(g));
  if (own.length) return `the gate at ${R.short(sha)} did not pass: ${own.join(', ')}`;
  if (receipt.static_checks && receipt.static_checks.blocking > 0) return `the gate at ${R.short(sha)} recorded ${receipt.static_checks.blocking} blocking static finding(s)`;
  const want = Array.isArray(needed) ? needed : [];
  if (!want.length) return receipt.nothing_to_run === true || passed.length ? null : 'the sha receipt records no gate and is not nothing_to_run';
  const missing = want.filter((g) => !passed.includes(g));
  if (missing.length) return `the sha receipt does not cover: ${missing.join(', ')}${receipt.nothing_to_run ? ' (it says nothing to run, which never stands for a needed gate)' : ''}`;
  return null;
}

const pending = () => new Promise(() => {});

// ---- verdicts ----------------------------------------------------------------------

const own = (reason) => ({ kind: 'own', reason });
const code = (reason) => ({ kind: 'code', reason });

// A finding that says a check did not run is the pre-step failing, not the code.
function didNotRunFinding(f) {
  return f.rule === 'did-not-run' || /did not run/.test(String(f.text || '')) || (f.file === null && f.line === null);
}

// static-checks' JSON: {blocking, file} or a failure of the gate's own.
function staticVerdict(r) {
  if (r.error || r.signal) return own(`the static checks did not run (${describe(r)})`);
  if (r.status !== 0 && r.status !== 1) return own(`the static checks did not run (${describe(r)})`);
  let v;
  try {
    v = JSON.parse(r.out);
  } catch (err) {
    if (err instanceof SyntaxError) return own(`the static checks printed no JSON (${describe(r)})`);
    throw err;
  }
  if (!v || typeof v !== 'object' || !Number.isInteger(v.blocking) || !Array.isArray(v.findings)) return own('the static checks printed JSON that is not their report');
  if ((v.blocking > 0) !== (r.status === 1)) return own(`the static checks' exit (${r.status}) disagrees with their ${v.blocking} blocking finding(s)`);
  const first = v.findings.find((f) => f && typeof f === 'object' && f.blocking === true);
  if (v.blocking > 0 && (!first || didNotRunFinding(first))) return own(`the static checks did not run (${first ? first.rule : 'no blocking finding listed'})`);
  return { kind: 'pass', blocking: v.blocking, file: first && typeof first.file === 'string' ? first.file : null };
}

// The smoke's summary.json: a pass only when skipped is false, there is no
// did_not_run, total_fail is 0 and the smoke exited 0.
function smokeVerdict(r, tapDir) {
  if (r.error || r.signal) return own(`the money smoke did not finish (${describe(r)})`);
  const file = path.join(tapDir, 'summary.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && ['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR'].includes(err.code)) return own(`the money smoke left no readable summary.json (${err.code}, ${describe(r)})`);
    throw err;
  }
  let s;
  try {
    s = JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) return own('the money smoke\'s summary.json is not JSON');
    throw err;
  }
  if (!s || typeof s !== 'object' || !Array.isArray(s.suites) || typeof s.total_fail !== 'number') return own('the money smoke\'s summary.json is not a smoke summary');
  if (s.skipped !== false) return own('the money smoke SKIPPED (no Neon key resolved); a skip is never a pass');
  if (s.did_not_run !== undefined && s.did_not_run !== null) return own(`the money smoke did not run (${M.clean(s.did_not_run)})`);
  if (s.total_fail > 0) {
    const failing = s.suites.filter((x) => x && x.ok !== true).map((x) => path.basename(String(x.file)));
    const names = failing.length ? `; failing: ${failing.slice(0, 3).join(', ')}${failing.length > 3 ? `, and ${failing.length - 3} more` : ''}` : '';
    return code(`money smoke: ${s.total_fail} failing of ${s.suites.length} suite(s), ${describe(r)}${names}`);
  }
  if (r.status !== 0) return own(`the money smoke ${describe(r)} with a passing summary`);
  return { kind: 'pass' };
}

// ---- the gate ---------------------------------------------------------------------

function overridesFrom(env, warn) {
  const ov = {};
  for (const o of OVERRIDES) {
    const v = env[o.env];
    if (typeof v === 'string' && v !== '') {
      ov[o.key] = v;
      warn(`gate: ${o.env} is set; ${v} runs in place of ${o.what}`);
    }
  }
  return ov;
}

function smokeEnv(env) {
  const out = {};
  for (const k of SCRUBBED_KEYS) if (typeof env[k] === 'string' && env[k] !== '') out[k] = env[k];
  return { ...out, ...gateEnvValues() };
}

function finish(ctx, kind, reason) {
  const { receipt, log, warn } = ctx;
  const s7 = R.short(ctx.full);
  const kept = keepSmoke({ wt: ctx.wt, sha: ctx.full, cwd: ctx.cwd }) || ctx.smokeDir || null;
  ctx.smokeDir = kept;
  const logs = kept ? ` (smoke logs: ${kept})` : '';
  receipt.gates_passed = [...ctx.passed];
  receipt.stubbed = [...ctx.stubbed];
  receipt.finished_at = new Date().toISOString();
  const file = writeShaReceipt(receipt, { cwd: ctx.cwd });
  let marker;
  if (kind === 'pass') {
    const covered = receipt.nothing_to_run ? 'nothing to run' : receipt.gates_passed.join(' + ');
    const stubs = receipt.stubbed.length ? ` (stubbed: ${receipt.stubbed.join(', ')})` : '';
    log(`gate: PASSED at ${s7} (${covered})${stubs}${logs}`);
    marker = clearMarker(ctx);
  } else if (kind === 'code') {
    warn(`gate: FAILED at ${s7}: ${reason}${logs}`);
    warn('gate: a verdict about the code at that sha');
    marker = setMarker(ctx, kept ? `${reason}; smoke logs kept beside the sha receipt` : reason);
  } else {
    warn(`gate: FAILED at ${s7}: ${reason}${logs}`);
    warn('gate: a failure of the gate itself; nothing was proven about the code, so no gate marker is written');
    marker = { written: false, reason: 'a failure of the gate itself writes no marker' };
  }
  return { ok: kind === 'pass', kind, receipt, receiptPath: file, marker, smokeDir: kept, reason: kind === 'pass' ? null : `${reason}${kept ? `; smoke logs in ${kept}` : ''}` };
}

// Whether a marker entry's sha is on origin/main (the fetched base); a sha
// git cannot place counts as shipped, the strict side.
function shipped(sha, ctx) {
  try {
    return R.isAncestor(sha, ctx.base, { cwd: ctx.cwd });
  } catch (err) {
    if (err instanceof Error && /merge-base --is-ancestor failed/.test(err.message)) return true;
    throw err;
  }
}

// On a pass: the standing marker is cleared when the sha fixes it forward or
// is its own sha, and this run re-ran and passed (ctx.ran) what each entry
// requires (see the header). A stubbed run clears only under
// DRB_GATE_ALLOW_STUBBED=1.
function clearMarker(ctx) {
  const { log, warn } = ctx;
  const s7 = R.short(ctx.full);
  const cur = M.gate({ cwd: ctx.cwd });
  if (!cur) {
    log('gate: no gate marker stands');
    return { cleared: false, marker: null };
  }
  if (cur.unreadable) {
    warn(`gate: the gate marker ${cur.path} is unreadable; left for a person to repair`);
    return { cleared: false, marker: cur };
  }
  if (ctx.stubbed.length && ctx.env.DRB_GATE_ALLOW_STUBBED !== '1') {
    log(`gate: the gate marker on ${R.short(cur.sha)} stands; a run with stubs in place of ${ctx.stubbed.join(', ')} never clears one (DRB_GATE_ALLOW_STUBBED is not set)`);
    return { cleared: false, marker: cur };
  }
  for (const e of [cur, ...(cur.earlier || [])]) {
    const named = Array.isArray(e.gates) ? e.gates : [];
    const required = shipped(e.sha, ctx) ? named : named.filter((g) => ctx.needs.includes(g));
    const missing = required.filter((g) => !ctx.ran.includes(g));
    if (missing.length) {
      log(`gate: the gate marker on ${R.short(cur.sha)} stands; this run did not re-run ${missing.join(', ')}, which the failure on ${R.short(e.sha)} still requires`);
      return { cleared: false, marker: cur };
    }
  }
  const res = M.clearGateIfDescendant(ctx.full, { cwd: ctx.cwd, self: true });
  if (res.cleared) log(`gate: cleared the gate marker on ${R.short(res.marker.sha)} (${res.marker.sha === ctx.full ? 're-run on its own sha' : 'fix forward'})`);
  else if (res.marker && !res.marker.unreadable) log(`gate: the gate marker on ${R.short(res.marker.sha)} stands; ${s7} is not a sha on main that fixes it`);
  else if (!res.marker) log('gate: no gate marker stands');
  else warn(`gate: the gate marker ${res.marker.path} is unreadable; left for a person to repair`);
  return res;
}

function setMarker(ctx, reason) {
  const s7 = R.short(ctx.full);
  let res;
  try {
    const unproven = ctx.needs.filter((g) => VERDICT_CHECKS.includes(g) && !ctx.ran.includes(g));
    res = M.setGate({ sha: ctx.full, reason, gates: unproven, cwd: ctx.cwd });
  } catch (err) {
    if (err && err.code === 'GATE_RESOLVE_FAILED') {
      ctx.warn(`gate: ${err.message}`);
      return { written: false, reason: err.message };
    }
    throw err;
  }
  if (res.written && res.uncertain) ctx.warn(`gate: gate marker written on ${s7} (git could not place it for certain); it binds every push`);
  else if (res.written) ctx.warn(`gate: gate marker written on ${s7}; it binds every push until a descendant passes`);
  else ctx.warn(`gate: no gate marker: ${res.reason}`);
  return res;
}

// The override for `key`, recorded in ctx.stubbed when it runs; else null.
function stubbed(ctx, key) {
  const cmd = ctx.ov[key] || null;
  if (cmd && !ctx.stubbed.includes(key)) ctx.stubbed.push(key);
  return cmd;
}

// The steps inside the worktree, in order; every ending goes through finish.
async function gateInWorktree(ctx, state) {
  const { cls, ov, env, log, warn, wt, primary, base, full } = ctx;
  const s7 = R.short(full);
  // Set before the add: an add that fails partway can leave a directory and a
  // registration, and cleanup removes whatever is there.
  state.wt = wt;
  const add = git(primary, ['worktree', 'add', '--detach', '--quiet', wt, full]);
  if (add.status !== 0) return finish(ctx, 'own', `git worktree add failed (${describe(add)})`);
  log(`gate: worktree ${wt} at ${s7}`);
  for (const rel of ENV_FILES) {
    if (lstatOrNull(path.join(wt, rel))) return finish(ctx, 'own', `the gate worktree already holds ${rel} (it is in the commit); the gate writes its own env file and refuses one it did not write`);
  }
  if (cls.install) {
    for (const rel of ['.', 'client']) {
      const dir = path.join(wt, rel);
      if (rel !== '.' && !fs.existsSync(path.join(dir, 'package.json'))) {
        log(`gate: no client/package.json at ${s7}; the client npm ci is skipped`);
        continue;
      }
      // A real directory first, so the shared node_modules can never be
      // linked in where a private install belongs.
      fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
      log(`gate: npm ci in ${rel === '.' ? 'the worktree root' : 'client/'}`);
      const r = await runChild(state, stubbed(ctx, 'install') || 'npm', ['ci'], { cwd: dir, env: { ...env, HUSKY: '0' } });
      if (state.stopping) return pending();
      if (r.error || r.signal) return finish(ctx, 'own', `npm ci in ${rel} did not finish (${describe(r)})`);
      if (r.status !== 0) return finish(ctx, 'own', `npm ci in ${rel}: ${describe(r)}`);
    }
    ctx.receipt.node_modules = 'npm ci';
    ctx.ran.push('npm ci');
  }
  const links = WL.linkInto(wt, primary, { env: false, log: (l) => log(`gate:${l}`), warn: (l) => warn(`gate:${l}`) });
  if (!cls.install) {
    const made = (rel) => links.linked.includes(rel) || links.present.includes(rel);
    if (!made('node_modules')) return finish(ctx, 'own', `the shared node_modules at ${primary} was not linked into the gate worktree`);
    if (cls.needed.includes('client') && !made('client/node_modules')) return finish(ctx, 'own', `the shared client/node_modules at ${primary} was not linked into the gate worktree`);
    ctx.receipt.node_modules = 'linked';
  }
  fs.writeFileSync(path.join(wt, '.env'), gateEnvFile(), { flag: 'wx', mode: 0o600 });
  ctx.receipt.env_keys = [...GATE_ENV_KEYS];
  log(`gate: wrote the gate env file (${GATE_ENV_KEYS.join(', ')})`);

  if (cls.static) {
    log(`gate: static checks over ${R.short(base)}..${s7}`);
    const args = ['--base', base, '--tip', full];
    const r = await runChild(state, stubbed(ctx, 'static') || process.execPath, ov.static ? args : [path.join(wt, 'scripts', 'static-checks.js'), ...args], { cwd: wt, env, keep: 'stdout' });
    if (state.stopping) return pending();
    const v = staticVerdict(r);
    if (v.kind === 'own') return finish(ctx, 'own', v.reason);
    ctx.receipt.static_checks = { blocking: v.blocking, file: v.file };
    if (v.blocking > 0) return finish(ctx, 'code', `static checks: ${v.blocking} blocking finding(s), the first in ${v.file === null ? 'no file' : v.file}`);
    ctx.ran.push('static checks');
  }
  if (cls.needed.includes('money')) {
    const tapDir = path.join(wt, '.gate-smoke');
    log('gate: the money smoke, in the gate worktree under the gate env file (about eight minutes; it waits on the smoke lock)');
    const args = ['--tap-dir', tapDir];
    const r = await runChild(state, stubbed(ctx, 'smoke') || process.execPath, ov.smoke ? args : [path.join(wt, 'scripts', 'testdb-smoke.js'), ...args], { cwd: wt, env: smokeEnv(env) });
    if (state.stopping) return pending();
    const v = smokeVerdict(r, tapDir);
    if (v.kind !== 'pass') return finish(ctx, v.kind, v.reason);
    ctx.passed.push('money');
    ctx.ran.push('money');
    log('gate: money smoke passed');
  }
  if (cls.needed.includes('client')) {
    log('gate: the client build (CI=true react-scripts build)');
    const r = await runChild(state, stubbed(ctx, 'build') || 'npx', ov.build ? [] : ['react-scripts', 'build'], { cwd: path.join(wt, 'client'), env: { ...env, CI: 'true' }, keep: 'tail' });
    if (state.stopping) return pending();
    if (r.error || r.signal) return finish(ctx, 'own', `the client build did not finish (${describe(r)})`);
    if (r.status !== 0) {
      const lines = r.out.trim().split('\n').slice(-25);
      warn('gate: last 25 lines of the client build:');
      warn(lines.join('\n') || '(no output)');
      return finish(ctx, 'code', `client build: ${describe(r)}`);
    }
    ctx.passed.push('client');
    ctx.ran.push('client');
    log('gate: client build passed');
  }
  return finish(ctx, 'pass');
}

// The gate on one sha, in order: resolve, fetch origin main in the primary
// root, classify origin/main..sha, then nothing_to_run (a receipt, no
// worktree) or the worktree steps. Returns {ok, kind, receipt, receiptPath,
// marker, reason} and never throws for an ordinary failure; it prints the
// receipt path as its last stdout line on every run that wrote one.
async function runShaGate({ sha, cwd = process.cwd(), log = console.log, warn = console.error, overrides, env = process.env } = {}) {
  const ov = overrides || overridesFrom(env, warn);
  const startedAt = new Date().toISOString();
  const refuse = (reason) => {
    warn(`gate: ${reason}`);
    return { ok: false, kind: 'own', receipt: null, receiptPath: null, marker: null, reason };
  };
  const full = resolveOrNull(String(sha === undefined ? '' : sha), cwd);
  if (!full) return refuse(`${M.clean(sha)} names no commit; nothing was gated`);
  const roots = gateRoots({ cwd });
  log('gate: git fetch origin main');
  const fetched = git(roots.primary, ['fetch', '--quiet', 'origin', 'main'], { ...R.gitEnv(), GIT_TERMINAL_PROMPT: '0' });
  if (fetched.status !== 0) return refuse(`git fetch origin main failed (${describe(fetched)}); the range could not be classified and no receipt was written`);
  const base = resolveOrNull('refs/remotes/origin/main', roots.primary);
  if (!base) return refuse('no refs/remotes/origin/main after the fetch; no receipt was written');
  const treeRun = git(roots.primary, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${full}^{tree}`]);
  const tree = treeRun.stdout.trim();
  if (treeRun.status !== 0 || !isSha(tree)) return refuse(`git could not name the tree of ${R.short(full)}`);
  const cls = classifyRange(base, full, { cwd: roots.primary });
  const receipt = {
    version: VERSION, sha: full, tree, base, files: [...cls.touches.files], gates_needed: [...cls.needed], gates_passed: [],
    nothing_to_run: cls.nothing_to_run, static_checks: null, node_modules: null, env_keys: [], stubbed: [], started_at: startedAt, finished_at: startedAt,
  };
  const needs = [...cls.needed, ...(cls.static ? ['static checks'] : []), ...(cls.install ? ['npm ci'] : [])];
  log(`gate: ${R.short(full)} against origin/main ${R.short(base)}: ${cls.touches.files.length} file(s), needs ${needs.length ? needs.join(' + ') : 'nothing'}`);
  const ctx = { full, base, cls, needs, ov, env, log, warn, cwd, receipt, passed: [], ran: [], stubbed: [], primary: roots.primary, wt: null, smokeDir: null };
  if (cls.nothing_to_run) {
    const res = finish(ctx, 'pass');
    log(res.receiptPath);
    return res;
  }

  sweepGateWorktrees({ cwd: roots.primary, log });
  ctx.wt = gateWorktreePath(full, { cwd: roots.primary });
  if (lstatOrNull(ctx.wt)) removeWorktree(roots.primary, ctx.wt);
  const state = { child: null, wt: null, stopping: false };
  // True when a worktree (or what a failed add left) was there to remove.
  const cleanup = () => {
    if (!state.wt) return false;
    const wt = state.wt;
    state.wt = null;
    try {
      ctx.smokeDir = keepSmoke({ wt, sha: full, cwd }) || ctx.smokeDir;
    } finally {
      ctx.removed = removeWorktree(roots.primary, wt);
    }
    return ctx.removed;
  };
  const onStop = (sig) => {
    if (state.stopping) return;
    state.stopping = true;
    warn(`gate: ${sig} received; stopping the running step and removing the gate worktree`);
    stopChild(state).then(cleanup).finally(() => process.exit(1));
  };
  const onExit = () => cleanup();
  for (const sig of STOP_SIGNALS) process.on(sig, onStop);
  process.on('exit', onExit);
  let res;
  try {
    res = await gateInWorktree(ctx, state);
  } finally {
    if (!state.stopping) {
      for (const sig of STOP_SIGNALS) process.off(sig, onStop);
      process.off('exit', onExit);
      cleanup();
    }
  }
  if (ctx.removed) log('gate: removed the gate worktree');
  log(res.receiptPath);
  return res;
}

module.exports = {
  GATE_ENV_KEYS,
  gateRoots,
  MAX_AGE_MS,
  gateEnvFile,
  gateWorktreePath,
  classifyRange,
  receiptPath,
  readShaReceipt,
  writeShaReceipt,
  checkShaReceipt,
  sweepGateWorktrees,
  runShaGate,
};

#!/usr/bin/env node
'use strict';

/**
 * push-gate — the two mechanical pre-push gates, plus a receipt so they are
 * never run twice for the same code.
 *
 * WHY THIS EXISTS (2026-08-14). `git push` opens the SSH connection and pulls
 * the ref advertisement BEFORE it runs the pre-push hook. The hook then took
 * ~8 minutes (431s of money suites + ~60s client build), the connection sat
 * idle that whole time, and GitHub closed it; git then wrote the packfile into
 * a dead socket and the push failed AFTER passing every gate, silently. The
 * hook was fast until ~2026-08-11, when NEON_API_KEY was configured and the
 * money smoke went from a SKIP banner to a real 431s run, which is exactly
 * when the hangs started. SSH keepalives do not help: it is the remote closing
 * an idle git-receive-pack session, not a NAT dropping a TCP flow.
 *
 * The fix is not to weaken the gate, it is to stop DUPLICATING it. The review
 * pass already runs these same checks against this same tree; the hook then ran
 * them again and that second run is what broke the push. So: `npm run gate`
 * runs them once and writes a receipt, and the hook skips instantly when the
 * receipt matches. No receipt, or a receipt that does not cover this push, and
 * the hook runs the full gate exactly as before. Fail-closed is preserved.
 *
 * ── THE SAFETY PROPERTY ───────────────────────────────────────────────────
 * Skip ONLY when the exact bytes now on disk were already gated AND the commit
 * being pushed is the commit those bytes belong to. The 2026-08-14 push-gate
 * review (Claude fleet + codex + gemini, all three independently) broke the
 * first draft of this file on five distinct paths; each guard below exists
 * because one of them shipped ungated code in a scratch repo:
 *
 *   1. CONTENT, not status. `git status --porcelain` reports a path and a
 *      status letter, never bytes, so re-editing an ALREADY-modified file left
 *      the fingerprint identical and the receipt valid. The fingerprint now
 *      hashes the CONTENT of every modified and untracked path.
 *   2. THE PUSHED COMMIT MUST BE HEAD. Both gates execute against the WORKING
 *      TREE (testdb-smoke runs the on-disk suites, the build builds the
 *      checkout), so they only describe HEAD. `git push origin <sha>:main` with
 *      a sha that is not HEAD ships code the gates never looked at. A receipt
 *      is now only valid when every pushed sha IS HEAD.
 *   3. EVERY ref, not the first. A multi-ref push feeds one line per ref and
 *      the old loop returned on the first, so `git push origin docs-branch main`
 *      gated the docs branch and skipped the money gate for main.
 *   4. MALFORMED stdin is unknown, not empty. A truncated line with no second
 *      field used to read as "deletions only" and skip everything.
 *   5. A SKIPPED money gate is not a PASSED money gate. testdb-smoke exits 0
 *      with a red banner when no NEON_API_KEY resolves; recording that as a
 *      pass laundered it into a green checkmark for 12 hours.
 *
 * KNOWN AND ACCEPTED LIMITS, stated because overstating them is how the first
 * draft went wrong:
 *   - GITIGNORED files are outside the fingerprint (`.env`, `client/.env*`,
 *     `~/.secrets/*`, node_modules). They can change what the gates do. The
 *     12h expiry is the only backstop, and the money-skip guard above closes
 *     the one case that actually mattered.
 *   - The receipt is a plain local file. Anything that can write it can also
 *     run `git push --no-verify`, so it is not a privilege boundary and is not
 *     treated as one.
 */

const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RECEIPT_VERSION = 2;
// Generous: the fingerprint pins the bytes exactly, so age only guards drift in
// EXTERNAL state the gates also depend on (the ci-smoke branch resets from
// prod; gitignored env files are invisible here). Twelve hours keeps a normal
// review-then-push cycle instant while expiring a receipt from yesterday.
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

// Paths whose change alters what the MONEY gate does or tests. server/ is the
// obvious one; the rest are the gate's own machinery and the dependency set it
// executes under, which a pure server/ trigger would have missed.
const MONEY_PATHS = [
  'server/',
  'scripts/money-smoke-list.txt',
  'scripts/testdb-smoke.js',
  'scripts/push-gate.js',
  'package.json',
  'package-lock.json',
];
const CLIENT_PATHS = ['client/'];

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }).trim();
}

function gitQuiet(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout || '').trim() };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function receiptPath() {
  // --absolute-git-dir resolves correctly inside a linked worktree, where .git
  // is a file, so each worktree keeps its own receipt.
  return path.join(git(['rev-parse', '--absolute-git-dir']), 'drb-push-gate-receipt.json');
}

/**
 * Every path git considers modified or untracked, with its status code.
 * Uses -z so paths containing spaces, quotes or newlines survive; rename and
 * copy entries carry a second NUL-terminated path that must be consumed.
 */
function dirtyEntries() {
  const raw = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const parts = raw.split('\0').filter((p) => p.length > 0);
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (/^[RC]/.test(code)) i += 1; // consume the origin path of a rename/copy
    out.push({ code, file });
  }
  return out;
}

/**
 * Fingerprint of exactly what the gates would test: HEAD, plus the CONTENT of
 * every modified and untracked file. Content, not just the status line: the
 * review proved that hashing the porcelain text alone let a re-edit of an
 * already-dirty file keep a valid receipt.
 */
function treeFingerprint() {
  const head = git(['rev-parse', 'HEAD']);
  const rows = dirtyEntries().map(({ code, file }) => {
    let contentHash;
    try {
      const st = fs.lstatSync(file);
      // NOTE isSymbolicLink(), not isSymlink() — the latter does not exist, and
      // writing it threw a TypeError that the catch below swallowed into a
      // constant, so the fingerprint silently stopped depending on content at
      // all. Caught only because a test asserted the hash MOVES on an edit.
      // That is why this catch is now narrow: a programming error here disables
      // the safety property while still looking like it works.
      if (st.isSymbolicLink()) contentHash = `symlink:${sha256(fs.readlinkSync(file))}`;
      else if (st.isFile()) contentHash = sha256(fs.readFileSync(file));
      else if (st.isDirectory()) contentHash = 'dir';
      else contentHash = 'special';
    } catch (err) {
      // A vanished or unreadable file is expected (a staged deletion, a
      // permissions problem) and is legitimately "not the bytes we gated".
      // Anything else is a bug in this function and must be loud.
      if (err && (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM')) contentHash = `missing:${err.code}`;
      else throw err;
    }
    return `${code}|${file}|${contentHash}`;
  });
  rows.sort();
  const fingerprint = sha256(`${head}\n${rows.join("\n")}`);
  return { head, fingerprint, dirty: rows.length > 0, dirtyCount: rows.length };
}

/** origin/main when it exists; null on a first push. */
function diffBase() {
  const r = gitQuiet(['rev-parse', '--verify', '--quiet', 'origin/main']);
  return r.ok && r.out ? 'origin/main' : null;
}

/**
 * Which gates these pushed refs need, unioned over ALL of them. A multi-ref
 * push must gate every ref, not the first one git happened to list.
 */
function neededGates(refs) {
  const list = Array.isArray(refs) ? refs : [refs];
  const base = diffBase();
  if (!base) return { gates: ['money', 'client'], base: null, reason: 'no origin/main yet, gating everything' };
  const gates = new Set();
  for (const ref of list) {
    if (!gitQuiet(['diff', '--quiet', base, ref, '--', ...MONEY_PATHS]).ok) gates.add('money');
    if (!gitQuiet(['diff', '--quiet', base, ref, '--', ...CLIENT_PATHS]).ok) gates.add('client');
  }
  return { gates: [...gates], base, reason: null };
}

function readReceipt() {
  try {
    const raw = JSON.parse(fs.readFileSync(receiptPath(), 'utf8'));
    if (!raw || raw.version !== RECEIPT_VERSION) return null;
    if (!Array.isArray(raw.gates)) return null; // malformed must never reach the accept branch
    if (typeof raw.fingerprint !== 'string' || typeof raw.head !== 'string') return null;
    return raw;
  } catch {
    return null;
  }
}

function writeReceipt({ fingerprint, head, gates }) {
  const receipt = { version: RECEIPT_VERSION, fingerprint, head, gates, at: new Date().toISOString() };
  fs.writeFileSync(receiptPath(), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

/**
 * Is the receipt good for this push? Returns a reason string when it is NOT,
 * so the hook can say plainly why it is about to spend eight minutes.
 *
 * `pushedShas` must all equal HEAD: the gates only ever describe the working
 * tree, so a receipt cannot vouch for a commit the tree is not sitting on.
 */
function checkReceipt(receipt, { fingerprint, head, needed, pushedShas = [], now = Date.now() }) {
  if (!receipt) return 'no receipt (run: npm run gate)';
  if (receipt.fingerprint !== fingerprint) return 'the working tree changed since the gate ran';
  if (receipt.head !== head) return 'HEAD moved since the gate ran';
  const foreign = pushedShas.filter((s) => s !== head);
  if (foreign.length) {
    return `pushing ${foreign[0].slice(0, 8)}, which is not HEAD (the gates only ever test the working tree)`;
  }
  const age = now - Date.parse(receipt.at);
  if (!Number.isFinite(age)) return 'receipt timestamp is unreadable';
  if (age < 0) return 'receipt is dated in the future';
  if (age > MAX_AGE_MS) return `receipt is ${Math.floor(age / 3600000)}h old (max ${MAX_AGE_MS / 3600000}h)`;
  const missing = needed.filter((g) => !receipt.gates.includes(g));
  if (missing.length) return `receipt does not cover: ${missing.join(', ')}`;
  return null;
}

/** The same key discovery testdb-smoke.js does, so we can tell run from skip. */
function neonKeyResolves() {
  if (process.env.NEON_API_KEY && process.env.NEON_API_KEY.trim()) return true;
  try {
    return fs.readFileSync(path.join(os.homedir(), '.secrets', 'neon_api_key'), 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

function describeSpawn(r) {
  if (r.error) return `could not start: ${r.error.code || r.error.message}`;
  if (r.signal) return `killed by ${r.signal}`;
  return `exit ${r.status}`;
}

/** @returns {{ok: boolean, ran: boolean}} ran=false means it SKIPPED, which is not a pass. */
function runMoneyGate() {
  if (!neonKeyResolves()) {
    // testdb-smoke would print its red SKIP banner and exit 0. Letting that
    // write a 'money' receipt turns a loud never-ran into a green checkmark
    // for 12 hours, so run it for the banner but refuse to bank it.
    console.log('gate: server/ changed — running the money-path smoke gate…');
    spawnSync(process.execPath, ['scripts/testdb-smoke.js'], { stdio: 'inherit' });
    console.log('gate: money smoke SKIPPED (no NEON_API_KEY) — NOT recorded as passed.');
    return { ok: true, ran: false };
  }
  console.log('gate: server/ changed — running the money-path smoke gate…');
  const r = spawnSync(process.execPath, ['scripts/testdb-smoke.js'], { stdio: 'inherit' });
  if (r.status === 0) return { ok: true, ran: true };
  console.error(`✗ BLOCKED — money smoke did not pass (${describeSpawn(r)}).`);
  console.error('  Emergencies only: git push --no-verify');
  return { ok: false, ran: false };
}

function runClientGate() {
  console.log('gate: client/ changed — running the Vercel-equivalent gate (CI=true react-scripts build, ~1 min)…');
  const r = spawnSync('npx', ['react-scripts', 'build'], {
    cwd: path.join(process.cwd(), 'client'),
    env: { ...process.env, CI: 'true' },
    stdio: 'pipe',
    encoding: 'utf8',
    maxBuffer: Infinity, // a truncated log would make "last 25 lines" show the cut, not the error
  });
  if (r.status === 0) {
    console.log('✓ gate: client build passed — the Vercel client deploy will not fail-compile.');
    return { ok: true, ran: true };
  }
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n');
  console.error('');
  console.error(`✗ BLOCKED — the client build failed (${describeSpawn(r)}). This WOULD fail the Vercel deploy.`);
  console.error('  ── last 25 lines ──────────────────────────────────────────');
  console.error(out.slice(-25).join('\n') || '  (no output: the build never started)');
  console.error('  ───────────────────────────────────────────────────────────');
  console.error('  Fix the errors above. Emergencies only: git push --no-verify');
  return { ok: false, ran: false };
}

/**
 * Run the needed gates against the tree, then write a receipt recording only
 * what genuinely RAN and passed. Re-fingerprints afterwards: an 8-minute run in
 * a shared checkout can finish against a different tree than it started on, and
 * banking that would vouch for bytes nothing ever gated.
 */
function runGates(needed, fpBefore) {
  const passed = [];
  if (needed.includes('money')) {
    const r = runMoneyGate();
    if (!r.ok) return false;
    if (r.ran) passed.push('money');
  }
  if (needed.includes('client')) {
    const r = runClientGate();
    if (!r.ok) return false;
    if (r.ran) passed.push('client');
  }
  if (!needed.length) console.log('gate: no gated paths changed — nothing to run.');

  const fpAfter = treeFingerprint();
  if (fpAfter.fingerprint !== fpBefore.fingerprint) {
    console.log('');
    console.log('gate: the working tree changed WHILE the gates ran, so no receipt was written.');
    console.log('      (another window edited files mid-run; the gates passed for the tree as it');
    console.log('       was, not as it is now). Re-run `npm run gate` when the tree is settled.');
    return true; // the gates themselves passed; we simply refuse to vouch for the new tree
  }
  writeReceipt({ fingerprint: fpAfter.fingerprint, head: fpAfter.head, gates: passed });
  return true;
}

/**
 * Every sha being pushed, from the hook's stdin, which git feeds as
 * `<local ref> <local sha> <remote ref> <remote sha>` per updated ref.
 *
 *   {kind:'shas', shas:[...]}  real refs are shipping; gate ALL of them
 *   {kind:'deletes'}           every line was an all-zero local sha, so no
 *                              code ships and there is nothing to gate
 *   {kind:'unknown'}           empty, a TTY, unreadable, or MALFORMED. Never a
 *                              free pass: the caller falls back to gating HEAD,
 *                              because "I cannot tell what is being pushed"
 *                              must fail closed.
 */
function parsePushedShas(input) {
  if (input === null || input === undefined) return { kind: 'unknown' };
  const lines = String(input).split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { kind: 'unknown' };
  const shas = [];
  for (const line of lines) {
    const fields = line.split(/\s+/);
    // A well-formed line has 4 fields. Anything shorter means we cannot read
    // this push, which is unknown, NOT "nothing to do".
    if (fields.length < 2) return { kind: 'unknown' };
    const localSha = fields[1];
    if (!/^[0-9a-fA-F]{7,64}$/.test(localSha)) return { kind: 'unknown' };
    if (!/^0+$/.test(localSha)) shas.push(localSha);
  }
  return shas.length ? { kind: 'shas', shas } : { kind: 'deletes' };
}

function readStdin() {
  if (process.stdin.isTTY) return { kind: 'unknown' };
  try {
    return parsePushedShas(fs.readFileSync(0, 'utf8'));
  } catch {
    return { kind: 'unknown' };
  }
}

function main() {
  const mode = process.argv[2] || 'run';
  const fp = treeFingerprint();

  if (mode === 'verify') {
    const parsed = readStdin();
    if (parsed.kind === 'deletes') {
      console.log('pre-push: deletions only — nothing to gate.');
      process.exit(0);
    }
    const pushedShas = parsed.kind === 'shas' ? parsed.shas : [];
    const refs = pushedShas.length ? pushedShas : ['HEAD'];
    const { gates: needed } = neededGates(refs);
    const why = checkReceipt(readReceipt(), {
      fingerprint: fp.fingerprint, head: fp.head, needed, pushedShas,
    });
    if (!why) {
      const receipt = readReceipt();
      const covered = receipt.gates.length ? receipt.gates.join(' + ') : 'nothing to run';
      console.log(`✓ pre-push: gate receipt valid for this exact tree (${covered}) — skipping the re-run.`);
      process.exit(0);
    }
    console.log(`pre-push: running the full gate — ${why}.`);
    const foreign = pushedShas.filter((s) => s !== fp.head);
    if (foreign.length) {
      console.log('');
      console.log(`pre-push: WARNING — you are pushing ${foreign[0].slice(0, 12)} but the working tree is at`);
      console.log(`          ${fp.head.slice(0, 12)}. Both gates test the WORKING TREE, so they describe`);
      console.log('          your checkout, NOT the commit being pushed. Check that commit out first if');
      console.log('          you want it gated.');
      console.log('');
    }
    process.exit(runGates(needed, fp) ? 0 : 1);
  }

  // `npm run gate` — validate the tree now, so the push itself is instant.
  const { gates: needed } = neededGates([process.argv[3] || 'HEAD']);
  if (fp.dirty) {
    console.log(`gate: NOTE ${fp.dirtyCount} uncommitted/untracked file(s) present. The gates test the tree`);
    console.log('      as it stands, and editing any of them invalidates the receipt.');
  }
  const ok = runGates(needed, fp);
  if (ok) {
    console.log('');
    console.log('✓ gate PASSED. The next push of this exact tree, at this HEAD, skips the hook.');
    console.log(`  Receipt: ${receiptPath()}`);
  }
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  checkReceipt, neededGates, treeFingerprint, parsePushedShas,
  RECEIPT_VERSION, MAX_AGE_MS, MONEY_PATHS, CLIENT_PATHS,
};

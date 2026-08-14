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
 * receipt matches. No receipt, or a receipt for different bytes, and the hook
 * runs the full gate exactly as before. Fail-closed is preserved.
 *
 * WHAT THE RECEIPT IS KEYED ON. Not the commit sha. Both gates test the WORKING
 * TREE (`testdb-smoke` runs the suites as they sit on disk; the client build
 * builds the checkout), and this is a SHARED checkout where a parallel window's
 * uncommitted edits have broken a push before. So the key is a fingerprint of
 * HEAD plus the full porcelain status including untracked files: "the exact
 * bytes I tested are the exact bytes on disk now." Any drift, from any window,
 * invalidates the receipt and the gate re-runs.
 */

const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RECEIPT_VERSION = 1;
// Generous: the fingerprint already pins the bytes exactly, so age only guards
// against drift in EXTERNAL state the gate also depends on (the ci-smoke branch
// resets from prod, so a prod schema change could invalidate a pass). Twelve
// hours keeps a normal review-then-push cycle instant while still expiring a
// receipt from yesterday.
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...opts }).trim();
}

function gitQuiet(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim() };
}

function receiptPath() {
  // --git-dir resolves correctly inside a worktree, where .git is a file.
  const gitDir = git(['rev-parse', '--absolute-git-dir']);
  return path.join(gitDir, 'drb-push-gate-receipt.json');
}

/**
 * Fingerprint of exactly what the gates would test: HEAD plus every tracked
 * modification and untracked file. A stray file under client/src can fail the
 * build, so untracked counts.
 */
function treeFingerprint() {
  const head = git(['rev-parse', 'HEAD']);
  const status = git(['status', '--porcelain', '--untracked-files=all']);
  const normalized = status.split('\n').map((l) => l.trim()).filter(Boolean).sort().join('\n');
  const h = crypto.createHash('sha256').update(`${head}\n${normalized}`).digest('hex');
  return { head, fingerprint: h, dirty: normalized.length > 0 };
}

/** origin/main when it exists; null on a first push. Mirrors the old hook. */
function diffBase() {
  const r = gitQuiet(['rev-parse', '--verify', '--quiet', 'origin/main']);
  return r.ok && r.out ? 'origin/main' : null;
}

/**
 * Which gates this push needs, by the SAME rules the hook always used: money
 * smoke when server/ or the smoke list changed, client build when client/
 * changed. `ref` is what is actually being pushed, which is NOT always HEAD:
 * the push model pushes a literal sha (`git push origin <sha>:main`), and the
 * old hook diffed HEAD regardless, so a push of an older sha could be gated
 * against code it was not shipping.
 */
function neededGates(ref) {
  const base = diffBase();
  if (!base) return { gates: ['money', 'client'], base: null, reason: 'no origin/main yet, gating everything' };
  const gates = [];
  if (!gitQuiet(['diff', '--quiet', base, ref, '--', 'server/', 'scripts/money-smoke-list.txt']).ok) gates.push('money');
  if (!gitQuiet(['diff', '--quiet', base, ref, '--', 'client/']).ok) gates.push('client');
  return { gates, base, reason: null };
}

function readReceipt() {
  try {
    const raw = JSON.parse(fs.readFileSync(receiptPath(), 'utf8'));
    return raw && raw.version === RECEIPT_VERSION ? raw : null;
  } catch {
    return null;
  }
}

function writeReceipt({ fingerprint, head, gates }) {
  const receipt = {
    version: RECEIPT_VERSION,
    fingerprint,
    head,
    gates,
    at: new Date().toISOString(),
  };
  fs.writeFileSync(receiptPath(), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

/**
 * Is the receipt good for this push? Returns a reason string when it is NOT,
 * so the hook can say plainly why it is about to spend eight minutes.
 */
function checkReceipt(receipt, { fingerprint, needed, now = Date.now() }) {
  if (!receipt) return 'no receipt (run: npm run gate)';
  if (receipt.fingerprint !== fingerprint) return 'the working tree changed since the gate ran';
  const age = now - Date.parse(receipt.at);
  if (!Number.isFinite(age)) return 'receipt timestamp is unreadable';
  if (age > MAX_AGE_MS) return `receipt is ${Math.floor(age / 3600000)}h old (max ${MAX_AGE_MS / 3600000}h)`;
  const missing = needed.filter((g) => !receipt.gates.includes(g));
  if (missing.length) return `receipt does not cover: ${missing.join(', ')}`;
  return null;
}

function runMoneyGate() {
  console.log('gate: server/ changed — running the money-path smoke gate…');
  const r = spawnSync(process.execPath, ['scripts/testdb-smoke.js'], { stdio: 'inherit' });
  return r.status === 0;
}

function runClientGate() {
  console.log('gate: client/ changed — running the Vercel-equivalent gate (CI=true react-scripts build, ~1 min)…');
  const r = spawnSync('npx', ['react-scripts', 'build'], {
    cwd: path.join(process.cwd(), 'client'),
    env: { ...process.env, CI: 'true' },
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (r.status === 0) {
    console.log('✓ gate: client build passed — the Vercel client deploy will not fail-compile.');
    return true;
  }
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n');
  console.error('');
  console.error('✗ BLOCKED — the client build failed. This WOULD fail the Vercel deploy.');
  console.error('  ── last 25 lines ──────────────────────────────────────────');
  console.error(out.slice(-25).join('\n'));
  console.error('  ───────────────────────────────────────────────────────────');
  return false;
}

/** Run the needed gates against the tree; write a receipt only on success. */
function runGates(needed, fp) {
  if (!needed.length) {
    console.log('gate: no server/ or client/ changes — nothing to run.');
    writeReceipt({ fingerprint: fp.fingerprint, head: fp.head, gates: [] });
    return true;
  }
  // Money first: it fails faster than the client build (kept from the old hook).
  if (needed.includes('money') && !runMoneyGate()) return false;
  if (needed.includes('client') && !runClientGate()) return false;
  writeReceipt({ fingerprint: fp.fingerprint, head: fp.head, gates: needed });
  return true;
}

/**
 * The sha actually being pushed, read from the hook's stdin, which git feeds as
 * `<local ref> <local sha> <remote ref> <remote sha>` per updated ref.
 *
 * Returns a DISCRIMINATED result, because the two "no sha" cases must not be
 * treated alike and getting that backwards silently disables the whole gate:
 *   {kind:'sha'}      a real ref is being pushed, gate it
 *   {kind:'deletes'}  every line was an all-zero local sha, i.e. branch
 *                     deletions only, so no code ships and there is nothing
 *                     to gate
 *   {kind:'unknown'}  stdin was empty, a TTY, or unreadable. NOT a free pass:
 *                     the caller falls back to gating HEAD, because "I could
 *                     not tell what is being pushed" must fail closed.
 */
function parsePushedSha(input) {
  if (input === null || input === undefined) return { kind: 'unknown' };
  const lines = String(input).split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { kind: 'unknown' };
  for (const line of lines) {
    const [, localSha] = line.split(/\s+/);
    if (localSha && !/^0+$/.test(localSha)) return { kind: 'sha', sha: localSha };
  }
  return { kind: 'deletes' };
}

function pushedShaFromStdin() {
  if (process.stdin.isTTY) return { kind: 'unknown' };
  try {
    return parsePushedSha(fs.readFileSync(0, 'utf8'));
  } catch {
    return { kind: 'unknown' };
  }
}

function main() {
  const mode = process.argv[2] || 'run';
  const fp = treeFingerprint();

  if (mode === 'verify') {
    const pushed = pushedShaFromStdin();
    if (pushed.kind === 'deletes') {
      // Branch deletions only: no code ships, so there is nothing to gate.
      console.log('pre-push: deletions only — nothing to gate.');
      process.exit(0);
    }
    // 'unknown' falls back to HEAD rather than passing: not knowing what is
    // being pushed is the one case that must never skip the gate.
    const ref = pushed.kind === 'sha' ? pushed.sha : 'HEAD';
    const { gates: needed } = neededGates(ref);
    const receipt = readReceipt();
    const why = checkReceipt(receipt, { fingerprint: fp.fingerprint, needed });
    if (!why) {
      const covered = receipt.gates.length ? receipt.gates.join(' + ') : 'nothing to run';
      console.log(`✓ pre-push: gate receipt valid for this exact tree (${covered}) — skipping the re-run.`);
      process.exit(0);
    }
    console.log(`pre-push: running the full gate — ${why}.`);
    process.exit(runGates(needed, fp) ? 0 : 1);
  }

  // `npm run gate` — validate the tree now, so the push itself is instant.
  const ref = process.argv[3] || 'HEAD';
  const { gates: needed } = neededGates(ref);
  if (fp.dirty) {
    console.log('gate: NOTE the working tree is dirty; the gate tests the tree as it stands,');
    console.log('      and any further edit (including another window\'s) invalidates the receipt.');
  }
  const ok = runGates(needed, fp);
  if (ok) {
    console.log('');
    console.log(`✓ gate PASSED and receipt written. The next push of this exact tree skips the hook.`);
    console.log(`  Receipt: ${receiptPath()}`);
  }
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { checkReceipt, neededGates, treeFingerprint, parsePushedSha, RECEIPT_VERSION, MAX_AGE_MS };

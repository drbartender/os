'use strict';
// Pieces the override conversion scripts share (plan
// 2026-10-16-price-override-removal, Tasks V1-V4).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { BRANCH_PREFIX } = require('./branch');

const REPO_ROOT = path.join(__dirname, '..', '..');
const { isLegalHold } = require('../../server/utils/legalHold');
const { isWholeCents } = require('../../server/utils/adjustmentRules');

// The guard every block checks and the export records: an md5 of the money
// columns, never updated_at (a client page view moves it). One text, used
// verbatim by the export, the fresh compute and both blocks.
const MONEY_MD5_EXPR = 'md5(row(total_price, amount_paid, status, total_price_override, adjustments, pricing_snapshot)::text)';

const TERMINAL_STATUSES = Object.freeze(['archived', 'completed']);
const hasOverride = (row) => row.total_price_override !== null && row.total_price_override !== undefined;
const isLiveOverride = (row) => hasOverride(row) && !TERMINAL_STATUSES.includes(row.status);

// Ids the conversion must never touch: the legal-hold seam (which reads
// LEGAL_HOLD_PROPOSAL_IDS and fails closed) plus any extra ids a caller adds
// (the rehearsal's synthetic hold). Extra ids only ever ADD to the refusal.
function heldCheck(extraIds = []) {
  const extra = (extraIds || []).map(Number);
  if (extra.some((n) => !Number.isSafeInteger(n) || n < 1)) throw new Error('held ids must be positive integers');
  return (id) => isLegalHold(id) || extra.includes(Number(id));
}

function parseIdList(text) {
  if (!text) return [];
  return String(text).split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    if (!/^[0-9]+$/.test(s)) throw new Error(`not an id: ${s}`);
    return Number(s);
  });
}

// Integer cents of a money value the SQL blocks can read the same way: a
// finite JSON number or a plain decimal string, in whole cents. null for a
// missing value (null or undefined), NaN for anything else.
const PLAIN_DECIMAL = /^\s*-?[0-9]+(\.[0-9]+)?\s*$/;
function moneyCents(v) {
  if (v === null || v === undefined) return null;
  let n = NaN;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && PLAIN_DECIMAL.test(v)) n = Number(v);
  if (!Number.isFinite(n) || !isWholeCents(n)) return NaN;
  return Math.round(n * 100);
}

// Only a URI file branch.js wrote (its name keeps the conversion prefix), so no
// tool here can be pointed at a hand-made URI, prod's own above all.
function readUriFile(file) {
  if (!file) throw new Error('name the URI file branch.js wrote');
  if (!path.basename(file).startsWith(BRANCH_PREFIX)) throw new Error(`${file} is not a URI file branch.js wrote`);
  const uri = fs.readFileSync(file, 'utf8').trim();
  if (!/^postgres(ql)?:\/\//.test(uri)) throw new Error(`${file} does not hold a connection URI`);
  return uri;
}

const pgConfig = (uri) => ({ connectionString: uri, ssl: uri.includes('neon.tech') ? { rejectUnauthorized: false } : false });

// Everything the conversion writes to disk carries free-text labels: chmod 600.
function writePrivate(file, text) {
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
const writePrivateJson = (file, data) => writePrivate(file, `${JSON.stringify(data, null, 2)}\n`);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const runGit = (args) => {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
};

/**
 * The deployed-code guard (push-1 security review, MINOR-1 class a). The fresh
 * compute prices live bookings with the engine code in THIS checkout, so the
 * conversion refuses unless that code is the code prod runs: server/ equal to
 * origin/main (no diff, staged or not, and no untracked file), after a fetch.
 * The conversion tooling must be committed (no uncommitted or untracked file),
 * but is never compared with origin/main, so an unpushed tooling commit (this
 * guard's own, before its push) cannot block a run. freshCompute.js and run.js
 * call it before any work; guard.js runs it alone (runbook steps 1 and 5).
 * @param {{ git?: Function, root?: string }} [opts]  injectable for tests
 * @returns {{ originMain: string }} the origin/main sha the checkout matched
 */
function assertDeployedCode({ git = runGit, root = REPO_ROOT } = {}) {
  const run = (...args) => git(['-C', root, ...args]);
  const fetched = run('fetch', '--quiet', 'origin', 'main');
  if (fetched.status !== 0) {
    throw new Error('git fetch origin main failed: fetch by hand (git fetch origin main) and re-run, '
      + 'so server/ is compared with the code prod runs');
  }
  const diff = run('diff', '--quiet', 'origin/main', '--', 'server');
  if (diff.status === 1) {
    throw new Error('server/ differs from origin/main: the fresh compute would price with code prod does not run. '
      + 'Bring this checkout to origin/main (no local server/ changes) and re-run');
  }
  if (diff.status !== 0) throw new Error('could not compare server/ with origin/main (git diff failed); refusing');
  const untracked = run('ls-files', '--others', '--exclude-standard', '--', 'server');
  if (untracked.status !== 0) throw new Error('could not list untracked files under server/; refusing');
  const stray = untracked.stdout.split('\n').filter(Boolean);
  if (stray.length) throw new Error(`server/ holds untracked files prod does not run: ${stray.slice(0, 5).join(', ')}; refusing`);
  const tooling = run('status', '--porcelain', '--', 'scripts/override-conversion');
  if (tooling.status !== 0) throw new Error('could not read the conversion tooling status; refusing');
  if (tooling.stdout.trim()) {
    throw new Error('scripts/override-conversion has uncommitted or untracked changes: run only committed tooling');
  }
  const head = run('rev-parse', 'origin/main');
  return { originMain: head.stdout.trim() };
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

module.exports = {
  MONEY_MD5_EXPR, TERMINAL_STATUSES, hasOverride, isLiveOverride, heldCheck, parseIdList, moneyCents,
  readUriFile, pgConfig, writePrivate, writePrivateJson, readJson, argValue, assertDeployedCode,
};

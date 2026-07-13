#!/usr/bin/env node
/*
 * testdb-smoke.js — pre-push money-path smoke gate (audit P2, stage 1).
 *
 * Flow when a Neon API key is configured:
 *   1. Reset the isolated `ci-smoke` branch to its prod parent (Neon REST API).
 *   2. Fetch that branch's pooled connection URI.
 *   3. Run initDb against it (this also validates any schema.sql change in the
 *      push BEFORE prod boot replays it — a gap nothing else covers).
 *   4. Run the money-path smoke suites (scripts/money-smoke-list.txt) serially.
 *
 * Credential: NEON_API_KEY from process.env or ~/.secrets/neon_api_key.
 *   - No key  -> loud SKIP banner, exit 0 (gate is NOT yet blocking).
 *   - Key set -> the gate is HARD and FAIL-CLOSED: ANY error in reset / URI /
 *     initDb / a failing suite exits 1. Emergency escape: `git push --no-verify`.
 *
 * The connection URI and the API key are NEVER printed (masked in every error).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// --- Neon target (provisioned 2026-07-13; see docs/superpowers/plans/2026-07-13-test-gate.md) ---
const API_BASE = 'https://console.neon.tech/api/v2';
const PROJECT_ID = 'round-tooth-34649976';
const BRANCH_ID = 'br-twilight-surf-adf8eghx'; // ci-smoke
const PARENT_BRANCH_ID = 'br-noisy-frog-ad99sa6l'; // production (reset source)
const DATABASE_NAME = 'neondb';
const ROLE_NAME = 'neondb_owner';

const REPO_ROOT = path.join(__dirname, '..');
const SMOKE_LIST = path.join(__dirname, 'money-smoke-list.txt');

// Timeouts (ms).
const REQUEST_TIMEOUT = 25000; // per single REST call
const OPERATIONS_TIMEOUT = 90000; // total wall-clock for the reset operations to finish
const POLL_INTERVAL = 2000;

// --- ANSI helpers (only for human-facing banners; no secrets ever pass through) ---
const RED = '\x1b[1;31m';
const YELLOW = '\x1b[1;33m';
const GREEN = '\x1b[1;32m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// Values that must never reach stdout/stderr. Populated as we learn them.
const SECRETS = [];
function registerSecret(v) {
  if (v && typeof v === 'string' && v.length >= 6) SECRETS.push(v);
}
// Redact every known secret from any string before it is printed.
function mask(str) {
  let out = String(str);
  for (const s of SECRETS) {
    if (s) out = out.split(s).join('***');
  }
  return out;
}
function die(msg) {
  console.error('');
  console.error(`${RED}✗ pre-push BLOCKED — money smoke could not run.${RESET}`);
  console.error(`  ${mask(msg)}`);
  console.error(`  ${DIM}Fail-closed: a configured gate never falls through to a silent pass.${RESET}`);
  console.error(`  Emergencies only: ${YELLOW}git push --no-verify${RESET}`);
  process.exit(1);
}

// --- Credential discovery -------------------------------------------------
function discoverApiKey() {
  const fromEnv = process.env.NEON_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const keyFile = path.join(os.homedir(), '.secrets', 'neon_api_key');
  try {
    const fromFile = fs.readFileSync(keyFile, 'utf8').trim();
    if (fromFile) return fromFile;
  } catch {
    // missing/unreadable file is the same as "no key" — handled by caller.
  }
  return null;
}

function skipBanner() {
  const bar = '═'.repeat(66);
  console.log('');
  console.log(`${RED}${bar}${RESET}`);
  console.log(`${RED}  MONEY SMOKE SKIPPED — NEON_API_KEY not configured.${RESET}`);
  console.log(`${RED}  This gate is NOT yet blocking; your push will proceed.${RESET}`);
  console.log(`${RED}  Set it up: see README > Test gate.${RESET}`);
  console.log(`${RED}${bar}${RESET}`);
  console.log('');
}

// --- Neon REST helpers ----------------------------------------------------
async function neonFetch(apiKey, method, urlPath, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  let res;
  try {
    res = await fetch(`${API_BASE}${urlPath}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    // AbortError or network failure — never leak the key that lived in headers.
    throw new Error(`Neon API ${method} ${urlPath} failed: ${err.name === 'AbortError' ? 'timed out' : err.message}`);
  } finally {
    clearTimeout(timer);
  }
  const rawText = await res.text();
  if (!res.ok) {
    // Body may echo request context; mask before surfacing.
    throw new Error(`Neon API ${method} ${urlPath} -> HTTP ${res.status}: ${mask(rawText).slice(0, 300)}`);
  }
  try {
    return rawText ? JSON.parse(rawText) : {};
  } catch {
    throw new Error(`Neon API ${method} ${urlPath}: could not parse JSON response`);
  }
}

// Terminal operation states per the Neon API.
const OP_DONE = 'finished';
const OP_FAILED = new Set(['failed', 'error', 'cancelled', 'cancelling', 'skipped']);

async function pollOperation(apiKey, opId, deadline) {
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`operation ${opId} did not finish within ${Math.round(OPERATIONS_TIMEOUT / 1000)}s`);
    }
    const { operation } = await neonFetch(apiKey, 'GET', `/projects/${PROJECT_ID}/operations/${opId}`);
    const status = operation && operation.status;
    if (status === OP_DONE) return;
    if (OP_FAILED.has(status)) {
      throw new Error(`operation ${opId} ended in state "${status}"`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

async function resetBranchToParent(apiKey) {
  // POST .../branches/{id}/restore with source_branch_id = parent IS the
  // documented "reset from parent" operation (neon.com/docs/guides/reset-from-parent).
  const resp = await neonFetch(
    apiKey,
    'POST',
    `/projects/${PROJECT_ID}/branches/${BRANCH_ID}/restore`,
    { source_branch_id: PARENT_BRANCH_ID }
  );
  const ops = Array.isArray(resp.operations) ? resp.operations : [];
  const deadline = Date.now() + OPERATIONS_TIMEOUT;
  for (const op of ops) {
    if (op && op.id) await pollOperation(apiKey, op.id, deadline);
  }
}

async function fetchConnectionUri(apiKey) {
  const qs = new URLSearchParams({
    branch_id: BRANCH_ID,
    database_name: DATABASE_NAME,
    role_name: ROLE_NAME,
    pooled: 'true',
  });
  const resp = await neonFetch(apiKey, 'GET', `/projects/${PROJECT_ID}/connection_uri?${qs.toString()}`);
  const uri = resp && resp.uri;
  if (!uri || typeof uri !== 'string') {
    throw new Error('connection_uri response did not include a uri');
  }
  registerSecret(uri); // from here on the URI is masked out of all output
  return uri;
}

// --- Suite list -----------------------------------------------------------
function readSmokeList() {
  let raw;
  try {
    raw = fs.readFileSync(SMOKE_LIST, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${path.relative(REPO_ROOT, SMOKE_LIST)}: ${err.message}`);
  }
  const files = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (files.length === 0) throw new Error('money-smoke-list.txt is empty — refusing to pass a no-op gate');

  // A silently-shrinking gate is worse than none: a listed file that no longer
  // exists is a HARD FAIL, not a skip.
  const missing = files.filter((f) => !fs.existsSync(path.join(REPO_ROOT, f)));
  if (missing.length) {
    throw new Error(`smoke-list references ${missing.length} missing file(s):\n    ${missing.join('\n    ')}`);
  }
  return files;
}

// --- Child processes ------------------------------------------------------
function runInitDb(dbUrl) {
  // Spawn a fresh node so the Pool binds to THIS dbUrl (db/index.js reads
  // process.env.DATABASE_URL at module load). initDb applies schema.sql.
  const child = spawnSync(
    process.execPath,
    ['-e', "require('./server/db/index.js').initDb().then(() => process.exit(0)).catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: 'inherit',
      timeout: 120_000, // a wedged schema apply must fail the gate, not hang the push
    }
  );
  if (child.error && child.error.code === 'ETIMEDOUT') {
    throw new Error('initDb timed out after 120s — schema apply against ci-smoke did not succeed');
  }
  if (child.status !== 0) {
    throw new Error(`initDb failed (exit ${child.status}) — schema apply against ci-smoke did not succeed`);
  }
}

function runSuite(file, dbUrl) {
  // `node -r dotenv/config --test <file>`: dotenv loads .env but does NOT
  // override env vars already set in the process, so our DATABASE_URL wins.
  const start = Date.now();
  const child = spawnSync(process.execPath, ['-r', 'dotenv/config', '--test', file], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'inherit',
    timeout: 180_000, // a hung suite becomes a hard fail, never an indefinitely-hung push
  });
  const secs = ((Date.now() - start) / 1000).toFixed(1);
  const timedOut = child.error && child.error.code === 'ETIMEDOUT';
  const ok = !timedOut && child.status === 0;
  console.log(`${ok ? GREEN + '  ✓' : RED + '  ✗'} ${file} ${DIM}(${secs}s)${timedOut ? ' TIMED OUT at 180s' : ''}${RESET}`);
  return ok;
}

// --- Main -----------------------------------------------------------------
async function main() {
  const apiKey = discoverApiKey();
  if (!apiKey) {
    skipBanner();
    process.exit(0);
  }
  registerSecret(apiKey);

  // Read & validate the list up front — fail before touching the network if
  // the gate would silently shrink.
  let files;
  try {
    files = readSmokeList();
  } catch (err) {
    die(err.message);
  }

  const totalStart = Date.now();
  let dbUrl;
  try {
    console.log(`${DIM}pre-push: resetting ci-smoke branch to its parent…${RESET}`);
    await resetBranchToParent(apiKey);
    console.log(`${DIM}pre-push: fetching ci-smoke connection URI…${RESET}`);
    dbUrl = await fetchConnectionUri(apiKey);
    console.log(`${DIM}pre-push: applying schema (initDb) to ci-smoke…${RESET}`);
    runInitDb(dbUrl);
  } catch (err) {
    die(err.message);
  }

  console.log('');
  console.log(`pre-push: running ${files.length} money-path smoke suite(s) against ci-smoke…`);
  let anyFailed = false;
  for (const file of files) {
    // Run all, report all — do not short-circuit on the first failure.
    const ok = runSuite(file, dbUrl);
    if (!ok) anyFailed = true;
  }

  const totalSecs = ((Date.now() - totalStart) / 1000).toFixed(1);
  console.log('');
  if (anyFailed) {
    console.error(`${RED}✗ pre-push BLOCKED — one or more money-path smoke suites failed (${totalSecs}s total).${RESET}`);
    console.error(`  Fix the failing suite(s) above. Emergencies only: ${YELLOW}git push --no-verify${RESET}`);
    process.exit(1);
  }
  console.log(`${GREEN}✓ pre-push: all ${files.length} money-path smoke suites passed (${totalSecs}s total).${RESET}`);
  process.exit(0);
}

main().catch((err) => {
  // Any unexpected throw once the key exists is still fail-closed.
  die(err && err.message ? err.message : String(err));
});

#!/usr/bin/env node
'use strict';
// The override conversion's Neon branch (plan 2026-10-16-price-override-removal,
// Task V1 step 1; spec section 8.5). The conversion reads a fresh branch, never
// prod itself, and never the push gate's ci-smoke branch.
//
//   node scripts/override-conversion/branch.js --scratch <dir> [--parent <branch id>]
//     Creates override-conversion-<YYYYMMDD-HHMM> (UTC) off --parent (default:
//     the production branch; the rehearsal passes the dev branch) with a
//     read_write endpoint, waits until it answers, writes its connection URI
//     to <dir>/<name>.uri (chmod 600) and prints the branch id. The URI and the
//     API key are never printed.
//   node scripts/override-conversion/branch.js --delete <branch id> [--scratch <dir>]
//     Deletes a conversion branch (and its URI file). Refuses any branch whose
//     name does not start with the prefix, the production, ci-smoke and dev
//     branches by id, and any default or protected branch.
//
// Key: NEON_API_KEY, else ~/.secrets/neon_api_key (as scripts/testdb-smoke.js).

const fs = require('fs');
const os = require('os');
const path = require('path');

const API_BASE = 'https://console.neon.tech/api/v2';
const PROJECT_ID = 'round-tooth-34649976';
const PROD_BRANCH_ID = 'br-noisy-frog-ad99sa6l';
const DEV_BRANCH_ID = 'br-delicate-union-adt2hvor';
const NEVER_DELETE = Object.freeze([
  PROD_BRANCH_ID,
  'br-twilight-surf-adf8eghx', // ci-smoke, the push gate's branch
  DEV_BRANCH_ID,
]);
const BRANCH_PREFIX = 'override-conversion-';
const DATABASE_NAME = 'neondb';
const ROLE_NAME = 'neondb_owner';
const REQUEST_TIMEOUT_MS = 25000;
const OPERATIONS_TIMEOUT_MS = 180000;
const PROBE_TIMEOUT_MS = 120000;

function discoverApiKey() {
  const fromEnv = process.env.NEON_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    const fromFile = fs.readFileSync(path.join(os.homedir(), '.secrets', 'neon_api_key'), 'utf8').trim();
    if (fromFile) return fromFile;
  } catch { /* no key file */ }
  return null;
}

const pad = (n) => String(n).padStart(2, '0');
function branchName(now = new Date()) {
  return `${BRANCH_PREFIX}${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
    + `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
}

// Every string that must never be printed, masked out of any error text, plus
// any connection URI an error body might echo.
function masker(secrets) {
  return (text) => secrets.filter((s) => s && s.length >= 6)
    .reduce((out, s) => out.split(s).join('***'), String(text))
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, 'postgresql://***');
}

function neonClient({ apiKey, fetchImpl, mask }) {
  return async function neon(method, urlPath, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(`${API_BASE}${urlPath}`, {
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
      throw new Error(`Neon API ${method} ${urlPath} failed: ${err && err.name === 'AbortError' ? 'timed out' : mask(err && err.message)}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Neon API ${method} ${urlPath} -> HTTP ${res.status}: ${mask(text).slice(0, 300)}`);
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Neon API ${method} ${urlPath}: unreadable JSON`);
    }
  };
}

const OP_FAILED = new Set(['failed', 'error', 'cancelled', 'cancelling', 'skipped']);
async function waitForOperations(neon, operations, pollMs) {
  const deadline = Date.now() + OPERATIONS_TIMEOUT_MS;
  for (const op of operations || []) {
    if (!op || !op.id) continue;
    for (;;) {
      const { operation } = await neon('GET', `/projects/${PROJECT_ID}/operations/${op.id}`);
      const status = operation && operation.status;
      if (status === 'finished') break;
      if (OP_FAILED.has(status)) throw new Error(`Neon operation ${op.id} ended "${status}"`);
      if (Date.now() > deadline) throw new Error(`Neon operation ${op.id} did not finish in time`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}

// Waits until the new endpoint answers a query (a fresh compute can take a
// moment to accept connections).
async function pgProbe(uri) {
  const { Client } = require('pg');
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString: uri, ssl: { rejectUnauthorized: false } });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (err) {
      lastError = err;
      await client.end().catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error(`the branch endpoint never answered (${lastError && lastError.code ? lastError.code : 'no code'})`);
}

// A failure after the create never orphans the branch (off prod it is a full
// copy of client data with a live read_write endpoint): it is deleted, and the
// error names it either way, with the command to delete it by hand when the
// cleanup itself failed.
async function createBranch({
  apiKey, scratchDir, parent = PROD_BRANCH_ID, now = new Date(), name = branchName(now),
  fetchImpl = fetch, pollMs = 2000, probe = pgProbe,
}) {
  if (!apiKey) throw new Error('no Neon API key (NEON_API_KEY or ~/.secrets/neon_api_key)');
  if (!scratchDir || !fs.existsSync(scratchDir)) throw new Error('--scratch <dir> must name an existing directory');
  if (typeof name !== 'string' || !name.startsWith(BRANCH_PREFIX)) throw new Error(`a branch name must keep the ${BRANCH_PREFIX} prefix`);
  const secrets = [apiKey];
  const mask = masker(secrets);
  const neon = neonClient({ apiKey, fetchImpl, mask });
  let id = null;
  try {
    const created = await neon('POST', `/projects/${PROJECT_ID}/branches`, {
      branch: { parent_id: parent, name },
      endpoints: [{ type: 'read_write' }],
    });
    id = created && created.branch && created.branch.id;
    if (!id) throw new Error('the create response named no branch');
    await waitForOperations(neon, created.operations, pollMs);
    const qs = new URLSearchParams({ branch_id: id, database_name: DATABASE_NAME, role_name: ROLE_NAME, pooled: 'false' });
    const { uri } = await neon('GET', `/projects/${PROJECT_ID}/connection_uri?${qs.toString()}`);
    if (!uri || typeof uri !== 'string') throw new Error('the connection_uri response held no uri');
    secrets.push(uri);
    await probe(uri);
    const uriFile = path.join(scratchDir, `${name}.uri`);
    fs.writeFileSync(uriFile, `${uri}\n`, { mode: 0o600 });
    fs.chmodSync(uriFile, 0o600);
    console.log(`branch ${id} (${name}) is ready off ${parent}; its URI is in ${uriFile}`);
    return { id, name, uriFile };
  } catch (err) {
    let message = mask(err && err.message);
    if (id) {
      try {
        await deleteBranch({ apiKey, id, fetchImpl, pollMs });
        message += `; branch ${id} (${name}) was created and has been deleted`;
      } catch (cleanupErr) {
        message += `; branch ${id} (${name}) was created and could NOT be deleted (${mask(cleanupErr && cleanupErr.message)}): `
          + `delete it with branch.js --delete ${id}`;
      }
    }
    throw new Error(message);
  }
}

async function deleteBranch({ apiKey, id, scratchDir = null, fetchImpl = fetch, pollMs = 2000 }) {
  if (!id || typeof id !== 'string') throw new Error('--delete needs a branch id');
  if (!apiKey) throw new Error('no Neon API key (NEON_API_KEY or ~/.secrets/neon_api_key)');
  const mask = masker([apiKey]);
  const neon = neonClient({ apiKey, fetchImpl, mask });
  if (NEVER_DELETE.includes(id)) throw new Error(`refusing to delete ${id}: a protected branch`);
  const { branch } = await neon('GET', `/projects/${PROJECT_ID}/branches/${encodeURIComponent(id)}`);
  if (!branch || branch.id !== id) throw new Error(`refusing to delete ${id}: the API did not return that branch`);
  if (typeof branch.name !== 'string' || !branch.name.startsWith(BRANCH_PREFIX)) {
    throw new Error(`refusing to delete ${id}: not a conversion branch`);
  }
  if (branch.default || branch.primary || branch.protected) {
    throw new Error(`refusing to delete ${id}: a default or protected branch`);
  }
  const deleted = await neon('DELETE', `/projects/${PROJECT_ID}/branches/${encodeURIComponent(id)}`);
  await waitForOperations(neon, deleted && deleted.operations, pollMs);
  if (scratchDir) {
    const uriFile = path.join(scratchDir, `${branch.name}.uri`);
    if (fs.existsSync(uriFile)) fs.unlinkSync(uriFile);
  }
  console.log(`deleted branch ${id} (${branch.name})`);
  return { id, name: branch.name };
}

// shared.js has the same helper; branch.js keeps its own so it loads no server module.
function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv) {
  const apiKey = discoverApiKey();
  const scratchDir = argValue(argv, '--scratch');
  if (argv.includes('--delete')) {
    await deleteBranch({ apiKey, id: argValue(argv, '--delete'), scratchDir });
    return;
  }
  await createBranch({ apiKey, scratchDir, parent: argValue(argv, '--parent') || PROD_BRANCH_ID });
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`branch.js: ${err && err.message}`);
    process.exit(1);
  });
}

module.exports = {
  createBranch, deleteBranch, branchName, discoverApiKey,
  BRANCH_PREFIX, PROD_BRANCH_ID, DEV_BRANCH_ID, PROJECT_ID, NEVER_DELETE,
};

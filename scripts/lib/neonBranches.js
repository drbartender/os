'use strict';

/*
 * neonBranches.js: the Neon REST calls behind run-suites' parallel workers
 * (2026-11-08): find or create a ci-suites-<n> branch off the dev branch,
 * reset it to dev, and fetch its pooled connection URI.
 *
 * Every branch this module creates or resets is named ci-suites-<n>; a reset or
 * a URI read of any other name throws, so production and dev are never touched
 * through it. The API key and every URI are registered as secrets and masked
 * out of every error message this module throws. The key comes from
 * NEON_API_KEY or ~/.secrets/neon_api_key, as for the money smoke.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const API_BASE = 'https://console.neon.tech/api/v2';
const PROJECT_ID = 'round-tooth-34649976';
const PARENT_NAME = 'dev';
const DATABASE_NAME = 'neondb';
const ROLE_NAME = 'neondb_owner';
const NAME_RE = /^ci-suites-\d+$/;
const REQUEST_TIMEOUT = 25000;
const OPERATIONS_TIMEOUT = 180000;
const POLL_INTERVAL = 2000;

const SECRETS = [];
function registerSecret(v) {
  if (v && typeof v === 'string' && v.length >= 6) SECRETS.push(v);
}
function mask(str) {
  let out = String(str);
  for (const s of SECRETS) out = out.split(s).join('***');
  return out;
}

function discoverApiKey() {
  const fromEnv = process.env.NEON_API_KEY;
  let key = fromEnv && fromEnv.trim() ? fromEnv.trim() : null;
  if (!key) {
    try {
      key = fs.readFileSync(path.join(os.homedir(), '.secrets', 'neon_api_key'), 'utf8').trim() || null;
    } catch {
      key = null;
    }
  }
  registerSecret(key);
  return key;
}

async function neonFetch(key, method, urlPath, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  let res;
  let text;
  try {
    // The timer bounds the body read too: a response whose headers arrive and
    // whose body stalls must not hold the dev-suite lock forever.
    res = await fetch(`${API_BASE}${urlPath}`, {
      method,
      headers: { accept: 'application/json', authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    throw new Error(mask(`Neon API ${method} ${urlPath} failed: ${err.name === 'AbortError' ? 'timed out' : err.message}`));
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(mask(`Neon API ${method} ${urlPath} -> HTTP ${res.status}: ${text.slice(0, 300)}`));
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Neon API ${method} ${urlPath}: could not parse JSON response`);
  }
}

const OP_FAILED = new Set(['failed', 'error', 'cancelled', 'cancelling', 'skipped']);
async function waitOperations(key, ops) {
  const deadline = Date.now() + OPERATIONS_TIMEOUT;
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || !op.id) continue;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`Neon operation ${op.id} did not finish within ${OPERATIONS_TIMEOUT / 1000}s`);
      const { operation } = await neonFetch(key, 'GET', `/projects/${PROJECT_ID}/operations/${op.id}`);
      const status = operation && operation.status;
      if (status === 'finished') break;
      if (OP_FAILED.has(status)) throw new Error(`Neon operation ${op.id} ended in state "${status}"`);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    }
  }
}

// The branch with exactly this name, or null.
async function branchByName(key, name) {
  const { branches } = await neonFetch(key, 'GET', `/projects/${PROJECT_ID}/branches?search=${encodeURIComponent(name)}`);
  return (branches || []).find((b) => b.name === name) || null;
}

function guardName(name) {
  if (!NAME_RE.test(name)) throw new Error(`neonBranches: refusing branch "${name}" (only ci-suites-<n> branches are touched)`);
}

// The id of branch `name` (ci-suites-<n>) off the dev branch, created with a
// read-write endpoint when it does not exist yet.
async function ensureBranch(key, name, parentId) {
  guardName(name);
  const found = await branchByName(key, name);
  if (found) return found.id;
  const resp = await neonFetch(key, 'POST', `/projects/${PROJECT_ID}/branches`, {
    branch: { name, parent_id: parentId },
    endpoints: [{ type: 'read_write' }],
  });
  await waitOperations(key, resp.operations);
  return resp.branch.id;
}

// Resets ci-suites-<n> to the dev branch's current state.
async function resetToParent(key, name, branchId, parentId) {
  guardName(name);
  const resp = await neonFetch(key, 'POST', `/projects/${PROJECT_ID}/branches/${branchId}/restore`, { source_branch_id: parentId });
  await waitOperations(key, resp.operations);
}

async function connectionUri(key, name, branchId) {
  guardName(name);
  const qs = new URLSearchParams({ branch_id: branchId, database_name: DATABASE_NAME, role_name: ROLE_NAME, pooled: 'true' });
  const resp = await neonFetch(key, 'GET', `/projects/${PROJECT_ID}/connection_uri?${qs.toString()}`);
  if (!resp || typeof resp.uri !== 'string' || !resp.uri) throw new Error('connection_uri response did not include a uri');
  registerSecret(resp.uri);
  return resp.uri;
}

// n fresh worker databases: ci-suites-1..n, each reset to dev, as pooled URIs
// in order. Throws (masked) when any step fails.
async function workerDatabases(key, n) {
  const parent = await branchByName(key, PARENT_NAME);
  if (!parent) throw new Error(`Neon branch "${PARENT_NAME}" not found`);
  const names = Array.from({ length: n }, (_, i) => `ci-suites-${i + 1}`);
  const ids = await Promise.all(names.map((nm) => ensureBranch(key, nm, parent.id)));
  await Promise.all(names.map((nm, i) => resetToParent(key, nm, ids[i], parent.id)));
  return Promise.all(names.map((nm, i) => connectionUri(key, nm, ids[i])));
}

module.exports = { discoverApiKey, workerDatabases, mask, registerSecret, guardName, NAME_RE };

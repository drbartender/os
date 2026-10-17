'use strict';
// branch.js (plan 2026-10-16-price-override-removal, Task V1 step 1). Pure: the
// Neon API is an injected fake, so nothing here reaches the network. The
// guards are the point: a create asks for a read_write endpoint off the parent
// it was given (prod only by default), the URI lands in a chmod-600 file and
// never on stdout, and a delete refuses anything that is not a conversion
// branch, so it can never touch ci-smoke, prod or dev.
//   node --test scripts/override-conversion/branch.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createBranch, deleteBranch, branchName, BRANCH_PREFIX, PROD_BRANCH_ID, PROJECT_ID,
} = require('./branch');

const KEY = 'test-api-key-not-real';
const URI = 'postgresql://neondb_owner:not-a-real-password@ep-fake-endpoint.us-east-1.aws.neon.tech/neondb?sslmode=require';

// A fake Neon API: records every call and answers from a route table.
function fakeNeon(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}`;
    calls.push({ key, url, init, body: init.body ? JSON.parse(init.body) : null });
    const handler = routes[key];
    if (!handler) return { ok: false, status: 404, text: async () => '{"message":"not found"}' };
    const out = await handler(u, init);
    return { ok: true, status: 200, text: async () => JSON.stringify(out) };
  };
  return { calls, fetchImpl };
}

function captureConsole(fn) {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  return Promise.resolve().then(fn).finally(() => Object.assign(console, orig)).then((r) => ({ r, lines }));
}

const NOW = new Date(Date.UTC(2026, 9, 18, 7, 5, 0));
const createRoutes = (name) => ({
  [`POST /api/v2/projects/${PROJECT_ID}/branches`]: async () => ({
    branch: { id: 'br-new-branch-123', name },
    endpoints: [{ id: 'ep-fake-endpoint', type: 'read_write' }],
    operations: [{ id: 'op-1', status: 'running' }],
  }),
  [`GET /api/v2/projects/${PROJECT_ID}/operations/op-1`]: async () => ({ operation: { id: 'op-1', status: 'finished' } }),
  [`GET /api/v2/projects/${PROJECT_ID}/connection_uri`]: async () => ({ uri: URI }),
});

test('the name is the prefix plus a UTC minute stamp', () => {
  assert.equal(branchName(NOW), `${BRANCH_PREFIX}20261018-0705`);
  assert.ok(BRANCH_PREFIX.startsWith('override-conversion-'));
});

test('create: a read_write endpoint off prod by default; the URI goes to a chmod-600 file, never stdout', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-branch-'));
  const name = branchName(NOW);
  const { calls, fetchImpl } = fakeNeon(createRoutes(name));
  const probed = [];
  const { r, lines } = await captureConsole(() => createBranch({
    apiKey: KEY, scratchDir: scratch, now: NOW, fetchImpl, pollMs: 1,
    probe: async (uri) => { probed.push(uri); },
  }));
  const create = calls.find((c) => c.key.startsWith('POST'));
  assert.equal(create.body.branch.parent_id, PROD_BRANCH_ID);
  assert.equal(create.body.branch.name, name);
  assert.deepEqual(create.body.endpoints, [{ type: 'read_write' }]);
  assert.equal(create.init.headers.authorization, `Bearer ${KEY}`);
  const uriCall = calls.find((c) => c.key.endsWith('/connection_uri'));
  const qs = new URL(uriCall.url).searchParams;
  assert.equal(qs.get('branch_id'), 'br-new-branch-123');
  assert.equal(qs.get('database_name'), 'neondb');
  assert.equal(qs.get('role_name'), 'neondb_owner');
  assert.ok(calls.some((c) => c.key.endsWith('/operations/op-1')), 'waits on the create operations');
  assert.deepEqual(probed, [URI], 'waits until the endpoint answers');

  assert.equal(r.id, 'br-new-branch-123');
  assert.equal(r.uriFile, path.join(scratch, `${name}.uri`));
  assert.equal(fs.readFileSync(r.uriFile, 'utf8').trim(), URI);
  assert.equal(fs.statSync(r.uriFile).mode & 0o777, 0o600);
  const out = lines.join('\n');
  assert.ok(out.includes('br-new-branch-123'), 'prints the branch id');
  assert.ok(!out.includes('not-a-real-password') && !out.includes('ep-fake-endpoint'), 'never prints the URI');
  assert.ok(!out.includes(KEY), 'never prints the key');
});

test('create: --parent passes through (the rehearsal branches dev)', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-branch-'));
  const { calls, fetchImpl } = fakeNeon(createRoutes(branchName(NOW)));
  await captureConsole(() => createBranch({
    apiKey: KEY, scratchDir: scratch, parent: 'br-some-dev-branch', now: NOW, fetchImpl, pollMs: 1, probe: async () => {},
  }));
  assert.equal(calls.find((c) => c.key.startsWith('POST')).body.branch.parent_id, 'br-some-dev-branch');
});

test('create: an API error is reported without the key or the URI', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-branch-'));
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => `boom ${KEY} ${URI}` });
  await assert.rejects(createBranch({ apiKey: KEY, scratchDir: scratch, now: NOW, fetchImpl, pollMs: 1, probe: async () => {} }),
    (err) => !err.message.includes(KEY) && !err.message.includes('not-a-real-password') && /HTTP 500/.test(err.message));
  assert.deepEqual(fs.readdirSync(scratch), [], 'no URI file on a failed create');
});

// A fake branch store for deletes.
function deleteRoutes(branches) {
  return {
    ...Object.fromEntries(Object.values(branches).map((b) => [
      `GET /api/v2/projects/${PROJECT_ID}/branches/${b.id}`, async () => ({ branch: b }),
    ])),
    ...Object.fromEntries(Object.values(branches).map((b) => [
      `DELETE /api/v2/projects/${PROJECT_ID}/branches/${b.id}`,
      async () => ({ branch: b, operations: [{ id: 'op-del', status: 'running' }] }),
    ])),
    [`GET /api/v2/projects/${PROJECT_ID}/operations/op-del`]: async () => ({ operation: { id: 'op-del', status: 'finished' } }),
  };
}

test('delete refuses ci-smoke, prod, dev and any default or protected branch before any DELETE', async () => {
  const branches = {
    ciSmoke: { id: 'br-twilight-surf-adf8eghx', name: 'ci-smoke' },
    prod: { id: PROD_BRANCH_ID, name: 'production', default: true },
    dev: { id: 'br-delicate-union-adt2hvor', name: 'dev' },
    prefixedDefault: { id: 'br-odd-default', name: `${BRANCH_PREFIX}20261018-0705`, default: true },
    prefixedProtected: { id: 'br-odd-protected', name: `${BRANCH_PREFIX}20261018-0706`, protected: true },
    nearMiss: { id: 'br-near-miss', name: 'override-conversion' },
    renamedProd: { id: PROD_BRANCH_ID, name: `${BRANCH_PREFIX}20261018-0707` },
  };
  for (const b of Object.values(branches)) {
    const { calls, fetchImpl } = fakeNeon(deleteRoutes({ b }));
    await assert.rejects(deleteBranch({ apiKey: KEY, id: b.id, fetchImpl, pollMs: 1 }), /refus/i, b.name);
    assert.ok(!calls.some((c) => c.key.startsWith('DELETE')), `no DELETE sent for ${b.name}`);
  }
  await assert.rejects(deleteBranch({ apiKey: KEY, id: '', fetchImpl: async () => { throw new Error('no call expected'); } }), /branch id/);
});

test('delete removes a conversion branch and its URI file', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-branch-'));
  const b = { id: 'br-conv-1', name: `${BRANCH_PREFIX}20261018-0705` };
  const uriFile = path.join(scratch, `${b.name}.uri`);
  fs.writeFileSync(uriFile, URI, { mode: 0o600 });
  const { calls, fetchImpl } = fakeNeon(deleteRoutes({ b }));
  const { lines } = await captureConsole(() => deleteBranch({ apiKey: KEY, id: b.id, scratchDir: scratch, fetchImpl, pollMs: 1 }));
  assert.ok(calls.some((c) => c.key === `DELETE /api/v2/projects/${PROJECT_ID}/branches/${b.id}`));
  assert.ok(calls.some((c) => c.key.endsWith('/operations/op-del')), 'waits on the delete operation');
  assert.equal(fs.existsSync(uriFile), false);
  assert.ok(lines.join('\n').includes(b.id));
});

// Fix round (security MINOR-2, code MINOR-1): a failure after the create must
// never orphan a branch, which off prod is a full copy of client data with a
// live read_write endpoint.
const failingCreate = (routes, scratch) => createBranch({
  apiKey: KEY, scratchDir: scratch, now: NOW, fetchImpl: routes.fetchImpl, pollMs: 1,
  probe: async () => { throw new Error('the endpoint never answered'); },
});

test('create: a failure after the branch exists names it and deletes it', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-branch-'));
  const name = branchName(NOW);
  const neon = fakeNeon({ ...createRoutes(name), ...deleteRoutes({ b: { id: 'br-new-branch-123', name } }) });
  await assert.rejects(failingCreate(neon, scratch), (err) => /br-new-branch-123/.test(err.message)
    && /has been deleted/.test(err.message) && !err.message.includes(KEY) && !err.message.includes('not-a-real-password'));
  assert.ok(neon.calls.some((c) => c.key === `DELETE /api/v2/projects/${PROJECT_ID}/branches/br-new-branch-123`));
  assert.deepEqual(fs.readdirSync(scratch), [], 'no URI file');
});

test('create: when that cleanup delete fails too, the error says how to delete the branch by hand', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-branch-'));
  const neon = fakeNeon(createRoutes(branchName(NOW))); // no GET or DELETE route: the cleanup fails
  await assert.rejects(failingCreate(neon, scratch),
    (err) => /could NOT be deleted/.test(err.message) && /branch\.js --delete br-new-branch-123/.test(err.message));
});

test('create: a custom name must keep the conversion prefix', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-branch-'));
  await assert.rejects(createBranch({ apiKey: KEY, scratchDir: scratch, name: 'ci-smoke-2', fetchImpl: async () => { throw new Error('no call'); } }),
    /prefix/);
});

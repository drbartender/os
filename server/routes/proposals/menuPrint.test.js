require('dotenv').config();

// Route-level tests for the bar-menu print file admin CRUD:
//   POST   /api/proposals/:id/menu-print
//   PATCH  /api/proposals/:id/menu-print
//   DELETE /api/proposals/:id/menu-print
//
// HARNESS NOTES
// -------------
// Same hand-rolled pattern as the sibling route tests (no supertest in this
// repo): a minimal express() app, the real router, the real express-fileupload
// middleware configured exactly as server/index.js configures it, and requests
// driven over real HTTP with a hand-built multipart body.
//
// R2 is stubbed at the module boundary (require.cache) so an upload asserts the
// route's validation + DB write without reaching Cloudflare. The bytes handed
// to uploadFile are captured so the key format can be asserted.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const fileUpload = require('express-fileupload');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');

// ── Stub R2 before the router requires it ─────────────────────────────────
const storagePath = require.resolve('../../utils/storage');
const realStorage = require('../../utils/storage');
const uploadCalls = [];
const signedCalls = [];
// Runs once, right after the next upload is stored (a change landing between the route's pre-read and its locks).
let onUpload = null;
require.cache[storagePath].exports = {
  ...realStorage,
  uploadFile: async (buffer, filename) => {
    uploadCalls.push({ buffer, filename });
    const hook = onUpload;
    onUpload = null;
    if (hook) await hook();
  },
  // The download signs a URL and fetches it; the fetch itself is swapped per
  // test (withFetch) so no request ever leaves the box.
  getSignedUrl: async (key) => { signedCalls.push(key); return `https://r2.invalid/${key}`; },
};

const { __setLegalHoldIdsForTest } = require('../../utils/legalHold');
const { adminWriteLimiter } = require('../../middleware/rateLimiters');
const menuPrintRouter = require('./menuPrint');

let server;
let baseUrl;
let adminToken;
let staffToken;
let adminUserId;
let staffUserId;
let clientId;
let proposalId;

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('fixture body\n')]);
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('pngbody'),
]);
const TEXT_BYTES = Buffer.from('this is not a print file');

/** Build a minimal multipart/form-data body with text fields, then one file part. */
function multipart(fieldName, filename, bytes, fields = {}) {
  const boundary = `----evdet${crypto.randomBytes(8).toString('hex')}`;
  const texts = Object.entries(fields).map(([k, v]) => Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
    'Content-Type: application/octet-stream\r\n\r\n'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([...texts, head, bytes, tail]), boundary };
}

// What a page loaded now shows, as the upload posts it: the live key and the
// draft's latest proof (superseded_at null), '' each for none.
async function pageNow(id) {
  const { rows: [p] } = await pool.query('SELECT menu_print_key FROM proposals WHERE id = $1', [id]);
  const { rows: [l] } = await pool.query(
    `SELECT mp.id, mp.answer FROM menu_proofs mp JOIN menu_drafts d ON d.id = mp.draft_id
      WHERE d.proposal_id = $1 AND mp.superseded_at IS NULL ORDER BY mp.sent_at DESC, mp.id DESC LIMIT 1`, [id]);
  return { expected_print_key: (p && p.menu_print_key) || '', seen_proof_id: l ? String(l.id) : '', seen_proof_answer: (l && l.answer) || '' };
}

function request(method, urlPath, { token, json, file } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + urlPath);
    let payload = null;
    const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    if (file) {
      const { body, boundary } = multipart('file', file.name, file.bytes, file.fields);
      payload = body;
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
      headers['Content-Length'] = body.length;
    } else if (json !== undefined) {
      payload = Buffer.from(JSON.stringify(json));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: parsed, raw: data, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function menuColumns() {
  const r = await pool.query(
    'SELECT menu_print_key, menu_not_required FROM proposals WHERE id = $1',
    [proposalId]
  );
  return r.rows[0];
}

before(async () => {
  await pool.query("DELETE FROM users WHERE email LIKE 'menuprint-route-%'");
  const passwordHash = await bcrypt.hash('x', 4);

  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id`,
    [`menuprint-route-admin-${NONCE}@example.com`, passwordHash]
  );
  adminUserId = a.rows[0].id;
  adminToken = jwt.sign({ userId: adminUserId, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const s = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id`,
    [`menuprint-route-staff-${NONCE}@example.com`, passwordHash]
  );
  staffUserId = s.rows[0].id;
  staffToken = jwt.sign({ userId: staffUserId, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555553333') RETURNING id",
    [`MenuPrint Route ${NONCE}`, `menuprint-route-client-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;

  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
                            event_timezone, status, event_type)
     VALUES ($1, CURRENT_DATE + 10, '18:00', 4, 'America/Chicago', 'confirmed', 'corporate')
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use(fileUpload({
    limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024 },
    abortOnLimit: true,
    useTempFiles: false,
  }));
  app.use('/api/proposals', menuPrintRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  // The withdraw tests' own events (declared below; read only once the tests ran).
  if (withdrawMade.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [withdrawMade]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])',
    [[adminUserId, staffUserId].filter((v) => v !== null && v !== undefined)]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  require.cache[storagePath].exports = realStorage;
});

// ─── Upload ────────────────────────────────────────────────────────────────

test('upload: a PDF lands under menu-print/<id>/ and flips status to ready', async () => {
  uploadCalls.length = 0;
  const res = await request('POST', `/api/proposals/${proposalId}/menu-print`,
    { token: adminToken, file: { name: 'menu.pdf', bytes: PDF_BYTES, fields: await pageNow(proposalId) } });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.menu_print, { status: 'ready' });
  assert.strictEqual(uploadCalls.length, 1, 'the file reached storage');
  assert.match(uploadCalls[0].filename, new RegExp(`^menu-print/${proposalId}/[0-9a-f-]+\\.pdf$`));
  const cols = await menuColumns();
  assert.strictEqual(cols.menu_print_key, uploadCalls[0].filename);
});

test('upload: a PNG is accepted with the png extension', async () => {
  uploadCalls.length = 0;
  const res = await request('POST', `/api/proposals/${proposalId}/menu-print`,
    { token: adminToken, file: { name: 'whatever.bin', bytes: PNG_BYTES, fields: await pageNow(proposalId) } });
  assert.strictEqual(res.status, 200);
  // Extension comes from the MAGIC BYTES, not the declared filename.
  assert.match(uploadCalls[0].filename, /\.png$/);
});

test('upload: a non-PDF/PNG/JPEG payload is rejected on magic bytes', async () => {
  uploadCalls.length = 0;
  const res = await request('POST', `/api/proposals/${proposalId}/menu-print`,
    { token: adminToken, file: { name: 'menu.pdf', bytes: TEXT_BYTES } });
  assert.strictEqual(res.status, 400);
  assert.ok(res.body.fieldErrors.file, 'field-level error names the file');
  assert.strictEqual(uploadCalls.length, 0, 'nothing reached storage');
});

test('upload: a missing file part is a field-level validation error', async () => {
  const res = await request('POST', `/api/proposals/${proposalId}/menu-print`, { token: adminToken });
  assert.strictEqual(res.status, 400);
  assert.ok(res.body.fieldErrors.file);
});

test('upload: an oversize file is refused by the size limit', async () => {
  const limit = parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024;
  const oversize = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(limit + 1024, 0x41)]);
  const res = await request('POST', `/api/proposals/${proposalId}/menu-print`,
    { token: adminToken, file: { name: 'huge.pdf', bytes: oversize } });
  assert.notStrictEqual(res.status, 200, `oversize upload must not succeed (got ${res.status})`);
});

// ─── Flag + delete ─────────────────────────────────────────────────────────

test('patch: not_required is refused while a file is posted', async () => {
  // finally-restore: without it the next test inherits this key and silently
  // becomes vacuous (it would assert "deleting nothing yields pending").
  await pool.query("UPDATE proposals SET menu_print_key = 'menu-print/x/y.pdf' WHERE id = $1", [proposalId]);
  try {
    const res = await request('PATCH', `/api/proposals/${proposalId}/menu-print`,
      { token: adminToken, json: { not_required: true } });
    // A release can post a key between the card's load and the mark: the fold refetches on the code.
    assert.deepStrictEqual([res.status, res.body.code, res.body.error], [409, 'MENU_PRINT_CHANGED', 'A print file is live now. Refresh to see it.']);
    const cols = await menuColumns();
    assert.strictEqual(cols.menu_not_required, false, 'the contradictory state never persisted');
  } finally {
    await pool.query('UPDATE proposals SET menu_print_key = NULL WHERE id = $1', [proposalId]);
  }
});

test('delete: clears the key it names and returns to pending', async () => {
  // Owns its own setup so the assertion is real in isolation.
  await pool.query("UPDATE proposals SET menu_print_key = 'menu-print/z/z.pdf' WHERE id = $1", [proposalId]);
  const res = await request('DELETE', `/api/proposals/${proposalId}/menu-print`,
    { token: adminToken, json: { expected_print_key: 'menu-print/z/z.pdf' } });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.menu_print, { status: 'pending' });
  const cols = await menuColumns();
  assert.strictEqual(cols.menu_print_key, null);
});

// A Remove pressed on a card that showed an older file must not unpost the one live now.
test('delete: 409 MENU_PRINT_CHANGED when the live file is not the one the page showed; nothing moves', async () => {
  const live = `menu-print/${proposalId}/released-${NONCE}.jpg`;
  await pool.query('UPDATE proposals SET menu_print_key = $2 WHERE id = $1', [proposalId, live]);
  // These writes share the admin's write budget with the rest of the suite.
  await adminWriteLimiter.resetKey(`admin-${adminUserId}`);
  try {
    for (const expected of [`menu-print/${proposalId}/older-${NONCE}.jpg`, '']) {
      const res = await request('DELETE', `/api/proposals/${proposalId}/menu-print`, { token: adminToken, json: { expected_print_key: expected } });
      assert.deepStrictEqual([res.status, res.body.code, res.body.error],
        [409, 'MENU_PRINT_CHANGED', 'A different print file is live now. Refresh to see it.'], expected);
      assert.strictEqual((await menuColumns()).menu_print_key, live, 'the live file stays');
    }
    for (const body of [undefined, {}, { expected_print_key: 7 }, { expected_print_key: 'x'.repeat(513) }]) {
      const res = await request('DELETE', `/api/proposals/${proposalId}/menu-print`, { token: adminToken, json: body });
      assert.strictEqual(res.status, 400, JSON.stringify(body));
      assert.ok(res.body.fieldErrors.expected_print_key);
    }
    assert.strictEqual((await menuColumns()).menu_print_key, live);
  } finally {
    await pool.query('UPDATE proposals SET menu_print_key = NULL WHERE id = $1', [proposalId]);
  }
  // With no file live, today's answer whatever the page showed.
  const none = await request('DELETE', `/api/proposals/${proposalId}/menu-print`, { token: adminToken, json: { expected_print_key: live } });
  assert.deepStrictEqual([none.status, none.body.menu_print], [200, { status: 'pending' }]);
  await adminWriteLimiter.resetKey(`admin-${adminUserId}`);
});

test('patch: not_required flips on and back off with no file posted', async () => {
  const on = await request('PATCH', `/api/proposals/${proposalId}/menu-print`,
    { token: adminToken, json: { not_required: true } });
  assert.strictEqual(on.status, 200);
  assert.deepStrictEqual(on.body.menu_print, { status: 'not_required' });

  const off = await request('PATCH', `/api/proposals/${proposalId}/menu-print`,
    { token: adminToken, json: { not_required: false } });
  assert.strictEqual(off.status, 200);
  assert.deepStrictEqual(off.body.menu_print, { status: 'pending' });
});

// Spec 2026-10-19 section 15: the admin's mark carries its provenance, so a
// client's later Custom or Standard submit never undoes it.
test('patch: setting the mark writes menu_not_required_by admin, and so does clearing it (the Undo stands)', async () => {
  // The suite's earlier writes share this admin's write budget.
  await adminWriteLimiter.resetKey(`admin-${adminUserId}`);
  const by = async () => (await pool.query(
    'SELECT menu_not_required, menu_not_required_by FROM proposals WHERE id = $1', [proposalId])).rows[0];
  await pool.query('UPDATE proposals SET menu_print_key = NULL, menu_not_required = false, menu_not_required_by = NULL WHERE id = $1', [proposalId]);
  try {
    const on = await request('PATCH', `/api/proposals/${proposalId}/menu-print`,
      { token: adminToken, json: { not_required: true } });
    assert.strictEqual(on.status, 200);
    assert.deepStrictEqual(await by(), { menu_not_required: true, menu_not_required_by: 'admin' });

    // A planner mark the admin sets again becomes the admin's.
    await pool.query("UPDATE proposals SET menu_not_required_by = 'planner' WHERE id = $1", [proposalId]);
    const again = await request('PATCH', `/api/proposals/${proposalId}/menu-print`,
      { token: adminToken, json: { not_required: true } });
    assert.strictEqual(again.status, 200);
    assert.deepStrictEqual(await by(), { menu_not_required: true, menu_not_required_by: 'admin' });

    const off = await request('PATCH', `/api/proposals/${proposalId}/menu-print`,
      { token: adminToken, json: { not_required: false } });
    assert.strictEqual(off.status, 200);
    assert.deepStrictEqual(await by(), { menu_not_required: false, menu_not_required_by: 'admin' });
  } finally {
    await pool.query('UPDATE proposals SET menu_not_required = false, menu_not_required_by = NULL WHERE id = $1', [proposalId]);
  }
});

// Spec 2026-10-19 section 15, amended 2026-11-12: an admin's Undo of a planner
// mark stands; a later Skip the Menu submit never re-marks the row.
test('patch: a planner mark the admin undoes stays unmarked through a later Skip the Menu submit', async () => {
  await adminWriteLimiter.resetKey(`admin-${adminUserId}`);
  const { triggerMenuAutoStart } = require('../../utils/menuAutoStart');
  await pool.query('UPDATE proposals SET menu_print_key = NULL, menu_not_required = false, menu_not_required_by = NULL WHERE id = $1', [proposalId]);
  const plan = await pool.query(
    `INSERT INTO drink_plans (proposal_id, status, selections, client_name, client_email, planner_version)
     VALUES ($1, 'submitted', '{"menuStyle":"none"}'::jsonb, $2, $3, 1) RETURNING id`,
    [proposalId, `MenuPrint Route ${NONCE}`, `menuprint-route-client-${NONCE}@example.com`]);
  const planId = plan.rows[0].id;
  const state = async () => (await pool.query(
    'SELECT menu_not_required, menu_not_required_by FROM proposals WHERE id = $1', [proposalId])).rows[0];
  try {
    await triggerMenuAutoStart(planId);
    assert.deepStrictEqual(await state(), { menu_not_required: true, menu_not_required_by: 'planner' });
    const undo = await request('PATCH', `/api/proposals/${proposalId}/menu-print`,
      { token: adminToken, json: { not_required: false } });
    assert.strictEqual(undo.status, 200);
    assert.deepStrictEqual(await state(), { menu_not_required: false, menu_not_required_by: 'admin' });
    await triggerMenuAutoStart(planId);
    assert.deepStrictEqual(await state(), { menu_not_required: false, menu_not_required_by: 'admin' }, 'the resubmit does not re-mark');
  } finally {
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM drink_plans WHERE id = $1', [planId]);
    await pool.query('UPDATE proposals SET menu_not_required = false, menu_not_required_by = NULL WHERE id = $1', [proposalId]);
  }
});

test('patch: a mark refused while a file is posted leaves menu_not_required_by untouched', async () => {
  // The suite's earlier writes share this admin's write budget.
  await adminWriteLimiter.resetKey(`admin-${adminUserId}`);
  await pool.query("UPDATE proposals SET menu_print_key = 'menu-print/x/y.pdf', menu_not_required_by = NULL WHERE id = $1", [proposalId]);
  try {
    const res = await request('PATCH', `/api/proposals/${proposalId}/menu-print`,
      { token: adminToken, json: { not_required: true } });
    assert.strictEqual(res.status, 409);
    const r = (await pool.query('SELECT menu_not_required_by FROM proposals WHERE id = $1', [proposalId])).rows[0];
    assert.strictEqual(r.menu_not_required_by, null);
  } finally {
    await pool.query('UPDATE proposals SET menu_print_key = NULL WHERE id = $1', [proposalId]);
  }
});

test('upload: posting a file over a planner mark clears the mark and who set it (setMenuPrintKey)', async () => {
  // The suite's earlier writes share this admin's write budget.
  await adminWriteLimiter.resetKey(`admin-${adminUserId}`);
  await pool.query("UPDATE proposals SET menu_print_key = NULL, menu_not_required = true, menu_not_required_by = 'planner' WHERE id = $1", [proposalId]);
  try {
    uploadCalls.length = 0;
    const res = await request('POST', `/api/proposals/${proposalId}/menu-print`,
      { token: adminToken, file: { name: 'menu.pdf', bytes: PDF_BYTES, fields: await pageNow(proposalId) } });
    assert.strictEqual(res.status, 200);
    const r = (await pool.query(
      'SELECT menu_print_key, menu_not_required, menu_not_required_by FROM proposals WHERE id = $1', [proposalId])).rows[0];
    assert.strictEqual(r.menu_print_key, uploadCalls[0].filename);
    assert.strictEqual(r.menu_not_required, false);
    assert.strictEqual(r.menu_not_required_by, null);
  } finally {
    await pool.query('UPDATE proposals SET menu_print_key = NULL, menu_not_required = false, menu_not_required_by = NULL WHERE id = $1', [proposalId]);
  }
});

// ─── Auth ──────────────────────────────────────────────────────────────────

test('auth: staff cannot upload, flag, or delete', async () => {
  const up = await request('POST', `/api/proposals/${proposalId}/menu-print`,
    { token: staffToken, file: { name: 'menu.pdf', bytes: PDF_BYTES } });
  assert.strictEqual(up.status, 403);
  const patch = await request('PATCH', `/api/proposals/${proposalId}/menu-print`,
    { token: staffToken, json: { not_required: true } });
  assert.strictEqual(patch.status, 403);
  const del = await request('DELETE', `/api/proposals/${proposalId}/menu-print`, { token: staffToken });
  assert.strictEqual(del.status, 403);
});

test('unknown proposal id 404s', async () => {
  const res = await request('DELETE', '/api/proposals/99999999/menu-print', { token: adminToken });
  assert.strictEqual(res.status, 404);
});

// ─── Download (GET) ─────────────────────────────────────────────────────────
// Admin reads the posted file back through the same guard + stream the staff
// route uses (utils/menuPrintFile.js). R2 is a real Response from a swapped
// global fetch, so the stream path is the production one.

// Node's own fetch Response (the server lint config predates the global).
const { Response } = globalThis;

async function setKey(key) {
  await pool.query('UPDATE proposals SET menu_print_key = $2 WHERE id = $1', [proposalId, key]);
}
async function withFetch(impl, fn) {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => { calls.push(url); return impl(url, opts); };
  try { return await fn(calls); } finally { global.fetch = real; }
}

test('download: admin gets the posted file as an attachment, never cached stale', async () => {
  const key = `menu-print/${proposalId}/fixture-${NONCE}.pdf`;
  await setKey(key);
  await withFetch(
    () => new Response(PDF_BYTES, { status: 200, headers: { 'content-type': 'application/pdf' } }),
    async (calls) => {
      const res = await request('GET', `/api/proposals/${proposalId}/menu-print`, { token: adminToken });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.raw, PDF_BYTES.toString());
      assert.strictEqual(res.headers['content-type'], 'application/pdf');
      assert.strictEqual(res.headers['content-disposition'], `attachment; filename="bar-menu-${proposalId}.pdf"`);
      assert.strictEqual(res.headers['cache-control'], 'private, no-cache');
      assert.ok(signedCalls.includes(key), 'signed the stored key');
      assert.deepStrictEqual(calls, [`https://r2.invalid/${key}`]);
    }
  );
});

test('download: staff are refused on the admin route', async () => {
  await setKey(`menu-print/${proposalId}/fixture-${NONCE}.pdf`);
  const res = await request('GET', `/api/proposals/${proposalId}/menu-print`, { token: staffToken });
  assert.strictEqual(res.status, 403);
});

test('download: nothing posted is a 404', async () => {
  await setKey(null);
  const res = await request('GET', `/api/proposals/${proposalId}/menu-print`, { token: adminToken });
  assert.strictEqual(res.status, 404);
});

test("download: a key outside this proposal's folder is refused and never fetched", async () => {
  for (const bad of [`menu-print/99999999/x.pdf`, `menu-print/${proposalId}/../x.pdf`, `menu-print/${proposalId}//x.pdf`]) {
    await setKey(bad);
    await withFetch(() => { throw new Error('must not fetch'); }, async (calls) => {
      const res = await request('GET', `/api/proposals/${proposalId}/menu-print`, { token: adminToken });
      assert.strictEqual(res.status, 404, `${bad} refused`);
      assert.strictEqual(calls.length, 0, `${bad} never reached R2`);
    });
  }
});

test('download: an R2 failure is a clean 502 that leaks nothing', async () => {
  await setKey(`menu-print/${proposalId}/fixture-${NONCE}.pdf`);
  await withFetch(() => new Response('upstream detail', { status: 500 }), async () => {
    const res = await request('GET', `/api/proposals/${proposalId}/menu-print`, { token: adminToken });
    assert.strictEqual(res.status, 502);
    assert.ok(!res.raw.includes('upstream detail'));
    assert.ok(!res.raw.includes('r2.invalid'));
  });
  await setKey(null);
});

test('download: an unknown proposal id 404s', async () => {
  const res = await request('GET', '/api/proposals/99999999/menu-print', { token: adminToken });
  assert.strictEqual(res.status, 404);
});

test('an id past int4 is a 404 on every verb, never a 500', async () => {
  const huge = '99999999999999999999';
  const get = await request('GET', `/api/proposals/${huge}/menu-print`, { token: adminToken });
  assert.strictEqual(get.status, 404);
  const del = await request('DELETE', `/api/proposals/${huge}/menu-print`, { token: adminToken });
  assert.strictEqual(del.status, 404);
});

// ─── The legal-hold proposal (money law 15; lane menu-legal-hold-guards) ───

test('legal hold: POST, PATCH and DELETE answer 409 LEGAL_HOLD before any read or upload and change no column; an unheld twin still writes', async () => {
  const made = [];
  const event = async (key) => {
    const r = await pool.query(
      `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours, event_timezone, status, event_type,
                              menu_print_key, menu_not_required)
       VALUES ($1, CURRENT_DATE + 10, '18:00', 4, 'America/Chicago', 'confirmed', 'corporate', $2, false) RETURNING id`,
      [clientId, key]);
    made.push(r.rows[0].id);
    return r.rows[0].id;
  };
  const columns = async (id) => (await pool.query(
    'SELECT menu_print_key, menu_not_required, updated_at FROM proposals WHERE id = $1', [id])).rows[0];
  try {
    const held = await event(`menu-print/held-${NONCE}/x.pdf`);
    const twin = await event(null);
    const before = await columns(held);
    uploadCalls.length = 0;
    // The suite's earlier writes share this admin's write budget.
    await adminWriteLimiter.resetKey(`admin-${adminUserId}`);
    __setLegalHoldIdsForTest([held]);
    const seen = [];
    const realQuery = pool.query;
    pool.query = function watched(...args) {
      seen.push(String(typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text) || ''));
      return realQuery.apply(this, args);
    };
    const out = {};
    try {
      out.post = await request('POST', `/api/proposals/${held}/menu-print`, { token: adminToken, file: { name: 'm.pdf', bytes: PDF_BYTES } });
      out.patch = await request('PATCH', `/api/proposals/${held}/menu-print`, { token: adminToken, json: { not_required: false } });
      out.del = await request('DELETE', `/api/proposals/${held}/menu-print`, { token: adminToken });
    } finally {
      pool.query = realQuery;
      __setLegalHoldIdsForTest(null);
    }
    for (const [name, res] of Object.entries(out)) {
      assert.deepEqual([res.status, res.body && res.body.code], [409, 'LEGAL_HOLD'], `${name}: ${JSON.stringify(res.body)}`);
    }
    assert.deepEqual(seen.filter((q) => /proposals/.test(q)), [], 'refused before the proposal is read');
    assert.deepEqual(uploadCalls, [], 'nothing uploaded');
    assert.deepEqual(await columns(held), before, 'no column changed');

    await adminWriteLimiter.resetKey(`admin-${adminUserId}`);

    const post = await request('POST', `/api/proposals/${twin}/menu-print`,
      { token: adminToken, file: { name: 'm.pdf', bytes: PDF_BYTES, fields: await pageNow(twin) } });
    assert.equal(post.status, 200, JSON.stringify(post.body));
    const posted = (await columns(twin)).menu_print_key;
    const del = await request('DELETE', `/api/proposals/${twin}/menu-print`, { token: adminToken, json: { expected_print_key: posted } });
    assert.deepEqual([del.status, del.body.menu_print.status], [200, 'pending']);
    const patch = await request('PATCH', `/api/proposals/${twin}/menu-print`, { token: adminToken, json: { not_required: true } });
    assert.deepEqual([patch.status, patch.body.menu_print.status], [200, 'not_required']);
  } finally {
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [made]);
  }
});

// ─── The open proof's withdraw (spec 2026-10-19 section 10.3; lane menu-approve-send) ───
// Dallas's mark and his upload withdraw the draft's open proof in the same
// transaction as their own write; the upload also withdraws a change request;
// DELETE withdraws nothing. Each event here is its own proposal, draft and
// proofs (an older superseded one beside the latest), removed at the end.

const inboxCache = require('../../utils/inbox/cache');
const { loadProofByToken } = require('../../utils/menuProofs');

const withdrawMade = [];
async function proofEvent({ answer = null, printKey = null } = {}) {
  const { rows: [p] } = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours, event_timezone, status, event_type, menu_print_key)
     VALUES ($1, CURRENT_DATE + 10, '18:00', 4, 'America/Chicago', 'confirmed', 'corporate', $2) RETURNING id`, [clientId, printKey]);
  withdrawMade.push(p.id);
  const { rows: [d] } = await pool.query(
    `INSERT INTO menu_drafts (proposal_id, run_id, inputs, content, plan_fingerprint, version, art_version)
     VALUES ($1, gen_random_uuid(), '{}', '{}', '{}', 4, 2) RETURNING id`, [p.id]);
  const insert = (cols) => pool.query(
    `INSERT INTO menu_proofs (draft_id, proposal_id, version, art_version, r2_key, email_status, sent_at,
                              answer, answer_note, answered_at, superseded_at)
     VALUES ($1, $2, 4, 2, $3, 'sent', $4, $5, $6, CASE WHEN $5::text IS NULL THEN NULL ELSE NOW() END, $7)
     RETURNING id, token`,
    [d.id, p.id, `menu-proof/${p.id}/${crypto.randomUUID()}.jpg`, cols.sentAt, cols.answer, cols.answer ? 'a note' : null, cols.superseded]);
  const older = (await insert({ sentAt: new Date(Date.now() - 3600000), answer: null, superseded: new Date() })).rows[0];
  const latest = (await insert({ sentAt: new Date(), answer, superseded: null })).rows[0];
  return { id: p.id, draftId: d.id, older, latest };
}
const withdrawnOf = async (proofId) => (await pool.query('SELECT withdrawn_at FROM menu_proofs WHERE id = $1', [proofId])).rows[0].withdrawn_at;

// Each write's statements on its transaction client, and each Inbox cache clear, in one sequence.
async function traced(fn) {
  const seen = [];
  const realConnect = pool.connect;
  const realInvalidate = inboxCache.invalidate;
  pool.connect = function wrapped(...args) {
    if (args.length) return realConnect.apply(this, args);
    return realConnect.call(this).then((client) => {
      const q = client.query;
      const release = client.release;
      client.query = function logged(text, ...rest) { seen.push(String(text).replace(/\s+/g, ' ').trim()); return q.call(this, text, ...rest); };
      client.release = function rel(...r) { seen.push('release'); client.query = q; client.release = release; return release.apply(client, r); };
      return client;
    });
  };
  inboxCache.invalidate = () => { seen.push('invalidate'); realInvalidate(); };
  try {
    await adminWriteLimiter.resetKey(`admin-${adminUserId}`);
    return { res: await fn(), seen };
  } finally {
    pool.connect = realConnect;
    inboxCache.invalidate = realInvalidate;
  }
}

test('mark: setting the mark withdraws the latest unanswered proof in its transaction, draft locked first; the page then reads withdrawn', async () => {
  const ev = await proofEvent();
  const { res, seen } = await traced(() => request('PATCH', `/api/proposals/${ev.id}/menu-print`, { token: adminToken, json: { not_required: true } }));
  assert.deepEqual([res.status, res.body.menu_print.status], [200, 'not_required']);
  assert.ok(await withdrawnOf(ev.latest.id) instanceof Date, 'the open proof is withdrawn');
  assert.equal(await withdrawnOf(ev.older.id), null, 'a superseded proof is left alone');
  assert.equal((await loadProofByToken(pool, ev.latest.token)).state, 'withdrawn');
  const at = (re) => seen.findIndex((s) => re.test(s));
  const lock = at(/^SELECT id FROM menu_drafts WHERE proposal_id = \$1 FOR UPDATE$/);
  const mark = at(/^UPDATE proposals SET menu_not_required/);
  const withdraw = at(/^UPDATE menu_proofs SET withdrawn_at/);
  const commit = seen.indexOf('COMMIT');
  assert.ok(lock >= 0 && lock < mark && mark < withdraw && withdraw < commit, JSON.stringify(seen));
  assert.ok(seen.indexOf('release') < seen.indexOf('invalidate'), 'the Inbox cache clears after the commit and release');
});

test('mark: a change request or an approved answer is never withdrawn by the mark; clearing the mark withdraws nothing', async () => {
  for (const answer of ['changes', 'approved']) {
    const ev = await proofEvent({ answer });
    const { res } = await traced(() => request('PATCH', `/api/proposals/${ev.id}/menu-print`, { token: adminToken, json: { not_required: true } }));
    assert.equal(res.status, 200);
    assert.equal(await withdrawnOf(ev.latest.id), null, answer);
  }
  const ev = await proofEvent();
  const { res } = await traced(() => request('PATCH', `/api/proposals/${ev.id}/menu-print`, { token: adminToken, json: { not_required: false } }));
  assert.equal(res.status, 200);
  assert.equal(await withdrawnOf(ev.latest.id), null, 'an Undo withdraws nothing');
});

test('mark: refused while a file is posted, it withdraws nothing (the whole transaction rolls back)', async () => {
  const ev = await proofEvent({ printKey: `menu-print/${NONCE}/live.pdf` });
  const { res, seen } = await traced(() => request('PATCH', `/api/proposals/${ev.id}/menu-print`, { token: adminToken, json: { not_required: true } }));
  assert.equal(res.status, 409);
  assert.equal(await withdrawnOf(ev.latest.id), null);
  assert.ok(seen.includes('ROLLBACK'));
  assert.ok(!seen.includes('invalidate'));
});

test('upload: withdraws the latest proof unanswered or answered changes, never one answered approved, in the key\'s own transaction', async () => {
  for (const [answer, expected] of [[null, true], ['changes', true], ['approved', false]]) {
    const ev = await proofEvent({ answer });
    // The page saw the answer (or none): the upload settles it knowingly.
    const fields = await pageNow(ev.id);
    const { res, seen } = await traced(() => request('POST', `/api/proposals/${ev.id}/menu-print`,
      { token: adminToken, file: { name: 'menu.pdf', bytes: PDF_BYTES, fields } }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await withdrawnOf(ev.latest.id) instanceof Date, expected, String(answer));
    assert.equal(await withdrawnOf(ev.older.id), null);
    const at = (re) => seen.findIndex((s) => re.test(s));
    const lock = at(/^SELECT id FROM menu_drafts WHERE proposal_id = \$1 FOR UPDATE$/);
    const setKey = at(/^UPDATE proposals SET menu_print_key = \$1/);
    const withdraw = at(/^UPDATE menu_proofs SET withdrawn_at/);
    assert.ok(lock >= 0 && lock < setKey && setKey < withdraw && withdraw < seen.indexOf('COMMIT'), JSON.stringify(seen));
    assert.ok(seen.indexOf('release') < seen.indexOf('invalidate'));
  }
});

test('upload: an event with no draft posts its file as before (no proof, so empty seen fields pass)', async () => {
  const { rows: [p] } = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours, event_timezone, status, event_type)
     VALUES ($1, CURRENT_DATE + 10, '18:00', 4, 'America/Chicago', 'confirmed', 'corporate') RETURNING id`, [clientId]);
  withdrawMade.push(p.id);
  const fields = { expected_print_key: '', seen_proof_id: '', seen_proof_answer: '' };
  const { res } = await traced(() => request('POST', `/api/proposals/${p.id}/menu-print`,
    { token: adminToken, file: { name: 'menu.pdf', bytes: PDF_BYTES, fields } }));
  assert.deepEqual([res.status, res.body.menu_print.status], [200, 'ready']);
  // A replace over that file names it, as the card does.
  const replace = { ...fields, expected_print_key: (await pool.query('SELECT menu_print_key FROM proposals WHERE id = $1', [p.id])).rows[0].menu_print_key };
  const { res: again } = await traced(() => request('POST', `/api/proposals/${p.id}/menu-print`,
    { token: adminToken, file: { name: 'menu.pdf', bytes: PDF_BYTES, fields: replace } }));
  assert.deepEqual([again.status, again.body.menu_print.status], [200, 'ready']);
});

// The upload is the third stale-page entrance (after Release and Remove): a
// card loaded before the client answered, or before a Looks great released a
// file, must not close that request or replace that file unseen.
test('upload: 409 MENU_PRINT_CHANGED or MENU_PROOF_CHANGED when the page is stale, before anything is stored, written or withdrawn', async () => {
  const changed = ['A different print file is live now. Refresh to see it.', "The client's review changed. Refresh to see it."];
  const post = async (id, fields) => {
    await adminWriteLimiter.resetKey(`admin-${adminUserId}`);
    return request('POST', `/api/proposals/${id}/menu-print`, { token: adminToken, file: { name: 'menu.pdf', bytes: PDF_BYTES, fields } });
  };
  const keyOf = async (id) => (await pool.query('SELECT menu_print_key FROM proposals WHERE id = $1', [id])).rows[0].menu_print_key;
  // The card loaded on an open proof; the client then asked for changes.
  const asked = await proofEvent();
  const stale = await pageNow(asked.id);
  await pool.query("UPDATE menu_proofs SET answer = 'changes', answer_note = 'More gin', answered_at = NOW() WHERE id = $1", [asked.latest.id]);
  uploadCalls.length = 0;
  for (const fields of [stale, { ...stale, seen_proof_id: '', seen_proof_answer: '' }, { ...stale, seen_proof_answer: 'approved' }]) {
    const res = await post(asked.id, fields);
    assert.deepEqual([res.status, res.body.code, res.body.error], [409, 'MENU_PROOF_CHANGED', changed[1]], JSON.stringify(fields));
  }
  assert.deepEqual(uploadCalls, [], 'nothing stored');
  assert.equal(await withdrawnOf(asked.latest.id), null, 'the change request stands, its Inbox task open');
  assert.equal(await keyOf(asked.id), null);
  // The card loaded on that proof open; a Looks great then released the file.
  const released = await proofEvent();
  const before = await pageNow(released.id);
  const live = `menu-print/${released.id}/released-${NONCE}.jpg`;
  await pool.query("UPDATE menu_proofs SET answer = 'approved', answered_at = NOW() WHERE id = $1", [released.latest.id]);
  await pool.query('UPDATE proposals SET menu_print_key = $2 WHERE id = $1', [released.id, live]);
  const over = await post(released.id, before);
  assert.deepEqual([over.status, over.body.code, over.body.error], [409, 'MENU_PRINT_CHANGED', changed[0]]);
  const sawFile = await post(released.id, { ...before, expected_print_key: live });
  assert.deepEqual([sawFile.status, sawFile.body.code], [409, 'MENU_PROOF_CHANGED'], 'the file seen, the answer not');
  assert.deepEqual(uploadCalls, [], 'nothing stored');
  assert.equal(await keyOf(released.id), live, 'the file the client released stays');
  // The page that saw both replaces it knowingly; an approved answer is never withdrawn.
  const ok = await post(released.id, await pageNow(released.id));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await withdrawnOf(released.latest.id), null);
});

test('upload: a change landing after the pre-read is still refused under the locks (the stored object is orphaned)', async () => {
  const ev = await proofEvent();
  const fields = await pageNow(ev.id);
  uploadCalls.length = 0;
  onUpload = () => pool.query("UPDATE menu_proofs SET answer = 'changes', answer_note = 'Late', answered_at = NOW() WHERE id = $1", [ev.latest.id]);
  await adminWriteLimiter.resetKey(`admin-${adminUserId}`);
  const { res, seen } = await traced(() => request('POST', `/api/proposals/${ev.id}/menu-print`,
    { token: adminToken, file: { name: 'menu.pdf', bytes: PDF_BYTES, fields } }));
  assert.deepEqual([res.status, res.body.code], [409, 'MENU_PROOF_CHANGED']);
  assert.equal(uploadCalls.length, 1, 'the object was stored before the transaction');
  assert.ok(seen.includes('ROLLBACK') && !seen.some((s) => /^UPDATE proposals SET menu_print_key/.test(s)), JSON.stringify(seen));
  assert.equal(await withdrawnOf(ev.latest.id), null);
});

test('upload: expected_print_key, seen_proof_id and seen_proof_answer are required and bounded, a 400 before anything is stored', async () => {
  const ev = await proofEvent();
  const good = await pageNow(ev.id);
  uploadCalls.length = 0;
  for (const [fields, field] of [
    [{ seen_proof_id: good.seen_proof_id, seen_proof_answer: '' }, 'expected_print_key'],
    [{ ...good, expected_print_key: 'x'.repeat(513) }, 'expected_print_key'],
    [{ expected_print_key: '', seen_proof_answer: '' }, 'seen_proof_id'],
    [{ ...good, seen_proof_id: '12x' }, 'seen_proof_id'], [{ ...good, seen_proof_id: '0' }, 'seen_proof_id'],
    [{ expected_print_key: '', seen_proof_id: good.seen_proof_id }, 'seen_proof_answer'], [{ ...good, seen_proof_answer: 'maybe' }, 'seen_proof_answer'],
  ]) {
    await adminWriteLimiter.resetKey(`admin-${adminUserId}`);
    const res = await request('POST', `/api/proposals/${ev.id}/menu-print`, { token: adminToken, file: { name: 'menu.pdf', bytes: PDF_BYTES, fields } });
    assert.equal(res.status, 400, JSON.stringify(fields));
    assert.ok(res.body.fieldErrors[field], `${field} named for ${JSON.stringify(fields)}`);
  }
  assert.deepEqual(uploadCalls, []);
  await adminWriteLimiter.resetKey(`admin-${adminUserId}`);
});

test('delete: removing the file withdraws nothing, and clears the Inbox cache after its write', async () => {
  const ev = await proofEvent({ printKey: `menu-print/${NONCE}/to-remove.pdf` });
  const { res, seen } = await traced(() => request('DELETE', `/api/proposals/${ev.id}/menu-print`,
    { token: adminToken, json: { expected_print_key: `menu-print/${NONCE}/to-remove.pdf` } }));
  assert.deepEqual([res.status, res.body.menu_print.status], [200, 'pending']);
  assert.equal(await withdrawnOf(ev.latest.id), null);
  assert.ok(seen.includes('invalidate'));
});

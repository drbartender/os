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
require.cache[storagePath].exports = {
  ...realStorage,
  uploadFile: async (buffer, filename) => { uploadCalls.push({ buffer, filename }); },
};

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

/** Build a minimal multipart/form-data body with one file part. */
function multipart(fieldName, filename, bytes) {
  const boundary = `----evdet${crypto.randomBytes(8).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
    'Content-Type: application/octet-stream\r\n\r\n'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, bytes, tail]), boundary };
}

function request(method, urlPath, { token, json, file } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + urlPath);
    let payload = null;
    const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    if (file) {
      const { body, boundary } = multipart('file', file.name, file.bytes);
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
          resolve({ status: res.statusCode, body: parsed, raw: data });
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
    { token: adminToken, file: { name: 'menu.pdf', bytes: PDF_BYTES } });
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
    { token: adminToken, file: { name: 'whatever.bin', bytes: PNG_BYTES } });
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
    assert.strictEqual(res.status, 409);
    const cols = await menuColumns();
    assert.strictEqual(cols.menu_not_required, false, 'the contradictory state never persisted');
  } finally {
    await pool.query('UPDATE proposals SET menu_print_key = NULL WHERE id = $1', [proposalId]);
  }
});

test('delete: clears the key and returns to pending', async () => {
  // Owns its own setup so the assertion is real in isolation.
  await pool.query("UPDATE proposals SET menu_print_key = 'menu-print/z/z.pdf' WHERE id = $1", [proposalId]);
  const res = await request('DELETE', `/api/proposals/${proposalId}/menu-print`, { token: adminToken });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.menu_print, { status: 'pending' });
  const cols = await menuColumns();
  assert.strictEqual(cols.menu_print_key, null);
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

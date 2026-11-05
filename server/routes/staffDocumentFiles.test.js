require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.SEND_NOTIFICATIONS = 'false';
// No .env on a gate or audit box: the real auth middleware still verifies a
// token, so the secret falls back to a fixed test value when none is set.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'staff-document-files-test';

/**
 * A document a staffer replaces from the Account page is stored as a URL the
 * admin tabs can open, and that URL resolves to the key the object was
 * uploaded under (audit 2026-11-05, POUT-05).
 *
 * POST /api/me/documents/:doc_type/replace stored the bare R2 key
 * (`staff/w9/<uid>/<ts>_<slug>`). The admin Documents and Certifications tabs
 * hand the stored value to api.get(url) verbatim, so that resolved to
 * /api/staff/w9/<uid>/..., not a route, and even /api/files/<basename> signs a
 * bare basename at the bucket root, never a prefixed key: a replaced W-9 or
 * alcohol certification could not be opened by any admin surface. The route
 * now stores `/files/` plus the key and routes/staffDocumentFiles.js signs
 * exactly that prefix.
 *
 * Harness: the real routers and the real auth middleware over node:http, with
 * pool.query and pool.connect replaced by an in-memory stub keyed on the SQL
 * text (the stripePayoutSync.unconfigured.test.js pattern), the R2 upload
 * stubbed through staffPortal's __setDeps seam and the signer through the
 * storage module object (as storage.readFile reads it). No database, no R2.
 * The DB-backed sibling staffPortal.test.js asserts the stored column shape.
 *
 * Run: node --test server/routes/staffDocumentFiles.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const fileUpload = require('express-fileupload');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError, NotFoundError } = require('../utils/errors');
const storage = require('../utils/storage');
const staffDocumentFilesRouter = require('./staffDocumentFiles');
const { staffDocumentKey } = staffDocumentFilesRouter;
const staffPortalRouter = require('./staffPortal');

if (process.env.NODE_ENV === 'production') {
  throw new Error('staffDocumentFiles.test.js refuses to run against production');
}

const ADMIN_ID = 301;
const MANAGER_ID = 302;
const STAFF_ID = 303;
const ROLES = { [ADMIN_ID]: 'admin', [MANAGER_ID]: 'manager', [STAFF_ID]: 'staff' };
const OLD_W9_URL = '/files/303_w9_old.pdf';

let server, baseUrl;
const realQuery = pool.query;
const realConnect = pool.connect;
const realGetSignedUrl = storage.getSignedUrl;
let signedKeys;    // every key handed to the signer
let uploads;       // every key handed to the R2 upload stub
let writes;        // every INSERT/UPDATE the replace route issued, on the transaction client

function answer(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (sql.startsWith('SELECT id, email, role, onboarding_status')) {
    const role = ROLES[params[0]];
    if (!role) return { rows: [], rowCount: 0 };
    return {
      rows: [{
        id: params[0], email: `user${params[0]}@example.com`, role, onboarding_status: 'approved',
        can_hire: false, can_staff: false, token_version: 0, pre_hired: false, presence_lead_rank: null,
      }],
      rowCount: 1,
    };
  }
  if (sql.startsWith('SELECT w9_file_url, w9_filename FROM payment_profiles')) {
    return { rows: [{ w9_file_url: OLD_W9_URL, w9_filename: 'old.pdf' }], rowCount: 1 };
  }
  if (/^(INSERT|UPDATE) /.test(sql)) {
    writes.push({ sql, params });
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

function tokenFor(id) {
  return jwt.sign({ userId: id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

// Build a multipart/form-data body by hand (staffPortal.test.js pattern).
function buildMultipart(file) {
  const boundary = `----nodetest${crypto.randomBytes(8).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="file"; filename="${file.filename}"\r\n`
      + `Content-Type: ${file.contentType}\r\n\r\n`
    ),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function request(method, path, { token, body, contentType } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: {
        ...(contentType ? { 'Content-Type': contentType } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Length': body.length } : {}),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let j = null;
        try { j = d ? JSON.parse(d) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: j, raw: d });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

before(async () => {
  pool.query = (text, params) => Promise.resolve(answer(text, params));
  pool.connect = () => Promise.resolve({
    query: (text, params) => Promise.resolve(answer(text, params)),
    release: () => {},
  });
  storage.getSignedUrl = (key) => {
    signedKeys.push(key);
    return Promise.resolve(`https://r2.example.test/signed/${encodeURIComponent(key)}`);
  };
  staffPortalRouter.__setDeps({
    uploadFile: (buffer, key) => { uploads.push(key); return Promise.resolve(); },
  });

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(fileUpload({ limits: { fileSize: 10 * 1024 * 1024 }, abortOnLimit: true, useTempFiles: false }));
  app.use('/api/files', staffDocumentFilesRouter);
  app.use('/api/me', staffPortalRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    console.error('[staff-document-files harness] unhandled:', err);
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => { signedKeys = []; uploads = []; writes = []; });

after(async () => {
  pool.query = realQuery;
  pool.connect = realConnect;
  storage.getSignedUrl = realGetSignedUrl;
  if (server) await new Promise((r) => server.close(r));
});

const KEY = 'staff/w9/303/1700000000000_my-w9.pdf';

test('staffDocumentKey: the writer shape and nothing else', () => {
  assert.equal(staffDocumentKey('w9', '303', '1700000000000_my-w9.pdf'), KEY);
  assert.equal(staffDocumentKey('alcohol_certification', 303, 'cert.png'), 'staff/alcohol_certification/303/cert.png');
  for (const args of [
    ['resume', '303', 'x.pdf'],          // not a replaceable document type
    ['w9', 'abc', 'x.pdf'],              // user id is not numeric
    ['w9', '303', '../../etc/passwd'],   // a path, not a basename
    ['w9', '303', ''],                   // nothing to sign
    ['w9', '303/../304', 'x.pdf'],       // traversal through the user segment
  ]) {
    assert.throws(() => staffDocumentKey(...args), NotFoundError, JSON.stringify(args));
  }
});

for (const [who, id] of [['admin', ADMIN_ID], ['manager', MANAGER_ID]]) {
  test(`${who} GET /api/files/staff/... signs exactly the stored key`, async () => {
    const r = await request('GET', `/api/files/${KEY}`, { token: tokenFor(id) });
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(signedKeys, [KEY]);
    assert.equal(r.body.url, `https://r2.example.test/signed/${encodeURIComponent(KEY)}`);
  });
}

test('a staffer is refused (403) and nothing is signed', async () => {
  const r = await request('GET', `/api/files/${KEY}`, { token: tokenFor(STAFF_ID) });
  assert.equal(r.status, 403, r.raw);
  assert.deepEqual(signedKeys, []);
});

test('an unknown document type, a non-numeric user id or a traversal is 404 and nothing is signed', async () => {
  for (const path of [
    '/api/files/staff/resume/303/x.pdf',
    '/api/files/staff/w9/abc/x.pdf',
    '/api/files/staff/w9/303/..%2F..%2Fsecret.pdf',
  ]) {
    const r = await request('GET', path, { token: tokenFor(ADMIN_ID) });
    assert.equal(r.status, 404, `${path}: ${r.raw}`);
  }
  assert.deepEqual(signedKeys, []);
});

test('a replaced W-9 is stored as a URL the admin tab can open, and it resolves to the uploaded key', async () => {
  const { body, contentType } = buildMultipart({
    filename: 'my-w9.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-1.4\n%binary\n'),
  });
  const replaced = await request('POST', '/api/me/documents/w9/replace', {
    token: tokenFor(STAFF_ID), body, contentType,
  });
  assert.equal(replaced.status, 200, replaced.raw);
  const fileUrl = replaced.body.file_url;
  assert.equal(uploads.length, 1, 'one R2 upload');
  assert.ok(fileUrl.startsWith(`/files/staff/w9/${STAFF_ID}/`), `stored shape: ${fileUrl}`);
  assert.equal(fileUrl, `/files/${uploads[0]}`, 'the stored URL is /files/ plus the uploaded key');

  const stored = writes.find((w) => w.sql.startsWith('UPDATE payment_profiles SET w9_file_url'));
  assert.ok(stored, 'the active record was written');
  assert.equal(stored.params[1], fileUrl, 'the column holds the same URL the response carries');
  const history = writes.find((w) => w.sql.startsWith('INSERT INTO staff_document_history'));
  assert.equal(history.params[1], OLD_W9_URL, 'the previous URL moves to history unchanged');

  // What the Documents tab does with the stored value: api.get(url) -> /api + url.
  const opened = await request('GET', `/api${fileUrl}`, { token: tokenFor(ADMIN_ID) });
  assert.equal(opened.status, 200, opened.raw);
  assert.deepEqual(signedKeys, [uploads[0]], 'the admin receives a signed URL for the object that was uploaded');
});

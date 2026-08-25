require('dotenv').config();
process.env.NODE_ENV = 'test';

// DELETE /campaigns/:id refuses to archive a campaign that is mid-send, because
// the run would keep mailing while its release UPDATE matched nothing. That
// guard had no staleness escape, so a process death mid-send wedged the row in
// 'sending' forever and the campaign could never be archived again except by
// hand-editing the database. "Abandoned" has to mean the same thing here as it
// does to the run claim in marketingSend.js, or the two disagree about whether
// a run is alive.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const router = require('./campaigns');
// The one definition of stale, read from the send that owns it.
const { RUN_STALE_MINUTES } = require('../marketingSend');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, base, adminToken, adminUserId;
const campaignIds = [];

function req(method, path, token) {
  return new Promise((resolve, reject) => {
    const r = http.request(`${base}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, (res) => {
      let raw = ''; res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    r.on('error', reject);
    r.end();
  });
}

async function mkCampaign(status, sentAtSql) {
  const c = await pool.query(
    `INSERT INTO email_campaigns (name, type, status, subject, html_body, sent_at)
     VALUES ($1, 'blast', $2, 'Test subject', '<p>body</p>', ${sentAtSql}) RETURNING id`,
    [`ARCH ${NONCE} ${status} ${campaignIds.length}`, status]
  );
  campaignIds.push(c.rows[0].id);
  return c.rows[0].id;
}

before(async () => {
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1,'x','admin','approved') RETURNING id`, [`arch-admin-${NONCE}@mkt-test.example`]);
  adminUserId = a.rows[0].id;
  adminToken = jwt.sign({ userId: adminUserId, tokenVersion: 0 }, process.env.JWT_SECRET);

  const app = express();
  app.use(express.json());
  app.use('/api/email-marketing', router);
  app.use((err, _req, res, _next) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
  });
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await pool.query('DELETE FROM email_campaigns WHERE id = ANY($1::int[])', [campaignIds]);
  await pool.query('DELETE FROM users WHERE id = $1', [adminUserId]);
  await new Promise(r => server.close(r));
  await pool.end();
});

test('archive: a draft campaign archives', async () => {
  const id = await mkCampaign('draft', 'NULL');
  const res = await req('DELETE', `/api/email-marketing/campaigns/${id}`, adminToken);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'archived');
});

test('archive: a campaign whose run is still live is refused', async () => {
  const id = await mkCampaign('sending', 'NOW()');
  const res = await req('DELETE', `/api/email-marketing/campaigns/${id}`, adminToken);
  assert.strictEqual(res.status, 409, 'archiving under a live run would strand it mailing');
  const after = await pool.query('SELECT status FROM email_campaigns WHERE id = $1', [id]);
  assert.strictEqual(after.rows[0].status, 'sending', 'the refused archive wrote nothing');
});

test('archive: a campaign stranded in sending by a process death archives once the claim goes stale', async () => {
  // Same clock the run claim uses to steal an abandoned claim: one minute past
  // the window is a run nobody is running.
  const id = await mkCampaign('sending',
    `NOW() - make_interval(mins => ${RUN_STALE_MINUTES}) - INTERVAL '1 minute'`);
  const res = await req('DELETE', `/api/email-marketing/campaigns/${id}`, adminToken);
  assert.strictEqual(res.status, 200, 'a dead run must not wedge the campaign forever');
  assert.strictEqual(res.body.status, 'archived');
});

test('archive: a sending campaign with no claim stamp is not a live run', async () => {
  // sent_at IS NULL is the third arm of the send claim's staleness test: there
  // is no claim to wait on, so there is nothing to strand.
  const id = await mkCampaign('sending', 'NULL');
  const res = await req('DELETE', `/api/email-marketing/campaigns/${id}`, adminToken);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'archived');
});

test('archive: a missing campaign is a 404, never a mid-send 409', async () => {
  const res = await req('DELETE', '/api/email-marketing/campaigns/2147483600', adminToken);
  assert.strictEqual(res.status, 404);
});

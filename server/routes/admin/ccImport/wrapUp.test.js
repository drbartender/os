require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../../db');
const { AppError } = require('../../../utils/errors');
const ccImportRouter = require('./index');

if (process.env.NODE_ENV === 'production') {
  throw new Error('wrapUp.test.js refuses to run against production');
}

let adminId, adminToken, managerId, managerToken, server, baseUrl;
// Bucket B fixtures
let clientId, proposalId;            // happy-path: completed past event, good email
let clientWithMsgId, proposalWithMsgId; // already has a sent wrap-up row
let badEmailClientId, badEmailProposalId; // email_status='bad'
let placeholderClientId, placeholderProposalId; // cc-import-noemail-* email
// Bucket A fixture (should be invalid_target)
let bucketAClientId, bucketAProposalId;

// Cleanup tracking: capture rows we create as side-effects so after() can wipe.
const scheduledMessageIdsToClean = [];

before(async () => {
  const u = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('cc-wrapup-admin@example.com','x','admin') RETURNING id"
  );
  adminId = u.rows[0].id;
  adminToken = jwt.sign(
    { userId: adminId, tokenVersion: 0 },
    process.env.JWT_SECRET
  );

  // Manager user for the admin-only guard test (audit batch 3c-roles).
  const mgr = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('cc-wrapup-manager@example.com','x','manager') RETURNING id"
  );
  managerId = mgr.rows[0].id;
  managerToken = jwt.sign({ userId: managerId, tokenVersion: 0 }, process.env.JWT_SECRET);

  // Bucket B happy-path client + proposal
  const c1 = await pool.query(
    "INSERT INTO clients (name, email, email_status) VALUES ('CC Wrap Client','cc-wrap-client@example.com','ok') RETURNING id"
  );
  clientId = c1.rows[0].id;
  const p1 = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours, total_price, cc_id)
     VALUES ($1, CURRENT_DATE - INTERVAL '14 days', 'completed', 'birthday-party', '6:00 PM', 4, 1000, 'cc-test-bucket-b-1')
     RETURNING id`,
    [clientId]
  );
  proposalId = p1.rows[0].id;

  // Bucket B with an already-sent wrap-up row
  const c2 = await pool.query(
    "INSERT INTO clients (name, email, email_status) VALUES ('CC Wrap Already','cc-wrap-already@example.com','ok') RETURNING id"
  );
  clientWithMsgId = c2.rows[0].id;
  const p2 = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours, total_price, cc_id)
     VALUES ($1, CURRENT_DATE - INTERVAL '21 days', 'completed', 'wedding', '5:00 PM', 4, 2000, 'cc-test-bucket-b-2')
     RETURNING id`,
    [clientWithMsgId]
  );
  proposalWithMsgId = p2.rows[0].id;
  const existingMsg = await pool.query(
    `INSERT INTO scheduled_messages
       (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, status, sent_at)
     VALUES ($1, 'proposal', 'post_event_wrap_up_email', 'client', $2, 'email', NOW() - INTERVAL '10 days', 'sent', NOW() - INTERVAL '10 days')
     RETURNING id`,
    [proposalWithMsgId, clientWithMsgId]
  );
  scheduledMessageIdsToClean.push(existingMsg.rows[0].id);

  // Bucket B with email_status='bad'
  const c3 = await pool.query(
    "INSERT INTO clients (name, email, email_status) VALUES ('CC Wrap Bad','cc-wrap-bad@example.com','bad') RETURNING id"
  );
  badEmailClientId = c3.rows[0].id;
  const p3 = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours, total_price, cc_id)
     VALUES ($1, CURRENT_DATE - INTERVAL '7 days', 'completed', 'birthday-party', '6:00 PM', 4, 1000, 'cc-test-bucket-b-3')
     RETURNING id`,
    [badEmailClientId]
  );
  badEmailProposalId = p3.rows[0].id;

  // Bucket B with placeholder email
  const c4 = await pool.query(
    "INSERT INTO clients (name, email, email_status) VALUES ('CC Wrap Placeholder','cc-import-noemail-abc123@drbartender.local','ok') RETURNING id"
  );
  placeholderClientId = c4.rows[0].id;
  const p4 = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours, total_price, cc_id)
     VALUES ($1, CURRENT_DATE - INTERVAL '5 days', 'completed', 'birthday-party', '6:00 PM', 4, 1000, 'cc-test-bucket-b-4')
     RETURNING id`,
    [placeholderClientId]
  );
  placeholderProposalId = p4.rows[0].id;

  // Bucket A (confirmed, future event — should be invalid_target)
  const c5 = await pool.query(
    "INSERT INTO clients (name, email, email_status) VALUES ('CC Wrap BucketA','cc-wrap-bucketa@example.com','ok') RETURNING id"
  );
  bucketAClientId = c5.rows[0].id;
  const p5 = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours, total_price, cc_id)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'confirmed', 'birthday-party', '6:00 PM', 4, 1000, 'cc-test-bucket-a-1')
     RETURNING id`,
    [bucketAClientId]
  );
  bucketAProposalId = p5.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/admin/cc-import', ccImportRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
    res.status(500).json({ error: err.message });
  });
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(r => server.close(r));
  const proposalIds = [
    proposalId, proposalWithMsgId, badEmailProposalId, placeholderProposalId, bucketAProposalId,
  ].filter(Boolean);
  const clientIds = [
    clientId, clientWithMsgId, badEmailClientId, placeholderClientId, bucketAClientId,
  ].filter(Boolean);
  if (proposalIds.length) {
    await pool.query(
      `DELETE FROM scheduled_messages WHERE entity_type='proposal' AND entity_id = ANY($1::int[])`,
      [proposalIds]
    );
    await pool.query(
      `DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])`,
      [proposalIds]
    );
    await pool.query(`DELETE FROM proposals WHERE id = ANY($1::int[])`, [proposalIds]);
  }
  if (clientIds.length) {
    await pool.query(`DELETE FROM clients WHERE id = ANY($1::int[])`, [clientIds]);
  }
  if (adminId) {
    await pool.query(
      `DELETE FROM admin_audit_log WHERE actor_user_id = $1`,
      [adminId]
    );
    await pool.query('DELETE FROM users WHERE id = $1', [adminId]);
  }
  if (managerId) {
    await pool.query('DELETE FROM users WHERE id = $1', [managerId]);
  }
  await pool.end();
});

function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const payload = body ? JSON.stringify(body) : null;
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const r = http.request({
      method, hostname: url.hostname, port: url.port, path: url.pathname + (url.search || ''), headers,
    }, (res) => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// Audit batch 3c-roles: cc-import is admin-only; a manager (previously allowed
// by requireAdminOrManager) now gets 403. The guard runs before the handler.
test('GET /wrap-up is admin-only — manager gets 403 (audit batch 3c-roles)', async () => {
  const r = await req('GET', '/api/admin/cc-import/wrap-up?filter=all', managerToken);
  assert.equal(r.status, 403);
  assert.equal(JSON.parse(r.body).code, 'PERMISSION_DENIED');
});

test('GET /wrap-up returns Bucket B item with wrap_up_done=false', async () => {
  // Filter to 'all' so the already-sent fixture and ours both could appear,
  // then assert the one without a message has wrap_up_done=false.
  const r = await req('GET', '/api/admin/cc-import/wrap-up?filter=all', adminToken);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.ok(Array.isArray(body.items));
  const ours = body.items.find(i => i.id === proposalId);
  assert.ok(ours, 'happy-path proposal in the list');
  assert.equal(ours.wrap_up_done, false);
  assert.equal(ours.cc_id, 'cc-test-bucket-b-1');
  assert.equal(ours.client_name, 'CC Wrap Client');
  // Counts present and numeric
  assert.ok(body.counts);
  assert.ok(Number.isInteger(body.counts.total_bucket_b));
});

test('GET /wrap-up?filter=needs-wrapup excludes proposals with a sent wrap-up row', async () => {
  const r = await req('GET', '/api/admin/cc-import/wrap-up?filter=needs-wrapup', adminToken);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  const ids = body.items.map(i => i.id);
  assert.ok(ids.includes(proposalId), 'happy-path proposal present (no wrap-up sent)');
  assert.ok(!ids.includes(proposalWithMsgId), 'proposal with sent wrap-up row is filtered out');
});

test('POST /wrap-up/enqueue without proposal_ids > ValidationError', async () => {
  const r = await req('POST', '/api/admin/cc-import/wrap-up/enqueue', adminToken, {});
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.body).error, /proposal_ids is required/);
});

test('POST /wrap-up/enqueue with empty array > ValidationError', async () => {
  const r = await req('POST', '/api/admin/cc-import/wrap-up/enqueue', adminToken, { proposal_ids: [] });
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.body).error, /at least one/);
});

test('POST /wrap-up/enqueue > 50 ids > ValidationError', async () => {
  const ids = Array.from({ length: 51 }, (_, i) => i + 1);
  const r = await req('POST', '/api/admin/cc-import/wrap-up/enqueue', adminToken, { proposal_ids: ids });
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.body).error, /Maximum 50/);
});

test('POST /wrap-up/enqueue happy path > enqueues + writes activity + audit', async () => {
  const r = await req('POST', '/api/admin/cc-import/wrap-up/enqueue', adminToken, {
    proposal_ids: [proposalId],
  });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].proposal_id, proposalId);
  assert.equal(body.results[0].outcome, 'enqueued');

  // scheduled_messages row created
  const sm = await pool.query(
    `SELECT id, status, channel FROM scheduled_messages
      WHERE entity_type='proposal' AND entity_id=$1
        AND message_type='post_event_wrap_up_email'`,
    [proposalId]
  );
  assert.equal(sm.rowCount, 1);
  assert.equal(sm.rows[0].status, 'pending');
  assert.equal(sm.rows[0].channel, 'email');

  // proposal_activity_log row
  const al = await pool.query(
    `SELECT action, actor_type, actor_id, details FROM proposal_activity_log
      WHERE proposal_id=$1 AND action='cc_wrap_up_enqueued'`,
    [proposalId]
  );
  assert.equal(al.rowCount, 1);
  assert.equal(al.rows[0].actor_type, 'admin');
  assert.equal(al.rows[0].actor_id, adminId);
  assert.equal(al.rows[0].details.cc_id, 'cc-test-bucket-b-1');

  // admin_audit_log row (target_user_id is null because the audit table's FK
  // is users(id), not clients(id); client_id rides in metadata instead).
  const au = await pool.query(
    `SELECT action, actor_user_id, target_user_id, metadata FROM admin_audit_log
      WHERE actor_user_id=$1 AND action='cc_wrap_up_enqueued'`,
    [adminId]
  );
  assert.ok(au.rowCount >= 1);
  const ours = au.rows.find(r => r.metadata.proposal_id === proposalId);
  assert.ok(ours, 'admin_audit_log entry written for this proposal');
  assert.equal(ours.metadata.client_id, clientId);
  assert.equal(ours.metadata.cc_id, 'cc-test-bucket-b-1');
});

test('POST /wrap-up/enqueue bad email > no_email outcome, no scheduled_messages row', async () => {
  const r = await req('POST', '/api/admin/cc-import/wrap-up/enqueue', adminToken, {
    proposal_ids: [badEmailProposalId],
  });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).results[0].outcome, 'no_email');

  const sm = await pool.query(
    `SELECT 1 FROM scheduled_messages
      WHERE entity_type='proposal' AND entity_id=$1
        AND message_type='post_event_wrap_up_email'`,
    [badEmailProposalId]
  );
  assert.equal(sm.rowCount, 0, 'no scheduled_messages row for bad-email client');
});

test('POST /wrap-up/enqueue with cc-import-noemail-* placeholder > no_email', async () => {
  const r = await req('POST', '/api/admin/cc-import/wrap-up/enqueue', adminToken, {
    proposal_ids: [placeholderProposalId],
  });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).results[0].outcome, 'no_email');
});

test('POST /wrap-up/enqueue dedup with existing sent row > already_enqueued', async () => {
  const r = await req('POST', '/api/admin/cc-import/wrap-up/enqueue', adminToken, {
    proposal_ids: [proposalWithMsgId],
  });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).results[0].outcome, 'already_enqueued');
});

test('POST /wrap-up/enqueue with Bucket A proposal > invalid_target', async () => {
  const r = await req('POST', '/api/admin/cc-import/wrap-up/enqueue', adminToken, {
    proposal_ids: [bucketAProposalId],
  });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).results[0].outcome, 'invalid_target');
});

test('POST /wrap-up/preview happy path > breakdown.proceed=1', async () => {
  // Bucket A row reaches the preview but has no good email check applied —
  // resolveChannelFallback for the Bucket A client should still 'proceed'
  // since its email is fine. So we use a fresh Bucket-B-style client.
  const r = await req('POST', '/api/admin/cc-import/wrap-up/preview', adminToken, {
    proposal_ids: [proposalId],
  });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.total, 1);
  assert.deepEqual(body.breakdown, { proceed: 1, no_email: 0, suppressed: 0 });
});

test('POST /wrap-up/preview with placeholder email > breakdown.no_email=1', async () => {
  const r = await req('POST', '/api/admin/cc-import/wrap-up/preview', adminToken, {
    proposal_ids: [placeholderProposalId],
  });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.total, 1);
  assert.deepEqual(body.breakdown, { proceed: 0, no_email: 1, suppressed: 0 });
});

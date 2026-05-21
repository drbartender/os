require('dotenv').config();
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  isFeedbackTokenShape,
  validateFeedbackInput,
  loadFeedbackContext,
  recordFeedback,
  handleFeedbackSubmission,
} = require('./publicFeedback');

let clientId;
let proposalId;
let token;

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email) VALUES ('Feedback Test Client', 'feedback-test@example.com') RETURNING id"
  );
  clientId = c.rows[0].id;
  // Schema note: proposals.token is UUID NOT NULL DEFAULT gen_random_uuid().
  // We omit `token` and let the default fire, then RETURNING captures the
  // generated value for use in feedback URL tests below.
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type)
     VALUES ($1, CURRENT_DATE - INTERVAL '2 days', 'completed', 'birthday-party')
     RETURNING id, token`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  token = p.rows[0].token;
});

after(async () => {
  await pool.query('DELETE FROM post_event_feedback WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

afterEach(async () => {
  await pool.query('DELETE FROM post_event_feedback WHERE proposal_id = $1', [proposalId]);
});

// ── token shape ──
test('isFeedbackTokenShape > accepts canonical UUID', () => {
  assert.strictEqual(isFeedbackTokenShape('00000000-0000-0000-0000-000000000000'), true);
});

test('isFeedbackTokenShape > rejects malformed strings', () => {
  assert.strictEqual(isFeedbackTokenShape('not-a-uuid'), false);
  assert.strictEqual(isFeedbackTokenShape(''), false);
  assert.strictEqual(isFeedbackTokenShape(null), false);
});

// ── input validation ──
test('validateFeedbackInput > accepts rating 1-5 with no comment', () => {
  const result = validateFeedbackInput({ rating: 4 });
  assert.deepStrictEqual(result, { rating: 4, comment: null });
});

test('validateFeedbackInput > accepts a trimmed comment under 2000 chars', () => {
  const result = validateFeedbackInput({ rating: 2, comment: 'Bartender was late.' });
  assert.strictEqual(result.rating, 2);
  assert.strictEqual(result.comment, 'Bartender was late.');
});

test('validateFeedbackInput > rejects rating outside 1-5', () => {
  assert.throws(() => validateFeedbackInput({ rating: 0 }), /rating/i);
  assert.throws(() => validateFeedbackInput({ rating: 6 }), /rating/i);
  assert.throws(() => validateFeedbackInput({ rating: 'three' }), /rating/i);
});

test('validateFeedbackInput > rejects oversize comment', () => {
  assert.throws(() => validateFeedbackInput({ rating: 2, comment: 'x'.repeat(3000) }), /comment/i);
});

test('validateFeedbackInput > rejects non-string comment', () => {
  assert.throws(() => validateFeedbackInput({ rating: 2, comment: 42 }), /comment/i);
});

// ── loadFeedbackContext ──
test('loadFeedbackContext > returns display data for a valid token', async () => {
  const ctx = await loadFeedbackContext(token);
  assert.ok(ctx);
  assert.ok(typeof ctx.client_first_name === 'string');
  assert.match(ctx.event_type_label, /Birthday/i);
  assert.strictEqual(ctx.already_submitted, false);
});

test('loadFeedbackContext > returns null for an unknown token', async () => {
  const ctx = await loadFeedbackContext('00000000-0000-0000-0000-000000000000');
  assert.strictEqual(ctx, null);
});

test('loadFeedbackContext > returns null when the proposal is archived', async () => {
  await pool.query("UPDATE proposals SET status = 'archived' WHERE id = $1", [proposalId]);
  const ctx = await loadFeedbackContext(token);
  assert.strictEqual(ctx, null);
  await pool.query("UPDATE proposals SET status = 'completed' WHERE id = $1", [proposalId]);
});

test('loadFeedbackContext > reports already_submitted=true when a feedback row exists', async () => {
  await pool.query(
    'INSERT INTO post_event_feedback (proposal_id, rating) VALUES ($1, 5)',
    [proposalId]
  );
  const ctx = await loadFeedbackContext(token);
  assert.strictEqual(ctx.already_submitted, true);
});

// ── recordFeedback ──
test('recordFeedback > high rating returns a redirect_url and stores the row', async () => {
  const result = await recordFeedback({ token, rating: 5, comment: null, ip: null, userAgent: null });
  assert.strictEqual(result.routing, 'redirect');
  assert.ok(result.redirect_url);

  const { rows } = await pool.query(
    'SELECT rating FROM post_event_feedback WHERE proposal_id = $1',
    [proposalId]
  );
  assert.strictEqual(rows[0].rating, 5);
});

test('recordFeedback > low rating stores comment and returns routing=thanks (no redirect)', async () => {
  const result = await recordFeedback({ token, rating: 2, comment: 'Bartender was late.', ip: null, userAgent: null });
  assert.strictEqual(result.routing, 'thanks');
  assert.strictEqual(result.redirect_url, undefined);

  const { rows } = await pool.query(
    'SELECT rating, comment FROM post_event_feedback WHERE proposal_id = $1',
    [proposalId]
  );
  assert.strictEqual(rows[0].rating, 2);
  assert.strictEqual(rows[0].comment, 'Bartender was late.');
});

test('recordFeedback > second submission for the same proposal throws conflict', async () => {
  await pool.query(
    'INSERT INTO post_event_feedback (proposal_id, rating) VALUES ($1, 5)',
    [proposalId]
  );
  await assert.rejects(
    () => recordFeedback({ token, rating: 3, comment: null, ip: null, userAgent: null }),
    /already/i
  );
});

test('recordFeedback > rejects when the underlying proposal is archived', async () => {
  await pool.query("UPDATE proposals SET status = 'archived' WHERE id = $1", [proposalId]);
  await assert.rejects(
    () => recordFeedback({ token, rating: 5, comment: null, ip: null, userAgent: null }),
    /not found/i
  );
  await pool.query("UPDATE proposals SET status = 'completed' WHERE id = $1", [proposalId]);
});

// ── handleFeedbackSubmission (Gemini Finding 6 — SUGGESTION) ──
// Covers the POST handler's email-on-low-rating branching without going
// through Express. sendEmail is injected so we count calls; no Resend
// network I/O. The pure record-only logic is already covered by the
// recordFeedback tests above; this layer asserts the admin-email side
// effect on low ratings.

test('handleFeedbackSubmission > low rating (1-3) triggers exactly one admin email', async () => {
  const emailCalls = [];
  const sendEmail = async (msg) => { emailCalls.push(msg); return { id: 'mock-msg' }; };

  const result = await handleFeedbackSubmission({
    token,
    body: { rating: 2, comment: 'Bartender was late.' },
    ip: '127.0.0.1',
    userAgent: 'mocha-test',
    sendEmail,
    now: () => new Date('2026-05-20T12:00:00Z'),
  });

  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.ok, true);
  assert.strictEqual(result.body.thanks, true);
  assert.strictEqual(result.body.redirect_url, undefined);
  assert.strictEqual(emailCalls.length, 1);
  assert.ok(emailCalls[0].to, 'admin email must have a recipient');
  assert.match(emailCalls[0].subject, /rating|feedback/i);
});

test('handleFeedbackSubmission > high rating (4-5) does NOT trigger an admin email and returns redirect_url', async () => {
  const emailCalls = [];
  const sendEmail = async (msg) => { emailCalls.push(msg); return { id: 'mock-msg' }; };

  const result = await handleFeedbackSubmission({
    token,
    body: { rating: 5, comment: null },
    ip: '127.0.0.1',
    userAgent: 'mocha-test',
    sendEmail,
    now: () => new Date('2026-05-20T12:00:00Z'),
  });

  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.ok, true);
  assert.ok(result.body.redirect_url);
  assert.strictEqual(emailCalls.length, 0);
});

test('handleFeedbackSubmission > rating 3 (boundary) is treated as low and triggers admin email', async () => {
  const emailCalls = [];
  const sendEmail = async (msg) => { emailCalls.push(msg); return { id: 'mock-msg' }; };

  const result = await handleFeedbackSubmission({
    token,
    body: { rating: 3, comment: 'just okay' },
    ip: null,
    userAgent: null,
    sendEmail,
    now: () => new Date('2026-05-20T12:00:00Z'),
  });

  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.thanks, true);
  assert.strictEqual(emailCalls.length, 1);
});

test('handleFeedbackSubmission > rating 4 (boundary) is treated as high and routes to redirect', async () => {
  const emailCalls = [];
  const sendEmail = async (msg) => { emailCalls.push(msg); return { id: 'mock-msg' }; };

  const result = await handleFeedbackSubmission({
    token,
    body: { rating: 4, comment: null },
    ip: null,
    userAgent: null,
    sendEmail,
    now: () => new Date('2026-05-20T12:00:00Z'),
  });

  assert.strictEqual(result.status, 200);
  assert.ok(result.body.redirect_url);
  assert.strictEqual(emailCalls.length, 0);
});

test('handleFeedbackSubmission > admin email failure does NOT fail the request (low rating)', async () => {
  // Simulate Resend down — sendEmail rejects. The handler should still
  // return a 200 success so the client sees a thanks page; Sentry capture
  // happens inside the handler.
  const sendEmail = async () => { throw new Error('Resend exploded'); };

  const result = await handleFeedbackSubmission({
    token,
    body: { rating: 1, comment: 'never again' },
    ip: null,
    userAgent: null,
    sendEmail,
    now: () => new Date('2026-05-20T12:00:00Z'),
  });

  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.ok, true);
  assert.strictEqual(result.body.thanks, true);
});

test('handleFeedbackSubmission > invalid rating returns 400 without inserting or emailing', async () => {
  const emailCalls = [];
  const sendEmail = async (msg) => { emailCalls.push(msg); };

  const result = await handleFeedbackSubmission({
    token,
    body: { rating: 99 },
    ip: null,
    userAgent: null,
    sendEmail,
    now: () => new Date('2026-05-20T12:00:00Z'),
  });

  assert.strictEqual(result.status, 400);
  assert.strictEqual(emailCalls.length, 0);
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM post_event_feedback WHERE proposal_id = $1',
    [proposalId]
  );
  assert.strictEqual(rows[0].n, 0);
});

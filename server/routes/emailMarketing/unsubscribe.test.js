require('dotenv').config();
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const router = require('./unsubscribe');

// GET CONFIRMS, POST ACTS.
//
// The flip used to live in the GET. Corporate mail gateways, security
// scanners and link prefetchers all issue GET on every URL in an email before
// the recipient sees it, so any of them silently unsubscribed a client who
// never clicked, and the retention and New Year touches just stopped arriving.

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const SECRET = process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET;
let server, base, clientId, leadId;

const sign = (payload) => jwt.sign(payload, SECRET, { expiresIn: '365d' });

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? new URLSearchParams(body).toString() : null;
    const u = new URL(base + path);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: data
        ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
        : {},
    }, (res) => {
      let b = ''; res.on('data', c => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));   // mirrors index.js
  app.use('/api/email-marketing', router);
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  clientId = (await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id',
    [`Unsub ${NONCE}`, `unsub-${NONCE}@mkt-test.example`])).rows[0].id;
  leadId = (await pool.query(
    `INSERT INTO email_leads (name, email, status, lead_source)
     VALUES ($1, $2, 'active', 'quote_wizard') RETURNING id`,
    [`Unsub ${NONCE}`, `unsub-lead-${NONCE}@mkt-test.example`])).rows[0].id;
});

after(async () => {
  await pool.query('DELETE FROM email_leads WHERE id = $1', [leadId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  if (server) await new Promise(r => server.close(r));
  await pool.end();
});

const marketingEnabled = async () => (await pool.query(
  `SELECT communication_preferences->>'marketing_enabled' AS m FROM clients WHERE id = $1`,
  [clientId])).rows[0].m;

test('GET renders a confirmation and changes NOTHING', async () => {
  const token = sign({ clientId, marketing: true, typ: 'unsub' });
  const before = await marketingEnabled();

  const r = await req('GET', `/api/email-marketing/unsubscribe?token=${token}`);
  assert.equal(r.status, 200);
  assert.match(r.body, /Unsubscribe from marketing emails\?/);
  assert.match(r.body, /<form method="POST"/, 'must offer a form, not act on the GET');

  assert.equal(await marketingEnabled(), before,
    'a GET must not flip the preference: scanners fetch every link in an email');
});

test('the confirmation form carries no inline JavaScript', async () => {
  // Helmet sets scriptSrc 'self', so an inline handler is blocked by CSP and
  // the button would silently do nothing.
  const token = sign({ clientId, marketing: true, typ: 'unsub' });
  const r = await req('GET', `/api/email-marketing/unsubscribe?token=${token}`);
  assert.ok(!/<script/i.test(r.body), 'no script tags');
  assert.ok(!/\son[a-z]+=/i.test(r.body), 'no inline event handlers');
});

test('POST performs the client unsubscribe', async () => {
  const token = sign({ clientId, marketing: true, typ: 'unsub' });
  const r = await req('POST', '/api/email-marketing/unsubscribe', { token });
  assert.equal(r.status, 200);
  assert.match(r.body, /You've been unsubscribed/);
  assert.equal(await marketingEnabled(), 'false');
});

test('POST performs the lead unsubscribe', async () => {
  const token = sign({ leadId, typ: 'unsub' });
  const r = await req('POST', '/api/email-marketing/unsubscribe', { token });
  assert.equal(r.status, 200);
  const { rows } = await pool.query('SELECT status FROM email_leads WHERE id = $1', [leadId]);
  assert.equal(rows[0].status, 'unsubscribed');
});

test('a token minted WITHOUT typ still works, on both verbs', async () => {
  // 365-day tokens are already in inboxes. typ is advisory; requiring it would
  // break every unsubscribe link already sent.
  await pool.query(
    `UPDATE clients SET communication_preferences = jsonb_set(communication_preferences,
       '{marketing_enabled}', 'true'::jsonb) WHERE id = $1`, [clientId]);
  const legacy = sign({ clientId, marketing: true });   // no typ
  assert.equal((await req('GET', `/api/email-marketing/unsubscribe?token=${legacy}`)).status, 200);
  assert.equal((await req('POST', '/api/email-marketing/unsubscribe', { token: legacy })).status, 200);
  assert.equal(await marketingEnabled(), 'false', 'a legacy token must still unsubscribe');
});

test('a garbage, missing, or wrong-shaped token is refused on both verbs', async () => {
  for (const path of ['/api/email-marketing/unsubscribe',
                      '/api/email-marketing/unsubscribe?token=not-a-jwt']) {
    assert.equal((await req('GET', path)).status, 400, `GET ${path}`);
  }
  assert.equal((await req('POST', '/api/email-marketing/unsubscribe', {})).status, 400);
  assert.equal((await req('POST', '/api/email-marketing/unsubscribe', { token: 'not-a-jwt' })).status, 400);
  // Signed, but carries neither a clientId nor a leadId.
  assert.equal((await req('POST', '/api/email-marketing/unsubscribe',
    { token: sign({ nothing: true }) })).status, 400);
});

// ─── Cross-identity opt-out (review findings H1/H3) ────────────────

test('a CLIENT-token unsubscribe also silences the matching lead row', async () => {
  // One human, two identity rows joined only by address. Writing one side is
  // how an honored opt-out still produced email: the sequence scheduler reads
  // email_leads and would have kept running its steps.
  const addr = `dual-c-${NONCE}@mkt-test.example`;
  const c = await pool.query('INSERT INTO clients (name,email) VALUES ($1,$2) RETURNING id', [`Dual ${NONCE}`, addr]);
  const l = await pool.query(
    `INSERT INTO email_leads (name,email,status,lead_source) VALUES ($1,$2,'active','quote_wizard') RETURNING id`,
    [`Dual ${NONCE}`, addr]);
  try {
    const r = await req('POST', '/api/email-marketing/unsubscribe',
      { token: sign({ clientId: c.rows[0].id, marketing: true, typ: 'unsub' }) });
    assert.equal(r.status, 200);
    const lead = await pool.query('SELECT status FROM email_leads WHERE id=$1', [l.rows[0].id]);
    assert.equal(lead.rows[0].status, 'unsubscribed', 'the lead row must be silenced too');
  } finally {
    await pool.query('DELETE FROM email_leads WHERE id=$1', [l.rows[0].id]);
    await pool.query('DELETE FROM clients WHERE id=$1', [c.rows[0].id]);
  }
});

test('a LEAD-token unsubscribe also silences the matching client row', async () => {
  // The other direction: the dispatcher reads clients, so a lead-only write
  // left the drip, retention nudge and New Year touch still firing.
  const addr = `dual-l-${NONCE}@mkt-test.example`;
  const c = await pool.query('INSERT INTO clients (name,email) VALUES ($1,$2) RETURNING id', [`Dual ${NONCE}`, addr]);
  const l = await pool.query(
    `INSERT INTO email_leads (name,email,status,lead_source) VALUES ($1,$2,'active','quote_wizard') RETURNING id`,
    [`Dual ${NONCE}`, addr]);
  try {
    const r = await req('POST', '/api/email-marketing/unsubscribe',
      { token: sign({ leadId: l.rows[0].id, typ: 'unsub' }) });
    assert.equal(r.status, 200);
    const cl = await pool.query(
      `SELECT communication_preferences->>'marketing_enabled' AS m FROM clients WHERE id=$1`, [c.rows[0].id]);
    assert.equal(cl.rows[0].m, 'false', 'the client row must be silenced too');
  } finally {
    await pool.query('DELETE FROM email_leads WHERE id=$1', [l.rows[0].id]);
    await pool.query('DELETE FROM clients WHERE id=$1', [c.rows[0].id]);
  }
});

test('a token carrying a CONFLICTING typ is refused', async () => {
  // Every token is signed with the same key when UNSUBSCRIBE_SECRET is unset.
  // An absent typ stays valid (legacy links); a typ that says it is something
  // else must not be usable as an unsubscribe credential.
  const bad = sign({ clientId, marketing: true, typ: 'auth' });
  assert.equal((await req('GET', `/api/email-marketing/unsubscribe?token=${bad}`)).status, 400);
  assert.equal((await req('POST', '/api/email-marketing/unsubscribe', { token: bad })).status, 400);
});

test('the confirmation page is not cacheable and not indexable', async () => {
  // It embeds a 365-day bearer credential in its HTML.
  const token = sign({ clientId, marketing: true, typ: 'unsub' });
  const u = new URL(base + `/api/email-marketing/unsubscribe?token=${token}`);
  const headers = await new Promise((resolve, reject) => {
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET' },
      res => { res.resume(); resolve(res.headers); });
    r.on('error', reject); r.end();
  });
  assert.match(headers['cache-control'] || '', /no-store/);
  assert.match(headers['x-robots-tag'] || '', /noindex/);
});

test('a CASE-VARIANT client row sharing the address is silenced too', async () => {
  // `idx_clients_email_unique` is UNIQUE on the RAW email, so exact twins are
  // impossible, but it does not lowercase: 'Bob@x.com' and 'bob@x.com' can both
  // exist, and so can a trailing-space variant. Matching the fan-out on
  // lower(btrim(email)) is what stops one of those staying mailable after the
  // other unsubscribes.
  const addr = `twin-${NONCE}@mkt-test.example`;
  const a = await pool.query('INSERT INTO clients (name,email) VALUES ($1,$2) RETURNING id',
    [`Twin A ${NONCE}`, addr]);
  const b = await pool.query('INSERT INTO clients (name,email) VALUES ($1,$2) RETURNING id',
    [`Twin B ${NONCE}`, addr.toUpperCase()]);
  try {
    const r = await req('POST', '/api/email-marketing/unsubscribe',
      { token: sign({ clientId: a.rows[0].id, marketing: true, typ: 'unsub' }) });
    assert.equal(r.status, 200);
    const { rows } = await pool.query(
      `SELECT communication_preferences->>'marketing_enabled' AS m FROM clients WHERE id = $1`, [b.rows[0].id]);
    assert.equal(rows[0].m, 'false', 'the case-variant row must be silenced too');
  } finally {
    await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [[a.rows[0].id, b.rows[0].id]]);
  }
});

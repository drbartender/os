// Route-level tests for the admin iCal DESCRIPTION formatting (fix-list #6).
//
// HARNESS NOTES
// -------------
// Mirrors the minimal-express harness pattern from
// server/routes/proposals/crud.test.js: mount the real calendar router on a
// fresh express() app with the real `auth` middleware and the same
// AppError-aware error handler as server/index.js, then drive it over real
// HTTP. Runs against the dev DB (DATABASE_URL from .env) — the same DB every
// other suite connects to. It creates real rows (client, proposal, shift,
// admin user w/ calendar_token, a staff teammate + approved shift_request) and
// purges every one in after().
//
// WHY route-level (not a pure buildAdminDescription unit): the bug this pins is
// a SELECT-column bug — `p.amount_paid` must be projected at BOTH admin query
// sites (the feed query AND the single-shift /event route) or the Balance line
// renders `NaN`. A pure builder test would pass even with the column missing
// from the query. So both routes are exercised end-to-end here.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const calendarRouter = require('./calendar');

// ─── Shared harness state ──────────────────────────────────────────────────
let server;
let baseUrl;
let adminToken;        // JWT for the admin user (single-shift /event route)
let calendarToken;     // the admin user's calendar_token UUID (feed route)
let shiftId;

// Track every row this suite creates so after() can purge precisely.
const created = { shiftRequestIds: [], shiftIds: [], proposalIds: [], clientIds: [], userIds: [] };

// ─── HTTP helper ────────────────────────────────────────────────────────────
function request(method, path, { token } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, raw: data }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// Unfold RFC-5545 line folding (CRLF + single leading space) and extract the
// DESCRIPTION value for a specific shift's VEVENT. The value itself contains
// escaped `\n` sequences (backslash + n) but no real CRLF, so after unfolding
// the DESCRIPTION property is one physical line terminated by the next
// CRLF-then-uppercase-property boundary.
function descForShift(ics, id) {
  const unfolded = ics.replace(/\r\n /g, '');
  const block = unfolded.split('BEGIN:VEVENT').find(b => b.includes(`UID:shift-${id}@drbartender.com`));
  if (!block) return null;
  const m = block.match(/\r\nDESCRIPTION:([\s\S]*?)\r\n[A-Z]/);
  return m ? m[1] : null;
}

// ─── Setup ──────────────────────────────────────────────────────────────────
before(async () => {
  const uniq = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

  // Admin user with a calendar_token (default gen_random_uuid()).
  const adminRes = await pool.query(
    `INSERT INTO users (email, password_hash, role, token_version)
     VALUES ($1, 'x', 'admin', 0) RETURNING id, calendar_token, token_version`,
    [`caltest-admin+${uniq}@example.test`]
  );
  const admin = adminRes.rows[0];
  created.userIds.push(admin.id);
  calendarToken = admin.calendar_token;
  adminToken = jwt.sign(
    { userId: admin.id, tokenVersion: admin.token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );

  // Staff teammate + contractor profile (preferred_name drives the Team line).
  const staffRes = await pool.query(
    `INSERT INTO users (email, password_hash, role, token_version)
     VALUES ($1, 'x', 'staff', 0) RETURNING id`,
    [`caltest-staff+${uniq}@example.test`]
  );
  const staffId = staffRes.rows[0].id;
  created.userIds.push(staffId);
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name) VALUES ($1, 'Alex Rivera')`,
    [staffId]
  );

  // Client.
  const clientRes = await pool.query(
    `INSERT INTO clients (name, email, phone, source)
     VALUES ('Feed Test Client', $1, '(312) 555-0100', 'direct') RETURNING id`,
    [`caltest-client+${uniq}@example.test`]
  );
  const clientId = clientRes.rows[0].id;
  created.clientIds.push(clientId);

  // Proposal: paid in full (amount_paid >= total → "Balance: paid").
  const propRes = await pool.query(
    `INSERT INTO proposals
       (client_id, guest_count, total_price, amount_paid, status, event_type,
        event_duration_hours, num_bars)
     VALUES ($1, 50, 400, 400, 'confirmed', 'Wedding', 4, 1) RETURNING id`,
    [clientId]
  );
  const proposalId = propRes.rows[0].id;
  created.proposalIds.push(proposalId);

  // Shift: 30 days out (inside the feed window), timed, with setup + notes.
  const shiftRes = await pool.query(
    `INSERT INTO shifts
       (event_date, start_time, end_time, location, notes, status, proposal_id,
        setup_minutes_before)
     VALUES (CURRENT_DATE + INTERVAL '30 days', '2:00 PM', '6:00 PM',
             'The Grand Hall', 'Bring extra ice', 'filled', $1, 60)
     RETURNING id`,
    [proposalId]
  );
  shiftId = shiftRes.rows[0].id;
  created.shiftIds.push(shiftId);

  // Approved shift_request → the teammate appears in the Team list.
  const srRes = await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'Bartender', 'approved') RETURNING id`,
    [shiftId, staffId]
  );
  created.shiftRequestIds.push(srRes.rows[0].id);

  // Minimal app: real calendar router + AppError-aware error handler.
  const app = express();
  app.use('/api/calendar', calendarRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

// ─── Teardown ───────────────────────────────────────────────────────────────
after(async () => {
  if (created.shiftRequestIds.length) await pool.query('DELETE FROM shift_requests WHERE id = ANY($1)', [created.shiftRequestIds]);
  if (created.shiftIds.length) await pool.query('DELETE FROM shifts WHERE id = ANY($1)', [created.shiftIds]);
  if (created.proposalIds.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [created.proposalIds]);
  if (created.clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1)', [created.clientIds]);
  if (created.userIds.length) {
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = ANY($1)', [created.userIds]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [created.userIds]);
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ─── Admin feed DESCRIPTION ───────────────────────────────────────────────
test('admin feed DESCRIPTION uses iCal-escaped real newlines, ordered lines, and the /events/shift link', async () => {
  const res = await request('GET', `/api/calendar/feed/${calendarToken}`);
  assert.equal(res.status, 200);

  const desc = descForShift(res.raw, shiftId);
  assert.ok(desc, 'expected a DESCRIPTION property for the seeded shift VEVENT');

  // Proper iCal newline escaping: the value contains the 2-char escape
  // sequence (backslash + n) produced by escapeICalText from a REAL newline...
  assert.ok(desc.includes('\\n'), 'DESCRIPTION should contain proper \\n iCal escapes');
  // ...and NOT the double-escaped (backslash + backslash + n) the old
  // literal-`\n`-join produced.
  assert.ok(!desc.includes('\\\\n'), 'DESCRIPTION must NOT contain double-escaped \\\\n');

  // Line 1: money summary, middle-dot separated.
  assert.ok(desc.includes('Guests: 50 · Total: $400 · Balance: paid'),
    `line 1 mismatch; got: ${desc}`);
  // Client line, venue, service window.
  assert.ok(desc.includes('Client: Feed Test Client'), 'client line missing');
  assert.ok(desc.includes('Venue: The Grand Hall'), 'venue line missing');
  assert.ok(desc.includes('Setup 1:00 PM · Service 2:00–6:00 PM'),
    `service window mismatch; got: ${desc}`);
  // Team block (admin header "Team:", NOT the staff "Dr. Bartender Team:").
  assert.ok(desc.includes('Team:'), 'team header missing');
  assert.ok(desc.includes('• Alex Rivera — Bartender'), 'team member line missing');
  // Notes.
  assert.ok(desc.includes('Notes: Bring extra ice'), 'notes line missing');
  // OS deep-link — shift route, not the event route.
  assert.ok(desc.includes(`/events/shift/${shiftId}`), 'OS shift deep-link missing');
  assert.ok(desc.includes('Open in OS:'), 'Open in OS label missing');

  // Ordering: guests → client → venue → setup → team → notes → open-in-os.
  const idx = (s) => desc.indexOf(s);
  assert.ok(idx('Guests: 50') < idx('Client: Feed Test Client'), 'guests before client');
  assert.ok(idx('Client: Feed Test Client') < idx('Venue: The Grand Hall'), 'client before venue');
  assert.ok(idx('Venue: The Grand Hall') < idx('Setup 1:00 PM'), 'venue before setup');
  assert.ok(idx('Setup 1:00 PM') < idx('Team:'), 'setup before team');
  assert.ok(idx('Team:') < idx('Notes:'), 'team before notes');
  assert.ok(idx('Notes:') < idx('Open in OS:'), 'notes before open-in-os');
});

// ─── Single-shift /event route Balance (2nd SELECT site) ──────────────────
test('single-shift .ics route projects amount_paid so Balance renders (no NaN)', async () => {
  const res = await request('GET', `/api/calendar/event/${shiftId}.ics`, { token: adminToken });
  assert.equal(res.status, 200);

  const desc = descForShift(res.raw, shiftId);
  assert.ok(desc, 'expected a DESCRIPTION property in the single-shift feed');
  assert.ok(desc.includes('Balance: paid'), `expected "Balance: paid"; got: ${desc}`);
  assert.ok(!desc.includes('NaN'), 'Balance must not render NaN (amount_paid missing from SELECT)');
  assert.ok(desc.includes(`/events/shift/${shiftId}`), 'OS shift deep-link missing in single-shift feed');
});

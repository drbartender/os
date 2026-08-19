require('dotenv').config();
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const router = require('./marketingOverview');
const { resolveMoments, isLive, needsSetup, MOMENT_BY_ID } = require('../utils/marketingMoments');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, base, adminToken, managerToken;
// Whatever real moment state exists before this suite runs. Restored in after().
const snapshot = { overrides: [], dismissals: [] };

function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const r = http.request(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = ''; res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

before(async () => {
  const a = await pool.query(
    `INSERT INTO users (email,password_hash,role,onboarding_status)
     VALUES ($1,'x','admin','approved') RETURNING id`, [`ovw-admin-${NONCE}@mkt-test.example`]);
  const m = await pool.query(
    `INSERT INTO users (email,password_hash,role,onboarding_status)
     VALUES ($1,'x','manager','approved') RETURNING id`, [`ovw-mgr-${NONCE}@mkt-test.example`]);
  adminToken = jwt.sign({ userId: a.rows[0].id, tokenVersion: 0 }, process.env.JWT_SECRET);
  managerToken = jwt.sign({ userId: m.rows[0].id, tokenVersion: 0 }, process.env.JWT_SECRET);

  // Capture, then clear. A real override on `why` would otherwise fail the
  // "untouched field still tracks the default" assertion outright — the suite
  // would break because of dev-UI state rather than because of the code.
  snapshot.overrides = (await pool.query('SELECT * FROM marketing_moment_overrides')).rows;
  snapshot.dismissals = (await pool.query('SELECT * FROM marketing_moment_dismissals')).rows;
  await pool.query('DELETE FROM marketing_moment_overrides');
  await pool.query('DELETE FROM marketing_moment_dismissals');

  const app = express();
  app.use(express.json());
  app.use('/api/marketing', router);
  app.use((err, _req, res, _next) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ error: err.message, fieldErrors: err.fieldErrors });
  });
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // SNAPSHOT AND RESTORE, not delete. Scoping the delete to "the moments these
  // tests touch" was cosmetic: those three ids ARE every moment there is, so a
  // scoped delete still wiped every real override and dismissal made through
  // the dev admin UI. Server suites share one database with a live dev app.
  await pool.query('DELETE FROM marketing_moment_overrides');
  await pool.query('DELETE FROM marketing_moment_dismissals');
  for (const r of snapshot.overrides) {
    await pool.query(
      `INSERT INTO marketing_moment_overrides (moment_id, field, value, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [r.moment_id, r.field, r.value, r.updated_by, r.updated_at]);
  }
  for (const r of snapshot.dismissals) {
    await pool.query(
      `INSERT INTO marketing_moment_dismissals (moment_id, occurrence_key, dismissed_by, dismissed_at)
       VALUES ($1,$2,$3,$4)`,
      [r.moment_id, r.occurrence_key, r.dismissed_by, r.dismissed_at]);
  }
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`ovw-%-${NONCE}@mkt-test.example`]);
  if (server) await new Promise(r => server.close(r));
  await pool.end();
});

// ─── The moment engine ─────────────────────────────────────────────

test('the holiday moment opens in August and closes after Sep 5', async () => {
  // The window IS the point: corporate holiday work is booked in September, so
  // a prompt arriving in October is a post-mortem, not a moment.
  const count = async () => 5;
  const openOn = async (iso) =>
    (await resolveMoments(new Date(iso), count)).find(m => m.id === 'holiday-corporate').open;

  assert.equal(await openOn('2026-08-01T15:00:00Z'), true);
  assert.equal(await openOn('2026-09-05T15:00:00Z'), true, 'the send-by date itself is still open');
  assert.equal(await openOn('2026-09-06T15:00:00Z'), false, 'the day after is closed');
  assert.equal(await openOn('2026-07-31T15:00:00Z'), false);
});

test('an annual moment is keyed by year; a rolling one by month', async () => {
  const count = async () => 5;
  const ms = await resolveMoments(new Date('2026-08-13T15:00:00Z'), count);
  assert.equal(ms.find(m => m.id === 'holiday-corporate').occurrence_key, '2026');
  assert.equal(ms.find(m => m.id === 'one-year-on').occurrence_key, '2026-08');
});

test('a moment with nobody in its audience is not live', async () => {
  // Still true, and still right: a moment with an empty audience is not SENDABLE.
  // The comment that used to sit here ("showing 'send to 0 people' is worse than
  // showing nothing") was the reasoning that caused a real miss, so it is recorded
  // as overturned rather than deleted: not-live was taken to mean not-rendered, and
  // `holiday-corporate` then sat open, undismissed and invisible on every surface
  // for most of an annual revenue window because `client_tags` was empty in prod.
  // Not live is correct. Not visible was the bug — see needsSetup below.
  const ms = await resolveMoments(new Date('2026-08-13T15:00:00Z'), async () => 0);
  assert.equal(ms.filter(isLive).length, 0);
});

test('an empty audience a HUMAN can fill is surfaced as needing setup', async () => {
  const ms = await resolveMoments(new Date('2026-08-13T15:00:00Z'), async () => 0);
  const flagged = ms.filter(needsSetup);
  assert.equal(flagged.length, 1, 'exactly the tag-gated moment');
  assert.equal(flagged[0].id, 'holiday-corporate');
  assert.equal(ms.filter(isLive).length, 0);
});

test('an empty audience only TIME can fill does NOT nag', async () => {
  // The anti-cry-wolf pin, and the reason needsSetup carries its last clause.
  // one-year-on and cold-quotes are open permanently (isOpen: () => true) and
  // their audiences are derived from event/proposal dates. On a young book both
  // are legitimately 0 — as of 2026-08 the earliest prod event is four months
  // old, so one-year-on cannot match anyone for another seven months. If these
  // ever start reporting "needs setup", the Overview begins nagging every day
  // about something nobody can act on, and the operator stops reading it.
  const ms = await resolveMoments(new Date('2026-08-13T15:00:00Z'), async () => 0);
  for (const id of ['one-year-on', 'cold-quotes']) {
    const m = ms.find(x => x.id === id);
    assert.equal(m.open, true, `test premise: ${id} is open`);
    assert.equal(m.emailable, 0, `test premise: ${id} has an empty audience here`);
    assert.equal(needsSetup(m), false, `${id} must not nag: only time fills it`);
  }
});

test('every open moment lands in exactly one bucket: sendable, needs-a-person, or waiting', async () => {
  // The original defect was a GAP between predicates that swallowed a moment
  // silently. Whatever the buckets are, they must account for every open moment,
  // so a future fourth state cannot vanish the same way.
  for (const size of [0, 1, 5, 500]) {
    const ms = await resolveMoments(new Date('2026-08-13T15:00:00Z'), async () => size);
    const open = ms.filter(m => m.open && !m.dismissed);
    const live = ms.filter(isLive);
    const setup = ms.filter(needsSetup);
    const waiting = open.filter(m => !isLive(m) && !needsSetup(m));
    assert.equal(live.length + setup.length + waiting.length, open.length,
      `audience size ${size}: the three buckets must cover the open set`);
    assert.equal(live.filter(m => setup.includes(m)).length, 0,
      `audience size ${size}: sendable and needs-setup must not overlap`);
    assert.ok(waiting.every(m => m.emailable === 0 && m.empty_audience === 'wait'),
      `audience size ${size}: anything waiting is empty AND time-gated, never a silent drop`);
  }
});

test('a moment carries its audience NAME and RULE, so an empty one can say why', async () => {
  // "past-corporate is empty" is not actionable; "nobody is tagged Corporate" is.
  const ms = await resolveMoments(new Date('2026-08-13T15:00:00Z'), async () => 0);
  const holiday = ms.find(m => m.id === 'holiday-corporate');
  assert.equal(holiday.audience_id, 'past-corporate');
  assert.equal(holiday.audience_name, 'Past clients · corporate');
  assert.match(holiday.audience_rule, /Corporate/);
  assert.ok(ms.every(m => typeof m.audience_name === 'string' && m.audience_name.length > 0),
    'every moment resolves a human audience name, never a bare id');
});

test('exceeds_daily_cap is computed for every moment, not just the illustrated one', async () => {
  const ms = await resolveMoments(new Date('2026-08-13T15:00:00Z'), async () => 500);
  assert.ok(ms.every(m => m.exceeds_daily_cap === true), 'a 500-person audience will not fit in a day');
  const small = await resolveMoments(new Date('2026-08-13T15:00:00Z'), async () => 5);
  assert.ok(small.every(m => m.exceeds_daily_cap === false));
});

// ─── Overrides: only what changed ──────────────────────────────────

test('editing ONE field leaves the others tracking the authored default', async () => {
  // The whole reason overrides are per-field: improving stock copy later must
  // still reach every moment nobody rewrote. Storing the record on first edit
  // would freeze all three the moment somebody fixed a typo in one.
  const def = MOMENT_BY_ID.get('one-year-on');
  const r = await req('PUT', '/api/marketing/moments/one-year-on', adminToken,
    { title: 'A year since their event' });
  assert.equal(r.status, 200);
  assert.equal(r.body.title, 'A year since their event');
  assert.equal(r.body.why, def.copy.why, 'the untouched field still tracks the default');
  assert.equal(r.body.window, def.copy.window);
  assert.deepEqual(r.body.edited_fields, ['title']);
});

test('clearing a field returns it to the authored default', async () => {
  const def = MOMENT_BY_ID.get('one-year-on');
  const r = await req('PUT', '/api/marketing/moments/one-year-on', adminToken, { title: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.title, def.copy.title, 'back to the default, not stuck at the rewrite');
  assert.deepEqual(r.body.edited_fields, []);
});

test('the rule, the audience and the window logic are NOT editable', async () => {
  // A moment whose rule drifted from its prose would put authored reasoning in
  // front of the wrong people.
  for (const bad of [{ audienceId: 'past-all' }, { audience_id: 'past-all' }, { isOpen: true }, { id: 'x' }]) {
    const r = await req('PUT', '/api/marketing/moments/one-year-on', adminToken, bad);
    assert.equal(r.status, 400, `${JSON.stringify(bad)} must be refused`);
  }
  assert.equal((await req('PUT', '/api/marketing/moments/one-year-on', adminToken, {})).status, 400);
  assert.equal((await req('PUT', '/api/marketing/moments/nope', adminToken, { title: 'x' })).status, 404);
});

// ─── Dismissal is per OCCURRENCE ───────────────────────────────────

test('dismissing an annual moment clears THIS year only', async () => {
  // The bug this prevents: a recurring revenue prompt silently deleted because
  // somebody tidied their screen once, with nobody ever finding out why it
  // stopped appearing.
  const d = await req('POST', '/api/marketing/moments/holiday-corporate/dismiss', adminToken);
  assert.equal(d.status, 200);
  const thisYear = d.body.occurrence_key;

  const nowMoments = await resolveMoments(new Date(`${thisYear}-08-13T15:00:00Z`), async () => 5);
  assert.equal(nowMoments.find(m => m.id === 'holiday-corporate').dismissed, true);

  const nextYear = await resolveMoments(new Date(`${Number(thisYear) + 1}-08-13T15:00:00Z`), async () => 5);
  assert.equal(nextYear.find(m => m.id === 'holiday-corporate').dismissed, false,
    'it must come back next September');
});

test('a dismissal can be undone', async () => {
  const r = await req('DELETE', '/api/marketing/moments/holiday-corporate/dismiss', adminToken);
  assert.equal(r.status, 200);
  assert.equal(r.body.dismissed, false);
  const ms = await resolveMoments(new Date(`${r.body.occurrence_key}-08-13T15:00:00Z`), async () => 5);
  assert.equal(ms.find(m => m.id === 'holiday-corporate').dismissed, false);
});

test('dismissing twice is idempotent, not an error', async () => {
  assert.equal((await req('POST', '/api/marketing/moments/one-year-on/dismiss', adminToken)).status, 200);
  assert.equal((await req('POST', '/api/marketing/moments/one-year-on/dismiss', adminToken)).status, 200);
  await req('DELETE', '/api/marketing/moments/one-year-on/dismiss', adminToken);
});

// ─── Overview and Sent ─────────────────────────────────────────────

test('the overview returns every section the screen renders', async () => {
  const r = await req('GET', '/api/marketing/overview', adminToken);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.moments));
  for (const k of ['emails_sent_all_time', 'past_clients_never_asked_back', 'repeat_corporate_bookings']) {
    assert.equal(typeof r.body.numbers[k], 'number', `numbers.${k}`);
  }
  for (const k of ['never_classified', 'do_not_contact', 'bounced']) {
    assert.equal(typeof r.body.needs_you[k], 'number', `needs_you.${k}`);
  }
  assert.equal(typeof r.body.base.mailable, 'number');
  assert.equal(typeof r.body.send_budget.remaining, 'number');
});

test('the held-back buckets sum to the total, as on the contacts screen', async () => {
  // Same CASE, so the two surfaces cannot disagree about who is held back.
  const b = (await req('GET', '/api/marketing/overview', adminToken)).body.base;
  assert.equal(b.mailable + b.do_not_contact + b.unsubscribed + b.bounced + b.no_address, b.total);
});

test('booked attribution counts a proposal within 30 days, once per person', async () => {
  const c = await pool.query('INSERT INTO clients (name,email) VALUES ($1,$2) RETURNING id',
    [`Ovw ${NONCE}`, `ovw-book-${NONCE}@mkt-test.example`]);
  const camp = await pool.query(
    `INSERT INTO email_campaigns (name,type,status,subject,html_body,sent_at)
     VALUES ($1,'blast','sent','S','<p>h</p>', NOW() - INTERVAL '10 days') RETURNING id`, [`OVW ${NONCE}`]);
  await pool.query(
    `INSERT INTO email_sends (campaign_id,client_id,subject,status,sent_at)
     VALUES ($1,$2,'S','sent', NOW() - INTERVAL '10 days')`, [camp.rows[0].id, c.rows[0].id]);
  // TWO proposals inside the window: one person, one booking.
  await pool.query(
    `INSERT INTO proposals (client_id,event_date,event_type,status,total_price,created_at)
     VALUES ($1, CURRENT_DATE + 30, 'corporate-event','sent',500, NOW() - INTERVAL '5 days'),
            ($1, CURRENT_DATE + 40, 'corporate-event','sent',600, NOW() - INTERVAL '4 days')`,
    [c.rows[0].id]);
  try {
    const r = await req('GET', '/api/marketing/sent', adminToken);
    assert.equal(r.status, 200);
    const row = r.body.campaigns.find(x => x.id === camp.rows[0].id);
    assert.ok(row, 'the campaign appears in Sent');
    assert.equal(row.sent, 1);
    assert.equal(row.booked, 1, 'two quotes from one person is ONE booking, not two');
    // Five, not four: six_months_out is registered and live in
    // marketingHandlers.js, and both screens tell the operator this list is
    // complete. An omission here is a promise the UI cannot keep.
    assert.equal(r.body.automations.length, 5, 'every live automation is named');
    const names = r.body.automations.map(a => a.name);
    assert.ok(names.includes('Six months out'), JSON.stringify(names));
  } finally {
    await pool.query('DELETE FROM proposals WHERE client_id=$1', [c.rows[0].id]);
    await pool.query('DELETE FROM email_sends WHERE campaign_id=$1', [camp.rows[0].id]);
    await pool.query('DELETE FROM email_campaigns WHERE id=$1', [camp.rows[0].id]);
    await pool.query('DELETE FROM clients WHERE id=$1', [c.rows[0].id]);
  }
});

test('a proposal OUTSIDE the 30-day window is not attributed', async () => {
  const c = await pool.query('INSERT INTO clients (name,email) VALUES ($1,$2) RETURNING id',
    [`OvwB ${NONCE}`, `ovw-late-${NONCE}@mkt-test.example`]);
  const camp = await pool.query(
    `INSERT INTO email_campaigns (name,type,status,subject,html_body,sent_at)
     VALUES ($1,'blast','sent','S','<p>h</p>', NOW() - INTERVAL '90 days') RETURNING id`, [`OVWB ${NONCE}`]);
  await pool.query(
    `INSERT INTO email_sends (campaign_id,client_id,subject,status,sent_at)
     VALUES ($1,$2,'S','sent', NOW() - INTERVAL '90 days')`, [camp.rows[0].id, c.rows[0].id]);
  // 40 days after the send: outside the window, and a proposal BEFORE it too.
  await pool.query(
    `INSERT INTO proposals (client_id,event_date,event_type,status,total_price,created_at)
     VALUES ($1, CURRENT_DATE + 30, 'corporate-event','sent',500, NOW() - INTERVAL '50 days'),
            ($1, CURRENT_DATE + 60, 'corporate-event','sent',700, NOW() - INTERVAL '100 days')`,
    [c.rows[0].id]);
  try {
    const r = await req('GET', '/api/marketing/sent', adminToken);
    const row = r.body.campaigns.find(x => x.id === camp.rows[0].id);
    assert.equal(row.booked, 0, 'attribution must not claim credit outside its own window');
  } finally {
    await pool.query('DELETE FROM proposals WHERE client_id=$1', [c.rows[0].id]);
    await pool.query('DELETE FROM email_sends WHERE campaign_id=$1', [camp.rows[0].id]);
    await pool.query('DELETE FROM email_campaigns WHERE id=$1', [camp.rows[0].id]);
    await pool.query('DELETE FROM clients WHERE id=$1', [c.rows[0].id]);
  }
});

test('a manager cannot read the overview or edit a moment', async () => {
  assert.equal((await req('GET', '/api/marketing/overview', managerToken)).status, 403);
  assert.equal((await req('PUT', '/api/marketing/moments/one-year-on', managerToken, { title: 'x' })).status, 403);
  assert.equal((await req('GET', '/api/marketing/overview', null)).status, 401);
});

// ─── Review round 1 (database-review, run on Fable) ────────────────

test('a FAILED send never gets credit for a booking', async () => {
  // The `sent` column guarded on status and the `booked` FILTER did not, while
  // a failed row carries a real sent_at (the claim lets the column default to
  // NOW() and the failure UPDATE leaves it). So a send that never left could
  // take credit — on the one number this tab exists to state honestly.
  const c = await pool.query('INSERT INTO clients (name,email) VALUES ($1,$2) RETURNING id',
    [`OvwF ${NONCE}`, `ovw-fail-${NONCE}@mkt-test.example`]);
  const camp = await pool.query(
    `INSERT INTO email_campaigns (name,type,status,subject,html_body,sent_at)
     VALUES ($1,'blast','sent','S','<p>h</p>', NOW() - INTERVAL '10 days') RETURNING id`, [`OVWF ${NONCE}`]);
  // A FAILED send row, with a real sent_at.
  await pool.query(
    `INSERT INTO email_sends (campaign_id,client_id,subject,status,sent_at)
     VALUES ($1,$2,'S','failed', NOW() - INTERVAL '10 days')`, [camp.rows[0].id, c.rows[0].id]);
  // ...and that person books anyway, on their own.
  await pool.query(
    `INSERT INTO proposals (client_id,event_date,event_type,status,total_price,created_at)
     VALUES ($1, CURRENT_DATE + 30, 'corporate-event','sent',500, NOW() - INTERVAL '5 days')`,
    [c.rows[0].id]);
  try {
    const r = await req('GET', '/api/marketing/sent', adminToken);
    const row = r.body.campaigns.find(x => x.id === camp.rows[0].id);
    assert.equal(row.sent, 0, 'a failed row is not a send');
    assert.equal(row.booked, 0, 'and it cannot claim a booking');
  } finally {
    await pool.query('DELETE FROM proposals WHERE client_id=$1', [c.rows[0].id]);
    await pool.query('DELETE FROM email_sends WHERE campaign_id=$1', [camp.rows[0].id]);
    await pool.query('DELETE FROM email_campaigns WHERE id=$1', [camp.rows[0].id]);
    await pool.query('DELETE FROM clients WHERE id=$1', [c.rows[0].id]);
  }
});

test('orphaned proposals cannot fake a repeat corporate booking', async () => {
  // proposals.client_id is nullable (ON DELETE SET NULL), and GROUP BY put every
  // orphan in ONE null group: two of them read as a phantom repeat booking,
  // poisoning the single metric whose thesis is that it has always been zero.
  const before = (await req('GET', '/api/marketing/overview', adminToken)).body.numbers.repeat_corporate_bookings;
  const made = [];
  for (let i = 0; i < 2; i++) {
    const p = await pool.query(
      `INSERT INTO proposals (client_id,event_date,event_type,status,total_price)
       VALUES (NULL, CURRENT_DATE + 30, 'Corporate Event','completed',900) RETURNING id`);
    made.push(p.rows[0].id);
  }
  try {
    const after = (await req('GET', '/api/marketing/overview', adminToken)).body.numbers.repeat_corporate_bookings;
    assert.equal(after, before, 'two orphaned corporate proposals are not a repeat client');
  } finally {
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [made]);
  }
});

test('the corporate predicate matches the shared vocabulary, punctuation and all', async () => {
  // Imported from marketingAudience rather than restated, so a dashboard number
  // cannot silently diverge from every audience when the list changes.
  const { CORPORATE_EVENT_TYPES } = require('../utils/marketingAudience');
  assert.ok(CORPORATE_EVENT_TYPES.includes('fundraiser-gala'));
  const c = await pool.query('INSERT INTO clients (name,email) VALUES ($1,$2) RETURNING id',
    [`OvwR ${NONCE}`, `ovw-rep-${NONCE}@mkt-test.example`]);
  const before = (await req('GET', '/api/marketing/overview', adminToken)).body.numbers.repeat_corporate_bookings;
  try {
    // 'Fundraiser / Gala' normalizes to fundraiser-gala only via NORM_EVENT_TYPE.
    await pool.query(
      `INSERT INTO proposals (client_id,event_date,event_type,status,total_price)
       VALUES ($1, CURRENT_DATE + 30, 'Fundraiser / Gala','completed',900),
              ($1, CURRENT_DATE + 60, 'Corporate Event','completed',900)`, [c.rows[0].id]);
    const after = (await req('GET', '/api/marketing/overview', adminToken)).body.numbers.repeat_corporate_bookings;
    assert.equal(after, before + 1, 'a punctuated spelling must still count as corporate');
  } finally {
    await pool.query('DELETE FROM proposals WHERE client_id=$1', [c.rows[0].id]);
    await pool.query('DELETE FROM clients WHERE id=$1', [c.rows[0].id]);
  }
});

test('the Needs-You queue and the base breakdown agree on "bounced"', async () => {
  // Both used to define bounced differently: Needs-You restated
  // email_status='bad' while the breakdown used the precedence-ordered
  // HELD_BACK_SQL. A client who is BOTH do-not-contact and hard-bounced then
  // appeared on two lines of the same page under two different labels.
  const c = await pool.query(
    `INSERT INTO clients (name,email,marketing_excluded,marketing_excluded_reason,email_status)
     VALUES ($1,$2,true,'both','bad') RETURNING id`,
    [`OvwBoth ${NONCE}`, `ovw-both-${NONCE}@mkt-test.example`]);
  try {
    const r = await req('GET', '/api/marketing/overview', adminToken);
    const n = r.body.needs_you;
    const b = r.body.base;
    assert.equal(n.bounced, b.bounced,
      'one definition of bounced, or the page contradicts itself');
    assert.equal(n.do_not_contact, b.do_not_contact,
      'and one definition of do-not-contact');
  } finally {
    await pool.query('DELETE FROM clients WHERE id=$1', [c.rows[0].id]);
  }
});

test('the automations list names every live marketing handler', async () => {
  // The screens promise completeness. This fails if a handler is registered
  // with category 'marketing' and nobody adds it to AUTOMATIONS.
  const { AUTOMATIONS } = require('../utils/marketingMoments');
  const src = require('fs').readFileSync(__dirname + '/../utils/marketingHandlers.js', 'utf8');
  const registered = [...src.matchAll(/^\s*'([a-z_]+)',\s*$/gm)].map(m => m[1]);
  for (const [handler, label] of [
    ['drip_', 'Unsigned proposal drip'], ['review_request', 'Review request'],
    ['six_months_out', 'Six months out'], ['retention_nudge', 'Retention nudge'],
    ['new_year_hello', 'New Year touch'],
  ]) {
    const isRegistered = registered.some(r => r.startsWith(handler)) || src.includes(`'${handler}'`);
    if (!isRegistered) continue;
    assert.ok(AUTOMATIONS.some(a => a.name === label),
      `${handler} is registered but "${label}" is not in AUTOMATIONS`);
  }
});

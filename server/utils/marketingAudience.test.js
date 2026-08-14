require('dotenv').config();
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const {
  isMailable, heldBackReason, MAILABLE_SQL, HELD_BACK_SQL,
  LEAD_UNSUB_LATERAL, HELD_BACK_REASONS, LAST_EVENT,
} = require('./marketingAudience');

after(async () => { await pool.end(); });

const ok = {
  email: 'a@b.com', email_status: 'ok', marketing_excluded: false,
  communication_preferences: {}, lead_unsubscribed: false,
};

test('a clean contact is mailable with no held-back reason', () => {
  assert.equal(isMailable(ok), true);
  assert.equal(heldBackReason(ok), null);
});

test('absent preference keys mean enabled (tri-state)', () => {
  // Every existing check in the codebase is `prefs.x === false`; an absent key
  // means enabled. A `= true` test would silently exclude the whole default.
  assert.equal(isMailable({ ...ok, communication_preferences: null }), true);
  assert.equal(isMailable({ ...ok, communication_preferences: {} }), true);
  assert.equal(isMailable({ ...ok, communication_preferences: { marketing_enabled: true } }), true);
});

const CASES = [
  ['marketing opt-out', { communication_preferences: { marketing_enabled: false } }, 'unsubscribed'],
  ['email opt-out', { communication_preferences: { email_enabled: false } }, 'unsubscribed'],
  ['house rule', { marketing_excluded: true }, 'do_not_contact'],
  ['null address', { email: null }, 'no_address'],
  ['blank address', { email: '   ' }, 'no_address'],
  ['bad status', { email_status: 'bad' }, 'bounced'],
  ['placeholder address', { email: 'x@arthrex-chicago.invalid' }, 'no_address'],
  ['placeholder with trailing space', { email: 'x@y.invalid ' }, 'no_address'],
  ['lead-side unsubscribe', { lead_unsubscribed: true }, 'unsubscribed'],
];

for (const [name, patch, reason] of CASES) {
  test(`${name} holds the contact back, reason ${reason}`, () => {
    const row = { ...ok, ...patch };
    assert.equal(isMailable(row), false);
    assert.equal(heldBackReason(row), reason);
  });
}

test('isMailable and heldBackReason are exact complements', () => {
  for (const [name, patch] of CASES) {
    const row = { ...ok, ...patch };
    assert.equal(isMailable(row), heldBackReason(row) === null, `${name} disagrees`);
  }
  assert.equal(isMailable(ok), heldBackReason(ok) === null);
});

test('every reason the classifier can produce is declared', () => {
  for (const [, , reason] of CASES) {
    assert.ok(HELD_BACK_REASONS.includes(reason), `${reason} not in HELD_BACK_REASONS`);
  }
});

test('MAILABLE_SQL is parameter-free and tri-state', () => {
  assert.equal(typeof MAILABLE_SQL, 'string');
  assert.ok(!/\$\d/.test(MAILABLE_SQL), 'must not contain bind parameters');
  assert.ok(MAILABLE_SQL.includes("IS DISTINCT FROM 'false'"), 'must be tri-state, never = true');
  assert.ok(MAILABLE_SQL.includes('btrim'), 'must btrim before the .invalid test, as isPlaceholderEmail does');
});

test('HELD_BACK_SQL is a CASE, so buckets are exclusive by construction', () => {
  // Documents why the aggregate must use this rather than N independent
  // COUNT FILTERs: those double-count a row that is both excluded and bounced.
  assert.match(HELD_BACK_SQL, /^\s*CASE/, 'must be a CASE');
  for (const r of HELD_BACK_REASONS) {
    assert.ok(HELD_BACK_SQL.includes(`'${r}'`), `${r} unreachable in SQL`);
  }
});

test('HELD_BACK_SQL and heldBackReason agree on every case, in the database', async () => {
  // The test that makes "one predicate" true rather than aspirational: run the
  // SQL leg and the JS leg over identical rows and require the same answer.
  const NONCE = `hb-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const ids = [];
  const mk = async (patch, i) => {
    const { rows } = await pool.query(
      `INSERT INTO clients (name, email, email_status, marketing_excluded,
                            marketing_excluded_reason, communication_preferences)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,
      [
        `HB ${NONCE}`,
        'email' in patch ? patch.email : `${NONCE}-${i}@mkt-test.example`,
        patch.email_status ?? 'ok',
        patch.marketing_excluded ?? false,
        patch.marketing_excluded ? 'test' : null,
        JSON.stringify(patch.prefs ?? {}),
      ]
    );
    return rows[0].id;
  };

  const cases = [
    {},                                                            // mailable
    { marketing_excluded: true },
    { prefs: { marketing_enabled: false } },
    { prefs: { email_enabled: false } },
    { email_status: 'bad' },
    { email: `${NONCE}@thing.invalid` },
    { email: null },
    { email: '   ' },
    { marketing_excluded: true, email_status: 'bad' },              // precedence
    { prefs: { marketing_enabled: false }, email_status: 'bad' },   // precedence
    { marketing_excluded: true, prefs: { marketing_enabled: false } }, // precedence
  ];

  try {
    for (let i = 0; i < cases.length; i++) ids.push(await mk(cases[i], i));
    const { rows } = await pool.query(`
      SELECT c.id, c.email, c.email_status, c.marketing_excluded,
             c.communication_preferences,
             COALESCE(lu.unsubscribed, false) AS lead_unsubscribed,
             ${HELD_BACK_SQL} AS sql_reason,
             (${MAILABLE_SQL}) AS sql_mailable
        FROM clients c ${LEAD_UNSUB_LATERAL}
       WHERE c.id = ANY($1)`, [ids]);

    assert.equal(rows.length, cases.length);
    for (const r of rows) {
      const js = heldBackReason(r);
      assert.equal(r.sql_reason, js,
        `reason disagreement on ${r.id}: SQL ${r.sql_reason} vs JS ${js}`);
      assert.equal(r.sql_mailable, isMailable(r),
        `mailable disagreement on ${r.id}: SQL ${r.sql_mailable} vs JS ${isMailable(r)}`);
      // And the two SQL expressions must agree with each other.
      assert.equal(r.sql_mailable, r.sql_reason === null,
        `MAILABLE_SQL and HELD_BACK_SQL disagree on ${r.id}`);
    }
  } finally {
    if (ids.length) await pool.query('DELETE FROM clients WHERE id = ANY($1)', [ids]);
  }
});

test('a lead-side unsubscribe is honored in SQL too', async () => {
  // 9 of the 16 email_leads rows are also clients, so someone who unsubscribed
  // from the one historical blast must not be re-mailable through this path.
  const NONCE = `lu-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const email = `${NONCE}@mkt-test.example`;
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1,$2) RETURNING id', [`LU ${NONCE}`, email]);
  const l = await pool.query(
    `INSERT INTO email_leads (name, email, status, lead_source)
     VALUES ($1,$2,'unsubscribed','quote_wizard') RETURNING id`, [`LU ${NONCE}`, email]);
  try {
    const { rows } = await pool.query(`
      SELECT COALESCE(lu.unsubscribed,false) AS lead_unsubscribed,
             ${HELD_BACK_SQL} AS reason, (${MAILABLE_SQL}) AS mailable
        FROM clients c ${LEAD_UNSUB_LATERAL} WHERE c.id = $1`, [c.rows[0].id]);
    assert.equal(rows[0].lead_unsubscribed, true, 'the lateral did not find the lead row');
    assert.equal(rows[0].mailable, false);
    assert.equal(rows[0].reason, 'unsubscribed');
  } finally {
    await pool.query('DELETE FROM email_leads WHERE id = $1', [l.rows[0].id]);
    await pool.query('DELETE FROM clients WHERE id = $1', [c.rows[0].id]);
  }
});

// ─── Audience definitions ──────────────────────────────────────────

const {
  AUDIENCES, AUDIENCE_BY_ID, CONTACT_AGGREGATES,
  CORPORATE_EVENT_TYPES, PERSONAL_EVENT_TYPES, UNCLASSIFIED_EVENT_TYPES,
} = require('./marketingAudience');

test('ships the seven audiences from the design, in order', () => {
  assert.deepEqual(AUDIENCES.map(a => a.id), [
    'past-corporate', 'past-all', 'one-year-on', 'cold-quotes-spring',
    'quoted-never-booked', 'thumbtack-live', 'never-classified',
  ]);
});

test('every audience carries display strings and a parameter-free where', () => {
  for (const a of AUDIENCES) {
    assert.ok(a.name && a.rule, `${a.id} missing name or rule`);
    assert.ok(Array.isArray(a.includes) && a.includes.length > 0, `${a.id} missing includes`);
    assert.ok(typeof a.where === 'string' && a.where.trim(), `${a.id} missing where`);
    assert.ok(!/\$\d/.test(a.where), `${a.id} where contains a bind parameter`);
  }
});

test('no audience filters on event type', () => {
  // legacy_cc_proposals.event_type is NULL on all 1,230 rows, so an
  // event-type rule silently drops the entire Check Cherry cohort.
  for (const a of AUDIENCES) {
    assert.ok(!/event_type/i.test(a.where), `${a.id} filters on event_type`);
  }
});

test('past-client audiences accept a Check Cherry booking, not just a proposal', () => {
  for (const id of ['past-corporate', 'past-all']) {
    assert.match(AUDIENCE_BY_ID.get(id).where, /cc\.booked_count/,
      `${id} gates on proposals only and would drop the Check Cherry cohort`);
  }
});

test('EVERY audience actually executes against the database', async () => {
  // The test that would have caught agg.last_inbound, a column that did not
  // exist and that no amount of reading the fragment revealed.
  for (const a of AUDIENCES) {
    const sql = `
      SELECT COUNT(*) FILTER (WHERE ${MAILABLE_SQL})::int AS emailable, COUNT(*)::int AS total
        FROM clients c ${LEAD_UNSUB_LATERAL} ${CONTACT_AGGREGATES}
       WHERE ${a.where}`;
    const { rows } = await pool.query(sql);   // throws 42703 on an undefined column
    assert.equal(typeof rows[0].emailable, 'number', `${a.id} returned no count`);
    assert.ok(rows[0].emailable <= rows[0].total, `${a.id}: emailable exceeds total`);
  }
});

test('the aggregates themselves execute and return the expected shape', async () => {
  const { rows } = await pool.query(`
    SELECT agg.proposal_count, agg.paid_count, agg.paid_dollars, agg.first_quoted,
           agg.last_finished, agg.corporate_events, agg.personal_events,
           agg.largest_guests, agg.a_venue,
           cc.booked_count, cc.paid_dollars AS cc_dollars, cc.last_event,
           tt.last_inbound, tg.tags, lc.last_contacted
      FROM clients c ${LEAD_UNSUB_LATERAL} ${CONTACT_AGGREGATES}
     ORDER BY c.id LIMIT 1`);
  assert.equal(rows.length, 1);
  assert.ok('last_inbound' in rows[0], 'tt.last_inbound is not exposed');
  assert.ok('last_contacted' in rows[0], 'lc.last_contacted is not exposed');
  assert.ok(Array.isArray(rows[0].tags), 'tg.tags is not an array');
});

test('lifetime dollars converts Check Cherry cents, so $760 is not $76,000', async () => {
  const NONCE = `cc-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const email = `${NONCE}@mkt-test.example`;
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1,$2) RETURNING id', [`CC ${NONCE}`, email]);
  await pool.query(
    `INSERT INTO legacy_cc_proposals (cc_id, status, client_email_normalized, event_date, total_cost_cents)
     VALUES ($1,'booked',$2, CURRENT_DATE - 400, 76000)`, [NONCE, email]);
  try {
    const { rows } = await pool.query(`
      SELECT (COALESCE(agg.paid_dollars,0) + COALESCE(cc.paid_dollars,0))::float8 AS lifetime,
             cc.booked_count::int, ${LAST_EVENT} AS last_event
        FROM clients c ${LEAD_UNSUB_LATERAL} ${CONTACT_AGGREGATES} WHERE c.id = $1`,
      [c.rows[0].id]);
    assert.ok(rows[0].lifetime >= 760 && rows[0].lifetime < 761,
      `expected ~760, got ${rows[0].lifetime}`);
    assert.equal(rows[0].booked_count, 1, 'a CC-only client must count as having paid');
    assert.ok(rows[0].last_event, 'a CC-only client must have a last_event');
  } finally {
    await pool.query('DELETE FROM legacy_cc_proposals WHERE cc_id = $1', [NONCE]);
    await pool.query('DELETE FROM clients WHERE id = $1', [c.rows[0].id]);
  }
});

test('a FUTURE-only Check Cherry booking does not make someone a past client', async () => {
  // The ledger runs to 2027-12-04. Without the past-only filter, a 2027
  // booking sorts to the top of "past clients".
  const NONCE = `fut-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const email = `${NONCE}@mkt-test.example`;
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1,$2) RETURNING id', [`FUT ${NONCE}`, email]);
  await pool.query(
    `INSERT INTO legacy_cc_proposals (cc_id, status, client_email_normalized, event_date, total_cost_cents)
     VALUES ($1,'booked',$2, CURRENT_DATE + 400, 50000)`, [NONCE, email]);
  try {
    const { rows } = await pool.query(`
      SELECT cc.last_event, ${LAST_EVENT} AS last_event_overall
        FROM clients c ${LEAD_UNSUB_LATERAL} ${CONTACT_AGGREGATES} WHERE c.id = $1`,
      [c.rows[0].id]);
    assert.equal(rows[0].last_event, null, 'a future booking leaked into last_event');
    assert.equal(rows[0].last_event_overall, -Infinity,
      'GREATEST should stay -infinity when there is no PAST event');
  } finally {
    await pool.query('DELETE FROM legacy_cc_proposals WHERE cc_id = $1', [NONCE]);
    await pool.query('DELETE FROM clients WHERE id = $1', [c.rows[0].id]);
  }
});

test('lookup by id works', () => {
  assert.equal(AUDIENCE_BY_ID.get('past-corporate').name, 'Past clients · corporate');
  assert.equal(AUDIENCE_BY_ID.get('nope'), undefined);
});

// ─── Event-type normalization (lane review, 2026-08-13) ────────────

test('NORM_EVENT_TYPE reconciles every spelling actually in prod', async () => {
  // A naive space-to-dash swap leaves 'Fundraiser / Gala' as
  // 'fundraiser-/-gala', which then misses 'fundraiser-gala'. This is the
  // defect that suggested Corporate to contacts whose only history was a
  // wedding, because their event type matched neither list.
  const cases = [
    ['Fundraiser / Gala', 'fundraiser-gala'],
    ['fundraiser-gala', 'fundraiser-gala'],
    ['Corporate Event', 'corporate-event'],
    ['corporate-event', 'corporate-event'],
    ['Graduation Party', 'graduation-party'],
    ['Bachelor / Bachelorette Party', 'bachelor-bachelorette-party'],
    ['Private Party', 'private-party'],
    ['Rehearsal Dinner', 'rehearsal-dinner'],
    ['Derby party', 'derby-party'],
  ];
  for (const [raw, want] of cases) {
    const { rows } = await pool.query(
      `SELECT btrim(lower(regexp_replace($1::text, '[^a-zA-Z0-9]+', '-', 'g')), '-') AS n`, [raw]);
    assert.equal(rows[0].n, want, `${raw} normalized wrong`);
  }
});

test('no event-type spelling in the database falls through every list', async () => {
  // Every distinct event_type must land in exactly one of the three exported
  // lists. A spelling in none of them is a SILENT fourth bucket: it neither
  // counts as corporate nor suppresses a corporate suggestion, which is
  // precisely how a wedding-only contact ended up suggested Corporate.
  //
  // The lists come from the module, never restated here, so this test cannot
  // pass against a copy that has drifted from the SQL.
  const known = new Set([
    ...CORPORATE_EVENT_TYPES, ...PERSONAL_EVENT_TYPES, ...UNCLASSIFIED_EVENT_TYPES,
    'walk-fixture', // a dev-only test fixture, not a real event type
  ]);
  // Server suites share ONE dev database, and other windows run their suites
  // concurrently. Their fixtures appear in this table mid-run, so an assertion
  // over live state has to ignore anything self-identifying as a fixture or it
  // fails for reasons that have nothing to do with the vocabulary. Narrow on
  // purpose: only spellings that literally say "test" are skipped, so a real
  // event type can never hide behind this.
  const looksLikeFixture = (n) => /(^|-)test(-|$)|(^|-)fixture(-|$)/.test(n);
  const { rows } = await pool.query(`
    SELECT DISTINCT btrim(lower(regexp_replace(event_type, '[^a-zA-Z0-9]+', '-', 'g')), '-') AS n
      FROM proposals
     WHERE status <> 'archived' AND event_type IS NOT NULL AND btrim(event_type) <> ''`);
  const unclassified = rows.map(r => r.n).filter(n => !known.has(n) && !looksLikeFixture(n)).sort();
  assert.deepEqual(unclassified, [],
    `unclassified event types: add each to CORPORATE_EVENT_TYPES, ` +
    `PERSONAL_EVENT_TYPES, or UNCLASSIFIED_EVENT_TYPES: ${unclassified.join(', ')}`);
});

test('the three event-type lists are disjoint', () => {
  // An overlap would make a single event both count as corporate and suppress
  // the corporate suggestion it just earned.
  const all = [...CORPORATE_EVENT_TYPES, ...PERSONAL_EVENT_TYPES, ...UNCLASSIFIED_EVENT_TYPES];
  const dupes = all.filter((t, i) => all.indexOf(t) !== i);
  assert.deepEqual(dupes, [], `event type in more than one list: ${dupes.join(', ')}`);
});

test('corporate_events counts only PAID events, so "Booked" is literal', async () => {
  const NONCE = `ce-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const c = await pool.query('INSERT INTO clients (name,email) VALUES ($1,$2) RETURNING id',
    [`CE ${NONCE}`, `${NONCE}@mkt-test.example`]);
  const id = c.rows[0].id;
  try {
    // A corporate event that was only ever QUOTED.
    await pool.query(
      `INSERT INTO proposals (client_id, event_date, event_type, status, total_price)
       VALUES ($1, CURRENT_DATE - 10, 'Corporate Event', 'sent', 500)`, [id]);
    let r = await pool.query(
      `SELECT agg.corporate_events::int AS ce FROM clients c ${LEAD_UNSUB_LATERAL} ${CONTACT_AGGREGATES} WHERE c.id=$1`, [id]);
    assert.equal(r.rows[0].ce, 0, 'a quote must not count as booked');

    // Now one they actually paid for.
    await pool.query(
      `INSERT INTO proposals (client_id, event_date, event_type, status, total_price, amount_paid)
       VALUES ($1, CURRENT_DATE - 20, 'Fundraiser / Gala', 'completed', 700, 700)`, [id]);
    r = await pool.query(
      `SELECT agg.corporate_events::int AS ce FROM clients c ${LEAD_UNSUB_LATERAL} ${CONTACT_AGGREGATES} WHERE c.id=$1`, [id]);
    assert.equal(r.rows[0].ce, 1, 'a paid Fundraiser / Gala must count, punctuation and all');
  } finally {
    await pool.query('DELETE FROM proposals WHERE client_id=$1', [id]);
    await pool.query('DELETE FROM clients WHERE id=$1', [id]);
  }
});

test('a wedding-only contact on a company domain is NOT suggested corporate', async () => {
  const NONCE = `wo-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const c = await pool.query('INSERT INTO clients (name,email) VALUES ($1,$2) RETURNING id',
    [`WO ${NONCE}`, `${NONCE}@somecompany.com`]);
  const id = c.rows[0].id;
  try {
    await pool.query(
      `INSERT INTO proposals (client_id, event_date, event_type, status, total_price)
       VALUES ($1, CURRENT_DATE - 10, 'Rehearsal Dinner', 'sent', 400)`, [id]);
    const { rows } = await pool.query(
      `SELECT c.email, agg.corporate_events::int AS ce, agg.personal_events::int AS pe
         FROM clients c ${LEAD_UNSUB_LATERAL} ${CONTACT_AGGREGATES} WHERE c.id=$1`, [id]);
    assert.equal(rows[0].pe, 1, 'Rehearsal Dinner must register as a personal event');
    const { suggestTag } = require('./marketingSuggestions');
    assert.equal(suggestTag({
      email: rows[0].email,
      corporateEventCount: rows[0].ce,
      personalEventCount: rows[0].pe,
    }), null, 'a company domain with only personal history must suggest nothing');
  } finally {
    await pool.query('DELETE FROM proposals WHERE client_id=$1', [id]);
    await pool.query('DELETE FROM clients WHERE id=$1', [id]);
  }
});

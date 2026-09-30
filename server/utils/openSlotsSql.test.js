require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { parsePositionsNeeded, openSlotsSql } = require('./positionsNeeded');
const { canonicalizeRole } = require('./staffingRoles');
const { roleFill } = require('./staffingClassification');

if (process.env.NODE_ENV === 'production') {
  throw new Error('openSlotsSql.test.js refuses to run against production');
}

// openSlotsSql (SQL) and roleFill (JS) state ONE staffing rule, by role (lane
// staffing-rule-by-role, 2026-09-30). The Needs staff flag, the tab badge and
// the unstaffed list read the SQL; confirmStaffingIfFullyStaffed and the client
// twin read the JS. This seeds every roster shape and request state on the dev
// DB and asserts the two agree row by row, and that each gives the number the
// rule says.

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const MIXED = '["Bartender","Bartender","Barback"]';

// [label, positions_needed, requests as [position, status, dropped], expected open]
const CASES = [
  ['mixed over-fill: an extra bartender never fills the barback slot', MIXED,
    [['Bartender', 'approved'], ['Bartender', 'approved'], ['Bartender', 'approved']], 1],
  ['mixed, exactly filled', MIXED,
    [['Bartender', 'approved'], ['Bartender', 'approved'], ['Barback', 'approved']], 0],
  ['a role the roster never declared fills nothing', '["Bartender"]', [['Barback', 'approved']], 1],
  ['a roleless approval takes the slot with room', MIXED,
    [['Bartender', 'approved'], ['Bartender', 'approved'], [null, 'approved']], 0],
  // Unknown role text on a request is impossible: the shift_requests_position_canonical
  // CHECK allows only the canonical labels or NULL, so NULL is the only roleless case.
  ['a roleless approval with no room fills nothing more', '["Bartender"]',
    [['Bartender', 'approved'], [null, 'approved']], 0],
  ['a dropped approval does not count', '["Bartender"]', [['Bartender', 'approved', true]], 1],
  ['pending and denied requests do not count', '["Bartender","Bartender"]',
    [['Bartender', 'pending'], ['Bartender', 'denied']], 2],
  ['legacy object shape with a numeric count', '[{"position":"bartender","count":2}]',
    [['Bartender', 'approved']], 1],
  ['legacy object shape: a numeric string count, ceiled', '[{"position":"Barback","count":"1.5"}]', [], 2],
  ['legacy object shape: decimal strings as Number() reads them: "+1", ".5" and "5."',
    '[{"position":"bartender","count":"+1"},{"position":"barback","count":".5"},{"position":"server","count":"2."}]', [], 4],
  ['legacy object shape: count true is 1, missing and negative are 0',
    '[{"position":"bartender","count":true},{"position":"barback"},{"position":"server","count":-3}]', [], 1],
  ['an empty roster is one slot', '[]', [], 1],
  ['an empty roster is filled by any approval', '[]', [['Barback', 'approved']], 0],
  ['a malformed roster reads as empty: one slot', 'not-json', [], 1],
  ['a NULL roster reads as empty: one slot', null, [], 1],
  ['a roster of unknown roles reads as empty: one slot', '["Mixologist"]', [], 1],
  ['a roster of unknown roles is filled by a roleless approval', '["Mixologist"]', [[null, 'approved']], 0],
  ['roster roles are trimmed and case-folded; server is Banquet Server', '[" BARTENDER ","server"]',
    [['Banquet Server', 'approved']], 1],
  ['an object with no position key fills nothing', '[{"role":"Bartender","count":2}]', [], 1],
  // A nested array is left out: JS String() reads ["Bartender"] as "Bartender" and the
  // parser counts it, the SQL does not. No row has ever held one (openSlotsSql's comment).
  ['non-string elements fill nothing', '[1, null, true, "Bartender"]', [], 1],
];

const MAX_REQUESTS = Math.max(...CASES.map(([, , reqs]) => reqs.length));
const staffIds = [];
const shiftIds = [];

before(async () => {
  for (let n = 0; n < MAX_REQUESTS; n++) {
    const u = await pool.query(
      `INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1, 'x', 'staff', 'approved') RETURNING id`,
      [`openslots-staff${n}-${NONCE}@example.com`]
    );
    staffIds.push(u.rows[0].id);
  }
  for (const [label, positions, requests] of CASES) {
    const s = await pool.query(
      `INSERT INTO shifts (event_date, start_time, end_time, status, location, client_name, positions_needed)
       VALUES (CURRENT_DATE + 5, '18:00', '22:00', 'open', 'X', $1, $2) RETURNING id`,
      [`OpenSlots ${label} ${NONCE}`, positions]
    );
    const shiftId = s.rows[0].id;
    shiftIds.push(shiftId);
    for (let i = 0; i < requests.length; i++) {
      const [position, status, dropped] = requests[i];
      await pool.query(
        `INSERT INTO shift_requests (shift_id, user_id, position, status, dropped_at)
         VALUES ($1, $2, $3, $4, ${dropped ? 'NOW()' : 'NULL'})`,
        [shiftId, staffIds[i], position, status]
      );
    }
  }
});

after(async () => {
  if (shiftIds.length) await pool.query('DELETE FROM shifts WHERE id = ANY($1::int[])', [shiftIds]);
  if (staffIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [staffIds]);
  await pool.end();
});

// The JS reading of the same fixture, as the server's callers build it.
function jsOpen(positions, requests) {
  const named = {};
  let roleless = 0;
  for (const [position, status, dropped] of requests) {
    if (status !== 'approved' || dropped) continue;
    const role = canonicalizeRole(position);
    if (role) named[role] = (named[role] || 0) + 1;
    else roleless += 1;
  }
  return roleFill(parsePositionsNeeded(positions), named, roleless).open;
}

test('openSlotsSql equals roleFill on every roster shape and request state, and both give the rule\'s number', async () => {
  const r = await pool.query(
    `SELECT s.id, ${openSlotsSql('s')} AS open FROM shifts s WHERE s.id = ANY($1::int[])`,
    [shiftIds]
  );
  const sqlOpen = new Map(r.rows.map((row) => [row.id, row.open]));
  CASES.forEach(([label, positions, requests, expected], i) => {
    const js = jsOpen(positions, requests);
    assert.equal(js, expected, `JS: ${label}`);
    assert.equal(sqlOpen.get(shiftIds[i]), expected, `SQL: ${label}`);
  });
});

// SQL only: each element's count is capped at 1000, so an absurd legacy count can
// never overflow the fragment's ::int and 500 the badge. Proven with 5000 and
// "7000", not a truly absurd number: this dev DB is shared, and the JS parser
// in any open admin tab would loop a count like 1e30 for as long as it existed
// (the write path is the real fix, on the fix list).
test('a legacy count above the cap reads as 1000 per element', async () => {
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, location, client_name, positions_needed)
     VALUES (CURRENT_DATE + 5, '18:00', '22:00', 'open', 'X', $1, $2) RETURNING id`,
    [`OpenSlots capped ${NONCE}`, '[{"position":"bartender","count":5000},{"position":"barback","count":"7000"}]']
  );
  shiftIds.push(s.rows[0].id);
  const r = await pool.query(`SELECT ${openSlotsSql('s')} AS open FROM shifts s WHERE s.id = $1`, [s.rows[0].id]);
  assert.equal(r.rows[0].open, 2000);
});

// SQL only: a count padded with a Unicode space (here a no-break space) is not a
// count here, where JS Number() would read 2. It must never raise: Postgres \s
// matches it but ::numeric rejects it, which would 500 the badge.
test('a count padded with a no-break space reads as no count and never raises', async () => {
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, location, client_name, positions_needed)
     VALUES (CURRENT_DATE + 5, '18:00', '22:00', 'open', 'X', $1, $2) RETURNING id`,
    [`OpenSlots nbsp ${NONCE}`, JSON.stringify([{ position: 'bartender', count: '\u00a02' }, { position: 'barback', count: '2\u3000' }])]
  );
  shiftIds.push(s.rows[0].id);
  const r = await pool.query(`SELECT ${openSlotsSql('s')} AS open FROM shifts s WHERE s.id = $1`, [s.rows[0].id]);
  assert.equal(r.rows[0].open, 1, 'no readable count: the roster reads as empty, one slot');
});

test('openSlotsSql never raises on a malformed roster, in a WHERE over many rows', async () => {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM shifts s WHERE s.id = ANY($1::int[]) AND ${openSlotsSql('s')} > 0`,
    [shiftIds.slice(0, CASES.length)]
  );
  assert.equal(r.rows[0].n, CASES.filter(([, , , expected]) => expected > 0).length);
});

require('dotenv').config();
if (process.env.NODE_ENV === 'production') throw new Error('refusing to run search tests against production');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  escapeLikePattern,
  extractDigits,
  formatPhoneDisplay,
  humanizeStaffStatus,
  runGlobalSearch,
} = require('./globalSearch');

// ---- pure helpers (no database) ----

test('escapeLikePattern > escapes LIKE wildcards and the escape char', () => {
  assert.strictEqual(escapeLikePattern('50%'), '50\\%');
  assert.strictEqual(escapeLikePattern('a_b'), 'a\\_b');
  assert.strictEqual(escapeLikePattern('x\\y'), 'x\\\\y');
  assert.strictEqual(escapeLikePattern('plain'), 'plain');
});

test('extractDigits > keeps only digits', () => {
  assert.strictEqual(extractDigits('(555) 867-5309'), '5558675309');
  assert.strictEqual(extractDigits('Gandalf'), '');
  assert.strictEqual(extractDigits(''), '');
  assert.strictEqual(extractDigits(null), '');
});

test('formatPhoneDisplay > formats a clean 10-digit number', () => {
  assert.strictEqual(formatPhoneDisplay('5558675309'), '(555) 867-5309');
  assert.strictEqual(formatPhoneDisplay('(555) 867-5309'), '(555) 867-5309');
});

test('formatPhoneDisplay > passes through anything that is not 10 digits', () => {
  assert.strictEqual(formatPhoneDisplay('123'), '123');
  assert.strictEqual(formatPhoneDisplay(''), '');
  assert.strictEqual(formatPhoneDisplay(null), '');
});

test('humanizeStaffStatus > maps known statuses and falls back', () => {
  assert.strictEqual(humanizeStaffStatus('approved'), 'Active bartender');
  assert.strictEqual(humanizeStaffStatus('applied'), 'Applicant (applied)');
  assert.strictEqual(humanizeStaffStatus('rejected'), 'Rejected applicant');
  assert.strictEqual(humanizeStaffStatus('something_else'), 'Staff');
});

// ---- runGlobalSearch (hits the local database) ----
// Fixture client name carries a recognizable prefix so cleanup is exact.

const MARKER = 'zz_searchtest_';
let clientId;
// One proposal per shape the phone search draws (lane ma-f3): a sent one with
// a date and a known type, a draft with neither, and a booked one (which the
// search files under events).
const P = {};

before(async () => {
  await pool.query("DELETE FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'zz_searchtest_%')");
  await pool.query("DELETE FROM clients WHERE name LIKE 'zz_searchtest_%'");
  const c = await pool.query(
    `INSERT INTO clients (name, email, phone, source) VALUES ($1, $2, $3, 'direct') RETURNING id`,
    [`${MARKER}gandalf`, `${MARKER}grey@example.com`, '(555) 867-5309']
  );
  clientId = c.rows[0].id;
  const seed = async (status, eventType, eventDate) => (await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, event_date, event_type)
     VALUES ($1, $2, 1000, $3, $4) RETURNING id`,
    [clientId, status, eventDate, eventType]
  )).rows[0].id;
  P.sent = await seed('sent', 'wedding-reception', '2026-10-24');
  P.draft = await seed('draft', 'other', null);
  P.booked = await seed('confirmed', 'birthday-party', '2027-01-09');
});

after(async () => {
  await pool.query('DELETE FROM proposals WHERE client_id = $1', [clientId]);
  await pool.query("DELETE FROM clients WHERE name LIKE 'zz_searchtest_%'");
  await pool.end();
});

test('runGlobalSearch > matches a client by partial name', async () => {
  const { clients } = await runGlobalSearch('gandalf');
  assert.ok(clients.some((c) => c.type === 'client' && c.name === `${MARKER}gandalf`));
});

test('runGlobalSearch > matches a client by partial email', async () => {
  const { clients } = await runGlobalSearch('grey@exam');
  assert.ok(clients.some((c) => c.name === `${MARKER}gandalf`));
});

test('runGlobalSearch > matches a client by phone digits despite stored formatting', async () => {
  const { clients } = await runGlobalSearch('867-5309');
  assert.ok(clients.some((c) => c.name === `${MARKER}gandalf`));
});

test('runGlobalSearch > returns empty groups for a query under 2 characters', async () => {
  const res = await runGlobalSearch('g');
  assert.deepStrictEqual(res, { clients: [], proposals: [], events: [], staff: [] });
});

test('runGlobalSearch > returns empty groups for a query over 100 characters', async () => {
  const res = await runGlobalSearch('x'.repeat(101));
  assert.deepStrictEqual(res, { clients: [], proposals: [], events: [], staff: [] });
});

// ---- the phone search's row fields (lane ma-f3) ----

test('runGlobalSearch > a proposal row carries status, event_date and kind beside the palette keys', async () => {
  const { proposals } = await runGlobalSearch('gandalf');
  const sent = proposals.find((p) => p.id === P.sent);
  assert.ok(sent, 'the sent proposal is in the proposals group');
  assert.strictEqual(sent.type, 'proposal');
  assert.strictEqual(sent.name, `${MARKER}gandalf`);
  assert.strictEqual(sent.detail, 'Wedding Reception · Oct 24, 2026');
  assert.ok('proposal_cc_id' in sent && 'client_cc_id' in sent);
  assert.strictEqual(sent.status, 'sent');
  assert.strictEqual(sent.event_date, '2026-10-24');
  assert.strictEqual(sent.kind, 'Wedding Reception');
});

test('runGlobalSearch > a proposal with no date answers event_date null and the fallback kind', async () => {
  const { proposals } = await runGlobalSearch('gandalf');
  const draft = proposals.find((p) => p.id === P.draft);
  assert.ok(draft, 'the draft is in the proposals group');
  assert.strictEqual(draft.status, 'draft');
  assert.strictEqual(draft.event_date, null);
  assert.strictEqual(draft.kind, 'event');
  assert.strictEqual(draft.detail, 'event');
});

test('runGlobalSearch > a booked proposal is an event row with the same three fields', async () => {
  const { proposals, events } = await runGlobalSearch('gandalf');
  assert.ok(!proposals.some((p) => p.id === P.booked), 'a booked proposal is not in proposals');
  const ev = events.find((e) => e.id === P.booked);
  assert.ok(ev, 'the booked proposal is in the events group');
  assert.strictEqual(ev.type, 'event');
  assert.strictEqual(ev.detail, 'Birthday Party · Jan 9, 2027');
  assert.strictEqual(ev.status, 'confirmed');
  assert.strictEqual(ev.event_date, '2027-01-09');
  assert.strictEqual(ev.kind, 'Birthday Party');
});

require('dotenv').config();
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

before(async () => {
  await pool.query("DELETE FROM clients WHERE name LIKE 'zz_searchtest_%'");
  await pool.query(
    `INSERT INTO clients (name, email, phone, source) VALUES ($1, $2, $3, 'direct')`,
    [`${MARKER}gandalf`, `${MARKER}grey@example.com`, '(555) 867-5309']
  );
});

after(async () => {
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

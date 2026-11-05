'use strict';
// findOrCreateClientDetailed's phoneMatch option (audit 2026-11-05 AUTH-02).
//
// The public quote wizard is unauthenticated, and a phone + name match used to
// stamp the submitted email onto a matched email-less row: anyone who knew a
// phone-only client's name and mobile (both visible in a Thumbtack thread)
// could attach their own address to that client, after which the portal's OTP
// login (clientAuth.js resolves the client by email) minted a session for the
// victim's client id and every lifecycle email for the victim's bookings went
// to the attacker. The wizard now passes phoneMatch: false, so a phone + name
// never resolves or mutates a stranger's row; the admin proposal-create path
// (crud.js) keeps the default and the backfill it exists for.
//
// Pure: the helper takes the caller's pg client, so a fake one records every
// statement and answers from two fixture rows. The DB-backed sibling is
// clientDedup.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findOrCreateClientDetailed } = require('./clientDedup');

// A fake pg client over one phone-only row (a Thumbtack lead, email NULL) and
// an optional email-bearing row. Returns ids the way the real statements do.
function fakeDb({ phoneOnlyRow = null, emailRow = null } = {}) {
  const calls = [];
  let nextId = 900;
  return {
    calls,
    query(text, params = []) {
      calls.push({ text, params });
      if (text.includes('WHERE LOWER(email) = $1')) return Promise.resolve({ rows: emailRow ? [emailRow] : [] });
      if (text.includes('REGEXP_REPLACE(phone')) return Promise.resolve({ rows: phoneOnlyRow ? [phoneOnlyRow] : [] });
      if (text.startsWith('UPDATE clients')) return Promise.resolve({ rows: [], rowCount: 1 });
      if (text.startsWith('INSERT INTO clients')) return Promise.resolve({ rows: [{ id: nextId++ }] });
      return Promise.resolve({ rows: [] }); // SAVEPOINT / RELEASE
    },
  };
}

const emailWrites = (db) => db.calls.filter((c) => /UPDATE clients SET email/.test(c.text));
const phoneLookups = (db) => db.calls.filter((c) => c.text.includes('REGEXP_REPLACE(phone'));
const inserts = (db) => db.calls.filter((c) => c.text.startsWith('INSERT INTO clients'));

test('phoneMatch: false (the public wizard): a phone + name match neither resolves nor stamps the phone-only row', async () => {
  const db = fakeDb({ phoneOnlyRow: { id: 42 } });
  const r = await findOrCreateClientDetailed(db, {
    name: 'Phone Only Lead', email: 'stranger@example.com', phone: '555-010-2929', source: 'website', phoneMatch: false,
  });
  assert.notEqual(r.id, 42, 'the stranger must not be handed the phone-only client');
  assert.equal(r.created, true, 'the submitter gets a row of their own');
  assert.deepEqual(emailWrites(db), [], 'no UPDATE of clients.email may run on the public path');
  assert.deepEqual(phoneLookups(db), [], 'the phone + name lookup is not even made');
  assert.equal(inserts(db).length, 1);
  assert.deepEqual(inserts(db)[0].params, ['Phone Only Lead', 'stranger@example.com', '555-010-2929', 'website', null]);
});

test('the default path (admin proposal-create) still resolves the phone-only row and backfills its email', async () => {
  const db = fakeDb({ phoneOnlyRow: { id: 42 } });
  const r = await findOrCreateClientDetailed(db, {
    name: 'Phone Only Lead', email: 'Lead@example.com', phone: '(555) 010-2929', source: 'direct',
  });
  assert.deepEqual(r, { id: 42, created: false });
  assert.equal(emailWrites(db).length, 1);
  assert.deepEqual(emailWrites(db)[0].params, [42, 'lead@example.com']);
  assert.ok(emailWrites(db)[0].text.includes('COALESCE(email, $2)'), 'backfill only, never an overwrite');
  assert.deepEqual(inserts(db), []);
});

test('phoneMatch: false still resolves an email match as-is (no write, no insert)', async () => {
  const db = fakeDb({ phoneOnlyRow: { id: 42 }, emailRow: { id: 7 } });
  const r = await findOrCreateClientDetailed(db, {
    name: 'Whoever', email: 'Known@example.com', phone: '555-010-9999', source: 'website', phoneMatch: false,
  });
  assert.deepEqual(r, { id: 7, created: false });
  assert.deepEqual(db.calls.filter((c) => /^(UPDATE|INSERT)/.test(c.text)), [], 'an email match stamps nothing');
});

test('phoneMatch: false with no phone at all behaves like the default (one insert)', async () => {
  const db = fakeDb();
  const r = await findOrCreateClientDetailed(db, { name: 'No Phone', email: 'nophone@example.com', source: 'website', phoneMatch: false });
  assert.equal(r.created, true);
  assert.equal(inserts(db).length, 1);
});

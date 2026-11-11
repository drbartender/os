'use strict';
// findOrCreateClientDetailed's stampEmail option (audit 2026-11-05 AUTH-02).
//
// The public quote wizard is unauthenticated, and a phone + name match used to
// stamp the submitted email onto a matched email-less row: anyone who knew a
// phone-only client's name and mobile (both visible in a Thumbtack thread)
// could attach their own address to that client, after which the portal's OTP
// login (clientAuth.js resolves the client by email) minted a session for the
// victim's client id and every lifecycle email for the victim's bookings went
// to the attacker. The wizard now passes stampEmail: false, so the phone + name
// match still resolves the row (one row per person) but writes nothing onto
// it; the admin proposal-create path (crud.js) keeps the default and the
// backfill it exists for.
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

test('stampEmail: false (the public wizard): a phone + name match resolves the phone-only row and writes nothing onto it', async () => {
  const db = fakeDb({ phoneOnlyRow: { id: 42 } });
  const r = await findOrCreateClientDetailed(db, {
    name: 'Phone Only Lead', email: 'stranger@example.com', phone: '555-010-2929', source: 'website', stampEmail: false,
  });
  assert.deepEqual(r, { id: 42, created: false }, 'one row per person: the match resolves the existing row');
  assert.deepEqual(emailWrites(db), [], 'no UPDATE of clients.email may run on the public path');
  assert.deepEqual(inserts(db), [], 'no second row');
  assert.equal(phoneLookups(db).length, 1, 'the name + phone lookup still runs');
});

test('stampEmail: false with a phone that matches no row inserts the submitted identity', async () => {
  const db = fakeDb();
  const r = await findOrCreateClientDetailed(db, {
    name: 'New Lead', email: 'new@example.com', phone: '555-010-3030', source: 'website', stampEmail: false,
  });
  assert.equal(r.created, true);
  assert.deepEqual(inserts(db)[0].params, ['New Lead', 'new@example.com', '555-010-3030', 'website', null]);
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

test('stampEmail: false still resolves an email match as-is (no write, no insert)', async () => {
  const db = fakeDb({ phoneOnlyRow: { id: 42 }, emailRow: { id: 7 } });
  const r = await findOrCreateClientDetailed(db, {
    name: 'Whoever', email: 'Known@example.com', phone: '555-010-9999', source: 'website', stampEmail: false,
  });
  assert.deepEqual(r, { id: 7, created: false });
  assert.deepEqual(db.calls.filter((c) => /^(UPDATE|INSERT)/.test(c.text)), [], 'an email match stamps nothing');
});

test('stampEmail: false with no phone at all behaves like the default (one insert)', async () => {
  const db = fakeDb();
  const r = await findOrCreateClientDetailed(db, { name: 'No Phone', email: 'nophone@example.com', source: 'website', stampEmail: false });
  assert.equal(r.created, true);
  assert.equal(inserts(db).length, 1);
});

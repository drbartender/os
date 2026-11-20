// The admin shift SQL text, pinned byte for byte (lane connector-shared-reads,
// plan 2026-11-19). The upcoming-events read the Claude connector calls is
// built on adminScopedShiftsSql with a date window; that window is opt-in, so
// the text the phone Events list, the desktop Events dashboard and the badge
// pin (shifts.adminScoped.test.js) run must not move by one character. The
// hashes were taken from the code BEFORE the window was added and this suite
// was committed with them. Pure: no database.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { adminScopedShiftsSql, adminShiftsSelectSql } = require('./shifts.queries');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

test('adminScopedShiftsSql(upcoming|past) and adminShiftsSelectSql() are the text they were', () => {
  assert.equal(sha(adminScopedShiftsSql('upcoming')), 'a2f2ca63d7e03c25d8df615a97abe06972e67ed7c4a10f214f4748a4dd0fc4e9');
  assert.equal(sha(adminScopedShiftsSql('past')), '6d680f6b2c9fd85a97e316223b58209774ee522b299e08b7007d0a7211cd6bd3');
  assert.equal(sha(adminShiftsSelectSql()), '3c48d2660aab34e3ab04184ce8b2783f47030703664a6ceb4c59cb5605d36ed1');
});

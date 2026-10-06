require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// The per-phone opt-out record and textability (spec 2026-10-06, Inbox,
// decision 10 and section 5.8), against the dev DB. Every sms_optouts row here
// is keyed to a 312-555-07xx number and removed in before() and after(); the
// backfill case runs inside a transaction that is rolled back.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pool, splitStatements } = require('../db');
const {
  recordOptOut, clearOptOut, activeOptOut, textability,
  isTwilioOptOutError, optedOutMessage, BAD_NUMBER_MESSAGE,
} = require('./smsOptOut');

// '3125550701' .. '3125550719'
const PHONES = Array.from({ length: 19 }, (_, i) => `31255507${String(i + 1).padStart(2, '0')}`);

async function clean() {
  await pool.query('DELETE FROM sms_optouts WHERE phone_last10 = ANY($1::text[])', [PHONES]);
}

before(clean);
after(async () => {
  await clean();
  await pool.end();
});

test('recordOptOut > keys the row by the last 10 digits, in any format', async () => {
  await recordOptOut({ phone: '+1 (312) 555-0701', source: 'keyword', line: '1922' });
  const { rows } = await pool.query(
    "SELECT source, line, cleared_at FROM sms_optouts WHERE phone_last10 = '3125550701'"
  );
  assert.deepEqual(rows, [{ source: 'keyword', line: '1922', cleared_at: null }]);
  const active = await activeOptOut('312.555.0701');
  assert.ok(active.opted_out_at instanceof Date);
});

test('recordOptOut > a repeat keeps the first opt-out; after a START a new one starts', async () => {
  await pool.query(
    `INSERT INTO sms_optouts (phone_last10, opted_out_at, source, line)
     VALUES ('3125550702', '2026-09-01T15:00:00Z', 'keyword', '888')`
  );
  await recordOptOut({ phone: '+13125550702', source: 'twilio_21610', line: '1922' });
  let r = await pool.query(
    "SELECT opted_out_at, source, line, cleared_at FROM sms_optouts WHERE phone_last10 = '3125550702'"
  );
  assert.equal(r.rows[0].opted_out_at.toISOString(), '2026-09-01T15:00:00.000Z', 'same opt-out, same date');
  assert.equal(r.rows[0].source, 'keyword');
  assert.equal(r.rows[0].line, '888');

  await clearOptOut({ phone: '+13125550702' });
  await recordOptOut({ phone: '+13125550702', source: 'twilio_21610', line: '1922' });
  r = await pool.query(
    "SELECT opted_out_at, source, line, cleared_at FROM sms_optouts WHERE phone_last10 = '3125550702'"
  );
  assert.ok(r.rows[0].opted_out_at > new Date('2026-09-02T00:00:00Z'), 'a fresh opt-out dates from now');
  assert.equal(r.rows[0].source, 'twilio_21610');
  assert.equal(r.rows[0].line, '1922');
  assert.equal(r.rows[0].cleared_at, null);
});

test('clearOptOut > stamps cleared_at and keeps the row; activeOptOut is then null', async () => {
  await recordOptOut({ phone: '+13125550703', source: 'keyword', line: '888' });
  await clearOptOut({ phone: '(312) 555-0703' });
  assert.equal(await activeOptOut('+13125550703'), null);
  const { rows } = await pool.query("SELECT cleared_at FROM sms_optouts WHERE phone_last10 = '3125550703'");
  assert.ok(rows[0].cleared_at instanceof Date, 'the history stays');
  await clearOptOut({ phone: '+13125550704' }); // no row: a no-op, never a throw
});

test('recordOptOut > refuses an unknown source; a short number is a no-op; an unknown line is stored as null', async () => {
  await assert.rejects(() => recordOptOut({ phone: '+13125550705', source: 'admin' }), /unknown source "admin"/);
  await recordOptOut({ phone: '555-0705', source: 'keyword' });
  assert.equal(await activeOptOut('555-0705'), null);
  await recordOptOut({ phone: '+13125550706', source: 'keyword', line: '312' });
  const { rows } = await pool.query("SELECT line FROM sms_optouts WHERE phone_last10 = '3125550706'");
  assert.equal(rows[0].line, null);
});

test('textability > a client: ok, opted out with the STOP date, a bad number, no phone', async () => {
  const ok = { communication_preferences: { sms_enabled: true }, phone_status: 'ok' };
  assert.deepEqual(await textability({ kind: 'client', client: ok, phone: '+13125550707' }), { ok: true });

  const stopped = {
    communication_preferences: { sms_enabled: false, sms_opt_out_at: '2026-09-01 15:00:00.123456+00' },
    phone_status: 'ok',
  };
  const v = await textability({ kind: 'client', client: stopped, phone: '+13125550707' });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'opted_out');
  assert.equal(v.since.toISOString(), '2026-09-01T15:00:00.123Z');

  const noStamp = { communication_preferences: { sms_enabled: false }, phone_status: 'ok' };
  assert.deepEqual(await textability({ kind: 'client', client: noStamp, phone: '+13125550707' }),
    { ok: false, reason: 'opted_out', since: null });

  const bad = { communication_preferences: { sms_enabled: true }, phone_status: 'bad' };
  assert.deepEqual(await textability({ kind: 'client', client: bad, phone: '+13125550707' }),
    { ok: false, reason: 'bad_number', since: null });

  assert.deepEqual(await textability({ kind: 'client', client: ok, phone: '' }),
    { ok: false, reason: 'no_phone', since: null });
});

test('textability > an active sms_optouts row opts out every kind; a cleared row does not', async () => {
  await pool.query(
    `INSERT INTO sms_optouts (phone_last10, opted_out_at, source, line)
     VALUES ('3125550708', '2026-09-03T12:00:00Z', 'keyword', '888')`
  );
  const client = { communication_preferences: { sms_enabled: true }, phone_status: 'ok' };
  const user = { communication_preferences: { sms_enabled: true } };
  const agreement = { sms_consent: true };
  for (const args of [{ kind: 'client', client }, { kind: 'staff', user, agreement }, { kind: 'unknown' }]) {
    const v = await textability({ ...args, phone: '+13125550708' });
    assert.equal(v.reason, 'opted_out', `${args.kind} must be refused`);
    assert.equal(v.since.toISOString(), '2026-09-03T12:00:00.000Z');
  }
  // The opt-out outranks a bad number: it is the stronger statement.
  const bad = { communication_preferences: { sms_enabled: true }, phone_status: 'bad' };
  assert.equal((await textability({ kind: 'client', client: bad, phone: '+13125550708' })).reason, 'opted_out');

  await clearOptOut({ phone: '+13125550708' });
  assert.deepEqual(await textability({ kind: 'unknown', phone: '+13125550708' }), { ok: true });
});

test('textability > staff: sms_enabled false, or no agreement consent, is opted out', async () => {
  const phone = '+13125550709';
  const on = { communication_preferences: { sms_enabled: true } };
  assert.deepEqual(await textability({ kind: 'staff', user: on, agreement: { sms_consent: true }, phone }), { ok: true });
  const off = { communication_preferences: { sms_enabled: false, sms_opt_out_at: '2026-09-04 09:30:00+00' } };
  const v = await textability({ kind: 'staff', user: off, agreement: { sms_consent: true }, phone });
  assert.equal(v.reason, 'opted_out');
  assert.equal(v.since.toISOString(), '2026-09-04T09:30:00.000Z');
  assert.deepEqual(await textability({ kind: 'staff', user: on, agreement: { sms_consent: false }, phone }),
    { ok: false, reason: 'opted_out', since: null });
  assert.deepEqual(await textability({ kind: 'staff', user: on, agreement: null, phone }),
    { ok: false, reason: 'opted_out', since: null });
});

test('optedOutMessage > names the Chicago date, or leaves it out when unknown', () => {
  assert.equal(optedOutMessage(new Date('2026-09-01T15:00:00Z')),
    'Texts are off for this person since Sep 1, 2026. Texts from 888, 1922 or 0082 will not deliver.');
  // 03:00 UTC on Sep 2 is still Sep 1 in Chicago.
  assert.match(optedOutMessage(new Date('2026-09-02T03:00:00Z')), /since Sep 1, 2026\./);
  assert.equal(optedOutMessage(null),
    'Texts are off for this person. Texts from 888, 1922 or 0082 will not deliver.');
  assert.equal(optedOutMessage(new Date('not a date')),
    'Texts are off for this person. Texts from 888, 1922 or 0082 will not deliver.');
  assert.equal(BAD_NUMBER_MESSAGE, "This number can't receive texts.");
});

test('isTwilioOptOutError > only error 21610, as a number or a string', () => {
  assert.equal(isTwilioOptOutError({ code: 21610 }), true);
  assert.equal(isTwilioOptOutError({ code: '21610' }), true);
  assert.equal(isTwilioOptOutError({ code: 30007 }), false);
  assert.equal(isTwilioOptOutError(new Error('no code')), false);
  assert.equal(isTwilioOptOutError(null), false);
});

test('backfill > the schema.sql statement seeds the latest STOP per phone and is idempotent', async () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const backfill = splitStatements(schema).filter((s) => /INSERT INTO sms_optouts/.test(s));
  assert.equal(backfill.length, 1, 'exactly one backfill statement in schema.sql');

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(
      `INSERT INTO sms_messages (direction, recipient_phone, body, status, metadata, created_at) VALUES
         ('inbound',  '+13125550711',   'STOP',  'received', '{"opt_keyword":"stop"}',  '2026-08-01T12:00:00Z'),
         ('inbound',  '+13125550711',   'START', 'received', '{"opt_keyword":"start"}', '2026-08-02T12:00:00Z'),
         ('inbound',  '(312) 555-0712', 'START', 'received', '{"opt_keyword":"start"}', '2026-08-01T12:00:00Z'),
         ('inbound',  '3125550712',     'STOP',  'received', '{"opt_keyword":"stop"}',  '2026-08-03T12:00:00Z'),
         ('inbound',  '+13125550713',   'STOP',  'received', '{"opt_keyword":"stop"}',  '2026-08-04T12:00:00Z'),
         ('outbound', '+13125550714',   'STOP',  'sent',     '{"opt_keyword":"stop"}',  '2026-08-04T12:00:00Z'),
         ('inbound',  '+13125550715',   'stop by later', 'received', '{}',             '2026-08-04T12:00:00Z')`
    );
    // 0713 already has a row, cleared by a START the live path recorded.
    await db.query(
      `INSERT INTO sms_optouts (phone_last10, opted_out_at, source, line, cleared_at)
       VALUES ('3125550713', '2026-08-04T12:00:00Z', 'keyword', '888', '2026-08-05T12:00:00Z')`
    );
    const read = async () => (await db.query(
      `SELECT phone_last10, opted_out_at, source, line, cleared_at FROM sms_optouts
        WHERE phone_last10 = ANY($1::text[]) ORDER BY phone_last10`,
      [['3125550711', '3125550712', '3125550713', '3125550714', '3125550715']]
    )).rows;

    await db.query(backfill[0]);
    const first = await read();
    await db.query(backfill[0]);
    const second = await read();

    assert.deepEqual(second, first, 'a second run changes nothing');
    assert.deepEqual(first.map((r) => r.phone_last10), ['3125550712', '3125550713'],
      'a later START, an outbound row and a plain text seed nothing');
    const seeded = first[0];
    assert.equal(seeded.source, 'backfill');
    assert.equal(seeded.line, null, 'pre-lane rows never recorded the real To');
    assert.equal(seeded.cleared_at, null);
    assert.equal(seeded.opted_out_at.toISOString(), '2026-08-03T12:00:00.000Z', 'dated by the STOP row itself');
    const kept = first[1];
    assert.equal(kept.source, 'keyword', 'an existing row is never overwritten');
    assert.ok(kept.cleared_at instanceof Date, 'and a START recorded after it is never undone');
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
});

test('backfill > a YES after a STOP leaves the phone opted out; START or UNSTOP clears it (amendment 32)', async () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const [backfill] = splitStatements(schema).filter((s) => /INSERT INTO sms_optouts/.test(s));
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(
      `INSERT INTO sms_messages (direction, recipient_phone, body, status, metadata, created_at) VALUES
         ('inbound', '+13125550716', 'STOP',   'received', '{"opt_keyword":"stop"}',  '2026-09-10T12:00:00Z'),
         ('inbound', '+13125550716', 'Yes',    'received', '{"opt_keyword":"start"}', '2026-09-11T12:00:00Z'),
         ('inbound', '+13125550717', 'STOP',   'received', '{"opt_keyword":"stop"}',  '2026-09-10T12:00:00Z'),
         ('inbound', '+13125550717', 'Unstop', 'received', '{"opt_keyword":"start"}', '2026-09-11T12:00:00Z')`
    );
    await db.query(backfill);
    const { rows } = await db.query(
      `SELECT phone_last10, opted_out_at, source FROM sms_optouts
        WHERE phone_last10 = ANY($1::text[]) ORDER BY phone_last10`,
      [['3125550716', '3125550717']]
    );
    assert.deepEqual(rows.map((r) => r.phone_last10), ['3125550716'], 'a YES never cleared it; an UNSTOP did');
    assert.equal(rows[0].source, 'backfill');
    assert.equal(rows[0].opted_out_at.toISOString(), '2026-09-10T12:00:00.000Z', 'dated by the STOP, not the YES');
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
});

test('backfill > reads the body: an untagged REVOKE seeds a row; a START with edge whitespace clears it', async () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const [backfill] = splitStatements(schema).filter((s) => /INSERT INTO sms_optouts/.test(s));
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // 0710's REVOKE is stored as a row from before 2026-10-06 was: no opt_keyword.
    // 0718's START carries a leading space and a real trailing newline.
    await db.query(
      `INSERT INTO sms_messages (direction, recipient_phone, body, status, metadata, created_at) VALUES
         ('inbound', '+13125550710', 'REVOKE', 'received', '{}',                      '2026-09-12T12:00:00Z'),
         ('inbound', '+13125550718', 'STOP',   'received', '{"opt_keyword":"stop"}',  '2026-09-12T12:00:00Z'),
         ('inbound', '+13125550718', $1,       'received', '{"opt_keyword":"start"}', '2026-09-13T12:00:00Z')`,
      [' Start\n']
    );
    await db.query(backfill);
    const { rows } = await db.query(
      `SELECT phone_last10, opted_out_at, source FROM sms_optouts
        WHERE phone_last10 = ANY($1::text[]) ORDER BY phone_last10`,
      [['3125550710', '3125550718']]
    );
    assert.deepEqual(rows.map((r) => r.phone_last10), ['3125550710'],
      'an untagged REVOKE is a STOP; a START with edge whitespace is a START');
    assert.equal(rows[0].source, 'backfill');
    assert.equal(rows[0].opted_out_at.toISOString(), '2026-09-12T12:00:00.000Z', 'dated by the REVOKE row');
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
});

test('textability > a caller mistake throws instead of answering ok', async () => {
  const phone = '+13125550719';
  const consent = { sms_consent: true };
  await assert.rejects(() => textability({ kind: 'staf', phone }), TypeError, 'an unknown kind');
  await assert.rejects(() => textability({ phone }), TypeError, 'no kind at all');
  await assert.rejects(() => textability({ kind: 'staff', agreement: consent, phone }), TypeError,
    'a staff check without the users row');
  await assert.rejects(() => textability({ kind: 'staff', user: { id: 1 }, agreement: consent, phone }), TypeError,
    'a users row selected without communication_preferences');
  await assert.rejects(
    () => textability({ kind: 'client', client: { id: 1, phone_status: 'ok' }, phone }), TypeError,
    'a clients row selected without communication_preferences'
  );
  await assert.rejects(
    () => textability({ kind: 'client', client: { id: 1, communication_preferences: { sms_enabled: true } }, phone }),
    TypeError, 'a clients row selected without phone_status'
  );
  // A clients row carrying both keys answers exactly as before, and no row at all is still no_phone.
  const client = { communication_preferences: { sms_enabled: true }, phone_status: 'ok' };
  assert.deepEqual(await textability({ kind: 'client', client, phone }), { ok: true });
  assert.deepEqual(await textability({ kind: 'client', phone }), { ok: false, reason: 'no_phone', since: null });
});

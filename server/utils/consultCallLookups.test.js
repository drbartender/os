require('dotenv').config();

// consultCallLookups: the two read paths that put a consult call outcome on an
// admin detail page (spec 2026-08-25 section 5.3, task S3).
//
// READ THIS BEFORE TRIMMING AN ASSERTION. Three things here look like padding
// and are not:
//
//   1. client_no_answer_at is asserted BY NAME, both as a real instant and as
//      an explicit null. S4 keys its "connected, no answer" label on exactly
//      that column. A query that forgot to select it returns undefined, which
//      reads as "the condition did not happen", so the label would simply never
//      fire and nobody would notice: the absence of a label looks exactly like
//      the absence of the condition. Testing `'client_no_answer_at' in row` is
//      what separates "never selected" from "selected and null".
//   2. Every fixture pair differs in EVERY asserted field, and every suite that
//      asserts "ours" also plants a NEWER row belonging to somebody else. A
//      lookup that returned the older attempt, or the newest attempt in the
//      whole table, would satisfy a laxer test.
//   3. Both lookups are pinned STRUCTURALLY, and what that pins is a FORM, not
//      a plan. Postgres collapses a two-relation inner join and reorders it
//      freely, so the textual FROM order constrains nothing. The part that does
//      keep the common case cheap, and most proposals and most clients never had
//      a consult at all, is the equality predicate on an indexed consults
//      column, so the test asserts that predicate too.
//
// Shared dev database: run this suite ALONE. Every fixture id is recorded and
// deleted BY ID in after(). Nothing here deletes by pattern: a pattern delete
// in this project once destroyed another suite's live rows.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { pool } = require('../db');
const { latestConsultCallForProposal, consultCallsForClient } = require('./consultCallLookups');

const RUN = `ccl-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

// Recorded ids, deleted by id in after(). consult_call_attempts cascades with
// its consult, so attempt ids never need their own list.
const made = { clients: [], proposals: [], consults: [] };

async function makeClient(tag) {
  const { rows: [c] } = await pool.query(
    `INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`,
    [`ConsultLookups ${tag}`, `${RUN}-${tag}@example.test`]
  );
  made.clients.push(c.id);
  return c.id;
}

async function makeProposal(clientId) {
  const { rows: [p] } = await pool.query(
    `INSERT INTO proposals (client_id, status, amount_paid, pricing_snapshot, total_price)
     VALUES ($1, 'sent', 0, '{}'::jsonb, 500) RETURNING id`,
    [clientId]
  );
  made.proposals.push(p.id);
  return p.id;
}

/** One consults row. Explicit column list: column ORDER differs between a fresh
 *  database and prod. The slot is built in SQL and never comes from JavaScript. */
async function makeConsult(tag, { clientId = null, proposalId = null, dayOffset = 0 } = {}) {
  const { rows: [c] } = await pool.query(
    `INSERT INTO consults (client_id, proposal_id, scheduled_at, calcom_event_id, status, booker_name, booker_phone)
     VALUES ($1, $2,
             date_trunc('second', NOW()) + make_interval(days => $3),
             $4, 'scheduled', 'Lookup Booker', '+12565550186')
     RETURNING id, scheduled_at`,
    [clientId, proposalId, dayOffset, `${RUN}-${tag}`]
  );
  made.consults.push(c.id);
  return c;
}

/** One consult_call_attempts row. slotShiftSec exists because
 *  UNIQUE (consult_id, scheduled_at) means a second attempt on one consult is a
 *  RESCHEDULE to a different slot, which is exactly how production files one. */
async function makeAttempt(consult, {
  status = 'missed',
  answeredBy = null,
  durationSec = null,
  detail = null,
  noAnswer = false,
  slotShiftSec = 0,
} = {}) {
  const { rows: [a] } = await pool.query(
    // The slot is derived from the consults row IN SQL and never round-trips
    // through JavaScript (ruling R12): node-pg truncates a TIMESTAMPTZ to
    // milliseconds, so a slot handed back into a write stops matching the
    // (consult_id, scheduled_at) UNIQUE the moment a real Cal.com slot carries
    // microseconds. Explicit column list, because column ORDER differs between
    // a fresh database and prod.
    `INSERT INTO consult_call_attempts
       (consult_id, scheduled_at, status, answered_by, bridge_duration_sec, detail, client_no_answer_at)
     SELECT c.id, c.scheduled_at + make_interval(secs => $2), $3, $4, $5, $6,
            CASE WHEN $7::boolean THEN date_trunc('second', NOW()) ELSE NULL END
       FROM consults c WHERE c.id = $1
     RETURNING id, scheduled_at, client_no_answer_at`,
    [consult.id, slotShiftSec, status, answeredBy, durationSec, detail, noAnswer]
  );
  return a;
}

/** A second consults row at EXACTLY the slot of an existing one. The slot is
 *  copied in SQL from that row, so the two are equal to the microsecond and no
 *  instant round-trips through JavaScript (ruling R12). Two consults for one
 *  client really can share a slot, and that is the whole reason the client
 *  lookup needs both a key and a sort tiebreaker. */
async function makeConsultSharingSlotWith(tag, { clientId, twin }) {
  const { rows: [c] } = await pool.query(
    `INSERT INTO consults (client_id, proposal_id, scheduled_at, calcom_event_id, status, booker_name, booker_phone)
     SELECT $1, NULL, t.scheduled_at, $3, 'scheduled', 'Lookup Booker', '+12565550186'
       FROM consults t WHERE t.id = $2
     RETURNING id, scheduled_at`,
    [clientId, twin.id, `${RUN}-${tag}`]
  );
  made.consults.push(c.id);
  return c;
}

// The six columns both lookups share, and the client lookup's seventh. The
// client surface renders one line per row, so consult_id is its list key. A
// slot cannot be one: two consults for one client can share a slot.
const SHARED = ['status', 'answered_by', 'bridge_duration_sec', 'scheduled_at', 'detail', 'client_no_answer_at'];
const CLIENT_ROW = ['consult_id', ...SHARED];

function assertColumns(row, cols, where) {
  for (const col of cols) {
    assert.ok(Object.prototype.hasOwnProperty.call(row, col), `${where}: ${col} must be selected`);
  }
}

after(async () => {
  // Order matters: consults first (attempts cascade), then proposals, then
  // clients. Every delete is by RECORDED ID.
  if (made.consults.length) {
    await pool.query('DELETE FROM consults WHERE id = ANY($1::int[])', [made.consults]);
  }
  if (made.proposals.length) {
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [made.proposals]);
  }
  if (made.clients.length) {
    await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [made.clients]);
  }
  await pool.end();
});

test('latestConsultCallForProposal returns the NEWEST attempt, not the first', async () => {
  const clientId = await makeClient('p-newest');
  const proposalId = await makeProposal(clientId);
  const consult = await makeConsult('p-newest', { clientId, proposalId, dayOffset: 2 });

  // Older: nobody answered, no latch, a raw Twilio error code in detail.
  await makeAttempt(consult, { status: 'failed', detail: '13224', slotShiftSec: -3600 });
  // Newer: differs in every asserted field, so returning the older row fails.
  const newer = await makeAttempt(consult, {
    status: 'connected', answeredBy: 'va', durationSec: 252,
    detail: 'bridge ok', noAnswer: true,
  });

  const row = await latestConsultCallForProposal(proposalId);
  assert.ok(row, 'a row is returned');
  assertColumns(row, SHARED, 'proposal lookup');
  assert.equal(row.status, 'connected');
  assert.equal(row.answered_by, 'va');
  assert.equal(row.bridge_duration_sec, 252);
  assert.equal(row.detail, 'bridge ok');
  assert.equal(Date.parse(row.scheduled_at), Date.parse(newer.scheduled_at));
  assert.equal(Date.parse(row.client_no_answer_at), Date.parse(newer.client_no_answer_at));
});

test('latestConsultCallForProposal carries client_no_answer_at, the column S4 labels on', async () => {
  const clientId = await makeClient('p-latch');
  const proposalId = await makeProposal(clientId);
  const consult = await makeConsult('p-latch', { clientId, proposalId, dayOffset: 3 });
  const attempt = await makeAttempt(consult, { status: 'connected', answeredBy: 'admin', durationSec: 8, noAnswer: true });

  const row = await latestConsultCallForProposal(proposalId);
  // hasOwnProperty, not truthiness: a query that never selected the column
  // returns undefined, which every downstream label reads as "did not happen".
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'client_no_answer_at'));
  assert.ok(row.client_no_answer_at instanceof Date, 'a real instant comes back');
  assert.equal(Date.parse(row.client_no_answer_at), Date.parse(attempt.client_no_answer_at));
});

test('latestConsultCallForProposal selects client_no_answer_at even when nothing latched', async () => {
  const clientId = await makeClient('p-nolatch');
  const proposalId = await makeProposal(clientId);
  const consult = await makeConsult('p-nolatch', { clientId, proposalId, dayOffset: 4 });
  await makeAttempt(consult, { status: 'connected', answeredBy: 'admin', durationSec: 120 });

  const row = await latestConsultCallForProposal(proposalId);
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'client_no_answer_at'), 'selected');
  assert.equal(row.client_no_answer_at, null, 'and null, which is NOT the same as absent');
});

test('latestConsultCallForProposal is null for a proposal with no consult (the common case)', async () => {
  const clientId = await makeClient('p-none');
  const proposalId = await makeProposal(clientId);
  assert.equal(await latestConsultCallForProposal(proposalId), null);
});

test('latestConsultCallForProposal is null for a consult that was never rung', async () => {
  const clientId = await makeClient('p-norings');
  const proposalId = await makeProposal(clientId);
  await makeConsult('p-norings', { clientId, proposalId, dayOffset: 5 });
  assert.equal(await latestConsultCallForProposal(proposalId), null);
});

test('latestConsultCallForProposal never returns another proposal\'s attempt', async () => {
  const mineClient = await makeClient('p-mine');
  const mineProposal = await makeProposal(mineClient);
  const mineConsult = await makeConsult('p-mine', { clientId: mineClient, proposalId: mineProposal, dayOffset: 6 });
  await makeAttempt(mineConsult, { status: 'missed', detail: 'mine' });

  // Somebody else's chain, filed AFTER ours, so it wins any unscoped
  // "newest attempt" ordering and a global lookup fails this test.
  const otherClient = await makeClient('p-other');
  const otherProposal = await makeProposal(otherClient);
  const otherConsult = await makeConsult('p-other', { clientId: otherClient, proposalId: otherProposal, dayOffset: 7 });
  await makeAttempt(otherConsult, { status: 'connected', answeredBy: 'admin', durationSec: 999, detail: 'theirs' });

  const row = await latestConsultCallForProposal(mineProposal);
  assert.equal(row.status, 'missed');
  assert.equal(row.detail, 'mine');
});

test('consultCallsForClient returns one row per consult, newest attempt each, newest slot first', async () => {
  const clientId = await makeClient('c-multi');
  const older = await makeConsult('c-multi-old', { clientId, dayOffset: 1 });
  const newer = await makeConsult('c-multi-new', { clientId, dayOffset: 9 });

  // The older consult was rescheduled: two attempts, and only the second one
  // may surface. Its fields differ from the first in every asserted position.
  await makeAttempt(older, { status: 'failed', detail: 'first slot', slotShiftSec: -7200 });
  await makeAttempt(older, { status: 'missed', detail: 'second slot' });
  await makeAttempt(newer, { status: 'connected', answeredBy: 'va', durationSec: 61, detail: 'newer consult' });

  const rows = await consultCallsForClient(clientId);
  assert.equal(rows.length, 2, 'one row per consult, not one per attempt');
  assertColumns(rows[0], CLIENT_ROW, 'client lookup');
  assert.equal(rows[0].status, 'connected', 'newest slot first');
  assert.equal(rows[0].detail, 'newer consult');
  assert.equal(rows[0].answered_by, 'va');
  assert.equal(rows[0].bridge_duration_sec, 61);
  assert.equal(rows[1].status, 'missed', 'the rescheduled consult shows its LATEST attempt');
  assert.equal(rows[1].detail, 'second slot');
  // The key identifies the RIGHT consult, which a bare typeof check would miss.
  assert.equal(rows[0].consult_id, newer.id);
  assert.equal(rows[1].consult_id, older.id);
  assert.ok(Date.parse(rows[0].scheduled_at) > Date.parse(rows[1].scheduled_at), 'ordered by slot, descending');
});

test('consultCallsForClient carries client_no_answer_at on every row', async () => {
  const clientId = await makeClient('c-latch');
  const latched = await makeConsult('c-latch-yes', { clientId, dayOffset: 8 });
  const plain = await makeConsult('c-latch-no', { clientId, dayOffset: 2 });
  const latchedAttempt = await makeAttempt(latched, { status: 'connected', answeredBy: 'admin', durationSec: 6, noAnswer: true });
  await makeAttempt(plain, { status: 'connected', answeredBy: 'admin', durationSec: 300 });

  const rows = await consultCallsForClient(clientId);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(Object.prototype.hasOwnProperty.call(row, 'client_no_answer_at'), 'selected on every row');
  }
  assert.equal(Date.parse(rows[0].client_no_answer_at), Date.parse(latchedAttempt.client_no_answer_at));
  assert.equal(rows[1].client_no_answer_at, null, 'null, not absent');
});

test('consultCallsForClient is an empty array for a client with no consults', async () => {
  const clientId = await makeClient('c-none');
  const rows = await consultCallsForClient(clientId);
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 0);
});

test('consultCallsForClient never returns another client\'s consult', async () => {
  const mine = await makeClient('c-mine');
  const mineConsult = await makeConsult('c-mine', { clientId: mine, dayOffset: 3 });
  await makeAttempt(mineConsult, { status: 'missed', detail: 'mine' });

  const other = await makeClient('c-other');
  const otherConsult = await makeConsult('c-other', { clientId: other, dayOffset: 20 });
  await makeAttempt(otherConsult, { status: 'connected', answeredBy: 'admin', durationSec: 500, detail: 'theirs' });

  const rows = await consultCallsForClient(mine);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detail, 'mine');
});

test('consultCallsForClient returns the ten newest consults, one row each, extra attempts and all', async () => {
  const clientId = await makeClient('c-cap');
  // Twelve consults, newest slot last. The two oldest must fall off the end.
  const consults = [];
  for (let i = 0; i < 12; i++) {
    consults.push(await makeConsult(`c-cap-${i}`, { clientId, dayOffset: 30 + i }));
  }
  for (const c of consults) await makeAttempt(c, { status: 'missed', detail: 'capped' });
  // The newest consult was rescheduled twice, so it carries THREE attempts.
  // This is NOT a test of whether the LIMIT runs before or after the collapse:
  // with DISTINCT ON in the same SELECT, an inner LIMIT 10 still yields ten
  // distinct consults, so that mutation is not expressible. What it does prove
  // is the cap itself, that a consult with three attempts still contributes one
  // row and not three, and which end of the order falls off.
  await makeAttempt(consults[11], { status: 'failed', detail: 'reschedule 1', slotShiftSec: -60 });
  await makeAttempt(consults[11], { status: 'connected', answeredBy: 'admin', durationSec: 30, detail: 'reschedule 2', slotShiftSec: -30 });

  const rows = await consultCallsForClient(clientId);
  assert.equal(rows.length, 10, 'ten rows for twelve consults and fourteen attempts');
  const slots = rows.map(r => Date.parse(r.scheduled_at));
  const descending = slots.every((slot, i) => i === 0 || slot < slots.at(i - 1));
  assert.ok(descending, 'strictly descending by slot, so every row is a different consult');
  assert.ok(slots.at(-1) > Date.parse(consults.at(1).scheduled_at), 'the two oldest consults fell off the end');
});

test('consultCallsForClient breaks a SHARED-SLOT tie deterministically, by consult_id', async () => {
  // Two consults for one client at the identical instant. Not exotic: two
  // Cal.com bookings can land on one slot, and it is the case where
  // scheduled_at identifies neither the row nor its place in the order.
  const clientId = await makeClient('c-tie');
  const first = await makeConsult('c-tie-a', { clientId, dayOffset: 40 });
  const second = await makeConsultSharingSlotWith('c-tie-b', { clientId, twin: first });
  await makeAttempt(first, { status: 'missed', detail: 'tie first' });
  await makeAttempt(second, { status: 'connected', answeredBy: 'admin', durationSec: 44, detail: 'tie second' });

  const rows = await consultCallsForClient(clientId);
  assert.equal(rows.length, 2);
  assert.equal(
    Date.parse(rows[0].scheduled_at), Date.parse(rows[1].scheduled_at),
    'fixture sanity: the two rows really do share one slot'
  );
  assert.ok(second.id > first.id, 'fixture sanity: the twin carries the higher consult id');

  // consult_id DESC is the tiebreaker, so the higher id leads. Drop it and the
  // outer sort has two equal keys and emits whatever the plan hands it, which
  // is the DISTINCT ON subquery's consult_id ASCENDING order: the reverse.
  assert.equal(rows[0].consult_id, second.id, 'the tiebreaker decides, not the plan');
  assert.equal(rows[0].detail, 'tie second');
  assert.equal(rows[1].consult_id, first.id);

  // And the order does not drift between requests, which is what the reader
  // would experience as a list reshuffling under them for no reason.
  for (let n = 0; n < 3; n++) {
    const again = await consultCallsForClient(clientId);
    assert.deepEqual(
      again.map(r => r.consult_id), [second.id, first.id],
      'same order on every call'
    );
  }
});

/** The SQL text of one lookup, sliced out of the module source. */
function sqlOf(fnName, endMarker) {
  const src = fs.readFileSync(path.join(__dirname, 'consultCallLookups.js'), 'utf8');
  const body = src.slice(src.indexOf(`async function ${fnName}`));
  return body.slice(body.indexOf('SELECT'), body.indexOf(endMarker) + endMarker.length);
}

// BOTH lookups are covered, because the same common case applies to both: most
// proposals and most clients never booked a consult at all.
//
// READ THIS BEFORE BELIEVING MORE OF IT THAN IT SAYS. What follows pins a FORM,
// not a plan, and no textual test could pin a plan. Both queries are
// two-relation inner joins, which Postgres collapses and reorders freely, so
// naming consults first constrains nothing about execution; it keeps the shape
// a reader sees equal to the shape that was reviewed, which is worth something
// on its own but is not a performance guarantee.
//
// The equality predicate is the part with teeth. idx_consults_proposal_id and
// idx_consults_client_id are what actually keep the common case off a
// whole-table walk, and they are reachable only from a bare equality on the
// indexed column. Wrap that column in a function or a cast, or swap the
// equality for an IN over a subquery, and the index quietly stops being usable
// while the FROM clause still reads exactly the same.
for (const [fnName, endMarker, predicate] of [
  ['latestConsultCallForProposal', 'LIMIT 1', /WHERE\s+c\.proposal_id\s*=\s*\$1/i],
  ['consultCallsForClient', 'LIMIT 10', /WHERE\s+c\.client_id\s*=\s*\$1/i],
]) {
  test(`${fnName} is written FROM consults and reaches its index by bare equality`, () => {
    const sql = sqlOf(fnName, endMarker);
    const fromConsults = sql.search(/FROM\s+consults\b/i);
    const attempts = sql.search(/consult_call_attempts/i);
    assert.ok(fromConsults >= 0, 'names FROM consults');
    assert.ok(attempts >= 0, 'joins consult_call_attempts');
    assert.ok(fromConsults < attempts, 'consults is named first (form, not plan)');
    assert.match(sql, /JOIN\s+consult_call_attempts/i);
    assert.match(sql, predicate, 'a bare equality on the indexed consults column');
  });
}

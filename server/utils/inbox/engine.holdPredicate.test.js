require('dotenv').config();

// The Inbox hold predicate (spec 2026-11-19 law 1) and the two connector
// reads built on it, getInboxExcludingHold and getItemExcludingHold. The
// predicate's three drops (a held subject, a held key, a held mail line inside
// another person's thread) and its personal drop are asserted on an invented
// snapshot; getReadSubjects, rewritten onto the same predicate, keeps its
// answers on engine.test.js, and here on the same snapshot. The admin
// getInbox and getItem are asserted unchanged beside each connector answer.
//
// The last test is law 6's check on a real snapshot: every statement the
// snapshot path sends (getInbox, getItem and both connector reads) is a read.
// It holds a synthetic booking only: for that one test the process's real
// hold list is emptied and the synthetic id added, so the engine never
// queries the real held row (restored in finally).
//
// Needs the dev DB (the AI status read, the real snapshot): run through
// scripts/run-suites.js. Fixtures are deleted by recorded id in after().

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { pool } = require('../../db');
const sweep = require('../staleProposalSweep');
const { heldProposalIds, __setLegalHoldIdsForTest } = require('../legalHold');
const k = require('./rules.testkit');

if (process.env.NODE_ENV === 'production') throw new Error('engine.holdPredicate.test.js refuses to run against production');

process.env.INBOX_TEXT_LINES = '888';
const engine = require('./engine');

const PLANNER = 'e-1111111111111111';
const HELD_KEY = 'e-2222222222222222';
const PERSONAL = 'e-3333333333333333';
const PLAIN = 'e-4444444444444444';
const FLAGGED = 'c-987001';
const OWNER = 1;
const HELD_WORDS = 'Words that copied the held client';
const SYNTHETIC_HELD = 987002;

function snapshot({ holdIds = heldProposalIds(), withoutHoldIds = false } = {}) {
  const now = new Date();
  const at = (h) => new Date(now.getTime() - h * 3600e3);
  const events = [
    k.gmIn(PLANNER, at(5), 'Who is bringing the ice?', { address: 'planner@example.com', gmailId: 'hp1' }),
    k.gmIn(PLANNER, at(3), HELD_WORDS, { address: 'planner@example.com', legalHold: true, gmailId: 'hp2' }),
    k.gmIn(HELD_KEY, at(2), 'A question under a held address', { address: 'stale@example.com' }),
    k.gmIn(PERSONAL, at(2), 'Dinner on Sunday?', { personal: true, address: 'friend@example.com' }),
    k.gmIn(PLAIN, at(1), 'Do you do corporate events?', { address: 'vendor@example.com' }),
    k.smsIn(FLAGGED, at(4), 'Is our date still on?', { phone: '+13125550177' }),
  ];
  const proposals = [k.proposalRow(FLAGGED, { id: SYNTHETIC_HELD, legalHold: true })];
  // The flagged client is on record, so a lookup of them is refused for the
  // hold, never because the key names no one.
  const index = { clients: new Map([[987001, { id: 987001, name: 'Flagged Pin' }]]) };
  return engine.__fakeSnapshot({ now, events, proposals, index, heldKeys: new Set([HELD_KEY]), holdIds: withoutHoldIds ? undefined : holdIds });
}
const useSnapshot = (snap) => engine.__setEngineDeps({ computeSnapshot: () => Promise.resolve(snap) });
const keysOf = (body) => [...body.waiting, ...body.snoozed, ...body.handled].map((r) => r.person_key).sort();

before(() => __setLegalHoldIdsForTest([SYNTHETIC_HELD]));
afterEach(() => engine.__setEngineDeps({ computeSnapshot: null }));

test('holdPredicate: a flagged person, a held key and a held mail line are dropped; personal only when asked', () => {
  const snap = snapshot();
  const plain = engine.holdPredicate(snap);
  assert.deepEqual([plain.keepsPerson(PLAIN), plain.keepsPerson(PLANNER), plain.keepsPerson(PERSONAL)], [true, true, true]);
  assert.equal(plain.keepsPerson(HELD_KEY), false, 'a held key');
  assert.equal(plain.keepsPerson(FLAGGED, true), false, 'a person the rules flag legalHold');
  const planner = snap.eventsByPerson.get(PLANNER);
  assert.deepEqual(planner.filter(plain.keepsEvent).map((e) => e.text), ['Who is bringing the ice?'], 'the held line goes, the thread stays');
  assert.equal(engine.holdPredicate(snap, { dropPersonal: true }).keepsPerson(PERSONAL), false, 'personal, when asked');
  const subject = { personKey: PLANNER, subjectRef: planner[0].ref, slice: [{ ref: planner[1].ref }] };
  assert.equal(plain.keepsSubject(subject), false, 'a subject whose slice holds a held line');
  assert.equal(plain.keepsSubject({ ...subject, slice: [] }), true);
  assert.equal(plain.keepsSubject({ personKey: PLANNER, subjectRef: planner[1].ref, slice: [] }), false, 'a held line as the subject');
});

test('getReadSubjects on the predicate: never the held people, the held line or personal mail', async () => {
  useSnapshot(snapshot());
  const subjects = await engine.getReadSubjects();
  const keys = new Set(subjects.map((s) => s.personKey));
  assert.ok(keys.has(PLAIN), 'the ordinary person is read');
  for (const key of [HELD_KEY, PERSONAL, FLAGGED]) assert.ok(!keys.has(key), key);
  const heldRef = snapshot().eventsByPerson.get(PLANNER)[1].ref;
  assert.ok(subjects.every((s) => s.subjectRef !== heldRef && !(s.slice || []).some((l) => l.ref === heldRef)));
});

test('getInboxExcludingHold: the three drops and personal, the held line gone from the need; getInbox unchanged', async () => {
  useSnapshot(snapshot());
  const admin = await engine.getInbox({ viewerId: OWNER });
  assert.deepEqual(keysOf(admin), [FLAGGED, HELD_KEY, PERSONAL, PLAIN, PLANNER].sort(), 'the admin list still holds every person');
  const planned = admin.waiting.find((r) => r.person_key === PLANNER);
  const body = await engine.getInboxExcludingHold({ viewerId: OWNER });
  assert.deepEqual(keysOf(body), [PLAIN, PLANNER].sort());
  assert.ok(!JSON.stringify(body).includes(HELD_WORDS), 'no held words anywhere in the connector list');
  assert.deepEqual(Object.keys(body).sort(), Object.keys(admin).sort(), 'the same body shape');
  assert.ok(planned, 'the planner waits on the admin list too');
});

test('getItemExcludingHold: the thread without the held line; a held, flagged or personal person is the plain not-found', async () => {
  useSnapshot(snapshot());
  const admin = await engine.getItem({ personKey: PLANNER, viewerId: OWNER });
  assert.ok(admin.thread.some((r) => r.text === HELD_WORDS), 'the admin item still shows its line');
  const item = await engine.getItemExcludingHold({ personKey: PLANNER, viewerId: OWNER });
  assert.ok(!JSON.stringify(item).includes(HELD_WORDS));
  assert.ok(item.thread.some((r) => r.text === 'Who is bringing the ice?'));
  assert.equal(item.legal_hold, false);
  for (const key of [HELD_KEY, FLAGGED, PERSONAL, 'e-0000000000000000', 'nope']) {
    await assert.rejects(engine.getItemExcludingHold({ personKey: key, viewerId: OWNER }),
      (err) => err.statusCode === 404 && err.message === engine.NOT_IN_INBOX && !(err instanceof engine.InboxMovedError), key);
  }
  assert.equal((await engine.getItem({ personKey: PERSONAL, viewerId: OWNER })).status, 'waiting', 'the owner still opens it on the admin item');
});

test('getItemExcludingHold: a person made only of held mail lines is a made-up key; a mixed one returns without the held line or its From name', async () => {
  const now = new Date();
  const at = (h) => new Date(now.getTime() - h * 3600e3);
  const ONLY_HELD = 'e-5555555555555555';
  const MIXED = 'e-6666666666666666';
  const snap = engine.__fakeSnapshot({ now, holdIds: heldProposalIds(), events: [
    k.gmIn(ONLY_HELD, at(2), 'Writing from another form of the held address', {
      address: 'held.form@example.com', fromName: 'Held Only Sender', legalHold: true, gmailId: 'oh1' }),
    k.gmIn(MIXED, at(5), 'When do you arrive?', { address: 'mixed@example.com', fromName: 'Clean Sender', gmailId: 'mx1' }),
    k.gmIn(MIXED, at(3), HELD_WORDS, { address: 'copied.form@example.com', fromName: 'Held From Name', legalHold: true, gmailId: 'mx2' }),
  ] });
  useSnapshot(snap);
  const errorOf = async (personKey) => {
    try { await engine.getItemExcludingHold({ personKey, viewerId: OWNER }); } catch (err) {
      return [err.constructor.name, err.statusCode, err.code, err.message, err instanceof engine.InboxMovedError];
    }
    return 'answered';
  };
  const madeUp = await errorOf('e-0000000000000000');
  assert.deepEqual(madeUp, ['NotFoundError', 404, 'NOT_FOUND', engine.NOT_IN_INBOX, false]);
  assert.deepEqual(await errorOf(ONLY_HELD), madeUp, 'the same not-found a made-up key gets');
  assert.ok((await engine.getItem({ personKey: ONLY_HELD, viewerId: OWNER })).person, 'the admin item still opens it');
  const item = await engine.getItemExcludingHold({ personKey: MIXED, viewerId: OWNER });
  assert.equal(item.person.name, 'Clean Sender', 'the name comes from the clean line, not the newer held one');
  assert.deepEqual(item.thread.map((r) => r.text).filter(Boolean), ['When do you arrive?']);
  const text = JSON.stringify(item);
  for (const held of [HELD_WORDS, 'Held From Name', 'copied.form@example.com']) assert.ok(!text.includes(held), held);
  const list = await engine.getInboxExcludingHold({ viewerId: OWNER });
  assert.deepEqual(list.waiting.map((r) => [r.person_key, r.name]), [[MIXED, 'Clean Sender']], 'the list names them the same way');
});

test('getItemExcludingHold: a client not under the hold whose only line is held gets the body a client with no lines gets', async () => {
  const now = new Date();
  const COPIED = 'c-987010';
  const QUIET = 'c-987011';
  const ONLY_HELD = 'e-5555555555555555';
  const index = { clients: new Map([[987010, { id: 987010, name: 'Pin Client' }], [987011, { id: 987011, name: 'Pin Client' }]]) };
  useSnapshot(engine.__fakeSnapshot({ now, index, holdIds: heldProposalIds(), events: [
    k.gmIn(COPIED, new Date(now.getTime() - 2 * 3600e3), HELD_WORDS, {
      address: 'copied.client@example.com', fromName: 'Held From Name', legalHold: true, gmailId: 'cc1' }),
    k.gmIn(ONLY_HELD, new Date(now.getTime() - 3600e3), 'Writing from another form of the held address', {
      address: 'held.form@example.com', fromName: 'Held Only Sender', legalHold: true, gmailId: 'oh2' }),
  ] }));
  const copied = await engine.getItemExcludingHold({ personKey: COPIED, viewerId: OWNER });
  const quiet = await engine.getItemExcludingHold({ personKey: QUIET, viewerId: OWNER });
  // The two differ only by their own id (the key, the card's client link).
  const asQuiet = JSON.parse(JSON.stringify(copied).replaceAll('987010', '987011'));
  assert.deepEqual(asQuiet, quiet, 'the same body, so the read never says held mail touched them');
  assert.deepEqual([copied.status, copied.thread, copied.person.name], ['quiet', [], 'Pin Client']);
  for (const held of [HELD_WORDS, 'Held From Name', 'copied.client@example.com']) assert.ok(!JSON.stringify(copied).includes(held), held);
  const errorOf = (personKey) => engine.getItemExcludingHold({ personKey, viewerId: OWNER }).then(() => 'answered',
    (err) => [err.constructor.name, err.statusCode, err.code, err.message, err instanceof engine.InboxMovedError]);
  assert.deepEqual(await errorOf(ONLY_HELD), await errorOf('e-0000000000000000'), 'an e- person made only of held lines is an unused address');
});

test('the connector reads fail closed: a missing hold list, or a snapshot built without the whole list, throws', async () => {
  useSnapshot(snapshot({ withoutHoldIds: true })); // a snapshot that says nothing of its list
  await assert.rejects(engine.getInboxExcludingHold({ viewerId: OWNER }), /legal-hold list/);
  await assert.rejects(engine.getItemExcludingHold({ personKey: PLAIN, viewerId: OWNER }), /legal-hold list/);
  useSnapshot(snapshot({ holdIds: sweep.LEGAL_HOLD_PROPOSAL_IDS.map(Number) })); // without the synthetic id
  await assert.rejects(engine.getInboxExcludingHold({ viewerId: OWNER }), /legal-hold list/);
  useSnapshot(snapshot());
  const real = sweep.LEGAL_HOLD_PROPOSAL_IDS;
  try {
    sweep.LEGAL_HOLD_PROPOSAL_IDS = undefined;
    await assert.rejects(engine.getInboxExcludingHold({ viewerId: OWNER }), /LEGAL_HOLD_PROPOSAL_IDS/);
    await assert.rejects(engine.getItemExcludingHold({ personKey: PLAIN, viewerId: OWNER }), /LEGAL_HOLD_PROPOSAL_IDS/);
  } finally {
    sweep.LEGAL_HOLD_PROPOSAL_IDS = real;
  }
  assert.equal((await engine.getInboxExcludingHold({ viewerId: OWNER })).waiting.length, 2, 'and answers once the list is whole');
});

// ─── law 6 on a real snapshot ───
const made = { clients: [], proposals: [], sms: [] };
after(async () => {
  __setLegalHoldIdsForTest(null);
  engine.__resetEngine();
  if (made.sms.length) await pool.query('DELETE FROM sms_messages WHERE id = ANY($1::int[])', [made.sms]);
  if (made.proposals.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [made.proposals]);
  if (made.clients.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [made.clients]);
  await pool.end();
});

test('the snapshot path writes nothing: every statement getInbox, getItem and the connector reads send is a read', async () => {
  const tag = crypto.randomBytes(4).toString('hex');
  const addClient = async (n, phone) => {
    const { rows: [c] } = await pool.query('INSERT INTO clients (name, phone) VALUES ($1, $2) RETURNING id', [`Law6 ${n} ${tag}`, phone]);
    made.clients.push(c.id);
    const { rows: [m] } = await pool.query(
      `INSERT INTO sms_messages (direction, client_id, recipient_phone, body, status, metadata, created_at)
       VALUES ('inbound', $1, $2, $3, 'received', $4::jsonb, NOW() - INTERVAL '1 hour') RETURNING id`,
      [c.id, phone, `A question ${n} ${tag}`, JSON.stringify({ from: phone })]
    );
    made.sms.push(m.id);
    return c.id;
  };
  const free = await addClient('free', '+17085550191');
  const held = await addClient('held', '+17085550192');
  const { rows: [hp] } = await pool.query("INSERT INTO proposals (client_id, status, event_date) VALUES ($1, 'confirmed', CURRENT_DATE + 30) RETURNING id", [held]);
  made.proposals.push(hp.id);

  const real = sweep.LEGAL_HOLD_PROPOSAL_IDS;
  // Recorded at the driver: every statement any pooled client runs, whether
  // it came through pool.query or a client a caller took.
  const query = Client.prototype.query;
  const sent = [];
  try {
    sweep.LEGAL_HOLD_PROPOSAL_IDS = []; // the synthetic booking is the whole hold for this test
    __setLegalHoldIdsForTest([hp.id]);
    engine.__setEngineDeps({ computeSnapshot: null, legalHoldIds: [hp.id] });
    engine.invalidate();
    Client.prototype.query = function recorded(sql, ...rest) {
      sent.push(typeof sql === 'string' ? sql : sql && sql.text);
      return query.call(this, sql, ...rest);
    };
    const list = await engine.getInbox({ viewerId: OWNER });
    const item = await engine.getItem({ personKey: `c-${free}`, viewerId: OWNER });
    const heldItem = await engine.getItem({ personKey: `c-${held}`, viewerId: OWNER });
    const connectorList = await engine.getInboxExcludingHold({ viewerId: OWNER });
    const connectorItem = await engine.getItemExcludingHold({ personKey: `c-${free}`, viewerId: OWNER });
    await assert.rejects(engine.getItemExcludingHold({ personKey: `c-${held}`, viewerId: OWNER }), (err) => err.statusCode === 404);
    Client.prototype.query = query;
    assert.ok(list.waiting.some((r) => r.person_key === `c-${held}`), 'the admin list holds the held client (spec 5)');
    assert.ok(!connectorList.waiting.some((r) => r.person_key === `c-${held}`), 'the connector list does not');
    assert.ok(connectorList.waiting.some((r) => r.person_key === `c-${free}`));
    assert.equal(heldItem.legal_hold, true);
    assert.deepEqual([item.person.person_key, connectorItem.person.person_key], [`c-${free}`, `c-${free}`]);
    assert.ok(sent.length > 10, `the path read the database (${sent.length} statements)`);
    const strip = (sql) => String(sql).replace(/--[^\n]*\n/g, '\n').trim();
    const writes = sent.filter((sql) => !/^\(?\s*(SELECT|WITH)\b/i.test(strip(sql)) || /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\s/i.test(strip(sql).replace(/'[^']*'/g, '')));
    assert.deepEqual(writes, [], 'no statement writes');
  } finally {
    Client.prototype.query = query;
    sweep.LEGAL_HOLD_PROPOSAL_IDS = real;
    __setLegalHoldIdsForTest([SYNTHETIC_HELD]);
    engine.__resetEngine();
  }
});

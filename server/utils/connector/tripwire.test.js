require('dotenv').config();
process.env.NODE_ENV = 'test';

// The bulk-read tripwire (spec 2026-11-19 section 7.6 guard 3), with the call
// log read and the owner email stubbed: no database, no mail. The endpoint
// suite (routes/connectorMcp.tools.test.js) drives it through the tools.

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const tripwire = require('./tripwire');

const sent = [];
const alerts = [];
let logRows = []; // the subjects the "call log" holds for the grant
let loggedTrip = null; // the trip start a refused row of the window names
const CAP = 3;

beforeEach(() => {
  process.env.CONNECTOR_TRIPWIRE_CAP = String(CAP);
  tripwire.__resetTripwire();
  sent.length = 0;
  alerts.length = 0;
  logRows = [];
  loggedTrip = null;
  tripwire.__setTripwireDeps({
    send: async (m) => { sent.push(m); },
    captureMessage: (msg) => { alerts.push(msg); },
    ownerEmail: async () => 'owner@example.com',
    logSubjects: async () => logRows.map((r) => r.subject),
    logTripStart: async () => loggedTrip,
  });
});
after(() => {
  delete process.env.CONNECTOR_TRIPWIRE_CAP;
  tripwire.__setTripwireDeps(null);
});

const T0 = new Date('2026-11-19T18:00:00.000Z');
const at = (min) => new Date(T0.getTime() + min * 60 * 1000);
const admit = (subject, min = 0, grantId = 51001) => tripwire.admit({ grantId, userId: 51002, subject, now: at(min) });

test('the cap-th different client is served, the next is refused, a repeat of a counted one is served', async () => {
  for (const s of ['c1', 'c2', 'c3']) assert.equal((await admit(s)).allowed, true, s);
  assert.deepEqual(await admit('c4'), { allowed: false, cap: CAP, since: T0.getTime() });
  assert.equal((await admit('c2')).allowed, true, 'already counted');
  assert.equal((await admit('c5')).allowed, false);
});

test('one email and one Sentry alert per trip, however many refusals; a new trip after the hour emails again', async () => {
  for (const s of ['c1', 'c2', 'c3']) await admit(s);
  await admit('c4');
  await admit('c5');
  await admit('c6', 1);
  await tripwire.__drain();
  assert.equal(sent.length, 1);
  assert.deepEqual(alerts, ['connector_tripwire_tripped']);
  assert.equal(sent[0].to, 'owner@example.com');
  assert.deepEqual(sent[0].meta, { skipLog: true }, 'the alert writes no message_log row');
  assert.ok(!/c4|c5|c6/.test(sent[0].text), 'the email names no record');
  assert.match(sent[0].text, /limit of 3 different records/);
  // The hour after the trip has passed: a new subject is served; filling up again is a new trip.
  assert.equal((await admit('c7', 61)).allowed, true);
  await admit('c8', 61);
  await admit('c9', 61);
  assert.equal((await admit('c10', 61)).allowed, false);
  await tripwire.__drain();
  assert.equal(sent.length, 2);
});

test('a trip lasts the hour: a slot freed as counted subjects age out admits no new subject until then, and sends no second email', async () => {
  await admit('c1', 0);
  await admit('c2', 0);
  await admit('c3', 30);
  assert.equal((await admit('c4', 30)).allowed, false, 'the trip begins at minute 30');
  assert.equal((await admit('c5', 61)).allowed, false, 'c1 and c2 have aged out, but the trip holds');
  assert.equal((await admit('c3', 61)).allowed, true, 'a subject still counted is served during the trip');
  await tripwire.__drain();
  assert.equal(sent.length, 1, 'one email for the trip');
  assert.deepEqual(alerts, ['connector_tripwire_tripped'], 'one alert');
  assert.equal((await admit('c5', 91)).allowed, true, 'an hour after the trip began');
});

test('the window rolls on the injected clock', async () => {
  for (const s of ['c1', 'c2', 'c3']) await admit(s, 0);
  assert.equal((await admit('c4', 59)).allowed, false, 'inside the hour: the trip begins');
  assert.equal((await admit('c4', 60)).allowed, false, 'the trip lasts an hour from minute 59');
  assert.equal((await admit('c4', 119)).allowed, true, 'an hour after the trip began, the first three long gone');
});

test('the call log counts too: subjects another instance (or a restart) served are in the count', async () => {
  logRows = [{ subject: 'c1' }, { subject: 'c2' }, { subject: 'thread:e-1111111111111111' }];
  assert.equal((await admit('c9')).allowed, false, 'three in the log, none in this process');
  assert.equal((await admit('c1')).allowed, true, 'a subject in the log is a repeat');
});

test('two calls racing for the last place: one is served', async () => {
  await admit('c1');
  await admit('c2');
  const [a, b] = await Promise.all([admit('c3'), admit('c4')]);
  assert.deepEqual([a.allowed, b.allowed].sort(), [false, true]);
});

test('grants are counted apart; a failed log read throws (the call fails rather than skip the count)', async () => {
  for (const s of ['c1', 'c2', 'c3']) await admit(s, 0, 51001);
  assert.equal((await admit('c4', 0, 51003)).allowed, true, 'another grant');
  tripwire.__setTripwireDeps({ logSubjects: async () => { throw new Error('db down'); } });
  await assert.rejects(admit('c5'), /db down/);
});

test('subjectOf: the client when there is one, else the tool and record; the cap reads its variable', () => {
  assert.equal(tripwire.subjectOf({ toolName: 'thread', clientId: 51004, recordId: 'c-51004' }), 'c51004');
  assert.equal(tripwire.subjectOf({ toolName: 'thread', clientId: null, recordId: 'p#abcdef0123456789' }), 'thread:p#abcdef0123456789');
  assert.equal(tripwire.readCap({}), 40);
  assert.equal(tripwire.readCap({ CONNECTOR_TRIPWIRE_CAP: '12' }), 12);
  for (const bad of ['0', '-1', 'x', '1.5', '5000']) assert.equal(tripwire.readCap({ CONNECTOR_TRIPWIRE_CAP: bad }), 40, bad);
  assert.deepEqual([...tripwire.DETAIL_TOOLS].sort(), ['client', 'proposal_or_event', 'thread']);
});

test('a trip survives a restart: a refused row naming the trip keeps it, with no second email', async () => {
  loggedTrip = at(10).getTime(); // a trip that began ten minutes in, held by another process
  logRows = [{ subject: 'c1' }];
  const r = await admit('c2', 30);
  assert.deepEqual(r, { allowed: false, cap: CAP, since: loggedTrip }, 'refused, well under the cap: the trip holds');
  assert.equal((await admit('c1', 30)).allowed, true, 'a counted subject is still served');
  await tripwire.__drain();
  assert.deepEqual([sent.length, alerts.length], [0, 0], 'no second email or alert');
  assert.equal((await admit('c2', 71)).allowed, true, 'an hour after the logged trip began');
});

test('a trip email that does not go out is reported: notifications off, or no owner address', async () => {
  tripwire.__setTripwireDeps({ send: async (m) => { sent.push(m); return { id: 'dev-skipped' }; } });
  for (const s of ['c1', 'c2', 'c3']) await admit(s);
  await admit('c4');
  await tripwire.__drain();
  assert.deepEqual(alerts, ['connector_tripwire_tripped', 'connector_tripwire_email_failed']);
  tripwire.__resetTripwire();
  alerts.length = 0;
  tripwire.__setTripwireDeps({ ownerEmail: async () => null });
  for (const s of ['d1', 'd2', 'd3']) await admit(s, 0, 51005);
  await admit('d4', 0, 51005);
  await tripwire.__drain();
  assert.deepEqual(alerts, ['connector_tripwire_tripped', 'connector_tripwire_email_failed']);
});

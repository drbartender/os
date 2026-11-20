require('dotenv').config();
process.env.NODE_ENV = 'test';

// The connector tools' text rules (text.js) as pure functions: the list
// tools' contact rule, the n- refs, the log key, and the guard's withheld,
// flagged and plain paths with the screen stubbed (so the text guards'
// tiering never moves this suite). No database.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { FLAG_NOTICE } = require('../textGuards');
const deps = require('./deps');
const text = require('./text');

after(() => deps.__resetToolDeps());

test('noContact marks phone numbers and email addresses and leaves dates, money and ids', () => {
  assert.equal(text.noContact('Call (312) 555-0123 or mail pat@example.com'), 'Call [phone] or mail [email]');
  for (const keep of ['On 2096-05-10 at 6pm', 'total 1250.00', 'proposal 123456', 'on 3/8']) assert.equal(text.noContact(keep), keep);
  assert.equal(text.noContact('+1 312 555 0123'), '[phone]');
  assert.equal(text.noContact(null), null);
});

test('listName and guardedName: a name that is an address or a number becomes the fallback', () => {
  assert.equal(text.listName('staffer@example.com', 'Staff member'), 'Staff member');
  assert.equal(text.listName('(312) 555-0199', 'Unknown number'), 'Unknown number');
  assert.equal(text.listName('Pat Example', 'Client'), 'Pat Example');
  assert.equal(text.listName('', 'Client'), 'Client');
  const guard = text.createTextGuard();
  assert.equal(text.guardedName(guard, 'staffer@example.com', 'Staff member', { record: 'staff 1' }), 'Staff member');
  assert.equal(text.guardedName(guard, 'Pat Example', 'Client', { record: 'client 1' }), 'Pat Example');
  assert.equal(text.personFallback('unknown', 'p-3125550199'), 'Unknown number');
  assert.equal(text.personFallback('unknown', 'e-1111111111111111'), 'Unknown sender');
  assert.equal(text.personFallback('lead', 'c-1'), 'Lead');
});

test('personRef hides a number behind letters, stable in a process; logKey never keeps the digits', () => {
  const ref = text.personRef('p-3125550199');
  assert.match(ref, /^n-[a-p]{16}$/);
  assert.equal(text.personRef('p-3125550199'), ref);
  assert.notEqual(text.personRef('p-3125550198'), ref);
  assert.equal(text.personRef('c-12'), 'c-12');
  assert.match(text.logKey('p-3125550199'), /^p#[0-9a-f]{16}$/);
  assert.equal(text.logKey('e-1111111111111111'), 'e-1111111111111111');
});

test('the guard: withheld once per piece with its record, flagged with the notice, plain text stripped, business text link-stripped', () => {
  deps.__setToolDeps({
    screenClientText: (t) => ({
      withheld: /WITHHOLD/.test(t), flagged: /FLAG/.test(t) && !/WITHHOLD/.test(t), tier: null, pattern: /WITHHOLD/.test(t) ? 'stub' : null,
    }),
  });
  const guard = text.createTextGuard();
  assert.equal(guard.client('WITHHOLD me', { record: 'message sms:1', ref: 'msg:sms:1' }), 'withheld, read it in the OS (message sms:1)');
  guard.client('WITHHOLD me', { record: 'message sms:1', ref: 'msg:sms:1' });
  assert.equal(guard.withheld.length, 1, 'the same words are one piece');
  assert.match(guard.withheld[0].ref, /^msg:sms:1#[0-9a-f]{16}$/);
  guard.client('WITHHOLD other words', { record: 'message sms:1', ref: 'msg:sms:1' });
  assert.equal(guard.withheld.length, 2, 'new words under the same record are a new piece');
  assert.equal(guard.client('FLAG this, see https://example.org/x', { record: 'message sms:2' }), `${FLAG_NOTICE} FLAG this, see [link]`);
  assert.deepEqual(guard.flagged, ['message sms:2']);
  assert.equal(guard.client('Mail me at pat@example.com', { record: 'message sms:3' }), 'Mail me at [email]');
  assert.equal(guard.business('Pay here: https://example.org/pay/abc'), 'Pay here: [link]');
  assert.equal(guard.client(null), null);
  assert.ok(guard.client('x'.repeat(5000), { record: 'm' }).endsWith('[cut, read the rest in the OS]'));
});

test('noContact: a phone of 7, 10 or 11 digits with any phone separators, fullwidth and commas too; ranges, dates and years are not phones', () => {
  for (const phone of ['312/555/0100', '312_555_0100', '312.555.0100', '312,555,0100', '\uFF13\uFF11\uFF12\uFF15\uFF15\uFF15\uFF10\uFF11\uFF10\uFF10', '312 / 555 / 0100', '+1 312 555 0100', '1-312-555-0100', '555-0123']) {
    assert.equal(text.noContact(`call ${phone} now`), 'call [phone] now', phone);
  }
  for (const keep of [
    'on 05/10/2096', 'Is 2026-11-21 7pm ok', 'from 2096-05-10 to 2096-05-11', 'Budget is 1500-2500 for 150 guests',
    'Budget is $500-2000', 'budget 500-2000', 'Open dates 3/8 3/15 3/22?', 'Open dates 11/21 11/28 12/5?', 'Years 2025 2026', '2025 2026 2027',
    'total 1,250,000', 'guests 120',
  ]) assert.equal(text.noContact(keep), keep, keep);
  assert.equal(text.listName('312/555/0100', 'Unknown number'), 'Unknown number');
});

test('the typed fields: a time, an address or a number is returned as stored; anything else is screened text or withheld', () => {
  deps.__resetToolDeps();
  const guard = text.createTextGuard();
  for (const t of ['6pm', '6:30 PM', '18:00', '6 p.m.']) assert.equal(guard.time(t, { record: 'p' }), t);
  assert.equal(guard.time('call pat@example.com', { record: 'p' }), 'call [email]');
  assert.equal(guard.email('pat@example.com', { record: 'c' }), 'pat@example.com');
  assert.equal(guard.email('pat@example.com; sam@example.org', { record: 'c' }), 'pat@example.com, sam@example.org');
  assert.equal(guard.email('mail it to drop at evil dot example', { record: 'c email' }), 'mail it to [email]',
    'no address: screened and stripped as text, not withheld for its shape');
  assert.equal(guard.phone('(312) 555-0101', { record: 'c' }), '(312) 555-0101');
  assert.equal(guard.phone('(312) 555-0101 x22', { record: 'c' }), '(312) 555-0101 x22');
  assert.equal(guard.phone('text me later', { record: 'c phone' }), 'text me later');
  assert.equal(guard.withheld.length, 0);
  assert.equal(text.refs.clientName(5), 'name:c-5');
  assert.equal(text.refs.personName('c-5'), 'name:c-5', 'a client is the same subject from the Inbox');
});

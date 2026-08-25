const { test } = require('node:test');
const assert = require('node:assert/strict');
const { consultCallAdmin } = require('./emailTemplates');

// ─── consultCallAdmin ────────────────────────────────────────────
// The consult call bridge's one admin alert (spec 2026-08-25 section 5.1).
// It fires only on faults: a failed chain, a tripped cap, a slot the bridge
// reached too late, a missed window, an undialable number, a fully missed
// consult whose text could not go out (no destination, or the send itself
// failed), and an unresolved reschedule that stopped more than one of a
// booker's upcoming consults. Never on a plain 'missed' (the text covers that)
// or on a cancelled/disabled skip. Pure render assertions; the
// notifyAdminCategory fan-out is exercised by the chain suite.

// 10:00 AM Chicago on 2026-10-10 (CDT, UTC-5).
const SLOT = new Date('2026-10-10T15:00:00.000Z');

const BASE = {
  bookerName: 'Tyler Anderson',
  scheduledAt: SLOT,
  phoneDisplay: '256-328-1203',
  adminUrl: 'https://admin.example.test/clients/7',
  proposalUrl: 'https://admin.example.test/proposals/42',
};

const REASONS = [
  'call failed',
  'daily cap tripped',
  'too late',
  'missed window',
  'undialable number',
  'missed, no text destination',
  'missed, text failed',
  'unresolved reschedule',
];

for (const reason of REASONS) {
  test(`reason "${reason}" lands in subject, html, and text`, () => {
    const tpl = consultCallAdmin({ ...BASE, reason });
    assert.equal(tpl.subject, `Consult call ${reason}: Tyler Anderson`);
    assert.ok(tpl.html.includes(reason), `html mentions the reason: ${reason}`);
    assert.ok(tpl.text.includes(reason), tpl.text);
    assert.ok(tpl.text.includes('Tyler Anderson'), tpl.text);
  });
}

test('the banner tells the reader what to do, per reason', () => {
  const banners = {
    'undialable number': 'The consult call bridge will not ring for this booking because the number cannot be dialed. Call them by hand at the slot.',
    'missed window': 'The slot passed before the bridge could ring. Call them now.',
    'missed, no text destination': 'Everyone missed this consult and no text destination is configured. Call them now.',
    // Its own banner, not the one above. sendSMS THROWS when Twilio is down, and
    // the two failures have different fixes: one is a Render setting, the other
    // is an outage nobody can fix from there.
    'missed, text failed': 'Everyone missed this consult and the text alert could not be sent, most likely a Twilio failure rather than a setting. Call them now.',
    'daily cap tripped': 'The daily cap on consult calls was already reached, so the bridge will not ring for this booking. Call them by hand at the slot.',
    'too late': 'Too much time had passed since the slot for the bridge to ring, so nobody was called. Call them now.',
    'unresolved reschedule': 'A reschedule named a booking we could not match, so this consult and every other upcoming consult for this booker were stopped and will not ring. Call them to confirm which slot is real.',
    // 'call failed' is the ONE reason the generic line is right for: the chain
    // died placing calls, which really is a system fault to go look at.
    'call failed': 'The consult call bridge could not complete calls for this consult. Check the system if this repeats.',
  };
  // Structural guard: another reason added to REASONS without a banner fails
  // here instead of silently shipping the generic "check the system" line.
  assert.deepEqual(
    Object.keys(banners).slice().sort(), REASONS.slice().sort(),
    'every reason the chain sends needs its own banner'
  );
  for (const [reason, banner] of Object.entries(banners)) {
    const tpl = consultCallAdmin({ ...BASE, reason });
    assert.ok(tpl.html.includes(banner), `html banner for ${reason}`);
    assert.ok(tpl.text.includes(banner), `text banner for ${reason}`);
  }
});

test('a reason that means nobody gets called never falls back to "check the system"', () => {
  // A tripped cap and a too-late chain used to render the generic fault line,
  // which sends the reader to the logs when the booker is the one waiting.
  const GENERIC = 'could not complete calls for this consult';
  const NOBODY_CALLED = [
    'daily cap tripped', 'too late', 'undialable number',
    'missed window', 'missed, no text destination', 'missed, text failed',
    'unresolved reschedule',
  ];
  for (const reason of NOBODY_CALLED) {
    const tpl = consultCallAdmin({ ...BASE, reason });
    assert.ok(!tpl.html.includes(GENERIC), `html: ${reason} must carry its own banner`);
    assert.ok(!tpl.text.includes(GENERIC), `text: ${reason} must carry its own banner`);
    assert.ok(/Call them/.test(tpl.text), `text: ${reason} must tell the reader to call them`);
  }
});

test('the undialable banner never leaks onto an unrelated reason', () => {
  const tpl = consultCallAdmin({ ...BASE, reason: 'call failed' });
  assert.ok(!tpl.html.includes('cannot be dialed'), tpl.html);
  assert.ok(!tpl.html.includes('The slot passed before'), tpl.html);
});

test('the Number row is always present, formatted or raw', () => {
  const formatted = consultCallAdmin({ ...BASE, reason: 'call failed' });
  assert.ok(formatted.html.includes('>Number</td>'), 'Number row in the table');
  assert.ok(formatted.html.includes('256-328-1203'), formatted.html);
  assert.ok(formatted.text.includes('256-328-1203'), formatted.text);

  // A bad number is exactly the case where nobody was rung and no text went
  // out, so the raw typed string has to ride along.
  const raw = consultCallAdmin({ ...BASE, reason: 'undialable number', phoneDisplay: 'call me at 5pm' });
  assert.ok(raw.html.includes('>Number</td>'), 'Number row survives a junk number');
  assert.ok(raw.html.includes('call me at 5pm'), raw.html);
  assert.ok(raw.text.includes('call me at 5pm'), raw.text);

  const none = consultCallAdmin({ reason: 'undialable number', scheduledAt: SLOT });
  assert.ok(none.html.includes('>Number</td>'), 'Number row survives a missing number');
  assert.ok(!/>\s*<\/td>\s*<\/tr>/.test(none.html.split('>Number</td>')[1] || ''), 'never a blank Number cell');
});

test('the slot renders in Chicago wall clock, never UTC', () => {
  const tpl = consultCallAdmin({ ...BASE, reason: 'call failed' });
  assert.ok(tpl.html.includes('>Slot</td>'), 'Slot row in the table');
  assert.ok(tpl.html.includes('Saturday'), tpl.html);
  assert.ok(tpl.html.includes('October 10'), tpl.html);
  assert.ok(tpl.html.includes('10:00'), tpl.html);
  assert.ok(!tpl.html.includes('October 11'), 'UTC day must not leak');
  assert.ok(!tpl.html.includes('3:00'), 'UTC hour must not leak');
  assert.ok(tpl.text.includes('October 10'), tpl.text);
});

test('a slot near midnight stays on the Chicago day', () => {
  const tpl = consultCallAdmin({ ...BASE, reason: 'call failed', scheduledAt: new Date('2026-10-11T02:30:00.000Z') });
  assert.ok(tpl.html.includes('October 10'), tpl.html);
  assert.ok(!tpl.html.includes('October 11'), 'UTC day must not leak');
});

test('an absent slot renders a fallback, never "Invalid Date"', () => {
  for (const scheduledAt of [null, undefined, 'not a date']) {
    const tpl = consultCallAdmin({ ...BASE, reason: 'call failed', scheduledAt });
    assert.ok(!tpl.html.includes('Invalid Date'), tpl.html);
    assert.ok(!tpl.text.includes('Invalid Date'), tpl.text);
    assert.ok(tpl.html.includes('Not specified'), tpl.html);
  }
});

test('both CTAs render when both links exist', () => {
  const tpl = consultCallAdmin({ ...BASE, reason: 'call failed' });
  assert.ok(tpl.html.includes('View Client'), tpl.html);
  assert.ok(tpl.html.includes('Open Proposal'), tpl.html);
  assert.ok(tpl.html.includes(BASE.adminUrl), tpl.html);
  assert.ok(tpl.html.includes(BASE.proposalUrl), tpl.html);
  assert.ok(tpl.text.includes(BASE.adminUrl), tpl.text);
  assert.ok(tpl.text.includes(BASE.proposalUrl), tpl.text);
});

test('one link renders one CTA; neither renders no dead href', () => {
  const clientOnly = consultCallAdmin({ ...BASE, reason: 'call failed', proposalUrl: null });
  assert.ok(clientOnly.html.includes('View Client'), clientOnly.html);
  assert.ok(!clientOnly.html.includes('Open Proposal'), clientOnly.html);
  assert.ok(!clientOnly.text.includes('Proposal:'), clientOnly.text);

  const proposalOnly = consultCallAdmin({ ...BASE, reason: 'call failed', adminUrl: null });
  assert.ok(proposalOnly.html.includes('Open Proposal'), proposalOnly.html);
  assert.ok(!proposalOnly.html.includes('View Client'), proposalOnly.html);

  const bare = consultCallAdmin({ ...BASE, reason: 'call failed', adminUrl: null, proposalUrl: null });
  assert.ok(!bare.html.includes('href="null"'), 'no dead href');
  assert.ok(!bare.html.includes('href="undefined"'), 'no dead href');
  assert.ok(!bare.html.includes('<a '), 'no CTA at all');
});

test('an absent booker name falls back to "Cal.com booker"', () => {
  const tpl = consultCallAdmin({ reason: 'call failed', scheduledAt: SLOT });
  assert.equal(tpl.subject, 'Consult call call failed: Cal.com booker');
  assert.ok(tpl.html.includes('Cal.com booker'), tpl.html);
  assert.ok(tpl.text.includes('Cal.com booker'), tpl.text);
});

test('an absent reason falls back to "call failed"', () => {
  const tpl = consultCallAdmin({ ...BASE });
  assert.equal(tpl.subject, 'Consult call call failed: Tyler Anderson');
  assert.ok(tpl.html.includes('call failed'), tpl.html);
});

test('a script-tag booker name is escaped in the subject and the html body', () => {
  const tpl = consultCallAdmin({ ...BASE, reason: 'call failed', bookerName: 'A <script>alert(1)</script>' });
  assert.ok(!tpl.html.includes('<script>'), 'name must be escaped in the body');
  assert.ok(tpl.html.includes('&lt;script&gt;'), tpl.html);
  assert.ok(!tpl.subject.includes('<script>'), 'name must be escaped in the subject');
});

test('an attacker-typed phone string is escaped in the html body', () => {
  const tpl = consultCallAdmin({ ...BASE, reason: 'undialable number', phoneDisplay: '"><script>alert(1)</script>' });
  assert.ok(!tpl.html.includes('<script>'), 'raw number must be escaped');
  assert.ok(tpl.html.includes('&lt;script&gt;'), tpl.html);
});

test('the plain-text part is not HTML-escaped', () => {
  // text/plain is delivered as-is by Resend and never re-rendered as HTML, so
  // escaping it would show a literal "&amp;" to the reader.
  const tpl = consultCallAdmin({ ...BASE, reason: 'call failed', bookerName: 'Tyler & Sons' });
  assert.ok(tpl.text.includes('Tyler & Sons'), tpl.text);
  assert.ok(!tpl.text.includes('&amp;'), tpl.text);
  assert.ok(tpl.html.includes('Tyler &amp; Sons'), tpl.html);
});

test('every render returns the three-part template shape', () => {
  const tpl = consultCallAdmin({ ...BASE, reason: 'call failed' });
  assert.equal(typeof tpl.subject, 'string');
  assert.equal(typeof tpl.html, 'string');
  assert.equal(typeof tpl.text, 'string');
  assert.ok(tpl.html.startsWith('<!DOCTYPE html>'), 'wrapped in the branded shell');
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { missedLeadCallAdmin } = require('./emailTemplates');

// ─── missedLeadCallAdmin ─────────────────────────────────────────
// The lead-call chain's one admin alert (missed / call failed / daily cap
// tripped). Pure render assertions; the notifyAdminCategory fan-out is
// exercised by the trigger/route suites.

const BASE = {
  customerName: 'Sarah M.',
  category: 'Wedding',
  eventDate: '2026-10-10T23:00:00.000Z',
  guestCount: 120,
  locationCity: 'Naperville',
  adminUrl: 'https://admin.example.test/clients/7',
  proposalUrl: 'https://admin.example.test/proposals/42',
};

for (const reason of ['missed', 'call failed', 'daily cap tripped']) {
  test(`reason "${reason}" lands in subject, html, and text`, () => {
    const tpl = missedLeadCallAdmin({ ...BASE, reason });
    assert.ok(tpl.subject.includes(reason), tpl.subject);
    assert.ok(tpl.subject.includes('Sarah M.'), tpl.subject);
    assert.ok(tpl.html.includes(reason), 'html mentions the reason');
    assert.ok(tpl.text.includes(reason), tpl.text);
  });
}

test('proposal URL wins the CTA; client URL is the fallback; neither renders no link', () => {
  const withProposal = missedLeadCallAdmin({ ...BASE, reason: 'missed' });
  assert.ok(withProposal.html.includes(BASE.proposalUrl));
  assert.ok(withProposal.text.includes(BASE.proposalUrl));

  const clientOnly = missedLeadCallAdmin({ ...BASE, reason: 'missed', proposalUrl: null });
  assert.ok(clientOnly.html.includes(BASE.adminUrl));
  assert.ok(clientOnly.text.includes(BASE.adminUrl));

  const bare = missedLeadCallAdmin({ ...BASE, reason: 'missed', proposalUrl: null, adminUrl: null });
  assert.ok(!bare.html.includes('href="null"'), 'no dead href');
});

test('absent lead fields render N/A fallbacks, never crash', () => {
  const tpl = missedLeadCallAdmin({ reason: 'missed' });
  assert.ok(tpl.subject.includes('Thumbtack lead'), tpl.subject);
  assert.ok(tpl.html.includes('Not specified'), 'missing date shows Not specified');
});

test('client-typed fields are HTML-escaped in the html body', () => {
  const tpl = missedLeadCallAdmin({ ...BASE, reason: 'missed', customerName: 'A <script>alert(1)</script>' });
  assert.ok(!tpl.html.includes('<script>'), 'name must be escaped');
});

test('event date renders in Chicago wall-clock (23:00Z Oct 10 stays Saturday October 10)', () => {
  const tpl = missedLeadCallAdmin({ ...BASE, reason: 'missed' });
  assert.ok(tpl.html.includes('October 10'), tpl.html.match(/Event Date.*?<\/tr>/s)?.[0]);
  assert.ok(!tpl.html.includes('October 11'), 'UTC day must not leak');
});

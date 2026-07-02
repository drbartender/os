const { test } = require('node:test');
const assert = require('node:assert/strict');
const t = require('./lifecycleEmailTemplates');

function assertNoEmDash(str, label) {
  assert.ok(!str.includes('—'), `${label} must not contain an em dash`);
}

test('portalInvite > first-name greeting, portal URL, one-time-code copy, no em dash', () => {
  const out = t.portalInvite({ clientName: 'Kim Nguyen', portalUrl: 'https://drbartender.com/my-proposals' });
  assert.strictEqual(out.subject, 'Your Dr. Bartender client portal');
  assert.match(out.html, /Hi Kim,/);
  assert.match(out.html, /https:\/\/drbartender\.com\/my-proposals/);
  assert.match(out.html, /one-time code/);
  assert.match(out.text, /Hi Kim,/);
  assert.match(out.text, /https:\/\/drbartender\.com\/my-proposals/);
  assert.match(out.text, /one-time code/);
  assertNoEmDash(out.subject, 'subject');
  assertNoEmDash(out.text, 'text');
  assertNoEmDash(out.html, 'html');
  // NEGATIVE token guard: this email's entire security property is that no
  // token/OTP/UUID rides in it (the portal sits behind the OTP login). Reject
  // token-ish content outright and anchor the URL so a future edit that
  // appends ?token=... fails here instead of shipping.
  for (const body of [out.html, out.text]) {
    assert.ok(!/token/i.test(body), 'no "token" anywhere in the invite');
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(body), 'no UUID in the invite');
    assert.ok(!/my-proposals[?#/]/.test(body), 'portal URL has nothing appended after /my-proposals');
  }
  // Null-name fallback greets generically, never "undefined".
  const fallback = t.portalInvite({ clientName: null, portalUrl: 'https://x/p' });
  assert.match(fallback.text, /Hi there,/);
  assert.ok(!fallback.text.includes('undefined'));
});

test('lastMinuteStaffingConfirmation > singular subject + body', () => {
  const out = t.lastMinuteStaffingConfirmation({
    eventDate: 'Saturday, May 30, 2026',
    bartenderList: 'Alex ((312) 555-1234)',
    isPlural: false,
  });
  assert.strictEqual(out.subject, 'Your bartender for Saturday, May 30, 2026');
  assert.match(out.text, /Your bartender for Saturday, May 30, 2026 is Alex \(\(312\) 555-1234\)/);
  assert.match(out.text, /Cheers, Dallas/);
  assert.match(out.html, /Alex \(\(312\) 555-1234\)/);
  assertNoEmDash(out.subject, 'subject');
  assertNoEmDash(out.text, 'text');
});

test('lastMinuteStaffingConfirmation > plural subject + body', () => {
  const out = t.lastMinuteStaffingConfirmation({
    eventDate: 'Saturday, May 30, 2026',
    bartenderList: 'Alex ((312) 555-1234) and Jordan ((312) 555-5678)',
    isPlural: true,
  });
  assert.strictEqual(out.subject, 'Your bartenders for Saturday, May 30, 2026');
  assert.match(out.text, /Your bartenders for Saturday, May 30, 2026 are Alex/);
  assert.match(out.text, /and Jordan/);
  assertNoEmDash(out.subject, 'subject');
  assertNoEmDash(out.text, 'text');
});

test('lastMinuteStaffingConfirmation > html is wrapped with the standard chrome', () => {
  const out = t.lastMinuteStaffingConfirmation({
    eventDate: 'Saturday, May 30, 2026',
    bartenderList: 'Alex',
    isPlural: false,
  });
  assert.match(out.html, /<!DOCTYPE html>/i);
});

// ─── Email change templates (spec §6.10, shipped Task 17/18) ──────────────

test('emailChangeVerification > substitutes verifyUrl + newEmail', () => {
  const out = t.emailChangeVerification({
    verifyUrl: 'https://api.drbartender.com/email-change/confirm/abc',
    newEmail: 'new@example.com',
  });
  assert.strictEqual(out.subject, 'Confirm your new Dr. Bartender email address');
  assert.match(out.text, /new@example\.com/);
  assert.match(out.text, /https:\/\/api\.drbartender\.com\/email-change\/confirm\/abc/);
  assert.match(out.html, /new@example\.com/);
  assert.match(out.html, /Confirm email change/);
  assertNoEmDash(out.subject, 'emailChangeVerification subject');
  assertNoEmDash(out.text, 'emailChangeVerification text');
});

test('emailChangeWarning > names the new email and includes a cancel link when provided', () => {
  const out = t.emailChangeWarning({
    newEmail: 'new@example.com',
    cancelUrl: 'https://admin.drbartender.com/profile/cancel-email-change',
  });
  assert.match(out.subject, /Email change requested/);
  assert.match(out.text, /new@example\.com/);
  assert.match(out.text, /https:\/\/admin\.drbartender\.com\/profile\/cancel-email-change/);
  assert.match(out.html, /new@example\.com/);
  assertNoEmDash(out.subject, 'emailChangeWarning subject');
  assertNoEmDash(out.text, 'emailChangeWarning text');
});

test('emailChangeWarning > omits cancel-link line when cancelUrl is null', () => {
  const out = t.emailChangeWarning({ newEmail: 'new@example.com', cancelUrl: null });
  assert.ok(!out.text.includes('Direct cancel link'), 'cancel-link line should be omitted');
});

test('emailChangeConfirmed > shows old + new emails', () => {
  const out = t.emailChangeConfirmed({
    oldEmail: 'old@example.com',
    newEmail: 'new@example.com',
  });
  assert.match(out.subject, /Email changed/);
  assert.match(out.text, /from old@example\.com to new@example\.com/);
  assert.match(out.html, /old@example\.com/);
  assert.match(out.html, /new@example\.com/);
  assertNoEmDash(out.subject, 'emailChangeConfirmed subject');
  assertNoEmDash(out.text, 'emailChangeConfirmed text');
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const t = require('./lifecycleEmailTemplates');

function assertNoEmDash(str, label) {
  assert.ok(!str.includes('—'), `${label} must not contain an em dash`);
}

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

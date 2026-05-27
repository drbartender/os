const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderCcWrapUpEmail } = require('./ccWrapUpEmailTemplate');

test('renderCcWrapUpEmail: subject contains first name', () => {
  const out = renderCcWrapUpEmail({
    client: { name: 'Meg Henke', email: 'meg@x.com' },
    proposal: { event_date: '2026-05-15', token: 'abc' },
  });
  assert.strictEqual(out.subject, 'Thanks for celebrating with Dr. Bartender, Meg');
});

test('renderCcWrapUpEmail: subject falls back to "there" on missing name', () => {
  const out = renderCcWrapUpEmail({
    client: { name: '', email: 'x@x.com' },
    proposal: { event_date: '2026-05-15', token: 'tok' },
  });
  assert.match(out.subject, /Thanks for celebrating with Dr\. Bartender, there/);
});

test('renderCcWrapUpEmail: feedback URL is path-segment shape', () => {
  process.env.PUBLIC_SITE_URL = 'https://drbartender.com';
  const out = renderCcWrapUpEmail({
    client: { name: 'X' },
    proposal: { event_date: '2026-05-15', token: 'tok123' },
  });
  assert.ok(out.html.includes('https://drbartender.com/feedback/tok123'));
  assert.ok(out.text.includes('https://drbartender.com/feedback/tok123'));
});

test('renderCcWrapUpEmail: omits Google review button when PUBLIC_GOOGLE_REVIEW_URL unset', () => {
  delete process.env.PUBLIC_GOOGLE_REVIEW_URL;
  const out = renderCcWrapUpEmail({
    client: { name: 'X' },
    proposal: { event_date: '2026-05-15', token: 'tok' },
  });
  assert.ok(!out.html.includes('Leave a Google review'));
});

test('renderCcWrapUpEmail: includes Google review button when PUBLIC_GOOGLE_REVIEW_URL set', () => {
  process.env.PUBLIC_GOOGLE_REVIEW_URL = 'https://g.page/drbartender/review';
  const out = renderCcWrapUpEmail({
    client: { name: 'X' },
    proposal: { event_date: '2026-05-15', token: 'tok' },
  });
  assert.ok(out.html.includes('https://g.page/drbartender/review'));
  delete process.env.PUBLIC_GOOGLE_REVIEW_URL;  // cleanup
});

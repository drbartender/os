const { test } = require('node:test');
const assert = require('node:assert/strict');
const tpl = require('./marketingEmailTemplates');

const baseParams = {
  clientName: 'Jane',
  clientFirstName: 'Jane',
  eventTypeLabel: 'birthday party',
  eventDateDisplay: 'June 15, 2026',
  proposalUrl: 'https://drbartender.com/proposal/abc-token',
  unsubscribeUrl: 'https://api.drbartender.com/unsubscribe?t=xyz',
};

// ── dripTouch2Client ──
test('dripTouch2Client > renders subject with first name and event date', () => {
  const out = tpl.dripTouch2Client(baseParams);
  assert.strictEqual(out.subject, 'Still thinking about your June 15, 2026 event, Jane?');
});

test('dripTouch2Client > includes the proposal URL and the unsubscribe footer', () => {
  const out = tpl.dripTouch2Client(baseParams);
  assert.ok(out.html.includes('https://drbartender.com/proposal/abc-token'));
  assert.ok(out.html.includes('Unsubscribe'));
  assert.ok(out.html.includes(baseParams.unsubscribeUrl));
});

test('dripTouch2Client > falls back to "there" / "your event" / "soon" when params are missing', () => {
  const out = tpl.dripTouch2Client({
    unsubscribeUrl: baseParams.unsubscribeUrl,
  });
  assert.match(out.subject, /event/);
  assert.ok(out.html.includes('Hi there'));
});

// ── dripTouch4Client ──
test('dripTouch4Client > mentions BYOB and Hosted alternative packages', () => {
  const out = tpl.dripTouch4Client(baseParams);
  assert.match(out.html, /BYOB/);
  assert.match(out.html, /Hosted/);
});

test('dripTouch4Client > subject mentions following up and event date', () => {
  const out = tpl.dripTouch4Client(baseParams);
  assert.strictEqual(out.subject, 'Following up on your June 15, 2026 booking, Jane');
});

// ── dripTouch5Client ──
test('dripTouch5Client > subject says "last call"', () => {
  const out = tpl.dripTouch5Client(baseParams);
  assert.strictEqual(out.subject, 'Last call to secure June 15, 2026, Jane');
});

test('dripTouch5Client > includes the proposal URL', () => {
  const out = tpl.dripTouch5Client(baseParams);
  assert.ok(out.html.includes(baseParams.proposalUrl));
});

// ── reviewRequestClient ──
// NOTE: payment_profiles has NO zelle_handle column today (only venmo_handle,
// cashapp_handle, paypal_url). Plan 2d deliberately defers Zelle support — the
// tip-handle section is Venmo + Cash App only. If/when a Zelle migration is
// added later, expand this test and the template together.
const reviewParams = {
  ...baseParams,
  dayOfWeek: 'Saturday',
  feedbackUrl: 'https://drbartender.com/feedback/abc-token',
  bartenderName: 'Alex',
  venmoHandle: '@alex-bartender',
  cashappHandle: '$alexb',
};

test('reviewRequestClient > renders subject with event date', () => {
  const out = tpl.reviewRequestClient(reviewParams);
  assert.strictEqual(out.subject, 'How was your June 15, 2026 event?');
});

test('reviewRequestClient > includes feedback URL and bartender tip handles when present', () => {
  const out = tpl.reviewRequestClient(reviewParams);
  assert.ok(out.html.includes('https://drbartender.com/feedback/abc-token'));
  assert.ok(out.html.includes('Alex'));
  assert.ok(out.html.includes('@alex-bartender'));
  assert.ok(out.html.includes('$alexb'));
});

test('reviewRequestClient > omits the tip-handle line when bartenderName is null (multi-bartender)', () => {
  const out = tpl.reviewRequestClient({ ...reviewParams, bartenderName: null });
  assert.doesNotMatch(out.html, /tips at/);
});

test('reviewRequestClient > omits a single tip handle when it is missing', () => {
  const out = tpl.reviewRequestClient({ ...reviewParams, cashappHandle: null });
  assert.ok(!out.html.includes('Cash App'));
  assert.ok(out.html.includes('@alex-bartender'));
});

test('reviewRequestClient > never references Zelle (column not in schema)', () => {
  const out = tpl.reviewRequestClient(reviewParams);
  assert.ok(!out.html.toLowerCase().includes('zelle'));
});

// ── newYearHelloClient ──
test('newYearHelloClient > subject contains "happy new year" and first name', () => {
  const out = tpl.newYearHelloClient(baseParams);
  assert.strictEqual(out.subject, 'Happy new year, Jane, looking forward to your event');
});

test('newYearHelloClient > includes the event type label and date in body', () => {
  const out = tpl.newYearHelloClient(baseParams);
  assert.ok(out.html.includes('birthday party'));
  assert.ok(out.html.includes('June 15, 2026'));
});

// ── sixMonthsOutClient ──
test('sixMonthsOutClient > subject says "six months out"', () => {
  const out = tpl.sixMonthsOutClient({
    ...baseParams,
    potionPlannerUrl: 'https://drbartender.com/plan/xyz',
    consultUrl: 'https://cal.com/drbartender/consult',
  });
  assert.strictEqual(out.subject, 'Six months out from your June 15, 2026 event');
});

test('sixMonthsOutClient > includes potion planner URL and consult URL', () => {
  const out = tpl.sixMonthsOutClient({
    ...baseParams,
    potionPlannerUrl: 'https://drbartender.com/plan/xyz',
    consultUrl: 'https://cal.com/drbartender/consult',
  });
  assert.ok(out.html.includes('https://drbartender.com/plan/xyz'));
  assert.ok(out.html.includes('https://cal.com/drbartender/consult'));
});

// ── retentionNudgeClient ──
test('retentionNudgeClient > subject mentions almost a year and event type', () => {
  const out = tpl.retentionNudgeClient(baseParams);
  assert.strictEqual(out.subject, 'Almost a year since your birthday party, Jane');
});

test('retentionNudgeClient > includes unsubscribe footer (this IS marketing-class)', () => {
  const out = tpl.retentionNudgeClient(baseParams);
  assert.ok(out.html.includes(baseParams.unsubscribeUrl));
});

// ── lowRatingAdminNotification ──
const adminParams = {
  clientName: 'Jane',
  eventDateDisplay: 'June 15, 2026',
  eventTypeLabel: 'birthday party',
  rating: 2,
  comment: 'Bartender was 30 minutes late.',
  adminUrl: 'https://admin.drbartender.com/proposals/42',
};

test('lowRatingAdminNotification > subject flags low rating', () => {
  const out = tpl.lowRatingAdminNotification(adminParams);
  assert.match(out.subject, /Low rating/);
});

test('lowRatingAdminNotification > includes rating, comment, and admin link', () => {
  const out = tpl.lowRatingAdminNotification(adminParams);
  assert.ok(out.html.includes('2 / 5'));
  assert.ok(out.html.includes('Bartender was 30 minutes late.'));
  assert.ok(out.html.includes(adminParams.adminUrl));
});

test('lowRatingAdminNotification > renders gracefully when comment is null', () => {
  const out = tpl.lowRatingAdminNotification({ ...adminParams, comment: null });
  assert.ok(!out.html.includes('null'));
});

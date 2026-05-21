const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseStartTimeToHM,
  computeUtcStartEnd,
  deriveBarOption,
  computeBalanceContext,
  buildPotionPlannerUrl,
} = require('./orientationData');

// parseStartTimeToHM accepts both 24h ("17:00") and 12h ("5:00 PM") strings
// since proposals.event_start_time is VARCHAR(20) with both shapes in the wild.
test('parseStartTimeToHM: 24h "17:00" -> {h:17,m:0}', () => {
  assert.deepEqual(parseStartTimeToHM('17:00'), { h: 17, m: 0 });
});
test('parseStartTimeToHM: 12h "5:00 PM" -> {h:17,m:0}', () => {
  assert.deepEqual(parseStartTimeToHM('5:00 PM'), { h: 17, m: 0 });
});
test('parseStartTimeToHM: 12h "12:00 AM" -> {h:0,m:0}', () => {
  assert.deepEqual(parseStartTimeToHM('12:00 AM'), { h: 0, m: 0 });
});
test('parseStartTimeToHM: 12h "12:30 PM" -> {h:12,m:30}', () => {
  assert.deepEqual(parseStartTimeToHM('12:30 PM'), { h: 12, m: 30 });
});
test('parseStartTimeToHM: null/garbage -> null', () => {
  assert.equal(parseStartTimeToHM(null), null);
  assert.equal(parseStartTimeToHM(''), null);
  assert.equal(parseStartTimeToHM('25:00'), null);
  assert.equal(parseStartTimeToHM('abc'), null);
});

test('computeUtcStartEnd: 2026-06-15 5:00 PM America/Chicago + 4h -> UTC start 22:00, end 02:00 next day', () => {
  // June 15 2026 is CDT (UTC-5). 5:00 PM local = 22:00 UTC.
  const { startUtc, endUtc } = computeUtcStartEnd({
    eventDate: '2026-06-15',
    startTimeStr: '5:00 PM',
    durationHours: 4,
    tz: 'America/Chicago',
  });
  assert.equal(startUtc.toISOString(), '2026-06-15T22:00:00.000Z');
  assert.equal(endUtc.toISOString(), '2026-06-16T02:00:00.000Z');
});

test('computeUtcStartEnd: missing start time -> null', () => {
  const result = computeUtcStartEnd({
    eventDate: '2026-06-15',
    startTimeStr: null,
    durationHours: 4,
    tz: 'America/Chicago',
  });
  assert.equal(result, null);
});

test('deriveBarOption: pricing_type "per_guest" -> "hosted"', () => {
  assert.equal(deriveBarOption({ pricing_type: 'per_guest' }), 'hosted');
});
test('deriveBarOption: pricing_type "flat" -> "byob"', () => {
  assert.equal(deriveBarOption({ pricing_type: 'flat' }), 'byob');
});
test('deriveBarOption: pricing_type "per_guest_timed" -> "byob" (DELIBERATE PIN, do not "fix")', () => {
  // DELIBERATE PIN - do not flip this to return 'hosted'.
  //
  // The pricing engine's `isHostedPackage(pkg)` checks ONLY
  // `pkg.pricing_type === 'per_guest'`. It does NOT include 'per_guest_timed'.
  // Plan 2b's `deriveBarOption` mirrors that exact check so the bar-option
  // branch in the orientation / drink-plan-submit / shopping-list emails
  // stays in lockstep with the pricing engine's bar-option branch. If the
  // two drift, BYOB clients get hosted copy or vice versa.
  //
  // If a future audit flags this as "per_guest_timed sounds hosted, shouldn't
  // it return 'hosted'?" - STOP. Check `isHostedPackage` in
  // server/utils/pricingEngine.js FIRST. Only flip this test if
  // isHostedPackage is also being extended to cover per_guest_timed; the
  // two MUST move together.
  assert.equal(deriveBarOption({ pricing_type: 'per_guest_timed' }), 'byob');
});
test('deriveBarOption: null package -> "byob" (safe default)', () => {
  assert.equal(deriveBarOption(null), 'byob');
});

test('computeBalanceContext: deposit-only, autopay enrolled', () => {
  const ctx = computeBalanceContext({
    totalPrice: 1500,
    amountPaid: 100,
    autopayEnrolled: true,
    balanceDueDate: '2026-06-01',
  });
  assert.equal(ctx.balanceRemaining, 1400);
  assert.equal(ctx.autopayEnrolled, true);
  assert.equal(ctx.balanceVerb, 'runs');
  assert.equal(ctx.dueLabel, 'runs on');
  assert.equal(ctx.formattedBalanceDueDate, 'June 1, 2026');
});

test('computeBalanceContext: paid in full', () => {
  const ctx = computeBalanceContext({
    totalPrice: 500,
    amountPaid: 500,
    autopayEnrolled: false,
    balanceDueDate: null,
  });
  assert.equal(ctx.balanceRemaining, 0);
  assert.equal(ctx.paidInFull, true);
});

test('computeBalanceContext: non-autopay path', () => {
  const ctx = computeBalanceContext({
    totalPrice: 1500,
    amountPaid: 100,
    autopayEnrolled: false,
    balanceDueDate: '2026-06-01',
  });
  assert.equal(ctx.balanceVerb, 'due');
  assert.equal(ctx.dueLabel, 'due on');
});

test('buildPotionPlannerUrl: builds /plan/<token>', () => {
  const url = buildPotionPlannerUrl('https://drbartender.com', 'abc-123');
  assert.equal(url, 'https://drbartender.com/plan/abc-123');
});
test('buildPotionPlannerUrl: null token returns null (caller suppresses CTA)', () => {
  const url = buildPotionPlannerUrl('https://drbartender.com', null);
  assert.equal(url, null);
});

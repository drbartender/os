const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  signedAndPaidClient,
  drinkPlanBalanceUpdate,
  shoppingListReady,
  postConsultClient,
} = require('./emailTemplates');

// ─── signedAndPaidClient (orientation) ───────────────────────────

test('signedAndPaidClient: full orientation includes booking + receipt + planner CTA + timeline', () => {
  const t = signedAndPaidClient({
    clientName: 'Alex',
    eventTypeLabel: 'birthday party',
    amount: '100.00',
    paymentType: 'deposit',
    bookingBlock: {
      formattedEventDate: 'Sunday, June 15, 2026',
      formattedStartTime: '5:00 PM',
      eventLocation: '123 Main St, Austin, TX',
      guestCount: 50,
      packageName: 'BYOB Classic',
    },
    receiptBlock: {
      depositPaid: '100.00',
      balanceRemaining: '1400.00',
      paidInFull: false,
      autopayEnrolled: true,
      dueLabel: 'runs on',
      formattedBalanceDueDate: 'June 1, 2026',
    },
    potionPlannerUrl: 'https://drbartender.com/plan/abc-123',
    timelineLines: [
      'Drink plan: pick yours any time, ideally before [date]',
      'Balance: auto-charges on June 1',
      'Bartender assignment: about 14 days before the event',
      'Day-of: your bartender arrives 30 to 90 minutes before your start time to set up',
    ],
  });
  assert.match(t.subject, /You're booked/i);
  assert.match(t.subject, /Sunday, June 15, 2026/);
  assert.match(t.html, /Sunday, June 15, 2026/);
  assert.match(t.html, /5:00 PM/);
  assert.match(t.html, /123 Main St, Austin, TX/);
  assert.match(t.html, /50/);
  assert.match(t.html, /BYOB Classic/);
  assert.match(t.html, /\$100\.00/);
  assert.match(t.html, /\$1400\.00/);
  assert.match(t.html, /runs on.*June 1, 2026/);
  assert.match(t.html, /Pick your drinks/i);
  assert.match(t.html, /abc-123/);
  for (const line of [
    'Drink plan:',
    'Balance:',
    'Bartender assignment:',
    'Day-of:',
  ]) {
    assert.match(t.html, new RegExp(line));
  }
  assert.ok(t.text && t.text.length > 100, 'text fallback should be substantial');
});

test('signedAndPaidClient: paid-in-full hides balance row and shows "paid in full" copy', () => {
  const t = signedAndPaidClient({
    clientName: 'Bob',
    eventTypeLabel: 'wedding',
    amount: '2000.00',
    paymentType: 'full payment',
    bookingBlock: {
      formattedEventDate: 'Saturday, August 1, 2026',
      formattedStartTime: '4:00 PM',
      eventLocation: 'Venue',
      guestCount: 120,
      packageName: 'Hosted Premium',
    },
    receiptBlock: {
      depositPaid: '2000.00',
      balanceRemaining: '0.00',
      paidInFull: true,
      autopayEnrolled: false,
      dueLabel: null,
      formattedBalanceDueDate: null,
    },
    potionPlannerUrl: 'https://drbartender.com/plan/xyz',
    timelineLines: ['Drink plan: pick yours any time'],
  });
  assert.match(t.html, /paid in full/i);
  assert.doesNotMatch(t.html, /balance remaining/i);
});

test('signedAndPaidClient: missing potionPlannerUrl suppresses the CTA gracefully', () => {
  const t = signedAndPaidClient({
    clientName: 'Sam',
    eventTypeLabel: 'event',
    amount: '100.00',
    paymentType: 'deposit',
    bookingBlock: {
      formattedEventDate: 'Sunday, June 15, 2026',
      formattedStartTime: '5:00 PM',
      eventLocation: 'TBD',
      guestCount: 50,
      packageName: 'BYOB Classic',
    },
    receiptBlock: {
      depositPaid: '100.00',
      balanceRemaining: '1400.00',
      paidInFull: false,
      autopayEnrolled: true,
      dueLabel: 'runs on',
      formattedBalanceDueDate: 'June 1, 2026',
    },
    potionPlannerUrl: null,
    timelineLines: [],
  });
  assert.doesNotMatch(t.html, /Pick your drinks/i);
  assert.doesNotMatch(t.html, /\/plan\//);
});

test('signedAndPaidClient: lastMinute=true appends the cancellation caveat', () => {
  const t = signedAndPaidClient({
    clientName: 'Jess',
    eventTypeLabel: 'birthday',
    amount: '100.00',
    paymentType: 'deposit',
    lastMinute: true,
    bookingBlock: {
      formattedEventDate: 'Tomorrow',
      formattedStartTime: '5:00 PM',
      eventLocation: 'X',
      guestCount: 30,
      packageName: 'BYOB Classic',
    },
    receiptBlock: {
      depositPaid: '100.00',
      balanceRemaining: '500.00',
      paidInFull: false,
      autopayEnrolled: true,
      dueLabel: 'runs on',
      formattedBalanceDueDate: 'June 1, 2026',
    },
    potionPlannerUrl: 'https://drbartender.com/plan/abc',
    timelineLines: [],
  });
  assert.match(t.html, /less than 72 hours/i);
});

// ─── drinkPlanBalanceUpdate ──────────────────────────────────────

test('drinkPlanBalanceUpdate: BYOB variant includes shopping-list timing warning', () => {
  const t = drinkPlanBalanceUpdate({
    clientName: 'Alex',
    eventTypeLabel: 'birthday',
    barOption: 'byob',
    balanceChanged: false,
    extrasAmount: 0,
    newTotal: 1500,
    amountPaid: 1500,
    balanceDue: 0,
    balanceDueDate: null,
  });
  assert.match(t.html, /hold off on the actual shopping/i);
  assert.match(t.html, /freshness|fresh ingredients|stay fresh/i);
  assert.match(t.html, /return windows?/i);
});

test('drinkPlanBalanceUpdate: Hosted variant has no shopping-list warning', () => {
  const t = drinkPlanBalanceUpdate({
    clientName: 'Alex',
    eventTypeLabel: 'wedding',
    barOption: 'hosted',
    balanceChanged: false,
    extrasAmount: 0,
    newTotal: 5000,
    amountPaid: 5000,
    balanceDue: 0,
    balanceDueDate: null,
  });
  assert.doesNotMatch(t.html, /hold off on/i);
  assert.doesNotMatch(t.html, /freshness/i);
});

test('drinkPlanBalanceUpdate: balanceChanged=true includes updated-balance table', () => {
  const t = drinkPlanBalanceUpdate({
    clientName: 'Alex',
    eventTypeLabel: 'birthday',
    barOption: 'byob',
    balanceChanged: true,
    extrasAmount: 200,
    newTotal: 1700,
    amountPaid: 100,
    balanceDue: 1600,
    balanceDueDate: '2026-06-01',
  });
  assert.match(t.html, /Updated balance|Updated Event Total|Remaining Balance/);
  assert.match(t.html, /\$1600\.00/);
  assert.match(t.html, /June 1, 2026/);
});

test('drinkPlanBalanceUpdate: balanceChanged=false omits balance table but still confirms receipt', () => {
  const t = drinkPlanBalanceUpdate({
    clientName: 'Alex',
    eventTypeLabel: 'birthday',
    barOption: 'byob',
    balanceChanged: false,
    extrasAmount: 0,
    newTotal: 1500,
    amountPaid: 1500,
    balanceDue: 0,
    balanceDueDate: null,
  });
  assert.match(t.html, /got your drink list/i);
  assert.doesNotMatch(t.html, /\$0\.00/);
});

// ─── shoppingListReady ───────────────────────────────────────────

test('shoppingListReady: includes freshness/return-window warning', () => {
  const t = shoppingListReady({
    clientName: 'Alex',
    eventTypeLabel: 'birthday',
    shoppingListUrl: 'https://drbartender.com/shopping-list/abc',
  });
  assert.match(t.html, /best to do the actual shopping in the days leading up/i);
  assert.match(t.html, /freshness|stay fresh/i);
  assert.match(t.html, /return windows?/i);
});

// ─── postConsultClient (new) ─────────────────────────────────────

test('postConsultClient: renders consult recap with drink list and next-step', () => {
  const t = postConsultClient({
    clientName: 'Alex',
    eventTypeLabel: 'birthday',
    formattedEventDate: 'Sunday, June 15, 2026',
    drinkRecapLines: [
      'Signature cocktail: Old Fashioned',
      'Wine: Cabernet, Sauvignon Blanc',
      'Beer: IPA, lager',
    ],
    nextStepLine: "We'll send your shopping list shortly.",
  });
  assert.match(t.subject, /Drink plan recap/i);
  assert.match(t.html, /Old Fashioned/);
  assert.match(t.html, /Cabernet/);
  assert.match(t.html, /We'll send your shopping list shortly/);
});

test('postConsultClient: hosted variant uses different next-step line', () => {
  const t = postConsultClient({
    clientName: 'Alex',
    eventTypeLabel: 'wedding',
    formattedEventDate: 'Saturday, August 1, 2026',
    drinkRecapLines: ['Signature cocktail: French 75'],
    nextStepLine: 'Your bartender will prep based on this.',
  });
  assert.match(t.html, /Your bartender will prep based on this/);
});

test('postConsultClient: empty drinkRecapLines still renders gracefully', () => {
  const t = postConsultClient({
    clientName: 'Alex',
    eventTypeLabel: 'birthday',
    formattedEventDate: 'Sunday, June 15, 2026',
    drinkRecapLines: [],
    nextStepLine: "We'll send your shopping list shortly.",
  });
  assert.ok(t.html);
  assert.match(t.html, /recap/i);
});

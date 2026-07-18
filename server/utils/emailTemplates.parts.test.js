'use strict';

// Pure unit tests for the compose-modal "parts" exports (spec 4.1). No DB, no
// dotenv: every parts function is a pure builder of { subject, heading,
// bodyText, cta }. Run: node --test server/utils/emailTemplates.parts.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  proposalSentParts,
  proposalOptionsSentParts,
  paymentReminderParts,
  invoiceReadyParts,
} = require('./emailTemplates');
const {
  shoppingListReadyParts,
  portalInviteParts,
  drinkPlanNudgeParts,
  consultRecapParts,
} = require('./lifecycleEmailTemplates');

// Shared shape assertions every parts function must satisfy.
function assertPartsShape(parts) {
  assert.equal(typeof parts.subject, 'string');
  assert.ok(parts.subject.length > 0, 'subject non-empty');
  assert.equal(typeof parts.heading, 'string');
  assert.ok(parts.heading.length > 0, 'heading non-empty');
  assert.equal(typeof parts.bodyText, 'string');
  assert.ok(parts.bodyText.length > 0, 'bodyText non-empty');
  assert.ok(parts.bodyText.startsWith('Hi '), 'bodyText starts with "Hi "');
  assert.ok(parts.bodyText.endsWith('Cheers, Dallas'), 'bodyText ends with sign-off');
  // House rule: no em dashes anywhere in the copy.
  assert.ok(!parts.subject.includes('—'), 'no em dash in subject');
  assert.ok(!parts.bodyText.includes('—'), 'no em dash in bodyText');
}

// ─── proposalSentParts ──────────────────────────────────────────────
test('proposalSentParts: shape + cta.url + planUrl folded into prose', () => {
  const p = proposalSentParts({
    clientName: 'Alex',
    eventTypeLabel: 'birthday party',
    proposalUrl: 'https://drbartender.com/p/abc',
    planUrl: 'https://drbartender.com/plan/xyz',
  });
  assertPartsShape(p);
  assert.equal(p.cta.url, 'https://drbartender.com/p/abc');
  assert.equal(p.cta.label, 'View your proposal');
  assert.ok(p.bodyText.includes('https://drbartender.com/plan/xyz'), 'planUrl mentioned in prose');
});

test('proposalSentParts: no planUrl -> prose omits the questionnaire line', () => {
  const p = proposalSentParts({
    clientName: 'Alex',
    proposalUrl: 'https://drbartender.com/p/abc',
  });
  assertPartsShape(p);
  assert.ok(!p.bodyText.toLowerCase().includes('questionnaire'), 'no plan line without planUrl');
});

// ─── proposalOptionsSentParts ───────────────────────────────────────
test('proposalOptionsSentParts: shape + cta.url', () => {
  const p = proposalOptionsSentParts({
    clientName: 'Jordan',
    eventTypeLabel: 'wedding',
    compareUrl: 'https://drbartender.com/compare/opt',
  });
  assertPartsShape(p);
  assert.equal(p.cta.url, 'https://drbartender.com/compare/opt');
  assert.equal(p.cta.label, 'Compare your options');
});

// ─── paymentReminderParts ───────────────────────────────────────────
test('paymentReminderParts: shape + cta.url (manual)', () => {
  const p = paymentReminderParts({
    clientName: 'Sam',
    eventTypeLabel: 'holiday party',
    balanceDue: 450,
    balanceDueDate: '2026-12-20',
    proposalUrl: 'https://drbartender.com/p/pay',
    paymentMode: 'manual',
  });
  assertPartsShape(p);
  assert.equal(p.cta.url, 'https://drbartender.com/p/pay');
  assert.equal(p.cta.label, 'View & pay');
  assert.ok(p.bodyText.includes('$450.00'), 'preserves money formatting from legacy');
});

test('paymentReminderParts: autopay vs manual produce different bodyText', () => {
  const args = {
    clientName: 'Sam',
    eventTypeLabel: 'holiday party',
    balanceDue: 450,
    balanceDueDate: '2026-12-20',
    proposalUrl: 'https://drbartender.com/p/pay',
    last4: '4242',
  };
  const autopay = paymentReminderParts({ ...args, paymentMode: 'autopay' });
  const manual = paymentReminderParts({ ...args, paymentMode: 'manual' });
  assertPartsShape(autopay);
  assertPartsShape(manual);
  assert.notEqual(autopay.bodyText, manual.bodyText, 'autopay and manual differ');
  assert.ok(autopay.bodyText.includes('4242'), 'autopay mentions last4');
  assert.ok(!manual.bodyText.includes('4242'), 'manual omits last4');
});

// ─── invoiceReadyParts ──────────────────────────────────────────────
test('invoiceReadyParts: shape + cta.url + preformatted amount verbatim', () => {
  const p = invoiceReadyParts({
    clientName: 'Riley',
    eventTypeLabel: 'corporate mixer',
    amountDue: '$1,250.00',
    invoiceUrl: 'https://drbartender.com/inv/123',
  });
  assertPartsShape(p);
  assert.equal(p.cta.url, 'https://drbartender.com/inv/123');
  assert.equal(p.cta.label, 'View & pay invoice');
  assert.ok(p.bodyText.includes('$1,250.00'), 'amountDue emitted verbatim');
});

// ─── shoppingListReadyParts (reference example) ─────────────────────
test('shoppingListReadyParts: shape + cta.url', () => {
  const p = shoppingListReadyParts({
    clientName: 'Casey',
    eventTypeLabel: 'graduation party',
    shoppingListUrl: 'https://drbartender.com/shop/list',
  });
  assertPartsShape(p);
  assert.equal(p.cta.url, 'https://drbartender.com/shop/list');
  assert.equal(p.cta.label, 'View shopping list');
});

// ─── portalInviteParts ──────────────────────────────────────────────
test('portalInviteParts: shape + cta.url + first-name greeting', () => {
  const p = portalInviteParts({
    clientName: 'Taylor Morgan',
    portalUrl: 'https://drbartender.com/portal',
  });
  assertPartsShape(p);
  assert.equal(p.cta.url, 'https://drbartender.com/portal');
  assert.equal(p.cta.label, 'Open your event portal');
  assert.ok(p.bodyText.startsWith('Hi Taylor,'), 'greets by first name only');
});

// ─── drinkPlanNudgeParts ────────────────────────────────────────────
test('drinkPlanNudgeParts: shape + cta.url', () => {
  const p = drinkPlanNudgeParts({
    clientFirstName: 'Morgan',
    eventTypeLabel: 'anniversary',
    eventDateDisplay: 'March 3',
    plannerUrl: 'https://drbartender.com/plan/tok',
    phone: '312-555-0100',
  });
  assertPartsShape(p);
  assert.equal(p.cta.url, 'https://drbartender.com/plan/tok');
  assert.equal(p.cta.label, 'Open the Potion Planner');
  assert.ok(p.bodyText.includes('312-555-0100'), 'phone line included when phone provided');
});

test('drinkPlanNudgeParts: Cal.com consult line gated on CAL_BOOKING_URL', () => {
  const args = {
    clientFirstName: 'Morgan',
    eventTypeLabel: 'anniversary',
    eventDateDisplay: 'March 3',
    plannerUrl: 'https://drbartender.com/plan/tok',
  };
  const prev = process.env.CAL_BOOKING_URL;
  try {
    delete process.env.CAL_BOOKING_URL;
    const without = drinkPlanNudgeParts(args);
    assert.ok(!without.bodyText.includes('phone consult'), 'no consult line when unset');

    process.env.CAL_BOOKING_URL = 'https://cal.com/drbartender/consult';
    const withCal = drinkPlanNudgeParts(args);
    assert.ok(withCal.bodyText.includes('https://cal.com/drbartender/consult'), 'consult line when set');
  } finally {
    if (prev === undefined) delete process.env.CAL_BOOKING_URL;
    else process.env.CAL_BOOKING_URL = prev;
  }
});

// ─── consultRecapParts ──────────────────────────────────────────────
test('consultRecapParts: shape, cta null, drink name in bodyText, next-step conditional', () => {
  const p = consultRecapParts({
    clientName: 'Jamie',
    eventTypeLabel: 'retirement party',
    formattedEventDate: 'April 10',
    drinkRecapLines: ['Old Fashioned (bourbon)', 'Paloma (tequila)'],
    nextStepLine: "We'll send your shopping list shortly.",
  });
  assertPartsShape(p);
  assert.equal(p.cta, null, 'no CTA button on the consult recap');
  assert.ok(p.bodyText.includes('Old Fashioned (bourbon)'), 'provided drink name present');
  assert.ok(p.bodyText.includes("We'll send your shopping list shortly."), 'next-step line present');
});

test('consultRecapParts: empty recap falls back gracefully', () => {
  const p = consultRecapParts({
    clientName: 'Jamie',
    eventTypeLabel: 'retirement party',
    drinkRecapLines: [],
  });
  assertPartsShape(p);
  assert.equal(p.cta, null);
});

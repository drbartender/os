const test = require('node:test');
const assert = require('node:assert/strict');
const { validateManifest, resolveAddons, SUPPRESSED_TYPES } = require('./cc-transfer-events');

const okEvent = (over = {}) => ({
  cc_id: '111111', client_email: 'ada@example.com', client_name: 'Ada Lovelace',
  event_date: '2026-08-01', start_time: '17:00', duration_hours: 4,
  package: 'The Core Reaction', addons: [], guest_count: 100,
  venue: { name: 'The Rookery', city: 'Chicago', state: 'IL' },
  event_type: 'wedding', total: 450, external_paid: 100, balance_due_date: '2026-07-18',
  ...over,
});

test('validateManifest passes a clean manifest and returns the events', () => {
  const events = validateManifest({ events: [okEvent(), okEvent({ cc_id: '222222' })] });
  assert.equal(events.length, 2);
});

test('validateManifest rejects the money and shape traps', () => {
  assert.throws(() => validateManifest({ events: [] }), /missing or empty/);
  assert.throws(() => validateManifest({ events: [okEvent(), okEvent()] }), /duplicate cc_id/);
  assert.throws(() => validateManifest({ events: [okEvent({ external_paid: 500 })] }), /exceeds total/);
  assert.throws(() => validateManifest({ events: [okEvent({ total: 0 })] }), /total must be > 0/);
  assert.throws(() => validateManifest({ events: [okEvent({ event_date: '08-01-2026' })] }), /YYYY-MM-DD/);
  assert.throws(() => validateManifest({ events: [okEvent({ guest_count: 0 })] }), /guest_count/);
  assert.throws(() => validateManifest({ events: [okEvent({ client_email: 'nope' })] }), /client_email/);
  assert.throws(() => validateManifest({ events: [okEvent({ addons: [{ slug: 'x', quantity: 0 }] })] }), /quantity/);
  assert.throws(() => validateManifest({ events: [okEvent({ balance_due_date: '' })] }), /balance_due_date/);
});

test('validateManifest allows zero external_paid (Jayme) and paid-in-full (Amy)', () => {
  assert.equal(validateManifest({ events: [okEvent({ external_paid: 0 })] }).length, 1);
  assert.equal(validateManifest({ events: [okEvent({ external_paid: 450 })] }).length, 1);
});

test('resolveAddons maps slugs to catalog rows with quantities', () => {
  const catalog = [
    { id: 1753, slug: 'additional-bartender', name: 'Additional Bartender', is_active: true },
    { id: 12, slug: 'soft-drink-addon', name: 'Soft Drink Add-On', is_active: true },
  ];
  const { selected } = resolveAddons(
    okEvent({ addons: [{ slug: 'additional-bartender', quantity: 7 }] }), catalog
  );
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, 1753);
  assert.equal(selected[0].quantity, 7);
});

test('resolveAddons throws loudly on an unknown slug', () => {
  assert.throws(
    () => resolveAddons(okEvent({ addons: [{ slug: 'not-a-thing', quantity: 1 }] }), []),
    /not in active catalog: not-a-thing/
  );
});

test('suppressed types are exactly the T-21 drink-plan nudges', () => {
  assert.deepEqual(SUPPRESSED_TYPES, ['drink_plan_nudge', 'drink_plan_nudge_sms']);
});

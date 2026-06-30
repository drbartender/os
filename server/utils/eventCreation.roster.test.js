'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { deriveStaffingRoster, loadStaffingAddons } = require('./eventCreation');

test('roster = bartenders (+ additional-bartender addon) then servers then barbacks', () => {
  const proposal = { num_bartenders: 2, event_duration_hours: 5 };
  const addons = [
    { slug: 'additional-bartender', quantity: 5 }, // 5 / 5 = 1
    { slug: 'banquet-server', quantity: 5 },        // 5 / max(5,4)=5 = 1
    { slug: 'barback', quantity: 10 },              // 10 / 5 = 2
  ];
  assert.deepEqual(
    deriveStaffingRoster(proposal, addons),
    ['Bartender', 'Bartender', 'Bartender', 'Banquet Server', 'Barback', 'Barback'],
  );
});

test('sub-4h event: additional-bartender / durationHours, server / max(dur,4)', () => {
  const proposal = { num_bartenders: 1, event_duration_hours: 2 };
  const addons = [
    { slug: 'additional-bartender', quantity: 2 }, // 2 / 2 = 1 (NOT / 4)
    { slug: 'banquet-server', quantity: 4 },        // stored max(2,4)=4 -> 4 / 4 = 1
  ];
  assert.deepEqual(
    deriveStaffingRoster(proposal, addons),
    ['Bartender', 'Bartender', 'Banquet Server'],
  );
});

test('class $0: counts derive from quantity regardless of price', () => {
  assert.deepEqual(
    deriveStaffingRoster({ num_bartenders: 1, event_duration_hours: 4 }, [{ slug: 'barback', quantity: 4 }]),
    ['Bartender', 'Barback'],
  );
});

test('no addons -> num_bartenders only; default 1', () => {
  assert.deepEqual(deriveStaffingRoster({ num_bartenders: 3 }, []), ['Bartender', 'Bartender', 'Bartender']);
  assert.deepEqual(deriveStaffingRoster({}, []), ['Bartender']);
});

test('loadStaffingAddons reads snapshot.addons first (no db hit)', async () => {
  const proposal = { id: 1, pricing_snapshot: { addons: [{ slug: 'banquet-server', quantity: 5 }] } };
  const db = { query: async () => { throw new Error('should not hit db'); } };
  assert.deepEqual(await loadStaffingAddons(proposal, db), [{ slug: 'banquet-server', quantity: 5 }]);
});

test('loadStaffingAddons join fallback recovers slug from addon_name when addon_id is NULL', async () => {
  const proposal = { id: 7, pricing_snapshot: {} }; // no addons[]
  const db = {
    query: async () => ({
      rows: [
        { slug: null, quantity: 5, addon_name: 'Banquet Server' },
        { slug: 'barback', quantity: 8, addon_name: 'Barback' },
      ],
    }),
  };
  assert.deepEqual(
    await loadStaffingAddons(proposal, db),
    [{ slug: 'banquet-server', quantity: 5 }, { slug: 'barback', quantity: 8 }],
  );
});

test('loadStaffingAddons tolerates a malformed snapshot string (falls to join)', async () => {
  const proposal = { id: 9, pricing_snapshot: 'not json' };
  const db = { query: async () => ({ rows: [] }) };
  assert.deepEqual(await loadStaffingAddons(proposal, db), []);
});

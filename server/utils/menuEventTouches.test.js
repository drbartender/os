process.env.NODE_ENV = 'test';
// server/utils/menuEventTouches.test.js
// PURE unit tests, no DB and no provider (spec 2026-10-19 section 9.4, table T;
// plan lane menu-house-card). Every event type id, a stored label, a custom
// type, no type, and a holiday party in December and in November, the date
// read as text.
//   node --test server/utils/menuEventTouches.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { touchSetFor, touchSetByKey, PLAIN_KEY, TOUCH_KEYS } = require('./menuEventTouches');
const { EVENT_TYPES } = require('./eventTypes');

// Table T by event type id: the touch set each takes (Dallas's two rows, the
// birthday and the December holiday, as sketched; the rest Claude's call).
const TABLE_T = {
  'birthday-party': 'balloons',
  'milestone-birthday': 'balloons',
  'wedding-reception': 'florals',
  'rehearsal-dinner': 'florals',
  'engagement-party': 'florals',
  'bridal-shower': 'florals',
  anniversary: 'florals',
  'bachelor-bachelorette': 'champagne',
  'graduation-party': 'graduation',
  'retirement-party': 'retirement',
  'baby-shower': 'baby',
  'corporate-event': 'sparkle',
  'corporate-happy-hour': 'sparkle',
  'fundraiser-gala': 'sparkle',
  'cocktail-party': 'confetti',
  'private-party': 'confetti',
  'dinner-party': 'confetti',
  housewarming: 'confetti',
  'block-party': 'bistro-lights',
  'festival-outdoor': 'bistro-lights',
  'cocktail-class': 'bar-tools',
  'celebration-of-life': PLAIN_KEY,
  other: PLAIN_KEY,
};
const ZONES = {
  balloons: ['top corners', 'top band', 'side margins'],
  holiday: ['top corners', 'bottom corners', 'top band'],
  florals: ['top corners', 'top band'],
  champagne: ['top corners', 'top band'],
  graduation: ['top corners', 'top band'],
  retirement: ['top corners'],
  baby: ['top corners'],
  sparkle: ['top corners'],
  confetti: ['top corners'],
  'bistro-lights': ['top band'],
  'bar-tools': ['top corners'],
};

const shape = (set) => Object.keys(set).sort();

test('every event type id in table T takes its touch set; holiday-party is tested by its date', () => {
  const ids = EVENT_TYPES.map((t) => t.id).filter((id) => id !== 'holiday-party');
  assert.deepEqual([...ids].sort(), Object.keys(TABLE_T).sort(), 'table T covers every event type id but the holiday');
  for (const id of ids) {
    const set = touchSetFor({ event_type: id, event_type_custom: null, event_date: '2027-06-19' });
    assert.equal(set.key, TABLE_T[id], id);
    assert.deepEqual(shape(set), ['bottomCorners', 'description', 'key', 'label', 'occasion', 'plain', 'zones'], id);
    if (set.key === PLAIN_KEY) {
      assert.deepEqual([set.plain, set.zones, set.bottomCorners, set.description], [true, [], false, ''], id);
    } else {
      assert.equal(set.plain, false, id);
      assert.deepEqual(set.zones, ZONES[set.key], id);
      assert.equal(set.bottomCorners, false, `${id}: only the December holiday uses the bottom corners`);
      assert.ok(set.description.length > 20, id);
    }
  }
});

test('the birthday set is the sketch: balloons in the top corners, streamers toward the title, confetti down the sides', () => {
  const set = touchSetFor({ event_type: 'birthday-party' });
  assert.match(set.description, /balloons in each top corner/);
  assert.match(set.description, /streamers/);
  assert.match(set.description, /confetti/);
  assert.equal(set.bottomCorners, false);
});

test('a holiday party in December draws gifts low and centres the footer; in November it is the plain card', () => {
  const dec = touchSetFor({ event_type: 'holiday-party', event_date: '2026-12-18' });
  assert.equal(dec.key, 'holiday');
  assert.equal(dec.plain, false);
  assert.equal(dec.bottomCorners, true);
  assert.deepEqual(dec.zones, ZONES.holiday);
  assert.match(dec.description, /gift boxes stacked in each bottom corner/);
  for (const date of ['2026-11-30', '2027-01-01', '2026-12', '', null, undefined]) {
    const set = touchSetFor({ event_type: 'holiday-party', event_date: date });
    assert.equal(set.key, PLAIN_KEY, String(date));
    assert.equal(set.bottomCorners, false, String(date));
  }
});

test('the December test reads the month from the text, never from a JS Date (a Date is no December)', () => {
  // A local-midnight Date on a GMT host would shift a day (spec 8.2); a Date is not read at all.
  assert.equal(touchSetFor({ event_type: 'holiday-party', event_date: new Date(2026, 11, 18) }).key, PLAIN_KEY);
  assert.equal(touchSetFor({ event_type: 'holiday-party', event_date: '2026-12-01' }).key, 'holiday');
  assert.equal(touchSetFor({ event_type: 'holiday-party', event_date: '2026-12-31' }).key, 'holiday');
  assert.equal(touchSetFor({ event_type: 'holiday-party', event_date: '12-2026-01' }).key, PLAIN_KEY);
});

test('a stored label matches as getEventTypeLabel does, so a legacy row still gets its touches', () => {
  assert.equal(touchSetFor({ event_type: 'Birthday Party' }).key, 'balloons');
  assert.equal(touchSetFor({ event_type: 'Bachelor / Bachelorette Party' }).key, 'champagne');
  assert.equal(touchSetFor({ event_type: 'Holiday Party', event_date: '2026-12-05' }).key, 'holiday');
  assert.equal(touchSetFor({ event_type: 'Other' }).key, PLAIN_KEY);
  assert.equal(touchSetFor({ event_type: 'birthday party' }).key, PLAIN_KEY, 'no fuzzy match: the label exactly');
});

test('a custom event type, an unknown type and no type are the plain card', () => {
  assert.equal(touchSetFor({ event_type: 'birthday-party', event_type_custom: 'Dog adoption day' }).key, PLAIN_KEY);
  assert.equal(touchSetFor({ event_type: 'quinceanera' }).key, PLAIN_KEY);
  for (const none of [{}, { event_type: null }, { event_type: '' }, null, undefined]) {
    assert.equal(touchSetFor(none).key, PLAIN_KEY, JSON.stringify(none));
  }
});

test('touchSetByKey reads a stored key back to its set; an unknown or missing key is the plain card', () => {
  for (const key of TOUCH_KEYS) assert.equal(touchSetByKey(key).key, key);
  assert.ok(TOUCH_KEYS.includes(PLAIN_KEY));
  assert.deepEqual(touchSetByKey('holiday'), touchSetFor({ event_type: 'holiday-party', event_date: '2026-12-18' }));
  for (const bad of ['nope', '', null, undefined, 42, { key: 'balloons' }]) assert.equal(touchSetByKey(bad).key, PLAIN_KEY);
});

test('a set handed out is a copy: changing it never changes the table', () => {
  const set = touchSetFor({ event_type: 'birthday-party' });
  set.zones.push('everywhere');
  set.description = 'x';
  const again = touchSetFor({ event_type: 'birthday-party' });
  assert.deepEqual(again.zones, ZONES.balloons);
  assert.notEqual(again.description, 'x');
});

test('no set names a client field: the descriptions and labels are fixed text with no date', () => {
  for (const key of TOUCH_KEYS) {
    const set = touchSetByKey(key);
    assert.doesNotMatch(`${set.description} ${set.label} ${set.occasion}`, /\d{4}|\d{1,2}\/\d{1,2}/, key);
    assert.ok(!`${set.description} ${set.label} ${set.occasion}`.includes(String.fromCharCode(8212)), `${key}: no em dash`);
  }
});

// The house card's event touches: table T, which small decorations an event's
// type and date put in the house card's background, where they sit, and
// whether the footer centres (spec 2026-10-19 section 9.4). Pure.
//
// touchSetFor({ event_type, event_type_custom, event_date }) -> { key, label,
//   occasion, description, zones, bottomCorners, plain }: a fresh copy, so a
//   caller can never change the table.
//   - event_type matches by id or by label, exactly as getEventTypeLabel does
//     (server/utils/eventTypes.js), so a legacy row that stores the label
//     still gets its touches. Any event_type_custom (what getEventTypeLabel
//     prints first), 'other', an unknown type and no type are the plain card.
//   - A holiday party takes the holiday set only in December, read from the
//     event_date TEXT (YYYY-MM-DD; spec 8.2, the query selects
//     event_date::text). A JS Date is never read, since a local-midnight Date
//     shifts a day on a GMT host; anything but the text is no December.
// touchSetByKey(key) -> the set a stored content.touch_key names (a re-roll
//   keeps the set Generate chose; Start over reads the event again), the
//   plain card for an unknown or missing key.
// PLAIN_KEY ('plain'): the set with no touches. A plain card draws no
//   background, so it spends no image (spec 9.2); layoutPieceKeys reads it.
//
// Where the date goes: only into the December test here. The prompt
// (menuArtImagePrompts.houseBackgroundPrompt) gets the set's fixed text, never
// the event's date, type label or anything the client wrote. label is the
// Design tab's Background row name (content.background_label); occasion names
// the kind of event in the prompt, in fixed words.
// "Small, nothing too dramatic" (decision 12) is the bar: every touch sits in
// its zones and the drink names stay clear.

const { EVENT_TYPES } = require('./eventTypes');

const PLAIN_KEY = 'plain';
const ZONE = Object.freeze({
  topCorners: 'top corners', topBand: 'top band', sideMargins: 'side margins', bottomCorners: 'bottom corners',
});

// Table T. Keys are stored as content.touch_key, so they never change.
const SETS = Object.freeze({
  balloons: {
    label: 'Balloons and streamers', occasion: 'a birthday',
    description: 'four or five balloons in each top corner, gathered with a bow; streamers curling in toward the title; '
      + 'confetti across the band above the title and drifting down the side margins',
    zones: [ZONE.topCorners, ZONE.topBand, ZONE.sideMargins],
  },
  holiday: {
    label: 'Gifts and holly', occasion: 'a December holiday party',
    description: 'gift boxes stacked in each bottom corner; holly sprigs in the top corners; ribbon curls toward the title; '
      + 'small gold stars and snow across the band above the title',
    zones: [ZONE.topCorners, ZONE.bottomCorners, ZONE.topBand], bottomCorners: true,
  },
  florals: {
    label: 'Florals and greenery', occasion: 'a wedding celebration',
    description: 'small white florals and greenery in the top corners; a few petals drifting toward the title',
    zones: [ZONE.topCorners, ZONE.topBand],
  },
  champagne: {
    label: 'Champagne and confetti', occasion: 'a bachelor or bachelorette party',
    description: 'a popping champagne bottle in each top corner; gold confetti toward the title',
    zones: [ZONE.topCorners, ZONE.topBand],
  },
  graduation: {
    label: 'Grad caps and diplomas', occasion: 'a graduation party',
    description: 'a grad cap and a rolled diploma in each top corner; confetti toward the title',
    zones: [ZONE.topCorners, ZONE.topBand],
  },
  retirement: {
    label: 'Gold streamers', occasion: 'a retirement party',
    description: 'gold streamers and confetti in the top corners',
    zones: [ZONE.topCorners],
  },
  baby: {
    label: 'Pastel balloons', occasion: 'a baby shower',
    description: 'a few soft pastel balloons and small stars in the top corners',
    zones: [ZONE.topCorners],
  },
  sparkle: {
    label: 'Gold sparkle', occasion: 'a corporate event',
    description: 'a little gold sparkle in the top corners, nothing else',
    zones: [ZONE.topCorners],
  },
  confetti: {
    label: 'Sparkle and confetti', occasion: 'a party',
    description: 'gold sparkle and a few confetti flecks in the top corners',
    zones: [ZONE.topCorners],
  },
  'bistro-lights': {
    label: 'Bistro lights', occasion: 'an outdoor party',
    description: 'a string of bistro lights across the band above the title',
    zones: [ZONE.topBand],
  },
  'bar-tools': {
    label: 'Jigger and shaker', occasion: 'a cocktail class',
    description: 'a jigger and a shaker, small, in the top corners',
    zones: [ZONE.topCorners],
  },
  [PLAIN_KEY]: { label: 'Plain house card', occasion: '', description: '', zones: [] },
});
const TOUCH_KEYS = Object.freeze(Object.keys(SETS));

// Event type id -> touch key. holiday-party is decided by its date below; a
// type missing here (celebration-of-life, other) is the plain card.
const BY_TYPE = Object.freeze({
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
});

const DECEMBER = /^\d{4}-12-\d{2}$/;

function touchSetByKey(key) {
  const k = typeof key === 'string' && Object.prototype.hasOwnProperty.call(SETS, key) ? key : PLAIN_KEY;
  const set = SETS[k];
  return {
    key: k, label: set.label, occasion: set.occasion, description: set.description, zones: [...set.zones],
    bottomCorners: set.bottomCorners === true, plain: k === PLAIN_KEY,
  };
}

// The event type id a stored event_type names, by id or by label, or null.
function typeIdOf(eventType) {
  if (typeof eventType !== 'string' || !eventType) return null;
  const found = EVENT_TYPES.find((t) => t.id === eventType || t.label === eventType);
  return found ? found.id : null;
}

function touchSetFor(event) {
  const { event_type: type, event_type_custom: custom, event_date: date } = event || {};
  if (custom) return touchSetByKey(PLAIN_KEY);
  const id = typeIdOf(type);
  if (id === 'holiday-party') return touchSetByKey(typeof date === 'string' && DECEMBER.test(date) ? 'holiday' : PLAIN_KEY);
  return touchSetByKey(BY_TYPE[id] || PLAIN_KEY);
}

module.exports = { touchSetFor, touchSetByKey, PLAIN_KEY, TOUCH_KEYS };

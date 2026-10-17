process.env.NODE_ENV = 'test';
// server/utils/menuArtPrompts.test.js
// PURE unit tests, no DB and no provider (plan Task E2).
//   node --test server/utils/menuArtPrompts.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { wordsRequest, parseWords, MenuWordsInvalid, BRIEF_MAX } = require('./menuArtPrompts');
const {
  backgroundPrompt, drinkPrompt, BACKGROUND_EDGES, BACKGROUND_CALM_CENTER, BACKGROUND_NO_TEXT, BACKGROUND_STYLE_REF,
  DRINK_OPAQUE, DRINK_FRAME, DRINK_STYLE_REFS, DRINK_TRANSPARENT, DRINK_MAGENTA_KEY,
} = require('./menuArtImagePrompts');
const { normalizePlan } = require('./menuDrinkSource');
const { FONT_PAIRING_IDS } = require('./menuFontPairings');
const { validatePatch } = require('./menuDraftValidation');

const PII = {
  name: 'Marisol Quintero-Vance', email: 'marisol.qv@example.com', phone: '(555) 867-5309',
  venue: 'Larkspur Hall Ballroom', address: '1234 Wisteria Lane', date: '2027-06-19',
};
const PII_VALUES = Object.values(PII);

function catalogMaps() {
  const rows = [
    ['cocktail', 7, 'Old Fashioned', 'Bourbon, bitters and an orange twist.', ['Bourbon', 'Angostura bitters']],
    ['cocktail', 9, 'Garden Gimlet', '', ['Gin', 'Lime']],
    ['mocktail', 3, 'Berry Spritz', 'Berries, lime and soda.', ['Raspberry', 'Soda']],
  ];
  const catalogById = new Map(rows.map(([kind, id, name, description, ingredients]) => [
    `${kind}:${id}`, { kind, id, name, description, ingredients },
  ]));
  return { catalogById, candidates: [] };
}

// A plan row carrying every kind of client detail, on the row and in selections.
function planRow(brief = {}) {
  return {
    id: 41, client_name: PII.name, client_email: PII.email, event_date: PII.date, serving_type: 'full_bar',
    shopping_list_source: 'planner',
    selections: {
      signatureDrinks: ['7', '9'], mocktails: ['3'], customCocktails: ['Lavender Fizz'],
      menuTheme: 'Sage and blush garden party', drinkNaming: 'Name them after flowers', menuDesignNotes: 'Soft watercolor',
      clientName: PII.name, clientEmail: PII.email, clientPhone: PII.phone, venueName: PII.venue,
      venueAddress: PII.address, eventDate: PII.date, beerFromFullBar: ['IPA'], wineFromFullBar: ['Red'],
      ...brief,
    },
  };
}

const normalized = (brief) => normalizePlan(planRow(brief), catalogMaps());

function modelAnswer(norm, over = {}) {
  return {
    title: 'Bar Menu',
    drinks: norm.drinks.map((d) => ({
      key: d.key, display_name: d.name, name_ai_suggested: false, description: null, visual_note: 'coupe, pale pink, mint sprig',
    })),
    font_pairing: 'elegant-script',
    palette: [{ name: 'sage', hex: '#9CAF88' }, { name: 'blush', hex: '#f4c2c2' }],
    accent_color: '#9CAF88',
    background_label: 'Pastel garden',
    ...over,
  };
}

function refuses(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof MenuWordsInvalid, `expected MenuWordsInvalid, got ${err && err.name}`);
    assert.equal(err.code, code);
    assert.equal(typeof err.reason, 'string');
    assert.equal(err.descriptor.errorClass, 'MenuWordsInvalid');
    return true;
  });
}

// ---- the words request ----

test('the user payload carries none of the client name, email, phone, venue, address or event date', () => {
  const norm = normalized();
  // Even a caller that spreads extra fields onto the plan and its drinks
  // cannot leak them: the payload is built from listed fields only.
  const polluted = {
    ...norm, client_name: PII.name, venue: PII.venue, event_date: PII.date,
    brief: { ...norm.brief, email: PII.email, phone: PII.phone },
    drinks: norm.drinks.map((d) => ({ ...d, client_email: PII.email, address: PII.address })),
  };
  for (const n of [norm, polluted]) {
    const { system, user, schema } = wordsRequest({ normalized: n, eventTypeLabel: 'Wedding' });
    const all = `${system}\n${user}\n${JSON.stringify(schema)}`;
    for (const value of PII_VALUES) assert.ok(!all.includes(value), `payload leaked ${value}`);
    const sent = JSON.parse(user);
    assert.deepEqual(Object.keys(sent).sort(), ['brief', 'drinks', 'event_type']);
    assert.deepEqual(Object.keys(sent.brief).sort(), ['design_notes', 'drink_naming', 'theme']);
    for (const d of sent.drinks) {
      assert.deepEqual(Object.keys(d).sort(), ['catalog_description', 'ingredients', 'key', 'kind', 'menu_section', 'name', 'needs_description']);
    }
  }
});

test('the payload names each drink with its key, kind, catalog text and whether it needs a description', () => {
  const { user } = wordsRequest({ normalized: normalized(), eventTypeLabel: 'Wedding' });
  const sent = JSON.parse(user);
  assert.equal(sent.event_type, 'Wedding');
  const byKey = Object.fromEntries(sent.drinks.map((d) => [d.key, d]));
  assert.equal(byKey['cocktail:7'].catalog_description, 'Bourbon, bitters and an orange twist.');
  assert.equal(byKey['cocktail:7'].needs_description, false);
  assert.equal(byKey['cocktail:9'].needs_description, true, 'an empty catalog description needs one');
  assert.equal(byKey['custom:lavender-fizz'].kind, 'client-typed');
  assert.equal(byKey['custom:lavender-fizz'].needs_description, true);
  assert.equal(byKey['mocktail:3'].menu_section, 'mocktails');
});

test('each brief field is cut to 1,000 characters (a 3,000-character theme does not blow up the prompt)', () => {
  const huge = (tag) => `${'a'.repeat(BRIEF_MAX - 3)}${tag}END${'b'.repeat(2000)}`;
  const norm = normalized({ menuTheme: huge('T'), drinkNaming: huge('N'), menuDesignNotes: huge('D') });
  const sent = JSON.parse(wordsRequest({ normalized: norm, eventTypeLabel: 'Birthday' }).user);
  for (const field of ['theme', 'drink_naming', 'design_notes']) {
    assert.equal(sent.brief[field].length, BRIEF_MAX, field);
    assert.ok(!sent.brief[field].includes('END'), `${field} kept text past the cut`);
  }
  const bg = backgroundPrompt({ brief: norm.brief, artDirection: 'x'.repeat(900) });
  assert.ok(!bg.includes('END'), 'the background prompt kept brief text past the cut');
  assert.ok(!bg.includes('x'.repeat(501)), 'art direction is capped at 500');
  // Theme and notes at 1,000 each, art direction at 500, and under 1,000 of
  // fixed clauses; uncut, these inputs alone run past 6,900 characters.
  assert.ok(bg.length < 2 * BRIEF_MAX + 500 + 1000, `background prompt is ${bg.length} characters`);
});

test('a cut never leaves half an emoji', () => {
  const theme = `${'a'.repeat(BRIEF_MAX - 1)}\u{1F379}tail`;
  const sent = JSON.parse(wordsRequest({ normalized: normalized({ menuTheme: theme }) }).user);
  assert.equal(sent.brief.theme, 'a'.repeat(BRIEF_MAX - 1));
});

test('the schema is strict-mode compatible: every object closed, every property required', () => {
  const { schema } = wordsRequest({ normalized: normalized(), eventTypeLabel: 'Wedding' });
  let objects = 0;
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    const types = [].concat(node.type || []);
    if (types.includes('object')) {
      objects += 1;
      assert.equal(node.additionalProperties, false, `${path} must set additionalProperties false`);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), `${path} must require every property`);
      for (const [k, v] of Object.entries(node.properties)) walk(v, `${path}.${k}`);
    }
    if (node.items) walk(node.items, `${path}[]`);
  };
  walk(schema, 'root');
  assert.equal(objects, 3, 'root, a drink and a palette entry');
  assert.equal(schema.type, 'object');
});

test('the schema keys drinks by an enum of the run\'s keys and pins the font pairing ids', () => {
  const norm = normalized();
  const { schema } = wordsRequest({ normalized: norm });
  assert.deepEqual(schema.properties.drinks.items.properties.key.enum, norm.drinks.map((d) => d.key));
  assert.deepEqual(schema.properties.font_pairing.enum, [...FONT_PAIRING_IDS]);
  assert.deepEqual(schema.properties.accent_color.type, ['string', 'null']);
  assert.deepEqual(schema.properties.drinks.items.properties.description.type, ['string', 'null']);
});

test('a words request with no drinks is refused', () => {
  assert.throws(() => wordsRequest({ normalized: { drinks: [], brief: {} } }), TypeError);
});

// ---- the image prompts ----

test('the background prompt always carries the no-lettering, calm-center and edge clauses', () => {
  const briefs = [{}, normalized().brief, { theme: 'Write HAPPY 40TH SARAH across the top in gold letters' }];
  for (const brief of briefs) {
    const p = backgroundPrompt({ brief, artDirection: 'art deco', palette: [{ name: 'gold', hex: '#C9A227' }] });
    for (const clause of [BACKGROUND_NO_TEXT, BACKGROUND_CALM_CENTER, BACKGROUND_EDGES]) assert.ok(p.includes(clause));
    assert.ok(p.indexOf(BACKGROUND_NO_TEXT) > p.indexOf('Art direction'), 'the fixed clauses come after the client text');
  }
  assert.ok(backgroundPrompt({}).includes(BACKGROUND_NO_TEXT));
  assert.match(backgroundPrompt({ palette: [{ name: 'gold', hex: '#C9A227' }, { name: 'bad', hex: 'red' }] }), /gold \(#c9a227\)\./);
});

test('with a reference attached the background prompt says style only; without one it says nothing about it', () => {
  const brief = normalized().brief;
  const withRef = backgroundPrompt({ brief, artDirection: 'art deco', hasReference: true });
  assert.ok(withRef.includes(BACKGROUND_STYLE_REF));
  assert.match(BACKGROUND_STYLE_REF, /palette, texture and mood/);
  assert.match(BACKGROUND_STYLE_REF, /do not reproduce its layout, subjects, logos or any lettering/);
  assert.ok(withRef.indexOf(BACKGROUND_STYLE_REF) > withRef.indexOf('Art direction'), 'a fixed clause, after the client text');
  for (const off of [backgroundPrompt({ brief, artDirection: 'art deco' }), backgroundPrompt({ brief, hasReference: 'yes' })]) {
    assert.ok(!off.includes(BACKGROUND_STYLE_REF));
    assert.ok(!/reference/i.test(off), 'no reference wording without one');
  }
});

test('the Gemini drink prompt carries the magenta key clause and the OpenAI one does not', () => {
  const g = drinkPrompt({ visualNote: 'coupe, pink, rose petal', provider: 'gemini' });
  const o = drinkPrompt({ visualNote: 'coupe, pink, rose petal', provider: 'openai' });
  assert.ok(g.includes(DRINK_MAGENTA_KEY) && g.includes('#FF00FF'));
  assert.ok(!o.includes('#FF00FF') && !o.toLowerCase().includes('magenta'));
  assert.ok(o.includes(DRINK_TRANSPARENT) && !g.includes(DRINK_TRANSPARENT));
  for (const p of [g, o]) {
    for (const clause of [DRINK_OPAQUE, DRINK_FRAME, DRINK_STYLE_REFS]) assert.ok(p.includes(clause));
    assert.match(p, /opaque/);
    assert.match(p, /70%/);
    assert.ok(p.includes('coupe, pink, rose petal'));
  }
});

test('a re-roll note is appended and capped at 200; an unknown provider throws', () => {
  const p = drinkPrompt({ visualNote: 'highball', rerollNote: `more ice ${'z'.repeat(400)}`, provider: 'openai' });
  assert.match(p, /Change from the last version: more ice/);
  assert.ok(!p.includes('z'.repeat(200)));
  assert.ok(!drinkPrompt({ visualNote: 'highball', provider: 'openai' }).includes('Change from'));
  assert.throws(() => drinkPrompt({ visualNote: 'x', provider: 'dalle' }), TypeError);
  assert.throws(() => drinkPrompt({ visualNote: 'x' }), TypeError);
});

// ---- parseWords ----

test('parseWords returns the stored content shape, each drink with exactly the thirteen spec 6 fields', () => {
  const norm = normalized();
  const content = parseWords(modelAnswer(norm), norm);
  assert.deepEqual(Object.keys(content).sort(), [
    'accent_color', 'also_at_bar', 'background_label', 'drinks', 'font_pairing', 'headings', 'ink_color',
    'logo_badge', 'logo_mode', 'mark_color', 'palette', 'text_backing', 'title',
  ]);
  for (const d of content.drinks) {
    assert.deepEqual(Object.keys(d).sort(), [
      'added_by_sync', 'catalog_id', 'catalog_kind', 'description', 'description_ai_written', 'display_name',
      'group', 'has_art', 'hidden', 'key', 'name_ai_suggested', 'source', 'visual_note',
    ]);
  }
  assert.deepEqual(content.drinks.map((d) => d.key), norm.drinks.map((d) => d.key), 'plan order kept');
  assert.equal(content.title, 'Bar Menu');
  assert.equal(content.ink_color, null);
  assert.equal(content.accent_color, '#9caf88');
  assert.deepEqual(content.palette, [{ name: 'sage', hex: '#9caf88' }, { name: 'blush', hex: '#f4c2c2' }]);
  assert.deepEqual(content.also_at_bar, [{ label: 'Beer and Wine', text: 'IPA, Red.' }]);
  const mock = content.drinks.find((d) => d.key === 'mocktail:3');
  assert.equal(mock.group, 'mock');
  assert.equal(mock.catalog_kind, 'mocktail');
});

test('parseWords forces catalog descriptions back to the catalog text and writes only the missing ones', () => {
  const norm = normalized();
  const answer = modelAnswer(norm);
  for (const d of answer.drinks) d.description = `Model words for ${d.key}.`;
  const byKey = Object.fromEntries(parseWords(answer, norm).drinks.map((d) => [d.key, d]));
  assert.equal(byKey['cocktail:7'].description, 'Bourbon, bitters and an orange twist.');
  assert.equal(byKey['cocktail:7'].description_ai_written, false);
  assert.equal(byKey['mocktail:3'].description, 'Berries, lime and soda.');
  assert.equal(byKey['cocktail:9'].description, 'Model words for cocktail:9.', 'empty catalog text is AI-written');
  assert.equal(byKey['cocktail:9'].description_ai_written, true);
  assert.equal(byKey['custom:lavender-fizz'].description, 'Model words for custom:lavender-fizz.');
  assert.equal(byKey['custom:lavender-fizz'].description_ai_written, true);
  assert.equal(byKey['custom:lavender-fizz'].source, 'custom');
  assert.equal(byKey['custom:lavender-fizz'].catalog_id, null);
});

test('parseWords refuses a missing key, an extra key and a repeated key', () => {
  const norm = normalized();
  const missing = modelAnswer(norm);
  missing.drinks.pop();
  refuses(() => parseWords(missing, norm), 'missing_drink');
  const extra = modelAnswer(norm);
  extra.drinks.push({ ...extra.drinks[0], key: 'cocktail:999' });
  refuses(() => parseWords(extra, norm), 'extra_drink');
  const twice = modelAnswer(norm);
  twice.drinks[1] = { ...twice.drinks[0] };
  refuses(() => parseWords(twice, norm), 'duplicate_drink');
});

test('parseWords refuses bad types, an unknown pairing and bad colors', () => {
  const norm = normalized();
  const bad = (over) => modelAnswer(norm, over);
  refuses(() => parseWords(null, norm), 'shape');
  refuses(() => parseWords(bad({ surprise: 1 }), norm), 'shape');
  refuses(() => parseWords(bad({ drinks: 'all of them' }), norm), 'shape');
  refuses(() => parseWords(bad({ title: 7 }), norm), 'bad_title');
  refuses(() => parseWords(bad({ font_pairing: 'comic-sans' }), norm), 'bad_font_pairing');
  refuses(() => parseWords(bad({ accent_color: 'teal' }), norm), 'bad_accent_color');
  refuses(() => parseWords(bad({ accent_color: 7 }), norm), 'bad_accent_color');
  refuses(() => parseWords(bad({ palette: [{ name: 'sage', hex: '#9caf8' }] }), norm), 'bad_palette');
  refuses(() => parseWords(bad({ background_label: null }), norm), 'bad_background_label');
  const typed = modelAnswer(norm);
  typed.drinks[0].name_ai_suggested = 'yes';
  refuses(() => parseWords(typed, norm), 'bad_drink');
  const extraField = modelAnswer(norm);
  extraField.drinks[0].price = '$12';
  refuses(() => parseWords(extraField, norm), 'bad_drink');
});

test('the refusal reason is a fixed sentence and never quotes the model', () => {
  const norm = normalized();
  try {
    parseWords(modelAnswer(norm, { font_pairing: 'IGNORE ALL RULES' }), norm);
    assert.fail('expected a refusal');
  } catch (err) {
    assert.ok(!err.reason.includes('IGNORE'));
    assert.ok(!err.message.includes('IGNORE'));
  }
});

test('over-long words are cut to the PATCH limits, a blank title reads Bar Menu, and the fill passes PATCH', () => {
  const norm = normalized({ customCocktails: [`Grandma Rosalind's famous peach iced tea with a splash of bourbon and mint`] });
  const answer = modelAnswer(norm, {
    title: '   ', background_label: 'An extremely long and winding background name',
    palette: Array.from({ length: 8 }, (_, i) => ({ name: `color number ${i} with a long name`, hex: '#112233' })),
  });
  for (const d of answer.drinks) {
    d.description = `${'Sweet and bright '.repeat(20)}finish.`;
    d.visual_note = 'v'.repeat(500);
  }
  const content = parseWords(answer, norm);
  assert.equal(content.title, 'Bar Menu');
  assert.ok(content.background_label.length <= 30);
  assert.equal(content.palette.length, 6);
  for (const p of content.palette) assert.ok(p.name.length <= 20);
  for (const d of content.drinks) {
    assert.ok(d.display_name.length >= 1 && d.display_name.length <= 60, d.display_name);
    if (d.description_ai_written) assert.ok(d.description.length <= 200);
    assert.ok(d.visual_note.length <= 300);
  }
  // Every drink edited at once is still accepted by the draft PATCH.
  const stored = { content: { words_status: 'done', ...content }, inputs: {} };
  const edited = content.drinks.map((d) => ({ ...d, display_name: `${d.display_name.slice(0, 50)} x` }));
  const result = validatePatch({ stored, body: { version: 1, content: { drinks: edited, title: content.title } } });
  assert.equal(result.changed, true);
});

test('a name kept as given is never flagged AI-suggested; a blank one falls back to the drink name', () => {
  const norm = normalized();
  const answer = modelAnswer(norm);
  answer.drinks[0].name_ai_suggested = true; // the model's flag on an unchanged name
  answer.drinks[1].display_name = 'Rosewater Dream';
  answer.drinks[1].name_ai_suggested = true;
  answer.drinks[2].display_name = '  ';
  const drinks = parseWords(answer, norm).drinks;
  assert.equal(drinks[0].name_ai_suggested, false);
  assert.equal(drinks[1].display_name, 'Rosewater Dream');
  assert.equal(drinks[1].name_ai_suggested, true);
  assert.equal(drinks[2].display_name, norm.drinks[2].name);
  assert.equal(drinks[2].name_ai_suggested, false);
});

test('accent_color is taken from the returned palette, otherwise null (spec 5.3)', () => {
  const norm = normalized();
  const accent = (over) => parseWords(modelAnswer(norm, over), norm).accent_color;
  assert.equal(accent({ accent_color: ' #F4C2C2 ' }), '#f4c2c2', 'a palette hex, in any case, is kept lowercased');
  assert.equal(accent({ accent_color: '#123456' }), null, 'a well-formed hex outside the palette is dropped');
  assert.equal(accent({ accent_color: null }), null);
  assert.equal(accent({ palette: [], accent_color: '#9caf88' }), null, 'no palette, no accent');
  const seven = Array.from({ length: 7 }, (_, i) => ({ name: `c${i}`, hex: `#00000${i}` }));
  assert.equal(accent({ palette: seven, accent_color: '#000006' }), null, 'only the six colors kept count');
});

test('artKeys sets has_art to exactly the drinks the run has pieces for, whatever their plan order', () => {
  const norm = normalized();
  const keys = norm.drinks.map((d) => d.key);
  assert.ok(keys.length >= 3);
  const out = parseWords(modelAnswer(norm), norm, { artKeys: [keys[2], 'cocktail:not-on-this-plan'] }).drinks;
  assert.deepEqual(out.map((d) => d.has_art), keys.map((k) => k === keys[2]));
  const none = parseWords(modelAnswer(norm), norm, { artKeys: new Set() }).drinks;
  assert.ok(none.every((d) => d.has_art === false), 'an empty set: no art at all, not the first eight');
});

test('the first eight drinks get art by default; artSlots and addedBySync serve Update draft', () => {
  const ids = Array.from({ length: 10 }, (_, i) => String(100 + i));
  const catalogById = new Map(ids.map((id) => [`cocktail:${id}`, { kind: 'cocktail', id, name: `Drink ${id}`, description: 'Words.', ingredients: [] }]));
  const norm = normalizePlan({ shopping_list_source: 'planner', selections: { signatureDrinks: ids } }, { catalogById, candidates: [] });
  const art = parseWords(modelAnswer(norm), norm).drinks.map((d) => d.has_art);
  assert.deepEqual(art, [true, true, true, true, true, true, true, true, false, false]);
  const synced = parseWords(modelAnswer(norm), norm, { artSlots: 2, addedBySync: true }).drinks;
  assert.deepEqual(synced.map((d) => d.has_art), [true, true, false, false, false, false, false, false, false, false]);
  assert.ok(synced.every((d) => d.added_by_sync === true && d.hidden === false));
});

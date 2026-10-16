process.env.NODE_ENV = 'test';
// server/utils/menuDraftValidation.test.js
// PURE unit tests, no DB. One passing and one failing case per spec 7.1 row,
// the 4.5 drink limits, and "omitted keys untouched".
//   node --test server/utils/menuDraftValidation.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateGenerateInputs, validatePatch, validateRerollNote, validateImageModel, LIMITS,
} = require('./menuDraftValidation');
const { ValidationError } = require('./errors');

const str = (n, ch = 'a') => ch.repeat(n);

function drink(key, over = {}) {
  return {
    key, source: 'catalog', catalog_kind: 'cocktail', group: 'sig', catalog_id: Number(key.split(':')[1]) || null,
    display_name: `Drink ${key}`, description: 'Catalog words.', name_ai_suggested: false,
    description_ai_written: false, visual_note: 'coupe, amber, orange peel', hidden: false, has_art: true,
    added_by_sync: false, ...over,
  };
}

function storedDraft() {
  return {
    content: {
      words_status: 'done', words_error: null, words_heartbeat_at: '2026-10-16T12:00:00.000Z',
      title: 'Bar Menu',
      headings: { sig: 'Signature Cocktails', mock: 'Mocktails', more: 'More from the bar', also: 'Also at the bar' },
      drinks: [
        drink('cocktail:1', { display_name: 'Garden Gimlet', name_ai_suggested: true }),
        drink('cocktail:2'),
        drink('custom:lavender-fizz', {
          source: 'custom', catalog_kind: null, catalog_id: null, display_name: 'Lavender Fizz',
          description: 'Gin, lavender, lemon and soda.', name_ai_suggested: true, description_ai_written: true,
        }),
        drink('mocktail:3', { group: 'mock', catalog_kind: 'mocktail', added_by_sync: true }),
      ],
      also_at_bar: [{ label: 'Beer and Wine', text: 'IPA, Red.' }, { label: 'Spirits', text: 'Vodka.' }],
      palette: [{ name: 'sage', hex: '#9caf88' }],
      font_pairing: 'elegant-script', ink_color: null, accent_color: '#c9a227', text_backing: 'soft',
      logo_mode: 'above_title', logo_badge: false, mark_color: 'ink', background_label: 'Pastel garden',
    },
    inputs: {
      planner_image_role: 'logo', reference_key: 'menu-art/5/ref-abc.png', reference_source: 'upload',
      art_direction: 'watercolor', drb_mark: true, image_model: 'openai',
    },
  };
}

const patch = (body, stored = storedDraft()) => validatePatch({ stored, body: { version: 3, ...body } });
const content = (c, stored) => patch({ content: c }, stored).content;
const inputs = (i, stored) => patch({ inputs: i }, stored).inputs;

function fails(fn, field) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err && err.name}`);
    assert.equal(err.statusCode, 400);
    assert.ok(err.fieldErrors && typeof err.fieldErrors[field] === 'string',
      `expected fieldErrors.${field}, got ${JSON.stringify(err.fieldErrors)}`);
    assert.ok(!err.fieldErrors[field].includes(String.fromCharCode(8212)), 'no em dash in the message');
    return true;
  });
}

const drinksWith = (fn) => storedDraft().content.drinks.map((d, i) => fn({ ...d }, i));
const gen = (body, opts) => validateGenerateInputs({ image_model: 'openai', ...body }, opts);

// ---- art_direction: string, at most 500 ----
test('art_direction: 500 characters pass on Generate and PATCH', () => {
  assert.equal(gen({ art_direction: str(500) }).art_direction, str(500));
  assert.equal(inputs({ art_direction: str(500) }).art_direction, str(500));
});
test('art_direction: 501 characters or a non-string fail', () => {
  fails(() => gen({ art_direction: str(501) }), 'art_direction');
  fails(() => inputs({ art_direction: str(501) }), 'art_direction');
  fails(() => inputs({ art_direction: 7 }), 'art_direction');
});

// ---- image_model: openai | gemini, required on Generate, re-roll, Update draft ----
test('image_model: openai and gemini pass', () => {
  assert.equal(validateImageModel('openai'), 'openai');
  assert.equal(validateImageModel('gemini'), 'gemini');
  assert.equal(gen({ image_model: 'gemini' }).image_model, 'gemini');
});
test('image_model: missing or unknown fails', () => {
  fails(() => validateImageModel(undefined), 'image_model');
  fails(() => validateImageModel('dall-e'), 'image_model');
  fails(() => validateGenerateInputs({}), 'image_model');
  fails(() => gen({ image_model: 'GEMINI' }), 'image_model');
});

// ---- mark_color ----
test('mark_color: ink, accent and gold pass', () => {
  for (const v of ['ink', 'accent', 'gold']) assert.equal(content({ mark_color: v }).mark_color, v);
});
test('mark_color: anything else fails', () => fails(() => content({ mark_color: 'silver' }), 'mark_color'));

// ---- background_label: words-step output only ----
test('background_label: kept as the words step wrote it when the PATCH omits it', () => {
  assert.equal(content({ title: 'Garden Party' }).background_label, 'Pastel garden');
});
test('background_label: refused from PATCH', () => fails(() => content({ background_label: 'Navy' }), 'background_label'));

// ---- re-roll note: at most 200 ----
test('re-roll note: 200 characters pass, empty is null', () => {
  assert.equal(validateRerollNote(str(200)), str(200));
  assert.equal(validateRerollNote('  more gold  '), 'more gold');
  assert.equal(validateRerollNote(undefined), null);
  assert.equal(validateRerollNote('   '), null);
});
test('re-roll note: 201 characters or a non-string fail', () => {
  fails(() => validateRerollNote(str(201)), 'note');
  fails(() => validateRerollNote({ text: 'x' }), 'note');
});

// ---- planner_image_role ----
test('planner_image_role: logo, reference and ignore pass (Logo by default)', () => {
  assert.equal(gen({}).planner_image_role, 'logo');
  assert.equal(gen({ planner_image_role: 'ignore' }).planner_image_role, 'ignore');
  assert.equal(gen({ planner_image_role: 'reference', reference_source: 'planner' }).planner_image_role, 'reference');
  assert.equal(inputs({ planner_image_role: 'ignore', reference_source: 'none' }).planner_image_role, 'ignore');
});
test('planner_image_role: anything else fails', () => {
  fails(() => gen({ planner_image_role: 'banner' }), 'planner_image_role');
  fails(() => inputs({ planner_image_role: 'banner' }), 'planner_image_role');
});

// ---- reference_source ----
test('reference_source on Generate: upload with a file, or keeping the stored upload, passes', () => {
  assert.equal(gen({ reference_source: 'upload' }, { hasFile: true }).reference_source, 'upload');
  const stored = storedDraft().inputs;
  assert.equal(gen({ reference_source: 'upload' }, { storedInputs: stored }).reference_source, 'upload');
  assert.equal(gen({}).reference_source, 'none');
});
test('reference_source on Generate: upload with nothing to upload, or a file with another source, fails', () => {
  fails(() => gen({ reference_source: 'upload' }), 'reference_source');
  fails(() => gen({ reference_source: 'upload' }, { storedInputs: { reference_source: 'none', reference_key: null } }), 'reference_source');
  fails(() => gen({ reference_source: 'none' }, { hasFile: true }), 'reference_source');
  fails(() => gen({ reference_source: 'url' }), 'reference_source');
});
test('reference_source on PATCH: none, or planner when the role is reference, passes', () => {
  assert.equal(inputs({ reference_source: 'none' }).reference_source, 'none');
  const next = inputs({ planner_image_role: 'reference', reference_source: 'planner' });
  assert.equal(next.reference_source, 'planner');
  assert.equal(next.planner_image_role, 'reference');
});
test('reference_source on PATCH: upload, or planner without the reference role, fails', () => {
  fails(() => inputs({ reference_source: 'upload' }), 'reference_source');
  fails(() => inputs({ reference_source: 'planner' }), 'reference_source');
  // The role and the source move together: Style ref means the client image is the reference.
  fails(() => inputs({ planner_image_role: 'reference' }), 'planner_image_role');
  const asRef = storedDraft();
  asRef.inputs.planner_image_role = 'reference';
  asRef.inputs.reference_source = 'planner';
  fails(() => inputs({ planner_image_role: 'logo' }, asRef), 'reference_source');
  assert.equal(inputs({ planner_image_role: 'logo', reference_source: 'none' }, asRef).reference_source, 'none');
});

// ---- reference_key and image_model in inputs: never from PATCH ----
test('reference_key and image_model: Generate records image_model; a PATCH leaves both as stored', () => {
  const g = gen({ image_model: 'gemini', art_direction: 'moody' });
  assert.deepEqual(g, {
    planner_image_role: 'logo', reference_source: 'none', art_direction: 'moody', drb_mark: true, image_model: 'gemini',
  });
  const next = inputs({ drb_mark: false });
  assert.equal(next.reference_key, 'menu-art/5/ref-abc.png');
  assert.equal(next.image_model, 'openai');
});
test('reference_key and image_model: refused from PATCH inputs (and reference_key from Generate)', () => {
  fails(() => inputs({ reference_key: 'w9/12_w9_x.png' }), 'reference_key');
  fails(() => inputs({ image_model: 'gemini' }), 'image_model');
  fails(() => gen({ reference_key: 'menu-art/5/ref-x.png' }), 'reference_key');
});

// ---- added_by_sync: Update draft and Generate only ----
test('added_by_sync: echoed unchanged in the drinks array passes and is kept', () => {
  const next = content({ drinks: drinksWith((d) => d) });
  assert.equal(next.drinks[3].added_by_sync, true);
  const omitted = content({ drinks: drinksWith(({ added_by_sync: _drop, ...d }) => d) });
  assert.equal(omitted.drinks[3].added_by_sync, true);
});
test('added_by_sync: changing it from PATCH fails', () => {
  fails(() => content({ drinks: drinksWith((d, i) => (i === 3 ? { ...d, added_by_sync: false } : d)) }), 'drinks');
  fails(() => content({ drinks: drinksWith((d, i) => (i === 0 ? { ...d, added_by_sync: true } : d)) }), 'drinks');
});

// ---- drb_mark: boolean ----
test('drb_mark: booleans pass; Generate takes multipart strings and defaults on', () => {
  assert.equal(inputs({ drb_mark: false }).drb_mark, false);
  assert.equal(gen({ drb_mark: 'false' }).drb_mark, false);
  assert.equal(gen({ drb_mark: 'true' }).drb_mark, true);
  assert.equal(gen({}).drb_mark, true);
});
test('drb_mark: a non-boolean fails', () => {
  fails(() => inputs({ drb_mark: 'true' }), 'drb_mark');
  fails(() => gen({ drb_mark: 'yes' }), 'drb_mark');
});

// ---- title: 1 to 60 ----
test('title: 1 and 60 characters pass, trimmed', () => {
  assert.equal(content({ title: '  Garden Party ' }).title, 'Garden Party');
  assert.equal(content({ title: str(60) }).title, str(60));
  assert.equal(content({ title: 'X' }).title, 'X');
});
test('title: empty, blank or 61 characters fail', () => {
  fails(() => content({ title: '' }), 'title');
  fails(() => content({ title: '   ' }), 'title');
  fails(() => content({ title: str(61) }), 'title');
  fails(() => content({ title: null }), 'title');
});

// ---- display_name: 1 to 60 ----
test('display_name: 60 characters pass', () => {
  const next = content({ drinks: drinksWith((d, i) => (i === 1 ? { ...d, display_name: str(60) } : d)) });
  assert.equal(next.drinks[1].display_name, str(60));
});
test('display_name: empty or 61 characters fail', () => {
  fails(() => content({ drinks: drinksWith((d, i) => (i === 1 ? { ...d, display_name: '' } : d)) }), 'drinks');
  fails(() => content({ drinks: drinksWith((d, i) => (i === 1 ? { ...d, display_name: str(61) } : d)) }), 'drinks');
});

// ---- description: 0 to 200 ----
test('description: empty and 200 characters pass', () => {
  const next = content({ drinks: drinksWith((d, i) => (i === 0 ? { ...d, description: '' } : i === 1 ? { ...d, description: str(200) } : d)) });
  assert.equal(next.drinks[0].description, '');
  assert.equal(next.drinks[1].description, str(200));
});
test('description: 201 characters fail', () => {
  fails(() => content({ drinks: drinksWith((d, i) => (i === 1 ? { ...d, description: str(201) } : d)) }), 'drinks');
});
test('a stored description over the limit (catalog text) passes when sent back unchanged', () => {
  const stored = storedDraft();
  stored.content.drinks[1].description = str(260);
  const next = content({ drinks: stored.content.drinks.map((d, i) => (i === 0 ? { ...d, hidden: true } : d)) }, stored);
  assert.equal(next.drinks[1].description, str(260));
  fails(() => content({ drinks: stored.content.drinks.map((d, i) => (i === 1 ? { ...d, description: str(261) } : d)) }, stored), 'drinks');
});

// ---- also_at_bar[].text: 0 to 120; the lines are fixed ----
test('also_at_bar text: empty and 120 characters pass', () => {
  const next = content({ also_at_bar: [{ label: 'Beer and Wine', text: '' }, { label: 'Spirits', text: str(120) }] });
  assert.deepEqual(next.also_at_bar, [{ label: 'Beer and Wine', text: '' }, { label: 'Spirits', text: str(120) }]);
});
test('also_at_bar text: 121 characters, or adding or removing a line, fail', () => {
  fails(() => content({ also_at_bar: [{ label: 'Beer and Wine', text: str(121) }, { label: 'Spirits', text: 'Vodka.' }] }), 'also_at_bar');
  fails(() => content({ also_at_bar: [{ label: 'Beer and Wine', text: 'IPA.' }] }), 'also_at_bar');
  fails(() => content({ also_at_bar: [...storedDraft().content.also_at_bar, { label: 'Wine', text: 'Rose.' }] }), 'also_at_bar');
  fails(() => content({ also_at_bar: [{ label: 'Beer and Wine', text: 'IPA.', hidden: true }, { label: 'Spirits', text: 'Vodka.' }] }), 'also_at_bar');
});

// ---- ink_color, accent_color: #rrggbb or null ----
test('ink_color and accent_color: #rrggbb (either case) or null pass', () => {
  const next = content({ ink_color: '#1A2b3C', accent_color: null });
  assert.equal(next.ink_color, '#1A2b3C');
  assert.equal(next.accent_color, null);
});
test('ink_color and accent_color: names, short hex or alpha hex fail', () => {
  fails(() => content({ ink_color: 'red' }), 'ink_color');
  fails(() => content({ accent_color: '#abc' }), 'accent_color');
  fails(() => content({ accent_color: '#aabbccdd' }), 'accent_color');
});

// ---- palette: words-step output only ----
test('palette: kept as the words step wrote it when the PATCH omits it', () => {
  assert.deepEqual(content({ title: 'Hi' }).palette, [{ name: 'sage', hex: '#9caf88' }]);
});
test('palette: refused from PATCH', () => fails(() => content({ palette: [] }), 'palette'));

// ---- headings: 1 to 40 each ----
test('headings: 1 to 40 characters each pass', () => {
  const h = { sig: str(40), mock: 'Zero proof', more: 'And more', also: 'Also' };
  assert.deepEqual(content({ headings: h }).headings, h);
});
test('headings: empty, 41 characters, or a missing or extra key fail', () => {
  const ok = storedDraft().content.headings;
  fails(() => content({ headings: { ...ok, sig: '' } }), 'headings');
  fails(() => content({ headings: { ...ok, mock: str(41) } }), 'headings');
  fails(() => content({ headings: { sig: 'A', mock: 'B', more: 'C' } }), 'headings');
  fails(() => content({ headings: { ...ok, extra: 'D' } }), 'headings');
});

// ---- also_at_bar[].label: 1 to 30 ----
test('also_at_bar label: 30 characters pass', () => {
  const next = content({ also_at_bar: [{ label: str(30), text: 'IPA, Red.' }, { label: 'Liquor', text: 'Vodka.' }] });
  assert.equal(next.also_at_bar[0].label, str(30));
  assert.equal(next.also_at_bar[1].label, 'Liquor');
});
test('also_at_bar label: empty or 31 characters fail', () => {
  fails(() => content({ also_at_bar: [{ label: '', text: 'IPA, Red.' }, { label: 'Spirits', text: 'Vodka.' }] }), 'also_at_bar');
  fails(() => content({ also_at_bar: [{ label: str(31), text: 'IPA, Red.' }, { label: 'Spirits', text: 'Vodka.' }] }), 'also_at_bar');
});

// ---- logo_badge: boolean ----
test('logo_badge: a boolean passes', () => assert.equal(content({ logo_badge: true }).logo_badge, true));
test('logo_badge: a non-boolean fails', () => fails(() => content({ logo_badge: 'yes' }), 'logo_badge'));

// ---- font_pairing: one of the fixed ids ----
test('font_pairing: a fixed id passes', () => assert.equal(content({ font_pairing: 'retro' }).font_pairing, 'retro'));
test('font_pairing: an unknown id fails', () => fails(() => content({ font_pairing: 'comic-sans' }), 'font_pairing'));

// ---- text_backing ----
test('text_backing: off, soft and panel pass', () => {
  for (const v of ['off', 'soft', 'panel']) assert.equal(content({ text_backing: v }).text_backing, v);
});
test('text_backing: anything else fails', () => fails(() => content({ text_backing: 'shadow' }), 'text_backing'));

// ---- logo_mode ----
test('logo_mode: above_title and replaces_title pass', () => {
  assert.equal(content({ logo_mode: 'replaces_title' }).logo_mode, 'replaces_title');
  assert.equal(content({ logo_mode: 'above_title' }).logo_mode, 'above_title');
});
test('logo_mode: anything else fails', () => fails(() => content({ logo_mode: 'below' }), 'logo_mode'));

// ---- drinks[]: the key set is fixed; only four fields change ----
test('drinks: the same key set in another order passes; the four editable fields change', () => {
  const sent = drinksWith((d, i) => (i === 2 ? { ...d, hidden: true, has_art: false } : d)).reverse();
  const next = content({ drinks: sent });
  assert.deepEqual(next.drinks.map((d) => d.key), ['mocktail:3', 'custom:lavender-fizz', 'cocktail:2', 'cocktail:1']);
  assert.equal(next.drinks[1].hidden, true);
  assert.equal(next.drinks[1].has_art, false);
});
test('drinks: adding, removing or repeating a key fails', () => {
  const base = drinksWith((d) => d);
  fails(() => content({ drinks: base.slice(1) }), 'drinks');
  fails(() => content({ drinks: [...base, drink('cocktail:9')] }), 'drinks');
  fails(() => content({ drinks: [...base.slice(1), base[1]] }), 'drinks');
  fails(() => content({ drinks: base.map((d, i) => (i === 0 ? { ...d, key: 'cocktail:99' } : d)) }), 'drinks');
});
test('drinks: changing any other field, or an unknown field, fails', () => {
  for (const [field, value] of [['group', 'mock'], ['source', 'custom'], ['catalog_id', 7], ['catalog_kind', 'mocktail'], ['visual_note', 'tiki mug'], ['price', 12]]) {
    fails(() => content({ drinks: drinksWith((d, i) => (i === 1 ? { ...d, [field]: value } : d)) }), 'drinks');
  }
  fails(() => content({ drinks: drinksWith((d, i) => (i === 1 ? { ...d, hidden: 'yes' } : d)) }), 'drinks');
});
test('drinks: editing a name or description sets its AI flag false; echoes keep it', () => {
  const next = content({
    drinks: drinksWith((d, i) => (i === 0 ? { ...d, display_name: 'Gimlet' } : i === 2 ? { ...d, description: 'Gin and lavender.' } : d)),
  });
  assert.equal(next.drinks[0].name_ai_suggested, false);
  assert.equal(next.drinks[2].description_ai_written, false);
  assert.equal(next.drinks[2].name_ai_suggested, true);
  // Sent back unchanged (even with stray spaces) is not an edit.
  const echo = content({ drinks: drinksWith((d, i) => (i === 0 ? { ...d, display_name: ' Garden Gimlet ' } : d)) });
  assert.equal(echo.drinks[0].name_ai_suggested, true);
  assert.equal(echo.drinks[0].display_name, 'Garden Gimlet');
});
test('drinks: an AI flag may be lowered by the client but never raised', () => {
  const lowered = content({ drinks: drinksWith((d, i) => (i === 0 ? { ...d, name_ai_suggested: false } : d)) });
  assert.equal(lowered.drinks[0].name_ai_suggested, false);
  fails(() => content({ drinks: drinksWith((d, i) => (i === 1 ? { ...d, name_ai_suggested: true } : d)) }), 'drinks');
});
test('drinks: a field the drafter stores later is fixed, round-trips, and never blocks an edit', () => {
  const stored = storedDraft();
  const extra = { typed_name: 'lavender fizz w/ gin', ingredients: [{ name: 'Gin', oz: 2 }, { name: 'Lavender syrup', oz: 0.75 }] };
  Object.assign(stored.content.drinks[2], extra);
  const before = structuredClone(stored);
  const sendWith = (fn) => before.content.drinks.map((d, i) => fn(structuredClone(d), i));
  // Echoed exactly: passes, nothing changed, the extra fields kept.
  const echo = patch({ content: { drinks: sendWith((d) => d) } }, stored);
  assert.equal(echo.changed, false);
  assert.deepEqual(echo.content.drinks[2], before.content.drinks[2]);
  // Renamed and hidden: saves, the extra fields ride along untouched.
  const edited = patch({ content: { drinks: sendWith((d, i) => (i === 2 ? { ...d, display_name: 'Lavender Spritz', hidden: true } : d)) } }, stored);
  assert.equal(edited.changed, true);
  assert.equal(edited.content.drinks[2].display_name, 'Lavender Spritz');
  assert.equal(edited.content.drinks[2].hidden, true);
  assert.equal(edited.content.drinks[2].name_ai_suggested, false);
  assert.equal(edited.content.drinks[2].typed_name, extra.typed_name);
  assert.deepEqual(edited.content.drinks[2].ingredients, extra.ingredients);
  // Left out of the sent drink: kept as stored.
  const omitted = content({ drinks: sendWith((d, i) => (i === 2 ? (({ typed_name: _t, ingredients: _g, ...rest }) => rest)(d) : d)) }, stored);
  assert.deepEqual(omitted.drinks[2].ingredients, extra.ingredients);
  assert.equal(omitted.drinks[2].typed_name, extra.typed_name);
  assert.deepEqual(stored, before);
  // Changing it, or sending it on a drink that never had it, is refused.
  fails(() => content({ drinks: sendWith((d, i) => (i === 2 ? { ...d, typed_name: 'lavender gin fizz' } : d)) }, stored), 'drinks');
  fails(() => content({ drinks: sendWith((d, i) => (i === 2 ? { ...d, ingredients: [{ name: 'Gin', oz: 2 }] } : d)) }, stored), 'drinks');
  fails(() => content({ drinks: sendWith((d, i) => (i === 2 ? { ...d, ingredients: null } : d)) }, stored), 'drinks');
  fails(() => content({ drinks: sendWith((d, i) => (i === 1 ? { ...d, typed_name: 'gimlet' } : d)) }, stored), 'drinks');
});
test('drinks: a changed added_by_sync keeps its own message', () => {
  assert.throws(() => content({ drinks: drinksWith((d, i) => (i === 3 ? { ...d, added_by_sync: false } : d)) }), (err) => {
    assert.equal(err.fieldErrors.drinks, 'New from plan is set by Update draft and cannot be edited.');
    return true;
  });
  assert.throws(() => content({ drinks: drinksWith((d, i) => (i === 1 ? { ...d, group: 'mock' } : d)) }), (err) => {
    assert.equal(err.fieldErrors.drinks, "Only a drink's name, description, Hide and art can change here.");
    return true;
  });
});

// ---- has_art: at most 8 visible drinks ----
function manyDrinks(n, artCount) {
  const stored = storedDraft();
  stored.content.drinks = Array.from({ length: n }, (_, i) => drink(`cocktail:${i + 1}`, { has_art: i < artCount }));
  return stored;
}
test('has_art: 8 visible drinks with art pass; hidden drinks do not count', () => {
  const stored = manyDrinks(10, 7);
  const eight = stored.content.drinks.map((d, i) => (i === 7 ? { ...d, has_art: true } : d));
  assert.equal(content({ drinks: eight }, stored).drinks.filter((d) => d.has_art).length, 8);
  const hiddenArt = stored.content.drinks.map((d, i) => (i >= 7 ? { ...d, has_art: true, hidden: i >= 8 } : d));
  assert.equal(content({ drinks: hiddenArt }, stored).drinks.filter((d) => d.has_art).length, 10);
});
test('has_art: a ninth visible drink with art fails', () => {
  const stored = manyDrinks(10, 8);
  fails(() => content({ drinks: stored.content.drinks.map((d, i) => (i === 8 ? { ...d, has_art: true } : d)) }, stored), 'drinks');
});

// ---- visible drinks: at most 12, at most 4 of them without art ----
test('visible drinks: 12 visible with 4 without art pass', () => {
  const stored = manyDrinks(13, 8);
  const next = content({ drinks: stored.content.drinks.map((d, i) => (i === 12 ? { ...d, hidden: true } : d)) }, stored);
  assert.equal(next.drinks.filter((d) => !d.hidden).length, 12);
  assert.equal(LIMITS.visible_drinks, 12);
});
test('visible drinks: a 13th, or a 5th without art, fails', () => {
  const twelve = manyDrinks(13, 8);
  twelve.content.drinks[12].hidden = true;
  fails(() => content({ drinks: twelve.content.drinks.map((d) => ({ ...d, hidden: false })) }, twelve), 'drinks');
  const tenWithArt = manyDrinks(10, 6);
  fails(() => content({ drinks: tenWithArt.content.drinks.map((d, i) => (i === 0 ? { ...d, has_art: false } : d)) }, tenWithArt), 'drinks');
});
test('visible drinks: a stored draft over the limits can be hidden down one drink at a time, never made worse', () => {
  const stored = manyDrinks(15, 8); // Generate on a 15-drink plan: 15 visible, 7 without art
  const hideOne = stored.content.drinks.map((d, i) => (i === 14 ? { ...d, hidden: true } : d));
  assert.equal(content({ drinks: hideOne }, stored).drinks.filter((d) => !d.hidden).length, 14);
  // A rename while over the limit still saves.
  const rename = stored.content.drinks.map((d, i) => (i === 0 ? { ...d, display_name: 'House Old Fashioned' } : d));
  assert.equal(content({ drinks: rename }, stored).drinks[0].display_name, 'House Old Fashioned');
  // Taking art off a drink adds a sixth... eighth drink without art: worse, refused.
  fails(() => content({ drinks: stored.content.drinks.map((d, i) => (i === 0 ? { ...d, has_art: false } : d)) }, stored), 'drinks');
});

// ---- the PATCH as a whole ----
test('omitted keys untouched: only the sent top-level keys change, and stored is not mutated', () => {
  const stored = storedDraft();
  const before = structuredClone(stored);
  const next = patch({ content: { title: 'Fall Formal' }, inputs: { drb_mark: false } }, stored);
  assert.deepEqual(next.content, { ...before.content, title: 'Fall Formal' });
  assert.deepEqual(next.inputs, { ...before.inputs, drb_mark: false });
  assert.deepEqual(stored, before);
  assert.equal(next.changed, true);
  // The returned objects are copies, never the stored ones.
  assert.notEqual(next.content.drinks, stored.content.drinks);
  assert.notEqual(next.inputs, stored.inputs);
});
test('only the sent sections come back, so the route writes only those columns', () => {
  const stored = storedDraft();
  const before = structuredClone(stored);
  // Inputs only: no content key at all, so the words fill is never written back.
  const inputsOnly = patch({ inputs: { art_direction: 'neon' } }, stored);
  assert.deepEqual(Object.keys(inputsOnly).sort(), ['changed', 'inputs']);
  assert.equal(Object.hasOwn(inputsOnly, 'content'), false);
  assert.deepEqual(inputsOnly.inputs, { ...before.inputs, art_direction: 'neon' });
  assert.equal(inputsOnly.changed, true);
  // Content only: no inputs key.
  const contentOnly = patch({ content: { mark_color: 'gold' } }, stored);
  assert.deepEqual(Object.keys(contentOnly).sort(), ['changed', 'content']);
  assert.equal(Object.hasOwn(contentOnly, 'inputs'), false);
  assert.deepEqual(contentOnly.content, { ...before.content, mark_color: 'gold' });
  assert.equal(contentOnly.changed, true);
  assert.deepEqual(stored, before);
});
test('a PATCH where every sent value equals the stored one passes with changed false', () => {
  const stored = storedDraft();
  const before = structuredClone(stored);
  const same = patch({
    content: {
      title: ' Bar Menu ', mark_color: 'ink', ink_color: null, headings: { ...before.content.headings },
      also_at_bar: before.content.also_at_bar.map((l) => ({ ...l })), drinks: drinksWith((d) => d),
    },
    inputs: { drb_mark: true, art_direction: 'watercolor', planner_image_role: 'logo' },
  }, stored);
  assert.equal(same.changed, false);
  // Both sent sections still come back, equal to the stored ones.
  assert.deepEqual(same.content, before.content);
  assert.deepEqual(same.inputs, before.inputs);
  assert.equal(patch({ inputs: { drb_mark: true } }, stored).changed, false);
  assert.equal(patch({ content: { drinks: drinksWith(({ added_by_sync: _drop, ...d }) => d) } }, stored).changed, false);
  // One real difference anywhere makes it a change: a value, a drink order, a lowered AI flag.
  assert.equal(patch({ content: { title: 'Bar Menu' }, inputs: { drb_mark: false } }, stored).changed, true);
  assert.equal(patch({ content: { drinks: drinksWith((d) => d).reverse() } }).changed, true);
  assert.equal(patch({ content: { drinks: drinksWith((d, i) => (i === 0 ? { ...d, name_ai_suggested: false } : d)) } }).changed, true);
  assert.deepEqual(stored, before);
  // A body that sends nothing is still refused.
  fails(() => patch({ content: {} }), 'content');
  fails(() => patch({ inputs: {} }), 'content');
});
test('the words status fields are refused, and content waits for the words to land', () => {
  for (const k of ['words_status', 'words_error', 'words_heartbeat_at']) fails(() => content({ [k]: 'done' }), k);
  const pending = storedDraft();
  pending.content.words_status = 'pending';
  fails(() => content({ title: 'Early' }, pending), 'content');
  // An inputs edit while the words are pending carries no content to write back.
  const next = patch({ inputs: { drb_mark: false } }, pending);
  assert.equal(next.inputs.drb_mark, false);
  assert.equal(Object.hasOwn(next, 'content'), false);
});
test('unknown keys, an empty PATCH and a missing version fail; all field errors come back together', () => {
  fails(() => content({ subtitle: 'x' }), 'subtitle');
  fails(() => inputs({ theme: 'x' }), 'theme');
  fails(() => patch({ content: {}, inputs: {} }), 'content');
  fails(() => patch({}), 'content');
  fails(() => patch({ content: { title: 'x' }, extra: 1 }), 'extra');
  fails(() => validatePatch({ stored: storedDraft(), body: { content: { title: 'x' } } }), 'version');
  fails(() => content({ ['__proto__']: 'x' }), '__proto__');
  assert.throws(() => content({ title: '', mark_color: 'silver', palette: [] }), (err) => {
    assert.deepEqual(Object.keys(err.fieldErrors).sort(), ['mark_color', 'palette', 'title']);
    return true;
  });
});

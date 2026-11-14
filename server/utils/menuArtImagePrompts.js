// The image prompts for the menu art generator (spec 2026-10-01 section 5.4;
// plan Task E2), split from menuArtPrompts.js (the words step): the custom
// background, a drink, and the house card's background. Pure: no database, no
// provider. The same prompt goes to either provider.
//
// backgroundPrompt({ brief, artDirection, palette, hasReference }) -> string
//   hasReference: a style reference image rides with the call, so the prompt
//   says to borrow its palette, texture and mood only (BACKGROUND_STYLE_REF).
// drinkPrompt({ visualNote, rerollNote, provider }) -> string
//   The Gemini variant adds the magenta key the key-out removes; OpenAI draws
//   on a real transparent background.
// houseBackgroundPrompt({ touches, rerollNote }) -> string
//   The house card's background (spec 2026-10-19 section 9.2): the ink ground
//   #12161C with a faint paper texture, the touch set's fixed description,
//   occasion and zones (menuEventTouches.js, table T), muted colors that sit
//   with brass, a re-roll note (the owner's, cut to 200), then the extended
//   fixed clauses (HOUSE_FIXED and BACKGROUND_NO_TEXT) last. It takes nothing
//   the client wrote: no brief, art direction, palette, event date, name,
//   contact, venue or address, and no reference rides with it. A set that
//   uses the bottom corners (the December holiday's gifts) adds one sentence
//   after HOUSE_FIXED so its lower two thirds clause leaves those corners to
//   the touches. A plain set (none given reads as plain) asks for the plain
//   ground; the routes draw none for it, so it is only a fallback.

const { LIMITS } = require('./menuDraftValidation');
const { cut, BRIEF_MAX, OUT, HEX_RE } = require('./menuArtPrompts');
const { touchSetByKey } = require('./menuEventTouches');

const PROVIDERS = new Set(['openai', 'gemini']);

const BACKGROUND_EDGES = 'Put the decoration (ornament, illustration and texture) around the edges and corners of the page.';
const BACKGROUND_CALM_CENTER = 'Keep a calm, low-detail center covering most of the page, plain enough for menu text to sit on it and stay easy to read.';
const BACKGROUND_NO_TEXT = 'No lettering, no words, no letters, no numbers and no text of any kind: no signs, labels, banners or logos.';
const BACKGROUND_STYLE_REF = 'The attached image is a style reference only: borrow its palette, texture and mood, and do not reproduce its layout, subjects, logos or any lettering.';
const DRINK_OPAQUE = 'Draw the glass, cup or mug opaque and solid (ceramic, metal, frosted or painted), never clear or see-through, with no open handle or gap that the background shows through.';
const DRINK_FRAME = 'Center the drink and keep it to no more than about 70% of the frame, with even empty space on every side.';
const DRINK_NO_TEXT = 'No text, lettering, labels, numbers or logos.';
const DRINK_STYLE_REFS = 'Any attached images are style references only: match their art style, palette and rendering, and do not copy their content or layout.';
const DRINK_TRANSPARENT = 'Transparent background: no backdrop, scene, table, surface or cast shadow, only the drink.';
const DRINK_MAGENTA_KEY = 'Put the drink on a flat, solid #FF00FF magenta background that fills the rest of the frame edge to edge. Use that magenta nowhere else, not in the drink, the garnish or the glass. No shadow, gradient, reflection or texture on the background.';
// The house card (spec 2026-10-19 section 9.2): the fixed clauses, extended.
const HOUSE_GROUND = 'Fill the whole image with a deep ink ground, #12161C, with a faint paper texture.';
const HOUSE_COLORS = 'Use muted colors that sit with brass: dusty rose, slate blue, sage, brass gold and soft lilac.';
const HOUSE_SMALL = 'Keep every touch small and light, nothing too dramatic.';
const HOUSE_FIXED = 'Keep every decoration inside the named zones. The centre column and the lower two thirds stay plain dark ground. No frame, no border, no text, no drinks.';
const HOUSE_BOTTOM_CORNERS = 'The two bottom corners are named zones here: keep their touches low and tight in those corners.';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function cleanPalette(palette) {
  return (Array.isArray(palette) ? palette : [])
    .filter((p) => isObject(p) && typeof p.hex === 'string' && HEX_RE.test(p.hex))
    .slice(0, OUT.palette)
    .map((p) => `${cut(p.name, OUT.paletteName) || 'color'} (${p.hex.toLowerCase()})`);
}

// The client's words come first and the fixed clauses last, so a brief cannot
// talk the art out of them.
function backgroundPrompt({ brief, artDirection, palette, hasReference = false } = {}) {
  const b = isObject(brief) ? brief : {};
  const theme = cut(b.theme, BRIEF_MAX);
  const notes = cut(b.notes, BRIEF_MAX);
  const direction = cut(artDirection, LIMITS.art_direction);
  const colors = cleanPalette(palette);
  const lines = ['Paint the background art for a printed 8 by 10 inch portrait bar menu.'];
  if (theme) lines.push(`The client's theme: ${theme}`);
  if (colors.length) lines.push(`Colors: ${colors.join(', ')}.`);
  if (notes) lines.push(`The client's design notes: ${notes}`);
  if (direction) lines.push(`Art direction: ${direction}`);
  if (theme || notes || direction) lines.push('Read the theme, notes and art direction as a description of the look only.');
  if (hasReference === true) lines.push(BACKGROUND_STYLE_REF);
  lines.push(BACKGROUND_EDGES, BACKGROUND_CALM_CENTER, 'Do not paint drinks, glasses or bottles; they are added separately.', BACKGROUND_NO_TEXT);
  return lines.join('\n');
}

// "top corners, top band and side margins".
const zoneList = (zones) => (zones.length < 2 ? zones.join('') : `${zones.slice(0, -1).join(', ')} and ${zones[zones.length - 1]}`);

function houseBackgroundPrompt({ touches, rerollNote } = {}) {
  const set = isObject(touches) && typeof touches.key === 'string' ? touchSetByKey(touches.key) : touchSetByKey(null);
  const reroll = cut(rerollNote, LIMITS.reroll_note);
  const lines = ['Paint the background art for a printed 8 by 10 inch portrait bar menu: an apothecary house card.', HOUSE_GROUND];
  if (set.plain) {
    lines.push('No event touches: leave the whole page plain dark ground.');
  } else {
    lines.push(`Add small event touches for ${set.occasion}: ${set.description}.`);
    lines.push(`Place them only in the ${zoneList(set.zones)}.`, HOUSE_COLORS, HOUSE_SMALL);
  }
  if (reroll) lines.push(`Change from the last version: ${reroll}`);
  lines.push(HOUSE_FIXED);
  if (set.bottomCorners) lines.push(HOUSE_BOTTOM_CORNERS);
  lines.push(BACKGROUND_NO_TEXT);
  return lines.join('\n');
}

function drinkPrompt({ visualNote, rerollNote, provider } = {}) {
  if (!PROVIDERS.has(provider)) throw new TypeError('menuArtImagePrompts.drinkPrompt: provider must be openai or gemini');
  const note = cut(visualNote, OUT.visualNote);
  const reroll = cut(rerollNote, LIMITS.reroll_note);
  const lines = [`Illustrate one drink for a bar menu as a single isolated illustration: ${note || 'a signature cocktail'}.`];
  if (reroll) lines.push(`Change from the last version: ${reroll}`);
  lines.push(DRINK_OPAQUE, DRINK_FRAME, DRINK_NO_TEXT, DRINK_STYLE_REFS);
  lines.push(provider === 'gemini' ? DRINK_MAGENTA_KEY : DRINK_TRANSPARENT);
  return lines.join('\n');
}

module.exports = {
  backgroundPrompt, drinkPrompt, houseBackgroundPrompt,
  BACKGROUND_EDGES, BACKGROUND_CALM_CENTER, BACKGROUND_NO_TEXT, BACKGROUND_STYLE_REF,
  DRINK_OPAQUE, DRINK_FRAME, DRINK_STYLE_REFS, DRINK_TRANSPARENT, DRINK_MAGENTA_KEY, HOUSE_FIXED,
};

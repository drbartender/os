// The house card's content: the Standard Menu card's sections, ported from the
// client, the house drink entry, and the plan fingerprint a draft is stamped
// with and read against (spec 2026-10-19 sections 9.2, 9.3 and 17). Pure.
//
// extractMenuSections(selections, activeModules, cocktails, mocktails) is a
// hand-synced port of its twin, client/src/pages/plan/data/menuSections.js
// (the planner's Standard Menu card, MenuPreview.js): keep both in sync, the
// server/utils/eventTypes.js pair precedent. Cocktails, Mocktails (resolved by
// id against the lookup arrays), then Beer & Wine (both key families merged; a
// Non-Alcoholic pick, like any beer but Seltzer and None, rolls up to Beer;
// shown as Beer, Seltzer, Red, White, Sparkling; Other wine and a None pick
// print nothing, and a section with no labels is not printed), then "Bar
// Service: Call Drinks" for a full bar with no signature picks. Spirits are
// never listed. menuHouseSections.test.js runs both twins on the same
// fixtures. The one difference is deliberate: a list stored in the wrong shape
// (not an array) reads as none here, where the client would throw, since the
// job must never throw on a malformed plan.
//
// houseSections(plan, normalized) -> the bar sections the job writes to
// content.house_sections at Generate and Update draft; the canvas only lays
// them out (HouseCard.js), after the Cocktails and Mocktails it draws from
// the draft's own visible drinks.
//   - planner side: the port on the plan's selections (activeModules is
//     selections.activeModules): the beer-wine and bar-service sections.
//   - consult side (the selections do not feed the menu there): the consult
//     bar's labelled lines (buildAlsoAtBar, through LINE_LABELS), each
//     { kind: 'bar-line', title: <label>, items: <its words> }, the Spirits
//     line left out so the house card never lists spirits on either side.
// houseDrink(drink, { addedBySync }) -> the stored drink entry (spec 6's
//   thirteen fields) for a normalized drink on a house draft: its own name
//   (never renamed, cut to the PATCH's 60), no description, no art.
// HOUSE_TITLE: the fixed title, "The Bar Menu".
// draftFingerprint(content, plan, normalized) -> the plan fingerprint a draft
//   is stamped with and read against (spec 2026-10-19 section 17: what is
//   compared is what the menu prints), the ONE helper Generate's upsert, the
//   house fill, Update draft and the read model use. A custom draft's (no
//   content.look, or 'custom') is buildFingerprint(normalized), unchanged. A
//   house draft prints its bar sections, never the "Also at the bar" lines,
//   so its bar part is houseSections(plan, normalized): bar_lines keyed
//   'house:<section title>' to the hash of that section's items, bar_hash over
//   them. A pick the card does not print (a spirit on either side, a second
//   beer style beside a beer, the pick order) never moves it; one it prints
//   (a beer or wine pick, a Non-Alcoholic pick that adds Beer, the Call Drinks
//   line) does. Every other part is buildFingerprint's.
// draftPlanHash(content, plan, normalized) -> the plan-hash echo (spec 17)
//   over that same form: fingerprintHash(draftFingerprint(...)), which on a
//   custom draft is planHash(normalized) exactly. The GET's diff.plan_hash and
//   the write routes' guard, menuDraftShared.requireSamePlan, both read it, so
//   on a house draft a pick the card does not print never refuses a write.

const crypto = require('crypto');
const { buildAlsoAtBar, LINE_LABELS } = require('./menuAlsoAtBar');
const { buildFingerprint, hashBarLines, fingerprintHash } = require('./menuDrinkSource');

const HOUSE_TITLE = 'The Bar Menu';
const NAME_MAX = 60;
const LIST_CAP = 200;
const BEER_WINE_DISPLAY_ORDER = ['Beer', 'Seltzer', 'Red', 'White', 'Sparkling'];
const BAR_KINDS = new Set(['beer-wine', 'bar-service']);
// A house bar baseline entry's key: this, then the printed section's title.
const HOUSE_LINE = 'house:';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v.slice(0, LIST_CAP) : []);
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function uniq(arr) {
  return Array.from(new Set(arr));
}

function resolveNames(ids, lookupArray) {
  const byId = new Map(list(lookupArray).filter(isObject).map((d) => [d.id, d.name]));
  return uniq(ids).map((id) => byId.get(id)).filter(Boolean);
}

function collapseBeerWine(selections) {
  const beerEntries = [...list(selections.beerFromFullBar), ...list(selections.beerFromBeerWine)];
  const wineEntries = [...list(selections.wineFromFullBar), ...list(selections.wineFromBeerWine)];

  const labels = new Set();
  // Any beer entry other than "Seltzer" rolls up to "Beer". "None" (the
  // planner's None checkbox, stored as ['None']) is no pick and adds nothing.
  if (beerEntries.some((e) => e && e !== 'Seltzer' && e !== 'None')) labels.add('Beer');
  if (beerEntries.includes('Seltzer')) labels.add('Seltzer');
  if (wineEntries.includes('Red')) labels.add('Red');
  if (wineEntries.includes('White')) labels.add('White');
  if (wineEntries.includes('Sparkling')) labels.add('Sparkling');
  // "Other" wine entries do NOT render a label.

  return BEER_WINE_DISPLAY_ORDER.filter((label) => labels.has(label));
}

function extractMenuSections(selections, activeModules, cocktails, mocktails) {
  const sel = isObject(selections) ? selections : {};
  const sections = [];

  // 1. Cocktails
  const sigIds = list(sel.signatureDrinks);
  if (sigIds.length > 0) {
    const items = resolveNames(sigIds, cocktails);
    if (items.length > 0) sections.push({ kind: 'cocktails', title: 'Cocktails', items });
  }

  // 2. Mocktails
  const mocIds = list(sel.mocktails);
  if (mocIds.length > 0) {
    const items = resolveNames(mocIds, mocktails);
    if (items.length > 0) sections.push({ kind: 'mocktails', title: 'Mocktails', items });
  }

  // 3. Beer & Wine
  const beerWineLabels = collapseBeerWine(sel);
  if (beerWineLabels.length > 0) sections.push({ kind: 'beer-wine', title: 'Beer & Wine', items: beerWineLabels });

  // 4. Bar Service fallback (full bar with no signature cocktails)
  if (isObject(activeModules) && activeModules.fullBar === true && sigIds.length === 0) {
    sections.push({ kind: 'bar-service', title: 'Bar Service', items: ['Call Drinks'] });
  }

  return { sections, isEmpty: sections.length === 0 };
}

// A labelled line's words: its text without the closing stop, split on ", ".
const wordsOf = (text) => String(text || '').replace(/\.$/, '').split(', ').map((w) => w.trim()).filter(Boolean);

function houseSections(plan, normalized) {
  if (!plan || !normalized) return [];
  if (normalized.side === 'consult') {
    return buildAlsoAtBar(normalized.bar)
      .filter((line) => line.label !== LINE_LABELS.spirits)
      .map((line) => ({ kind: 'bar-line', title: line.label, items: wordsOf(line.text) }))
      .filter((s) => s.items.length > 0);
  }
  const sel = isObject(plan.selections) ? plan.selections : {};
  return extractMenuSections(sel, sel.activeModules, [], []).sections.filter((s) => BAR_KINDS.has(s.kind));
}

function houseDrink(d, { addedBySync = false } = {}) {
  const drink = isObject(d) ? d : {};
  const catalog = drink.source === 'catalog';
  const name = Array.from(String(drink.name || '').trim()).slice(0, NAME_MAX).join('').trim();
  return {
    key: drink.key, source: catalog ? 'catalog' : 'custom', catalog_kind: catalog ? drink.catalog_kind || null : null,
    group: drink.group === 'mock' ? 'mock' : 'sig',
    catalog_id: catalog && drink.catalog_id !== undefined ? drink.catalog_id : null,
    display_name: name || drink.key, description: null,
    name_ai_suggested: false, description_ai_written: false, visual_note: '',
    hidden: false, has_art: false, added_by_sync: addedBySync === true,
  };
}

// The fingerprint a draft is stamped with and read against (header).
function draftFingerprint(content, plan, normalized) {
  const fingerprint = buildFingerprint(normalized);
  if (!isObject(content) || content.look !== 'house') return fingerprint;
  const barLines = {};
  for (const s of houseSections(plan, normalized)) barLines[`${HOUSE_LINE}${s.title}`] = sha256(JSON.stringify(s.items));
  return { ...fingerprint, bar_lines: barLines, bar_hash: hashBarLines(barLines) };
}

// The plan-hash echo over the form the read shows for the draft (header).
function draftPlanHash(content, plan, normalized) {
  return fingerprintHash(draftFingerprint(content, plan, normalized));
}

module.exports = { extractMenuSections, houseSections, houseDrink, draftFingerprint, draftPlanHash, HOUSE_TITLE };

// Per-add-on shopping list coverage map. Each entry lists the item names
// that the corresponding service add-on (from the byob_support category)
// substitutes for. The list is filtered out of the auto-generated
// shopping list at the end of generateShoppingList in shoppingList.js.
//
// signature-mixers-only is NOT in this map. It is silently skipped because
// its coverage depends on per-cocktail ingredient data that is not yet
// populated for seeded cocktails (cocktails.ingredients defaults to '[]'
// for every row). The follow-up spec at docs/superpowers/specs/ (to be
// authored) will add it once the ingredient data is in place.
//
// the-formula bundles those signature mixers ON TOP of the Foundation items,
// so only its mixer half ever depended on that missing data. It strips the
// Foundation items today and defers the rest: the earlier blanket skip had
// Formula clients buying water, cups, napkins and ice we were already
// bringing them.
//
// Straws are deliberately covered by NOTHING. We stopped bringing them
// (available on request, 2026-08-20, eco), so every BYOB shopping list keeps
// its own straws line no matter which supply bundle the client bought.
//
// Unknown slugs are silently ignored. The operator's audit before
// approval is the safety net for any drift.

const { BASIC_MIXERS, GARNISHES } = require('./shoppingList');

const FOUNDATION_ITEMS = ['Water', 'Cups (9oz)', 'Napkins', 'Ice'];

function namesOf(items) {
  return items.map((i) => i.item);
}

function addAll(set, names) {
  for (const n of names) set.add(n);
}

function computeStripSet({ activeAddonSlugs } = {}) {
  const stripSet = new Set();
  if (!Array.isArray(activeAddonSlugs) || activeAddonSlugs.length === 0) {
    return stripSet;
  }

  const allBasicMixers = namesOf(BASIC_MIXERS);
  const allGarnishes = namesOf(GARNISHES);

  for (const slug of activeAddonSlugs) {
    switch (slug) {
      case 'ice-delivery-only':
        stripSet.add('Ice');
        break;
      case 'cups-disposables-only':
        stripSet.add('Cups (9oz)');
        stripSet.add('Napkins');
        break;
      case 'bottled-water-only':
        stripSet.add('Water');
        break;
      case 'full-mixers-only':
        addAll(stripSet, allBasicMixers);
        break;
      case 'garnish-package-only':
        addAll(stripSet, allGarnishes);
        break;
      case 'the-foundation':
        addAll(stripSet, FOUNDATION_ITEMS);
        break;
      case 'the-formula':
        // Foundation half only. The signature-mixers half stays deferred,
        // exactly as signature-mixers-only is.
        addAll(stripSet, FOUNDATION_ITEMS);
        break;
      case 'the-full-compound':
        addAll(stripSet, FOUNDATION_ITEMS);
        addAll(stripSet, allBasicMixers);
        addAll(stripSet, allGarnishes);
        break;
      default:
        // signature-mixers-only and any unknown slug.
        // Silently skipped; the operator's audit handles any gaps.
        break;
    }
  }

  return stripSet;
}

module.exports = { computeStripSet };

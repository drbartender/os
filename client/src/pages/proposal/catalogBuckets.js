// What's in a package, bucketed into a fixed row order so two options can be
// read across from each other.
//
// Extracted from PackageMatrix.js so the old explore matrix and the new
// other-options surface share ONE implementation. Bucketing is the whole reason
// a comparison lines up: catalog headings vary per package ("Beer & Wine"
// combined in some, "Beer" / "Wine" / "Beer & Seltzer" separate in others), and
// mapping every heading into the same four buckets is what keeps the rows
// aligned across columns.
import { getPackageBySlug } from '../../data/packages';

export const SECTION_ORDER = ['Spirits', 'Beer & Wine', 'Mixers & Extras', 'Non-Alcoholic'];

export function bucketFor(heading) {
  const h = (heading || '').toLowerCase();
  if (h.includes('spirit')) return 'Spirits';
  if (h.includes('beer') || h.includes('wine') || h.includes('seltzer')) return 'Beer & Wine';
  if (h.includes('non') && h.includes('alc')) return 'Non-Alcoholic';
  return 'Mixers & Extras'; // "Mixers & Modifiers" + any unexpected heading
}

// Catalog items carry witty descriptions after an en-dash separator
// ("Tito's Vodka – ..."). Show just the names so tiers scan cleanly.
export function itemName(item) {
  return item.split(' – ')[0];
}

/** { bucket: [names...] } for a package slug, or null when it isn't catalogued. */
export function bucketsForSlug(slug) {
  const detail = getPackageBySlug(slug);
  if (!detail) return null;
  const out = {};
  for (const section of detail.sections) {
    const key = bucketFor(section.heading);
    out[key] = (out[key] || []).concat(section.items.map(itemName));
  }
  return out;
}

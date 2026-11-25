// A proposal's own drink swaps: the bottles one client's package lists in place of the package's
// defaults, read from proposals.package_swaps and checked before any page, record or email uses
// them. Required by the public proposal read, the admin proposal read and the sign route.
//
// The stored shape is { "package_slug": "<slug>", "swaps": [{ "from": "<item name>", "to": "<item>" }] }.
// "from" is an item's name as the package list prints it before its " – " description
// ("Maker's Mark Bourbon"); "to" is the whole replacement item, name and optional description
// ("Basil Hayden Bourbon – ..."). The swaps answer only for the package they were written for, so a
// client who switches packages sees that package's own list and a switch back restores them.
// There is no editor: swaps are rare and are set on the row by hand. Anything malformed reads as
// no swaps, so a bad row shows the package's own list and never breaks the page.

'use strict';

const MAX_SWAPS = 30;
const MAX_FROM = 200;
const MAX_TO = 400;

function cleanString(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s.length <= max ? s : null;
}

/**
 * The checked swaps for the package a proposal is on now, or [] when the row
 * holds none, holds swaps for another package, or holds anything malformed.
 * Pure.
 *
 * @param {unknown} raw  proposals.package_swaps as read (JSONB, parsed)
 * @param {string|null|undefined} packageSlug  service_packages.slug of the proposal's package
 * @returns {{ from: string, to: string }[]}
 */
function swapsForPackage(raw, packageSlug) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  if (typeof packageSlug !== 'string' || !packageSlug || raw.package_slug !== packageSlug) return [];
  if (!Array.isArray(raw.swaps) || raw.swaps.length === 0 || raw.swaps.length > MAX_SWAPS) return [];
  const out = [];
  for (const s of raw.swaps) {
    if (!s || typeof s !== 'object') return [];
    const from = cleanString(s.from, MAX_FROM);
    const to = cleanString(s.to, MAX_TO);
    if (!from || !to) return [];
    out.push({ from, to });
  }
  return out;
}

module.exports = { swapsForPackage };

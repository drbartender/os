'use strict';

// A booking's price lines as the admin breakdown shows them: the display label (gratuityLabels.resolveGratuityDisplayLabel) and the "hidden from client" mark, for the Proposal or event tool.
//
// The admin breakdown (client/src/components/PricingBreakdown.js) draws
// snapshot.breakdown with each label through resolveGratuityDisplayLabel
// (the server twin is server/utils/gratuityLabels.js) and tags each hidden
// adjustment row through client/src/utils/hiddenRows.js hiddenRowFlags.
// hiddenRowFlags lives only in the client (an ES module the server cannot
// load), so hiddenFlags below is its rule ported row for row onto the
// server's own adjustmentRules coercions (adjVisible, adjLabel,
// adjSignedCents), which the client file mirrors: a row carrying `visible`
// reads from it; otherwise the adjustment rows are matched to
// snapshot.adjustments from the bottom by label and signed cents, skipping
// the client Gratuity row at the end while snapshot.gratuity.total is above
// zero. Integer cents comparisons only; nothing is added up.
//
// ADD_ON_UNITS says what an add-on's stored quantity counts, by billing type
// (money law 6: per_hour stores hours times staff, per_guest and
// per_guest_timed the guest count, per_staff the staff count, per_100_guests
// blocks of a hundred guests, flat the count itself).

const { resolveGratuityDisplayLabel, GRATUITY_LABEL } = require('../../gratuityLabels');
const { adjVisible, adjLabel, adjSignedCents } = require('../../adjustmentRules');

const hasOwn = (o, k) => Boolean(o) && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

function rowSignedCents(amount) {
  const n = Number(amount) || 0;
  const cents = Math.round(Math.abs(n) * 100);
  if (cents === 0) return 0;
  return n < 0 ? -cents : cents;
}

const rowIsLine = (row, adj) => row.label === adjLabel(adj) && rowSignedCents(row.amount) === adjSignedCents(adj);

/** boolean[] aligned with snapshot.breakdown: true where the admin marks the row hidden from the client. */
function hiddenFlags(snapshot) {
  const rows = snapshot && Array.isArray(snapshot.breakdown) ? snapshot.breakdown : [];
  const adjs = snapshot && Array.isArray(snapshot.adjustments) ? snapshot.adjustments : [];
  const flags = rows.map((row) => (hasOwn(row, 'visible') ? !row.visible : false));
  let end = rows.length;
  const last = rows[end - 1];
  if (hasOwn(last, 'label') && last.label === GRATUITY_LABEL
    && Number(snapshot.gratuity && snapshot.gratuity.total) > 0) end -= 1;
  let k = adjs.length - 1;
  for (let i = end - 1; i >= 0 && k >= 0; i -= 1) {
    const row = rows[i];
    if (!row || typeof row !== 'object') continue;
    let j = k;
    while (j >= 0 && !rowIsLine(row, adjs[j])) j -= 1;
    if (j < 0) continue;
    flags[i] = hasOwn(row, 'visible') ? !row.visible : !adjVisible(adjs[j]);
    k = j - 1;
  }
  return flags;
}

/** The breakdown rows as { label (the admin's display label), amount (as stored), hidden_from_client }. */
function adminPriceLines(snapshot) {
  const rows = snapshot && Array.isArray(snapshot.breakdown) ? snapshot.breakdown : [];
  const hidden = hiddenFlags(snapshot);
  return rows.map((row, i) => ({
    label: resolveGratuityDisplayLabel(row && row.label, snapshot),
    amount: row ? row.amount : null,
    hidden_from_client: Boolean(hidden[i]),
  }));
}

const ADD_ON_UNITS = Object.freeze({
  per_hour: 'staff-hours (hours times staff)',
  per_guest: 'guests',
  per_guest_timed: 'guests',
  per_staff: 'staff',
  per_100_guests: 'blocks of 100 guests',
  flat: 'units',
});

module.exports = { hiddenFlags, adminPriceLines, ADD_ON_UNITS };

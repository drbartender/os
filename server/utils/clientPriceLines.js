// server/utils/clientPriceLines.js
'use strict';
// The service rows a client sees, built on the server (spec 2026-10-16
// section 4.1, decision D2). Pure: no DB, no Sentry. The routes that call it
// report a fallback or an unexplained gap themselves.
//
// Row set: exactly the rows the proposal page drew from its own lineItems memo
// before this module (ProposalView.js L580-620 on 2026-10-16), ported row for
// row and pinned by clientPriceLines.test.js: the package row (package.base_cost
// + staffing.total, labeled with the package name the page passes), bar rental,
// every add-on including $0 ones, syrups, and the VISIBLE adjustments as signed
// rows (adjustmentRules coercions). A hidden adjustment produces no row: its
// amount reaches the client only folded into the package row, or into one
// "Pricing adjustment" row when the package row would go below $0 (the invoice
// rule, foldDecision.js). Service rows only: the page adds the gratuity row from
// snapshot.gratuity itself, because a create-intent quote re-prices the
// gratuity in client state (intentQuote.js).
//
// Amounts are dollars in whole cents. Keys are stable and never reveal where a
// hidden line sat: visible adjustments are counted on their own.

const { decideFold, PRICING_ADJUSTMENT_LABEL } = require('./foldDecision');
const { adjVisible, adjSignedCents, adjLabel } = require('./adjustmentRules');

// A money value the snapshot really carries: a finite number, or a non-blank
// numeric string (legacy rows). null, '', booleans and junk are not money.
function isMoney(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.trim() !== '' && Number.isFinite(Number(v));
  return false;
}

// Dollars to integer cents; anything that is not money counts as 0, as the
// page's own `|| 0` reads did.
const moneyToCents = (v) => (isMoney(v) ? Math.round(Number(v) * 100) : 0);

const isSnapshot = (s) => !!s && typeof s === 'object' && !Array.isArray(s);

// The proposal page's target (spec 4.2): the snapshot's own total less its
// client gratuity, in integer cents. Only a gratuity above zero comes off,
// because only then does the page draw a gratuity row. NaN when the snapshot
// has no usable total: no target is never a $0 target, which would fold every
// row away (invoiceLineItems.contractCents keeps null the same way).
function snapshotServiceCents(snapshot) {
  if (!isSnapshot(snapshot) || !isMoney(snapshot.total)) return NaN;
  const g = snapshot.gratuity && snapshot.gratuity.total;
  const gratuityCents = isMoney(g) && Number(g) > 0 ? Math.round(Number(g) * 100) : 0;
  return Math.round(Number(snapshot.total) * 100) - gratuityCents;
}

function itemizedRows(snap, packageName) {
  const rows = [];
  // The page drew no rows at all for a snapshot without a package.
  if (!snap.package) return rows;
  rows.push({
    key: 'package',
    label: packageName === undefined ? null : packageName,
    amount: (moneyToCents(snap.package.base_cost) + moneyToCents(snap.staffing && snap.staffing.total)) / 100,
  });
  if (snap.bar_rental && moneyToCents(snap.bar_rental.total) > 0) {
    rows.push({ key: 'bar-rental', label: 'Bar Rental', amount: moneyToCents(snap.bar_rental.total) / 100 });
  }
  (Array.isArray(snap.addons) ? snap.addons : []).forEach((a, i) => {
    rows.push({ key: `addon-${i}`, label: a && a.name !== undefined ? a.name : null, amount: moneyToCents(a && a.line_total) / 100 });
  });
  const sc = snap.syrups;
  if (sc && moneyToCents(sc.total) > 0) {
    let label = 'Handcrafted Syrups';
    if (sc.packs > 0 && sc.singles > 0) {
      label += ` (${sc.packs} three-pack${sc.packs !== 1 ? 's' : ''} + ${sc.singles} single${sc.singles !== 1 ? 's' : ''})`;
    } else if (sc.packs > 0) {
      label += ` (${sc.packs} three-pack${sc.packs !== 1 ? 's' : ''})`;
    } else {
      label += ` (${sc.singles} bottle${sc.singles !== 1 ? 's' : ''})`;
    }
    rows.push({ key: 'syrups', label, amount: moneyToCents(sc.total) / 100 });
  }
  let shown = 0;
  for (const adj of Array.isArray(snap.adjustments) ? snap.adjustments : []) {
    if (!adjVisible(adj)) continue;
    rows.push({ key: `adjustment-${shown}`, label: adjLabel(adj), amount: adjSignedCents(adj) / 100 });
    shown += 1;
  }
  return rows;
}

/**
 * @param {object} snapshot  a pricing snapshot (proposals.pricing_snapshot)
 * @param {{ targetCents: number, packageName?: string|null }} opts
 *   targetCents: the service total the rows must reach, integer cents (NaN = none)
 * @returns {{ rows: Array<{ key: string, label: string|null, amount: number }>,
 *   fold: { applied: 'no_total'|'none'|'skipped'|'package'|'fallback', gapCents: number,
 *           hiddenNetCents: number, explainedCents: number|null, unexplainedCents: number } }}
 *   The fold report itself never leaves the server (decision 6). The rows do,
 *   and in a fallback the "Pricing adjustment" row carries the gap (spec D3).
 */
function buildClientPriceRows(snapshot, { targetCents, packageName } = {}) {
  if (!isSnapshot(snapshot) || !isMoney(snapshot.total) || !Number.isFinite(targetCents)) {
    return { rows: [], fold: { applied: 'no_total', gapCents: 0, hiddenNetCents: 0, explainedCents: null, unexplainedCents: 0 } };
  }
  const rows = itemizedRows(snapshot, packageName);
  const gapCents = Math.round(targetCents) - rows.reduce((s, r) => s + Math.round(r.amount * 100), 0);
  const pkg = rows.find(r => r.key === 'package');
  const applied = decideFold({ hasPackage: !!pkg, packageCents: pkg ? Math.round(pkg.amount * 100) : 0, gapCents });
  if (applied === 'package') pkg.amount = (Math.round(pkg.amount * 100) + gapCents) / 100;
  if (applied === 'fallback') rows.push({ key: 'pricing-adjustment', label: PRICING_ADJUSTMENT_LABEL, amount: gapCents / 100 });
  const adjustments = Array.isArray(snapshot.adjustments) ? snapshot.adjustments : [];
  const netOf = (lines) => lines.reduce((s, a) => s + adjSignedCents(a), 0);
  const hiddenNetCents = netOf(adjustments.filter(a => !adjVisible(a)));
  // What the snapshot itself explains, read the way
  // invoiceLineItems.foldToContract reads it: its own service total less what
  // it itemizes (subtotal plus the visible lines). That is the hidden lines, an
  // override's difference, or the engine's zero clamp (a comped booking), so
  // none of them reads as unexplained. Null when the snapshot carries no
  // subtotal; its hidden lines are then the only explanation there is.
  const explainedCents = isMoney(snapshot.subtotal)
    ? snapshotServiceCents(snapshot) - (moneyToCents(snapshot.subtotal) + netOf(adjustments.filter(adjVisible)))
    : null;
  const unexplainedCents = gapCents - (explainedCents === null ? hiddenNetCents : explainedCents);
  return { rows, fold: { applied, gapCents, hiddenNetCents, explainedCents, unexplainedCents } };
}

module.exports = { buildClientPriceRows, snapshotServiceCents, moneyToCents };

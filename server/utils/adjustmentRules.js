// server/utils/adjustmentRules.js
'use strict';
// One definition of a price adjustment line (spec 2026-10-16 section 3).
// adjVisible, adjAmount and adjLabel are the engine's own coercions
// (pricingEngine.js adjustmentNet and its breakdown rows). adjSignedCents is
// a line's signed amount in integer cents, rounding the magnitude half away
// from zero: a per-line rounding the engine never does (it nets raw dollars
// and rounds the total once), exact for every line validateAdjustments
// accepts, since those are whole cents. Client twin:
// client/src/utils/adjustmentRules.js (parity pinned by the test).
//
// A line is { type: 'discount' | 'surcharge', label, amount (positive
// dollars), visible }, plus two optional markers the engine ignores:
// `source` ('agreed_price' for a Set agreed price line or a converted
// override, 'refund' for a refund line, 'comp' for a comped Drink Plan Extras
// invoice, compLine.js), `refund_id` (proposal_refunds.id, only with source
// 'refund') and `comped_addons` (only with source 'comp': the catalog add-ons
// the comp waived, [{ addon_id, cents }], so the comp leaves with them,
// compLine.js netCompLinesAgainstAddons). Protection keys on `source`, never
// on a label an admin can edit.

const { GRATUITY_LABEL } = require('./gratuityLabels');

const ADJUSTMENT_SOURCES = Object.freeze(['agreed_price', 'refund', 'comp']);
const AGREED_PRICE_LABEL = 'Agreed price adjustment';
const REFUND_LABEL = 'Refund';
const COMP_LABEL = 'Drink Plan Extras comped';
const MAX_ADJUSTMENTS = 50;
const MAX_ADJUSTMENT_DOLLARS = 1000000; // exclusive; the bound TOTAL_PRICE_OVERRIDE_MAX had
const MAX_ADJUSTMENT_LABEL = 255;      // invoice_line_items.description
const MAX_REFUND_ID = 2147483647;      // proposal_refunds.id is SERIAL (int4)
const MAX_ADDON_ID = 2147483647;       // service_addons.id is SERIAL (int4)
const MAX_COMPED_ADDONS = 50;          // one extras invoice names far fewer add-ons

const adjVisible = (adj) => !!(adj && adj.visible);
const adjAmount = (adj) => Math.abs(Number(adj && adj.amount) || 0);
const adjSignedCents = (adj) => {
  const cents = Math.round(adjAmount(adj) * 100);
  if (cents === 0) return 0; // a $0 discount is 0, never -0
  return adj && adj.type === 'discount' ? -cents : cents;
};
const adjLabel = (adj) => (adj && adj.label) || (adj && adj.type === 'discount' ? 'Discount' : 'Surcharge');
const isProtectedAdjustment = (adj) => !!adj && ADJUSTMENT_SOURCES.includes(adj.source);
// True when a dollar amount has no part finer than a cent. Tolerates the float
// noise of whole-cent arithmetic (0.1 + 0.2) and rounds nothing.
const isWholeCents = (dollars) => {
  const cents = Number(dollars) * 100;
  return Number.isFinite(cents) && Math.abs(cents - Math.round(cents)) < 1e-6;
};

// The comped add-ons of a comp line as stored: [{ addon_id, cents }] with
// integer ids inside int4, whole non-negative cents, no id twice, and the
// cents summing to no more than the line (what is left is the comp's bar and
// syrup portion, which names no add-on). null for any other shape.
function readCompedAddons(raw, amountDollars) {
  if (!Array.isArray(raw) || raw.length > MAX_COMPED_ADDONS) return null;
  const out = [];
  const seen = new Set();
  let sum = 0;
  for (const c of raw) {
    if (!c || typeof c !== 'object') return null;
    const { addon_id: id, cents } = c;
    if (!Number.isInteger(id) || id < 1 || id > MAX_ADDON_ID || seen.has(id)) return null;
    if (!Number.isInteger(cents) || cents < 0) return null;
    seen.add(id);
    sum += cents;
    out.push({ addon_id: id, cents });
  }
  if (sum > Math.round(amountDollars * 100)) return null;
  return out;
}

function validateAdjustments(input) {
  const fail = (error) => ({ value: null, error });
  if (!Array.isArray(input)) return fail('Price adjustments must be a list.');
  if (input.length > MAX_ADJUSTMENTS) return fail(`At most ${MAX_ADJUSTMENTS} price adjustments.`);
  const value = [];
  for (const adj of input) {
    if (!adj || typeof adj !== 'object') return fail('Each price adjustment must be an object.');
    if (adj.type !== 'discount' && adj.type !== 'surcharge') return fail('Each price adjustment is a discount or a surcharge.');
    const label = adj.label === undefined || adj.label === null ? '' : adj.label;
    if (typeof label !== 'string') return fail('A price adjustment label must be text.');
    if (label.length > MAX_ADJUSTMENT_LABEL) return fail(`A price adjustment label is at most ${MAX_ADJUSTMENT_LABEL} characters.`);
    // Blank, null and undefined count as 0, the engine's reading (decision 9); no rounding.
    const raw = adj.amount;
    const n = raw === '' || raw === null || raw === undefined ? 0
      : (typeof raw === 'string' ? (raw.trim() === '' ? 0 : Number(raw)) : raw);
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n >= MAX_ADJUSTMENT_DOLLARS) {
      return fail('A price adjustment amount must be $0 or more and under $1,000,000.');
    }
    // Refused, never rounded (decision 9): per-line cents then equal the engine's net.
    if (!isWholeCents(n)) return fail('A price adjustment amount must be in whole cents.');
    const line = { type: adj.type, label, amount: n, visible: !!adj.visible };
    if (adj.source !== undefined && adj.source !== null) {
      if (!ADJUSTMENT_SOURCES.includes(adj.source)) return fail('Unknown price adjustment source.');
      line.source = adj.source;
    }
    if (line.source === 'refund') {
      if (!Number.isInteger(adj.refund_id) || adj.refund_id < 1 || adj.refund_id > MAX_REFUND_ID) {
        return fail('A refund line must name its refund.');
      }
      line.refund_id = adj.refund_id;
    } else if (adj.refund_id !== undefined && adj.refund_id !== null) {
      return fail('Only a refund line can name a refund.');
    }
    if (line.source === 'comp') {
      if (adj.comped_addons !== undefined && adj.comped_addons !== null) {
        const comped = readCompedAddons(adj.comped_addons, n);
        if (comped === null) return fail('A comp line must name the add-ons it comps with whole cents each, within the line.');
        line.comped_addons = comped;
      }
    } else if (adj.comped_addons !== undefined && adj.comped_addons !== null) {
      return fail('Only a comp line can name comped add-ons.');
    }
    value.push(line);
  }
  return { value, error: null };
}

// Where a server-written line's row goes in snapshot.breakdown (server only):
// where the engine would have put it. The engine pushes the adjustment rows
// after every other service row and the client GRATUITY_LABEL row LAST, and
// only when the client gratuity is above zero; the forced "Shared Gratuity"
// rows sit inside staffing and the add-ons. So the row goes just before a last
// GRATUITY_LABEL row while snapshot.gratuity.total is above zero, and is
// appended otherwise. A last row with that label and no client gratuity is an
// admin's own line, never the client row. Returns a new array.
function insertAdjustmentBreakdownRow(snapshot, row) {
  const breakdown = snapshot && Array.isArray(snapshot.breakdown) ? snapshot.breakdown : [];
  const last = breakdown[breakdown.length - 1];
  const clientGratuityLast = !!last && last.label === GRATUITY_LABEL
    && Number(snapshot.gratuity && snapshot.gratuity.total) > 0;
  return clientGratuityLast
    ? [...breakdown.slice(0, -1), row, last]
    : [...breakdown, row];
}

module.exports = {
  ADJUSTMENT_SOURCES, AGREED_PRICE_LABEL, REFUND_LABEL, COMP_LABEL,
  MAX_ADJUSTMENTS, MAX_ADJUSTMENT_DOLLARS, MAX_ADJUSTMENT_LABEL,
  adjVisible, adjAmount, adjSignedCents, adjLabel, isProtectedAdjustment,
  isWholeCents,
  validateAdjustments,
  insertAdjustmentBreakdownRow,
};

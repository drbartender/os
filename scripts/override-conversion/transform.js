'use strict';
// The override conversion's transform (plan 2026-10-16-price-override-removal,
// Task V2; spec 8.2-8.4). Pure: export rows and the fresh compute in, the
// change set, the dry-run report and Dallas's lists out. Every compare is in
// integer cents; the engine's own coercions read every line (adjustmentRules).
//
//   live override       priced at the fresh compute (today's catalog): line =
//                       override - freshServiceCents; the after snapshot is the
//                       fresh one with the line appended.
//   terminal override   in place: line = override - max(0, subtotal + net),
//                       from the ROW's override (527, 599); line prices untouched.
//   refund backfill     no-override bookings only: one Refund line per succeeded
//                       contract refund with a drop and no line naming it, only
//                       when the snapshot gap equals those drops.
// Refunds on a booking that still carries an override are absorbed by its
// agreed-price line and never backfilled. In-place rows add a breakdown row only
// when the snapshot has a breakdown (never invent one), at the engine's slot
// (insertAdjustmentBreakdownRow). Every after-state must pass the editor's
// validator and add up from its own JSON exactly as the forward block re-checks
// it; a row that cannot is listed with a reason, never written. A legal-hold id
// (the seam, plus legalHoldIds) appears nowhere in the output.

const { isLegalHold } = require('../../server/utils/legalHold');
const {
  AGREED_PRICE_LABEL, REFUND_LABEL, adjSignedCents, validateAdjustments, insertAdjustmentBreakdownRow,
} = require('../../server/utils/adjustmentRules');
const { buildClientPriceRows, snapshotServiceCents } = require('../../server/utils/clientPriceLines');
const { buildInvoiceLineItems } = require('../../server/utils/invoiceLineItems');
const { extractGratuityCents } = require('../../server/utils/payrollMath');
const { hasOverride, isLiveOverride, moneyCents } = require('./shared');

const KIND_LIVE = 'override_live';
const KIND_TERMINAL = 'override_terminal';
const KIND_BACKFILL = 'refund_backfill';

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// The row's stored lines: SQL NULL reads as none; JSON null or a non-array is unreadable (null).
function rowLines(row) {
  if (row.adjustments_type !== undefined && row.adjustments_type !== null && row.adjustments_type !== 'array') return null;
  if (row.adjustments === null || row.adjustments === undefined) return [];
  return Array.isArray(row.adjustments) ? row.adjustments : null;
}
// The snapshot's copy: a missing key reads as none; JSON null or a non-array is unreadable.
function snapLines(snap) {
  if (!isPlainObject(snap)) return null;
  if (snap.adjustments === undefined) return [];
  return Array.isArray(snap.adjustments) ? snap.adjustments : null;
}
// Canonical JSON (sorted keys) so two parses of the same jsonb compare equal.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isPlainObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const sameLines = (a, b) => canonical(a) === canonical(b);
const netCents = (lines) => lines.reduce((s, a) => s + adjSignedCents(a), 0);
const namesRefund = (lines, refundId) => lines.some((a) => isPlainObject(a)
  && a.refund_id !== undefined && a.refund_id !== null && Number(a.refund_id) === refundId);

// An amount the forward block reads the way the engine does: blank, a plain
// decimal string or a finite number.
const readableAmount = (v) => v === undefined || v === null
  || (typeof v === 'number' && Number.isFinite(v))
  || (typeof v === 'string' && /^\s*([0-9]+(\.[0-9]+)?)?\s*$/.test(v));
function linesProblem(lines) {
  if (validateAdjustments(lines).error) return 'invalid_lines';
  if (!lines.every((l) => readableAmount(l.amount))) return 'unreadable_amount';
  return null;
}

// The engine's total recomputed from a snapshot's own figures, the arithmetic
// the forward block re-checks: max(0, subtotal + net) + gratuity, a missing
// gratuity counting as 0. NaN when a figure cannot be read.
function engineTotalCents(snap, lines) {
  const sub = moneyCents(snap.subtotal);
  if (!Number.isFinite(sub)) return NaN;
  const g = isPlainObject(snap.gratuity) ? moneyCents(snap.gratuity.total) : 0;
  const grat = g === null ? 0 : g;
  return Math.max(0, sub + netCents(lines)) + grat;
}

function agreedLine(lineCents) {
  if (lineCents === 0) return null;
  return {
    type: lineCents < 0 ? 'discount' : 'surcharge', label: AGREED_PRICE_LABEL,
    amount: Math.abs(lineCents) / 100, visible: false, source: 'agreed_price',
  };
}
const refundLine = (r) => ({
  type: 'discount', label: REFUND_LABEL, amount: r.dropCents / 100, visible: true, source: 'refund', refund_id: r.id,
});
const breakdownRow = (l) => ({ label: l.label, amount: l.type === 'discount' ? -l.amount : l.amount, visible: l.visible });

// The new rows placed one at a time where the engine would put each, and the
// slot that came out ('before_last' or 'end'; 'none' when nothing is placed).
function placeRows(snap, lines) {
  if (!Array.isArray(snap.breakdown) || lines.length === 0) return { breakdown: snap.breakdown, placement: 'none' };
  let breakdown = snap.breakdown;
  for (const l of lines) breakdown = insertAdjustmentBreakdownRow({ ...snap, breakdown }, breakdownRow(l));
  const last = snap.breakdown[snap.breakdown.length - 1];
  return { breakdown, placement: last !== undefined && breakdown[breakdown.length - 1] === last ? 'before_last' : 'end' };
}

function inPlaceAfter(snap, existing, lines, totalCents, clearOverride) {
  const { breakdown, placement } = placeRows(snap, lines);
  const after = { ...snap, adjustments: [...existing, ...lines] };
  if (Array.isArray(snap.breakdown)) after.breakdown = breakdown;
  if (clearOverride) after.total_price_override = null;
  after.total = totalCents / 100;
  return { after, placement };
}

function planLive(row, f, base) {
  if (!f) return { unconverted: 'no_fresh_compute' };
  if (f.error || !isPlainObject(f.snapshot)) return { unconverted: 'fresh_compute_refused' };
  if (f.money_md5 !== row.money_md5) return { unconverted: 'fresh_compute_stale' };
  const existing = rowLines(row);
  if (!existing) return { unconverted: 'unreadable_lines' };
  if (!sameLines(snapLines(f.snapshot) || [null], existing)) return { unconverted: 'fresh_compute_lines_differ' };
  const line = agreedLine(base.overrideCents - f.freshServiceCents);
  const lines = line ? [line] : [];
  const { breakdown, placement } = placeRows(f.snapshot, lines);
  const after = { ...f.snapshot, adjustments: [...existing, ...lines], breakdown, total_price_override: null };
  after.total = base.totalPriceCents / 100;
  const stored = row.pricing_snapshot;
  const storedLines = snapLines(stored);
  const storedSub = isPlainObject(stored) ? moneyCents(stored.subtotal) : NaN;
  const drift = Number.isFinite(storedSub) && storedLines
    ? f.freshServiceCents - Math.max(0, storedSub + netCents(storedLines)) : null;
  return { lines, after, placement, clearOverride: true, catalogDriftCents: drift };
}

function planTerminal(row, base) {
  const snap = row.pricing_snapshot;
  const existing = rowLines(row);
  const copy = snapLines(snap);
  if (!existing || !copy) return { unconverted: 'unreadable_lines' };
  if (!sameLines(existing, copy)) return { list: 'snapshotMismatch' };
  const sub = moneyCents(snap.subtotal);
  if (!Number.isFinite(sub)) return { unconverted: 'no_subtotal' };
  const line = agreedLine(base.overrideCents - Math.max(0, sub + netCents(existing)));
  const lines = line ? [line] : [];
  return { lines, ...inPlaceAfter(snap, existing, lines, base.totalPriceCents, true), clearOverride: true };
}

function planBackfill(row, base) {
  const withDrop = (row.refunds || []).filter((r) => r.total_scope === 'contract')
    .map((r) => ({ ...r, dropCents: moneyCents(r.total_price_before) - moneyCents(r.total_price_after) }))
    .filter((r) => Number.isFinite(r.dropCents) && r.dropCents > 0);
  if (withDrop.length === 0) return null;
  const snap = row.pricing_snapshot;
  const existing = rowLines(row);
  const copy = snapLines(snap);
  if (!existing || !copy) return { unconverted: 'unreadable_lines' };
  // A refund one list names and the other does not is a mismatch, never "lined".
  if (withDrop.some((r) => namesRefund(existing, r.id) !== namesRefund(copy, r.id))) return { list: 'snapshotMismatch' };
  const unbacked = withDrop.filter((r) => !namesRefund(existing, r.id) && !namesRefund(copy, r.id))
    .sort((a, b) => (Date.parse(a.created_at) - Date.parse(b.created_at)) || (a.id - b.id));
  if (unbacked.length === 0) return null; // every refund has its line (the 59 shape stays untouched)
  if (!sameLines(existing, copy)) return { list: 'snapshotMismatch' };
  const snapTotal = moneyCents(snap.total);
  if (!Number.isFinite(snapTotal)) return { unconverted: 'no_snapshot_total' };
  if (!Number.isFinite(moneyCents(snap.subtotal))) return { unconverted: 'no_subtotal' };
  const gapCents = snapTotal - base.totalPriceCents;
  const unbackedCents = unbacked.reduce((s, r) => s + r.dropCents, 0);
  const listed = unbacked.map((r) => ({
    id: r.id, dropCents: r.dropCents, created_at: r.created_at,
    additionalServicesAfter: (row.additional_services_invoices || [])
      .filter((i) => Date.parse(i.created_at) > Date.parse(r.created_at))
      .map((i) => ({ id: i.id, created_at: i.created_at, amount_due: i.amount_due, status: i.status })),
  }));
  if (gapCents === 0) return { list: 'refundGapZero', extra: { refunds: listed } };
  if (gapCents !== unbackedCents) return { list: 'refundGapUnequal', extra: { gapCents, unbackedCents, refunds: listed } };
  const lines = unbacked.map(refundLine);
  return { lines, ...inPlaceAfter(snap, existing, lines, base.totalPriceCents, false), clearOverride: false };
}

function changeOf(row, kind, r) {
  return {
    id: row.id, kind, money_md5: row.money_md5,
    before: { adjustments: row.adjustments, pricing_snapshot: row.pricing_snapshot, total_price_override: row.total_price_override },
    after: {
      adjustments: r.after.adjustments, pricing_snapshot: r.after,
      total_price_override: kind === KIND_BACKFILL ? row.total_price_override : null,
    },
    lines: r.lines, placement: r.placement, breakdownRows: r.lines.map(breakdownRow), clearOverride: r.clearOverride,
  };
}

// The invoice fold's verdict, or 'skipped' when no package line is there to
// carry a gap the lines leave (foldToContract gives no verdict then).
function invoiceVerdict(snapshot, addonRows, totalPriceCents) {
  const { items, fold } = buildInvoiceLineItems({ snapshot, addonRows, totalPriceCents });
  if (fold.applied) return fold.applied;
  const hasPackage = items.some((it) => it.source_type === 'package');
  return !hasPackage && items.reduce((sum, it) => sum + it.line_total, 0) !== totalPriceCents ? 'skipped' : 'none';
}

// The payroll gratuity pool (payrollMath.extractGratuityCents: the Shared
// Gratuity and Gratuity breakdown rows), so Dallas sees staff-pay impact
// before the prod write. Only a live row's fresh compute can move it.
const payrollPool = (snap) => (isPlainObject(snap) && Array.isArray(snap.breakdown) ? extractGratuityCents(snap) : 0);

function reportRowOf(row, who, r, base) {
  const before = payrollPool(row.pricing_snapshot);
  const after = payrollPool(r.after);
  return {
    ...who,
    lines: r.lines.map((l) => ({ type: l.type, label: l.label, amount: l.amount })),
    catalogDriftCents: who.kind === KIND_LIVE ? r.catalogDriftCents : null,
    payrollGratuityBeforeCents: before, payrollGratuityAfterCents: after, payrollGratuityChanged: before !== after,
    pageVerdict: buildClientPriceRows(r.after, { targetCents: snapshotServiceCents(r.after) }).fold.applied,
    invoiceVerdict: invoiceVerdict(r.after, row.addons || [], base.totalPriceCents),
    pendingChangeRequests: row.pending_change_requests || [],
  };
}

// Contract refunds with a drop on an override booking that no line names: the
// ones its agreed-price line absorbs (527, 599). A refund that already has its
// own Refund line (the step 1 window) is carried by that line instead.
function absorbedRefundIds(row) {
  const named = [...(rowLines(row) || []), ...(snapLines(row.pricing_snapshot) || [])];
  return (row.refunds || []).filter((x) => x.total_scope === 'contract'
    && moneyCents(x.total_price_before) - moneyCents(x.total_price_after) > 0
    && !namesRefund(named, x.id)).map((x) => x.id);
}

/**
 * @param {{ rows: object[], fresh: object[], legalHoldIds: number[] }} input
 *   rows: export.js rows; fresh: freshCompute.js rows; legalHoldIds: ids to
 *   refuse on top of the legal-hold seam (required, may be empty)
 * @returns {{ changes, report, dallasLists, absorbedRefunds }}
 */
function planConversion({ rows, fresh, legalHoldIds } = {}) {
  if (!Array.isArray(legalHoldIds)) throw new TypeError('planConversion needs legalHoldIds (an array, may be empty)');
  const extraHeld = legalHoldIds.map(Number);
  const held = (id) => isLegalHold(id) || extraHeld.includes(Number(id));
  const freshById = new Map((fresh || []).map((f) => [f.id, f]));
  const out = {
    changes: [], report: [],
    dallasLists: { snapshotMismatch: [], refundGapZero: [], refundGapUnequal: [], unconverted: [] },
    absorbedRefunds: [],
  };
  for (const row of [...(rows || [])].sort((a, b) => a.id - b.id)) {
    if (held(row.id)) continue; // never planned, reported or listed
    const kind = !hasOverride(row) ? KIND_BACKFILL : (isLiveOverride(row) ? KIND_LIVE : KIND_TERMINAL);
    const who = { id: row.id, status: row.status, kind };
    const base = { totalPriceCents: moneyCents(row.total_price), overrideCents: moneyCents(row.total_price_override) };
    let r;
    if (!Number.isFinite(base.totalPriceCents)) r = { unconverted: 'no_total_price' };
    else if (kind !== KIND_BACKFILL && !Number.isFinite(base.overrideCents)) r = { unconverted: 'unreadable_override' };
    else if (kind !== KIND_LIVE && !isPlainObject(row.pricing_snapshot)) r = { unconverted: 'unreadable_snapshot' };
    else if (kind === KIND_LIVE) r = planLive(row, freshById.get(row.id), base);
    else if (kind === KIND_TERMINAL) r = planTerminal(row, base);
    else r = planBackfill(row, base);
    if (r === null) continue;
    if (r.lines && !r.unconverted && !r.list) {
      const problem = linesProblem(r.after.adjustments);
      if (problem) r = { unconverted: problem };
      else if (engineTotalCents(r.after, r.after.adjustments) !== base.totalPriceCents) r = { unconverted: 'total_mismatch' };
    }
    if (r.unconverted) { out.dallasLists.unconverted.push({ ...who, reason: r.unconverted }); continue; }
    if (r.list) { out.dallasLists[r.list].push({ ...who, ...(r.extra || {}) }); continue; }
    out.changes.push(changeOf(row, kind, r));
    out.report.push(reportRowOf(row, who, r, base));
    const absorbed = kind === KIND_BACKFILL ? [] : absorbedRefundIds(row);
    if (absorbed.length) out.absorbedRefunds.push({ proposalId: row.id, refundIds: absorbed });
  }
  return out;
}

module.exports = { planConversion, canonical, breakdownRow, KIND_LIVE, KIND_TERMINAL, KIND_BACKFILL };

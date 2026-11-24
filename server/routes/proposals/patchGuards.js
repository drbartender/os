// server/routes/proposals/patchGuards.js
'use strict';
// The editor PATCH's guards (spec 2026-10-16 sections 3, 5.1 and 5.3; plan
// Task E1). Pure: no database, no Express. PATCH /api/proposals/:id in crud.js
// calls each one; crud.js sits near the file-size cap, so the logic lives here
// and crud.js carries call lines only.
//
// What they keep out of a save:
//  - a crafted id. The route parses req.params.id once and uses the integer
//    for every query and the post-commit tail: Postgres reads '1_23' as 123
//    where parseInt reads 1, so a raw id could re-price one booking and bill
//    another.
//  - a legal hold. The early check runs on the parsed id; the binding check
//    runs on the id of the row the route locked (Global Constraints).
//  - stale lines. The admin GET and the PATCH response carry adjustments_token
//    (md5 of the stored lines). A body that changes the lines must carry the
//    current token; a body that leaves them as stored needs none. Keyed on the
//    LINES, never updated_at, which every client page view moves (decision 8).
//  - a new override. Overrides are retired: a body may only repeat the stored
//    value (in cents), clear it with null, or leave it out.
//  - a malformed line, or a refund line the save did not inherit.
//  - a respelling. Lines a body leaves as stored are not rewritten at all, so
//    their token holds; an override is written as stored, never as sent.

const { ValidationError, ConflictError } = require('../../utils/errors');
const { validateAdjustments, isWholeCents } = require('../../utils/adjustmentRules');
const { isLegalHold } = require('../../utils/legalHold');
const { normalizeVenueState } = require('../../utils/venueAddress');

const PLAIN_DIGITS = /^[0-9]+$/;
const MAX_INT4 = 2147483647; // proposals.id is SERIAL

/** The route id as an integer: plain decimal digits from 1 to int4 max, else 400. */
function parseProposalId(raw) {
  const text = typeof raw === 'number' && Number.isInteger(raw) ? String(raw) : raw;
  const n = typeof text === 'string' && PLAIN_DIGITS.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_INT4) {
    throw new ValidationError({ id: 'Invalid proposal id.' });
  }
  return n;
}

/** 409 LEGAL_HOLD when the booking is held (isLegalHold fails closed). */
function assertNotLegalHold(proposalId) {
  if (isLegalHold(proposalId)) {
    throw new ConflictError('This booking is on legal hold and cannot be edited.', 'LEGAL_HOLD');
  }
}

// The validator's amount reading, without its refusals: blank, null and
// undefined are 0, a string is Number(), anything else as given.
function amountOf(raw) {
  if (raw === '' || raw === null || raw === undefined) return 0;
  if (typeof raw === 'string') return raw.trim() === '' ? 0 : Number(raw);
  return raw;
}

// One line after the validator's coercions, keys in sorted order.
function canonicalLine(adj) {
  if (!adj || typeof adj !== 'object') return adj;
  const line = {
    amount: amountOf(adj.amount),
    label: adj.label === undefined || adj.label === null ? '' : adj.label,
  };
  if (adj.refund_id !== undefined && adj.refund_id !== null) line.refund_id = adj.refund_id;
  if (adj.source !== undefined && adj.source !== null) line.source = adj.source;
  line.type = adj.type;
  line.visible = !!adj.visible;
  return line;
}

/**
 * A stable string of the lines after the validator's coercions, so two
 * spellings of the same lines compare equal ('100' and 100, key order, a
 * missing label or visible). Order is kept: it is the order lines print in.
 * Anything that is not an array reads as no lines.
 */
function canonicalLines(adjustments) {
  return JSON.stringify((Array.isArray(adjustments) ? adjustments : []).map(canonicalLine));
}

/**
 * 409 STALE_EDIT when the body changes the stored lines without the current
 * token. Fails closed: a route that hands it no token is a server bug, never a
 * pass.
 */
function assertLinesFresh(body, oldRow, currentToken) {
  if (!body || body.adjustments === undefined) return;
  if (typeof currentToken !== 'string' || currentToken === '') {
    throw new Error('assertLinesFresh: no current token (the route must select adjustments_token)');
  }
  if (canonicalLines(body.adjustments) === canonicalLines(oldRow && oldRow.adjustments)) return;
  if (body.adjustments_token === currentToken) return;
  throw new ConflictError('This booking changed since you opened it. Reload to see the latest.', 'STALE_EDIT');
}

// Dollars to integer cents, or null for anything that is not a whole-cent
// price: NUMERIC(10,2) rounds '1024.215' to 1024.22, so a half-cent spelling
// could pass a rounded compare and still move the stored cent.
function toCents(value) {
  let n = NaN;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
  return Number.isFinite(n) && isWholeCents(n) ? Math.round(n * 100) : null;
}

/**
 * 400 on total_price_override unless the body leaves it out, clears it with
 * null, or repeats the stored value in cents. pg returns NUMERIC as a string
 * ("3373.00") and a body may send a Number or a string; a stored NULL against
 * any value, 0 included, differs.
 */
function assertOverrideUnchanged(body, oldRow) {
  const sent = body ? body.total_price_override : undefined;
  if (sent === undefined || sent === null) return;
  const sentCents = toCents(sent);
  const storedCents = toCents(oldRow ? oldRow.total_price_override : null);
  if (sentCents === null || storedCents === null || sentCents !== storedCents) {
    throw new ValidationError({ total_price_override: 'Price overrides are retired. Use Set agreed price.' });
  }
}

/**
 * The override the save writes once assertOverrideUnchanged has passed: null
 * when the body clears it, else the STORED value, never the body's spelling.
 */
function overrideToWrite(body, oldRow) {
  if (body && body.total_price_override === null) return null;
  const stored = oldRow ? oldRow.total_price_override : null;
  return stored === undefined ? null : stored;
}

/** The validated lines, 400 naming `adjustments` on a bad one; undefined passes through. */
function normalizeAdjustmentsOrThrow(adjustments) {
  if (adjustments === undefined) return undefined;
  const { value, error } = validateAdjustments(adjustments);
  if (error) throw new ValidationError({ adjustments: error });
  return value;
}

/**
 * 400 on `adjustments` when a body line names a refund_id that no stored
 * refund line of this booking carries, or names one refund_id twice. A save
 * may keep, change or drop the refund lines it was given; only the refund
 * writer adds one, so a save can never mint a refund line or re-point its id.
 */
function assertRefundMarkersBound(adjustments, oldRow) {
  if (!Array.isArray(adjustments)) return; // absent, or refused by the validator
  const stored = new Set((Array.isArray(oldRow && oldRow.adjustments) ? oldRow.adjustments : [])
    .filter((a) => a && a.source === 'refund' && a.refund_id !== undefined && a.refund_id !== null)
    .map((a) => a.refund_id));
  const seen = new Set();
  for (const adj of adjustments) {
    if (!adj || typeof adj !== 'object' || adj.refund_id === undefined || adj.refund_id === null) continue;
    if (!stored.has(adj.refund_id)) {
      throw new ValidationError({ adjustments: 'A refund line can only be kept from the booking, never added here.' });
    }
    if (seen.has(adj.refund_id)) {
      throw new ValidationError({ adjustments: 'A refund can have only one line.' });
    }
    seen.add(adj.refund_id);
  }
}

/**
 * The lines a save writes: the validated body lines when they change the
 * stored ones; the stored lines, as stored, when the body leaves them out or
 * repeats them in another spelling. Writing them back byte for byte keeps
 * their token, so a save that only touched the event never refuses another
 * open tab (prod keeps most amounts as numeric strings, which validation
 * would rewrite as numbers).
 */
function linesToWrite(validatedLines, oldRow) {
  const stored = oldRow && Array.isArray(oldRow.adjustments) ? oldRow.adjustments : [];
  if (validatedLines === undefined) return stored;
  return canonicalLines(validatedLines) === canonicalLines(stored) ? stored : validatedLines;
}

/**
 * The adjustments column value for the UPDATE: null when the lines are the
 * stored ones, so the route keeps the column as it is (COALESCE) and never
 * rewrites it, else the lines as JSON ('[]' when the body empties them).
 */
function adjustmentsColumn(lines, oldRow) {
  return canonicalLines(lines) === canonicalLines(oldRow && oldRow.adjustments) ? null : JSON.stringify(lines);
}

/** Activity-log fields for a save: both arrays when the lines changed, else none. */
function adjustmentsAudit(oldRow, newLines) {
  const before = Array.isArray(oldRow && oldRow.adjustments) ? oldRow.adjustments : [];
  return canonicalLines(newLines) === canonicalLines(before)
    ? {}
    : { old_adjustments: before, new_adjustments: newLines };
}

// ─── The signed terms (audit ESIG-02) ───────────────────────────────────────
// A signature never stands against terms admin changed afterward
// (gratuityMandate.js states it for one field; this is the rule for all of
// them). The decision is pure; signatureVoid.js writes it.

// The statuses a client can sign or pay from. A lifecycle status an admin
// forced onto an unpaid signed row (confirmed, completed) keeps its signature
// like a paid row does: voiding it would leave a row the client can never
// sign again (the sign UPDATE refuses those statuses).
const VOIDABLE_STATUSES = ['sent', 'viewed', 'modified', 'accepted'];

// Dollars to integer cents, null when the value is not money.
function centsOf(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
const numOf = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const pick = (a, b) => (a === null || a === undefined || a === '' ? b : a);

/**
 * The priced terms a booking's snapshot describes, as the signed terms are
 * compared: package, guests, hours, bars, billed bartenders, the add-on set
 * (name, variant, quantity, line total), syrups, the lines and the override.
 * Row columns stand in where a legacy snapshot lacks a field. The total is
 * compared apart, against the total the signature acknowledged.
 */
function pricedTermsOf(snapshot, row = {}) {
  const s = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {};
  const inputs = s.inputs && typeof s.inputs === 'object' ? s.inputs : {};
  return {
    package_id: numOf(pick(s.package && s.package.id, row.package_id)),
    guest_count: numOf(pick(inputs.guestCount, row.guest_count)),
    hours: numOf(pick(inputs.durationHours, row.event_duration_hours)),
    bars: numOf(pick(inputs.numBars, row.num_bars)),
    bartenders: numOf(pick(s.staffing && s.staffing.actual, row.num_bartenders)),
    addons: (Array.isArray(s.addons) ? s.addons : [])
      .map((a) => JSON.stringify([(a && a.name) || null, (a && a.variant) || null, numOf(a && a.quantity) ?? 1, centsOf(a && a.line_total)]))
      .sort(),
    syrups: (s.syrups && Array.isArray(s.syrups.selections) ? s.syrups.selections : []).map(String).sort(),
    adjustments: canonicalLines(pick(s.adjustments, row.adjustments)),
    override: centsOf(pick(s.total_price_override, row.total_price_override)),
  };
}

// The venue the Event-Specific Agreement names (section 1.3: "location"):
// any structured venue field the body sends that differs from the stored one
// (state compared canonical, so 'IL' and 'Illinois' agree), else a free-text
// event_location that differs. A field the body leaves out is not a change.
function venueChanged(body, row) {
  if (!body || typeof body !== 'object') return false;
  const norm = (v) => (v === null || v === undefined ? '' : String(v).trim().toLowerCase());
  const keys = ['venue_name', 'venue_street', 'venue_city', 'venue_state', 'venue_zip'];
  const provided = keys.filter((k) => body[k] !== undefined);
  if (provided.length > 0) {
    return provided.some((k) => {
      const next = k === 'venue_state' ? normalizeVenueState(body[k]) : body[k];
      const prev = k === 'venue_state' ? normalizeVenueState(row[k]) : row[k];
      return norm(next) !== norm(prev);
    });
  }
  if (body.event_location !== undefined && body.event_location !== null) {
    return norm(body.event_location) !== norm(row.event_location);
  }
  return false;
}

/**
 * Why a save must void the client's signature, as the moved terms, or null
 * when the signature stands: the row is signed, holds no money (amount_paid
 * and external_paid both 0; a debit still in flight is the DB-side half of
 * the same rule, signatureVoid.js rowHoldsMoney) and sits in a status the
 * client can sign or pay from, and the save moves a priced term (the new
 * engine snapshot against the stored one), the total the signature
 * acknowledged (client_signed_total, else the row total), or the venue. A
 * row with money keeps its signature (the additional-services flow); its
 * signed snapshot keeps the record either way.
 */
function signatureVoidReason({ old, snapshot, body }) {
  if (!old || old.client_signed_at === null || old.client_signed_at === undefined) return null;
  if (Number(old.amount_paid || 0) > 0 || Number(old.external_paid || 0) > 0) return null;
  if (!VOIDABLE_STATUSES.includes(old.status)) return null;
  const before = pricedTermsOf(old.pricing_snapshot, old);
  const after = pricedTermsOf(snapshot, {});
  const reasons = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  const signedTotal = centsOf(pick(old.client_signed_total, old.total_price));
  if (signedTotal !== null && centsOf(snapshot && snapshot.total) !== signedTotal) reasons.push('total');
  if (venueChanged(body, old)) reasons.push('venue');
  return reasons.length ? reasons : null;
}

module.exports = {
  parseProposalId,
  assertNotLegalHold,
  canonicalLines,
  assertLinesFresh,
  assertOverrideUnchanged,
  overrideToWrite,
  normalizeAdjustmentsOrThrow,
  assertRefundMarkersBound,
  linesToWrite,
  adjustmentsColumn,
  adjustmentsAudit,
  pricedTermsOf,
  signatureVoidReason,
  VOIDABLE_STATUSES,
};

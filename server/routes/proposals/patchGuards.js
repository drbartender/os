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
};

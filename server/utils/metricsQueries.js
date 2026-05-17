/**
 * Pure metrics query builders + filter parsing. No DB, no side effects —
 * the single source of truth for Dashboard/Financials filtering so the two
 * endpoints cannot drift. Mirrors the pricingEngine.js / bookingWindow.js style.
 *
 * Date handling: half-open ranges [from, to+1day) with ::date casts, matching
 * the existing precedent in metadata.js (no explicit TZ constant — Postgres
 * default, consistent with the rest of the date code in this codebase).
 */
const { ValidationError } = require('./errors');

const BASES = ['booked', 'scheduled', 'paid'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(s) {
  if (!ISO.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * @param {{from?:string,to?:string,basis?:string}} q
 * @returns {{from:string|null,to:string|null,basis:string}}
 */
function resolveFilters(q = {}) {
  const basis = q.basis === null || q.basis === undefined || q.basis === '' ? 'booked' : String(q.basis);
  if (!BASES.includes(basis)) {
    const msg = `basis must be one of ${BASES.join(', ')}`;
    throw new ValidationError({ basis: msg }, msg);
  }
  const hasFrom = q.from !== null && q.from !== undefined && q.from !== '';
  const hasTo = q.to !== null && q.to !== undefined && q.to !== '';
  if (!hasFrom && !hasTo) return { from: null, to: null, basis };
  if (hasFrom !== hasTo) {
    const msg = 'both from and to are required for a custom range';
    throw new ValidationError({ from: msg }, msg);
  }
  if (!isRealDate(q.from)) {
    const msg = 'from must be a valid YYYY-MM-DD date';
    throw new ValidationError({ from: msg }, msg);
  }
  if (!isRealDate(q.to)) {
    const msg = 'to must be a valid YYYY-MM-DD date';
    throw new ValidationError({ to: msg }, msg);
  }
  if (q.from > q.to) {
    const msg = 'from must be on or before to';
    throw new ValidationError({ from: msg }, msg);
  }
  return { from: q.from, to: q.to, basis };
}

/**
 * Immediately-preceding equal-length window. null when either bound is null.
 * @returns {{from:string,to:string}|null}
 */
function priorPeriod(from, to) {
  if (!from || !to) return null;
  const DAY = 86400000;
  const f = Date.parse(from + 'T00:00:00Z');
  const t = Date.parse(to + 'T00:00:00Z');
  const lenDays = Math.round((t - f) / DAY) + 1; // inclusive
  const priorTo = new Date(f - DAY);
  const priorFrom = new Date(priorTo.getTime() - (lenDays - 1) * DAY);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { from: iso(priorFrom), to: iso(priorTo) };
}

/**
 * Parameterized half-open date fragment. Pushes onto `params`, returns SQL
 * (leading space). Empty string + untouched params when range is null.
 * `column` is a trusted internal identifier — never user input.
 */
function dateClause(column, from, to, params) {
  if (!from || !to) return '';
  params.push(from);
  const a = params.length;
  params.push(to);
  const b = params.length;
  return ` AND ${column} >= $${a}::date AND ${column} < ($${b}::date + 1)`;
}

/** Number coercion; divides by 100 when the source column is integer cents. */
function toDollars(value, { fromCents = false } = {}) {
  const n = Number(value || 0);
  return fromCents ? n / 100 : n;
}

module.exports = { resolveFilters, priorPeriod, dateClause, toDollars, BASES };

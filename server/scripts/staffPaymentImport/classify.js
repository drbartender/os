// Row classifier — turns a staging row into a proposed verdict for the review
// sheet. Order: funding → ignore-patterns → agencies → dictionary hit → unsure.
//
// classify(row, dict) → { verdict:'staff-pay'|'ignore'|'unsure', person, confidence, reason }
const { normalizeName } = require('./staging');

// Case-insensitive substrings on payee + memo → auto-ignore (merchant/personal).
const IGNORE_PATTERNS = [
  'lyft', 'uber', 'massage', 'gift', 'cash app card order',
  'allegiant', 'coach usa', 'wildsky books',
];
// Staffing agencies — real work, but paid as an agency invoice, not a 1099 payee.
const AGENCIES = ['qwick'];

function classify(row, dict) {
  if (row.kind === 'funding') {
    return { verdict: 'ignore', person: null, confidence: 'high', reason: 'funding' };
  }

  const hay = `${row.payee || ''} ${row.memo || ''}`.toLowerCase();

  for (const pat of IGNORE_PATTERNS) {
    if (hay.includes(pat)) {
      return { verdict: 'ignore', person: null, confidence: 'high', reason: `pattern:${pat}` };
    }
  }
  for (const ag of AGENCIES) {
    if (normalizeName(row.payee || '').includes(ag) || hay.includes(ag)) {
      return { verdict: 'ignore', person: null, confidence: 'high', reason: 'agency' };
    }
  }

  const person = dict && typeof dict.resolve === 'function' ? dict.resolve(row.payee) : null;
  if (person) {
    return { verdict: 'staff-pay', person, confidence: 'high', reason: 'dictionary' };
  }

  return { verdict: 'unsure', person: null, confidence: 'low', reason: 'unknown' };
}

module.exports = { classify, IGNORE_PATTERNS, AGENCIES };

// Cash App PDF parser (business + personal accounts). Cash App statements have
// no transaction ids and no memos, so rows fingerprint positionally (seq).
//
// parseCashappText(text, { sourceFile, sourceAccount }) → row[]  (pure)
// parseCashappPdf(filePath, opts) → runs `pdftotext -layout` then parseCashappText.
//
// Row shape (pdftotext -layout), " from <bank>" optional:
//   Jun 10   To Test Person from Chase Bank x0000   Cash App payment   $0.00   $170.00
// Direction is "To" (outgoing). "From" rows, "Cash App Card Order", card/instant
// transfers, and canceled payments are all dropped. Date = row month/day + the
// statement year from the header line ("June 2025").
const { execFileSync } = require('child_process');
const path = require('path');
const { makeRow, parseMoney, normalizeName } = require('../staging');
const { MONTH_NAMES } = require('../config');

const MONTH_ABBR = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// System/non-person "To" destinations that are not staff payments.
const NON_PERSON = new Set(['cash app card order']);

function statementYearMonth(text) {
  const re = new RegExp(`^\\s*(${MONTH_NAMES.join('|')})\\s+(20\\d\\d)\\s*$`, 'i');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(re);
    if (m) return { month: MONTH_NAMES.indexOf(m[1].toLowerCase()) + 1, year: +m[2] };
  }
  return { month: null, year: null };
}

function parseCashappText(text, { sourceFile, sourceAccount }) {
  const { year: stmtYear, month: stmtMonth } = statementYearMonth(text);
  // No resolvable statement year → we cannot date any row (would emit
  // "null-06-10"). Fail loudly so the orchestrator records it and emits nothing.
  if (stmtYear === null) {
    throw new Error(`cashapp: statement year not found in ${sourceFile || 'input'}`);
  }
  const rows = [];
  // seq per identical (date,amount,payee) tuple within this file.
  const seqCounter = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    const dateM = line.match(/^\s*([A-Z][a-z]{2})\s+(\d{1,2})\s+(To\s+.*)$/);
    if (!dateM) continue;
    const mon = MONTH_ABBR[dateM[1].toLowerCase()];
    const day = +dateM[2];
    if (!mon) continue;
    const rest = dateM[3];
    // "To <payee>  Cash App payment  $<fee>  $<amount>" (not canceled)
    const m = rest.match(/^To\s+(.+?)\s{2,}Cash App payment(?!\s*\(canceled\))\s+\$[\d,]+\.\d{2}\s+\$([\d,]+\.\d{2})\s*$/);
    if (!m) continue;
    const payee = m[1].replace(/\s+from\s+.*$/i, '').trim();
    if (!payee || NON_PERSON.has(normalizeName(payee))) continue;
    const amountCents = parseMoney(`$${m[2]}`);
    if (!amountCents || amountCents <= 0) continue;
    // Year: single-month statements never span, but guard the Dec-in-Jan case.
    let year = stmtYear;
    if (year !== null && stmtMonth !== null && mon > stmtMonth) year -= 1;
    const date = `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const key = `${date}|${amountCents}|${normalizeName(payee)}`;
    const seq = seqCounter.get(key) || 0;
    seqCounter.set(key, seq + 1);
    rows.push(makeRow({
      date, amountCents, platform: 'cashapp', sourceAccount,
      payee, memo: null, txnId: null, sourceFile, seq, kind: 'payment',
    }));
  }
  return rows;
}

function parseCashappPdf(filePath, { sourceAccount }) {
  const text = execFileSync('pdftotext', ['-layout', filePath, '-'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return parseCashappText(text, { sourceFile: path.basename(filePath), sourceAccount });
}

module.exports = { parseCashappText, parseCashappPdf, statementYearMonth };

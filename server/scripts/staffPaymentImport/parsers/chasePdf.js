// Chase statement parser — Zelle PRIMARY payments plus Venmo/CashApp/PayPal
// funding MIRRORS (spec §3). Zelle is the primary record for a Zelle payment;
// the ACH/card mirrors are `funding` (excluded from import, but kept as a
// completeness cross-check: a mirror with no matching primary = missing export).
//
// parseChaseText(text, { sourceFile, sourceAccount, statementYear, statementMonth }) → row[]
// parseChasePdf(filePath, { sourceAccount }) → pdftotext -layout then parse.
//
// pdftotext -layout wraps each transaction to 1-2 lines: the date line carries
// the amount; a continuation line may carry `Paypalsec:Web` (the only PayPal
// tell), so rows are grouped into blocks (date line + continuations) before
// classification.
const { execFileSync } = require('child_process');
const path = require('path');
const { makeRow, parseMoney } = require('../staging');
const { parseStatementPeriod } = require('../config');

const DATE_LED = /^\s*(\d{2})\/(\d{2})\b/;

function lastAmount(line) {
  const matches = line.match(/[\d,]+\.\d{2}/g);
  return matches ? parseMoney(matches[matches.length - 1]) : null;
}

// The withdrawal amount, robust across account layouts: business statements
// (6835/7570) show a single unsigned amount per row; the personal statement
// (8700) shows a SIGNED debit plus a trailing running-balance column. So a
// signed-negative decimal is always the amount; otherwise the row has one
// amount and no balance, so the last decimal is it.
function withdrawalAmount(line) {
  const signed = line.match(/-\s?([\d,]+\.\d{2})/);
  if (signed) return Math.abs(parseMoney(signed[1]));
  return lastAmount(line);
}

function resolveYear(month, statementYear, statementMonth) {
  if (statementYear === null || statementYear === undefined) return null;
  // A row month later than the statement month belongs to the prior year
  // (a Dec row inside a January-dated statement).
  if (statementMonth && month > statementMonth) return statementYear - 1;
  return statementYear;
}

function parseChaseText(text, { sourceFile, sourceAccount, statementYear, statementMonth }) {
  // Without a statement year we cannot date any MM/DD row — fail loudly rather
  // than silently drop every row (the orchestrator records it in ERRORS).
  if (statementYear === null || statementYear === undefined) {
    throw new Error(`chase: statement year unknown for ${sourceFile || 'input'}`);
  }
  const lines = text.split(/\r?\n/);
  const rows = [];
  let seq = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const dm = line.match(DATE_LED);
    if (!dm) continue;
    // gather continuation lines (non-date, non-blank) for block classification
    const blockLines = [line];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (DATE_LED.test(lines[j]) || lines[j].trim() === '') break;
      blockLines.push(lines[j]);
    }
    const block = blockLines.join('\n');
    const month = +dm[1];
    const day = +dm[2];
    const year = resolveYear(month, statementYear, statementMonth);
    if (!year) continue;
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    // 1) Zelle primary payment: "Zelle Payment To <name> [<ref>] <amount> [<balance>]"
    //    Layout varies by account (see withdrawalAmount): the ref id is the last
    //    alphanumeric-with-digit token before the amount; some rows have no ref.
    const zm = line.match(/Zelle Payment To (.+)$/);
    if (zm && !/Zelle Payment (From|Reversal)/i.test(line)) {
      const rest = zm[1];
      // Amount is a signed debit if present, else the first amount; either may
      // carry a "$" prefix (some Chase rows do, most don't). Match index points
      // at the sign/"$" so the pre-amount slice never keeps the "$".
      let amt = rest.match(/-\s?\$?([\d,]+\.\d{2})/); // signed debit
      if (!amt) amt = rest.match(/\$?([\d,]+\.\d{2})/); // else first (only) amount
      if (amt) {
        const amountCents = Math.abs(parseMoney(amt[1]));
        const before = rest.slice(0, amt.index).replace(/[-$\s]+$/, '').trim();
        const tokens = before.split(/\s+/).filter(Boolean);
        let txnId = null;
        const last = tokens[tokens.length - 1];
        if (tokens.length > 1 && last && /[0-9]/.test(last) && /^[A-Za-z0-9]{6,}$/.test(last)) {
          txnId = tokens.pop();
        }
        const payee = tokens.join(' ') || null;
        if (amountCents > 0) {
          rows.push(makeRow({
            date, amountCents, platform: 'zelle', sourceAccount,
            payee, memo: null, txnId, sourceFile, seq: seq++, kind: 'payment',
          }));
        }
      }
      continue;
    }

    // 2) Cash App card mirror: outgoing "Payment Sent ... Cash App*<cardholder> ... Card <n>".
    //    "Payment Received" rows are incoming (refunds) and are dropped.
    if (/Cash App\*/.test(block) && /Payment Sent/i.test(block)) {
      const amountCents = withdrawalAmount(line);
      if (amountCents && amountCents > 0) {
        let payee = null;
        const nm = block.match(/Cash App\*(.+?)\s+[A-Za-z]+\s+[A-Z]{2}\s+Card\b/);
        if (nm) payee = nm[1].trim();
        else {
          const nm2 = block.match(/Cash App\*([A-Za-z .'-]+)/);
          if (nm2) payee = nm2[1].trim();
        }
        rows.push(makeRow({
          date, amountCents, platform: 'zelle', sourceAccount,
          payee, memo: null, txnId: null, sourceFile, seq: seq++,
          kind: 'funding', fundingOf: 'cashapp',
        }));
      }
      continue;
    }

    // 3) Venmo ACH funding mirror
    if (/Orig CO Name:Venmo\b/i.test(block)) {
      const amountCents = withdrawalAmount(line);
      if (amountCents && amountCents > 0) {
        rows.push(makeRow({
          date, amountCents, platform: 'zelle', sourceAccount,
          payee: null, memo: null, txnId: null, sourceFile, seq: seq++,
          kind: 'funding', fundingOf: 'venmo',
        }));
      }
      continue;
    }

    // 4) PayPal funding mirror (tell is `Paypalsec:Web` on the continuation line,
    //    or the older `Orig CO Name:Paypal`)
    if (/Paypalsec:Web/i.test(block) || /Orig CO Name:Paypal\b/i.test(block)) {
      const amountCents = withdrawalAmount(line);
      if (amountCents && amountCents > 0) {
        rows.push(makeRow({
          date, amountCents, platform: 'zelle', sourceAccount,
          payee: null, memo: null, txnId: null, sourceFile, seq: seq++,
          kind: 'funding', fundingOf: 'paypal',
        }));
      }
      continue;
    }
    // everything else (deposits, ordinary debits, fees) is dropped
  }
  return rows;
}

function parseChasePdf(filePath, { sourceAccount }) {
  const text = execFileSync('pdftotext', ['-layout', filePath, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const { year, month } = parseStatementPeriod(path.basename(filePath));
  return parseChaseText(text, { sourceFile: path.basename(filePath), sourceAccount, statementYear: year, statementMonth: month });
}

module.exports = { parseChaseText, parseChasePdf, lastAmount };

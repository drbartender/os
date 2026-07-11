// Staff payment import — the staging row: one identical shape produced by every
// parser, plus the money parser and the fingerprint rule (spec §5). Pure, no DB.
//
// Fingerprint (row identity, deduped by row_fingerprint UNIQUE):
//   - txn-id present (Venmo/Zelle/PayPal) → sha256("v1|"+platform+"|"+txnId)
//     — stable across re-exports and file reordering.
//   - txn-id absent (Cash App PDFs)       → positional hash over
//     platform|account|date|amountCents|payeeNorm|memo|seq, where `seq` is the
//     0-based index of identical (date,amount,payee) tuples in one file — so
//     same-day duplicate payments stay distinct.
// DEVIATION from spec §5 / plan B1: sourceFile is intentionally NOT in the
// id-less hash. Cash App statements are re-exported under different file names
// (".../October 2025 (1).pdf") with identical transactions but different bytes,
// which byte-level content-hash dedupe misses; a payment's date pins it to one
// statement month, so dropping sourceFile lets those re-export rows collapse to
// one fingerprint (spec §2 "one row per unique payment"), while seq still keeps
// genuine same-day duplicates distinct.
// Stored/display form is "fp-"+hash (the fp- prefix forces text cells in Excel
// and is part of the persisted row_fingerprint).

const crypto = require('crypto');

// "$1,043.74" → 104374 ; "- $105.00" → -10500 ; "204.99" → 20499.
// Sign is taken from a leading "-" (with or without a space before the $).
function parseMoney(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  const negative = /^-/.test(s) || /^\(\s*\$?/.test(s); // "-..." or "($...)"
  const digits = s.replace(/[^0-9.]/g, '');
  if (digits === '' || digits === '.') return null;
  const cents = Math.round(parseFloat(digits) * 100);
  if (Number.isNaN(cents)) return null;
  return negative ? -cents : cents;
}

// Normalize a person/handle name for fingerprinting + clustering:
// lowercase, strip punctuation/emoji, collapse whitespace.
function normalizeName(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/['’.]/g, '')             // O'Brien → obrien ; St. John → st john
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // remaining punctuation + emoji → space (hyphen = word boundary)
    .replace(/\s+/g, ' ')
    .trim();
}

function sha32(input) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 32);
}

function fingerprint({ platform, sourceAccount, date, amountCents, payee, memo, txnId, sourceFile, seq }) {
  let hash;
  if (txnId !== null && txnId !== undefined && String(txnId).trim() !== '') {
    hash = sha32(`v1|${platform}|${String(txnId).trim()}`);
  } else {
    const parts = [
      'v1', platform, sourceAccount, date, amountCents,
      normalizeName(payee), memo || '', seq === undefined ? 0 : seq,
    ].join('|');
    hash = sha32(parts);
  }
  return `fp-${hash}`;
}

// Build one frozen staging row. `kind` ∈ 'payment'|'funding'|'other'.
function makeRow({
  date, amountCents, platform, sourceAccount, payee = null, memo = null,
  txnId = null, sourceFile, seq = 0, kind = 'payment',
  // optional evidence carried by some parsers:
  payeeEmail = null, fundingOf = null, unresolvedCurrency = false,
}) {
  const row = {
    date,
    amountCents,
    platform,
    sourceAccount,
    payee,
    payeeEmail,
    memo,
    txnId: txnId === undefined ? null : txnId,
    sourceFile,
    seq,
    kind,
    fundingOf,
    unresolvedCurrency,
    fingerprint: fingerprint({ platform, sourceAccount, date, amountCents, payee, memo, txnId, sourceFile, seq }),
  };
  return Object.freeze(row);
}

module.exports = { parseMoney, normalizeName, fingerprint, makeRow, sha32 };

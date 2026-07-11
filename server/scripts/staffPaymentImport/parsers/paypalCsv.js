// PayPal CSV parser — person payments only ("General Payment" + "Mobile
// Payment", Completed, negative Gross). Foreign (PHP) payments to Zul store the
// USD cost, resolved from the linked "General Currency Conversion" USD row that
// back-references the payment's Transaction ID (spec §2). A raw PHP magnitude is
// NEVER stored as USD; unresolvable rows carry amountCents:null +
// unresolvedCurrency:true so B7 surfaces them (never a silent drop).
//
// parsePaypalCsv(filePath, { sourceAccount }) → row[]
const fs = require('fs');
const path = require('path');
const { parseCsv } = require('./csvUtil');
const { makeRow, parseMoney } = require('../staging');

const PERSON_TYPES = new Set(['General Payment', 'Mobile Payment']);

function toIso(dateStr) {
  const m = String(dateStr).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function parsePaypalCsv(filePath, { sourceAccount }) {
  const text = fs.readFileSync(filePath, 'utf8'); // parseCsv strips the BOM
  const sourceFile = path.basename(filePath);
  const records = parseCsv(text);
  if (!records.length) throw new Error(`paypal: empty file ${sourceFile}`);
  const header = records[0].map((c) => c.trim());
  const col = {};
  header.forEach((name, idx) => { col[name] = idx; });
  // Loud failure on a structurally wrong export (vs a valid file with 0 payments).
  for (const required of ['Type', 'Status', 'Currency', 'Gross', 'Transaction ID']) {
    if (col[required] === undefined) {
      throw new Error(`paypal: required column "${required}" missing in ${sourceFile}`);
    }
  }
  const get = (rec, name) => (col[name] !== undefined ? (rec[col[name]] || '').trim() : '');

  // Pass 1: index the USD currency-conversion rows for PHP→USD resolution.
  const convByRef = new Map();      // payment Transaction ID → USD conversion Gross
  const convByDateTime = new Map(); // fallback: Date|Time → USD conversion Gross
  for (let i = 1; i < records.length; i += 1) {
    const rec = records[i];
    if (get(rec, 'Type') !== 'General Currency Conversion') continue;
    if (get(rec, 'Currency') !== 'USD') continue;
    const gross = get(rec, 'Gross');
    const ref = get(rec, 'Reference Txn ID');
    if (ref) convByRef.set(ref, gross);
    const key = `${get(rec, 'Date')}|${get(rec, 'Time')}`;
    if (!convByDateTime.has(key)) convByDateTime.set(key, gross);
  }

  // Pass 2: emit person payments.
  const rows = [];
  let seq = 0;
  for (let i = 1; i < records.length; i += 1) {
    const rec = records[i];
    const type = get(rec, 'Type');
    if (!PERSON_TYPES.has(type)) continue;
    if (get(rec, 'Status') !== 'Completed') continue;
    const gross = parseMoney(get(rec, 'Gross'));
    if (gross === null || gross >= 0) continue; // outgoing (negative) only
    const currency = get(rec, 'Currency');
    const txnId = get(rec, 'Transaction ID') || null;
    const date = toIso(get(rec, 'Date'));
    if (!date) continue;

    let amountCents = null;
    let unresolvedCurrency = false;
    if (currency === 'USD') {
      amountCents = Math.abs(gross);
    } else {
      let usd = txnId && convByRef.has(txnId) ? convByRef.get(txnId) : null;
      if (usd === null) usd = convByDateTime.get(`${get(rec, 'Date')}|${get(rec, 'Time')}`) || null;
      if (usd !== null) {
        amountCents = Math.abs(parseMoney(usd));
      } else {
        unresolvedCurrency = true; // never store a raw PHP magnitude as USD
      }
    }

    rows.push(makeRow({
      date,
      amountCents,
      platform: 'paypal',
      sourceAccount,
      payee: get(rec, 'Name') || null,
      payeeEmail: get(rec, 'To Email Address') || null,
      memo: null,
      txnId,
      sourceFile,
      seq: seq++,
      kind: 'payment',
      unresolvedCurrency,
    }));
  }
  return rows;
}

module.exports = { parsePaypalCsv, toIso };

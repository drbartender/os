// Venmo CSV parser — business (Dr. Bartending LLC) AND personal (@Dallas-Raby)
// layouts. Emits only outgoing completed payments as staging rows; everything
// else (incoming, merchant, transfers, disclaimers) is dropped.
//
// Business layout: header starts "Transaction ID,Date,...", Date = MM/DD/YYYY,
//   txn id triple-quoted ("""123""" → literal-quoted "123", stripped here).
// Personal layout: two title rows, header has an empty first column
//   (",ID,Datetime,..."), combined ISO Datetime column (date = first 10 chars).
//
// Interface: parseVenmoCsv(filePath, { sourceAccount }) → row[]
const fs = require('fs');
const path = require('path');
const { parseCsv } = require('./csvUtil');
const { makeRow, parseMoney } = require('../staging');

function toIso(dateStr) {
  const s = String(dateStr).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/); // ISO or ISO datetime
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // MM/DD/YYYY
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  return null;
}

// Find the header record (has both an ID column and "Amount (total)").
function findHeader(records) {
  for (let i = 0; i < Math.min(records.length, 6); i += 1) {
    const rec = records[i];
    const hasAmount = rec.some((c) => c.trim() === 'Amount (total)');
    const hasId = rec.some((c) => /(^|\s)ID$/i.test(c.trim()));
    if (hasAmount && hasId) return i;
  }
  return -1;
}

function colMap(header) {
  const map = {};
  header.forEach((name, idx) => { map[name.trim()] = idx; });
  // canonical accessors
  const idKey = Object.keys(map).find((k) => /(^|\s)ID$/i.test(k));
  const dateKey = map.Date !== undefined ? 'Date' : (map.Datetime !== undefined ? 'Datetime' : null);
  return { map, idKey, dateKey };
}

function parseVenmoCsv(filePath, { sourceAccount }) {
  const text = fs.readFileSync(filePath, 'utf8');
  const sourceFile = path.basename(filePath);
  const records = parseCsv(text);
  const hIdx = findHeader(records);
  // A structurally unreadable file is a loud failure, not a silent 0 rows: a
  // valid statement with no outgoing payments still has a header (returns []).
  if (hIdx === -1) throw new Error(`venmo: header row not found in ${sourceFile}`);
  const header = records[hIdx];
  const { map, idKey, dateKey } = colMap(header);
  const iType = map.Type;
  const iStatus = map.Status;
  const iNote = map.Note;
  const iTo = map.To;
  const iAmt = map['Amount (total)'];
  if (iType === undefined || iAmt === undefined) {
    throw new Error(`venmo: required columns (Type/Amount) missing in ${sourceFile}`);
  }

  const rows = [];
  let seq = 0;
  for (let i = hIdx + 1; i < records.length; i += 1) {
    const rec = records[i];
    if (!rec || rec.length <= iAmt) continue;
    const type = (rec[iType] || '').trim();
    const status = (rec[iStatus] || '').trim();
    if (type !== 'Payment') continue;
    if (status !== 'Complete' && status !== 'Completed') continue;
    const amount = parseMoney(rec[iAmt]);
    if (amount === null || amount >= 0) continue; // outgoing only (negative)
    const rawId = idKey !== undefined && map[idKey] !== undefined ? (rec[map[idKey]] || '') : '';
    const txnId = rawId.replace(/^"+|"+$/g, '').trim() || null;
    const date = dateKey ? toIso(rec[map[dateKey]]) : null;
    if (!date) continue;
    rows.push(makeRow({
      date,
      amountCents: Math.abs(amount),
      platform: 'venmo',
      sourceAccount,
      payee: (rec[iTo] || '').trim() || null,
      memo: iNote !== undefined ? ((rec[iNote] || '').trim() || null) : null,
      txnId,
      sourceFile,
      seq: seq++,
      kind: 'payment',
    }));
  }
  return rows;
}

module.exports = { parseVenmoCsv, toIso };

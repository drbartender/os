// Opportunistic event attribution (spec §7). Best evidence wins:
//   a. CC expense: same payee-cluster, |amount| exact, |date| ≤ 5 days → booking label
//   b. memo: a date token (M/D) or a " - <suffix>" → memo-derived label
//   c. CC booking proximity: payee in Assigned Staff, payment 0–7 days after Event Date → "<title> (inferred)"
//   d. none → null (acceptable)
//
// matchEvents(rows, { ccExpenses, ccBookings }, dict?) → new rows with
//   eventLabel + eventEvidence ('cc-expense'|'memo'|'inferred'|null).
const { normalizeName } = require('./staging');

function daysBetween(isoA, isoB) {
  const a = Date.parse(`${String(isoA).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(isoB).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / 86400000);
}

function keyFor(name, dict) {
  if (dict && typeof dict.resolve === 'function') {
    const k = dict.resolve(name);
    if (k) return k;
  }
  return normalizeName(name);
}

function memoLabel(memo) {
  if (!memo) return null;
  const dash = memo.match(/\s-\s+(.+)$/);
  if (dash) return dash[1].trim();
  if (/\b\d{1,2}\/\d{1,2}\b/.test(memo)) return memo.trim();
  return null;
}

function matchEvents(rows, { ccExpenses = [], ccBookings = [] } = {}, dict) {
  return rows.map((row) => {
    if (row.kind && row.kind !== 'payment') {
      return { ...row, eventLabel: null, eventEvidence: null };
    }
    const payeeKey = keyFor(row.payee, dict);

    // a. CC expense exact match (payee cluster + exact amount + ≤5 days)
    const exp = ccExpenses.find((e) => e.amountCents === row.amountCents
      && keyFor(e.payee, dict) === payeeKey
      && e.date && row.date && Math.abs(daysBetween(row.date, e.date)) <= 5);
    if (exp && exp.bookingTitle) {
      const label = exp.bookingDate ? `${exp.bookingTitle} (${exp.bookingDate})` : exp.bookingTitle;
      return { ...row, eventLabel: label, eventEvidence: 'cc-expense' };
    }

    // b. memo-derived
    const ml = memoLabel(row.memo);
    if (ml) return { ...row, eventLabel: ml, eventEvidence: 'memo' };

    // c. CC booking proximity (0–7 days after event, payee assigned)
    const bk = ccBookings.find((b) => {
      if (!b.eventDate || !row.date) return false;
      const d = daysBetween(row.date, b.eventDate);
      if (d === null || d < 0 || d > 7) return false;
      return b.assignedStaff.some((s) => keyFor(s, dict) === payeeKey);
    });
    if (bk) return { ...row, eventLabel: `${bk.title} (inferred)`, eventEvidence: 'inferred' };

    return { ...row, eventLabel: null, eventEvidence: null };
  });
}

module.exports = { matchEvents, memoLabel, daysBetween };

// Minimal RFC-4180 CSV parser (no new deps). Handles quoted fields containing
// commas and embedded newlines, and "" escaped quotes. Strips a leading BOM.
// Returns an array of records; each record is an array of string fields.
function parseCsv(text) {
  let s = String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // strip BOM
  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  let sawAny = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1; } // escaped quote
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
      sawAny = true;
    } else if (c === ',') {
      record.push(field); field = ''; sawAny = true;
    } else if (c === '\r') {
      // handled by \n; skip
    } else if (c === '\n') {
      record.push(field); records.push(record);
      field = ''; record = []; sawAny = false;
    } else {
      field += c; sawAny = true;
    }
  }
  // flush trailing field/record (file without final newline)
  if (sawAny || field !== '' || record.length) {
    record.push(field);
    records.push(record);
  }
  return records;
}

module.exports = { parseCsv };

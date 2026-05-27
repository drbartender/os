const fs = require('fs');
const { parse } = require('csv-parse/sync');

function loadCsv(absPath) {
  const text = fs.readFileSync(absPath, 'utf8');
  return parse(text, { columns: true, relax_quotes: true, relax_column_count: true, skip_empty_lines: true });
}

module.exports = { loadCsv };

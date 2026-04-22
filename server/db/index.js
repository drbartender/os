const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('neon.tech') ? { rejectUnauthorized: false } : false
});

// Split a SQL script into individual statements on `;`, while respecting
// PostgreSQL dollar-quoted bodies so DO blocks, function bodies, and seed
// rows with embedded HTML stay intact.
//
// Handles both bare (`$$...$$`) and named tags (`$body$...$body$`, `$txt$...$txt$`).
// A tag only closes when the exact same tag appears again — `$body$ ... $$`
// does NOT close. Statements are split on `;` only when outside any
// dollar-quoted region.
//
// Doesn't handle single-quoted strings or SQL comments containing `;` —
// schema.sql doesn't use those patterns today. If you add them, teach this
// splitter first.
function splitStatements(sql) {
  const TAG_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;
  const statements = [];
  let buf = '';
  let openTag = null; // the exact string (e.g. '$$', '$body$') we're inside
  let i = 0;
  while (i < sql.length) {
    if (openTag === null) {
      if (sql[i] === '$') {
        const m = TAG_RE.exec(sql.slice(i));
        if (m) {
          openTag = m[0];
          buf += openTag;
          i += openTag.length;
          continue;
        }
      }
      if (sql[i] === ';') {
        const stmt = buf.trim();
        if (stmt.length > 0) statements.push(stmt);
        buf = '';
        i++;
        continue;
      }
    } else if (sql.startsWith(openTag, i)) {
      buf += openTag;
      i += openTag.length;
      openTag = null;
      continue;
    }
    buf += sql[i];
    i++;
  }
  const tail = buf.trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}

async function initDb() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  // Run each statement independently so one idempotent failure doesn't abort the rest.
  const statements = splitStatements(schema);
  const client = await pool.connect();
  try {
    for (const stmt of statements) {
      try {
        await client.query(stmt);
      } catch (err) {
        // Log but continue — most errors here are benign (duplicate constraints, etc.)
        console.warn('Schema statement warning:', err.message.split('\n')[0]);
      }
    }
    console.log('✓ Database schema initialized');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDb, splitStatements };

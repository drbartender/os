const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('neon.tech') ? { rejectUnauthorized: false } : false
});

// Split a SQL script into individual statements on `;`, while respecting
// `$$ ... $$` dollar-quoted bodies so DO blocks and function definitions
// stay intact. A naive `.split(';')` shreds every DO block that contains
// inner semicolons (END IF;, ALTER TABLE ... ;), so every fragment fails.
function splitStatements(sql) {
  const statements = [];
  let buf = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === '$' && sql[i + 1] === '$') {
      inDollar = !inDollar;
      buf += '$$';
      i++;
      continue;
    }
    if (sql[i] === ';' && !inDollar) {
      const stmt = buf.trim();
      if (stmt.length > 0) statements.push(stmt);
      buf = '';
      continue;
    }
    buf += sql[i];
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

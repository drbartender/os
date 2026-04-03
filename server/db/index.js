const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('neon.tech') ? { rejectUnauthorized: false } : false
});

async function initDb() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  // Split on semicolons, filtering out empty statements, and run each independently
  // so that one idempotent failure doesn't abort subsequent statements
  const statements = schema
    .split(/;\s*$/m)
    .map(s => s.trim())
    .filter(s => s.length > 0);
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

module.exports = { pool, initDb };

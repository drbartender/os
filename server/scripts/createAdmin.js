// One-off script to grant admin access to a user.
//
// Usage:
//   ADMIN_EMAIL=zul@drbartender.com node server/scripts/createAdmin.js
//   ADMIN_EMAIL=zul@drbartender.com ADMIN_PASSWORD='Sup3rSecret!' node server/scripts/createAdmin.js
//
// Behavior:
//   - User already exists: promotes role to 'admin' and sets onboarding_status
//     to 'approved'. Password is left untouched unless ADMIN_PASSWORD is set,
//     in which case it is reset to that value.
//   - User does not exist: ADMIN_PASSWORD is required and a new admin user
//     is created.
//
// Run locally with DATABASE_URL pointing at the target database.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

async function createAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;

  if (!email) {
    console.error('ERROR: ADMIN_EMAIL environment variable is required.');
    process.exit(1);
  }

  const existing = await pool.query(
    'SELECT id, email, role FROM users WHERE email = $1',
    [email]
  );

  if (existing.rows.length > 0) {
    const user = existing.rows[0];
    if (password) {
      const hash = await bcrypt.hash(password, 12);
      await pool.query(
        `UPDATE users
            SET role = 'admin',
                onboarding_status = 'approved',
                password_hash = $1,
                token_version = COALESCE(token_version, 0) + 1,
                updated_at = NOW()
          WHERE id = $2`,
        [hash, user.id]
      );
      console.log(`✓ Promoted ${user.email} to admin and reset password.`);
    } else {
      await pool.query(
        `UPDATE users
            SET role = 'admin',
                onboarding_status = 'approved',
                updated_at = NOW()
          WHERE id = $1`,
        [user.id]
      );
      console.log(`✓ Promoted ${user.email} to admin (password unchanged).`);
    }
    process.exit(0);
  }

  if (!password) {
    console.error(
      `ERROR: No user found for ${email}. ADMIN_PASSWORD is required to create a new admin.`
    );
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, $2, 'admin', 'approved')`,
    [email, hash]
  );
  console.log(`✓ Created new admin: ${email}`);
  process.exit(0);
}

createAdmin().catch((err) => {
  console.error('createAdmin error:', err);
  process.exit(1);
});

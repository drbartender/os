const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const bcrypt = require('bcryptjs');
const { pool, initDb } = require('./index');

async function seed() {
  try {
    await initDb();

    // Create admin account
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@drbartender.com';
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword) {
      console.error('ERROR: ADMIN_PASSWORD environment variable is required. Aborting seed.');
      process.exit(1);
    }
    const hash = await bcrypt.hash(adminPassword, 12);

    await pool.query(`
      INSERT INTO users (email, password_hash, role, onboarding_status)
      VALUES ($1, $2, 'admin', 'approved')
      ON CONFLICT (email) DO UPDATE SET password_hash = $2
    `, [adminEmail, hash]);

    console.log(`✓ Admin account seeded: ${adminEmail}`);
    console.log('  ⚠️  Change this password in production!');
    process.exit(0);
  } catch (err) {
    console.error('Seed error:', err);
    process.exit(1);
  }
}

seed();

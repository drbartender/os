// One-off, READ-ONLY export of OS people → <review-dir>/known-people.csv.
// The ONLY pipeline file that touches a DB. Seeds the payee dictionary with OS
// user ids + onboarding status, and feeds the review sheet's phone-collision
// check (a stale CC phone must not shadow a real `approved` staffer).
//
// Usage (run at OPERATION time, against the target DB):
//   DATABASE_URL=... node server/scripts/staffPaymentImport/exportKnownPeople.js \
//     --review-dir "$HOME/win-share/payments/review"
//
// Note the nesting: this file sits one level deeper than createAdmin.js, so the
// DB import is ../../db and dotenv is ../../../.env (createAdmin's ../db throws).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const fs = require('fs');
const { pool } = require('../../db');

function reviewDirFromArgv(argv) {
  const i = argv.indexOf('--review-dir');
  const raw = i !== -1 && argv[i + 1] ? argv[i + 1] : path.join(process.env.HOME || '.', 'win-share/payments/review');
  return path.resolve(raw.replace(/^~(?=$|\/)/, process.env.HOME || '~'));
}

// CSV-escape a single field (quote if it contains comma/quote/newline).
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const reviewDir = reviewDirFromArgv(process.argv.slice(2));
  fs.mkdirSync(reviewDir, { recursive: true });

  // staff + manager (both work paid shifts) + admin (Zul is an admin payee);
  // all onboarding statuses. Role enum is ('staff','admin','manager') per
  // schema.sql (users_role_check).
  const { rows } = await pool.query(`
    SELECT u.id AS user_id,
           COALESCE(cp.preferred_name, u.email) AS name,
           cp.preferred_name,
           COALESCE(cp.email, u.email) AS email,
           cp.phone,
           u.onboarding_status
      FROM users u
      LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
     WHERE u.role IN ('staff', 'admin', 'manager')
     ORDER BY u.id
  `);

  const header = 'user_id,name,preferred_name,email,phone,onboarding_status';
  const lines = rows.map((r) => [
    r.user_id, r.name, r.preferred_name, r.email, r.phone, r.onboarding_status,
  ].map(csvCell).join(','));
  const outPath = path.join(reviewDir, 'known-people.csv');
  fs.writeFileSync(outPath, `${header}\n${lines.join('\n')}\n`);
  console.log(`[exportKnownPeople] wrote ${rows.length} people → ${outPath}`);
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[exportKnownPeople] failed:', err.message);
    process.exit(1);
  });

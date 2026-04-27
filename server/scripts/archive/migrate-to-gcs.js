// ARCHIVED 2026-04-27. One-time migration; do not re-run without reading.
// Original purpose: upload local files from server/uploads/ to GCS (pre-R2 era).

/**
 * One-time migration: upload existing local files to Google Cloud Storage.
 * Run from the project root: node server/scripts/migrate-to-gcs.js
 * Requires GCS env vars to be set (see README or .env).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { uploadFile } = require('../utils/storage');

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './server/uploads');

async function migrate() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    console.log('No uploads directory found — nothing to migrate.');
    return;
  }

  const files = fs.readdirSync(UPLOAD_DIR).filter(f => !f.startsWith('.'));
  if (files.length === 0) {
    console.log('Uploads directory is empty — nothing to migrate.');
    return;
  }

  console.log(`Found ${files.length} file(s) to migrate...\n`);
  let success = 0;
  let failed = 0;

  for (const filename of files) {
    const filepath = path.join(UPLOAD_DIR, filename);
    try {
      const buffer = fs.readFileSync(filepath);
      await uploadFile(buffer, filename);
      console.log(`  ✓  ${filename}`);
      success++;
    } catch (err) {
      console.error(`  ✗  ${filename} — ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. ${success} migrated, ${failed} failed.`);
  if (failed === 0) {
    console.log('\nAll files are now in GCS. You can safely delete ./server/uploads.');
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});

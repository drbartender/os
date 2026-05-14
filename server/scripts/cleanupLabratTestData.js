// One-shot Lab Rat test-data cleanup. Run via:
//   node server/scripts/cleanupLabratTestData.js
// Purges users + clients (and dependent proposals) whose email matches
// '%@labrat.test' AND are older than 24 hours. The auto-scheduler in
// server/index.js calls the same function hourly; this script exists for
// out-of-band manual runs (e.g., right after a heavy testing session).

require('dotenv').config();
const { purgeLabratTestData } = require('../utils/labratCleanup');

(async () => {
  try {
    const stats = await purgeLabratTestData();
    console.log('[labrat-cleanup] purged', stats);
    process.exit(0);
  } catch (err) {
    console.error('[labrat-cleanup] failed:', err.message);
    process.exit(1);
  }
})();

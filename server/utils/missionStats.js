const { pool } = require('../db');

async function logCompletion(missionId, testerName) {
  await pool.query(
    'INSERT INTO mission_completions (mission_id, tester_name) VALUES ($1, $2)',
    [missionId, testerName || null],
  );
}

async function getCompletionCounts() {
  const { rows } = await pool.query(
    'SELECT mission_id, COUNT(*)::int AS count FROM mission_completions GROUP BY mission_id',
  );
  const counts = {};
  for (const r of rows) counts[r.mission_id] = r.count;
  return counts;
}

module.exports = { logCompletion, getCompletionCounts };

const fs = require('node:fs/promises');
const path = require('node:path');

function getFile() {
  return process.env.LABRAT_COMPLETIONS_FILE
    || path.join(__dirname, '..', 'data', 'mission-completions.jsonl');
}

async function logCompletion(missionId, testerName) {
  await fs.mkdir(path.dirname(getFile()), { recursive: true });
  const line = JSON.stringify({
    missionId,
    testerName: testerName || null,
    at: new Date().toISOString(),
  }) + '\n';
  await fs.appendFile(getFile(), line);
}

async function getCompletionCounts() {
  let raw;
  try { raw = await fs.readFile(getFile(), 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
  const counts = {};
  for (const line of raw.trim().split('\n')) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      counts[rec.missionId] = (counts[rec.missionId] || 0) + 1;
    } catch { /* skip malformed */ }
  }
  return counts;
}

module.exports = { logCompletion, getCompletionCounts };

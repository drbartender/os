const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const VALID_KINDS = new Set(['bug', 'confusion', 'mission-stale']);

function getBugDir() {
  return process.env.LABRAT_BUG_DIR
    || path.join(__dirname, '..', 'data', 'tester-bugs');
}
function statusFile() { return path.join(getBugDir(), 'status.json'); }
function monthFile(date = new Date()) {
  return path.join(getBugDir(), `${date.toISOString().slice(0, 7)}.jsonl`);
}

async function ensureDir() {
  await fs.mkdir(getBugDir(), { recursive: true });
}

function newBugId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `bug_${ts}_${crypto.randomBytes(3).toString('hex')}`;
}

async function appendBug(input) {
  if (!VALID_KINDS.has(input.kind)) {
    throw new Error(`bugLog: invalid kind "${input.kind}"`);
  }
  await ensureDir();
  const record = {
    id: newBugId(),
    kind: input.kind,
    missionId: input.missionId || null,
    stepIndex: Number.isFinite(input.stepIndex) ? input.stepIndex : null,
    testerName: (input.testerName || '').toString().slice(0, 120) || null,
    testerEmail: (input.testerEmail || '').toString().slice(0, 200) || null,
    where: (input.where || '').toString().slice(0, 1000),
    didWhat: (input.didWhat || '').toString().slice(0, 5000),
    happened: (input.happened || '').toString().slice(0, 5000),
    expected: (input.expected || '').toString().slice(0, 5000),
    browser: (input.browser || '').toString().slice(0, 500),
    screenshotUrl: (input.screenshotUrl || '').toString().slice(0, 1000) || null,
    reportedAt: new Date().toISOString(),
  };
  await fs.appendFile(monthFile(), JSON.stringify(record) + '\n');
  return { id: record.id };
}

async function readStatus() {
  try {
    return JSON.parse(await fs.readFile(statusFile(), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function setBugStatus(bugId, patch) {
  await ensureDir();
  const all = await readStatus();
  all[bugId] = { ...(all[bugId] || {}), ...patch, updatedAt: new Date().toISOString() };
  await fs.writeFile(statusFile(), JSON.stringify(all, null, 2));
  return all[bugId];
}

async function readAllBugs() {
  await ensureDir();
  const entries = await fs.readdir(getBugDir());
  const out = [];
  for (const name of entries.sort()) {
    if (!name.endsWith('.jsonl')) continue;
    const raw = await fs.readFile(path.join(getBugDir(), name), 'utf8');
    for (const line of raw.trim().split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
  }
  return out;
}

async function listOpenBugs() {
  const [bugs, status] = await Promise.all([readAllBugs(), readStatus()]);
  return bugs.filter(b => !status[b.id] || status[b.id].status === 'open');
}

async function openBugCountByMission() {
  const open = await listOpenBugs();
  const counts = {};
  for (const b of open) {
    if (!b.missionId) continue;
    counts[b.missionId] = (counts[b.missionId] || 0) + 1;
  }
  return counts;
}

module.exports = { appendBug, listOpenBugs, setBugStatus, readAllBugs, readStatus, openBugCountByMission };

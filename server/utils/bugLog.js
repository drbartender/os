const crypto = require('node:crypto');
const { pool } = require('../db');

const VALID_KINDS = new Set(['bug', 'confusion', 'mission-stale']);
const VALID_STATUSES = new Set(['open', 'fixed', 'wontfix']);

function newBugId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `bug_${ts}_${crypto.randomBytes(3).toString('hex')}`;
}

function clip(value, max) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  if (!s) return null;
  return s.slice(0, max);
}

async function appendBug(input) {
  if (!VALID_KINDS.has(input.kind)) {
    throw new Error(`bugLog: invalid kind "${input.kind}"`);
  }
  const id = newBugId();
  const stepIndex = Number.isFinite(input.stepIndex) ? input.stepIndex : null;
  await pool.query(
    `INSERT INTO tester_bugs (
      id, kind, mission_id, step_index, tester_name,
      where_at, did_what, happened, expected, browser
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      input.kind,
      input.missionId || null,
      stepIndex,
      clip(input.testerName, 120),
      clip(input.where, 1000),
      clip(input.didWhat, 5000),
      clip(input.happened, 5000),
      clip(input.expected, 5000),
      clip(input.browser, 500),
    ],
  );
  return { id };
}

function rowToBug(row) {
  return {
    id: row.id,
    kind: row.kind,
    missionId: row.mission_id,
    stepIndex: row.step_index,
    testerName: row.tester_name,
    where: row.where_at,
    didWhat: row.did_what,
    happened: row.happened,
    expected: row.expected,
    browser: row.browser,
    reportedAt: row.reported_at instanceof Date ? row.reported_at.toISOString() : row.reported_at,
    status: row.status,
    statusUpdatedAt: row.status_updated_at instanceof Date ? row.status_updated_at.toISOString() : row.status_updated_at,
    fixCommitSha: row.fix_commit_sha,
    notes: row.notes,
  };
}

async function setBugStatus(bugId, patch = {}) {
  const fields = [];
  const values = [];
  if (patch.status) {
    if (!VALID_STATUSES.has(patch.status)) {
      throw new Error(`bugLog: invalid status "${patch.status}"`);
    }
    values.push(patch.status); fields.push(`status = $${values.length}`);
  }
  if (patch.fixCommitSha !== undefined) {
    values.push(clip(patch.fixCommitSha, 40)); fields.push(`fix_commit_sha = $${values.length}`);
  }
  if (patch.notes !== undefined) {
    values.push(clip(patch.notes, 5000)); fields.push(`notes = $${values.length}`);
  }
  if (!fields.length) {
    const { rows } = await pool.query('SELECT * FROM tester_bugs WHERE id = $1', [bugId]);
    return rows[0] ? rowToBug(rows[0]) : null;
  }
  fields.push('status_updated_at = NOW()');
  values.push(bugId);
  const { rows } = await pool.query(
    `UPDATE tester_bugs SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values,
  );
  return rows[0] ? rowToBug(rows[0]) : null;
}

const MAX_LIMIT = 500;

async function readAllBugs({ status, missionId, limit } = {}) {
  const filters = [];
  const values = [];
  if (status && status !== 'all') {
    if (!VALID_STATUSES.has(status)) throw new Error(`bugLog: invalid status filter "${status}"`);
    values.push(status); filters.push(`status = $${values.length}`);
  }
  if (missionId) {
    values.push(missionId); filters.push(`mission_id = $${values.length}`);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= MAX_LIMIT ? limit : MAX_LIMIT;
  values.push(safeLimit);
  const { rows } = await pool.query(
    `SELECT * FROM tester_bugs ${where} ORDER BY reported_at DESC LIMIT $${values.length}`,
    values,
  );
  return rows.map(rowToBug);
}

function listOpenBugs() {
  return readAllBugs({ status: 'open' });
}

async function openBugCountByMission() {
  const { rows } = await pool.query(
    `SELECT mission_id, COUNT(*)::int AS count
     FROM tester_bugs
     WHERE status = 'open' AND mission_id IS NOT NULL
     GROUP BY mission_id`,
  );
  const counts = {};
  for (const r of rows) counts[r.mission_id] = r.count;
  return counts;
}

module.exports = { appendBug, listOpenBugs, setBugStatus, readAllBugs, openBugCountByMission };

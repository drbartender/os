require('dotenv').config();
const { pool } = require('../db');
const {
  appendBug, readAllBugs, setBugStatus, openBugCountByMission,
} = require('./bugLog');

describe('bugLog (Postgres)', () => {
  beforeEach(async () => {
    await pool.query("DELETE FROM tester_bugs WHERE mission_id LIKE 'test-%'");
  });
  afterAll(async () => {
    await pool.query("DELETE FROM tester_bugs WHERE mission_id LIKE 'test-%'");
    await pool.end();
  });

  test('appendBug inserts and readAllBugs returns it', async () => {
    const { id } = await appendBug({
      kind: 'bug', missionId: 'test-m1', stepIndex: 2,
      testerName: 'Anon', where: 'step 3', didWhat: 'clicked',
      happened: 'nothing', expected: 'something', browser: 'Chrome',
    });
    expect(id).toMatch(/^bug_/);
    const bugs = await readAllBugs({ status: 'open', missionId: 'test-m1' });
    expect(bugs).toHaveLength(1);
    expect(bugs[0].id).toBe(id);
    expect(bugs[0].kind).toBe('bug');
    expect(bugs[0].missionId).toBe('test-m1');
    expect(bugs[0].stepIndex).toBe(2);
    expect(bugs[0].happened).toBe('nothing');
  });

  test('setBugStatus flips open to fixed and bumps status_updated_at', async () => {
    const { id } = await appendBug({
      kind: 'bug', missionId: 'test-m2', happened: 'x',
    });
    const before = await readAllBugs({ status: 'open', missionId: 'test-m2' });
    expect(before[0].statusUpdatedAt).toBeNull();

    const updated = await setBugStatus(id, { status: 'fixed', fixCommitSha: 'abc1234', notes: 'fix note' });
    expect(updated.status).toBe('fixed');
    expect(updated.fixCommitSha).toBe('abc1234');
    expect(updated.notes).toBe('fix note');
    expect(updated.statusUpdatedAt).not.toBeNull();
  });

  test('readAllBugs filters by missionId', async () => {
    await appendBug({ kind: 'bug', missionId: 'test-m3', happened: 'a' });
    await appendBug({ kind: 'bug', missionId: 'test-m4', happened: 'b' });
    const m3 = await readAllBugs({ missionId: 'test-m3' });
    const m4 = await readAllBugs({ missionId: 'test-m4' });
    expect(m3).toHaveLength(1);
    expect(m4).toHaveLength(1);
    expect(m3[0].missionId).toBe('test-m3');
    expect(m4[0].missionId).toBe('test-m4');
  });

  test('openBugCountByMission returns counts for open bugs only', async () => {
    await appendBug({ kind: 'bug', missionId: 'test-m5', happened: 'x' });
    await appendBug({ kind: 'bug', missionId: 'test-m5', happened: 'y' });
    const { id } = await appendBug({ kind: 'bug', missionId: 'test-m5', happened: 'z' });
    await setBugStatus(id, { status: 'fixed' });
    const counts = await openBugCountByMission();
    expect(counts['test-m5']).toBe(2);
  });

  test('appendBug throws on invalid kind', async () => {
    await expect(appendBug({ kind: 'invalid', happened: 'x' }))
      .rejects.toThrow(/invalid kind/);
  });

  test('setBugStatus throws on invalid status', async () => {
    const { id } = await appendBug({ kind: 'bug', missionId: 'test-m6', happened: 'x' });
    await expect(setBugStatus(id, { status: 'maybe' }))
      .rejects.toThrow(/invalid status/);
  });
});

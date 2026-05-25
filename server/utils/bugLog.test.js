require('dotenv').config();
const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const {
  appendBug, readAllBugs, setBugStatus, openBugCountByMission,
} = require('./bugLog');

describe('bugLog (Postgres)', () => {
  beforeEach(async () => {
    await pool.query("DELETE FROM tester_bugs WHERE mission_id LIKE 'test-%'");
  });
  after(async () => {
    await pool.query("DELETE FROM tester_bugs WHERE mission_id LIKE 'test-%'");
    await pool.end();
  });

  test('appendBug inserts and readAllBugs returns it', async () => {
    const { id } = await appendBug({
      kind: 'bug', missionId: 'test-m1', stepIndex: 2,
      testerName: 'Anon', where: 'step 3', didWhat: 'clicked',
      happened: 'nothing', expected: 'something', browser: 'Chrome',
    });
    assert.match(id, /^bug_/);
    const bugs = await readAllBugs({ status: 'open', missionId: 'test-m1' });
    assert.strictEqual(bugs.length, 1);
    assert.strictEqual(bugs[0].id, id);
    assert.strictEqual(bugs[0].kind, 'bug');
    assert.strictEqual(bugs[0].missionId, 'test-m1');
    assert.strictEqual(bugs[0].stepIndex, 2);
    assert.strictEqual(bugs[0].happened, 'nothing');
  });

  test('setBugStatus flips open to fixed and bumps status_updated_at', async () => {
    const { id } = await appendBug({
      kind: 'bug', missionId: 'test-m2', happened: 'x',
    });
    const before = await readAllBugs({ status: 'open', missionId: 'test-m2' });
    assert.strictEqual(before[0].statusUpdatedAt, null);

    const updated = await setBugStatus(id, { status: 'fixed', fixCommitSha: 'abc1234', notes: 'fix note' });
    assert.strictEqual(updated.status, 'fixed');
    assert.strictEqual(updated.fixCommitSha, 'abc1234');
    assert.strictEqual(updated.notes, 'fix note');
    assert.notStrictEqual(updated.statusUpdatedAt, null);
  });

  test('readAllBugs filters by missionId', async () => {
    await appendBug({ kind: 'bug', missionId: 'test-m3', happened: 'a' });
    await appendBug({ kind: 'bug', missionId: 'test-m4', happened: 'b' });
    const m3 = await readAllBugs({ missionId: 'test-m3' });
    const m4 = await readAllBugs({ missionId: 'test-m4' });
    assert.strictEqual(m3.length, 1);
    assert.strictEqual(m4.length, 1);
    assert.strictEqual(m3[0].missionId, 'test-m3');
    assert.strictEqual(m4[0].missionId, 'test-m4');
  });

  test('openBugCountByMission returns counts for open bugs only', async () => {
    await appendBug({ kind: 'bug', missionId: 'test-m5', happened: 'x' });
    await appendBug({ kind: 'bug', missionId: 'test-m5', happened: 'y' });
    const { id } = await appendBug({ kind: 'bug', missionId: 'test-m5', happened: 'z' });
    await setBugStatus(id, { status: 'fixed' });
    const counts = await openBugCountByMission();
    assert.strictEqual(counts['test-m5'], 2);
  });

  test('appendBug throws on invalid kind', async () => {
    await assert.rejects(
      appendBug({ kind: 'invalid', happened: 'x' }),
      /invalid kind/
    );
  });

  test('setBugStatus throws on invalid status', async () => {
    const { id } = await appendBug({ kind: 'bug', missionId: 'test-m6', happened: 'x' });
    await assert.rejects(
      setBugStatus(id, { status: 'maybe' }),
      /invalid status/
    );
  });
});

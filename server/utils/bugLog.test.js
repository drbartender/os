const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { appendBug, listOpenBugs, setBugStatus, openBugCountByMission } = require('./bugLog');

describe('bugLog', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buglog-'));
    process.env.LABRAT_BUG_DIR = tmp;
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('appendBug writes a JSON line and returns id', async () => {
    const { id } = await appendBug({
      kind: 'bug',
      missionId: 'submit-byob-quote',
      stepIndex: 2,
      testerName: 'Jordan',
      where: 'Step 3 of quote wizard',
      didWhat: 'Filled date and clicked Next',
      happened: 'Page froze',
      expected: 'Should advance to Step 4',
      browser: 'Chrome 142',
    });
    expect(id).toMatch(/^bug_/);
    const month = new Date().toISOString().slice(0, 7);
    const lines = fs.readFileSync(path.join(tmp, `${month}.jsonl`), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).missionId).toBe('submit-byob-quote');
  });

  test('listOpenBugs returns bugs without status', async () => {
    const { id: a } = await appendBug({ kind: 'bug', happened: 'A' });
    const { id: b } = await appendBug({ kind: 'bug', happened: 'B' });
    await setBugStatus(a, { status: 'fixed', fixCommitSha: 'abc1234' });
    const open = await listOpenBugs();
    expect(open.map(x => x.id)).toEqual([b]);
  });

  test('openBugCountByMission counts only open bugs per mission', async () => {
    await appendBug({ kind: 'bug', missionId: 'm1', happened: 'a' });
    await appendBug({ kind: 'bug', missionId: 'm1', happened: 'b' });
    const { id: c } = await appendBug({ kind: 'bug', missionId: 'm1', happened: 'c' });
    await appendBug({ kind: 'bug', missionId: 'm2', happened: 'd' });
    await setBugStatus(c, { status: 'fixed' });
    const counts = await openBugCountByMission();
    expect(counts).toEqual({ m1: 2, m2: 1 });
  });

  test('rejects unknown kind', async () => {
    await expect(appendBug({ kind: 'rant', happened: 'x' })).rejects.toThrow(/kind/);
  });
});

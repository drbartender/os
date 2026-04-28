const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { logCompletion, getCompletionCounts } = require('./missionStats');

describe('missionStats', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mstats-'));
    process.env.LABRAT_COMPLETIONS_FILE = path.join(tmp, 'completions.jsonl');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('counts completions per mission id', async () => {
    await logCompletion('a', 'tester1');
    await logCompletion('a', 'tester2');
    await logCompletion('b', 'tester1');
    expect(await getCompletionCounts()).toEqual({ a: 2, b: 1 });
  });
  test('returns empty object when no file', async () => {
    expect(await getCompletionCounts()).toEqual({});
  });
});

require('dotenv').config();
const { pool } = require('../db');
const { logCompletion, getCompletionCounts } = require('./missionStats');

describe('missionStats (Postgres)', () => {
  beforeEach(async () => {
    await pool.query("DELETE FROM mission_completions WHERE mission_id LIKE 'test-%'");
  });
  afterAll(async () => {
    await pool.query("DELETE FROM mission_completions WHERE mission_id LIKE 'test-%'");
    await pool.end();
  });

  test('counts completions per mission id', async () => {
    await logCompletion('test-a', 'tester1');
    await logCompletion('test-a', 'tester2');
    await logCompletion('test-b', 'tester1');
    const counts = await getCompletionCounts();
    expect(counts['test-a']).toBe(2);
    expect(counts['test-b']).toBe(1);
  });

  test('returns empty object (modulo test- rows) when no rows', async () => {
    const counts = await getCompletionCounts();
    const filtered = Object.fromEntries(
      Object.entries(counts).filter(([k]) => k.startsWith('test-'))
    );
    expect(filtered).toEqual({});
  });

  test('stores tester_name as null when omitted', async () => {
    await logCompletion('test-c');
    const { rows } = await pool.query(
      "SELECT tester_name FROM mission_completions WHERE mission_id = 'test-c'"
    );
    expect(rows[0].tester_name).toBeNull();
  });
});

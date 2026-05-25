require('dotenv').config();
const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const { logCompletion, getCompletionCounts } = require('./missionStats');

describe('missionStats (Postgres)', () => {
  beforeEach(async () => {
    await pool.query("DELETE FROM mission_completions WHERE mission_id LIKE 'test-%'");
  });
  after(async () => {
    await pool.query("DELETE FROM mission_completions WHERE mission_id LIKE 'test-%'");
    await pool.end();
  });

  test('counts completions per mission id', async () => {
    await logCompletion('test-a', 'tester1');
    await logCompletion('test-a', 'tester2');
    await logCompletion('test-b', 'tester1');
    const counts = await getCompletionCounts();
    assert.strictEqual(counts['test-a'], 2);
    assert.strictEqual(counts['test-b'], 1);
  });

  test('returns empty object (modulo test- rows) when no rows', async () => {
    const counts = await getCompletionCounts();
    const filtered = Object.fromEntries(
      Object.entries(counts).filter(([k]) => k.startsWith('test-'))
    );
    assert.deepStrictEqual(filtered, {});
  });

  test('stores tester_name as null when omitted', async () => {
    await logCompletion('test-c');
    const { rows } = await pool.query(
      "SELECT tester_name FROM mission_completions WHERE mission_id = 'test-c'"
    );
    assert.strictEqual(rows[0].tester_name, null);
  });
});

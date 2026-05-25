require('dotenv').config();
const { test, describe, beforeEach, after, mock } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const { wrapScheduler, checkStaleSchedulers, recordHeartbeat } = require('./schedulerHealth');

describe('schedulerHealth', () => {
  beforeEach(async () => {
    await pool.query("DELETE FROM scheduler_health WHERE scheduler_name LIKE 'test-%'");
  });

  after(async () => {
    await pool.query("DELETE FROM scheduler_health WHERE scheduler_name LIKE 'test-%'");
    await pool.end();
  });

  describe('recordHeartbeat', () => {
    test('inserts a new row when scheduler has never run', async () => {
      await recordHeartbeat('test-fresh', 3600, 'ok');
      const { rows } = await pool.query(
        "SELECT * FROM scheduler_health WHERE scheduler_name = 'test-fresh'"
      );
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].last_status, 'ok');
      assert.strictEqual(rows[0].consecutive_failures, 0);
      assert.strictEqual(rows[0].expected_interval_seconds, 3600);
    });

    test('updates existing row on subsequent runs', async () => {
      await recordHeartbeat('test-update', 60, 'ok');
      const before = await pool.query(
        "SELECT last_run_at FROM scheduler_health WHERE scheduler_name = 'test-update'"
      );
      await new Promise((r) => setTimeout(r, 50));
      await recordHeartbeat('test-update', 60, 'ok');
      const next = await pool.query(
        "SELECT last_run_at FROM scheduler_health WHERE scheduler_name = 'test-update'"
      );
      assert.ok(
        new Date(next.rows[0].last_run_at).getTime() > new Date(before.rows[0].last_run_at).getTime()
      );
    });

    test('increments consecutive_failures on failed status, resets on ok', async () => {
      await recordHeartbeat('test-fail', 60, 'failed', 'boom');
      await recordHeartbeat('test-fail', 60, 'failed', 'still boom');
      let { rows } = await pool.query(
        "SELECT consecutive_failures FROM scheduler_health WHERE scheduler_name = 'test-fail'"
      );
      assert.strictEqual(rows[0].consecutive_failures, 2);

      await recordHeartbeat('test-fail', 60, 'ok');
      ({ rows } = await pool.query(
        "SELECT consecutive_failures FROM scheduler_health WHERE scheduler_name = 'test-fail'"
      ));
      assert.strictEqual(rows[0].consecutive_failures, 0);
    });
  });

  describe('wrapScheduler', () => {
    test('records ok heartbeat after successful run', async () => {
      const fn = mock.fn(() => Promise.resolve(undefined));
      const wrapped = wrapScheduler('test-wrap-ok', 60, fn);
      await wrapped();
      assert.ok(fn.mock.callCount() >= 1);
      const { rows } = await pool.query(
        "SELECT last_status FROM scheduler_health WHERE scheduler_name = 'test-wrap-ok'"
      );
      assert.strictEqual(rows[0].last_status, 'ok');
    });

    test('records failed heartbeat and swallows the error', async () => {
      const fn = mock.fn(() => Promise.reject(new Error('kaboom')));
      const wrapped = wrapScheduler('test-wrap-fail', 60, fn);
      // Wrapper must NOT rethrow, timer callbacks can't handle unhandled rejections.
      const result = await wrapped();
      assert.strictEqual(result, undefined);
      const { rows } = await pool.query(
        "SELECT last_status, last_error FROM scheduler_health WHERE scheduler_name = 'test-wrap-fail'"
      );
      assert.strictEqual(rows[0].last_status, 'failed');
      assert.strictEqual(rows[0].last_error, 'kaboom');
    });
  });

  describe('checkStaleSchedulers', () => {
    test('returns names of schedulers that have not reported within 2x expected interval', async () => {
      await pool.query(`
        INSERT INTO scheduler_health (scheduler_name, last_run_at, last_status, expected_interval_seconds, consecutive_failures)
        VALUES ('test-stale', NOW() - INTERVAL '10 minutes', 'ok', 60, 0)
      `);
      const stale = await checkStaleSchedulers();
      const names = stale.map((s) => s.scheduler_name);
      assert.ok(names.includes('test-stale'));
    });

    test('does not flag schedulers within tolerance', async () => {
      await pool.query(`
        INSERT INTO scheduler_health (scheduler_name, last_run_at, last_status, expected_interval_seconds, consecutive_failures)
        VALUES ('test-fresh-stale', NOW() - INTERVAL '30 seconds', 'ok', 60, 0)
      `);
      const stale = await checkStaleSchedulers();
      const names = stale.map((s) => s.scheduler_name);
      assert.ok(!names.includes('test-fresh-stale'));
    });
  });
});

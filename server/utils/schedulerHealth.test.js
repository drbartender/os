require('dotenv').config();
const { pool } = require('../db');
const { wrapScheduler, checkStaleSchedulers, recordHeartbeat } = require('./schedulerHealth');

describe('schedulerHealth', () => {
  beforeEach(async () => {
    await pool.query("DELETE FROM scheduler_health WHERE scheduler_name LIKE 'test-%'");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM scheduler_health WHERE scheduler_name LIKE 'test-%'");
    await pool.end();
  });

  describe('recordHeartbeat', () => {
    it('inserts a new row when scheduler has never run', async () => {
      await recordHeartbeat('test-fresh', 3600, 'ok');
      const { rows } = await pool.query(
        "SELECT * FROM scheduler_health WHERE scheduler_name = 'test-fresh'"
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].last_status).toBe('ok');
      expect(rows[0].consecutive_failures).toBe(0);
      expect(rows[0].expected_interval_seconds).toBe(3600);
    });

    it('updates existing row on subsequent runs', async () => {
      await recordHeartbeat('test-update', 60, 'ok');
      const before = await pool.query(
        "SELECT last_run_at FROM scheduler_health WHERE scheduler_name = 'test-update'"
      );
      await new Promise((r) => setTimeout(r, 50));
      await recordHeartbeat('test-update', 60, 'ok');
      const after = await pool.query(
        "SELECT last_run_at FROM scheduler_health WHERE scheduler_name = 'test-update'"
      );
      expect(new Date(after.rows[0].last_run_at).getTime()).toBeGreaterThan(
        new Date(before.rows[0].last_run_at).getTime()
      );
    });

    it('increments consecutive_failures on failed status, resets on ok', async () => {
      await recordHeartbeat('test-fail', 60, 'failed', 'boom');
      await recordHeartbeat('test-fail', 60, 'failed', 'still boom');
      let { rows } = await pool.query(
        "SELECT consecutive_failures FROM scheduler_health WHERE scheduler_name = 'test-fail'"
      );
      expect(rows[0].consecutive_failures).toBe(2);

      await recordHeartbeat('test-fail', 60, 'ok');
      ({ rows } = await pool.query(
        "SELECT consecutive_failures FROM scheduler_health WHERE scheduler_name = 'test-fail'"
      ));
      expect(rows[0].consecutive_failures).toBe(0);
    });
  });

  describe('wrapScheduler', () => {
    it('records ok heartbeat after successful run', async () => {
      const fn = jest.fn().mockResolvedValue(undefined);
      const wrapped = wrapScheduler('test-wrap-ok', 60, fn);
      await wrapped();
      expect(fn).toHaveBeenCalled();
      const { rows } = await pool.query(
        "SELECT last_status FROM scheduler_health WHERE scheduler_name = 'test-wrap-ok'"
      );
      expect(rows[0].last_status).toBe('ok');
    });

    it('records failed heartbeat and swallows the error', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('kaboom'));
      const wrapped = wrapScheduler('test-wrap-fail', 60, fn);
      // Wrapper must NOT rethrow — timer callbacks can't handle unhandled rejections
      await expect(wrapped()).resolves.toBeUndefined();
      const { rows } = await pool.query(
        "SELECT last_status, last_error FROM scheduler_health WHERE scheduler_name = 'test-wrap-fail'"
      );
      expect(rows[0].last_status).toBe('failed');
      expect(rows[0].last_error).toBe('kaboom');
    });
  });

  describe('checkStaleSchedulers', () => {
    it('returns names of schedulers that have not reported within 2x expected interval', async () => {
      await pool.query(`
        INSERT INTO scheduler_health (scheduler_name, last_run_at, last_status, expected_interval_seconds, consecutive_failures)
        VALUES ('test-stale', NOW() - INTERVAL '10 minutes', 'ok', 60, 0)
      `);
      const stale = await checkStaleSchedulers();
      const names = stale.map((s) => s.scheduler_name);
      expect(names).toContain('test-stale');
    });

    it('does not flag schedulers within tolerance', async () => {
      await pool.query(`
        INSERT INTO scheduler_health (scheduler_name, last_run_at, last_status, expected_interval_seconds, consecutive_failures)
        VALUES ('test-fresh-stale', NOW() - INTERVAL '30 seconds', 'ok', 60, 0)
      `);
      const stale = await checkStaleSchedulers();
      const names = stale.map((s) => s.scheduler_name);
      expect(names).not.toContain('test-fresh-stale');
    });
  });
});

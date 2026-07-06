// DB layer for the presence tracker. Every multi-statement write is a
// transaction; the one-open-interval invariant is enforced by the partial
// unique index (INSERT side) and by id-scoped guarded UPDATEs (close side).
const { pool } = require('../db');
const { ValidationError, ConflictError } = require('./errors');
const { derivePointer, leadsAfterTransition, sumOverlapMs, centralWindows } = require('./presence');
const presenceActivity = require('./presenceActivity');

let _deps = { pool, now: () => new Date() };
function __setPresenceStoreDeps(d) { _deps = { ..._deps, ...d }; }

const NAME_SQL = "COALESCE(cp.preferred_name, INITCAP(SPLIT_PART(u.email, '@', 1)))";

async function getStripPayload() {
  const r = await _deps.pool.query(`
    SELECT u.id, u.presence_state, u.presence_since, u.presence_taking_leads,
           u.presence_lead_rank, ${NAME_SQL} AS name
    FROM users u
    LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
    WHERE u.presence_lead_rank IS NOT NULL
    ORDER BY u.presence_lead_rank
  `);
  return {
    users: r.rows.map((u) => ({
      id: u.id,
      name: u.name,
      state: u.presence_state,
      since: u.presence_since,
      taking_leads: u.presence_taking_leads,
      rank: u.presence_lead_rank,
    })),
    lead_owner_id: derivePointer(r.rows),
  };
}

// Close the open interval, update users, open the new interval. NOW() is
// transaction-stable so the close/open timestamps match exactly. FOR UPDATE
// on the users row serializes concurrent transitions per user.
async function transitionState(userId, nextState) {
  const client = await _deps.pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      `SELECT presence_state, presence_taking_leads,
              presence_lead_rank = (SELECT MAX(presence_lead_rank) FROM users
                                    WHERE presence_lead_rank IS NOT NULL) AS is_fallback_owner
       FROM users WHERE id = $1 AND presence_lead_rank IS NOT NULL FOR UPDATE`,
      [userId]
    );
    if (!cur.rows[0]) throw new ValidationError(null, 'Not a presence-tracked user');
    const { presence_state: prev, presence_taking_leads: taking, is_fallback_owner: isOwner } = cur.rows[0];
    if (prev === nextState) { await client.query('ROLLBACK'); return; }
    const nextTaking = leadsAfterTransition(prev, nextState, taking, isOwner);
    await client.query(
      "UPDATE presence_log SET ended_at = NOW(), ended_reason = 'switch' WHERE user_id = $1 AND ended_at IS NULL",
      [userId]
    );
    await client.query(
      'UPDATE users SET presence_state = $2, presence_since = NOW(), presence_taking_leads = $3 WHERE id = $1',
      [userId, nextState, nextTaking]
    );
    await client.query(
      'INSERT INTO presence_log (user_id, state, taking_leads, started_at) VALUES ($1, $2, $3, NOW())',
      [userId, nextState, nextTaking]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Spec 409 contract: a losing concurrent transition surfaces as
    // ConflictError, not a 500. Near-unreachable given FOR UPDATE; backstop.
    if (err && err.code === '23505') {
      throw new ConflictError('Presence state changed concurrently; refresh and retry');
    }
    throw err;
  } finally {
    client.release();
  }
}

async function setTakingLeads(userId, taking) {
  const client = await _deps.pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      'SELECT presence_state, presence_taking_leads FROM users WHERE id = $1 AND presence_lead_rank IS NOT NULL FOR UPDATE',
      [userId]
    );
    if (!cur.rows[0]) throw new ValidationError(null, 'Not a presence-tracked user');
    const { presence_state: state, presence_taking_leads: current } = cur.rows[0];
    if (state === 'away') throw new ValidationError(null, 'Leads toggle is unavailable while away');
    if (current === taking) { await client.query('ROLLBACK'); return; }
    await client.query(
      "UPDATE presence_log SET ended_at = NOW(), ended_reason = 'switch' WHERE user_id = $1 AND ended_at IS NULL",
      [userId]
    );
    await client.query('UPDATE users SET presence_taking_leads = $2 WHERE id = $1', [userId, taking]);
    await client.query(
      'INSERT INTO presence_log (user_id, state, taking_leads, started_at) VALUES ($1, $2, $3, NOW())',
      [userId, state, taking]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err && err.code === '23505') {
      throw new ConflictError('Presence state changed concurrently; refresh and retry');
    }
    throw err;
  } finally {
    client.release();
  }
}

async function getLogSummary(now = _deps.now()) {
  const { weekStart, monthStart } = centralWindows(now);
  const fetchFrom = new Date(Math.min(weekStart.getTime(), monthStart.getTime()));
  const [users, rows, recent] = await Promise.all([
    _deps.pool.query(`
      SELECT u.id, ${NAME_SQL} AS name
      FROM users u LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
      WHERE u.presence_lead_rank IS NOT NULL ORDER BY u.presence_lead_rank
    `),
    _deps.pool.query(
      'SELECT user_id, state, started_at, ended_at FROM presence_log WHERE ended_at IS NULL OR ended_at > $1',
      [fetchFrom]
    ),
    _deps.pool.query(`
      SELECT pl.id, pl.user_id, pl.state, pl.taking_leads, pl.started_at, pl.ended_at,
             pl.ended_reason, ${NAME_SQL} AS user_name
      FROM presence_log pl
      JOIN users u ON u.id = pl.user_id
      LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
      WHERE u.presence_lead_rank IS NOT NULL
      ORDER BY pl.started_at DESC LIMIT 50
    `),
  ]);
  const byUser = new Map(users.rows.map((u) => [u.id, []]));
  for (const iv of rows.rows) {
    if (byUser.has(iv.user_id)) byUser.get(iv.user_id).push(iv);
  }
  return {
    users: users.rows.map((u) => {
      const ivs = byUser.get(u.id) || [];
      const week = sumOverlapMs(ivs, weekStart, now, now);
      const month = sumOverlapMs(ivs, monthStart, now, now);
      return {
        id: u.id,
        name: u.name,
        week: { desk_ms: week.desk, available_ms: week.available },
        month: { desk_ms: month.desk, available_ms: month.available },
      };
    }),
    intervals: recent.rows,
  };
}

// Open desk intervals + everything the sweep needs to decide nudge/flip.
async function findSweepRows() {
  const r = await _deps.pool.query(`
    SELECT pl.id, pl.user_id, pl.state, pl.started_at, pl.ended_at, pl.nudged_at,
           u.presence_nudge_channel, u.presence_nudge_phone, u.presence_last_seen_at,
           ${NAME_SQL} AS name
    FROM presence_log pl
    JOIN users u ON u.id = pl.user_id
    LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
    WHERE pl.ended_at IS NULL AND pl.state = 'desk' AND u.presence_lead_rank IS NOT NULL
  `);
  return r.rows;
}

async function stampNudged(intervalId) {
  await _deps.pool.query(
    'UPDATE presence_log SET nudged_at = NOW() WHERE id = $1 AND ended_at IS NULL',
    [intervalId]
  );
}

/**
 * Auto-flip an ignored desk to away, scoped to the exact interval the sweep
 * observed (spec: Flip pass). Locks the users row FOR UPDATE first (the same
 * lock order as transitionState, so no deadlock), which serializes against
 * manual transitions; if the observed interval is still open after acquiring
 * the lock, no transition has interleaved. rowCount 0 on the close means a
 * manual switch won the race: ROLLBACK and report false. The interval closes
 * AT its own nudged_at and the away interval starts there, all in SQL (never
 * round-tripping timestamps through JS, which truncates Postgres's
 * microseconds), so an ignored tail never counts as work and
 * ended_at < started_at is impossible by construction.
 */
async function applyAutoFlip({ intervalId, userId }) {
  const client = await _deps.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const closed = await client.query(
      `UPDATE presence_log SET ended_at = nudged_at, ended_reason = 'auto_flip'
       WHERE id = $1 AND user_id = $2 AND ended_at IS NULL
         AND state = 'desk' AND nudged_at IS NOT NULL`,
      [intervalId, userId]
    );
    if (closed.rowCount === 0) { await client.query('ROLLBACK'); return false; }
    // The spec's presence_since equality guard is intentionally consolidated
    // into the id-scoped close above: with the users lock held, a still-open
    // observed interval proves no transition interleaved (every transition
    // closes it), and sourcing the timestamp via subquery avoids the JS
    // millisecond truncation an equality compare would trip on.
    const flipped = await client.query(
      `UPDATE users SET presence_state = 'away', presence_taking_leads = false,
         presence_since = (SELECT ended_at FROM presence_log WHERE id = $2)
       WHERE id = $1 AND presence_state = 'desk'`,
      [userId, intervalId]
    );
    if (flipped.rowCount === 0) { await client.query('ROLLBACK'); return false; }
    await client.query(
      `INSERT INTO presence_log (user_id, state, taking_leads, started_at)
       SELECT user_id, 'away', false, ended_at FROM presence_log WHERE id = $1`,
      [intervalId]
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function hasPendingNudge(userId) {
  const r = await _deps.pool.query(
    "SELECT 1 FROM presence_log WHERE user_id = $1 AND ended_at IS NULL AND state = 'desk' AND nudged_at IS NOT NULL",
    [userId]
  );
  return r.rowCount > 0;
}

async function getTelegramTrackedUserId() {
  const r = await _deps.pool.query(
    "SELECT id FROM users WHERE presence_nudge_channel = 'telegram' AND presence_lead_rank IS NOT NULL LIMIT 1"
  );
  return r.rows[0] ? r.rows[0].id : null;
}

/**
 * Inbound-SMS sign of life: match From (Twilio sends E.164) against tracked
 * users' presence_nudge_phone. Returns the matched user id or null. Also
 * updates the in-memory activity map so the same-process sweep sees it
 * instantly. NOTE: staff CONFIRM/CANT matching keys on
 * contractor_profiles.phone, a different column; no interference.
 */
async function stampByNudgePhone(fromE164) {
  if (!fromE164) return null;
  const r = await _deps.pool.query(
    'UPDATE users SET presence_last_seen_at = NOW() WHERE presence_nudge_phone = $1 AND presence_lead_rank IS NOT NULL RETURNING id',
    [String(fromE164).trim()]
  );
  const id = r.rows[0] ? r.rows[0].id : null;
  if (id) presenceActivity.touch(id, { immediate: true });
  return id;
}

module.exports = {
  getStripPayload, transitionState, setTakingLeads, getLogSummary,
  findSweepRows, stampNudged, applyAutoFlip, hasPendingNudge,
  getTelegramTrackedUserId, stampByNudgePhone, __setPresenceStoreDeps,
};

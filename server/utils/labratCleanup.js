// Lab Rat test-data cleanup. Purges users + clients (and dependent proposals)
// whose email matches the `@labrat.test` pattern AND are older than 24 hours.
// Called periodically by the scheduler in server/index.js, and on-demand by
// server/scripts/cleanupLabratTestData.js.
//
// Why this exists: POST /api/qa/seed creates real DB rows on production. Even
// with the rate limiter (2/hr/IP + 20/hr global), accounts accumulate. Without
// cleanup an attacker that flooded the limit would leave permanently-usable
// labrat credentials in production. This function bounds steady-state damage
// to roughly 24 hours of seed activity.

const { pool } = require('../db');

const AGE_INTERVAL = '24 hours';

async function purgeLabratTestData() {
  const client = await pool.connect();
  let stats = { users: 0, clients: 0, proposals: 0 };
  try {
    await client.query('BEGIN');

    // 1. Delete proposals whose client is a labrat client.
    //    proposals.client_id is ON DELETE SET NULL, so without this step the
    //    proposal rows would orphan when we delete the clients below. Better
    //    to delete them outright — they're test fixtures.
    const proposalsDeleted = await client.query(
      `DELETE FROM proposals
       WHERE client_id IN (
         SELECT id FROM clients
         WHERE email LIKE $1
           AND created_at < NOW() - INTERVAL '${AGE_INTERVAL}'
       )`,
      ['%@labrat.test'],
    );
    stats.proposals = proposalsDeleted.rowCount;

    // 2. Delete labrat clients (from the proposal-in-sent recipe).
    const clientsDeleted = await client.query(
      `DELETE FROM clients
       WHERE email LIKE $1
         AND created_at < NOW() - INTERVAL '${AGE_INTERVAL}'`,
      ['%@labrat.test'],
    );
    stats.clients = clientsDeleted.rowCount;

    // 3. Delete labrat users (from the pre-hire-invitation recipe).
    //    Most FKs to users(id) are ON DELETE CASCADE, so dependent rows
    //    (contractor_profiles, applications, etc.) drop automatically.
    const usersDeleted = await client.query(
      `DELETE FROM users
       WHERE email LIKE $1
         AND created_at < NOW() - INTERVAL '${AGE_INTERVAL}'`,
      ['%@labrat.test'],
    );
    stats.users = usersDeleted.rowCount;

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rbErr) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
  return stats;
}

module.exports = { purgeLabratTestData };

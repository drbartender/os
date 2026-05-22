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

    // 1. Delete proposals whose client is a labrat client. invoices.proposal_id
    //    is ON DELETE RESTRICT, so a bare proposal delete violates
    //    invoices_proposal_id_fkey (Sentry DRBARTENDER-SERVER-K) — the invoice +
    //    payment children must go first. proposal_addons / proposal_activity_log
    //    CASCADE, so they need no explicit delete; scheduled_messages has no FK
    //    to proposals but would orphan, so sweep it too.
    const labratProposalIds = (await client.query(
      `SELECT id FROM proposals
       WHERE client_id IN (
         SELECT id FROM clients
         WHERE email LIKE $1
           AND created_at < NOW() - INTERVAL '${AGE_INTERVAL}'
       )`,
      ['%@labrat.test'],
    )).rows.map(r => r.id);

    if (labratProposalIds.length > 0) {
      await client.query(
        `DELETE FROM invoice_payments
         WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1))`,
        [labratProposalIds],
      );
      await client.query('DELETE FROM invoices WHERE proposal_id = ANY($1)', [labratProposalIds]);
      // proposal_refunds → proposals AND → proposal_payments are both ON DELETE
      // RESTRICT, so refunds must go before both. (Labrat data realistically
      // never has refunds, but the purge must not abort if one ever does.)
      await client.query('DELETE FROM proposal_refunds WHERE proposal_id = ANY($1)', [labratProposalIds]);
      await client.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1)', [labratProposalIds]);
      await client.query(
        "DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = ANY($1)",
        [labratProposalIds],
      );
    }
    const proposalsDeleted = await client.query(
      'DELETE FROM proposals WHERE id = ANY($1)',
      [labratProposalIds],
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

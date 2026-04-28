const crypto = require('node:crypto');
const { pool } = require('../db');

function fakeName() {
  const f = ['Lab', 'Test', 'QA', 'Demo', 'Mock'][crypto.randomInt(0, 5)];
  const l = ['Rat', 'Pilot', 'Subject', 'Friend', 'Cousin'][crypto.randomInt(0, 5)];
  return `${f} ${l}-${crypto.randomBytes(2).toString('hex')}`;
}

function fakeEmail() {
  return `labrat-${crypto.randomBytes(4).toString('hex')}@labrat.test`;
}

async function recipeProposalInSent(client) {
  const cli = await client.query(`
    INSERT INTO clients (name, email, phone)
    VALUES ($1, $2, '5555550100')
    RETURNING id
  `, [fakeName(), fakeEmail()]);

  const eventDate = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const prop = await client.query(`
    INSERT INTO proposals (
      client_id, status, event_date, event_start_time,
      event_duration_hours, event_location, guest_count,
      total_price, num_bartenders, event_type, pricing_snapshot
    )
    VALUES ($1, 'sent', $2, '17:00', 4, 'Chicago, IL', 50,
            500.00, 1, 'wedding-reception', '{}'::jsonb)
    RETURNING id, token
  `, [cli.rows[0].id, eventDate]);

  return {
    clientId: cli.rows[0].id,
    proposalId: prop.rows[0].id,
    token: prop.rows[0].token,
    proposalUrl: `/proposal/${prop.rows[0].token}`,
  };
}

const RECIPES = {
  'proposal-in-sent': recipeProposalInSent,
};

async function runSeedRecipe(recipeId) {
  if (!RECIPES[recipeId]) throw new Error(`Unknown seed recipe: ${recipeId}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await RECIPES[recipeId](client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { runSeedRecipe, RECIPES };

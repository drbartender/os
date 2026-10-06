require('dotenv').config();

// Pins what the automatic first-save recap actually SENDS (spec 2026-10-06,
// section 3.1). drinkPlanConsult.js dispatches with no message, so the body is
// dispatch's own defaults, never buildMessages'. remainingActions.test.js only
// checks the drafted body, so a dispatch that forgot the drink names would pass
// there. sendEmail is stubbed through require.cache BEFORE the action loads
// (the action destructures sendEmail at require time), so this file never
// reaches Resend and every other suite keeps the real sender.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const emailPath = require.resolve('../../email');
const realEmail = require('../../email');
const sent = [];
require.cache[emailPath].exports = {
  ...realEmail,
  sendEmail: async (args) => { sent.push(args); return { id: 'dev-skipped' }; },
};

const { pool } = require('../../../db');
const action = require('./consultRecap');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const CLIENT_EMAIL = `consult-dispatch-${NONCE}@example.test`;
const COCKTAIL_ID = `consult-dispatch-${NONCE}`;
let clientId;
let proposalId;
let planId;

before(async () => {
  // Inactive catalog drink, named unlike its humanized id, so a resolved name
  // and the fallback cannot be confused.
  await pool.query(
    "INSERT INTO cocktails (id, name, is_active) VALUES ($1, 'Dispatch Recap Sour (catalog)', false)",
    [COCKTAIL_ID]
  );
  const c = await pool.query(
    "INSERT INTO clients (name, email) VALUES ('Consult Dispatch Test', $1) RETURNING id",
    [CLIENT_EMAIL]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'deposit_paid', 'birthday-party') RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  const dp = await pool.query(
    `INSERT INTO drink_plans (client_name, client_email, event_type, event_date, proposal_id, consult_selections)
     VALUES ('Consult Dispatch Test', $1, 'birthday-party', CURRENT_DATE + INTERVAL '30 days', $2, $3::jsonb)
     RETURNING id`,
    [CLIENT_EMAIL, proposalId, JSON.stringify({
      barType: 'full_bar', signatureDrinks: [COCKTAIL_ID], mixers: 'full',
    })]
  );
  planId = dp.rows[0].id;
});

after(async () => {
  await pool.query('DELETE FROM message_log WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM drink_plans WHERE id = $1', [planId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.query('DELETE FROM cocktails WHERE id = $1', [COCKTAIL_ID]);
  await pool.end();
});

test('dispatch with no message (the automatic first-save send) emails drink names, not catalog ids', async () => {
  sent.length = 0;
  const r = await action.dispatch(planId, undefined, ['email'], {});
  assert.equal(r.email, 'sent');
  assert.equal(sent.length, 1, 'exactly one email handed to the sender');
  const { text, html } = sent[0];
  assert.ok(text.includes('Signature cocktails: Dispatch Recap Sour (catalog)'), 'text names the drink');
  assert.ok(text.includes('Mixers: Full set'), 'text carries the Mixers line');
  assert.ok(!text.includes(COCKTAIL_ID), 'never the raw catalog id in the text');
  assert.ok(html.includes('Dispatch Recap Sour (catalog)'), 'html names the drink');
  assert.ok(!html.includes(COCKTAIL_ID), 'never the raw catalog id in the html');
});

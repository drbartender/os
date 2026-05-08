// server/utils/tipPageLifecycle.js
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const {
  deactivateTipPaymentLink,
  activateTipPaymentLink,
} = require('./tipPaymentLinks');

async function deactivateTipPage(userId) {
  const { rows } = await pool.query(
    'SELECT stripe_payment_link_id FROM payment_profiles WHERE user_id = $1',
    [userId]
  );
  const linkId = rows[0]?.stripe_payment_link_id;

  if (linkId) {
    try { await deactivateTipPaymentLink(linkId); }
    catch (err) {
      console.error('[tip] failed to deactivate Stripe Payment Link', err.message);
      Sentry.captureException(err, { extra: { userId, linkId, op: 'deactivate' } });
    }
  }

  await pool.query(
    'UPDATE payment_profiles SET tip_page_active = FALSE WHERE user_id = $1',
    [userId]
  );
}

async function activateTipPage(userId) {
  const { rows } = await pool.query(
    'SELECT stripe_payment_link_id FROM payment_profiles WHERE user_id = $1',
    [userId]
  );
  const linkId = rows[0]?.stripe_payment_link_id;

  if (linkId) {
    try { await activateTipPaymentLink(linkId); }
    catch (err) {
      console.error('[tip] failed to activate Stripe Payment Link', err.message);
      Sentry.captureException(err, { extra: { userId, linkId, op: 'activate' } });
    }
  }

  await pool.query(
    'UPDATE payment_profiles SET tip_page_active = TRUE WHERE user_id = $1',
    [userId]
  );
}

module.exports = { deactivateTipPage, activateTipPage };

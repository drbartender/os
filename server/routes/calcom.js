const express = require('express');
const { pool } = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const {
  verifyCalcomSignature,
  computeBodyHash,
  parseCalcomBody,
} = require('../utils/calcomWebhookHelpers');

let Sentry = null;
try { Sentry = require('@sentry/node'); } catch (_) { /* optional in dev */ }

function sentryWarn(message, ctx = {}) {
  if (Sentry && process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage(message, { level: 'warning', ...ctx });
  }
}

const router = express.Router();

router.post('/webhook', asyncHandler(async (req, res) => {
  // Pre-check 1: secret configured. Fails closed.
  if (!process.env.CAL_WEBHOOK_SECRET) {
    console.error('[calcom] CAL_WEBHOOK_SECRET not set; rejecting webhook');
    return res.status(503).send('Cal.com webhook not configured');
  }

  // Pre-check 2: signature header present.
  const provided = req.headers['x-cal-signature-256'] || '';
  if (!provided) {
    sentryWarn('Cal.com webhook missing signature header', {
      tags: { webhook: 'calcom', reason: 'missing_signature' },
    });
    return res.status(400).send('Missing signature');
  }

  // Pre-check 3: signature valid.
  const sigOk = verifyCalcomSignature(req.body, provided, process.env.CAL_WEBHOOK_SECRET);
  if (!sigOk) {
    console.error('[calcom] signature verification failed');
    sentryWarn('Cal.com webhook signature failure', {
      tags: { webhook: 'calcom', reason: 'invalid_signature' },
    });
    return res.status(400).send('Invalid signature');
  }

  // Pre-check 4: body parses.
  let body;
  try {
    body = parseCalcomBody(req.body);
  } catch (_) {
    sentryWarn('Cal.com webhook JSON parse failure', {
      tags: { webhook: 'calcom', reason: 'malformed_body' },
    });
    return res.status(400).send('Malformed body');
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sentryWarn('Cal.com webhook non-object body', {
      tags: { webhook: 'calcom', reason: 'malformed_body' },
    });
    return res.status(400).send('Malformed body');
  }

  // Replay protection: dedupe by SHA-256 of the raw signed body.
  const eventUid = computeBodyHash(req.body);
  const dedupe = await pool.query(
    `INSERT INTO webhook_events (provider, event_id, received_at)
     VALUES ('calcom', $1, NOW())
     ON CONFLICT (provider, event_id) DO NOTHING
     RETURNING received_at`,
    [eventUid]
  );
  if (dedupe.rowCount === 0) {
    return res.status(200).send('Already processed');
  }

  const event = body.triggerEvent;
  const data = body.payload || {};

  switch (event) {
    case 'BOOKING_CREATED':         return handleCreated(data, res);
    case 'BOOKING_CANCELLED':       return handleCancelled(data, res);
    case 'BOOKING_RESCHEDULED':     return handleRescheduled(data, res);
    case 'BOOKING_NO_SHOW_UPDATED': return handleNoShow(data, res);
    default:
      console.log(`[calcom] ignored event: ${event || 'unknown'}`);
      return res.status(200).send(`ignored: ${event || 'unknown'}`);
  }
}));

// Handler stubs (filled in by Tasks 5, 6, 7, 8).
async function handleCreated(_payload, res)     { return res.status(200).send('OK'); }
async function handleCancelled(_payload, res)   { return res.status(200).send('OK'); }
async function handleRescheduled(_payload, res) { return res.status(200).send('OK'); }
async function handleNoShow(_payload, res)      { return res.status(200).send('OK'); }

module.exports = router;
module.exports._handlers = { handleCreated, handleCancelled, handleRescheduled, handleNoShow };

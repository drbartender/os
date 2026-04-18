const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('../utils/email');
const { newThumbtackLeadAdmin, newThumbtackMessageAdmin, newThumbtackReviewAdmin } = require('../utils/emailTemplates');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

// Rate limit: 30 requests per minute per IP
const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Too many requests' } });
router.use(webhookLimiter);

// ─── Webhook Auth ──────────────────────────────────────────────────
// Thumbtack can send Basic Auth or a custom header depending on setup.
// We check both against THUMBTACK_WEBHOOK_SECRET.

/** Timing-safe string comparison */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function verifyWebhook(req, res, next) {
  const secret = process.env.THUMBTACK_WEBHOOK_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      console.error('THUMBTACK_WEBHOOK_SECRET not set in production — rejecting');
      return res.status(500).json({ error: 'Webhook not configured' });
    }
    console.warn('THUMBTACK_WEBHOOK_SECRET not set — allowing in dev');
    return next();
  }

  // Basic Auth: Authorization: Basic base64(secret)
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts[0] === 'Basic' && parts[1]) {
      const decoded = Buffer.from(parts[1], 'base64').toString();
      // Thumbtack may send username:password or just the secret
      if (safeEqual(decoded, secret) || safeEqual(decoded.split(':').pop(), secret)) {
        return next();
      }
    }
  }

  // Custom header
  if (safeEqual(req.headers['x-thumbtack-secret'], secret)) return next();

  console.error('Thumbtack webhook auth failed');
  return res.status(401).json({ error: 'Unauthorized' });
}

router.use(verifyWebhook);

// ─── Helpers ───────────────────────────────────────────────────────

/** Truncate untrusted strings to prevent oversized DB inserts */
function truncate(str, max = 5000) {
  if (!str) return str;
  return str.length > max ? str.slice(0, max) : str;
}

/** Try to extract guest count from Thumbtack details Q&A */
function extractGuestCount(details) {
  if (!Array.isArray(details)) return null;
  for (const d of details) {
    const q = (d.question || '').toLowerCase();
    if (q.includes('guest') || q.includes('attendee') || q.includes('people') || q.includes('how many')) {
      const num = parseInt(d.answer, 10);
      if (!isNaN(num) && num > 0) return num;
    }
  }
  return null;
}

/** Normalize phone to digits only for matching */
function normalizePhone(phone) {
  if (!phone) return null;
  return phone.replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
}

/** Extract lead fields from V4 or legacy payload */
function parseLead(body) {
  // V4 envelope: { event: { eventType }, data: { ... } }
  if (body.event && body.data) {
    const d = body.data;
    const req = d.request || {};
    const loc = req.location || {};
    const booking = req.booking || {};
    const proposedTimes = req.proposedTimes || [];

    return {
      negotiationId: d.negotiationID || d.negotiation_id,
      customerId: d.customer?.customerID,
      customerName: [d.customer?.firstName, d.customer?.lastName].filter(Boolean).join(' ') || null,
      customerPhone: d.customer?.phone,
      category: req.category?.name || null,
      description: req.description || null,
      locationAddress: loc.address1 || null,
      locationCity: loc.city || null,
      locationState: loc.state || null,
      locationZip: loc.zipCode || null,
      eventDate: booking.start || proposedTimes[0]?.start || null,
      eventDuration: booking.duration || null,
      leadType: d.leadType || null,
      leadPrice: d.leadPrice || null,
      chargeState: d.chargeState || null,
      guestCount: extractGuestCount(req.details),
      details: req.details || [],
    };
  }

  // Legacy flat format: { leadID, customer, request, ... }
  const req = body.request || {};
  const loc = req.location || {};
  return {
    negotiationId: body.leadID,
    customerId: body.customer?.customerID,
    customerName: body.customer?.name || null,
    customerPhone: body.customer?.phone,
    category: req.category || req.title || null,
    description: req.description || null,
    locationAddress: loc.address1 || null,
    locationCity: loc.city || null,
    locationState: loc.state || null,
    locationZip: loc.zipCode || null,
    eventDate: null, // Legacy uses freeform schedule string
    eventDuration: null,
    leadType: body.leadType || null,
    leadPrice: body.leadPrice || body.price || null,
    chargeState: body.chargeState || null,
    guestCount: extractGuestCount(req.details),
    details: req.details || [],
  };
}

/** Extract message fields from V4 or legacy payload */
function parseMessage(body) {
  if (body.event && body.data) {
    const d = body.data;
    return {
      messageId: d.messageID,
      negotiationId: d.negotiationID,
      fromType: d.from || null,
      senderName: d.customer?.displayName || d.business?.displayName || null,
      text: d.text || null,
      sentAt: d.sentAt || null,
    };
  }

  // Legacy
  const msg = body.message || {};
  return {
    messageId: msg.messageID,
    negotiationId: body.leadID,
    fromType: null,
    senderName: null,
    text: msg.text || null,
    sentAt: msg.createTimestamp ? new Date(Number(msg.createTimestamp) * 1000).toISOString() : null,
  };
}

/** Extract review fields from V4 or legacy payload */
function parseReview(body) {
  if (body.event && body.data) {
    const d = body.data;
    return {
      reviewId: d.reviewID,
      negotiationId: d.negotiationID || null,
      rating: d.rating !== null && d.rating !== undefined ? Number(d.rating) : null,
      reviewText: d.reviewText || null,
      reviewerName: d.reviewerName || null,
    };
  }

  // Legacy
  const r = body.review || {};
  return {
    reviewId: r.reviewID,
    negotiationId: r.leadID || null,
    rating: r.rating !== null && r.rating !== undefined ? Number(r.rating) : null,
    reviewText: r.text || null,
    reviewerName: r.reviewerNickname || null,
  };
}

// ─── POST /api/thumbtack/leads ─────────────────────────────────────

router.post('/leads', asyncHandler(async (req, res) => {
  const body = req.body;
  console.log('Thumbtack lead webhook received');

  let lead;
  try {
    lead = parseLead(body);
  } catch (err) {
    console.error('Failed to parse Thumbtack lead:', err);
    return res.status(400).json({ error: 'Invalid payload' });
  }

  if (!lead.negotiationId) {
    console.error('Thumbtack lead missing negotiation/lead ID');
    return res.status(400).json({ error: 'Missing lead ID' });
  }

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    // Deduplicate — skip if we already have this lead
    const existing = await dbClient.query(
      'SELECT id FROM thumbtack_leads WHERE negotiation_id = $1',
      [lead.negotiationId]
    );
    if (existing.rows.length > 0) {
      await dbClient.query('COMMIT');
      console.log(`Thumbtack lead ${lead.negotiationId} already exists — skipping`);
      return res.status(200).json({ status: 'duplicate' });
    }

    // Find or create client by phone
    let clientId = null;
    const phone = normalizePhone(lead.customerPhone);

    if (phone && phone.length >= 10) {
      // Match on last 10 digits of normalized phone (uses functional index)
      const match = await dbClient.query(
        `SELECT id FROM clients WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1 ORDER BY created_at DESC LIMIT 1`,
        [phone.slice(-10)]
      );

      if (match.rows.length > 0) {
        clientId = match.rows[0].id;
      } else {
        // Create new client
        const newClient = await dbClient.query(
          `INSERT INTO clients (name, phone, source, notes) VALUES ($1, $2, 'thumbtack', $3) RETURNING id`,
          [
            lead.customerName || 'Thumbtack Lead',
            lead.customerPhone,
            `Thumbtack lead — email needed. Category: ${lead.category || 'N/A'}`,
          ]
        );
        clientId = newClient.rows[0].id;
      }
    } else if (lead.customerName) {
      // No phone — create client with name only
      const newClient = await dbClient.query(
        `INSERT INTO clients (name, source, notes) VALUES ($1, 'thumbtack', $2) RETURNING id`,
        [lead.customerName, `Thumbtack lead — email & phone needed. Category: ${lead.category || 'N/A'}`]
      );
      clientId = newClient.rows[0].id;
    }

    // Insert the Thumbtack lead
    await dbClient.query(
      `INSERT INTO thumbtack_leads (
        negotiation_id, client_id, customer_id, customer_name, customer_phone,
        category, description, location_city, location_state, location_zip,
        location_address, event_date, event_duration, guest_count, lead_type,
        lead_price, charge_state, raw_payload
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        lead.negotiationId, clientId, lead.customerId, truncate(lead.customerName, 255),
        truncate(lead.customerPhone, 50), truncate(lead.category, 255), truncate(lead.description),
        truncate(lead.locationCity, 255), truncate(lead.locationState, 50), truncate(lead.locationZip, 20),
        lead.locationAddress, lead.eventDate, lead.eventDuration,
        lead.guestCount, lead.leadType, lead.leadPrice, lead.chargeState,
        JSON.stringify(body),
      ]
    );

    await dbClient.query('COMMIT');
    console.log(`Thumbtack lead ${lead.negotiationId} saved — client ${clientId}`);

    // Admin notification (non-blocking)
    try {
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail) {
        const clientUrl = process.env.CLIENT_URL || 'https://www.drbartender.com';
        const adminUrl = clientId ? `${clientUrl}/admin/clients/${clientId}` : null;
        const tpl = newThumbtackLeadAdmin({
          customerName: lead.customerName,
          customerPhone: lead.customerPhone,
          category: lead.category,
          description: lead.description,
          location: [lead.locationCity, lead.locationState].filter(Boolean).join(', '),
          eventDate: lead.eventDate,
          details: lead.details,
          adminUrl,
        });
        await sendEmail({ to: adminEmail, ...tpl });
      }
    } catch (emailErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(emailErr, {
          tags: { webhook: 'thumbtack', route: '/leads' },
        });
      }
      console.error('Thumbtack admin notification failed (non-blocking):', emailErr);
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, {
        tags: { webhook: 'thumbtack', route: '/leads' },
      });
    }
    console.error('Thumbtack lead processing error:', err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    dbClient.release();
  }
}));

// ─── POST /api/thumbtack/messages ──────────────────────────────────

router.post('/messages', asyncHandler(async (req, res) => {
  const body = req.body;
  console.log('Thumbtack message webhook received');

  let msg;
  try {
    msg = parseMessage(body);
  } catch (err) {
    console.error('Failed to parse Thumbtack message:', err);
    return res.status(400).json({ error: 'Invalid payload' });
  }

  if (!msg.messageId) {
    return res.status(400).json({ error: 'Missing message ID' });
  }

  try {
    // Upsert with ON CONFLICT to handle concurrent duplicates
    const result = await pool.query(
      `INSERT INTO thumbtack_messages (message_id, negotiation_id, from_type, sender_name, text, sent_at, raw_payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (message_id) DO NOTHING
       RETURNING id`,
      [msg.messageId, msg.negotiationId, msg.fromType, truncate(msg.senderName, 255), truncate(msg.text), msg.sentAt, JSON.stringify(body)]
    );

    if (result.rowCount === 0) {
      return res.status(200).json({ status: 'duplicate' });
    }

    console.log(`Thumbtack message ${msg.messageId} saved`);

    // Notify admin of customer messages (non-blocking)
    if (msg.fromType === 'Customer' || !msg.fromType) {
      try {
        const adminEmail = process.env.ADMIN_EMAIL;
        if (adminEmail) {
          const lead = await pool.query(
            'SELECT client_id, customer_name FROM thumbtack_leads WHERE negotiation_id = $1',
            [msg.negotiationId]
          );
          const clientUrl = process.env.CLIENT_URL || 'https://www.drbartender.com';
          const clientId = lead.rows[0]?.client_id;
          const adminUrl = clientId ? `${clientUrl}/admin/clients/${clientId}` : null;
          const tpl = newThumbtackMessageAdmin({
            customerName: lead.rows[0]?.customer_name || msg.senderName || 'Unknown',
            text: msg.text,
            adminUrl,
          });
          await sendEmail({ to: adminEmail, ...tpl });
        }
      } catch (emailErr) {
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(emailErr, {
            tags: { webhook: 'thumbtack', route: '/messages' },
          });
        }
        console.error('Thumbtack message notification failed (non-blocking):', emailErr);
      }
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, {
        tags: { webhook: 'thumbtack', route: '/messages' },
      });
    }
    console.error('Thumbtack message processing error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
}));

// ─── POST /api/thumbtack/reviews ───────────────────────────────────

router.post('/reviews', asyncHandler(async (req, res) => {
  const body = req.body;
  console.log('Thumbtack review webhook received');

  let review;
  try {
    review = parseReview(body);
  } catch (err) {
    console.error('Failed to parse Thumbtack review:', err);
    return res.status(400).json({ error: 'Invalid payload' });
  }

  if (!review.reviewId) {
    return res.status(400).json({ error: 'Missing review ID' });
  }

  try {
    // Upsert with ON CONFLICT to handle concurrent duplicates
    const result = await pool.query(
      `INSERT INTO thumbtack_reviews (review_id, negotiation_id, rating, review_text, reviewer_name, raw_payload)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (review_id) DO NOTHING
       RETURNING id`,
      [review.reviewId, review.negotiationId, review.rating, truncate(review.reviewText), truncate(review.reviewerName, 255), JSON.stringify(body)]
    );

    if (result.rowCount === 0) {
      return res.status(200).json({ status: 'duplicate' });
    }

    console.log(`Thumbtack review ${review.reviewId} saved`);

    // Notify admin (non-blocking)
    try {
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail) {
        const tpl = newThumbtackReviewAdmin({
          reviewerName: review.reviewerName,
          rating: review.rating,
          reviewText: review.reviewText,
        });
        await sendEmail({ to: adminEmail, ...tpl });
      }
    } catch (emailErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(emailErr, {
          tags: { webhook: 'thumbtack', route: '/reviews' },
        });
      }
      console.error('Thumbtack review notification failed (non-blocking):', emailErr);
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, {
        tags: { webhook: 'thumbtack', route: '/reviews' },
      });
    }
    console.error('Thumbtack review processing error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
}));

module.exports = router;

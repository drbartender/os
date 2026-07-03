const express = require('express');
const rateLimit = require('express-rate-limit');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { newThumbtackLeadAdmin, newThumbtackReviewAdmin } = require('../utils/emailTemplates');
const { notifyAdminCategory } = require('../utils/adminNotifications');
const { ADMIN_URL } = require('../utils/urls');
const { findOrCreateClient } = require('../utils/clientDedup');
const { safeEqual } = require('../utils/secrets');
const { createDraftProposalFromLead } = require('../utils/thumbtackProposalDraft');

// Test seam: lets thumbtack.test.js stub the draft builder to throw and prove
// the webhook still 200s with the lead persisted.
let _deps = { createDraftProposalFromLead };
function __setDeps(d) { _deps = { ..._deps, ...d }; }
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

// Rate limit: 30 requests per minute per IP
const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Too many requests' } });
router.use(webhookLimiter);

// ─── Webhook Auth ──────────────────────────────────────────────────
// Thumbtack can send Basic Auth or a custom header depending on setup.
// We check both against THUMBTACK_WEBHOOK_SECRET.

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
  Sentry.captureMessage('Thumbtack webhook signature failure', {
    level: 'warning',
    tags: { webhook: 'thumbtack', reason: 'invalid_signature' },
  });
  return res.status(401).json({ error: 'Unauthorized' });
}

router.use(verifyWebhook);

// ─── Helpers ───────────────────────────────────────────────────────

/** Truncate untrusted strings to prevent oversized DB inserts */
function truncate(str, max = 5000) {
  if (str === null || str === undefined) return null;
  const v = typeof str === 'string' ? str : String(str);
  return v.length > max ? v.slice(0, max) : v;
}

/** Try to extract guest count from Thumbtack details Q&A */
function extractGuestCount(details) {
  if (!Array.isArray(details)) return null;
  for (const d of details) {
    if (!d || typeof d !== 'object') continue;
    const q = String(d.question || '').toLowerCase();
    if (q.includes('guest') || q.includes('attendee') || q.includes('people') || q.includes('how many')) {
      // Take the HIGH end of a range ("51 - 75 guests" => 75) so we never
      // under-staff or under-price; Thumbtack reports guest count as a range.
      const nums = String(d.answer || '').slice(0, 2000).match(/\d+/g);
      if (nums && nums.length) {
        const max = nums.reduce((hi, n) => Math.max(hi, Number(n)), 0);
        if (max > 0) return max;
      }
    }
  }
  return null;
}

/** Minimal HTML-entity decode for Thumbtack Q&A answers (prod sends e.g. I&#39;m). */
function decodeEntities(str) {
  return String(str)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * Stated budget from the Thumbtack details Q&A. The answer is a comma-joined
 * multi-select of ranges ("Under $200 (...)", "$300 - $400", "$600- $750",
 * "More than $750", "I'm not sure"). Returns integer WHOLE DOLLARS, matching
 * proposals.total_price units (the documented proposals dollars exception):
 *   { budgetMin, budgetMax, budgetRaw }
 * budgetMax null = no cap known (unsure-only, or ANY "More than $X" token),
 * so the over-budget badge can never fire. All three null when no budget
 * question exists or nothing parses. A bare single number with no under/more
 * keyword contributes nothing: not an observed prod shape, and guessing a
 * bound from it risks a wrong flag.
 */
function extractBudget(details) {
  const NONE = { budgetMin: null, budgetMax: null, budgetRaw: null };
  if (!Array.isArray(details)) return NONE;
  for (const d of details) {
    if (!d || typeof d !== 'object') continue;
    if (!String(d.question || '').toLowerCase().includes('budget')) continue;
    // Pre-slice to 2000 (same defensive bound as extractGuestCount) so the
    // decode regexes never chew an unbounded payload; slice to 500 AFTER the
    // decode so a boundary never cuts an entity mid-sequence.
    const raw = decodeEntities(String(d.answer || '').slice(0, 2000)).slice(0, 500);
    let min = null;
    let max = null;
    let openMax = false;
    for (const token of raw.split(',')) {
      const t = token.trim().toLowerCase();
      if (!t || t.includes('not sure')) continue;
      // 50..100000 filter: discards thousands-separator shrapnel (a "$1,000"
      // split on commas yields junk fragments) and zero/absurd values.
      const nums = (t.match(/\d+/g) || []).map(Number).filter((n) => n >= 50 && n <= 100000);
      if (!nums.length) continue;
      if (/\bunder\b|\bless than\b/.test(t)) {
        min = 0;
        max = max === null ? nums[0] : Math.max(max, nums[0]);
      } else if (/\bmore than\b|\bover\b|\babove\b/.test(t)) {
        min = min === null ? nums[0] : Math.min(min, nums[0]);
        openMax = true;
      } else if (nums.length >= 2) {
        const lo = Math.min(...nums);
        const hi = Math.max(...nums);
        min = min === null ? lo : Math.min(min, lo);
        max = max === null ? hi : Math.max(max, hi);
      }
      // single bare number with no keyword: contributes nothing
    }
    if (min === null && max === null) return NONE;
    if (openMax) max = null;
    return { budgetMin: min, budgetMax: max, budgetRaw: raw };
  }
  return NONE;
}

/**
 * Event duration in HOURS from the lead's scheduled window (end - start).
 * Thumbtack V4 leads carry the window as proposedTimes[].start/end ISO
 * timestamps, so the duration is unambiguous. We deliberately do NOT read a
 * scalar booking.duration: its unit is undocumented and real payloads never
 * send it. Rounded to ONE decimal to match the NUMERIC(4,1) duration columns
 * (thumbtack_leads.event_duration and proposals.event_duration_hours), so the
 * stored value and the priced value never disagree; half-hour windows (e.g.
 * 6:00-9:30 PM => 3.5) are preserved. Returns null for a missing or implausible
 * window (rounds to <=0 or >24h) so the draft builder falls back to 4 hours.
 */
function computeDurationHours(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const hours = Math.round(((end.getTime() - start.getTime()) / 3600000) * 10) / 10;
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return null;
  return hours;
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
    // Event window: prefer a confirmed booking, else the first proposed time.
    const windowStart = booking.start || proposedTimes[0]?.start || null;
    const windowEnd = booking.end || proposedTimes[0]?.end || null;

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
      eventDate: windowStart,
      eventDuration: computeDurationHours(windowStart, windowEnd),
      leadType: d.leadType || null,
      leadPrice: d.leadPrice || null,
      chargeState: d.chargeState || null,
      guestCount: extractGuestCount(req.details),
      ...extractBudget(req.details),
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
    ...extractBudget(req.details),
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

// Post-commit side effects for a captured lead: best-effort Core Reaction draft
// proposal + admin notification. Extracted so the duplicate-heal path (a
// crash-after-commit strand) can re-run the exact same steps. Never throws; each
// step is independently guarded. Returns the draft proposalId (or null).
async function runPostCommitSteps({ lead, clientId }) {
  // Auto-create a Core Reaction draft proposal (best-effort). A failure here must
  // NOT surface to the webhook. Idempotent on the lead's existing proposal_id.
  let proposalId = null;
  if (clientId) {
    try {
      const draft = await _deps.createDraftProposalFromLead({ lead, clientId, negotiationId: lead.negotiationId });
      proposalId = draft ? draft.proposalId : null;
    } catch (draftErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(draftErr, { tags: { webhook: 'thumbtack', step: 'draft' } });
      }
      console.error('Thumbtack auto-draft failed (non-blocking):', draftErr);
    }
  }

  // Admin notification (non-blocking).
  try {
    const adminUrl = clientId ? `${ADMIN_URL}/clients/${clientId}` : null;
    const proposalUrl = proposalId ? `${ADMIN_URL}/proposals/${proposalId}` : null;
    const tpl = newThumbtackLeadAdmin({
      customerName: lead.customerName,
      customerPhone: lead.customerPhone,
      category: lead.category,
      description: lead.description,
      location: [lead.locationCity, lead.locationState].filter(Boolean).join(', '),
      eventDate: lead.eventDate,
      details: lead.details,
      adminUrl,
      proposalUrl,
    });
    await notifyAdminCategory({
      category: 'routine_thumbtack',
      subject: tpl.subject,
      emailHtml: tpl.html,
      emailText: tpl.text,
    });
  } catch (emailErr) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(emailErr, {
        tags: { webhook: 'thumbtack', route: '/leads' },
      });
    }
    console.error('Thumbtack admin notification failed (non-blocking):', emailErr);
  }

  return proposalId;
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
      'SELECT id, client_id, proposal_id FROM thumbtack_leads WHERE negotiation_id = $1',
      [lead.negotiationId]
    );
    if (existing.rows.length > 0) {
      await dbClient.query('COMMIT'); // close the read-only tx before any heal work
      const row = existing.rows[0];
      // Duplicate-heal: a lead committed WITH a client but WITHOUT a draft is a
      // crash-after-commit strand — the client is created in the SAME tx as the
      // lead, so a persisted lead + client but no proposal_id means the
      // post-commit steps never ran (a hard crash right after COMMIT). Re-run them
      // once. A fully-processed duplicate (proposal_id set) or a clientless lead
      // (nothing to draft or notify with a link) is left untouched, so a normal
      // duplicate never re-notifies.
      if (row.client_id && !row.proposal_id) {
        console.log(`Thumbtack lead ${lead.negotiationId} duplicate with no draft — healing post-commit steps`);
        await runPostCommitSteps({ lead, clientId: row.client_id });
        return res.status(200).json({ status: 'healed' });
      }
      console.log(`Thumbtack lead ${lead.negotiationId} already exists — skipping`);
      return res.status(200).json({ status: 'duplicate' });
    }

    // Find or create the client (dedupes on email OR phone — see clientDedup.js)
    let clientId = null;
    if (lead.customerName || normalizePhone(lead.customerPhone)) {
      clientId = await findOrCreateClient(dbClient, {
        name: lead.customerName || 'Thumbtack Lead',
        phone: lead.customerPhone,
        source: 'thumbtack',
        notes: `Thumbtack lead — email needed. Category: ${lead.category || 'N/A'}`,
      });
    }

    // Insert the Thumbtack lead
    await dbClient.query(
      `INSERT INTO thumbtack_leads (
        negotiation_id, client_id, customer_id, customer_name, customer_phone,
        category, description, location_city, location_state, location_zip,
        location_address, event_date, event_duration, guest_count, lead_type,
        lead_price, charge_state, budget_min, budget_max, budget_raw, raw_payload
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        lead.negotiationId, clientId, lead.customerId, truncate(lead.customerName, 255),
        truncate(lead.customerPhone, 50), truncate(lead.category, 255), truncate(lead.description),
        truncate(lead.locationCity, 255), truncate(lead.locationState, 50), truncate(lead.locationZip, 20),
        lead.locationAddress, lead.eventDate, lead.eventDuration,
        lead.guestCount, lead.leadType, lead.leadPrice, lead.chargeState,
        lead.budgetMin, lead.budgetMax, truncate(lead.budgetRaw, 500),
        JSON.stringify(body),
      ]
    );

    // Thumbtack never sends the customer email. If this client has no email yet,
    // flag it for the email harvester to fill in. Guarded so it only flips
    // not_needed -> pending: a client that already has an email, or is already
    // pending/harvested/failed, is left untouched.
    if (clientId) {
      await dbClient.query(
        `UPDATE clients SET email_harvest_status='pending'
         WHERE id=$1 AND email IS NULL AND email_harvest_status='not_needed'`,
        [clientId]
      );
    }

    await dbClient.query('COMMIT');
    console.log(`Thumbtack lead ${lead.negotiationId} saved — client ${clientId}`);

    // Post-commit side effects (best-effort draft + admin notification). A
    // failure here must NOT roll back lead capture or 500 the webhook.
    await runPostCommitSteps({ lead, clientId });

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
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
      const tpl = newThumbtackReviewAdmin({
        reviewerName: review.reviewerName,
        rating: review.rating,
        reviewText: review.reviewText,
      });
      await notifyAdminCategory({
        category: 'routine_thumbtack',
        subject: tpl.subject,
        emailHtml: tpl.html,
        emailText: tpl.text,
      });
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
module.exports.__setDeps = __setDeps;
module.exports.extractGuestCount = extractGuestCount; // exported for unit tests
module.exports.extractBudget = extractBudget; // exported for unit tests
module.exports.parseLead = parseLead; // exported for unit tests
module.exports.computeDurationHours = computeDurationHours; // exported for unit tests

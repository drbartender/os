const express = require('express');
const rateLimit = require('express-rate-limit');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { safeEqual } = require('../utils/secrets');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const { AppError, ValidationError } = require('../utils/errors');
const { logAdminAction } = require('../utils/adminAuditLog');
const { notifyAdminCategory } = require('../utils/adminNotifications');

// Dedicated router for the Thumbtack email-harvester agent + the admin manual-paste
// fallback. Mounted at /api/admin/thumbtack in server/index.js, BEFORE the general
// /api/admin router, so the agent-secret paths never hit that router's JWT auth.
// This is intentionally NOT the webhook router (which applies router.use(verifyWebhook)
// and warns-and-allows in dev); the agent auth fails closed in every environment.
const router = express.Router();

// Tighter than the public webhook (30/min): this is a single-box poller plus the
// admin paste UI, not high-volume inbound. The agent runs human-paced with jittered
// delays, so a real batch stays well under this; a burst is a signal, not normal.
const agentLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, message: { error: 'Too many requests' } });
router.use(agentLimiter);

function logAgentAuthFailure(req) {
  try {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureMessage('Thumbtack agent auth failure', {
        level: 'warning',
        tags: { component: 'thumbtack-harvester', reason: 'invalid_agent_secret' },
        extra: { method: req.method, path: req.originalUrl },
      });
    }
  } catch (_) { /* never let logging break the response */ }
}

/**
 * Timing-safe check of the agent shared secret. FAILS CLOSED in every environment:
 * when THUMBTACK_AGENT_SECRET is unset the secret path can never authenticate
 * (unlike the webhook's warn-and-allow-in-dev). A leaked secret still cannot stamp
 * arbitrary clients — the email-harvested write-guard is the second layer.
 */
function verifyAgentSecret(req) {
  const secret = process.env.THUMBTACK_AGENT_SECRET;
  if (!secret) return false; // fail closed, all envs
  return safeEqual(req.headers['x-thumbtack-agent-secret'], secret);
}

/** Agent-secret ONLY. The work-queue + failure-report routes (no admin-JWT path). */
function agentSecretOnly(req, res, next) {
  if (verifyAgentSecret(req)) { req.isAgent = true; return next(); }
  logAgentAuthFailure(req);
  return next(new AppError('Unauthorized', 401, 'NO_AGENT_SECRET'));
}

/** Agent-secret OR a valid admin/manager JWT. The email-harvested writeback (agent + paste UI). */
function agentOrAdmin(req, res, next) {
  if (verifyAgentSecret(req)) { req.isAgent = true; return next(); }
  // Fall through to standard staff JWT auth + admin/manager role guard.
  return auth(req, res, (err) => {
    if (err) return next(err);
    return requireAdminOrManager(req, res, next);
  });
}

// Server-side cooldown before a leased-but-unresolved lead is re-offered.
const HARVEST_COOLDOWN = process.env.HARVEST_COOLDOWN_INTERVAL || '6 hours';
const PENDING_DEFAULT_LIMIT = 25;
const PENDING_MAX_LIMIT = 100;

// GET /api/admin/thumbtack/pending-harvest?limit=N  — agent-secret only.
// Returns up to N { negotiation_id } for pending, email-null, past-cooldown clients
// that still have a non-terminal Thumbtack lead, and atomically LEASES each (stamps
// email_harvest_attempted_at=now()) in the SAME statement (FOR UPDATE SKIP LOCKED) so
// an overlapping poll can never re-hand the same lead. The lease does NOT touch
// email_harvest_attempts (the failure counter, bumped only by harvest-failed).
// negotiation_id is the latest NON-terminal lead. Kill-switch: HARVESTER_ENABLED='false'
// returns [] (a redeploy-free stop, even if the box is unreachable).
router.get('/pending-harvest', agentSecretOnly, asyncHandler(async (req, res) => {
  if (process.env.HARVESTER_ENABLED === 'false') return res.json([]);
  const requested = parseInt(req.query.limit, 10);
  const limit = Math.min(
    Number.isFinite(requested) && requested > 0 ? requested : PENDING_DEFAULT_LIMIT,
    PENDING_MAX_LIMIT
  );

  const { rows } = await pool.query(
    `WITH picked AS (
       SELECT c.id,
              (SELECT tl.negotiation_id
                 FROM thumbtack_leads tl
                WHERE tl.client_id = c.id
                  AND tl.status NOT IN ('converted','lost')
                ORDER BY tl.created_at DESC
                LIMIT 1) AS negotiation_id
         FROM clients c
        WHERE c.email_harvest_status = 'pending'
          AND c.email IS NULL
          AND (c.email_harvest_attempted_at IS NULL
               OR c.email_harvest_attempted_at < now() - $1::interval)
          AND EXISTS (SELECT 1 FROM thumbtack_leads tl2
                       WHERE tl2.client_id = c.id
                         AND tl2.status NOT IN ('converted','lost'))
        ORDER BY c.email_harvest_attempted_at NULLS FIRST, c.id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE clients
        SET email_harvest_attempted_at = now()
       FROM picked
      WHERE clients.id = picked.id
      RETURNING picked.negotiation_id`,
    [HARVEST_COOLDOWN, limit]
  );

  res.json(rows.filter((r) => r.negotiation_id).map((r) => ({ negotiation_id: r.negotiation_id })));
}));

// Wrong-address backstop. The agent's "non-pro email" pick is unverifiable server
// side, so refuse to stamp the pro's own domain, the admin inbox, or any ACTIVE
// staff/manager/admin address (a drifted pro-email read, or an admin typo). An
// ex-staff address (deactivated/rejected/suspended) is allowed: they may now be a
// real customer.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'contact@drbartender.com').trim().toLowerCase();
const PRO_DOMAIN = ADMIN_EMAIL.includes('@') ? ADMIN_EMAIL.split('@')[1] : null;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function isInternalAddress(email) {
  if (PRO_DOMAIN && email.endsWith(`@${PRO_DOMAIN}`)) return true;
  if (email === ADMIN_EMAIL) return true;
  // All users.role values are internal (there is no 'bartender' role; bartenders are
  // 'staff'), so any ACTIVE user's address is a wrong-address.
  const r = await pool.query(
    `SELECT 1 FROM users
      WHERE LOWER(email) = $1
        AND role IN ('staff','admin','manager')
        AND onboarding_status NOT IN ('deactivated','rejected','suspended')
      LIMIT 1`,
    [email]
  );
  return r.rows.length > 0;
}

// Best-effort drip re-arm. Flip a client's FUTURE, terminally-suppressed
// (client_no_email) proposal touches back to pending now that the email exists. Runs
// on its OWN pooled connection AFTER the writeback commit (never inside that tx). Keys
// on the BARE error_message='client_no_email' value the dispatcher stores (NOT a
// 'suppressed: ...' prefix); never resurrects a past-window touch (scheduled_for >
// now()); leaves suppressed_by_sibling / dead_letter rows alone.
async function rearmDripForClient(clientId) {
  await pool.query(
    `UPDATE scheduled_messages SET status='pending'
      WHERE entity_type='proposal'
        AND status='suppressed'
        AND error_message='client_no_email'
        AND scheduled_for > now()
        AND entity_id IN (SELECT id FROM proposals WHERE client_id = $1)`,
    [clientId]
  );
}

// Best-effort admin alert via the existing routine_thumbtack category. NEVER includes
// the customer email (PII).
async function fireHarvestAlert(reason, negotiationId) {
  try {
    const line = `Thumbtack email harvest hit "${reason}" for negotiation ${negotiationId}. Manual review needed.`;
    await notifyAdminCategory({
      category: 'routine_thumbtack',
      subject: `Thumbtack email harvest needs attention (${reason})`,
      emailHtml: `<p>${line}</p>`,
      emailText: line,
      smsBody: `Thumbtack harvest ${reason}: ${negotiationId} needs review`,
    });
  } catch (e) {
    console.error('[thumbtack-harvester] admin alert failed:', e.message);
  }
}

// POST /api/admin/thumbtack/email-harvested  { negotiation_id, email }
// Agent-secret OR admin/manager JWT. Sets clients.email + status 'harvested'. The
// AGENT path may only write a pending+null client (a leaked secret cannot stamp
// arbitrary rows); the ADMIN manual-paste path may override any status. A UNIQUE-email
// collision is terminal + alert on the AGENT path, but a recoverable 409 on the ADMIN
// path (human typo or real duplicate). NEVER auto-merges, NEVER stamps on collision.
router.post('/email-harvested', agentOrAdmin, asyncHandler(async (req, res) => {
  const negotiationId = String(req.body?.negotiation_id || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const isAgent = req.isAgent === true;

  if (!negotiationId) throw new ValidationError(null, 'negotiation_id is required');
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    throw new ValidationError(null, 'A valid email is required');
  }
  if (await isInternalAddress(email)) {
    throw new ValidationError(null, 'That address belongs to staff or admin, not a customer');
  }

  let outcome = null;
  let clientId = null;
  const db = await pool.connect();
  try {
    await db.query('BEGIN');

    const leadRes = await db.query('SELECT client_id FROM thumbtack_leads WHERE negotiation_id = $1', [negotiationId]);
    clientId = leadRes.rows[0] ? leadRes.rows[0].client_id : null;
    if (!clientId) {
      await db.query('ROLLBACK');
      outcome = 'lead_not_found';
    } else {
      const cRes = await db.query('SELECT email, email_harvest_status FROM clients WHERE id = $1 FOR UPDATE', [clientId]);
      const current = cRes.rows[0];
      if (!current) {
        await db.query('ROLLBACK');
        outcome = 'lead_not_found';
      } else if (current.email) {
        // Already resolved. Promote pending -> harvested only (preserve not_needed provenance).
        if (current.email_harvest_status === 'pending') {
          await db.query("UPDATE clients SET email_harvest_status='harvested' WHERE id = $1", [clientId]);
        }
        await db.query('COMMIT');
        outcome = 'already_set';
      } else if (isAgent && current.email_harvest_status !== 'pending') {
        await db.query('ROLLBACK');
        outcome = 'not_pending';
      } else {
        await db.query('SAVEPOINT set_email');
        try {
          // Single guarded UPDATE. Agent path requires pending+null (race-safe under the
          // lease); admin path overrides any status.
          const upd = isAgent
            ? await db.query(
                `UPDATE clients SET email=$1, email_harvest_status='harvested', email_harvest_attempted_at=now()
                  WHERE id=$2 AND email_harvest_status='pending' AND email IS NULL RETURNING id`,
                [email, clientId]
              )
            : await db.query(
                `UPDATE clients SET email=$1, email_harvest_status='harvested', email_harvest_attempted_at=now()
                  WHERE id=$2 RETURNING id`,
                [email, clientId]
              );
          if (upd.rowCount === 0) {
            await db.query('ROLLBACK TO SAVEPOINT set_email');
            await db.query('ROLLBACK');
            outcome = 'not_pending'; // status changed under the agent path between lease and write
          } else {
            await db.query('RELEASE SAVEPOINT set_email');
            await db.query('COMMIT');
            outcome = 'set';
          }
        } catch (err) {
          if (err.code === '23505') {
            await db.query('ROLLBACK TO SAVEPOINT set_email');
            if (isAgent) {
              await db.query("UPDATE clients SET email_harvest_status='failed' WHERE id = $1", [clientId]);
              await db.query('COMMIT');
              outcome = 'collision_agent';
            } else {
              await db.query('ROLLBACK');
              outcome = 'collision_admin';
            }
          } else {
            await db.query('ROLLBACK');
            throw err;
          }
        }
      }
    }
  } finally {
    db.release();
  }

  // Response + after-commit side effects. Email is NEVER logged.
  switch (outcome) {
    case 'lead_not_found':
      console.log(`[thumbtack-harvester] email-harvested ${negotiationId} -> lead_not_found`);
      return res.status(404).json({ status: 'lead_not_found' });
    case 'not_pending':
      console.log(`[thumbtack-harvester] email-harvested ${negotiationId} -> not_pending`);
      return res.status(409).json({ status: 'not_pending', error: 'This lead is no longer awaiting an email.' });
    case 'collision_admin':
      console.log(`[thumbtack-harvester] email-harvested ${negotiationId} -> collision (admin, recoverable)`);
      return res.status(409).json({ status: 'collision', error: 'That email already belongs to another client.' });
    case 'collision_agent':
      await fireHarvestAlert('collision', negotiationId);
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureMessage(`Thumbtack harvest collision ${negotiationId}`, { level: 'warning', tags: { component: 'thumbtack-harvester', reason: 'collision' } });
      }
      console.log(`[thumbtack-harvester] email-harvested ${negotiationId} -> collision (agent, failed)`);
      return res.status(409).json({ status: 'collision', error: 'That email already belongs to another client.' });
    case 'already_set':
      console.log(`[thumbtack-harvester] email-harvested ${negotiationId} -> already_set`);
      return res.status(200).json({ status: 'already_set' });
    case 'set':
      if (!isAgent) {
        // Admin override audit (the admin path stamped clients.email). Best-effort.
        logAdminAction({
          actorUserId: req.user?.id || null,
          targetUserId: null,
          action: 'thumbtack_email_harvested',
          metadata: { client_id: clientId, negotiation_id: negotiationId },
        });
      }
      rearmDripForClient(clientId).catch((e) => console.error('[thumbtack-harvester] drip re-arm failed:', e.message));
      console.log(`[thumbtack-harvester] email-harvested ${negotiationId} -> set`);
      return res.status(200).json({ status: 'set' });
    default:
      throw new AppError('email-harvested reached no outcome', 500, 'HARVEST_NO_OUTCOME');
  }
}));

// POST /api/admin/thumbtack/rearm  { negotiation_id }  — admin/manager JWT ONLY (no
// agent-secret path). Puts a FAILED lead back in the agent queue: status 'pending',
// attempts 0, attempted_at NULL (clears the cooldown so the agent re-picks it).
router.post('/rearm', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const negotiationId = String(req.body?.negotiation_id || '').trim();
  if (!negotiationId) throw new ValidationError(null, 'negotiation_id is required');

  const lead = await pool.query('SELECT client_id FROM thumbtack_leads WHERE negotiation_id = $1', [negotiationId]);
  const clientId = lead.rows[0] ? lead.rows[0].client_id : null;
  if (!clientId) return res.status(404).json({ status: 'lead_not_found' });

  const upd = await pool.query(
    `UPDATE clients
        SET email_harvest_status='pending', email_harvest_attempts=0, email_harvest_attempted_at=NULL
      WHERE id=$1 AND email_harvest_status='failed'
      RETURNING id`,
    [clientId]
  );
  if (upd.rowCount === 0) return res.status(409).json({ status: 'not_failed' });

  logAdminAction({
    actorUserId: req.user?.id || null,
    targetUserId: null,
    action: 'thumbtack_harvest_rearm',
    metadata: { client_id: clientId, negotiation_id: negotiationId },
  });
  console.log(`[thumbtack-harvester] rearm ${negotiationId} -> pending (by user ${req.user?.id})`);
  return res.status(200).json({ status: 'pending' });
}));

// Retry cap for transient agent failures before a lead is given up as 'failed'.
const MAX_HARVEST_ATTEMPTS = parseInt(process.env.MAX_HARVEST_ATTEMPTS, 10) > 0
  ? parseInt(process.env.MAX_HARVEST_ATTEMPTS, 10) : 3;
const HARVEST_FAIL_REASONS = new Set(['render_timeout', 'navigation_error', 'lead_not_found', 'ambiguous', 'session_expired']);

// POST /api/admin/thumbtack/harvest-failed  { negotiation_id, reason }  — agent-secret only.
router.post('/harvest-failed', agentSecretOnly, asyncHandler(async (req, res) => {
  const negotiationId = String(req.body?.negotiation_id || '').trim();
  const reason = String(req.body?.reason || '').trim();
  if (!negotiationId) throw new ValidationError(null, 'negotiation_id is required');
  if (!HARVEST_FAIL_REASONS.has(reason)) throw new ValidationError(null, 'invalid reason');

  // session_expired is an environment problem, not a per-lead failure: alert for
  // re-login, leave attempts and status untouched.
  if (reason === 'session_expired') {
    await fireHarvestAlert('session_expired', negotiationId);
    console.log(`[thumbtack-harvester] harvest-failed ${negotiationId} -> session_expired (re-login alert)`);
    return res.status(200).json({ status: 'session_expired' });
  }

  const lead = await pool.query('SELECT client_id FROM thumbtack_leads WHERE negotiation_id = $1', [negotiationId]);
  const clientId = lead.rows[0] ? lead.rows[0].client_id : null;
  if (!clientId) return res.status(404).json({ status: 'lead_not_found' });

  // ambiguous -> terminal failed + alert (never guess between >1 rendered email).
  if (reason === 'ambiguous') {
    await pool.query("UPDATE clients SET email_harvest_status='failed' WHERE id=$1 AND email_harvest_status='pending'", [clientId]);
    await fireHarvestAlert('ambiguous', negotiationId);
    console.log(`[thumbtack-harvester] harvest-failed ${negotiationId} -> ambiguous (failed)`);
    return res.status(200).json({ status: 'failed' });
  }

  // render_timeout | navigation_error | lead_not_found -> bump the counter; at the cap
  // mark failed + alert, otherwise leave pending (cooldown via attempted_at).
  const upd = await pool.query(
    `UPDATE clients SET email_harvest_attempts = email_harvest_attempts + 1
      WHERE id=$1 AND email_harvest_status='pending'
      RETURNING email_harvest_attempts`,
    [clientId]
  );
  if (upd.rowCount === 0) return res.status(200).json({ status: 'noop' }); // no longer pending; nothing to count
  const attempts = upd.rows[0].email_harvest_attempts;
  if (attempts >= MAX_HARVEST_ATTEMPTS) {
    await pool.query("UPDATE clients SET email_harvest_status='failed' WHERE id=$1 AND email_harvest_status='pending'", [clientId]);
    await fireHarvestAlert(`${reason} (max attempts)`, negotiationId);
    console.log(`[thumbtack-harvester] harvest-failed ${negotiationId} -> failed (attempts ${attempts})`);
    return res.status(200).json({ status: 'failed', attempts });
  }
  console.log(`[thumbtack-harvester] harvest-failed ${negotiationId} -> retry (attempts ${attempts}, reason ${reason})`);
  return res.status(200).json({ status: 'pending', attempts });
}));

module.exports = router;
module.exports.agentSecretOnly = agentSecretOnly;
module.exports.agentOrAdmin = agentOrAdmin;
module.exports.verifyAgentSecret = verifyAgentSecret;

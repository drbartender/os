/**
 * Admin CC-Import wrap-up worklist + enqueue.
 *
 * Plan Task 18. Surfaces Bucket B (CC-imported, status='completed',
 * event_date in the past) proposals so the operator can fire
 * `post_event_wrap_up_email` for events that pre-date the importer cut-over.
 *
 * Endpoints (all auth + requireAdminOrManager):
 *   GET  /admin/cc-import/wrap-up           worklist + header counts
 *   POST /admin/cc-import/wrap-up/preview   pre-flight delivery breakdown
 *   POST /admin/cc-import/wrap-up/enqueue   schedule the actual messages
 *
 * The preview endpoint uses `resolveChannelFallback` (pure, no I/O) so the
 * confirmation modal can show what WILL happen without writing 'suppressed'
 * rows or suspending automation as `resolveDelivery` would do. Enqueue itself
 * is best-effort per id with a per-row outcome enum; one bad id never blocks
 * the rest of a batch.
 */

const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../../../db');
const { auth, requireAdminOrManager } = require('../../../middleware/auth');
const asyncHandler = require('../../../middleware/asyncHandler');
const { ValidationError } = require('../../../utils/errors');
const { scheduleMessage } = require('../../../utils/messageScheduling');
const { resolveChannelFallback } = require('../../../utils/channelFallback');
const { logAdminAction } = require('../../../utils/adminAuditLog');

const router = express.Router();

const PAGE_SIZE = 50;
const MAX_BATCH = 50;
const NO_EMAIL_PATTERN = /^cc-import-noemail-.*@drbartender\.local$/i;

function isNoEmail(client) {
  if (!client) return true;
  if (client.email_status === 'bad') return true;
  if (typeof client.email === 'string' && NO_EMAIL_PATTERN.test(client.email)) return true;
  return false;
}

// ─── GET /admin/cc-import/wrap-up ─────────────────────────────────
// Worklist + header counts. Pagination + filter + date range via query
// string. `wrap_up_done` on each row reflects whether a pending or sent
// wrap-up message already exists (we do NOT count 'failed' / 'suppressed' as
// done — operator can retry those).
router.get(
  '/wrap-up',
  auth,
  requireAdminOrManager,
  asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * PAGE_SIZE;
    const filter = req.query.filter === 'all' ? 'all' : 'needs-wrapup';
    const range = req.query.range === 'last-30' ? 'last-30' : 'since-import';

    const where = [
      "p.cc_id IS NOT NULL",
      "p.status = 'completed'",
      "p.event_date < CURRENT_DATE",
    ];
    if (filter === 'needs-wrapup') {
      where.push(
        `NOT EXISTS (
           SELECT 1 FROM scheduled_messages sm
            WHERE sm.entity_type = 'proposal'
              AND sm.entity_id = p.id
              AND sm.message_type = 'post_event_wrap_up_email'
              AND sm.status IN ('pending','sent')
         )`
      );
    }
    if (range === 'last-30') {
      where.push("p.event_date >= CURRENT_DATE - INTERVAL '30 days'");
    }
    const whereSql = where.join('\n   AND ');

    const itemsSql = `
      SELECT p.id, p.cc_id, p.event_date, p.event_type, p.event_type_custom,
             p.total_price, p.amount_paid,
             c.id AS client_id, c.name AS client_name, c.email, c.email_status,
             EXISTS (
               SELECT 1 FROM scheduled_messages sm
                WHERE sm.entity_type = 'proposal'
                  AND sm.entity_id = p.id
                  AND sm.message_type = 'post_event_wrap_up_email'
                  AND sm.status IN ('pending','sent')
             ) AS wrap_up_done
        FROM proposals p
        JOIN clients c ON c.id = p.client_id
       WHERE ${whereSql}
       ORDER BY p.event_date DESC
       LIMIT ${PAGE_SIZE} OFFSET ${offset}
    `;
    const itemsRes = await pool.query(itemsSql);

    // Header counts are NOT filter-scoped — they describe the full Bucket B
    // population so the toggle UI can show "23 of 187 still need wrap-up".
    const countsRes = await pool.query(`
      SELECT
        COUNT(*) AS total_bucket_b,
        COUNT(*) FILTER (WHERE NOT EXISTS (
          SELECT 1 FROM scheduled_messages sm
           WHERE sm.entity_type = 'proposal' AND sm.entity_id = p.id
             AND sm.message_type = 'post_event_wrap_up_email'
             AND sm.status IN ('pending','sent')
        )) AS needs_wrapup,
        COUNT(*) FILTER (WHERE p.event_date >= CURRENT_DATE - INTERVAL '30 days') AS last_30
      FROM proposals p
      WHERE p.cc_id IS NOT NULL
        AND p.status = 'completed'
        AND p.event_date < CURRENT_DATE
    `);
    const counts = countsRes.rows[0] || { total_bucket_b: 0, needs_wrapup: 0, last_30: 0 };

    res.json({
      items: itemsRes.rows,
      counts: {
        total_bucket_b: Number(counts.total_bucket_b) || 0,
        needs_wrapup: Number(counts.needs_wrapup) || 0,
        last_30: Number(counts.last_30) || 0,
      },
      page,
      page_size: PAGE_SIZE,
      filter,
      range,
    });
  })
);

function validateProposalIds(body) {
  const ids = body && Array.isArray(body.proposal_ids) ? body.proposal_ids : null;
  if (!ids) {
    throw new ValidationError(undefined, 'proposal_ids is required (array of integers).');
  }
  if (ids.length === 0) {
    throw new ValidationError(undefined, 'proposal_ids must contain at least one id.');
  }
  if (ids.length > MAX_BATCH) {
    throw new ValidationError(undefined, `Maximum ${MAX_BATCH} proposals per batch.`);
  }
  const clean = [];
  for (const raw of ids) {
    const n = typeof raw === 'number' ? raw : parseInt(raw, 10);
    if (!Number.isInteger(n) || n <= 0) {
      throw new ValidationError(undefined, 'proposal_ids must be positive integers.');
    }
    clean.push(n);
  }
  return clean;
}

// ─── POST /admin/cc-import/wrap-up/preview ────────────────────────
// Pure pre-flight count for the confirmation modal. Uses
// `resolveChannelFallback` (no DB writes) instead of `resolveDelivery` so
// previewing the batch does NOT flip rows to 'suppressed' or send admin
// suspension emails. `category: 'operational'` mirrors the wrap-up handler's
// registration so marketing-disabled clients still count as 'proceed'.
router.post(
  '/wrap-up/preview',
  auth,
  requireAdminOrManager,
  asyncHandler(async (req, res) => {
    const ids = validateProposalIds(req.body);
    const breakdown = { proceed: 0, no_email: 0, suppressed: 0 };

    // One round-trip for the whole batch (was one SELECT per id — an N+1 of up
    // to MAX_BATCH=50 sequential queries). Classification stays per-id in JS.
    const { rows } = await pool.query(
      `SELECT p.id, p.status,
              c.id AS client_id, c.email, c.email_status, c.phone, c.phone_status,
              c.communication_preferences
         FROM proposals p
         JOIN clients c ON c.id = p.client_id
        WHERE p.id = ANY($1::int[])`,
      [ids]
    );
    const byId = new Map(rows.map((row) => [row.id, row]));

    for (const proposalId of ids) {
      const row = byId.get(proposalId);
      if (!row) continue;

      if (isNoEmail(row)) {
        breakdown.no_email += 1;
        continue;
      }

      const fallback = resolveChannelFallback({
        channel: 'email',
        client: row,
        category: 'operational',
      });
      if (!fallback || fallback.action !== 'proceed') {
        breakdown.suppressed += 1;
      } else {
        breakdown.proceed += 1;
      }
    }

    res.json({ total: ids.length, breakdown });
  })
);

// ─── POST /admin/cc-import/wrap-up/enqueue ────────────────────────
// Per-id best-effort scheduling. Outcomes:
//   enqueued        - new scheduled_messages row inserted + audit + activity log
//   already_enqueued - pending or sent wrap-up row exists (failed/suppressed are NOT in this set; operator can retry)
//   no_email        - bad email status or cc-import-noemail-*@drbartender.local placeholder
//   invalid_target  - not Bucket B (no cc_id / not completed / event_date in the future)
//   error           - unexpected exception, captured to Sentry
router.post(
  '/wrap-up/enqueue',
  auth,
  requireAdminOrManager,
  asyncHandler(async (req, res) => {
    const ids = validateProposalIds(req.body);
    const results = [];

    // Pre-fetch the proposal+client rows AND the already-enqueued set for the
    // whole batch in two round-trips (was two SELECTs PER id — up to ~2*50
    // sequential queries before any write). The per-row writes below stay
    // per-row; only the read prelude is batched.
    const { rows } = await pool.query(
      `SELECT p.id, p.cc_id, p.status, p.event_date,
              c.id AS client_id, c.email, c.email_status, c.phone, c.phone_status,
              c.communication_preferences
         FROM proposals p
         JOIN clients c ON c.id = p.client_id
        WHERE p.id = ANY($1::int[])`,
      [ids]
    );
    const byId = new Map(rows.map((row) => [row.id, row]));

    // Dedup against pending OR sent only — failed and suppressed are
    // retry-eligible (operator may try again after a Resend bounce).
    const dupRes = await pool.query(
      `SELECT entity_id
         FROM scheduled_messages
        WHERE entity_type = 'proposal'
          AND entity_id = ANY($1::int[])
          AND message_type = 'post_event_wrap_up_email'
          AND status IN ('pending','sent')`,
      [ids]
    );
    const alreadyEnqueued = new Set(dupRes.rows.map((d) => d.entity_id));

    // Computed once (was re-derived per id): pg returns DATE as a JS Date at UTC
    // midnight, so a past event_date is strictly less than today (UTC).
    const today = new Date(new Date().toISOString().slice(0, 10));

    for (const proposalId of ids) {
      try {
        const row = byId.get(proposalId);

        const isBucketB =
          row &&
          row.cc_id !== null && row.cc_id !== undefined &&
          row.status === 'completed' &&
          row.event_date &&
          new Date(row.event_date) < today;

        if (!isBucketB) {
          results.push({ proposal_id: proposalId, outcome: 'invalid_target' });
          continue;
        }

        if (isNoEmail(row)) {
          results.push({ proposal_id: proposalId, outcome: 'no_email' });
          continue;
        }

        if (alreadyEnqueued.has(proposalId)) {
          results.push({ proposal_id: proposalId, outcome: 'already_enqueued' });
          continue;
        }

        const scheduled = await scheduleMessage({
          entityType: 'proposal',
          entityId: proposalId,
          messageType: 'post_event_wrap_up_email',
          recipientType: 'client',
          recipientId: row.client_id,
          channel: 'email',
          scheduledFor: new Date(),
        });

        // scheduleMessage returns null when the partial unique index swallows
        // the insert (a concurrent admin clicked first). Treat as duplicate.
        if (!scheduled) {
          results.push({ proposal_id: proposalId, outcome: 'already_enqueued' });
          continue;
        }

        await pool.query(
          `INSERT INTO proposal_activity_log
             (proposal_id, action, actor_type, actor_id, details)
           VALUES ($1, 'cc_wrap_up_enqueued', 'admin', $2, $3::jsonb)`,
          [proposalId, req.user.id, JSON.stringify({ cc_id: row.cc_id })]
        );

        // admin_audit_log.target_user_id FK references users(id), not clients(id),
        // so the client_id rides in metadata instead of the column.
        await logAdminAction({
          actorUserId: req.user.id,
          targetUserId: null,
          action: 'cc_wrap_up_enqueued',
          metadata: { proposal_id: proposalId, cc_id: row.cc_id, client_id: row.client_id },
        });

        // Guard in-batch duplicates: a repeated id later in the same request
        // resolves to already_enqueued (the partial unique index would catch it
        // anyway, this just skips the redundant insert attempt).
        alreadyEnqueued.add(proposalId);

        results.push({ proposal_id: proposalId, outcome: 'enqueued' });
      } catch (err) {
        Sentry.captureException(err, {
          tags: { route: 'admin.cc-import.wrap-up.enqueue' },
          extra: { proposal_id: proposalId, admin_id: req.user?.id },
        });
        results.push({ proposal_id: proposalId, outcome: 'error', message: err.message });
      }
    }

    res.json({ results });
  })
);

module.exports = router;

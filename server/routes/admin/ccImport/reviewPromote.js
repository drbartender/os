/**
 * Admin CC-Import Review — force-promote endpoints (skipDedup, admin-only).
 *
 * Two operator-confirmed promote endpoints, extracted from review.js for the
 * line-count ratchet (CLAUDE.md §"File-size discipline") and because they share
 * one concern: re-running a phase-3 promotion with the §7.2 dedup check bypassed
 * after a human confirmed the CC row is genuinely new.
 *
 *   /review/duplicate/:row_id/promote      — §1 Suspected duplicates: promote anyway
 *   /review/skipped-event/:row_id/promote  — §6 Skipped (Bucket D): re-run phase 3
 *
 * Atomicity (audit batch 3c-roles): the promote and the legacy_cc_raw_imports
 * status flip run inside ONE transaction on a shared client. The phase3 promote
 * helpers honor `options.client` and leave BEGIN/COMMIT to the caller
 * (scripts/cc-import/phases/phase3.js _promote). Before this, the proposal
 * INSERT auto-committed on phase3's own connection while the status flip
 * auto-committed separately — so a failure between them left the raw row in its
 * pre-promote state with a committed proposal already created, and a retry
 * (skipDedup:true bypasses the §7.2 dedup guard) created a SECOND proposal. The
 * shared transaction makes a partial promote roll back together with the row, so
 * the row stays retry-safe with no orphaned proposal. This mirrors the already-
 * shipped orphan-payment payment path in review.js.
 *
 * Admin-only (audit decision: the whole cc-import surface is adminOnly; managers
 * no longer reach it).
 *
 * Spec reference: docs/superpowers/specs/2026-05-25-checkcherry-import-design.md §9.2 §1, §6.
 */

const express = require('express');
const { pool } = require('../../../db');
const { auth, adminOnly } = require('../../../middleware/auth');
const asyncHandler = require('../../../middleware/asyncHandler');
const { ValidationError, NotFoundError, ConflictError } = require('../../../utils/errors');
const { logAdminAction } = require('../../../utils/adminAuditLog');

const phase3 = require('../../../../scripts/cc-import/phases/phase3');

const router = express.Router();

function intParam(name, value) {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n)) {
    throw new ValidationError(undefined, `${name} must be an integer`);
  }
  return n;
}

// §1 — Suspected duplicates: promote (the CC row is actually new; bypass dedup).
// Refuses if the candidate proposal's updated_at > the row's imported_at (the
// operator might be about to clobber a human edit) unless confirm_candidate_edited.
router.post(
  '/review/duplicate/:row_id/promote',
  auth,
  adminOnly,
  asyncHandler(async (req, res) => {
    const rowId = intParam('row_id', req.params.row_id);
    const confirmEdited = req.body?.confirm_candidate_edited === true;

    const guard = await pool.query(
      `SELECT id, import_status, import_notes, payload, imported_at
         FROM legacy_cc_raw_imports
        WHERE id = $1 AND source_entity = 'events'`,
      [rowId]
    );
    if (guard.rowCount === 0) throw new NotFoundError('row not found');
    if (guard.rows[0].import_status !== 'duplicate_review') {
      throw new ConflictError('row is not in duplicate_review state');
    }
    const raw = guard.rows[0];
    const candidateId = raw.import_notes?.candidate_proposal_id || null;

    // Candidate-edited check — only when notes carried a candidate id.
    if (candidateId && !confirmEdited) {
      const cand = await pool.query(
        `SELECT updated_at FROM proposals WHERE id = $1`, [candidateId]
      );
      if (cand.rowCount > 0) {
        const candidateUpdated = cand.rows[0].updated_at;
        if (candidateUpdated && new Date(candidateUpdated) > new Date(raw.imported_at)) {
          throw new ConflictError(
            `Candidate proposal #${candidateId} has been edited since import (${candidateUpdated.toISOString?.() || candidateUpdated}). ` +
              `Pass confirm_candidate_edited: true to promote anyway.`,
            'CC_CANDIDATE_EDITED'
          );
        }
      }
    }

    // Atomic: re-run Bucket A promotion (dedup skipped) and flip the raw-import
    // status in ONE transaction so a failure can't strand a committed proposal
    // behind a still-promotable row (a retry would then double-create).
    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await phase3.promoteBucketA(raw.payload, { skipDedup: true, client });
      if (result.status !== 'promoted' && result.status !== 'already_promoted') {
        throw new ConflictError(`Promote failed: ${result.error || result.status}`, 'CC_PROMOTE_FAILED');
      }
      const newNotes = {
        ...(raw.import_notes || {}),
        decision: 'promote_anyway',
        resolved_by_user_id: req.user.id,
        resolved_at: new Date().toISOString(),
        proposal_id: result.proposalId || null,
        candidate_edited_confirmed: confirmEdited,
      };
      await client.query(
        `UPDATE legacy_cc_raw_imports
            SET import_status = 'duplicate_confirmed',
                import_notes = $2::jsonb
          WHERE id = $1`,
        [rowId, JSON.stringify(newNotes)]
      );
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* swallow */ }
      throw err;
    } finally {
      client.release();
    }

    await logAdminAction({
      actorUserId: req.user.id,
      targetUserId: null,
      action: 'cc_review_duplicate_promoted',
      metadata: {
        row_id: rowId,
        candidate_proposal_id: candidateId,
        promoted_proposal_id: result.proposalId || null,
        candidate_edited_confirmed: confirmEdited,
      },
    });

    res.json({ ok: true, decision: 'promote_anyway', proposal_id: result.proposalId || null });
  })
);

// §6 — Skipped (Bucket D): re-run phase 3 with the skip rule bypassed.
router.post(
  '/review/skipped-event/:row_id/promote',
  auth,
  adminOnly,
  asyncHandler(async (req, res) => {
    const rowId = intParam('row_id', req.params.row_id);

    const guard = await pool.query(
      `SELECT id, payload, import_status, source_entity
         FROM legacy_cc_raw_imports
        WHERE id = $1`,
      [rowId]
    );
    if (guard.rowCount === 0) throw new NotFoundError('row not found');
    if (guard.rows[0].import_status !== 'skipped' || guard.rows[0].source_entity !== 'events') {
      throw new ConflictError('row is not a skipped event');
    }

    // Reclassify by status + event_date so a past-dated event lands in Bucket B
    // (completed, no auto-comms enrollment) instead of being force-promoted as
    // Bucket A and scheduling stale reminders. classifyForRetry mirrors the
    // initial phase 3 pass via buildRowContext + classify; C/D degrade to A
    // (archive paths aren't single-row callable) with the genuine bucket letter
    // preserved in the audit log.
    const { bucket, promote } = phase3.classifyForRetry(guard.rows[0].payload);

    // Atomic: promote + status flip in one transaction (see /duplicate above).
    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await promote(guard.rows[0].payload, { skipDedup: true, client });
      if (result.status !== 'promoted' && result.status !== 'already_promoted') {
        throw new ConflictError(`Promote failed: ${result.error || result.status}`, 'CC_PROMOTE_FAILED');
      }
      await client.query(
        `UPDATE legacy_cc_raw_imports
            SET import_status = 'promoted',
                import_notes = $2::jsonb
          WHERE id = $1`,
        [rowId, JSON.stringify({
          promoted_by_user_id: req.user.id,
          promoted_at: new Date().toISOString(),
          proposal_id: result.proposalId || null,
          skip_rule_bypassed: true,
          retry_bucket: bucket,
        })]
      );
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* swallow */ }
      throw err;
    } finally {
      client.release();
    }

    await logAdminAction({
      actorUserId: req.user.id,
      targetUserId: null,
      action: 'cc_review_skipped_event_promoted',
      metadata: { row_id: rowId, proposal_id: result.proposalId || null, retry_bucket: bucket },
    });

    res.json({ ok: true, proposal_id: result.proposalId || null });
  })
);

module.exports = router;

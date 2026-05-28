/**
 * Admin CC-Import Review page — Section 9.2 worklist + 10 action endpoints.
 *
 * GET /admin/cc-import/review
 *   Returns all 7 sections in one shot (50 rows per section). Lets the
 *   front-end render every collapsible at once without a per-section fetch.
 *
 * 8 mutation endpoints (all auth + requireAdminOrManager, all audited):
 *
 *   /duplicate/:row_id/confirm                 — flip duplicate_review → confirmed
 *   /duplicate/:row_id/promote                 — re-run Bucket A promote (skipDedup)
 *   /orphan-payment/:legacy_id/link            — set cc_event_id + promote
 *   /orphan-payment/:legacy_id/dismiss         — set dismissed_at + notes
 *   /unmatched-payee/:legacy_payout_id/link    — reassign shift_requests + audit
 *   /unmatched-payee/:legacy_payout_id/create-stub  — fresh stub + link payout
 *   /errored-row/:row_id/retry                 — re-run per-row insert
 *   /skipped-event/:row_id/promote             — re-run phase3 promotion
 *
 * Phase 0 give-up endpoints (accept-loss, revert-give-up — Section 9.2 §7) live
 * in sibling phase0.js, mounted by index.js. Extracted for file-size discipline.
 *
 * The link picker endpoints (/search/proposals, /search/users) and the
 * /link-preview pre-check live in search.js (sibling router on the same path
 * prefix).
 *
 * Spec reference: docs/superpowers/specs/2026-05-25-checkcherry-import-design.md §9.2, §9.3.E.
 * Plan reference: docs/superpowers/plans/2026-05-26-checkcherry-import.md Task 19.
 */

const express = require('express');
const Sentry = require('@sentry/node');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const { pool } = require('../../../db');
const { auth, requireAdminOrManager } = require('../../../middleware/auth');
const asyncHandler = require('../../../middleware/asyncHandler');
const { ValidationError, NotFoundError, ConflictError } = require('../../../utils/errors');
const { logAdminAction } = require('../../../utils/adminAuditLog');
const { accruePayoutsForProposal } = require('../../../utils/payrollAccrual');

const phase3 = require('../../../../scripts/cc-import/phases/phase3');
const phase4 = require('../../../../scripts/cc-import/phases/phase4');
const { buildStubCcId } = require('../../../../scripts/cc-import/lib/fuzzyName');

const router = express.Router();

// ── helpers ──────────────────────────────────────────────────────────────

function intParam(name, value) {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n)) {
    throw new ValidationError(undefined, `${name} must be an integer`);
  }
  return n;
}

function trimText(name, value, { required = false, max = 2000, min = 0 } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new ValidationError(undefined, `${name} is required`);
    return null;
  }
  const s = String(value).trim();
  if (s.length < min) throw new ValidationError(undefined, `${name} must be at least ${min} chars`);
  if (s.length > max) throw new ValidationError(undefined, `${name} exceeds ${max} chars`);
  return s;
}

function reportException(req, err, extra = {}) {
  try {
    Sentry.captureException(err, {
      tags: { route: req.path, user_id: req.user?.id },
      extra,
    });
  } catch (_) { /* best-effort */ }
}

// ─────────────────────────────────────────────────────────────────
// GET /admin/cc-import/review — all 7 sections in one shot
// ─────────────────────────────────────────────────────────────────
router.get(
  '/review',
  auth,
  requireAdminOrManager,
  asyncHandler(async (req, res) => {
    const [
      duplicates,
      orphans,
      payees,
      unmatchedStaffRuns,
      errored,
      skipped,
      phase0Eligible,
      phase0Done,
      lastRun,
    ] = await Promise.all([
      pool.query(
        `SELECT id, source_row_number, payload, import_notes, imported_at
           FROM legacy_cc_raw_imports
          WHERE import_status = 'duplicate_review'
            AND source_entity = 'events'
          ORDER BY id
          LIMIT 50`
      ),
      pool.query(
        `SELECT id, cc_event_title, cc_type, paid_on, event_date,
                payment_applied_cents, payment_method, reference_code,
                paid_by, public_notes, private_notes, notes, dismissed_at
           FROM legacy_cc_payments
          WHERE promoted_payment_id IS NULL
            AND promoted_refund_id IS NULL
            AND cc_event_id IS NULL
            AND dismissed_at IS NULL
          ORDER BY id
          LIMIT 50`
      ),
      pool.query(
        `SELECT id, payee_name, payee_name_normalized, payee_user_id, paid_on,
                amount_cents, reference_role, category
           FROM legacy_cc_payouts
          WHERE payee_user_id IS NULL
          ORDER BY id
          LIMIT 50`
      ),
      pool.query(
        `SELECT notes FROM cc_import_runs WHERE phase = 3 ORDER BY id DESC LIMIT 1`
      ),
      pool.query(
        `SELECT id, source_entity, source_row_number, payload, import_notes, imported_at
           FROM legacy_cc_raw_imports
          WHERE import_status = 'errored'
          ORDER BY id
          LIMIT 50`
      ),
      pool.query(
        `SELECT id, source_row_number, payload, import_notes, imported_at
           FROM legacy_cc_raw_imports
          WHERE import_status = 'skipped'
            AND source_entity = 'events'
          ORDER BY id
          LIMIT 50`
      ),
      pool.query(
        `SELECT id, source_url, source_entity, attempt_count, last_error, last_attempted_at
           FROM cc_import_phase0_failures
          WHERE attempt_count >= 10
            AND given_up_at IS NULL
            AND resolved_at IS NULL
          ORDER BY id
          LIMIT 50`
      ),
      pool.query(
        `SELECT id, source_url, source_entity, attempt_count, last_error,
                given_up_at, given_up_reason
           FROM cc_import_phase0_failures
          WHERE given_up_at IS NOT NULL
          ORDER BY given_up_at DESC
          LIMIT 50`
      ),
      pool.query(
        `SELECT id, phase, status, error_summary, started_at, finished_at
           FROM cc_import_runs
          ORDER BY id DESC
          LIMIT 1`
      ),
    ]);

    // Unmatched-staff names live in cc_import_runs.notes JSON. Phase 3 writes
    // `[ ...samples, { unmatched_staff: [...] }, { buckets: ... } ]`; we pluck
    // the unmatched_staff entry (or default to []).
    let unmatchedStaff = [];
    const noteRows = unmatchedStaffRuns.rows[0]?.notes;
    if (Array.isArray(noteRows)) {
      const entry = noteRows.find((n) => n && typeof n === 'object' && Array.isArray(n.unmatched_staff));
      if (entry) unmatchedStaff = entry.unmatched_staff;
    }

    res.json({
      duplicates: duplicates.rows,
      orphans: orphans.rows,
      unmatchedPayees: payees.rows,
      unmatchedStaff,
      errored: errored.rows,
      skipped: skipped.rows,
      phase0Eligible: phase0Eligible.rows,
      phase0Done: phase0Done.rows,
      lastRun: lastRun.rows[0] || null,
    });
  })
);

// ─────────────────────────────────────────────────────────────────
// Action endpoints — Section 9.2 §1-§7
// ─────────────────────────────────────────────────────────────────

// §1 — Suspected duplicates: confirm (it really is a duplicate; archive).
router.post(
  '/review/duplicate/:row_id/confirm',
  auth,
  requireAdminOrManager,
  asyncHandler(async (req, res) => {
    const rowId = intParam('row_id', req.params.row_id);

    const guard = await pool.query(
      `SELECT id, import_status, import_notes
         FROM legacy_cc_raw_imports
        WHERE id = $1 AND source_entity = 'events'`,
      [rowId]
    );
    if (guard.rowCount === 0) throw new NotFoundError('row not found');
    if (guard.rows[0].import_status !== 'duplicate_review') {
      throw new ConflictError('row is not in duplicate_review state');
    }

    // Preserve any pre-existing notes (e.g. candidate_proposal_id) by merging
    // the decision flag into the existing JSON.
    const oldNotes = guard.rows[0].import_notes || {};
    const newNotes = {
      ...oldNotes,
      decision: 'duplicate',
      resolved_by_user_id: req.user.id,
      resolved_at: new Date().toISOString(),
    };

    await pool.query(
      `UPDATE legacy_cc_raw_imports
          SET import_status = 'duplicate_confirmed',
              import_notes = $2::jsonb
        WHERE id = $1`,
      [rowId, JSON.stringify(newNotes)]
    );

    await logAdminAction({
      actorUserId: req.user.id,
      targetUserId: null,
      action: 'cc_review_duplicate_confirmed',
      metadata: { row_id: rowId, candidate_proposal_id: oldNotes.candidate_proposal_id || null },
    });

    res.json({ ok: true, decision: 'duplicate' });
  })
);

// §1 — Suspected duplicates: promote (the CC row is actually new; bypass dedup).
// Refuses if the candidate proposal's updated_at > the row's imported_at (the
// operator might be about to clobber a human edit) unless confirm_candidate_edited.
router.post(
  '/review/duplicate/:row_id/promote',
  auth,
  requireAdminOrManager,
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

    // Re-run Bucket A promotion with dedup skipped.
    const result = await phase3.promoteBucketA(raw.payload, { skipDedup: true });

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

    await pool.query(
      `UPDATE legacy_cc_raw_imports
          SET import_status = 'duplicate_confirmed',
              import_notes = $2::jsonb
        WHERE id = $1`,
      [rowId, JSON.stringify(newNotes)]
    );

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

// §2 — Orphan payment: link to a proposal + re-promote single row.
router.post(
  '/review/orphan-payment/:legacy_id/link',
  auth,
  requireAdminOrManager,
  asyncHandler(async (req, res) => {
    const legacyId = intParam('legacy_id', req.params.legacy_id);
    const proposalId = intParam('proposal_id', req.body?.proposal_id);

    const legacyRes = await pool.query(
      `SELECT id, cc_event_id, cc_type, promoted_payment_id, promoted_refund_id, dismissed_at
         FROM legacy_cc_payments WHERE id = $1`,
      [legacyId]
    );
    if (legacyRes.rowCount === 0) throw new NotFoundError('legacy_cc_payments row not found');
    const legacy = legacyRes.rows[0];
    if (legacy.dismissed_at) throw new ConflictError('row was already dismissed');
    if (legacy.promoted_payment_id || legacy.promoted_refund_id) {
      throw new ConflictError('row was already promoted');
    }
    if (legacy.cc_event_id) {
      throw new ConflictError('row is not an orphan (cc_event_id already set)');
    }

    // Look up the target proposal's cc_id (must exist + be a cc-imported row;
    // linking to a native proposal would orphan it from the cc-imported recompute).
    const propRes = await pool.query(
      `SELECT id, cc_id FROM proposals WHERE id = $1`, [proposalId]
    );
    if (propRes.rowCount === 0) throw new NotFoundError('proposal not found');
    if (!propRes.rows[0].cc_id) {
      throw new ConflictError('target proposal is not a cc-imported proposal');
    }
    const targetCcId = propRes.rows[0].cc_id;

    // UPDATE legacy_cc_payments.cc_event_id + promote in ONE atomic step so
    // an exception in promote cannot leave the orphan row half-linked (cc_event_id
    // set but promoted_*_id NULL — which would drop the row from the orphans
    // worklist filter `cc_event_id IS NULL`, removing the operator's recovery path).
    //
    // Two execution paths because the helpers have different transaction shapes:
    //   - Payment: promoteSingleLegacyPayment(id, { client }) cooperates with a
    //     caller-managed transaction → wrap UPDATE + promote in a single BEGIN/COMMIT.
    //   - Refund: promoteSingleLegacyRefund(id) MUST own its own connection (per
    //     refundHelpers.js Approach A — proposal row-locks against autopay), so
    //     we cannot share a transaction. Fallback: UPDATE first, and on promote
    //     throw, revert cc_event_id back to NULL before re-raising. The revert
    //     is best-effort but the failure window is one statement wide.
    let promoteResult;
    if (legacy.cc_type === 'Refund') {
      // Refund path — UPDATE + explicit revert-on-throw. promoteSingleLegacyRefund
      // MUST own its own connection (Approach A; cannot share a txn). Add a status
      // check after the call so non-success non-throws still trigger the existing
      // revert catch block via re-throw.
      await pool.query(
        `UPDATE legacy_cc_payments SET cc_event_id = $1 WHERE id = $2`,
        [targetCcId, legacyId]
      );
      try {
        promoteResult = await phase4.promoteSingleLegacyRefund(legacyId);
        if (promoteResult.status !== 'promoted' && promoteResult.status !== 'already_promoted') {
          throw new ConflictError(
            `Promote failed: ${promoteResult.error || promoteResult.status}`,
            'CC_PROMOTE_FAILED'
          );
        }
      } catch (err) {
        // Revert the cc_event_id assignment so the orphan stays on the worklist.
        try {
          await pool.query(
            `UPDATE legacy_cc_payments SET cc_event_id = NULL WHERE id = $1
                AND promoted_payment_id IS NULL AND promoted_refund_id IS NULL`,
            [legacyId]
          );
        } catch (revertErr) {
          reportException(req, revertErr, { step: 'cc_event_id_revert', legacyId });
        }
        // ConflictError is the operator-visible failure — don't Sentry-spam on it.
        if (!(err instanceof ConflictError)) {
          reportException(req, err, { step: 'promote_single', legacyId });
        }
        throw err;
      }
    } else {
      // Payment path — shared transaction. The cc_event_id UPDATE and the promote
      // MUST be atomic so a non-success promote does not strand cc_event_id set
      // (which would drop the row off the orphan queue's `cc_event_id IS NULL`
      // filter without actually promoting it).
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE legacy_cc_payments SET cc_event_id = $1 WHERE id = $2`,
          [targetCcId, legacyId]
        );
        promoteResult = await phase4.promoteSingleLegacyPayment(legacyId, { client });
        if (promoteResult.status !== 'promoted' && promoteResult.status !== 'already_promoted') {
          // Throw so BEGIN rolls back the cc_event_id UPDATE — keeps the row in the
          // orphan queue with a recovery path.
          throw new ConflictError(
            `Promote failed: ${promoteResult.error || promoteResult.status}`,
            'CC_PROMOTE_FAILED'
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* swallow */ }
        // ConflictError is the operator-visible failure — don't Sentry-spam on it.
        if (!(err instanceof ConflictError)) {
          reportException(req, err, { step: 'promote_single', legacyId });
        }
        throw err;
      } finally {
        client.release();
      }
    }

    // Proposal-wide recompute + re-derive (spec §9.2 §2): keep the proposal in
    // sync after the link. These helpers run across ALL cc-imported proposals
    // but are idempotent UPDATEs; cheap enough on the small import dataset. They
    // intentionally run OUTSIDE the link transaction (post-COMMIT) — they are
    // proposal-wide cleanups that should fire only after the promote committed.
    const tail = await pool.connect();
    try {
      await phase4.recomputeAmountPaid(tail);
      await phase4.rederivePaymentTypeAndStatus(tail);
      // Mirror phase4.run() — when a manual link fully settles a future proposal,
      // any already-scheduled balance_* rows must be suppressed so they don't
      // fire. No BEGIN on this connection, so the UPDATE auto-commits.
      await phase4.suppressStaleBalanceReminders(tail);
    } finally {
      tail.release();
    }

    await logAdminAction({
      actorUserId: req.user.id,
      targetUserId: null,
      action: 'cc_review_orphan_payment_linked',
      metadata: {
        legacy_id: legacyId, proposal_id: proposalId, cc_id: targetCcId,
        cc_type: legacy.cc_type, promote_status: promoteResult?.status,
      },
    });

    res.json({ ok: true, promote_status: promoteResult?.status, proposal_id: proposalId });
  })
);

// §2 — Orphan payment: dismiss with an optional reason note.
router.post(
  '/review/orphan-payment/:legacy_id/dismiss',
  auth,
  requireAdminOrManager,
  asyncHandler(async (req, res) => {
    const legacyId = intParam('legacy_id', req.params.legacy_id);
    const reason = trimText('reason', req.body?.reason, { max: 2000 });

    const guard = await pool.query(
      `SELECT id, dismissed_at, cc_event_id, promoted_payment_id, promoted_refund_id
         FROM legacy_cc_payments WHERE id = $1`,
      [legacyId]
    );
    if (guard.rowCount === 0) throw new NotFoundError('legacy_cc_payments row not found');
    if (guard.rows[0].dismissed_at) throw new ConflictError('row was already dismissed');

    await pool.query(
      `UPDATE legacy_cc_payments
          SET dismissed_at = NOW(), notes = $2
        WHERE id = $1`,
      [legacyId, reason]
    );

    await logAdminAction({
      actorUserId: req.user.id,
      targetUserId: null,
      action: 'cc_review_orphan_payment_dismissed',
      metadata: { legacy_id: legacyId, reason: reason || null },
    });

    res.json({ ok: true });
  })
);

// §3 — Unmatched payee: link to a real user. Reassigns shift_requests with
// the spec §9.3.E DELETE 1a/1b dedup, audits per inherited proposal, then
// runs post-COMMIT best-effort auto-reaccrue on separate connections.
router.post(
  '/review/unmatched-payee/:legacy_payout_id/link',
  auth,
  requireAdminOrManager,
  asyncHandler(async (req, res) => {
    const legacyPayoutId = intParam('legacy_payout_id', req.params.legacy_payout_id);
    const userId = intParam('user_id', req.body?.user_id);

    // Existence check on the target user (early NotFoundError beats a cryptic
    // FK violation later).
    const userCheck = await pool.query(`SELECT id, cc_id FROM users WHERE id = $1`, [userId]);
    if (userCheck.rowCount === 0) throw new NotFoundError('target user not found');
    if (/^legacy_cc:/.test(String(userCheck.rows[0].cc_id || ''))) {
      throw new ConflictError('cannot link a payout to a stub user — pick a real user', 'CC_TARGET_IS_STUB');
    }

    const client = await pool.connect();
    let inheritedProposalIds = [];
    let stubUserId;
    let deletedRows1a = [];
    let deletedRows1b = [];

    try {
      await client.query('BEGIN');

      const stubRow = await client.query(
        `SELECT payee_user_id FROM legacy_cc_payouts WHERE id = $1 FOR UPDATE`,
        [legacyPayoutId]
      );
      if (stubRow.rowCount === 0) {
        await client.query('ROLLBACK');
        throw new NotFoundError('legacy_cc_payouts row not found');
      }
      stubUserId = stubRow.rows[0].payee_user_id;
      if (stubUserId === null || stubUserId === undefined) {
        // Payout had no stub assigned at all — just set the link, no shift
        // reassignment needed.
        await client.query(
          `UPDATE legacy_cc_payouts SET payee_user_id = $1 WHERE id = $2`,
          [userId, legacyPayoutId]
        );
        await client.query('COMMIT');
        await logAdminAction({
          actorUserId: req.user.id,
          targetUserId: null,
          action: 'cc_review_unmatched_payee_linked',
          metadata: {
            legacy_payout_id: legacyPayoutId, user_id: userId,
            stub_user_id: null, inherited_proposals: 0, no_stub_path: true,
          },
        });
        return res.json({ ok: true, inherited_proposal_count: 0, no_stub_path: true });
      }

      // Update the payout link first.
      await client.query(
        `UPDATE legacy_cc_payouts SET payee_user_id = $1 WHERE id = $2`,
        [userId, legacyPayoutId]
      );

      // Capture the stub's PRE-deletes proposal set up front. We use this for
      // both the audit log AND the post-COMMIT reaccrue loop — operating on the
      // EXACT set of proposals the stub participated in, not the real user's
      // full approved set (which would sweep in unrelated proposals the real
      // user already worked).
      const stubProposalsRes = await client.query(
        `SELECT DISTINCT s.proposal_id
           FROM shift_requests sr
           JOIN shifts s ON s.id = sr.shift_id
          WHERE sr.user_id = $1`,
        [stubUserId]
      );
      inheritedProposalIds = stubProposalsRes.rows
        .map((r) => r.proposal_id)
        .filter((id) => id !== null && id !== undefined);

      // Collision guard: reject Step 2 if BOTH stub and real user have
      // non-approved rows on the same shift. The importer (Phase 5) writes
      // stub shift_requests as 'approved' — a non-approved stub row implies a
      // post-import edit. DELETE 1a only fires when stub is approved; DELETE 1b
      // only fires when real user is approved; so a both-pending or both-denied
      // pair would slip through and crash Step 2's UPDATE on UNIQUE(shift_id, user_id).
      const conflictCheck = await client.query(
        `SELECT sr.shift_id
           FROM shift_requests sr
           JOIN shift_requests sr2
             ON sr.shift_id = sr2.shift_id
            AND sr.user_id = $1
            AND sr2.user_id = $2
          WHERE sr.status NOT IN ('approved')
            AND sr2.status NOT IN ('approved')
          LIMIT 5`,
        [stubUserId, userId]
      );
      if (conflictCheck.rowCount > 0) {
        await client.query('ROLLBACK');
        throw new ConflictError(
          `Cannot link: stub and real user both have non-approved shift_requests on shift(s) ${conflictCheck.rows.map((r) => r.shift_id).join(', ')}. ` +
            'Manually resolve one side in the shift admin UI before linking.',
          'CC_LINK_NON_APPROVED_COLLISION'
        );
      }

      // Step 1a: drop now-real user's non-approved rows where stub is approved
      // on the same shift (preserve the approved money path).
      const delA = await client.query(
        `DELETE FROM shift_requests sr
           WHERE sr.user_id = $1
             AND sr.status IN ('pending','denied')
             AND EXISTS (
               SELECT 1 FROM shift_requests sr2
                WHERE sr2.shift_id = sr.shift_id
                  AND sr2.user_id = $2
                  AND sr2.status = 'approved'
             )
           RETURNING shift_id, user_id, status`,
        [userId, stubUserId]
      );
      deletedRows1a = delA.rows;

      // Step 1b: drop stub rows where now-real user is already approved (true dup).
      const delB = await client.query(
        `DELETE FROM shift_requests sr
           WHERE sr.user_id = $1
             AND EXISTS (
               SELECT 1 FROM shift_requests sr2
                WHERE sr2.shift_id = sr.shift_id
                  AND sr2.user_id = $2
                  AND sr2.status = 'approved'
             )
           RETURNING shift_id, user_id, status`,
        [stubUserId, userId]
      );
      deletedRows1b = delB.rows;

      // Step 2: reassign any remaining stub rows to the now-real user. DELETE
      // 1a/1b cleared the approved-vs-(pending|denied) collisions; the guard
      // above rejected the rare both-non-approved collision.
      await client.query(
        `UPDATE shift_requests SET user_id = $1 WHERE user_id = $2`,
        [userId, stubUserId]
      );

      // Audit trail per spec §9.3.E: ONE proposal_activity_log entry per
      // affected proposal recording the deleted rows. The deleted_rows snapshot
      // is the global 1a+1b set (we don't have a cheap shift→proposal map
      // here at row-level; the proposal_id on the row itself disambiguates).
      const allDeleted = [...deletedRows1a, ...deletedRows1b].map((d) => ({
        shift_id: d.shift_id, was_user_id: d.user_id, was_status: d.status,
      }));
      for (const pid of inheritedProposalIds) {
        await client.query(
          `INSERT INTO proposal_activity_log
             (proposal_id, action, actor_type, actor_id, details)
           VALUES ($1, 'cc_link_shift_request_dedup', 'admin', $2, $3::jsonb)`,
          [
            pid,
            req.user.id,
            JSON.stringify({
              stub_user_id: stubUserId,
              now_real_user_id: userId,
              legacy_payout_id: legacyPayoutId,
              deleted_rows: allDeleted,
            }),
          ]
        );
      }

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
      action: 'cc_review_unmatched_payee_linked',
      metadata: {
        legacy_payout_id: legacyPayoutId,
        user_id: userId,
        stub_user_id: stubUserId,
        inherited_proposals: inheritedProposalIds.length,
        deleted_1a: deletedRows1a.length,
        deleted_1b: deletedRows1b.length,
      },
    });

    // Step 4 — post-COMMIT auto-reaccrue (best-effort, per-proposal on its own
    // connection). The link itself is the irreversible operator decision; if
    // accrual hiccups on one proposal, the operator hits the per-user
    // "Re-accrue payouts" button (Section 9.3.E future work).
    for (const pid of inheritedProposalIds) {
      try {
        await accruePayoutsForProposal(pid);
      } catch (err) {
        reportException(req, err, { step: 'auto_reaccrue', proposalId: pid, stubUserId, userId });
      }
    }

    res.json({
      ok: true,
      inherited_proposal_count: inheritedProposalIds.length,
      deleted_pending_or_denied: deletedRows1a.length,
      deleted_dup_stub_rows: deletedRows1b.length,
      stub_user_id: stubUserId,
    });
  })
);

// §3 — Unmatched payee: create a fresh stub user + link the payout. Used when
// no real user matches and the operator wants to preserve the historic name.
router.post(
  '/review/unmatched-payee/:legacy_payout_id/create-stub',
  auth,
  requireAdminOrManager,
  asyncHandler(async (req, res) => {
    const legacyPayoutId = intParam('legacy_payout_id', req.params.legacy_payout_id);

    const payoutRes = await pool.query(
      `SELECT id, payee_name, paid_on, payee_user_id FROM legacy_cc_payouts WHERE id = $1`,
      [legacyPayoutId]
    );
    if (payoutRes.rowCount === 0) throw new NotFoundError('legacy_cc_payouts row not found');
    const payout = payoutRes.rows[0];
    if (payout.payee_user_id !== null && payout.payee_user_id !== undefined) {
      throw new ConflictError('payout is already linked to a user');
    }

    const earliestIso = payout.paid_on instanceof Date
      ? payout.paid_on.toISOString().slice(0, 10)
      : String(payout.paid_on || '').slice(0, 10);
    const { ccId, email } = buildStubCcId(payout.payee_name, earliestIso);
    const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);

    const client = await pool.connect();
    let newUserId;
    try {
      await client.query('BEGIN');
      const insRes = await client.query(
        `INSERT INTO users (email, password_hash, role, onboarding_status, pre_hired, cc_id)
         VALUES ($1, $2, 'staff', 'deactivated', false, $3)
         ON CONFLICT (cc_id) WHERE cc_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [email, passwordHash, ccId]
      );
      if (insRes.rowCount > 0) {
        newUserId = insRes.rows[0].id;
        await client.query(
          `INSERT INTO contractor_profiles (user_id, preferred_name)
           VALUES ($1, $2)
           ON CONFLICT (user_id) DO NOTHING`,
          [newUserId, payout.payee_name]
        );
      } else {
        // cc_id existed — fetch its id so we can link the payout to it.
        const lookup = await client.query(`SELECT id FROM users WHERE cc_id = $1`, [ccId]);
        if (lookup.rowCount === 0) {
          await client.query('ROLLBACK');
          throw new ConflictError('stub creation failed and lookup returned no row');
        }
        newUserId = lookup.rows[0].id;
      }
      await client.query(
        `UPDATE legacy_cc_payouts SET payee_user_id = $1 WHERE id = $2`,
        [newUserId, legacyPayoutId]
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
      targetUserId: newUserId,
      action: 'cc_review_unmatched_payee_stub_created',
      metadata: {
        legacy_payout_id: legacyPayoutId,
        payee_name: payout.payee_name,
        cc_id: ccId,
        email,
      },
    });

    res.json({ ok: true, user_id: newUserId, cc_id: ccId, email });
  })
);

// §5 — Type-coercion failures: retry a single errored row, optionally with a
// payload override (lets the operator fix bad data in-place without re-upload).
router.post(
  '/review/errored-row/:row_id/retry',
  auth,
  requireAdminOrManager,
  asyncHandler(async (req, res) => {
    const rowId = intParam('row_id', req.params.row_id);
    const payloadOverride = req.body?.payload_override;
    if (
      payloadOverride !== null && payloadOverride !== undefined
      && (typeof payloadOverride !== 'object' || Array.isArray(payloadOverride))
    ) {
      throw new ValidationError(undefined, 'payload_override must be an object');
    }

    const guard = await pool.query(
      `SELECT id, source_entity, payload, import_status
         FROM legacy_cc_raw_imports WHERE id = $1`,
      [rowId]
    );
    if (guard.rowCount === 0) throw new NotFoundError('row not found');
    if (guard.rows[0].import_status !== 'errored') {
      throw new ConflictError('row is not in errored state');
    }
    const { source_entity: sourceEntity } = guard.rows[0];

    let workingPayload = guard.rows[0].payload;
    if (payloadOverride) {
      await pool.query(
        `UPDATE legacy_cc_raw_imports SET payload = $2::jsonb WHERE id = $1`,
        [rowId, JSON.stringify(payloadOverride)]
      );
      workingPayload = payloadOverride;
    }

    // Dispatch to the appropriate retry path based on source_entity. We only
    // retry the entities Task 19 surfaces: events (phase 3) and payments
    // (phase 4). Other entities (clients, payouts) get a 409 with a clear
    // message — the operator's only path is re-running the phase end-to-end.
    let retryStatus = 'unknown';
    let retryResult = null;
    try {
      if (sourceEntity === 'events') {
        // Re-run phase 3 promotion. Without dedup-skip — the row's natural
        // bucket should re-classify cleanly if the operator's fix was real.
        const r = await phase3.promoteBucketA(workingPayload, { skipDedup: false });
        retryResult = r;
        retryStatus = r.status;
        // Mark raw row promoted on success; leave 'errored' on failure with new notes.
        if (r.status === 'promoted' || r.status === 'already_promoted') {
          await pool.query(
            `UPDATE legacy_cc_raw_imports
                SET import_status = 'promoted',
                    import_notes = $2::jsonb
              WHERE id = $1`,
            [rowId, JSON.stringify({
              retried_by_user_id: req.user.id,
              retried_at: new Date().toISOString(),
              proposal_id: r.proposalId || null,
              status: r.status,
            })]
          );
        } else if (r.status === 'duplicate_review') {
          await pool.query(
            `UPDATE legacy_cc_raw_imports
                SET import_status = 'duplicate_review',
                    import_notes = $2::jsonb
              WHERE id = $1`,
            [rowId, JSON.stringify({
              retried_by_user_id: req.user.id,
              retried_at: new Date().toISOString(),
              candidate_proposal_id: r.candidateProposalId || null,
            })]
          );
        } else {
          // Still errored.
          await pool.query(
            `UPDATE legacy_cc_raw_imports
                SET import_status = 'errored',
                    import_notes = $2::jsonb
              WHERE id = $1`,
            [rowId, JSON.stringify({
              retried_by_user_id: req.user.id,
              retried_at: new Date().toISOString(),
              error: r.error || r.status,
            })]
          );
        }
      } else if (sourceEntity === 'payments') {
        // Phase 4 retry would require finding the legacy_cc_payments row tied
        // to this raw_import_id and calling promoteSingleLegacyPayment /
        // promoteSingleLegacyRefund. Most "errored" payment rows are
        // unparseable — re-promoting won't help until the operator has also
        // re-parsed (out of scope for this batch). Surface explicitly.
        throw new ConflictError(
          'Payment-row retry requires a phase 4 re-run after fixing the underlying parse failure',
          'CC_RETRY_PAYMENT_NOT_SUPPORTED'
        );
      } else {
        throw new ConflictError(
          `Retry not supported for source_entity='${sourceEntity}' — re-run the phase end-to-end`,
          'CC_RETRY_ENTITY_NOT_SUPPORTED'
        );
      }
    } catch (err) {
      reportException(req, err, { step: 'errored_retry', rowId, sourceEntity });
      throw err;
    }

    await logAdminAction({
      actorUserId: req.user.id,
      targetUserId: null,
      action: 'cc_review_errored_row_retried',
      metadata: {
        row_id: rowId,
        source_entity: sourceEntity,
        payload_overridden: !!payloadOverride,
        result_status: retryStatus,
      },
    });

    res.json({ ok: true, status: retryStatus, result: retryResult });
  })
);

// §6 — Skipped (Bucket D): re-run phase 3 with the skip rule bypassed.
router.post(
  '/review/skipped-event/:row_id/promote',
  auth,
  requireAdminOrManager,
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

    // Re-run via promoteBucketA. The row's natural bucket is determined by
    // status + date inside the promote helper; for a Bucket D row that was
    // skipped purely on package, bypassing means it now lands in A / B / C as
    // appropriate. We call promoteBucketA which handles its own classification
    // path through the underlying _promote.
    // NOTE: phase3.promoteBucketA uses bucketLetter='A' explicitly — meaning
    // the row will be inserted as Bucket A (future + Confirmed). For a more
    // permissive re-classification, callers would need a dedicated bypass
    // helper. For Task 19 we accept "promote as Bucket A" semantics: the
    // operator who flips a skipped row is explicitly saying "this should be
    // an active event."
    const result = await phase3.promoteBucketA(guard.rows[0].payload, { skipDedup: true });
    if (result.status !== 'promoted' && result.status !== 'already_promoted') {
      throw new ConflictError(`Promote failed: ${result.error || result.status}`, 'CC_PROMOTE_FAILED');
    }

    await pool.query(
      `UPDATE legacy_cc_raw_imports
          SET import_status = 'promoted',
              import_notes = $2::jsonb
        WHERE id = $1`,
      [rowId, JSON.stringify({
        promoted_by_user_id: req.user.id,
        promoted_at: new Date().toISOString(),
        proposal_id: result.proposalId || null,
        skip_rule_bypassed: true,
      })]
    );

    await logAdminAction({
      actorUserId: req.user.id,
      targetUserId: null,
      action: 'cc_review_skipped_event_promoted',
      metadata: { row_id: rowId, proposal_id: result.proposalId || null },
    });

    res.json({ ok: true, proposal_id: result.proposalId || null });
  })
);

// §7 — Phase 0 give-up endpoints (accept-loss, revert-give-up) live in
// sibling phase0.js, mounted by index.js. Extracted for file-size discipline.

module.exports = router;

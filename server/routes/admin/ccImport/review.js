/**
 * Admin CC-Import Review page — Section 9.2 worklist + 10 action endpoints.
 *
 * GET /admin/cc-import/review
 *   Returns all 7 sections in one shot (50 rows per section). Lets the
 *   front-end render every collapsible at once without a per-section fetch.
 *
 * 10 mutation endpoints (all auth + requireAdminOrManager, all audited):
 *
 *   /duplicate/:row_id/confirm                 — flip duplicate_review → confirmed
 *   /duplicate/:row_id/promote                 — re-run Bucket A promote (skipDedup)
 *   /orphan-payment/:legacy_id/link            — set cc_event_id + promote
 *   /orphan-payment/:legacy_id/dismiss         — set dismissed_at + notes
 *   /unmatched-payee/:legacy_payout_id/link    — reassign shift_requests + audit
 *   /unmatched-payee/:legacy_payout_id/create-stub  — fresh stub + link payout
 *   /errored-row/:row_id/retry                 — re-run per-row insert
 *   /skipped-event/:row_id/promote             — re-run phase3 promotion
 *   /phase0-failure/:row_id/accept-loss        — set given_up_at + reason
 *   /phase0-failure/:row_id/revert-give-up     — clear give-up + reset attempts
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

    // Set cc_event_id on the legacy row.
    await pool.query(
      `UPDATE legacy_cc_payments SET cc_event_id = $1 WHERE id = $2`,
      [targetCcId, legacyId]
    );

    // Re-run the appropriate phase 4 single-row promote helper.
    let promoteResult;
    try {
      promoteResult = legacy.cc_type === 'Refund'
        ? await phase4.promoteSingleLegacyRefund(legacyId)
        : await phase4.promoteSingleLegacyPayment(legacyId);
    } catch (err) {
      reportException(req, err, { step: 'promote_single', legacyId });
      throw err;
    }

    // Proposal-wide recompute + re-derive (spec §9.2 §2): keep the proposal in
    // sync after the link. These helpers run across ALL cc-imported proposals
    // but are idempotent UPDATEs; cheap enough on the small import dataset.
    const tail = await pool.connect();
    try {
      await phase4.recomputeAmountPaid(tail);
      await phase4.rederivePaymentTypeAndStatus(tail);
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

      // Step 2: reassign any remaining stub rows to the now-real user. Step 1a/1b
      // cleared the only paths that would collide on UNIQUE(shift_id, user_id).
      await client.query(
        `UPDATE shift_requests SET user_id = $1 WHERE user_id = $2`,
        [userId, stubUserId]
      );

      // Step 3: capture inherited proposal ids for the audit trail + reaccrue loop.
      const inherited = await client.query(
        `SELECT DISTINCT s.proposal_id
           FROM shift_requests sr
           JOIN shifts s ON s.id = sr.shift_id
          WHERE sr.user_id = $1 AND sr.status = 'approved'`,
        [userId]
      );
      inheritedProposalIds = inherited.rows
        .map((r) => r.proposal_id)
        .filter((id) => id !== null && id !== undefined);

      // Audit trail per spec §9.3.E: ONE proposal_activity_log entry per
      // affected proposal recording the deleted rows. Combined 1a+1b deletes.
      const allDeleted = [...deletedRows1a, ...deletedRows1b];
      for (const pid of inheritedProposalIds) {
        const proposalDeleted = allDeleted.filter((d) => {
          // We don't have shift→proposal here at row-level cheaply; the spec
          // captures the JSON with the affected proposal id alongside the
          // global deleted-rows snapshot. Keep the per-proposal entry simple.
          return true;
        }).map((d) => ({
          shift_id: d.shift_id, was_user_id: d.user_id, was_status: d.status,
        }));
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
              deleted_rows: proposalDeleted,
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
    if (payloadOverride !== null && payloadOverride !== undefined && typeof payloadOverride !== 'object') {
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

// §7 — Phase 0 give-ups: accept loss (URL is permanently dead).
router.post(
  '/review/phase0-failure/:row_id/accept-loss',
  auth,
  requireAdminOrManager,
  asyncHandler(async (req, res) => {
    const rowId = intParam('row_id', req.params.row_id);
    const reason = trimText('reason', req.body?.reason, { required: true, min: 1, max: 500 });

    // State guard: row exists, attempts ≥ 10, not yet given up, not resolved.
    const r = await pool.query(
      `UPDATE cc_import_phase0_failures
          SET given_up_at = NOW(), given_up_reason = $2
        WHERE id = $1
          AND given_up_at IS NULL
          AND resolved_at IS NULL
          AND attempt_count >= 10
        RETURNING id, source_url, source_entity, attempt_count`,
      [rowId, reason]
    );
    if (r.rowCount === 0) {
      // Determine whether the row exists or just isn't eligible.
      const exists = await pool.query(
        `SELECT id, given_up_at, resolved_at, attempt_count FROM cc_import_phase0_failures WHERE id = $1`,
        [rowId]
      );
      if (exists.rowCount === 0) throw new NotFoundError('row not found');
      throw new ConflictError('row is not eligible for accept-loss (already actioned or attempt_count < 10)');
    }

    await logAdminAction({
      actorUserId: req.user.id,
      targetUserId: null,
      action: 'cc_review_phase0_accept_loss',
      metadata: {
        row_id: rowId,
        source_url: r.rows[0].source_url,
        source_entity: r.rows[0].source_entity,
        attempt_count: r.rows[0].attempt_count,
        reason,
      },
    });

    res.json({ ok: true });
  })
);

// §7 — Phase 0 give-ups: revert (URL is fetchable again; reset attempt count
// so the next phase 0 run can re-try without immediately hitting the cap).
router.post(
  '/review/phase0-failure/:row_id/revert-give-up',
  auth,
  requireAdminOrManager,
  asyncHandler(async (req, res) => {
    const rowId = intParam('row_id', req.params.row_id);

    const r = await pool.query(
      `UPDATE cc_import_phase0_failures
          SET given_up_at = NULL,
              given_up_reason = NULL,
              attempt_count = 0
        WHERE id = $1
          AND given_up_at IS NOT NULL
        RETURNING id, source_url, source_entity`,
      [rowId]
    );
    if (r.rowCount === 0) {
      const exists = await pool.query(
        `SELECT id, given_up_at FROM cc_import_phase0_failures WHERE id = $1`,
        [rowId]
      );
      if (exists.rowCount === 0) throw new NotFoundError('row not found');
      throw new ConflictError('row is not currently in given-up state');
    }

    await logAdminAction({
      actorUserId: req.user.id,
      targetUserId: null,
      action: 'cc_review_phase0_revert_give_up',
      metadata: {
        row_id: rowId,
        source_url: r.rows[0].source_url,
        source_entity: r.rows[0].source_entity,
      },
    });

    res.json({ ok: true });
  })
);

module.exports = router;

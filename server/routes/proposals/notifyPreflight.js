'use strict';

// POST /api/proposals/:id/notify-preflight — READ-ONLY. "Would saving these
// edits message the client, and what would it say?" No transaction, no writes.
// The PATCH recomputes its own answer via the SAME functions and is the
// authority; this exists so the edit form can ask before saving, and so the
// reschedule draft can be composed while the OLD field values still exist
// (they die at commit; the message renders old-vs-new).
const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const { adminWriteLimiter } = require('../../middleware/rateLimiters');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const { NOTICE_EVENT_DETAILS, eventDetailsNoticeApplies } = require('../../utils/clientNotices');
const {
  RESCHEDULABLE_FIELDS, changedReschedulableFields, buildEventDetailsDraft,
} = require('../../utils/rescheduleProposal');
const { resolvePendingLocation } = require('../../utils/venueAddress');
const { isPlaceholderEmail } = require('../../utils/emailValidation');
const { normalizePhone } = require('../../utils/sms');

const router = express.Router();

router.post('/:id/notify-preflight', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError({ id: 'Invalid proposal id.' });
  const body = req.body || {};

  // Change-request saves have their own client email (the change-approved
  // touch in crud.js) and the save suppresses the direct reschedule send on
  // them (`&& !change_request_id`). Zero notices = no popup = the one
  // coherent answer; the save-side trigger check mirrors this same rule.
  if (body.change_request_id) return res.json({ notices: [] });

  // Channel availability here is presence + placeholder ONLY (spec decision:
  // suppression is enforced at send time and reported 'skipped'), so the
  // suppression columns are deliberately not selected.
  const { rows } = await pool.query(
    `SELECT p.*, c.id AS client_id, c.name AS client_name, c.email AS client_email,
            c.phone AS client_phone
       FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1`,
    [id]
  );
  const old = rows[0];
  if (!old) throw new NotFoundError('Proposal not found');

  // Prospective row: undefined OR NULL means unchanged — the PATCH writes
  // these three through COALESCE, where null keeps the stored value. Treating
  // null as a change here would return a phantom notice whose opt-in the save
  // then 400s (requested-but-untriggered), rolling back a legitimate edit.
  // Location goes through the SAME merge-and-compose the save uses
  // (resolvePendingLocation), because venue edits arrive as venue_* parts,
  // not as event_location — the exact drift surface behind the live incident
  // that motivated this feature.
  const updated = { ...old };
  for (const f of RESCHEDULABLE_FIELDS) {
    if (body[f] !== undefined && body[f] !== null) updated[f] = body[f];
  }
  const composed = resolvePendingLocation(old, body);
  if (composed !== null) updated.event_location = composed;

  const notices = [];
  if (eventDetailsNoticeApplies({ old, updated, status: old.status })) {
    const placeholder = isPlaceholderEmail(old.client_email);
    const phone = old.client_phone ? normalizePhone(old.client_phone) : null;
    const draft = buildEventDetailsDraft({ old, updated, ctx: old });
    notices.push({
      type: NOTICE_EVENT_DETAILS,
      reasons: changedReschedulableFields(old, updated).map((f) => `${f} changed`),
      composable: true,
      recipient: { name: old.client_name || null, email: old.client_email || null, phone },
      channels: {
        email: {
          available: Boolean(old.client_email) && !placeholder,
          default: Boolean(old.client_email) && !placeholder,
          unavailable_reason: !old.client_email ? 'No email on file.'
            : placeholder ? 'Placeholder address (.invalid) from the CC import; no real email exists.'
              : null,
        },
        sms: {
          available: Boolean(phone),
          default: Boolean(phone),
          unavailable_reason: phone ? null : 'No usable phone on file.',
        },
      },
      autopay_notice: draft.autopay_notice,
      draft: { email: draft.email, sms: draft.sms },
    });
  }

  res.json({ notices });
}));

module.exports = router;

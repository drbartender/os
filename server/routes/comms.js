'use strict';

// Compose-and-confirm endpoints for the shared SendModal (spec 4.2). Every
// admin-click client send routes through here: preview shows the live-resolved
// recipient + drafted message, send runs the action's idempotent side effects
// then dispatches with the admin's edits. The recipient is resolved server
// side ONLY — the request cannot override the destination.
const express = require('express');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const { adminWriteLimiter } = require('../middleware/rateLimiters');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, PermissionError } = require('../utils/errors');
const { getAction } = require('../utils/comms/registry');

const router = express.Router();

// SMS ceiling: 4 GSM segments (spec 4.2). Hard server cap; the modal mirrors it.
const SMS_MAX_CHARS = 640;

function requireAction(body, user) {
  const action = getAction(body.action);
  if (!action) throw new ValidationError({ action: 'Unknown comms action.' });
  // Per-action role floor: an action ported from an adminOnly legacy route
  // declares minRole 'admin' so the comms layer cannot widen its access to
  // managers (e.g. reenroll clears CC-import nudge suppression, an
  // owner-level protection).
  if (action.minRole === 'admin' && user.role !== 'admin') {
    throw new PermissionError('This send requires the admin role.');
  }
  const entityId = parseInt(body.entity_id, 10);
  if (!Number.isInteger(entityId) || entityId <= 0) {
    throw new ValidationError({ entity_id: 'entity_id must be a positive integer.' });
  }
  return { action, entityId };
}

/** POST /api/comms/preview — recipient, warnings, channels, drafted message. */
router.post('/preview', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { action, entityId } = requireAction(req.body || {}, req.user);
  const recipient = await action.resolveRecipient(entityId);
  const messages = await action.buildMessages(entityId);
  res.json({
    action: action.key,
    recipient: {
      name: recipient.name,
      email: recipient.email,
      phone: recipient.phone,
      source: recipient.source,
    },
    warnings: recipient.warnings,
    channels: recipient.channels,
    email: messages.email,
    sms: messages.sms,
  });
}));

/** POST /api/comms/send — run side effects (idempotent), dispatch with edits,
 *  return per-channel truth (spec 4.2 partial-failure contract). */
router.post('/send', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const { action, entityId } = requireAction(body, req.user);

  const channels = Array.isArray(body.channels) ? body.channels.filter((c) => ['email', 'sms'].includes(c)) : [];
  if (channels.length === 0) {
    // Side-effects-only confirm (spec 4.6, hosted approve): an empty channel
    // list is legal ONLY when the action genuinely has no channel to offer.
    // When a channel IS available, an empty selection is an accidental no-op
    // and gets rejected.
    const availability = await action.resolveRecipient(entityId);
    if (availability.channels.email.available || availability.channels.sms.available) {
      throw new ValidationError({ channels: 'Select at least one channel.' });
    }
  }
  if (channels.includes('email')) {
    // Strip CR/LF from the subject (header hygiene) and cap its length.
    const subject = String(body.email?.subject ?? '').replace(/[\r\n]+/g, ' ').trim();
    if (!subject) {
      throw new ValidationError({ subject: 'Subject cannot be empty.' });
    }
    if (subject.length > 300) {
      throw new ValidationError({ subject: 'Subject is over the 300 character cap.' });
    }
    body.email.subject = subject;
    if (!String(body.email?.body_text ?? '').trim()) {
      throw new ValidationError({ body_text: 'Message cannot be empty.' });
    }
  }
  if (channels.includes('sms')) {
    const smsBody = String(body.sms?.body ?? '').trim();
    if (!smsBody) throw new ValidationError({ sms_body: 'SMS message cannot be empty.' });
    if (smsBody.length > SMS_MAX_CHARS) {
      throw new ValidationError({ sms_body: `SMS message is over the ${SMS_MAX_CHARS} character cap.` });
    }
  }

  const isRetry = body.retry === true;
  const sideEffects = await action.ensureSideEffects(entityId, { sentBy: req.user.id });

  // Dispatch only when this confirm APPLIED the side effect, or when the
  // client explicitly flags a retry of a failed channel (the one legitimate
  // applied:false send). A plain confirm that applied nothing is a concurrent
  // duplicate: the other confirm already sent, so re-sending here would
  // double-message the client (the old PATCH route only emailed inside the
  // atomic flip; this preserves that property without breaking Retry).
  // EXCEPTION: resend-type actions (proposal resend, nudges, reminders,
  // invoice re-send) are validate-only by design; their ensureSideEffects
  // always returns applied:false because SENDING IS the operation. Those
  // declare dispatchWithoutSideEffects: true and dispatch on every confirm
  // (the modal's in-flight lockout + adminWriteLimiter guard double-clicks,
  // exactly the protection level their legacy routes had).
  let results;
  if (!action.dispatchWithoutSideEffects && !sideEffects.applied && !isRetry && channels.length > 0) {
    results = { email: 'skipped', sms: 'skipped', skip_reasons: {} };
    for (const c of channels) {
      results.skip_reasons[c] = 'Already handled by a concurrent confirm; nothing sent.';
    }
  } else {
    results = await action.dispatch(
      entityId,
      {
        email: body.email
          ? { subject: String(body.email.subject ?? '').trim(), bodyText: String(body.email.body_text ?? '').trim() }
          : undefined,
        sms: body.sms ? { body: String(body.sms.body ?? '').trim() } : undefined,
      },
      channels,
      { sentBy: req.user.id }
    );
  }

  res.json({
    ok: true,
    side_effects_applied: sideEffects.applied,
    email: results.email,
    sms: results.sms,
    email_error: results.email_error || null,
    sms_error: results.sms_error || null,
    skip_reasons: results.skip_reasons,
    recipient_email: results.recipient_email,
    recipient_phone: results.recipient_phone,
  });
}));

module.exports = router;

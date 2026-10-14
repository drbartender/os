'use strict';
// POST /api/me/push-test: one banner to every subscription the caller holds,
// so the phone can prove a device works (spec 2026-08-13-mobile-admin
// section 7, 2026-10-14: the one new push endpoint). Admin or manager, the
// admin write limiter (10 a minute per user). Never throws over a push
// failure: the counts are the answer.
const express = require('express');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const { adminWriteLimiter } = require('../middleware/rateLimiters');
const asyncHandler = require('../middleware/asyncHandler');
// Module object, not destructured, so tests can replace sendPushToUser.
const adminPush = require('../utils/adminPush');

const router = express.Router();

router.post('/push-test', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  if (!adminPush.publicKey()) {
    return res.json({ subscriptions: 0, sent: 0, failed: 0, gone: 0, reason: 'vapid_unset' });
  }
  const r = await adminPush.sendPushToUser({
    userId: req.user.id,
    title: 'Test notification',
    body: 'Push is working on this account.',
    url: '/more/notifications',
    tag: 'push_test',
    surface: 'admin',
  });
  // The four counts only, never a spread: sendPushToUser's result also carries
  // readFailed and, on a failed read, the raw database error, which never goes
  // in a response. A failed read is reported from the flag alone, so the phone
  // never says "no device" when the server could not look.
  const { subscriptions, sent, failed, gone } = r;
  const reason = r.readFailed ? 'read_failed' : r.subscriptions === 0 ? 'no_subscriptions' : null;
  return res.json({ subscriptions, sent, failed, gone, reason });
}));

module.exports = router;

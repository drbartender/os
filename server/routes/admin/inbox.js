'use strict';

// Inbox (spec docs/superpowers/specs/2026-10-06-inbox-design.md, section 8).
// Every route is auth + requireAdminOrManager + asyncHandler, and every person
// key is checked against spec 8's patterns before anything reads it. The
// rules, the readers and the text route live in server/utils/inbox/.

const express = require('express');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { adminWriteLimiter, inboxTextLimiter } = require('../../middleware/rateLimiters');
const { ValidationError } = require('../../utils/errors');
const { parsePersonKey } = require('../../utils/inbox/personKey');
const engine = require('../../utils/inbox/engine');
const { recordAction, undoAction, markSeen } = require('../../utils/inbox/actions');
const { sendInboxText } = require('../../utils/inbox/textSend');

const router = express.Router();

const NOT_A_PERSON = 'That is not an Inbox person.';

function checkKey(raw) {
  if (!parsePersonKey(raw)) throw new ValidationError({ personKey: NOT_A_PERSON }, NOT_A_PERSON);
  return raw;
}

router.get('/inbox', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  res.json(await engine.getInbox({ viewerId: req.user.id }));
}));

router.get('/inbox/:personKey', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const personKey = checkKey(req.params.personKey);
  try {
    res.json(await engine.getItem({ personKey, viewerId: req.user.id }));
  } catch (err) {
    // The global handler writes only error, code and fieldErrors, so the
    // moved_to hint the page follows is written here (spec 4.2 and 8).
    if (err instanceof engine.InboxMovedError) {
      return res.status(404).json({ error: err.message, code: err.code, moved_to: err.movedTo });
    }
    throw err;
  }
}));

router.post('/inbox/:personKey/seen', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  await markSeen({ personKey: checkKey(req.params.personKey), userId: req.user.id });
  res.status(204).end();
}));

router.post('/inbox/:personKey/actions', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const personKey = checkKey(req.params.personKey);
  const { action, until } = req.body || {};
  res.status(201).json(await recordAction({ personKey, action, until, userId: req.user.id }));
}));

router.delete('/inbox/actions/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  await undoAction({ id: req.params.id, userId: req.user.id });
  res.status(204).end();
}));

router.post('/inbox/:personKey/text', auth, requireAdminOrManager, adminWriteLimiter, inboxTextLimiter, asyncHandler(async (req, res) => {
  const personKey = checkKey(req.params.personKey);
  const out = await sendInboxText({ personKey, body: req.body || {}, user: req.user });
  res.status(out.status).json(out.body);
}));

module.exports = router;

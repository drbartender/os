'use strict';

// Inbox (spec docs/superpowers/specs/2026-10-06-inbox-design.md, section 8).
// Every route is auth + requireAdminOrManager + asyncHandler, and every person
// key is checked against spec 8's patterns before anything reads it. The
// rules, the readers and the text route live in server/utils/inbox/.
// Personal mail, judged once per mail by the sync (personalMail.js; spec
// 2026-10-14 decision 6 and section 8), is its owner's alone: the list and
// the item filter it in the engine, and
// seen, actions and text refuse it to anyone else with the item's own 404,
// before they write anything. Those three refuse an e- key with no mail the
// same way, so they never tell a personal person from an address that never
// wrote (an e- key is a hash of an address anyone can guess).

const express = require('express');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { adminWriteLimiter, inboxTextLimiter } = require('../../middleware/rateLimiters');
const { ValidationError, NotFoundError } = require('../../utils/errors');
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

// A checked key that names someone this viewer may see, else the 404 a key
// that names no one gets.
async function visibleKey(raw, user) {
  const personKey = checkKey(raw);
  if (await engine.isHiddenKey(personKey, user.id)) throw new NotFoundError(engine.NOT_IN_INBOX);
  return personKey;
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

// The deliberate open: upserts `inbox_seen` and, for a client, marks their inbound texts read, in
// one transaction. 204
router.post('/inbox/:personKey/seen', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  await markSeen({ personKey: await visibleKey(req.params.personKey, req.user), userId: req.user.id });
  res.status(204).end();
}));

// `{ action, until? }`: `claim`, `release`, `done`, `snooze` (`until` required, 1 minute to 8 days
// ahead, and accepted on no other action), `wake`, `reopen`. 201 `{ id }` for Undo
router.post('/inbox/:personKey/actions', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const personKey = await visibleKey(req.params.personKey, req.user);
  const { action, until } = req.body || {};
  res.status(201).json(await recordAction({ personKey, action, until, userId: req.user.id }));
}));

// Undo: stamps `undone_at` on the caller's own action while it is under 60 seconds old; a repeat is
// 204 again. Another user's action is 409 `INBOX_UNDO_NOT_YOURS`, an older one 409
// `INBOX_UNDO_EXPIRED`
router.delete('/inbox/actions/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  await undoAction({ id: req.params.id, userId: req.user.id });
  res.status(204).end();
}));

// `{ body, line, send_id }`. 201 `{ message }`, the new thread row. Rules below
router.post('/inbox/:personKey/text', auth, requireAdminOrManager, adminWriteLimiter, inboxTextLimiter, asyncHandler(async (req, res) => {
  const personKey = await visibleKey(req.params.personKey, req.user);
  const out = await sendInboxText({ personKey, body: req.body || {}, user: req.user });
  res.status(out.status).json(out.body);
}));

module.exports = router;

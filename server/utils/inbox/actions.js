'use strict';

// The taps (spec 4.4 and 8): On it, Let go, Done, Snooze, Wake, Reopen, Undo,
// and the deliberate open. inbox_actions is append-only: Undo stamps
// undone_at and nothing is deleted. Every write clears the engine cache, so
// the next list, item or badge read already shows it.

const { pool } = require('../../db');
const { ValidationError, ConflictError, NotFoundError } = require('../errors');
const { SNOOZE_MIN_SECONDS, SNOOZE_MAX_DAYS, UNDO_SECONDS } = require('./constants');
const { parsePersonKey } = require('./personKey');
const cache = require('./cache');

const ACTIONS = new Set(['claim', 'release', 'done', 'snooze', 'wake', 'reopen']);
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTION_ID_RE = /^[1-9]\d{0,9}$/;
const MAX_INT = 2147483647;

const INSERT_SQL = 'INSERT INTO inbox_actions (person_key, action, until_at, user_id) VALUES ($1, $2, $3, $4) RETURNING id';
const UNDO_SQL = `
  UPDATE inbox_actions SET undone_at = NOW()
   WHERE id = $1 AND user_id = $2 AND undone_at IS NULL
     AND created_at > NOW() - make_interval(secs => $3)
  RETURNING id`;
const ACTION_SQL = 'SELECT user_id, undone_at FROM inbox_actions WHERE id = $1';
const SEEN_SQL = `
  INSERT INTO inbox_seen (person_key, seen_at, seen_by) VALUES ($1, NOW(), $2)
  ON CONFLICT (person_key) DO UPDATE SET seen_at = EXCLUDED.seen_at, seen_by = EXCLUDED.seen_by`;
// The Messages page's own "mark read" (PUT /api/sms/conversations/:clientId/read).
const READ_SMS_SQL = `
  UPDATE sms_messages SET read_at = NOW()
   WHERE client_id = $1 AND direction = 'inbound' AND read_at IS NULL`;

// A field error whose copy is also the message, so a toast never reads the
// generic "Please fix the errors below".
const invalid = (field, message) => new ValidationError({ [field]: message }, message);

// Snooze needs an until 1 minute to 8 days ahead (spec 8); nothing else takes one.
function untilFor(action, until, nowMs) {
  if (action !== 'snooze') {
    if (until !== undefined && until !== null) throw invalid('until', 'Only Snooze takes a time.');
    return null;
  }
  const at = typeof until === 'string' ? new Date(until) : null;
  if (!at || Number.isNaN(at.getTime())) throw invalid('until', 'Pick when it comes back.');
  const ahead = at.getTime() - nowMs;
  if (ahead < SNOOZE_MIN_SECONDS * 1000 || ahead > SNOOZE_MAX_DAYS * DAY_MS) {
    throw invalid('until', 'A snooze runs from 1 minute to 8 days.');
  }
  return at;
}

async function recordAction({ personKey, action, until, userId, now = new Date() }, db = pool) {
  if (!ACTIONS.has(action)) throw invalid('action', 'That is not an Inbox action.');
  const untilAt = untilFor(action, until, now.getTime());
  const { rows } = await db.query(INSERT_SQL, [personKey, action, untilAt, userId]);
  cache.invalidate();
  return { id: rows[0].id };
}

// Undo (spec 8): the viewer's OWN action, under 60 seconds old. A repeat of
// an Undo that already landed answers the same as the first.
async function undoAction({ id, userId }, db = pool) {
  const raw = String(id);
  if (!ACTION_ID_RE.test(raw) || Number(raw) > MAX_INT) throw invalid('id', 'That is not an action id.');
  const actionId = Number(raw);
  const undone = await db.query(UNDO_SQL, [actionId, userId, UNDO_SECONDS]);
  if (undone.rowCount) {
    cache.invalidate();
    return;
  }
  const { rows } = await db.query(ACTION_SQL, [actionId]);
  const row = rows[0];
  if (!row) throw new NotFoundError('That tap is not in the inbox.');
  if (Number(row.user_id) !== Number(userId)) {
    throw new ConflictError('Only the person who tapped can undo it.', 'INBOX_UNDO_NOT_YOURS');
  }
  if (row.undone_at) return;
  throw new ConflictError('Too late to undo: Undo lasts 60 seconds.', 'INBOX_UNDO_EXPIRED');
}

// The deliberate open (spec 4.1 and 8). For a client it also marks their
// texts read, as opening the Messages thread does. Both, or neither.
async function markSeen({ personKey, userId }, db = pool) {
  const key = parsePersonKey(personKey);
  const conn = await db.connect();
  try {
    await conn.query('BEGIN');
    await conn.query(SEEN_SQL, [personKey, userId]);
    if (key && key.type === 'c') await conn.query(READ_SMS_SQL, [Number(key.id)]);
    await conn.query('COMMIT');
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
  cache.invalidate();
}

module.exports = { recordAction, undoAction, markSeen, ACTIONS };

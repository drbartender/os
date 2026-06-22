'use strict';

// Push-channel dispatch, extracted from scheduledMessageDispatcher.js and fixed
// for SERVER-17.
//
// Push rows bypass the registered-handler model: the payload travels on the row
// itself. dispatchPushRow sends a web-push to each of the recipient's
// push_subscriptions and prunes any the push service reports as gone (410/404).
//
// SERVER-17 fix: the previous version held a `SELECT ... FOR UPDATE` transaction
// open across EVERY web-push network round-trip. A slow or unreachable push
// endpoint pinned the pooled connection idle-in-transaction past Neon's
// idle_in_transaction_session_timeout; the backend then killed the connection
// and the unhandled pool error crashed the process. So: read subscriptions with
// a plain query, do all the network sends with NO transaction open, then prune
// dead subs in a SHORT transaction that re-reads the current array and removes
// by endpoint — which is the concurrency guarantee the original FOR UPDATE was
// actually there to provide.

const Sentry = require('@sentry/node');
const { pool } = require('../db');
// Module-level (not destructured) so tests can monkey-patch pushSender.sendPush.
const pushSender = require('./pushSender');

async function dispatchPushRow(row) {
  const payload = row.payload || {};

  // Read the recipient's subscriptions WITHOUT holding a transaction.
  const { rows: userRows } = await pool.query(
    'SELECT staff_notification_preferences AS prefs FROM users WHERE id = $1',
    [row.recipient_id]
  );
  if (userRows.length === 0) {
    await pool.query(
      "UPDATE scheduled_messages SET status = 'failed', error_message = $2 WHERE id = $1",
      [row.id, 'recipient user not found']
    );
    return;
  }
  const prefs = userRows[0].prefs || {};
  const subs = Array.isArray(prefs.push_subscriptions) ? prefs.push_subscriptions : [];
  if (subs.length === 0) {
    await pool.query(
      "UPDATE scheduled_messages SET status = 'suppressed', error_message = $2 WHERE id = $1",
      [row.id, 'no_push_subscriptions']
    );
    return;
  }

  // Network sends, with NO DB connection held. 410/404 marks the sub for pruning;
  // a transient failure keeps the sub for next time.
  let anyOk = false;
  let anyDegraded = false;
  const goneEndpoints = [];
  for (const sub of subs) {
    const result = await pushSender.sendPush({
      subscription: { endpoint: sub.endpoint, keys: sub.keys },
      title: payload.title,
      body: payload.body,
      url: payload.url,
      tag: payload.tag || row.message_type,
      icon: payload.icon,
    });
    if (result && result.ok) {
      anyOk = true;
    } else if (result && result.gone) {
      anyDegraded = true;
      goneEndpoints.push(sub.endpoint);
    }
    // transient failure: keep the sub, prune nothing
  }

  // Prune dead subscriptions in a SHORT transaction. Re-read the current array
  // under FOR UPDATE and remove only the gone endpoints, so a concurrent dispatch
  // tick's add/remove of a different endpoint is preserved, not clobbered.
  if (goneEndpoints.length > 0) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: freshRows } = await client.query(
        'SELECT staff_notification_preferences AS prefs FROM users WHERE id = $1 FOR UPDATE',
        [row.recipient_id]
      );
      const freshSubs = Array.isArray(freshRows[0] && freshRows[0].prefs && freshRows[0].prefs.push_subscriptions)
        ? freshRows[0].prefs.push_subscriptions
        : [];
      const gone = new Set(goneEndpoints);
      const kept = freshSubs.filter((s) => !gone.has(s.endpoint));
      if (kept.length !== freshSubs.length) {
        await client.query(
          `UPDATE users
              SET staff_notification_preferences = jsonb_set(
                staff_notification_preferences, '{push_subscriptions}', $2::jsonb, true)
            WHERE id = $1`,
          [row.recipient_id, JSON.stringify(kept)]
        );
      }
      await client.query('COMMIT');
    } catch (pruneErr) {
      try { await client.query('ROLLBACK'); } catch { /* connection may already be gone */ }
      // Prune is best-effort: the sends already happened and a lingering dead sub
      // is harmless (it just 410s again next tick). Never fail the row over it.
      Sentry.addBreadcrumb({
        category: 'notifications',
        message: 'push_prune_failed',
        data: { user_id: row.recipient_id, row_id: row.id, error: pruneErr && pruneErr.message },
      });
    } finally {
      client.release();
    }
  }

  // Record the row outcome from the SEND result (independent of the prune).
  if (anyOk) {
    await pool.query(
      "UPDATE scheduled_messages SET status = 'sent', sent_at = NOW(), error_message = NULL WHERE id = $1",
      [row.id]
    );
    if (anyDegraded) {
      Sentry.addBreadcrumb({
        category: 'notifications',
        message: 'push_partial_prune',
        data: { user_id: row.recipient_id, row_id: row.id, pruned: goneEndpoints.length },
      });
    }
  } else {
    await pool.query(
      "UPDATE scheduled_messages SET status = 'failed', error_message = $2 WHERE id = $1",
      [row.id, anyDegraded ? 'all_subscriptions_gone' : 'push_send_failed']
    );
  }
}

module.exports = { dispatchPushRow };

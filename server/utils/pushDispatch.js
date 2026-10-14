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
const { sendPushToUser } = require('./adminPush');

async function dispatchPushRow(row) {
  const payload = row.payload || {};

  const { rows: userRows } = await pool.query('SELECT 1 FROM users WHERE id = $1', [row.recipient_id]);
  if (userRows.length === 0) {
    await pool.query(
      "UPDATE scheduled_messages SET status = 'failed', error_message = $2 WHERE id = $1",
      [row.id, 'recipient user not found']
    );
    return;
  }

  // The send-and-prune routine is shared with the admin push channel
  // (adminPush.js): no connection held across the network, the prune in its
  // own short FOR UPDATE transaction, a dead endpoint removed by endpoint.
  const r = await sendPushToUser({
    userId: row.recipient_id,
    title: payload.title,
    body: payload.body,
    url: payload.url,
    tag: payload.tag || row.message_type,
    icon: payload.icon,
    surface: 'staff',
  });

  // A failed subscription read is not "no subscriptions": record it as failed
  // with the reason, never as suppressed.
  if (r.readFailed) {
    await pool.query(
      "UPDATE scheduled_messages SET status = 'failed', error_message = $2 WHERE id = $1",
      [row.id, 'push_read_failed: ' + (r.error || 'unknown')]
    );
    return;
  }

  if (r.subscriptions === 0) {
    await pool.query(
      "UPDATE scheduled_messages SET status = 'suppressed', error_message = $2 WHERE id = $1",
      [row.id, 'no_push_subscriptions']
    );
    return;
  }

  // Record the row outcome from the SEND result (independent of the prune).
  if (r.sent > 0) {
    await pool.query(
      "UPDATE scheduled_messages SET status = 'sent', sent_at = NOW(), error_message = NULL WHERE id = $1",
      [row.id]
    );
    if (r.gone > 0) {
      Sentry.addBreadcrumb({
        category: 'notifications',
        message: 'push_partial_prune',
        data: { user_id: row.recipient_id, row_id: row.id, pruned: r.gone },
      });
    }
  } else {
    await pool.query(
      "UPDATE scheduled_messages SET status = 'failed', error_message = $2 WHERE id = $1",
      [row.id, r.gone > 0 ? 'all_subscriptions_gone' : 'push_send_failed']
    );
  }
}

module.exports = { dispatchPushRow };

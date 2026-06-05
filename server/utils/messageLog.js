const { pool } = require('../db');
let Sentry = null;
try { Sentry = require('@sentry/node'); } catch (_) { /* optional */ }

// Pure: an email send outcome -> a log entry, or null to skip logging.
function buildEmailLogEntry({ to, subject, meta = {}, result, error }) {
  if (meta.skipLog) return { skipLog: true };
  const recipient = Array.isArray(to) ? to[0] : to;
  if (!recipient) return null;
  if (result && result.id === 'dev-skipped') return null; // gated/dev — not a real send
  return {
    channel: 'email',
    recipient,
    subject: subject || null,
    status: error ? 'failed' : 'sent',
    error: error ? String(error.message || error).slice(0, 500) : null,
    providerId: result && result.id ? result.id : null,
    proposalId: meta.proposalId || null,
    clientId: meta.clientId || null,
    messageType: meta.messageType || 'other',
  };
}

// Pure: an SMS send outcome -> a log entry, or null to skip logging.
function buildSmsLogEntry({ to, body, meta = {}, result, error }) {
  if (meta.skipLog) return { skipLog: true };
  if (!to) return null;
  const sid = result && result.sid ? result.sid : null;
  if (sid && String(sid).startsWith('dev-skipped')) return null; // gated/dev
  return {
    channel: 'sms',
    recipient: to,
    subject: body ? String(body).slice(0, 140) : null,
    status: error ? 'failed' : 'sent',
    error: error ? String(error.message || error).slice(0, 500) : null,
    providerId: sid,
    proposalId: meta.proposalId || null,
    clientId: meta.clientId || null,
    messageType: meta.messageType || 'other',
  };
}

// Effectful: resolve client/proposal if not supplied, then insert the ledger row.
// NEVER throws and never rejects — safe to call fire-and-forget from a send path.
async function logClientMessage(entry) {
  try {
    if (!entry || entry.skipLog) return;
    let { channel, recipient, subject, status, error, providerId,
          proposalId, clientId, messageType } = entry;

    if (!clientId) {
      if (channel === 'email') {
        const r = await pool.query(
          'SELECT id FROM clients WHERE LOWER(email) = LOWER($1) LIMIT 1',
          [recipient]
        );
        clientId = r.rows[0] ? r.rows[0].id : null;
      } else {
        const last10 = recipient ? String(recipient).replace(/\D/g, '').slice(-10) : null;
        if (last10 && last10.length === 10) {
          const r = await pool.query(
            "SELECT id FROM clients WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1 LIMIT 1",
            [last10]
          );
          clientId = r.rows[0] ? r.rows[0].id : null;
        }
      }
    }
    if (!clientId) return; // recipient is not a client — not a client ping

    if (!proposalId) {
      const r = await pool.query(
        'SELECT id FROM proposals WHERE client_id = $1 ORDER BY created_at DESC LIMIT 1',
        [clientId]
      );
      proposalId = r.rows[0] ? r.rows[0].id : null;
    }
    if (!proposalId) return; // nothing to attach to (rare, pre-event)

    await pool.query(
      `INSERT INTO message_log
         (proposal_id, client_id, channel, message_type, recipient, subject, status, error_message, provider_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [proposalId, clientId, channel, messageType || 'other', recipient,
       subject || null, status, error || null, providerId || null]
    );
  } catch (e) {
    console.error('[messageLog] log failed (send unaffected):', e.message);
    if (Sentry && Sentry.captureException) {
      Sentry.captureException(e, { tags: { area: 'message_log' } });
    }
  }
}

// Read: newest-first ledger rows for one proposal (the event detail Messages card).
// id DESC tiebreaks rows that share created_at so ordering is deterministic.
async function getMessageLogForProposal(proposalId) {
  const { rows } = await pool.query(
    `SELECT id, channel, message_type, recipient, subject, status, error_message, created_at
       FROM message_log
      WHERE proposal_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 100`,
    [proposalId]
  );
  return rows;
}

module.exports = { buildEmailLogEntry, buildSmsLogEntry, logClientMessage, getMessageLogForProposal };

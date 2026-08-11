const { pool } = require('../db');

/**
 * Every message a contact actually received, newest first.
 *
 * WHAT EACH SOURCE IS FOR
 * -----------------------
 * `message_log` is the primary and near-complete record: it is written at the
 * `sendEmail` / `sendSMS` choke points, so it captures dispatcher sends and
 * human sends alike. Verified against prod: 2,200 sent rows.
 *
 * `scheduled_messages` is a SAFETY NET, not a peer. The dispatcher's handlers
 * send through those same choke points without `skipLog`, so 1,154 of its
 * 1,196 sent rows (96%) already have a `message_log` twin milliseconds apart.
 * Emitting both would show the operator the same drip twice, once tagged
 * automated and once human, which is the exact opposite of what this view is
 * for. So this leg is anti-joined: a dispatcher row appears only when no
 * ledger twin exists, which today means only when a ledger write failed.
 *
 * `email_sends` covers campaign blasts and joins in phase 2, once
 * `mkt-g-send` adds its `client_id`.
 *
 * HONEST SCOPE NOTE: a contact with no proposal has nothing in either phase-1
 * source. `logClientMessage` returns early without a `proposal_id`, and every
 * client-directed `scheduled_messages` row is proposal-anchored too. The ~254
 * proposal-less clients therefore get an empty history until the phase-2 leg
 * lands. Do not claim otherwise in docs.
 *
 * `automated` is derived, never assumed: `message_log.sent_by` is NULL for a
 * scheduler send and set for a human one (2,165 of 2,200 prod rows are NULL).
 * Hardcoding it is how this view ends up asserting that the system's own drip
 * was sent by a person.
 *
 * Only rows that went out are history. A pending future touch is a plan;
 * suppressed, failed, and bounced rows are non-events.
 *
 * Safe to call from a plain handler. It takes its own pooled connections, so
 * per CLAUDE.md's one-connection rule do NOT call it while holding a client
 * from `pool.connect()`.
 */

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const PG_INT4_MAX = 2147483647;

// How close in time a message_log row must be to count as the same physical
// send as a scheduled_messages row. Observed gaps in prod are 3-121ms; two
// minutes is generous. Widening it only ever suppresses a duplicate, because
// message_log captures the send either way.
const TWIN_WINDOW = '2 minutes';

// email_sends.client_id arrives in phase 2. Probe once per process rather than
// once per call: schema.sql replays at boot before any call, and a deploy
// restarts the process, so a cached answer cannot go stale in a way that
// matters. Exported for tests to reset.
let campaignLegAvailable = null;

async function hasCampaignLeg() {
  if (campaignLegAvailable === null) {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'email_sends' AND column_name = 'client_id' LIMIT 1`
    );
    campaignLegAvailable = rows.length > 0;
  }
  return campaignLegAvailable;
}

function _resetCampaignLegProbe() { campaignLegAvailable = null; }

async function getContactMessageHistory(clientId, { limit = DEFAULT_LIMIT } = {}) {
  const id = parseInt(clientId, 10);
  // Out-of-int4-range ids parse as valid integers but raise 22003 against an
  // integer column, so bound here rather than 500 on a lookup.
  if (!Number.isInteger(id) || id < 1 || id > PG_INT4_MAX) return [];

  const parsedLimit = parseInt(limit, 10);
  const cap = Math.min(MAX_LIMIT, Math.max(1, Number.isInteger(parsedLimit) ? parsedLimit : DEFAULT_LIMIT));

  // NOT `status = 'sent'`. The email_sends CHECK allows queued/sent/delivered/
  // opened/clicked/bounced/complained/failed, and emailMarketingWebhook.js
  // monotonically advances a delivered send PAST 'sent', so an equality filter
  // would hide most real campaign sends. 'complained' is deliberately kept: a
  // spam complaint proves receipt, and it is the single most important row in
  // a "do not double-tap" view. COALESCE because the column is nullable.
  const campaignLeg = (await hasCampaignLeg()) ? `
    UNION ALL
    SELECT es.sent_at AS at, es.id, 'email' AS channel, 'campaign' AS kind,
           es.subject, COALESCE(ec.name, es.subject) AS label,
           false AS automated, 'email_sends' AS source
      FROM email_sends es
      LEFT JOIN email_campaigns ec ON ec.id = es.campaign_id
     WHERE es.client_id = $1
       AND es.sent_at IS NOT NULL
       AND COALESCE(es.status, '') NOT IN ('failed', 'bounced', 'queued')
  ` : '';

  const { rows } = await pool.query(`
    SELECT at, channel, kind, subject, label, automated, source FROM (
      -- Primary. sent_by IS NULL means the scheduler sent it; a set value
      -- means a human did (schema.sql documents this discriminator).
      SELECT ml.created_at AS at, ml.id, ml.channel, ml.message_type AS kind,
             ml.subject, NULLIF(ml.subject, '') AS label,
             (ml.sent_by IS NULL) AS automated, 'message_log' AS source
        FROM message_log ml
       WHERE ml.client_id = $1
         AND ml.status NOT IN ('failed', 'bounced')

      UNION ALL

      -- Safety net only: a dispatcher send whose ledger write did not land.
      SELECT sm.sent_at AS at, sm.id, sm.channel, sm.message_type AS kind,
             NULL AS subject, NULL AS label,
             true AS automated, 'scheduled_messages' AS source
        FROM scheduled_messages sm
       WHERE sm.recipient_type = 'client' AND sm.recipient_id = $1
         AND sm.status = 'sent' AND sm.sent_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM message_log ml2
            WHERE ml2.client_id = $1
              AND ml2.channel = sm.channel
              AND ml2.status NOT IN ('failed', 'bounced')
              AND ml2.created_at BETWEEN sm.sent_at - INTERVAL '${TWIN_WINDOW}'
                                     AND sm.sent_at + INTERVAL '${TWIN_WINDOW}'
         )
      ${campaignLeg}
    ) h
    -- id + source tiebreak so a LIMIT cut is deterministic when two rows share
    -- a timestamp (event_eve is deliberately an SMS + email pair).
    ORDER BY h.at DESC, h.source, h.id DESC
    LIMIT $2
  `, [id, cap]);

  return rows;
}

module.exports = {
  getContactMessageHistory,
  MAX_LIMIT,
  _resetCampaignLegProbe,
};

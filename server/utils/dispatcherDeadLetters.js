/**
 * Dead-letter recovery for the scheduled-message dispatcher — the critical-path
 * re-resolve sweep (spec §6.13 / Phase 2 Task 7). Extracted from
 * scheduledMessageDispatcher.js to keep the dispatcher core under the file-size
 * cap. The dispatcher requires this module and calls resolveCriticalDeadLetters()
 * once per tick, after the main drain. Leaf module: it requires the pool /
 * resolver / sms it needs directly and never requires the dispatcher back, so
 * there is no require cycle.
 */
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const {
  pickChannelsForUserAndCategory,
  CRITICAL_CATEGORIES,
} = require('./notificationChannelResolver');
// Module-level (not destructured) so tests can monkey-patch sms.sendAndLogSms.
const sms = require('./sms');

async function resolveCriticalDeadLetters() {
  // One row per group, GROUP BY suppression_key. Only consider groups where:
  //   - All rows are terminal (sent / failed / suppressed / suppressed_by_sibling / dead_letter)
  //   - NO sibling is 'sent', 'pending', or 'deferred' (no live retry in flight)
  //   - The category (from payload->>'category') is in CRITICAL_CATEGORIES
  //   - The group's max re_resolve_count is < 2
  // For each group, increment counter + re-resolve + enqueue OR dead-letter all rows.
  const { rows: groups } = await pool.query(
    `SELECT suppression_key,
            recipient_id AS user_id,
            entity_type, entity_id, message_type,
            MAX(COALESCE((payload->>'category'), '')) AS category,
            MAX(COALESCE((payload->>'re_resolve_count')::int, 0)) AS re_resolve_count,
            MAX(scheduled_for) AS last_scheduled
       FROM scheduled_messages
      WHERE suppression_key IS NOT NULL
        AND recipient_type = 'staff'
        AND status IN ('failed','suppressed','suppressed_by_sibling','dead_letter')
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_messages sm2
           WHERE sm2.suppression_key = scheduled_messages.suppression_key
             AND sm2.status IN ('sent','pending','deferred','processing')
        )
      GROUP BY suppression_key, recipient_id, entity_type, entity_id, message_type
      HAVING MAX(COALESCE((payload->>'re_resolve_count')::int, 0)) < 99`
  );

  for (const group of groups) {
    if (!CRITICAL_CATEGORIES.has(group.category)) continue;

    // If counter already hit the cap, dead-letter everything in the group.
    if (group.re_resolve_count >= 2) {
      await pool.query(
        `UPDATE scheduled_messages
            SET status = 'dead_letter',
                error_message = $2
          WHERE suppression_key = $1
            AND status IN ('failed','suppressed','suppressed_by_sibling')`,
        [group.suppression_key, 're_resolve_cap_reached']
      );
      Sentry.captureMessage('critical_path_dead_letter', {
        tags: { dispatcher: 'critical_path' },
        extra: {
          user_id: group.user_id,
          category: group.category,
          message_type: group.message_type,
          suppression_key: group.suppression_key,
          re_resolve_count: group.re_resolve_count,
        },
      });
      // Out-of-band hotline SMS (spec §6.13)
      if (process.env.ADMIN_PHONE) {
        try {
          await sms.sendAndLogSms({
            to: process.env.ADMIN_PHONE,
            body: `DR BARTENDER: critical message dead-lettered for user ${group.user_id} category ${group.category}, check Sentry`,
            messageType: 'critical_path_dead_letter_alert',
          });
        } catch (smsErr) {
          console.error('[dispatcher] critical-path dead-letter ADMIN_PHONE SMS failed:', smsErr.message);
        }
      }
      continue;
    }

    // Re-resolve with fresh state.
    const resolved = await pickChannelsForUserAndCategory(group.user_id, group.category);
    if (resolved.kind === 'dead_letter') {
      await pool.query(
        `UPDATE scheduled_messages
            SET status = 'dead_letter',
                error_message = $2
          WHERE suppression_key = $1
            AND status IN ('failed','suppressed','suppressed_by_sibling')`,
        [group.suppression_key, 're_resolve_all_blocked']
      );
      Sentry.captureMessage('critical_path_dead_letter', {
        tags: { dispatcher: 'critical_path' },
        extra: {
          user_id: group.user_id,
          category: group.category,
          message_type: group.message_type,
          reason: 'resolver_dead_letter',
        },
      });
      if (process.env.ADMIN_PHONE) {
        try {
          await sms.sendAndLogSms({
            to: process.env.ADMIN_PHONE,
            body: `DR BARTENDER: critical message dead-lettered for user ${group.user_id} category ${group.category}, check Sentry`,
            messageType: 'critical_path_dead_letter_alert',
          });
        } catch (smsErr) {
          console.error('[dispatcher] critical-path dead-letter ADMIN_PHONE SMS failed:', smsErr.message);
        }
      }
      continue;
    }
    // Enqueue ONE new row at the first resolved channel with a fresh
    // suppression_key + re_resolve_count + 1. Reuse the same entity context.
    const nextChannel = resolved.channels[0];
    const newCount = group.re_resolve_count + 1;
    const newKey = `${group.suppression_key}:retry${newCount}`;
    // Read the original row's payload to carry forward (modulo the counter).
    const { rows: srcRows } = await pool.query(
      `SELECT payload FROM scheduled_messages
        WHERE suppression_key = $1 ORDER BY id ASC LIMIT 1`,
      [group.suppression_key]
    );
    const srcPayload = srcRows[0]?.payload || {};
    const newPayload = { ...srcPayload, re_resolve_count: newCount };
    await pool.query(
      `INSERT INTO scheduled_messages
         (entity_id, entity_type, message_type, recipient_type, recipient_id,
          channel, scheduled_for, status, suppression_key, payload)
       VALUES ($1, $2, $3, 'staff', $4, $5, NOW(), 'pending', $6, $7::jsonb)
       ON CONFLICT (entity_id, entity_type, message_type, recipient_id, recipient_type, channel)
         WHERE status = 'pending'
       DO NOTHING`,
      [group.entity_id, group.entity_type, group.message_type, group.user_id,
       nextChannel, newKey, JSON.stringify(newPayload)]
    );
    // Degradation breadcrumb: ops can see silent channel substitution.
    Sentry.addBreadcrumb({
      category: 'notifications',
      message: 'critical_path_re_resolved',
      data: {
        user_id: group.user_id,
        category: group.category,
        new_channel: nextChannel,
        re_resolve_count: newCount,
      },
    });
  }
}

module.exports = { resolveCriticalDeadLetters };

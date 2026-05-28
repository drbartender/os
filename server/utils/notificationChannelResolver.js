const { pool } = require('../db');

/**
 * Notification channel resolver for the staff portal redesign (spec §6.13).
 *
 * Reads users.staff_notification_preferences AND users.communication_preferences,
 * returns the effective channel set after kill-switch suppression + critical-path
 * override. Pure helper: one user-row SELECT, no side effects.
 *
 * The DEFAULT_CHANNELS map is the single source of truth for missing-key fallbacks.
 * If a category is added later (e.g., 'event_reminder_24h') without a corresponding
 * staff_notification_preferences backfill, the resolver returns DEFAULT_CHANNELS[cat]
 * rather than empty (which would silently suppress the message).
 */

const CRITICAL_CATEGORIES = new Set(['beo_finalized', 'schedule_change', 'payday']);

// Tried in order when every requested channel is blocked AND category is critical.
const CRITICAL_FALLBACK_ORDER = ['sms', 'email', 'push'];

const DEFAULT_CHANNELS = Object.freeze({
  shift_offered:   ['push', 'sms', 'email'],
  shift_decided:   ['push', 'sms'],
  cover_needed:    ['push'],
  beo_finalized:   ['push', 'sms', 'email'],
  beo_reminder_t3: ['push', 'sms'],
  schedule_change: ['push', 'sms', 'email'],
  payday:          ['sms', 'email'],
  tip_received:    ['push'],
});

/**
 * Resolve the effective channel set for a categorized message.
 *
 * @param {number} userId
 * @param {string} category one of the keys in DEFAULT_CHANNELS
 * @returns {Promise<{kind:'channels', channels:string[]} | {kind:'dead_letter', reason:string}>}
 */
async function pickChannelsForUserAndCategory(userId, category) {
  const { rows } = await pool.query(
    `SELECT staff_notification_preferences AS prefs,
            communication_preferences      AS comms
       FROM users WHERE id = $1`,
    [userId]
  );
  if (rows.length === 0) return { kind: 'channels', channels: [] };
  const { prefs, comms } = rows[0];

  const stored = Array.isArray(prefs?.channels?.[category]) ? prefs.channels[category] : null;
  const requested = stored !== null ? stored : (DEFAULT_CHANNELS[category] || []);

  const filtered = requested.filter(ch => {
    if (ch === 'sms' && comms?.sms_enabled === false) return false;
    if (ch === 'email' && comms?.email_enabled === false) return false;
    return true;
  });

  if (filtered.length > 0) {
    return { kind: 'channels', channels: Array.from(new Set(filtered)) };
  }

  if (CRITICAL_CATEGORIES.has(category)) {
    const pushSubs = Array.isArray(prefs?.push_subscriptions) ? prefs.push_subscriptions : [];
    for (const ch of CRITICAL_FALLBACK_ORDER) {
      if (ch === 'sms' && comms?.sms_enabled === false) continue;
      if (ch === 'email' && comms?.email_enabled === false) continue;
      if (ch === 'push' && pushSubs.length === 0) continue;
      return { kind: 'channels', channels: [ch] };
    }
    return { kind: 'dead_letter', reason: 'all_channels_blocked' };
  }

  return { kind: 'channels', channels: [] };
}

module.exports = {
  pickChannelsForUserAndCategory,
  CRITICAL_CATEGORIES,
  CRITICAL_FALLBACK_ORDER,
  DEFAULT_CHANNELS,
};

// Staff portal — notification preferences + Web Push subscriptions.
//
// Spec §6.13 (Notifications), §6.17 (Push). Extracted VERBATIM from
// staffPortal.js 2026-08-20 to get that router back under the file-size ratchet;
// it sat at 997 lines against a 1000 hard cap — wc-style, the way
// scripts/check-file-size.js counts — so the next addition to the staff
// portal was blocked. Behavior is unchanged — same routes, same order, same
// handlers, registered onto the SAME router by the parent, so `router.use(auth)`
// and mount order still apply exactly as before.
//
// This section was chosen because it is the only large one that touches neither
// the `_deps` stub seam (uploadFile / sendEmail / today) nor any money path.
// PUSH_SUBSCRIPTION_CAP is declared with the notification constants but consumed
// by the push routes, which is why the two travel together rather than splitting.
//
// Mirrors the register(router) shape of ./paymentMethods.js, ./payouts.js and
// ./accountReads.js.

const { pool } = require('../../db');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError } = require('../../utils/errors');

const NOTIFICATION_CATEGORIES_STAFF = new Set([
  'shift_offered', 'shift_decided', 'cover_needed',
  'beo_finalized', 'beo_reminder_t3', 'schedule_change',
  'payday', 'tip_received',
]);

const NOTIFICATION_CHANNELS = new Set(['push', 'sms', 'email']);

// Critical-path categories (spec §6.13). Each MUST individually retain at
// least one channel after a PATCH; if any one of these is left with no
// channel, the PATCH rejects 400 with a _form error.
const CRITICAL_NOTIFICATION_CATEGORIES = ['beo_finalized', 'schedule_change', 'payday'];

const PUSH_SUBSCRIPTION_CAP = 10;

function register(router) {
  router.get('/staff-notifications', asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT staff_notification_preferences, communication_preferences FROM users WHERE id = $1',
      [req.user.id]
    );
    res.json({
      prefs: rows[0]?.staff_notification_preferences || {},
      comms: rows[0]?.communication_preferences || {},
    });
  }));

  router.patch('/staff-notifications', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const allowedTop = new Set(['channels', 'quiet_hours']);
    for (const k of Object.keys(body)) {
      if (!allowedTop.has(k)) {
        throw new ValidationError({ body: `Unknown field: ${k}` }, `Unknown field: ${k}`);
      }
    }

    // Validate the channels patch (partial — caller may only send a subset).
    if (body.channels !== undefined) {
      if (typeof body.channels !== 'object' || body.channels === null || Array.isArray(body.channels)) {
        throw new ValidationError({ channels: 'must be an object' });
      }
      for (const [cat, chans] of Object.entries(body.channels)) {
        if (!NOTIFICATION_CATEGORIES_STAFF.has(cat)) {
          throw new ValidationError({ [`channels.${cat}`]: `Unknown category: ${cat}` });
        }
        if (!Array.isArray(chans)) {
          throw new ValidationError({ [`channels.${cat}`]: 'must be an array' });
        }
        for (const c of chans) {
          if (!NOTIFICATION_CHANNELS.has(c)) {
            throw new ValidationError({ [`channels.${cat}`]: `Unknown channel: ${c}` });
          }
        }
      }
    }

    if (body.quiet_hours !== undefined && body.quiet_hours !== null) {
      if (typeof body.quiet_hours !== 'object' || Array.isArray(body.quiet_hours)) {
        throw new ValidationError({ quiet_hours: 'must be an object or null' });
      }
    }

    // Read current prefs to compute the prospective merged state for the
    // per-category critical-path check. Spec §6.13: rejection is PER-CATEGORY
    // (not aggregate). A save that leaves any one critical category with no
    // deliverable channel rejects, regardless of the other categories.
    const { rows: currRows } = await pool.query(
      'SELECT staff_notification_preferences FROM users WHERE id = $1',
      [req.user.id]
    );
    const current = currRows[0]?.staff_notification_preferences || {};
    const currentChannels = current.channels || {};
    const incomingChannels = body.channels || {};
    // Per-category: incoming wins, otherwise keep current. Categories not in
    // either source are inherently fine (the default-channels resolver in
    // notificationChannelResolver covers missing keys).
    for (const cat of CRITICAL_NOTIFICATION_CATEGORIES) {
      const next = cat in incomingChannels ? incomingChannels[cat] : currentChannels[cat];
      if (Array.isArray(next) && next.length === 0) {
        throw new ValidationError(
          { _form: 'Critical messages need at least one channel.' },
          'Critical messages need at least one channel.'
        );
      }
    }

    // Build the merged JSONB via chained jsonb_set so concurrent saves from
    // multiple devices don't clobber sibling categories.
    let sqlExpr = `COALESCE(staff_notification_preferences, '{}'::jsonb)`;
    const params = [req.user.id];

    if (body.channels !== undefined) {
      // For each category present in the body, jsonb_set the channels[cat] path.
      for (const cat of Object.keys(body.channels)) {
        params.push(JSON.stringify(body.channels[cat]));
        sqlExpr = `jsonb_set(${sqlExpr}, '{channels,${cat}}', $${params.length}::jsonb, true)`;
      }
    }
    if (body.quiet_hours !== undefined) {
      params.push(JSON.stringify(body.quiet_hours));
      sqlExpr = `jsonb_set(${sqlExpr}, '{quiet_hours}', $${params.length}::jsonb, true)`;
    }

    const { rows } = await pool.query(
      `UPDATE users SET staff_notification_preferences = ${sqlExpr}, updated_at = NOW()
        WHERE id = $1 RETURNING staff_notification_preferences`,
      params
    );
    res.json({ prefs: rows[0].staff_notification_preferences });
  }));

  router.post('/push-subscriptions', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
    const keys = body.keys || {};
    const userAgent = typeof body.user_agent === 'string' ? body.user_agent.slice(0, 500) : '';

    if (!endpoint || endpoint.length > 1000) {
      throw new ValidationError({ endpoint: 'must be a non-empty string up to 1000 chars' });
    }
    if (!keys.p256dh || !keys.auth || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') {
      throw new ValidationError({ keys: 'must include p256dh + auth strings' });
    }

    const newEntry = {
      endpoint,
      keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) },
      user_agent: userAgent,
      subscribed_at: new Date().toISOString(),
    };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT staff_notification_preferences FROM users WHERE id = $1 FOR UPDATE`,
        [req.user.id]
      );
      const prefs = rows[0]?.staff_notification_preferences || {};
      const subs = Array.isArray(prefs.push_subscriptions) ? [...prefs.push_subscriptions] : [];

      // Replace-in-place if the endpoint already exists; otherwise append.
      const existingIdx = subs.findIndex((s) => s && s.endpoint === endpoint);
      if (existingIdx >= 0) {
        subs[existingIdx] = newEntry;
      } else {
        subs.push(newEntry);
      }

      // Cap at 10 active subscriptions. Evict OLDEST by subscribed_at; on a
      // timestamp tie keep the entry with the LOWER array index (spec §6.13).
      while (subs.length > PUSH_SUBSCRIPTION_CAP) {
        let oldestIdx = 0;
        let oldestTs = subs[0]?.subscribed_at || '';
        for (let i = 1; i < subs.length; i += 1) {
          const t = subs[i]?.subscribed_at || '';
          if (t < oldestTs) {
            oldestTs = t;
            oldestIdx = i;
          }
          // Strict < — equal timestamps keep the lower index per spec.
        }
        subs.splice(oldestIdx, 1);
      }

      await client.query(
        `UPDATE users SET staff_notification_preferences = jsonb_set(
           COALESCE(staff_notification_preferences, '{}'::jsonb),
           '{push_subscriptions}',
           $2::jsonb,
           true
         ), updated_at = NOW() WHERE id = $1`,
        [req.user.id, JSON.stringify(subs)]
      );
      await client.query('COMMIT');
      res.json({ ok: true, count: subs.length });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* gone */ }
      throw err;
    } finally {
      client.release();
    }
  }));

  router.delete('/push-subscriptions', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
    if (!endpoint) throw new ValidationError({ endpoint: 'required' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT staff_notification_preferences FROM users WHERE id = $1 FOR UPDATE`,
        [req.user.id]
      );
      const prefs = rows[0]?.staff_notification_preferences || {};
      const subs = Array.isArray(prefs.push_subscriptions) ? prefs.push_subscriptions : [];
      const next = subs.filter((s) => s && s.endpoint !== endpoint);
      await client.query(
        `UPDATE users SET staff_notification_preferences = jsonb_set(
           COALESCE(staff_notification_preferences, '{}'::jsonb),
           '{push_subscriptions}',
           $2::jsonb,
           true
         ), updated_at = NOW() WHERE id = $1`,
        [req.user.id, JSON.stringify(next)]
      );
      await client.query('COMMIT');
      res.json({ ok: true, removed: subs.length - next.length, count: next.length });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* gone */ }
      throw err;
    } finally {
      client.release();
    }
  }));
}

module.exports = { register };

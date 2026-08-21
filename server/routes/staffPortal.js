// Staff portal API — composite + account-management endpoints (spec
// docs/superpowers/specs/2026-05-27-staff-portal-redesign-design.md).
//
// Mounted at /api/me, AFTER server/routes/me.js so existing paths win on any
// path collision. Verified no overlap at write time: me.js owns /tip-page,
// /tips, /notification-preferences; this router owns /staff-home,
// /payment-methods, /preferred-payment-method, /tip-card-order, /profile,
// /ui-preferences, /staff-notifications, /push-subscriptions, /documents/...,
// /request-email-change, /cancel-pending-email-change.

const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, ConflictError, PayloadTooLargeError } = require('../utils/errors');
const { validatePhone } = require('../utils/phone');
const { refreshDisplayName } = require('../utils/refreshDisplayName');
const { chicagoTodayYmd } = require('../utils/businessTime');
const { validatePreferredNameChange } = require('../utils/staffDisplayName.validate');
const { isValidUpload } = require('../utils/fileValidation');
const storage = require('../utils/storage');
const { sendEmail } = require('../utils/email');
const { emailChangeVerification, emailChangeWarning } = require('../utils/lifecycleEmailTemplates');
const { STAFF_URL } = require('../utils/urls');
const { emailChangeRequestLimiter } = require('../middleware/rateLimiters');
// THE shift-visibility predicate — see server/utils/shiftEndInstant.js.
const { shiftNotFinishedSql, shiftEndInstantSql } = require('../utils/shiftEndInstant');
const paymentMethods = require('./staffPortal/paymentMethods');
const payouts = require('./staffPortal/payouts');
const accountReads = require('./staffPortal/accountReads');
const notifications = require('./staffPortal/notifications');
const crypto = require('crypto');

// Stub seam — tests swap uploadFile + sendEmail to avoid hitting real R2 /
// Resend. Defaults to the real impls in prod / dev.
// `today` is injectable for the same reason uploadFile and sendEmail are: the
// pay-period lookup below is a DATE decision, and the only interesting dates are
// the ones a test cannot wait for. Pinning global Date instead would expire the
// suite's own JWT, so the clock is a dependency rather than a mock.
let _deps = { uploadFile: storage.uploadFile, sendEmail, today: chicagoTodayYmd };
function __setDeps(d) { _deps = { ..._deps, ...d }; }

const router = express.Router();
router.use(auth);

// ─── Task 12: GET /staff-home (composite home payload) ─────────────────────
//
// One round-trip for the redesigned HomePage. Four parallel queries via
// Promise.all (none depend on each other's results):
//   1. Next upcoming approved shift, with BEO finalize + ack projection.
//   2. Pending shift_requests for this user.
//   3. Cover broadcasts visible to this user (any shift_request with
//      cover_requested_at NOT NULL, requester != this user). Each broadcast
//      carries `you_are_on_team` derived from same-proposal approved requests.
//   4. Current pay-period summary (projected payout total + event count +
//      payday + status). Mirrors the payoutAccrual / payouts pattern.
//   5. Open-shifts teaser (spec §6.2): top 2 soonest open future shifts, plus
//      open_shifts_count for the "All (N)" link to Shifts -> Available.
//
// EVERY shift boundary below asks "has this shift finished yet" — the shift's
// END INSTANT (server/utils/shiftEndInstant.js) compared to NOW() — never a
// calendar day. Under the old `event_date >= CURRENT_DATE` (the GMT day on this
// session) this whole payload went wrong together for the last five hours of
// every day: the next-shift card said "no upcoming shift" to a staffer opening
// the portal 30 minutes before call time, tonight's pending request and cover
// broadcast disappeared, and the teaser and its "All (N)" count silently
// disagreed with the Available tab. Swapping to the Chicago calendar day fixed
// the disappearance and introduced the opposite fault — this MORNING's finished
// shift stayed on the card until midnight. The end instant answers both.
//
// The teaser and the count are documented mirrors of STAFF_OPEN_SHIFTS_SQL
// (routes/shifts.queries.js). All three now import the same fragment, because
// the count and the list it counts drifting apart is exactly what broke the
// round this replaces. The pay-period query is the one holdout — see its note.
router.get('/staff-home', asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const [nextShift, pendingRequests, coverBroadcasts, currentPeriod, openShiftsTeaser, openShiftsCount] = await Promise.all([
    pool.query(`
      SELECT s.id AS shift_id, s.event_date, s.start_time, s.end_time, s.location,
             s.positions_needed,
             sr.id AS request_id, sr.status AS request_status, sr.position,
             sr.beo_acknowledged_at,
             p.id AS proposal_id, p.event_type, p.event_type_custom,
             p.event_timezone, p.event_duration_hours,
             c.name AS client_name,
             dp.finalized_at AS drink_plan_finalized_at,
             dp.id AS drink_plan_id
        FROM shift_requests sr
        JOIN shifts s ON s.id = sr.shift_id
        LEFT JOIN proposals p ON p.id = s.proposal_id
        LEFT JOIN clients c ON c.id = p.client_id
        LEFT JOIN drink_plans dp ON dp.proposal_id = p.id
       WHERE sr.user_id = $1
         AND sr.status = 'approved'
         AND sr.dropped_at IS NULL
         AND ${shiftNotFinishedSql('s', 'p')}
       -- Order by the END INSTANT, never by start_time. start_time is free text,
       -- so ASC on it compares '7:00 PM' against '8:00 AM' as STRINGS and puts
       -- the evening shift first: a staffer with an 8am brunch and a 7pm wedding
       -- on the same day was shown the 7pm call time on the morning they were
       -- due at 8. Among shifts that have not finished, the earliest end is the
       -- nearest one.
       -- CORRECTED 2026-08-20: this used to claim "same ordering as
       -- findNearestApprovedShift, deliberately". It is no longer the same.
       -- smsInbound.js:431 gained a leading (event_date < today) term so a
       -- past-dated overnight shift can never outrank a current one on the CANT
       -- WRITE path. This read path did not, so between 00:00 and about 08:00
       -- Chicago the two can name different shifts: this card can show last
       -- night's still-unfinished shift while a CANT or CONFIRM text acts on
       -- tonight's. Whether the card SHOULD keep showing an in-progress
       -- overnight shift is a product call and is open in the fix list; what is
       -- not open is that this comment must not claim a parity that is gone.
       ORDER BY ${shiftEndInstantSql('s', 'p')} ASC, s.id ASC
       LIMIT 1
    `, [userId]),

    pool.query(`
      SELECT sr.id AS request_id, sr.created_at, sr.position,
             s.id AS shift_id, s.event_date, s.start_time, s.end_time, s.location,
             p.id AS proposal_id, p.event_type, p.event_type_custom,
             c.name AS client_name
        FROM shift_requests sr
        JOIN shifts s ON s.id = sr.shift_id
        LEFT JOIN proposals p ON p.id = s.proposal_id
        LEFT JOIN clients c ON c.id = p.client_id
       WHERE sr.user_id = $1
         AND sr.status = 'pending'
         AND ${shiftNotFinishedSql('s', 'p')}
       ORDER BY s.event_date ASC
    `, [userId]),

    pool.query(`
      SELECT sr.id AS request_id, sr.cover_requested_at, sr.cover_reason,
             sr.user_id AS requester_id,
             s.id AS shift_id, s.event_date, s.start_time, s.end_time, s.location,
             p.id AS proposal_id, p.event_type, p.event_type_custom,
             c.name AS client_name,
             u.email AS requester_email,
             COALESCE(cp.display_name, cp.preferred_name) AS requester_preferred_name,
             EXISTS (
               SELECT 1 FROM shift_requests sr2
                WHERE sr2.shift_id = sr.shift_id
                  AND sr2.user_id = $1
                  AND sr2.status = 'approved'
                  AND sr2.dropped_at IS NULL
             ) AS you_are_on_team
        FROM shift_requests sr
        JOIN shifts s ON s.id = sr.shift_id
        LEFT JOIN proposals p ON p.id = s.proposal_id
        LEFT JOIN clients c ON c.id = p.client_id
        LEFT JOIN users u ON u.id = sr.user_id
        LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
       WHERE sr.cover_requested_at IS NOT NULL
         AND sr.user_id <> $1
         AND sr.status = 'approved'
         AND sr.dropped_at IS NULL
         AND ${shiftNotFinishedSql('s', 'p')}
       ORDER BY s.event_date ASC
       LIMIT 20
    `, [userId]),

    pool.query(`
      SELECT pp.id AS pay_period_id, pp.start_date, pp.end_date,
             pp.payday,
             CASE WHEN pp.status = 'reopened' THEN 'processing' ELSE pp.status END AS status,
             po.id AS payout_id, COALESCE(po.total_cents, 0) AS total_cents,
             COALESCE((
               SELECT COUNT(*)::int FROM payout_events pe WHERE pe.payout_id = po.id
             ), 0) AS event_count,
             COALESCE((
               SELECT COUNT(*)::int FROM payout_duty_lines d
                WHERE d.payout_id = po.id AND d.removed_at IS NULL
                  AND (d.held_state IS NULL OR d.held_state = 'confirmed')
             ), 0) AS duty_line_count
        FROM pay_periods pp
        LEFT JOIN payouts po ON po.pay_period_id = pp.id AND po.contractor_id = $1
       -- The Chicago business day, passed in, NOT CURRENT_DATE: the session runs
       -- at GMT, so CURRENT_DATE rolls over at 19:00 Chicago and on a period's
       -- last evening this asked for a period whose row accrual has not minted
       -- yet, matching nothing and emptying the card. Full account in
       -- ARCHITECTURE.md > Database Schema and in the boundary suite's header.
       -- A pay-period boundary is a DATE boundary; no shift end-instant applies.
       WHERE $2::date BETWEEN pp.start_date AND pp.end_date
       ORDER BY pp.start_date DESC
       LIMIT 1
    `, [userId, _deps.today()]),

    // Open shifts teaser — top 2 soonest open shifts that have not finished
    // (spec §6.2). Mirrors the Available tab's open-shift filter (status='open'
    // AND the end instant has not passed — STAFF_OPEN_SHIFTS_SQL in
    // routes/shifts.queries.js) so the cards, the "All (N)" count below and the
    // tab they link to stay consistent. That mirror is why all three import the
    // SAME fragment rather than restating it. A lean projection (vs reusing
    // STAFF_OPEN_SHIFTS_SQL, which is built for the full 500-row Available list
    // with the cover LATERAL) is enough for the 2-row teaser.
    pool.query(`
      SELECT s.id AS shift_id, s.event_date, s.start_time, s.end_time, s.location,
             p.id AS proposal_id, p.event_type, p.event_type_custom,
             p.guest_count, c.name AS client_name
        FROM shifts s
        LEFT JOIN proposals p ON p.id = s.proposal_id
        LEFT JOIN clients c ON c.id = p.client_id
       WHERE s.status = 'open' AND ${shiftNotFinishedSql('s', 'p')}
       -- Same reason as the next-shift card above: start_time is free text, so
       -- ASC on it sorts '7:00 PM' before '8:00 AM'. With LIMIT 2 that does not
       -- merely reorder the teaser, it can HIDE the soonest open shift entirely.
       ORDER BY ${shiftEndInstantSql('s', 'p')} ASC, s.id ASC
       LIMIT 2
    `),

    // Total unfinished open shifts for the "All (N)" link to Shifts → Available.
    // THE COUNT FOR THE TEASER AND THE TAB. Same fragment as both, and the
    // LEFT JOIN exists only to reach event_timezone — this query had no join at
    // all when it read CURRENT_DATE, which is precisely how it could drift.
    pool.query(`
      SELECT COUNT(*)::int AS n
        FROM shifts s
        LEFT JOIN proposals p ON p.id = s.proposal_id
       WHERE s.status = 'open' AND ${shiftNotFinishedSql('s', 'p')}
    `),
  ]);

  res.json({
    next_shift: nextShift.rows[0] || null,
    pending_requests: pendingRequests.rows,
    cover_broadcasts: coverBroadcasts.rows,
    current_period: currentPeriod.rows[0] || null,
    open_shifts_teaser: openShiftsTeaser.rows,
    open_shifts_count: openShiftsCount.rows[0].n,
  });
}));

// ─── Task 13: Payment methods (delegated) ──────────────────────────────────
// Spec §6.11. Implementation lives in ./staffPortal/paymentMethods.js to keep
// this top-level router under the file-size ratchet.
paymentMethods.register(router);

// ─── Phase 8: Staffer payout read endpoints (delegated) ───────────────────
// Spec §6.6 (Pay tab). Implementation lives in ./staffPortal/payouts.js.
// Exposes GET /payouts (list for req.user.id) and GET /payouts/:periodId
// (one period's detail, scoped to req.user.id — IDOR-guarded by the JOIN
// condition po.contractor_id = $1 AND po.pay_period_id = $2).
payouts.register(router);

// ─── Phase 9: Account READ endpoints (delegated) ──────────────────────────
// Spec §6.10 (Profile), §6.12 (Calendar sync), §6.14 (Documents). Implementation
// lives in ./staffPortal/accountReads.js. Exposes GET /profile, GET /calendar-
// settings, and GET /documents — all hard-scoped to req.user.id (no userId
// path param). The Documents endpoint never projects raw R2 keys; the Profile
// endpoint returns the staffer's own PII (intentional — they need to edit it).
accountReads.register(router);

// ─── Task 14: tip-card-order, profile, ui-preferences ─────────────────────

// Spec §6.8: order is a JSON array of method tokens. Card is always implicit.
const TIP_CARD_METHOD_TOKENS = new Set(['card', 'venmo', 'cashapp', 'paypal', 'zelle']);

router.put('/tip-card-order', asyncHandler(async (req, res) => {
  const order = req.body?.order;
  if (!Array.isArray(order)) {
    throw new ValidationError({ order: 'must be an array' }, 'order must be an array');
  }
  if (order.length > TIP_CARD_METHOD_TOKENS.size) {
    throw new ValidationError({ order: 'too many tokens' });
  }
  const seen = new Set();
  for (const tok of order) {
    if (!TIP_CARD_METHOD_TOKENS.has(tok)) {
      throw new ValidationError({ order: `Unknown method token: ${tok}` }, `Unknown method token: ${tok}`);
    }
    if (seen.has(tok)) {
      throw new ValidationError({ order: `Duplicate token: ${tok}` }, `Duplicate token: ${tok}`);
    }
    seen.add(tok);
  }

  await pool.query(
    `UPDATE users
        SET ui_preferences = jsonb_set(
              COALESCE(ui_preferences, '{}'::jsonb),
              '{tip_card_order}',
              $2::jsonb,
              true
            ),
            updated_at = NOW()
      WHERE id = $1`,
    [req.user.id, JSON.stringify(order)]
  );
  res.json({ tip_card_order: order });
}));

// PROFILE allowlist — note: NOT email. Email goes through the separate
// request-email-change flow (Task 17). Server-side validation per spec §6.10.
const PROFILE_ALLOWED_KEYS = new Set([
  'preferred_name', 'phone', 'street_address', 'city', 'state', 'zip_code',
  'emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relationship',
]);

const ZIP_RE = /^\d{5}(-\d{4})?$/;

function trimOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

router.patch('/profile', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const keys = Object.keys(body);
  for (const k of keys) {
    if (!PROFILE_ALLOWED_KEYS.has(k)) {
      throw new ValidationError({ body: `Unknown field: ${k}` }, `Unknown field: ${k}`);
    }
  }
  if (keys.length === 0) {
    throw new ValidationError({ _form: 'No fields to update.' }, 'No fields to update.');
  }

  const prevRow = await pool.query('SELECT preferred_name FROM contractor_profiles WHERE user_id = $1', [req.user.id]);
  const prevPreferredName = prevRow.rows[0]?.preferred_name ?? null;

  const updates = {};

  if ('preferred_name' in body) {
    // validatePreferredNameChange, NOT validatePreferredName: an unchanged
    // legacy value always passes, so nobody is locked out of editing their own
    // address by a name they cannot fix through the form (spec §3.4).
    const check = validatePreferredNameChange(body.preferred_name, prevPreferredName);
    if (!check.valid) throw new ValidationError({ preferred_name: check.error });
    updates.preferred_name = check.value;
  }
  if ('street_address' in body) updates.street_address = trimOrNull(body.street_address);
  if ('city' in body)           updates.city           = trimOrNull(body.city);
  if ('state' in body) {
    const st = trimOrNull(body.state);
    if (st !== null && st.length > 2) {
      throw new ValidationError({ state: 'must be a 2-letter state code' });
    }
    updates.state = st;
  }

  if ('zip_code' in body) {
    const z = trimOrNull(body.zip_code);
    if (z !== null && !ZIP_RE.test(z)) {
      throw new ValidationError({ zip_code: 'must be 5 digits or 5+4 (e.g. 12345 or 12345-6789)' });
    }
    updates.zip_code = z;
  }

  for (const f of ['emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relationship']) {
    if (f in body) {
      const v = trimOrNull(body[f]);
      if (v !== null && v.length > 100) {
        throw new ValidationError({ [f]: 'must be 100 chars or fewer' });
      }
      updates[f] = v;
    }
  }

  // Phone validation (E.164-ish per server/utils/phone.js: stores 10-digit US).
  if ('phone' in body) {
    const { value, error } = validatePhone(body.phone);
    if (error) throw new ValidationError({ phone: error });
    updates.phone = value;
  }

  // Phone-change audit (spec §6.10): if `phone` is in body AND differs, log
  // an audit row with last-4-only old + new (no full PII in the audit trail).
  let phoneOld = null;
  let phoneNew = null;
  if ('phone' in updates) {
    const prevRes = await pool.query(
      'SELECT phone FROM contractor_profiles WHERE user_id = $1',
      [req.user.id]
    );
    const prev = prevRes.rows[0]?.phone || null;
    if (prev !== updates.phone) {
      phoneOld = prev ? prev.slice(-4) : null;
      phoneNew = updates.phone ? updates.phone.slice(-4) : null;
    }
  }

  // Ensure a row exists, then UPDATE the allowlisted fields.
  await pool.query(
    'INSERT INTO contractor_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
    [req.user.id]
  );
  const cols = Object.keys(updates);
  if (cols.length > 0) {
    const setClause = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    await pool.query(
      `UPDATE contractor_profiles SET ${setClause}, updated_at = NOW() WHERE user_id = $1`,
      [req.user.id, ...cols.map((c) => updates[c])]
    );
  }

  // Display name is derived, so it is recomputed on every profile write.
  // previousPreferredName is passed ONLY when the caller sent a preferred_name,
  // so a phone-only edit cannot re-raise the §3.5 notice.
  // Contained (contractor.js pattern): the profile write above has already
  // autocommitted, so a DB blip here must not 500 a save that succeeded.
  try {
    if ('preferred_name' in updates) {
      await refreshDisplayName(req.user.id, pool, { previousPreferredName: prevPreferredName });
    } else {
      await refreshDisplayName(req.user.id, pool);
    }
  } catch (dnErr) {
    console.error('[StaffPortal] display-name refresh failed:', dnErr.message);
    Sentry.captureException(dnErr, { tags: { route: 'PATCH /api/staff-portal/profile', step: 'display_name' } });
  }

  // Audit row OUTSIDE the implicit "transaction" (it's all auto-commit anyway,
  // but conceptually: profile write succeeded → log; never roll back on audit
  // insert failure).
  if (phoneOld !== null || phoneNew !== null) {
    try {
      await pool.query(
        `INSERT INTO staff_audit_log (user_id, actor_type, actor_id, action, details)
         VALUES ($1, 'staff', $1, 'profile_phone_change', $2)`,
        [req.user.id, JSON.stringify({ old_phone_last4: phoneOld, new_phone_last4: phoneNew })]
      );
    } catch (err) {
      try {
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(err, {
            tags: { route: 'staffPortal.profile', op: 'audit_insert' },
            extra: { user_id: req.user.id },
          });
        }
      } catch (_) { /* swallow */ }
    }
  }

  res.json({ ok: true, fields_changed: cols });
}));

// UI preferences allowlist (spec §6.16 + §6.12).
const UI_PREF_ALLOWED_KEYS = new Set(['theme', 'calendar_subscribed_app']);
const UI_PREF_THEMES = new Set(['light', 'dark']);

// GET sibling of the PATCH below. Used by StaffShellWithThemeWiring on mount
// to hydrate the skin from ui_preferences.theme before the first paint (spec
// §6.16). Returns `{ ui_preferences: {} }` rather than 404 for the new-user
// case where no preferences have been written yet.
router.get('/ui-preferences', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT ui_preferences FROM users WHERE id = $1',
    [req.user.id]
  );
  res.json({ ui_preferences: rows[0]?.ui_preferences || {} });
}));

router.patch('/ui-preferences', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const keys = Object.keys(body);
  for (const k of keys) {
    if (!UI_PREF_ALLOWED_KEYS.has(k)) {
      throw new ValidationError({ body: `Unknown field: ${k}` }, `Unknown field: ${k}`);
    }
  }
  if (keys.length === 0) {
    throw new ValidationError({ _form: 'No fields to update.' }, 'No fields to update.');
  }

  if ('theme' in body && body.theme !== null && !UI_PREF_THEMES.has(body.theme)) {
    throw new ValidationError({ theme: "must be 'light' or 'dark'" });
  }
  if ('calendar_subscribed_app' in body && body.calendar_subscribed_app !== null) {
    if (typeof body.calendar_subscribed_app !== 'string' || body.calendar_subscribed_app.length > 100) {
      throw new ValidationError({ calendar_subscribed_app: 'must be a string up to 100 chars' });
    }
  }

  // Merge each key via chained jsonb_set so a partial PATCH does not clobber
  // sibling keys (theme, tip_card_order, calendar_subscribed_app share the
  // JSONB).
  let sqlExpr = "COALESCE(ui_preferences, '{}'::jsonb)";
  const params = [req.user.id];
  for (const k of keys) {
    params.push(JSON.stringify(body[k]));
    sqlExpr = `jsonb_set(${sqlExpr}, '{${k}}', $${params.length}::jsonb, true)`;
  }
  const { rows } = await pool.query(
    `UPDATE users SET ui_preferences = ${sqlExpr}, updated_at = NOW()
      WHERE id = $1 RETURNING ui_preferences`,
    params
  );
  res.json({ ui_preferences: rows[0].ui_preferences });
}));

// ─── Task 15: staff-notifications + push-subscriptions (delegated) ────────
// Spec §6.13 (Notifications), §6.17 (Push). Implementation moved verbatim to
// ./staffPortal/notifications.js on 2026-08-20 to bring this router back under
// the file-size ratchet (it was 997 of a 1000 hard cap, wc-style, which is how
// scripts/check-file-size.js counts). Same routes, same
// order, same router — only the file they live in changed.
notifications.register(router);

// ─── Task 16: Documents replace endpoint ───────────────────────────────────
//
// Spec §6.14. POST /api/me/documents/:doc_type/replace
// Multipart. Execution order is load-bearing:
//   1. Validate doc_type, expires_on (alcohol cert only).
//   2. Magic-byte file validation + size cap (express-fileupload abort handles
//      file-size limit; if abortOnLimit fired, req.files is empty, the route
//      sees no file and returns 413 indirectly via the missing-file 400 path —
//      we surface the size limit explicitly via a 413 helper here for clarity).
//   3. Slugify filename to a safe R2 key.
//   4. Upload to R2 first (orphan acceptable on tx failure; admin tooling sweeps).
//   5. Transaction: history INSERT + active record UPDATE.

const DOC_TYPES = new Set(['w9', 'alcohol_certification']);
const MAX_DOC_BYTES = 10 * 1024 * 1024;

// Slugify the original filename so the R2 key has no slashes, control chars,
// or path traversal sequences. Keeps a-z A-Z 0-9 . _ - only; everything else
// becomes `_`. Strips leading `.` so a `.htaccess`-style upload can't masquerade.
function slugifyFilename(name) {
  if (!name || typeof name !== 'string') return 'upload';
  const trimmed = name.trim().replace(/^\.+/, '');
  const cleaned = trimmed.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return cleaned || 'upload';
}

function isValidIsoDateFuture(s) {
  if (!s || typeof s !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return d.getTime() > today.getTime();
}

router.post('/documents/:doc_type/replace', asyncHandler(async (req, res) => {
  const docType = req.params.doc_type;
  if (!DOC_TYPES.has(docType)) {
    throw new ValidationError({ doc_type: `Unknown document type: ${docType}` });
  }

  // For alcohol_certification, expires_on is required and must be a future date.
  let expiresOn = null;
  if (docType === 'alcohol_certification') {
    expiresOn = req.body?.expires_on;
    if (!isValidIsoDateFuture(expiresOn)) {
      throw new ValidationError(
        { expires_on: 'Expiry date must be a YYYY-MM-DD in the future.' },
        'Expiry date must be in the future.'
      );
    }
  }

  const file = req.files?.file;
  if (!file) {
    throw new ValidationError({ file: 'File upload required.' }, 'File upload required.');
  }
  // express-fileupload's abortOnLimit returns a 413 with text/html before we
  // see the request, so this size check is the in-handler safety net for any
  // path that gets past the middleware (e.g. test harness with a different
  // limit).
  if (file.size > MAX_DOC_BYTES) {
    throw new PayloadTooLargeError('File too large (max 10 MB).', 'FILE_TOO_LARGE');
  }
  if (!isValidUpload(file)) {
    throw new ValidationError(
      { file: 'Only PDF, PNG, or JPEG allowed.' },
      'Only PDF, PNG, or JPEG allowed.'
    );
  }

  const slug = slugifyFilename(file.name);
  const r2Key = `staff/${docType}/${req.user.id}/${Date.now()}_${slug}`;

  // R2 upload BEFORE the transaction. If R2 is down, return 502 and nothing
  // in the DB changes. Orphan upload on a later transaction failure is the
  // documented trade (spec §6.14, cleanup sweep is §13 follow-up).
  try {
    await _deps.uploadFile(file.data, r2Key);
  } catch (err) {
    // ExternalServiceError surfaces 502 via the global error handler. Anything
    // else also rethrows; the AppError middleware decides the response shape.
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (docType === 'w9') {
      // Active record lives on payment_profiles. Lock it FOR UPDATE.
      await client.query(
        'INSERT INTO payment_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
        [req.user.id]
      );
      const cur = await client.query(
        'SELECT w9_file_url, w9_filename FROM payment_profiles WHERE user_id = $1 FOR UPDATE',
        [req.user.id]
      );
      await client.query(
        `INSERT INTO staff_document_history
           (user_id, doc_type, previous_url, previous_filename, replaced_by_user_id)
         VALUES ($1, 'w9', $2, $3, $4)`,
        [req.user.id, cur.rows[0]?.w9_file_url || null, cur.rows[0]?.w9_filename || null, req.user.id]
      );
      await client.query(
        `UPDATE payment_profiles
            SET w9_file_url = $2, w9_filename = $3, updated_at = NOW()
          WHERE user_id = $1`,
        [req.user.id, r2Key, slug]
      );
    } else {
      // alcohol_certification → contractor_profiles.
      await client.query(
        'INSERT INTO contractor_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
        [req.user.id]
      );
      const cur = await client.query(
        `SELECT alcohol_certification_file_url, alcohol_certification_filename
           FROM contractor_profiles WHERE user_id = $1 FOR UPDATE`,
        [req.user.id]
      );
      await client.query(
        `INSERT INTO staff_document_history
           (user_id, doc_type, previous_url, previous_filename, replaced_by_user_id)
         VALUES ($1, 'alcohol_certification', $2, $3, $4)`,
        [
          req.user.id,
          cur.rows[0]?.alcohol_certification_file_url || null,
          cur.rows[0]?.alcohol_certification_filename || null,
          req.user.id,
        ]
      );
      await client.query(
        `UPDATE contractor_profiles
            SET alcohol_certification_file_url = $2,
                alcohol_certification_filename = $3,
                alcohol_certification_expires_on = $4,
                updated_at = NOW()
          WHERE user_id = $1`,
        [req.user.id, r2Key, slug, expiresOn]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* gone */ }
    throw err;
  } finally {
    client.release();
  }

  return res.json({
    ok: true,
    file_url: r2Key,
    filename: slug,
    ...(expiresOn ? { expires_on: expiresOn } : {}),
  });
}));

// ─── Task 17: Email-change request + cancel ────────────────────────────────
// Spec §6.10.

// RFC-5322-light: same shape used in clientAuth + auth flows.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/request-email-change', emailChangeRequestLimiter, asyncHandler(async (req, res) => {
  const newEmail = typeof req.body?.new_email === 'string'
    ? req.body.new_email.trim().toLowerCase()
    : '';
  if (!newEmail || !EMAIL_RE.test(newEmail) || newEmail.length > 254) {
    throw new ValidationError({ new_email: 'Please enter a valid email address.' });
  }

  // Pull the requester's current email for the same-as-current and warn-to-old
  // checks below. req.user already has email per auth.js.
  const currentEmail = (req.user.email || '').toLowerCase();
  if (newEmail === currentEmail) {
    throw new ValidationError(
      { new_email: 'This is already your current email address.' },
      'This is already your current email address.'
    );
  }

  // Reject if another user already owns this email. Lowercased compare.
  const existsRes = await pool.query(
    'SELECT id FROM users WHERE LOWER(email) = $1',
    [newEmail]
  );
  if (existsRes.rows.length > 0) {
    throw new ConflictError('That email is already in use.', 'EMAIL_IN_USE');
  }

  // Supersede the requester's own prior pending row(s) so the partial UNIQUE
  // index on LOWER(new_email) WHERE consumed_at IS NULL has room to accept
  // the new INSERT — and the most-recent request wins.
  await pool.query(
    `UPDATE pending_email_changes SET consumed_at = NOW()
      WHERE user_id = $1 AND consumed_at IS NULL`,
    [req.user.id]
  );

  // Generate the raw token; store only its sha256 hash.
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  // Race-safe insert. The partial unique index on LOWER(new_email) WHERE
  // consumed_at IS NULL enforces "at most one pending change per email"
  // across users. If a different user already holds a pending change to this
  // email, the INSERT no-ops (returns 0 rows) and we surface 409
  // already_pending. Per the partial-index ON CONFLICT semantics, the target
  // is the indexed expression.
  const insertRes = await pool.query(
    `INSERT INTO pending_email_changes (user_id, new_email, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')
     ON CONFLICT (LOWER(new_email)) WHERE consumed_at IS NULL DO NOTHING
     RETURNING id`,
    [req.user.id, newEmail, tokenHash]
  );

  if (insertRes.rowCount === 0) {
    // Either someone else holds a pending change to this email (partial
    // unique on new_email) or a token-hash collision (astronomically rare).
    // Use the helpful "already pending" reason — race-safe per spec §6.10.
    return res.status(409).json({ error: 'A pending change to that email already exists.', code: 'ALREADY_PENDING', reason: 'already_pending' });
  }

  // Outbound emails. Failures here do not roll back the pending row — the
  // user can re-request via Cancel + retry.
  const verifyUrl = `${STAFF_URL}/verify-email/${rawToken}`;
  const newEmailContent = emailChangeVerification({ verifyUrl, newEmail });
  const warnContent = emailChangeWarning({ newEmail });

  try {
    await _deps.sendEmail({ to: newEmail, ...newEmailContent });
  } catch (err) {
    try {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(err, {
          tags: { route: 'staffPortal.request-email-change', op: 'send_verify' },
          extra: { user_id: req.user.id },
        });
      }
    } catch (_) { /* swallow */ }
  }
  if (currentEmail) {
    try {
      await _deps.sendEmail({ to: currentEmail, ...warnContent });
    } catch (err) {
      try {
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(err, {
            tags: { route: 'staffPortal.request-email-change', op: 'send_warn' },
            extra: { user_id: req.user.id },
          });
        }
      } catch (_) { /* swallow */ }
    }
  }

  // Audit-log row. Failure non-fatal.
  try {
    await pool.query(
      `INSERT INTO staff_audit_log (user_id, actor_type, actor_id, action, details)
       VALUES ($1, 'staff', $1, 'email_change_requested', $2)`,
      [req.user.id, JSON.stringify({ new_email: newEmail })]
    );
  } catch (err) {
    try {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(err, {
          tags: { route: 'staffPortal.request-email-change', op: 'audit_insert' },
          extra: { user_id: req.user.id },
        });
      }
    } catch (_) { /* swallow */ }
  }

  res.json({ ok: true, pending: true });
}));

router.post('/cancel-pending-email-change', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `UPDATE pending_email_changes SET consumed_at = NOW()
      WHERE user_id = $1 AND consumed_at IS NULL`,
    [req.user.id]
  );
  res.json({ ok: true, cancelled: result.rowCount });
}));

module.exports = router;
module.exports.__setDeps = __setDeps;

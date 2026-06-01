// Staffer-facing account READ endpoints for the staff portal AccountPage
// (spec §6.10 Profile, §6.12 Calendar sync, §6.14 Documents).
//
// Mounted at /api/me by the parent router. `auth` is already applied upstream
// (server/routes/staffPortal.js calls router.use(auth) before register).
//
// All three endpoints are hard-scoped to req.user.id — there is NO `:userId`
// path param, ever. That IS the IDOR guard, by construction. Sibling pattern
// to server/routes/staffPortal/payouts.js (the existing Pay-tab READ file).
//
//   - SELECTs are parameterized and pinned to ... = $1 = req.user.id
//   - Each query LEFT JOINs the optional rows (contractor_profiles,
//     payment_profiles, agreements) so a new hire with no child rows yet gets
//     null/`present: false` rather than a 500.
//   - For /profile we return the staffer's OWN PII (phone/address/emergency
//     contact). That's fine — they entered it; they need it back to edit it.
//   - For /documents we return ONLY presence + filename + (cert) expiry — never
//     the raw R2 storage key/URL. A real download path would go through the
//     existing signed-URL/auth-gated file pattern, not this read.

const { pool } = require('../../db');
const asyncHandler = require('../../middleware/asyncHandler');

// Mirrors the apiBase composition in server/routes/calendar.js (token + token/
// regenerate). Keep them in sync so the URL we hand the AccountPage matches
// what calendar.js serves. Server-side composition is convenient for the
// client (one source of truth) and harmless because the token is the secret —
// the URL is not.
function feedUrlForToken(token) {
  const apiBase =
    process.env.RENDER_EXTERNAL_URL ||
    process.env.API_URL ||
    `http://localhost:${process.env.PORT || 5000}`;
  return `${apiBase}/api/calendar/feed/${token}`;
}

function register(router) {
  // ─── GET /api/me/profile ─────────────────────────────────────────────────
  // Hydrate the AccountPage Profile form + the pending-email banner.
  //
  // Sources:
  //   - email                                          → users.email
  //   - preferred_name, phone, street_address, city,
  //     state, zip_code, emergency_contact_*           → contractor_profiles
  //   - legal_name (READ-ONLY in the UI)               → agreements.full_name
  //                                                      (signed legal doc),
  //                                                      else applications.full_name,
  //                                                      else null
  //   - pending_email_change                           → pending_email_changes
  //                                                      WHERE user_id = $1
  //                                                      AND consumed_at IS NULL
  //                                                      AND expires_at > NOW(),
  //                                                      most recent
  //
  // New-hire handling: a fresh user may have NO contractor_profiles row, NO
  // agreement, NO application — all the LEFT JOINs collapse to nulls and we
  // return them as nulls. Never 500.
  router.get('/profile', asyncHandler(async (req, res) => {
    const profileRes = await pool.query(
      `SELECT
         u.email,
         cp.preferred_name,
         cp.phone,
         cp.street_address,
         cp.city,
         cp.state,
         cp.zip_code,
         cp.emergency_contact_name,
         cp.emergency_contact_phone,
         cp.emergency_contact_relationship,
         -- Prefer the signed agreement's full_name (legal doc); fall back to
         -- the application's full_name; null if the staffer is brand-new and
         -- has neither.
         COALESCE(ag.full_name, ap.full_name) AS legal_name
       FROM users u
       LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
       LEFT JOIN agreements           ag ON ag.user_id = u.id
       LEFT JOIN applications         ap ON ap.user_id = u.id
       WHERE u.id = $1`,
      [req.user.id]
    );
    const row = profileRes.rows[0] || {};

    // Most recent non-consumed, non-expired pending change. The partial unique
    // index `idx_pending_email_changes_new_email_pending` enforces at-most-one
    // pending row per new_email globally, but the same user could in theory
    // have rows for two different new_emails if the supersede UPDATE in
    // request-email-change failed mid-flight. ORDER BY created_at DESC LIMIT 1
    // gives us the canonical "most recent" without depending on that.
    const pendingRes = await pool.query(
      `SELECT new_email, expires_at
         FROM pending_email_changes
        WHERE user_id = $1
          AND consumed_at IS NULL
          AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1`,
      [req.user.id]
    );
    const pending = pendingRes.rows[0]
      ? {
          new_email: pendingRes.rows[0].new_email,
          expires_at: pendingRes.rows[0].expires_at,
        }
      : null;

    res.json({
      preferred_name: row.preferred_name || null,
      email: row.email || null,
      legal_name: row.legal_name || null,
      phone: row.phone || null,
      street_address: row.street_address || null,
      city: row.city || null,
      state: row.state || null,
      zip_code: row.zip_code || null,
      emergency_contact_name: row.emergency_contact_name || null,
      emergency_contact_phone: row.emergency_contact_phone || null,
      emergency_contact_relationship: row.emergency_contact_relationship || null,
      pending_email_change: pending,
    });
  }));

  // ─── GET /api/me/calendar-settings ───────────────────────────────────────
  // Hydrate the AccountPage Calendar-sync section.
  //
  // Sources (all on users):
  //   - calendar_token             → users.calendar_token (UUID; secret)
  //   - calendar_token_created_at  → users.calendar_token_created_at
  //   - last_ics_fetch_at          → users.last_ics_fetch_at (nullable —
  //                                  populated lazily by calendar.js when a
  //                                  subscribed app pulls the feed)
  //   - calendar_subscribed_app    → users.ui_preferences ->> 'calendar_subscribed_app'
  //                                  (JSONB key, nullable)
  //   - feed_url                   → composed server-side via the same
  //                                  apiBase pattern calendar.js uses, so the
  //                                  AccountPage doesn't have to second-guess
  //                                  which env var to read. Keeps client +
  //                                  server agreement on the feed URL.
  //
  // Returning the token to its OWNER is correct — they need it for the
  // subscribe URL. Same posture as POST /api/calendar/token/regenerate.
  router.get('/calendar-settings', asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT calendar_token,
              calendar_token_created_at,
              last_ics_fetch_at,
              ui_preferences ->> 'calendar_subscribed_app' AS calendar_subscribed_app
         FROM users
        WHERE id = $1`,
      [req.user.id]
    );
    const row = rows[0] || {};
    const token = row.calendar_token || null;
    res.json({
      calendar_token: token,
      calendar_token_created_at: row.calendar_token_created_at || null,
      last_ics_fetch_at: row.last_ics_fetch_at || null,
      calendar_subscribed_app: row.calendar_subscribed_app || null,
      feed_url: token ? feedUrlForToken(token) : null,
    });
  }));

  // ─── GET /api/me/documents ───────────────────────────────────────────────
  // Hydrate the AccountPage Documents section.
  //
  // Sources:
  //   - w9                       → payment_profiles.w9_file_url (present),
  //                                payment_profiles.w9_filename
  //   - agreement                → agreements.pdf_storage_key (present)
  //   - alcohol_certification    → contractor_profiles.alcohol_certification_file_url,
  //                                _filename, _expires_on
  //
  // DELIBERATELY NOT projected: w9_file_url, alcohol_certification_file_url,
  // agreements.pdf_storage_key. Those are R2 keys; returning them lets the
  // client bypass auth on the asset. Presence + filename + (cert) expiry is
  // all the Documents UI needs; a future download flow would go through the
  // existing signed-URL/auth-gated file pattern, not this read.
  //
  // New-hire handling: LEFT JOIN both child tables. Every `present` collapses
  // to false, every filename/expires_on to null. Never 500.
  router.get('/documents', asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT
         pp.w9_file_url,
         pp.w9_filename,
         ag.pdf_storage_key,
         cp.alcohol_certification_file_url,
         cp.alcohol_certification_filename,
         cp.alcohol_certification_expires_on
       FROM users u
       LEFT JOIN payment_profiles     pp ON pp.user_id = u.id
       LEFT JOIN agreements           ag ON ag.user_id = u.id
       LEFT JOIN contractor_profiles  cp ON cp.user_id = u.id
       WHERE u.id = $1`,
      [req.user.id]
    );
    const row = rows[0] || {};
    res.json({
      w9: {
        present: !!row.w9_file_url,
        filename: row.w9_filename || null,
      },
      agreement: {
        present: !!row.pdf_storage_key,
      },
      alcohol_certification: {
        present: !!row.alcohol_certification_file_url,
        filename: row.alcohol_certification_filename || null,
        expires_on: row.alcohol_certification_expires_on || null,
      },
    });
  }));
}

module.exports = { register };

const express = require('express');
const path = require('path');
const { pool } = require('../db');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const { publicReadLimiter, drinkPlanWriteLimiter, logoUploadLimiter, adminWriteLimiter } = require('../middleware/rateLimiters');
const { requireUuidToken } = require('../utils/tokens');

const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError, PermissionError, ExternalServiceError } = require('../utils/errors');
const { API_URL } = require('../utils/urls');
const { ensureNotFinalized, registerFinalizeRoute, registerUnfinalizeRoute } = require('../utils/beoFinalize');
const { isDrinkPlanPreBooking } = require('../utils/drinkPlanAccess');
const { uploadFile, getSignedUrl } = require('../utils/storage');
const { isValidImageUpload } = require('../utils/fileValidation');
const { handleSubmit } = require('./drinkPlans/submit');
const { buildHostedCoveragePayload } = require('./drinkPlans/coverageContext');
const { registerPublicShoppingListRoute, registerAdminShoppingListRoutes } = require('./drinkPlans/shoppingList');

const router = express.Router();

// ─── Public routes (token-based) ─────────────────────────────────

// GET /t/:token/shopping-list — extracted to ./drinkPlans/shoppingList.js.
// Registered here (before the other /t/:token handlers) to preserve its
// original early position in the router's matching order.
registerPublicShoppingListRoute(router);

/** POST /api/drink-plans/t/:token/lab-cta — celebration-screen Enhancement
 *  Lab CTA click marker (attach-rate funnel; first click wins). Public,
 *  token-gated, write-once, no body. */
router.post('/t/:token/lab-cta', requireUuidToken('token', 'This drink plan is no longer available'), publicReadLimiter, asyncHandler(async (req, res) => {
  await pool.query(
    'UPDATE drink_plans SET lab_cta_clicked_at = COALESCE(lab_cta_clicked_at, NOW()) WHERE token = $1',
    [req.params.token]
  );
  res.json({ success: true });
}));

/** GET /api/drink-plans/t/:token — fetch plan by token (public) */
router.get('/t/:token', requireUuidToken('token', 'This drink plan is no longer available'), publicReadLimiter, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT dp.id, dp.token, dp.client_name, dp.client_email, dp.event_type, dp.event_type_custom, dp.event_date,
            dp.status, dp.serving_type, dp.selections, dp.submitted_at, dp.created_at,
            dp.proposal_id, dp.exploration_submitted_at, dp.planner_version,
            p.guest_count, p.num_bartenders, p.num_bars, p.pricing_snapshot,
            p.status AS proposal_status,
            p.token AS proposal_token,
            p.total_price AS proposal_total_price,
            p.amount_paid AS proposal_amount_paid,
            p.event_date AS proposal_event_date,
            p.balance_due_date AS proposal_balance_due_date,
            sp.id                  AS package_id,
            sp.bar_type            AS package_bar_type,
            sp.category            AS package_category,
            sp.slug                AS package_slug,
            sp.name                AS package_name,
            sp.includes            AS package_includes,
            sp.covered_addon_slugs AS package_covered_addon_slugs,
            sp.slot_count          AS package_slot_count,
            sp.slot_kind           AS package_slot_kind
     FROM drink_plans dp
     LEFT JOIN proposals p ON p.id = dp.proposal_id
     LEFT JOIN service_packages sp ON sp.id = p.package_id
     WHERE dp.token = $1`,
    [req.params.token]
  );
  if (!result.rows[0]) throw new NotFoundError('This drink plan link is no longer valid');
  const plan = result.rows[0];
  // The drink plan only opens after the client books (deposit paid).
  // Outstanding proposal-sent emails may still carry a /plan/:token link for a
  // pre-deposit proposal — never drop an unbooked client into the wizard (it
  // can run a Stripe charge in ConfirmationStep). Return a locked payload.
  if (isDrinkPlanPreBooking(plan.proposal_status)) {
    return res.json({ locked: true, proposalToken: plan.proposal_token });
  }
  // Planner v2 hosted payload: per-drink coverage for the two-tier picker.
  // has_contents:false = the package's contents aren't entered yet, so the v2
  // client falls back to the legacy hosted flow (content-readiness switch).
  if (plan.planner_version >= 2 && plan.package_category === 'hosted') {
    plan.hosted_coverage = await buildHostedCoveragePayload(pool, plan.package_id);
  }
  res.json(plan);
}));

/** PUT /api/drink-plans/t/:token - save draft or submit (public).
 *  Handler extracted to ./drinkPlans/submit.js (file-size cap); the
 *  requireUuidToken guard + drinkPlanWriteLimiter stay here on the mount. */
router.put('/t/:token',
  requireUuidToken('token', 'This drink plan is no longer available'),
  drinkPlanWriteLimiter,
  asyncHandler(handleSubmit));

/** POST /api/drink-plans/t/:token/logo
 * Public token-gated logo upload. Accepts multipart with field 'logo'.
 * Validates magic bytes + size + extension. Uploads to R2 under
 * drink-plan-logos/<plan-id>-<timestamp>.<ext>. Atomically merges the
 * URL + filename into selections.companyLogo via Postgres jsonb || operator.
 * Returns { logoUrl, selections }.
 */
router.post('/t/:token/logo', requireUuidToken('token', 'This drink plan is no longer available'), logoUploadLimiter, asyncHandler(async (req, res) => {
  const planResult = await pool.query(
    'SELECT id, status, finalized_at FROM drink_plans WHERE token = $1',
    [req.params.token]
  );
  if (!planResult.rows[0]) throw new NotFoundError('Plan not found.');
  const plan = planResult.rows[0];
  if (plan.finalized_at) throw new ConflictError('This plan has been finalized; reach out if you need a change.');

  // Pre-deposit plans render as locked in the planner UI; reject uploads.
  if (plan.status === 'pending') throw new PermissionError('Plan is locked until deposit is paid.');

  const file = req.files?.logo;
  if (!file) throw new ValidationError({ logo: 'No logo file uploaded. Use the field name "logo".' });
  if (file.size > 5 * 1024 * 1024) {
    throw new ValidationError({ logo: 'Logo must be 5 MB or smaller.' });
  }
  if (!isValidImageUpload(file)) {
    throw new ValidationError({ logo: 'Invalid file type. Use PNG or JPG only.' });
  }

  const ext = (path.extname(file.name) || '.png').toLowerCase();
  const safeExt = ['.png', '.jpg', '.jpeg'].includes(ext) ? ext : '.png';
  // Coerce plan.id to a number defensively — the DB returns an integer today,
  // but if the column ever migrates to UUID/text, a tainted value would let
  // an attacker traverse paths in R2 via `..`.
  const ts = Date.now();
  const filename = `drink-plan-logos/${Number(plan.id)}-${ts}${safeExt}`;
  await uploadFile(file.data, filename);
  // Absolute URL so the admin SPA at admin.drbartender.com (which has no
  // /api/* rewrite to Render) and the public planner at drbartender.com
  // (same — Vercel rewrites /(.*) → /index.html) both resolve the image.
  // ?v=<ts> cache-busts the 24h browser cache when a logo is replaced.
  const logoUrl = `${API_URL}/api/drink-plans/t/${req.params.token}/logo?v=${ts}`;

  // Atomic merge into the selections JSONB column using Postgres's || operator.
  // The merge happens in the database, not in the application, so a concurrent
  // auto-save PUT from the planner cannot lose the companyLogo / _logoFilename
  // fields via last-write-wins. The auto-save sees the merged result and
  // preserves it because it merges its own changes into whatever is current at
  // its write time. (If both writes target the same key in the JSON, the later
  // one still wins; but companyLogo is only written by these logo routes, so
  // there is no contention on that specific key.)
  const patch = { companyLogo: logoUrl, _logoFilename: filename };
  const updateResult = await pool.query(
    `UPDATE drink_plans
        SET selections = COALESCE(selections, '{}'::jsonb) || $1::jsonb,
            updated_at = NOW()
      WHERE id = $2
      RETURNING selections`,
    [JSON.stringify(patch), plan.id]
  );

  res.json({ logoUrl, selections: updateResult.rows[0].selections });
}));

/** GET /api/drink-plans/t/:token/logo
 * Public token-gated logo proxy. Returns the R2 object bytes with the
 * appropriate content-type so both the client preview (unauthenticated
 * token-gated context) and the admin event detail page (and html2canvas
 * during PNG export) can fetch the image from a same-origin URL.
 *
 * Note: this is intentionally a NEW file-serving pattern that differs from
 * the existing /api/files/:filename at server/index.js:149 (which is
 * auth-gated and returns a signed URL the client redirects to). Three
 * reasons:
 *   1. The planner client has no JWT (token-gated public access), so the
 *      existing auth-gated route is unreachable from MenuPreview.
 *   2. html2canvas during PNG export needs the image at a same-origin URL
 *      with no redirect dance, or the canvas gets tainted by CORS.
 *   3. Returning bytes directly with Cache-Control: public, max-age=86400
 *      gives us browser caching for free.
 */
router.get('/t/:token/logo', requireUuidToken('token', 'This drink plan is no longer available'), logoUploadLimiter, asyncHandler(async (req, res) => {
  // Project just the filename — the full selections JSONB is 50-200 KB and
  // this route is hit once per pageview on every cache miss.
  const planResult = await pool.query(
    `SELECT selections->>'_logoFilename' AS filename FROM drink_plans WHERE token = $1`,
    [req.params.token]
  );
  if (!planResult.rows[0]) throw new NotFoundError('Plan not found.');
  const filename = planResult.rows[0].filename;
  if (!filename) throw new NotFoundError('No logo uploaded for this plan.');
  // Defense in depth: even if _logoFilename leaks past the selections sanitizer
  // (e.g. a future code path adds it back), refuse any R2 key outside the
  // dedicated logo prefix so the proxy can't be pivoted into reading
  // agreements, headshots, W-9s, etc.
  if (!filename.startsWith('drink-plan-logos/')) {
    throw new NotFoundError('No logo uploaded for this plan.');
  }

  const url = await getSignedUrl(filename);
  // Bound the upstream fetch so a slow/hung R2 connection can't tie up an
  // Express worker indefinitely — slow-loris guard on a public endpoint.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  let upstream;
  try {
    upstream = await fetch(url, { signal: ac.signal });
  } catch (err) {
    throw new ExternalServiceError('r2', err, 'Logo is temporarily unavailable.');
  } finally {
    clearTimeout(timer);
  }
  if (!upstream.ok) {
    throw new ExternalServiceError(
      'r2',
      new Error(`Upstream returned ${upstream.status}`),
      'Logo is temporarily unavailable.'
    );
  }
  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.set('Content-Type', contentType);
  // private — each plan's logo is tenant-scoped; we don't want CDN/intermediary
  // caches serving one client's logo to another. Browser caches it for 1 hour;
  // ?v=<ts> on the URL invalidates that cache after a Replace.
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(buffer);
}));

// ─── Admin routes (auth required) ────────────────────────────────

/** GET /api/drink-plans — list all plans. Exclude selections/shopping_list JSONB blobs
 *  (each 100 KB+). Detail endpoint returns selections; shopping_list has its own route.
 *  Paginated via ?limit (default 200, max 500) + ?offset to keep the response
 *  bounded as the table grows. */
router.get('/', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { status, search } = req.query;
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  let query = `
    SELECT dp.id, dp.token, dp.proposal_id, dp.client_name, dp.client_email,
           dp.event_type, dp.event_type_custom, dp.event_date, dp.serving_type,
           dp.status, dp.finalized_at, dp.exploration_submitted_at, dp.submitted_at, dp.created_at,
           dp.updated_at, dp.created_by, dp.shopping_list_status, dp.selections,
           p.guest_count,
           u.email AS created_by_email
    FROM drink_plans dp
    LEFT JOIN proposals p ON p.id = dp.proposal_id
    LEFT JOIN users u ON u.id = dp.created_by
    WHERE 1=1
  `;
  const params = [];

  if (status) {
    params.push(status);
    query += ` AND dp.status = $${params.length}`;
  }
  if (search) {
    params.push(`%${search}%`);
    query += ` AND (dp.client_name ILIKE $${params.length} OR dp.client_email ILIKE $${params.length})`;
  }

  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;
  query += ` ORDER BY dp.created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`;

  const result = await pool.query(query, params);

  // Additive enrichment for the Potions plans drawer (spec §4): resolve each
  // plan's selected drink ids to display names in TWO batched queries across
  // the whole page (never per-row). `selections` itself is internal here —
  // extracted then dropped so the payload stays list-sized.
  const cocktailIds = new Set();
  const mocktailIds = new Set();
  for (const row of result.rows) {
    const sel = row.selections || {};
    for (const id of Array.isArray(sel.signatureDrinks) ? sel.signatureDrinks : []) cocktailIds.add(id);
    for (const id of Array.isArray(sel.mocktails) ? sel.mocktails : []) mocktailIds.add(id);
  }
  const nameMap = new Map();
  if (cocktailIds.size > 0) {
    const r = await pool.query('SELECT id, name FROM cocktails WHERE id = ANY($1::text[])', [[...cocktailIds]]);
    for (const row of r.rows) nameMap.set(`c:${row.id}`, row.name);
  }
  if (mocktailIds.size > 0) {
    const r = await pool.query('SELECT id, name FROM mocktails WHERE id = ANY($1::text[])', [[...mocktailIds]]);
    for (const row of r.rows) nameMap.set(`m:${row.id}`, row.name);
  }
  const rows = result.rows.map((row) => {
    const sel = row.selections || {};
    const drinkNames = [
      ...(Array.isArray(sel.signatureDrinks) ? sel.signatureDrinks : []).map((id) => nameMap.get(`c:${id}`)),
      ...(Array.isArray(sel.mocktails) ? sel.mocktails : []).map((id) => nameMap.get(`m:${id}`)),
      ...(Array.isArray(sel.customCocktails) ? sel.customCocktails : []).map((s) => String(s || '').trim()).filter(Boolean),
    ].filter(Boolean);
    const { selections, ...rest } = row;
    return { ...rest, drink_names: drinkNames };
  });
  res.json(rows);
}));

/** POST /api/drink-plans — create a new plan */
router.post('/', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { client_name, client_email, event_type, event_type_custom, event_date } = req.body;
  if (!client_name || !client_name.trim()) {
    throw new ValidationError({ client_name: 'Client name is required.' });
  }
  const result = await pool.query(`
    INSERT INTO drink_plans (client_name, client_email, event_type, event_type_custom, event_date, created_by)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
  `, [
    client_name,
    client_email || null,
    event_type || null,
    event_type_custom || null,
    event_date || null,
    req.user.id
  ]);
  res.status(201).json(result.rows[0]);
}));

/** POST /api/drink-plans/for-proposal/:proposalId — create a drink plan for a proposal (admin) */
router.post('/for-proposal/:proposalId', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { createDrinkPlan } = require('../utils/eventCreation');
  // Fetch proposal data
  const pRes = await pool.query(
    `SELECT p.*, c.name AS client_name, c.email AS client_email
     FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
     WHERE p.id = $1`, [req.params.proposalId]
  );
  if (!pRes.rows[0]) throw new NotFoundError('Proposal not found.');
  const proposal = pRes.rows[0];

  const drinkPlan = await createDrinkPlan(proposal.id, {
    client_name: proposal.client_name,
    client_email: proposal.client_email,
    event_type: proposal.event_type,
    event_type_custom: proposal.event_type_custom,
    event_date: proposal.event_date,
    created_by: req.user.id,
  }, { skipEmail: true });

  if (drinkPlan) {
    return res.status(201).json(drinkPlan);
  }

  // Already exists — return the existing one
  const existing = await pool.query(
    'SELECT * FROM drink_plans WHERE proposal_id = $1 LIMIT 1',
    [req.params.proposalId]
  );
  if (!existing.rows[0]) throw new NotFoundError('Plan not found.');
  // Keep the (potentially large) approved-snapshot blob off the wire; this
  // response predates the column and no consumer reads it here (T0
  // database-review carry-forward).
  const { shopping_list_approved_snapshot, ...planRow } = existing.rows[0];
  res.json(planRow);
}));

/** GET /api/drink-plans/by-proposal/:proposalId — fetch plan by proposal id.
 *  Mirrors the GET /:id projection (consult + shopping-list status flags, kept
 *  as IS NOT NULL booleans so the JSONB blobs stay off the wire) so the
 *  event-page DrinkPlanCard can drive consult + shopping-list controls without
 *  a second round-trip. selections is kept (needed for detail); shopping_list
 *  itself has its own endpoint. */
router.get('/by-proposal/:proposalId', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT dp.id, dp.token, dp.proposal_id, dp.client_name, dp.client_email,
            dp.event_type, dp.event_type_custom, dp.event_date, dp.serving_type,
            dp.selections, dp.status, dp.finalized_at, dp.finalized_by, dp.admin_notes, dp.exploration_submitted_at,
            dp.submitted_at, dp.created_at, dp.updated_at, dp.created_by,
            u.email AS created_by_email,
            dp.consult_selections IS NOT NULL AS has_consult_selections,
            dp.consult_filled_at, dp.consult_filled_by_user_id,
            cu.email AS consult_filled_by_email,
            dp.shopping_list_source,
            dp.shopping_list IS NOT NULL AS has_shopping_list,
            dp.shopping_list_status, dp.shopping_list_approved_at,
            p.guest_count,
            COALESCE((
              SELECT i.amount_due - i.amount_paid FROM invoices i
               WHERE i.proposal_id = dp.proposal_id AND i.label = 'Drink Plan Extras'
                 AND i.status IN ('sent', 'partially_paid')
               ORDER BY i.id DESC LIMIT 1
            ), 0) AS extras_unpaid_cents
     FROM drink_plans dp
     LEFT JOIN users u ON u.id = dp.created_by
     LEFT JOIN users cu ON cu.id = dp.consult_filled_by_user_id
     LEFT JOIN proposals p ON p.id = dp.proposal_id
     WHERE dp.proposal_id = $1`,
    [req.params.proposalId]
  );
  if (!result.rows[0]) throw new NotFoundError('No drink plan found for this proposal.');
  res.json(result.rows[0]);
}));

/** GET /api/drink-plans/:id — fetch single plan by id. Exclude shopping_list
 *  (has its own endpoint); keep selections for detail rendering. Booleans
 *  (`has_consult_selections`, `has_shopping_list`) keep the JSONB blobs off
 *  the wire — the consult payload itself is only fetched on demand from
 *  GET /:id/consult when the form is opened. */
router.get('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT dp.id, dp.token, dp.proposal_id, dp.client_name, dp.client_email,
            dp.event_type, dp.event_type_custom, dp.event_date, dp.serving_type,
            dp.selections, dp.status, dp.finalized_at, dp.finalized_by, dp.admin_notes, dp.exploration_submitted_at,
            dp.submitted_at, dp.created_at, dp.updated_at, dp.created_by,
            u.email AS created_by_email,
            dp.consult_selections IS NOT NULL AS has_consult_selections,
            dp.consult_filled_at, dp.consult_filled_by_user_id,
            cu.email AS consult_filled_by_email,
            dp.shopping_list_source,
            dp.shopping_list IS NOT NULL AS has_shopping_list,
            dp.shopping_list_status, dp.shopping_list_approved_at,
            p.guest_count, p.client_id
     FROM drink_plans dp
     LEFT JOIN users u ON u.id = dp.created_by
     LEFT JOIN users cu ON cu.id = dp.consult_filled_by_user_id
     LEFT JOIN proposals p ON p.id = dp.proposal_id
     WHERE dp.id = $1`,
    [req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Plan not found.');

  const plan = result.rows[0];

  // Resolve signature-drink and mocktail names so <MenuPreview> on the admin
  // event detail page can render without a second fetch. Missing IDs (deleted
  // rows in the source tables) are silently dropped, matching the graceful
  // degradation pattern used by shoppingListGen.js.
  const sigIds = Array.isArray(plan.selections?.signatureDrinks) ? plan.selections.signatureDrinks : [];
  const mocktailIds = Array.isArray(plan.selections?.mocktails) ? plan.selections.mocktails : [];

  let signatureDrinkNames = [];
  if (sigIds.length > 0) {
    const sigRows = await pool.query(
      `SELECT id, name FROM cocktails WHERE id = ANY($1::text[])`,
      [sigIds]
    );
    const nameById = new Map(sigRows.rows.map((r) => [r.id, r.name]));
    signatureDrinkNames = sigIds.map((id) => nameById.get(id)).filter(Boolean);
  }

  let mocktailNames = [];
  if (mocktailIds.length > 0) {
    const mocktailRows = await pool.query(
      `SELECT id, name FROM mocktails WHERE id = ANY($1::text[])`,
      [mocktailIds]
    );
    const nameById = new Map(mocktailRows.rows.map((r) => [r.id, r.name]));
    mocktailNames = mocktailIds.map((id) => nameById.get(id)).filter(Boolean);
  }

  res.json({ ...plan, signatureDrinkNames, mocktailNames });
}));

/** PATCH /api/drink-plans/:id/notes — update admin notes */
router.patch('/:id/notes', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  await ensureNotFinalized(parseInt(req.params.id, 10));
  const { admin_notes } = req.body;
  const result = await pool.query(
    'UPDATE drink_plans SET admin_notes = $1 WHERE id = $2 RETURNING id, admin_notes',
    [admin_notes || '', req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Plan not found.');
  res.json(result.rows[0]);
}));

/** PATCH /api/drink-plans/:id/status — update plan status */
router.patch('/:id/status', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  await ensureNotFinalized(parseInt(req.params.id, 10));
  const { status } = req.body;
  if (!['pending', 'draft', 'submitted', 'reviewed'].includes(status)) {
    throw new ValidationError({ status: 'Invalid status.' });
  }
  const result = await pool.query(
    'UPDATE drink_plans SET status = $1 WHERE id = $2 RETURNING *',
    [status, req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Plan not found.');
  // Snapshot blob stays off the wire (same as the by-proposal create path).
  const { shopping_list_approved_snapshot, ...statusRow } = result.rows[0];
  res.json(statusRow);
}));
registerFinalizeRoute(router); registerUnfinalizeRoute(router);
// GET /:id/shopping-list, PUT /:id/shopping-list, PATCH /:id/shopping-list/approve
// — extracted to ./drinkPlans/shoppingList.js. Registered here, immediately
// after the finalize routes and before POST /:id/logo, to preserve their
// original position in the router's matching order.
registerAdminShoppingListRoutes(router);

/** POST /api/drink-plans/:id/logo
 * Admin-authenticated logo upload by plan ID. Same validation + R2 upload +
 * atomic JSONB merge as the token-gated route.
 */
router.post('/:id/logo', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  await ensureNotFinalized(parseInt(req.params.id, 10));
  const planResult = await pool.query(
    'SELECT id, token FROM drink_plans WHERE id = $1',
    [req.params.id]
  );
  if (!planResult.rows[0]) throw new NotFoundError('Plan not found.');
  const plan = planResult.rows[0];

  const file = req.files?.logo;
  if (!file) throw new ValidationError({ logo: 'No logo file uploaded. Use the field name "logo".' });
  if (file.size > 5 * 1024 * 1024) {
    throw new ValidationError({ logo: 'Logo must be 5 MB or smaller.' });
  }
  if (!isValidImageUpload(file)) {
    throw new ValidationError({ logo: 'Invalid file type. Use PNG or JPG only.' });
  }

  const ext = (path.extname(file.name) || '.png').toLowerCase();
  const safeExt = ['.png', '.jpg', '.jpeg'].includes(ext) ? ext : '.png';
  const ts = Date.now();
  const filename = `drink-plan-logos/${Number(plan.id)}-${ts}${safeExt}`;
  await uploadFile(file.data, filename);
  const logoUrl = `${API_URL}/api/drink-plans/t/${plan.token}/logo?v=${ts}`;

  // Atomic merge in the database (same pattern as the token-gated route above).
  const patch = { companyLogo: logoUrl, _logoFilename: filename };
  const updateResult = await pool.query(
    `UPDATE drink_plans
        SET selections = COALESCE(selections, '{}'::jsonb) || $1::jsonb,
            updated_at = NOW()
      WHERE id = $2
      RETURNING selections`,
    [JSON.stringify(patch), plan.id]
  );

  res.json({ logoUrl, selections: updateResult.rows[0].selections });
}));

/** DELETE /api/drink-plans/:id/logo
 * Admin-authenticated. Clears selections.companyLogo. Does NOT delete the R2
 * file (storage cost is negligible; no cleanup job in v1).
 */
router.delete('/:id/logo', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  await ensureNotFinalized(parseInt(req.params.id, 10));
  // Verify plan exists; the DELETE itself is also a no-op-on-missing pattern,
  // but we want a 404 if the ID is wrong so the admin sees a clear error.
  const planResult = await pool.query(
    'SELECT id FROM drink_plans WHERE id = $1',
    [req.params.id]
  );
  if (!planResult.rows[0]) throw new NotFoundError('Plan not found.');

  // Atomic key removal via Postgres jsonb - operator. Strips both companyLogo
  // and _logoFilename in a single statement; concurrent auto-saves can't race.
  const updateResult = await pool.query(
    `UPDATE drink_plans
        SET selections = COALESCE(selections, '{}'::jsonb) - 'companyLogo' - '_logoFilename',
            updated_at = NOW()
      WHERE id = $1
      RETURNING selections`,
    [req.params.id]
  );

  res.json({ selections: updateResult.rows[0].selections });
}));

/** DELETE /api/drink-plans/:id — delete a plan */
router.delete('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  await ensureNotFinalized(parseInt(req.params.id, 10));
  const result = await pool.query('DELETE FROM drink_plans WHERE id = $1 RETURNING id', [req.params.id]);
  if (!result.rows[0]) throw new NotFoundError('Plan not found.');
  res.json({ success: true });
}));

/**
 * POST /api/drink-plans/:id/resend-nudge — DEPRECATED direct resend, kept
 * mounted for API compatibility. Delegates to the drink_plan_nudge comms action
 * (spec 4.4): the action resolves the LIVE client email + phone via the proposal
 * join, enforces the archived block (ensureSideEffects), honors the SMS opt-out
 * / bad-phone gate through channel availability, and OWNS its ledger writes
 * (sent + failed) so a provider throw can never leave a sent-but-unlogged
 * message. This is the admin "Resend planner link" button; unlike the scheduled
 * T-21 nudge it does NOT suppress on an already-filled plan (deliberate admin
 * override). Links use the DRINK-PLAN token, which is what /plan/:token
 * resolves. New UI goes through POST /api/comms/send instead.
 */
router.post('/:id/resend-nudge', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  const { getAction } = require('../utils/comms/registry');
  const action = getAction('drink_plan_nudge');
  const planId = parseInt(req.params.id, 10);

  const recipient = await action.resolveRecipient(planId);
  // Archived block first (matches the legacy ordering) — throws before any send;
  // no other bookkeeping.
  await action.ensureSideEffects(planId, { sentBy: req.user.id });

  const channels = [];
  if (recipient.channels.email.available) channels.push('email');
  if (recipient.channels.sms.available) channels.push('sms');
  if (channels.length === 0) {
    // No live email AND no sendable phone (missing, opted out, or bad status).
    throw new ValidationError({}, 'No client email or phone on file to resend to.');
  }

  const results = await action.dispatch(planId, undefined, channels, { sentBy: req.user.id });

  // Additive, backward-compatible response ({ ok: true } preserved).
  res.json({
    ok: true,
    email: results.email,
    sms: results.sms,
    email_error: results.email_error || null,
    sms_error: results.sms_error || null,
    recipient_email: results.recipient_email || null,
    recipient_phone: results.recipient_phone || null,
  });
}));

module.exports = router;

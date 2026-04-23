const express = require('express');
const { pool } = require('../db');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const { publicLimiter, publicReadLimiter } = require('../middleware/rateLimiters');
const { calculateProposal } = require('../utils/pricingEngine');
const { refreshUnlockedInvoices } = require('../utils/invoiceHelpers');
const { sendEmail } = require('../utils/email');
const emailTemplates = require('../utils/emailTemplates');
const { getEventTypeLabel } = require('../utils/eventTypes');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError } = require('../utils/errors');
const { ADMIN_URL } = require('../utils/urls');

const router = express.Router();

// ─── Public routes (token-based) ─────────────────────────────────

/** GET /api/drink-plans/t/:token/shopping-list — public shopping list for clients */
router.get('/t/:token/shopping-list', publicReadLimiter, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT dp.shopping_list, dp.client_name, dp.event_type, dp.event_type_custom, dp.event_date, dp.status
     FROM drink_plans dp WHERE dp.token = $1`,
    [req.params.token]
  );
  if (!result.rows[0]) throw new NotFoundError('This drink plan link is no longer valid');
  const plan = result.rows[0];
  if (!plan.shopping_list) {
    return res.json({
      ready: false,
      client_name: plan.client_name,
      event_type: plan.event_type,
      event_type_custom: plan.event_type_custom,
      event_date: plan.event_date,
    });
  }
  res.json({
    ready: true,
    shopping_list: plan.shopping_list,
    client_name: plan.client_name,
    event_type: plan.event_type,
    event_type_custom: plan.event_type_custom,
    event_date: plan.event_date,
  });
}));

/** GET /api/drink-plans/t/:token — fetch plan by token (public) */
router.get('/t/:token', publicReadLimiter, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT dp.id, dp.token, dp.client_name, dp.client_email, dp.event_type, dp.event_type_custom, dp.event_date,
            dp.status, dp.serving_type, dp.selections, dp.submitted_at, dp.created_at,
            dp.proposal_id, dp.exploration_submitted_at,
            p.guest_count, p.num_bartenders, p.num_bars, p.pricing_snapshot,
            p.status AS proposal_status,
            p.total_price AS proposal_total_price,
            p.amount_paid AS proposal_amount_paid,
            p.event_date AS proposal_event_date,
            p.balance_due_date AS proposal_balance_due_date,
            sp.bar_type AS package_bar_type
     FROM drink_plans dp
     LEFT JOIN proposals p ON p.id = dp.proposal_id
     LEFT JOIN service_packages sp ON sp.id = p.package_id
     WHERE dp.token = $1`,
    [req.params.token]
  );
  if (!result.rows[0]) throw new NotFoundError('This drink plan link is no longer valid');
  res.json(result.rows[0]);
}));

/** PUT /api/drink-plans/t/:token — save draft or submit (public) */
router.put('/t/:token', publicLimiter, asyncHandler(async (req, res) => {
  const { serving_type, selections, status, paid_separately } = req.body;
  const paidSeparately = paid_separately === true;

  // Check plan exists and is not already submitted
  const existing = await pool.query(
    'SELECT id, status, proposal_id, client_name, client_email, event_type, event_type_custom FROM drink_plans WHERE token = $1',
    [req.params.token]
  );
  if (!existing.rows[0]) throw new NotFoundError('This drink plan link is no longer valid');
  if (existing.rows[0].status === 'submitted' || existing.rows[0].status === 'reviewed') {
    throw new ConflictError('This plan has already been submitted.');
  }

  const newStatus = status === 'submitted' ? 'submitted'
                  : status === 'exploration_saved' ? 'exploration_saved'
                  : 'draft';

  // Compute timestamps in JS to avoid PostgreSQL "inconsistent types" error
  // when reusing the same parameter ($3) in both SET and CASE WHEN contexts
  const submittedNow = newStatus === 'submitted' ? new Date() : null;
  const explorationNow = newStatus === 'exploration_saved' ? new Date() : null;

  // Draft saves must not overwrite submitted/reviewed status (race condition protection)
  let result;
  if (newStatus === 'draft') {
    result = await pool.query(`
      UPDATE drink_plans SET
        serving_type = COALESCE($1, serving_type),
        selections = COALESCE($2::jsonb, selections),
        status = $3,
        submitted_at = COALESCE($4, submitted_at),
        exploration_submitted_at = COALESCE($5, exploration_submitted_at)
      WHERE token = $6 AND status NOT IN ('submitted', 'reviewed')
      RETURNING id, token, status, serving_type, submitted_at, proposal_id
    `, [serving_type || null, selections ? JSON.stringify(selections) : null, newStatus, submittedNow, explorationNow, req.params.token]);
  } else {
    result = await pool.query(`
      UPDATE drink_plans SET
        serving_type = COALESCE($1, serving_type),
        selections = COALESCE($2::jsonb, selections),
        status = $3,
        submitted_at = COALESCE($4, submitted_at),
        exploration_submitted_at = COALESCE($5, exploration_submitted_at)
      WHERE token = $6
      RETURNING id, token, status, serving_type, submitted_at, proposal_id
    `, [serving_type || null, selections ? JSON.stringify(selections) : null, newStatus, submittedNow, explorationNow, req.params.token]);
  }

  // Draft save silently skipped if plan was already submitted
  if (!result.rows[0] && newStatus === 'draft') {
    return res.json({ status: 'submitted', skipped: true });
  }

  const updatedPlan = result.rows[0];

  // Process addons and bar rental into proposal on submit
  if (newStatus === 'submitted' && updatedPlan.proposal_id) {
    const addonSlugs = Object.keys(selections?.addOns || {}).filter(slug => selections.addOns[slug]?.enabled);
    const addBarRental = selections?.logistics?.addBarRental === true;
    if (addonSlugs.length > 0 || addBarRental) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Lock the proposal row
        const proposalRes = await client.query(
          'SELECT * FROM proposals WHERE id = $1 FOR UPDATE',
          [updatedPlan.proposal_id]
        );
        const proposal = proposalRes.rows[0];

        if (proposal) {
          // Update num_bars if client added a bar rental from the drink plan
          if (addBarRental) {
            const newNumBars = (proposal.num_bars || 0) + 1;
            await client.query(
              'UPDATE proposals SET num_bars = $1 WHERE id = $2',
              [newNumBars, proposal.id]
            );
            proposal.num_bars = newNumBars;
          }

          // Resolve addon slugs to service_addon rows
          const addonRes = await client.query(
            'SELECT * FROM service_addons WHERE slug = ANY($1) AND is_active = true',
            [addonSlugs]
          );
          const resolvedAddons = addonRes.rows;

          // UPSERT each resolved addon into proposal_addons
          for (const addon of resolvedAddons) {
            const rate = Number(addon.rate);
            let quantity = 1;
            let lineTotal = rate;

            if (addon.billing_type === 'per_guest') {
              quantity = proposal.guest_count || 1;
              lineTotal = rate * quantity;
            }

            // TODO: when variant-capable add-ons become available in drink-plan resolution,
            // pull `variant` from the resolution payload and include it in this INSERT.
            await client.query(`
              INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total)
              VALUES ($1, $2, $3, $4, $5, $6, $7)
              ON CONFLICT (proposal_id, addon_id) DO UPDATE SET
                quantity = EXCLUDED.quantity,
                line_total = EXCLUDED.line_total
            `, [proposal.id, addon.id, addon.name, addon.billing_type, rate, quantity, lineTotal]);
          }

          // Log unknown slugs
          const resolvedSlugs = resolvedAddons.map(a => a.slug);
          addonSlugs.forEach(slug => {
            if (!resolvedSlugs.includes(slug)) {
              console.warn(`Drink plan addon slug not found in DB: ${slug}`);
            }
          });

          // Recalculate proposal total with all addons (existing + new)
          const allAddonsRes = await client.query(
            'SELECT sa.* FROM proposal_addons pa JOIN service_addons sa ON sa.id = pa.addon_id WHERE pa.proposal_id = $1',
            [proposal.id]
          );
          const pkgRes = await client.query('SELECT * FROM service_packages WHERE id = $1', [proposal.package_id]);
          const pkg = pkgRes.rows[0];

          if (pkg && proposal.guest_count && proposal.event_duration_hours) {
            // Flatten per-drink syrup map to unique array (supports legacy flat arrays too)
            const rawSyrups = selections.syrupSelections || {};
            const syrupSels = Array.isArray(rawSyrups)
              ? rawSyrups
              : [...new Set(Object.values(rawSyrups).flat())];
            const snapshot = calculateProposal({
              pkg,
              guestCount: proposal.guest_count,
              durationHours: Number(proposal.event_duration_hours),
              numBars: proposal.num_bars ?? 0,
              numBartenders: proposal.num_bartenders,
              addons: allAddonsRes.rows,
              syrupSelections: syrupSels,
            });

            await client.query(
              'UPDATE proposals SET total_price = $1, pricing_snapshot = $2, updated_at = NOW() WHERE id = $3',
              [snapshot.total, JSON.stringify(snapshot), proposal.id]
            );

            // Log activity
            await client.query(
              `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
               VALUES ($1, 'drink_plan_addons_added', 'client', $2)`,
              [proposal.id, JSON.stringify({
                addons: addonSlugs,
                syrups: syrupSels,
                champagne_serving_style: selections.addOns?.['champagne-toast']?.servingStyle || null,
                bar_rental_added: !!addBarRental,
                new_total: snapshot.total,
              })]
            );

            // Send admin notification if balance changed
            const amountPaid = Number(proposal.amount_paid) || 0;
            if (amountPaid < snapshot.total) {
              const adminEmail = process.env.ADMIN_EMAIL;
              if (adminEmail) {
                const daysUntil = proposal.event_date
                  ? Math.ceil((new Date(proposal.event_date) - new Date()) / (1000 * 60 * 60 * 24))
                  : null;
                const isUrgent = daysUntil !== null && daysUntil <= 14;

                const planName = existing.rows[0]?.client_name || 'Client';
                const addonNames = resolvedAddons.map(a => a.name);
                if (addBarRental) addonNames.push('Portable Bar Rental');
                await sendEmail({
                  to: adminEmail,
                  subject: `${isUrgent ? 'URGENT: ' : ''}Drink Plan Submitted with Add-Ons — ${planName}`,
                  html: `<p><strong>${planName}</strong> submitted their drink plan.</p>
                         <p><strong>Add-ons selected:</strong> ${addonNames.join(', ')}</p>
                         <p><strong>New total:</strong> $${snapshot.total.toFixed(2)}</p>
                         <p><strong>Amount paid:</strong> $${amountPaid.toFixed(2)}</p>
                         <p><strong>Balance due:</strong> $${(snapshot.total - amountPaid).toFixed(2)}</p>
                         ${isUrgent ? `<p style="color: red;"><strong>Event is in ${daysUntil} days!</strong></p>` : ''}
                         <p><a href="${ADMIN_URL}/admin/proposals/${proposal.id}">View Proposal</a></p>`,
                }).catch(emailErr => console.error('Admin notification email failed:', emailErr));
              }

              // Send client email with updated balance
              const clientEmail = existing.rows[0]?.client_email || proposal.client_email;
              if (clientEmail) {
                const extrasAmount = snapshot.total - (Number(proposal.total_price) || 0);
                const balanceDue = snapshot.total - amountPaid;
                const tpl = emailTemplates.drinkPlanBalanceUpdate({
                  clientName: existing.rows[0]?.client_name || 'Client',
                  eventTypeLabel: getEventTypeLabel({
                    event_type: existing.rows[0]?.event_type || proposal.event_type,
                    event_type_custom: existing.rows[0]?.event_type_custom || proposal.event_type_custom
                  }),
                  extrasAmount,
                  newTotal: snapshot.total,
                  amountPaid,
                  balanceDue,
                  balanceDueDate: proposal.balance_due_date,
                });
                sendEmail({ to: clientEmail, ...tpl })
                  .catch(emailErr => console.error('Client balance email failed:', emailErr));
              }
            }
          }
        }

        // Only refresh the Balance invoice when the extras are being *added
        // to balance* — NOT when the client is paying for them separately via
        // Stripe on this same submit (those extras will land on their own
        // "Drink Plan Extras" invoice created by the webhook).
        if (!paidSeparately) {
          try {
            await refreshUnlockedInvoices(proposal.id, client);
          } catch (refreshErr) {
            console.error('refreshUnlockedInvoices failed (non-fatal):', refreshErr);
          }
        }

        await client.query('COMMIT');
      } catch (addonErr) {
        await client.query('ROLLBACK');
        console.error('Addon processing error (non-fatal):', addonErr);
        // Don't fail the submission — addons are best-effort
      } finally {
        client.release();
      }
    }
  }

  res.json(updatedPlan);
}));

// ─── Admin routes (auth required) ────────────────────────────────

/** GET /api/drink-plans — list all plans */
router.get('/', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { status, search } = req.query;
  let query = `
    SELECT dp.*, u.email AS created_by_email
    FROM drink_plans dp
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

  query += ' ORDER BY dp.created_at DESC';

  const result = await pool.query(query, params);
  res.json(result.rows);
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
  res.json(existing.rows[0]);
}));

/** GET /api/drink-plans/by-proposal/:proposalId — fetch plan by proposal id */
router.get('/by-proposal/:proposalId', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT dp.*, u.email AS created_by_email
     FROM drink_plans dp
     LEFT JOIN users u ON u.id = dp.created_by
     WHERE dp.proposal_id = $1`,
    [req.params.proposalId]
  );
  if (!result.rows[0]) throw new NotFoundError('No drink plan found for this proposal.');
  res.json(result.rows[0]);
}));

/** GET /api/drink-plans/:id/shopping-list-data — fetch shaped data for shopping list generation */
router.get('/:id/shopping-list-data', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  // Fetch the drink plan, joining proposals for guest_count
  const planResult = await pool.query(
    `SELECT dp.*, p.guest_count
     FROM drink_plans dp
     LEFT JOIN proposals p ON p.id = dp.proposal_id
     WHERE dp.id = $1`,
    [req.params.id]
  );
  if (!planResult.rows[0]) throw new NotFoundError('Plan not found.');
  const plan = planResult.rows[0];

  // Resolve signature cocktail IDs to names + ingredients
  const signatureDrinkIds = (plan.selections && plan.selections.signatureDrinks) || [];
  let signatureCocktails = [];
  if (signatureDrinkIds.length > 0) {
    const cocktailResult = await pool.query(
      `SELECT id, name, ingredients FROM cocktails WHERE id = ANY($1::text[])`,
      [signatureDrinkIds]
    );
    // Preserve the order from selections
    const byId = Object.fromEntries(cocktailResult.rows.map(c => [c.id, c]));
    signatureCocktails = signatureDrinkIds
      .filter(id => byId[id])
      .map(id => ({
        name: byId[id].name,
        ingredients: byId[id].ingredients || [],
      }));
  }

  // Extract self-provided syrup IDs from selections
  const syrupSelfProvided = (plan.selections && plan.selections.syrupSelfProvided) || [];

  // Extract beer/wine/mixer selections for shopping list filtering
  const serviceStyle = plan.serving_type || 'full_bar';
  const sel = plan.selections || {};
  const isFullBar = serviceStyle === 'full_bar';
  const beerSelections = isFullBar
    ? (sel.beerFromFullBar || [])
    : (sel.beerFromBeerWine || []);
  const wineSelections = isFullBar
    ? (sel.wineFromFullBar || [])
    : (sel.wineFromBeerWine || []);

  res.json({
    client_name: plan.client_name,
    event_type: plan.event_type,
    event_type_custom: plan.event_type_custom,
    event_date: plan.event_date,
    guest_count: plan.guest_count || null,
    service_style: serviceStyle,
    signature_cocktails: signatureCocktails,
    syrup_self_provided: syrupSelfProvided,
    beer_selections: beerSelections,
    wine_selections: wineSelections,
    mixers_for_signature_drinks: sel.mixersForSignatureDrinks ?? null,
    notes: plan.admin_notes || '',
  });
}));

/** GET /api/drink-plans/:id — fetch single plan by id */
router.get('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT dp.*, u.email AS created_by_email
     FROM drink_plans dp
     LEFT JOIN users u ON u.id = dp.created_by
     WHERE dp.id = $1`,
    [req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Plan not found.');
  res.json(result.rows[0]);
}));

/** PATCH /api/drink-plans/:id/notes — update admin notes */
router.patch('/:id/notes', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
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
  const { status } = req.body;
  if (!['pending', 'draft', 'exploration_saved', 'submitted', 'reviewed'].includes(status)) {
    throw new ValidationError({ status: 'Invalid status.' });
  }
  const result = await pool.query(
    'UPDATE drink_plans SET status = $1 WHERE id = $2 RETURNING *',
    [status, req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Plan not found.');
  res.json(result.rows[0]);
}));

/** GET /api/drink-plans/:id/shopping-list — load saved shopping list */
router.get('/:id/shopping-list', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT shopping_list FROM drink_plans WHERE id = $1',
    [req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Plan not found.');
  res.json({ shopping_list: result.rows[0].shopping_list || null });
}));

/** PUT /api/drink-plans/:id/shopping-list — save/update shopping list */
router.put('/:id/shopping-list', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { shopping_list } = req.body;
  if (!shopping_list || typeof shopping_list !== 'object') {
    throw new ValidationError({ shopping_list: 'Invalid shopping list data.' });
  }
  const result = await pool.query(
    'UPDATE drink_plans SET shopping_list = $1, updated_at = NOW() WHERE id = $2 RETURNING id',
    [JSON.stringify(shopping_list), req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Plan not found.');
  res.json({ success: true });
}));

/** DELETE /api/drink-plans/:id — delete a plan */
router.delete('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query('DELETE FROM drink_plans WHERE id = $1 RETURNING id', [req.params.id]);
  if (!result.rows[0]) throw new NotFoundError('Plan not found.');
  res.json({ success: true });
}));

module.exports = router;

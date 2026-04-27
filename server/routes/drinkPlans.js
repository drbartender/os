const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const { publicReadLimiter, drinkPlanWriteLimiter } = require('../middleware/rateLimiters');
const { calculateProposal } = require('../utils/pricingEngine');
const { refreshUnlockedInvoices } = require('../utils/invoiceHelpers');
const { sendEmail } = require('../utils/email');
const emailTemplates = require('../utils/emailTemplates');
const { getEventTypeLabel } = require('../utils/eventTypes');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError } = require('../utils/errors');
const { ADMIN_URL, PUBLIC_SITE_URL } = require('../utils/urls');
const { generateShoppingList } = require('../utils/shoppingList');

// Mirror of client/src/data/syrups.js SYRUPS — id → display name. Keep in sync
// when adding new flavors. Only used for shopping-list rendering of the
// self-provided syrup line items, so a missing entry just drops that flavor
// from the list (no crash).
const SYRUP_NAME_LOOKUP = {
  'mixed-berry': 'Mixed Berry', 'blackberry': 'Blackberry', 'strawberry': 'Strawberry',
  'mango': 'Mango', 'passion-fruit': 'Passion Fruit', 'pineapple': 'Pineapple',
  'peach': 'Peach', 'watermelon': 'Watermelon', 'grenadine': 'Grenadine (Pomegranate)',
  'cherry': 'Cherry (Dark/Tart)',
  'jalapeno': 'Jalapeño', 'habanero': 'Habanero', 'cherry-habanero': 'Cherry Habanero',
  'reaper-ghost': 'Carolina Reaper / Ghost Pepper',
  'lavender': 'Lavender', 'rosemary': 'Rosemary', 'thyme': 'Thyme', 'basil': 'Basil',
  'mint': 'Mint', 'ginger': 'Ginger', 'cardamom': 'Cardamom', 'cinnamon': 'Cinnamon',
  'vanilla': 'Vanilla', 'lemongrass': 'Lemongrass', 'hibiscus': 'Hibiscus',
  'rose': 'Rose', 'elderflower': 'Elderflower',
  'honey': 'Honey', 'maple': 'Maple', 'salted-caramel': 'Salted Caramel',
  'brown-butter': 'Brown Butter', 'espresso': 'Espresso', 'chocolate': 'Chocolate',
};

// Auto-generate a shopping list for a submitted drink plan and stage it as
// `pending_review`. Strict no-overwrite semantics: only generates when no list
// exists yet — the WHERE-clause `shopping_list IS NULL` guard keeps an admin's
// concurrent manual save (or already-approved list) from being clobbered by a
// late-firing auto-gen after submit COMMIT. Failures are non-fatal — admin can
// still trigger the manual generator from the modal as a fallback.
async function autoGenerateShoppingList(planId, dbClient) {
  const planRes = await dbClient.query(
    `SELECT dp.id, dp.serving_type, dp.selections, dp.client_name, dp.event_date,
            dp.admin_notes, dp.shopping_list IS NOT NULL AS has_list,
            p.guest_count
     FROM drink_plans dp
     LEFT JOIN proposals p ON p.id = dp.proposal_id
     WHERE dp.id = $1`,
    [planId]
  );
  const plan = planRes.rows[0];
  if (!plan || !plan.guest_count) return null;
  // Skip the cocktail/JSON work entirely when a list already exists. The
  // UPDATE below is also gated on `shopping_list IS NULL` for atomicity, so
  // this is just an early-out optimization.
  if (plan.has_list) return null;

  const sel = plan.selections || {};
  const sigDrinkIds = Array.isArray(sel.signatureDrinks) ? sel.signatureDrinks : [];
  let signatureCocktails = [];
  if (sigDrinkIds.length > 0) {
    const cocktailRes = await dbClient.query(
      'SELECT id, name, ingredients FROM cocktails WHERE id = ANY($1::text[])',
      [sigDrinkIds]
    );
    const byId = Object.fromEntries(cocktailRes.rows.map(c => [c.id, c]));
    signatureCocktails = sigDrinkIds
      .filter(id => byId[id])
      .map(id => ({ name: byId[id].name, ingredients: byId[id].ingredients || [] }));
  }

  const syrupSelfProvided = Array.isArray(sel.syrupSelfProvided) ? sel.syrupSelfProvided : [];
  const syrupNamesById = syrupSelfProvided.length > 0 ? SYRUP_NAME_LOOKUP : {};

  const isFullBar = (plan.serving_type || 'full_bar') === 'full_bar';
  const beerSelections = isFullBar ? (sel.beerFromFullBar || []) : (sel.beerFromBeerWine || []);
  const wineSelections = isFullBar ? (sel.wineFromFullBar || []) : (sel.wineFromBeerWine || []);

  const list = generateShoppingList({
    clientName: plan.client_name,
    guestCount: plan.guest_count,
    signatureCocktails,
    syrupSelfProvided,
    syrupNamesById,
    eventDate: plan.event_date,
    notes: plan.admin_notes || '',
    serviceStyle: plan.serving_type || 'full_bar',
    beerSelections,
    wineSelections,
    mixersForSignatureDrinks: sel.mixersForSignatureDrinks ?? null,
  });

  // Atomic guard: only fill the list when it's still NULL. If admin saved an
  // edit (PUT /shopping-list) or approved a different list during the race
  // window between submit COMMIT and this UPDATE, the row already has a value
  // and this UPDATE matches zero rows — admin's edit wins.
  await dbClient.query(
    `UPDATE drink_plans
       SET shopping_list = $1::jsonb,
           shopping_list_status = 'pending_review',
           updated_at = NOW()
     WHERE id = $2
       AND shopping_list IS NULL`,
    [JSON.stringify(list), planId]
  );
  return list;
}

const router = express.Router();

// ─── Public routes (token-based) ─────────────────────────────────

/** GET /api/drink-plans/t/:token/shopping-list — public shopping list for clients.
 *  Returns the list only when admin has explicitly approved it. While the list
 *  is auto-generated and waiting for review (status='pending_review'), or no
 *  list exists yet, the response stays in the "being prepared" placeholder
 *  state so clients don't see unreviewed quantities. */
router.get('/t/:token/shopping-list', publicReadLimiter, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT dp.shopping_list, dp.shopping_list_status,
            dp.client_name, dp.event_type, dp.event_type_custom, dp.event_date, dp.status
     FROM drink_plans dp WHERE dp.token = $1`,
    [req.params.token]
  );
  if (!result.rows[0]) throw new NotFoundError('This drink plan link is no longer valid');
  const plan = result.rows[0];
  const isApproved = plan.shopping_list && plan.shopping_list_status === 'approved';
  if (!isApproved) {
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
            sp.bar_type            AS package_bar_type,
            sp.category            AS package_category,
            sp.slug                AS package_slug,
            sp.name                AS package_name,
            sp.includes            AS package_includes,
            sp.covered_addon_slugs AS package_covered_addon_slugs
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
router.put('/t/:token', drinkPlanWriteLimiter, asyncHandler(async (req, res) => {
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

  // Detect submit-with-side-effects up front. When true, we run the plan
  // UPDATE inside the same transaction as the addon/total/invoice work so a
  // rollback also rolls back the plan-status change. Previously the plan was
  // committed first and the addon block was marked "non-fatal", which caused
  // split-brain: client saw success while pricing/invoices stayed stale.
  const rawAddons = selections?.addOns || {};
  const rawAddonSlugs = Object.keys(rawAddons).filter(slug => rawAddons[slug]?.enabled);
  const addBarRental = selections?.logistics?.addBarRental === true;
  const hasFinancialSideEffects =
    newStatus === 'submitted'
    && !!existing.rows[0].proposal_id
    && (rawAddonSlugs.length > 0 || addBarRental);

  if (hasFinancialSideEffects) {
    // Atomic submit path: plan UPDATE + addons + total + invoice all in one
    // transaction. Email side-effects deferred until after COMMIT (captured
    // in `pendingNotifications` and sent below).
    const client = await pool.connect();
    let updatedPlan;
    let pendingNotifications = null;
    try {
      await client.query('BEGIN');

      const planUpd = await client.query(`
        UPDATE drink_plans SET
          serving_type = COALESCE($1, serving_type),
          selections = COALESCE($2::jsonb, selections),
          status = $3,
          submitted_at = COALESCE($4, submitted_at),
          exploration_submitted_at = COALESCE($5, exploration_submitted_at)
        WHERE token = $6
        RETURNING id, token, status, serving_type, submitted_at, proposal_id
      `, [serving_type || null, selections ? JSON.stringify(selections) : null, newStatus, submittedNow, explorationNow, req.params.token]);

      if (!planUpd.rows[0]) {
        await client.query('ROLLBACK');
        throw new NotFoundError('This drink plan link is no longer valid');
      }
      updatedPlan = planUpd.rows[0];

      // Lock the proposal row
      const proposalRes = await client.query(
        'SELECT * FROM proposals WHERE id = $1 FOR UPDATE',
        [updatedPlan.proposal_id]
      );
      const proposal = proposalRes.rows[0];

      if (proposal) {
        // Pull the package so we can validate autoAdded addons against its coverage.
        const pkgEarly = proposal.package_id
          ? (await client.query('SELECT id, covered_addon_slugs FROM service_packages WHERE id = $1', [proposal.package_id])).rows[0]
          : null;
        const coveredAddonSlugs = pkgEarly?.covered_addon_slugs || [];

        // Pull the selected cocktails' upgrade_addon_slugs so we can verify triggers.
        const sigDrinkIds = Array.isArray(selections?.signatureDrinks) ? selections.signatureDrinks : [];
        const cocktailRows = sigDrinkIds.length > 0
          ? (await client.query(
              'SELECT id, upgrade_addon_slugs FROM cocktails WHERE id = ANY($1::text[])',
              [sigDrinkIds]
            )).rows
          : [];
        const cocktailById = new Map(cocktailRows.map(r => [r.id, r]));

        // For each autoAdded addon, require a still-selected triggering cocktail whose
        // upgrade_addon_slugs includes the slug AND the package does not cover it.
        const addonSlugs = rawAddonSlugs.filter(slug => {
          const meta = rawAddons[slug];
          if (coveredAddonSlugs.includes(slug)) return false; // package already covers — never charge
          if (meta?.autoAdded) {
            const triggers = Array.isArray(meta.triggeredBy) ? meta.triggeredBy : [];
            const validTrigger = triggers.some(drinkId => {
              const c = cocktailById.get(drinkId);
              return c && Array.isArray(c.upgrade_addon_slugs) && c.upgrade_addon_slugs.includes(slug);
            });
            return validTrigger;
          }
          return true; // user-added addon — honor it
        });

        // Build the specialty_upgrades payload for activity-log enrichment.
        const specialtyUpgrades = addonSlugs
          .filter(slug => rawAddons[slug]?.autoAdded)
          .map(slug => ({
            slug,
            triggeredBy: (rawAddons[slug].triggeredBy || []).filter(drinkId => cocktailById.has(drinkId)),
          }));

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

          await client.query(
            `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
             VALUES ($1, 'drink_plan_addons_added', 'client', $2)`,
            [proposal.id, JSON.stringify({
              addons: addonSlugs,
              syrups: syrupSels,
              champagne_serving_style: selections.addOns?.['champagne-toast']?.servingStyle || null,
              bar_rental_added: !!addBarRental,
              new_total: snapshot.total,
              specialty_upgrades: specialtyUpgrades,
            })]
          );

          // Capture data for post-commit notifications. Don't send inside the
          // transaction — a rollback after sending would leak misleading email.
          const amountPaid = Number(proposal.amount_paid) || 0;
          if (amountPaid < snapshot.total) {
            const addonNames = resolvedAddons.map(a => a.name);
            if (addBarRental) addonNames.push('Portable Bar Rental');
            pendingNotifications = {
              proposal: {
                id: proposal.id,
                event_date: proposal.event_date,
                event_type: existing.rows[0]?.event_type || proposal.event_type,
                event_type_custom: existing.rows[0]?.event_type_custom || proposal.event_type_custom,
                balance_due_date: proposal.balance_due_date,
                prevTotal: Number(proposal.total_price) || 0,
              },
              snapshot,
              amountPaid,
              addonNames,
              clientName: existing.rows[0]?.client_name || 'Client',
              clientEmail: existing.rows[0]?.client_email || proposal.client_email,
            };
          }
        }
      }

      // Refresh the Balance invoice unless extras are being paid separately
      // via Stripe (those land on their own webhook-created "Drink Plan Extras"
      // invoice). Skip when the proposal row was deleted between the existence
      // check and the FOR UPDATE lock — refreshing against a missing row would
      // throw and roll back an otherwise-valid plan submission. Failure here
      // is otherwise FATAL — a rolled-back refresh rolls back the plan UPDATE,
      // so the client retries cleanly.
      if (!paidSeparately && proposal) {
        await refreshUnlockedInvoices(proposal.id, client);
      }

      await client.query('COMMIT');
    } catch (txErr) {
      try { await client.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(txErr, {
          tags: { route: 'drinkPlans/putToken', op: 'submit_with_addons' },
          extra: { token: req.params.token, proposalId: existing.rows[0].proposal_id },
        });
      }
      console.error('Drink-plan submit transaction failed:', txErr);
      throw txErr; // surface as 5xx so client can retry instead of seeing a phantom success
    } finally {
      client.release();
    }

    // Post-commit notifications (best-effort; logged but never block response).
    if (pendingNotifications) {
      const { proposal: pn, snapshot, amountPaid, addonNames, clientName, clientEmail } = pendingNotifications;
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail) {
        const daysUntil = pn.event_date
          ? Math.ceil((new Date(pn.event_date) - new Date()) / (1000 * 60 * 60 * 24))
          : null;
        const isUrgent = daysUntil !== null && daysUntil <= 14;
        sendEmail({
          to: adminEmail,
          subject: `${isUrgent ? 'URGENT: ' : ''}Drink Plan Submitted with Add-Ons — ${clientName}`,
          html: `<p><strong>${clientName}</strong> submitted their drink plan.</p>
                 <p><strong>Add-ons selected:</strong> ${addonNames.join(', ')}</p>
                 <p><strong>New total:</strong> $${snapshot.total.toFixed(2)}</p>
                 <p><strong>Amount paid:</strong> $${amountPaid.toFixed(2)}</p>
                 <p><strong>Balance due:</strong> $${(snapshot.total - amountPaid).toFixed(2)}</p>
                 ${isUrgent ? `<p style="color: red;"><strong>Event is in ${daysUntil} days!</strong></p>` : ''}
                 <p><a href="${ADMIN_URL}/admin/proposals/${pn.id}">View Proposal</a></p>`,
        }).catch(emailErr => console.error('Admin notification email failed:', emailErr));
      }
      if (clientEmail) {
        const extrasAmount = snapshot.total - pn.prevTotal;
        const balanceDue = snapshot.total - amountPaid;
        const tpl = emailTemplates.drinkPlanBalanceUpdate({
          clientName,
          eventTypeLabel: getEventTypeLabel({ event_type: pn.event_type, event_type_custom: pn.event_type_custom }),
          extrasAmount,
          newTotal: snapshot.total,
          amountPaid,
          balanceDue,
          balanceDueDate: pn.balance_due_date,
        });
        sendEmail({ to: clientEmail, ...tpl }).catch(emailErr => console.error('Client balance email failed:', emailErr));
      }
    }

    // Auto-generate the shopping list now that the plan is submitted. Runs
    // outside the transaction (best-effort, non-fatal) — admin can still
    // generate manually from the modal if this misses.
    if (newStatus === 'submitted' && updatedPlan?.id) {
      autoGenerateShoppingList(updatedPlan.id, pool).catch(genErr => {
        console.error('Shopping list auto-gen failed:', genErr);
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(genErr, {
            tags: { route: 'drinkPlans/putToken', op: 'auto_gen_shopping_list' },
            extra: { planId: updatedPlan.id },
          });
        }
      });
    }

    return res.json(updatedPlan);
  }

  // Fast path: drafts, exploration_saved, or submit-without-addons. No
  // financial side effects, so we can use a single auto-committed UPDATE.
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

  // Fast-path submit (no add-ons) also auto-generates the shopping list draft
  // for admin review. Best-effort — same fail-open contract as the financial
  // branch above.
  if (newStatus === 'submitted' && result.rows[0]?.id) {
    autoGenerateShoppingList(result.rows[0].id, pool).catch(genErr => {
      console.error('Shopping list auto-gen failed:', genErr);
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(genErr, {
          tags: { route: 'drinkPlans/putToken', op: 'auto_gen_shopping_list' },
          extra: { planId: result.rows[0].id },
        });
      }
    });
  }

  res.json(result.rows[0]);
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
           dp.status, dp.exploration_submitted_at, dp.submitted_at, dp.created_at,
           dp.updated_at, dp.created_by,
           u.email AS created_by_email
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

  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;
  query += ` ORDER BY dp.created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`;

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

/** GET /api/drink-plans/by-proposal/:proposalId — fetch plan by proposal id. Keep
 *  selections (needed for detail); exclude shopping_list (has its own endpoint). */
router.get('/by-proposal/:proposalId', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT dp.id, dp.token, dp.proposal_id, dp.client_name, dp.client_email,
            dp.event_type, dp.event_type_custom, dp.event_date, dp.serving_type,
            dp.selections, dp.status, dp.admin_notes, dp.exploration_submitted_at,
            dp.submitted_at, dp.created_at, dp.updated_at, dp.created_by,
            u.email AS created_by_email
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

/** GET /api/drink-plans/:id — fetch single plan by id. Exclude shopping_list
 *  (has its own endpoint); keep selections for detail rendering. */
router.get('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT dp.id, dp.token, dp.proposal_id, dp.client_name, dp.client_email,
            dp.event_type, dp.event_type_custom, dp.event_date, dp.serving_type,
            dp.selections, dp.status, dp.admin_notes, dp.exploration_submitted_at,
            dp.submitted_at, dp.created_at, dp.updated_at, dp.created_by,
            u.email AS created_by_email
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
    'SELECT shopping_list, shopping_list_status, shopping_list_approved_at FROM drink_plans WHERE id = $1',
    [req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Plan not found.');
  res.json({
    shopping_list: result.rows[0].shopping_list || null,
    shopping_list_status: result.rows[0].shopping_list_status || null,
    shopping_list_approved_at: result.rows[0].shopping_list_approved_at || null,
  });
}));

/** PUT /api/drink-plans/:id/shopping-list — save/update shopping list. Keeps
 *  the list in `pending_review` until the admin explicitly approves; an admin
 *  re-edit of an already-approved list reverts it to pending so the client
 *  doesn't keep reading stale numbers. */
router.put('/:id/shopping-list', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { shopping_list } = req.body;
  if (!shopping_list || typeof shopping_list !== 'object') {
    throw new ValidationError({ shopping_list: 'Invalid shopping list data.' });
  }
  const result = await pool.query(
    `UPDATE drink_plans
       SET shopping_list = $1,
           shopping_list_status = 'pending_review',
           shopping_list_approved_at = NULL,
           updated_at = NOW()
     WHERE id = $2
     RETURNING id`,
    [JSON.stringify(shopping_list), req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Plan not found.');
  res.json({ success: true });
}));

/** PATCH /api/drink-plans/:id/shopping-list/approve — admin approves the list,
 *  flipping it from pending_review → approved. Public client view starts
 *  serving the list now; client gets an email with the link. */
router.patch('/:id/shopping-list/approve', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  // Atomic UPDATE: matches at most once. Concurrent admin clicks both pass
  // the auth check, but only the first transitions pending_review → approved
  // and gets the row back. Subsequent clicks fall through to the idempotent
  // success path below — no double-emails to the client.
  const upd = await pool.query(
    `UPDATE drink_plans
       SET shopping_list_status = 'approved',
           shopping_list_approved_at = NOW(),
           updated_at = NOW()
     WHERE id = $1
       AND shopping_list IS NOT NULL
       AND shopping_list_status IS DISTINCT FROM 'approved'
     RETURNING id, token, client_name, client_email, event_type, event_type_custom, event_date`,
    [req.params.id]
  );

  if (!upd.rows[0]) {
    // Either the row doesn't exist, the list is missing, or it was already
    // approved by another admin click. Distinguish so we surface a useful
    // error for the no-list case but stay idempotent for the already-approved
    // case (don't re-email the client).
    const check = await pool.query(
      `SELECT shopping_list IS NOT NULL AS has_list, shopping_list_status, shopping_list_approved_at
       FROM drink_plans WHERE id = $1`,
      [req.params.id]
    );
    if (!check.rows[0]) throw new NotFoundError('Plan not found.');
    if (!check.rows[0].has_list) {
      throw new ConflictError('Cannot approve: this plan has no shopping list yet. Generate one first.');
    }
    return res.json({
      success: true,
      approved_at: check.rows[0].shopping_list_approved_at,
      alreadyApproved: true,
    });
  }

  const plan = upd.rows[0];

  // Notify the client. Best-effort — never fail the approval if email blows up.
  if (plan.client_email && plan.token) {
    const shoppingListUrl = `${PUBLIC_SITE_URL}/shopping-list/${plan.token}`;
    const eventTypeLabel = getEventTypeLabel({
      event_type: plan.event_type,
      event_type_custom: plan.event_type_custom,
    });
    const tpl = emailTemplates.shoppingListReady
      ? emailTemplates.shoppingListReady({
          clientName: plan.client_name,
          eventTypeLabel,
          shoppingListUrl,
        })
      : null;
    if (tpl) {
      sendEmail({ to: plan.client_email, ...tpl }).catch(emailErr => {
        console.error('Shopping-list-ready email failed:', emailErr);
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(emailErr, {
            tags: { route: 'drinkPlans/approveShoppingList', step: 'email' },
            extra: { planId: plan.id },
          });
        }
      });
    }
  }

  res.json({ success: true, approved_at: new Date().toISOString() });
}));

/** DELETE /api/drink-plans/:id — delete a plan */
router.delete('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query('DELETE FROM drink_plans WHERE id = $1 RETURNING id', [req.params.id]);
  if (!result.rows[0]) throw new NotFoundError('Plan not found.');
  res.json({ success: true });
}));

module.exports = router;

const express = require('express');
const path = require('path');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const { publicReadLimiter, drinkPlanWriteLimiter, logoUploadLimiter } = require('../middleware/rateLimiters');

// Token-gated selections PUT accepts arbitrary JSON. To stop attackers from
// (a) seeding internal-only keys like `_logoFilename` to pivot the logo proxy
// into reading any R2 object, or (b) writing a `javascript:` URL into
// `companyLogo` that the admin "Download original" link would then execute,
// every PUT goes through this sanitizer first.
const ALLOWED_SELECTIONS_KEYS = new Set([
  'signatureDrinks', 'signatureDrinkSpirits', 'customCocktails',
  'mixersForSignatureDrinks', 'mocktails', 'mocktailNotes',
  'spirits', 'spiritsOther', 'mixersForSpirits',
  'beerFromFullBar', 'wineFromFullBar', 'wineOtherFullBar', 'beerWineBalanceFullBar',
  'beerFromBeerWine', 'wineFromBeerWine', 'wineOtherBeerWine', 'beerWineBalanceBeerWine',
  'syrupSelections', 'syrupSelfProvided',
  'addOns', 'logistics',
  'customMenuDesign', 'menuStyle', 'menuTheme', 'drinkNaming', 'menuDesignNotes',
  'additionalNotes', 'companyLogo',
  'activeModules', 'exploration',
  // legacy fields preserved for back-compat with already-saved plans
  'signatureCocktails', 'barFocus', 'wineStyles', 'beerStyles', 'beerWineBalance',
  'beerWineNotes', 'fullBarNotes', 'logisticsNotes',
]);

function sanitizeSelections(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_SELECTIONS_KEYS.has(key)) continue; // drop unknown keys, including _logoFilename
    out[key] = raw[key];
  }
  // companyLogo must be either empty or a path served by THIS API. Reject
  // `javascript:`, `data:`, or any cross-origin URL — the admin event-detail
  // page renders `<a href={companyLogo}>Download original</a>`, which would
  // otherwise execute attacker-controlled script in an admin session.
  if (out.companyLogo !== undefined) {
    const cl = typeof out.companyLogo === 'string' ? out.companyLogo : '';
    if (cl && !cl.startsWith('/api/drink-plans/t/') && !cl.startsWith(`${API_URL}/api/drink-plans/t/`)) {
      out.companyLogo = '';
    }
  }
  return out;
}
const { calculateProposal } = require('../utils/pricingEngine');
const { refreshUnlockedInvoices } = require('../utils/invoiceHelpers');
const { sendEmail } = require('../utils/email');
const emailTemplates = require('../utils/emailTemplates');
const { notifyAdminCategory } = require('../utils/adminNotifications');
const { getEventTypeLabel } = require('../utils/eventTypes');
const { shouldSendImmediate } = require('../utils/messageSuppression');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError, PermissionError, ExternalServiceError } = require('../utils/errors');
const { ADMIN_URL, PUBLIC_SITE_URL, API_URL } = require('../utils/urls');
const { autoGenerateShoppingList } = require('../utils/shoppingListGen');
const { isDrinkPlanPreBooking } = require('../utils/drinkPlanAccess');
const { uploadFile, getSignedUrl } = require('../utils/storage');
const { isValidImageUpload } = require('../utils/fileValidation');

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
            p.token AS proposal_token,
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
  const plan = result.rows[0];
  // The drink plan only opens after the client books (deposit paid).
  // Outstanding proposal-sent emails may still carry a /plan/:token link for a
  // pre-deposit proposal — never drop an unbooked client into the wizard (it
  // can run a Stripe charge in ConfirmationStep). Return a locked payload.
  if (isDrinkPlanPreBooking(plan.proposal_status)) {
    return res.json({ locked: true, proposalToken: plan.proposal_token });
  }
  res.json(plan);
}));

/** PUT /api/drink-plans/t/:token — save draft or submit (public) */
router.put('/t/:token', drinkPlanWriteLimiter, asyncHandler(async (req, res) => {
  const { serving_type, status, paid_separately } = req.body;
  const selections = sanitizeSelections(req.body.selections);
  const paidSeparately = paid_separately === true;

  // Check plan exists and is not already submitted. JOIN proposals + clients
  // so the post-commit suppression check (shouldSendImmediate) can see the
  // proposal status and the client's comm-prefs / contact-status. Without the
  // JOIN those columns are undefined and suppression is silently bypassed.
  // LEFT JOINs keep behavior identical for plans with no linked proposal/client.
  const existing = await pool.query(
    `SELECT dp.id, dp.status, dp.proposal_id,
            dp.client_name, dp.client_email,
            dp.event_type, dp.event_type_custom,
            p.status AS proposal_status,
            c.id AS client_id,
            c.communication_preferences, c.email_status, c.phone_status
     FROM drink_plans dp
     LEFT JOIN proposals p ON p.id = dp.proposal_id
     LEFT JOIN clients c ON c.id = p.client_id
     WHERE dp.token = $1`,
    [req.params.token]
  );
  if (!existing.rows[0]) throw new NotFoundError('This drink plan link is no longer valid');
  if (existing.rows[0].status === 'submitted' || existing.rows[0].status === 'reviewed') {
    throw new ConflictError('This plan has already been submitted.');
  }

  const newStatus = status === 'submitted' ? 'submitted' : 'draft';

  // Compute timestamps in JS to avoid PostgreSQL "inconsistent types" error
  // when reusing the same parameter ($3) in both SET and CASE WHEN contexts
  const submittedNow = newStatus === 'submitted' ? new Date() : null;
  // Legacy: the Exploration phase was removed 2026-05-17. The
  // exploration_submitted_at column + its $-param are kept inert (always null)
  // so the financial UPDATE's parameter numbering stays untouched.
  const explorationNow = null;

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
          // The client drink-plan-submitted confirmation fires UNCONDITIONALLY
          // (spec section 3.8); the balance language is conditional on whether
          // extras actually pushed the total up (`balanceChanged`).
          const amountPaid = Number(proposal.amount_paid) || 0;
          const balanceChanged = snapshot.total > Number(proposal.total_price); // extras pushed total up
          const addonNames = resolvedAddons.map(a => a.name);
          if (addBarRental) addonNames.push('Portable Bar Rental');
          pendingNotifications = {
            proposal: {
              id: proposal.id,
              // `proposal.status` from the FOR-UPDATE SELECT * is the direct
              // source; existing.rows[0].proposal_status (Step 3 JOIN) backstops it.
              status: proposal.status || existing.rows[0]?.proposal_status,
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
            // Suppression rules: comm-prefs + email/phone status pulled by the
            // joined `existing` SELECT in Step 3.
            clientForCheck: {
              communication_preferences: existing.rows[0]?.communication_preferences,
              email_status: existing.rows[0]?.email_status,
              phone_status: existing.rows[0]?.phone_status,
            },
            barOption: pkg && pkg.pricing_type === 'per_guest' ? 'hosted' : 'byob',
            balanceChanged,
          };
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
      // Admin heads-up stays throttled to balance-changing submits — a
      // zero-impact addon submit (all package-covered) doesn't warrant a ping.
      if (pendingNotifications.balanceChanged) {
        const daysUntil = pn.event_date
          ? Math.ceil((new Date(pn.event_date) - new Date()) / (1000 * 60 * 60 * 24))
          : null;
        const isUrgent = daysUntil !== null && daysUntil <= 14;
        const dpSubject = `${isUrgent ? 'Urgent: ' : ''}Drink plan submitted with add-ons, ${clientName}`;
        const dpHtml = `<p><strong>${clientName}</strong> submitted their drink plan.</p>
                 <p><strong>Add-ons selected:</strong> ${addonNames.join(', ')}</p>
                 <p><strong>New total:</strong> $${snapshot.total.toFixed(2)}</p>
                 <p><strong>Amount paid:</strong> $${amountPaid.toFixed(2)}</p>
                 <p><strong>Balance due:</strong> $${(snapshot.total - amountPaid).toFixed(2)}</p>
                 ${isUrgent ? `<p style="color: red;"><strong>Event is in ${daysUntil} days.</strong></p>` : ''}
                 <p><a href="${ADMIN_URL}/proposals/${pn.id}">View Proposal</a></p>`;
        const dpText = `${clientName} submitted their drink plan with add-ons: ${addonNames.join(', ')}. New total $${snapshot.total.toFixed(2)}, balance due $${(snapshot.total - amountPaid).toFixed(2)}. ${ADMIN_URL}/proposals/${pn.id}`;
        notifyAdminCategory({ category: 'routine_admin', subject: dpSubject, emailHtml: dpHtml, emailText: dpText })
          .catch(emailErr => console.error('Admin notification failed:', emailErr));
      }
      if (clientEmail) {
        // Always-fire drink-plan-submitted confirmation. Balance language is
        // conditional on `balanceChanged`; the BYOB-vs-Hosted warning is driven
        // by `barOption`. Respect suppression rules on the immediate send.
        const { barOption, balanceChanged, clientForCheck } = pendingNotifications;
        const sendCheck = await shouldSendImmediate({
          proposal: { id: pn.id, status: pn.status || 'deposit_paid' },
          client: clientForCheck,
          channel: 'email',
        });
        if (!sendCheck.ok) {
          console.log(`[drinkPlanSubmit] suppressed for proposal ${pn.id}: ${sendCheck.reason}`);
        } else {
          const extrasAmount = balanceChanged ? snapshot.total - pn.prevTotal : 0;
          const balanceDue = balanceChanged ? snapshot.total - amountPaid : 0;
          const tpl = emailTemplates.drinkPlanBalanceUpdate({
            clientName,
            eventTypeLabel: getEventTypeLabel({ event_type: pn.event_type, event_type_custom: pn.event_type_custom }),
            barOption,
            balanceChanged,
            extrasAmount,
            newTotal: snapshot.total,
            amountPaid,
            balanceDue,
            balanceDueDate: pn.balance_due_date,
          });
          sendEmail({ to: clientEmail, ...tpl }).catch(emailErr => console.error('Client drink-plan confirmation email failed:', emailErr));
        }
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

  // Fast path: drafts or submit-without-addons. No financial side effects, so
  // we can use a single auto-committed UPDATE.
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

  // Always-fire drink-plan-submitted confirmation. Spec section 3.8: fires on
  // every submission, with conditional balance language (false here: the fast
  // path runs when no addons were added, so no balance shift).
  if (newStatus === 'submitted' && result.rows[0]?.id) {
    try {
      const r = await pool.query(`
        SELECT p.id, p.status AS proposal_status,
               p.event_type, p.event_type_custom, p.balance_due_date,
               p.total_price, p.amount_paid,
               c.name AS client_name, c.email AS client_email,
               c.communication_preferences, c.email_status, c.phone_status,
               sp.pricing_type AS package_pricing_type
        FROM drink_plans dp
        LEFT JOIN proposals p ON p.id = dp.proposal_id
        LEFT JOIN clients c ON c.id = p.client_id
        LEFT JOIN service_packages sp ON sp.id = p.package_id
        WHERE dp.id = $1
        LIMIT 1
      `, [result.rows[0].id]);
      if (r.rows[0]?.client_email) {
        const row = r.rows[0];
        // Respect suppression rules on the immediate send.
        const sendCheck = await shouldSendImmediate({
          proposal: { id: row.id, status: row.proposal_status || 'deposit_paid' },
          client: {
            communication_preferences: row.communication_preferences,
            email_status: row.email_status,
            phone_status: row.phone_status,
          },
          channel: 'email',
        });
        if (!sendCheck.ok) {
          console.log(`[drinkPlanSubmitFastPath] suppressed for plan ${result.rows[0].id}: ${sendCheck.reason}`);
        } else {
          const barOption = row.package_pricing_type === 'per_guest' ? 'hosted' : 'byob';
          const tpl = emailTemplates.drinkPlanBalanceUpdate({
            clientName: row.client_name || 'Client',
            eventTypeLabel: getEventTypeLabel({ event_type: row.event_type, event_type_custom: row.event_type_custom }),
            barOption,
            balanceChanged: false,
            extrasAmount: 0,
            newTotal: Number(row.total_price) || 0,
            amountPaid: Number(row.amount_paid) || 0,
            balanceDue: 0,
            balanceDueDate: row.balance_due_date,
          });
          sendEmail({ to: row.client_email, ...tpl }).catch(e => console.error('Drink-plan submit fast-path email failed:', e));
        }
      }
    } catch (e) {
      console.error('Drink-plan submit fast-path notification lookup failed (non-fatal):', e);
    }
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

/** POST /api/drink-plans/t/:token/logo
 * Public token-gated logo upload. Accepts multipart with field 'logo'.
 * Validates magic bytes + size + extension. Uploads to R2 under
 * drink-plan-logos/<plan-id>-<timestamp>.<ext>. Atomically merges the
 * URL + filename into selections.companyLogo via Postgres jsonb || operator.
 * Returns { logoUrl, selections }.
 */
router.post('/t/:token/logo', logoUploadLimiter, asyncHandler(async (req, res) => {
  const planResult = await pool.query(
    'SELECT id, status FROM drink_plans WHERE token = $1',
    [req.params.token]
  );
  if (!planResult.rows[0]) throw new NotFoundError('Plan not found.');
  const plan = planResult.rows[0];

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
router.get('/t/:token/logo', logoUploadLimiter, asyncHandler(async (req, res) => {
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
            dp.selections, dp.status, dp.admin_notes, dp.exploration_submitted_at,
            dp.submitted_at, dp.created_at, dp.updated_at, dp.created_by,
            u.email AS created_by_email,
            dp.consult_selections IS NOT NULL AS has_consult_selections,
            dp.consult_filled_at, dp.consult_filled_by_user_id,
            cu.email AS consult_filled_by_email,
            dp.shopping_list_source,
            dp.shopping_list IS NOT NULL AS has_shopping_list,
            dp.shopping_list_status, dp.shopping_list_approved_at,
            p.guest_count
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
 *  (has its own endpoint); keep selections for detail rendering. Booleans
 *  (`has_consult_selections`, `has_shopping_list`) keep the JSONB blobs off
 *  the wire — the consult payload itself is only fetched on demand from
 *  GET /:id/consult when the form is opened. */
router.get('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT dp.id, dp.token, dp.proposal_id, dp.client_name, dp.client_email,
            dp.event_type, dp.event_type_custom, dp.event_date, dp.serving_type,
            dp.selections, dp.status, dp.admin_notes, dp.exploration_submitted_at,
            dp.submitted_at, dp.created_at, dp.updated_at, dp.created_by,
            u.email AS created_by_email,
            dp.consult_selections IS NOT NULL AS has_consult_selections,
            dp.consult_filled_at, dp.consult_filled_by_user_id,
            cu.email AS consult_filled_by_email,
            dp.shopping_list_source,
            dp.shopping_list IS NOT NULL AS has_shopping_list,
            dp.shopping_list_status, dp.shopping_list_approved_at,
            p.guest_count
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
  if (!['pending', 'draft', 'submitted', 'reviewed'].includes(status)) {
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

  // Hosted events: we do the shopping, not the client — so the
  // shopping-list-ready email does not apply. BYOB events get the email.
  const pkgRow = await pool.query(`
    SELECT sp.pricing_type
    FROM drink_plans dp
    LEFT JOIN proposals p ON p.id = dp.proposal_id
    LEFT JOIN service_packages sp ON sp.id = p.package_id
    WHERE dp.id = $1
  `, [plan.id]);
  const isHosted = pkgRow.rows[0]?.pricing_type === 'per_guest';

  if (isHosted) {
    console.log(`[shoppingListReady] hosted event, skipping client email for plan ${plan.id}`);
  } else if (plan.client_email && plan.token) {
    // Notify the client. Best-effort — never fail the approval if email blows up.
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

/** POST /api/drink-plans/:id/logo
 * Admin-authenticated logo upload by plan ID. Same validation + R2 upload +
 * atomic JSONB merge as the token-gated route.
 */
router.post('/:id/logo', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
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
  const result = await pool.query('DELETE FROM drink_plans WHERE id = $1 RETURNING id', [req.params.id]);
  if (!result.rows[0]) throw new NotFoundError('Plan not found.');
  res.json({ success: true });
}));

module.exports = router;

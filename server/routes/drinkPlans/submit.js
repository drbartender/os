'use strict';

// PUT /api/drink-plans/t/:token submit handler, extracted from drinkPlans.js
// (which was over the 1000-line hard cap). Behavior-inert extraction: this is
// the exact handler body, its sanitizeSelections helper, and every import it
// used. Mounted in drinkPlans.js behind requireUuidToken + drinkPlanWriteLimiter.

const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { refreshUnlockedInvoices, findOrRefreshExtrasInvoice, findExtrasInvoice, voidExtrasInvoiceWithReconcile, createAdditionalInvoiceIfNeeded } = require('../../utils/invoiceHelpers');
const { foldExtrasIntoProposal, loadRepriceAddons } = require('../../utils/proposalExtrasFold');
const { computeExtrasBreakdown } = require('../../utils/drinkPlanExtras');
const { sendEmail } = require('../../utils/email');
const emailTemplates = require('../../utils/emailTemplates');
const { notifyAdminCategory } = require('../../utils/adminNotifications');
const { getEventTypeLabel } = require('../../utils/eventTypes');
const { shouldSendImmediate } = require('../../utils/messageSuppression');
const { NotFoundError, ConflictError } = require('../../utils/errors');
const { ADMIN_URL, API_URL } = require('../../utils/urls');
const { triggerShoppingListAutoGen } = require('../../utils/shoppingListGen');
const { scheduleMessage } = require('../../utils/messageScheduling');
const { loadHostedCoverageContext, mocktailAddonFor } = require('./coverageContext');
const { drinkPlanEchoSection } = require('../../utils/lifecycleEmailTemplates');

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
  // planner v2 (spec 2026-07-18 §3.1): crowd answers + day-of bar placement/power
  'crowd', 'barPlacement', 'powerAtBar',
  // Data-loss bugfix (found 2026-07-18): the legacy hosted wizard has always
  // written guestPreferences ({balance, naInterest}) but the key was never on
  // this allow-list, so hosted guest-prefs answers were silently dropped at
  // save. v2's display-only taste answers reuse the same key.
  'guestPreferences',
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
  // Planner v2 crowd answers: normalize to the pinned contract shape so
  // garbage from the public token route never reaches the quantity engine.
  if (out.crowd !== undefined) {
    const c = (out.crowd && typeof out.crowd === 'object' && !Array.isArray(out.crowd)) ? out.crowd : {};
    const rawDrinkers = c.drinkers === null || c.drinkers === undefined || c.drinkers === '' ? null : Number(c.drinkers);
    const drinkers = Number.isFinite(rawDrinkers) ? Math.max(0, Math.round(rawDrinkers)) : null;
    const profiles = ['cocktail_forward', 'wine', 'beer', 'even', 'help'];
    out.crowd = {
      drinkers,
      unsure: c.unsure === true || drinkers === null,
      profile: profiles.includes(c.profile) ? c.profile : 'help',
    };
  }
  if (out.barPlacement !== undefined) {
    out.barPlacement = ['indoors', 'outdoors', 'unsure'].includes(out.barPlacement) ? out.barPlacement : 'unsure';
  }
  if (out.powerAtBar !== undefined) {
    out.powerAtBar = ['yes', 'no', 'unsure'].includes(out.powerAtBar) ? out.powerAtBar : 'unsure';
  }
  return out;
}

/** PUT /api/drink-plans/t/:token — save draft or submit (public) */

// Resolve selected drink names and build the confirmation echo section
// (planner v2). Runs in the post-commit tail; pool is correct there. Never
// fatal — a failed echo still sends the base confirmation.
async function buildSelectionsEcho(selections) {
  try {
    const sig = Array.isArray(selections?.signatureDrinks) ? selections.signatureDrinks : [];
    const moc = Array.isArray(selections?.mocktails) ? selections.mocktails : [];
    const [c, m] = await Promise.all([
      sig.length ? pool.query('SELECT id, name FROM cocktails WHERE id = ANY($1::text[])', [sig]) : Promise.resolve({ rows: [] }),
      moc.length ? pool.query('SELECT id, name FROM mocktails WHERE id = ANY($1::text[])', [moc]) : Promise.resolve({ rows: [] }),
    ]);
    const cn = new Map(c.rows.map(r => [r.id, r.name]));
    const mn = new Map(m.rows.map(r => [r.id, r.name]));
    return drinkPlanEchoSection({
      selections: selections || {},
      cocktailNames: sig.map(id => cn.get(id)).filter(Boolean),
      mocktailNames: moc.map(id => mn.get(id)).filter(Boolean),
    });
  } catch (err) {
    console.error('Selections echo build failed (non-fatal):', err.message);
    return { html: '', text: '' };
  }
}

// Enhancement Lab follow-up: one nudge email +36h after a v2 submit (spec
// §3.3). scheduleMessage is idempotent on its tuple, so nothing here can
// double-book. There is NO cancel bookkeeping anywhere: every cancel
// condition (lab addition made, window closed, plan finalized, event inside
// 72h, marketing opt-out) is re-checked at fire time by labFollowupHandler.
// Fire-and-forget from the submit tail; a failure never fails the submit.
async function scheduleLabFollowupAfterSubmit(planId) {
  if (!planId) return;
  try {
    const r = await pool.query(
      `SELECT dp.planner_version, p.id AS proposal_id, p.client_id
         FROM drink_plans dp
         JOIN proposals p ON p.id = dp.proposal_id
        WHERE dp.id = $1`,
      [planId]
    );
    const row = r.rows[0];
    if (!row || row.planner_version < 2 || !row.client_id) return;
    await scheduleMessage({
      entityType: 'proposal',
      entityId: row.proposal_id,
      messageType: 'lab_followup',
      recipientType: 'client',
      recipientId: row.client_id,
      channel: 'email',
      scheduledFor: new Date(Date.now() + 36 * 60 * 60 * 1000),
    });
  } catch (err) {
    console.error('lab_followup scheduling failed (non-fatal):', err.message);
  }
}

async function handleSubmit(req, res) {
  const { serving_type, status, paid_separately } = req.body;
  const selections = sanitizeSelections(req.body.selections);
  const paidSeparately = paid_separately === true;

  // Check plan exists and is not already submitted. JOIN proposals + clients
  // so the post-commit suppression check (shouldSendImmediate) can see the
  // proposal status and the client's comm-prefs / contact-status. Without the
  // JOIN those columns are undefined and suppression is silently bypassed.
  // LEFT JOINs keep behavior identical for plans with no linked proposal/client.
  const existing = await pool.query(
    `SELECT dp.id, dp.status, dp.proposal_id, dp.finalized_at,
            dp.client_name, dp.client_email,
            dp.event_type, dp.event_type_custom, dp.planner_version,
            p.status AS proposal_status,
            sp.category AS package_category,
            sp.bar_type AS package_bar_type,
            c.id AS client_id,
            c.email AS live_client_email, c.name AS live_client_name,
            c.communication_preferences, c.email_status, c.phone_status
     FROM drink_plans dp
     LEFT JOIN proposals p ON p.id = dp.proposal_id
     LEFT JOIN service_packages sp ON sp.id = p.package_id
     LEFT JOIN clients c ON c.id = p.client_id
     WHERE dp.token = $1`,
    [req.params.token]
  );
  if (!existing.rows[0]) throw new NotFoundError('This drink plan link is no longer valid');
  if (existing.rows[0].finalized_at) throw new ConflictError('This plan has been finalized; reach out if you need a change.');
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
  // The Jack rule (planner v2, spec §3.2): on a hosted non-mocktail package,
  // picked mocktails price via exactly one addon (1 flavor = pre-batched,
  // 2+ = full Mocktail Bar), derived SERVER-side from the picks — the
  // client's addOns are never trusted for this pair. Counted up front so a
  // mocktail-only hosted submit still takes the atomic financial path.
  // VERSION GATE (2026-07-18 push review): the rule applies ONLY to v2 plans —
  // the flip price is disclosed only by the v2 hosted wizard. Legacy v1 picks
  // stay informational and the pair slugs bill only as ordinary user-added
  // addons; version-blind enforcement would bill legacy clients undisclosed
  // per-guest charges (the 2026-07-16 incident class).
  const isHostedNonMocktail = existing.rows[0].package_category === 'hosted'
    && existing.rows[0].package_bar_type !== 'mocktail';
  const plannerV2Plan = Number(existing.rows[0].planner_version) >= 2;
  const mocktailPickCount = Array.isArray(selections?.mocktails) ? selections.mocktails.length : 0;
  const hostedMocktailFlipSlug = isHostedNonMocktail && plannerV2Plan
    ? mocktailAddonFor(mocktailPickCount)
    : null;
  const hasFinancialSideEffects =
    newStatus === 'submitted'
    && !!existing.rows[0].proposal_id
    && (rawAddonSlugs.length > 0 || addBarRental || hostedMocktailFlipSlug !== null);

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
      // The bar-rental fee is priced on the client's num_bars BEFORE this submit
      // increments it below (matching what create-intent charged). Capture it now
      // so the extras invoice bar-rental line matches the Stripe charge.
      const numBarsAtIntent = proposal ? (proposal.num_bars || 0) : 0;
      // F2: snapshot the pre-extras total (cents) BEFORE the total_price UPDATE
      // below, so the add-to-balance branch bills only the delta via
      // createAdditionalInvoiceIfNeeded (mirrors crud.js oldTotalCents). Declared
      // at transaction scope because the pricing block and the invoice block are
      // separate `if (proposal)` scopes. proposal.total_price is the pre-UPDATE
      // dollar value (the DB UPDATE never mutates this JS object).
      const oldTotalCents = Math.round(Number(proposal?.total_price || 0) * 100);

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
              'SELECT id, upgrade_addon_slugs, ingredients FROM cocktails WHERE id = ANY($1::text[])',
              [sigDrinkIds]
            )).rows
          : [];
        const cocktailById = new Map(cocktailRows.map(r => [r.id, r]));
        // Planner v2: recipe-derived fence picks (mocktails included) validate
        // through the coverage engine when the package has structured contents.
        // Uses the HELD transaction client (one-connection rule).
        const mocktailPickIds = Array.isArray(selections?.mocktails) ? selections.mocktails : [];
        const mocktailRows = mocktailPickIds.length > 0
          ? (await client.query('SELECT id, ingredients FROM mocktails WHERE id = ANY($1::text[])', [mocktailPickIds])).rows
          : [];
        const mocktailById = new Map(mocktailRows.map(r => [r.id, r]));
        const coverageCtx = existing.rows[0].package_category === 'hosted'
          ? await loadHostedCoverageContext(client, proposal.package_id)
          : null;
        // Enforcement gate: v2 plan AND contents entered (coverageCtx is null
        // until the package has package_items) — exactly the cohort whose UI
        // (HostedDrinksV2 fence badges + rate lines) disclosed the flip price
        // before submit. Final Jack-rule slug from RESOLVED picks only — an id
        // that matches no real mocktail never bills.
        const flipEnforced = isHostedNonMocktail && plannerV2Plan && coverageCtx !== null;
        const resolvedFlipSlug = flipEnforced ? mocktailAddonFor(mocktailRows.length) : null;
        const gapSlugCache = new Map();
        const coverageGapSlugsFor = (drinkRow) => {
          if (!coverageCtx || !drinkRow) return [];
          if (!gapSlugCache.has(drinkRow.id)) {
            const verdict = coverageCtx.classifyDrink(drinkRow);
            gapSlugCache.set(drinkRow.id, verdict.status === 'fenced' ? verdict.gapAddonSlugs : []);
          }
          return gapSlugCache.get(drinkRow.id);
        };

        // For each autoAdded addon, require a still-selected triggering cocktail whose
        // upgrade_addon_slugs includes the slug AND the package does not cover it.
        const addonSlugs = rawAddonSlugs.filter(slug => {
          const meta = rawAddons[slug];
          if (coveredAddonSlugs.includes(slug)) return false; // package already covers — never charge
          if (meta?.autoAdded) {
            const triggers = Array.isArray(meta.triggeredBy) ? meta.triggeredBy : [];
            const validTrigger = triggers.some(drinkId => {
              const c = cocktailById.get(drinkId) || mocktailById.get(drinkId);
              if (!c) return false;
              if (Array.isArray(c.upgrade_addon_slugs) && c.upgrade_addon_slugs.includes(slug)) return true;
              // planner v2 fence: the coverage engine says this drink's gap
              // is priced by this addon on this package
              return coverageGapSlugsFor(c).includes(slug);
            });
            return validTrigger;
          }
          return true; // user-added addon — honor it
        });

        // Enforce the server-derived mocktail flip: exactly the right one of
        // the pre-batched/mocktail-bar pair, regardless of what the client sent.
        if (flipEnforced) {
          for (const pairSlug of ['pre-batched-mocktail', 'mocktail-bar']) {
            const idx = addonSlugs.indexOf(pairSlug);
            if (pairSlug !== resolvedFlipSlug && idx !== -1) addonSlugs.splice(idx, 1);
            if (pairSlug === resolvedFlipSlug && idx === -1 && !coveredAddonSlugs.includes(pairSlug)) {
              addonSlugs.push(pairSlug);
            }
          }
        }

        // Build the specialty_upgrades payload for activity-log enrichment.
        const specialtyUpgrades = addonSlugs
          .filter(slug => rawAddons[slug]?.autoAdded)
          .map(slug => ({
            slug,
            triggeredBy: (rawAddons[slug].triggeredBy || []).filter(drinkId => cocktailById.has(drinkId)),
          }));

        // Pre-extras catalog baseline. Captured BEFORE the num_bars increment
        // and the add-on upsert below, so a negotiated proposal can price the
        // delta of exactly what the client just added. numBarsAtIntent is the
        // pre-increment count (the same value computeExtrasBreakdown keys the
        // first-vs-additional bar fee off). Syrups come off the pre-update
        // snapshot for the same reason.
        // Reprice-ready rows (carry pa.quantity so per_hour addons —
        // additional-bartender/banquet-server/barback — keep their real count;
        // bare sa.* dropped it and under-priced them as quantity 1). Shared
        // with the Enhancement Lab via loadRepriceAddons.
        const preAddonsRes = { rows: await loadRepriceAddons(client, proposal.id) };
        const preSyrups = proposal.pricing_snapshot?.syrups?.selections || [];

        // Reconcile a PRE-EXISTING opposite-pair mocktail row on the proposal
        // (security-review + database-review 2026-07-18): the upsert loop only
        // adds; without this delete an admin-seeded pre-batched row would bill
        // alongside a newly-flipped mocktail-bar. Ordered AFTER the
        // preAddonsRes baseline capture so the override path's catalogBefore
        // still contains the removed row and the delta CREDITS it, and BEFORE
        // the upsert + total recalc so the post-state sums correctly.
        // Runs ONLY when a flip actually resolved: on null (no or unresolvable
        // picks) delete NOTHING — a client submit must never strip or credit
        // an admin-seeded or previously purchased pair row (2026-07-18 push
        // review; removal flows through the ordinary addon paths instead).
        if (flipEnforced && resolvedFlipSlug !== null) {
          const staleSlugs = ['pre-batched-mocktail', 'mocktail-bar'].filter(s => s !== resolvedFlipSlug);
          await client.query(
            `DELETE FROM proposal_addons
              WHERE proposal_id = $1
                AND addon_id IN (SELECT id FROM service_addons WHERE slug = ANY($2::text[]))`,
            [proposal.id, staleSlugs]
          );
        }

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

        // Recalculate proposal total with all addons (existing + new).
        // Reprice-ready rows (pa.quantity preserved) — see preAddonsRes above.
        const allAddonsRes = { rows: await loadRepriceAddons(client, proposal.id) };
        const pkgRes = await client.query('SELECT * FROM service_packages WHERE id = $1', [proposal.package_id]);
        const pkg = pkgRes.rows[0];

        if (pkg && proposal.guest_count && proposal.event_duration_hours) {
          const rawSyrups = selections.syrupSelections || {};
          const allSyrupIds = Array.isArray(rawSyrups)
            ? rawSyrups
            : [...new Set(Object.values(rawSyrups).flat())];
          // Self-provided syrups are brought by the client and never priced
          // (matches drinkPlanExtras.js). (calculateSyrupCost additionally drops
          // any non-catalog id.)
          // Array.isArray guard: this is a public token payload, so a non-array
          // syrupSelfProvided (e.g. {}) would otherwise throw on .includes.
          const selfProvidedSyrups = Array.isArray(selections.syrupSelfProvided)
            ? selections.syrupSelfProvided
            : [];
          const dropSelfProvided = (id) => !selfProvidedSyrups.includes(id);
          const syrupSels = allSyrupIds.filter(dropSelfProvided);
          // Filter self-provided out of BOTH delta legs symmetrically. If it were
          // stripped from `after` only, a client marking an already-CONTRACTED
          // syrup (one in the snapshot -> priced into catalogBefore) as
          // self-provided would push a negative delta and shave the negotiated
          // contract — a client-driven contract mutation on a public route. New
          // self-provided syrups aren't in preSyrups anyway, so this is a no-op
          // for them; the net effect is that self-provided is neutral to the delta.
          const preSyrupsPriced = preSyrups.filter(dropSelfProvided);

          // Contract-safe reprice + payment-status re-eval. The override-delta
          // math (Jack Van Dyke lesson), snapshot recompute, total/override
          // write, and F2 balance_paid demotion moved VERBATIM to
          // utils/proposalExtrasFold.js so the Enhancement Lab folds through
          // the exact same sequence (one money path, two callers). Mutates
          // proposal.status in memory on demotion, as before.
          const { snapshot } = await foldExtrasIntoProposal({
            client,
            proposal,
            pkg,
            addonsBefore: preAddonsRes.rows,
            addonsAfter: allAddonsRes.rows,
            syrupsBefore: preSyrupsPriced,
            syrupsAfter: syrupSels,
            numBarsBefore: numBarsAtIntent,
            numBarsAfter: proposal.num_bars ?? 0,
            statusChangeReason: 'drink_plan_extras_reconciled',
          });

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
            // Live client record first, plan snapshot as fallback (fix-list
            // 2026-07-18: the old `proposal.client_email` fallback was always
            // undefined — proposals has no such column — so this path emailed
            // the stale drink_plans snapshot; Brandon-class stale-recipient
            // shape. Mirrors the fast path's live c.email resolution.
            clientName: existing.rows[0]?.live_client_name || existing.rows[0]?.client_name || 'Client',
            clientEmail: existing.rows[0]?.live_client_email || existing.rows[0]?.client_email,
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

      // Pay-now extras (paid_separately) land on their own "Drink Plan Extras"
      // invoice, created/refreshed at submit so an abandoned card still leaves a
      // real unpaid invoice; the Balance invoice refresh is skipped for pay-now.
      // Add-to-balance folds the extras into the Balance invoice as before. Skip
      // both when the proposal row was deleted between the existence check and
      // the FOR UPDATE lock. Failure here is FATAL — a rolled-back refresh/invoice
      // rolls back the plan UPDATE, so the client retries cleanly.
      if (proposal) {
        if (paidSeparately) {
          const bd = await computeExtrasBreakdown(
            { selections, guestCount: proposal.guest_count, pricingSnapshot: proposal.pricing_snapshot, numBars: numBarsAtIntent },
            client
          );
          if (bd.totalCents > 0) {
            await findOrRefreshExtrasInvoice(
              { proposalId: proposal.id, drinkPlanId: updatedPlan.id, breakdown: bd,
                selections, guestCount: proposal.guest_count, pricingSnapshot: proposal.pricing_snapshot, numBars: numBarsAtIntent },
              client
            );
          }
        } else {
          // Re-submit as add-to-balance: void any standing UNPAID extras invoice
          // BEFORE the Balance refresh rebuilds from the extras-inclusive
          // total_price, or the add-on portion is invoiced twice. Do NOT reduce
          // total_price here — the add-on stays in total_price and flows onto the
          // rebuilt Balance invoice. A paid extras invoice is locked and already
          // netted by refreshUnlockedInvoices, so it is left alone. NOTE: only
          // reachable via an admin reset-to-draft — the submit-once gate above
          // blocks ordinary re-submits, so a standing extras invoice is rare here.
          const standing = await findExtrasInvoice(proposal.id, client);
          if (standing && Number(standing.amount_paid) === 0) {
            await voidExtrasInvoiceWithReconcile(standing.id, null, client, {
              reconcileTotalPrice: false,
              reason: 'resubmit_add_to_balance',
            });
          }
          await refreshUnlockedInvoices(proposal.id, client);
          // F2: a fully-paid proposal's invoices are LOCKED, so the refresh above
          // can't re-bill the extras delta. Mirror crud.js: raise a separate
          // "Additional Services" invoice for (newTotal - oldTotal). No-op when no
          // locked invoice exists or the delta is <= 0 (idempotent on any
          // admin-reset re-submit: oldTotalCents == newTotalCents -> null).
          await createAdditionalInvoiceIfNeeded(proposal.id, oldTotalCents, client);
        }
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
          const echo = await buildSelectionsEcho(selections);
          sendEmail({
            to: clientEmail,
            ...tpl,
            html: echo.html ? tpl.html.replace('</body>', `${echo.html}</body>`) : tpl.html,
            text: `${tpl.text || ''}${echo.text}`,
            meta: { proposalId: pn.id, messageType: 'drink_plan_ready' },
          }).catch(emailErr => console.error('Client drink-plan confirmation email failed:', emailErr));
        }
      }
    }

    // Auto-generate the shopping list now that the plan is submitted. Runs
    // outside the transaction (best-effort, non-fatal) — admin can still
    // generate manually from the modal if this misses.
    if (newStatus === 'submitted') {
      triggerShoppingListAutoGen(updatedPlan?.id);
      scheduleLabFollowupAfterSubmit(updatedPlan?.id);
    }

    return res.json(updatedPlan);
  }

  // Fast path: drafts or submit-without-addons. This also covers syrup-only
  // pay-now, which now creates a "Drink Plan Extras" invoice inside a transaction
  // (syrups are additive money that never fold into total_price, so an abandoned
  // card would otherwise leave them uncollected and invisible).
  let result;
  const needsExtrasInvoice =
    newStatus === 'submitted' && paidSeparately && !!existing.rows[0].proposal_id;

  if (needsExtrasInvoice) {
    // Transactional: plan UPDATE + proposal FOR UPDATE lock + find-or-refresh the
    // extras invoice, atomically. Do NOT refresh the Balance invoice — pay-now
    // extras live on their own invoice.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      result = await client.query(`
        UPDATE drink_plans SET
          serving_type = COALESCE($1, serving_type),
          selections = COALESCE($2::jsonb, selections),
          status = $3,
          submitted_at = COALESCE($4, submitted_at),
          exploration_submitted_at = COALESCE($5, exploration_submitted_at)
        WHERE token = $6
        RETURNING id, token, status, serving_type, submitted_at, proposal_id
      `, [serving_type || null, selections ? JSON.stringify(selections) : null, newStatus, submittedNow, explorationNow, req.params.token]);

      if (result.rows[0]) {
        const propRes = await client.query(
          'SELECT id, guest_count, pricing_snapshot, num_bars FROM proposals WHERE id = $1 FOR UPDATE',
          [result.rows[0].proposal_id]
        );
        const proposal = propRes.rows[0];
        if (proposal) {
          const bd = await computeExtrasBreakdown(
            { selections, guestCount: proposal.guest_count, pricingSnapshot: proposal.pricing_snapshot, numBars: proposal.num_bars },
            client
          );
          if (bd.totalCents > 0) {
            await findOrRefreshExtrasInvoice(
              { proposalId: proposal.id, drinkPlanId: result.rows[0].id, breakdown: bd,
                selections, guestCount: proposal.guest_count, pricingSnapshot: proposal.pricing_snapshot, numBars: proposal.num_bars },
              client
            );
          }
        }
      }
      await client.query('COMMIT');
    } catch (txErr) {
      try { await client.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(txErr, {
          tags: { route: 'drinkPlans/putToken', op: 'submit_extras_invoice' },
          extra: { token: req.params.token, proposalId: existing.rows[0].proposal_id },
        });
      }
      console.error('Drink-plan submit (extras invoice) transaction failed:', txErr);
      throw txErr; // surface as 5xx so client can retry instead of seeing a phantom success
    } finally {
      client.release();
    }
  } else if (newStatus === 'draft') {
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
          const echo = await buildSelectionsEcho(selections);
          sendEmail({
            to: row.client_email,
            ...tpl,
            html: echo.html ? tpl.html.replace('</body>', `${echo.html}</body>`) : tpl.html,
            text: `${tpl.text || ''}${echo.text}`,
            meta: { proposalId: row.id, messageType: 'drink_plan_ready' },
          }).catch(e => console.error('Drink-plan submit fast-path email failed:', e));
        }
      }
    } catch (e) {
      console.error('Drink-plan submit fast-path notification lookup failed (non-fatal):', e);
    }
  }

  // Fast-path submit (no add-ons) also auto-generates the shopping list draft
  // for admin review. Best-effort — same fail-open contract as the financial
  // branch above.
  if (newStatus === 'submitted') {
    triggerShoppingListAutoGen(result.rows[0]?.id);
    scheduleLabFollowupAfterSubmit(result.rows[0]?.id);
  }

  res.json(result.rows[0]);
}

module.exports = { handleSubmit, sanitizeSelections };

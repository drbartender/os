// Admin consult-form routes — alternate input path for shopping lists.
// Mounted under /api/drink-plans alongside the main drinkPlans router.
//
// Workflow: when a client doesn't fill out the potion planner, the admin
// captures their phone/email-consult info via the consult form on the drink
// plan detail page. This produces `consult_selections` and a generator-derived
// `shopping_list` in `pending_review` state — same approval/email/public-token
// pipeline as a planner-derived list. The source toggle lets admin switch
// between planner-derived and consult-derived output when both exist.

const express = require('express');
const { pool } = require('../db');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError } = require('../utils/errors');
const { ensureNotFinalized } = require('../utils/beoFinalize');
const { generateShoppingList } = require('../utils/shoppingList');
const {
  buildPlannerGeneratorInput,
  buildConsultGeneratorInput,
  loadCatalog,
  reportUnresolvedIngredients,
} = require('../utils/shoppingListGen');

const router = express.Router();

// Side-effect helper: when the admin saves the consult form for a drink plan
// linked to a proposal, flip any past-scheduled consults rows for that
// proposal to 'completed'. Fire-and-forget — a flip failure must NOT roll
// back the consult save itself (the user's primary action). Errors land in
// the log + Sentry so an operator can chase them.
async function performConsultsCompletionFlip(client, proposalId) {
  // Guard both null AND undefined — written long-form to satisfy `eqeqeq`.
  // Critical: the SELECT at the call site MUST include `dp.proposal_id` or
  // this short-circuits silently in production despite tests passing (tests
  // call this helper directly with a non-null id).
  if (proposalId === null || proposalId === undefined) return;
  try {
    await client.query(
      `UPDATE consults
       SET status = 'completed'
       WHERE proposal_id = $1
         AND status = 'scheduled'
         AND scheduled_at <= NOW()`,
      [proposalId]
    );
  } catch (flipErr) {
    // Fire-and-forget: do NOT roll back the consult save just because the
    // side-effect flip failed. Log + Sentry so operator can chase it.
    console.error('[drinkPlanConsult] consults status flip failed (non-fatal):', flipErr);
    if (process.env.SENTRY_DSN_SERVER) {
      try {
        const Sentry = require('@sentry/node');
        Sentry.captureException(flipErr, {
          tags: { route: 'drinkPlanConsult/putConsult', step: 'consults_complete_flip' },
          extra: { proposalId },
        });
      } catch (_) { /* sentry optional */ }
    }
  }
}

const VALID_BAR_TYPES = ['full_bar', 'sig_beer_wine', 'beer_wine', 'mocktails'];
const VALID_MIXER_MODES = ['full', 'matching', 'none'];
const MAX_LIST_ITEMS = 50;        // signatureDrinks, mocktails, customCocktails, customMocktails
const MAX_NOTES_LEN = 2000;
const MAX_INGREDIENTS_PER_DRINK = 30;
const MAX_INGREDIENT_LEN = 200;
const MAX_NAME_LEN = 200;

// Allow-list and shape-validate the consult payload. Strips unknown keys so
// JSONB only stores fields the rest of the system understands. Throws
// ValidationError on shape/size violations; returns the cleaned object.
function sanitizeConsult(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError({ consult: 'Invalid consult payload.' });
  }
  const out = {};
  if (raw.barType !== undefined) {
    if (!VALID_BAR_TYPES.includes(raw.barType)) {
      throw new ValidationError({ barType: 'Invalid bar type.' });
    }
    out.barType = raw.barType;
  }
  if (raw.mixers !== undefined) {
    if (!VALID_MIXER_MODES.includes(raw.mixers)) {
      throw new ValidationError({ mixers: 'Invalid mixer mode.' });
    }
    out.mixers = raw.mixers;
  }
  const stringArrayField = (key, max = MAX_LIST_ITEMS) => {
    if (raw[key] === undefined) return;
    if (!Array.isArray(raw[key])) throw new ValidationError({ [key]: `${key} must be an array.` });
    if (raw[key].length > max) throw new ValidationError({ [key]: `${key} exceeds ${max} items.` });
    out[key] = raw[key].map(v => String(v));
  };
  stringArrayField('spirits', 20);
  stringArrayField('signatureDrinks');
  stringArrayField('mocktails');
  stringArrayField('wine', 10);

  const customDrinkArrayField = (key) => {
    if (raw[key] === undefined) return;
    if (!Array.isArray(raw[key])) throw new ValidationError({ [key]: `${key} must be an array.` });
    if (raw[key].length > MAX_LIST_ITEMS) {
      throw new ValidationError({ [key]: `${key} exceeds ${MAX_LIST_ITEMS} items.` });
    }
    out[key] = raw[key].map((item, i) => {
      if (!item || typeof item !== 'object') {
        throw new ValidationError({ [key]: `${key}[${i}] must be an object.` });
      }
      const name = String(item.name || '').slice(0, MAX_NAME_LEN);
      if (!name) throw new ValidationError({ [key]: `${key}[${i}].name required.` });
      const ingredientsRaw = Array.isArray(item.ingredients) ? item.ingredients : [];
      if (ingredientsRaw.length > MAX_INGREDIENTS_PER_DRINK) {
        throw new ValidationError({
          [key]: `${key}[${i}].ingredients exceeds ${MAX_INGREDIENTS_PER_DRINK}.`,
        });
      }
      const ingredients = ingredientsRaw.map(s => String(s).slice(0, MAX_INGREDIENT_LEN));
      return { name, ingredients };
    });
  };
  customDrinkArrayField('customCocktails');
  customDrinkArrayField('customMocktails');

  if (raw.beer !== undefined) out.beer = Boolean(raw.beer);
  if (raw.mocktailsEnabled !== undefined) out.mocktailsEnabled = Boolean(raw.mocktailsEnabled);
  if (raw.notes !== undefined) {
    out.notes = String(raw.notes || '').slice(0, MAX_NOTES_LEN);
  }
  if (raw.guestCountOverride !== undefined && raw.guestCountOverride !== null) {
    const gc = Number(raw.guestCountOverride);
    if (!Number.isFinite(gc) || gc < 0 || !Number.isInteger(gc)) {
      throw new ValidationError({ guestCountOverride: 'Must be a non-negative integer.' });
    }
    out.guestCountOverride = gc;
  } else if (raw.guestCountOverride === null) {
    out.guestCountOverride = null;
  }
  return out;
}

/** GET /api/drink-plans/:id/consult — fetch consult-form payload for pre-population.
 *  Returns the raw consult_selections so the form can re-open with the admin's
 *  prior input intact. Empty object when nothing's been saved yet. */
router.get('/:id/consult', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT consult_selections, consult_filled_at, consult_filled_by_user_id
     FROM drink_plans WHERE id = $1`,
    [req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Plan not found.');
  res.json({
    consult_selections: result.rows[0].consult_selections || null,
    consult_filled_at: result.rows[0].consult_filled_at || null,
    consult_filled_by_user_id: result.rows[0].consult_filled_by_user_id || null,
  });
}));

/** PUT /api/drink-plans/:id/consult — save admin consult-form payload, run the
 *  generator, persist the resulting shopping list as `pending_review`. Atomic
 *  in a single transaction: the consult_selections, audit fields, source flag,
 *  and shopping_list all move together. Re-runnable — submitting again
 *  overwrites the prior consult and regenerates. */
router.put('/:id/consult', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  await ensureNotFinalized(parseInt(req.params.id, 10));
  const consult = sanitizeConsult(req.body?.consult);

  // Function scope so the post-commit email block (after the finally) can read it.
  let isFirstTimeConsultSave = false;

  // Catalog load stays OUTSIDE the transaction: a failed read degrades to the
  // legacy constants inside generateShoppingList (Sentry-reported) and can
  // never roll back the admin's consult save.
  const catalog = await loadCatalog(pool);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const planRes = await client.query(
      `SELECT dp.id, dp.client_name, dp.event_date, dp.admin_notes,
              dp.consult_filled_at, dp.proposal_id,
              p.guest_count
       FROM drink_plans dp
       LEFT JOIN proposals p ON p.id = dp.proposal_id
       WHERE dp.id = $1
       FOR UPDATE OF dp`,
      [req.params.id]
    );
    if (!planRes.rows[0]) {
      await client.query('ROLLBACK');
      throw new NotFoundError('Plan not found.');
    }
    const plan = planRes.rows[0];
    plan.consult_selections = consult;
    // First-time save vs re-submit. Captured before COMMIT (no DB touch here);
    // read by the post-commit email block after the finally boundary.
    isFirstTimeConsultSave = (plan.consult_filled_at === null || plan.consult_filled_at === undefined);

    const overrideGc = Number(consult.guestCountOverride) || 0;
    if (overrideGc > 0) plan.guest_count = overrideGc;
    if (!plan.guest_count) {
      await client.query('ROLLBACK');
      throw new ValidationError({
        guestCountOverride: 'Guest count is required — set it on the proposal or override here.',
      });
    }

    const input = await buildConsultGeneratorInput(plan, client);
    const list = generateShoppingList(input, catalog);

    await client.query(
      `UPDATE drink_plans
         SET consult_selections = $1::jsonb,
             consult_filled_by_user_id = $2,
             consult_filled_at = NOW(),
             shopping_list = $3::jsonb,
             shopping_list_status = 'pending_review',
             shopping_list_approved_at = NULL,
             shopping_list_source = 'consult',
             updated_at = NOW()
       WHERE id = $4`,
      [JSON.stringify(consult), req.user.id, JSON.stringify(list), req.params.id]
    );

    // Flip linked Cal.com consults row to 'completed' as a side effect of
    // the admin saving the consult form. See spec §6. Wrapped (inside the
    // helper) to not roll back the consult save on flip failure.
    await performConsultsCompletionFlip(client, plan.proposal_id);

    await client.query('COMMIT');
    reportUnresolvedIngredients(list, 'consult_save');
    res.json({ success: true, shopping_list_source: 'consult' });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* swallow rollback failure */ }
    throw err;
  } finally {
    client.release();
  }

  // AFTER the finally boundary — post-commit work is fully isolated from the
  // transaction frame. Any throw here is caught locally and never rolls back
  // the (already-committed) consult save or surfaces as a 5xx.
  if (isFirstTimeConsultSave) {
    try {
      const { sendEmail } = require('../utils/email');
      const emailTemplates = require('../utils/emailTemplates');
      const { getEventTypeLabel } = require('../utils/eventTypes');
      const { formatConsultRecap, pickNextStepLine } = require('../utils/consultRecap');
      const { shouldSendImmediate } = require('../utils/messageSuppression');

      const lookup = await pool.query(`
        SELECT dp.client_email, dp.client_name, dp.event_type, dp.event_type_custom, dp.event_date,
               p.id AS proposal_id, p.status AS proposal_status,
               c.communication_preferences, c.email_status, c.phone_status,
               sp.pricing_type AS package_pricing_type
        FROM drink_plans dp
        LEFT JOIN proposals p ON p.id = dp.proposal_id
        LEFT JOIN clients c ON c.id = p.client_id
        LEFT JOIN service_packages sp ON sp.id = p.package_id
        WHERE dp.id = $1
      `, [req.params.id]);

      if (lookup.rows[0]?.client_email) {
        const row = lookup.rows[0];
        const sendCheck = await shouldSendImmediate({
          proposal: { id: row.proposal_id, status: row.proposal_status || 'deposit_paid' },
          client: {
            communication_preferences: row.communication_preferences,
            email_status: row.email_status,
            phone_status: row.phone_status,
          },
          channel: 'email',
        });
        if (!sendCheck.ok) {
          console.log(`[postConsultClient] suppressed for plan ${req.params.id}: ${sendCheck.reason}`);
        } else {
          const barOption = row.package_pricing_type === 'per_guest' ? 'hosted' : 'byob';
          const formattedEventDate = row.event_date
            ? new Date(row.event_date).toLocaleDateString('en-US', {
                timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
              })
            : null;
          const tpl = emailTemplates.postConsultClient({
            clientName: row.client_name || 'there',
            eventTypeLabel: getEventTypeLabel({ event_type: row.event_type, event_type_custom: row.event_type_custom }),
            formattedEventDate,
            drinkRecapLines: formatConsultRecap(consult),
            nextStepLine: pickNextStepLine(barOption),
          });
          // Fire-and-forget — the .catch keeps an async rejection from
          // escaping as an unhandled-rejection warning.
          sendEmail({ to: row.client_email, ...tpl }).catch(emailErr => {
            console.error('[postConsultClient] send failed (non-fatal):', emailErr);
            if (process.env.SENTRY_DSN_SERVER) {
              const Sentry = require('@sentry/node');
              Sentry.captureException(emailErr, {
                tags: { route: 'drinkPlanConsult/putConsult', step: 'postConsultClient' },
                extra: { planId: req.params.id },
              });
            }
          });
        }
      }
    } catch (recapErr) {
      // Anything that throws during lookup/templating gets logged but NEVER
      // rethrown. The consult save itself succeeded and the response was
      // already sent before we got here.
      console.error('[postConsultClient] post-commit step failed (non-fatal):', recapErr);
      if (process.env.SENTRY_DSN_SERVER) {
        const Sentry = require('@sentry/node');
        Sentry.captureException(recapErr, {
          tags: { route: 'drinkPlanConsult/putConsult', step: 'postConsult_lookup' },
          extra: { planId: req.params.id },
        });
      }
    }
  }
}));

/** PATCH /api/drink-plans/:id/shopping-list-source — flip the active source
 *  between 'planner' and 'consult'. Validates the requested source has data,
 *  regenerates from that source, resets `shopping_list_status` to
 *  `pending_review` so admin re-approves before client sees the new numbers. */
router.patch('/:id/shopping-list-source', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  await ensureNotFinalized(parseInt(req.params.id, 10));
  const { source } = req.body;
  if (!['planner', 'consult'].includes(source)) {
    throw new ValidationError({ source: 'Source must be "planner" or "consult".' });
  }

  // Outside the transaction, same rationale as the consult-save route above.
  const catalog = await loadCatalog(pool);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const planRes = await client.query(
      `SELECT dp.id, dp.serving_type, dp.selections, dp.consult_selections,
              dp.client_name, dp.event_date, dp.admin_notes,
              p.guest_count
       FROM drink_plans dp
       LEFT JOIN proposals p ON p.id = dp.proposal_id
       WHERE dp.id = $1
       FOR UPDATE OF dp`,
      [req.params.id]
    );
    if (!planRes.rows[0]) {
      await client.query('ROLLBACK');
      throw new NotFoundError('Plan not found.');
    }
    const plan = planRes.rows[0];

    if (source === 'planner' && !plan.selections) {
      await client.query('ROLLBACK');
      throw new ConflictError('No planner submission exists yet for this plan.');
    }
    if (source === 'consult' && !plan.consult_selections) {
      await client.query('ROLLBACK');
      throw new ConflictError('No consult-form input exists yet for this plan.');
    }
    if (!plan.guest_count && source === 'planner') {
      await client.query('ROLLBACK');
      throw new ValidationError({ guest_count: 'Guest count is required to generate a shopping list.' });
    }

    const input = source === 'planner'
      ? await buildPlannerGeneratorInput(plan, client)
      : await buildConsultGeneratorInput(plan, client);
    const list = generateShoppingList(input, catalog);

    await client.query(
      `UPDATE drink_plans
         SET shopping_list = $1::jsonb,
             shopping_list_status = 'pending_review',
             shopping_list_approved_at = NULL,
             shopping_list_source = $2,
             updated_at = NOW()
       WHERE id = $3`,
      [JSON.stringify(list), source, req.params.id]
    );

    await client.query('COMMIT');
    reportUnresolvedIngredients(list, 'source_switch');
    res.json({ success: true, shopping_list_source: source });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* swallow rollback failure */ }
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
module.exports.performConsultsCompletionFlip = performConsultsCompletionFlip;

const express = require('express');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const { calculateProposal } = require('../utils/pricingEngine');
const { sendEmail } = require('../utils/email');

const router = express.Router();

// ─── Permission helper ──────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.user.role === 'admin' || req.user.role === 'manager') return next();
  return res.status(403).json({ error: 'Admin access required.' });
}

// ─── Public routes (token-based) ─────────────────────────────────

/** GET /api/drink-plans/t/:token/shopping-list — public shopping list for clients */
router.get('/t/:token/shopping-list', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT dp.shopping_list, dp.client_name, dp.event_name, dp.event_date, dp.status
       FROM drink_plans dp WHERE dp.token = $1`,
      [req.params.token]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Plan not found.' });
    const plan = result.rows[0];
    if (!plan.shopping_list) {
      return res.json({
        ready: false,
        client_name: plan.client_name,
        event_name: plan.event_name,
        event_date: plan.event_date,
      });
    }
    res.json({
      ready: true,
      shopping_list: plan.shopping_list,
      client_name: plan.client_name,
      event_name: plan.event_name,
      event_date: plan.event_date,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/drink-plans/t/:token — fetch plan by token (public) */
router.get('/t/:token', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT dp.id, dp.token, dp.client_name, dp.client_email, dp.event_name, dp.event_date,
              dp.status, dp.serving_type, dp.selections, dp.submitted_at, dp.created_at,
              dp.proposal_id, dp.exploration_submitted_at,
              p.guest_count, p.num_bartenders, p.num_bars, p.pricing_snapshot,
              p.status AS proposal_status
       FROM drink_plans dp
       LEFT JOIN proposals p ON p.id = dp.proposal_id
       WHERE dp.token = $1`,
      [req.params.token]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Plan not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PUT /api/drink-plans/t/:token — save draft or submit (public) */
router.put('/t/:token', async (req, res) => {
  const { serving_type, selections, status } = req.body;
  try {
    // Check plan exists and is not already submitted
    const existing = await pool.query(
      'SELECT id, status, proposal_id, client_name, event_name FROM drink_plans WHERE token = $1',
      [req.params.token]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'Plan not found.' });
    if (existing.rows[0].status === 'submitted' || existing.rows[0].status === 'reviewed') {
      return res.status(400).json({ error: 'This plan has already been submitted.' });
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

    // Process addons into proposal on submit
    if (newStatus === 'submitted' && updatedPlan.proposal_id && selections?.addOns) {
      const addonSlugs = Object.keys(selections.addOns).filter(slug => selections.addOns[slug]?.enabled);
      if (addonSlugs.length > 0) {
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
              // Flatten per-drink syrup map to unique array (supports legacy flat arrays too)
              const rawSyrups = selections.syrupSelections || {};
              const syrupSels = Array.isArray(rawSyrups)
                ? rawSyrups
                : [...new Set(Object.values(rawSyrups).flat())];
              const snapshot = calculateProposal({
                pkg,
                guestCount: proposal.guest_count,
                durationHours: Number(proposal.event_duration_hours),
                numBars: proposal.num_bars || 1,
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
                  champagne_serving_style: selections.addOns['champagne-toast']?.servingStyle || null,
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
                  const clientUrl = process.env.CLIENT_URL || 'https://drbartender.com';

                  const planName = existing.rows[0]?.client_name || 'Client';
                  await sendEmail({
                    to: adminEmail,
                    subject: `${isUrgent ? 'URGENT: ' : ''}Drink Plan Submitted with Add-Ons — ${planName}`,
                    html: `<p><strong>${planName}</strong> submitted their drink plan.</p>
                           <p><strong>Add-ons selected:</strong> ${resolvedAddons.map(a => a.name).join(', ')}</p>
                           <p><strong>New total:</strong> $${snapshot.total.toFixed(2)}</p>
                           <p><strong>Amount paid:</strong> $${amountPaid.toFixed(2)}</p>
                           <p><strong>Balance due:</strong> $${(snapshot.total - amountPaid).toFixed(2)}</p>
                           ${isUrgent ? `<p style="color: red;"><strong>Event is in ${daysUntil} days!</strong></p>` : ''}
                           <p><a href="${clientUrl}/admin/proposals/${proposal.id}">View Proposal</a></p>`,
                  }).catch(emailErr => console.error('Admin notification email failed:', emailErr));
                }
              }
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
  } catch (err) {
    console.error('Drink plan update error:', err.message, err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Admin routes (auth required) ────────────────────────────────

/** GET /api/drink-plans — list all plans */
router.get('/', auth, requireAdmin, async (req, res) => {
  const { status, search } = req.query;
  try {
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
      query += ` AND (dp.client_name ILIKE $${params.length} OR dp.event_name ILIKE $${params.length} OR dp.client_email ILIKE $${params.length})`;
    }

    query += ' ORDER BY dp.created_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /api/drink-plans — create a new plan */
router.post('/', auth, requireAdmin, async (req, res) => {
  const { client_name, client_email, event_name, event_date } = req.body;
  if (!client_name) {
    return res.status(400).json({ error: 'Client name is required.' });
  }
  try {
    const result = await pool.query(`
      INSERT INTO drink_plans (client_name, client_email, event_name, event_date, created_by)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [
      client_name,
      client_email || null,
      event_name || null,
      event_date || null,
      req.user.id
    ]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /api/drink-plans/for-proposal/:proposalId — create a drink plan for a proposal (admin) */
router.post('/for-proposal/:proposalId', auth, requireAdmin, async (req, res) => {
  const { createDrinkPlan } = require('../utils/eventCreation');
  try {
    // Fetch proposal data
    const pRes = await pool.query(
      `SELECT p.*, c.name AS client_name, c.email AS client_email
       FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
       WHERE p.id = $1`, [req.params.proposalId]
    );
    if (!pRes.rows[0]) return res.status(404).json({ error: 'Proposal not found.' });
    const proposal = pRes.rows[0];

    const drinkPlan = await createDrinkPlan(proposal.id, {
      client_name: proposal.client_name,
      client_email: proposal.client_email,
      event_name: proposal.event_name,
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/drink-plans/by-proposal/:proposalId — fetch plan by proposal id */
router.get('/by-proposal/:proposalId', auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT dp.*, u.email AS created_by_email
       FROM drink_plans dp
       LEFT JOIN users u ON u.id = dp.created_by
       WHERE dp.proposal_id = $1`,
      [req.params.proposalId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'No drink plan found for this proposal.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/drink-plans/:id/shopping-list-data — fetch shaped data for shopping list generation */
router.get('/:id/shopping-list-data', auth, requireAdmin, async (req, res) => {
  try {
    // Fetch the drink plan, joining proposals for guest_count
    const planResult = await pool.query(
      `SELECT dp.*, p.guest_count
       FROM drink_plans dp
       LEFT JOIN proposals p ON p.id = dp.proposal_id
       WHERE dp.id = $1`,
      [req.params.id]
    );
    if (!planResult.rows[0]) return res.status(404).json({ error: 'Plan not found.' });
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

    res.json({
      client_name: plan.client_name,
      event_name: plan.event_name,
      event_date: plan.event_date,
      guest_count: plan.guest_count || null,
      service_style: plan.serving_type || 'full_bar',
      signature_cocktails: signatureCocktails,
      syrup_self_provided: syrupSelfProvided,
      notes: plan.admin_notes || '',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/drink-plans/:id — fetch single plan by id */
router.get('/:id', auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT dp.*, u.email AS created_by_email
       FROM drink_plans dp
       LEFT JOIN users u ON u.id = dp.created_by
       WHERE dp.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Plan not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PATCH /api/drink-plans/:id/notes — update admin notes */
router.patch('/:id/notes', auth, requireAdmin, async (req, res) => {
  const { admin_notes } = req.body;
  try {
    const result = await pool.query(
      'UPDATE drink_plans SET admin_notes = $1 WHERE id = $2 RETURNING id, admin_notes',
      [admin_notes || '', req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Plan not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PATCH /api/drink-plans/:id/status — update plan status */
router.patch('/:id/status', auth, requireAdmin, async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'draft', 'exploration_saved', 'submitted', 'reviewed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  try {
    const result = await pool.query(
      'UPDATE drink_plans SET status = $1 WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Plan not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/drink-plans/:id/shopping-list — load saved shopping list */
router.get('/:id/shopping-list', auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT shopping_list FROM drink_plans WHERE id = $1',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Plan not found.' });
    res.json({ shopping_list: result.rows[0].shopping_list || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PUT /api/drink-plans/:id/shopping-list — save/update shopping list */
router.put('/:id/shopping-list', auth, requireAdmin, async (req, res) => {
  const { shopping_list } = req.body;
  if (!shopping_list || typeof shopping_list !== 'object') {
    return res.status(400).json({ error: 'Invalid shopping list data.' });
  }
  try {
    const result = await pool.query(
      'UPDATE drink_plans SET shopping_list = $1, updated_at = NOW() WHERE id = $2 RETURNING id',
      [JSON.stringify(shopping_list), req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Plan not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** DELETE /api/drink-plans/:id — delete a plan */
router.delete('/:id', auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM drink_plans WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Plan not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

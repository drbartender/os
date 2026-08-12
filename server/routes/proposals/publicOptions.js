// Public "other options" data for the proposal page (/proposal/:token).
//
// The client browses every bar we could run for THEIR event and compares a few
// side by side. One request prices the whole set, because the alternative — the
// explore matrix's one POST /public/calculate per package — cannot express a
// BYOB configuration (package + support tier), makes the client send the event
// numbers back to us, and multiplies against a shared IP rate limit on a
// checkout path.
//
// TWO LAWS HERE:
//
// 1. The event numbers are read off the proposal, never off the request. The
//    client says WHICH bar it wants priced; the server decides WHAT IT COSTS.
//    A public token-gated handler that lets the caller influence pricing inputs
//    is how drinkPlans/submit.js overbilled a real client $627.
//
// 2. Pricing goes through priceProposedState — the same function the eventual
//    sign-time commit will use — so the number quoted here and the number
//    charged later agree by construction rather than by two implementations
//    happening to match. That is deliberate: /public/calculate does NOT run
//    stripIncludedAddons or validateProposalRules and ignores adjustments and
//    the gratuity mandate, so quoting from it would misprice every proposal
//    carrying a discount.
//
// Read-only: POST in verb (it takes a selection body) but it writes nothing.
// It sits on its OWN token-keyed limiter rather than the shared IP-keyed
// publicReadLimiter, because browsing must never be able to exhaust the budget
// the page load and the Stripe key fetch depend on.
const express = require('express');
const { pool } = require('../../db');
const { optionsQuoteLimiter } = require('../../middleware/rateLimiters');
const asyncHandler = require('../../middleware/asyncHandler');
const { NotFoundError, ValidationError } = require('../../utils/errors');
const { requireUuidToken } = require('../../utils/tokens');
const { priceProposedState } = require('../../utils/changeRequests');
const { BYOB_BUNDLE_SLUGS, BUNDLE_INCLUDED, visibleAddonsFor } = require('../../utils/proposalRules');

const router = express.Router();

// Everything priceProposedState reads off the proposal. A column missed here
// prices as undefined and silently drops a discount, the syrups, or the
// gratuity mandate floor, so this list is load-bearing rather than convenient.
const PROPOSAL_SELECT = `
  p.id, p.token, p.status, p.package_id, p.total_price, p.total_price_override,
  p.guest_count, p.event_duration_hours, p.num_bars, p.num_bartenders,
  p.event_date, p.event_start_time, p.event_location, p.event_type,
  p.event_type_custom, p.event_type_category,
  p.adjustments, p.pricing_snapshot, p.client_provides_glassware,
  p.gratuity_rate, p.tip_jar, p.gratuity_floor_rate, p.client_signed_at`;

// Mirrors the sign endpoint's own guard. The comparison is offered only while
// the proposal could still actually be signed; once signed, the configuration
// is the one they signed for and the surface has nothing left to offer.
const UNSIGNABLE = ['accepted', 'deposit_paid', 'balance_paid', 'confirmed', 'completed', 'archived'];

function notComparable(reason) {
  return { comparable: false, reason, options: [], tiers: [], extras: [] };
}

/** Integer ids only — the body is public input that selects priced rows. */
function safeIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw.slice(0, 40)) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0) out.push(n);
  }
  return [...new Set(out)];
}

router.post(
  '/t/:token/options',
  requireUuidToken('token', 'This proposal is no longer available'),
  optionsQuoteLimiter,
  asyncHandler(async (req, res) => {
    const { rows: [proposal] } = await pool.query(
      `SELECT ${PROPOSAL_SELECT} FROM proposals p WHERE p.token = $1`,
      [req.params.token]
    );
    if (!proposal) throw new NotFoundError('This proposal is no longer available');

    // A negotiated price is a number Dallas agreed by hand. Re-pricing it
    // against the catalog is exactly the Jack Van Dyke failure, so these
    // proposals are not offered the comparison at all rather than being offered
    // it and rejected at the end.
    if (proposal.total_price_override !== null && proposal.total_price_override !== undefined) {
      return res.json(notComparable('custom_pricing'));
    }
    if (proposal.client_signed_at || UNSIGNABLE.includes(proposal.status)) {
      return res.json(notComparable('already_signed'));
    }

    // One fetch each, then priced in memory. The proposal's OWN package is
    // unioned in even when retired: a client whose quote sits on a
    // discontinued package must still see their own option priced, and the
    // catalog path would otherwise not find it (the un-catalogued path looks up
    // by id alone and does not filter on is_active).
    const [pkgRes, addonRes, currentAddonRes] = await Promise.all([
      pool.query(
        `SELECT * FROM service_packages
          WHERE (is_active = true AND bar_type IS DISTINCT FROM 'class') OR id = $1
          ORDER BY category, sort_order NULLS LAST, name`,
        [proposal.package_id]
      ),
      pool.query('SELECT * FROM service_addons WHERE is_active = true ORDER BY sort_order'),
      pool.query('SELECT addon_id, variant, quantity FROM proposal_addons WHERE proposal_id = $1', [proposal.id]),
    ]);
    const catalog = { packages: pkgRes.rows, addons: addonRes.rows };
    const currentAddonIds = currentAddonRes.rows.map(r => r.addon_id);
    // Quantity and variant are part of what an add-on COSTS: `additional-bartender`
    // x2 is not the same money as x1, and dropping them re-prices the client's own
    // proposal below the total printed above it on the same page. Carried on every
    // quote so a client-added extra defaults to 1 while Dallas's stored quantities
    // survive untouched.
    const currentQuantities = {};
    const currentVariants = {};
    for (const r of currentAddonRes.rows) {
      if (r.quantity !== null && r.quantity !== undefined) currentQuantities[String(r.addon_id)] = r.quantity;
      if (r.variant !== null && r.variant !== undefined) currentVariants[String(r.addon_id)] = r.variant;
    }

    const tierAddons = catalog.addons.filter(a => BYOB_BUNDLE_SLUGS.includes(a.slug));
    const tierIds = new Set(tierAddons.map(a => a.id));

    // Selection. First load carries no body, so the proposal's own add-ons are
    // the starting state: whatever Dallas already put on the quote stays on it
    // rather than being silently dropped the moment the client looks around.
    const bodyGiven = req.body && (req.body.extra_addon_ids !== undefined || req.body.tier_addon_id !== undefined);
    const selectedExtras = bodyGiven
      ? safeIds(req.body.extra_addon_ids).filter(id => !tierIds.has(id))
      : currentAddonIds.filter(id => !tierIds.has(id));
    const requestedTier = bodyGiven
      ? (tierIds.has(Number(req.body.tier_addon_id)) ? Number(req.body.tier_addon_id) : null)
      : (currentAddonIds.find(id => tierIds.has(id)) ?? null);

    // Price one candidate package. Rule violations are a per-option verdict, not
    // a failed request: a hosted package under the 25-guest floor should render
    // as unavailable with a reason, while every other option still prices.
    const priceOption = async (pkg) => {
      const isByob = pkg.category === 'byob';
      const tierForPkg = isByob && requestedTier ? requestedTier : null;
      let addonIds;

      if (pkg.id === proposal.package_id) {
        // The option the client is STANDING ON must reproduce the total printed
        // above it, to the penny — on the first load AND after every re-quote.
        //
        // Its add-ons were set by Dallas, not chosen here. Some of them are
        // deliberately invisible to a client (a parking fee; real glassware on a
        // 120-guest event), so they are never in the offered `extras` list and
        // can never come back in the request body. Filtering this option through
        // the client-choice gate would therefore drop them the moment the client
        // toggles anything, and the "Yours" card would quietly get CHEAPER than
        // the total printed directly above it for a reason the client cannot
        // see. So: the client owns the visible selection, Dallas's invisible
        // ones always ride along.
        const clientVisible = new Set(
          visibleAddonsFor({
            addons: catalog.addons, pkg, guestCount: Number(proposal.guest_count),
            addonIds: tierForPkg ? [...selectedExtras, tierForPkg] : selectedExtras,
          }).map(a => a.id)
        );
        const ownHidden = currentAddonIds.filter(id => !clientVisible.has(id) && !tierIds.has(id));
        addonIds = [...new Set([...selectedExtras.filter(id => clientVisible.has(id)), ...ownHidden])];
        if (tierForPkg) addonIds.push(tierForPkg);
        else if (!bodyGiven) {
          const ownTier = currentAddonIds.find(id => tierIds.has(id));
          if (ownTier) addonIds.push(ownTier);
        }
      } else {
        // The visibility gate DOES apply to add-ons carried onto a different
        // package. Pass the tier alongside, because rules like mocktail-bar's
        // are written against a selection that includes it; without it the rule
        // can never be satisfied and the extra silently vanishes.
        const gateIds = tierForPkg ? [...selectedExtras, tierForPkg] : selectedExtras;
        const visibleIds = new Set(
          visibleAddonsFor({
            addons: catalog.addons, pkg, guestCount: Number(proposal.guest_count), addonIds: gateIds,
          }).map(a => a.id)
        );
        addonIds = selectedExtras.filter(id => visibleIds.has(id));
        if (tierForPkg) addonIds.push(tierForPkg);
      }

      try {
        const snapshot = await priceProposedState(proposal, {
          package_id: pkg.id,
          addon_ids: addonIds,
          addon_quantities: currentQuantities,
          addon_variants: currentVariants,
          // priceProposedState does NOT fall back to the stored column for this
          // one field (unlike guests/hours/bars), so an admin staffing override
          // would be silently re-derived from the 1:100 ratio and the quote
          // would drop the extra-bartender charge AND the gratuity that rides
          // on the crew size. Pass it explicitly.
          num_bartenders: proposal.num_bartenders ?? null,
        }, pool, catalog);
        return { total: Number(snapshot.total), available: true, reason: null };
      } catch (err) {
        // A rule violation is a verdict about ONE option; anything else is a
        // real fault and must not be swallowed into a cheerful badge.
        // (instanceof, not err.status: AppError sets `statusCode`, so the old
        // `err.status !== 400` never matched and one unpriceable option failed
        // the whole request.)
        if (!(err instanceof ValidationError)) throw err;
        return { total: null, available: false, reason: err.message || 'Not available for this event' };
      }
    };

    const options = [];
    for (const pkg of catalog.packages) {
      const priced = await priceOption(pkg);
      options.push({
        package_id: pkg.id,
        slug: pkg.slug,
        name: pkg.name,
        category: pkg.category,
        pricing_type: pkg.pricing_type,
        is_current: pkg.id === proposal.package_id,
        total: priced.total,
        available: priced.available,
        reason: priced.reason,
      });
    }

    // BYOB tier totals: the same package priced once per tier, so the card can
    // show what each level of support actually costs on this event instead of
    // making the client add it up.
    const byobPkg = catalog.packages.find(p => p.category === 'byob');
    const tiers = [];
    if (byobPkg) {
      for (const t of [null, ...tierAddons]) {
        const gateIds = t ? [...selectedExtras, t.id] : selectedExtras;
        const visibleIds = new Set(
          visibleAddonsFor({
            addons: catalog.addons, pkg: byobPkg, guestCount: Number(proposal.guest_count), addonIds: gateIds,
          }).map(a => a.id)
        );
        const ids = selectedExtras.filter(id => visibleIds.has(id));
        if (t) ids.push(t.id);
        let total = null;
        try {
          total = Number((await priceProposedState(proposal, {
            package_id: byobPkg.id,
            addon_ids: ids,
            addon_quantities: currentQuantities,
            addon_variants: currentVariants,
            num_bartenders: proposal.num_bartenders ?? null,
          }, pool, catalog)).total);
        } catch (err) {
          if (!(err instanceof ValidationError)) throw err;
        }
        // What this level of support actually puts on the bar, derived from the
        // bundle config rather than a second hand-written list: BUNDLE_INCLUDED
        // already names the add-ons a tier covers, so the card and the pricing
        // strip can never disagree about what is included.
        const covers = t
          ? (BUNDLE_INCLUDED[t.slug] || [])
            .map(slug => (catalog.addons.find(a => a.slug === slug) || {}).name)
            .filter(Boolean)
          : [];
        tiers.push({
          addon_id: t ? t.id : null,
          slug: t ? t.slug : null,
          name: t ? t.name : 'Bar service only',
          total,
          covers,
          selected: (t ? t.id : null) === requestedTier,
        });
      }
    }

    // Offered extras = the rule-derived visible set for the CURRENT package,
    // which is what the client is standing on. Per-option applicability is
    // already handled above (an extra that does not apply to an option is
    // simply not priced into it).
    const currentPkg = catalog.packages.find(p => p.id === proposal.package_id);
    const extras = (currentPkg
      ? visibleAddonsFor({
        addons: catalog.addons, pkg: currentPkg, guestCount: Number(proposal.guest_count),
        addonIds: selectedExtras,
      })
      : []
    )
      .filter(a => !tierIds.has(a.id))
      .map(a => ({
        addon_id: a.id,
        slug: a.slug,
        name: a.name,
        description: a.description,
        billing_type: a.billing_type,
        rate: a.rate === null || a.rate === undefined ? null : Number(a.rate),
        category: a.category,
        selected: selectedExtras.includes(a.id),
      }));

    res.json({
      comparable: true,
      reason: null,
      event: {
        guest_count: proposal.guest_count,
        event_duration_hours: proposal.event_duration_hours,
        num_bars: proposal.num_bars,
        event_date: proposal.event_date,
        event_start_time: proposal.event_start_time,
        event_location: proposal.event_location,
        event_type: proposal.event_type,
        event_type_custom: proposal.event_type_custom,
      },
      current_package_id: proposal.package_id,
      current_total: proposal.total_price === null ? null : Number(proposal.total_price),
      options,
      tiers,
      extras,
    });
  })
);

module.exports = router;

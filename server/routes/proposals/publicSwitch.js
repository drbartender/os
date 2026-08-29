// POST /api/proposals/t/:token/switch — the ONE write behind the proposal
// page's package drawer (spec 2026-08-14-proposal-options-drawer-design.md).
//
// "Switch to this package" rewrites the proposal pre-signature: package,
// add-ons, total, snapshot, exactly the configuration the drawer quoted. The
// signature flow then commits whatever is on the row, unchanged. Browsing
// writes nothing; this endpoint is the single deliberate exception to the
// panel's leave-no-trace law, and everything here exists to keep that write
// honest:
//
// - The client sends a CONFIGURATION, never a price used for pricing. Every
//   event parameter is read off the FOR UPDATE row (the drinkPlans/submit.js
//   $627 failure class).
// - Pricing runs through the exact identity the quote uses
//   (optionsPricingShared + priceProposedState), so quote and commit can only
//   disagree if the world moved, which is what the 409 is for.
// - `acknowledged_total` is compared in integer cents; on mismatch NOTHING is
//   written and the 409 carries a fresh quote (built by buildOptionsQuote, the
//   same function that serves the quote route).
// - Money in flight blocks the switch: pending cancelable Stripe intents are
//   canceled server-side FIRST (client-side secret invalidation cannot revoke
//   a live intent), and a processing/succeeded intent refuses the switch
//   outright — a pre-switch intent settling post-switch would pass the
//   webhook's payable guard and record the OLD amount against the NEW
//   configuration.
const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { switchLimiter, publicTokenIpLimiter } = require('../../middleware/rateLimiters');
const asyncHandler = require('../../middleware/asyncHandler');
const { AppError, NotFoundError, ValidationError, ConflictError } = require('../../utils/errors');
const { requireUuidToken } = require('../../utils/tokens');
const { getStripe } = require('../../utils/stripeClient');
const { priceProposedState } = require('../../utils/changeRequests');
const { reconcileProposalPaymentStatus } = require('../../utils/proposalStatus');
const { refreshUnlockedInvoices } = require('../../utils/invoiceLifecycle');
const { BYOB_BUNDLE_SLUGS, visibleAddonsFor } = require('../../utils/proposalRules');
const {
  PROPOSAL_SELECT, fitsPackage, computeOwnHidden, overrideOnlyBartenders,
  safeIds, recoverAddonInputs,
} = require('./optionsPricingShared');
const { buildOptionsQuote } = require('./publicOptions');
const { buildPublicProposalPayload } = require('./publicToken');

const router = express.Router();

// The shared pricing set plus the guard fields this write needs. PROPOSAL_SELECT
// is load-bearing (a column missed there silently drops a discount or the
// mandate floor); the two extras are guards, not pricing inputs.
const SWITCH_SELECT = `${PROPOSAL_SELECT}, p.amount_paid, p.group_id`;

const UNAVAILABLE_MSG =
  'This proposal can no longer be changed online. Reply to your email or give us a call and we will sort it out.';

// Every Stripe call in this handler runs either inside the FOR UPDATE lock or
// in the post-commit sweep, so none of them may hang for the SDK default (80s,
// times 2 retries, across two sequential waves). Ten seconds is far above a
// healthy round trip and far below anything that would strand the payment
// webhook behind our row lock. On the pre-commit waves a timeout aborts the
// switch, which is the safe direction: better a failed switch than a rewritten
// total behind a live intent.
const STRIPE_CALL_TIMEOUT_MS = 10000;

// Landed-switch grinding breadcrumb. The 409-storm log below catches a token
// that keeps FAILING; this catches one that keeps SUCCEEDING. Multi-commit
// sessions are the designed norm now (a client steps a tier, adds an extra,
// changes their mind), so a leaked token grinding valid switches with correct
// acknowledged totals would otherwise be completely silent while it churns
// invoices, Stripe intents and audit rows. Counted from the audit table rather
// than memory, so it survives a restart and cannot be reset by spreading the
// grind across instances.
const GRIND_COUNT = 5;
const GRIND_WINDOW_MIN = 30;
// Latched like noteConflict below: without this the capture fires on EVERY
// landed switch from the 5th onward, so one grinding token spends up to a
// switchLimiter-bounded 20 Sentry events per window saying the same thing.
// One page per proposal per window is the signal; the rest is quota.
const grindFlagged = new Map();

// 409-storm breadcrumb: repeated TOTAL_CHANGED conflicts on one token mean
// either quote/commit drift (a bug we want paged for) or a grinding token.
// In-memory is fine: this is a breadcrumb, not a ledger.
const conflictLog = new Map();
function noteConflict(token) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const entry = conflictLog.get(token) || { hits: [], flagged: false };
  entry.hits = entry.hits.filter((t) => now - t < windowMs);
  if (entry.hits.length === 0) entry.flagged = false;
  entry.hits.push(now);
  if (entry.hits.length >= 5 && !entry.flagged) {
    entry.flagged = true;
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureMessage('switch: repeated TOTAL_CHANGED 409s for one token', {
        level: 'warning',
        tags: { route: 'proposals/switch', issue: 'conflict_storm' },
        extra: { tokenTail: String(token).slice(-6), hits: entry.hits.length },
      });
    }
  }
  conflictLog.set(token, entry);
  // Bounded memory: drop tokens whose window has fully drained.
  if (conflictLog.size > 500) {
    for (const [k, v] of conflictLog) {
      if (!v.hits.some((t) => now - t < windowMs)) conflictLog.delete(k);
    }
  }
}

router.post(
  '/t/:token/switch',
  // UUID gate first (repo convention): junk tokens never spend a limiter bucket.
  requireUuidToken('token', 'This proposal is no longer available'),
  // IP ceiling first, then the token bucket: the token key is client-supplied,
  // so without this a sprayer mints a fresh bucket per made-up UUID.
  publicTokenIpLimiter,
  switchLimiter,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const packageId = Number(body.package_id);
    if (!Number.isInteger(packageId) || packageId <= 0) {
      throw new ValidationError({ package_id: 'Please pick a package to switch to.' });
    }
    // `null` is spelled out because Number(null) is 0, which is finite: a
    // client sending an explicit null would price as $0.00, take a guaranteed
    // TOTAL_CHANGED 409, and on retry feed the conflict-storm breadcrumb. The
    // sign route treats null and absent identically for the same reason (both
    // 400 since 2026-08-28).
    const ackRaw = body.acknowledged_total === null ? NaN : Number(body.acknowledged_total);
    if (!Number.isFinite(ackRaw)) {
      throw new ValidationError({ acknowledged_total: 'Please refresh the page and try again.' });
    }
    const ackCents = Math.round(ackRaw * 100);
    const tierRaw = body.tier_addon_id;
    const extraIdsRaw = body.extra_addon_ids;

    // req.ip FIRST, not the raw header: express is behind `trust proxy`, so
    // req.ip is the proxy-validated address while the first x-forwarded-for
    // entry is attacker-supplied. This row is the provenance for a payment
    // dispute and the detector for leaked-token abuse, which is exactly the
    // job a forgeable field cannot do.
    const rawIp = req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || '';
    const ip = rawIp.replace(/^::ffff:/, '');

    // getStripe() RETURNS NULL when creds are missing or test mode is armed
    // without test keys; it does not throw. Every other call site guards it,
    // and here the consequence of not guarding is the worst of any: a null
    // client makes every intent lookup throw, the money-in-flight defense
    // silently degrades to "nothing in flight", and the switch rewrites the
    // proposal behind a live intent for the old amount. Fail closed.
    const stripe = getStripe();
    if (!stripe) {
      throw new AppError('Payments are not configured.', 503, 'PAYMENTS_NOT_CONFIGURED');
    }
    let priceConflict = false;
    let switchedProposalId = null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Guards evaluate against the LOCKED row: the quote's unlocked read is
      // the wrong model for a write, or a webhook could commit money between
      // guard-check and write.
      const { rows: [p] } = await client.query(
        `SELECT ${SWITCH_SELECT} FROM proposals p WHERE p.token = $1 FOR UPDATE OF p`,
        [req.params.token]
      );
      if (!p) throw new NotFoundError('This proposal is no longer available');

      // Status whitelist, deliberately narrower than the quote's blacklist:
      // draft/modified may browse a quote but never write. options_available
      // (publicToken.js) uses the same predicate so the entry link and this
      // guard cannot disagree.
      if (!['sent', 'viewed'].includes(p.status)
          || (p.total_price_override !== null && p.total_price_override !== undefined)
          || p.client_signed_at
          || Number(p.amount_paid) > 0) {
        throw new ConflictError(UNAVAILABLE_MSG, 'SWITCH_NOT_AVAILABLE');
      }
      if (p.group_id !== null) {
        // A hand-built alternatives group is decided on the compare page; a
        // switch inside an undecided group would corrupt what /compare renders.
        const g = await client.query(
          'SELECT chosen_proposal_id FROM proposal_groups WHERE id = $1',
          [p.group_id]
        );
        if (!g.rows[0] || g.rows[0].chosen_proposal_id === null) {
          throw new ConflictError(UNAVAILABLE_MSG, 'SWITCH_NOT_AVAILABLE');
        }
      }

      // Money in flight. Every pending mirror row is checked against Stripe:
      // processing/succeeded means a charge for the OLD configuration is
      // landing, so the switch refuses; anything still cancelable is canceled
      // HERE (create-intent's stale-cancel pattern). A failed cancel throws:
      // better a failed switch than a live stale intent behind a changed total.
      //
      // THREE PHASES, and the order is load-bearing. Retrieve everything, THEN
      // decide, THEN cancel. Doing it per-row (retrieve, decide, cancel, next)
      // has two costs, both real: the row count is not bounded (create-intent
      // mints a fresh pending row per checkout revisit and nothing reaps them;
      // prod today has a switch-eligible proposal carrying 14), so serial
      // round trips put 28 Stripe calls inside a FOR UPDATE lock the payment
      // webhook also wants; and a refusal on row 2 would roll the DB back
      // AFTER row 1 was already canceled at Stripe, which no rollback can
      // undo. Deciding before cancelling removes that window entirely.
      //
      // Rows with a NULL intent id carry no PaymentIntent to retrieve, so they
      // are filtered out rather than logged as unretrievable on every switch.
      // They are NOT all harmless: an admin payment link mints such a row and
      // IS a client-payable Stripe-hosted checkout for the old amount, which
      // survives this switch. That exposure is identical to the one crud.js
      // admin price edits already carry, so it is inherited precedent rather
      // than something this route introduces; closing it means deactivating
      // the link (stripe.js does this with paymentLinks.update({active:false}))
      // and is a separate decision. Do not read this filter as "never a client
      // checkout".
      //
      // 'failed' is scanned alongside 'pending' and that is load-bearing.
      // paymentIntentFailed.js flips the mirror row to 'failed' but makes NO
      // Stripe call, so a declined card leaves the intent alive at Stripe in
      // requires_payment_method with a client_secret still live in the client's
      // open tab (stripeCreateIntent.js proves such intents are confirmable: it
      // deliberately REUSES them in exactly that state). Scanning 'pending'
      // alone let this sequence through: checkout for the old total, decline,
      // switch, retry the card in the still-open tab, and the old amount is
      // recorded against the new configuration. That is precisely the harm
      // this block exists to prevent.
      const pend = await client.query(
        `SELECT stripe_payment_intent_id FROM stripe_sessions
          WHERE proposal_id = $1 AND status IN ('pending', 'failed')
            AND stripe_payment_intent_id IS NOT NULL`,
        [p.id]
      );
      // Phase 1: retrieve concurrently. No DB touched here, so the held client
      // is idle and nothing races it.
      //
      // The catch is NARROW on purpose. "Gone at Stripe" genuinely means not
      // in flight; a 429, a 5xx, or a timeout means we do not know, and
      // treating unknown as "nothing in flight" would rewrite the total behind
      // a live intent. That is the exact harm this block exists to prevent, so
      // anything but a real resource_missing/404 aborts the switch.
      const goneIds = [];
      const intents = (await Promise.all(pend.rows.map(async (row) => {
        try {
          // Per-request timeout: the SDK default is 80s with 2 retries, and
          // these calls run INSIDE the FOR UPDATE lock, so an unbounded hang
          // holds the proposal row (and a pooled connection) against the
          // payment webhook for minutes. A timeout throw lands on the abort
          // path, which is the safe direction.
          return await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id, { timeout: STRIPE_CALL_TIMEOUT_MS });
        } catch (e) {
          const gone = e && (e.code === 'resource_missing' || e.statusCode === 404);
          if (!gone) throw e;
          console.warn(`[switch] pending intent ${row.stripe_payment_intent_id} is gone at Stripe (not in flight): ${e.message}`);
          goneIds.push(row.stripe_payment_intent_id);
          return null;
        }
      }))).filter(Boolean);

      // Phase 2: DECIDE, before anything is cancelled and before anything is
      // written. A cancel is the one action in this handler that ROLLBACK
      // cannot undo, so nothing may be cancelled until the switch is certain
      // to commit. (Pre-fix, a refusal on the second pending row left the
      // first one dead at Stripe while the DB rolled back.)
      if (intents.some((i) => i.status === 'processing' || i.status === 'succeeded')) {
        throw new ConflictError(
          'A payment for this proposal is already in progress. Give it a moment, then refresh.',
          'PAYMENT_IN_FLIGHT'
        );
      }
      const cancelable = intents.filter((i) => i.status !== 'canceled');
      // Phase 3 runs AFTER the acknowledged-total check, below.

      // Catalog, same three fetches as the quote. Sequential BY CONSTRUCTION,
      // not by oversight: node-postgres serializes queries on one connection,
      // so Promise.all here would execute identically and only LOOK parallel,
      // and pool.query would check out a SECOND connection while this one is
      // held, which is the deadlock this repo has hit twice (SERVER-17, the
      // 2026-07-13 capture-lead). Leave them on the held client.
      const [pkgRes, addonRes, currentAddonRes] = [
        await client.query(
          `SELECT * FROM service_packages
            WHERE (is_active = true AND bar_type IS DISTINCT FROM 'class') OR id = $1
            ORDER BY category, sort_order NULLS LAST, name`,
          [p.package_id]
        ),
        await client.query('SELECT * FROM service_addons WHERE is_active = true ORDER BY sort_order'),
        await client.query(
          'SELECT addon_id, variant, quantity, line_total, rate FROM proposal_addons WHERE proposal_id = $1',
          [p.id]
        ),
      ];
      const catalog = { packages: pkgRes.rows, addons: addonRes.rows };
      const pkg = catalog.packages.find((x) => x.id === packageId);
      if (!pkg) throw new ValidationError({ package_id: 'That package is not available for this event.' });

      // Selection: EXACTLY the quote's math for the target package, via the
      // shared identity module, so the committed configuration is the quoted
      // configuration to the penny.
      const tierAddons = catalog.addons.filter((a) => BYOB_BUNDLE_SLUGS.includes(a.slug));
      const tierIds = new Set(tierAddons.map((a) => a.id));
      const currentAddonIds = currentAddonRes.rows.map((r) => r.addon_id);
      const durationHours = Number(p.event_duration_hours) || 0;
      const metaRows = currentAddonIds.length
        ? (await client.query(
          'SELECT id, slug, billing_type, minimum_hours FROM service_addons WHERE id = ANY($1::int[])',
          [currentAddonIds]
        )).rows
        : [];
      const { quantities, variants } = recoverAddonInputs(currentAddonRes.rows, metaRows, durationHours);

      const selectedExtras = safeIds(extraIdsRaw).filter((id) => !tierIds.has(id));
      const requestedTier = tierIds.has(Number(tierRaw)) ? Number(tierRaw) : null;
      const currentPkg = catalog.packages.find((x) => x.id === p.package_id);
      const ownHiddenObjs = currentPkg
        ? computeOwnHidden({
          catalog, currentPkg, guestCount: p.guest_count, currentAddonIds,
          selectionIds: requestedTier ? [...selectedExtras, requestedTier] : selectedExtras,
          tierIds,
        })
        : [];

      const isByob = pkg.category === 'byob';
      const tierForPkg = isByob && requestedTier ? requestedTier : null;
      const gateIds = tierForPkg ? [...selectedExtras, tierForPkg] : selectedExtras;
      const visibleIds = new Set(
        visibleAddonsFor({
          addons: catalog.addons, pkg, guestCount: Number(p.guest_count), addonIds: gateIds,
        }).map((a) => a.id)
      );
      // Hidden add-ons: the applies_to filter is for CROSS-package moves only.
      // Staying on the same package must reproduce the quote's current-package
      // branch exactly, and that branch carries the proposal's own hidden
      // add-ons unfiltered (publicOptions.js: "Dallas's invisible ones always
      // ride along"). Filtering them here would drop, on a same-package
      // switch, an add-on the card the client acknowledged had priced in,
      // so engine total and acknowledged total could never agree and the
      // switch would 409 forever. A same-package switch is a real flow: the
      // drawer sends package plus extras, so changing only extras lands here.
      const isSamePackage = packageId === p.package_id;
      const ridingHidden = isSamePackage
        ? ownHiddenObjs
        : ownHiddenObjs.filter((a) => fitsPackage(a, pkg));
      const droppedNames = [
        ...(isSamePackage ? [] : ownHiddenObjs.filter((a) => !fitsPackage(a, pkg))),
        ...selectedExtras
          .filter((id) => !visibleIds.has(id))
          .map((id) => catalog.addons.find((a) => a.id === id))
          .filter(Boolean),
      ].map((a) => a.name);
      const addonIds = [...new Set([
        ...selectedExtras.filter((id) => visibleIds.has(id)),
        ...ridingHidden.map((a) => a.id),
      ])];
      if (tierForPkg) addonIds.push(tierForPkg);

      // Engine-owned pricing off the locked row. A rule violation
      // (ValidationError) propagates as a 400: the target was never a valid
      // option for this event.
      const snapshot = await priceProposedState(p, {
        package_id: packageId,
        addon_ids: addonIds,
        addon_quantities: quantities,
        addon_variants: variants,
        num_bartenders: overrideOnlyBartenders(p),
      }, client, catalog);

      if (Math.round(Number(snapshot.total) * 100) !== ackCents) {
        // The total the client saw is the total they get; anything else is a
        // refusal that re-shows, never a silent commit. The fresh quote is
        // built AFTER rollback + release (one-connection law: buildOptionsQuote
        // runs on the pool).
        await client.query('ROLLBACK');
        noteConflict(req.params.token);
        priceConflict = true;
      } else {
        // Phase 3, deferred to here on purpose: the switch is now certain to
        // commit, so cancelling is finally safe. A Stripe cancel is the one
        // action ROLLBACK cannot reverse, and running it before the price
        // check meant a stale-quote 409 killed a live intent for a switch that
        // never happened. Concurrent, so a proposal carrying many pending rows
        // costs one round trip rather than N inside the lock. A throw here
        // still aborts the whole switch, which is the correct trade: better a
        // failed switch than a live intent behind a changed total.
        if (cancelable.length) {
          await Promise.all(cancelable.map((i) => stripe.paymentIntents.cancel(i.id, { timeout: STRIPE_CALL_TIMEOUT_MS })));
        }
        // One statement for the whole set, including intents Stripe already
        // had as canceled AND ids that are gone at Stripe entirely: that is the
        // mirror heal. Without the gone ids the row stays 'pending' forever and
        // every future switch re-retrieves it, re-404s, and re-logs the same
        // warning; folding them in makes the sweep converge. Scoped by
        // proposal_id as well as intent id (the column is unique, so this is
        // belt and braces on a public write path).
        const healIds = [...new Set([...intents.map((i) => i.id), ...goneIds])];
        if (healIds.length) {
          await client.query(
            `UPDATE stripe_sessions SET status = 'canceled'
              WHERE proposal_id = $1 AND stripe_payment_intent_id = ANY($2::text[])`,
            [p.id, healIds]
          );
        }

        // Commit writes, in the crud.js precedent order. total_price and the
        // snapshot come from engine output verbatim. num_bartenders is synced
        // to what was actually priced (crud does the same): leaving a stale
        // value would resurrect the phantom-override problem on the NEXT
        // quote. NEVER in this SET list: tip_jar, gratuity_rate,
        // gratuity_floor_rate, deposit_amount (election-at-payment law; a
        // hand-set deposit is Dallas's).
        await client.query(
          `UPDATE proposals
              SET package_id = $1, total_price = $2, pricing_snapshot = $3,
                  num_bartenders = $4, updated_at = NOW()
            WHERE id = $5`,
          [packageId, snapshot.total, JSON.stringify(snapshot),
            snapshot.staffing?.actual ?? null, p.id]
        );

        // Belt and braces, and honestly labelled: the amount_paid = 0 guard
        // above makes this structurally unreachable today (reconcile only
        // moves deposit_paid/balance_paid rows, and those are already refused),
        // so it is defense that survives a future guard edit rather than a
        // live detector. Kept because the class it defends against, money
        // sitting on a 'sent' row via a force rewind or an external_paid
        // import, is real and has bitten before.
        const rec = reconcileProposalPaymentStatus({
          status: p.status, amountPaid: p.amount_paid, totalPrice: snapshot.total,
        });
        if (rec.changed) {
          await client.query(
            rec.autopayDisarmed
              ? `UPDATE proposals SET status = $1, autopay_enrolled = false, autopay_status = NULL WHERE id = $2`
              : `UPDATE proposals SET status = $1 WHERE id = $2`,
            [rec.status, p.id]
          );
          if (process.env.SENTRY_DSN_SERVER) {
            Sentry.captureMessage('switch: reconcile fired on a guarded row', {
              level: 'warning',
              tags: { route: 'proposals/switch', issue: 'guard_hole' },
              extra: { proposalId: p.id, from: p.status, to: rec.status },
            });
          }
        }

        // Replace proposal add-ons from engine output (single bulk INSERT,
        // quantity is the engine's OUTPUT, never recomputed here).
        await client.query('DELETE FROM proposal_addons WHERE proposal_id = $1', [p.id]);
        if (snapshot.addons.length) {
          const placeholders = snapshot.addons.map((_, i) => {
            const b = i * 8;
            return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`;
          }).join(',');
          const values = snapshot.addons.flatMap((a) => [
            p.id, a.id, a.name, a.billing_type, a.rate, a.quantity, a.line_total, a.variant || null,
          ]);
          await client.query(
            `INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total, variant) VALUES ${placeholders}`,
            values
          );
        }

        // The invoice minted at send is stale the moment the total moves.
        // In-tx, no invoice-number churn, no-op when nothing is minted yet
        // (deferred-group proposals mint at accept, off the new row).
        await refreshUnlockedInvoices(p.id, client);

        // Provenance: the audit row is what defends a disputed price and
        // detects leaked-token abuse. Admin NOTIFICATION is deliberately out
        // of scope; the audit row is not.
        await client.query(
          `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
           VALUES ($1, 'package_switched', 'client', $2)`,
          [p.id, JSON.stringify({
            from_package_id: p.package_id,
            to_package_id: packageId,
            old_total: Number(p.total_price),
            new_total: Number(snapshot.total),
            dropped: droppedNames,
            ip: ip || null,
          })]
        );

        await client.query('COMMIT');
        switchedProposalId = p.id;
      }
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    } finally {
      client.release();
    }

    // Post-release only: both builders take their own pool connections.
    if (priceConflict) {
      const quote = await buildOptionsQuote(req.params.token, {
        tier_addon_id: tierRaw ?? null,
        extra_addon_ids: Array.isArray(extraIdsRaw) ? extraIdsRaw : [],
      });
      return res.status(409).json({
        error: 'Prices were updated, take another look.',
        code: 'TOTAL_CHANGED',
        quote,
      });
    }
    // Close the create-intent window (skipped on the 409 path: nothing
    // committed, so there is nothing to protect).
    // stripeCreateIntent.js takes NO row lock:
    // it reads total_price, spends a second or two at Stripe, and only then
    // writes its pending mirror row. A checkout that started just before our
    // FOR UPDATE scan is therefore invisible to it, and would leave a live
    // intent for the OLD total against the NEW configuration. Re-scan now
    // that the switch has committed and the lock is gone: anything that
    // appeared in the gap gets cancelled here, converting "stale intent
    // survives" into "stale intent dies a moment later". Best-effort by
    // design, the switch itself already committed and must not be undone by
    // a cleanup failure.
    try {
      const late = switchedProposalId ? await pool.query(
        `SELECT stripe_payment_intent_id FROM stripe_sessions
          WHERE proposal_id = $1 AND status IN ('pending', 'failed')
            AND stripe_payment_intent_id IS NOT NULL`,
        [switchedProposalId]
      ) : { rows: [] };
      for (const row of late.rows) {
        const intent = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id, { timeout: STRIPE_CALL_TIMEOUT_MS });
        if (['processing', 'succeeded', 'canceled'].includes(intent.status)) continue;
        await stripe.paymentIntents.cancel(intent.id, { timeout: STRIPE_CALL_TIMEOUT_MS });
        await pool.query(
          `UPDATE stripe_sessions SET status = 'canceled'
            WHERE proposal_id = $1 AND stripe_payment_intent_id = $2`,
          [switchedProposalId, intent.id]
        );
        console.warn(`[switch] cancelled an intent minted during the switch window for proposal ${switchedProposalId}`);
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureMessage('switch: intent minted inside the create-intent window', {
            level: 'warning',
            tags: { route: 'proposals/switch', issue: 'create_intent_race' },
            extra: { proposalId: switchedProposalId, intentId: intent.id },
          });
        }
      }
    } catch (e) {
      // Best-effort by design, but NOT silent: this sweep is the only defense
      // against the create-intent race, so a failure here means a live intent
      // for the old total may survive behind the new configuration. Every other
      // anomaly on this route pages; this one used to log and vanish.
      console.error(`[switch] post-commit stale-intent sweep failed for proposal ${switchedProposalId}: ${e && e.message}`);
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(e instanceof Error ? e : new Error(String(e && e.message)), {
          level: 'error',
          tags: { route: 'proposals/switch', issue: 'stale_intent_sweep_failed' },
          extra: { proposalId: switchedProposalId },
        });
      }
    }

    // Landed-switch frequency. Deliberately AFTER the stale-intent sweep: the
    // sweep closes a live create-intent race and every millisecond before it
    // widens that window, while this is pure observability that can wait.
    // Best-effort and post-commit, so a failure here must not affect a switch
    // that already committed.
    if (switchedProposalId) {
      try {
        const grind = await pool.query(
          `SELECT COUNT(*)::int AS n FROM proposal_activity_log
            WHERE proposal_id = $1 AND action = 'package_switched'
              AND created_at > NOW() - ($2 || ' minutes')::interval`,
          [switchedProposalId, String(GRIND_WINDOW_MIN)]
        );
        const landed = grind.rows[0] ? grind.rows[0].n : 0;
        const flaggedAt = grindFlagged.get(switchedProposalId) || 0;
        const windowMs = GRIND_WINDOW_MIN * 60 * 1000;
        const stale = Date.now() - flaggedAt > windowMs;
        if (landed < GRIND_COUNT) grindFlagged.delete(switchedProposalId);
        if (landed >= GRIND_COUNT && stale && process.env.SENTRY_DSN_SERVER) {
          grindFlagged.set(switchedProposalId, Date.now());
          Sentry.captureMessage('switch: high landed-switch frequency for one token', {
            level: 'warning',
            tags: { route: 'proposals/switch', issue: 'switch_grind' },
            extra: {
              proposalId: switchedProposalId,
              landed,
              windowMinutes: GRIND_WINDOW_MIN,
            },
          });
        }
      } catch (e) {
        console.error(`[switch] landed-switch frequency check failed for proposal ${switchedProposalId}: ${e && e.message}`);
      }
    }

    const payload = await buildPublicProposalPayload(req.params.token);
    // Unreachable in practice (the row committed a moment ago), but a 200
    // carrying null would blow up in the drawer rather than say what happened.
    if (!payload) throw new NotFoundError('This proposal is no longer available');
    res.json(payload);
  })
);

module.exports = router;

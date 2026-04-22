# Potion Lab Pay-Now Invoice Generation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a client pays for drink-plan extras from the Potion Planning Lab, create a proper `invoices` row with line items (separate for "extras only", combined with the Balance invoice for "extras + balance"). Fix the pre-existing "add to balance" path so extras actually update the open Balance invoice. Offer a non-past-due client a voluntary "pay balance in full" option in the ConfirmationStep.

**Architecture:** Stripe webhook becomes the source of truth for invoice creation on drink-plan payments. Two new helpers (`createDrinkPlanExtrasInvoice`, `findOpenInvoiceForBalance`) extend `invoiceHelpers.js`. Intent endpoint accepts a `paymentChoice` flag so the UI can drive extras-only vs extras+balance charges without inventing new payment types. `invoice_payments` rows split a single charge across the new extras invoice and the existing Balance invoice for combined payments. Drink plan submit calls `refreshUnlockedInvoices` so the balance-update path works.

**Tech Stack:** Node 18, Express 4, Stripe Node SDK, PostgreSQL via `pg`, React 18 with Stripe React Elements.

**Commit strategy (per project rules):** All backend + frontend edits ship in **one commit** at the end of the plan. This is a single logical feature — mixing backend invoice logic, webhook, and UI — and per CLAUDE.md rule #3 it's one commit, not five. Tasks below are implementation steps, not separate commits.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `server/utils/invoiceHelpers.js` | Modify | Add `createDrinkPlanExtrasInvoice(...)` and `findOpenInvoiceForBalance(...)` helpers. Export both. |
| `server/routes/stripe.js` | Modify | `create-drink-plan-intent` accepts `paymentChoice`; stores `extras_amount_cents` and `balance_amount_cents` in PaymentIntent metadata; returns `balanceOptionAvailable`. Webhook `payment_intent.succeeded` branches on `payment_type` to create the correct invoice(s). |
| `server/routes/drinkPlans.js` | Modify | In the submit (`PUT /t/:token` status=submitted) transaction, call `refreshUnlockedInvoices` after the proposal total/snapshot update so the open Balance invoice line items reflect new extras. |
| `client/src/pages/plan/steps/ConfirmationStep.js` | Modify | Add third radio option "Pay Extras + Balance in Full" when `balanceOptionAvailable`. Re-fetch intent on choice change. Pass `paymentChoice` to intent endpoint. |

No schema changes. No new env vars. No new files.

---

## Task 1 — Add `createDrinkPlanExtrasInvoice` helper

**Files:**
- Modify: `server/utils/invoiceHelpers.js` (append helper before the `// ─── Exports` block at line 517)

- [ ] **Step 1.1: Add the helper function**

Open `server/utils/invoiceHelpers.js` and insert the following after the `linkPaymentToInvoice` function (after line 515) and before the `module.exports` block. The helper reads the drink plan selections and proposal snapshot from the database, derives line items with the same logic the intent endpoint uses to compute the extras dollar amount, creates a new invoice labeled `Drink Plan Extras`, and writes the line items.

```javascript
// ─── 11. createDrinkPlanExtrasInvoice ────────────────────────────────────────

/**
 * Create a new "Drink Plan Extras" invoice for a drink-plan payment.
 *
 * Reads drink_plan.selections + proposal.pricing_snapshot/num_bars from the DB
 * and builds line items for the extras the client selected. Caller is
 * responsible for calling linkPaymentToInvoice() to record the payment.
 *
 * @param {{ proposalId:number, drinkPlanId:number, extrasAmountCents:number }} opts
 * @param {object} dbClient  — must be a transaction client
 * @returns {Promise<object>} The new invoice row.
 */
async function createDrinkPlanExtrasInvoice({ proposalId, drinkPlanId, extrasAmountCents }, dbClient) {
  // Load drink plan + proposal context
  const [dpRes, propRes] = await Promise.all([
    dbClient.query('SELECT selections FROM drink_plans WHERE id = $1', [drinkPlanId]),
    dbClient.query(
      'SELECT guest_count, num_bars, pricing_snapshot FROM proposals WHERE id = $1',
      [proposalId]
    ),
  ]);

  if (!dpRes.rows[0]) throw new Error(`Drink plan ${drinkPlanId} not found`);
  if (!propRes.rows[0]) throw new Error(`Proposal ${proposalId} not found`);

  const selections = dpRes.rows[0].selections || {};
  const prop = propRes.rows[0];
  const snap = prop.pricing_snapshot || {};

  // Build the line items
  const items = [];

  // Add-ons — enabled slugs only; resolve to service_addons for names/rates
  const addonSlugs = Object.keys(selections.addOns || {}).filter(
    slug => selections.addOns[slug]?.enabled
  );
  if (addonSlugs.length > 0) {
    const addonRows = await dbClient.query(
      'SELECT id, slug, name, rate, billing_type FROM service_addons WHERE slug = ANY($1) AND is_active = true',
      [addonSlugs]
    );
    for (const addon of addonRows.rows) {
      const rate = Number(addon.rate);
      const isPerGuest = addon.billing_type === 'per_guest';
      const qty = isPerGuest ? (prop.guest_count || 1) : 1;
      const lineCents = toCents(rate * qty);
      const unitCents = toCents(rate);
      const description = isPerGuest
        ? `${addon.name} (${qty} guests)`
        : addon.name;
      items.push({
        description,
        quantity: qty,
        unit_price: unitCents,
        line_total: lineCents,
        source_type: 'addon',
        source_id: addon.id,
      });
    }
  }

  // Bar rental — use pricing_snapshot values if present, fall back to defaults
  if (selections.logistics?.addBarRental === true) {
    const barRental = snap.bar_rental || {};
    const isAdditional = (prop.num_bars || 0) >= 1;
    const feeDollars = isAdditional
      ? (barRental.additional_bar_fee || 100)
      : (barRental.first_bar_fee || 50);
    const lineCents = toCents(feeDollars);
    items.push({
      description: isAdditional ? 'Additional Portable Bar' : 'Portable Bar Rental',
      quantity: 1,
      unit_price: lineCents,
      line_total: lineCents,
      source_type: 'fee',
      source_id: null,
    });
  }

  // Syrups — any cost in extras corresponds to new syrups (not self-provided, not already on proposal)
  // extras_amount_cents minus the addon + bar rental lines is the syrup portion.
  const accountedCents = items.reduce((sum, it) => sum + it.line_total, 0);
  const syrupCents = extrasAmountCents - accountedCents;
  if (syrupCents > 0) {
    items.push({
      description: 'Hand-Crafted Syrups',
      quantity: 1,
      unit_price: syrupCents,
      line_total: syrupCents,
      source_type: 'fee',
      source_id: null,
    });
  }

  // Create the invoice row and write line items
  const invoice = await createInvoice(
    {
      proposalId,
      label: 'Drink Plan Extras',
      amountDueCents: extrasAmountCents,
      status: 'sent',
      dueDate: null,
    },
    dbClient
  );
  await writeLineItems(invoice.id, items, dbClient);
  return invoice;
}
```

- [ ] **Step 1.2: Export the helper**

In the `module.exports` block (currently lines 519–530), add `createDrinkPlanExtrasInvoice` to the exported names. Final block should look like:

```javascript
module.exports = {
  formatInvoiceNumber,
  generateLineItemsFromProposal,
  writeLineItems,
  createInvoice,
  lockInvoice,
  refreshUnlockedInvoices,
  createInvoiceOnSend,
  createBalanceInvoice,
  createAdditionalInvoiceIfNeeded,
  linkPaymentToInvoice,
  createDrinkPlanExtrasInvoice,
  findOpenInvoiceForBalance,
};
```

(Note: `findOpenInvoiceForBalance` is added in Task 2; adding it to exports now in one edit is fine since the next task will populate the function.)

- [ ] **Step 1.3: Syntax check**

Run: `node --check server/utils/invoiceHelpers.js`
Expected: no output (success).

Note: `findOpenInvoiceForBalance` is not yet defined, but Node's `--check` only parses syntax, not references, so this passes. The module.exports will fail at runtime until Task 2 is complete.

---

## Task 2 — Add `findOpenInvoiceForBalance` helper

**Files:**
- Modify: `server/utils/invoiceHelpers.js` (append helper before exports)

- [ ] **Step 2.1: Add the helper function**

Insert just before the `module.exports` block:

```javascript
// ─── 12. findOpenInvoiceForBalance ───────────────────────────────────────────

/**
 * Locate the invoice that represents the proposal's outstanding balance.
 * Priority: Balance > Full Payment > Deposit. Skips Drink Plan Extras and
 * any other bespoke-label invoices that shouldn't absorb balance payments.
 *
 * @param {number} proposalId
 * @param {object} [dbClient]
 * @returns {Promise<{id:number, label:string}|null>}
 */
async function findOpenInvoiceForBalance(proposalId, dbClient) {
  const client = db(dbClient);
  const result = await client.query(
    `SELECT id, label
       FROM invoices
      WHERE proposal_id = $1
        AND status IN ('sent', 'partially_paid')
        AND label IN ('Balance', 'Full Payment', 'Deposit')
      ORDER BY CASE label
                 WHEN 'Balance' THEN 1
                 WHEN 'Full Payment' THEN 2
                 WHEN 'Deposit' THEN 3
               END,
               id ASC
      LIMIT 1`,
    [proposalId]
  );
  return result.rows[0] || null;
}
```

- [ ] **Step 2.2: Syntax check**

Run: `node --check server/utils/invoiceHelpers.js`
Expected: no output (success).

- [ ] **Step 2.3: Smoke-import the module**

Run: `node -e "const h = require('./server/utils/invoiceHelpers'); console.log(Object.keys(h).sort().join(','));"`
Expected output (one line): `createAdditionalInvoiceIfNeeded,createBalanceInvoice,createDrinkPlanExtrasInvoice,createInvoice,createInvoiceOnSend,findOpenInvoiceForBalance,formatInvoiceNumber,generateLineItemsFromProposal,linkPaymentToInvoice,lockInvoice,refreshUnlockedInvoices,writeLineItems`

---

## Task 3 — Update `create-drink-plan-intent` endpoint

**Files:**
- Modify: `server/routes/stripe.js:162-315`

- [ ] **Step 3.1: Accept `paymentChoice` and add balance-option logic**

Replace the entire `POST /api/stripe/create-drink-plan-intent/:token` handler (starts at line 162, ends at line 315) with this version. Changes from the current handler:
- Reads `paymentChoice` from the body (`'extras_only'` | `'with_balance'`, default `'extras_only'`).
- Scenario resolution now treats the non-past-due case as `extras_optional` AND allows `with_balance` to add the outstanding balance voluntarily.
- Stores `extras_amount_cents` and `balance_amount_cents` in PaymentIntent metadata so the webhook can split the charge cleanly.
- Returns `balanceOptionAvailable` so the UI can conditionally render the middle radio.

```javascript
/** POST /api/stripe/create-drink-plan-intent/:token — public, token-gated (drink plan token) */
router.post('/create-drink-plan-intent/:token', publicLimiter, asyncHandler(async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    throw new AppError('Payments are not configured.', 503, 'PAYMENTS_NOT_CONFIGURED');
  }

  const { selections, paymentChoice: rawChoice } = req.body;
  if (!selections) throw new ValidationError({ selections: 'Selections required' });
  const paymentChoice = rawChoice === 'with_balance' ? 'with_balance' : 'extras_only';

  // Look up drink plan + proposal
  const planRes = await pool.query(`
    SELECT dp.id AS plan_id, dp.token AS plan_token, dp.status AS plan_status,
           p.id AS proposal_id, p.total_price, p.amount_paid, p.event_date,
           p.balance_due_date, p.guest_count, p.num_bars, p.stripe_customer_id,
           p.event_type, p.event_type_custom, p.pricing_snapshot,
           c.email AS client_email, c.name AS client_name
    FROM drink_plans dp
    JOIN proposals p ON p.id = dp.proposal_id
    LEFT JOIN clients c ON c.id = p.client_id
    WHERE dp.token = $1
  `, [req.params.token]);

  if (!planRes.rows[0]) throw new NotFoundError('This drink plan link is no longer valid');
  const data = planRes.rows[0];

  if (!data.proposal_id) throw new ConflictError('No linked proposal for this plan');

  // Calculate extras server-side
  const addOns = selections.addOns || {};
  const addonSlugs = Object.keys(addOns).filter(slug => addOns[slug]?.enabled);
  const addBarRental = selections.logistics?.addBarRental === true;

  let addonTotal = 0;
  if (addonSlugs.length > 0) {
    const addonRes = await pool.query(
      'SELECT slug, rate, billing_type FROM service_addons WHERE slug = ANY($1) AND is_active = true',
      [addonSlugs]
    );
    for (const addon of addonRes.rows) {
      const rate = Number(addon.rate);
      if (addon.billing_type === 'per_guest') {
        addonTotal += rate * (data.guest_count || 1);
      } else {
        addonTotal += rate;
      }
    }
  }

  let barRentalCost = 0;
  if (addBarRental) {
    const snapshot = data.pricing_snapshot || {};
    const barRental = snapshot.bar_rental || {};
    if ((data.num_bars || 0) >= 1) {
      barRentalCost = barRental.additional_bar_fee || 100;
    } else {
      barRentalCost = barRental.first_bar_fee || 50;
    }
  }

  const rawSyrups = selections.syrupSelections || {};
  const allSyrupIds = Array.isArray(rawSyrups)
    ? rawSyrups
    : [...new Set(Object.values(rawSyrups).flat())];
  const selfProvided = selections.syrupSelfProvided || [];
  const proposalSyrups = data.pricing_snapshot?.syrups?.selections || [];
  const newSyrupIds = allSyrupIds
    .filter(id => !selfProvided.includes(id))
    .filter(id => !proposalSyrups.includes(id));
  const syrupCost = calculateSyrupCost(newSyrupIds, data.guest_count);

  const extrasAmount = addonTotal + barRentalCost + syrupCost.total;

  // Compute outstanding balance
  const now = new Date();
  let balanceDueDate = data.balance_due_date;
  if (!balanceDueDate && data.event_date) {
    const d = new Date(data.event_date);
    d.setDate(d.getDate() - 14);
    balanceDueDate = d;
  }
  const isPastDue = balanceDueDate ? now > new Date(balanceDueDate) : false;
  const currentBalance = Math.max(0, Number(data.total_price || 0) - Number(data.amount_paid || 0));
  const balanceOptionAvailable = !isPastDue && currentBalance > 0 && extrasAmount > 0;

  // Early exit when nothing to charge
  if (extrasAmount <= 0 && !(isPastDue && currentBalance > 0)) {
    return res.json({ noPaymentNeeded: true, extrasAmount: 0, balanceOptionAvailable: false });
  }

  // Resolve scenario and amounts
  let paymentScenario;
  let totalCharge;
  let pastDueAmount = 0;
  let balancePortion = 0;

  if (isPastDue && currentBalance > 0) {
    paymentScenario = 'extras_plus_balance';
    pastDueAmount = currentBalance;
    balancePortion = currentBalance;
    totalCharge = extrasAmount + currentBalance;
  } else if (isPastDue) {
    paymentScenario = 'extras_required';
    totalCharge = extrasAmount;
  } else if (paymentChoice === 'with_balance' && currentBalance > 0 && extrasAmount > 0) {
    paymentScenario = 'extras_optional';
    balancePortion = currentBalance;
    totalCharge = extrasAmount + currentBalance;
  } else {
    paymentScenario = 'extras_optional';
    totalCharge = extrasAmount;
  }

  const customerId = await getOrCreateCustomer({
    id: data.proposal_id,
    stripe_customer_id: data.stripe_customer_id,
    client_email: data.client_email,
    client_name: data.client_name,
  });

  const amountCents = Math.round(totalCharge * 100);
  const extrasCents = Math.round(extrasAmount * 100);
  const balanceCents = Math.round(balancePortion * 100);
  const paymentType = balancePortion > 0 ? 'drink_plan_with_balance' : 'drink_plan_extras';

  let paymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: customerId,
      description: `Drink Plan Extras — ${eventLabelFor(data)}`,
      receipt_email: data.client_email || undefined,
      metadata: {
        proposal_id: String(data.proposal_id),
        drink_plan_id: String(data.plan_id),
        payment_type: paymentType,
        extras_amount_cents: String(extrasCents),
        balance_amount_cents: String(balanceCents),
      },
    });
  } catch (err) {
    console.error('Drink plan payment intent error:', err);
    throw new ExternalServiceError('Stripe', err, 'Payment temporarily unavailable. Please try again.');
  }

  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
    [data.proposal_id, paymentIntent.id, amountCents]
  );

  res.json({
    clientSecret: paymentIntent.client_secret,
    extrasAmount,
    pastDueAmount,
    totalCharge,
    paymentScenario,
    balanceOptionAvailable,
    currentBalance,
  });
}));
```

- [ ] **Step 3.2: Syntax check**

Run: `node --check server/routes/stripe.js`
Expected: no output (success).

---

## Task 4 — Update Stripe webhook for typed drink-plan invoice creation

**Files:**
- Modify: `server/routes/stripe.js:650-675` (the "Invoice integration" block inside the `payment_intent.succeeded` handler)

- [ ] **Step 4.1: Import the new helpers**

Open `server/routes/stripe.js`. At line 10, the `require` for `invoiceHelpers` currently reads:

```javascript
const { createBalanceInvoice, linkPaymentToInvoice } = require('../utils/invoiceHelpers');
```

Replace with:

```javascript
const {
  createBalanceInvoice,
  linkPaymentToInvoice,
  createDrinkPlanExtrasInvoice,
  findOpenInvoiceForBalance,
} = require('../utils/invoiceHelpers');
```

- [ ] **Step 4.2: Replace the webhook invoice-integration block**

Inside the webhook's `isFirstDelivery` branch (near the comment `// ── Invoice integration ──`, currently lines 650–675), replace the existing block with type-aware handling:

Find this existing code:

```javascript
          // ── Invoice integration ──────────────────────────────────
          const invoiceId = intent.metadata?.invoice_id;
          const paymentRow = await dbClient.query(
            'SELECT id FROM proposal_payments WHERE stripe_payment_intent_id = $1 AND status = $2 LIMIT 1',
            [intent.id, 'succeeded']
          );
          if (paymentRow.rows[0]) {
            if (invoiceId) {
              // Payment was made through an invoice — link and lock
              await linkPaymentToInvoice(Number(invoiceId), paymentRow.rows[0].id, intent.amount, dbClient);
            } else {
              // Legacy payment (not through invoice) — try to find and link the oldest open invoice
              const openInvoice = await dbClient.query(
                "SELECT id FROM invoices WHERE proposal_id = $1 AND status IN ('sent', 'partially_paid') ORDER BY created_at ASC LIMIT 1",
                [proposalId]
              );
              if (openInvoice.rows[0]) {
                await linkPaymentToInvoice(openInvoice.rows[0].id, paymentRow.rows[0].id, intent.amount, dbClient);
              }
            }
          }

          // If a deposit was just paid, create the balance invoice
          if (paymentType === 'deposit') {
            await createBalanceInvoice(proposalId, dbClient);
          }
```

Replace with:

```javascript
          // ── Invoice integration ──────────────────────────────────
          const invoiceId = intent.metadata?.invoice_id;
          const paymentRow = await dbClient.query(
            'SELECT id FROM proposal_payments WHERE stripe_payment_intent_id = $1 AND status = $2 LIMIT 1',
            [intent.id, 'succeeded']
          );
          if (paymentRow.rows[0]) {
            const paymentRowId = paymentRow.rows[0].id;

            if (invoiceId) {
              // Payment was made through a specific invoice (e.g. the invoice page)
              await linkPaymentToInvoice(Number(invoiceId), paymentRowId, intent.amount, dbClient);
            } else if (paymentType === 'drink_plan_extras' || paymentType === 'drink_plan_with_balance') {
              // Drink-plan payment — create a "Drink Plan Extras" invoice; for
              // combined payments also apply the balance portion to the
              // existing balance-representing invoice.
              const extrasCents = Number(intent.metadata?.extras_amount_cents || 0);
              const balanceCents = Number(intent.metadata?.balance_amount_cents || 0);
              const drinkPlanId = Number(intent.metadata?.drink_plan_id);

              if (extrasCents > 0 && drinkPlanId) {
                const extrasInvoice = await createDrinkPlanExtrasInvoice(
                  { proposalId, drinkPlanId, extrasAmountCents: extrasCents },
                  dbClient
                );
                await linkPaymentToInvoice(extrasInvoice.id, paymentRowId, extrasCents, dbClient);
              }

              if (balanceCents > 0) {
                const balanceInv = await findOpenInvoiceForBalance(proposalId, dbClient);
                if (balanceInv) {
                  await linkPaymentToInvoice(balanceInv.id, paymentRowId, balanceCents, dbClient);
                } else {
                  // No open Balance/Full-Payment/Deposit invoice to absorb the
                  // balance portion. Log so admin can reconcile manually; the
                  // money is still recorded in proposal_payments.
                  console.warn(
                    `Webhook: drink_plan_with_balance payment ${intent.id} for proposal ${proposalId} had no open invoice to absorb balance portion ($${(balanceCents / 100).toFixed(2)})`
                  );
                  if (process.env.SENTRY_DSN_SERVER) {
                    Sentry.captureMessage(
                      `Unapplied drink-plan balance portion (proposal ${proposalId}, intent ${intent.id}, cents ${balanceCents})`,
                      'warning'
                    );
                  }
                }
              }
            } else {
              // Non-drink-plan, non-specific-invoice payment (deposit / balance / full)
              // — fall back to the oldest open invoice as before.
              const openInvoice = await dbClient.query(
                "SELECT id FROM invoices WHERE proposal_id = $1 AND status IN ('sent', 'partially_paid') ORDER BY created_at ASC LIMIT 1",
                [proposalId]
              );
              if (openInvoice.rows[0]) {
                await linkPaymentToInvoice(openInvoice.rows[0].id, paymentRowId, intent.amount, dbClient);
              }
            }
          }

          // If a deposit was just paid, create the balance invoice
          if (paymentType === 'deposit') {
            await createBalanceInvoice(proposalId, dbClient);
          }
```

- [ ] **Step 4.3: Syntax check**

Run: `node --check server/routes/stripe.js`
Expected: no output (success).

---

## Task 5 — Refresh unlocked invoices when drink plan is submitted

**Files:**
- Modify: `server/routes/drinkPlans.js:5` (import) and around line 278 (inside submit transaction)

- [ ] **Step 5.1: Import `refreshUnlockedInvoices`**

At the top of the file (currently line 5), the imports look like:

```javascript
const { calculateProposal } = require('../utils/pricingEngine');
```

Directly below that line, add:

```javascript
const { refreshUnlockedInvoices } = require('../utils/invoiceHelpers');
```

- [ ] **Step 5.2: Call `refreshUnlockedInvoices` inside the submit transaction**

In the submit handler around line 278 (right after the `UPDATE proposals SET total_price = $1, pricing_snapshot = ...` query and the activity-log insert), find the end of the `if (pkg && proposal.guest_count && proposal.event_duration_hours) { ... }` block — it currently closes around line 277 with `}`. Just before that closing brace (and after the block that sends the client balance email ends), add:

Actually, the cleanest insertion point is at the very end of the addon-processing `if (proposal)` branch, right before `await client.query('COMMIT');`. Locate the existing line:

```javascript
        await client.query('COMMIT');
```

(around line 280). Directly above this line, add:

```javascript
        // Keep any open (unlocked) Balance / Full Payment invoice in sync with
        // the new total — so "add to balance" actually updates the invoice the
        // client will later pay.
        try {
          await refreshUnlockedInvoices(proposal.id, client);
        } catch (refreshErr) {
          console.error('refreshUnlockedInvoices failed (non-fatal):', refreshErr);
        }
```

- [ ] **Step 5.3: Syntax check**

Run: `node --check server/routes/drinkPlans.js`
Expected: no output (success).

---

## Task 6 — ConfirmationStep UI: add "Pay Extras + Balance in Full" option

**Files:**
- Modify: `client/src/pages/plan/steps/ConfirmationStep.js`

- [ ] **Step 6.1: Widen the payment-choice state and track balance availability**

At line 82:

```javascript
  const [paymentChoice, setPaymentChoice] = useState('pay_now');
```

Replace with:

```javascript
  const [paymentChoice, setPaymentChoice] = useState('pay_now'); // 'pay_now' | 'pay_everything' | 'add_to_balance'
  const [balanceOptionAvailable, setBalanceOptionAvailable] = useState(false);
  const [currentBalance, setCurrentBalance] = useState(0);
```

- [ ] **Step 6.2: Send `paymentChoice` to the intent endpoint and read `balanceOptionAvailable`**

Replace the existing `useEffect` that loads the payment intent (currently lines 149–191) with a version that:
- Accepts `paymentChoice` as a dependency so switching radio options re-fetches the intent with the updated charge total.
- Maps the UI's three-way choice into the endpoint's two-way flag (`'extras_only'` or `'with_balance'`).
- Reads `balanceOptionAvailable` and `currentBalance` from the response.

```javascript
  useEffect(() => {
    if (!showPayment || !token) return;
    // Skip the fetch when the user has chosen "Add to My Balance" — no charge.
    if (paymentChoice === 'add_to_balance') {
      setClientSecret('');
      return;
    }

    let cancelled = false;
    async function loadPaymentInfo() {
      setLoadingPayment(true);
      setPaymentError('');
      try {
        const choiceForServer = paymentChoice === 'pay_everything' ? 'with_balance' : 'extras_only';
        const res = await axios.post(`${BASE_URL}/stripe/create-drink-plan-intent/${token}`, {
          selections,
          paymentChoice: choiceForServer,
        });
        if (cancelled) return;

        if (res.data.noPaymentNeeded) {
          setPaymentScenario(null);
          setBalanceOptionAvailable(false);
          return;
        }

        setClientSecret(res.data.clientSecret);
        setPaymentScenario(res.data.paymentScenario);
        setPaymentAmounts({
          extrasAmount: res.data.extrasAmount,
          pastDueAmount: res.data.pastDueAmount,
          totalCharge: res.data.totalCharge,
        });
        setBalanceOptionAvailable(!!res.data.balanceOptionAvailable);
        setCurrentBalance(Number(res.data.currentBalance || 0));
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to load payment info:', err);
          setPaymentError('Unable to load payment form. You can still submit and pay later.');
        }
      } finally {
        if (!cancelled) setLoadingPayment(false);
      }
    }

    loadPaymentInfo();
    return () => { cancelled = true; };
  }, [showPayment, token, paymentChoice]); // eslint-disable-line react-hooks/exhaustive-deps
```

- [ ] **Step 6.3: Render the new third radio option when `balanceOptionAvailable`**

In the `extras_optional` branch of the render (currently around lines 491–543), the block starts with:

```javascript
          {/* Scenario: extras optional (not past due) */}
          {paymentScenario === 'extras_optional' && (
            <div style={{ marginBottom: '1rem' }}>
              <p className="text-muted" style={{ color: 'var(--warm-brown)', marginBottom: '0.75rem' }}>
                How would you like to handle payment for your extras?
              </p>
```

Immediately after the existing "Pay Now" label (the one that sets `paymentChoice === 'pay_now'`) and BEFORE the "Add to My Balance" label, insert a new option:

```javascript
              {balanceOptionAvailable && (
                <label style={{
                  display: 'block', padding: '0.85rem 1rem', borderRadius: '8px', cursor: 'pointer', marginBottom: '0.5rem',
                  border: paymentChoice === 'pay_everything' ? '2px solid var(--deep-brown)' : '1px solid #d4c4b0',
                  background: paymentChoice === 'pay_everything' ? 'rgba(193, 125, 60, 0.06)' : 'transparent',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input
                      type="radio"
                      name="paymentChoice"
                      value="pay_everything"
                      checked={paymentChoice === 'pay_everything'}
                      onChange={() => setPaymentChoice('pay_everything')}
                      style={{ accentColor: 'var(--deep-brown)' }}
                    />
                    <div>
                      <div style={{ fontWeight: 600, color: 'var(--deep-brown)' }}>
                        Pay Extras + Balance in Full — {fmt(paymentAmounts.extrasAmount + currentBalance)}
                      </div>
                      <div className="text-muted text-small">
                        Settle your event balance of {fmt(currentBalance)} too
                        {displayBalanceDueDate && ` (due ${formatDateShort(displayBalanceDueDate)})`}.
                      </div>
                    </div>
                  </div>
                </label>
              )}
```

- [ ] **Step 6.4: Fix the `paymentRequired` / Stripe-form visibility condition**

Line 193:

```javascript
  const paymentRequired = paymentScenario === 'extras_required' || paymentScenario === 'extras_plus_balance';
```

No change needed — the old variable still works.

The Stripe form render condition (line 546) is:

```javascript
          {(paymentRequired || paymentChoice === 'pay_now') && (
```

Replace with:

```javascript
          {(paymentRequired || paymentChoice === 'pay_now' || paymentChoice === 'pay_everything') && (
```

- [ ] **Step 6.5: Fix the "submit without pay" fallback condition**

Line 581:

```javascript
      {(!showPayment || !paymentScenario || (paymentScenario === 'extras_optional' && paymentChoice === 'add_to_balance') || paymentError) && (
```

No change needed — `paymentChoice === 'add_to_balance'` is still the correct check for "submit without charging."

- [ ] **Step 6.6: Lint check the file**

Run: `npx eslint client/src/pages/plan/steps/ConfirmationStep.js --max-warnings 0`
Expected: no errors. If the project has a lint warning about the `react-hooks/exhaustive-deps` comment, that's pre-existing — leave it.

---

## Task 7 — Manual smoke test

No automated tests exist in this project. Manual verification is the gate. Run through every scenario in a browser with Stripe test mode active.

- [ ] **Step 7.1: Start the dev server**

Run: `npm run dev`
Expected: Express on :5000, React on :3000. Check the console prints.

- [ ] **Step 7.2: Confirm Stripe test mode is active**

Run: `node -e "const sc = require('./server/utils/stripeClient'); const stripe = sc.getStripe(); console.log(stripe ? 'stripe-client-ok' : 'no-stripe-client');"`
Expected: `stripe-client-ok`.

Verify `.env` has `STRIPE_TEST_MODE_UNTIL` set to a date in the future OR that `STRIPE_SECRET_KEY` is a test key. If live-mode creds are active, stop — don't run live charges for smoke tests.

- [ ] **Step 7.3: Pick a test proposal**

Either seed one via `npm run seed:testdata` or use the admin dashboard to create a test proposal for an existing test client. Requirements:
- Event date ≥ 30 days out (so not past-due)
- Deposit already paid (so a `Balance` invoice exists)
- Has a drink plan created via "For Proposal" button

Record the drink plan token for the scenarios below.

- [ ] **Step 7.4: Scenario A — Pay extras only**

1. Open the drink plan URL: `http://localhost:3000/plan/<token>` and complete the wizard with at least one priced add-on.
2. On the Confirmation step, verify three radio options appear under Payment: "Pay Now", "Pay Extras + Balance in Full", "Add to My Balance".
3. Select "Pay Now" (default).
4. Use Stripe test card `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP. Submit.
5. Check the admin:
   - Proposal detail → Invoices tab shows a new `INV-XXXX` labeled **"Drink Plan Extras"**, status **paid**, locked.
   - Line items include the add-on, bar rental if selected, and/or "Hand-Crafted Syrups" if syrups were chosen.
   - The existing `Balance` invoice is **unchanged** (amount_due still matches the pre-drink-plan balance, amount_paid unchanged).
   - Proposal `amount_paid` incremented by the extras amount.

- [ ] **Step 7.5: Scenario B — Pay extras + balance in full**

Repeat with a fresh test proposal (deposit-paid, non-past-due).
1. In the wizard, add extras.
2. On Confirmation, select "Pay Extras + Balance in Full".
3. Total shown on the pay button should equal `extras + (total_price - amount_paid)`.
4. Pay with test card.
5. Admin verification:
   - New "Drink Plan Extras" invoice created, **paid**, locked.
   - Existing **Balance** invoice: `amount_paid` incremented by the balance portion, status now **paid**, locked.
   - `invoice_payments` has two rows tied to the same `payment_id` — one for extras cents, one for balance cents. Verify with `psql`:
     ```sql
     SELECT ip.invoice_id, i.label, ip.amount
       FROM invoice_payments ip
       JOIN invoices i ON i.id = ip.invoice_id
       JOIN proposal_payments pp ON pp.id = ip.payment_id
      WHERE pp.stripe_payment_intent_id = '<intent_id>';
     ```
   - Proposal `amount_paid = total_price`, `status = 'balance_paid'`.

- [ ] **Step 7.6: Scenario C — Add to balance**

Repeat with a fresh test proposal.
1. In the wizard, add extras.
2. On Confirmation, select "Add to My Balance". Verify the Stripe payment form is NOT shown.
3. Click "Submit My Drink Plan".
4. Admin verification:
   - No new invoice created.
   - Existing **Balance** invoice: `amount_due` increased by the extras cost, line items now include the new add-on(s), invoice still `sent` (unlocked, unpaid).
   - Proposal `total_price` increased by the extras amount.

- [ ] **Step 7.7: Scenario D — Past-due forced pay**

Manually UPDATE a test proposal's `balance_due_date` to yesterday via psql:
```sql
UPDATE proposals SET balance_due_date = NOW() - INTERVAL '1 day' WHERE id = <proposalId>;
```

1. Open the drink plan, add extras.
2. Confirmation step: verify `extras_plus_balance` scenario — radio options NOT shown, combined charge is forced.
3. Pay with test card.
4. Admin verification: same outcome as Scenario B (extras invoice paid + Balance invoice paid).

- [ ] **Step 7.8: Scenario E — Extras with no balance**

Use a proposal where `total_price === amount_paid` (already paid in full). Add extras via the drink plan.
1. Expect to see two options only: "Pay Now" and "Add to My Balance" (no middle option, since `balanceOptionAvailable` is false).
2. Pay.
3. Admin verification: new "Drink Plan Extras" invoice paid. Proposal `amount_paid` exceeds `total_price` by the extras cents (overpayment is acceptable — `amount_paid` is just a running tally).

- [ ] **Step 7.9: Check webhook log for warnings**

Run: `grep -i 'Unapplied drink-plan balance' logs/*.log 2>/dev/null || echo 'no warnings'`
(Or check wherever server logs go in your env.)

Expected: the only warnings should come from Scenario E's overpayment if any — no `Unapplied` messages should appear for Scenarios A–D.

---

## Task 8 — Update documentation

**Files:**
- Modify: `CLAUDE.md` (no folder-tree changes needed — no new files)
- Modify: `ARCHITECTURE.md` (database schema or invoicing section if present)

- [ ] **Step 8.1: Check CLAUDE.md and ARCHITECTURE.md for invoicing / payment flow sections**

Run: `grep -n -i 'drink.plan\|invoice' CLAUDE.md ARCHITECTURE.md README.md 2>/dev/null | head -40`

If any mentions the drink-plan payment flow or the list of invoice labels, update to include `'Drink Plan Extras'` as a label. If nothing mentions it, skip this task.

- [ ] **Step 8.2: Add a one-line note to ARCHITECTURE.md's "Invoice labels" section if such exists**

Text to insert if the section exists:

> **Drink Plan Extras** — created by the Stripe webhook when a client pays for drink-plan extras from the Potion Planning Lab. Line items are the extras the client selected (add-ons, bar rental, syrups). Always created in `paid` + `locked` state via the webhook path.

Skip if no such section exists.

---

## Task 9 — Pre-push review + commit

- [ ] **Step 9.1: Inspect the diff**

Run: `git diff --stat` then `git diff`
Expected: changes in exactly four files: `server/utils/invoiceHelpers.js`, `server/routes/stripe.js`, `server/routes/drinkPlans.js`, `client/src/pages/plan/steps/ConfirmationStep.js`. Optionally `ARCHITECTURE.md` if Task 8 applied.

- [ ] **Step 9.2: Stage only the expected files**

Run the following (adjust filename list to match what actually changed):

```bash
git add server/utils/invoiceHelpers.js \
        server/routes/stripe.js \
        server/routes/drinkPlans.js \
        client/src/pages/plan/steps/ConfirmationStep.js
```

(Include `ARCHITECTURE.md` in the `git add` list only if Task 8 wrote to it.)

- [ ] **Step 9.3: Run the 5 review agents in parallel (per CLAUDE.md Git Workflow Rule 6)**

This is a money/payments/webhook change, so all five auto-running agents must pass before pushing: `consistency-check`, `code-review`, `security-review`, `database-review`, `performance-review`.

Launch all five in parallel from the top-level assistant (NOT as child agents of this plan executor). If any agent flags a blocker, stop, report, and fix before committing.

- [ ] **Step 9.4: Commit**

Run:

```bash
git commit -m "feat(potion-lab): generate invoice on pay-now; offer voluntary pay-in-full"
```

- [ ] **Step 9.5: Confirm commit and stop**

Run: `git log -1 --stat`
Expected: single commit with the four (or five) modified files.

**Do not push.** The user will give the push cue separately per CLAUDE.md Rule 4.

---

## Self-review notes (inline)

- **Spec coverage:** All five server-side changes from the spec ("new helpers ×2", "intent endpoint", "webhook", "drink plan submit refresh") are covered by Tasks 1–5. UI change is Task 6. Manual testing for every scenario named in the spec's Testing section is covered by Task 7.4–7.9.
- **Type consistency:** Helper names used in Task 4 (`createDrinkPlanExtrasInvoice`, `findOpenInvoiceForBalance`) match the signatures defined in Tasks 1–2. `paymentChoice` values (`'extras_only'` | `'with_balance'`) used in Task 3 match what the UI sends in Task 6.2 (client maps its three-way UI state to these two server values).
- **Edge cases handled:** Webhook branch for `drink_plan_with_balance` without an open invoice logs to Sentry (per spec). Duplicate webhook delivery handled by the existing `ON CONFLICT DO NOTHING` on `proposal_payments`. Syrup line-item fallback is computed by diffing `extras_amount_cents` from addon+bar totals — no re-implementing the syrup calculator in the webhook.
- **No placeholders:** Every code block is complete. Every command is exact.

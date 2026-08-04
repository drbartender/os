---
lanes:
  - id: grat-intent-webhook
    footprint:
      - server/routes/stripeCreateIntent.js
      - server/routes/stripeCreateIntent.test.js
      - server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js
      - server/routes/stripeWebhook.gratuityApply.test.js
      - scripts/money-smoke-list.txt
      # Fix round 1: deliberate widening — the floor must be re-asserted on the
      # DERIVED rate in the engine (merge-fleet blocker, cross-confirmed x3).
      - server/utils/pricingEngine.js
      - server/utils/pricingEngine.test.js
    deps: []
    review: full-fleet
  - id: grat-admin-lockdown
    footprint:
      - server/routes/proposals/crud.js
      - server/routes/proposals/crud.test.js
      - server/routes/proposals/metadata.js
      - server/routes/proposals/metadata.calculate.test.js
      - server/utils/changeRequests.js
      - server/utils/changeRequests.gratuity.test.js
      - client/src/pages/admin/proposalEditor/ProposalEditorForm.js
      - client/src/pages/admin/proposalEditor/patchBody.js
      - client/src/pages/admin/proposalEditor/patchBody.test.js
      - client/src/pages/admin/proposalEditor/formState.js
    deps: []
    review: full-fleet
  - id: grat-copy-reset
    footprint:
      - client/src/pages/proposal/proposalView/SignAndPaySection.js
      # Fix round 1: comment-only cleanup of two stale server-behavior comments
      # (ProposalView.js:265, :273-274) found by lane-1 consistency review.
      - client/src/pages/proposal/proposalView/ProposalView.js
      - scripts/reset-unpaid-gratuity.js
      - scripts/reset-unpaid-gratuity.test.js
      - README.md
      - ARCHITECTURE.md
      - .claude/CLAUDE.md
    # deps are real, not ceremonial: Task 9 writes "admin PATCH never accepts
    # tip_jar" into the CLAUDE.md invariant (true only once grat-admin-lockdown
    # merges), and the reset script's prod run is only safe once
    # grat-intent-webhook is DEPLOYED (else abandoned checkouts regrow the rows).
    deps: [grat-intent-webhook, grat-admin-lockdown]
    review: full-fleet
---

# Gratuity Election at Payment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-08-03-gratuity-election-at-payment-design.md`

**Goal:** The client's tip-jar election is made at sign-and-pay and persists to the proposal only when payment succeeds; unpaid proposals never carry a gratuity, and the admin editor loses its gratuity write path.

**Architecture:** `create-intent` computes the gratuity in memory and stamps the election into PaymentIntent metadata; the `payment_intent.succeeded` webhook applies it inside its existing transaction, under the same lifecycle guard as the credit, before the balance invoice is minted. Admin PATCH carries the stored rate forward untouched (staffing rescale + notices intact). A one-off script strips self-elected gratuity from ~13 unpaid prod proposals.

**Tech Stack:** Express 4 / raw SQL via `pg`, Stripe PaymentIntents, node:test route harnesses (fake Stripe via the `getStripe` seam; HMAC-signed webhook posts), React 18 (CRA).

## Global Constraints

- Proposal money is DOLLARS; Stripe/invoices are integer CENTS. The only conversion in this work is `Math.round(total * 100)` at intent creation.
- The gratuity floor value, `recomputeSnapshotGratuity`, `gratuityLabels.js`, the DB CHECK, and all System B "Shared Gratuity" logic are UNTOUCHED. One deliberate engine carve-out (fix round 1): `deriveGratuityRate` gains a floor re-assert on the derived ROUNDED rate — nothing else in the engine moves.
- Metadata contract (both lanes must match exactly): `tip_jar` = `String(boolean)` (`'true'`/`'false'`), `gratuity_rate` = `String(rate)` (e.g. `'50'`, `'27.5'`). Present on an intent only when the client sent an election; absence means "do not touch the proposal's gratuity".
- No em dashes in any client-facing copy.
- Server suites run one at a time from repo root: `node --test <file>`. They hit the shared dev DB. Client changes verify with `cd client && CI=true npx react-scripts build`.
- Tests refuse to run when `NODE_ENV === 'production'` (copy the guard from the neighboring suites).

---

## Lane grat-intent-webhook

### Task 1: create-intent computes in memory, stamps metadata

**Files:**
- Modify: `server/routes/stripeCreateIntent.js` (whole gratuity section, lines 72-171 and 176-223)
- Test: `server/routes/stripeCreateIntent.test.js` (new)

**Interfaces:**
- Consumes: `deriveGratuityRate`, `gratuityBasisFromSnapshot`, `recomputeSnapshotGratuity` from `server/utils/pricingEngine.js` (unchanged signatures).
- Produces: PaymentIntents whose `metadata` may carry `tip_jar`/`gratuity_rate` per the Global Constraints contract. Task 2's webhook reads exactly those keys. Response shape unchanged: `{ clientSecret, total_price, gratuity }`.

- [ ] **Step 1: Write the failing tests**

Create `server/routes/stripeCreateIntent.test.js` on the pattern of `server/routes/stripe.invoiceIntentArchived.test.js` (fake Stripe installed on `require('../utils/stripeClient').getStripe` BEFORE requiring the router; real express app mounting `./stripe`; real HTTP; dev-DB seeds cleaned in `after()`; production guard). The fake Stripe needs `customers.retrieve/create` and `paymentIntents.create/retrieve/cancel` with spy arrays `createCalls`, `cancelCalls`, and a settable `retrieveResult`.

Seed helper (snapshot carries the frozen gratuity basis so `gratuityBasisFromSnapshot` resolves 1 staff x 5h):

```js
const SNAPSHOT = {
  total: 450,
  breakdown: [{ label: 'The Core Reaction (5hrs, 50 guests)', amount: 450 }],
  staffing: { actual: 1 },
  staff_noun: 'bartender',
  gratuity: { rate: 0, tip_jar: true, staff_count: 1, hours: 5, staff_noun: 'bartender', total: 0 },
};
async function seedProposal() {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Grat Intent Test', $1) RETURNING id`,
    [`grat-intent-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, total_price, tip_jar, gratuity_rate,
                            event_date, event_duration_hours, pricing_snapshot, stripe_customer_id, token)
     VALUES ($1, 'viewed', 'wedding', 450, true, 0,
             CURRENT_DATE + INTERVAL '60 days', 5, $2, 'cus_faketest', $3)
     RETURNING id, token`,
    [c.rows[0].id, JSON.stringify(SNAPSHOT), crypto.randomUUID()]
  );
  proposalIds.push(p.rows[0].id);
  return p.rows[0];
}
```

Define a `post(path, body)` helper mirroring the HTTP request helper in `stripe.invoiceIntentArchived.test.js` (node `http.request`, JSON body, resolves `{ status, body }`). Test cases (each POSTs `/api/stripe/create-intent/:token`):

```js
test('full-pay with skip-jar election: correct charge + metadata, NO proposal write', async () => {
  const p = await seedProposal();
  const res = await post(`/api/stripe/create-intent/${p.token}`,
    { payment_option: 'full', tip_jar: false, gratuity_total: 250 });
  assert.equal(res.status, 200, res.body);
  const call = createCalls[createCalls.length - 1];
  assert.equal(call.amount, 70000, 'charged the in-memory gratuity-inclusive total');
  assert.equal(call.metadata.tip_jar, 'false');
  assert.equal(call.metadata.gratuity_rate, '50');
  const body = JSON.parse(res.body);
  assert.equal(body.total_price, 700);
  assert.equal(body.gratuity.total, 250);
  const row = (await pool.query(
    'SELECT tip_jar, gratuity_rate, total_price, pricing_snapshot FROM proposals WHERE id = $1', [p.id])).rows[0];
  assert.equal(row.tip_jar, true, 'election NOT persisted');
  assert.equal(Number(row.gratuity_rate), 0, 'rate NOT persisted');
  assert.equal(Number(row.total_price), 450, 'total NOT rewritten');
  assert.ok(!row.pricing_snapshot.breakdown.some(l => l.label === 'Gratuity'), 'no Gratuity line persisted');
});

test('deposit with skip-jar election: flat deposit amount, metadata present, no write', async () => {
  const p = await seedProposal();
  const res = await post(`/api/stripe/create-intent/${p.token}`,
    { payment_option: 'deposit', tip_jar: false, gratuity_total: 250 });
  assert.equal(res.status, 200, res.body);
  const call = createCalls[createCalls.length - 1];
  assert.equal(call.amount, 10000, 'deposit stays flat regardless of election');
  assert.equal(call.metadata.tip_jar, 'false');
  assert.equal(call.metadata.gratuity_rate, '50');
  const row = (await pool.query(
    'SELECT tip_jar, gratuity_rate, total_price FROM proposals WHERE id = $1', [p.id])).rows[0];
  assert.equal(row.tip_jar, true, 'election NOT persisted');
  assert.equal(Number(row.gratuity_rate), 0, 'rate NOT persisted');
  assert.equal(Number(row.total_price), 450, 'total NOT rewritten');
});

test('below-floor no-jar election: 400, no Stripe call, no write', async () => {
  const p = await seedProposal();
  const before = createCalls.length;
  const res = await post(`/api/stripe/create-intent/${p.token}`,
    { payment_option: 'deposit', tip_jar: false, gratuity_total: 100 }); // floor is 250
  assert.equal(res.status, 400);
  assert.equal(createCalls.length, before, 'no intent created');
});

test('metadata-bearing pending intent is cancelled, never reused, by a metadata-less request', async () => {
  const p = await seedProposal();
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, 'pi_stale_meta', 10000, 'pending')`, [p.id]);
  retrieveResult = { id: 'pi_stale_meta', status: 'requires_payment_method',
    client_secret: 'sec_stale', metadata: { tip_jar: 'false', gratuity_rate: '50' } };
  const res = await post(`/api/stripe/create-intent/${p.token}`, { payment_option: 'deposit' });
  assert.equal(res.status, 200, res.body);
  assert.ok(cancelCalls.includes('pi_stale_meta'), 'stale election intent cancelled');
  const call = createCalls[createCalls.length - 1];
  assert.equal(call.metadata.tip_jar, undefined, 'fresh intent carries no election');
  const sess = (await pool.query(
    "SELECT status FROM stripe_sessions WHERE stripe_payment_intent_id = 'pi_stale_meta'")).rows[0];
  assert.equal(sess.status, 'canceled');
});

test('metadata-less pending intent at the same amount is still reused (existing behavior)', async () => {
  const p = await seedProposal();
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, 'pi_reusable', 10000, 'pending')`, [p.id]);
  retrieveResult = { id: 'pi_reusable', status: 'requires_payment_method',
    client_secret: 'sec_reuse', metadata: {} };
  const before = createCalls.length;
  const res = await post(`/api/stripe/create-intent/${p.token}`, { payment_option: 'deposit' });
  assert.equal(res.status, 200, res.body);
  assert.equal(JSON.parse(res.body).clientSecret, 'sec_reuse', 'reused the pending intent');
  assert.equal(createCalls.length, before, 'no new intent minted');
});
```

- [ ] **Step 2: Run to verify the right failures**

Run: `node --test server/routes/stripeCreateIntent.test.js`
Expected: the no-write assertions FAIL (today the route persists `tip_jar=false, gratuity_rate=50, total_price=700`), and the metadata assertions FAIL (`call.metadata.tip_jar` undefined). The stale-metadata-cancel case ALSO fails RED — today's reuse branch (`stripeCreateIntent.js:139-152`) sees a metadata-less request at a matching amount and returns the pending intent early, so no cancel happens. Only the below-floor and metadata-less-reuse cases pass RED.

- [ ] **Step 3: Rewrite the gratuity section of the route**

In `server/routes/stripeCreateIntent.js`, replace the persist transaction (lines 72-125) with:

```js
  // Election-at-payment (spec 2026-08-03): compute the gratuity IN MEMORY only.
  // Nothing is written to the proposal here; the election rides the
  // PaymentIntent metadata and is applied by the webhook when payment succeeds.
  // An abandoned checkout leaves the proposal untouched — no Gratuity line can
  // ever appear on an unpaid quote.
  let effSnap = proposal.pricing_snapshot || {};
  let election = null; // { tipJar, rate } when the client sent one this request
  if (gratuityProvided) {
    const { staffCount, hours } = gratuityBasisFromSnapshot(effSnap, proposal.event_duration_hours);
    // Can't skip the jar with no crew/hours — force it on (mirrors the old path).
    const effTipJar = (staffCount * hours) <= 0 ? true : (tip_jar !== false);
    const g = deriveGratuityRate({
      enteredTotal: gratuity_total !== undefined ? gratuity_total : 0,
      staffCount, hours, tipJar: effTipJar,
    });
    if (!g.ok) throw new ValidationError({ gratuity: g.message });
    effSnap = recomputeSnapshotGratuity(effSnap, {
      gratuityRate: g.rate, tipJar: effTipJar,
      staffNoun: effSnap.staff_noun, durationHours: proposal.event_duration_hours,
    });
    election = { tipJar: effTipJar, rate: g.rate };
  }
  const effTotal = gratuityProvided ? effSnap.total : Number(proposal.total_price);
```

Then update the amount (replace `Number(proposal.total_price)` at line 130 with `effTotal`) and replace the reuse/stale block (lines 133-171) with an identity check that includes the election:

```js
  // Intent identity = (amount, election metadata). A deposit is $100 regardless
  // of election, so amount alone can no longer identify an intent (spec §3).
  const reqMeta = election
    ? { tip_jar: String(election.tipJar), gratuity_rate: String(election.rate) }
    : null;
  const existing = await pool.query(
    "SELECT stripe_payment_intent_id, amount FROM stripe_sessions WHERE proposal_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    [proposal.id]
  );
  if (existing.rows[0]) {
    try {
      const intent = await stripe.paymentIntents.retrieve(existing.rows[0].stripe_payment_intent_id);
      const intentMeta = (intent.metadata && intent.metadata.tip_jar !== undefined)
        ? { tip_jar: intent.metadata.tip_jar, gratuity_rate: intent.metadata.gratuity_rate }
        : null;
      const amountMatch = existing.rows[0].amount === amount;
      const metaMatch = (reqMeta === null && intentMeta === null)
        || (reqMeta !== null && intentMeta !== null
            && reqMeta.tip_jar === intentMeta.tip_jar
            && reqMeta.gratuity_rate === intentMeta.gratuity_rate);
      // Reuse ONLY a metadata-less intent for a metadata-less request: an
      // election-bearing intent is never reused (a reload resets the client's
      // UI state; confirming a stale election the client can no longer see is
      // exactly the harm this redesign removes).
      if (amountMatch && reqMeta === null && intentMeta === null
          && (intent.status === 'requires_payment_method' || intent.status === 'requires_confirmation')) {
        return res.json({
          clientSecret: intent.client_secret,
          total_price: effTotal,
          gratuity: (effSnap && effSnap.gratuity) || null,
        });
      }
      // Stale-intent safety: cancel when the identity (amount OR election)
      // no longer matches, so a stale tab can't confirm an old total/election.
      if ((!amountMatch || !metaMatch)
          && !['succeeded', 'processing', 'canceled'].includes(intent.status)) {
        await stripe.paymentIntents.cancel(intent.id);
        await pool.query(
          "UPDATE stripe_sessions SET status = 'canceled' WHERE stripe_payment_intent_id = $1",
          [intent.id]
        );
      }
    } catch (e) { /* intent gone/unretrievable — create fresh */ }
  }
```

Stamp the election into the new intent's metadata (lines 184-187):

```js
    metadata: {
      proposal_id: String(proposal.id),
      payment_type: isFullPay ? 'full' : 'deposit',
      ...(reqMeta || {}),
    },
```

And build the final response from the in-memory values (lines 219-223):

```js
  res.json({
    clientSecret: paymentIntent.client_secret,
    total_price: effTotal,
    gratuity: (effSnap && effSnap.gratuity) || null,
  });
```

Update the file-header comment (it still says "gratuity persist/recompute"). The `pool.connect`/`BEGIN`/`FOR UPDATE` machinery goes away entirely — NAMED REMOVAL: the old under-lock ALREADY_PAID re-check goes with it (spec §3: bounded, because this route no longer writes; a paid-mid-request proposal can at worst mint a fresh intent, and the webhook's additive credit records what is actually charged). `ConflictError` is still used by the top-of-route status guards; keep all imports that remain referenced.

Accepted hole (state it in the code comment, do not "fix" it): when the request carries an election and a pending intent exists with the SAME amount and SAME metadata, the intent is neither reused nor cancelled — a second identical intent is minted alongside it. Harmless (both charge the same amount and carry the same election) and matches today's behavior.

- [ ] **Step 4: Run the new suite and the neighbors**

Run: `node --test server/routes/stripeCreateIntent.test.js`
Expected: PASS.
Run: `node --test server/routes/stripe.invoiceIntentArchived.test.js`
Expected: PASS (route file shape changed; this proves the mount still works).

- [ ] **Step 5: Commit (lane checkpoint)**

```bash
git add server/routes/stripeCreateIntent.js server/routes/stripeCreateIntent.test.js
git commit -m "feat(gratuity): create-intent computes election in memory, stamps intent metadata"
```

### Task 2: webhook applies the election on payment success

**Files:**
- Modify: `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js` (insert one block before the credit branches, ~line 143)
- Test: `server/routes/stripeWebhook.gratuityApply.test.js` (new)

**Interfaces:**
- Consumes: intent `metadata.tip_jar` / `metadata.gratuity_rate` exactly as produced by Task 1; `recomputeSnapshotGratuity` from `server/utils/pricingEngine.js`.
- Produces: on first delivery of a `deposit`/`full` intent carrying election metadata, the proposal's `tip_jar`, `gratuity_rate`, `pricing_snapshot`, `total_price` reflect the election BEFORE the credit and BEFORE `createBalanceInvoice`.

- [ ] **Step 1: Write the failing tests**

Create `server/routes/stripeWebhook.gratuityApply.test.js` on the pattern of `server/routes/stripeWebhook.balanceBranch.test.js` (known `STRIPE_WEBHOOK_SECRET`, local HMAC `sign()`, `postWebhook()` over real HTTP, production guard, seeds cleaned in `after()`). Copy the harness env lines EXACTLY, including `process.env.STRIPE_WEBHOOK_SECRET_TEST = ''` (`balanceBranch:8`) — without it the dispatch-level test-mode gate in `server/routes/stripeWebhook.js` ack-and-drops the event (`{received:true, skipped:'test_mode'}`) and every assertion fails for the wrong reason. Do not put `livemode` in the event fixture. Seed helper (same snapshot shape as Task 1, repeated here so this task stands alone):

```js
const SNAPSHOT = {
  total: 450,
  breakdown: [{ label: 'The Core Reaction (5hrs, 50 guests)', amount: 450 }],
  staffing: { actual: 1 },
  staff_noun: 'bartender',
  gratuity: { rate: 0, tip_jar: true, staff_count: 1, hours: 5, staff_noun: 'bartender', total: 0 },
};
async function seedProposal() {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Grat Apply Test', $1) RETURNING id`,
    [`grat-apply-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, total_price, amount_paid,
                            tip_jar, gratuity_rate, event_date, event_duration_hours,
                            pricing_snapshot, token)
     VALUES ($1, 'viewed', 'wedding', 450, 0, true, 0,
             CURRENT_DATE + INTERVAL '60 days', 5, $2, $3)
     RETURNING id`,
    [c.rows[0].id, JSON.stringify(SNAPSHOT), crypto.randomUUID()]
  );
  proposalIds.push(p.rows[0].id);
  return p.rows[0].id;
}
```

```js
function intentEvent({ proposalId, amount, paymentType, meta = {}, piId }) {
  return {
    id: `evt_${piId}`, type: 'payment_intent.succeeded',
    data: { object: { id: piId, amount, payment_method: null,
      metadata: { proposal_id: String(proposalId), payment_type: paymentType, ...meta } } },
  };
}

test('deposit with skip-jar metadata: election applied before credit + balance invoice', async () => {
  const id = await seedProposal();
  const res = await postWebhook(intentEvent({ proposalId: id, amount: 10000, paymentType: 'deposit',
    meta: { tip_jar: 'false', gratuity_rate: '50' }, piId: `pi_grat_dep_${NONCE}` }));
  assert.equal(res.status, 200, res.body);
  const p = (await pool.query(
    'SELECT tip_jar, gratuity_rate, total_price, amount_paid, status, pricing_snapshot FROM proposals WHERE id = $1',
    [id])).rows[0];
  assert.equal(p.tip_jar, false);
  assert.equal(Number(p.gratuity_rate), 50);
  assert.equal(Number(p.total_price), 700, 'gratuity folded into total at payment');
  assert.equal(Number(p.amount_paid), 100);
  assert.equal(p.status, 'deposit_paid');
  assert.equal(Number(p.pricing_snapshot.gratuity.total), 250);
  assert.ok(p.pricing_snapshot.breakdown.some(l => l.label === 'Gratuity'));
  const inv = (await pool.query(
    "SELECT amount_due FROM invoices WHERE proposal_id = $1 AND label = 'Balance'", [id])).rows[0];
  assert.equal(Number(inv.amount_due), 60000, 'balance invoice = (700 - 100) in cents');
});

test('full-pay with metadata: balance_paid at the gratuity-inclusive total', async () => {
  const id = await seedProposal();
  await postWebhook(intentEvent({ proposalId: id, amount: 70000, paymentType: 'full',
    meta: { tip_jar: 'false', gratuity_rate: '50' }, piId: `pi_grat_full_${NONCE}` }));
  const p = (await pool.query(
    'SELECT total_price, amount_paid, status FROM proposals WHERE id = $1', [id])).rows[0];
  assert.equal(Number(p.total_price), 700);
  assert.equal(Number(p.amount_paid), 700);
  assert.equal(p.status, 'balance_paid');
});

test('no election metadata: gratuity untouched (balance/invoice/legacy path)', async () => {
  const id = await seedProposal();
  await postWebhook(intentEvent({ proposalId: id, amount: 10000, paymentType: 'deposit',
    piId: `pi_grat_none_${NONCE}` }));
  const p = (await pool.query(
    'SELECT tip_jar, gratuity_rate, total_price FROM proposals WHERE id = $1', [id])).rows[0];
  assert.equal(p.tip_jar, true);
  assert.equal(Number(p.gratuity_rate), 0);
  assert.equal(Number(p.total_price), 450);
});

test('full-pay onto an existing pre-gratuity Full Payment invoice: link caps, overflow logged', async () => {
  // Pre-existing behavior surfaced deliberately (review finding): a non-grouped
  // proposal gets a 'Full Payment' invoice minted AT SEND for the pre-gratuity
  // total. Raising total_price in-tx then linking the 70000c charge hits the
  // cap in linkPaymentToInvoice and logs invoice_link_overflow_capped. This
  // test freezes that behavior so it is a decision, not a surprise.
  const id = await seedProposal();
  const invToken = crypto.randomUUID();
  await pool.query(
    `INSERT INTO invoices (proposal_id, token, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, $3, 'Full Payment', 45000, 0, 'open')`,
    [id, invToken, `INV${crypto.randomBytes(5).toString('hex')}`]);
  await postWebhook(intentEvent({ proposalId: id, amount: 70000, paymentType: 'full',
    meta: { tip_jar: 'false', gratuity_rate: '50' }, piId: `pi_grat_inv_${NONCE}` }));
  const p = (await pool.query(
    'SELECT total_price, amount_paid, status FROM proposals WHERE id = $1', [id])).rows[0];
  assert.equal(Number(p.total_price), 700);
  assert.equal(Number(p.amount_paid), 700);
  const inv = (await pool.query(
    "SELECT amount_paid FROM invoices WHERE proposal_id = $1 AND label = 'Full Payment'", [id])).rows[0];
  assert.equal(Number(inv.amount_paid), 45000, 'link capped at the invoice amount_due');
  // If the implementer finds linkPaymentToInvoice behaves differently against a
  // raised total, adjust the assertion to the OBSERVED behavior and flag it in
  // the lane summary — the point is to record what happens, not to guess.
});

test('duplicate delivery: election + credit applied exactly once', async () => {
  const id = await seedProposal();
  const evt = intentEvent({ proposalId: id, amount: 10000, paymentType: 'deposit',
    meta: { tip_jar: 'false', gratuity_rate: '50' }, piId: `pi_grat_dup_${NONCE}` });
  await postWebhook(evt);
  await postWebhook(evt);
  const p = (await pool.query(
    'SELECT total_price, amount_paid FROM proposals WHERE id = $1', [id])).rows[0];
  assert.equal(Number(p.total_price), 700, 'not re-applied');
  assert.equal(Number(p.amount_paid), 100, 'not re-credited');
});
```

Cleanup in `after()` must also delete the minted `invoices`, `proposal_payments`, `stripe_sessions`, and `scheduled_messages`/shift rows the deposit conversion creates for these proposal ids (copy the delete list from `stripeWebhook.balanceBranch.test.js` and extend as needed until `after()` leaves no rows behind).

- [ ] **Step 2: Run to verify the right failures**

Run: `node --test server/routes/stripeWebhook.gratuityApply.test.js`
Expected: the deposit, full-pay, AND duplicate-delivery cases all FAIL (each asserts `total_price` 700; pre-implementation it stays 450). Only the no-metadata case passes vacuously RED.

- [ ] **Step 3: Implement the apply block**

In `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js`, add the import at the top with the other requires:

```js
const { recomputeSnapshotGratuity } = require('../../utils/pricingEngine');
```

Insert immediately before the `// Determine new status and amount_paid based on payment type` comment (~line 143), inside `isFirstDelivery`:

```js
          // Election-at-payment (spec 2026-08-03): a deposit/full intent minted
          // at sign-and-pay carries the client's tip-jar election in metadata.
          // Apply it NOW — under the SAME lifecycle guard as the credit below,
          // and BEFORE the credit + createBalanceInvoice, so the derived status
          // and the Balance invoice both see the gratuity-inclusive total.
          // Metadata absent (balance / invoice / drink-plan / legacy client) =
          // no gratuity write at all. The rate passed deriveGratuityRate at
          // intent creation, so the DB CHECK (tip_jar OR rate >= 50) holds by
          // construction even if staffing changed mid-flight.
          if ((paymentType === 'full' || paymentType === 'deposit')
              && intent.metadata?.tip_jar !== undefined) {
            const electTipJar = intent.metadata.tip_jar !== 'false';
            const electRate = Number(intent.metadata.gratuity_rate) || 0;
            // FOR UPDATE: this handler holds no proposal row lock of its own
            // (the hoist above locks only the CLIENT row), and the admin PATCH
            // does hold proposals FOR UPDATE — an unlocked read-modify-write of
            // the snapshot here could lose-update against a concurrent edit.
            const gRow = await dbClient.query(
              `SELECT pricing_snapshot, event_duration_hours FROM proposals
                WHERE id = $1 AND status NOT IN ('confirmed', 'completed', 'archived')
                FOR UPDATE`,
              [proposalId]
            );
            if (gRow.rows[0]) {
              const snap = gRow.rows[0].pricing_snapshot || {};
              const newSnap = recomputeSnapshotGratuity(snap, {
                gratuityRate: electRate, tipJar: electTipJar,
                staffNoun: snap.staff_noun, durationHours: gRow.rows[0].event_duration_hours,
              });
              // origin explicitly NULL: this is a CLIENT election — a stale
              // pre-existing 'admin'/'staffing' origin must not mislabel it.
              await dbClient.query(
                `UPDATE proposals SET tip_jar = $1, gratuity_rate = $2,
                        gratuity_rate_change_origin = NULL,
                        pricing_snapshot = $3, total_price = $4, updated_at = NOW()
                  WHERE id = $5 AND status NOT IN ('confirmed', 'completed', 'archived')`,
                [electTipJar, electRate, JSON.stringify(newSnap), newSnap.total, proposalId]
              );
            }
          }
```

The guard mirrors the credit branches exactly (`status NOT IN ('confirmed','completed','archived')`): a total must never rise on a row whose credit is refused, or total and amount_paid desync. Every query uses `dbClient` (one pooled connection per request — invariant).

- [ ] **Step 4: Run the new suite and every existing webhook suite**

Run each, one at a time (this is every suite that drives `paymentIntentSucceeded.js`):
```
node --test server/routes/stripeWebhook.gratuityApply.test.js
node --test server/routes/stripe.webhook.test.js
node --test server/routes/stripeWebhook.balanceBranch.test.js
node --test server/routes/stripeWebhook.invoiceLink.test.js
node --test server/routes/stripeWebhook.archivedSettle.test.js
node --test server/routes/stripeWebhook.guards.test.js
node --test server/routes/stripeWebhook.optionGroup.test.js
node --test server/routes/stripeWebhook.extrasLink.test.js
```
Expected: all PASS. (There is no `stripeWebhook.test.js` — the base suite is `stripe.webhook.test.js`.)

Also append `server/routes/stripeWebhook.gratuityApply.test.js` and `server/routes/stripeCreateIntent.test.js` to `scripts/money-smoke-list.txt` so the pre-push money gate covers the new seam.

- [ ] **Step 5: Commit (lane checkpoint)**

```bash
git add server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js server/routes/stripeWebhook.gratuityApply.test.js scripts/money-smoke-list.txt
git commit -m "feat(gratuity): webhook applies the tip-jar election on payment success"
```

---

## Lane grat-admin-lockdown

### Task 3: admin PATCH stops accepting the election

**Files:**
- Modify: `server/routes/proposals/crud.js:310` (destructure), `:453-491` (gratuity resolve block), `:596-605` (dead audit branch)
- Test: `server/routes/proposals/crud.test.js` (Cases 21/23 removed, one case added)

**Interfaces:**
- Consumes: `old` row (`tip_jar`, `gratuity_rate`, `gratuity_rate_change_origin`, `amount_paid`) already loaded by the PATCH.
- Produces: PATCH ignores `tip_jar`/`gratuity_total` in any body; stored rate/jar always carried into `calculateProposal`; staffing-driven rescale + `origin='staffing'` + `notifyStaffingGratuity` unchanged.

- [ ] **Step 1: Update the tests first**

In `server/routes/proposals/crud.test.js`: delete Case 21 (lines 853-861) and Case 23 (lines 873-891) with their comment banners — the admin write path they exercise is being removed. Keep Case 19 and Case 22 untouched (they exercise the carry-forward and staffing rescale, which survive). Add in their place:

```js
// ─── Case 21 — PATCH ignores tip_jar / gratuity_total (election-at-payment) ──
// The election is client-owned at sign-and-pay; the admin PATCH silently drops
// these keys so an old client build or a crafted request cannot preset a
// gratuity on a proposal (spec 2026-08-03).
test('Case 21: PATCH ignores tip_jar and gratuity_total in the body', async () => {
  const token = await makeFreshAdmin();
  const id = await insertDraftProposal({ status: 'draft', total_price: 2000 });
  const r = await request('PATCH', `/api/proposals/${id}`, {
    token, body: { tip_jar: false, gratuity_total: 400 },
  });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.raw}`);
  const row = (await pool.query(
    'SELECT tip_jar, gratuity_rate, pricing_snapshot FROM proposals WHERE id = $1', [id])).rows[0];
  assert.equal(row.tip_jar, true, 'tip_jar untouched');
  assert.equal(Number(row.gratuity_rate), 0, 'rate untouched');
  assert.ok(!row.pricing_snapshot.breakdown.some(l => l.label === 'Gratuity'),
    'no Gratuity line injected');
});
```

- [ ] **Step 2: Run to verify the new case fails**

Run: `node --test server/routes/proposals/crud.test.js`
Expected: new Case 21 FAILS (today the body keys are honored: `tip_jar=false, rate=50` persists). Cases 19/22 still pass.

- [ ] **Step 3: Implement the lockdown**

In `server/routes/proposals/crud.js`:

1. Remove `tip_jar, gratuity_total,` from the destructure at line 310.
2. Replace the block at lines 453-491 (from the `// Gratuity (§3/§4/§7)` comment through the `gratuityDecreasedPostPayment` const) with:

```js
    // Gratuity (election-at-payment, spec 2026-08-03): the tip-jar election is
    // made by the CLIENT at sign-and-pay and persisted by the Stripe webhook —
    // this PATCH never accepts tip_jar/gratuity_total. The STORED rate + jar
    // always carry forward so a staffing change on a paid proposal rescales the
    // dollar at the same rate (origin 'staffing' + client notice below).
    // Admin's only gratuity power is removal via cancel-line-item.
    const persistTipJar = old.tip_jar !== false;
    const resolvedGratuityRate = Number(old.gratuity_rate) || 0;
    let gratuityOrigin = old.gratuity_rate_change_origin || null;
    const isPaidForGratuity = Number(old.amount_paid || 0) > 0;
```

3. The `calculateProposal` call (line 493-498) and the staffing-driven detection block (lines 500-509) are unchanged; they consume exactly these names.
4. Delete the `if (gratuityDecreasedPostPayment) {...}` activity-log branch (lines 596-605) — its only writer is gone.
5. The UPDATE still writes `tip_jar = $26, gratuity_rate = $27, gratuity_rate_change_origin = $28` — now always the carried-forward values (or a fresh `'staffing'` origin). Leave it.
6. Grep the file for `computeGratuityBasis` and `deriveGratuityRate`; if the removed block was their last use in this file, remove them from the pricingEngine require line.

- [ ] **Step 4: Run the suite**

Run: `node --test server/routes/proposals/crud.test.js`
Expected: all PASS, including Cases 19 and 22.

- [ ] **Step 5: Commit (lane checkpoint)**

```bash
git add server/routes/proposals/crud.js server/routes/proposals/crud.test.js
git commit -m "feat(gratuity): admin PATCH no longer accepts tip_jar/gratuity_total"
```

### Task 4: preview endpoint drops the gratuity_total derivation

**Files:**
- Modify: `server/routes/proposals/metadata.js:36, 64-81`
- Test: `server/routes/proposals/metadata.calculate.test.js` (new — NO existing suite covers this endpoint)

**Interfaces:**
- Consumes/Produces: `POST /api/proposals/calculate` keeps accepting `tip_jar` + `gratuity_rate` (Task 6's editor preview sends the STORED values) and stops accepting `gratuity_total`.

- [ ] **Step 0: Write the failing test**

Create `server/routes/proposals/metadata.calculate.test.js` on the harness pattern of `server/routes/proposals/metadata.shapes.test.js` (minimal express() app, real `metadata` router + real auth middleware, admin JWT, node http against the dev DB). Look up a real active `service_packages` id in `before()` (`SELECT id FROM service_packages WHERE is_active = true LIMIT 1`) rather than hardcoding one.

```js
test('POST /calculate ignores gratuity_total (election-at-payment)', async () => {
  const res = await request('POST', '/api/proposals/calculate', {
    body: { package_id: pkgId, guest_count: 50, duration_hours: 5,
            tip_jar: false, gratuity_total: 250 },
  });
  assert.equal(res.status, 200, res.raw);
  const snap = JSON.parse(res.raw);
  assert.ok(!snap.breakdown.some(l => l.label === 'Gratuity'),
    'an entered dollar total can no longer conjure a preview gratuity line');
});

test('POST /calculate previews the stored rate', async () => {
  const res = await request('POST', '/api/proposals/calculate', {
    body: { package_id: pkgId, guest_count: 50, duration_hours: 5,
            tip_jar: false, gratuity_rate: 50 },
  });
  assert.equal(res.status, 200, res.raw);
  const snap = JSON.parse(res.raw);
  const line = snap.breakdown.find(l => l.label === 'Gratuity');
  assert.ok(line, 'stored-rate preview keeps the Gratuity line');
  assert.ok(line.amount > 0);
});
```

Run: `node --test server/routes/proposals/metadata.calculate.test.js`
Expected RED: the first test FAILS (today `gratuity_total` derives a rate and injects the line); the second passes.

- [ ] **Step 1: Implement**

In `server/routes/proposals/metadata.js`: remove `gratuity_total` from the destructure at line 36, and replace lines 64-81 with:

```js
  // Gratuity preview (election-at-payment): the editor can no longer ENTER a
  // gratuity — it always previews at the STORED rate/jar so a paid proposal's
  // gratuity line scales with staff/hours edits and matches what will save.
  const previewTipJar = tip_jar !== false;
  const previewRate = Number(gratuity_rate) || 0;
```

Grep the file for `computeGratuityBasis` / `deriveGratuityRate`; remove them from the require if now unused. The `calculateProposal` call at lines 83-94 is unchanged.

- [ ] **Step 2: Verify green + no neighbor regression**

Run: `node --test server/routes/proposals/metadata.calculate.test.js` (now PASS), then `node --test server/routes/proposals/metadata.shapes.test.js` and `node --test server/routes/proposals/metadata.leadSpend.test.js`.
Expected: all PASS. (`public.calculate.test.js` covers a different route in `public.js`; it is in the whole-feature verification list, not a gate here.)

- [ ] **Step 3: Commit (lane checkpoint)**

```bash
git add server/routes/proposals/metadata.js server/routes/proposals/metadata.calculate.test.js
git commit -m "feat(gratuity): /calculate previews only the stored rate"
```

### Task 5: change-request previews stop dropping stored gratuity

**Files:**
- Modify: `server/utils/changeRequests.js:77-87`
- Test: `server/utils/changeRequests.gratuity.test.js` (new)

**Interfaces:**
- Consumes: `proposal.gratuity_rate` / `proposal.tip_jar` — the implementer MUST verify every caller of `priceProposedState`/`buildPreview` loads the proposal with these columns (grep `priceProposedState\|buildPreview` in `server/routes/` and check each SELECT; `SELECT *` rows are fine).

- [ ] **Step 1: Write the failing test**

`priceProposedState(proposal, proposed, db)` accepts a `db` with a `.query` method, so this is testable without seeding:

```js
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { priceProposedState } = require('./changeRequests');

// Fixture columns MUST match the real service_packages schema — copy the BYOB
// fixture from server/utils/pricingEngine.test.js:10-13 (category, pricing_type,
// bar_type, base_rate_4hr, base_rate_3hr, extra_hour_rate, ...), do NOT invent
// column names.
const PKG = { id: 1, slug: 'byob', name: 'BYOB Bar', category: 'byob', pricing_type: 'flat',
  bar_type: 'byob', base_rate_4hr: 1000, base_rate_3hr: 900, extra_hour_rate: 150,
  min_guests: 0, guests_per_bartender: 100, extra_bartender_hourly: 40 };
const fakeDb = { query: async (sql) => sql.includes('service_packages')
  ? { rows: [PKG] } : { rows: [] } };

test('priceProposedState carries the stored gratuity into the preview', async () => {
  const proposal = {
    id: 1, package_id: 1, guest_count: 50, event_duration_hours: 5, num_bars: 1,
    gratuity_rate: 50, tip_jar: false,
    pricing_snapshot: { gratuity: { staff_count: 1, hours: 5 } },
    adjustments: [], total_price_override: null, client_provides_glassware: false,
  };
  const snap = await priceProposedState(proposal, { guest_count: 50 }, fakeDb);
  const line = snap.breakdown.find(l => l.label === 'Gratuity');
  assert.ok(line, 'preview keeps the Gratuity line');
  assert.equal(line.amount, 250, '50/staff/hr x 1 staff x 5h');
});
```

If `priceProposedState` is not exported, export it alongside the existing exports. Adjust `PKG` fields to whatever `calculateProposal` actually requires — run the test and satisfy the engine's field reads, do not guess new shapes.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test server/utils/changeRequests.gratuity.test.js`
Expected: FAIL — no Gratuity line (the call omits `gratuityRate`).

- [ ] **Step 3: Implement**

In `server/utils/changeRequests.js`, the `calculateProposal` call already ends with `totalPriceOverride: proposal.total_price_override ?? null,` at line 86 — add ONLY these lines after it (do not re-state the existing key; a duplicate key trips `no-dupe-keys`):

```js
    // Election-at-payment: carry the STORED gratuity so a change-request preview
    // on a paid proposal doesn't silently drop the client's paid gratuity line.
    gratuityRate: Number(proposal.gratuity_rate) || 0,
    tipJar: proposal.tip_jar !== false,
```

- [ ] **Step 4: Run**

Run: `node --test server/utils/changeRequests.gratuity.test.js` and any existing `server/utils/changeRequests*.test.js` / change-request route suites found by `grep -rl changeRequests server --include=*.test.js`.
Expected: PASS.

- [ ] **Step 5: Commit (lane checkpoint)**

```bash
git add server/utils/changeRequests.js server/utils/changeRequests.gratuity.test.js
git commit -m "fix(gratuity): change-request previews carry the stored gratuity"
```

### Task 6: remove the admin editor's gratuity block

**Files:**
- Modify: `client/src/pages/admin/proposalEditor/ProposalEditorForm.js`, `patchBody.js`, `formState.js`
- Test: `client/src/pages/admin/proposalEditor/patchBody.test.js`

**Interfaces:**
- Consumes: Task 4's `/calculate` contract (`tip_jar` + `gratuity_rate` only).
- Produces: no proposal-editor surface can write a gratuity; paid proposals still render their Gratuity line read-only via `PricingBreakdown`.

- [ ] **Step 1: Update patchBody + its test first**

In `patchBody.js`: remove the `gratuityDirty = false` option and the `if (gratuityDirty) {...}` block (lines 9, 48-54). In `patchBody.test.js` — a Jest/CRA suite (`describe`/`it`/`expect`) whose fixture is named `form` — replace the "omits gratuity keys unless gratuityDirty" test with:

```js
it('never includes gratuity keys (election-at-payment)', () => {
  const body = buildProposalPatchBody({ ...form, tip_jar: false, gratuity_total: 400 });
  expect('tip_jar' in body).toBe(false);
  expect('gratuity_total' in body).toBe(false);
});
```

- [ ] **Step 2: Strip the form**

In `ProposalEditorForm.js`:
1. Delete the gratuity block (lines 634-670) entirely.
2. Delete `gratuityDirty` state + comment (lines 107-112). KEEP `storedGratuityRate` / `storedTipJar` (113-114) — the preview needs them.
3. Preview body (lines 192-197): replace the conditional spread with the stored values only:

```js
        // Preview at the STORED rate/jar so a paid proposal's gratuity line
        // scales with staff/hours and matches what will save (election is
        // client-owned at sign-and-pay; this form cannot edit it).
        tip_jar: storedTipJar,
        gratuity_rate: storedGratuityRate,
```

4. Remove `editForm.tip_jar`, `editForm.gratuity_total`, and `gratuityDirty` from the effect dependency array (lines 221-223); keep `storedTipJar` / `storedGratuityRate`.
5. Delete `updateGratuity` (lines 248-251).
6. Remove the `gratuityDirty` option from the `buildProposalPatchBody(...)` call site (grep `buildProposalPatchBody(` in the file).
7. Delete the `GRATUITY_ORIGIN_LABELS` local const (it is NOT an import — the const lives at lines 27-30 with its comment at 24-26) and grep the file to confirm no other use. Leaving it orphaned fails the CI build on `no-unused-vars`.

In `formState.js`: delete the `tip_jar` / `gratuity_total` seeds (lines 41-42) — nothing reads them once the form and patchBody are stripped. Grep `client/src/pages/admin/proposalEditor/` for `tip_jar\|gratuity` afterward; the only survivors should be `storedGratuityRate` / `storedTipJar` in the form.

- [ ] **Step 3: Verify with tests + the CI-grade build**

Run: `cd client && npx react-scripts test --watchAll=false src/pages/admin/proposalEditor/` — the WHOLE directory, not just patchBody: `formState.test.js` and `ProposalEditorForm.smoke.test.js` exist and are reached by these edits. (Check `client/package.json` first if the invocation differs.)
Run: `cd client && CI=true npx react-scripts build`
Expected: all suites PASS; build clean (CI treats warnings as errors — an orphaned const or import fails here).

- [ ] **Step 3b: Manual verification (admin editor, dev server restarted first — it does not auto-reload)**

Open a PAID proposal that carries a gratuity (dev DB: any `gratuity_rate > 0 AND amount_paid > 0` row) in the proposal editor:
- The gratuity block (checkbox + dollar input) is gone.
- The Gratuity line still renders read-only in the pricing breakdown.
- Changing guest count/duration still previews the gratuity line scaled at the stored rate.
- The event detail page still shows the "No tip jar (client paid to skip it)" badge for a no-jar proposal.

- [ ] **Step 4: Commit (lane checkpoint)**

```bash
git add client/src/pages/admin/proposalEditor/ProposalEditorForm.js client/src/pages/admin/proposalEditor/patchBody.js client/src/pages/admin/proposalEditor/patchBody.test.js client/src/pages/admin/proposalEditor/formState.js
git commit -m "feat(gratuity): remove the admin editor's gratuity block"
```

---

## Lane grat-copy-reset

### Task 7: sign-and-pay copy reframe

**Files:**
- Modify: `client/src/pages/proposal/proposalView/SignAndPaySection.js:258-261, 288-291`

**Interfaces:** none — copy only. Every control keeps calling `setGratuityDirty(true)`; no logic edits.

- [ ] **Step 1: Replace the intro paragraph (lines 258-261)**

```jsx
              <p className="gratuity-intro">
                Our {gratuityStaffNoun}s are always tipped: either guests tip at
                the bar, or the gratuity is prepaid.{' '}
                <span className="assured">Every dollar</span> goes straight to your
                {` ${gratuityStaffNoun}s`}. None of it is kept by Dr. Bartender.
              </p>
```

- [ ] **Step 2: Replace the skip-jar description (lines 288-291)**

```jsx
                <span className="tip-tablet-desc">
                  No jar at the bar. Instead, a prepaid gratuity of $50 per{' '}
                  {gratuityStaffNoun} per hour is added to your total, so your
                  crew is still taken care of.
                </span>
```

No em dashes anywhere in this copy. The `$50` literal matches `GRATUITY_FLOOR_RATE` and the existing mirrored literals in `ProposalView.js:71`; it is copy, not math.

- [ ] **Step 3: Verify build**

Run: `cd client && CI=true npx react-scripts build`
Expected: clean.

- [ ] **Step 4: Commit (lane checkpoint)**

```bash
git add client/src/pages/proposal/proposalView/SignAndPaySection.js
git commit -m "copy(gratuity): reframe tip-jar choice as how the crew gets tipped"
```

### Task 8: one-off reset of unpaid self-elected gratuities

**Files:**
- Create: `scripts/reset-unpaid-gratuity.js`
- Test: `scripts/reset-unpaid-gratuity.test.js`

**Interfaces:**
- Consumes: `recomputeSnapshotGratuity` from `server/utils/pricingEngine.js`; `pool` from `server/db`.
- Produces: exported `resetUnpaidGratuity({ apply })` returning `{ examined, changed: [{id, from, to}] }`; CLI wrapper (dry-run default, `--apply` to write).

- [ ] **Step 1: Write the failing test**

```js
require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../server/db');
const { resetUnpaidGratuity } = require('./reset-unpaid-gratuity');

if (process.env.NODE_ENV === 'production') {
  throw new Error('reset-unpaid-gratuity.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const ids = { clients: [], proposals: [] };
const SNAP = (g) => ({
  total: 450 + g, staff_noun: 'bartender',
  breakdown: [{ label: 'Pkg', amount: 450 }, ...(g ? [{ label: 'Gratuity', amount: g }] : [])],
  gratuity: { rate: g ? 50 : 0, tip_jar: !g, staff_count: 1, hours: 5, total: g },
});
async function seed({ amountPaid, gratuity }) {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Grat Reset Test', $1) RETURNING id`,
    [`grat-reset-${NONCE}-${ids.clients.length}@example.com`]);
  ids.clients.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, total_price, amount_paid,
                            tip_jar, gratuity_rate, event_duration_hours, pricing_snapshot, token)
     VALUES ($1, 'viewed', 'wedding', $2, $3, $4, $5, 5, $6, $7) RETURNING id`,
    [c.rows[0].id, 450 + gratuity, amountPaid, gratuity === 0, gratuity ? 50 : 0,
     JSON.stringify(SNAP(gratuity)), crypto.randomUUID()]);
  ids.proposals.push(p.rows[0].id);
  return p.rows[0].id;
}

test('resets unpaid gratuity rows, never paid ones; dry run writes nothing', async () => {
  const unpaidId = await seed({ amountPaid: 0, gratuity: 250 });
  const paidId = await seed({ amountPaid: 100, gratuity: 250 });

  const dry = await resetUnpaidGratuity({ apply: false });
  assert.ok(dry.changed.some(r => r.id === unpaidId));
  assert.ok(!dry.changed.some(r => r.id === paidId), 'paid row never listed');
  let row = (await pool.query('SELECT total_price FROM proposals WHERE id = $1', [unpaidId])).rows[0];
  assert.equal(Number(row.total_price), 700, 'dry run wrote nothing');

  await resetUnpaidGratuity({ apply: true });
  row = (await pool.query(
    'SELECT tip_jar, gratuity_rate, total_price, pricing_snapshot FROM proposals WHERE id = $1',
    [unpaidId])).rows[0];
  assert.equal(row.tip_jar, true);
  assert.equal(Number(row.gratuity_rate), 0);
  assert.equal(Number(row.total_price), 450);
  assert.ok(!row.pricing_snapshot.breakdown.some(l => l.label === 'Gratuity'));
  const paid = (await pool.query('SELECT total_price FROM proposals WHERE id = $1', [paidId])).rows[0];
  assert.equal(Number(paid.total_price), 700, 'paid row untouched');
});

after(async () => {
  await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [ids.proposals]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1)', [ids.clients]);
  await pool.end();
});
```

Caveat for the implementer: `resetUnpaidGratuity` runs against the WHOLE dev DB, so `apply: true` in the test also resets any other unpaid-gratuity rows sitting in dev. That is the intended production behavior and acceptable on dev; do not "fix" it by scoping to test ids.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/reset-unpaid-gratuity.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the script**

```js
#!/usr/bin/env node
'use strict';
// One-off (spec 2026-08-03): strip self-elected checkout gratuity from UNPAID
// proposals. Before election-at-payment shipped, create-intent persisted the
// client's "Skip the tip jar" click immediately — an abandoned checkout left a
// Gratuity line baked into the quote (Delara, proposal 665). Paid proposals are
// NEVER touched.
//   node scripts/reset-unpaid-gratuity.js           # dry run (default)
//   node scripts/reset-unpaid-gratuity.js --apply   # write
require('dotenv').config();
const { pool } = require('../server/db');
const { recomputeSnapshotGratuity } = require('../server/utils/pricingEngine');

async function resetUnpaidGratuity({ apply = false } = {}) {
  const { rows } = await pool.query(`
    SELECT id, total_price, amount_paid, pricing_snapshot, event_duration_hours
      FROM proposals
     WHERE COALESCE(amount_paid, 0) = 0
       AND (COALESCE(gratuity_rate, 0) > 0
            OR COALESCE((pricing_snapshot->'gratuity'->>'total')::numeric, 0) > 0)
     ORDER BY id`);
  // Snapshot-carried OR column-carried: prod proposal 580 holds a $400 gratuity
  // in its snapshot/total with a ZERO column (pre-existing drift, found at
  // review) — a column-only WHERE would leave that Delara-shaped row behind.
  const changed = [];
  for (const row of rows) {
    if (Number(row.amount_paid) > 0) throw new Error(`paid row ${row.id} matched — refusing`);
    const snap = row.pricing_snapshot || {};
    const newSnap = recomputeSnapshotGratuity(snap, {
      gratuityRate: 0, tipJar: true,
      staffNoun: snap.staff_noun, durationHours: row.event_duration_hours,
    });
    changed.push({ id: row.id, from: Number(row.total_price), to: newSnap.total });
    console.log(`#${row.id}: total ${row.total_price} -> ${newSnap.total}`);
    if (apply) {
      await pool.query(
        `UPDATE proposals SET tip_jar = true, gratuity_rate = 0,
                gratuity_rate_change_origin = NULL,
                pricing_snapshot = $1, total_price = $2, updated_at = NOW()
          WHERE id = $3 AND COALESCE(amount_paid, 0) = 0`,
        [JSON.stringify(newSnap), newSnap.total, row.id]
      );
    }
  }
  console.log(`${changed.length} unpaid proposals ${apply ? 'RESET' : 'would be reset (dry run — pass --apply)'}`);
  return { examined: rows.length, changed };
}

if (require.main === module) {
  resetUnpaidGratuity({ apply: process.argv.includes('--apply') })
    .then(() => pool.end())
    .catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { resetUnpaidGratuity };
```

- [ ] **Step 4: Run**

Run: `node --test scripts/reset-unpaid-gratuity.test.js`
Expected: PASS.

- [ ] **Step 5: Commit (lane checkpoint)**

```bash
git add scripts/reset-unpaid-gratuity.js scripts/reset-unpaid-gratuity.test.js
git commit -m "feat(gratuity): one-off reset of unpaid self-elected gratuities"
```

### Task 9: documentation

**Files:**
- Modify: `.claude/CLAUDE.md` (Checkout gratuity invariant bullet), `ARCHITECTURE.md` (checkout-gratuity flow description, ~line 877 schema note and ~1508 pricing rule), `README.md` (~line 595 feature blurb; scripts list if one exists)

**Interfaces:** none.

- [ ] **Step 1: Update the invariant bullet**

In `.claude/CLAUDE.md`, extend the **Checkout gratuity** invariant bullet (keep every existing clause) with:

> The election persists ONLY at payment: `create-intent` computes it in memory and stamps `tip_jar`/`gratuity_rate` into PaymentIntent metadata; the `payment_intent.succeeded` webhook applies it (same lifecycle guard as the credit, before the Balance invoice, `FOR UPDATE` on the proposal row). Unpaid proposals never carry a gratuity, and the admin PATCH never accepts `tip_jar`/`gratuity_total` (admin removal goes through cancel-line-item only). Payments that carry no metadata — balance, invoice, drink-plan, admin-issued Stripe payment links — never touch the gratuity, so a link-paid proposal cannot collect a prepaid gratuity.

- [ ] **Step 2: Update ARCHITECTURE.md and README.md**

Find the checkout-gratuity descriptions (`grep -n "gratuity" ARCHITECTURE.md README.md`) and bring them in line with the same sentence — README.md:595's "admins can preset it on a proposal" is now false and must go. Mention `scripts/reset-unpaid-gratuity.js` wherever the other one-off scripts (`cc-*.js`) are listed, if anywhere. Incidental one-liner while ARCHITECTURE.md is open: line ~383 misattributes `POST /create-intent-for-invoice/:token` to `stripeCreateIntent.js`; it lives in `stripe.js`.

Also in this lane (fix round 1): update the two stale comments in `client/src/pages/proposal/proposalView/ProposalView.js` — line ~265 "the deposit must re-persist the new rate" (now: re-stamps election metadata) and lines ~273-274 "(row lock + Stripe retrieve/cancel/create + total_price rewrite)" (there is no row lock or total_price rewrite anymore). Comment-only, no behavior change.

- [ ] **Step 3: Commit (lane checkpoint)**

```bash
git add .claude/CLAUDE.md ARCHITECTURE.md README.md
git commit -m "docs(gratuity): election-at-payment invariant + flow descriptions"
```

---

## Verification (whole feature, after merges)

1. Server suites the change reaches, one at a time from repo root: the five webhook suites (Task 2 Step 4 list), `stripeCreateIntent.test.js`, `stripe.invoiceIntentArchived.test.js`, `proposals/crud.test.js`, `proposals/public.calculate.test.js`, `changeRequests.gratuity.test.js` (+ any existing changeRequests suites), `utils/pricingEngine.test.js`, `utils/proposalExtrasFold.stability.test.js`, `utils/invoiceHelpers.gratuity.test.js`, `scripts/reset-unpaid-gratuity.test.js`.
2. Client: `cd client && CI=true npx react-scripts build`; `patchBody.test.js` and `gratuityFloor.test.js`.
3. Live walk on dev (dev server restart required — Claude-managed background process): open a proposal token, elect Skip the tip jar, watch the "New total" move once the server confirms. NOTE: in-session, the left-rail quote MAY also show the Gratuity line after confirmation — the client deliberately adopts the server-confirmed gratuity into local state; that is the in-session consequence view, not persistence. The load-bearing assertion is the RELOAD: the quote is back to service-only, the chooser is reset to Keep the tip jar, and the DB row is untouched. Then complete a Stripe test-mode payment; confirm total/snapshot/Balance invoice now carry the gratuity.
4. `node scripts/reset-unpaid-gratuity.js` (dry run) against dev, eyeball the list, `--apply` on dev.
5. Prod, ONLY after the `grat-intent-webhook` and `grat-admin-lockdown` lanes are deployed to prod and step 3's flow is verified live (running the reset while the old `create-intent` is still deployed just lets abandoned checkouts regrow the rows), and with explicit per-action approval: dry run, review the ~13 rows (665 among them), `--apply`, then spot-check proposal 665 renders $450.

## Execution notes

- Lanes 1 (`grat-intent-webhook`) and 2 (`grat-admin-lockdown`) are independent and run in parallel. Lane 3 (`grat-copy-reset`) depends on BOTH (see front-matter comment) and builds/merges after them. Every lane touches sensitive paths, so each gets the full review fleet at merge, and push time adds the sensitive-path re-review + `/second-opinion`.
- Review-cadence mapping (execution-review pattern): `security-review` + `code-review` on lane 1 (public money route + webhook surface); `code-review` + `consistency-check` on lane 2 (the stored-rate carry crosses PATCH/preview/changeRequests/client); `database-review` on lane 3 (the reset script is the only bulk writer in this work); `consistency-check` at push across all three (the metadata contract and the CLAUDE.md invariant span lanes).
- Lane 1 is the money seam; build it with max reasoning effort. Its two tasks are NOT independently mergeable: Task 1 alone charges a gratuity-inclusive total that nothing records. The lane merges whole or not at all.
- Safe partial revert (if lane 1 must be rolled back after deploy): revert the `stripeCreateIntent.js` change ONLY. The webhook apply block is a no-op when metadata is absent, and removing it while metadata-bearing intents are in flight strands a charged election (client charged gratuity-inclusive, proposal never records it).
- Deliberate bundling, decided at review: Task 5 (changeRequests fix) stays in lane 2 — three lines, conceptually part of "the stored gratuity carries correctly everywhere". Lane 3 keeps copy + script + docs — the deps now force it to land last, which is the ordering that mattered.
- Server tests share the dev DB: one suite at a time, never concurrently with another suite or the reset script.

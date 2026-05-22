# Plan 2d Wiring (Revised) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Plan 2d's marketing/retention comms handlers into every proposal status-transition path, so the drip, New Year / 6-months-out touches, review request, retention nudge, and the feedback route all fire regardless of which code path moved the proposal.

**Architecture:** The `marketingHandlers.js` scheduling functions already exist and are path-agnostic (each takes a numeric `proposalId`, loads the proposal itself, self-gates on eligibility, and is idempotent). This plan only adds best-effort, non-blocking hook calls at the points where a proposal changes state, plus one boot-time registration, one route mount, one DRY orchestrator helper, and the W2 reschedule recompute.

**Tech Stack:** Node 18 / Express, raw SQL via `pg`, `@sentry/node`, `node:test`.

**Supersedes:** Tasks 7-15 of `docs/superpowers/plans/2026-05-20-comms-marketing-emails.md`. Those were written before `crud.js` was split into `lifecycle.js` and before the proposal status-transition path map was enumerated. Tasks 0-6 of that plan (the components) are done, committed, and unit-tested; this plan replaces only the wiring tail.

---

## Why this revision exists

A path enumeration found the original wiring covered one route per state; proposals reach each state through several:

- **becomes `sent`** (drip enrollment) via **3 paths** — admin `POST /api/proposals` with `send_now:true` (S1), `PATCH /:id/status` (S2, now in `lifecycle.js`), and the public quote wizard `POST /api/proposals/public/submit` (S3). The original plan wired only S2.
- **client sign+pay** (drip-suppress + New Year / 6-mo) via **3 paths** — Stripe `payment_intent.succeeded` deposit/full (D1/B1), Stripe `checkout.session.completed` Payment-Link deposit (D2), and admin `POST /:id/record-payment` (D3/B5). The original plan wired only D1/B1.
- **becomes `completed`** (review + retention) via **2 paths** — the `processEventCompletions` scheduler (C1) and `PATCH /:id/status` (C2). Original plan covered both.
- **becomes `archived`** (cancel marketing) via **1 path** — `PATCH /:id/status` (A1). Original plan covered it.

Also corrected here: the status hooks move to `lifecycle.js` (the `PATCH /:id/status` handler was split out of `crud.js`); `lifecycle.js` gains a `Sentry` import; the W2 reschedule contract is resolved with a post-commit recompute (avoids the in-transaction-vs-pool atomicity mismatch); and `crud.test.js` gets a `scheduled_messages` cleanup line because its route tests now exercise the real drip hook.

**Out of scope (flagged, not fixed here):** the D2 Payment-Link path also lacks Plan 2c's `schedulePreEventReminders` and the `scheduleBalanceReminders` ladder. Closing that needs a shared post-sign+pay handler refactor of the Stripe webhook — money-path surgery that belongs in its own separately-reviewed task. This plan adds 2d's marketing hook to D2 (additive, low-risk) but does not refactor the webhook.

---

## File Structure

- **Modify `server/index.js`** — register marketing handlers at boot; mount the feedback route.
- **Modify `server/utils/marketingHandlers.js`** — add one DRY orchestrator, `onProposalSignedAndPaid(proposalId)`, that the three paid paths share (schedules New Year + 6-mo, then suppresses pending drip rows). Add its unit test to `marketingHandlers.test.js`.
- **Modify `server/routes/proposals/lifecycle.js`** — add `Sentry` import; post-commit hooks for `→sent`, `→archived`, `→completed`.
- **Modify `server/routes/proposals/crud.js`** — drip enrollment in the `POST /` born-sent path; `onProposalSignedAndPaid` in the `record-payment` path; the W2 recompute in the `PATCH /:id` reschedule path.
- **Modify `server/routes/proposals/public.js`** — drip enrollment in the quote-wizard submit born-sent path.
- **Modify `server/routes/stripe.js`** — `onProposalSignedAndPaid` after the Plan 2c block in `payment_intent.succeeded`, and in the `checkout.session.completed` post-commit block.
- **Modify `server/utils/balanceScheduler.js`** — review + retention enrollment in the `processEventCompletions` loop.
- **Modify `server/routes/proposals/crud.test.js`** — `scheduled_messages` cleanup in `after()`.
- **Modify `server/utils/scheduledMessageDispatcher.test.js`** — marketing-gating tests.
- **Modify `README.md`, `ARCHITECTURE.md`** — the new public route + marketing message types.

Every hook is best-effort: its own `try/catch`, Sentry-on-failure, `console.error`, never rethrown. A comms-scheduling failure must never break a proposal status change or a payment.

---

## Task 1: Register handlers at boot, mount the feedback route

**Files:**
- Modify: `server/index.js`

- [ ] **Step 1: Mount the feedback route**

In `server/index.js`, find the public-route mounts (near the `publicReviews` / `publicTip` lines). After the line:

```javascript
app.use('/api/public/tip', require('./routes/publicTip'));
```

add:

```javascript
app.use('/api/public/feedback', require('./routes/publicFeedback'));
```

- [ ] **Step 2: Register marketing handlers at boot**

In `server/index.js`, find this line in the scheduler-bootstrap block (inside the `app.listen` callback):

```javascript
      require('./utils/preEventHandlers').registerAll();
```

Immediately after it, add:

```javascript
      // Plan 2d: register the marketing/retention dispatcher handlers
      // (drip_touch_2/4/5_email, new_year_hello, six_months_out,
      // retention_nudge, review_request). Synchronous, like registerAll()
      // above; must run before the dispatcher's first tick.
      require('./utils/marketingHandlers').registerMarketingHandlers();
```

- [ ] **Step 3: Verify the server boots cleanly**

Run: `node -e "require('./server/routes/publicFeedback'); require('./server/utils/marketingHandlers').registerMarketingHandlers(); console.log('boot wiring OK');"`
Expected: prints `boot wiring OK` with no throw. (A transient `[email] RESEND_API_KEY is NOT set` log line is expected and harmless.)

- [ ] **Step 4: Commit**

```bash
git add server/index.js
git commit -m "feat(comms): register marketing handlers and mount the feedback route at boot"
```

---

## Task 2: Comms hooks on the proposal status handler

**Files:**
- Modify: `server/routes/proposals/lifecycle.js`
- Modify: `server/routes/proposals/crud.test.js`

`lifecycle.js` holds the `PATCH /:id/status` handler. Its `crud.test.js` route tests (Cases 10-12) exercise this handler against the dev DB, so the real drip hook will fire there; Step 4 adds the cleanup.

- [ ] **Step 1: Add the `Sentry` import**

In `server/routes/proposals/lifecycle.js`, the first import line is:

```javascript
const express = require('express');
```

Change it to:

```javascript
const express = require('express');
const Sentry = require('@sentry/node');
```

- [ ] **Step 2: Add the three post-commit hooks**

In `lifecycle.js`, the `PATCH /:id/status` handler ends with a post-commit `if (status === 'sent')` email block, then `res.json(result.rows[0]);`. Find:

```javascript
    } catch (e) {
      console.error('Post-send email re-fetch failed for proposal', req.params.id, e.code || e.name);
    }
  }

  res.json(result.rows[0]);
```

Replace it with:

```javascript
    } catch (e) {
      console.error('Post-send email re-fetch failed for proposal', req.params.id, e.code || e.name);
    }
  }

  // Plan 2d: comms hooks on the status transition. All best-effort and
  // non-blocking — a scheduling failure must never break the status change.
  // The marketing helpers are idempotent, so a same-status re-PATCH is safe.
  if (status === 'sent') {
    try {
      const { scheduleDripForProposal } = require('../../utils/marketingHandlers');
      await scheduleDripForProposal(Number(req.params.id));
    } catch (dripErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(dripErr, { tags: { route: 'proposals/status', issue: 'drip-enroll' } });
      }
      console.error('Drip enrollment failed (non-blocking):', dripErr);
    }
  }
  if (status === 'archived') {
    try {
      const { cancelMarketingForProposal } = require('../../utils/marketingHandlers');
      await cancelMarketingForProposal(Number(req.params.id));
    } catch (cancelErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(cancelErr, { tags: { route: 'proposals/status', issue: 'archive-cancel' } });
      }
      console.error('Marketing cancel on archive failed (non-blocking):', cancelErr);
    }
  }
  if (status === 'completed') {
    try {
      const { scheduleReviewRequest, scheduleRetentionNudge } = require('../../utils/marketingHandlers');
      await scheduleReviewRequest(Number(req.params.id));
      await scheduleRetentionNudge(Number(req.params.id));
    } catch (completeErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(completeErr, { tags: { route: 'proposals/status', issue: 'completion-enroll' } });
      }
      console.error('Completion enroll failed (non-blocking):', completeErr);
    }
  }

  res.json(result.rows[0]);
```

- [ ] **Step 3: Run the route tests**

Run: `node --test server/routes/proposals/crud.test.js`
Expected: all 12 cases pass. Cases 10/11 (`PATCH → sent`) now also fire the real `scheduleDripForProposal` against the dev DB; the hook is best-effort so the cases still pass, but they leave `scheduled_messages` rows — Step 4 cleans those.

- [ ] **Step 4: Add the `scheduled_messages` cleanup to `crud.test.js`**

In `server/routes/proposals/crud.test.js`, find the `after()` cleanup block. It deletes invoices then proposals:

```javascript
  if (createdProposalIds.size > 0) {
    const ids = [...createdProposalIds];
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [ids]);
  }
```

Add a `scheduled_messages` delete before the `proposals` delete (the Plan 2d hooks now insert drip rows for the `→sent` test cases; `scheduled_messages` has no FK cascade):

```javascript
  if (createdProposalIds.size > 0) {
    const ids = [...createdProposalIds];
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1)', [ids]);
    // Plan 2d hooks schedule drip rows on a →sent transition; scheduled_messages
    // has no FK cascade to proposals, so sweep them before deleting proposals.
    await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = ANY($1)", [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [ids]);
  }
```

- [ ] **Step 5: Re-run the route tests and confirm clean**

Run: `node --test server/routes/proposals/crud.test.js`
Expected: all 12 cases pass. Then confirm no orphan rows:
`psql "$DATABASE_URL" -c "SELECT count(*) FROM scheduled_messages sm LEFT JOIN proposals p ON p.id = sm.entity_id WHERE sm.entity_type='proposal' AND p.id IS NULL;"`
Expected: `0`.

- [ ] **Step 6: Commit**

```bash
git add server/routes/proposals/lifecycle.js server/routes/proposals/crud.test.js
git commit -m "feat(comms): comms hooks on the proposal status handler"
```

---

## Task 3: Drip enrollment on the born-sent paths

**Files:**
- Modify: `server/routes/proposals/crud.js`
- Modify: `server/routes/proposals/public.js`

A proposal can be created directly in `sent` status by the admin `POST /` flow (S1) and the public quote wizard (S3). Both must enroll the drip, the same as the `PATCH → sent` path. Both files already import `Sentry`.

- [ ] **Step 1: Wire `POST /api/proposals` (admin born-sent)**

In `server/routes/proposals/crud.js`, the `POST /` handler has a post-commit block that emails the client. Find:

```javascript
      } catch (e) {
        console.error('Post-send email step failed (non-blocking) for proposal', proposal.id);
      }
    }

    res.status(201).json(proposal);
```

Replace it with:

```javascript
      } catch (e) {
        console.error('Post-send email step failed (non-blocking) for proposal', proposal.id);
      }
    }

    // Plan 2d: enroll the unsigned-proposal drip for a born-sent proposal.
    if (proposalStatus === 'sent') {
      try {
        const { scheduleDripForProposal } = require('../../utils/marketingHandlers');
        await scheduleDripForProposal(proposal.id);
      } catch (dripErr) {
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(dripErr, { tags: { route: 'proposals/create', issue: 'drip-enroll' } });
        }
        console.error('Drip enrollment failed (non-blocking):', dripErr);
      }
    }

    res.status(201).json(proposal);
```

- [ ] **Step 2: Wire `POST /api/proposals/public/submit` (quote-wizard born-sent)**

In `server/routes/proposals/public.js`, the submit handler has a post-commit email `try/catch`, then `res.status(201).json(...)`. Find:

```javascript
    } catch (emailErr) {
      Sentry.captureException(emailErr, { tags: { route: 'proposals/public/submit', phase: 'email' } });
      console.error('Public proposal emails failed (non-blocking):', emailErr);
    }

    res.status(201).json({ token: proposal.token, total: snapshot ? snapshot.total : 0, top_shelf: isTopShelfClass });
```

Replace it with:

```javascript
    } catch (emailErr) {
      Sentry.captureException(emailErr, { tags: { route: 'proposals/public/submit', phase: 'email' } });
      console.error('Public proposal emails failed (non-blocking):', emailErr);
    }

    // Plan 2d: enroll the unsigned-proposal drip for a born-sent proposal.
    // Top Shelf submits as 'draft' (proposalStatus !== 'sent') and is skipped.
    if (proposalStatus === 'sent') {
      try {
        const { scheduleDripForProposal } = require('../../utils/marketingHandlers');
        await scheduleDripForProposal(proposal.id);
      } catch (dripErr) {
        Sentry.captureException(dripErr, { tags: { route: 'proposals/public/submit', issue: 'drip-enroll' } });
        console.error('Drip enrollment failed (non-blocking):', dripErr);
      }
    }

    res.status(201).json({ token: proposal.token, total: snapshot ? snapshot.total : 0, top_shelf: isTopShelfClass });
```

- [ ] **Step 3: Verify both files parse and lint**

Run: `npx eslint server/routes/proposals/crud.js server/routes/proposals/public.js`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add server/routes/proposals/crud.js server/routes/proposals/public.js
git commit -m "feat(comms): enroll drip on the admin-create and public-wizard sent paths"
```

---

## Task 4: Schedule marketing and suppress the drip on every sign+pay path

**Files:**
- Modify: `server/utils/marketingHandlers.js`
- Modify: `server/utils/marketingHandlers.test.js`
- Modify: `server/routes/stripe.js`
- Modify: `server/routes/proposals/crud.js`

Three paths represent a genuine client sign+pay: Stripe `payment_intent.succeeded` (deposit/full), Stripe `checkout.session.completed` (Payment-Link deposit), and admin `record-payment`. Each must schedule the long-lead marketing touches and suppress the now-moot drip. Step 1 adds one shared orchestrator so the logic (including the raw suppress SQL) lives in one place.

- [ ] **Step 1: Write the failing test for the orchestrator**

In `server/utils/marketingHandlers.test.js`, append:

```javascript
const { test: t2dTest } = require('node:test');

t2dTest('onProposalSignedAndPaid > suppresses pending drip rows for the proposal', async () => {
  const { pool } = require('../db');
  const { onProposalSignedAndPaid } = require('./marketingHandlers');
  const c = await pool.query("INSERT INTO clients (name, email) VALUES ('SignPay Test', 'signpay-test@example.com') RETURNING id");
  const p = await pool.query(
    "INSERT INTO proposals (client_id, event_date, status, event_type) VALUES ($1, CURRENT_DATE + INTERVAL '200 days', 'deposit_paid', 'birthday-party') RETURNING id",
    [c.rows[0].id]
  );
  const proposalId = p.rows[0].id;
  await pool.query(
    `INSERT INTO scheduled_messages (entity_type, entity_id, message_type, recipient_type, recipient_id, channel, scheduled_for, status)
     VALUES ('proposal', $1, 'drip_touch_2', 'client', $2, 'email', NOW() + INTERVAL '7 days', 'pending')`,
    [proposalId, c.rows[0].id]
  );

  await onProposalSignedAndPaid(proposalId);

  const drip = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_id = $1 AND message_type = 'drip_touch_2'",
    [proposalId]
  );
  const assert2d = require('node:assert/strict');
  assert2d.strictEqual(drip.rows[0].status, 'suppressed');

  await pool.query('DELETE FROM scheduled_messages WHERE entity_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [c.rows[0].id]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/utils/marketingHandlers.test.js`
Expected: FAIL — `onProposalSignedAndPaid is not a function`.

- [ ] **Step 3: Add the orchestrator to `marketingHandlers.js`**

In `server/utils/marketingHandlers.js`, just above the `module.exports = {` block, add:

```javascript
/**
 * Plan 2d: shared sign+pay orchestrator. Called from every client sign+pay
 * path (Stripe payment_intent.succeeded deposit/full, Stripe
 * checkout.session.completed Payment-Link deposit, admin record-payment).
 * Schedules the long-lead marketing touches, then suppresses any pending
 * unsigned-proposal drip rows — once the client has signed and paid, the
 * "still thinking about your event?" touches no longer apply. Only pending
 * drip rows are flipped; already-sent rows stay 'sent'. Idempotent.
 */
async function onProposalSignedAndPaid(proposalId) {
  await scheduleNewYearHello(proposalId);
  await scheduleSixMonthsOut(proposalId);
  await pool.query(
    `UPDATE scheduled_messages
        SET status = 'suppressed',
            error_message = 'proposal signed and paid'
      WHERE entity_type = 'proposal'
        AND entity_id = $1
        AND status = 'pending'
        AND message_type IN ('drip_touch_2', 'drip_touch_4', 'drip_touch_5_email')`,
    [proposalId]
  );
}
```

Then add `onProposalSignedAndPaid,` to the `module.exports` object (next to `scheduleNewYearHello`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test server/utils/marketingHandlers.test.js`
Expected: all tests pass, including the new `onProposalSignedAndPaid` test.

- [ ] **Step 5: Wire the Stripe `payment_intent.succeeded` path (D1/B1)**

In `server/routes/stripe.js`, the `payment_intent.succeeded` post-commit notifier has the Plan 2c `schedulePreEventReminders` block. Find:

```javascript
        if (paymentType === 'deposit' || paymentType === 'full') {
          try {
            await schedulePreEventReminders(proposalId);
          } catch (schedErr) {
            if (process.env.SENTRY_DSN_SERVER) {
              Sentry.captureException(schedErr, {
                tags: { webhook: 'stripe', route: '/webhook', step: 'schedulePreEventReminders' },
              });
            }
            console.error('schedulePreEventReminders failed (non-blocking):', schedErr);
          }
        }
      }
    }
  }
```

Replace it with (add the Plan 2d block after the 2c block, still inside the `deposit || full` and `isFirstDelivery` guards):

```javascript
        if (paymentType === 'deposit' || paymentType === 'full') {
          try {
            await schedulePreEventReminders(proposalId);
          } catch (schedErr) {
            if (process.env.SENTRY_DSN_SERVER) {
              Sentry.captureException(schedErr, {
                tags: { webhook: 'stripe', route: '/webhook', step: 'schedulePreEventReminders' },
              });
            }
            console.error('schedulePreEventReminders failed (non-blocking):', schedErr);
          }

          // Plan 2d: schedule long-lead marketing touches (New Year, 6-mo-out)
          // and suppress the now-moot unsigned-proposal drip. Separate
          // try/catch from the Plan 2c block so a marketing failure cannot
          // mask a pre-event-reminder failure. The helper self-gates on
          // eligibility and is idempotent under Stripe webhook retries.
          try {
            const { onProposalSignedAndPaid } = require('../utils/marketingHandlers');
            await onProposalSignedAndPaid(Number(proposalId));
          } catch (marketingErr) {
            if (process.env.SENTRY_DSN_SERVER) {
              Sentry.captureException(marketingErr, {
                tags: { webhook: 'stripe', route: '/webhook', step: 'marketing-signpay' },
              });
            }
            console.error('Marketing enroll on sign+pay failed (non-blocking):', marketingErr);
          }
        }
      }
    }
  }
```

- [ ] **Step 6: Wire the Stripe `checkout.session.completed` path (D2)**

In `server/routes/stripe.js`, the `checkout.session.completed` branch has a post-commit `if (isFirstDelivery)` block. Find:

```javascript
      // Non-blocking post-commit work — only on first delivery.
      if (isFirstDelivery) {
        sendPaymentNotifications(proposalId, session.amount_total || 0, 'deposit');
        try {
          const shift = await createEventShifts(proposalId);
          if (shift) console.log(`Shift #${shift.id} created for proposal ${proposalId}`);
        } catch (shiftErr) {
          if (process.env.SENTRY_DSN_SERVER) {
            Sentry.captureException(shiftErr, {
              tags: { webhook: 'stripe', route: '/webhook' },
            });
          }
          console.error('Shift auto-creation failed (non-blocking):', shiftErr);
        }
      }
```

Replace it with:

```javascript
      // Non-blocking post-commit work — only on first delivery.
      if (isFirstDelivery) {
        sendPaymentNotifications(proposalId, session.amount_total || 0, 'deposit');
        try {
          const shift = await createEventShifts(proposalId);
          if (shift) console.log(`Shift #${shift.id} created for proposal ${proposalId}`);
        } catch (shiftErr) {
          if (process.env.SENTRY_DSN_SERVER) {
            Sentry.captureException(shiftErr, {
              tags: { webhook: 'stripe', route: '/webhook' },
            });
          }
          console.error('Shift auto-creation failed (non-blocking):', shiftErr);
        }

        // Plan 2d: a Payment-Link deposit is a genuine client sign+pay —
        // schedule the long-lead marketing touches and suppress the drip,
        // same as the payment_intent.succeeded path. (This branch still
        // lacks Plan 2c/2a reminders; that is a separate tracked follow-up.)
        try {
          const { onProposalSignedAndPaid } = require('../utils/marketingHandlers');
          await onProposalSignedAndPaid(Number(proposalId));
        } catch (marketingErr) {
          if (process.env.SENTRY_DSN_SERVER) {
            Sentry.captureException(marketingErr, {
              tags: { webhook: 'stripe', route: '/webhook', event: 'checkout.session.completed', step: 'marketing-signpay' },
            });
          }
          console.error('Marketing enroll on Payment-Link deposit failed (non-blocking):', marketingErr);
        }
      }
```

- [ ] **Step 7: Wire the admin `record-payment` path (D3/B5)**

In `server/routes/proposals/crud.js`, the `record-payment` handler has a post-commit `// Email notifications for payment (non-blocking)` block. Find the end of that email `try/catch` — it ends with:

```javascript
  } catch (emailErr) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(emailErr, { tags: { route: 'proposals/payment', issue: 'email' } });
    }
    console.error('Payment email failed (non-blocking):', emailErr);
  }
```

Immediately after that closing `}`, add:

```javascript

  // Plan 2d: an admin-recorded outside payment moves the proposal to a paid
  // state — schedule the long-lead marketing touches and suppress the
  // now-moot drip, same as a Stripe sign+pay.
  try {
    const { onProposalSignedAndPaid } = require('../../utils/marketingHandlers');
    await onProposalSignedAndPaid(proposal.id);
  } catch (marketingErr) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(marketingErr, { tags: { route: 'proposals/payment', issue: 'marketing-signpay' } });
    }
    console.error('Marketing enroll on record-payment failed (non-blocking):', marketingErr);
  }
```

(Verify the anchor: this `catch (emailErr)` block is the one inside `record-payment`, near a following `// Auto-create event shift` block. If the next block after your insertion is the shift auto-create, the anchor is correct.)

- [ ] **Step 8: Verify lint, then verify the helper end-to-end**

Run: `npx eslint server/routes/stripe.js server/routes/proposals/crud.js server/utils/marketingHandlers.js`
Expected: 0 errors.

Then exercise the orchestrator against a real proposal:

```bash
node -e "
  const { onProposalSignedAndPaid } = require('./server/utils/marketingHandlers');
  const { pool } = require('./server/db');
  (async () => {
    const { rows: [c] } = await pool.query(\"INSERT INTO clients (name, email) VALUES ('SignPay Smoke', 'signpay-smoke@example.com') RETURNING id\");
    const { rows: [p] } = await pool.query(\"INSERT INTO proposals (client_id, event_date, status, event_type) VALUES (\$1, CURRENT_DATE + INTERVAL '220 days', 'deposit_paid', 'birthday-party') RETURNING id\", [c.id]);
    await onProposalSignedAndPaid(p.id);
    const { rows } = await pool.query(\"SELECT message_type, scheduled_for FROM scheduled_messages WHERE entity_id = \$1 ORDER BY scheduled_for\", [p.id]);
    console.log(rows);
    await pool.query('DELETE FROM scheduled_messages WHERE entity_id = \$1', [p.id]);
    await pool.query('DELETE FROM proposals WHERE id = \$1', [p.id]);
    await pool.query('DELETE FROM clients WHERE id = \$1', [c.id]);
    await pool.end();
  })();
"
```

Expected: rows for `six_months_out` and `new_year_hello` (the long-lead touches; exact dates depend on the run date).

- [ ] **Step 9: Commit**

```bash
git add server/utils/marketingHandlers.js server/utils/marketingHandlers.test.js server/routes/stripe.js server/routes/proposals/crud.js
git commit -m "feat(comms): schedule marketing and suppress drip on every sign+pay path"
```

---

## Task 5: Review + retention enrollment on auto-complete

**Files:**
- Modify: `server/utils/balanceScheduler.js`

The manual completion path (`PATCH → completed`) was wired in Task 2. This wires the auto-complete scheduler (C1). `Sentry` is already imported in `balanceScheduler.js`.

- [ ] **Step 1: Add the hook to `processEventCompletions`**

In `server/utils/balanceScheduler.js`, the `processEventCompletions` loop inserts an activity-log row per auto-completed proposal. Find:

```javascript
      for (const proposal of result.rows) {
        try {
          await pool.query(
            `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'status_changed', 'system', $2)`,
            [proposal.id, JSON.stringify({ from: 'confirmed/balance_paid', to: 'completed', reason: 'auto_complete' })]
          );
        } catch (logErr) {
          console.error(`[BalanceScheduler] activity-log insert failed for #${proposal.id}:`, logErr);
          Sentry.captureException(logErr, { tags: { scheduler: 'auto-complete', proposalId: proposal.id } });
        }
      }
```

Replace it with:

```javascript
      for (const proposal of result.rows) {
        try {
          await pool.query(
            `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'status_changed', 'system', $2)`,
            [proposal.id, JSON.stringify({ from: 'confirmed/balance_paid', to: 'completed', reason: 'auto_complete' })]
          );
        } catch (logErr) {
          console.error(`[BalanceScheduler] activity-log insert failed for #${proposal.id}:`, logErr);
          Sentry.captureException(logErr, { tags: { scheduler: 'auto-complete', proposalId: proposal.id } });
        }
        // Plan 2d: schedule the post-event review request and retention nudge.
        // Best-effort and isolated — a marketing failure must never abort the
        // auto-completion batch.
        try {
          const { scheduleReviewRequest, scheduleRetentionNudge } = require('./marketingHandlers');
          await scheduleReviewRequest(proposal.id);
          await scheduleRetentionNudge(proposal.id);
        } catch (marketingErr) {
          console.error(`[BalanceScheduler] marketing enroll failed for #${proposal.id}:`, marketingErr.message);
          Sentry.captureException(marketingErr, { tags: { scheduler: 'auto-complete', proposalId: proposal.id, issue: 'marketing-enroll' } });
        }
      }
```

- [ ] **Step 2: Verify lint and exercise the scheduler**

Run: `npx eslint server/utils/balanceScheduler.js`
Expected: 0 errors.

Run: `node -e "require('./server/utils/marketingHandlers').registerMarketingHandlers(); require('./server/utils/balanceScheduler').processEventCompletions().then(() => { console.log('processEventCompletions ran OK'); process.exit(0); });"`
Expected: prints `processEventCompletions ran OK` with no throw (it auto-completes whatever real events qualify; on a quiet dev DB it typically completes 0 and is a clean no-op).

- [ ] **Step 3: Commit**

```bash
git add server/utils/balanceScheduler.js
git commit -m "feat(comms): review and retention enrollment on auto-complete"
```

---

## Task 6: Recompute `new_year_hello` on reschedule (W2)

**Files:**
- Modify: `server/routes/proposals/crud.js`

`new_year_hello` is registered with `offsetFromEventDate: null` (its anchor is a computed Jan 2, not a fixed offset), so `reanchorPendingMessages` — the generic offset cascade — leaves it untouched when a proposal is rescheduled. The `recomputeNewYearHelloForProposal` helper re-evaluates it. It uses the module-level `pool`, so it runs **post-commit, best-effort** in the `PATCH /:id` handler, alongside the existing post-commit reschedule email — not inside `reanchorPendingMessages` (which runs in the reschedule transaction on a different `client`).

- [ ] **Step 1: Add the post-commit recompute to `PATCH /api/proposals/:id`**

In `server/routes/proposals/crud.js`, the `PATCH /:id` handler has a post-commit reschedule-email block gated on `shouldSendRescheduleEmail`. Find:

```javascript
    if (shouldSendRescheduleEmail) {
      try {
        await sendRescheduleEmail({
          proposalId: parseInt(req.params.id, 10),
          old,
          updated: updatedRow.rows[0],
        });
      } catch (emailErr) {
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(emailErr, {
            tags: { route: 'proposals/update', issue: 'reschedule-email' },
            extra: { proposalId: req.params.id },
          });
        }
        console.error('Reschedule email failed (non-blocking, DB already committed):', emailErr);
      }
    }

    // Return updated proposal (from the UPDATE ... RETURNING * above)
    res.json(updatedRow.rows[0]);
```

Replace it with:

```javascript
    if (shouldSendRescheduleEmail) {
      try {
        await sendRescheduleEmail({
          proposalId: parseInt(req.params.id, 10),
          old,
          updated: updatedRow.rows[0],
        });
      } catch (emailErr) {
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(emailErr, {
            tags: { route: 'proposals/update', issue: 'reschedule-email' },
            extra: { proposalId: req.params.id },
          });
        }
        console.error('Reschedule email failed (non-blocking, DB already committed):', emailErr);
      }
    }

    // Plan 2d / W2: re-anchor the New Year touch after a reschedule.
    // new_year_hello has a computed Jan-2 anchor (offsetFromEventDate null), so
    // reanchorPendingMessages (the in-transaction generic offset cascade) skips
    // it. recomputeNewYearHelloForProposal uses the module-level pool, so it
    // runs here — post-commit, best-effort — alongside the reschedule email.
    // shouldSendRescheduleEmail is true exactly when a signed proposal was
    // rescheduled, which is the only time a new_year_hello row can exist.
    if (shouldSendRescheduleEmail) {
      try {
        const { recomputeNewYearHelloForProposal } = require('../../utils/marketingHandlers');
        await recomputeNewYearHelloForProposal(parseInt(req.params.id, 10));
      } catch (recomputeErr) {
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(recomputeErr, {
            tags: { route: 'proposals/update', issue: 'new-year-recompute' },
            extra: { proposalId: req.params.id },
          });
        }
        console.error('new_year_hello recompute failed (non-blocking):', recomputeErr);
      }
    }

    // Return updated proposal (from the UPDATE ... RETURNING * above)
    res.json(updatedRow.rows[0]);
```

- [ ] **Step 2: Verify lint and exercise the recompute**

Run: `npx eslint server/routes/proposals/crud.js`
Expected: 0 errors.

```bash
node -e "
  const { recomputeNewYearHelloForProposal } = require('./server/utils/marketingHandlers');
  const { pool } = require('./server/db');
  (async () => {
    const { rows: [c] } = await pool.query(\"INSERT INTO clients (name, email) VALUES ('Reanchor Smoke', 'reanchor-smoke@example.com') RETURNING id\");
    const { rows: [p] } = await pool.query(\"INSERT INTO proposals (client_id, event_date, status, event_type) VALUES (\$1, CURRENT_DATE + INTERVAL '400 days', 'deposit_paid', 'birthday-party') RETURNING id\", [c.id]);
    const r = await recomputeNewYearHelloForProposal(p.id);
    console.log('recompute result:', r);
    await pool.query('DELETE FROM scheduled_messages WHERE entity_id = \$1', [p.id]);
    await pool.query('DELETE FROM proposals WHERE id = \$1', [p.id]);
    await pool.query('DELETE FROM clients WHERE id = \$1', [c.id]);
    await pool.end();
  })();
"
```

Expected: prints a `recompute result:` object (shape `{ deleted, rescheduled }`) with no throw.

- [ ] **Step 3: Commit**

```bash
git add server/routes/proposals/crud.js
git commit -m "feat(comms): recompute new_year_hello on reschedule"
```

---

## Task 7: Verify marketing gating honors `communication_preferences`

**Files:**
- Modify: `server/utils/scheduledMessageDispatcher.test.js`

The dispatcher's marketing gate already exists (`scheduledMessageDispatcher.js`, the `meta?.category === 'marketing'` block that suppresses when `communication_preferences.marketing_enabled === false`). This task adds tests proving Plan 2d's handlers are gated correctly: marketing-class types are suppressed when the client opted out, and the operational `review_request` is not.

- [ ] **Step 1: Confirm the gate exists**

Run: `grep -n "marketing_enabled" server/utils/scheduledMessageDispatcher.js`
Expected: a match inside the dispatch path that suppresses the row. If absent, stop — Plan 2a did not ship the gate; that is a prerequisite.

- [ ] **Step 2: Append the gating tests**

In `server/utils/scheduledMessageDispatcher.test.js`, append:

```javascript
const { test: gateTest, before: gateBefore, after: gateAfter } = require('node:test');
const gateAssert = require('node:assert/strict');
const { pool: gatePool } = require('../db');

let gateClientId;
let gateProposalId;

gateBefore(async () => {
  const c = await gatePool.query(
    `INSERT INTO clients (name, email, communication_preferences)
     VALUES ('Marketing Off Client', 'marketing-off-gate@example.com', '{"marketing_enabled":false,"email_enabled":true,"sms_enabled":true}'::jsonb)
     RETURNING id`
  );
  gateClientId = c.rows[0].id;
  const p = await gatePool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type)
     VALUES ($1, CURRENT_DATE + INTERVAL '365 days', 'sent', 'birthday-party') RETURNING id`,
    [gateClientId]
  );
  gateProposalId = p.rows[0].id;
});

gateAfter(async () => {
  await gatePool.query('DELETE FROM scheduled_messages WHERE entity_id = $1', [gateProposalId]);
  await gatePool.query('DELETE FROM proposals WHERE id = $1', [gateProposalId]);
  await gatePool.query('DELETE FROM clients WHERE id = $1', [gateClientId]);
});

gateTest('marketing gating > suppresses a marketing-class row when marketing_enabled is false', async () => {
  require('./marketingHandlers').registerMarketingHandlers();
  await gatePool.query(
    `INSERT INTO scheduled_messages (entity_type, entity_id, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ('proposal', $1, 'drip_touch_2', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [gateProposalId, gateClientId]
  );
  await require('./scheduledMessageDispatcher').dispatchPending();
  const { rows } = await gatePool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE entity_id = $1 AND message_type = 'drip_touch_2'",
    [gateProposalId]
  );
  gateAssert.strictEqual(rows[0].status, 'suppressed');
  gateAssert.match(rows[0].error_message, /marketing_disabled/);
});

gateTest('marketing gating > does not suppress the operational review_request', async () => {
  require('./marketingHandlers').registerMarketingHandlers();
  await gatePool.query("UPDATE proposals SET status = 'completed', event_date = CURRENT_DATE - INTERVAL '2 days' WHERE id = $1", [gateProposalId]);
  await gatePool.query(
    `INSERT INTO scheduled_messages (entity_type, entity_id, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ('proposal', $1, 'review_request', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [gateProposalId, gateClientId]
  );
  await require('./scheduledMessageDispatcher').dispatchPending();
  const { rows } = await gatePool.query(
    "SELECT status FROM scheduled_messages WHERE entity_id = $1 AND message_type = 'review_request'",
    [gateProposalId]
  );
  // 'sent' or 'failed' are both acceptable — the gate must NOT suppress it.
  gateAssert.notStrictEqual(rows[0].status, 'suppressed');
});
```

- [ ] **Step 3: Run the test**

Run: `node --test server/utils/scheduledMessageDispatcher.test.js`
Expected: all tests pass, including the two new gating tests.

- [ ] **Step 4: Commit**

```bash
git add server/utils/scheduledMessageDispatcher.test.js
git commit -m "feat(comms): test marketing gating honors communication_preferences"
```

---

## Task 8: Documentation

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: README — folder tree**

In `README.md`'s folder-structure tree, in the `server/routes/` block, add an entry for `publicFeedback.js` near the other `public*` route files:

```text
│   ├── publicFeedback.js   # Post-event feedback router (5-star sentiment routing)
```

- [ ] **Step 2: ARCHITECTURE — route table**

In `ARCHITECTURE.md`, find the API route table. Add two rows for the feedback route (adjacent to the other `/api/public/*` rows):

```markdown
| GET | `/api/public/feedback/:token` | Public | Display data for the post-event feedback router page |
| POST | `/api/public/feedback/:token` | Public | Submit a rating (1-5). 4-5 redirects to Google Reviews; 1-3 records feedback and alerts admin |
```

- [ ] **Step 3: ARCHITECTURE — marketing message types**

In `ARCHITECTURE.md`, in the scheduled-messages / comms section, add:

```markdown
### Marketing and retention message types

The dispatcher handles marketing-class touches registered by `marketingHandlers.js`:
`drip_touch_2`, `drip_touch_4`, `drip_touch_5_email`, `new_year_hello`,
`six_months_out`, `retention_nudge` (all gated on
`clients.communication_preferences.marketing_enabled`), plus `review_request`
(operational / CAN-SPAM transactional — not gated). They are scheduled by hooks
on the proposal status-transition paths: drip on every `→sent` path, New Year /
6-months-out and drip-suppression on every sign+pay path, review request and
retention nudge on completion, and marketing cancellation on archive.
```

- [ ] **Step 4: Commit**

```bash
git add README.md ARCHITECTURE.md
git commit -m "docs(comms): document the feedback route and marketing message types"
```

---

## Task 9: Final verification

No code changes. Confirm the wiring landed cleanly.

- [ ] **Step 1: Working tree clean**

Run: `git status --short`
Expected: empty except known untracked `.claude/` scratch files.

- [ ] **Step 2: Lint clean**

Run: `npm run lint`
Expected: 0 errors.

- [ ] **Step 3: Unit + route tests pass**

Run: `node --test server/utils/marketingHandlers.test.js server/utils/scheduledMessageDispatcher.test.js server/routes/proposals/crud.test.js`
Expected: all green.

- [ ] **Step 4: Server boots and the dispatcher resolves all handlers**

Run: `npm run dev`, watch for a clean boot with no handler-registration error, then stop it. (Alternatively: `node -e "require('./server/utils/marketingHandlers').registerMarketingHandlers(); console.log('handlers registered');"`.)

- [ ] **Step 5: Deferred interactive E2E smoke (with the dev server)**

These need the running app and are done interactively, not as part of the automated run:
- Drip flow: create a `draft` proposal, push it to `sent` via the admin UI, confirm three `drip_touch_*` rows appear; fast-forward one row and trigger the dispatcher; flip the client's `marketing_enabled` to false and confirm the next drip row is suppressed.
- Born-sent: submit the public quote wizard and confirm drip rows appear for that proposal.
- Sign+pay: pay a deposit (Stripe test mode), confirm `new_year_hello` / `six_months_out` rows appear and pending `drip_touch_*` rows flip to `suppressed`.
- Feedback router: open `/feedback/<token>`, submit a 5-star (redirects to Google Reviews) and a 2-star (records feedback, admin alert).

- [ ] **Step 6: Report**

Summarize: tasks committed, tests green, lint clean, and the deferred E2E items still pending an interactive pass.

---

## Self-review

- **Path coverage:** `→sent` — Task 2 (S2 lifecycle.js), Task 3 (S1 crud.js POST, S3 public.js). `sign+pay` — Task 4 (D1/B1 stripe payment_intent, D2 stripe checkout.session, D3/B5 crud.js record-payment). `→completed` — Task 2 (C2 manual), Task 5 (C1 auto). `→archived` — Task 2 (A1). W2 — Task 6. Every enumerated path maps to a task.
- **Placeholder scan:** every step has exact code or an exact command; no TBD.
- **Type consistency:** `onProposalSignedAndPaid(proposalId)` is defined in Task 4 Step 3 and called in Task 4 Steps 5-7. All `marketingHandlers` calls pass a numeric id (`Number(...)` for the string `proposalId` in `stripe.js`; `proposal.id` is already numeric in `crud.js`/`balanceScheduler.js`; `Number(req.params.id)` in `lifecycle.js`).
- **Idempotency:** every hook is best-effort (own try/catch, Sentry, never rethrown); the scheduling helpers are idempotent, so Stripe retries and same-status re-PATCHes do not double-schedule.
- **Known follow-up (not in this plan):** the D2 `checkout.session.completed` path still lacks Plan 2c's `schedulePreEventReminders` and `scheduleBalanceReminders`. Closing that needs a shared post-sign+pay handler refactor of the Stripe webhook — a separate, separately-reviewed task.

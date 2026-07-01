# Proposal Options / Compare — Design Spec

**Date:** 2026-07-01
**Status:** Approved in brainstorm (section-by-section) + design-review folded in (spec-gaps agent + inline grounding/risk pass). Ready for plan (lane map).
**Author:** Dallas + Claude

---

## 1. Problem

When a lead wants to weigh their choices (canonical case: we sent a **BYOB** proposal and they now want to see **hosted** options, or they want to compare **hosted tiers**), we have no real mechanism. Today an admin builds a second proposal from scratch; the two share only a `client_id`, render as unrelated dashboard rows, and the client gets two separate `Your Proposal … — Dr. Bartender` emails with two "View Proposal" links. No side-by-side, no compare, nothing tying the options together. The client can pay for one option without ever seeing the other.

## 2. Goal

Let admin present a client with **two or three proposal "options"** side by side, from **one link**, and let the client **compare and choose** cleanly. Under the hood each option stays a full, independent proposal (so the money path never changes); to the client it looks like one unified comparison. "One under the hood, looks like two on screen."

## 3. Core architecture decision

**Each option is a real, separate `proposals` row** (own `token`, own `pricing_snapshot`, own sign/pay path). A new lightweight **`proposal_groups`** entity bundles the siblings and owns the shared client-facing compare link. The chosen option flows through the **exact existing** sign → Stripe intent → webhook → `createEventShifts` path with zero changes to that math; the unchosen options archive.

**Rejected alternative:** one row holding multiple package variants inline — would force a rewrite of the most battle-tested code in the system (Stripe intent, `stripeWebhook.js`, `eventCreation.js`, invoicing all assume one snapshot / one `package_id` / one `total_price` per row). Not worth the money-path risk for a presentation feature.

## 4. Client experience

### 4.1 The compare page
- **Route:** `/compare/:token` (client), backed by `GET /api/proposals/group/:token` (public, UUID-guarded via `requireUuidToken` / `server/utils/tokens.js`). `:token` is the group's UUID.
- **Public visibility gate:** the endpoint returns the group only once **at least one member is in a client-visible status** (`sent`/`viewed`/…); it 404s while every member is still `draft`. Admin gets an authed preview path that ignores this gate.
- **Per-option payload uses the same public-safe column allowlist as `publicToken.js`** (must be reused verbatim per option) so the endpoint never leaks `admin_notes`, `stripe_customer_id`, signature IP/UA, or any option's private fields.
- **Shared header (shown once):** client name, event type, date, service time, guest count, location.
- **Each option, side by side (2 columns; support up to 3):** package name + `tagline`; a derived **BYOB / Hosted badge** off `pricing_type` (`isHostedPackage`); headline **total** + **deposit**; **what's included** — real `sections[]` from `getPackageBySlug(option.package_slug)` (brand-level; shared section headings make tiers align); a **"Choose this one"** button (the only action).
- **Allowed option package categories:** only packages that expose the standard `sections[]` + a concrete total (the full-bar / beer-wine catalog). Class/tasting and TBD-price packages are **not** valid options for v1 (they have no aligned sections / no fixed headline) — the "Add an alternative" flow must reject or hide them.
- **UI states:** loading, error + retry, and the degenerate post-race states (0 or 1 visible member) are all defined; a 1-member group renders as (or redirects to) that single proposal, not a broken one-column compare.
- **What stays OFF this page:** full service agreement, gratuity block, payment terms, card entry — all on the click-through proposal. The compare page touches **zero** money surface.

### 4.2 Choose flow (lightweight chooser)
"Choose this one" links to that option's existing sign/pay page: **`/proposal/:optionToken?choose=1`**. Client signs and pays there exactly as today. `?choose=1` is the compare→proposal hand-off marker (see 4.3).

### 4.3 Link resolution & redirect (must not mutate on the redirect branch)
The existing `GET /api/proposals/t/:token` **bumps `view_count` and flips `sent→viewed`** (`publicToken.js`). The redirect decision must therefore **not** ride on that mutating GET — merely landing on a link that will be bounced must not inflate that option's engagement. Add a **cheap non-mutating resolver** (a small read, or a `?resolve` mode that skips the view/status write) that returns: the member's `group_id`, the group compare token, and whether the group is **decided** (`chosen_proposal_id` set).

Resolution precedence (**decided > choose > cold**):
1. **Decided group** (a member reached a paid status) → any member token, and `/compare/:groupToken` itself, resolve to the **chosen** proposal's booked/paid view. No dead archived page.
2. **`?choose=1` present, undecided** → render that proposal's sign/pay page normally (the only place the mutating GET runs). Prevents the compare→choose→bounce loop.
3. **Undecided, cold hit (no `?choose`)** → redirect to `/compare/:groupToken`.

Ungrouped proposals behave exactly as today.

## 5. Admin experience

### 5.1 "Add an alternative" (the one genuinely new primitive)
- **Endpoint:** `POST /api/proposals/:id/alternative`, **admin-only, explicit role guard** (not just route-mount implicit).
- Clones the source via canonical `insertProposalRecord` (copying client, event type, date, time, guest count, location, num_bars; defaults package to the source's so the clone is immediately valid), then ensures a shared group.
- **Source-status gate:** only `draft`/`sent`/`viewed`/`modified` sources may spawn or join a group. Reject `deposit_paid`/`balance_paid`/`confirmed`/`completed`/`archived` sources, and reject pulling an **already-paid** (`amount_paid > 0`) solo proposal into a group. You never group a booked event.
- **Atomic group creation:** creating the `proposal_groups` row + stamping `group_id` on both proposals happens under a row lock (`SELECT … FOR UPDATE` on the source), mirroring the `proposal_change_requests` locked-create, so a double-click can't spawn two clones or two groups around one source.
- **Server-side cap:** count members in-transaction; reject the 4th (cap = 3). Not a UI-only limit.
- Returns the new proposal id; admin opens it in the existing edit flow and swaps the package.
- Works **before or after** the first send.

### 5.2 Managing a group + remove/dissolution
`ProposalDetail.js` gains an **"Alternatives" panel** (list siblings + package/total/status, "Add an alternative", per-option remove). **Remove must be group-aware — it may not use the blind `DELETE /:id` (`crud.js:968`)**, which hard-deletes with no dissolution and no guard. Remove rules:
- Removing a member on an **undecided** group is allowed; if it drops the group to **one** member, **dissolve** the group (clear the survivor's `group_id`, delete the group row) so the survivor reverts to a normal solo proposal and stops redirecting to compare.
- On a **decided** group, members are effectively frozen (the winner is a booked event, losers are archived); no removal that would null a live `chosen_proposal_id`.

### 5.3 Grouped send = one email, one link (defined mechanics)
Sending must be **group-aware and transactional**:
- A **group-send action** transitions **all** members to `sent` in one transaction (all-or-nothing; partial failure rolls back), rather than the single-row `PATCH /:id/status`. The admin "Send" affordance on a grouped proposal calls this path.
- **Defer invoicing** for grouped members (see §7.1) — no per-option invoice at send.
- Send **one** email (`emailTemplates.proposalOptionsSent`, one "Compare your options" CTA → `/compare/:groupToken`). **Suppress the per-option `proposalSent` email AND `initialProposalSms`** for grouped members (both halves fire in the solo path).
- The compare email runs `checkSuppression` and is **deduped/idempotent** (admin double-click or dispatcher retry must not send twice).

### 5.4 Dashboard rollup
`ProposalsDashboard.js` and `ClientDetail.js` collapse a group into **one row** ("Client · Event · N options · status"), expandable/clickable. **`group_id IS NULL` rows stay solo** — the rollup must not `GROUP BY` a NULL group into one pseudo-group (every existing proposal has `group_id NULL`).

## 6. Acceptance & lifecycle (choice-commit)

- **Choice commits at first paid status.** The group stays undecided until a member reaches `deposit_paid`/`balance_paid`/`confirmed`. Before that the client may return to compare and pick a different option freely (signing without paying does not lock the group).
- **All three money-in conversion paths must run the choice-commit**, since each already calls `createEventShifts`:
  1. `stripeWebhook.js` `payment_intent.succeeded`
  2. `stripeWebhook.js` `checkout.session.completed` (Payment-Link)
  3. `proposals/actions.js` admin offline **record-payment**
- **Choice-commit sequence (one transaction, alongside the winner's conversion):**
  1. **First-writer-wins gate:** `UPDATE proposal_groups SET chosen_proposal_id = $winner WHERE id = $g AND chosen_proposal_id IS NULL` under a `SELECT … FOR UPDATE` on the group row. If the group is **already decided by a different member**, do **not** convert this payment's proposal; leave it flagged for admin refund and Sentry-capture (real money landed on a non-chosen option — see §6 concurrency note).
  2. **Archive each losing sibling through the real `→archived` reap path** (`cancelMarketingForProposal` + `cancelPendingChangeRequestsForProposal`), never a raw `UPDATE status='archived'`, with `archive_reason='option_not_chosen'`. This stops the loser's drip/SMS from continuing to fire.
  3. **Void each loser's unpaid invoice** via the new helper (§7.2).
  4. Convert the winner (`createEventShifts`) — unchanged.
- **Atomicity / partial-failure:** the commit + archives + voids + conversion are one unit. If any step throws after the winner is converted, do not half-apply; roll back or record a reconcilable Sentry event so we never end with a booked winner + still-live losers.
- **Concurrency note:** the deposit is real money ($100). First-writer-wins prevents two winners, but a second payment can still *arrive* on a loser. v1 handling: block its conversion, flag for refund, alert admin. (A stricter pre-pay lock is a possible future hardening, out of v1 scope.)

### Group dissolution recap
Covered in §5.2 — dropping to one member dissolves the group.

## 7. Money seams (full review fleet)

### 7.1 Invoicing: defer per-option, create the winner's before settle
Today `createInvoiceOnSend` (idempotent on `proposal_id`) runs in-transaction at send (`lifecycle.js:104`, `crud.js:313`) and creates the **Deposit** invoice; the webhook then **links** the incoming payment to an **open** invoice (`status IN ('sent','partially_paid')`) and builds the balance from it. If we merely skip invoice creation for grouped options, the winner reaches settle with **no open invoice** → the payment can't link and the balance computes off a missing base (unlinked deposit / phantom balance). The **sign endpoint currently creates no invoices.**

**Rule:** grouped sends skip per-option invoice creation, but the **chosen option's Deposit/Full invoice is created idempotently and transactionally *before* its payment settles** — at sign time or intent-creation on the `?choose=1` path — so the webhook always finds an open invoice to link. Reuse `createInvoiceOnSend` (idempotent) at that new call site.

### 7.2 Loser invoice void — new helper required
There is **no reusable void path**: `→archived` voids nothing, `voidExtrasInvoiceWithReconcile` is drink-plan-extras-specific, and the `invoices.js` void is an admin HTTP route the webhook can't call. Build a small **`voidUnpaidProposalInvoice(proposalId, dbClient)`** helper (guarded to `amount_paid = 0`, voids the open Deposit/Full invoice) callable inside the choice-commit transaction. Only relevant to the retroactive case (a solo proposal sent-and-invoiced before being grouped); new-from-start groups never created a loser invoice.

### 7.3 Existing invariant preserved
A price change on one option re-evaluates only **that** option's `amount_paid` vs total (existing rule). Options are independent rows; grouping does not change this. **Pricing engine is untouched** — each option prices as an ordinary proposal, so the hosted-package 1:100 bartender rule holds even when options swap BYOB↔hosted. (Verified: spec adds no `pricingEngine.js` change.)

## 8. Data model

```sql
CREATE TABLE IF NOT EXISTS proposal_groups (
  id                 SERIAL PRIMARY KEY,
  token              UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),  -- canonical /compare link
  client_id          INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  chosen_proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL, -- set at first paid status
  created_by         INTEGER REFERENCES users(id),
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES proposal_groups(id) ON DELETE SET NULL;
```

- **`archive_reason` CHECK** (`schema.sql:2348`) gains `'option_not_chosen'` (drop + re-add the constraint). This feature is the **first live writer** of `archive_reason` — wire the write explicitly.
- `group_id` defaults **NULL** on all existing rows (no backfill needed). Every consumer must treat NULL as "solo."
- FK `ON DELETE SET NULL` on `chosen_proposal_id` and `group_id` is exactly why remove/dissolution must be group-aware (§5.2): a blind delete would silently un-decide a group.
- Option ordering on the compare page: by `proposals.created_at`. No `group_position` column (YAGNI).
- All schema via idempotent statements.

## 9. Observability

`proposal_activity_log` entries (the pervasive existing convention) for: add-alternative, remove-alternative, grouped-send, choice-commit, and each sibling-archive. Sentry-capture the post-commit failure branch (archive/void throws after the winner converts) so a booked-winner-with-live-losers state is caught and reconcilable.

## 10. Reuse map

| Need | Existing thing |
|---|---|
| Clone a proposal | `insertProposalRecord` (`server/utils/proposalInsert.js`) |
| Locked create (anti double-submit) | `proposal_change_requests` `FOR UPDATE` / partial-unique pattern |
| Public token GET + UUID guard + **allowlist** | `publicToken.js`, `server/utils/tokens.js` |
| Compare column contents | `getPackageBySlug` + `sections`/`tagline` (`client/src/data/packages.js`); renderer in `ProposalPricingBreakdown.js` |
| BYOB/Hosted badge | `isHostedPackage` / `isHostedProposal` |
| Sign/pay + event conversion (unchanged) | `SignAndPaySection.js`, `stripeCreateIntent.js`, `stripeWebhook.js`, `createEventShifts` |
| Winner-invoice-before-settle | `createInvoiceOnSend` (idempotent) at a new call site |
| Archive reaps | `cancelMarketingForProposal`, `cancelPendingChangeRequestsForProposal` (`lifecycle.js`) |
| Grouped-send suppression | `checkSuppression` (`scheduledMessageDispatcher.js`) |
| Loser invoice void | **new** `voidUnpaidProposalInvoice` (nothing reusable) |

## 11. Non-goals (v1 YAGNI)

No "Recommended" flag; no inline sign/pay on the compare page; no custom labels or column reorder; no normalized attribute grid; no automated change-of-mind after deposit; no change requests hosted on the compare page; no more than 3 options; no pre-payment cross-member lock beyond first-writer-wins (a stray second payment is refunded + flagged, not prevented).

## 12. Sensitive paths → full review fleet

`server/routes/proposals/*` (lifecycle, crud, publicToken, actions), `server/routes/stripeWebhook.js`, `server/utils/invoiceHelpers.js`, `schema.sql`, `server/utils/proposalInsert.js`, `server/utils/eventCreation.js`.

## 13. Tests & docs to update

- `createInvoiceOnSend` coverage (`crud.test.js` rollback cases) + the `_deps` injection, once send becomes group-conditional.
- New tests: choice-commit concurrency (two members paying), sibling-archive reaps fire, loser invoice void, group dissolution, redirect precedence, grouped-send suppression.
- `README.md` (folder tree, new `/compare` page + route file) and `ARCHITECTURE.md` (route table, `proposal_groups` in the schema section) per the Mandatory Documentation Updates table.

## 14. Genuinely open (defer to plan/build, not blockers)

- Exact new call site for the winner-invoice-before-settle (sign endpoint vs intent-creation) — pin against `publicToken.js` + `stripeCreateIntent.js` during build.
- Admin authed preview route shape for `/compare` before send.

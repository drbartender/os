# Proposal Options / Compare — Design Spec

**Date:** 2026-07-01
**Status:** Approved in brainstorm (section-by-section). Ready for `/review-spec` → plan (lane map).
**Author:** Dallas + Claude

---

## 1. Problem

When a lead wants to weigh their choices (the canonical case: we sent a **BYOB** proposal and they now want to see **hosted** options, or they want to compare **hosted tiers**), we have no real mechanism. Today an admin builds a second proposal from scratch; the two share only a `client_id`, render as unrelated rows in the dashboard, and the client receives two separate `Your Proposal for your … — Dr. Bartender` emails with two separate "View Proposal" links. There is no side-by-side, no compare, and nothing ties the options together. The client can end up paying for one option without ever seeing the other.

## 2. Goal

Let admin present a client with **two or three proposal "options"** side by side, from **one link**, and let the client **compare and choose** cleanly. Under the hood each option stays a full, independent proposal (so the money path never changes); to the client it looks like one unified comparison. "One under the hood, looks like two on screen."

## 3. Core architecture decision

**Each option is a real, separate `proposals` row** (its own `token`, its own `pricing_snapshot`, its own sign/pay path). A new lightweight **`proposal_groups`** entity bundles the sibling options and owns the shared client-facing compare link. The chosen option flows through the **exact existing** sign → Stripe intent → webhook → `createEventShifts` path with zero changes; the unchosen options archive.

**Rejected alternative:** one proposal row holding multiple package variants inline. That would force a rewrite of the most battle-tested code in the system (Stripe intent, `stripeWebhook.js`, `eventCreation.js`, invoicing all assume exactly one snapshot / one `package_id` / one `total_price` per row) for what is fundamentally a presentation feature. Not worth the money-path risk.

## 4. Client experience

### 4.1 The compare page
- **Route:** `/compare/:token` (client), backed by `GET /api/proposals/group/:token` (public, UUID-guarded via `requireUuidToken` / `server/utils/tokens.js`, mirroring `publicToken.js`). `:token` is the group's UUID.
- **Shared header (shown once):** client name, event type, date, service time, guest count, location. These are identical across options and frame the page instead of repeating per column.
- **Each option, side by side (2 columns; support up to 3):**
  - Package name + `tagline` (e.g. "Premium inputs. Amplified output.") as the one-line descriptor — reused straight from `client/src/data/packages.js`.
  - A small derived **BYOB / Hosted badge** off `pricing_type` (`isHostedPackage`), so the who-supplies-the-alcohol axis is unmistakable.
  - Headline **total** + **deposit to book**.
  - **What's included** — the package's real `sections[]` (Spirits / Beer & Wine / Mixers & Modifiers / Non-Alcoholic), brand-level, rendered from `getPackageBySlug(option.package_slug)`. Because every package shares those section headings, two tiers naturally align row-band by row-band and the client can compare "this tier's vodka vs that tier's vodka" with no rigid attribute grid.
  - A **"Choose this one"** button — the only action.
- **What stays OFF the compare page:** full service agreement, gratuity block, payment terms, card entry. Those live on the click-through proposal. The compare page is pure presentation and touches **zero** money surface.

### 4.2 Choose flow (lightweight chooser)
"Choose this one" links to that option's existing sign/pay page: **`/proposal/:optionToken?choose=1`**. The client signs and pays there exactly as today. The `?choose=1` param is the compare→proposal hand-off marker (see redirect rule 4.3).

### 4.3 Old-link / cold-link redirect
The BYOB link already sitting in a client's inbox must keep working after we add an alternative.
- `GET /api/proposals/t/:token` returns the member's `group_id` + the group's compare token + whether the group is **decided** (has a `chosen_proposal_id`).
- `ProposalView` behavior:
  - **Undecided group, cold hit (no `?choose`)** → redirect to `/compare/:groupToken`. One canonical landing spot no matter which option's link they clicked.
  - **`?choose=1` present** → render the proposal's sign/pay page normally (no redirect). This prevents the compare→choose→bounce-back loop.
  - **Decided group** (someone already paid) → any member token resolves to the **chosen** proposal's view (booked/paid state). The losing link never shows a dead archived page.

## 5. Admin experience

### 5.1 "Add an alternative" (the one genuinely new primitive)
- **Endpoint:** `POST /api/proposals/:id/alternative`. Clones the source proposal via the canonical `insertProposalRecord` (copying client, event type, date, time, guest count, location, num_bars — the shared logistics), defaults the new option's package to the source's so it is immediately valid, and ensures both rows share a group:
  - If the source isn't grouped yet, create a `proposal_groups` row and set `group_id` on both source and new option.
  - If already grouped, attach the new option to the existing group.
- Returns the new proposal id; admin opens it in the existing edit flow and swaps the package (BYOB→hosted) / tweaks.
- **Works before OR after the first send.** Build both up front and send the set once, or send BYOB solo and convert it to a group later when they ask.
- **Cap:** 3 options per group.

### 5.2 Managing a group
`ProposalDetail.js` gains an **"Alternatives" panel**: lists the sibling options (package, total, status), an "Add an alternative" button, and a per-option remove. No separate group page for v1 (reuse the detail surface we already have).

### 5.3 Grouped send = one email, one link
When a proposal belongs to a group, "send" sends the **set**:
- Transition each member to `sent` (each individually viewable/payable).
- Send **one** email (new `emailTemplates.proposalOptionsSent`, one "Compare your options" CTA → `/compare/:groupToken`), NOT a per-option `proposalSent`.
- **Defer invoicing** (see §7.1).

### 5.4 Dashboard rollup
The flat proposals list collapses a group into **one row** ("Client · Event · 2 options · status"), expandable / clickable into the group. Ungrouped proposals render as normal rows. Avoids N confusing sibling rows. `ClientDetail.js`'s proposals table gets the same rollup.

## 6. Acceptance & lifecycle

- **Choice commits at first paid status.** The group stays **undecided** until a member reaches `deposit_paid` / `balance_paid` / `confirmed`. Before that, the client may return to compare and pick a different option freely (signing an option without paying does not lock the group).
- **On the chosen option's payment success** (inside the existing `stripeWebhook.js` path that already calls `createEventShifts`):
  1. Set `proposal_groups.chosen_proposal_id`.
  2. Archive the sibling options: `status='archived'`, `archive_reason='option_not_chosen'` (new CHECK value). Recoverable via the existing `archived → draft` transition.
  3. Void any invoice attached to a now-archived sibling (only possible in the retroactive-from-solo case, §7.2).
  4. The chosen option converts to an event **unchanged**.
- **Group dissolution.** If an admin removes an alternative and only one option remains, dissolve the group (clear the survivor's `group_id`, drop the group row). The survivor reverts to a normal solo proposal and its link stops redirecting to compare.

## 7. Money & cross-cutting-consistency seams (the delicate parts — full review fleet)

### 7.1 Deferred invoicing on grouped sends
Today `PATCH /:id/status → 'sent'` runs `createInvoiceOnSend(id)` in-transaction (`lifecycle.js`). For a comparison, creating an invoice per option at send would leave a dangling invoice on the option the client never picks. **Rule:** `createInvoiceOnSend` runs at send only for **ungrouped** proposals (or a group of one). For grouped options, invoice creation is **deferred to choice** — run it (idempotently) for the **chosen** option when it enters the sign/pay path, so the unpicked options never generate an invoice.

### 7.2 Retroactive grouping of an already-sent (already-invoiced) solo proposal
If BYOB was sent solo first, `createInvoiceOnSend` already ran for it. When it later becomes a group member and loses, archiving it (§6.2) must **void that pre-existing invoice**. New-from-the-start groups never hit this (invoicing was deferred), but the retroactive path must clean up.

### 7.3 Existing invariant still applies
Per CLAUDE.md "Money, auth, and data" — a price change on one option re-evaluates only **that** option's payment status. Grouping does not change this; options are independent rows.

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

- **`archive_reason` CHECK** gains `'option_not_chosen'` (current set: `no_hire | client_cancelled | we_cancelled | event_completed | other`). Note the existing reason column had no live write path; this feature adds the first one, so wire the write explicitly.
- **Option ordering** on the compare page: by `proposals.created_at` (the order admin added them). No `group_position` column for v1 (YAGNI).
- All schema via idempotent statements in `schema.sql` per project convention.

## 9. Reuse map (lean on what exists)

| Need | Existing thing |
|---|---|
| Clone a proposal | `insertProposalRecord` (`server/utils/proposalInsert.js`) — the one canonical INSERT shape |
| Public token GET + UUID guard | `server/routes/proposals/publicToken.js`, `server/utils/tokens.js` |
| Compare column contents | `getPackageBySlug` + `sections`/`tagline` (`client/src/data/packages.js`); section renderer in `ProposalPricingBreakdown.js` |
| BYOB/Hosted badge | `isHostedPackage` / `isHostedProposal` (`pricingEngine.js` / `eventCreation.js`) |
| Sign/pay (unchanged) | `SignAndPaySection.js`, `stripeCreateIntent.js`, `stripeWebhook.js` |
| Event conversion (unchanged) | `createEventShifts` (`server/utils/eventCreation.js`) |
| Grouped send email | new `emailTemplates.proposalOptionsSent`, sent via `sendProposalSentEmail` sibling path |
| Related-table pattern (FK + partial-unique + activity log) | `proposal_change_requests` |

## 10. Non-goals (v1 YAGNI boundaries)

- **No "Recommended" flag.** Options present as equals; trivial boolean to add later.
- No inline sign/pay on the compare page (lightweight chooser only).
- No custom option labels or column reordering.
- No per-attribute normalized comparison grid (natural section-heading alignment is enough).
- No automated change-of-mind after deposit (existing manual / change-request handling).
- No change requests hosted on the compare page (portal per-option flow unchanged).
- More than 3 options.

## 11. Sensitive paths touched → full review fleet on these lanes

`server/routes/proposals/*` (lifecycle, crud, publicToken), `server/routes/stripeWebhook.js`, invoicing, `schema.sql`, `server/utils/proposalInsert.js`. Triggers the full agent fleet per the review model.

## 12. Open items to pin in the plan (not blockers)

- Exact call-site mechanics of deferring `createInvoiceOnSend` and the idempotent choose-time invoice creation, verified against `lifecycle.js` + `stripeWebhook.js`.
- Invoice-void mechanism for §7.2 (reuse whatever archive/cancel already does to invoices, if anything).
- Admin preview of `/compare/:token` before send (public GET should 404 while the group has never been sent; admin gets an authed preview).
- Drip-marketing interaction: a grouped send should schedule/suppress drip once for the group, not per option.

# Thumbtack Budget Warning: over-budget badge on auto-drafted proposals

**Date:** 2026-07-02
**Status:** Approved (brainstorm section-by-section)
**Scope:** Small/Medium, one lane

## Goal

Surface the budget a Thumbtack lead stated in its Q&A so the admin sees, the moment they open the auto-drafted proposal, that the computed price exceeds what the client said they'd spend, and can offer a discount or trim scope to win the job. Intent (Dallas): win jobs; discounting a random Thursday afternoon or a 1-hour corporate happy hour is fine.

## Production findings (verified 2026-07-02, prod Neon read-only)

- 191 of 194 `thumbtack_leads` rows carry a Budget Q&A. Path: `raw_payload -> data -> request -> details` (note the `data` wrapper; the fix-list doc said `request.details`).
- The answer is a multi-select of ranges, comma-joined. Observed tokens: `Under $200 (typically only for small/brief events)`, `$200 - $300 (typically only for small/brief events)`, `$300 - $400`, `$400 - $500`, `$500 - $600`, `$600- $750`, `More than $750`, `I'm not sure`, plus one free-form `$300 to $600`. HTML entities appear in prod data (`I&#39;m not sure`).
- About 20% of leads answer only "I'm not sure".
- Roughly half of all leads state budgets at or below $400, right around the Core Reaction draft floor, so the warning fires often and usefully.

## Decisions (locked in brainstorm)

1. **Forward-only.** Parse at webhook time for leads arriving after this ships. NO backfill of existing leads.
2. **No parseable cap means no flag.** "I'm not sure" and "More than $750" produce no warning. "More than $750" still renders as context in the payment panel.
3. **Badge is pre-acceptance only.** Shown on `draft` and `sent`; hidden once accepted/paid/archived (they took the price). The payment-panel context line shows at every status.
4. **Admin-only.** Never client-facing.
5. **Whole dollars.** Budget columns store integer dollars, matching `proposals.total_price` units (the documented proposals dollars exception), with a schema comment saying so.

## Approach

Parse at webhook time into columns on `thumbtack_leads` (the `guest_count` precedent), not parse-on-read from `raw_payload`. Stored columns keep the feature forward-only naturally, make budgets queryable later (budget vs close-rate reporting), and cost one trivial join at read time. Parse-on-read was rejected: it re-parses on every view and would incidentally light up old leads.

## Design

### 1. Parser

New `extractBudget(details)` in `server/routes/thumbtack.js`, beside `extractGuestCount`:

- Find the first Q&A row whose question contains "budget" (case-insensitive).
- Decode common HTML entities in the answer (`&#39;`, `&amp;`, `&quot;`, `&lt;`, `&gt;`).
- Split on commas, trim tokens (observed tokens never contain internal commas).
- Map each token:
  - contains "not sure" (or parses to nothing): contributes nothing
  - "Under $X": bounds [0, X]
  - "More than $X" / "Over $X": bounds [X, open]
  - two numbers ("$A - $B", "$A to $B"): bounds [A, B]
  - a single number with no under/more keyword (a bare "$400"): contributes nothing; not an observed prod shape, and guessing a bound from it risks a wrong flag
- Aggregate: `budgetMin` = min of mins, `budgetMax` = max of maxes; any open-ended token forces `budgetMax` to null.
- Return `{ budgetMin, budgetMax, budgetRaw }`; all null when no budget question exists or nothing parses. `budgetRaw` is the decoded original answer, truncated to 500 chars.
- Both the V4 and legacy branches of `parseLead` carry the three fields (legacy payloads also have `request.details`).

### 2. Schema

Idempotent ALTERs on `thumbtack_leads` in `schema.sql`:

- `budget_min INTEGER` (whole dollars)
- `budget_max INTEGER` (whole dollars; NULL = no cap known, covering both "not sure" and "More than $750")
- `budget_raw TEXT` (decoded original answer, for display)

Schema comment states the dollars unit explicitly. Prod gets the columns via initDb on deploy; dev DB gets them applied by hand (schema.sql is not auto-applied to dev).

### 3. Delivery

The single-proposal GET in `server/routes/proposals/crud.js` (the `SELECT p.*, c.name ...` query) gains a lateral join pulling `budget_min`, `budget_max`, `budget_raw` from the lead stamped with this `proposal_id`, newest lead wins (`ORDER BY tl.id DESC LIMIT 1`, same as `/lead-cost`). The fields ride the proposal payload as `proposal.budget_min` / `budget_max` / `budget_raw`. No new endpoint, no new client fetch; an edit that changes the total refetches the proposal, so the warning updates for free.

### 4. UI (two touches, both admin)

- **Header badge** in `client/src/pages/admin/ProposalDetail.js`, next to the last-minute badge (`lm-hold-badge` precedent). Render when `budget_max` is non-null AND `Number(total_price) > budget_max` (strict) AND status is `draft` or `sent`. Copy: `⚠ Over stated budget: $505 vs $300-400` (single-bound budgets render as `vs under $200` style). Tooltip: "Thumbtack lead stated this budget. Consider a discount or trimmed scope to win the job." New CSS class (e.g. `budget-over-badge`) in `index.css`, styled in the red family like the last-minute badge.
- **Payment panel line** in `ProposalDetailPaymentPanel.js`: a "Stated budget" row under Acquisition rendering `budget_raw`, shown at every status whenever a budget exists.

### 5. Tests and docs

- Unit tests on `extractBudget` covering the real prod shapes: single range, multi-select ranges, unsure-only, unsure-plus-range, Under $200, More than $750 alone and mixed with ranges, entity decoding, `$300 to $600`, junk/absent.
- `parseLead` pass-through check (V4 + legacy).
- Webhook INSERT path extended in the existing `thumbtack.test.js`.
- ARCHITECTURE.md schema section updated (three new columns).

## Edge cases

- Mixed `I'm not sure, $300 - $400`: unsure token ignored, range used.
- Any "More than $X" token suppresses the flag even when other ranges are selected (open max).
- Unparseable junk tokens contribute nothing; if nothing parses, all three fields stay null.
- Multiple leads stamped to one proposal: newest lead wins, matching `/lead-cost`.
- `budget_raw` present with null `budget_max` (e.g. "More than $750"): context line renders, badge never does.

## Out of scope

- Backfill of existing leads (explicitly declined).
- Badges on ProposalsDashboard list rows.
- Computed discount suggestions (the badge flags; the admin decides).
- Anything client-facing.
- Budget analytics/reporting (enabled by the columns, not built now).

## Review note

`server/routes/thumbtack.js` is on `scripts/sensitive-paths.txt`: the lane merge gets the full review fleet, and push time gets the sensitive-path re-review plus `/second-opinion`.

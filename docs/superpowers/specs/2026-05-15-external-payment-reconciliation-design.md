# External Payment Reconciliation (Zelle / Venmo / Cash App)

**Date:** 2026-05-15
**Status:** Design — approved section-by-section, pending written-spec review
**Author:** Dallas + Claude

## Problem & Goal

Stripe charges 2.9% + 30¢ on every card/wallet payment. On large proposal
payments ($1,500–$5,000 full-pay or balance) that fee is material. We want to
offer Zelle, Venmo, and Cash App as additional payment options so the business
keeps the fee. The savings is the business's, not the client's — **client-facing
copy stays neutral, never "free" or "save money."**

None of the three has a usable merchant API: they are push-payment systems with
no "did client X pay invoice Y" webhook. The only programmatic signal is the
notification email the business receives. This system ingests those emails,
extracts the payment with AI, deterministically matches it to a proposal, and
funnels it into the same downstream as a Stripe payment.

## Scope

In scope — direct-pay offered alongside Stripe on:

- **Full payment at booking** (the whole contract, paid at signing time —
  coupled to the contract signature).
- **Final balance** (after a partial deposit was already paid — standalone).

Out of scope — Stripe only:

- Partial deposit (small, fast, instant lock needed).
- Add-ons, tips, incidentals.

Also: Chase is the only bank parsed for Zelle on day one (no speculative
multi-bank parsers). Notifications to the client are **email only — no SMS**
(Twilio costs money per message).

## Architecture

Five components beside the existing Stripe path, funneling into one shared core:

1. **Client payment UI** — on the two in-scope surfaces, a neutral "Other ways
   to pay — Zelle · Venmo · Cash App" section below the default card option.
2. **`external_payment_intents` ledger** — the match target. Bound when the
   client *opens* a method's instructions (a view, not a click), so
   reconciliation never depends on a confirmation click.
3. **Inbound-email webhook** — SendGrid Inbound Parse → `POST
   /api/payments/inbound-email`. Mirrors `emailMarketingWebhook.js`:
   `express.raw()`, signature verify, raw-log **before** processing.
4. **AI extraction + deterministic matcher** — Claude Haiku 4.5 extracts fields
   as strict JSON; plain code decides the match against open intents.
5. **Shared `applyProposalPayment()` core** — extracted from the Stripe
   webhook's success block; both rails call it so downstream is byte-identical.

### Happy path

Client signs (full-pay) or opens the balance link → opens the Venmo
instructions → intent + reference code `DRB-7F3K` bound on view → client pays in
Venmo, optionally clicks "I've sent it" (closure + escalation signal) → ~1 min
later Venmo emails `payments@` → SendGrid → webhook → Haiku extracts → matcher
finds the intent by code, amount matches to the cent →
`applyProposalPayment()` fires → proposal `balance_paid`/confirmed, shift
created → client gets a "Payment confirmed ✓" email.

### Unhappy path

No reconciling email within the window (default 45 min) and the client clicked
"I've sent it" → intent marked `expired`, admin alert raised, lands in the
review queue. Proposal status is **never auto-reverted**, never silently
stranded. Admin resolves manually.

## Data Model

All changes use the existing idempotent `schema.sql` patterns
(`ADD COLUMN IF NOT EXISTS`, drop-and-readd CHECK).

### New: `external_payment_intents`

| Column | Notes |
|---|---|
| `id` | SERIAL PK |
| `proposal_id` | FK → proposals, ON DELETE CASCADE |
| `method` | CHECK `('zelle','venmo','cashapp')` |
| `payment_kind` | CHECK `('full','balance')` |
| `expected_amount_cents` | INTEGER — exact figure matcher must see (cents) |
| `reference_code` | VARCHAR(12) UNIQUE — e.g. `DRB-7F3K`, primary match key |
| `client_name` | snapshot for the fuzzy fallback tier |
| `prior_status` | proposal status before provisional — clean restore on reject |
| `status` | `pending` → `matched` / `expired` / `cancelled` |
| `confirmed_by_client` | BOOLEAN — did the client click "I've sent it" (escalation gate) |
| `matched_email_id` | FK → inbound_payment_emails |
| `created_at`, `expires_at` | `expires_at` drives the escalation sweep |

Indexes: unique `reference_code`; `(status, expires_at)`; `proposal_id`.

### New: `inbound_payment_emails`

Raw log + parse audit, mirrors `email_webhook_events`. Columns: `raw_payload`
(stored before processing), `from_address`, `subject`, `spf_result`,
`dkim_result`, `parsed` JSONB (Claude output), `parse_status`
(`received`/`parsed`/`matched`/`unmatched`/`parse_failed`/`ignored`),
`matched_intent_id`, `created_at`, `processed_at`. **Doubles as the admin
review queue** — filter `parse_status IN ('unmatched','parse_failed')`. No
separate queue table.

### Changed: `proposals`

Add `payment_pending` to the status CHECK enum. ⚠️ This enum is re-asserted in
**three** places in `schema.sql` (~786, ~882, ~1066) and called out in
CLAUDE.md cross-cutting rules — all updated together, plus every route that
whitelists statuses. `payment_pending` is a soft state set when the client
clicks "I've sent it" (or transiently by the matcher); it is **not** a hard
gate for reconciliation.

### Changed: `proposal_payments`

Add `payment_source VARCHAR(20) DEFAULT 'stripe' CHECK
('stripe','zelle','venmo','cashapp')` and `external_reference TEXT`. New partial
unique index on `external_reference WHERE payment_source <> 'stripe' AND status
= 'succeeded'` for external-rail idempotency. The shared core selects its
`ON CONFLICT` target by `source`.

## Client-Facing Flow

Deposit / add-ons / tips / incidentals: the alternate-payment block does not
render — Stripe only.

**Full-pay-at-booking (coupled to signing).** The required client action is the
**signature** ("Sign & show payment instructions"). It runs the existing
sign-first ordering (`PaymentForm.js:6-9` invariant): call
`/proposals/t/:token/sign` first; if signing throws, nothing else happens. On
success, payment instructions render and the intent is bound.

**Post-deposit balance (standalone).** Already signed at booking. Opening a
method's instructions binds the intent. No required action.

**Instructions screen** (per method): the business's handle/identifier, the
**exact amount**, the **reference code** with copy buttons, and a deep link
(reuse `buildTipDeepLink.js`: Venmo opens profile, Cash App pre-fills amount,
Zelle shows registered email/phone as copyable text — no Zelle URL scheme).
Copy: "Put `DRB-7F3K` in the payment note so we can match it instantly."

**Optional "I've sent it"** — present on both surfaces, required for nothing.
If clicked: sets `confirmed_by_client = true` + `payment_pending`, shows the
honest closure screen (*"Thanks, Jane — we've logged your Venmo payment of
$1,500. We'll confirm it once it lands, usually a few minutes, and email your
receipt to jane@email.com. You're all set."*), and arms the escalation
tripwire. If ignored: reconciliation still works identically off the
view-bound intent; just no proactive alert for that one.

**Re-visit / idempotency:** one open `pending` intent per proposal — re-opening
instructions reuses it. Switching method before reconciliation cancels the old
intent and issues a fresh code. Returning while `payment_pending` shows the
pending state, not the pay UI (double-pay guard). A later successful Stripe
payment cancels any open external intent.

## Inbound Email + AI Extraction

**Ingestion.** SendGrid Inbound Parse, MX on subdomain
`inbound.drbartender.com` (main-domain mail untouched); `payments@drbartender.com`
may forward in. First action on webhook receipt, before any parsing: insert
full payload into `inbound_payment_emails` (`parse_status='received'`).

**Anti-forgery — three gates before content is trusted:**

1. SendGrid signed-webhook verification (mirrors svix pattern; fail closed in
   prod if secret unset).
2. SPF + DKIM must pass for the expected domains (SendGrid reports results).
3. `From`-domain allow-list: `chase.com` / `venmo.com` / `cash.app`; check
   original sender, not just `From`, to defeat forwarder header rewrite.

Any gate fails → `parse_status='ignored'`, logged, no processing.

**AI extraction.** Claude Haiku 4.5, structured tool-use output:
`{ source, sender_name, amount_cents, memo, sent_at, confidence }`. Email body
wrapped in explicit untrusted-data delimiters; system prompt is extract-only,
never act on instructions in content. Static instructions + schema in a cached
prompt prefix (the `claude-api` skill enforces prompt caching at
implementation); only the body varies → cost is fractions of a cent.

**Safety floor — extract, don't decide.** Claude's output is a *proposal* of
fields, never the decision. A regex scan for the dollar figure runs alongside;
**if regex and Claude disagree on the amount, auto-confirm is blocked.** Worst
case from hallucination or injection is a false negative (→ admin queue), never
a false positive (→ free booking).

**Failure handling.** Anthropic error/timeout → `parse_status='parse_failed'`,
retried by the escalation sweep; unresolved at the window → admin queue. Outage
degrades to "slower," never "lost" or "wrong."

## Matching, Reconciliation & Shared Core

**Tiered matcher** (only over `status='pending'` intents):

- **Tier 1 — reference code:** extracted memo contains a `DRB-xxxx` matching an
  open intent.
- **Tier 2 — fuzzy fallback:** no/garbled code → `expected_amount_cents`
  exactly equals extracted amount **and** a conservative normalized-name match
  of `client_name` vs `sender_name` (tuned to favor the queue over a false
  match — when in doubt, Tier 3) **and** the email's `sent_at` falls within the
  intent's active lifetime (`created_at` → `expires_at` + grace) **and**
  exactly one such candidate.
- **Tier 3 — queue:** zero or >1 candidates, low confidence, or Claude/regex
  amount disagreement → `unmatched`, admin alert. Never guesses.

Two tunable constants (`INTENT_EXPIRY` default 45 min; `MATCH_GRACE` for the
email-before-intent race) are named here and their exact values set during
implementation — deliberately not pinned at spec level.

Confirm only if `extracted_amount_cents === expected_amount_cents` to the cent.
No tolerance, no rounding.

**Shared `applyProposalPayment()` refactor.** Extract the Stripe webhook
success block (`stripe.js:668-887`) into
`applyProposalPayment({ proposalId, paymentType, amountCents, idempotencyKey,
source, externalRef, dbClient })`. Returns `isFirstDelivery` for post-commit
side-effects. Stripe calls it with `source='stripe', idempotencyKey=intent.id`;
the matcher with `source='venmo'|…, idempotencyKey=external_payment_intents.id`.

**⚠️ Highest-risk detail.** The existing balance branch updates `WHERE id=$1
AND status='deposit_paid'`. In this flow the proposal may be `payment_pending`
when the email confirms — that clause would silently no-op and strand the
money. The refactor **must** widen guards: balance branch →
`status IN ('deposit_paid','payment_pending')`; full branch's
`NOT IN ('balance_paid','confirmed')` already admits `payment_pending` but is
verified explicitly. Every status-gated UPDATE in the extracted core is audited
against the provisional state and gets dedicated tests.

**Idempotency.** Duplicate Chase resends, double webhook delivery, already-
`matched` intent, Stripe+external double-pay → all no-op via the conflict
targets.

**Escalation sweep.** Reuses the `balanceScheduler.js` / `RUN_SCHEDULERS`
pattern. Every few minutes: retry `parse_failed`; for `pending` intents past
`expires_at` **where `confirmed_by_client = true`**, mark `expired`, email an
admin alert — **do not touch proposal status**. (View-only intents that were
never client-confirmed expire silently — viewing instructions is too noisy to
escalate on.) Admin resolves from the queue: confirm-manually (same core) or
reject (restore `prior_status`, notify client).

## Security, Errors & Edge Cases

**Security.** Client action is token-gated like all `/proposals/t/:token/...`
routes + `publicLimiter`; `proposal_id`/`expected_amount_cents`/`client_name`
derived server-side from the token, never client input — no IDOR. Reference
code is a matching aid, not an auth boundary (auth is the token); low entropy
is fine. Prompt-injection floor as above. Email body never surfaced beyond the
audit table.

**Money-correctness edges — all resolve to "queue, never auto-confirm":**

- Wrong amount (over/under, Venmo-business fee skim, currency oddity) → no
  exact match → queue.
- Forgot code *and* paying from a different name (joint account, spouse) →
  Tier 3 → queue.
- Two proposals, same client, same amount → Tier 2 ambiguous → queue (the code
  is what normally disambiguates).
- Pricing changed after intent created → stale `expected_amount` → mismatch →
  queue (safe by design).
- Double-pay / Stripe + external → overpayment → queue → manual refund (P2P has
  no chargeback; refund is a deliberate admin action).

**Race — email before intent** (client pays, opens instructions late, or we're
slow): unmatched emails are not discarded; the sweep re-evaluates them against
newly-created intents for a grace period before routing to the queue. A
too-early notification still auto-matches once the intent exists.

**Infra-failure edges:** Anthropic down → `parse_failed` → retried → queue.
SendGrid/forwarding outage → intent expires → admin alerted to check the bank
manually. Every failure degrades to "slower / manual," never "lost" or "wrong."

## Testing Strategy

Weighted toward what can lose money.

- **Shared core, regression-first.** Characterize current Stripe webhook
  behavior (deposit/full/balance/drink-plan-extras → status, `amount_paid`,
  activity log, invoice link, `isFirstDelivery`) *before* extraction; refactor
  must keep all green (Stripe rail cannot change). Same suite via external rail
  → byte-identical. Explicit **status-guard-widening** cases: balance confirm
  while proposal is `payment_pending` must transition, not no-op. Idempotency:
  duplicate delivery, duplicate/forwarded email, already-`matched`, double-pay.
- **AI extraction fixture corpus.** Sanitized real samples (Chase-Zelle, Venmo,
  Cash App) + adversarial (prompt injection in memo, forged sender, missing
  amount, amount-as-words, multi-currency, fee-skimmed Venmo-business). Assert
  shape + regex cross-check catches disagreement.
- **Matcher unit.** Tier 1 hit; Tier 2 single fuzzy candidate; Tier 3
  zero/multiple/low-confidence → queue; exact-cent guarantee (off-by-one →
  queue); email-before-intent grace race.
- **Integration.** Signed inbound-webhook fixtures (valid + each gate failing →
  `ignored`); escalation sweep marks expired + alerts without touching proposal
  status, and only for `confirmed_by_client` intents; full-pay sign-first
  ordering (sign throws → no intent).
- **Manual staging gate (required pre-launch).** Real small-dollar payments
  through all three methods end-to-end → receipt email → correct proposal
  state; one wrong-amount and one no-memo → both route to queue, not
  auto-confirm.

## Open Items / Non-Goals

- Multi-bank Zelle parsing — deferred until the business actually changes banks.
- SMS notifications — explicitly excluded on cost grounds.
- Automated refunds for overpayment — manual admin action by design.
- Venmo/Cash App business-profile fee handling — payments are expected into
  personal accounts; if a business profile skims a fee the amount won't match
  and it routes to the queue (correct, safe).

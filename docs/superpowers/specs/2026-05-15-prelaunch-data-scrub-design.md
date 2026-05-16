# Pre-Launch Data Scrub — Design Spec

**Date:** 2026-05-15
**Status:** **EXECUTED 2026-05-16Z** — production (`br-noisy-frog-ad99sa6l`) scrubbed via `server/scripts/prelaunch-data-scrub.sql` after a clean rehearsal. Post-scrub verified: proposals 6 `{21,25,30,51,52,54}`, clients 71 (0 keep-predicate violations), users 6 `{1,2,12,15,16,19}`; catalog/Thumbtack/automation config untouched. Restore point: Neon branch `br-morning-union-ad26nq4r` (full pre-scrub copy) retained + ~6h PITR. Audit dump: `C:\Users\dalla\prelaunch-scrub-deleted-2026-05-15.json` (46 proposals / 28 clients / 13 users, outside repo — PII).

**Drift addendum 2026-05-15:** Ketan Patel converted from quote-wizard lead #46 to a real `deposit_paid` booking ($650, event 2026-05-16) during rehearsal prep — proposal **#54** + client **#102** added to the keep-set; verified intact post-scrub. The `created_at < 2026-05-16Z` cutoff + Task 5 drift gate handled live traffic.
**Risk:** HIGH — destructive operation on the production Neon database. Real client/staff data is interleaved with development/test data.

## Problem

The production database (`dr-bartender`, branch `production` = `br-noisy-frog-ad99sa6l`) accumulated heavy development/test data during the build-up to the Check Cherry cutover. Now that DRB OS is live, the test data must be purged while preserving genuine client, staff, and Thumbtack-lead data, and all catalog/automation config. The planned cutover-by-date heuristic does **not** work: only 1 proposal exists after 2026-05-12, so test vs. real must be decided by identity, not by date.

## Decisions (locked)

### Users — keep 6, delete 13

**KEEP (ids):** `1` admin@drbartender.com · `2` zul@drbartender.com · `12` dallas@drbartender.com · `15` bookari773@gmail.com (Ariel Smith) · `16` sleepywilli@gmail.com (Evan Williams) · `19` bellagracecoffee@gmail.com (Kristine andersen)

**DELETE (ids):** `3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 17, 18`

Includes deliberately-removed real records the user confirmed: `#11` slparent@gmail.com (Sean, hired staff), `#3` dallasraby@gmail.com (owner's Gmail alt), `#18` zeehme51@gmail.com (Zuleika, deactivated mgr), plus the 8 fake-domain test accounts and the owner's `drabymj`/`rabydallas` alts.

### Proposals — keep 6, delete 46

**KEEP (ids):** `21` (Stef D., $400 balance_paid) · `25` (Jane) · `30` (Kaite Watson) · `51` (David Luebke) · `52` (Tabitha Lopez) · `54` (Ketan Patel — real `deposit_paid` booking, converted post-analysis 2026-05-15)

**DELETE:** all other 46 proposals.

### Clients — keep 71, delete 28

**KEEP:** every client with a row in `thumbtack_leads` (i.e. `EXISTS (SELECT 1 FROM thumbtack_leads tl WHERE tl.client_id = clients.id)`) — 65 real webhook leads — **UNION** the 6 clients of kept proposals: `21` (Stef D.), `26` (Jane), `31` (Kaite Watson), `80` (David Luebke), `83` (Tabitha Lopez), `102` (Ketan Patel — converted post-analysis 2026-05-15).

**DELETE:** all other 28 clients (Dallas Raby variants, @labrat.test, joke names, unlinked `source='thumbtack'` test entries).

### Shifts — keep 1, delete 18

Keep shifts whose `proposal_id` ∈ kept proposals (1 row). Delete the rest (18). No standalone (proposal_id IS NULL) shifts exist.

### Invoices — delete all 8

Zero invoices reference a kept proposal. All 8 must be deleted **before** their proposals (`invoices.proposal_id` = `RESTRICT` — will block a proposal delete otherwise). Cascades to `invoice_line_items`, `invoice_payments`.

### Email leads / quote drafts / enrollments — keep real customer trail + config

- **KEEP `email_leads`:** `44` (David Luebke — kept proposal #51) · `46` (Ketan Patel — fresh real inbound 5/15). **DELETE:** `41, 42, 43, 45`.
- **KEEP `quote_drafts`:** the 2 whose `lead_id` ∈ {44, 46}. **DELETE** the other 4.
- **KEEP `email_sequence_enrollments`:** the 2 whose `lead_id` ∈ {44, 46}. **DELETE** the 1 for lead 42 (Sean).
- **KEEP untouched (automation config):** `email_campaigns` (1 — "Abandoned Quote Followup") · `email_sequence_steps` (2).

### Other

- **`sms_messages`:** delete the lone test row (id 1, "Testing !. 2. 4.").
- **Untouched catalog/config:** `service_packages`, `service_addons`, `cocktails`, `cocktail_categories`, `mocktails`, `mocktail_categories`, `app_settings`, `blog_posts`.
- **Untouched real Thumbtack data:** `thumbtack_leads` (66), `thumbtack_messages` (126), `thumbtack_reviews` (0).
- **Lab Rat:** `tester_bugs` (0) and `mission_completions` (0) tables untouched; the `@labrat.test` seeded proposals/clients fall inside the delete-sets and are purged. `server/utils/labratCleanup.js` scheduler is unaffected.
- **No Stripe verification needed** — user confirmed all dev payments were Stripe test-mode (no real money).

## Approach (chosen: Neon branch dry-run → verify → apply)

1. **Snapshot/rehearse:** create a Neon branch from `production` (instant copy-on-write) — this branch *is* the restore point.
2. **Rehearse:** run the full transactional script on the branch.
3. **Verify on branch:** run all post-condition asserts (below) + a smoke check (app key queries succeed).
4. **Apply to prod:** run the *identical* script on `production` inside one `BEGIN … COMMIT`, with the asserts as an in-transaction guard (`RAISE EXCEPTION` → auto-`ROLLBACK` on any mismatch).
5. **Retain rollback path:** keep the rehearsal branch + Neon ~6h PITR until prod is sanity-checked in the live app, then delete the branch.
6. **Audit trail:** before `COMMIT` on prod, dump deleted `proposals`/`clients`/`users` rows to a timestamped gitignored SQL file.

## Deletion order (single transaction, FK-safe)

Build keep-lists as temp tables first (`keep_users`, `keep_proposals`, `keep_clients`, `keep_email_leads`), then:

1. `invoices` where `proposal_id NOT IN keep_proposals` → cascades `invoice_line_items`, `invoice_payments` *(must precede proposals — RESTRICT)*
2. `shifts` where `proposal_id IS NULL OR proposal_id NOT IN keep_proposals` → cascades `shift_requests`
3. `proposals` where `id NOT IN keep_proposals` → cascades `proposal_addons`, `proposal_activity_log`, `proposal_payments`, `stripe_sessions`, `drink_plans`
4. `email_sequence_enrollments` where `lead_id NOT IN keep_email_leads`
5. `quote_drafts` where `lead_id IS NULL OR lead_id NOT IN keep_email_leads`
6. `email_leads` where `id NOT IN keep_email_leads`
7. `sms_messages` — delete the test row
8. `clients` where `id NOT IN keep_clients` *(after proposals; `proposals.client_id`/`thumbtack_leads.client_id`/`email_leads.client_id` are all SET NULL — kept links are safe because every tt-linked client is in keep_clients)*
9. `users` where `id NOT IN keep_users` → cascades `agreements`, `applications`, `contractor_profiles`, `onboarding_progress`, `interview_notes`, `interview_scores`, `payment_profiles`, `shift_requests`, `application_activity`, `password_reset_tokens`; SET NULL on `proposals.created_by`, `shifts.created_by`, `drink_plans.created_by`, `sms_messages.sender/recipient`, `email_campaigns.created_by`, `admin_audit_log`

## Verification (asserted before COMMIT; abort on any failure)

- `users` = 6, exactly `{1,2,12,15,16,19}`
- `proposals` = 6, exactly `{21,25,30,51,52,54}`
- `clients` = 71; every surviving client has a `thumbtack_leads` row OR `id ∈ {21,26,31,80,83,102}`
- Each kept proposal's `client_id` still resolves to a surviving client
- No `thumbtack_leads` row gets its `client_id` nulled (no tt-lead orphaned by a client delete)
- `thumbtack_leads` = 66, `thumbtack_messages` = 126 (unchanged)
- `email_campaigns` = 1, `email_sequence_steps` = 2 (unchanged); `email_leads` = 2 `{44,46}`; `quote_drafts` = 2; `email_sequence_enrollments` = 2
- `shifts` = 1 (only the one on a kept proposal); `sms_messages` = 0
- Zero orphaned rows in `proposal_addons`/`proposal_payments`/`stripe_sessions`/`drink_plans`/`invoice_line_items` (CASCADE invariant, asserted)
- Catalog tables (`service_packages`, `service_addons`, `cocktails`, `cocktail_categories`, `mocktails`, `mocktail_categories`, `app_settings`, `blog_posts`) row counts unchanged

## Artifacts

- `server/scripts/prelaunch-data-scrub.sql` — committed transactional script; keep-lists as the single source of truth; inline asserts. Consistent with the existing `server/scripts/cleanupLabratTestData.js` pattern.
- This spec: `docs/superpowers/specs/2026-05-15-prelaunch-data-scrub-design.md`.
- Deleted-rows dump: `.tmp/prelaunch-scrub-deleted-<timestamp>.sql` (gitignored).

## Cross-cutting consistency

- David Luebke kept as a coherent set: proposal #51 + client 80 + email_lead 44 + quote_draft + enrollment.
- Removals only — no proposal re-pricing or payment-status recompute is triggered.
- `labratCleanup.js` continues to target `@labrat.test`; those rows are purged here regardless.

## Out of scope

- Schema changes. This is data-only.
- Application code changes (no route/component edits — the keep-set is hand-curated, one-time).
- Re-running periodically. This is a one-time pre-launch scrub; ongoing `@labrat.test` hygiene stays with `labratCleanup.js`.

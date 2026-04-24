# Full-Audit Remediation — Bucket B

**Date:** 2026-04-24
**Source:** `.claude/full-audit-2026-04-24.log`
**Scope:** All 15 BLOCKERs + ~20 high-value WARNINGs identified by the 2026-04-24 /full-audit. Architecture refactors, schema migrations on production data, and shape-validator extractions are deferred to `docs/tech-debt.md`.

## Goal

Close every fail-closed gap, every data-integrity gap, every admin-facing performance gap, and the observability gaps flagged by the audit. Leave the codebase in a state where the next /full-audit surfaces substantially fewer BLOCKER/WARNING items, and where the audit log serves as a living ledger of what was fixed vs. deferred.

## Non-Goals

- Schema migrations that change column types on production-populated tables (`shifts.positions_needed` TEXT→JSONB).
- Cross-cutting refactors (pricing_snapshot shape validator across 6 consumers, proposal-creation workflow consolidation, PotionPlanningLab state-controller split).
- Codex P2 architecture items (drink-plan extras pricing service, ClientAuthContext via utils/api.js, App.js route manifest dedup, true schedulers-to-worker-process separation).
- New feature work.

All deferred items ship in `docs/tech-debt.md` with enough context to be re-opened as standalone specs.

## Design

### Execution in 5 phases, ~15-18 commits total

Each phase is a cluster of related fixes. Commits group by logical feature, not by item — per CLAUDE.md Rule 3. User controls push cadence (Rule 4); no auto-pushes.

**Phase 1 — Security fail-closed (6 fixes, ~5 commits)**

1. `server/routes/emailMarketingWebhook.js:16-29` — reject with 401 when `RESEND_WEBHOOK_SECRET` is missing in production. Mirror the `thumbtack.js:31-38` fail-closed pattern. Capture a Sentry warning on every invalid-signature request.
2. `server/utils/encryption.js:7-14` — throw from `encrypt()`/`decrypt()` when `ENCRYPTION_KEY` is missing or invalid and `NODE_ENV === 'production'`. Retain the dev fallback but log a warning.
3. `server/routes/stripe.js:330-357` — remove `req.query.token` from the payment-link success-URL construction. Look up the proposal's actual token server-side via a new `SELECT token FROM proposals WHERE id = $1` before redirect URL assembly.
4. `server/routes/emailMarketing.js:808-831` — wrap `/unsubscribe` in `asyncHandler`. Split the catch at line 828: JWT-expired → 400 "Invalid or expired"; DB error → re-throw to the global handler (which logs to Sentry and returns 500).
5. `server/routes/admin.js:358-373` — refactor `statusClause` interpolation into a parameterized predicate. Branch on `archived === 'true'` selects between two fixed WHERE fragments, each with its own parameter placeholder.
6. `server/index.js:216-217` — wrap scheduler kickoffs in `if (process.env.RUN_SCHEDULERS !== 'false')`. Default remains ON (current Render single-instance behavior unchanged). Multi-instance deploys opt out of duplicate work by setting `RUN_SCHEDULERS=false` on extra instances. Document in `.env.example`.

**Phase 2 — Auth & input hardening (8 fixes, ~6 commits)**

7. `server/index.js:84-96` — tighten CORS `!origin` pass-through. `/api/health` (confirmed at line 165) is the only path that should accept origin-less requests. Return 403 for all other paths when `!origin` — Render's health probe is unaffected; any legitimate server-to-server caller must set an Origin header going forward.
8. JWT token invalidation on password reset:
   - Schema: `ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;` in `schema.sql`.
   - `server/routes/auth.js` — include `token_version` in the signed payload on login/register. On password reset, increment `users.token_version` in the same transaction as the password update.
   - `server/middleware/auth.js` — re-read `token_version` from the DB on verify; reject if the JWT's version is less than the DB value. (Adds one DB round-trip per authenticated request — acceptable for safety; can cache via `pool` later.)
9. Separate unsubscribe secret: add `UNSUBSCRIBE_SECRET` optional env var. If set, sign/verify unsubscribe JWTs with it. If unset, fall back to `JWT_SECRET` (graceful rollout — existing in-flight links keep working). Add to `.env.example`.
10. `server/routes/proposals.js:896-924` — validate `total_price_override` bounds on PATCH: reject if `< 0` or `>= 1_000_000`, return 400 via `ValidationError`.
11. `server/routes/proposals.js:972-988` — define a state-machine map at the top of the file: `'draft' → ['sent']`, `'sent' → ['viewed', 'accepted']`, `'viewed' → ['accepted']`, `'accepted' → ['deposit_paid']`, `'deposit_paid' → ['balance_paid']`, etc. PATCH /:id/status validates the transition against this map. Admin-override path (`?force=true` query param, only honored for admin role) bypasses the map but still writes an activity-log note.
12. `server/routes/blog.js:29` — in the image proxy:
    - Check `Content-Length` of the R2 response; reject > 10 MB.
    - Verify response `Content-Type` starts with `image/` and is one of the types from `fileValidation.js`.
13. Admin HTML sanitization server-side: DOMPurify the `html_body` param in `server/routes/emailMarketing.js:279` and `:348` (both INSERT and UPDATE) before persisting. Uses the same `BLOG_SANITIZE_OPTIONS` pattern already in `blog.js`. Client-side sanitization on display remains for defense-in-depth.
14. `server/index.js:109` — set `express.json({ limit: '1mb' })` globally. Confirm no legitimate >1MB JSON body exists (webhook endpoints already use `express.raw`). File uploads use `express-fileupload` separately.
15. `.gitignore` — add `.env.*`, `*.key`, `*.pem`. `package.json` root — pin security-critical packages to exact versions: `bcryptjs`, `stripe`, `jsonwebtoken`, `pg`, `dompurify`, `jsdom`, `helmet`, `express`.

**Phase 3 — Error handling & observability (4 fixes, ~3 commits)**

16. Scheduler hygiene:
    - `server/utils/balanceScheduler.js:9-11` — when `!stripe`, call `Sentry.captureMessage('Autopay disabled — no Stripe client', 'warning')` once per cycle, then return.
    - `server/utils/balanceScheduler.js:50-56` — on autopay Stripe error, send admin notification email in addition to the existing `autopay_failed` activity-log row.
    - `server/utils/balanceScheduler.js:68-92` — wrap per-iteration DB writes in try/catch so one proposal's failure doesn't abort the whole batch.
    - `server/utils/emailSequenceScheduler.js:136` — replace `.catch(() => {})` with `.catch(err => Sentry.captureException(err, { tags: { scheduler: 'emailSequence' } }))`.
    - `server/routes/drinkPlans.js:349-352` — wrap `await client.query('ROLLBACK')` in its own try/catch.
17. Webhook signature-failure observability — `Sentry.captureMessage` with severity `warning` on every invalid-signature request in `emailMarketingWebhook.js:46`, `thumbtack.js:56`, and `stripe.js:525`. Tag with `webhook: <provider>`, `reason: 'invalid_signature'`.
18. Add `RETURNING *` (or an explicit column allowlist on the `proposals` path to avoid shipping sensitive fields) to the four mutations:
    - `server/routes/proposals.js:906-924` (admin PATCH)
    - `server/routes/proposals.js:127-133` (client signature)
    - `server/routes/shifts.js:377-393` (shift UPDATE)
    - `server/routes/drinkPlans.js:105-122` (drink-plan UPDATE from public submit)
    Scope for this item is backend-only: add `RETURNING *` to each UPDATE and have the handler respond with the returned row. Do NOT refactor the frontend callers in this phase — client-side double-fetch elimination is a follow-up optimization and not in scope for bucket B.
19. `stripe_sessions` idempotency: add a migration to `schema.sql` — `CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_sessions_payment_link ON stripe_sessions(stripe_payment_link_id) WHERE stripe_payment_link_id IS NOT NULL;`. Add a SELECT path in `stripe.js` that checks for an existing payment-link row before creating a new one.

**Phase 4 — Performance (8 fixes, ~5 commits)**

20. Explicit column allowlists on list endpoints (replaces `SELECT *` / `SELECT p.*`):
    - `server/routes/proposals.js:685-716` — exclude `pricing_snapshot`, `admin_notes`, `adjustments`, `questionnaire_data`, `stripe_customer_id`, `stripe_payment_method_id`, `client_signature_data` from the admin list. Detail endpoint keeps the blob.
    - `server/routes/drinkPlans.js:365-387 / 518-527 / 444-453` — exclude `selections` and `shopping_list` from list endpoints. Detail keeps `selections`. `shopping_list` remains on the dedicated `/shopping-list` endpoint only.
    - `server/routes/emailMarketing.js:241-263` (campaigns list) — exclude `html_body`, `text_body`, `html_draft`.
    - `server/routes/emailMarketing.js:292` (campaign detail) — keep `html_body` on the main detail, but limit the `sends` array at 306-312 to `LIMIT 500 ORDER BY created_at DESC`.
    - `server/routes/emailMarketing.js:517-523` (campaign steps) — return only `id, step_order, subject, delay_hours` on list; load `html_body` on step edit.
    - `server/routes/emailMarketing.js:677-685` (campaign enrollments) — `LIMIT 500 ORDER BY created_at DESC`.
    - `server/routes/emailMarketing.js:742-750` (conversations) — exclude `body_html` from the initial load; add a `/conversations/:id/message/:msgId` endpoint for lazy body fetch.
    - `server/routes/shifts.js:36-74` — paginate admin `GET /shifts`, `LIMIT 100 OFFSET ?`.
    - `server/routes/clients.js:49-62` — allowlist on `clients.*` and the joined `proposals.*`; exclude `pricing_snapshot`.
21. Bulk INSERT / batch mutations:
    - `server/routes/admin.js:696-720` — geocode backfill: keep the 1.1s Nominatim throttle, but collect successes into an array and issue a single bulk UPDATE using `unnest()` CTE after the fetch phase completes. Separate commits for `contractor_profiles` and `shifts`.
    - `server/routes/admin.js:800-849` — blog import: `Promise.all` the image uploads (unbounded — blog imports are rare and small); multi-row VALUES INSERT for `blog_posts`.
    - `server/routes/emailMarketing.js:649-670` — campaign enrollment: `INSERT INTO email_sequence_enrollments (campaign_id, lead_id, next_step_due_at) SELECT $1, id, NOW() FROM email_leads WHERE id = ANY($2) ON CONFLICT (campaign_id, lead_id) DO NOTHING`.
    - `server/routes/messages.js:81-126` — SMS blast: keep sequential Twilio sends (carrier throttle); collect `sms_messages` rows during the loop; single multi-row INSERT after.
    - `server/routes/proposals.js:487-492 / 799-803 / 928-933` — addon INSERT loops: multi-row VALUES INSERT.
    - `server/routes/drinkPlans.js:208-227` — addon UPSERT loop: multi-row INSERT ... ON CONFLICT.
22. Promise.all sweep on sequential-independent awaits:
    - `server/routes/emailMarketing.js:291-330` (campaign detail)
    - `server/routes/emailMarketing.js:191-207` (lead detail)
    - `server/routes/shifts.js:184-214` (shift detail)
    - `server/routes/clients.js:49-62` (client detail)
    - `server/routes/stripe.js:803-833` (payment_intent.payment_failed — 3 independent writes)
23. `server/utils/autoAssign.js:297-323` — replace per-candidate `UPDATE shift_requests` with single `UPDATE shift_requests SET status='approved' WHERE id = ANY($1)`.
24. `server/utils/balanceScheduler.js:27-57` — bounded `Promise.all` on Stripe `paymentIntents.create` with concurrency 5.
25. `client/src/pages/plan/PotionPlanningLab.js:9-27` — convert all 18 step imports except `WelcomeStep` to `React.lazy(() => import('./steps/...'))`. Wrap the step-render switch in `<Suspense fallback={...}>` with an existing spinner component.
26. `server/routes/blog.js:56-70` — add `Cache-Control: public, max-age=300, s-maxage=600` to the public `/:slug` response.
27. Remaining unpaginated endpoints — add `LIMIT 500` to `server/routes/shifts.js:117-127`, `:505-516`, `:87-101`, and `server/routes/admin.js:414-424`.

**Phase 5 — Docs & backlog (3 items, ~2 commits)**

28. Folder-tree refresh across `CLAUDE.md`, `README.md`, `ARCHITECTURE.md` — add `client/src/pages/staff/` (6 files), `HiringLanding.js`, `admin/ShiftDetail.js`, `public/ClientShoppingList.js`, `components/AdminBreadcrumbs.js`, `components/StaffLayout.js`.
29. Annotate `.claude/full-audit-2026-04-24.log` — inline `→ FIXED in <commit-sha>` on each remediated item. Deferred items stay unmarked.
30. Write `docs/tech-debt.md` from the deferred list. Structure per item: `## <short title>`, `**Source:** full-audit-2026-04-24.log, item <N>`, `**What:** <one paragraph>`, `**Why deferred:** <schema-risk / architecture / low-value>`, `**Next step:** <brainstorm / migration script / etc.>`. Then schedule a 60-day follow-up `/full-audit` via the `/schedule` skill.

### Verification

- Backend-only phases (1, 3, most of 2, most of 4): TypeScript/ESLint passes + `npm test` if a test suite exists for the touched files + manual hit of affected endpoints via curl from `npm run dev`.
- UI-touching items (PotionPlanningLab lazy-load; any frontend consumer that changes because of RETURNING): `npm run dev` and manually exercise the happy path in-browser.
- Schema changes (`users.token_version`, `stripe_sessions` unique index): idempotent via `IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`. Confirmed safe on restart.

### Risk notes

- **JWT token_version** adds a DB round-trip on every authenticated request. Acceptable for safety; consider caching via Redis/in-memory LRU in a follow-up if profiling shows impact.
- **UNSUBSCRIBE_SECRET fallback** means existing unsubscribe links (signed with JWT_SECRET) keep working until they expire. If the user wants a hard cutover, add a one-time flag.
- **Proposal status state machine** may reject transitions that some admin user was silently relying on. The `?force=true` admin-override escape hatch covers this.
- **express.json 1mb** — confirm blog post body size fits. TipTap posts with inlined images can approach 1MB. If blog save breaks after the change, raise the blog-admin route limit specifically.
- **CORS tightening** — health-check endpoints need to remain unauthenticated/origin-less. Render's health probe and any uptime pinger must still pass.
- **Batch UPSERT on campaign enrollment** — `ON CONFLICT (campaign_id, lead_id)` requires the unique index to exist. Confirmed at `server/db/schema.sql:1176` (`UNIQUE(campaign_id, lead_id)` on `email_sequence_enrollments`).

## Commit & push cadence

- One commit per logical cluster (~15-18 commits total).
- I do NOT auto-push. Per CLAUDE.md Rule 4, pushes are user-initiated. After each phase I stand down silently; the user controls whether to push per-phase or batch the whole run.
- Pre-push agents run at the user's cue. I will NOT pre-run agents at phase completion or as a "let me verify" step — that violates Rule 6.

## Preservation

- `.claude/full-audit-2026-04-24.log` becomes a living ledger: FIXED annotations inline, deferred items unmarked.
- `docs/tech-debt.md` captures everything deferred with enough context to re-spec.
- `/schedule` a 60-day re-audit at the end of Phase 5.

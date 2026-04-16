# Wave Coordination — Error Handling × Remove Event Title

**Purpose:** Coordinate two concurrent Claude windows executing two implementation plans against the same repo on `main`. Maximize parallelism while avoiding file conflicts.

**Plans:**
- **Window A** — `docs/superpowers/plans/2026-04-16-error-handling.md` (32 tasks across 6 phases)
- **Window B** — `docs/superpowers/plans/2026-04-16-remove-event-title.md` (15 tasks)

**Both windows execute via the `superpowers:subagent-driven-development` skill** — one subagent per task within each window, sequential within a window, parallel across windows.

---

## Conflict Analysis

Files modified by **both** plans (require sequencing):

**Backend routes:** `proposals.js`, `shifts.js`, `drinkPlans.js`, `calendar.js`, `clientPortal.js`, `invoices.js`, `messages.js`, `stripe.js`

**Frontend pages:** `admin/ProposalCreate.js`, `admin/ProposalDetail.js`, `admin/EventsDashboard.js`, `admin/ClientDetail.js`, `admin/DrinkPlansDashboard.js`, `admin/DrinkPlanDetail.js`, `public/ClientDashboard.js`, `proposal/ProposalView.js`, `invoice/InvoicePage.js`, `website/ClassWizard.js`

**Other:** `client/src/index.css` (different sections — both append, safe in either order), `.claude/CLAUDE.md`, `README.md`, `ARCHITECTURE.md`

**Resolution:** non-overlapping work runs in parallel waves. Window A handles all shared-file work after Window B's plan is complete, so the error-handling sweep edits the post-event-title-cleanup version of each file (no merge conflicts).

---

## Wave 1 — Foundation (full parallel, zero file overlap)

### Window A
**Tasks:** error-handling Tasks **1–13** (Phase 1 backend foundation + Phase 2 frontend foundation)

**Files touched:**
- New: `server/utils/errors.js`, `server/middleware/asyncHandler.js`, `client/src/components/Toast.js`, `client/src/components/FormBanner.js`, `client/src/components/FieldError.js`, `client/src/components/SessionExpiryHandler.js`, `client/src/context/ToastContext.js`
- Modified: `server/index.js`, `client/src/index.js`, `client/src/App.js`, `client/src/utils/api.js`, `client/src/components/ErrorBoundary.js`, `client/src/index.css` (toast, form-banner, field-error, error-boundary-fallback sections only)
- Other: `package.json`, `client/package.json`, `.env.example`

### Window B
**Tasks:** event-title Tasks **1–4** (helpers + schema + seed + utils)

**Files touched:**
- New: `client/src/utils/eventTypes.js`, `server/utils/eventTypes.js`
- Modified: `client/src/data/eventTypes.js`, `server/db/schema.sql`, `server/db/seedTestData.js`, `server/utils/emailTemplates.js`, `server/utils/eventCreation.js`, `server/utils/autoAssign.js`, `server/utils/autoAssignScheduler.js`, `server/utils/balanceScheduler.js`

### Sync point 1
Both windows confirm `npm run dev` boots cleanly and report `Wave 1 done`. No push.

---

## Wave 2 — Window B finishes; Window A does non-shared sweep (full parallel, zero file overlap)

### Window A
**Tasks:** error-handling Tasks **14, 15, 19, 23, 25, 27, 28** (non-shared sweep)

**Files touched:**
- Backend routes: `auth.js`, `clientAuth.js`, `application.js`, `agreement.js`, `contractor.js`, `progress.js`, `admin.js`, `cocktails.js`, `mocktails.js`, `emailMarketing.js`, `blog.js` (public + admin endpoints)
- Frontend pages: `Login.js`, `Register.js`, `ForgotPassword.js`, `ResetPassword.js`, `Application.js`, `ApplicationStatus.js`, `Agreement.js`, `ContractorProfile.js`, `PaydayProtocols.js`, `Welcome.js`, `FieldGuide.js`, `Completion.js`, `AdminDashboard.js`, `admin/Dashboard.js`, `StaffPortal.js`, `admin/SettingsDashboard.js`, `admin/HiringDashboard.js`, `AdminApplicationDetail.js`, `AdminUserDetail.js`, `admin/CocktailMenuDashboard.js`, all 8 email-marketing admin pages (`admin/EmailMarketingDashboard.js`, `EmailLeadsDashboard.js`, `EmailLeadDetail.js`, `EmailCampaignsDashboard.js`, `EmailCampaignCreate.js`, `EmailCampaignDetail.js`, `EmailAnalyticsDashboard.js`, `EmailConversations.js`), `admin/BlogDashboard.js`, `Blog.js` (public), `BlogPost.js` (public)

### Window B
**Tasks:** event-title Tasks **5–14** (routes + frontend + ClassWizard + ShoppingList + docs)

**Files touched:**
- Backend routes: `proposals.js`, `shifts.js`, `drinkPlans.js`, `calendar.js`, `clientPortal.js`, `invoices.js`, `messages.js`, `stripe.js`
- Admin pages: `admin/ProposalCreate.js`, `admin/ProposalDetail.js`, `admin/EventsDashboard.js`, `admin/ShiftDetail.js`, `admin/ClientDetail.js`, `admin/DrinkPlansDashboard.js`, `admin/DrinkPlanDetail.js`
- Public/client pages: `public/ClientDashboard.js`, `proposal/ProposalView.js`, `invoice/InvoicePage.js`, `plan/steps/WelcomeStep.js`, `website/ClassWizard.js`
- Components: `ShoppingList/ShoppingListPDF.jsx`, `ShoppingList/ShoppingListModal.jsx`, `ShoppingList/ShoppingListButton.jsx`
- Other: `client/src/index.css` (`.event-subtitle` section only — append at end; will not collide with Window A's Wave 1 additions), `.claude/CLAUDE.md`, `README.md`, `ARCHITECTURE.md` (event-title doc updates)

**IMPORTANT — Window B must STOP before Task 15's push step.** The final push happens at Wave 4 after Window A finishes its sweep. Run Task 15's verification steps (smoke tests + review agents) only if you want; otherwise leave verification to Wave 4.

### Sync point 2
Both report `Wave 2 done`. Both confirm clean state.

---

## Wave 3 — Window A solo on shared files (Window B idle or assists)

Window B's plan is complete. Window A applies the error-handling pattern to files Window B just finalized — no merge conflicts because Window B's edits are already committed.

**Tasks:** error-handling Tasks **16, 17, 18, 20, 21, 22, 24, 26, 29, 30**

**Files touched (all already touched by Window B in Wave 2):**
- Backend routes: `clientPortal.js`, `publicReviews.js`, `drinkPlans.js`, `proposals.js`, `invoices.js`, `stripe.js`, `clients.js`, `payment.js`, `calendar.js`, `shifts.js`, `messages.js`, `emailMarketingWebhook.js`, `thumbtack.js`
- Frontend pages: `public/ClientDashboard.js`, `HomePage.js`, `QuoteWizard.js`, `QuotePage.js`, `ClassWizard.js`, `FaqPage.js`, `PotionPlanningLab.js`, `proposal/ProposalView.js`, `invoice/InvoicePage.js`, `admin/ClientsDashboard.js`, `admin/ClientDetail.js`, `admin/ProposalsDashboard.js`, `admin/ProposalCreate.js`, `admin/ProposalDetail.js`, `admin/EventsDashboard.js`, `admin/DrinkPlansDashboard.js`, `admin/DrinkPlanDetail.js`, `admin/FinancialsDashboard.js`

**Optional parallelism:** Window B may take Tasks **22 (events + calendar + shifts)** and **24 (drink plans admin)** — Window B has the freshest mental model of those files since they were just edited. Coordinate with Window A before claiming a task to avoid double-edits.

### Sync point 3
Window A (and Window B if helping) report `Wave 3 done`.

---

## Wave 4 — Final docs + verification + push (Window A drives)

### Step 1 — Sweep up uncommitted prior work
Before pushing, decide what to do with these uncommitted modifications already in the working tree (the clear-reaction-addon-cleanup work from earlier today):
- `.claude/settings.local.json`
- `client/src/data/addonCategories.js`
- `client/src/pages/admin/ProposalCreate.js`
- `client/src/pages/admin/ProposalDetail.js`
- `server/db/schema.sql`
- `server/routes/proposals.js`
- `server/utils/pricingEngine.js`

Plus the untracked spec `docs/superpowers/specs/2026-04-16-clear-reaction-addon-cleanup-design.md`.

If these are finished work, commit them in their own commits BEFORE the final push. If they're WIP, hold them out of the push.

### Step 2 — Window A: error-handling docs
Task **31** — append error-handling sections to `.claude/CLAUDE.md`, `README.md`, `ARCHITECTURE.md`. Window B's event-title doc edits are already committed, so Window A appends on top.

### Step 3 — Pre-push review agents
Per `.claude/CLAUDE.md` Pre-Push Procedure: launch all 5 non-UI agents in parallel from a single message — `consistency-check`, `code-review`, `security-review`, `database-review`, `performance-review`. Address any flagged issues before pushing.

### Step 4 — Final smoke tests
Manual end-to-end smoke per the verification sections of both plans. Confirm:
- Field-level errors appear (e.g., duplicate-email register).
- FormBanner auto-scrolls into view above submit.
- Toast appears on success and on session expiry.
- Event-title display: client name + event-type label everywhere; `'event'` fallback works.
- ICS calendar `SUMMARY` reads "Client — Event Type Label".
- Stripe PaymentIntent description includes the event type label.
- Sentry receives a forced 500 (if DSN set in env).

### Step 5 — Push
```bash
git push origin main
```

This single push ships everything that has accumulated since the last push to `origin/main`:
- Today's prior commits (clickable-row, design specs).
- Wave 1–3 commits from both windows.
- Wave 4 doc + sweep-up commits.

Confirm Render + Vercel begin deploying.

---

## Coordination Protocol

1. Both windows acknowledge this wave plan.
2. Both kick off Wave 1 simultaneously using the `superpowers:subagent-driven-development` skill (one subagent per task, sequential within window).
3. Each window reports `Wave N done` to the user when its assigned tasks for that wave are complete and committed.
4. User signals `proceed to Wave N+1` only after both have reported done.
5. **Only one `npm run dev` runs at a time.** Subagents should skip explicit "start dev server" steps in their per-task verification — assume it's running. Manual UI verification deferred to sync points.
6. **No pushes until Wave 4.** Window B explicitly skips Task 15's push step.
7. If a subagent encounters an unexpected file conflict (e.g., `git status` shows a file modified outside its task scope), pause and report — don't try to merge.

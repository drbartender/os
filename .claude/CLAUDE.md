# Dr. Bartender — Claude Code Instructions

## Tech Stack

- **Backend**: Node.js 18+ / Express 4.18
- **Frontend**: React 18 (Create React App) / React Router 6
- **Database**: Neon PostgreSQL (via `pg` driver, raw SQL — no ORM)
- **Auth**: JWT (jsonwebtoken) + bcryptjs
- **File Storage**: Cloudflare R2 (AWS SDK v3)
- **Payments**: Stripe (server SDK + React Elements)
- **Email**: Resend
- **SMS**: Twilio
- **Rich Text Editor**: TipTap (ProseMirror-based WYSIWYG) for blog admin
- **HTML Sanitization**: DOMPurify + jsdom (server-side, for blog post bodies)
- **Styling**: Vanilla CSS (no Tailwind, no preprocessors)
- **Error Tracking**: `@sentry/node` (server error tracking), `@sentry/react` (client error tracking)
- **Dev tools**: nodemon, concurrently, ESLint + eslint-plugin-security, husky + lint-staged

## Folder Structure

```
dr-bartender/
├── server/
│   ├── index.js              # Express entry point, middleware, route mounting
│   ├── data/
│   │   └── contractorAgreement.js # Versioned v2 legal text (clauses, acknowledgments, effective date)
│   ├── db/
│   │   ├── index.js          # PostgreSQL pool + schema init
│   │   ├── schema.sql        # Full DDL (tables, triggers, seed data)
│   │   ├── seed.js           # Admin account seeder
│   │   └── seedTestData.js   # Test data seeder (staff, clients, proposals)
│   ├── middleware/
│   │   ├── asyncHandler.js  # 3-line wrapper that funnels async-handler rejections to the global error middleware
│   │   └── auth.js           # JWT verification, role guards
│   ├── routes/
│   │   ├── admin.js           # Admin management endpoints
│   │   ├── agreement.js       # Staff agreement/contract signing
│   │   ├── application.js     # Staff application submission
│   │   ├── auth.js            # Login, register, JWT refresh
│   │   ├── blog.js            # Blog post endpoints
│   │   ├── calendar.js        # Calendar/scheduling endpoints
│   │   ├── clientAuth.js      # Client authentication (separate from staff auth)
│   │   ├── clientPortal.js    # Client portal endpoints
│   │   ├── clients.js         # Client CRM endpoints
│   │   ├── cocktails.js       # Cocktail menu management
│   │   ├── contractor.js      # Contractor profile endpoints
│   │   ├── drinkPlans.js      # Public drink plan (Potion Planning Lab)
│   │   ├── messages.js        # SMS messaging to staff
│   │   ├── mocktails.js       # Mocktail menu management
│   │   ├── payment.js         # Payment tracking
│   │   ├── progress.js        # Onboarding progress tracking
│   │   ├── proposals.js       # Proposal CRUD + public token view
│   │   ├── shifts.js          # Shift management
│   │   ├── stripe.js          # Stripe checkout + webhooks
│   │   ├── emailMarketing.js  # Email marketing (leads, campaigns, sequences, conversations)
│   │   ├── emailMarketingWebhook.js # Resend webhook receiver (tracking events)
│   │   ├── publicReviews.js   # Public cached endpoint for Thumbtack reviews (homepage)
│   │   ├── invoices.js        # Invoice CRUD, public token view, client portal
│   │   ├── testFeedback.js    # Receives tester bug/checklist submissions from /testing-guide.html and emails contact@drbartender.com
│   │   └── thumbtack.js       # Thumbtack webhook endpoints (leads, messages, reviews)
│   ├── utils/
│   │   ├── agreementPdf.js    # PDFKit renderer for signed contractor agreements
│   │   ├── autoAssign.js      # Auto-assign algorithm (seniority + geo + equipment)
│   │   ├── autoAssignScheduler.js # Scheduled auto-assign runner (hourly)
│   │   ├── balanceScheduler.js # Scheduled balance/payment tasks
│   │   ├── email.js           # Resend wrapper (send + batch)
│   │   ├── emailSequenceScheduler.js # Drip sequence step processor (every 15 min)
│   │   ├── emailTemplates.js  # Email template helpers (transactional + marketing)
│   │   ├── encryption.js      # AES-256-GCM wrapper for bank PII at rest (fails closed in prod)
│   │   ├── errors.js          # AppError class hierarchy (ValidationError, ConflictError, NotFoundError, PermissionError, ExternalServiceError, PaymentError)
│   │   ├── eventCreation.js   # Event creation helpers
│   │   ├── eventTypes.js      # Event type id→label resolver (mirrors client)
│   │   ├── fileValidation.js  # Magic-byte validation
│   │   ├── geocode.js         # Nominatim geocoding (address → lat/lng)
│   │   ├── invoiceHelpers.js   # Invoice auto-generation, line items, locking
│   │   ├── phone.js           # Save-time phone validation (10 digits, strips country code 1)
│   │   ├── pricingEngine.js   # Pure pricing calculation functions
│   │   ├── shoppingList.js    # Shopping-list generator (mirrors client/src/components/ShoppingList/generateShoppingList.js)
│   │   ├── sms.js             # Twilio wrapper
│   │   ├── storage.js         # R2 upload/signed-URL helpers
│   │   ├── stripeClient.js    # Central Stripe client factory (test-mode toggle, fail-closed)
│   │   └── urls.js            # Canonical PUBLIC_SITE_URL / ADMIN_URL / API_URL resolvers
│   └── scripts/
│       ├── importBlogPosts.js     # Blog post import script (legacy)
│       ├── migrateBlogBodies.js  # One-time: convert blog blocks → HTML
│       └── migrate-to-gcs.js    # Storage migration script
├── client/
│   ├── src/
│   │   ├── App.js            # All routes + auth guards
│   │   ├── context/
│   │   │   ├── AuthContext.js      # Staff/admin auth state
│   │   │   ├── ClientAuthContext.js # Client auth state
│   │   │   ├── ToastContext.js     # ToastProvider + useToast() hook
│   │   │   └── UserPrefsContext.js # Per-user admin OS prefs (skin/density/sidebar) — strips on logout
│   │   ├── utils/
│   │   │   ├── api.js             # Axios instance with JWT interceptor
│   │   │   ├── constants.js       # App-wide constants
│   │   │   ├── eventTypes.js      # Event type id→label resolver (mirrors server)
│   │   │   ├── formatCurrency.js  # $ formatting with consistent precision
│   │   │   ├── formatPhone.js     # Phone number formatting
│   │   │   ├── leadSources.js     # Single source of truth for email lead source enum (mirrors schema + server validator)
│   │   │   └── timeOptions.js     # Time option generator + 12h formatter + input parser (TimePicker)
│   │   ├── components/
│   │   │   ├── AdminLayout.js     # Admin sidebar + header layout
│   │   │   ├── BrandLogo.js       # Dr. Bartender logo component
│   │   │   ├── ConfirmModal.js    # Confirmation dialog component
│   │   │   ├── DrinkPlanSelections.js # Drink plan selection display
│   │   │   ├── ErrorBoundary.js   # React error boundary
│   │   │   ├── FieldError.js  # Inline red text under an input
│   │   │   ├── FileUpload.js      # Drag-and-drop file upload
│   │   │   ├── FormBanner.js  # Error banner above submit button (auto-scrolls into view)
│   │   │   ├── Layout.js          # Staff-facing layout wrapper
│   │   │   ├── LocationInput.js   # Nominatim address autocomplete
│   │   │   ├── NumberStepper.js   # Numeric input with TimePicker-style ▲/▼ steppers (used for hours)
│   │   │   ├── PricingBreakdown.js # Proposal pricing display
│   │   │   ├── PublicLayout.js    # Public-facing layout wrapper
│   │   │   ├── RichTextEditor.js  # TipTap WYSIWYG editor (blog + email marketing)
│   │   │   ├── InvoiceDropdown.js # Invoice list dropdown (admin + client)
│   │   │   ├── ScrollToTop.js     # Router-level scroll reset on pathname change (skips hash nav)
│   │   │   ├── SessionExpiryHandler.js  # Listens for session-expired event, shows toast, redirects
│   │   │   ├── SignaturePad.js    # E-signature canvas
│   │   │   ├── StaffLayout.js     # Staff-facing layout wrapper (sidebar nav for staff.drbartender.com)
│   │   │   ├── Toast.js  # Toast container (top-right, dismissible, auto-fade)
│   │   │   ├── W9Form.js         # W-9 tax form component
│   │   │   ├── LeadImportModal.js # CSV lead import modal
│   │   │   ├── MenuSamplesModal.js # Sample menu designs lightbox (Potion Planning Lab)
│   │   │   ├── AudienceSelector.js # Campaign audience filter/selector
│   │   │   ├── SequenceStepEditor.js # Drip sequence step editor
│   │   │   ├── CampaignMetricsBar.js # Campaign performance metrics bar
│   │   │   ├── SyrupPicker.js    # Syrup add-on selection component
│   │   │   ├── TimePicker.js     # Unified time input (type, 30-min arrows, dropdown)
│   │   │   ├── adminos/          # Admin OS shell + primitives (scoped to [data-app="admin-os"])
│   │   │   │   ├── AreaChart.js       # SVG area chart (Dashboard revenue series)
│   │   │   │   ├── CommandPalette.js  # ⌘K palette — search + jump to admin pages
│   │   │   │   ├── Drawer.js          # Right-slide peek panel — body-scroll-locked, Esc-closable
│   │   │   │   ├── format.js          # fmt$, fmtDate, relDay, dayDiff helpers
│   │   │   │   ├── Header.js          # Top bar — search trigger, quick-add, account menu
│   │   │   │   ├── Icon.js            # Inline SVG icon set
│   │   │   │   ├── KebabMenu.js       # Portal-anchored 3-dots-vertical row action menu
│   │   │   │   ├── nav.js             # Sidebar nav config (label, route, icon)
│   │   │   │   ├── shifts.js          # Shared shiftPositions / parsePositionsCount / approvedCount / eventStatusChip
│   │   │   │   ├── Sidebar.js         # Left rail — collapsible, badge counts
│   │   │   │   ├── Sparkline.js       # Tiny SVG sparkline (per-row mini chart)
│   │   │   │   ├── StaffPills.js      # Compact filled/pending/open position pills
│   │   │   │   ├── StatusChip.js      # Standardized chip with kind + dot
│   │   │   │   ├── Toolbar.js         # Toolbar wrapper (search + tabs + filters)
│   │   │   │   └── drawers/           # Per-entity peek bodies
│   │   │   │       ├── ClientDrawer.js
│   │   │   │       ├── EventDrawer.js
│   │   │   │       ├── InvoicesDrawer.js   # Read-only invoice list for a proposal (link → public invoice page)
│   │   │   │       ├── ProposalDrawer.js
│   │   │   │       └── ShiftDrawer.js
│   │   │   └── ShoppingList/     # Shopping list generator
│   │   │       ├── ShoppingListButton.jsx
│   │   │       ├── ShoppingListModal.jsx
│   │   │       ├── ShoppingListPDF.jsx
│   │   │       ├── generateShoppingList.js
│   │   │       ├── logoBase64.js
│   │   │       └── shoppingListPars.js
│   │   ├── data/
│   │   │   ├── addonCategories.js # Add-on category definitions
│   │   │   ├── eventTypes.js      # Event type definitions
│   │   │   ├── menuSamples.js     # Curated menu design samples (Menu Design step popup)
│   │   │   ├── packages.js        # Service package definitions
│   │   │   └── syrups.js          # Syrup product definitions
│   │   ├── hooks/
│   │   │   ├── useDebounce.js     # Debounced callback helper
│   │   │   ├── useDrawerParam.js  # URL-synced drawer state (?drawer=event&drawerId=123)
│   │   │   ├── useFormValidation.js # Form validation hook
│   │   │   └── useWizardHistory.js # Wizard step ↔ browser history sync
│   │   ├── pages/
│   │   │   ├── Login.js, Register.js, ForgotPassword.js, ResetPassword.js
│   │   │   ├── Welcome.js, FieldGuide.js, Agreement.js
│   │   │   ├── ContractorProfile.js, PaydayProtocols.js, Completion.js
│   │   │   ├── Application.js, ApplicationStatus.js
│   │   │   ├── AdminDashboard.js, AdminApplicationDetail.js, AdminUserDetail.js
│   │   │   ├── HiringLanding.js           # Public hiring site (hiring.drbartender.com)
│   │   │   ├── admin/
│   │   │   │   ├── BlogDashboard.js
│   │   │   │   ├── ClientDetail.js
│   │   │   │   ├── ClientsDashboard.js
│   │   │   │   ├── CocktailMenuDashboard.js
│   │   │   │   ├── Dashboard.js
│   │   │   │   ├── DrinkPlanDetail.js
│   │   │   │   ├── DrinkPlansDashboard.js
│   │   │   │   ├── EventDetailPage.js               # Per-event admin page (proposal join + every shift on the event)
│   │   │   │   ├── EventsDashboard.js
│   │   │   │   ├── FinancialsDashboard.js
│   │   │   │   ├── HiringDashboard.js
│   │   │   │   ├── ProposalCreate.js
│   │   │   │   ├── ProposalDetail.js              # Lean container (identity bar, two-col layout, drink plan, notes, activity)
│   │   │   │   ├── ProposalDetailEditForm.js      # Edit-mode sibling: client/event/package/addons/syrups/adjustments/override + dirty guard
│   │   │   │   ├── ProposalDetailPaymentPanel.js  # Payment sibling: invoices, balance due date, charge balance, payment link, record payment
│   │   │   │   ├── ProposalsDashboard.js
│   │   │   │   ├── SettingsDashboard.js
│   │   │   │   ├── StaffDashboard.js            # Staff list (replaces legacy AdminDashboard for /admin/staffing)
│   │   │   │   ├── EmailMarketingDashboard.js  # Email marketing hub (tabs)
│   │   │   │   ├── EmailLeadsDashboard.js      # Lead list + import
│   │   │   │   ├── EmailLeadDetail.js          # Lead profile + history
│   │   │   │   ├── EmailCampaignsDashboard.js  # Campaign list
│   │   │   │   ├── EmailCampaignCreate.js      # Campaign builder
│   │   │   │   ├── EmailCampaignDetail.js      # Campaign detail + metrics
│   │   │   │   ├── EmailAnalyticsDashboard.js  # Analytics overview
│   │   │   │   └── EmailConversations.js       # Conversation inbox
│   │   │   ├── plan/             # PotionPlanningLab (public questionnaire)
│   │   │   │   ├── PotionPlanningLab.js
│   │   │   │   ├── data/         # cocktailMenu.js, servingTypes.js, drinkUpgrades.js, packageGaps.js (hosted-package gap helpers; packageGaps.test.js is the Jest test)
│   │   │   │   └── steps/        # WelcomeStep, LogisticsStep, FullBarStep, SyrupUpsellStep, HostedGuestPrefsStep (compact guest-prefs step for hosted refinement), etc.
│   │   │   ├── invoice/
│   │   │   │   └── InvoicePage.js     # Public token-gated invoice view + payment
│   │   │   ├── proposal/         # ProposalView (public client-facing)
│   │   │   ├── public/           # Client portal pages
│   │   │   │   ├── Blog.js, BlogPost.js
│   │   │   │   ├── ClientDashboard.js
│   │   │   │   ├── ClientLogin.js
│   │   │   │   └── ClientShoppingList.js  # Client-facing read-only shopping list
│   │   │   ├── staff/            # Staff portal (staff.drbartender.com)
│   │   │   │   ├── StaffDashboard.js
│   │   │   │   ├── StaffEvents.js
│   │   │   │   ├── StaffProfile.js
│   │   │   │   ├── StaffResources.js
│   │   │   │   ├── StaffSchedule.js
│   │   │   │   └── StaffShifts.js
│   │   │   └── website/          # Public website pages
│   │   │       ├── Website.js
│   │   │       ├── HomePage.js       # Public homepage
│   │   │       ├── QuoteWizard.js    # Multi-step quote builder
│   │   │       ├── QuotePage.js      # Quote page wrapper
│   │   │       ├── FaqPage.js        # FAQ page
│   │   │       └── ClassWizard.js    # Cocktail class booking wizard
│   │   └── index.css         # Global styles
│   ├── package.json          # proxy: localhost:5000
│   └── vercel.json           # SPA rewrite for Vercel deployment
├── .claude/
│   └── agents/               # Claude Code review agents (all opus)
│       ├── security-review.md     # OWASP security audit
│       ├── code-review.md         # Code quality + error handling
│       ├── consistency-check.md   # Cross-file synchronization
│       ├── database-review.md     # Schema + query analysis
│       ├── performance-review.md  # Frontend, API, and bundle performance
│       └── ui-ux-review.md        # Playwright visual + accessibility review
├── scripts/
│   ├── build-testing-guide.js   # Builds client/public/testing-guide.html from TESTING.md
│   └── testing-guide-template.html
├── .env / .env.example
├── .husky/pre-commit         # Pre-commit hook (runs lint-staged)
├── eslint.config.mjs         # ESLint flat config + security plugin
├── package.json              # Root (server deps + scripts)
└── render.yaml               # Render blueprint
```

## Environment Variables

See `.env.example` for the full list. Key ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Token signing key |
| `UNSUBSCRIBE_SECRET` | Optional. Separate signing key for unsubscribe/marketing-link JWTs (365-day lifetime). Falls back to `JWT_SECRET` if unset. |
| `RUN_SCHEDULERS` | Set to `false` on additional web instances to prevent duplicate scheduler runs. Default (unset) runs schedulers — single-instance deploys unaffected. |
| `CLIENT_URL` | Admin/staff frontend origin (CORS + admin dashboard links in emails). In prod: `https://admin.drbartender.com` |
| `PUBLIC_SITE_URL` | Public marketing site origin used in client-facing token URLs (proposal, drink plan, invoice, shopping list). In prod: `https://drbartender.com` |
| `API_URL` | Backend origin for server-rendered email links (unsubscribe). Optional — defaults to `RENDER_EXTERNAL_URL` in prod, `localhost:5000` in dev. |
| `R2_*` | Cloudflare R2 credentials |
| `RESEND_API_KEY` | Resend email |
| `RESEND_WEBHOOK_SECRET` | Resend webhook signing secret (svix) |
| `TWILIO_*` | Twilio SMS |
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` / `STRIPE_WEBHOOK_SECRET` | Stripe live payments |
| `STRIPE_SECRET_KEY_TEST` / `STRIPE_PUBLISHABLE_KEY_TEST` / `STRIPE_WEBHOOK_SECRET_TEST` | Stripe test-mode credentials |
| `STRIPE_TEST_MODE_UNTIL` | ISO date; while in the future, all Stripe calls use `*_TEST` creds (auto-reverts to live after cutoff) |
| `STRIPE_DEPOSIT_AMOUNT` | Deposit in cents (default 10000 = $100) |
| `THUMBTACK_WEBHOOK_SECRET` | Shared secret for Thumbtack webhook auth |
| `REACT_APP_API_URL` | Client-side API base URL (set in client/.env.production) |
| `SENTRY_DSN_SERVER` | Server-side Sentry DSN (optional in dev; required in prod) |
| `REACT_APP_SENTRY_DSN_CLIENT` | Client-side Sentry DSN (optional in dev; required in prod) |

## Running Locally

```bash
npm run install:all   # Install server + client deps
cp .env.example .env  # Fill in DATABASE_URL (Neon connection string) + other values
npm run seed          # Seed admin account
npm run dev           # Express on :5000, React on :3000
```

## Deployment

- **Backend**: Render (auto-deploys from `main` via render.yaml)
- **Frontend**: Vercel (SPA rewrite in client/vercel.json)
- **Database**: Neon PostgreSQL (connection string in Render env vars)
- Push to `main` triggers automatic deployment. No manual deploy step needed.

## Git Workflow

Solo developer, trunk-based, vibe-coded. Code preservation is the #1 priority. Push to `main` = deploy to production via Render + Vercel.

### Twelve Core Rules

1. **Trunk-only by default.** All work on `main`. Claude confirms branch at session start; if not on `main`, stops and asks — never auto-switches.
2. **Code preservation beats shipping speed.** When a git op could destroy uncommitted or unpushed work, stop and ask.
3. **Commits are finished, tested work only — and grouped by logical feature, not by step.** "Finished" means either (a) user verified it works in the app, or (b) it's a behavior-inert change (copy, CSS, docs) the user approved. No WIP commits, no checkpoint commits. **Default to one commit per logical feature, not one per file or step.** If a feature touches the AppError class, asyncHandler middleware, and the routes that use them, that's ONE commit, not three. Only split when the pieces are genuinely independent and could be reverted separately.
4. **Separate cues for commit vs. push.**
   - **Commit cue:** "looks good", "commit", "next task", or any affirmative after Claude reports what to test → commit without re-approval. Use plain `git commit -m "single line"` (no heredoc, no co-author footer) unless the user asks otherwise — keeps permission prompts at zero.
   - **Push cue:** explicit only — "push", "deploy", "ship it", "send it". Claude never auto-pushes on commit cues. **Claude NEVER volunteers a "ready to push?" prompt.** Pushes are user-initiated only. The user coordinates push timing across multiple parallel Claude sessions / terminals and decides when the full batch is ready. After a commit, Claude stands down — silence is correct. No "ready to push?" question, no "want me to push these now?" nudge, nothing.
   - **Agent-run confirmation.** When the user issues a push cue, Claude's FIRST response is a one-line batch summary + confirmation — BEFORE any agent launch: *"N commits / M files pending. Run agents + push?"* Agents fire only on an explicit yes. If the user says *wait / one more thing / defer*, Claude stands down — no agent run, no push. Re-ask on the next push cue. **Never pre-run agents.** Not at end of feature, not to "verify," not on commit cues, not as prep. The confirmation prompt is the single entry point to the agent fleet. This guards against burning a review on a batch the user is about to amend, and lets the user consolidate commits across multiple terminals into ONE review pass.
5. **Push = deploy.** Every push to `main` ships to Render + Vercel. Treat with gravity.
6. **Review agents run automatically before every code-touching push.** Claude launches all 5 non-UI agents in parallel (`consistency-check`, `code-review`, `security-review`, `database-review`, `performance-review`). Skip agents only when (a) the push contains exclusively `*.md` or `.gitignore` changes, or (b) a fresh `.claude/overnight-review.log` records the current `HEAD` as CLEAN or FIXED with zero flags (see Pre-Push Procedure step 4.5). Clean results → push proceeds silently. Any flag → stop, report findings, wait. **Agents run exactly once per logical push, gated by the Pre-Push Procedure step 0.5 confirmation. Claude does NOT pre-run agents at feature completion, task completion, "let me verify," or any point outside the confirmed push flow.**
7. **Explicit staging only.** `git add <specific-path>` always. Never `git add .`, `-A`, or `-u`. Prevents sweeping in screenshots, `.playwright-mcp/`, `.env`, etc.
8. **Branches and stashes require approval with a one-line reason.** Claude may propose but never creates silently.
9. **Undo rules (safe recipes).**
   - Unpushed commit: `git reset --soft HEAD~N`
   - Pushed commit: `git revert <sha>` + push (new undo commit — never rewrite pushed history)
   - Unstage without losing work: `git restore --staged <path>`
10. **Amend rules.** Never `--amend` a pushed commit. On unpushed commits, prefer new commits over amend; only amend if the user explicitly asks.
11. **Destructive ops always require explicit approval.** `push --force`, `reset --hard`, `clean -f`, `branch -D`, `checkout .`, `restore .`, `rm` on tracked files — per-action yes every time. No "obviously safe" bypass.
12. **Push failures stop and report — never auto-resolve.** If `git push` is rejected (non-fast-forward, auth, network), Claude stops and asks. Never auto-pulls, auto-rebases, or force-pushes.

### Pre-Push Procedure

When the user gives a push cue, Claude runs this checklist exactly. No steps skipped, no silent deviations.

**0.5 — Confirmation gate (runs BEFORE any other step).** Announce the pending batch in one line: *"N commits / M files. Run agents + push?"* Wait for explicit yes. If the user says *defer / wait / one more thing / hold on*, stand down silently — no agent run, no push, no further pre-push work. Re-ask on the next push cue. This gate ensures agents run AT MOST once per logical push, even when the user is batching work across multiple parallel Claude sessions.

1. **Verify branch.** Confirm current branch = `main`. If not, stop and ask.
2. **Sanity-check working tree.** If there are uncommitted modifications or untracked files other than known-ignored artifacts, pause and ask: *"There are uncommitted changes in X, Y, Z — meant to go in this push or leave them out?"* Not a hard block; user may just say "leave them."
3. **Inventory the batch.** Run `git log origin/main..HEAD --name-only` to see every file in the pending push.
4. **Classify code vs. non-code.** If all changed files are `*.md` or `.gitignore`, skip to step 7.
4.5. **Check overnight-review cache.** If `.claude/overnight-review.log` exists, honor it and skip to step 7 when ALL of the following hold:
   - Log timestamp is within the last 18 hours
   - `Current HEAD:` sha in the log matches `git rev-parse HEAD`
   - `## Result` line begins with `CLEAN` or `FIXED`
   - `## Flagged for morning (NOT fixed)` section contains only `none`

   If honored, announce one line: *"Honoring overnight-review cache (HEAD `<short-sha>`, result `<CLEAN|FIXED>`)"* and skip to step 7. Otherwise announce one line why the cache was rejected (stale / HEAD mismatch / has flags / missing) and continue to step 5.
5. **Launch 5 agents in parallel** (single message, 5 concurrent Agent tool calls): `consistency-check`, `code-review`, `security-review`, `database-review`, `performance-review`.
6. **Wait for all agents. Consolidate.** All clean → proceed silently to push. Any flagged issue → stop, present a consolidated report grouped by severity (blockers, warnings, suggestions), ask for direction (fix now, push anyway, abandon).
7. **Push.** `git push origin main`. If rejected, stop and report (per Rule 12).
8. **Report result.** Confirm push succeeded. Note Render + Vercel are now deploying. List commits that shipped.

## Reasoning Effort

**Use maximum reasoning effort when:**
- A change crosses system boundaries (schema → routes → components, backend ↔ frontend)
- Pricing, payment, or Stripe logic is involved (real money at stake)
- Auth, security, or role-guard logic is involved (data exposure risk)
- Schema migrations (hard to reverse in production)
- Any change that triggers the Cross-Cutting Consistency rules below

**Normal effort is fine for:**
- Single-file, single-layer edits (one component, one route, one style block)
- Copy, text, or documentation-only changes
- CSS-only styling tweaks
- Isolated bug fixes with an obvious cause and fix

**Quick test:** *"If I get this subtly wrong, will it cause a bug that's hard to catch?"* If yes — max effort. If the mistake would be immediately obvious — normal effort.

## Coding Patterns & Conventions

- **No ORM** — use raw SQL via `pool.query()` with parameterized queries (`$1`, `$2`, etc.). Never concatenate user input into SQL.
- **Route files** export an Express Router. One file per resource under `server/routes/`.
- **Auth middleware** — import `{ auth }` for protected routes; check `req.user.role` for admin/manager guards.
- **File uploads** use `express-fileupload` → validated with magic bytes → uploaded to R2 → URL stored in DB.
- **Public token-gated routes** (drink plans, proposals) use UUID tokens in the URL instead of auth.
- **Frontend API calls** go through `client/src/utils/api.js` (axios with auto-attached JWT).
- **Schema changes** go in `schema.sql` using idempotent statements (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).
- **Pricing logic** lives in `server/utils/pricingEngine.js` — pure functions, no DB calls.
- **CSS** — vanilla CSS in `index.css`. No CSS modules, no utility frameworks.
- **Naming**: camelCase for JS variables/functions, snake_case for DB columns and API JSON keys.

## Cross-Cutting Consistency

When modifying any entity, always check and update **all** related entities too. Never leave one part of the system out of sync with another. Examples:

- **Proposal price changes** → re-evaluate payment status. If the new total exceeds `amount_paid`, remove or correct any "Paid in Full" flag. Never leave a proposal marked paid when it isn't.
- **Proposal event detail changes** (date, time, location, guest count) → check and update linked shifts accordingly.
- **Phone number / formatting changes** → update every component, route, and display that touches that field.
- **Schema column changes** → update every route (SELECT, INSERT, UPDATE), every component that reads/writes that field, and every place that displays it.
- **New feature data shape** → ensure every consumer of that data (backend endpoints, frontend components, PDF templates) is updated in the same PR.
- **Event identity** — client name and event type are separate, independent data points. Never concatenate them into a single "title" string or prompt for an `event_name`. Display uses `getEventTypeLabel({ event_type, event_type_custom })` with `'event'` as the graceful fallback. Available in `client/src/utils/eventTypes.js` (ESM) and `server/utils/eventTypes.js` (CJS — kept in sync manually).
- **Hosted-package bartender rule** — Hosted (per_guest) packages include bartender staffing in the per-guest rate. Any additional bartenders — via the `num_bartenders` override OR the `additional-bartender` add-on — are **$0 line items with $0 gratuity** on hosted packages. Use `isHostedPackage(pkg)` from `server/utils/pricingEngine.js`. Grep for `isHostedPackage` before adding any new bartender-cost code path; replicate the zero-out. This rule has been re-lost multiple times — treat as load-bearing.

The rule: **if you change X, search the codebase for everything that depends on X and update it too.**

## Mandatory Documentation Updates

**This is not optional.** When you add, rename, or remove files, update ALL THREE docs in the same change. The pre-commit hook will warn if you don't.

| What changed | Update in CLAUDE.md | Update in README.md | Update in ARCHITECTURE.md |
|---|---|---|---|
| New/removed route file | Folder structure tree | Folder structure tree | Add/remove API route table |
| New/removed util file | Folder structure tree | Folder structure tree | Mention in relevant section |
| New/removed component | Folder structure tree | Folder structure tree | — |
| New/removed page | Folder structure tree | Folder structure tree | — |
| New/removed context | Folder structure tree | Folder structure tree | — |
| Schema column/table change | — | — | Database Schema section |
| New env variable | Environment Variables table | Environment Variables table | — |
| New npm script | — | NPM Scripts table | — |
| New integration | Tech Stack list | Tech Stack table | Third-Party Integrations |
| New feature | — | Key Features section | Relevant architecture section |

---

## Code Verification System

This project is vibe-coded — the author relies on Claude to catch issues. Verification has two layers: an inline self-check on every change, and opus-powered review agents for thorough analysis.

### Inline Self-Check (Every Change — Free)

Before presenting ANY code change, silently verify:

**Security**
- All SQL uses parameterized queries (`$1`, `$2`) — never string concatenation
- All non-public routes have `auth` middleware; admin routes check `req.user.role`
- Endpoints filter by `req.user.id` to prevent accessing other users' data (IDOR)
- No secrets hardcoded — everything from `process.env`
- User input validated on server side (type, length, format)
- File uploads validated with magic bytes via `fileValidation.js`
- Error responses never leak stack traces, SQL, or internals

**Data Integrity**
- Multi-table writes wrapped in `BEGIN/COMMIT/ROLLBACK`
- Schema changes are idempotent (`IF NOT EXISTS`)
- Money stored as integer cents, never floats
- Changed columns updated in ALL routes that touch that table

**Frontend**
- Async ops have loading, error, and empty states
- API calls go through `utils/api.js` — never raw fetch/axios
- New routes added to `App.js` with correct auth guards
- Client-side validation matches server-side rules

**Logic**
- Null/undefined handled for DB results, API responses, optional fields
- Date ranges and pagination boundaries correct
- No race conditions on payment/mutation endpoints

### Review Agents (All Opus)

Six review agents live in `.claude/agents/`, all running on opus. Triggered automatically per the Git Workflow rules above (see Rule 6 + Pre-Push Procedure) or explicitly via the `/review-before-deploy` slash command. A complementary `/codex-review` command runs OpenAI Codex (GPT) as a cross-LLM second-opinion reviewer — see its subsection below.

**Auto-run in parallel before every code-touching push to `main`:**

- **@security-review** — Full OWASP Top 10:2025 audit:
  - A01 Broken Access Control: missing `auth` middleware, IDOR (missing `req.user.id` ownership checks), SSRF (consolidated into A01 in 2025 — user-controlled URLs in Nominatim/webhooks)
  - A02 Security Misconfiguration: CORS, Helmet, error leakage, debug endpoints, `STRIPE_TEST_MODE_UNTIL` in prod
  - A03 Software Supply Chain Failures (NEW/expanded): `npm audit`, lockfile integrity, pinned security packages, suspicious postinstall scripts, Render/Vercel pipeline pinning
  - A04 Cryptographic Failures: bcryptjs, JWT_SECRET from env, secret keys never in client bundle
  - A05 Injection: SQL string concat, XSS (`dangerouslySetInnerHTML`), command injection, path traversal
  - A06 Insecure Design: rate limiting, file upload magic bytes, server-side payment/state-machine validation
  - A07 Authentication Failures: JWT impl, password requirements, user enumeration
  - A08 Data Integrity: Stripe/Resend/Thumbtack webhook signature verification, BEGIN/COMMIT/ROLLBACK
  - A09 Logging & Monitoring: Sentry init, failed-login and payment-event logging, no PII in logs
  - A10 Mishandling of Exceptional Conditions (NEW): `asyncHandler` coverage, `AppError` hierarchy usage, fail-closed on Stripe/webhook paths, ROLLBACK on error branches, scheduler resilience

- **@code-review** — Code quality + error handling:
  - Missing try/catch on async handlers, missing ROLLBACK after BEGIN, unhandled promises
  - Missing loading/error/empty states in React components
  - Dead code, duplication, function complexity (>50 lines), naming conventions
  - React anti-patterns: useEffect deps, component size (>200 lines), props drilling
  - API consistency: response shapes, HTTP status codes, snake_case keys

- **@consistency-check** — Cross-file synchronization:
  - Schema column changes reflected in all routes (SELECT, INSERT, UPDATE)
  - New routes mounted in `index.js` with matching `App.js` frontend routes
  - Pricing logic changes reflected in all consumers (ProposalCreate, ProposalDetail, PricingBreakdown)
  - API response shape changes handled by all frontend consumers
  - Doc updates: CLAUDE.md, README.md, ARCHITECTURE.md folder trees

- **@performance-review** — Frontend, API, and bundle performance:
  - Unnecessary React re-renders (missing memo/useMemo/useCallback)
  - Heavy imports, missing lazy loading, unused code shipped to client
  - Sequential DB queries that could use Promise.all, missing pagination
  - Oversized API responses, `SELECT *` instead of specific columns
  - Prioritizes public-facing pages (HomePage, ProposalView, PotionPlanningLab, Blog)

**Auto-run additionally when `server/db/schema.sql` is modified:**

- **@database-review** — Schema + query analysis:
  - Missing indexes, foreign keys, NOT NULL constraints
  - N+1 query patterns, `SELECT *`, missing LIMIT on list queries
  - Transaction integrity (BEGIN/COMMIT/ROLLBACK)
  - Migration safety (idempotent DDL, nullable new columns)

**Explicit-only (requires `npm run dev` running):**

- **@ui-ux-review** — Playwright visual + accessibility review:
  - Screenshots at desktop, tablet, and mobile viewports
  - Color contrast, form labels, heading hierarchy, keyboard navigation
  - Loading states, error messages, empty states, form validation feedback
  - Responsive layout, touch targets, admin sidebar behavior

**Slash Command — `/review-before-deploy`:**

Runs ALL six agents in parallel (the five auto-runners plus `ui-ux-review`). Reserved for heavier gates: end of a major feature, before quarterly deploy, after adding a new third-party integration. Will warn if `npm run dev` isn't running and ask whether to start it or skip the UI agent.

**Slash Command — `/codex-review`:**

Runs OpenAI Codex (GPT) as a second-opinion reviewer over uncommitted changes, a diff range, or a focused sweep. GPT and Claude have different priors, so Codex catches what Claude-style checklist agents miss — logic correctness, business-intent alignment, architectural smell, and test-gap reasoning.

Argument presets (see `.claude/commands/codex-review.md` for the full table):
- *(empty)* — holistic "anything look off?" on uncommitted changes
- `tests` — identify missing unit/integration/edge-case tests
- `pricing` — verify money math (integer cents, hosted-bartender rule, rounding)
- `intent` — check diff matches the stated commit message / branch intent
- `architecture` — leaky abstractions, module boundaries, coupling

Read-only by design: the slash command runs exclusively `codex review ...`. All write-capable Codex subcommands (`apply`, `exec`, `cloud`, `resume`, `fork`, `mcp-server`, `app`, `app-server`) are blocked by deny rules in `.claude/settings.local.json`. If Codex suggests a patch, it's presented as text — the user decides what lands.

# Client-Facing Surface Inventory

A complete map of every surface a UI/UX overhaul will touch, what it does, and the current end-to-end booking flow. Generated 2026-04-29.

The app runs on four host contexts and the routing in `client/src/App.js:137-144` decides which routes render where:

| Host | Context | Audience |
|---|---|---|
| `drbartender.com` | `public` | Prospects, leads, signed clients |
| `hiring.drbartender.com` | `hiring` | Applicants, contractors mid-onboarding |
| `staff.drbartender.com` | `staff` | Hired contractors |
| `admin.drbartender.com` / localhost | `app` | Admin + managers (NOT in scope of this overhaul) |

Token-gated pages (`/proposal/:token`, `/plan/:token`, `/invoice/:token`, `/shopping-list/:token`) are **mounted on every host** — the same surface ships from any domain.

---

## A. Public Marketing Site (drbartender.com)

| File | Purpose |
|---|---|
| `client/src/components/PublicLayout.js` | Header + footer + mobile nav wrapper. Brand logo, top-nav (Services / How It Works / About / FAQ / Blog / Sign In / **Get an Instant Quote** CTA), and footer with email + copyright. Used by every marketing page. |
| `client/src/components/BrandLogo.js` | The Dr. Bartender logo lock-up reused in every header. |
| `client/src/pages/website/HomePage.js` | The home page. Hero ("Your event's bar, engineered."), services grid (3 image cards), 3-step "How It Works" alternating text/image rows, "Why Dr. Bartender" stats (20+ yrs, $2M liability, IL/IN/MI), live Thumbtack testimonials with fallback copy, CTA banner. |
| `client/src/pages/website/Website.js` | Legacy combined website. Still in the tree but `App.js` no longer routes to it — `HomePage.js` replaced it. (Candidate for deletion.) |
| `client/src/pages/website/FaqPage.js` | Static FAQ. Four categories (Booking & Pricing, Services & Packages, Logistics & Coverage, Event Day) of accordion items; CTA banner at bottom. |
| `client/src/pages/website/QuotePage.js` | Three-line wrapper that drops the QuoteWizard into PublicLayout. |
| `client/src/pages/website/quoteWizard/QuoteWizard.js` | The 5-step instant-quote wizard. Loads packages + add-ons from `/api/proposals/public/packages` and `/api/proposals/public/addons`, shows step dots, a left form column, and a right pricing sidebar that recalculates live via `/api/proposals/public/calculate`. Persists drafts to localStorage and (after step 4) to a server token, so a returning user gets a "Welcome back" banner. |
| `client/src/pages/website/quoteWizard/steps/EventDetailsStep.js` | Step 1 — guest count, duration, date, start time, city/state, alcohol provider (BYOB / hosted / mocktail), event type autocomplete with custom fallback. |
| `client/src/pages/website/quoteWizard/steps/PackageStep.js` | Step 2 (hosted only) — bar type then package card grid. BYOB and mocktail paths auto-pick a package and skip the visible step. |
| `client/src/pages/website/quoteWizard/steps/ExtrasStep.js` | Step 3 — grouped add-on grid (BYOB bundles, garnish, mocktail bar, real glassware, Flavor Blaster, syrups picker, etc.) with mutual exclusion rules (signature/full mixers, BYOB bundles). |
| `client/src/pages/website/quoteWizard/steps/ReviewStep.js` | Step 4 — read-only summary of selections with edit jump links. |
| `client/src/pages/website/quoteWizard/steps/YourInfoStep.js` | Step 5 — name, email, phone. Submitting captures the lead and creates a real proposal in the DB; the page then jumps to `/proposal/:token`. |
| `client/src/pages/website/quoteWizard/bundleConfig.js` | BYOB bundle slug constants and "what's included / what's blocked" maps. |
| `client/src/pages/website/quoteWizard/helpers.js` | `getSteps`, `formatCurrency`, addon taglines. |
| `client/src/pages/website/ClassWizard.js` | A separate 4-step wizard for cocktail classes (Choose Class → Details → Equipment → Your Info). Filters packages to `bar_type='class'`, shows BYOB / Supplies / Top Shelf upgrades, mutually-exclusive tool kit add-ons (purchase vs rental). Submits via the same `/api/proposals/public/submit` endpoint and lands on a proposal token URL. |
| `client/src/pages/public/Blog.js` | "Lab Notes" index — chapter-numbered post cards with cover images, served from `/api/blog`. |
| `client/src/pages/public/BlogPost.js` | "Lab Notes" detail — TipTap-authored body sanitized with DOMPurify, image-URL rewriting for `/api/...` assets, back-link header and footer. |

---

## B. Token-Gated Client Pages (sent via email; work on every host)

| File | Purpose |
|---|---|
| `client/src/pages/proposal/proposalView/ProposalView.js` | The proposal-viewing page. Loads `/proposals/t/:token`, lazy-loads Stripe.js only when payment is still possible, manages two payment intents (deposit vs full) with autopay-toggle reuse, and orchestrates the sign-and-pay flow. |
| `client/src/pages/proposal/proposalView/ProposalHeader.js` | Brand bar + event identity card (client name, event type, date, location, guest count, bartender count). |
| `client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js` | "What's included" bullets, line-item table (package, bar rental, add-ons, syrups, adjustments), totals, deposit/balance summary. |
| `client/src/pages/proposal/proposalView/SignAndPaySection.js` | Two modes: `signAndPay` (sig pad + name + payment-option radios + autopay checkbox + Stripe Elements) and `payOnly` (already signed, deposit vs full toggle + Stripe). |
| `client/src/pages/proposal/proposalView/PaymentForm.js` | Stripe Elements-aware form that signs the proposal first, then confirms payment in one click. |
| `client/src/pages/proposal/proposalView/helpers.js` | `fmt`, `formatTime`, `calcEndTime`, `formatDateShort`, `DEPOSIT_DOLLARS`. |
| `client/src/pages/proposal/proposalView/styles.js` | All proposal page inline-style objects (page, container, heading, paid banner, footer). The whole page is style-prop driven — not class-based — so it's the most isolated visual surface for a redesign. |
| `client/src/pages/plan/PotionPlanningLab.js` | The big one — drink plan questionnaire. Two phases (Exploration → Refinement) gated by proposal status. Auto-saves every 30s + on unload, supports browser back-button to navigate steps, can checkout extras through Stripe mid-flow. |
| `client/src/pages/plan/steps/WelcomeStep.js` | Front-door splash for the lab. |
| `client/src/pages/plan/steps/RefinementWelcomeStep.js` | Phase-2 entry splash that recaps the exploration data. |
| `client/src/pages/plan/steps/VibeStep.js` | Exploration — pick an event vibe. |
| `client/src/pages/plan/steps/FlavorDirectionStep.js` | Exploration — flavor directions + free-text "dream drink" notes. |
| `client/src/pages/plan/steps/ExplorationBrowseStep.js` | Exploration — browse the cocktail menu, mark favorites, attach per-drink upgrades. |
| `client/src/pages/plan/steps/MocktailInterestStep.js` | Exploration — yes/no/maybe on mocktails. |
| `client/src/pages/plan/steps/ExplorationSaveStep.js` | Exploration — save & wait for proposal to be sent. |
| `client/src/pages/plan/steps/QuickPickStep.js` | Refinement — quick-pick serving styles (signature drinks / full bar / beer & wine / mocktail / custom). |
| `client/src/pages/plan/steps/CustomSetupStep.js` | Refinement — opt-in toggles for each module (signatures, mocktails, full bar, beer/wine). |
| `client/src/pages/plan/steps/SignaturePickerStep.js` | Refinement — pick the actual signature drinks, with custom add, mixers question, and per-drink upgrades (carbonation, smoke, smoke-bubble, syrups). |
| `client/src/pages/plan/steps/MocktailStep.js` | Refinement — pick mocktails, attach syrups + add-ons. |
| `client/src/pages/plan/steps/FullBarSpiritsStep.js` | Refinement — spirits selection. |
| `client/src/pages/plan/steps/FullBarBeerWineStep.js` | Refinement — beer/wine on a full bar. |
| `client/src/pages/plan/steps/BeerWineStep.js` | Refinement — beer/wine-only setup. |
| `client/src/pages/plan/steps/HostedGuestPrefsStep.js` | Refinement (hosted only) — compact guest-preferences step. |
| `client/src/pages/plan/steps/MenuDesignStep.js` | Refinement — opt into a custom menu graphic, naming, theme, notes. |
| `client/src/pages/plan/steps/MakeItYoursPanel.js` | Reusable upsell side-panel inside the lab. |
| `client/src/pages/plan/steps/LogisticsStep.js` | Refinement — day-of contact, parking, equipment add-ons (bar rental), access notes. |
| `client/src/pages/plan/steps/ConfirmationStep.js` | Final review, surcharge tally, Stripe handoff if there are paid extras, submit button. |
| `client/src/pages/plan/data/cocktailMenu.js` | Cocktail seed data. |
| `client/src/pages/plan/data/servingTypes.js` | The QUICK_PICKS, MODULE_STEP_MAP, and queue-builder logic that drives the wizard. |
| `client/src/pages/plan/data/drinkUpgrades.js` | Per-drink upgrade definitions (carbonation, smoke, etc.). |
| `client/src/pages/plan/data/packageGaps.js` | "What's still missing on a hosted package?" gap helpers. |
| `client/src/pages/invoice/InvoicePage.js` | Stand-alone invoice view. Print-styled "INVOICE" header, paid stamp when paid, line-item table, totals, Stripe Pay button + payment element, "Save as PDF" via html2pdf. |
| `client/src/pages/public/ClientShoppingList.js` | Mobile-first dark-themed shopping checklist (own inline style block, distinct from the rest of the site). Loads `/api/drink-plans/t/:token/shopping-list`, persists checked state per token in localStorage, "Refresh List" button, signature cocktail strip at bottom. |

---

## C. Client Portal (logged-in clients on the public host)

| File | Purpose |
|---|---|
| `client/src/pages/public/ClientLogin.js` | Two-step OTP login — request code (neutral success message for enumeration safety), then enter 6-digit code. Side-by-side benefits panel listing what the portal offers. |
| `client/src/pages/public/ClientDashboard.js` | "My Proposals" — grid of cards per proposal showing status badge, event type, date, total, paid amount; each card has an InvoiceDropdown and a "View Proposal" button that links into the token-gated proposal view. |
| `client/src/components/InvoiceDropdown.js` | Reusable dropdown that lists invoices for a proposal (used inside `ClientDashboard`). |
| `client/src/context/ClientAuthContext.js` | Holds `clientUser`, `db_client_token` JWT, login/logout — separate from staff auth. |

---

## D. Hiring & Application (hiring.drbartender.com)

| File | Purpose |
|---|---|
| `client/src/pages/HiringLanding.js` | The applicant landing page. Hero ("Join the Dr. Bartender Team"), a 4-card "1 → 2 → 3 → 4" process (Create Account → Apply → Interview → Start Working), Apply Now CTA, "Why Dr. Bartender?" 3-bullet strip. |
| `client/src/pages/Register.js` | Email + password (8-char min) + confirm. Creates account, logs in, sends to `/apply`. |
| `client/src/pages/Login.js` | Generic email+password login (used by hiring + staff hosts; admin hits this on admin.). After login routes the user to the right place based on `onboarding_status`. |
| `client/src/pages/ForgotPassword.js` | Email-only reset request. Shows a neutral "if an account exists…" message after submit. |
| `client/src/pages/ResetPassword.js` | Token-link landing page from the email — set a new password. |
| `client/src/pages/Application.js` | The 8-section application form: Basic Info (name/phone/favorite-color color picker/DOB w/21+ check), Location & Travel, Experience (years, types, history), Availability (Saturdays + commitments), Tools & Equipment (long checkbox lists), Skills (1–5 confidence slider, working alone, customer service blurb), Additional Info + Resume + Headshot + BASSET upload + referral, Emergency Contact. Multipart form-data POST. |
| `client/src/pages/ApplicationStatus.js` | Post-submit holding page. Status-aware: rejected gets a "decided not to move forward" card; everyone else gets "Application Received!" with a "What Happens Next" list and contact info. Auto-forwards if status flips to `hired` / `submitted` / `reviewed` / `approved`. |

---

## E. Contractor Onboarding (mounted on hiring + staff hosts; gated by `onboarding_status='hired'`)

The shared shell:

| File | Purpose |
|---|---|
| `client/src/components/Layout.js` | Onboarding-flow wrapper. Renders site header + a 6-step progress bar (Account → Welcome → Field Guide → Agreement → Profile → Payday → Complete) with click-back to completed steps and a percent-complete fill bar. Loads `/progress` on every nav. |

The 6 onboarding steps:

| File | Purpose |
|---|---|
| `client/src/pages/Welcome.js` | "Welcome to the Lab" splash — 4-item Lab Access Requirements checklist, "Access the Field Guide" button. |
| `client/src/pages/FieldGuide.js` | Long-form expectations document split into 9 sections (Field Duties, Appearance Protocols, Tools, etc.) with section nav. |
| `client/src/pages/Agreement.js` | Independent Contractor Agreement v2 — At-a-Glance plain-English bullets, full numbered clauses (each with `plain` + `formal` text), per-acknowledgment checkboxes loaded from server, name/email/phone form, SMS consent, SignaturePad. POSTs to `/agreement` and triggers the PDF generator on the server. |
| `client/src/pages/ContractorProfile.js` | Long profile form (preferred name, phone, address, DOB, travel distance, transportation, equipment owned, emergency contact) + file uploads (alcohol cert, resume, headshot). Pre-fills from application data. |
| `client/src/pages/PaydayProtocols.js` | Preferred payment method selector (Venmo / Zelle / Cash App / PayPal / Direct Deposit / Check) with conditional fields, plus W-9 — either fill with `W9Form.js` (generates a PDF) or upload your own. |
| `client/src/pages/Completion.js` | "You're All Set!" celebration card. Refreshes `/auth/me` to pick up the new `submitted` status, then deep-links into `/shifts` or `/dashboard`. |

---

## F. Staff Portal (staff.drbartender.com; mirrored on hiring host post-onboarding)

| File | Purpose |
|---|---|
| `client/src/components/StaffLayout.js` | Sidebar shell (Dashboard / Shifts / My Schedule / My Events / divider / Resources / Profile). Admin/manager users get an extra "Admin Portal" cross-domain link at the top. Mobile sidebar overlay. |
| `client/src/pages/staff/StaffDashboard.js` | Welcome banner with WhatsApp Group link, KPI tiles (Open Shifts / Pending Requests / Confirmed / Events Worked), "Next Event" card. |
| `client/src/pages/staff/StaffShifts.js` | All open shifts the contractor can request, with pending/confirmed/denied pills. |
| `client/src/pages/staff/StaffSchedule.js` | The contractor's own request history — pending/approved/denied. |
| `client/src/pages/staff/StaffEvents.js` | Upcoming and past events the contractor is staffed on. |
| `client/src/pages/staff/StaffProfile.js` | Read-only profile summary with "Edit Profile" link back to the onboarding ContractorProfile page. |
| `client/src/pages/staff/StaffResources.js` | Links + the iCal subscription URL (calendar feed) with copy-to-clipboard, plus phone/WhatsApp. |

---

## G. Lab Rat Tester Program (public, lazy-loaded)

| File | Purpose |
|---|---|
| `client/src/pages/labrat/LabRatLanding.js` | Tester program intro — "Be a Lab Rat", optional first-name field, links to quiz or missions. Has its own scoped `data-app="labrat"` styling block in `labrat.css`. |
| `client/src/pages/labrat/LabRatQuiz.js` | Quick onboarding quiz that picks a starting mission. |
| `client/src/pages/labrat/LabRatMissions.js` | Mission picker. |
| `client/src/pages/labrat/LabRatMission.js` | Single mission view with checklist + bug submission. |
| `client/src/pages/labrat/BugDialog.js` | Modal for filing bug reports back to the inbox. |
| `client/src/pages/labrat/linkify.js` | Helper for turning URLs into anchors in mission text. |
| `client/src/pages/labrat/labrat.css` | Lab-Rat-only CSS, scoped via `data-app="labrat"`. |

(This program is intentionally separate from the visual brand. Decide whether the overhaul includes it or leaves it alone.)

---

## H. Shared Components Used by Client-Facing Pages

These will get touched anywhere they're rendered in a redesigned page. They're the connective tissue.

| File | Purpose |
|---|---|
| `client/src/components/SignaturePad.js` | Canvas signature with type/draw toggle. Used in Agreement (onboarding) and ProposalView (signing). |
| `client/src/components/LocationInput.js` | Nominatim address autocomplete. (Used inside admin builder; quote wizard now uses plain city/state.) |
| `client/src/components/FileUpload.js` | Drag-and-drop file upload with magic-byte validation hooked to the server. Used in Application + ContractorProfile + PaydayProtocols + W9Form. |
| `client/src/components/FormBanner.js` | Red error banner above submit buttons; auto-scrolls into view. Used everywhere. |
| `client/src/components/FieldError.js` | Inline red text under one input. Used everywhere. |
| `client/src/components/Toast.js` + `client/src/context/ToastContext.js` | Top-right transient notifications. |
| `client/src/components/ConfirmModal.js` | Yes/no dialog. |
| `client/src/components/PricingBreakdown.js` | The line-item pricing table (also used inside admin proposal create). |
| `client/src/components/DrinkPlanSelections.js` | Read-only summary of drink plan selections — used inside ProposalView. |
| `client/src/components/MenuSamplesModal.js` | Image lightbox of curated menu designs (Potion Planning Lab MenuDesignStep). |
| `client/src/components/SyrupPicker.js` | Syrup-quantity selector used in QuoteWizard ExtrasStep + drink plan. |
| `client/src/components/TimePicker.js` | Time input used in QuoteWizard EventDetailsStep + ClassWizard. |
| `client/src/components/NumberStepper.js` | Up/down stepper. Used in hours fields. |
| `client/src/components/W9Form.js` | The W-9 fillable form used in PaydayProtocols. |
| `client/src/components/RichTextEditor.js` | TipTap WYSIWYG. Admin-only — not in scope. |
| `client/src/components/InvoiceDropdown.js` | Invoice list dropdown. Used in ClientDashboard + admin proposal page. |
| `client/src/components/ShoppingList/ShoppingListButton.jsx` | "View Shopping List" button (admin + client portal entry). |
| `client/src/components/ShoppingList/ShoppingListModal.jsx` | The inline shopping list modal (mainly admin). |
| `client/src/components/ShoppingList/ShoppingListPDF.jsx` | The downloadable PDF version. |
| `client/src/components/ScrollToTop.js`, `ErrorBoundary.js`, `SessionExpiryHandler.js` | Cross-cutting plumbing. |

---

## I. Global Styling

| File | Purpose |
|---|---|
| `client/src/index.css` | Vanilla CSS for the entire app — class names like `ws-*` (website), `wz-*` (wizards), `client-*` (portal), `lab-*` (blog), `auth-page`, `card`, `btn-primary`, `radio-option`, etc. No Tailwind, no preprocessor. CSS variables for `--font-display`, `--amber`, `--deep-brown`, `--parchment`, `--cream-text`, `--success`, `--rust`. The single biggest file the redesign will touch. |
| `client/src/pages/labrat/labrat.css` | Scoped Lab Rat styles (separate so they don't leak). |

---

## J. Server Surfaces That Render or Email Client-Facing Content

Worth knowing because the overhaul probably touches the things clients receive in their inbox or download.

| File | Purpose |
|---|---|
| `server/utils/emailTemplates.js` | All transactional + admin-notification email HTML. `wrapEmail()` is the transactional shell, `wrapMarketingEmail()` is the marketing shell with unsubscribe footer. Includes proposal-sent / payment-received / drink-plan-ready / interview-confirmation / paperwork-reminder / new-application-admin / top-shelf-class-request templates. |
| `server/utils/agreementPdf.js` | PDFKit renderer for the signed contractor-agreement PDF that contractors get emailed. |
| `client/public/testing-guide.html` | Built from `TESTING.md` by `scripts/build-testing-guide.js`. Lab Rat program references it. |
| `client/src/data/menuSamples.js`, `addonCategories.js`, `eventTypes.js`, `packages.js`, `syrups.js` | Static catalog data. `packages.js` and `syrups.js` are shown to clients; changes here re-skin the Quote Wizard add-on cards and Potion Planning Lab. |

---

## K. Design Rules & Conventions

The load-bearing constraints — anything the redesign should know going in. Pulled from `CLAUDE.md`, `README.md`, `ARCHITECTURE.md`, and the actual `index.css` tokens.

### Styling System

**Vanilla CSS only.** From `CLAUDE.md`:

- "Styling: Vanilla CSS (no Tailwind, no preprocessors)"
- "CSS — vanilla CSS in `index.css`. No CSS modules, no utility frameworks."

Everything lives in `client/src/index.css` (8,865 lines). The only exceptions:

- `client/src/pages/labrat/labrat.css` — scoped Lab Rat styles, gated by `data-app="labrat"`.
- Per-page inline-style objects in `proposalView/styles.js` and `ClientShoppingList.js`. These two surfaces opted out of the global stylesheet entirely.

If the redesign introduces a new approach (Tailwind, CSS modules, design-token JSON, CSS-in-JS), it's a deliberate break from this rule — not a drop-in.

### Design Tokens (from `:root` in `index.css`)

```css
/* Colors — apothecary lab palette */
--cream:           #F5F0E8   /* light text on dark */
--parchment:       #E8DFC4   /* secondary text on dark */
--parchment-dark:  #D4C9A8
--dark-ink:        #1A1410
--deep-brown:      #2C1F0E   /* headings + text on parchment */
--chalkboard:      #2a2a2a   /* page background */
--warm-brown:      #6B4226   /* hover state for amber CTAs */
--amber:           #C17D3C   /* primary CTA + focus rings */
--amber-light:     #D4954A   /* links + accents */
--cream-text:      #F5F0E8   /* alias for cream on dark */
--forest:          #2D4A2D   /* btn-success */
--forest-light:    #3D6B3D
--sage:            #7A9E7A   /* paid / positive */
--rust:            #A0522D   /* balance due / warning */
--error:           #8B2020
--success:         #2D6B2D
--border:          #9E8B6A
--border-dark:     #7A6B4F
--border-light:    #e0d6c2
--text-muted:      #6B5A42
--card-bg:         #F5EDE0   /* parchment scroll card */
--paper:           #F8F4EC
--paper-dark:      #EDE6D6

/* Shape */
--radius:    6px
--radius-lg: 10px

/* Shadow */
--shadow:    0 2px 20px rgba(0, 0, 0, 0.25)
--shadow-lg: 0 8px 40px rgba(0, 0, 0, 0.35)

/* Z-index scale */
--z-dropdown: 100
--z-sticky:   200
--z-sidebar:  300
--z-overlay:  400
--z-modal:    500
--z-toast:    600
--z-skip-nav: 700

/* Type */
--font-display: 'IM Fell English SC', 'IM Fell English', Georgia, serif
--font-body:    'IM Fell English', Georgia, serif
```

Fonts are imported from Google Fonts at the top of `index.css` — no self-hosting today.

### Typography

- Body: **17px base**, `line-height: 1.65`.
- All headings use `--font-display` (small-caps Fell).
- `h1`–`h3` use `clamp()` for fluid scaling: `h1: 1.85rem → 2.75rem`, `h2: 1.4rem → 1.9rem`, `h3: 1.15rem → 1.4rem`.
- `h4` is a small-caps eyebrow: `1rem`, uppercase, `letter-spacing: 0.1em`.

### Class-Name Namespaces

The CSS isn't strict BEM but it does namespace by surface so the global file doesn't collide with itself:

| Prefix | Surface |
|---|---|
| `ws-*` | Public website / marketing (HomePage, sections, hero) |
| `wz-*` | Wizards — quote, class, drink-plan navigation |
| `client-*` | Client portal (login, dashboard) |
| `lab-*` | Lab Notes blog (`lab-card`, `lab-notebook`) |
| `admin-*` | Admin layout shell — also used by the staff portal because it shares the sidebar layout |
| `auth-page` | Login / Register / Forgot-Password chalkboard backdrop |
| `guide-*` | Field Guide (onboarding) |
| `potion-*` | Potion Planning Lab |
| `invoice-*` | Invoice page |
| `step-*` | 6-step onboarding progress bar |

Primitives without a prefix:

- `card`, `card-sm`, `card-clickable` — the parchment scroll card.
- `btn`, `btn-primary`, `btn-secondary`, `btn-dark`, `btn-success`, `btn-danger`, `btn-sm`, `btn-full`.
- `form-group`, `form-label`, `form-input`, `form-select`, `form-textarea`, `form-helper`, `form-error`.
- `radio-group`, `radio-option`, `checkbox-group`.
- `alert-info`, `alert-success`, `alert-error`.
- `badge-inprogress`, `badge-submitted`, `badge-approved`.
- `divider`, `divider-ornate`.
- `loading`, `spinner`.
- `page-container`, `page-container.wide` (max 900px / 1100px).
- Utilities: `text-center`, `text-muted`, `text-small`, `italic`, `sr-only`, `mt-2`, `mb-3`, `two-col`.

### Visual Language ("Apothecary Lab")

- Body lives on a **chalkboard background** (`--chalkboard` plus the `chalkboard_background.png` repeating image at `client/src/images/`).
- Content sits on **parchment-colored cards** (`--card-bg: #F5EDE0`) with a 3px `--border-dark` border, `--radius-lg`, and an inset 1px parchment-light highlight: `box-shadow: var(--shadow), inset 0 0 0 1px rgba(212, 201, 168, 0.4)`.
- **Inside cards**, paragraph text and headings flip to `--deep-brown`. `.card .text-muted` overrides to `#5C3319`. `.card .btn-secondary` flips its text to deep-brown so it's legible on parchment.
- Decorative ⚗ glyphs ("ornaments") are a recurring brand motif — used as page icons in onboarding steps, the "Lab Access Requirements" header, etc.
- `.divider-ornate` puts a single italic word ("sit tight", "officially official", "What to Expect") centered in a hairline rule — one of the file's most recognizable details.
- The marketing site uses a custom **fade-up-on-scroll** animation (`.ws-fade-up` + IntersectionObserver in `HomePage.js` and `Website.js`).

### Buttons

- `.btn-primary` — amber background, white text, `box-shadow: 0 2px 8px rgba(193, 125, 60, 0.3)`, hover lifts (`translateY(-1px)`) and deepens to `--warm-brown`.
- `.btn-secondary` — transparent + amber-light border. Inside `.card`, automatically flips to deep-brown text + dark border.
- `.btn-success` — forest green for positive admin actions.
- `.btn-dark` — deep brown for inverse/secondary.
- `.btn-danger` — error red.
- All buttons share: `0.18s ease` transition, `letter-spacing: 0.04em`, weight 600.
- **Focus state**: `outline: 2px solid var(--amber); outline-offset: 3px;` applied to `.btn:focus-visible` and a curated list of clickable non-button elements (`.tab-btn`, `.guide-section-header`, `.ws-faq-q`, `.admin-nav-item`, `.category-sidebar-btn`, `.category-pill`, `.drink-card-horizontal`, `.vibe-card`, `.flavor-chip`).

### Forms

- Every form-driven page uses the `useFormValidation` hook (`client/src/hooks/useFormValidation.js`).
- Labels are uppercase, 0.85rem, letter-spacing 0.06em, color `--deep-brown`.
- Validation errors render in two layers: `<FieldError>` under the input, `<FormBanner>` above the submit button (auto-scrolls into view).
- Form inputs respect server-driven `fieldErrors` keyed by field name — never re-validate client-side; trust the server's per-field message and clear it on next edit.

### Error Display System (from `ARCHITECTURE.md`)

| Surface | Component | When to use |
|---|---|---|
| Field-level inline | `<FieldError>` | Server returned `fieldErrors: { fieldName: '...' }` |
| Form-level banner | `<FormBanner>` | Whole-form failure, not field-attributable. Sits above submit; auto-scrolls |
| Toast | `useToast()` | System events not tied to a form (success, session expiry, network) |
| Modal fallback | `<ErrorBoundary>` | Unhandled React error |

Server error envelope (every 4xx/5xx):

```json
{ "error": "Human-readable message", "code": "OPTIONAL_CODE", "fieldErrors": { "field": "..." } }
```

Special-case routing the redesign must preserve:

- **401 (session expired):** toast → 1.5s → context-aware redirect. Never show a stack.
- **Network failure:** toast `'Network error — check your connection.'`
- **Stripe Elements card errors:** Stripe handles them inline. `<FormBanner>` is for the surrounding API only.
- **Enumeration-sensitive endpoints** (forgot-password, client OTP request): public response is always success; banner only on hard errors (rate limit, server failure).

### Accessibility Conventions Already in the Codebase

- Every layout has a "Skip to main content" link (`.skip-nav` → `#main-content`).
- All loading regions use `role="status"` + `aria-live="polite"`.
- Error banners use `role="alert"`.
- Form inputs use `aria-invalid={!!fieldErrors?.field}`.
- The 6-step onboarding bar exposes `role="navigation"` + per-step `role="button"` + `aria-current="step"`.
- Keyboard activation (Enter / Space) on clickable non-button rows is wired manually wherever the page uses `onClick` on a div.

Don't regress these — Sentry catches obvious failures but not missing ARIA.

### Naming (Code, not CSS)

- **JS:** camelCase variables/functions (e.g. `clientLoginPath`, `useFormValidation`).
- **DB + API JSON:** snake_case (`onboarding_status`, `event_date`, `client_signed_at`).
- **CSS classes:** kebab-case (`ws-faq-item`, `btn-primary`, `card-clickable`).
- **Money:** stored as integer cents, never floats (CLAUDE.md). Format with `formatCurrency` helpers — never construct a `$` string by hand.

### File-Size Discipline (CLAUDE.md)

The pre-commit hook (`.husky/check-file-size.sh`) gates source files (`server/**/*.js`, `client/src/**/*.{js,jsx}`):

- **Warn at 700 lines** — plan a split.
- **Fail at 1000 lines** — split or add `// claude-allow-large-file` with a one-line reason.
- Sweet spot: under 300 lines.

Existing debt the redesign will inherit (already over 1000 — touch them, you split them):

- `client/src/pages/plan/PotionPlanningLab.js` (~1,095)
- `client/src/pages/admin/ProposalCreate.js` (~1,068, admin — out of scope)
- `server/routes/stripe.js` (~1,039, server — out of scope)

### Brand Voice

The lab/apothecary metaphor runs through copy too — useful to know if the overhaul includes a copy pass:

- **Site-level:** "Mixing Science with Celebration", "Mobile Bar · Cocktail Lab", "your event's bar, engineered."
- **Marketing 3-step process:** *The Prescription* (proposal + deposit) → *The Potion Planner* (consult + menu) → *The Big Experiment* (event day).
- **Onboarding chrome:** "Welcome to the Lab", "Lab Access Requirements", "Field Guide", "Payday Protocols".
- **Blog:** *Lab Notes* (chapter-numbered).
- **Drink-plan flow:** *Potion Planning Lab*.
- **Tester program:** *Be a Lab Rat* — and yes, this is intentionally gritty/separate.

If you're rebranding, the metaphor is everywhere. If you're refreshing, the metaphor likely stays — but it's the single biggest decision to make up front.

### Cross-Cutting Consistency (CLAUDE.md)

> "If you change X, search the codebase for everything that depends on X and update it too."

Concrete rules a UI overhaul will brush against:

- **Event identity** is `event_type` + optional `event_type_custom` → render via `getEventTypeLabel()` (mirrored in `client/src/utils/eventTypes.js` and `server/utils/eventTypes.js`). No free-text title field. Falls back to the literal string `'event'` when type is unset.
- **Hosted-package bartender rule** — additional bartenders on hosted (per_guest) packages are $0 line items with $0 gratuity (BOTH the `num_bartenders` override AND the `additional-bartender` add-on path). Don't show them as paid line items in any new pricing UI. Grep `isHostedPackage` before touching bartender pricing.
- **Phone numbers** — saved as 10 digits, country code 1 stripped. UI uses `formatPhoneInput` / `stripPhone` from `client/src/utils/formatPhone.js`.
- **Dates** — proposals/shifts/drink_plans use `event_date` (date) + `event_start_time` (time) separately. Don't merge into one ISO datetime in the UI without converting.
- **NA beer brand** — endorse Athletic Brewing exclusively; never list Heineken 0.0 as a default.

### Status Color Conventions

These are repeated across surfaces — staff list, proposals dashboard, drink plans, shifts, invoices:

| State | Background | Border | Text |
|---|---|---|---|
| Pending / In progress | `#FFF3DC` | `#E5C97A` | `#8B5E0A` |
| Approved / Confirmed | `#E8F5E8` | `#90CC90` | `#1A6B1A` |
| Denied / Rejected | `#F5F5F5` | `#CCC` | `#666` |

The primary status badges in `index.css` (`badge-inprogress`, `badge-submitted`, `badge-approved`) are the canonical version. The inline pill objects in `StaffShifts.js`, `StaffSchedule.js`, etc. are duplicates that should converge with whatever the new system standardizes.

---

## What Currently Exists — Plain English

**Three brands stitched into one app.** Marketing site, applicant/contractor portal, staff portal — all the same React bundle, served on three different subdomains, with the routing in `App.js` deciding which routes are visible based on `window.location.hostname`. Token-gated pages (proposals, drink plans, invoices, shopping lists) work everywhere so an email link never hits the wrong door.

**The marketing site is small and direct.** Home, Quote (the engine — a 5-step wizard with live pricing), FAQ, Cocktail Classes (separate 4-step wizard), Lab Notes blog, plus a Sign In/My Proposals link in the nav for repeat clients. The visual language is "apothecary lab": dark serifed headings, kicker labels, amber/cream/parchment palette, IntersectionObserver fade-up animations, image-stack heroes. Everything funnels to **Get an Instant Quote**.

**The instant quote isn't a lead form — it's a real proposal builder.** The wizard hits live `/calculate` on every change, shows a pricing sidebar that updates in real time, persists drafts to localStorage and (after the contact step) to a server-side draft token so a "?resume=…" email link can pick up where they left off, and on submit creates a real DB row and sends them straight into the proposal-view page at `/proposal/:token`.

**Proposals are sign-and-pay in one breath.** The proposal page shows the event identity, what's included, line items, totals, and a single combined "Sign & Pay deposit (or full)" section. The signature is captured first, then Stripe confirms the payment in the same click. Once paid, the page swaps to a confirmation banner with the balance-due date.

**The Potion Planning Lab is the longest, most-stateful client surface.** It's a multi-phase wizard (Exploration → Refinement) attached to a paid proposal. Auto-saves every 30 seconds and on tab close, supports browser-back to navigate steps, can charge mid-flow extras through Stripe, and ends in a celebration screen that promises a shopping list + BEO within 2 business days. The ConfirmationStep is the last consumer before the back office takes over.

**Invoices and shopping lists are standalone token URLs**, both designed for phones — invoices print well, the shopping list has its own dark mobile UI with checkbox-line-through and a progress bar, completely off the rest of the site's visual system.

**The client portal is small** — OTP login, then a "My Proposals" grid of every proposal sent to that client. From a card they can view the proposal, view its drink plan, or open invoice dropdowns.

**Hiring and the staff portal share the auth pages.** The hiring host shows a 4-step "how to apply" landing, drives applicants through Register → Application → ApplicationStatus, and once the admin flips them to `hired` the same domain can host the onboarding flow (Welcome → Field Guide → Agreement → Profile → Payday → Complete). Once the contractor is `submitted` they bounce over to staff.drbartender.com which has its own sidebar app (Dashboard / Shifts / Schedule / Events / Resources / Profile). Admin/manager users get a sidebar shortcut back to admin.drbartender.com.

**Lab Rat is a deliberately off-brand tester program** with its own scoped CSS. Decide whether to leave it alone or include it in the overhaul.

**Styling is one big `index.css`.** No Tailwind, no CSS-in-JS, no design tokens beyond a few CSS variables. The proposal page (`proposalView/styles.js`) and shopping list (inline styles in `ClientShoppingList.js`) are exceptions — they each carry their own style objects independent of the global stylesheet.

---

## The Current Booking Flow (End-to-End, Plain English)

1. **Visitor lands on drbartender.com.** They see the home page (or a deep link to `/quote`). Every CTA points to **Get an Instant Quote**.

2. **They open the Quote Wizard.** Step 1 collects event details (date, guests, duration, location, alcohol provider). Step 2 (hosted only) picks a bar type and package; BYOB and mocktail paths skip this. Step 3 picks add-ons. Step 4 reviews. Step 5 collects name + email + phone — submitting fires `/api/proposals/public/capture-lead` which creates a DB lead and a draft token (so they can resume from the email).

3. **Submission creates the proposal.** Final submit posts to `/api/proposals/public/submit`, which writes the proposal row, sends the client a "Your proposal is ready!" email, and redirects them to `/proposal/:token`.

4. **They view the proposal.** ProposalView loads, shows event identity + line-item breakdown + total. If it's still unsigned and unpaid, the Sign & Pay section appears: type or draw a signature, pick deposit-only ($100) vs pay-in-full, optionally tick autopay-on-balance-due-date, then click the Stripe payment button. Signature is saved first; payment confirms; page swaps to the "Deposit Received!" banner with balance-due copy.

5. **A drink plan is created.** When the deposit lands, the Stripe webhook (in `server/routes/stripe.js`) flips the proposal to `deposit_paid`, generates a drink-plan token, and emails the client a "Plan your drinks!" link to `/plan/:token`.

6. **They go through the Potion Planning Lab — Exploration phase first.** Welcome screen → Vibe → Flavor Direction → Browse cocktails (favorite drinks + per-drink upgrades) → Mocktail Interest → Save. This phase is a "wishlist" — it doesn't commit anything; it just collects taste. Auto-saves continuously.

7. **Admin reviews the proposal.** Behind the scenes, pricing is adjusted, staff are added, the package is finalized. When the proposal is sent and accepted, the lab progresses to Refinement.

8. **The client returns and goes through Refinement.** Quick-pick a serving style (or Custom for module toggles), then per-module steps (Signature drinks with mixers/upgrades, Mocktails, Full Bar Spirits, Beer/Wine, Hosted Guest Prefs for hosted packages, Menu Design opt-in, Logistics with day-of contact + parking + bar-rental add-on). A confirmation step tallies any paid extras; if there are surcharges, the client can pay them through Stripe right inside the lab (the webhook then lands those on a "Drink Plan Extras" invoice). Submit lands a "Plan submitted!" celebration screen and emails the BEO data to admin.

9. **Balance comes due.** ~14 days before the event (configurable per proposal), the balance scheduler emails the client a payment link. They land back on the proposal token URL — now in "pay-only" mode — and pay the balance via Stripe (or autopay charges automatically). Status flips to `balance_paid`.

10. **Shopping list ships.** When the BEO/shopping list is finalized internally, the client gets a `/shopping-list/:token` URL. They view it on their phone, check items off as they shop, and the same data fuels event-day prep.

11. **Event happens.** Staff side: bartenders see the event on `staff.drbartender.com` (StaffEvents / StaffSchedule), pull their iCal feed from StaffResources, message via WhatsApp.

12. **Repeat clients log into `/login` on drbartender.com** (the OTP flow) and see all their past + current proposals on `/my-proposals`, with invoice access from the dropdowns.

**Two parallel applicant flows live in the same shell:**

- **New applicants** hit `hiring.drbartender.com` → Register → Application (8-section form with magic-byte file uploads) → ApplicationStatus card.
- **Hired applicants** log back into the same hiring host, get routed through the 6-step onboarding (Welcome → Field Guide → Agreement → Profile → Payday → Complete), and on completion get bounced to `staff.drbartender.com/dashboard` to start picking up shifts.

---

## Pieces to Decide About Before Starting

A few "is this in scope?" questions worth answering up front, because they fork the plan:

1. **Lab Rat program** — has its own scoped visual language. Leave alone, or align with new system?
2. **Shopping list dark theme** — `ClientShoppingList.js` is a wholly separate visual system (own inline styles). Mobile-first, dark, intentional. Keep as-is, or absorb into the new design system?
3. **Proposal page styling** — lives in `proposalView/styles.js` as JS objects, not in `index.css`. Decision: migrate to the new system's classes, or keep self-contained?
4. **Admin shell vs marketing** — "client facing" reads as everything except `pages/admin/` and `components/AdminLayout.js` + `components/adminos/*`. Confirm. (Staff portal is technically internal-but-external — they're contractors, not employees, and they touch the brand.)
5. **Email templates** — `wrapEmail()` and `wrapMarketingEmail()` define the visual language clients see in their inbox. They'll feel disjointed if the website changes but the emails don't. In scope?
6. **PDFs** — the signed agreement PDF (`agreementPdf.js`), invoice "Save as PDF" output, and ShoppingListPDF all carry brand. Re-skin too?

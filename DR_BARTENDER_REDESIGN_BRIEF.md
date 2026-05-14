# Dr. Bartender — Visual Redesign Brief

> Read this entire document before generating any code. This is a *visual* redesign, not a functional rebuild. Every existing route, component, wizard step, API endpoint, state machine, and business rule stays exactly as it is. You are reskinning a working app.

---

## TL;DR

Reskin Dr. Bartender's existing React app to feel like an **old-timey apothecary printing house running a contemporary cocktail-chemistry program**.

- **Brand soul:** **"Magic, but not really."** Wonder earned through expertise, not actual magic. Walter White at a wedding > Dumbledore.
- **Experience test:** **"Cool, but fun and easy to use."** In that order.
- **The "Dr." is a play on D.R. (Dallas Raby's initials).** Not a fake credential. The brand performs as Doctor Bartender; the pun is the gentle reveal you tell people.
- **Visual register:** old apothecary bottle labels — printed, typeset, formal, IM Fell typography, ornamental borders, engraved glassware. Period costume on contemporary science.

**Three structural calls already made:**

1. **Wedding-vendor mood-board posture: belong AND stand out.** Soft enough to live next to a sage-and-cream florist; distinctive enough that the bride remembers Dr. Bartender specifically.
2. **Density mixed by surface.** Atmospheric pages (Home, FAQ, Blog, HiringLanding) lean denser/layered. Functional pages (QuoteWizard, PotionPlanningLab, ProposalView, InvoicePage, portals) lean sparse and clear. Apothecary recedes when the user is working.
3. **Where chaos lives.** In the character (smirk, bowtie, mid-experiment energy) and in selected magical-realism moments (flask glow, three rainbow placements, brass pulse, iridescent hover) — never in messy/scratched-out surfaces.

**Must preserve:** every route, component, wizard step, API endpoint, accessibility primitive (skip-nav, ARIA, keyboard handlers), CSS variable name, class namespace (`ws-*`, `wz-*`, `client-*`, `lab-*`, `auth-page`, `guide-*`, `potion-*`, `invoice-*`, `step-*`). Vanilla CSS in `client/src/index.css` only — no Tailwind, no preprocessors, no CSS-in-JS.

**Reading order for ambiguity:** §2 (hard rules) → §3 (palette) → §5 (components) → §6 (per-surface) → §11 (when to ship). Use §1 to break ties. Use §10 to chunk iterations against a constrained budget.

---

## 1. Strategic Context

Three things that anchor every visual decision when the brief is silent.

### 1.1. Visual peer group is high-end wedding vendors, not other bartenders

Chicago bartender competitors are visually generic — wordmarks in navy/gold/black/burgundy. This brand is designed to belong on a wedding planner's preferred-vendor mood board next to florists, photographers, and stationers. It should NOT belong on a Yelp results page next to other bartenders.

### 1.2. The character is the moat, not the palette

No competitor has an illustrated character. The Dr. Bartender mark — when finalized — is the brand's primary differentiator. The visual system supports the character; it does not replace it. The current logo is a deliberate placeholder (§8) — design as if the real character will land on top of this system later.

### 1.3. Why teal-led with a warm anchor

Cool colors traditionally lose in F&B *product* branding (amber appetite cues), but service branding for premium events is a different decision context — clients book weeks ahead, comparing vendors, not deciding what to drink. Teal *is* differentiation in this category. Warmth doesn't disappear; it relocates to brass + aged paper + rainbow bowtie + skin tones in illustration.

### 1.4. Vendor-list gut check

When in doubt, picture the homepage thumbnail in a 12-vendor wedding mood board next to a sage-and-cream florist and a charcoal-and-dusty-rose photographer. Does it belong? If not, the choice is wrong — pull back toward the wedding-vendor lane.

---

## 2. Hard Rules — Read Before Anything Else

Non-negotiable. If a creative decision conflicts with a rule, follow the rule.

### 2.1. What you are NOT doing

- **DO NOT** change routes, page structures, wizard step counts, API endpoints, state machines, or data models. CSS / component-styling pass only.
- **DO NOT** introduce Tailwind, CSS-in-JS, CSS modules, or any new framework. Vanilla CSS in `client/src/index.css` only.
- **DO NOT** rename existing CSS variable names (`--amber`, `--deep-brown`, etc.). Only their *values* change. The codebase uses `var(--amber)` in 80+ places and we are not refactoring tonight.
- **DO NOT** rename existing class namespaces (`ws-*`, `wz-*`, `client-*`, `lab-*`, `auth-page`, `guide-*`, `potion-*`, `invoice-*`, `step-*`). They map to surfaces.
- **DO NOT** regress accessibility. Skip-nav links, `role="status"`, `role="alert"`, `aria-current`, `aria-invalid`, manual keyboard handlers — all stay.
- **DO NOT** touch admin routes (`pages/admin/`, `components/AdminLayout.js`, `components/adminos/*`). Out of scope.

### 2.2. What this brand IS NOT

- Not pirate, tavern, rum-bar, rope-and-barrel rustic
- Not Halloween, witchy, occult, or fantasy
- Not chalkboard café or kitschy themed restaurant
- Not modern SaaS or sterile minimalism
- Not Disney-cute or childish mascot energy
- Not corporate, cold, or interchangeable with a catering company
- Not a real medical or fake-credentialed brand — the "Dr." is a pun on D.R. (Dallas Raby), not a doctorate
- Not a lab notebook (no grid paper, no engineering ruled paper, no schematic blueprints)

### 2.3. What this brand IS

- Old-timey apothecary printing house running a contemporary cocktail-chemistry program
- Dark speakeasy *atmosphere* housing apothecary-lab *content*
- Professional and wedding-vendor-appropriate first; clever and characterful second
- Hand-drawn, textured, slightly imperfect surfaces with clean modern UI on top
- "I'm in good hands, and this is going to be fun" — in that order

### 2.4. The texture rule

**Textured surfaces, untextured UI.** Paper grain, ink wash, aged feel belong on backgrounds, cards, dividers, and illustration anchors. Buttons, form fields, body text, and navigation stay clean and modern. Texture is the world; UI is the interface. This is how you get "premium apothecary" instead of "Etsy storefront."

### 2.5. The rainbow rule

Iridescent / rainbow accents appear in **exactly three places**:
1. The bowtie on any character art
2. The active `.btn-primary` hover state (subtle border-glow only)
3. One signature divider element on the home page

**Nowhere else.** No rainbow backgrounds, no rainbow text, no rainbow gradients elsewhere. Restraint is what makes it feel intentional instead of nightclub.

### 2.6. The "magic, but not really" rule

The brand has wonder, but the wonder is *earned through expertise*, not theatrical magic. Magical-realism moments appear in selected places — the teal flask has a subtle inner glow (not just a teal fill); the brass auto-save indicator has a slow pulse; a CTA hover shimmers iridescently for half a second. **Never as decoration.** Always as *the science feeling alive*. If a magical moment doesn't have a real-world analog (a glow that could come from chemiluminescence, a shimmer that could come from oil refraction), it doesn't belong.

---

## 3. Color System

Replace current hex values in `:root`. **Keep variable names** so existing CSS rules resolve.

### 3.1. New token values

```css
/* Backgrounds & structure — 70% of the canvas */
--chalkboard:       #12161C   /* main page background — Midnight Ink */
--dark-ink:         #1E242B   /* secondary backgrounds, panels, sections */
--border-dark:      #313842   /* borders, dividers, subtle frames */
--border:           #4A5360   /* lighter borders on dark surfaces */

/* Light surfaces — cards live here */
--card-bg:          #E6DDCC   /* aged paper — primary card surface */
--paper:            #EDE6D6   /* lighter parchment for nested surfaces */
--paper-dark:       #D8CFBE   /* subtle darker parchment for depth */
--cream:            #F0E8D6   /* lightest neutral, light text on dark */
--parchment:        #E6DDCC
--parchment-dark:   #D4C9A8

/* Type colors */
--cream-text:       #F0E8D6   /* body text on dark backgrounds */
--deep-brown:       #1C1610   /* headings + body on aged paper cards */
--text-muted:       #5A5048   /* muted text on aged paper */
--warm-brown:       #134544   /* primary CTA hover state (deepened teal) */

/* Brand accents */
--amber:            #1D8C89   /* Deep Apothecary Teal — primary CTA + active states */
--amber-light:      #2FA7A0   /* Luminous Teal — links, focus rings */
--brass:            #B8924A   /* Antique brass — fine details, frame edges */
--plum:             #6B4D7A   /* Dusty Plum — secondary accent, hover depth */

/* States */
--success:          #2D6B5A   /* paid / positive */
--sage:             #5A8B7A   /* lighter success */
--rust:             #A0522D   /* balance due / warning */
--error:            #8B2020
--forest:           #1D5A4A   /* btn-success */
--forest-light:     #2D7A6A
```

> **Important:** the variable is still called `--amber` for backwards compatibility; the *value* is now teal. Do not rename — the codebase uses `var(--amber)` in 80+ places.

### 3.2. Why this palette (use to break ties)

- **Teal leads** because it differentiates in a category dominated by amber/gold/black wordmarks, and it photographs cleanly on dark backgrounds and parchment cards.
- **Brass anchors warmth** so the dark mood doesn't feel cold or clinical. Use on hairline dividers, frame edges, fine detail strokes, the rim of the flask in illustrations. **Never a dominant color.**
- **Aged paper** prevents pure-white shock and ties the brand to the bottle-label tradition. All cards live on aged paper.
- **Plum supports**, never leads. Hover states, secondary accents, occasional depth. If teal and plum start showing up at equal weight, the brand starts feeling mystical/witchy — pull back.

### 3.3. Usage proportions

- 70% dark neutrals (`--chalkboard`, `--dark-ink`, `--border-dark`)
- 15% teal (`--amber`, `--amber-light`) — buttons, active states, the potion
- 10% aged paper (`--card-bg`, `--paper`) — card surfaces
- 4% plum (`--plum`) — hover, secondary depth
- 1% brass (`--brass`) — frame edges, hairline dividers, small details

**Teal leads. Plum supports.** Never equal weight.

### 3.4. Status pills — DO NOT change

| State | Background | Border | Text |
|---|---|---|---|
| Pending / In progress | `#FFF3DC` | `#E5C97A` | `#8B5E0A` |
| Approved / Confirmed | `#E8F5E8` | `#90CC90` | `#1A6B1A` |
| Denied / Rejected | `#F5F5F5` | `#CCC` | `#666` |

Reused across staff, proposals, drink plans, shifts, invoices. They live on parchment cards — tuned for that.

---

## 4. Typography

### 4.1. Keep the existing font stack

- **Display:** `'IM Fell English SC', 'IM Fell English', Georgia, serif`
- **Body:** `'IM Fell English', Georgia, serif`
- Imports stay at the top of `index.css`. IM Fell is the brand. Do not propose alternatives.

### 4.2. Keep the existing scale

- Body: 17px base, line-height 1.65
- `h1`–`h3` use `clamp()`: `h1: 1.85rem → 2.75rem`, `h2: 1.4rem → 1.9rem`, `h3: 1.15rem → 1.4rem`
- `h4` is the small-caps eyebrow: 1rem, uppercase, letter-spacing 0.1em

### 4.3. Color rules

- Headings on dark surfaces: `--cream-text`
- Body on dark surfaces: `--cream-text` at 90% opacity
- Headings/body inside `.card`: `--deep-brown` (existing rule; don't break)
- Links: `--amber-light` on dark, `--warm-brown` inside cards
- Eyebrow labels (`h4`, kicker text): `--brass` on dark, `--text-muted` on cards

### 4.4. Bottle-label usage patterns

Cards and proposal panels on atmospheric surfaces (§5.0) should occasionally read like printed apothecary bottle labels:

- Small-caps eyebrow above the heading (e.g. *No. 4 · The Prescription*)
- Heading in display face, restrained size
- Optional one-line ornament rule under the heading (1px brass)
- Body in regular Fell, supporting micro-text in muted gray-brown
- Optional "ingredient list" pattern for line items: `Service` ··· `Qty` ··· `Amount` with leader dots

This is a treatment available to atmospheric surfaces. **Do not apply to functional surfaces** — see §5.0.

---

## 5. Component Styling

### 5.0. Density-by-surface — THE organizing rule

| Category | Density | Treatment | Pages |
|---|---|---|---|
| **Atmospheric** | Denser, layered | Bottle-label energy, ornament rules, kicker eyebrows, supporting micro-text | HomePage, FaqPage, Blog, BlogPost, HiringLanding, Welcome, Completion |
| **Functional** | Sparser, clear | Apothecary recedes to accents — section markers, brass hairlines, single seal on totals | QuoteWizard, ClassWizard, PotionPlanningLab, ProposalView, InvoicePage, ClientDashboard, all Staff portal pages, ContractorProfile, PaydayProtocols, Application, ApplicationStatus |
| **Middle** | Formal, uncluttered | Single card on dark, brass frame, no ornament beyond a divider | Login, Register, ForgotPassword, ResetPassword, ClientLogin, FieldGuide, Agreement |

When in doubt: respect the user's task. They're not browsing a museum — they're booking a bartender or doing paperwork.

### 5.1. Cards (`.card`, `.card-sm`, `.card-clickable`)

- Background: `--card-bg` (aged paper)
- Border: 2px solid `--brass` for primary cards (currently 3px `--border-dark` — tighten and re-color)
- Border-radius: `--radius-lg` (10px) — keep
- Shadow: `box-shadow: 0 4px 24px rgba(0,0,0,0.4), inset 0 0 0 1px rgba(184, 146, 74, 0.2)` — heavier outer shadow for depth on dark, brass-tinted inner highlight
- Subtle paper-grain texture as a low-opacity background-image overlay (5–8%). Letterpress imperfection, not heavy distress.
- Inside cards, all text flips to `--deep-brown` (existing rule — preserve)

### 5.2. Buttons

**`.btn-primary`** (every CTA):
- Background: `--amber` (teal)
- Text: `--cream-text`
- Box shadow: `0 2px 8px rgba(29, 140, 137, 0.3)`
- Hover: deepen to `--warm-brown`, `translateY(-1px)`, **subtle iridescent border-glow** (rainbow placement #2)
- Letter-spacing 0.04em, weight 600

**`.btn-secondary`**:
- Transparent background, 2px `--amber-light` border
- Inside `.card`: flip to `--deep-brown` text + `--border-dark` border (existing rule)

**`.btn-dark`**: deep `--dark-ink` background, `--cream-text`, `--brass` border on hover
**`.btn-success`**: `--forest`
**`.btn-danger`**: `--error`

**Focus state — preserve exactly:**
```css
.btn:focus-visible { outline: 2px solid var(--amber); outline-offset: 3px; }
```

### 5.3. Form inputs

Stay clean and modern. **No texture, no parchment background, no vintage flourishes on the input itself.**

- Background: `--paper` when on dark, lighter when inside cards
- Border: 1px solid `--border-dark`, 2px solid `--amber` on focus
- Text: `--deep-brown`
- Labels: existing uppercase, 0.85rem, letter-spacing 0.06em — keep

This is the texture rule (§2.4) in action. Page atmosphere = old laboratory; inputs cannot be, or the form gets unusable.

### 5.4. Dividers

- Standard `.divider`: 1px `--border-dark`
- `.divider-ornate` (italic word centered in hairline rule): keep — one of the brand's most recognizable details. Rule in `--brass`, word in `--cream-text` on dark or `--deep-brown` on parchment.
- One special divider on the home page carries the rainbow shimmer (rainbow placement #3).

### 5.5. Status badges

`.badge-inprogress`, `.badge-submitted`, `.badge-approved` — keep colors per §3.4. They live on parchment.

### 5.6. The ⚗ glyph

Already used as a brand motif in onboarding, "Lab Access Requirements", section anchors. Keep. Color `--brass` on dark, `--deep-brown` on cards. **DO NOT add new ornamental glyphs** — restraint is the rule.

---

## 6. Surface-by-Surface Direction

Organized by the density categories from §5.0.

### 6.1. Atmospheric surfaces

**`PublicLayout.js` — header + footer**
- Header: `--chalkboard` background, brass hairline divider at the bottom, logo + nav links in `--cream-text`, "Get an Instant Quote" CTA in `--amber`. Mobile nav drawer slides from right with same dark treatment.
- Footer: same dark base, tighter padding, brass hairline at top.

**`HomePage.js`**
- Hero on `--chalkboard` with subtle paper-grain overlay; headline in display font (`--cream-text`), kicker eyebrow in `--brass`. One strong illustration as the anchor — not stock photography, not a collage.
- Services grid: 3 image cards on `--card-bg` parchment with brass frame. Hover lifts subtly.
- "How It Works" alternating rows: keep the current image-text pattern, restyled with parchment cards on dark. Step numbers in `--brass`.
- "Why Dr. Bartender" stats: 3 stats on dark. Brass accent above each number, cream-text number, muted-cream label.
- Testimonials: parchment card style. Keep the live Thumbtack pull + fallback logic.
- CTA banner before footer: full-bleed dark, teal CTA centered. **Rainbow shimmer divider (placement #3) lives here.**

**`FaqPage.js`**
- Accordion items as flat parchment strips on dark, brass hairline between them, chevron in `--brass`. Open state expands with smooth `0.18s ease`.

**`Blog.js` (Lab Notes index) & `BlogPost.js`**
- Index: chapter-numbered post cards in parchment, brass chapter number, deep-brown title, muted excerpt. Cover images stay.
- Detail: dark background, parchment "scroll" content card centered (~700px max-width), TipTap-rendered body in `--deep-brown`. Back-link header + footer in `--brass`.

**`HiringLanding.js`**
- Hero in dark with one strong illustration. 4-card "1 → 2 → 3 → 4" process strip in parchment cards on dark, each with brass numeral.
- "Apply Now" CTA in teal.

### 6.2. Functional surfaces

**`QuoteWizard.js` — the engine** (this one matters most)
- Step dots at top: filled = `--amber` (teal), current = `--amber` with `--brass` ring, future = `--border-dark`. Connector line in `--border-dark`.
- Two-column layout (existing): left form column on dark with cream-text labels; right pricing sidebar in a parchment card (live numbers feel weighty and scroll-stable).
- Package and add-on cards: parchment with brass hairline border. Selected = teal accent. Hover = plum tint.
- "Welcome back" resume banner: brass hairline.
- Live `/calculate` is sacred — do not touch the recalculation hook.

**`ClassWizard.js`** — same treatment as QuoteWizard.

**`PotionPlanningLab.js`** (the long stateful wizard)
- This file is over 1000 lines. **If you touch it, you split it** per `CLAUDE.md`. Split by phase: `ExplorationPhase.js` and `RefinementPhase.js`. Parent is a thin orchestrator.
- Visual: dark base, parchment step cards, teal active states, brass section dividers. Auto-save indicator gets a slow brass pulse — magical-realism placement.
- Each step (Welcome, Vibe, FlavorDirection, ExplorationBrowse, etc.): parchment content card with comfortable padding, kicker label in brass, headline in display font, content in clean modern type.
- Drink cards in `SignaturePickerStep`: parchment with brass frame, teal selected state, per-drink upgrade chips in plum.

**`ProposalView.js`** (styles live in `proposalView/styles.js` as JS objects)
- **Migrate the styles object's hex values to the new palette.** Don't move it into `index.css` — the isolation is intentional.
- Header: dark band with event identity card in parchment.
- Pricing breakdown: parchment card, line items in `--deep-brown`, totals row in display font with brass top-border.
- Sign-and-pay section: parchment card. Signature pad gets a brass frame. Stripe Elements inherit the form-input style. "Deposit Received!" success banner uses sage/forest from §3.

**`InvoicePage.js`**
- Print-friendly is the priority — keep existing layout structure. Parchment-on-white-print, brass dividers, deep-brown text. "PAID" stamp in brass.
- Stripe Pay button uses `.btn-primary` (teal).

**`ClientShoppingList.js`** (mobile-first dark theme, own inline styles)
- **Keep as-is for v1.** Mobile-first and intentionally off-brand for in-store glance utility. If touched, just retune the palette to match (replace amber-orange with teal, keep the dark mobile shell).

**`ClientDashboard.js` ("My Proposals")**
- Grid of parchment cards. Status badges per §3.4. "View Proposal" CTA in teal. `InvoiceDropdown` inherits the card's brass-bordered style.

**`Application.js`** (8 sections)
- Long form, sectioned. Each section header: h2 with kicker brass eyebrow above. Form inputs per §5.3. Section anchors get a brass `⚗` glyph.

**`ApplicationStatus.js`**
- Status-aware card. Each status uses the matching pill color from §3.4.

**`StaffLayout.js` + staff pages** (Dashboard, Shifts, Schedule, Events, Profile, Resources)
- Dark sidebar (`--dark-ink`), nav items in cream-text, active item in teal, brass divider between primary and secondary nav.
- Cross-domain "Admin Portal" link at top for admin/manager users gets brass treatment.
- Content area on dark with parchment KPI tiles and event cards. Status pills per §3.4.
- "Next Event" card on the dashboard: larger parchment card, brass top-border, event details in deep-brown.

**`ContractorProfile.js`, `PaydayProtocols.js`** — long forms; same form-input treatment as Application. W9Form inside PaydayProtocols inherits `.form-input`.

### 6.3. Middle surfaces (formal, uncluttered)

**`Login.js`, `Register.js`, `ForgotPassword.js`, `ResetPassword.js`, `ClientLogin.js`**
- All use the existing `auth-page` namespace with the chalkboard backdrop. Keep the namespace; restyle the card on top: parchment card, brass frame, teal CTA, deep-brown body.
- ClientLogin's two-column desktop layout: left = login card (parchment), right = benefits panel (dark with teal icons). Stack on mobile. Neutral OTP success message stays — it's a security feature.

**`Layout.js` (onboarding wrapper)**
- 6-step progress bar at top. Completed = teal fill, current = teal with brass ring + slow pulse, future = `--border-dark`. Percent-complete bar underneath in teal.
- Click-back to completed steps preserved. `aria-current="step"` and `role="navigation"` preserved.

**`Welcome.js`, `FieldGuide.js`, `Agreement.js`, `Completion.js`**
- Parchment content cards on dark. FieldGuide section navigation gets brass section anchors.
- Agreement signature pad: brass-framed, deep-brown ink color.

### 6.4. Out of scope

**Lab Rat (`pages/labrat/*`, `labrat.css`).** Intentionally off-brand tester program. Don't touch in this overhaul.

**Email templates (`server/utils/emailTemplates.js`).** Deferred to a follow-up PR after the website ships. The redesign creates dissonance otherwise (clients book on a teal-and-parchment site, then get an amber-and-cream email), so this *will* happen — just not in this brief. Update `wrapEmail()` and `wrapMarketingEmail()` separately.

**PDFs (`agreementPdf.js`, invoice "Save as PDF", `ShoppingListPDF.jsx`).** Out of scope for v1. Different rendering pipelines (PDFKit, html2pdf, jsPDF). Update separately.

---

## 7. Motion & Magic

The brand's "magic, but not really" energy lives almost entirely in motion. Restraint is the rule; the magical moments are exceptions.

**Keep (existing motion):**
- `0.18s ease` button transition
- `.ws-fade-up` IntersectionObserver fade on the marketing site

**The five magical-realism moments — implement these:**

1. **Flask glow** — the teal flask in any character art (logo, hero, package card seal) has a subtle inner luminance. Soft radial gradient from a brighter teal core. Doesn't pulse; it's just *alive*.
2. **Rainbow shimmer on the bowtie** — the character bowtie has a gentle iridescent shift when its containing element scrolls into view (rainbow placement #1).
3. **Iridescent CTA hover** — `.btn-primary` hover gets a half-second border-glow shimmer (rainbow placement #2). Subtle. Not a nightclub.
4. **Signature divider shimmer** — one divider on the home page, before the closing CTA banner, has a slow rainbow shimmer animation (rainbow placement #3).
5. **Brass pulse on auto-save** — `PotionPlanningLab.js` auto-save indicator (every 30s) gets a soft brass pulse. The brand winking at the user.

**Forbidden:** parallax, heavy gradient animations, cursor effects, scroll-jacking, full-page transitions. The dark mood is the atmosphere — restraint sells it.

---

## 8. Logo Placeholder

The real character logo is the brand's primary differentiator (§1.2). It is not yet locked. **Render `BrandLogo.js` as a deliberately minimal placeholder** so the wrong identity doesn't anchor design decisions before the real character mark lands.

**Placeholder spec:**

- Circular badge, ~64px in headers / ~48px in mobile
- Brass border (2px), aged-paper interior
- Centered "Dr." in display font on top, "Bartender" below, `--deep-brown` text
- Small `⚗` glyph between or beside the text in `--brass`

**Replacement plan:** when the real character mark is ready, the swap is one line — replace the contents of `BrandLogo.js` with an `<img>` tag (or inline SVG). Build the placeholder so the swap is trivial.

---

## 9. Brand Voice

Lab/apothecary metaphor runs through copy and stays. **Voice principle: clarity first, flavor second. 80% clear / 20% character.** No copy changes in this PR.

Existing locked phrasings: *Mixing Science with Celebration*, *your event's bar, engineered.*, *The Prescription → The Potion Planner → The Big Experiment*, *Welcome to the Lab*, *Lab Access Requirements*, *Field Guide*, *Payday Protocols*, *Lab Notes* (chapter-numbered), *Potion Planning Lab*.

---

## 10. Sequencing — Generate in Stages

**This brief is consumed in stages, not one pass.** Generate Stage 1, stop, await review before Stage 2. Caps each iteration's surface area to fit a constrained iteration budget.

1. **Token swap.** Update `:root` in `index.css` with the new palette. The entire app shifts to new colors immediately. Smoke-test every page. **Stop.**
2. **Primitives.** `.card`, `.btn-*`, `.form-*`, `.divider`, `.divider-ornate`, status badges, the ⚗ glyph. These cascade everywhere. **Stop.**
3. **Public marketing.** `PublicLayout`, `HomePage`, `FaqPage`, `Blog`, `BlogPost`. **Stop.**
4. **Quote wizard.** `QuoteWizard` + steps + `ClassWizard`. **Stop.**
5. **Token-gated client pages.** `ProposalView` (migrate `styles.js` hex values), `PotionPlanningLab` (split if you touch it). **Stop.**
6. **Auth + portal.** `ClientLogin`, `ClientDashboard`, `Login`, `Register`, `ForgotPassword`, `ResetPassword`. **Stop.**
7. **Hiring + onboarding.** `HiringLanding`, `Application`, `ApplicationStatus`, the 6-step onboarding shell. **Stop.**
8. **Staff portal.** `StaffLayout` + staff pages. **Stop.**
9. **Invoice page.** **Stop.**
10. **Email templates.** Follow-up.
11. **PDFs.** Separate, later.

Each stage = one PR if shipping, one iteration if generating. Smaller diffs = faster review = fewer regressions.

---

## 11. Quality Gates — When to Ship vs. When to Iterate

Before calling any stage done:

- [ ] Skip-nav link works on every layout
- [ ] All `role="status"`, `role="alert"`, `aria-current`, `aria-invalid` preserved
- [ ] Keyboard activation (Enter/Space) on clickable non-button rows still works
- [ ] Focus-visible outlines visible on all interactive elements
- [ ] Every page tested on mobile — no responsive regressions
- [ ] `useFormValidation` hook + `<FieldError>` + `<FormBanner>` chain still functional
- [ ] Stripe Elements load and confirm payments (`ProposalView`, `InvoicePage`, `PotionPlanningLab` extras)
- [ ] Auto-save in `PotionPlanningLab` still fires every 30s + on unload
- [ ] Localstorage draft persistence in `QuoteWizard` still works ("Welcome back" banner)
- [ ] Status pill colors (§3.4) unchanged across staff, proposals, drink plans
- [ ] No file over 1000 lines without `// claude-allow-large-file` + reason
- [ ] No new framework, preprocessor, or styling system introduced
- [ ] CSS variable names preserved (only values changed)
- [ ] Class namespaces preserved
- [ ] **Vendor-list gut check:** picture the homepage thumbnail in a 12-vendor wedding mood board. Does it belong next to a sage-and-cream florist?

**Stop-iterating rule:** if every gate above passes, **ship**. Do NOT propose further refinements. The brief is constrained intentionally. The brand wins on restraint. A perfectly tuned dark surface with one well-placed brass hairline beats a busy parchment-everything page every time.

---

## 12. Reference

The full surface inventory and codebase architectural notes are in **`CLIENT_FACING_SURFACES.md`** (repo root). Read it before starting. Source of truth for which files exist, which routes mount where, and what each surface does.

Cliffs notes:
- Four hosts: `drbartender.com`, `hiring.drbartender.com`, `staff.drbartender.com`, `admin.drbartender.com` (admin out of scope)
- Token-gated pages mount on every host: `/proposal/:token`, `/plan/:token`, `/invoice/:token`, `/shopping-list/:token`
- Routing decided in `client/src/App.js:137-144` based on `window.location.hostname`
- One global stylesheet (`client/src/index.css`) plus two intentional exceptions (`labrat.css`, `proposalView/styles.js`)

---

**Final note:** when in doubt, choose restraint. This brand wins on *atmosphere*, not maximalism. Every magical moment costs a little restraint somewhere else — spend the magic where it's earned.

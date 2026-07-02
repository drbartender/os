# Proposal Compare Page — Apothecary Reskin Prompt

> **What this is:** a per-surface prompt for the repo-linked design session. The page
> `client/src/pages/proposal/compare/ProposalCompare.js` is functionally final and wired to
> real data, but it is visually plain: it renders on a light cream placeholder canvas with
> white cards, while every other public token page (most importantly the proposal it hands
> off to) lives on the dark Apothecary Press canvas. **Your job is surface polish only.** The
> design tokens are already in the codebase (`client/src/index.css` `:root`, mirrored in
> `client/src/styles/drb-tokens.css`); do not invent a palette, and do not touch the wiring
> called out in section 4.
>
> **Generated:** 2026-07-02 from `main`. **Surface:** public client-facing token page, part
> of the proposal / sign-and-pay money funnel (not the admin app).

---

## 0. TL;DR

`/compare/:token` is the **"compare your options" sales page**: two or three event bar
packages shown side by side from a single link, each with a **"Choose this one"** button that
hands the client off to that option's normal sign-and-pay proposal page. It is pure
presentation. There is no card entry, no gratuity, no agreement, and no mutation on this page.
The client audience is mobile-heavy and unauthenticated (a UUID in the URL is the only key).

Today it is a placeholder skin. Reskin it to match the proposal page it feeds into
(`client/src/pages/proposal/proposalView/`): the **dark chalkboard stage with aged-paper /
parchment cards, antique-brass hairlines, teal primary action, and IM Fell display type**.

---

## 1. The surface and route

- **Route:** `/compare/:token` (registered four times in `App.js`, once per host router branch;
  all four resolve to the same lazy-loaded `ProposalCompare` component). `:token` is the
  `proposal_groups` UUID, not a proposal token.
- **Public and unauthenticated.** No login, no JWT, no `PublicLayout` marketing header/footer.
  The component owns the full viewport (`minHeight: 100vh`, its own background), exactly like
  the proposal view page. Design the whole canvas.
- **Where it sits in the funnel:** admin sends one email with one "Compare your options" link,
  the client lands here, weighs the options, and clicks through to sign and pay. This is a
  **client-facing sales moment** and often the first premium impression of the brand.
- **Mobile-heavy.** Assume phones are the primary device. The two or three columns must stack
  cleanly and stay comparable at narrow widths.

---

## 2. Design system — "Apothecary Press"

Use the tokens already defined in `client/src/index.css` `:root` (and the `.drb-*` component
sheet in `client/src/styles/drb-tokens.css`). **Variable names are stable even though the
values shifted from amber to teal**: `--amber` is the primary teal, not an amber.

### Palette (defined tokens to use)
| Token | Value | Role |
|---|---|---|
| `--chalkboard` | `#12161C` | Page canvas (near-black). The dark stage. |
| `--dark-ink` | `#1E242B` | Secondary dark surface |
| `--paper` / `--card-bg` | `#EDE6D6` / `#E6DDCC` | Aged-paper card surfaces (gradient top / bottom) |
| `--parchment` | `#E6DDCC` | Parchment fills |
| `--cream-text` | `#F0E8D6` | Text on the dark canvas |
| `--deep-brown` / `--ink` | `#1C1610` | Text on paper cards |
| `--text-muted` | `#5A5048` | Muted labels, taglines, secondary lines |
| `--amber` | `#1D8C89` | **Primary CTA** ("Choose this one"). Named amber, value is Apothecary Teal. |
| `--warm-brown` | `#134544` | CTA hover (deepened teal) |
| `--brass` | `#B8924A` | Hairlines, frames, kickers, badges, micro-labels |
| `--brass-bright` | `#D6AE65` | Brass hover highlight |
| `--success` | `#2D6B5A` | Success/paid green (if needed) |
| `--error` | `#8B2020` | Error text |

### Type & shape
| Token | Value |
|---|---|
| `--font-display` | `'IM Fell English SC', 'IM Fell English', Georgia, serif` (headings, kickers, buttons, labels) |
| `--font-body` | `'IM Fell English', Georgia, serif` |
| `--radius` / `--radius-lg` | `6px` / `10px` |
| `--shadow-card` | `0 4px 24px rgba(0,0,0,0.4), inset 0 0 0 1px rgba(184,146,74,0.22)` |

Micro-labels are uppercase, letter-spaced ~`0.18em`. Kickers are uppercase, letter-spaced
~`0.22em`. Taglines are italic. On-paper regions flip body text to `--deep-brown`; text on
the chalkboard uses `--cream-text` (the `.drb .on-paper` convention in `drb-tokens.css` shows
the pattern).

### Match the sibling proposal page
The page the client clicks into is `ProposalView` (`proposalView/styles.js` +
`.proposal-*` / `.sign-pay-*` classes in `index.css`): a **dark chalkboard page** (with an
optional `/static/chalkboard_background.png` grain) carrying **parchment "scroll" cards**,
brass hairline dividers, IM Fell display headings, and a teal (`--amber`) CTA with
`box-shadow: 0 2px 10px rgba(29,140,137,0.32)`. The compare page should feel like the same
world, one step earlier. Pulling the compare canvas onto `--chalkboard` and rendering the
option columns as aged-paper cards is the natural target.

---

## 3. Data the page has (do not invent fields)

The page calls `axios.get(BASE_URL + '/proposals/group/:token')`. The response shape is fixed
by `server/routes/proposals/compareGroup.js` (`shape()`), a positive allowlist that
deliberately excludes admin notes, Stripe IDs, signatures, and any other private field. **Only
the fields below exist. Do not design around a description blurb, hero image, star rating,
"most popular" flag, per-option guest count, or anything not listed.**

**Top level**
- `group_token` (UUID string)
- `decided` (boolean; true once a member has been paid/booked)
- `chosen_token` (proposal token string, or null)
- `client_name` (string or null)

**`event_header`** (shared across all options, shown once)
- `event_type`, `event_type_category`, `event_type_custom` (feed `getEventTypeLabel(...)` for
  the display label; never concatenate into a title)
- `event_date`, `event_start_time`, `event_duration_hours`
- `guest_count`
- `event_location`

**`options[]`** (2 or 3 entries; render side by side)
- `id`, `token`, `status`
- `package_name`
- `package_slug`
- `package_category` (e.g. `hosted`)
- `pricing_type` (e.g. `per_guest`; drives the BYOB vs Hosted badge)
- `total_price` — **dollars, not cents** (proposals store dollars). Render via `fmt()`.
- `deposit_amount` — **dollars**. Falls back to `100` when null.

**Client-side enrichment (present, not from the API).** For each option the page calls
`getPackageBySlug(option.package_slug)` against the local catalog
(`client/src/data/packages.js`) to get:
- `detail.tagline` (italic line under the package name)
- `detail.sections[]` = `[{ heading, items: [...] }]` — the "what's included" lists. Item
  strings carry a witty description after an en-dash separator (`"Tito's Vodka – ..."`);
  `itemName()` strips it so two tiers show clean, scannable names that align row to row.
- When `getPackageBySlug` returns nothing (class or custom packages), the column shows the
  single line **"Full details on the next page."** instead of sections. Design this fallback
  column too.

---

## 4. Hard wiring constraints (do NOT break)

These are the seams that keep the money funnel intact. Restyle freely around them, but do not
change the logic, the URLs, the data flow, or the state guards.

1. **The two redirect effects must stay.** A **decided** group
   (`data.decided && data.chosen_token`) redirects to `/proposal/:chosen_token?choose=1`
   (`replace: true`). A group with a **single visible option** redirects to
   `/proposal/:options[0].token?choose=1`. Both are `navigate(..., { replace: true })`. Do not
   remove or reorder them.
2. **`?choose=1` is load-bearing on every proposal link.** The "Choose this one" button and
   both redirects append `?choose=1`. It is the compare-to-proposal handoff marker that stops
   the proposal page from bouncing the client back here into a loop. Keep it verbatim on every
   link out.
3. **Keep every state branch.** loading, error (with its retry rules), and the
   redirect-in-progress guard `if (!data || data.decided || options.length < 2) return null`
   must all remain. You may restyle the markup inside each branch; you may not delete a branch
   or change what triggers it.
4. **Do not touch the data fetch.** The raw `axios.get` against `BASE_URL` is intentional for
   this public token page (it mirrors the proposal view; there is no auth to attach). Leave the
   fetch, the `reloadKey` retry, and the response shape exactly as they are. This is surface
   polish, not a refactor.
5. **No new API fields.** Render only what section 3 lists (plus the client-catalog
   enrichment). Do not add data that would require a server change.
6. **No em dashes in any client copy** you add or change. Use commas, periods, colons, or
   parentheses. (The en-dash inside catalog item strings is data, handled by `itemName()`;
   leave it alone.)
7. **Vanilla CSS only.** Inline style objects (the existing `S` map) or new `.compare-*`
   classes added to `client/src/index.css`. No Tailwind, no CSS modules, no styled-components,
   no new dependencies. This is Create React App on React 18.
8. **Cosmetic mirrors stay cosmetic.** The BYOB vs Hosted badge (`pricing_type` /
   `package_category`) and the `fullPaymentLikely(eventDate)` deposit line ("Reserve with a
   $X deposit" vs "Full payment due at booking") are display-only mirrors of server rules.
   Keep the logic; restyle the presentation.

---

## 5. States to design

| State | What renders | Notes |
|---|---|---|
| **Loading** | Centered "Loading your options..." | Style the empty/centered layout; a brass or teal loading motif fits the theme. |
| **Error (gone)** | Centered "This comparison is no longer available." | 404 case. **No retry button.** |
| **Error (transient)** | Centered "Something went wrong loading your options." + **"Try again"** button | The retry re-runs the fetch. Style the button (currently an outline brass button). |
| **Two options** | Shared header card + 2 columns side by side | The common case. Columns must feel weighable against each other. |
| **Three options** | Shared header card + 3 columns | Must still read and compare on a phone (stacking is fine). |
| **Fallback column** | Package name + badge + total + "Full details on the next page." | For class/custom packages with no catalog sections. Do not leave it looking broken next to a full column. |
| **Decided / single option** | Nothing (returns null, redirect fires) | Do **not** build a "you chose X" screen here; that lives on the proposal page. Just know these states exist so you never design a lone one-column compare. |

The content region is only ever reached with **2 or 3** visible options; the server and the
guard redirect 0-option and 1-option groups away before render.

---

## 6. Design intent

- **Premium sales moment.** This is often the client's first polished brand impression before
  they commit money. It should feel considered and calm, in the same apothecary world as the
  proposal page, not a generic pricing table.
- **Clarity of comparison first.** The whole point is helping the client weigh two or three
  packages. Keep the price prominent and consistent across columns, keep the "what's included"
  section headings aligned row to row (that alignment is why `itemName()` strips descriptions;
  do not re-add per-item blurbs, it would break the scan), and make the differences easy to
  see at a glance.
- **One clear action per column.** "Choose this one" is the only control on the page. It is the
  primary teal (`--amber`) CTA. Nothing should compete with it.
- **Works on phones.** Columns stack gracefully; totals and the CTA stay obvious after the
  stack; the shared header (date, start time, guests, location) stays legible and does not
  crowd the options.
- **Voice.** The existing copy is plain and warm ("Compare your {event type} options.",
  "Your Options · For {name}"). Apothecary flourish in the chrome (kickers, hairlines, brass
  detail, IM Fell type) is welcome; keep the words themselves clear and free of em dashes.

---

## 7. Current implementation notes (context, not a spec to preserve verbatim)

- Styling today is a single inline `S` style-object map at the top of `ProposalCompare.js`.
  It references `var(--brass)`, `var(--text-muted)`, `var(--ink)`, `var(--font-display)`
  (all defined) but also `var(--bg, #faf7f2)`, `var(--card, #fff)`, and `var(--line, #e5ded2)`
  — and **`--bg`, `--card`, and `--line` are not defined anywhere in `:root`**, so the page
  currently paints from those light fallbacks. That is exactly why it reads as a plain light
  placeholder. Swap those to defined tokens (`--chalkboard` / `--dark-ink` for the canvas,
  `--paper` / `--card-bg` for cards, a brass-tinted hairline for lines) rather than leaning on
  undefined fallbacks. If you genuinely need a new global token, add it to `:root` in
  `index.css`; do not scatter new undefined names.
- The sibling proposal page uses a **hybrid** approach (inline `S`/`styles.js` objects for the
  content, plus dedicated `.proposal-*` classes in `index.css` for the new chrome like the
  parchment scroll and workshop-bench cards). Either continue the inline-object approach with
  real tokens, or lift the compare chrome into new `.compare-*` classes in `index.css`. Both
  are acceptable; both must stay vanilla CSS.
- `fmt`, `formatDateShort`, and `formatTime` are imported from `proposalView/helpers.js`.
  `getEventTypeLabel` from `utils/eventTypes.js`. `getPackageBySlug` from `data/packages.js`.
  Leave these imports and their call sites; they produce the display strings you are styling.

---

## 8. Warnings for the design session

1. **This page is inside the money funnel.** It touches no money surface itself, but it is the
   on-ramp to sign-and-pay. Treat the redirect logic and `?choose=1` marker (section 4.1, 4.2)
   as untouchable. A broken handoff means a client cannot book.
2. **The columns are fed by two sources.** Package name, badge, total, and deposit come from
   the API; the tagline and the "what's included" sections come from the **client-side catalog**
   (`getPackageBySlug`). Do not assume everything visible is in the API response, and do not try
   to move catalog detail into the API.
3. **Do not design a one-column or decided state here.** Those redirect away by design. A lone
   column or a "you booked X" screen on this route would be dead UI.
4. **Undefined tokens are the trap.** `--bg`, `--card`, `--line` render only via their inline
   light fallbacks. If you keep referencing them without defining them, the page stays light and
   off-brand. Resolve them to real apothecary tokens.
5. **Verify the client build.** Client lint is only enforced by Vercel CI. After changes, a
   local `CI=true react-scripts build` in `client/` catches the warnings that would fail the
   deploy.

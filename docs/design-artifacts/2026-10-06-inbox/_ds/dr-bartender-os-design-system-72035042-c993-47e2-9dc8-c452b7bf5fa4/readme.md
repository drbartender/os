# Dr. Bartender OS — Design System

The back-office design system for **Dr. Bartender** — the admin console at
`admin.drbartender.com` (all `/admin/*` pages) and the mobile staff portal at
`staff.drbartender.com`. This is the **operations** system: dense, professional,
keyboard-driven — think Linear / Vercel, not a wedding-vendor site.

> **This is NOT the apothecary brand.** No IM Fell serif, no parchment, no ⚗
> flask, no brass hairlines. Those belong to the public marketing site
> (`drbartender.com`) and are a *separate* system. If a design needs warm paper
> and Victorian serifs, you are in the wrong system. The one place the two
> touch is the House Lights skin, which borrows a warm-paper palette — but the
> type is still Inter/Caslon-sans, never IM Fell.

## Identity

- **Brand mark:** `℞` (prescription-R). Renders in an accent square in the
  sidebar brand and staff topbar.
- **Wordmark:** "Dr. Bartender **OS**" (OS in muted ink).
- **Character:** utilitarian, information-dense, fast. Command palette (⌘K),
  collapsible rail sidebar with tooltips, metric tiles, sparklines, area charts,
  kebab overflow menus, right-side detail drawers.

## Sources

Built by reading the live product source in the GitHub repo
**[drbartender/os](https://github.com/drbartender/os)** — explore it to build
higher-fidelity work:

- `client/src/index.css` — the `[data-app="admin-os"]` + `[data-skin]` token
  blocks (neutral surfaces, ink, lines, type scale) and every component rule.
  The `--sp-*` staff tokens live in the same file.
- `client/src/components/adminos/*` — Sidebar, Header, Toolbar, CommandPalette,
  KebabMenu, Drawer, StatusChip, StaffPills, Sparkline, AreaChart,
  MetricsFilterBar, Icon, DocumentPreviewModal, nav, format.
- `client/src/components/StaffShell.js`, `StaffUserPillMenu.js` — the staff PWA
  shell.
- `client/src/context/UserPrefsContext.js` — the palette / skin / density /
  sidebar preference model (the "rainbow" palette values used here).

Neutral surfaces and the type scale are lifted **verbatim** from index.css.
The semantic hues follow the **"rainbow" palette** (see Token Architecture).

## Axes

Every surface flexes along four axes, all driven by `data-*` attributes on the
app root (`<html>` in production, or any wrapper here):

| Axis | Attribute | Values |
|---|---|---|
| Skin | `data-skin` | `dark` (After Hours — **default**) · `light` (House Lights) |
| Density | `data-density` | `comfy` (**default**) · `compact` |
| Sidebar | `data-sidebar` | `full` · `rail` (icon rail + hover tooltips) |
| App scope | `data-app` | `admin-os` · `staff` |

## Token Architecture

Tokens are HSL semantic hues + literal neutral scales, scoped under
`[data-app="admin-os"]` and split by `[data-skin]`. Keep the HSL structure
(`--accent-h/s/l`, `--ok-*`, `--warn-*`, `--danger-*`, `--info-*`, `--violet-*`)
— components read them as `hsl(var(--ok-h) var(--ok-s) 52%)`.

**Semantic hues — "rainbow" palette, by skin:**

```css
[data-app="admin-os"][data-skin="dark"] {   /* AFTER HOURS */
  --accent-h: 212; --accent-s: 78%; --accent-l: 44%;   /* cobalt blue */
  --ok-h: 168;    --ok-s: 62%;      --warn-h: 192;  --warn-s: 72%;
  --danger-h: 262; --danger-s: 62%; --info-h: 224;  --info-s: 72%;
  --violet-h: 280; --violet-s: 68%;
}
[data-app="admin-os"][data-skin="light"] {  /* HOUSE LIGHTS */
  --accent-h: 120; --accent-s: 16%; --accent-l: 20%;   /* deep muted green */
  --ok-h: 120;    --ok-s: 16%;      --warn-h: 36;   --warn-s: 62%;
  --danger-h: 10; --danger-s: 58%;  --info-h: 208;  --info-s: 36%;
  --violet-h: 280; --violet-s: 40%;
}
```

**Neutrals (verbatim from index.css):** dark surfaces `#0b0d10 → #1f242b`
(bg-0…3) + `#1b2028` elev; ink `#eef1f4 / #b8c0cc / #7c8593 / #565d69`. Light
"warm paper" surfaces `#f7f4ec → #e7e3d6` + `#fcfaf4` elev; ink
`#1a1a1a / #3d3a33 / #7a7468 / #b4ac9b`. House Lights also carries literal
jewel-tone supports (`--ms-emerald / --ms-camel / --ms-bordeaux / --ms-navy`)
for cases where an HSL ramp would wash out.

The staff portal mirrors the same model under `[data-app="staff"]` with the
`--sp-*` prefix.

### Export blocks

```css
[data-app="admin-os"][data-skin="dark"]  { /* After Hours — full token set */ }
[data-app="admin-os"][data-skin="light"] { /* House Lights — full token set */ }
```

See `tokens/colors.css` for the authoritative source.

## WCAG contrast audit

Measured with the WCAG 2.1 relative-luminance formula. AA = 4.5:1 (normal
text), 3.0:1 (large text / UI).

**After Hours (dark) — passes**
- Body ink `#eef1f4` on page — **17.2** ✓ · muted ink-3 — **5.2** ✓
- `btn-primary` white on accent — **5.3** ✓
- Status chip text (raised lightness): ok **10.3**, warn **9.2**,
  danger **6.7**, info **5.7**, violet **7.7** — all ✓

**⚠ After Hours — flags**
- **Accent as text on panels** (`--accent`, l=44%) — **3.47:1**. Fails AA for
  normal-size text; passes AA-large (3.0). It reads fine as fills, borders, the
  active-nav stripe, and the ℞ mark, but avoid it for small body links. The
  status/queue tints deliberately use **l≥58%** for text to clear AA — mirror
  that if you tint accent text on dark.
- **danger / violet** were the specific hues to watch: at the chip text
  lightness used here (danger 72%, violet 74%) they clear AA (6.7 / 7.7). At
  full saturation mid-lightness (l≈52%) they drop toward ~3.5 — keep danger/
  violet **text** at l≥66% on dark.

**House Lights (light) — flags**
- **Warn / camel `#b8832a` on paper** — **3.02:1**. Fails AA normal text; use it
  only for large numerals, icons, and chip borders — not small body copy.
- Muted ink-3 `#7a7468` — **4.22:1**, marginally under AA; fine for secondary
  meta, avoid for primary reading text.
- Emerald **11.0**, bordeaux **6.2**, navy **6.3**, accent green **11.4** — ✓

## Content fundamentals

- **Voice:** terse, operational, second-person-implied. Labels are nouns
  ("Events", "Proposals", "Needs you", "Tip Card"), never sentences. Buttons are
  verbs ("Assign staff", "New proposal", "Confirm").
- **Casing:** Title Case for nav + buttons; ALL-CAPS + wide tracking only for
  small eyebrow/section labels (`stat-label`, `sidebar-section`). Sentence case
  for helper text.
- **Numbers are first-class:** money and counts render in JetBrains Mono with
  tabular figures; `—` for null. Money uses `$` with no decimals in dense views
  (`$4,200`), two decimals in detail (`$4,200.00`).
- **Product vocabulary:** Events, Proposals, Clients, Staff/Staffing, Hiring,
  Financials, Tips & Feedback, Drink Plans, Cocktail Menu, **Lab Notes** (blog),
  **Lab Rat Bugs** (tester issues). The mode names are **After Hours** (dark) and
  **House Lights** (light).
- **No emoji** in the OS chrome. Status is a colored dot + word, not an emoji.

## Visual foundations

- **Type:** Inter across the UI (explicitly *not* IM Fell). JetBrains Mono for
  all numerics, code, keycaps, timestamps. House Lights swaps the *display* +
  numeric faces to **Libre Caslon Text** for an editorial feel — body stays
  sans. Dense px scale: 26 display / 22 title / 13 body / 12.5 UI / 11 label /
  10.5 micro.
- **Surfaces:** flat, layered near-blacks on After Hours (page → panel → card →
  input, each a step lighter); warm paper with hairline rules on House Lights.
  Cards are `1px` line + subtle shadow on dark, **borderless/shadowless** with a
  single ink hairline on light.
- **Radius:** 6px default, 4px small, 10px large. House Lights deliberately
  **squares** many elements (radius 0) — toggles, chips, tab underlines, buttons
  — for an editorial, printed feel.
- **Borders over shadows:** elevation is mostly a lighter surface + a `1px`
  line. Real shadow is reserved for floating layers (palette, drawer, kebab,
  modals) via `--shadow-pop`.
- **Motion:** fast and functional (80–200ms) — background/border/color
  transitions, drawer slide-in, scrim fade. No bounces, no decorative loops.
- **States:** hover = a `--row-hover` wash (a few % white on dark, warm gray on
  light) + brighter ink; active-nav = `--row-active` accent wash + a 2px inset
  accent stripe; press relies on the wash, not scale. Focus = 2px accent ring,
  2px offset.
- **Density is structural:** `--row-h`, `--cell-pad-*` and `--font-size-base`
  flip on `data-density`; nothing else changes.
- **No AI-slop tropes:** no purple gradients, no emoji cards, no
  rounded-with-colored-left-border cards. The one gradient is the sidebar avatar
  and the dark active-toggle chip.

## Iconography

- **Single inline-SVG set** (`components/icon/Icon.jsx`), Lucide-style, 24×24
  viewBox, **stroke 1.75**, `currentColor`. Ported verbatim from the product's
  `adminos/Icon.js` — ~46 glyphs (home, calendar, clipboard, users, dollar,
  flask, book, chart, kebab, …). Always use `<Icon name>`; never hand-roll SVG
  or substitute emoji.
- The `℞` brand mark is a **Unicode glyph** (U+211E), not an icon or image, set
  in the accent square.
- **No logo image was provided** in the source, so the brand renders as the ℞
  glyph + type wordmark everywhere a mark would go. If a raster/vector logo
  exists, drop it into `assets/` and swap the `.sidebar-brand-mark` / `.sp-brand-mark`.

## Components

Reusable primitives (`window.DrBartenderOSDesignSystem_720350`):

- **Icon** — the OS glyph set.
- **StatusChip** — semantic status pill (ok/warn/danger/info/violet/accent/neutral).
- **StaffPills** — per-position roster fill indicator + count.
- **MetricTile** — dashboard KPI tile (label, tabular value, delta chip).
- **Sparkline** — inline trend line.
- **AreaChart** — two-series filled dashboard chart.
- **MetricsFilterBar** — date-range + source + money-lens filter row.
- **Sidebar** — collapsible rail nav + skin/density/rail controls footer.
- **Header** — top bar with ⌘K palette trigger + quick actions.
- **Toolbar** — list-page tabs + search + slots.
- **CommandPalette** — the ⌘K overlay.
- **KebabMenu** — row overflow (⋮) menu.
- **Drawer** — right-side detail panel.
- **DocumentPreviewModal** — image/PDF preview modal.
- **DataTableRow** — a row of the workhorse `.tbl`.
- **StaffTabBar** — mobile Home/Shifts/Pay/Tip Card tab bar.
- **StaffUserPillMenu** — staff topbar user popover + lighting toggle.
- **NextEventCard** — staff Home next-shift hero.
- **ShiftRow** — staff shift list entry.
- **PayoutRow** — staff pay-period line.
- **MobileTabBar** — phone admin Events/Proposals/More bottom tabs (badge counts).
- **MobileHeader** — phone admin top bar: title, search, Desktop-view escape.
- **BottomSheet / SheetRow** — thumb-zone action sheet replacing dropdowns and
  small modals on the phone.
- **CardListRow** — phone list card for events/proposals (title, mono meta,
  StatusChip). Phone lists are date-ordered cards, never tables.
- **Stepper** — tap-only count control (no keyboard).
- **MoreRow** — More-tab navigation row.

**Intentional additions** (no 1:1 source component, added for the kit):
`MetricTile`, `DataTableRow`, `NextEventCard`, `ShiftRow`, `PayoutRow`, `Toolbar`
formalize markup patterns that live inline in the product source so consumers
have a typed component instead of copying class soup.

**The mobile family is design-ahead-of-code:** it carries the approved
phone-first admin idiom (repo spec `2026-08-13-mobile-admin` + foundation
plan) while the product surfaces are being built. Its `.m-*` rules live in
`components-mobile.css`; the idiom law is `guidelines/mobile-idiom.html`.
When the product shell ships, these specimens track the shipped CSS verbatim,
same as every other family.

## UI kits

- `ui_kits/admin/` — the full Admin OS shell: sidebar + header + ⌘K palette,
  Dashboard / Events / Financials screens, metric tiles, area chart, data table,
  and the event detail **Drawer**. Skin, density and rail toggles are live in the
  sidebar footer; ⌘K opens the palette.
- `ui_kits/staff/` — the mobile staff PWA in a device frame: Home / Shifts / Pay
  / Tip Card with the bottom tab bar and the House Lights/After Hours lighting
  toggle in the user-pill menu.

## File index

- `styles.css` — entry point (link this). `@import`s everything below.
- `tokens/` — `fonts.css`, `colors.css`, `typography.css`, `layout.css`.
- `components-admin.css` · `components-staff.css` · `components-mobile.css` —
  component rules.
- `components/<group>/` — React primitives (`icon`, `status`, `metrics`,
  `navigation`, `command`, `overlay`, `table`, `staff`, `mobile`) with `.d.ts`,
  `.prompt.md` and a `@dsCard` gallery each.
- `guidelines/` — foundation specimen cards (Brand, Colors, Type, Spacing,
  Mobile).
- `ui_kits/admin/`, `ui_kits/staff/` — full product recreations.
- `SKILL.md` — Agent-Skill manifest.

## Caveats

- **Fonts** (Inter, JetBrains Mono, Libre Caslon Text) load from Google Fonts.
  The product self-hosts none of these for the OS; swap `tokens/fonts.css` to
  self-host if you need offline builds.
- **No logo asset** was in the source — the ℞ glyph + wordmark stand in.
- The `@dsCard` component galleries + UI kits depend on the compiled
  `_ds_bundle.js`, which is generated after the first save; a freshly-cloned
  copy renders them only once the design system has compiled.

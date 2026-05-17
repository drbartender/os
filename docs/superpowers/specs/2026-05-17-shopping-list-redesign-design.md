# Shopping List Surfaces — Apothecary Press Redesign

- **Date:** 2026-05-17
- **Status:** Approved (conversational brainstorm)
- **Author:** Dallas + Claude
- **Source design:** `C:/Users/dalla/Downloads/shopping list/` (Claude-design exploration)

## Context

The global "Apothecary Press" redesign already shipped: `client/src/index.css`
tokens are migrated to the Midnight-Ink / Apothecary-Teal / Antique-Brass
palette (`--amber` is now teal `#1D8C89`, `--chalkboard` `#12161C`, `--cream`
`#F0E8D6`, etc. — variable *names* preserved, values shifted).

`DR_BARTENDER_REDESIGN_BRIEF.md` deliberately deferred three shopping-list
surfaces, which are now out of sync with the rest of the app:

- `ClientShoppingList.js` — "keep as-is for v1, retune palette later, keep the dark mobile shell."
- `ShoppingListModal.jsx` — still hardcoded old copper hex.
- `ShoppingListPDF.jsx` — "out of scope for v1, update separately."

This spec lands that deferred follow-up using the provided design files.

## Goal

Bring all three shopping-list surfaces onto the shipped design system, add the
gold-ringed character logo, and replace the PDF with a print-friendly white
editorial layout — **with zero behavior/logic change**.

## Scope

### In scope (4 files)

| File | Change |
|---|---|
| `client/src/components/ShoppingList/logoBase64.js` | Replace base64 payload with `logo-character-dark.png` **downscaled to 200×200** |
| `client/src/pages/public/ClientShoppingList.js` | New teal/chalkboard palette + logo medallion in header/error/not-ready states |
| `client/src/components/ShoppingList/ShoppingListModal.jsx` | Hardcoded copper hex → existing `var(--*)` tokens; add logo `<img>` to modal header |
| `client/src/components/ShoppingList/ShoppingListPDF.jsx` | Total visual rework: white page, brass hairlines, teal Qty, no dark header band, small-caps kickers |

Optional (low priority, not load-bearing): keep the 500×500 source
`logo-character-dark.png` in `client/src/images/` for reproducible future
re-encoding. Not imported → zero bundle impact. Repo already has
`client/src/images/logo-character.png`; skip if it adds noise.

### Out of scope (do NOT implement)

- Preview-harness files in the design folder: `shopping-list.jsx`,
  `shopping-list-admin.jsx`, `tweaks-panel.jsx`, `ios-frame.jsx`, the `.html`
  facsimiles, `design-system/` portable sheet, `uploads/`. Their own header
  comments declare them presentation-only.
- Server, DB, route, or email changes. The `shoppingListReady` email sends a
  link, not an inline render; email redesign is its own deferred PR per the brief.
- `ConsultationForm.jsx`, `generateShoppingList.js`, `shoppingListPars.js`,
  `ShoppingListButton.jsx` — untouched (data/logic layer).
- Switching `ClientShoppingList` off raw `axios` onto `utils/api.js` — it is the
  intentional public-token-page exception and the current file already does
  this; preserving working public path beats an out-of-scope lint nicety.

## Detailed design

### 1. Logo pipeline — `logoBase64.js`

- Today `logoBase64.js` (129 KB) is imported **only** by `ShoppingListPDF.jsx`.
  After this change it is also imported by `ShoppingListModal.jsx` and
  `ClientShoppingList.js` (a `lazy()`-loaded public mobile page on all 4 host
  route trees).
- `logo-character-dark.png` is 325 KB at 500×500 → ~433 KB base64. It renders at
  72 px (medallion), 48 px (modal), 60 pt (PDF). 500×500 is wild overkill.
- **Downscale to 200×200** (≈2.7× the largest display size, crisp on retina)
  before base64-encoding → expected ~20–35 KB inline. Keeps the public lazy
  chunk light; PDF still embeds fine at 60 pt.
- Tooling: Python `PIL`/Pillow 12.2 is available (self-contained one-off, no
  client-dep risk); `sharp` 0.34.5 also present as fallback. Lanczos resample,
  preserve RGBA transparency, output PNG.
- `logoBase64.js` keeps its exact shape: `export const LOGO_BASE64 =
  "data:image/png;base64,…";` (single line — file-size hook is line-count based,
  unaffected).

### 2. `ClientShoppingList.js`

Replace with the design-folder source. It is the current file plus:
- `import { LOGO_BASE64 } from '../../components/ShoppingList/logoBase64';`
  (correct relative path from `pages/public/`).
- New hex palette (`#12161C`, `#1D8C89`, `#2FA7A0`, `#F0E8D6`) — kept as inline
  hex on purpose (public dark mobile shell, brief's instruction).
- 72 px logo `<img>` in the header, error, and not-ready states (loading state
  intentionally has none). Gold ring is baked into the asset — no medallion ring
  CSS.

Preserved unchanged: `useParams`, raw `axios`, `fetchList`, localStorage
`shopping-list-checked-${token}`, the `eslint-disable-next-line
no-restricted-syntax` on the 404 branch, progress math, section render, refresh.

Data contract consumed is unchanged: `data.ready`, `data.client_name`,
`data.event_date`, `data.shopping_list.{liquorBeerWine, everythingElse,
signatureCocktailNames, guestCount}`.

### 3. `ShoppingListModal.jsx`

Replace with the design-folder source. Verified line-by-line: **logic is
byte-identical** (auto-save debounce, dnd-kit sort, add/remove/undo, guest-count
recalc confirm, share-link, approve-and-send, dynamic PDF import). Only changes:

- `import { LOGO_BASE64 } from './logoBase64';` + a 48 px logo `<img>` at the
  start of the modal header row.
- Hardcoded copper hex → tokens already defined in `index.css`:
  `--chalkboard`, `--amber`, `--amber-light`, `--cream`, `--cream-text`,
  `--dark-ink`, `--parchment`, `--paper`, `--warm-brown`, `--text-muted`,
  `--deep-brown`, `--border`, `--success`, `--rust`, `--error`,
  `--font-display`. All confirmed present.
- Keeps `className="btn" / "btn-secondary" / "btn-success" / "btn-sm"` — the
  live redesigned button classes. The `.drb-btn` classes in the design folder
  were preview-only scaffolding and are correctly NOT carried over.
- **Conscious visual shift:** Qty input recolors rust-brown `#6B4226` →
  `var(--warm-brown)` `#134544`. Intentional brand alignment, not a bug.

### 4. `ShoppingListPDF.jsx`

Replace with the design-folder source. White editorial treatment:
- White page, no dark header band; brass hairlines for chrome; one hairline per
  row (no zebra fill); small-caps brass section kickers; column header labels
  small-caps grey; Qty in dark warm-teal `[19,69,68]` (only colored data point);
  footer URL in teal.
- `generateShoppingListPDF(listData)` signature, destructured fields, and
  `doc.output('blob')` return are **unchanged** → `handleDownload`'s dynamic
  `import('./ShoppingListPDF')` keeps working.
- jsPDF 4.2.1 installed; `setCharSpace` (the one new API used) confirmed present
  in dist. Built-in `times`/`helvetica` fonts only. `addImage(LOGO_BASE64,
  'PNG', …)` unchanged.
- Internal-only: page margin `MX` 22 → 36 (no caller impact).

## "What could break" analysis — verdict: nothing

- **Hosts:** one `lazy()` `ClientShoppingList` component is mounted on all 4
  host route trees in `App.js` (`/shopping-list/:token`). One file edit updates
  every host identically.
- **Tokens:** every `var(--*)` the Modal references already exists in
  `index.css`; no global stylesheet edit, so no app-wide ripple.
- **PDF caller:** signature/return unchanged; dynamic import still resolves.
- **No other consumer** renders `liquorBeerWine`/`everythingElse`.
  `DrinkPlanCard`/`DrinkPlanDetail` only mount `ShoppingListButton`, whose
  `listData` contract is untouched.
- **Email:** `shoppingListReady` is a CTA link only — decoupled from the page
  redesign.
- **Logo ripple** is contained: pre-change only the PDF imported `logoBase64`;
  the new importers are part of this change.
- **File-size hook** is line-count based; the one-line base64 module is fine.

## Verification

1. **Client production build** (lint is CI-only per project memory; `.husky/pre-push` gates it): `cd client && CI=true npx react-scripts build` must pass clean.
2. **Logo encode check:** decode the new `LOGO_BASE64`, confirm it's a valid
   200×200 PNG with transparency and renders the gold-ringed mark.
3. **Manual, dev server (Claude-managed bg process):**
   - Public `/shopping-list/:token` — ready, not-ready, error, loading states;
     new palette + logo; checklist toggle + localStorage persist; refresh.
   - Admin Modal via `DrinkPlanCard` and `DrinkPlanDetail` — opens, logo shows,
     edit a qty (auto-save "Saved"), drag-reorder, add/remove + Undo, guest-count
     recalc confirm, Share Client Link, Approve & Send.
   - Download PDF — new white layout, logo crisp, two columns, signature
     cocktails row, footer; test both small (Reyes-style) and large
     (wedding-style) lists for the row-height auto-fit.
4. **Pre-push:** code-touching → standard 5-agent fleet runs per CLAUDE.md
   (no server/DB/auth/money paths, so expected light).

## Risks & rollout

- Single client-only batch; revert = `git revert` of one commit.
- Highest-attention item is the PDF (the artifact clients receive) — verify
  large-list pagination/row-fit before push.
- No migration, no env var, no data shape change.

## Revision — 2026-05-17 (post-implementation feedback)

After the initial drop-in, the user revised three points. These supersede the
matching parts of "Detailed design" above:

1. **Modal: no logo.** The `<img>` and the `LOGO_BASE64` import are removed from
   `ShoppingListModal.jsx` (an unused import would fail the `CI=true` lint gate).
   `logoBase64.js` is now imported by **PDF + ClientShoppingList only** (not the
   modal); the contained-ripple analysis still holds.
2. **Modal: re-themed to Admin OS, not base tokens.** `ShoppingListModal` is
   admin-only — verified every render path roots in `pages/admin/`
   (`DrinkPlanDetail`, and `DrinkPlanCard` via `EventDetailPage` /
   `ProposalDetail`); the client never sees it (the client gets the separate
   read-only `/shopping-list/:token` page + PDF). So the modal's bespoke
   chalkboard/cream/`--amber` styling is replaced with the **Admin OS skin
   tokens** (`--bg-elev`, `--ink-1/2/3`, `--line-1/2`, `--accent`,
   `--accent-soft`, `--accent-line`, `--shadow-pop`, `--radius*`, semantic
   `--ok-h/--danger-h` for the save indicator) so it auto-swaps with the admin
   light/dark skin like `.confirm-modal` does. `.btn`/`.btn-secondary`/
   `.btn-success` kept (already admin-skinned); Undo button is now
   `.btn .btn-sm .btn-primary` with inline color overrides dropped. Under
   `html[data-app="admin-os"]`, `--font-display` resolves to Inter — that is the
   intended admin match. **Logic remains byte-identical.**
3. **Client page: IM Fell headings.** `ClientShoppingList.js` `brand`,
   `clientName`, and `sectionHeader` switch `Georgia, serif` →
   `var(--font-display)`. The public page is not `data-app="admin-os"`, so this
   resolves from `:root` = IM Fell English SC (the apothecary brand). Item rows /
   meta / disclaimer keep the system sans for glance readability.

PDF is unchanged from the approved design-folder source.

# Spec: Standard Menu Auto-Generation and Logo Upload

> Auto-generate the "Standard Menu" deliverable on the planner's MenuDesignStep, give clients a live preview of their actual menu inline, accept an optional client logo upload that also applies to the Custom Menu path, and ship an admin-side PNG download of the printable 8x10 menu for the operator to print and frame.

This spec implements the "Standard Menu auto-generation" carve-out called out at §3.1 of `docs/superpowers/specs/2026-05-19-potion-planner-implementation-design.md`. That earlier spec shipped the three-way Menu Design radio (Custom, Standard, No Menu Card) and the data flag `selections.menuStyle === 'house'` for the Standard option. This spec is the generator that turns the flag into an actual deliverable.

---

## 1. Goals and non-goals

### Goals

- A live, in-planner HTML preview that shows the client exactly what their printed menu will look like once they pick Standard. Updates on every drink change.
- An optional logo upload that works for BOTH the Custom and Standard menu paths (the corporate-appeal feature).
- An admin-only PNG download of the same menu at 8x10 / 300 DPI for the operator to print at a photo print service and frame for the bar.
- Single source of truth for the visual: one React component drives both the on-screen preview and the printable artifact. No dual implementation, no risk of drift.

### Non-goals (explicit out-of-scope)

- Custom Menu auto-generation. The Custom path remains operator-designed. Logo upload helps the operator (gives them the client's logo to integrate) but no auto-rendering happens for Custom.
- Email delivery of the menu. The PNG is downloaded by the operator from the admin event detail page. No automatic email-on-submit attaching the PNG.
- Brand color or theme upload for the client. Just the logo. Branded weddings still go through Custom.
- Multi-logo upload. One logo per plan. No "sponsor row" or co-branded multi-logo layouts.
- Logo persistence across events. Each event uploads its own logo. No "default logo" stored on the client account.
- R2 cleanup of orphaned or replaced logos. Storage cost is negligible. Future spec if it ever matters.
- SVG logo upload. Excluded for security (magic-bytes validation on XML is not reliable).
- A separate "Non-Alcoholic Beer" label on the menu. NA beer rolls up under "Beer" per §5.
- Print-shop integration or print bleed/safe-area markings. Operator handles physical printing logistics.
- PDF export. PNG-only output. Covers photo print services AND home printers (via OS print dialog).

---

## 2. Status and prior art

- **Prior spec** (still authoritative for the radio UI and the data flag): `docs/superpowers/specs/2026-05-19-potion-planner-implementation-design.md`. The three-way radio, the migration from `customMenuDesign` to `menuStyle`, and the placeholder "we bring it printed and framed" copy all already shipped.
- **Pattern to follow for PNG generation**: `client/src/components/ShoppingList/ShoppingListPDF.jsx` is the existing precedent for client-side rendering of an event artifact. We follow its lazy-load + button-trigger shape, but output PNG via html2canvas instead of PDF via jsPDF.
- **Upload infrastructure already exists**: `server/utils/storage.js` exports `uploadFile(buffer, filename)` to Cloudflare R2. `server/utils/fileValidation.js` performs magic-bytes validation. `server/routes/application.js` is the canonical example of a multipart upload route. No new dependencies for the upload pipeline.

---

## 3. What we are shipping (one logical commit/PR)

1. **`<MenuPreview>` React component** rendering the menu visually as HTML/CSS. Renders inline on MenuDesignStep when `selections.menuStyle === 'house'`. Used off-screen at print dimensions by the admin PNG export.
2. **`<MenuPNG>` admin-only export component** that triggers an html2canvas capture of `<MenuPreview>` at print dimensions and saves the result as a PNG. Lazy-loaded; only fetched when the operator clicks the button.
3. **Logo upload UI** on MenuDesignStep, visible whenever `menuStyle === 'custom'` OR `'house'`. PNG/JPG only, max 5 MB.
4. **Logo upload server routes** (one public token-gated, two admin-authenticated): one for client upload, one for admin override upload, one for admin clear.
5. **Admin-side logo display** on `EventDetailPage.js` showing the uploaded logo thumbnail with a "Download original" link, regardless of whether the client picked Custom or Standard. Lets the operator grab the client's logo for the Custom path.
6. **New data field** `selections.companyLogo` (string URL). Added to `DEFAULT_SELECTIONS`. No schema change.
7. **Custom menu gallery scoping**: the existing "See sample menus" button on MenuDesignStep gets scoped to `menuStyle === 'custom'` only, so Standard clients see the live preview instead.
8. **Menu sections helper** at `client/src/pages/plan/data/menuSections.js` that extracts the menu's section structure from `selections`. Shared by both `<MenuPreview>` and `<MenuPNG>` so the look stays consistent.

---

## 4. Architecture

### 4.1 Single source of truth

The React component `<MenuPreview>` is the canonical visual. Both surfaces consume it:

- **Client preview**: rendered inline on MenuDesignStep at responsive width, max ~400 px on desktop. Updates live as `selections` changes.
- **Admin PNG export**: a hidden full-size render at exactly 768 x 960 px (8 x 10 inches at 96 DPI screen scale), captured by `html2canvas` at `scale: 3` to produce a 2304 x 2880 px PNG (close enough to 2400 x 3000 for 300 DPI quality at 8x10).

Whatever visual styling Claude Design ships for `<MenuPreview>` automatically applies to the printed PNG. One component, one styling pass, no drift.

### 4.2 Why PNG, not PDF

Photo print services (Walgreens, Costco, online printing) typically only accept PNG and JPG, not PDF. Choosing PNG keeps the operator's print pipeline maximally flexible. PNG also prints fine through OS print dialogs for home printer use. PDF is excluded.

### 4.3 Why html2canvas, not jsPDF

`jsPDF` would require embedding IM Fell English as base64 TTFs (~200 KB) in the admin bundle to maintain the brand typography, plus a duplicated render path. `html2canvas` captures the actual DOM, which already loads IM Fell via `@font-face` (see `client/src/index.css:5-19`). Lighter net bundle weight (~120 KB vs ~50 KB jsPDF + ~200 KB embedded fonts), single render path, zero font-drift risk.

### 4.4 Fonts and palette

The HTML preview and the PNG export both inherit IM Fell English typography from the existing planner CSS. **The menu surface is the planner's stage palette translated to a printable artifact: chalkboard background (`#12161C`), brass-bright (`#D6AE65`) for section labels and decorative elements, brass (`#B8924A`) for hairlines and the title eyebrow, cream (`#F0E8D6`) for drink names.** Reads as a craft-bar chalkboard menu when framed, on-brand with the rest of the planner's dark surfaces.

**Print workflow implication.** A full-coverage dark background at 8×10 means the printed PNG is mostly dark ink/toner. Photo print services (Walgreens, Costco, online printing) handle this fine. Home printers struggle with flat dark coverage. The operator's print workflow effectively requires a photo print service for the Dark Ink menu. Not a blocker; just the path of least resistance.

### 4.5 Visual design pass

Section structure, typography sizing, decorative elements, the exact look of the menu header and section dividers all get refined in a Claude Design session AFTER this spec lands. The engineer ships `<MenuPreview>` with a placeholder visual sufficient to verify the section conditionals and the data path. The visual gets iterated the same way the planner reskin was iterated.

---

## 5. Menu section conditional logic

A single helper at `client/src/pages/plan/data/menuSections.js` extracts the menu's section structure from `selections`. Both `<MenuPreview>` and `<MenuPNG>` consume identical output, so the look stays consistent.

### 5.1 Section visibility rules

| Section | Renders when |
|---|---|
| Cocktails | `selections.signatureDrinks.length > 0` |
| Mocktails | `selections.mocktails.length > 0` |
| Beer & Wine | any non-"Other" entry exists in `beerFromFullBar`, `beerFromBeerWine`, `wineFromFullBar`, or `wineFromBeerWine` |
| Bar Service | `activeModules.fullBar === true` AND `selections.signatureDrinks.length === 0` (fallback for full-bar clients with no specific signature cocktails) |

### 5.2 Per-section content

- **Cocktails**: drink names resolved from the cocktails API. One name per line. Render order matches the order in `signatureDrinks` (the order the client picked them).
- **Mocktails**: same pattern. Names from the mocktails API.
- **Beer & Wine**: collapses array contents into at most five fixed labels in this display order: **Beer, Seltzer, Red, White, Sparkling**. Mapping rules:
  - `"Beer"` label appears if any beer array contains an entry other than `"Seltzer"`. The strings `"Light / Easy Drinking"`, `"Craft / Local"`, `"IPA"`, and `"Non-Alcoholic"` all roll up to `"Beer"`.
  - `"Seltzer"` label appears if any beer array contains exactly `"Seltzer"`.
  - `"Red"` / `"White"` / `"Sparkling"` each appear if the corresponding string is present in any wine array.
  - `"Other"` wine entries do NOT render a label.
- **Bar Service**: a single line reading *"Call Drinks"* under a "Bar Service" section title. No further content.

### 5.3 Section order

Cocktails → Mocktails → Beer & Wine → Bar Service. Order is fixed. Sections that don't render are skipped.

### 5.4 Empty-menu fallback

If literally no section renders (e.g., client opened MenuDesignStep before picking anything), `<MenuPreview>` shows the menu chrome (header + logos) with a single muted italic line in the body: *"No drinks selected yet. Go back and pick something to serve."* No guard on the admin PNG button for this state. Clicking it on an empty plan downloads an empty menu. Edge case.

### 5.5 Drink-name resolution

Both renderers need resolved `name` strings for each ID in `signatureDrinks` and `mocktails`.

- **Planner side**: cocktails + mocktails arrays already loaded into state at plan mount (`PotionPlanningLab.js` `useEffect` at line 113). `<MenuPreview>` receives them as props.
- **Admin side**: `EventDetailPage.js` does not currently load cocktail/mocktail reference data. The existing `/api/drink-plans/:id` response (server route at `drinkPlans.js:638`) is extended to include resolved `signatureDrinkNames: [string]` and `mocktailNames: [string]` arrays (server-side resolution from the cocktails + mocktails tables). The admin page passes these directly into `<MenuPreview>` without needing a separate fetch.

### 5.6 Deduplication

If `selections.signatureDrinks` or `selections.mocktails` somehow contains duplicate IDs (defense in depth; the picker UI prevents this), the menu rendering deduplicates by ID. Same-name entries from beer/wine arrays are already collapsed by the label-mapping rules in §5.2.

### 5.7 Custom drink names

`selections.drinkNaming` (a Custom-Menu-only free-text field) is intentionally ignored by the Standard render. Standard always uses the real cocktail names from the data.

---

## 6. `<MenuPreview>` component

### 6.1 File location

`client/src/pages/plan/components/MenuPreview.js` (new file in the same `components/` folder where `ScopeBanner` and `WelcomeRoadmap` already live).

### 6.2 Props

```js
<MenuPreview
  selections={selections}            // full selections object
  companyLogo={selections.companyLogo}  // string URL or ''
  signatureDrinkNames={[...]}        // resolved string array
  mocktailNames={[...]}              // resolved string array
  activeModules={activeModules}      // for the Bar Service fallback
  variant="screen"                   // "screen" | "print"
/>
```

The `variant` prop controls render size. `"screen"` uses responsive width with the 4:5 aspect ratio. `"print"` renders at exactly 768 x 960 px so the html2canvas capture produces a clean 2304 x 2880 PNG.

### 6.3 Where it renders on MenuDesignStep

Inline below the `<span className="potion-field-note">` reveal text for the Standard option (which already exists at `MenuDesignStep.js:175-178`). The preview sits inside the same `<div className="card">` that holds the radio question. No new card, no modal.

When `menuStyle === 'house'` is selected:
1. The field-note reveal text appears (already shipped).
2. The logo upload field appears (per §7).
3. `<MenuPreview variant="screen" ... />` renders below both.

When `menuStyle === 'custom'`: no preview (existing theme/naming/notes textareas show instead).

When `menuStyle === 'none'` or `null`: no preview, no logo field.

### 6.4 Visual constraints (for the Claude Design pass)

**Direction:** Dark Ink. Chalkboard surface, cream type, brass accents. **Vertical single-column stacked layout** (the Claude Design iteration moved away from two-column after the first pass): Cocktails → Mocktails → Beer & Wine → Bar Service, each with its own label + brass hairline + items block.

**Format:**
- Portrait, 4:5 aspect ratio, 8 x 10 inches at print scale.
- Print canvas: exactly 768 x 960 px at 96 DPI screen scale. html2canvas captures at `scale: 3` to produce a 2304 x 2880 PNG.
- Solid chalkboard background (`#12161C`) flooded across the full surface.

**Palette and one-rule-token discipline:**
- Background: `#12161C` (chalkboard)
- Drink names: `#F0E8D6` (cream)
- Section labels: `#D6AE65` (brass-bright)
- Hairlines, ornaments, vertical footer divider, brass diamonds: `#B8924A` (brass)
- **Single rule token:** all hairlines on the menu render as `1px solid #B8924A`. No opacity drift, no subpixel variation. One token applied to title hairlines, section-label hairlines, footer top border, and footer's vertical divider.

**Typography:**

| Element | Size (print px) | Font | Style |
|---|---|---|---|
| Title crest "The Bar Menu" | 72 px | **Pirata One** (NEW dependency, blackletter-adjacent display serif) | weight 400, letter-spacing 0.02em, cream |
| Section labels (Cocktails, Mocktails, Beer & Wine, Bar Service) | 17 px | IM Fell English SC | letter-spacing 0.22em, uppercase, brass-bright |
| Drink names (the heroes) | 35 px | IM Fell English SC | letter-spacing 0.04em, line-height 1.4, cream, centered |
| Beer & Wine inline labels | 21 px | IM Fell English SC | letter-spacing 0.18em, uppercase, cream, centered, joined by `   ·   ` (three em-spaces + middot + three em-spaces) |
| Empty-state copy | 22 px | IM Fell English (body, italic) | line-height 1.5, cream at 65% alpha |
| Footer wordmark (Dr. Bartender) | 19 px | IM Fell English SC | letter-spacing 0.32em, uppercase, cream |
| Diamond ornament `◆` flanking title | 14 px | system, brass | translateY(-1px) for optical center |
| Diamond ornament `◆` flanking section labels | 11 px | system, brass | translateY(-1px) for optical center |

**Pirata One** is loaded as a local `@font-face` in `client/src/index.css` from a TTF asset shipped under `client/src/fonts/PirataOne-Regular.ttf` (or the implementer's chosen subdirectory). Local-font load matches the existing IM Fell pattern and ensures html2canvas captures cleanly without any external Google Fonts fetch during PNG generation.

**Spatial scale (print px):**
- Page margins: 48 px on all four sides
- Title crest bottom margin (before first section): 38 px
- Vertical gap between stacked sections: 30 px
- Section label bottom-padding (above the hairline): 12 px
- Gap between section hairline and drink list: 18 px
- Footer band height: 107 px (fixed at the bottom)
- Footer paddingInline: 48 px
- Footer DRB-to-client-logo gap: 24 px (with vertical brass rule between)

**Title crest structure:**

```
[HRule with ◆ centered (line, 14px diamond, line)]
   The Bar Menu        ← 72px Pirata One, cream
[HRule with ◆ centered (line, 14px diamond, line)]
```

Each `HRule` is a flex row: `[flex:1 1px line; max 160px width]  ◆  [flex:1 1px line; max 160px width]`. The diamond sits between the two line segments.

**Section structure:**

Every section uses identical chrome:

```
   ◆  COCKTAILS  ◆       ← brass-bright SC, 17px, with brass diamond flankers
─────────────────────    ← brass 1px hairline (the bottom-border of the label cell)

   Drink Name 1          ← 35px IM Fell SC cream, centered
   Drink Name 2
   Drink Name 3
```

The diamond+label+hairline together form the section header. The diamond markers (11px) sit on either side of the label text, separated by 14px gaps, centered above the hairline.

**Beer & Wine layout (conditional):**

- **When Beer & Wine is NOT the only section** (accompanying Cocktails or Mocktails): items render inline as one centered tracked SC line at 21px: `BEER   ·   SELTZER   ·   RED   ·   WHITE   ·   SPARKLING` (three em-spaces, middot, three em-spaces between labels).
- **When Beer & Wine IS the only section on the menu**: items render stacked vertically as hero lines at 35px IM Fell SC cream, the same treatment as drink names. The inline pill row reads as a footnote with nothing above it; promoting it to hero-stacked gives it visual weight when it carries the whole menu.

**Footer band:**

- Absolute-positioned at the bottom, full-width, 107 px tall, with `borderTop: 1px solid #B8924A`.
- Left side: DRB lockup = medallion image (64×64 px, `objectFit: contain`) + "Dr. Bartender" wordmark (19px IM Fell SC, 0.32em tracking, cream), separated by a 16px gap.
- Center: empty flex spacer.
- Right side (only when `companyLogo` is present): a 1px brass vertical rule (64 px tall) followed by the client logo, capped at **160 × 72 px** with `objectFit: contain` so the visual mass balances the 64-px DRB medallion next to it.

**Logo asset path:** the DRB medallion uses `/images/menu-logo-gold.png` (a new asset the operator places in `client/public/images/`). Path defined as `process.env.PUBLIC_URL + '/images/menu-logo-gold.png'` in `<MenuPreview>` so it works in both dev and prod bundles.

**Other constraints:**
- No event name, no event date, no flavor descriptions (drink names only).
- No box-shadow or backdrop-filter effects on text (so html2canvas captures cleanly).
- No CSS borders that would be visible during print (all dividers are explicit hairline blocks).
- Diamonds use the Unicode `◆` character (U+25C6) in the system color emoji-free; no SVG, no icon library.

### 6.5 Update behavior

Pure React component reading from `selections`. Every drink toggle on any prior step automatically re-renders the preview when the client returns to MenuDesignStep. No refresh button, no debouncing.

---

## 7. Logo upload

### 7.1 Client-side UI

A new section on MenuDesignStep that appears whenever `menuStyle === 'custom'` OR `menuStyle === 'house'`. Hidden for `'none'` and `null`.

**Title:** *"Add your logo (optional)"*

**Helper text under the title:** *"For corporate events or branded weddings."*

**States:**

- **No logo uploaded**: a file picker button. Hint text: *"PNG or JPG, up to 5 MB."*
- **Uploading**: spinner overlay on the button. Button disabled.
- **Uploaded**: thumbnail preview at 80 x 80 px (image fits inside maintaining aspect via `object-fit: contain`). "Replace" button + "Remove" link to the right of the thumbnail.
- **Upload failed**: inline error message with the reason (wrong format, too large, server unreachable).

### 7.2 Format constraints

- **Accepted formats**: PNG and JPG only. SVG is excluded for security.
- **Max file size**: 5 MB.
- **No client-side dimension cap**: 5 MB is enough to filter out obvious mistakes. Logos at any reasonable size fit comfortably.

### 7.3 Server route (public, token-gated)

`POST /api/drink-plans/t/:token/logo`

- Body: multipart form with one file field named `logo`.
- Rate-limited via the existing `drinkPlanWriteLimiter` (per `drinkPlans.js:93`).
- Look up plan by token. 404 if not found. 403 if `plan.locked === true`.
- Validate the file via `server/utils/fileValidation.js` (magic bytes + size + extension check). Reject with 400 and a specific error message on failure.
- Upload to R2 via `server/utils/storage.js#uploadFile` to path `drink-plan-logos/<plan-id>-<timestamp>.<ext>`.
- **Atomic persist**: in the same request, update `drink_plans.selections` JSON to set `companyLogo` to the new URL via a parameterized UPDATE. This eliminates the race where the R2 file uploads but the client's next auto-save fails to persist the URL.
- Return `{ logoUrl, selections }` where `selections` is the updated selections JSON so the client can sync state immediately.

### 7.4 Admin routes (authenticated)

Two new admin-authenticated routes, both with `auth + requireAdminOrManager`:

- `POST /api/drink-plans/:id/logo`: admin uploads a logo for a specific plan by ID. Same validation + R2 upload + atomic persist as the client route, just authenticated and by ID instead of token. Returns `{ logoUrl, selections }`.
- `DELETE /api/drink-plans/:id/logo`: admin clears the logo. Sets `selections.companyLogo = ''` in the plan's JSON. Does NOT delete the R2 file (storage cost is negligible). Returns `{ selections }`.

### 7.5 Admin UI

A new "Logo" subsection on `client/src/pages/admin/EventDetailPage.js`, in the drink plan area. Renders **regardless of whether the client picked Custom or Standard** (or even none, in case they uploaded a logo before changing the menu type later).

States:

- **Logo present**: thumbnail at 80 x 80 px (`object-fit: contain`), "Replace" button (file picker → admin upload route), "Remove" link (calls admin DELETE route), and a "Download original" link that opens the R2 URL in a new tab for the operator to save the file for Custom-menu design work.
- **No logo**: a placeholder reading *"No logo uploaded."* with an "Upload logo" button (file picker → admin upload route).

### 7.6 Lifecycle quirks

- Switching `menuStyle` between Custom and Standard keeps the uploaded logo (relevant to both paths).
- Switching to "No Menu Card" hides the upload UI on the planner side but does NOT delete the URL. If the client flips back, the logo is still there.
- The admin "Remove" action clears the URL but does NOT delete the R2 file.
- New uploads do NOT delete previous R2 files. Orphaned files have trivial storage cost. No cleanup job in v1.

### 7.7 Custom menu gallery scoping

The existing "See sample menus" button at `client/src/pages/plan/steps/MenuDesignStep.js:127-135` currently renders whenever `MENU_SAMPLES.length > 0`. Update the conditional so the gallery button appears only when `selections.menuStyle === 'custom'`. The Standard path uses the live preview instead.

---

## 8. PNG export (admin-only)

### 8.1 Component file

`client/src/components/MenuPNG/MenuPNG.jsx`.

### 8.2 Where it mounts

A new "Download Standard Menu PNG" button on `client/src/pages/admin/EventDetailPage.js`, in the drink plan section. Renders only when the plan's `selections.menuStyle === 'house'`. (Not Custom, not None.)

### 8.3 Render pipeline

1. Button click triggers a lazy import of `MenuPNG.jsx` (`React.lazy` + dynamic import) so html2canvas (~120 KB) is not in the initial admin bundle.
2. Component mounts a hidden full-size `<MenuPreview variant="print" ... />` off-screen via `position: absolute; left: -9999px;` (or equivalent off-screen positioning that html2canvas can still capture).
3. `html2canvas(node, { scale: 3, backgroundColor: '#EDE6D6', useCORS: true })` produces a 2304 x 2880 px canvas.
4. `canvas.toBlob(blob => { ... }, 'image/png')` triggers a browser download via a temporary `<a download>` element.
5. Loading state: button text changes to *"Generating..."* and the button is disabled until the download triggers (typically 500ms-2s).

### 8.4 Filename

`Standard Menu - <client name>.png`. The `<client name>` segment comes from `plan.client_name` and is **sanitized** before use: strip or replace any character that is filesystem-unfriendly (slashes, colons, quotes, backslashes, control chars). Replace with a hyphen and collapse consecutive hyphens. If the result is empty, fall back to *"Standard Menu.png"* with no suffix.

```js
// Reference implementation:
const safe = (plan.client_name || '')
  .replace(/[\/\\:"*?<>|\x00-\x1f]/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '')
  .trim();
const filename = safe ? `Standard Menu - ${safe}.png` : 'Standard Menu.png';
```

### 8.5 CORS on the client logo image

The uploaded logo lives on R2. For html2canvas to capture it, the R2 bucket needs to send `Access-Control-Allow-Origin: *` (or the admin app's origin) on logo image fetches. If the existing R2 bucket already serves the shopping list logo CORS-enabled, the same config covers menu logos. Verify at implementation time.

### 8.6 Loading the DRB logo for the menu render

Reuse the existing static asset path `/shopping-list-logo.png` for v1 (already in `client/public/`). Claude Design may swap this for a menu-specific variant during the visual pass.

---

## 9. Data shape

### 9.1 New selection field

`selections.companyLogo` (string URL, default `''`).

Added to `DEFAULT_SELECTIONS` in `PotionPlanningLab.js`. Persisted via the existing auto-save PUT path AND atomically by the upload routes per §7.

### 9.2 No schema change

`selections` is a JSON column on `drink_plans`. No DDL, no column adds, no backfill. Existing plans without the field read as `undefined`, which the consumer treats the same as `''` (no logo).

### 9.3 Server-side reads

The PNG render happens entirely client-side. The server stores the URL and the upload routes ship it back. No server-side image processing, no thumbnail generation.

### 9.4 Admin event detail response

The existing `GET /api/drink-plans/:id` route at `server/routes/drinkPlans.js:638` returns the plan. The response is extended with two pre-resolved name arrays so `<MenuPreview>` and `<MenuPNG>` on the admin side don't need to make additional fetches:

- `signatureDrinkNames: string[]`: names resolved from the `cocktails` table, in the same order as `selections.signatureDrinks` IDs.
- `mocktailNames: string[]`: same pattern from the `mocktails` table.

Both arrays are computed in one server-side join. If an ID has been deleted from the source table, that entry is silently dropped (matching the existing graceful-degradation pattern in `shoppingListGen.js`).

---

## 10. Component changes summary

### 10.1 Files to create

- `client/src/pages/plan/components/MenuPreview.js`: the shared visual component
- `client/src/pages/plan/data/menuSections.js`: the section structure helper
- `client/src/components/MenuPNG/MenuPNG.jsx`: the admin-side PNG export

### 10.2 Files to modify

- `client/src/pages/plan/PotionPlanningLab.js`: add `companyLogo: ''` to DEFAULT_SELECTIONS
- `client/src/pages/plan/steps/MenuDesignStep.js`: mount logo upload field, mount `<MenuPreview>` for Standard, scope the gallery button to Custom only
- `client/src/pages/admin/EventDetailPage.js`: add the Logo subsection (always visible when a plan exists), add the "Download Standard Menu PNG" button (conditional on `menuStyle === 'house'`)
- `server/routes/drinkPlans.js`: three new routes (one public, two admin); extend the `GET /:id` response with resolved `signatureDrinkNames` and `mocktailNames`
- `client/src/index.css`: append `.logo-upload-*`, `.menu-preview-*`, and any other planner-scoped classes the new UI introduces, all under `.potion-app` scope

### 10.3 New dependency

`html2canvas` (~120 KB minified, ~33 KB gzipped) added to `client/package.json`. Lazy-loaded; not in the initial bundle.

---

## 11. Quality gates (definition of done)

Ship when all of these hold:

- [ ] Client picks Standard on MenuDesignStep and sees a live HTML preview of their actual menu render inline below the radio reveal.
- [ ] The preview updates within ~100ms of any drink toggle on prior steps (verified by navigating back, changing a drink, navigating forward).
- [ ] Section visibility logic matches §5.1 exactly. Empty sections do not render. Bar Service fallback renders when full-bar is active and no signature cocktails are selected.
- [ ] Beer & Wine labels are exactly *Beer, Seltzer, Red, White, Sparkling* (no specific brand names, no "Other" rendering).
- [ ] Client can upload a PNG or JPG logo up to 5 MB. Upload completes within a reasonable time; thumbnail renders at 80 x 80 with `object-fit: contain`.
- [ ] Upload is atomic: a single request both writes to R2 and persists the URL to `selections.companyLogo`. Verified by killing the client connection right after upload-success and refreshing; the logo URL is still on the plan.
- [ ] SVG and other formats are rejected with a clear error message.
- [ ] Admin can replace and remove the logo from EventDetailPage. Both actions update `selections.companyLogo` correctly.
- [ ] Admin can see the uploaded logo thumbnail AND download the original file from EventDetailPage, regardless of Custom vs Standard.
- [ ] Admin "Download Standard Menu PNG" button is hidden when `menuStyle !== 'house'`.
- [ ] Clicking the button produces a 2304 x 2880 PNG file with the filename `Standard Menu - <sanitized client name>.png`.
- [ ] The PNG contains all the same sections as the preview, the same drink names, the DRB logo, and the client logo (if uploaded).
- [ ] The PNG uses IM Fell English typography throughout (visually verified).
- [ ] CORS on the client logo R2 fetches works for html2canvas (no tainted-canvas error).
- [ ] Custom menu gallery button only appears when `menuStyle === 'custom'`.
- [ ] No em dashes introduced in copy, code, or comments.
- [ ] No new server-side dependencies. No schema changes. No DDL. Existing migrations untouched.
- [ ] `PotionPlanningLab.js` stays under 1000 lines after this work lands (it was at 974 after the reskin; adding ~5 lines for the new default + maybe 5 for the upload trigger).

---

## 12. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| html2canvas produces a slightly different look than the live HTML preview (CSS quirks, box-shadow rendering, sub-pixel font positioning) | Medium | The Claude Design pass for `<MenuPreview>` deliberately favors simple primitives (flat fills, hairlines, system-compatible CSS) that html2canvas captures cleanly. Avoid box-shadow on text and tricky CSS effects. Verify by exporting a PNG and visually diffing against the HTML preview. |
| CORS misconfiguration on R2 causes html2canvas to throw "tainted canvas" when loading the client logo | Medium | Verify the R2 bucket already sends `Access-Control-Allow-Origin: *` (or the admin origin) on image fetches. If not, that's a one-line config change on the bucket. Adding a quality gate above for this. |
| Atomic upload-and-persist race condition still possible if the auto-save PUT fires concurrently with the upload-route's UPDATE | Low | Both writes target the same `selections` JSON. Last-write-wins is fine; the upload route always reads-and-merges (not blind replace) so a concurrent auto-save won't lose a non-logo field. Document the merge behavior in the route comment. |
| Operator prints the PNG and the image is upscaled poorly on their print service | Low | PNG is delivered at 300 DPI (2400 x 3000 effective for 8x10). Most print services treat that as native and don't upscale. If the operator picks a service that misbehaves, the fix is on their end. |
| Client uploads a 5 MB logo that takes a long time on a slow connection, blocking the planner | Low | The upload is async; the user can keep editing other fields during the upload. UI shows a spinner. If they navigate away from MenuDesignStep mid-upload, the request still completes; the URL is persisted server-side on success. |
| The drink-name resolution in the admin GET response is a hot path slow query | Low | The cocktails and mocktails tables are small (~100 rows). A single JOIN with a small array of IDs is fast. Add an index if needed (no index changes planned for v1). |
| Bundle size growth on the admin app from html2canvas | Low | html2canvas is lazy-loaded; only fetched when the operator clicks the button. Initial admin bundle is unchanged. |
| Claude Design ships a visual that uses CSS html2canvas can't capture (e.g., backdrop-filter, complex gradients with transparency) | Medium | The visual brief explicitly constrains Claude Design to html2canvas-compatible primitives. Spec calls this out (§4.5). If a design choice breaks export, iterate the design (the preview is the source of truth; if it doesn't export, redesign). |

---

## 13. Implementation order (suggested)

1. Server: extend `GET /api/drink-plans/:id` with `signatureDrinkNames` and `mocktailNames`. Verify the join works.
2. Server: add the three logo upload routes. Test each with curl + multipart payloads.
3. Client: add `companyLogo: ''` to DEFAULT_SELECTIONS.
4. Client: create `menuSections.js` helper. Unit-test the section visibility logic with sample selections data.
5. Client: create `<MenuPreview>` with placeholder visual (just sections + drink names + a placeholder header). Render on MenuDesignStep when Standard is selected.
6. Client: add the logo upload UI on MenuDesignStep. Wire to the public upload route.
7. Client: scope the gallery button to Custom only.
8. Admin: add the Logo subsection on EventDetailPage with thumbnail, Replace, Remove, Download original.
9. Admin: create `<MenuPNG>` component with lazy-loaded html2canvas. Render it with the conditional button.
10. Visual pass: hand `<MenuPreview>` to Claude Design for the actual look. Iterate.
11. Final verification: walk the quality gates in §11.

---

## 14. Open questions (to resolve at writing-plans time, not now)

- The exact off-screen positioning trick for the hidden full-size `<MenuPreview>` during PNG capture. `position: absolute; left: -9999px` is one option; CSS `visibility: hidden` won't work (html2canvas needs visible layout). Verify the chosen approach captures correctly.
- Whether `<MenuPNG>` mounts the hidden preview on demand (then unmounts) or keeps it mounted off-screen. Tradeoff: mount-on-click is heavier per-click; persistent mount adds DOM weight to EventDetailPage. Plan-writing time decision.
- Whether the admin "Download original" link opens R2 in a new tab (simplest) or triggers a download via `<a download>` (cleaner UX but needs the right `Content-Disposition` header from R2). Plan-writing time decision.

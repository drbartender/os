# Design prompt: Package Contents Editor + Makeability Preview (admin, new surface)

> Per-surface prompt for a repo-linked claude.ai/design session. Executes `docs/superpowers/specs/2026-07-18-potion-planner-v2-design.md` §4.2, §4.3, §5, §6.2, §6.3.
>
> Design-system project: **Dr. Bartender OS Design System** (`72035042-c993-47e2-9dc8-c452b7bf5fa4`). Both skins must render.

## The one-sentence brief

Package contents stop being prose: this surface is where the owner edits what each package ACTUALLY contains (category pars, eligible bottles, slots), sees **live margin** at any guest count, and sanity-checks the result through the makeability preview, retiring the pricing spreadsheet and the four-disagreeing-sources problem for good.

## Grounding

- **There is no packages admin today.** `service_packages` rows are edited via SQL/DB console; the seed is INSERT-DO-NOTHING and the DB is the source of truth. This is a green-field admin surface; the session should propose its home (a new tab on `client/src/pages/admin/PotionsPage.js` beside Recipes and Pantry & Pars is the natural fit, but a standalone page is acceptable).
- Schema: `service_packages` (slug, name, description, category byob/hosted, pricing_type, base rates 3hr/4hr + small variants, extra_hour_rate, min_total, min_billed_guests, bartenders_included, guests_per_bartender, bar_type, `covered_addon_slugs TEXT[]`, `includes JSONB` display prose, is_active, sort_order) at `server/db/schema.sql:552+`.
- `par_items` (`server/db/schema.sql:3785+`): the ingredient/bottle catalog (role, spirit_key, style_key, aliases, qty_per_100). Gains a **cost column** in this project; the owner's cost spreadsheet imports nearly verbatim.
- The decided package lineup (contents changes, retirements, price holds) is spec §5; the editor's first data entry IS that table, including pinning Enhanced/Grand's vague bullets to real bottle lists.

## What to design

1. **Package list**: the ladder at a glance: name, category, bar_type, price points, active flag, sort order, a small margin readout. Retired packages (Refined Reaction) visible but clearly dead.
2. **Package detail editor**:
   - **Category pars**: rows like "Tequila: 4 bottles per 100 guests" with **eligible bottles** per category (split pars: multiple labels sharing the category volume; this is how Grand's for-show spread stays cheap). Add/remove categories and bottles from `par_items`.
   - **Slot config**: hard slot count (Base Compound: 2) vs featured slot count (Clear Reaction: 4) vs none.
   - **Covered generic classes** ("one red wine") alongside specific bottles.
   - **Marketing prose** (`includes`) edited separately and visibly labeled as display-only: sales copy and machine truth may differ on purpose, never by accident.
   - Existing pricing fields displayed (rates, min_total, min_billed_guests); editable is fine but price changes are rare and deliberate.
3. **Live margin panel**: at an adjustable guest count and hours, compute revenue vs cost (category pars x par_items cost + supplies + a labor assumption the owner can set in settings). Directional by design; label it so. This is the screen that retires `All-inclusive per person costs.xlsx`.
4. **Makeability preview** (the fun screen): pick a package, see every active recipe sorted into **in-tier / fenced with computed per-guest price / unmakeable**, recomputed live as contents are edited. This is the owner's sanity check after any recipe or package edit; the Formula-No.-5-has-no-citrus class of bug becomes visible instead of client-discovered. Cross-link: each drink opens its recipe card; each fenced drink shows which missing classes price the fence.

## What must not change (hard)

1. Coverage rules are computed exactly as the spec defines (recipe ingredients resolve against package contents; gap classes price via the class-to-addon mapping). The preview displays engine output; it never has its own opinion.
2. `includes` prose never drives logic.
3. Vanilla CSS, adminos patterns, both skins, no new deps.
4. Money display follows repo law: packages/proposals money is DOLLARS (never mix cents in display math).

## Definition of done

- Both skins. States: hosted full-bar package (coverage + fence), slot package (Base, Clear), display-only beer & wine package, retired package.
- The spec §5 lineup fully entered as mock data, with the makeability preview visibly catching a deliberately broken package (e.g. citrus removed from F5 kills the Margarita into the fence).
- Margin panel sanity-checked against the owner's spreadsheet ballparks (directional agreement, not equality).

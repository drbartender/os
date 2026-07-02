# Design prompt: the Compare Options page (`/compare/:token`)

> Per-surface reskin prompt for a repo-linked design session. Read `DR_BARTENDER_REDESIGN_BRIEF.md` first and obey its §2 hard rules; this doc adds only what is specific to this surface. This is a VISUAL pass on a working, live page: no logic, routing, data, or copy-meaning changes.

## What this page is

The client-facing side-by-side comparison for "proposal options." When a lead wants to see, say, BYOB next to a Hosted tier, admin sends ONE email with one link to `/compare/:token`. This page shows 2-3 options as columns; the client picks one with "Choose this one" and lands on that option's normal sign-and-pay page. The compare page itself is pure presentation: no agreement, no gratuity, no card entry, and it must stay that way.

Brand posture (brief §6): this is a FUNCTIONAL page in the ProposalView family. Sparse and clear; the apothecary recedes while the client is deciding. Think two bottle-label plates from the same printing house set side by side, not a poster. It should feel like a sibling of the proposal page ("The Prescription"): same paper, same brass, same typographic voice.

## The file

- `client/src/pages/proposal/compare/ProposalCompare.js` (single file; `OptionColumn` is an inner component; all styling is currently an inline `S` style object using CSS vars, matching the proposalView family's inline-styles convention).
- You may restyle the `S` object in place, or extract to `client/src/index.css` under a NEW `compare-*` class namespace (do not touch existing namespaces). No Tailwind, no CSS-in-JS, no new deps.
- Sibling reference for voice and tokens: `client/src/pages/proposal/proposalView/` (wax-seal Rx medallion, "The Prescription · For {name}" kicker, `var(--font-display)`, `var(--brass)`, aged-paper cards).

## Data the page renders (do not change the fetch or shape)

`GET /api/proposals/group/:token` returns:

- `client_name`, `decided`, `chosen_token`
- `event_header`: `event_type` (+`event_type_custom`), `event_date`, `event_start_time`, `event_duration_hours`, `guest_count`, `event_location`
- `options[]`: `token`, `status`, `package_name`, `package_slug`, `package_category` (`byob`|`hosted`), `pricing_type`, `total_price` (dollars), `deposit_amount` (dollars)

Per option, the client-side catalog (`getPackageBySlug(package_slug)` from `client/src/data/packages.js`) supplies `tagline`, `description`, `sections[]` (Spirits / Beer & Wine / Mixers & Modifiers / Non-Alcoholic, with brand-level items like "Tito's Vodka – ..."), and `serviceIncludes`. The current render shows item NAMES only (split before the "–") so two tiers scan cleanly row-band by row-band; you may show the witty descriptions if you find a treatment that keeps cross-column scanning easy, but names-only is the safe default.

## What must not change (hard)

1. All fetching, effects, and navigation: the redirects for `decided` and single-option groups, and "Choose this one" navigating to `/proposal/{option.token}?choose=1`.
2. All five states must remain visually handled: loading; error with a Try again button; "This comparison is no longer available."; decided (renders null while redirecting); single-option (same).
3. The non-catalog fallback: when `getPackageBySlug` returns null (class or custom package), the column shows name, total, and "Full details on the next page." with no sections. Keep a graceful version of this.
4. The deposit line logic: "Reserve with a ${deposit} deposit" vs "Full payment due at booking" when the event is within 14 days. Cosmetic mirror of a server rule; keep both variants.
5. Copy rules: no em dashes anywhere in client copy. "Choose this one" is the only action per column.
6. Responsive: columns are flex with wrap (side by side on desktop, stacked on mobile); wide content never causes page-level horizontal scroll.
7. Accessibility: buttons stay buttons, keyboard reachable; do not regress anything from the brief's §2.

## Design opportunities (where to spend the effort)

- The shared event header: currently a plain pill card of Date / Start / Guests / Location. Could become the "prescription header" moment: one typeset plate that frames both formulas.
- The option columns: give each the label-plate treatment (ornamental border, package name in display type, the BYOB / Hosted badge as a small stamped seal). Keep the two columns visually EQUAL; there is deliberately no "recommended" option in v1.
- The section headings (Spirits, Beer & Wine, ...) repeat across columns at the same heights when both packages are catalog tiers; lean into that natural alignment so the eye compares rows.
- The price block: total is the headline number; the deposit line is the whisper under it.
- The kicker currently reads "Your Options · For {client_name}" and the headline "Compare your {event type} options." Improve freely within brand voice; keep it client-warm, not salesy.
- One restrained magical-realism moment maximum (per the brief), if any: a brass pulse or hover lift on "Choose this one" is the natural candidate.

## Verify before finishing

- `cd client && CI=true npx react-scripts build` must pass (this is the Vercel gate; warnings fail it).
- Smoke both breakpoints on a 2-option group and a group containing one non-catalog package.
- Confirm the decided/single-option redirects still fire (open a decided group's compare link; it must land on the booked option).

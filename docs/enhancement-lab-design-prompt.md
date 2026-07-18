# Design prompt: The Enhancement Lab (new client surface)

> Per-surface prompt for a repo-linked claude.ai/design session. Read `DR_BARTENDER_REDESIGN_BRIEF.md` (repo root, §2 hard rules) and `docs/superpowers/specs/2026-07-18-potion-planner-v2-design.md` §3.3, which this session executes. This is a NEW page; there is no legacy CSS to inherit beyond the app base tokens.
>
> Design-system project: **Dr. Bartender — Apothecary Design System** (`e8719940-ff6f-4eb0-a39d-473d9a0591a8`). Same single-skin apothecary press as the planner (IM Fell, parchment on Midnight Ink, teal + brass). Suggested namespace `lab-*` or `potion-lab-*`, scoped to its own page class.

## The one-sentence brief

All selling lives here and nowhere else: a token-linked page that pitches enhancements against the client's actual submitted drinks by name, one tap to add, **invoice-only** (no card fields anywhere), closing when admin approves the shopping list.

## What it is

- Route on the same drink-plan token (own path, e.g. `/plan/:token/lab`; engineering decides the exact route).
- Entry points: the planner celebration CTA ("Enter the Enhancement Lab") and one follow-up email a day or two later, sent only if the window is open and nothing was added.
- Window lifecycle: **open** until shopping-list approval, then **locked** (read-only summary of what was added, or a graceful "the lab is closed for your event" if nothing was).

## Page order (spec law)

1. **Balance banner**, only when money is owed. Due soon: a visible line with the amount and a pay link out to the existing invoice surface. Past due: it leads the page. It never blocks adding upgrades.
2. **Your drinks, enhanced**: one card per submitted drink by name, showing only the enhancements that apply to it (smoke bubble on the Old Fashioned, carbonation on the Margarita, craft ginger beer on the Mule, craft ice someday). One tap adds with the real price shown per-guest AND multiplied out; tap again removes. **Nothing is ever pre-checked.**
3. **Housemade syrup upsell** (BYOB plans only): for each syrup-bearing drink, one card: "Upgrade to our housemade [flavor] syrup, hand-crafted in the lab, +$X." Adding flips the syrup off their shopping list onto our prep. Declining changes nothing and says nothing. No fork UI, no source radios.
4. **For the event**: champagne toast (serving style + toast timing + the coupe upgrade nested inside), real glassware, and for hosted plans the NA add-ons and the soft-drink add-on. On Formula No. 5 and Grand the toast presentation is **"classy, never carnival"**: a quiet, elegant card, not a deal banner.
5. **Running total** plus the one honest sentence: "Everything here is added to your event balance. No payment now."

## Data grounding

- Drinks come from the submitted plan (`drink_plans.selections`); enhancements and applicability come from the recipe database (per-drink enhancement assignments with pitch copy and bubble flavors; the migration from hardcoded `drinkUpgrades.js` is part of this project), pricing from `GET /proposals/public/addons` (`[{slug, name, rate, billing_type}]`, `per_guest` or flat). No price is ever hardcoded in copy.
- Additions land as line items via the existing extras/balance invoice machinery (engineering concern; the design only ever says "added to your balance").
- Craft ice and future enhancements are new DB rows; the page must be fully data-driven with no per-enhancement layout code.

## Tone

Apothecary lab voice throughout: this is the potions cabinet, the one place theatrical flourish is welcome. The smoke bubble, carbonation, and torch smoke ARE sciency showpieces; lean in. But the money language stays plain and calm, and premium tiers get the understated treatment.

Also design the **follow-up email** (one template): same voice, the client's drinks by name, one CTA back to the Lab, and the balance line riding along when money is owed (this email is a payment prompt wearing a fun costume; that is intentional and should stay subtle).

## What must not change (hard)

1. **No card fields, no Stripe elements, no checkout of any kind.** Invoice-only is the entire point.
2. Nothing pre-checked, no dark patterns, prices always visible before and after adding.
3. The balance banner links OUT to existing invoice/proposal pay surfaces; it never embeds payment.
4. Vanilla CSS in `client/src/index.css`, no new deps, no Tailwind. No em dashes in client copy. NA beer copy is Athletic Brewing only.
5. Window close is driven by shopping-list approval (existing admin gate); the page never invents its own deadline language beyond "before we finalize your shopping list".

## Definition of done

- States: open with nothing owed, open with balance due soon, open past due, locked with additions, locked without additions, open-but-empty (no applicable enhancements: page should still feel worth the click, not broken).
- BYOB variant (with syrup section) and hosted variant (without it, with NA add-ons).
- 390px first, desktop second. Vercel gate: `cd client && CI=true npx react-scripts build`.

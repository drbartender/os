# Compare and book on the proposal page

Design doc, 2026-08-11. Supersedes the hand-built alternatives flow for the
package-vs-package and add-on-variant cases.

## 1. The problem

Dallas builds two or three sibling proposals by hand, groups them, and sends a
`/compare/:token` link. It works, and he does not like it: "we send this
convoluted 'alternative options' link with a bunch of different proposals. It
works, but it should be so much easier/smoother."

Three concrete failures behind that feeling, all verified against prod:

1. **The comparison runs together.** `PackageMatrix.js` renders each catalog
   section as `items.join(', ')`, so the Spirits cell is a comma run-on of eight
   bottle names. Dallas: "the list is run together and hard to compare, bullets
   or something would be better."

2. **It compares packages, not what the client is actually choosing.** Of the 13
   real comparison groups in prod, 10 differ by package and 2 differ only by an
   add-on on the same package. Group 15 is two "The Core Reaction" options at
   $350 and $500 whose entire difference is Ice Delivery, and the page renders
   two visually identical columns with an unexplained $150 gap. Group 7 is the
   same shape, $850 vs $1000, difference is a Banquet Server. Add-ons are not in
   the compare payload at all: `OPTION_SELECT` in `compareGroup.js` is a positive
   allowlist that never selects them.

3. **The good version of this already exists and the feature turns it off.**
   `ExplorePackagesSection` prices every active package against the proposal's
   real numbers and renders the same matrix. `ProposalView.js:656` reads
   `{!inOptionGroup && <ExplorePackagesSection ... />}`, so sending alternatives
   explicitly suppresses it. Its "I want this one" is a `mailto:`, deliberately,
   because a client changing the package on a sent proposal is a client-driven
   write to a money column.

## 2. What we are building

**The proposal Dallas sends is the page and the starting point.** A client who
wants the $350 Core Reaction opens it, sees what he sent, signs, and pays, with
nothing new in the way. That path must not get slower or noisier.

**The comparison is a second step, taken only if they want it.** It opens with
Dallas's option marked current and every other option priced alongside it, using
the event's own fixed numbers. Dallas: "Many just want that $350 tier and that is
fine, but I want them to be able to see other options if they want. The initial
proposal that we create should be the starting point."

**The unit of comparison is a configuration, not a package.** A configuration is
a package plus, on BYOB, its support tier, plus any extras. This is what makes
"Core Reaction with Full Compound" a single thing a client can weigh against "The
Enhanced Solution." Today BYOB always shows as the bare $350 Core Reaction with
no tier priced onto it, which makes it look artificially cheap beside a hosted
column.

**They can sign and book whatever they pick, without Dallas.** Decided
explicitly: "sign and book rn is what we want."

There is no cap to raise. Sibling proposals stop being how alternatives are
expressed, so the `MAX_OPTIONS = 3` question dissolves. Comparing two options or
six is a view, not a set of rows in a table.

## 3. What already exists (read this before building anything)

Most of the hard parts are written. Rebuilding any of it would be the main way
this design goes wrong.

| Need | Already exists |
|---|---|
| BYOB tier definitions, what each covers, what each supersedes | `client/src/pages/website/quoteWizard/bundleConfig.js`, mirrored in CJS by `server/utils/proposalRules.js` (manual mirror, marked KEEP IN SYNC) |
| Tier mutual exclusion, mixer mutex, `requires_addon_slug` prerequisites, hosted 25-guest floor, glassware caps | `validateProposalRules()` in `server/utils/proposalRules.js` |
| Refusing to double-charge for items a tier already covers | `stripIncludedAddons()`, same file, written specifically against scripted POSTs |
| Which add-ons a client may see, including `applies_to` lane gating and hiding the parking fee | `filterAddons()` in `client/src/utils/proposalRules.js` |
| Safe reprice of a client-proposed end state, preserving `total_price_override`, adjustments, syrups, and stored gratuity | `priceProposedState()` in `server/utils/changeRequests.js` |
| Pricing a full configuration including add-on ids and quantities | `POST /proposals/public/calculate` already accepts `addon_ids`, `addon_quantities`, `syrup_selections` |
| The package/tier/extras pickers | `quoteWizard/steps/PackageStep.js`, `ExtrasStep.js`, `extras/BundlePicker.js`, `extras/AddonAccordion.js`, `extras/AddonTile.js`, `WizardPriceBar.js` |
| The aligned comparison matrix | `PackageMatrix.js` (needs configurations rather than packages, and bullets) |

**Decision: the proposal page mirrors the quote wizard exactly.** Same visible
add-ons, same rules, including staffing add-ons, which `filterAddons` does not
hide and which a cold lead can already select today. Dallas: "I'm ok with
mirroring the same things the quote wizard can do." `filterAddons` is therefore
the single source of truth for what a client may pick, and this design adds no
second curation concept and no `client_selectable` column.

## 4. The surface

On `/proposal/:token`, unchanged above the fold: the proposal as sent.

A clearly visible entry into the comparison, not the buried "Compare packages for
your event" toggle it is today. Opening it shows the event's fixed numbers stated
once and not editable (date, guest count, duration, bar count), then every
available option as a compact card carrying its real price for this event.
Dallas's current option is marked current.

Selecting cards pins them into the aligned matrix, which renders contents as
bullets rather than the comma run-on. Pinning is what "compare whichever ones
they want" means, and it is why the number of options never needs a limit.

Choosing an option opens its configuration (tier on BYOB, extras) with a live
total, reusing the wizard's pickers. Then sign and book.

Class packages are excluded, matching the existing
`filter(p => p.bar_type !== 'class')` in explore mode. Classes have their own
wizard.

The comparison is offered only while the proposal would still pass the sign
endpoint's own guard, that is `client_signed_at IS NULL` and the status is not
already accepted, paid, confirmed, completed, or archived. Once signed, the
configuration is what they signed for and is frozen. The UI never defines its own
eligibility rule; it mirrors the guard the server already enforces.

## 5. The money seam

**Browsing writes nothing.** Every price comes from a read-only pricing call. A
client who explores and leaves changes nothing, matching the election-at-payment
precedent where an abandoned checkout leaves the proposal untouched.

**The commit point is the signature**, in the public sign endpoint in
`server/routes/proposals/publicToken.js`. That endpoint already performs one
atomic UPDATE guarded by `client_signed_at IS NULL AND status NOT IN (accepted,
deposit_paid, balance_paid, confirmed, completed, archived)`, and it already folds
conditional extra fields (the venue capture) into that same statement. The chosen
configuration joins that write, so a replayed or raced sign cannot reconfigure
twice: it fails the same guard that already stops a double signature.

Five rules, in order of how badly they hurt if broken.

**5.1 The client sends a configuration, never a price.** The request carries
`package_id`, `addon_ids`, `addon_quantities`, `addon_variants`. The server
re-prices through `priceProposedState()` using the proposal's own stored
`guest_count`, `event_duration_hours`, and `num_bars`, read under the row lock.
Event parameters are never taken from the request body. The client picks what,
the server decides how much. This is the exact failure that overbilled Jack Van
Dyke $627 and put `drinkPlans/submit.js` on the sensitive-paths list, and the new
write is the same species: a public token-gated handler writing `total_price` off
client-supplied selections.

**5.2 If they changed nothing, we write nothing.** A signature with no
configuration in the body takes today's path byte for byte. Most bookings never
open the comparison and must not be exposed to any of this. This is also what
makes the feature safe to ship: the blast radius is limited to clients who
actively chose something else.

**5.3 The total the client saw is the total they get.** The request carries an
`acknowledged_total`. If the server's recomputed total differs, the signature is
rejected with a conflict carrying the new number, and the client re-confirms.
Silently charging a number different from the one on screen is not acceptable
even when the server's number is the correct one. `changeRequests.js` already
treats `acknowledged_total` as a non-field, so the concept exists.

**5.4 Override-locked proposals never get this.** 32 proposals carry a
`total_price_override` and 16 of those are live and payable. Those are negotiated
prices. Those proposals do not render the comparison at all (Dallas: "it can just
not appear for them"), and the sign endpoint rejects a configuration on one as a
server-side backstop. Note that `priceProposedState()` would in fact preserve the
override; the exclusion is belt and braces on a number Dallas agreed by hand.

**5.5 Order is load-bearing.** The configuration commits at signature, which
happens before `create-intent`. `create-intent` writes nothing and derives its
charge from the stored `total_price` and `pricing_snapshot`, and the gratuity
election derives staff count and hours from that same snapshot. Committing the
configuration first means `create-intent`, the PaymentIntent metadata, and the
`payment_intent.succeeded` webhook all require no changes whatsoever.

**Transaction shape.** `proposal_addons` is a separate table, so the sign handler
needs a real transaction rather than today's sequence of bare `pool.query` calls.
Under CLAUDE.md's one-pooled-connection rule, every query in the handler must then
run through the single checked-out client, and the post-commit best-effort tail
(phone capture, activity log, notification emails) must either use that client or
run after it is released, since helpers there take their own connections. This is
the documented SERVER-17 and capture-lead deadlock, and converting this handler is
the most likely place to reintroduce it.

Inside the transaction, in order: lock the proposal row; reject a configuration on
an override-locked or non-signable row; reprice via `priceProposedState()`;
compare against `acknowledged_total`; run the existing guarded sign UPDATE
extended with `package_id`, `total_price`, and `pricing_snapshot`; rewrite
`proposal_addons` only if that UPDATE returned a row; re-derive the invoice
minted at send, which is stale the moment the total moves; commit.

**`deposit_amount` is deliberately not written.** It is not derived from pricing:
`calculateProposal` never returns a deposit, nothing in the normal flow writes the
column, and `create-intent` falls back to the standard `DEPOSIT_AMOUNT` constant
when it is null. A non-null value is therefore a deposit Dallas set by hand for
that client, and a configuration change must neither recompute nor clear it.

"Non-signable" here means the existing guard on that UPDATE, not a new list. The
statement's own `client_signed_at IS NULL AND status NOT IN (...)` condition stays
exactly as written and remains the single definition of who may sign.

## 6. Explicitly not in scope

- **Retiring the alternatives groups.** The group machinery
  (`commitGroupChoice`, loser archiving, invoice voiding) stays in place and
  unused, and is retired in its own pass once the new path has carried real
  bookings. Deleting live money code as a side effect of a build is how this goes
  wrong. Note `sweepClientAlternatives` also governs ungrouped alternatives and
  is independent of this work.
- **Changing event parameters.** Guest count, duration, and date stay fixed on
  this surface. That is what the change-request flow is for, and mixing the two
  would put a client-editable guest count on the checkout path.
- **Class packages**, which have their own wizard.
- **Admin-side changes.** Dallas keeps building proposals exactly as he does now.

## 7. Risks and open items

**Sharing the wizard's pickers means editing the live lead funnel.** Those
components sit under `pages/website/` in the marketing skin. Extracting them into
shared components and pointing the wizard at the extracted version gives one
implementation and no drift, but it edits top-of-funnel lead capture. Agreed
approach: do the extraction, in its own step, with a browser walk of the wizard
before merge, rather than copying and maintaining two versions.

**The bundle config is a manual mirror.** `bundleConfig.js` and
`server/utils/proposalRules.js` are kept in sync by hand and marked as such. This
design adds a third consumer of the rules but no new mirror. Any edit still has to
touch both.

**The grouped-proposal redirect interacts with removing the suppression.**
`ProposalView.js` bounces a grouped proposal to `/compare/:token` unless
`?choose=1` is present. Removing `!inOptionGroup` without accounting for that
redirect will produce a loop or a dead end for proposals that are still in groups.

**Invoice re-derivation is named but not specified.** The obligation is stated in
5.5; which function satisfies it (`refreshUnlockedInvoices` or a sibling in
`invoice*.js`) is an implementation question for the plan, and it is on the
sensitive-paths list.

## 8. Test obligations

The regression guard that matters most: **a signature with no configuration
produces exactly the writes it produces today.** That test is what protects every
existing booking.

Beyond it: sign with a configuration writes package, addons, total, snapshot, and
deposit atomically; a configuration on an override-locked proposal is rejected; an
`acknowledged_total` mismatch is rejected rather than charged; a submitted tier
plus an item that tier already covers is stripped and priced once, not twice; a
rule-violating configuration is rejected; a replayed sign hits ALREADY_ACCEPTED
and does not reconfigure; and the invoice matches the committed total.

Review posture: the sign-endpoint lane is a public token-gated write to
`total_price` and gets the full fleet plus cross-LLM at push, per the
sensitive-paths contract.

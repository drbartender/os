# Walkthroughs Owed

**Created 2026-08-11.** One checklist for every piece of shipped, live-in-production work
that nobody has actually looked at in the app.

Why this file exists: Dallas found a feature that had been built and buried. That is not a
one-off. This category was scattered across a dozen project memory entries and several
sections of the fix list, each saying "owed a walk" in isolation, so the size of it was
never visible in one place. It is large.

Everything here is **already running in production**. None of it is a build. The risk is
not that the code is broken; it is that nobody knows what it looks like, so a feature that
shipped wrong or shipped invisible stays that way.

Sourced from project memory and the fix list. Memory reflects what was true when written,
so tick items off as you confirm them rather than assuming the list is current.

---

## Tier 1 — money moved, and nobody watched it land

- [~] **cancel-line-item — PREVIEW HALF WALKED 2026-08-12** (Dallas, proposal 678, Real
      Glassware Upgrade $125). Target matching, the fold, and the invoice math all correct:
      total $750 → $625, Balance invoice $650 → $525, Deposit untouched, no refund offered.
      Close and "Never mind" both work. **Found a real bug:** every admin modal is a boxless
      ghost in House Lights — see the 2026-08-12 section of the fix list.
      **The Stripe refund half is still owed, and cannot be walked on demand.** Checked prod
      2026-08-12: no live booking can produce it. Every fully-paid proposal carrying real
      `proposal_payments` rows is a past `completed` event, and the only fully-paid FUTURE
      booking (604, $550) has zero payment rows and zero invoices — the CC-transfer shape,
      so there is nothing to refund against. The trigger needs a client who has paid in full
      and then drops a line before their event. When that next happens, do it deliberately
      and watch, rather than manufacturing a case.
- [ ] **Gratuity election-at-payment: 2 walks.** Complete 2026-08-04. The election now
      rides PaymentIntent metadata and persists only on payment success. Confirm a normal
      tip-jar checkout and a skip-the-jar checkout both land the right gratuity.
- [ ] **Admin gratuity mandate on Lauren Karcz (proposal 719).** Live 2026-08-10. The
      mandate path has never run on a real booking.
- [ ] **Owner no-draw payouts, post-deploy walk.** Pushed 2026-08-07 with prod DDL and a
      backfill (4 rows `no_draw`, period 72 paid). Confirm the payroll screen reflects it.
- [ ] **Service extension, in-app pass.** Pushed 2026-08-04. Code-level verification of the
      `event_duration_hours` consumers is done; the browser pass was explicitly deferred.
      With a settled extension on a dev event, check staff event details, the admin BEO, the
      calendar feed, the client portal, the Money Board, and the events list.
- [ ] **Duty pay walks.** In progress. Flat $50 hosted supplies, the out-of-area knob, and
      the ShiftDrawer knob.
- [ ] **Money Board eyeball + the manager walk.** Live since 2026-07-10 and still unwalked.
      Both skins, the rainbow palette, 390px, chart hover/zoom/Compare. The manager walk
      needs a prod manager account, and the network tab must show **zero** `/admin/payroll/*`
      calls.

## Tier 2 — client-facing, shipped, unseen

- [ ] **Notify-client confirmation, browser walk.** All 3 lanes live 2026-07-24.
- [ ] **Staff event-details redesign walkthrough.** Shipped 2026-08-03.
- [ ] **Mobile: real-phone wizard walk + signing.** Live 2026-07-04. Needs an actual phone,
      not a viewport emulator.
- [ ] **Needs-attention tabs, prod smoke.** Live 2026-07-14.
- [ ] **Global search / ⌘K palette smoke.** Live 2026-07-09.
- [ ] **Quote-wizard Extras UI.** 8 fixes shipped; 4 of them are `schema.sql` copy changes
      that only become visible on deploy. Nobody has confirmed the deployed copy reads right.
- [ ] **After Hours skin sweep, both skins:** the event page, a dashboard, blog-editor
      fields, primary-button hover.
- [ ] **Doc-preview modal, both skins,** with a real W-9 PDF and a real headshot.

## Tier 3 — new in the 2026-08-11 push, never seen by anyone

- [ ] **Voicemail listen link.** Miss a call to the 1922, confirm the alert SMS arrives with
      a working link, and confirm the audio plays on a phone. Also confirm
      `VM_LISTEN_LINK_ENABLED=false` kills BOTH the route and the link line in the SMS.
- [ ] **Tip sign download.** Download a sign as jpg, png, and pdf, and the two-sided card as
      pdf. Confirm a bartender with no Stripe link is not offered Card.
- [ ] **Staff recipes.** Open a spec at the bar and confirm real ingredients render, not
      `[object Object]`.
- [ ] **First-name greetings.** Confirm a normal client gets "Hi Monica," and a couple gets
      "Hi Aubrey & Dominic,". The couples case was fixed at the push gate and has unit
      coverage, but no rendered email has been read by a human.
- [ ] **Guest count in the event header.**
- [ ] **Inbound SMS alerts naming the staffer.**

## Tier 4 — gated: do these BEFORE the thing they gate

- [ ] **Potions recipe review pass** — 6 low-confidence drafts of ~41. **This gates the prod
      `seedRecipeDrafts` run** (dry-run first), because `package_items` existence flips
      hosted coverage live and `coverageContext` has no recipe-review filter, so fence
      charges would derive from unreviewed recipes.
- [ ] **Potion Planner v2: both gates before the lineup script's prod run.** (1) Extend
      `applyPackageLineup2026.js` to also UPDATE the changed packages'
      `service_packages.includes` prose and refresh the stale seed copy, or four public
      surfaces keep serving retired-lineup copy. (2) The recipe pass above.
- [ ] **Thumbtack first-reply: the next real lead.** The programmatic draft-clear fix is
      live on the box but has only been proven against captured diagnostics, never a live
      lead. Until one lands, the pipeline is unproven.
- [ ] **`refreshDisplayNames.js --check` against prod** after the first week of organic
      writes (display names shipped 2026-08-06).
- [ ] **CC seniority mapping**: generate, hand-review, then `--apply`. Human-gated.
- [ ] **Display-name walkthroughs T6 and T10-T13**, plus the seniority panel smoke.
- [ ] **Deactivate the two Stripe test Payment Links** (`plink_1U0nVQ…`, `plink_1U0nVP…`).
      Admin-blocked for Claude; only Dallas can do it.

## Tier 5 — never exercised end-to-end

- [ ] **Comms SMS smoke, end-to-end.** Never run: dispatcher heartbeat, sign+pay
      orientation, .ics open, drink-plan submit, STOP/START, CONFIRM/CANT, duplicate
      MessageSid idempotency, prod Twilio signature.
- [ ] **Onboarding optional-tip-handle checks.** Four specific cases: Check payout with no
      handles finishes; Venmo payout with a blank handle still blocks; direct deposit plus
      an optional Venmo tip handle works; `/my-tip-page` Cash App save works.

## Wildlight

- [ ] **Journal 500 fix — Dan's e2e retry.**
- [ ] **Prodigi gate 5 — a second-paper order.** First real order (2026-08-10) submitted and
      called back correctly on one paper only.
- [ ] **Stripe refund webhook.** Live signature proven on the first real order, but the
      refund path has never fired in production.
- [ ] **Discount code live redemption.** Shipped 2026-08-08; the first live attempt failed
      before payment for an unrelated client-side reason, so a code has still never been
      successfully redeemed in production.

---

## How to use this

Work top-down. Tier 1 is where being wrong costs money, and Tier 4 items are gates — doing
the gated thing first is how the fence charges derive from unreviewed recipes.

When you finish one, tick it and delete it. When a walk finds a defect, the defect goes to
the fix list, not here. This file should shrink.

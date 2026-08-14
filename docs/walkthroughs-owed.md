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
- [x] **Gratuity election-at-payment — PASSED 2026-08-12.** Verified two ways. (1) From prod
      data, the invariant this feature exists to enforce holds table-wide: ZERO unpaid
      proposals carry a client-elected gratuity, ZERO carry an unpaid no-jar election, and
      all 7 no-jar proposals sit exactly at the $50 floor. Seven real checkouts since 8/04
      all landed `tip_jar=true` with a coherent rate. (2) Dallas walked the no-jar path on
      proposal 731 (the branch none of those 7 exercised, since all predate the rewrite):
      UI showed $150 gratuity, total $300 → $450, then abandoned. The PaymentIntent carried
      `tip_jar:"false"` / `gratuity_rate:"50"` / amount 45000 — so it WOULD have applied —
      while the proposal row stayed `tip_jar=true`, `rate=0`, `total=300`, and the activity
      log recorded only a `viewed`. Both halves proven without spending anything.
      Bonus: the prior $300 intent was CANCELED one second before the $450 one was minted,
      so the stale-election replacement path works rather than stacking duplicates.
- [x] **Admin gratuity mandate — PASSED 2026-08-12 on Lauren Karcz (719).** Dallas removed
      a hand-rolled $100 surcharge line and ticked "Require prepaid gratuity" instead. The
      mandate reproduced his manual figure exactly: snapshot reads
      `rate 50 / hours 2 / staff_count 1 / total 100 / tip_jar true / floor_rate 50`, the
      breakdown carries a clean `Gratuity 100` line with no remnant of the old surcharge,
      and `total_price` held at $350 (350 base − 100 short-event discount + 100 gratuity).
      Critically `floor_rate` IS persisted into `pricing_snapshot.gratuity` — the writer
      that, if it dropped the key, would strip the checkout floor client-side while the
      server still enforced. Was prod's FIRST mandate ever (count was 0).
      CLOSED 2026-08-13: Dallas checked her checkout on a real phone — the $100 renders as
      required and an error appears on any attempt to set it to $0. The client-side floor
      holds. The mandate is now verified end to end: admin entry, snapshot persistence,
      derived rate, and client-side enforcement.
- [x] **Owner no-draw payouts — PASSED 2026-08-12.** Exactly one contractor carries
      `takes_draw = false` (user 12, Dallas). His four payouts (80, 83, 92, 98) all sit at
      `status = 'no_draw'` with `paid_at` null — tracked, never owed — and the payroll screen
      renders the line correctly rather than as an outstanding balance. Confirmed structurally
      that a `no_draw` row does NOT block period closure: `maybeFinalizePeriod` counts only
      `pending`, and periods 72 and 89 both closed while holding one.
      SIDE CATCH, now cleared: periods 76 (7/21-7/27) and 80 (7/28-8/03) had been sitting in
      `processing` for weeks with zero pending payouts. NOT a bug — `POST /payroll/periods/:id/process`
      re-runs the finalize check precisely for the "all paid pre-reopen" case and is the only
      place that flip can happen, since mark-paid can never run on a period with nothing
      pending. Reopen → Process closed both immediately. Worth knowing as an ops move: a
      period stranded in `processing` with nothing pending is closed by Reopen then Process,
      not by SQL.
- [x] **Service extension, in-app pass — PASSED 2026-08-13/14 on dev** (fixture: Sean
      Parent, Aug 30, 5h -> 6h, end 10 -> 11 PM, settled via the real `settleExtension()`
      then finalized by the heal sweep — which had also never run and verified itself in
      the process; see git history of this entry for the full fixture story).
      All six surfaces read the extension correctly: staff event details (walk, 8/13),
      admin event page/BEO + Money Board render + events list (Dallas, "admin looks good"),
      calendar feed (verified by curl: DTEND 23:00 America/Chicago, SEQUENCE advanced), and
      the client view — where the correct 5:00 PM – 11:00 PM range is itself the PROOF,
      because `ProposalHeader.js:40` computes the end time from `event_duration_hours`; a
      stale read would have shown 10:00 PM. No stale read anywhere.
      NOTE, not a defect: the client page shows duration as the time range, never as an
      explicit "N hours" label. Dallas noticed; adding "(6 hours)" to the header is a
      one-liner awaiting his call on the copy.
      CLEANUP still owed: dev extension 714 + proposal 7's bumped hours (now safe to revert
      any time, or keep as a standing extension fixture).
- [x] **Duty pay — MONEY VERIFIED 2026-08-12.** All six production duty lines sit at exactly
      the specced flat amounts: `bar_rental` 3 x $20, `hosted_supplies` 2 x $50 (the flat-$50
      hosted decision of 2026-08-07 is live and correct), `menu_print` 1 x $5. The
      hosted/BYOB either/or held on every event: the three BYOB events got `bar_rental` only,
      the one hosted event got `hosted_supplies` + `menu_print` and no `bar_rental`. Two
      admin-added lines behaved correctly, including one Dallas removed and did not pay.
      **NOTHING IS OWED to anyone for duty.** Duty pay shipped 2026-08-07; any event or
      period ending before that could never accrue, so a missing pre-feature duty line is
      correct, not an unpaid staffer. See [[reference-duty-pay-effective-date]].
      ONE DEFECT FOUND, logged: a duty attribution into a non-`open` period is a SILENT
      no-op — the endpoint accepts it, accrues nothing, and only warns to Sentry. Fix is to
      refuse loudly; do NOT let accrual accept `reopened` (fix list, 2026-08-12 section A).
      Not walked: the out-of-area knob and the ShiftDrawer knob — pulled out as their own
      item below so they cannot hide inside a checked box.
- [ ] **Duty-pay knobs: out-of-area + ShiftDrawer.** The two knob surfaces from the
      duty-residuals lane (merged afb6e5e6): the out-of-area no-op/auto-lock semantics and
      the ShiftDrawer knob (spec §9). Money math around them verified 2026-08-12; the knobs
      themselves have never been touched in the app.
- [x] **Money Board — CLOSED 2026-08-14.** Mobile/skin half walked 8/12 (found and fixed
      the see-through House Lights drawer). Desktop chart pass effectively done by finding:
      Dallas hit the day/week granularity hole and ruled "that whole chart is gonna need a
      bit of work" — the rework is a queued project (fix list 2026-08-12), so further
      palette/hover polish review of the current chart is moot.
      MANAGER WALK — BACKBURNERED BY DALLAS 2026-08-14 ("don't really need the manager role
      rn"), accepted with a TRIPWIRE: prod has zero manager accounts, so the payroll-
      exposure this checks is unreachable today. **The day anyone is promoted to manager,
      this walk becomes mandatory before they log in**: dashboard as the manager, devtools
      Network filtered to `payroll`, zero `/admin/payroll/*` requests. Dev stays ready
      (`manager-test@drbartender.com`, and note the walk must run on plain `localhost:3000`
      — the `staff.localhost` host is the staff portal for every role by design).

## Tier 2 — client-facing, shipped, unseen

- [x] **Notify-client confirmation — PASSED 2026-08-12 on dev** (proposal 16301, a booked
      `deposit_paid` fixture). Modal appears on a notifiable change; the notify box is
      **ticked by default**, i.e. the product decision is opt-OUT; the draft renders
      old-vs-new; the text is editable; it renders correctly in House Lights.
      MONEY HALF VERIFIED FROM THE DB, which is better than the screen: the save moved
      `event_start_time` 18:00 -> 19:00 and `event_date` 09-09 -> 09-10, and re-anchored
      `balance_due_date` to **2026-08-27** — exactly the documented no-existing-due-date rule
      (`event_date - 14d`). The reschedule's balance recompute is correct.
      FIRST ATTEMPT WAS A BAD FIXTURE, not a bug: proposal 7368 is status `viewed`, and
      `reschedulableStatusOk` requires `BOOKED_STATUSES = deposit_paid | balance_paid |
      confirmed | completed`. A client who has only viewed a quote correctly gets no
      "your event moved" notice.
      STILL UNVERIFIABLE ON DEV: the actual send + `message_log` row. `email.js:64` returns
      `{id:'dev-skipped'}` BEFORE `logClientMessage`, so a gated send writes no row, and the
      dev server's stdout is a socket with no readable log. Proving the send needs prod.
- [x] **Staff event-details redesign — WALKED 2026-08-13 on dev** (as `marcus.j@test`, shift
      14, via `http://staff.localhost:3000`). Also closes the staff-details surface of the
      service-extension pass: the page correctly reflects the settled extension at **6 hours
      / service to 11:00 PM**, so no stale read.
      FOUND: the page never lists required equipment even though the server sends it — see the
      2026-08-13 fix-list entry. Matters more since duty pay now pays for equipment handling.
      NOT A BUG: no drink specs shown because plan 11 is `pending` / not finalized, which is
      the correct gate.
      ACCESS RECIPE (supersedes the 54-day-old localStorage workaround in memory):
      `staff.localhost:3000` just works — `getSiteContext()` keys on the `staff.` prefix and
      CRA's host check does not block it. No code override needed.
- [x] **Mobile: real-phone wizard walk + signing — WALKED 2026-08-13** on a real phone over
      cellular, against prod. (Dev was ruled out: the dev CORS rule is
      `^http://(?:[a-z0-9-]+\.)?localhost(:\d+)?$` so a LAN IP origin is rejected, and
      `client/.env` points the client at `localhost:5000`, which on a phone means the phone.
      Making it work needs two config changes and two restarts on a shared box.)
      SIGNING SURFACE: clean. Signature pad, terms and payment fields all work on a phone.
      FOUND: the quote wizard's TimePicker crowds three sub-minimum tap targets into 48px
      with no responsive rules at all — fix list, 2026-08-13. Public lead-capture surface.
- [x] **Needs-attention tabs — PASSED 2026-08-13.** All four data tabs verified accurate
      against prod after three of my own approximations disagreed with them and the tabs won
      every time: Staffing 14 = 10 short-staffed + 1 applications + 3 uncertified; Clients 0
      is right (92 of 116 unread inbound are Thumbtack relay, the other 24 have no
      client_id); Sales = sent-unviewed-past-72h by design. PRODUCT CALL LOGGED: the Money
      tab is payroll-only now that all 213 payout lines are matched, and Dallas wants payroll
      rehomed — fix list 2026-08-13, including the warning that the unmatched-payout alarm
      needs a new surface if the tab goes away.
- [x] **Global search palette — PASSED 2026-08-13.** Staff search groups correctly (`Teah`
      under Staff), client search resolves the record plus its proposal (`Lauren Karcz` ->
      proposal 719), and the empty-state Jump to list is complete. Note the shortcut is
      **Ctrl+K on Linux** — `AdminLayout.js:110` accepts `metaKey || ctrlKey`, so Cmd+K is
      Mac-only.
      FALSE ALARM I CAUSED: I first gave `Marcus` as the staff target, which returned "no
      matches" — correctly, because Marcus is a DEV-only fixture (`marcus.j@test`) and prod
      has zero users matching him. Verify a search target exists in the environment being
      walked before calling a miss a bug.
- [x] **Quote-wizard Extras UI — DONE 2026-08-13 (data + render).** All
      four guarded `schema.sql` description UPDATEs checked against prod directly. Three are
      live and correct: `non-alcoholic-beer` (Athletic Brewing only, Heineken gone),
      `zero-proof-spirits` (Lyre's), `specialty-niche-liqueurs`. The fourth,
      `soft-drink-addon`, never applied and never can — prod holds a third, better, 257-char
      text that matches neither the guard nor the replacement, so schema.sql is permanently
      wrong about that row and a rebuilt environment would ship different copy than
      production. Logged in the fix list (2026-08-13).
      CLOSED 2026-08-13: Dallas read them live. Two render fine; NA beer named varieties he
      does not want in catalog copy — fixed the same hour (brand-only, prod + seed + guards
      aligned; copy law recorded).
- [x] **Skin sweep, both skins — DONE 2026-08-13, and it found the day's biggest structural
      item:** the rich text editor never got a skin pass and sits on FIVE admin surfaces
      (blog, campaign create, sequence steps, email builder x2) in the old pre-split
      marketing vocabulary — fix list 2026-08-13, sequenced into the marketing redesign.
      Salvage from the contrast pass: `--ink-4` placeholder/disabled text genuinely fails in
      BOTH skins (2.16 / 2.78); the old "danger ~2.56" ledger figure no longer reproduces
      (6.51, passes). The event-page/dashboard/button-hover legs were folded into the Money
      Board and doc-preview walks rather than repeated.
- [x] **Doc-preview modal — PASSED 2026-08-13**, both skins, with Dallas's real W-9 PDF and
      headshot. Properly adminos-scoped with adaptive tokens (`--bg-elev`/`--ink-1`/
      `--line-2`) — the model for what an admin overlay should be.
      DATA FIND while picking the target: **Zul's W-9 slot holds a screenshot .png that is
      the same file as her headshot** — a mis-upload, and a 1099 input. Fix list 2026-08-13,
      with a sweep of `w9_filename` for other non-PDFs.

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
- [x] **Guest count in the event header — PASSED 2026-08-13** ("yes").
- [ ] **Inbound SMS alerts naming the staffer.**

## Tier 3b — shipped 2026-08-13, live in prod, never eyeballed

The walkthrough fixes themselves now need the same medicine. Both of the first two shipped
BROKEN on the first attempt and were corrected blind by a later session (`54fb77cb`,
`fc5e6ca2`) — nobody has seen any of these render.

- [x] **TimePicker on a real phone — PASSED 2026-08-13** ("good"). Steppers gone, chevron
      tappable. The fix that shipped inert once is now proven on the device it targets.
- [ ] **Equipment label on a staff shift — RETARGETED 2026-08-13.** Dallas checked his own
      shifts (367/373) and saw no card at all — CORRECT, their `equipment_required` is
      `'[]'` (and that mismatch with their paid bar_rental duty is now its own fix-list
      item). The three shifts that actually carry `["portable_bar"]` are 368 (kpduffy),
      347 (loryn), 366 (jaszyjay) — all past events, other staffers. Verify via one of
      their views, or on dev by setting equipment on a fixture shift.
- [ ] **Bar-required transport ack + card (built 2026-08-13, unseen).** On dev
      (`staff.localhost:3000`, marcus.j): open shift 14 (Sean Parent) — the Equipment card
      must lead with "Portable bar — DRB bar pickup at the Pilsen storage unit, or bring
      your own", and hitting Request on any bar-carrying open shift must demand the
      transport acknowledgment naming the bar. Also read the corrected cooler copy (brought
      EMPTY) on the card and in the FieldGuide kit list.
- [ ] **Shopping-list guest-count prompt in House Lights.** `ShoppingListButton.jsx`'s modal
      was the panel my `--include=*.js` sweep missed and was patched with `.modal-card`
      AFTER the other eleven were confirmed — it has never been seen. Open a drink plan in
      House Lights and hit the shopping-list button with no guest count set.
- [ ] **Attribution skip-notice (conditional).** The corrected notice renders only when a
      duty attribution hits a closed period. Cannot be forced in prod without doing exactly
      that; verify the next time one happens (or deliberately on dev against a processed
      period). Until seen, treat it as unproven — its first version also "worked".
- [x] **Text the 1922 — PASSED 2026-08-13.** Dallas texted it; the inbound pipeline answered
      with the freeform staff auto-reply, closing the last unverified half of the phone-1a
      cutover. Bonus: the reply live-demoed the 312-handout backlog item by telling Dallas
      to contact Dallas at the 312.
- [ ] **"See other options" compare strip.** Pushed live 2026-08-11 (41d3206c, read-only
      package compare on the proposal page) the same night as everything else; no record of
      anyone opening it in prod since. One look at a real proposal's compare link. Note the
      compare-and-book spec will eventually replace this surface.
- [ ] **Marketing redesign phases 1+2 — LIVE as of the 2026-08-13 evening push (tip
      `5adeb0b3`).** The campaign create/send flow owes a full walk BEFORE real sends: tags,
      resolver, contacts UI, extract, compliance, send pacing. Include the three gate-fix
      surfaces, all corrected blind and never seen: (1) compose resume — save a draft, send
      to a tiny audience, then simulate the retryable path by leaving `/marketing/compose`
      and returning; the "Resuming campaign #N" banner and its "Start fresh instead" button
      must appear after a quota-stopped or partly-failed run, never after a clean one;
      (2) actionable toasts — select over 500 recipients ("Send at most 500 at a time")
      and an all-suppressed audience ("Check the held-back panel"), each must show its
      real message, not "Please fix the errors below"; (3) the Sent tab placeholder must
      say phase 3. (Sep 5 deadline pressure is exactly the condition that buries
      walkthroughs — this one gates real sends.)
- [ ] **Proposals list pagination — LIVE as of the 2026-08-13 evening push (`1dc72df6` +
      stale-response guard `92efc663`).** **Never opened in a browser**, deliberately:
      the build-time walk needed a second dev server and a local admin token, both denied
      by the permission classifier, and nothing was routed around. Static gates that DID
      pass: ESLint, the Vercel-exact build, the `useUrlListState` suite (5/5), the round-3
      push fleet, and codex. So the code is reviewed, not witnessed.
      The walk, on `/proposals`: page through Active to the last page and back; from page 3
      flip to the Draft tab and confirm it lands on page 1 with rows (a missed filter writer
      shows up as an empty table); sort by price from page 2 and confirm the same reset;
      confirm a sub-50 tab shows no pager and reads exactly as before; hit `/proposals?page=99`
      and confirm it snaps back rather than sitting empty; apply a zero-match filter and
      confirm no URL churn; and flip between tabs/filters rapidly — the list under the
      controls must always match the controls (the `92efc663` guard; a mismatch means a
      stale response won). Full steps in
      `docs/superpowers/plans/2026-08-12-proposals-pagination.md`, Task 2 Step 6.
      One known cosmetic edge, plan-accepted but now logged on the fix list (2026-08-13,
      round-3 section) for a design call: an option group whose members straddle a page
      boundary renders on both pages with a split "N options" badge. Worth trying to catch
      one live during the walk; report what it looks like, not as a bug.

## Tier 6 — queued: will owe a walkthrough the moment it ships

(Empty as of the 2026-08-13 evening push — both former occupants shipped and moved to
Tier 3b. Next expected occupant: marketing phase 3 (mkt-h, Overview + Sent) once its plan
is written and built.)

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

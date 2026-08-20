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

## Status: the 2026-08-14 session, refreshed 2026-08-19

**WHAT MOVED SINCE 2026-08-14**, because this block sat here as the file's headline for
five days while production changed underneath it. Two pushes landed: 2026-08-16 (the
52-commit `bab7fba5..981b09ef` batch, which carried the phone passkey unlock) and
2026-08-19 (lane `nat-trim`, which reshaped the admin Overview). Four lanes merged.
`origin/main` is `d61c62b7`. Out of that: one new Tier 3b entry (`nat-trim`), three more
moved into Tier 3b from Tier 6, which had been filing shipped work under "queued", and one
checked Tier 2 box that now certifies a surface which no longer exists.

**Count the boxes yourself rather than trusting a number written here.** `grep -c '^- \[x\]'`,
`'^- \[~\]'` and `'^- \[ \]'` against this file give done / partial / open in one command.
The hard tally that used to sit on this line was wrong from the commit that wrote it and
was never re-derived across four merges, which is what a hard-coded count in a living file
always does. What any raw count overstates: a chunk of the "open" items are not walks at
all. Read this before picking anything up.

**Closed tonight by Dallas:** voicemail listen link (BOTH halves — the first listen link
this system has ever sent went out and was tapped), inbound SMS alerts naming the
staffer, the "See other options" compare strip, duty-pay policy text (Field Guide §17 +
agreement v3 signed and stamped), and STOP/START on prod.
**Closed tonight by Claude:** duty-pay out-of-area knobs (both mounts, plus all of spec
§9), review money §7 manual half, display-name T6, the seniority panel smoke, and the
duplicate-MessageSid idempotency check (closed structurally on the unique index).

**The three routing rules that came out of the 2026-08-14 lane split:**
1. **Automation's lane** — contrast/palette measurement and mechanical render checks
   (`getComputedStyle` on real elements; staff recipes rendering real ingredients;
   first-name greetings; the proposals pager). Display-name T10-T13 moved here.
2. **Human-only** — anything about reachability, real devices, or taste. The compare-strip
   defect proved why: a Playwright click on `getByRole('button')` passes every time,
   because the button works; only a human reading "Tap to compare" and tapping where it
   pointed found the dead zone.
3. **Neither** — trigger-armed or structurally unobservable. Say so in the entry rather
   than leaving it looking walkable.

**What is genuinely left for a human, in order:**
- Marketing RESTYLE visual walk (35-45 min, pure judgment, wants daylight)
- Marketing FUNCTIONAL walk (70-85 min, gates real sends, now more useful since the
  corporate contacts are tagged)
- Tip sign wake lock, Leg A (20 min on the Pixel) and Leg B print-and-scan (needs a photo
  counter). Now carries its own Tier 3 checkbox, so a tier refresh cannot lose it
- Phone admin passkey unlock on the Pixel, against PROD (Tier 3b). The highest-value walk
  open: the only unverified auth path in production
- Mobile admin PWA on the Pixel. The INSTALL half is DONE (Dallas, 2026-08-14, zero
  findings). What is still owed is the offline-resume leg and the Desktop-view toggle
  round trip, and both ride the passkey walk above rather than standing alone
- Admin Overview / Needs-attention after `nat-trim` (Tier 3b): the landing page changed
  shape on 2026-08-19 and nobody has opened it since

**Waiting on a Dallas decision, not on time:** the Potions recipe sourcing call
(grapefruit soda / Cognac / lavender syrup — see Tier 4), and Potion Planner gate 1's
Midrange scotch bullet.

**Do not pick up:** the comms SMS smoke beyond STOP/START (exhausted for a human — see
that entry for the per-check reason), the equipment label (needs a dev write before it is
lookable in either environment), or anything marked trigger-armed.

Defects this session sent to the fix list, one of them since closed: the "Tap to compare"
dead affordance plus 14 more of the same shape found by sweep, the dev box holding a LIVE
Stripe key with no `NODE_ENV` gate, the September corporate-holiday moment being
invisible, Jasmine SMS-dark for six weeks while working, `yes`/`cancel` swallowing client
texts, and the agreement's raw markdown on the signing screen.
CLOSED 2026-08-19, the September corporate-holiday moment, on both halves. The audience
half is live in prod: `client_tags` holds exactly 9 `corporate` rows, so the moment has
somebody to go to. The product half is lane `mkt-moment-setup` (`7b099746`), **merged but
NOT pushed**, so the needs-setup card and the header's "N needs setup" segment do not
render in prod yet even though the audience they are about is populated. Its walk sits in
Tier 6 until that ships.

---

## Tier 1 — money moved, and nobody watched it land

- [~] **cancel-line-item — PREVIEW HALF WALKED 2026-08-12** (Dallas, proposal 678, Real
      Glassware Upgrade $125). Target matching, the fold, and the invoice math all correct:
      total $750 → $625, Balance invoice $650 → $525, Deposit untouched, no refund offered.
      Close and "Never mind" both work. **Found a real bug:** every admin modal is a boxless
      ghost in House Lights — see the 2026-08-12 section of the fix list.
      **The Stripe refund half is still owed, and still cannot be walked on demand — but the
      REASON changed on 2026-08-14 and the old reason is now wrong.**
      SUPERSEDED: the 8/12 note said no live booking could produce it. That is wrong. The
      eligible set is non-empty and stays non-empty, so **the structural precondition is
      MET.** Do not write the members down; the set ages out as events complete (the 8/14
      snapshot named six, three of which were Aug 15 events that have since finished).
      REGENERATE it instead, against prod:
      ```sql
      SELECT p.id, p.total_price, p.event_date, p.status,
             (SELECT count(*) FROM proposal_payments pp WHERE pp.proposal_id = p.id) AS pay_rows
      FROM proposals p
      WHERE p.event_date >= CURRENT_DATE AND p.amount_paid >= p.total_price AND p.total_price > 0
      ORDER BY p.event_date;
      ```
      Anything with `pay_rows` of 0 is the CC-transfer shape and cannot produce a refund;
      604 has always been that. On 2026-08-19 it returned four usable rows plus 604.
      WHAT ACTUALLY BLOCKS IT NOW is that walking it means issuing a real refund against a
      real client's real money, which is only legitimate when that client genuinely drops a
      line. That has not changed: when it next happens, do it deliberately and watch.
      **AND DEV CANNOT STAND IN — this is the trap.** The dev box is armed against LIVE
      Stripe: `.env` carries an `sk_live_` secret, there is no `STRIPE_SECRET_KEY_TEST`, and
      `STRIPE_TEST_MODE_UNTIL` is unset, so `getStripe()` — which has no `NODE_ENV` gate at
      all — hands back the LIVE client on localhost. A "safe dev refund" would be a real
      refund on the production Stripe account. See the fix-list entry of 2026-08-14; this
      has already created real Stripe objects once.
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
      PAY-RUN UI ALSO PASSED, live, 2026-08-14. Dallas ran the editing surface on real
      payroll rather than the dev fixture. Every payout in period 89 foots exactly against
      the single-writer formula (events + payable duty, clamped): Jasmine 8000+2000=10000,
      Nevver 15090+5500=20590, Dallas 35279+4000=39279 (no_draw), Fareed 20279+0=20279.
      His remove behaved correctly end to end — an admin-added $50 hosted line added 17:04:10
      and pulled 17:04:13, `removed_by` set, excluded from her total, row retained struck
      through. Two $20 bar rentals on one payout looked like a duplicate and are not: shifts
      367 and 373, two separate events. The removal also landed ~5h before the payout was
      marked paid, so the frozen-period guard was never tested by it and remains unproven.
      UX NOTE, not a defect: Dallas read the retained struck-through row as "it didn't
      delete". It is deliberate (undo affordance + the record that derivation must never
      resurrect it), and it is correctly hidden on paid/History views. If it keeps reading
      wrong, the fix is a visible "Removed — restore" label, not deletion.
- [x] **Duty-pay knobs: out-of-area + ShiftDrawer — PASSED 2026-08-14 on dev**, full
      sequence, both mounts (fixture: proposal 24131 / shift 10726, two approved
      bartenders). Spec §9 turns out to name the SAME knob for both halves of this item
      ("Shift page: Out-of-Area knob, suggested amount, requester home distances beside
      approvals, locked indicator"), so the ShiftDrawer half was not a separate control.
      The bug the residuals lane fixed is now proven, not just reviewed:
      (1) attach $25 with 2 approved → saved UNLOCKED (`out_of_area_locked_at` null, so
      the auto-lock correctly refused an ambiguous roster), warning reads "locked to no one
      and will not pay", and the same-value Save is GREYED OUT;
      (2) drop one staffer → the warning REWORDS itself to "Save the amount to lock it to
      them" and Save turns clickable at the identical value — the exact dead end the fix
      removed;
      (3) Save → locks to the survivor (`locked_user_id = 12926`, Walk Bartender A), UI
      swaps to the "Locked" chip;
      (4) reduce to $10 → 409 carrying the server's sentence verbatim, DB untouched at
      2500. Re-run in the Event Detail mount at $5: same refusal, same untouched row.
      ALSO covered, beyond the prescribed steps: the $250 cap (a $300 save is refused with
      "Enter a bonus between $0.01 and $250.", surfaced verbatim from the server, row
      untouched), and the two §9 elements that had never rendered anywhere because the
      fixture had no coordinates — after setting the shift to Rockford the knob shows
      "Venue is 78.9 mi out." with a "Use suggested $20.00" button (correct band), and
      after giving Walk Bartender A a Chicago home the approval row shows "home: 79.9 mi".
      The published-ambiguity rule holds: no band literal or band arithmetic exists in
      `client/src/`, the number arrives on the payload. The staff-privacy claim holds
      empirically too — the requester object carries `home_distance_miles` and NO lat/lng.
      FIXTURE STATE AFTER THE WALK, so nobody is surprised: shift 10726 is now locked at
      $25 to user 12926 and carries Rockford coordinates; 12926 has a Chicago home. The
      lock is deliberately irreversible from the UI, so re-walking this sequence needs a
      SQL reset of the four `out_of_area_*` columns or a fresh fixture.
      ONE DEFECT FOUND, logged to the fix list (bottom section, 2026-08-14): the card and
      the drawer disagree on the "N staffed" denominator when `positions_needed` is `[]`
      (card `|| 1`, drawer `roster.length`). Cosmetic; 6 prod shifts reach it, and all 6
      are the past-dated `open` rows the shift-closure sweep is about to close.
- [~] **Review money: bounty + quarterly contest (spec §7) — MANUAL HALF PASSED 2026-08-14
      on dev**, the whole chain, first time this code has ever moved a cent anywhere.
      (Prod remains at zero rows by design; the file's own instruction was that dev is fine
      because a real bounty in prod is real money.)
      THE MONEY MOMENT: logged a manual Google 5-star, credited Marcus (user 5), and
      crediting alone paid NOTHING — the bounty appeared only on Confirm, which is the
      correct seam. The line landed as $10.00 / `origin=auto` / `kind=review_bounty` in
      payout 8465 of period **7303 (Aug 11-24)** — the period covering today, not the other
      open period 7174 (Aug 28-Sep 11), so `findOpenPeriodForDate` picks the right one. It
      then showed up on the real pay-run screen as "$10.00 owed, paid 0 of 1".
      DISMISS, BOTH SIDES, which is where the subtle bug lived:
      unfrozen Dismiss genuinely pulls the money — line tombstoned with `removed_by` NULL
      (a SYSTEM tombstone, revivable) and the payout total recomputed to **$0**, not merely
      hidden. Re-Confirm then RESTORED the same row 686 (note flipped to "credit restored",
      total back to $10) with `review_bounty` row count still exactly 1 — so the
      dismiss-then-re-confirm path neither silently pays nothing (the `ON CONFLICT DO
      NOTHING` trap `settleBounty` exists to dodge) nor double-pays.
      THE FROZEN REFUSAL, which the duty-pay entry above records as never having been
      tested: processed period 7303 to freeze the line, clicked Dismiss, and got a clean
      refusal — review stayed `confirmed`, line stayed active, payout stayed $10, and the
      admin sees a toast carrying the server sentence verbatim. That guard is now proven.
      LEADERBOARD + CONTEST: Marcus renders at a 100% rate ("1 of 1 events reviewed") and
      still reads **"below the floor"**, so a perfect rate cannot buy past the 4-events /
      2-named-reviews floor. The floor numbers come off the payload
      (`data.min_events_worked`), not hardcoded in the bundle. Awarding an in-progress
      quarter is refused THREE deep: the button is disabled, the server 409s
      `QUARTER_IN_PROGRESS` without force, and **even WITH force it 409s "no eligible
      contractors this quarter"** — the floor holds against a deliberate override. Zero
      `review_contest` rows were written.
      STILL UNPROVEN, and it cannot be forced: the Thumbtack webhook ingest that bridges
      a real TT review into `staff_reviews` via `tt_review_id`. It fires only on a real
      review landing. Until one does, the automatic half of §7 is unproven — the manual walk
      above does not exercise it. That is the only reason this is [~] and not [x].
      DEV FIXTURE LEFT BEHIND: review 259 (confirmed, 5-star, crediting Marcus) and its live
      $10 line 686 in period 7303. The period was processed to test the freeze and then
      REOPENED, so it now sits `reopened` (processable, not frozen) rather than the `open`
      it started at. Nothing is stranded.
      COPY NIT, logged to the fix list: the refusal says the bounty is "already paid" when
      the state that actually froze it was a period merely `processing`.
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

- [ ] **Remote Staffing Fee prompt at Send. NEVER FIRED IN PROD.** Verified 2026-08-14:
      `proposals.remote_fee_prompted_at` is set on **zero** rows and `venue_lat` on zero —
      so the popup has never appeared, and the on-demand geocode has never run, since
      shipping 8/07. Correct-looking, because the gate is narrow (venue 40+ miles out AND
      fewer than 3 active staff homes within 40 miles AND not already answered AND not yet
      accepted), and DRB books mostly in-city. But narrow-and-never-fired is also what a
      silently-broken gate looks like, which is the point of walking it.
      WALK ON DEV (a prod Send emails a real client): proposal 24132, "Walk Far Venue" in
      Rockford. Click Send, expect the "Checking staffing for this venue…" overlay, then the
      popup with ~80 miles / no staff within 40 / suggested $20. Take **Add suggested fee**
      and confirm the total rises $20 through the normal editor path. Send again and confirm
      it does NOT re-ask — the answer is stamped once per proposal, deliberately.
      To walk it in prod instead, wait for a genuinely far booking and do it on the real
      send rather than manufacturing one.
- [x] **Duty-pay policy text: Field Guide §17 + contractor agreement v3 — PASSED
      2026-08-14**, both halves, on dev as marcus.j.
      §17 CONTENT: every published figure reads as specced — $20 bar rental (own bar or
      Pilsen pickup, same either way), $20 parking (driver only), $20 supplies with the
      **flat $50 hosted** carve-out, $5 menu print, $10 named 5-star bounty, $100 quarterly
      contest, and Travel as exactly ONE discretionary sentence with no mileage, no band and
      no radius. The published-ambiguity rule holds, and no duration language survives near
      the hosted $50.
      AGREEMENT v3 STAMPED CLEAN: `agreements.signature_document_version` =
      `'contractor-agreement-v3'` (the STRING, as designed), signed 2026-08-15T00:00:36Z,
      PDF present, and the version is baked into the R2 key
      (`agreements/5/contractor-agreement-v3-1786752037188.pdf`) as a second independent
      confirmation. Note nothing in the UI ever displays the stamped version — SQL and the
      PDF header are the only two proofs.
      SIDE EFFECT, PREDICTED AND OBSERVED: signing ran `refreshDisplayName`, and marcus's
      `display_name` moved `Marcus` → `Marcus J.` one second after the signature. That is
      the documented behaviour (the signed full name outranks everything for the last
      initial) and it incidentally re-verified the display-name single writer under a real
      write.
      COPY FINDING: Dallas could not find the quarterly contest. It IS present, but as the
      second BULLET under the sub-heading "Review Bounty: $10", so the biggest number in the
      schedule hides under the smallest. Fix list, 2026-08-14, with the note that this may
      partly explain why §7 has never paid out once.
      ALSO SEEN, already logged: clause 6 of the agreement renders literal `**` asterisks on
      the signing screen while the PDF renders them bold correctly.

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
- [x] **Needs-attention tabs: PASSED 2026-08-13, SUPERSEDED 2026-08-19 by `9d7d4c86`.**
      **Do not read this box as certifying the surface you will find today.** Lane `nat-trim`
      deleted the Money tab, so the four-tab set this passed no longer exists; the Staffing
      count of 14 is not reproducible now that dated rows filter to a 14-day horizon; and the
      product call below is SHIPPED, not logged. Kept because the accuracy method still
      stands and the residual tabs still resolve the same way. The live surface is unwalked:
      see Tier 3b, below.
      What it verified on 8/13, against prod, after three of my own approximations disagreed
      with the tabs and the tabs won every time: Staffing 14 = 10 short-staffed + 1
      applications + 3 uncertified; Clients 0 is right (92 of 116 unread inbound are
      Thumbtack relay, the other 24 have no client_id); Sales = sent-unviewed-past-72h by
      design. PRODUCT CALL, now SHIPPED: the Money tab was payroll-only once all 213 payout
      lines were matched and Dallas wanted payroll rehomed. Done 8/19: payroll is an
      admin-only right-rail card. This entry's own warning, that the unmatched-payout alarm
      would need a new surface if the tab went away, was answered in the same lane: the alarm
      rides a badge on the Band 2 Payouts button.
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

- [x] **Voicemail listen link — PASSED 2026-08-14, BOTH HALVES (Dallas: "it worked").**
      Route half: he opened the backfilled 8/11 token on his phone, the audio played, and a
      tampered token 404'd.
      SMS half, and this is the milestone: he made a real missed call to the 1922 and **the
      first listen link this system has ever sent went out and was tapped.** Prod row
      `CA257c2c7f2fa58a4908c05a9fea932d9a`, line `primary`, 16 seconds recorded, status
      `delivered`, created 2026-08-14T22:51:49Z and the alert delivered 31 seconds later at
      22:52:20Z. Before today `voicemail_delivery` held exactly one primary row, from 8/11,
      whose alert predated the link lane by about five hours and carried no link line.
      KILL SWITCH: NOT walked, and **deliberately not owed.** Both halves are already pinned
      by direct unit tests — `voicemail.test.js:608` ("listenLinkEnabled defaults ON and only
      the literal false disables it") and `:638` ("the kill switch drops the link line, not
      just the route") — and the route and the SMS builder read the same single
      `listenLinkEnabled()`, so there is no drift path between them. Walking it manually
      costs TWO Render redeploys of the single web service, which takes every Twilio voice
      and SMS webhook and every Stripe webhook down across both restarts, to re-prove
      something already covered. Not worth the blast radius. If it is ever walked anyway,
      note a cold start returns 502/503 or a Cloudflare page, NOT the plain-text `Not found`,
      so testing inside the deploy window produces a false pass.
      FOUND: `API_URL` is unset in Render, so the link in the alert is built on the
      `RENDER_EXTERNAL_URL` `*.onrender.com` host rather than `api.drbartender.com`
      (`urls.js:13-15`). It works, and the link only ever goes to the operator, but it is
      worth setting so the ops link carries the real domain — fix list, 2026-08-14.
      The original prose was wrong twice, kept here because it explains the above: it read as
      though links had been arriving and needed an eyeball (none had), and it implied the
      kill switch could be proven in one pass (the SMS half needs its own extra missed call,
      because the alert body is only built at delivery time and nothing replays it).
      CORRECTION 1, the headline: this said "confirm the alert SMS arrives with a working
      link" as though links had been arriving. **No listen link has ever been sent, once.**
      `voicemail_delivery` holds exactly ONE primary-line row ever (2026-08-11T02:49:25Z),
      and the lane that added the link (`56d0fcd1`) committed about five hours AFTER it; the
      real sent body in the Twilio log has no link line. So this is "produce the FIRST alert
      SMS that carries a link", not a re-check.
      CORRECTION 2: the two-sided kill switch cannot be done in one pass. The route half is
      instant, but the SMS half needs a whole extra missed call while the var is false,
      because the alert body is only built at delivery time (`voicemail.js:290-293`) and
      nothing replays it. Each env flip is also a Render redeploy.
      FREE HALF, no phone call needed: the primary line never deletes its recordings, and
      `listen_token` was added `DEFAULT gen_random_uuid()`, which backfilled a working token
      onto the pre-feature 8/11 row. The prod route was confirmed live on 8/14 (HTTP 200,
      `audio/mpeg`, 8777 bytes, and a `Range: bytes=0-1` probe returning 206, so the iOS
      media path works). Steps 1, 2, 7 and 9 of the script therefore prove the route and its
      kill switch in about five minutes; only the SMS half costs a real call.
      TRAPS THAT WILL READ AS BUGS: a recording under 2 seconds is silently discarded
      (`voice.js:646-651` writes status `empty`, deletes it, sends nothing) so speak 5+
      seconds; the alert never appears in the admin Messages page (`skipLog: true`, by
      design); and if Google Voice's own voicemail answers the forwarded leg first you get
      no greeting, no recording and no SMS, which is exactly what `VM_PRIMARY_RING_SEC=18`
      exists to outrun — the tell is hearing the GV greeting instead of the Dallas one.
      PASS = tapped a real alert's link and heard the audio; then with
      `VM_LISTEN_LINK_ENABLED=false` that URL 404s AND a fresh miss produces a two-line
      alert with no URL; then restored and the URL plays again. All three.
      Link expiry is 30 days from `created_at` enforced in the route's own SQL, so the 8/11
      row's shortcut token dies 2026-09-10.
- [ ] **Tip sign download.** Download a sign as jpg, png, and pdf, and the two-sided card as
      pdf. Confirm a bartender with no Stripe link is not offered Card.
- [ ] **Staff recipes: REASSIGNED to the automated lane 2026-08-14 (routing rule 1),
      mechanical render check, not a human walk.** Open a spec at the bar and confirm real
      ingredients render, not `[object Object]`.
- [ ] **First-name greetings: REASSIGNED to the automated lane 2026-08-14 (routing rule 1),
      mechanical render check, not a human walk.** Confirm a normal client gets "Hi Monica,"
      and a couple gets "Hi Aubrey & Dominic,". The couples case was fixed at the push gate
      and has unit coverage, but no rendered email has been read by a human.
- [ ] **Tip sign wake lock: Leg A and Leg B, both still owed.** Named in the ordered list
      above since 2026-08-14 with no checkbox anywhere in the tiers, so it was invisible to
      every count and a tier refresh would have dropped it. It is a real human walk under
      routing rule 2: real device, real paper.
      LEG A (about 20 min, on the Pixel): open a bartender's tip page, confirm the screen
      does not sleep while it is showing, and confirm it releases when you leave.
      LEG B (print-and-scan): print a sign and scan the QR off the paper with a phone
      camera, not off the screen. Needs a photo counter or an equivalent flat surface. This
      is the leg that catches a code that renders but does not scan at real ink density.
- [x] **Guest count in the event header — PASSED 2026-08-13** ("yes").
- [x] **Inbound SMS alerts naming the staffer — PASSED 2026-08-14.** Dallas found the alert
      email from the 2026-08-13 21:13 CT inbound and confirmed the body reads
      **"Dallas (user 1)"** — a real name plus the user id, which is exactly what the fix
      `5f3671fa` (2026-08-11) set out to replace "A staff member" with. Closed from the
      inbox with zero texts sent.
      TRAPS: the alert is EMAIL only (category `routine_admin`, no `smsBody`) so do not wait
      for a text; and the texts correctly never appear on the admin Messages page, because
      `GET /api/sms/conversations` selects FROM `clients` and staff rows carry a null
      `client_id` (the page's own empty-state copy claims otherwise — fix list, 2026-08-14).
      **DO NOT prove this by dropping a real shift.** `alertStaffCant`, the SUCCESSFUL drop
      alert, is the one path the naming fix never covered: it still says "A bartender texted
      CANT" with no name, so that route would make a shipped fix look unshipped. Fix list,
      2026-08-14. The four paths that DO name are ambiguous CONFIRM/CANT, CANT-with-no-shift,
      the CANT race, and free-form staff text.
      Text from the 312 rather than the personal cell: user 1 has zero approved unfinished
      shifts, so nothing can be dropped by accident.

## Tier 3b: shipped since 2026-08-13, live in prod, never eyeballed

Two cohorts. The 2026-08-13 walkthrough fixes needed the same medicine they were
prescribing: the TimePicker and equipment-label fixes both shipped BROKEN on the first
attempt and were corrected blind by a later session (`54fb77cb`, `fc5e6ca2`). The 8/14
through 8/19 arrivals are listed FIRST, because they are what is live in prod today that
nobody has opened at all.

- [x] **Phone admin passkey unlock (lane `ma-d-auth`): FULLY WALKED 2026-08-19 (Zul).**
      Every leg is proven: 1 and 2 by real production use, 3, 4 and 5 walked on a real Pixel
      against prod, plus both legs folded in from ma-a/ma-b. Two defects came out of step 4
      and live in the fix list, not here, per this file's own rule.
      KEPT rather than deleted, against the "tick it and delete it" convention, for one
      reason: the PROTOCOL TRAP below is walk methodology, not a result. It cost an hour and
      it will cost the next person the same hour on any future offline walk. Delete the rest
      of this entry freely; keep that.
      Original entry follows. **PUSHED 2026-08-16**
      in the 52-commit `bab7fba5..981b09ef` batch (merge `c206118c` + fix `981b09ef`). Prod
      DDL needs no action and never did: `webauthn_credentials` and `webauthn_challenges` are
      `CREATE TABLE IF NOT EXISTS` in `server/db/schema.sql`, which `server/db/index.js`
      re-executes on every boot, so the deploy applied them itself. Both tables are confirmed
      present in prod.
      **THIS IS A PRODUCTION WALK. Read the next paragraph before step 5.** The old text
      here said "on the real Pixel, against dev data" and that is now dangerous advice.
      There is no dev stand-in: `WEBAUTHN_RP_ID` resolves to `localhost` in dev and
      `admin.drbartender.com` in prod (`webauthn.js:26-28`), so a passkey never crosses
      environments, and the phone cannot reach the dev server anyway (`client/.env` points
      the client at `localhost:5000`, which on a phone means the phone). The only enrolled
      passkeys that exist anywhere are PRODUCTION credentials.
      **STEPS 1 AND 2 ARE ALREADY PROVEN BY REAL USE.** Do not re-run them, and do not treat
      them as unwalked. Prod holds two credentials in daily service: user 2
      (zul@drbartender.com) enrolled 2026-08-16 and last asserted 2026-08-18, and user 1
      (admin@drbartender.com, Dallas) enrolled 2026-08-17 and asserted 2026-08-19. Enrollment
      and unlock work in production against real accounts.
      **WHAT STEP 5 ACTUALLY COSTS.** Revoke deletes the credential AND bumps
      `users.token_version` (`webauthn.js:194`), which is a global logout of every session
      that user holds, everywhere, by design. Run against prod on Dallas's own account, it
      signs him out of desktop and phone at once and destroys a credential he asserted today;
      the only way back is a password login plus a fresh enrollment. That is a deliberate
      act with a cost, not a step to walk through casually. Do it when Dallas is at a
      keyboard and expecting it, or run it against the OTHER admin account.
      GENUINELY UNPROVEN, and the whole reason this box is open:
      3. ~~Airplane mode, cold launch within 30 minutes of last use: restored route with
         staleness lines, no Login bounce.~~ **WALKED 2026-08-19 (ZUL, on her own phone and account). SPLIT VERDICT.**
         Route restore PASSES: offline cold launch landed on the same page, no Login bounce,
         so the `981b09ef` identity bound behaves. Staleness lines FAIL, and not on this
         screen only: they do not exist anywhere in the product. `formatStaleAt` is exported
         and imported by NOBODY, and `.m-stale` appears only inside a code comment. The SW
         stamps the header and `api.js` surfaces `staleAt`, both with passing tests, but no
         screen was ever wired to render it. Recorded in the fix list as its own entry. Do
         not re-walk this leg for the staleness half until that ships.
         **RE-RUN CLEAN 2026-08-19 after the first attempt was invalidated:** the first pass
         had WiFi still associated (see the protocol trap below), so "offline" was unproven.
         Repeated with WiFi AND mobile data off and the status bar verified: landed on the
         same route WITH data, no lock, no Login bounce. Route restore is now genuinely proven
         offline.
      4. ~~Airplane mode, cold launch with the lock due: lock screen explains offline unlock
         needs a connection; password path visible.~~ **WALKED 2026-08-19 (ZUL, on her own phone and account). PASSES on
         the lock itself, and surfaced a real defect on the way out.** Lock fired after a
         30-minute background. It FULLY OCCLUDED, no data behind it, so the spec section 8
         requirement holds. Unlock offline gave "You are offline. Unlocking needs a
         connection." with NO biometric prompt, which is correct by design:
         `unlockWithPasskey` POSTs `assert-options` before `startAuthentication`, so it never
         asks for a fingerprint it cannot use. **"Use password instead" landed on "Something
         went wrong."** That is TWO defects sharing one button, both in the fix list under
         "The offline lock screen has no working exit": the dead end is a lazy-chunk load
         failure independent of the logout, and the logout silently UNARMS the phone (no
         30-minute lock at all) until the user re-enrolls. Verified by a 3-lens adversarial
         panel; my first write-up of it was wrong three ways and the corrections are in that
         entry. Do not re-walk this leg; walk the FIX when it ships.
      5. ~~From desktop Settings > Security: revoke the phone passkey, confirm the desktop
         logs out, the phone's next unlock fails to the password path, and re-enrollment
         works.~~ **WALKED 2026-08-19 (ZUL, on her own account). PASSES.** No automated test
         covers this leg, so this is the only proof it has. Revoke deleted the credential row
         and logged the session out on the spot, which is the designed global-logout blast
         radius (`webauthn.js:184` delete, `:194` `token_version` bump). Re-enrollment then
         succeeded. Verified against prod rather than taken on report: her original credential
         (id 1, enrolled 2026-08-16) is GONE and a fresh row (id 3) was written at
         2026-08-20 01:31Z.
         **WHOSE ACCOUNT MATTERS HERE, and the record was wrong for an hour.** Every leg of
         this walk on 2026-08-19 was run by ZUL on HER phone and HER account, not by Dallas.
         Prod settles it: Dallas's credential (id 2) still shows `last_used` 2026-08-19
         14:50Z, untouched all evening, so no leg tonight asserted his passkey. The mechanism
         is account-agnostic, so proving it on her account proves the code and Dallas does NOT
         need to re-walk it. What is NOT proven is anything specific to his device.
         The revoke is correctly scoped and cannot reach another user's credential: the list
         is `WHERE user_id = $1` (`webauthn.js:164-171`) and the delete is
         `WHERE id = $1 AND user_id = $2` (`:183-186`). An orchestrator alarm that the wrong
         account had been revoked was WRONG and is recorded here so nobody re-raises it.
         One sub-check went unobserved: whether the phone's next unlock falls cleanly to the
         password path was skipped, because re-enrollment happened first. Low value, and the
         offline path already exercised the failure branch.
      **PROTOCOL TRAP, cost an hour on 2026-08-19, not in the original script:**
      (a) **Android airplane mode does NOT reliably kill WiFi.** It remembers the radio state
      and will leave WiFi on or auto-reconnect, so the device stays online and every "offline"
      leg silently tests nothing. Turn WiFi and mobile data off explicitly and LOOK at the
      status bar before starting.
      (b) **The 30-minute clock measures BACKGROUNDED time, and any glance at the app resets
      it to zero.** `touchLastActive` writes on hide (`visibilitychange`/`pagehide`) and
      returning to the foreground runs `evaluate()`, which CLEARS the stamp whenever the lock
      is not due. So: background it, then do not open it again, or the wait restarts. Related:
      force-closing an app you just looked at writes a FRESH stamp, so the next launch is
      seconds old and will not lock. Force-close only from an already-backgrounded state.
      ~~FOLDED IN FROM THE ma-a/ma-b ITEM, because these legs are only walkable in the same
      offline session: the Desktop-view toggle round trip, and the offline-resume proof that
      an offline cold launch lands on the restored route behind the lock rather than
      bouncing to Login.~~ **BOTH FOLDED-IN LEGS PASSED 2026-08-19 (ZUL, on her own phone and account).**
      Offline-resume: proven on the step 3 re-run above.
      Desktop-view toggle round trip: full round trip on Events, BOTH directions persisted
      across a reload, which is the half a tap-and-tap-back would never catch. Into desktop
      view via the header's "Switch to desktop view" control (`MobileHeader.js:43`,
      `setDesktopView(screenKey, true)`); the "Phone view" return pill appeared
      (`AdminLayout.js:279-287`); reload held it in desktop view; the pill returned it to
      phone view; a second reload held THAT. So both the write path and the
      `delete next[screenKey]` path persist correctly, and the escape hatch is genuinely
      two-way rather than one-way.
      NOTE the overrides are localStorage-only with no server copy, so the step 4 purge wiped
      every previously pinned screen. Anything Dallas had in desktop view had to be re-pinned
      by hand; nothing restores them.
      **RE-READ THE SCRIPT BEFORE RUNNING IT.** It was written against the lane and predates
      `981b09ef`, which rewrote the revoke copy the walk checks (SecuritySettings no longer
      promises "a lost phone is locked out immediately"; it names the offline carve-out) and
      added a bound so a cache-served `/auth/me` is honored only while the stored token is
      unexpired. Check the steps against the copy that is actually on screen.

- [ ] **Admin Overview / Needs-attention after `nat-trim`: LIVE IN PROD 2026-08-19**
      (merge `9d7d4c86` + review fixes `d61c62b7`; `origin/main` points at the latter). The
      admin landing page changed shape and nobody has opened it since. This is a
      look-at-it, not a hunt: the one defect the review fleet caught, light-skin rail cards
      refusing to shrink and clipping the Pipeline card's money column at 320-390px, was
      fixed in `d61c62b7` and shipped in the same push.
      WHAT MOVED, so you can tell a change from a bug:
      (1) **The Money tab is GONE from Needs-attention.** The tab row is shorter. That is
      the change, not a failed render.
      (2) **Payroll is now a Band 1 card in the right rail, admin-only.**
      `OverviewPage.js:334` renders `{isAdmin && <PayrollStatus />}`. A manager sees no
      payroll card at all, which is the point. Read the Overdue state if one is available:
      the chip moved into the card head and carries an `aria-label` so the accessible name
      still says the check is late.
      (3) **The unmatched-payout alarm rides a badge on the Band 2 Payouts button.** Same
      page, not a new surface: clicking it deep-links to `{ tab: 'payouts', show:
      'unmatched' }` (`OverviewPage.js:343`). It is dormant while every payout line is
      matched, so expect no badge; confirm the button itself still lands on Payouts.
      (4) **Dated Staffing rows cap at a 14-day horizon** (`STAFFING_HORIZON_DAYS = 14` in
      `queueItems.js`). Unstaffed events further out are cut from the tab, and an
      uncertified staffer whose next shift is PAST fourteen days de-escalates to the
      standing "eligible" row rather than disappearing. The page header's "N need staff"
      count still reports the true total, so header and tab disagreeing is CORRECT.
      Judge whether the emptier board reads as calm or as broken. That is the actual
      question this walk answers.

- [x] **Mobile admin shell + PWA (lanes `ma-a`/`ma-b`): INSTALL HALF PASSED 2026-08-14**
      (Dallas, on the Pixel, zero findings). Both merges (`0bf3eb30` ma-a-shell, `30405f97`
      ma-b-pwa) shipped in the 8/14 evening push. Install from More > Install app, the DrB
      OS icon, standalone launch, tab nav and badges all confirmed.
      Closed here rather than left half-open: the two legs that remain, offline resume and
      the Desktop-view toggle round trip, are only walkable inside the offline session the
      passkey walk above sets up, and they now live in that entry. Nothing is dropped.
      The old "DO NOT REPORT THE AIRPLANE-MODE LOGIN AS A BUG" caveat is retired:
      `ma-d-auth` fixed the transport-clear defect, so AuthContext keeps the token on
      transport failure and the SW serves the cached `/auth/me`.

- [ ] **Admin palette baseline eyeball sweep (palette lanes, merged 2026-08-14).** The
      text-colour baseline moved for every admin surface in both skins with **zero browser
      verification**, since every contrast number was token arithmetic. Live for five days now,
      which is why it moved out of the queued tier: it is not waiting on a ship, it is
      waiting on a human. Walk the screen list in the fix list; `/change-requests` is the
      cleanest single proof case; check House Lights specifically.

- [x] **TimePicker on a real phone — PASSED 2026-08-13** ("good"). Steppers gone, chevron
      tappable. The fix that shipped inert once is now proven on the device it targets.
- [ ] **Equipment label on a staff shift — RETARGETED 2026-08-13.** Dallas checked his own
      shifts (367/373) and saw no card at all — CORRECT, their `equipment_required` is
      `'[]'` (and that mismatch with their paid bar_rental duty is now its own fix-list
      item). The three shifts that actually carry `["portable_bar"]` are 368 (kpduffy),
      347 (loryn), 366 (jaszyjay) — all past events, other staffers. Verify via one of
      their views, or on dev by setting equipment on a fixture shift.
      CONFIRMED 2026-08-14, and it means this needs a WRITE before it can be walked at all:
      prod carries **exactly those three** shifts with non-empty `equipment_required`, all
      `["portable_bar"]`, all past and all belonging to other staffers — and **dev has no
      equipment data whatsoever**, every non-cancelled dev shift is `'[]'`. So the token
      label is unobservable in both environments as they stand. Seeing it requires setting
      equipment on a dev fixture shift first; there is no "just go look" path.
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
- [x] **"See other options" compare strip — PASSED 2026-08-14 (Dallas: "all true"), and it
      found a live client-facing defect on the first try.** All five pass conditions held,
      including the money probe: toggling Real Glassware off and back on returned the Yours
      price to exactly $1,250.00, so the live-priced current option reconciles to the penny
      against the stored contract total. The defect is below and is logged to the fix list;
      the surface itself is verified.
      SCRIPTED 2026-08-14. The prose originally here described the wrong surface.** It said "one look at a real proposal's compare link". There is no
      link: what shipped 8/11 is a BUTTON on the proposal page reading "See other options"
      (`ProposalView.js:683`) which mounts `OtherOptionsPanel`. `/compare/:token` is a
      DIFFERENT and OLDER surface, the option-GROUP page, in the tree since 7/13. Also
      `41d3206c` is the push-gate fix inside the lane, not the lane; the merge is `d945656a`,
      and it deliberately deleted the old `!inOptionGroup` gate so the panel now appears on
      grouped proposals too.
      WALK IT ON **proposal 733** (Julia Gutnik, token `eb616114-6e11-4b0e-b35f-d77f9d45ddff`,
      $1,250.00, 50 guests / 5 hours, event Sep 5). Already status `viewed`, so opening it
      flips no status; it does bump `view_count` and `last_viewed_at` and log a `viewed` row
      with the viewer's IP. Zero-footprint alternative if that matters: proposal 482, DRB's
      own Test Client, token `cc6c3ab6-2eb8-41a9-9a69-65b983707c0f` — but it is past-dated so
      it shows pay-in-full copy, which is expected noise, not a panel bug.
      PASS, five things: the strip opens and prices 11 options across exactly TWO lanes
      (hosted 10 + BYOB 1; "Also available" correctly never appears); the BYOB card reads
      "The Core Reaction with The Full Compound" / "Yours · recommended" / $1,250.00;
      pinning three caps with "Three is the most we can line up"; "Compare these 2" renders
      the table with "only on this one" / "on all of them" tags and a "+ Add one more" slot;
      and THE MONEY PROBE — toggle an extra on and back off, and the Yours price must return
      to exactly $1,250.00. That last one is a live reconciliation between the stored
      contract total and today's engine, because once any body is sent the current option is
      live-priced rather than echoed. Any other number is a finding; write it down.
      JUDGEMENT CALL FOR DALLAS, not a bug: lane order puts hosted FIRST, so a BYOB client
      scrolls past ten hosted cards before reaching their own recommended one.
      **DEFECT FOUND ON THE FIRST TRY 2026-08-14 — the walk paid for itself here.** Dallas
      could not pin an option: the cards only respond at the TOP. The card's sole hit target
      is `<button className="oo-card-hit">` (`OtherOptionsPanel.js:281-300`, the badge/name/
      price block), while the words **"Tap to compare"** print at `:340-342` in a plain
      `oo-card-foot` div at the BOTTOM, separated from it by the ingredients list and, on
      BYOB cards, a row of tier buttons that DO work. The instruction sits on dead space, on
      a live public client-facing page, since 8/11. Fix list, 2026-08-14.
      This is the exact class the 8/14 lane split reserved for a human: a Playwright click on
      `getByRole('button')` passes every time, because the button works.
      Note the compare-and-book spec will eventually replace this surface.
- [ ] **Marketing redesign, FUNCTIONAL walk — all 3 phases live in prod; gates real
      sends.** The
      campaign create/send flow owes a full walk BEFORE real sends: tags, resolver,
      contacts UI, extract, compliance, send pacing. Include the three gate-fix surfaces,
      all corrected blind and never seen: (1) compose resume — save a draft, send to a
      tiny audience, then simulate the retryable path by leaving `/marketing/compose` and
      returning; the "Resuming campaign #N" banner and its "Start fresh instead" button
      must appear after a quota-stopped or partly-failed run, never after a clean one;
      (2) actionable toasts — select over 500 recipients ("Send at most 500 at a time")
      and an all-suppressed audience ("Check the held-back panel"), each must show its
      real message, not "Please fix the errors below". Doubles as the data-needing half
      of the restyle walk below — same session covers both. (Sep 5 deadline pressure is
      exactly the condition that buries walkthroughs — this one gates real sends.)
- [ ] **Marketing RESTYLE, visual walk — the whole section moved onto the approved
      claude.ai/design look 2026-08-14** (lane `mkt-restyle`, squash `19a9298e` +
      follow-ups `be555426`/`3af0edd9`/`15cc4df0`; **PUSHED and LIVE IN PROD 8/14** — the
      prod admin CSS bundle carries `mkt-moment-grid`, so walk it at
      admin.drbartender.com, no dev server needed). Benchmark is
      `docs/design-artifacts/2026-08-11-marketing-redesign.dc.html`; final agent verdict
      ADHERENT, but no human has seen it. Headless coverage so far: 31+ screenshots, both
      skins, 1280/900/375, zero console errors. The walk:
      (1) all four tabs in BOTH skins — After Hours is the artifact's look; House Lights
      deliberately goes serif on the moment titles like every other heading, judge whether
      that reads right; (2) widths — at 1280 the Audiences table shows five columns
      ("Last contacted" folds under 1400px, recorded as a spec §10 deviation), at ≥1400 all
      six; check both feel right; at 375 the moment cards stack with the spine down the
      left edge and the budget meter flexes full-width; (3) the contact drawer (DS slide-in,
      hero name must be full ink on House Lights — this was the cream-leak fix) and the
      Compose preview drawer; (4) Compose's two steps: count lives in the Recipients tab
      label while writing, the two-stage confirm and "Before you send" rail on the right;
      (5) small judgment calls flagged by the adherence review: the light-skin budget-bar
      legend swatches are two similar darks, and keyboard-Tab the tabs once to confirm the
      focus ring survives (the always-on scroll container that clipped it was scoped to
      phones in `15cc4df0`). States that need seeded data (Sent table with rows, resume
      banner, send-result/quota copy, moment inline editor, tag menu, pager) arrive free
      during the functional walk above. What is deliberately NOT there: block canvas /
      Look panel / Send test / Desktop-Mobile toggles — deferred lane `mkt-compose-canvas`,
      unscheduled, awaiting Dallas's go.
      POINTER: the Overview tab gains a needs-setup card and a header segment from lane
      `mkt-moment-setup` (`7b099746`, merged and NOT pushed). Until that ships you will not
      see them in prod, so their absence is not a restyle finding. Once it does ship, walk
      them in the same session as this one; the Tier 6 entry has the steps.
- [ ] **Proposals list pagination — LIVE as of the 2026-08-13 evening push (`1dc72df6` +
      stale-response guard `92efc663`). SPLIT 2026-08-14 (routing rule 1): the pager
      MECHANICS below are the automated lane's, every one of them a deterministic state
      check a headless run makes better than a person. What stays HUMAN is the one design
      judgement at the bottom of this entry, an option group straddling a page boundary.**
      **Never opened in a browser**, deliberately:
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
      **A THIRD commit, `9dc29682`, HAS SHIPPED** (failed fetch no longer captions stale
      rows; confirmed an ancestor of `origin/main` on 2026-08-19). It adds two walk steps
      the plan predates, and they are no longer gated on anything, so do them with the rest:
      with devtools set to offline, click Next and confirm the
      table reads "Could not load proposals · Try again" with the pager GONE, rather than
      the previous page's rows sitting under a "Page 2 of N" label; then go back online and
      click Try again and confirm the list restores. Second, confirm a filter that genuinely
      matches nothing still reads "No proposals match these filters" with Clear filters, NOT
      the error row — before this commit those two states rendered identically, and that
      distinction is the point of the change.
      **THE HUMAN HALF, and the only part of this entry a person owns.** One known cosmetic
      edge, plan-accepted but now logged on the fix list (2026-08-13, round-3 section) for a
      design call: an option group whose members straddle a page boundary renders on both
      pages with a split "N options" badge. Automation can prove the badge splits; it cannot
      say whether a client reading half a group across two pages is acceptable, and that is
      the open question. Worth trying to catch one live; report what it looks like, not as a
      bug.

## Tier 6 — queued: will owe a walkthrough the moment it ships

The heading is a promise, so keep it true: an item belongs here ONLY while it is genuinely
unshipped. All three former occupants had in fact shipped and were sitting under a "queued"
banner reading as pending work, the palette sweep for five days across every admin
surface. They moved to Tier 3b on 2026-08-19. If you ship something in this tier, move it;
do not leave it here because it is still unwalked.

- [ ] **Marketing moment needs-setup card + header segment (lane `mkt-moment-setup`):
  MERGED 2026-08-19 (`7b099746`), NOT PUSHED.** Nothing to see in prod until it deploys;
  the walk arms the moment it does. It closed the product half of the September
  corporate-holiday miss, where an open moment with an empty audience was hidden in three
  places at once (the card list, the `open_moment_count` badge, and the header reading
  "0 moments open" while a moment was open).
  The reusable law it introduced, which is what the walk is really checking: an open moment
  now DECLARES which kind of empty it is. `emptyAudience: 'configure'` means a human can
  close the gap today (`holiday-corporate`, whose audience is gated on the `corporate` tag),
  so it renders a card. `emptyAudience: 'wait'` means only time changes it (`one-year-on`,
  `cold-quotes`), so it stays quiet. Nagging daily about something nobody can act on is
  itself the bug.
  ON THE MARKETING OVERVIEW, once pushed:
  1. A `configure` moment with an empty audience renders a needs-setup card that keeps the
     spine, the window and the why, drops "Review recipients" (there is nobody to review),
     shows `0 emailable` in the rail, and offers exactly two actions: "Set up the audience"
     and "Not this time".
  2. The header subtitle carries a separate "N needs setup" segment alongside "N moments
     open", so it can never read "0 moments open" while a needs-setup card sits below it.
  3. A `wait` moment with an empty audience renders NOTHING. Confirm `one-year-on` and
     `cold-quotes` stay silent; prod's earliest event is 2026-04-25, so `one-year-on`
     legitimately cannot match anyone for months and must not shout about it.
  4. "Set up the audience" lands somewhere you can actually add the tag.
  NOTE prod's `corporate` tag is now populated (9 clients), so `holiday-corporate` will
  render as a normal sendable moment rather than a needs-setup card. To see the card at all
  you need a `configure` moment whose audience is genuinely empty. Do NOT add a check that
  dismissing a needs-setup card decrements the open-moments badge: it cannot fail, because
  `open_moment_count` counts `moment.emailable > 0` and `moments_needing_setup` counts
  `moment.emailable === 0`, so a needs-setup moment was never in the open count.

## Tier 4 — gated: do these BEFORE the thing they gate

- [ ] **Potions recipe review pass — READY FOR DALLAS, 2026-08-14.** **This gates the prod
      `seedRecipeDrafts` run** (dry-run first), because `package_items` existence flips
      hosted coverage live and `coverageContext` has no recipe-review filter, so fence
      charges would derive from unreviewed recipes.
      COUNT CORRECTED: it is **5** low-confidence drafts of 41, not 6 — `seedRecipeDrafts.js`
      carries exactly five `low: true` entries.
      They are not five separate questions. THREE of them are one decision: the drink is
      named for an ingredient the par list does not carry, so the draft substitutes and the
      name stops being true.
      · **Paloma** pours **Sprite** as the "stand-in for grapefruit soda (Squirt / Jarritos)"
        — as drafted there is no grapefruit in it at all.
      · **Sidecar** is built on **Bourbon**, with the draft's own note: "Sidecar is Cognac;
        no brandy par row yet, swap when added."
      · **Lavender Cream Soda** pours **vanilla syrup**, noted "lavender syrup preferred; no
        lavender par row yet."
      So the one call is: add the three par rows (grapefruit soda, Cognac/brandy, lavender
      syrup), or rename/drop those drinks. Everything else follows from it.
      The remaining two are house originals with nothing to check them against, so they need
      only your "yes, that is what I pour":
      · **Berry Vodka Lemonade** — vodka 1.5, real lemonade 3, two muddled strawberries,
        plus grenadine 0.25 "for the pink pop" (grenadine on top of the strawberries is the
        part worth a second look — it may be sweet twice).
      · **Smokey Pina** — mezcal 2, pineapple 1.5, lime 0.5, agave 0.25.
- [ ] **Potion Planner v2: both gates before the lineup script's prod run. GATE 1
      RESHAPED 2026-08-14 — it is a 10-minute copy edit, NOT a script extension.**
      The old wording said "extend `applyPackageLineup2026.js` to also UPDATE the changed
      packages' `service_packages.includes` prose". **Do not build that.** It contradicts
      the spec in three places: `includes` is "a separate display field [that] never drives
      logic" (§ line 25), "`includes` prose stays display-only" (§96), and the spec's own
      open item assigns it to a human — "Enhanced/Grand `includes` bullets pinned to real
      bottle lists **during package-editor data entry**" (§10). The script's header also
      states the admin dashboard is the source of truth for CONTENT after seed and that a
      re-running UPDATE would clobber admin edits. A script that writes marketing prose
      would clobber exactly what the spec protects, and it would require inventing
      client-facing copy, which is Dallas's call and not the script's.
      CONFIRMED PENDING: the script has never run in prod — `slot_count`/`slot_kind` are
      NULL on all nine packages and `the-refined-reaction` is still `is_active = true`.
      **THE ONE PROVEN DRIFT, and it is the whole of gate 1's real content:**
      `the-midrange-reaction`'s public `includes` lists **"Dewar's Scotch"** as a bullet,
      and the new midrange lineup has NO scotch category at all — the script's own comment
      says "scotch OUT". The moment it runs in prod, that package advertises a named
      product it does not contain. Delete that bullet before the run.
      TWO POSSIBLE DRIFTS NEEDING DALLAS'S READ, not bugs until he says so: Enhanced says
      "Six premium spirits" against five spirit categories, and Grand says "Nine spirits"
      against six (Grand DOES keep scotch — its category is "Irish & Scotch", which a
      naive spirit-name count misses). Whether those are wrong depends on whether the copy
      counts CATEGORIES or BOTTLES, and Grand's eligible lists carry several branded
      bottles per category, so "nine" may well be right at the bottle level.
      So gate 1 = fix the Midrange scotch bullet, rule on the two counts, in the package
      editor. (2) The recipe pass above.
- [ ] **Thumbtack first-reply: the next real lead.** The programmatic draft-clear fix is
      live on the box but has only been proven against captured diagnostics, never a live
      lead. Until one lands, the pipeline is unproven.
- [x] **`refreshDisplayNames.js --check` — PASSED 2026-08-14 against prod:** 62 rows, no
      drift, after 8 days of organic writes. The display-name single-writer discipline holds
      under real use.
- [ ] **CC seniority mapping**: generate, hand-review, then `--apply`. Human-gated.
- [~] **Display-name walkthroughs: T6 PASSED + seniority panel smoke PASSED, 2026-08-14.**
      T10-T13 REASSIGNED, see below.
      **T6 (stop step 5 from asking for a name)** — the TwistidTreets fix — proven on both
      halves, because the page looking right proves only half of it:
      · SERVER: `payment.noNameWrite.test.js` runs green against the dev DB, including the
        case that matters, "POST /api/payment ignores a preferred_name in the body". The
        route no longer even destructures the field (`payment.js:57-59`), so a stale client
        or a hand-rolled POST cannot overwrite the step 4 answer.
      · UI: `/payday-protocols` has NO name input. It renders a read-only "Your tip page
        will read **Marcus**." with a "Change this" link to `/contractor-profile`, i.e. it
        displays what step 4 owns and sends you back there to change it.
      · TRAP for whoever walks this next: the page DOES still show name fields — "1. Name as
        shown on your income tax return" and "2. Business name / DBA". Those are the W-9's
        LEGAL name for tax purposes and they belong there. Do not read them as step 5
        asking for a name again.
      **Seniority panel smoke** — went at the invariant rather than the render, because the
      panel's real hazard is `contractor_profiles.updated_at`, which orders SMS STOP
      attribution on a shared inbound number. An idle Save (identical values re-submitted)
      returned `{"success":true}` / HTTP 200 and left `updated_at` **10 days old**, so the
      `IS DISTINCT FROM` guard in the PUT's WHERE clause (`admin/users.js:683-697`) really
      does write nothing. `users.seniority.test.js` is 7/7 green besides.
      FOUND, logged to the fix list: that no-op guard is NOT pinned by any test — the whole
      seniority suite never mentions `updated_at`, and the only test that does is the
      BACKFILL script's. Delete the WHERE clause and every suite still passes.
      T10-T13 (client helper port + onboarding copy/live preview, staff portal copy, client
      read-site swaps + admin legal-name row, the admin visibility notice) are copy and
      render checks, so by the 2026-08-14 split they belong in the automated lane, not here.
- [ ] **PORTED FROM THE `oo-switch-server` LANE 2026-08-19: the proposal options
      drawer + switch endpoint owes two launch checks, and they existed only on the lane.**
      `docs/superpowers/plans/2026-08-14-proposal-options-drawer.md` Task 7 says these belong
      in "the one owed-items file, which push time re-reads" and they were never appended
      here. The lane is unmerged and stale (8 commits, branch `oo-switch-server`), so had it
      been scrapped both checks would have gone with it. They live here now, and they gate
      the SHIP, not the build.
      **(1) "Walk Test Package" must not be `is_active` in the PROD catalog.** The switch's
      option list selects `WHERE (is_active = true AND bar_type IS DISTINCT FROM 'class') OR
      id = $1`, so any active fixture package appears on a live client-facing options list
      under its own name. CHECKED CLEAN 2026-08-19: prod `service_packages` holds no row
      whose name or slug matches walk or test at all, active or not. It is a DEV-catalog
      fixture (the plan counts 11 active comparable packages in dev, "Walk Test Package"
      among them). Re-run before the ship, because the dev catalog is where it lives and a
      seed run is what would put it in prod:
      `SELECT id, name, slug, is_active FROM service_packages WHERE name ILIKE '%walk%' OR name ILIKE '%test%' OR slug ILIKE '%test%';`
      **(2) Walk a drink-plan preview across a hosted-to-BYOB switch and back.** The planner
      derives from the proposal row, and the flip case has never existed in production, so
      nothing about it is proven. Switch a proposal hosted → BYOB, open the drink-plan
      preview, switch back, open it again. Both directions must read correctly; a stale or
      half-derived plan is the failure this is looking for.
- [x] **Stripe test Payment Links — ALREADY DEACTIVATED (verified 2026-08-14).** Both
      (`plink_1U0nVQ…`, `plink_1U0nVP…` — test tips for a test user) read `active: false`
      via the live API; the TODO had gone stale, same as the Ruta/Anna archive. Every other
      active link in the account is a real bartender's tip-page link, as designed.

## Tier 5 — never exercised end-to-end

- [~] **Comms SMS smoke, end-to-end — STOP/START PASSED 2026-08-14, the rest still owed.**
      **HONEST STATUS OF THE REST, 2026-08-14: this item is EXHAUSTED as far as a human
      can take it.** Four of the six remaining sub-checks are not walks at all, and saying
      so is worth more than leaving them on a list to be "looked at".
      · **duplicate MessageSid idempotency — CLOSED STRUCTURALLY.** You cannot make Twilio
        resend a SID, so it closes the only honest way: the guarantee is a UNIQUE partial
        index, verified live on prod — `idx_sms_messages_twilio_sid UNIQUE ON sms_messages
        (twilio_sid) WHERE twilio_sid IS NOT NULL`. A replayed webhook physically cannot
        insert twice. Backed operationally by **zero** unprocessed inbound rows, all-time
        and in the last 7 days, so nothing has ever been stranded mid-handling.
      · **dispatcher heartbeat — NOT A HUMAN WALK.** No route, no page, no browser surface;
        it is a SQL query or a Sentry search. Recorded explicitly so nobody "looks at it"
        and ticks the box, which is the only way this one gets got wrong.
      · **prod Twilio signature — half unprovable.** The reject-an-unsigned-request half is
        testable; the accept-a-valid-signature half can only be inferred from real traffic
        landing, which it does continuously.
      · **.ics open — BLOCKED.** The orientation email goes to the CLIENT's address only.
        Dallas cannot receive it, and without Resend dashboard access the delivery half is
        unobservable.
      · **sign+pay orientation — TRIGGER-ARMED.** Needs a real client signature plus a real
        card charge inside a 6-hour window. Dev cannot substitute, and the reason is the
        2026-08-14 Stripe finding: dev carries an `sk_live_` key, so a dev "test" charge is
        a real charge.
      · **CONFIRM/CANT — blocked two ways.** The CANT write path cannot be proven in prod
        without dropping a real staffer off a real paid event, so it is dev-only until a
        genuine drop happens. And CONFIRM from Dallas's own phone is blocked in prod because
        `clients` row 1429 (the Test Client) carries his cell number — the same row that
        swallowed the four "yes" messages. Freeing it is a one-field prod write.
      **"drink-plan submit" was MISFILED and is now resolved, 2026-08-14.** It sat under an
      SMS smoke item, but drink-plan submit sends **no SMS and never has** — verified:
      `grep -rn "sendAndLogSms\|sendSMS" server/routes/drinkPlans/` returns ZERO hits.
      Submit sends a client EMAIL (`drink_plan_ready`), an admin email only when the balance
      changed, and schedules a lab-followup email at +36h. Anyone who submits a plan and
      waits for a text waits forever and files a phantom bug.
      Where the drink plan DOES touch SMS is the scheduled NUDGE, and that path is already
      proven in production without a walk: `sms_messages` holds **34** `drink_plan_nudge_sms`
      rows, latest 2026-08-12. Nothing owed there.
      All that is genuinely unwalked is the submit-side EMAIL on dev, a 3-minute check:
      submit at `/plan/600924a5-a608-485e-a530-90546242fdd9` (dev plan 445, proposal 9813)
      and confirm exactly one `[DEV] Email skipped (notifications gated off)` line and zero
      SMS lines. SAFETY: dev fixtures carry REAL client addresses, and the only thing
      stopping a real send is `notificationsEnabled()`. Confirmed 2026-08-14 that `.env` has
      no `SEND_NOTIFICATIONS` line and `NODE_ENV=development`, so it is gated off — re-check
      that before submitting, every time.
      **STOP/START — PASSED on prod, both directions.** Dallas texted from the 312 to the
      888. `users.id=1` went `sms_enabled` true → **false** at 00:20:41Z → **true** at
      00:21:05Z, 24 seconds apart, with `sms_opt_out_at` AND `sms_opt_in_at` both stamped
      and the opt-out timestamp deliberately retained as history. `email_enabled` and
      `marketing_enabled` survived untouched, confirming the writer uses `jsonb_set` rather
      than replacing the object. Inbound rows 1521/1522 recorded with `opt_keyword`
      `stop`/`start`, `processed` true, and `client_id` null — the correct staff-branch
      resolution. Uppercase matched, so the lowercasing works.
      WORTH KNOWING: our system deliberately sends NO reply of its own here (the TwiML is
      `<Response></Response>`); any compliance reply on the phone is Twilio's own. If none
      arrives that is the number's opt-out-management setting in the console, not a code
      bug.
      SIDE VALUE: this proves the recovery path Jasmine J. needs. She has been
      `sms_enabled: false` since 2026-07-05 (see the fix list, 2026-08-14) and one START
      from her own phone will restore her the same way — 24 seconds, no admin action, no
      compliance exposure.
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

## Dev walk credentials

The dev test accounts `marcus.j@test.drbartender.com` (staff) and
`manager-test@drbartender.com` (manager) had their DEV passwords reset by Claude on
2026-08-13/14 for the walkthroughs. If a future session doesn't know them, re-reset with a
one-line bcrypt UPDATE against the dev branch (guard on the email first) — never on prod.
Staff portal is `staff.localhost:3000`; admin context is plain `localhost:3000`.

**marcus.j@test.drbartender.com — DEV password re-set 2026-08-14 to `WalkTest2026!`**
(users.id 5, role staff, onboarding_status `approved`, so he reaches `/field-guide` and
`/agreement` without the onboarding wizard blocking). Verified against the dev API: login
returns 200. Write it down here rather than re-resetting every session — this is a dev
fixture on a dev branch and the value is worth less than the twenty minutes each session
spends rediscovering that nobody knows it.

## How to use this

Work top-down. Tier 1 is where being wrong costs money, and Tier 4 items are gates — doing
the gated thing first is how the fence charges derive from unreviewed recipes.

When you finish one, tick it and delete it. When a walk finds a defect, the defect goes to
the fix list, not here. This file should shrink.

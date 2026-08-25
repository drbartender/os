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

## Status: refreshed 2026-08-21

**`origin/main` is `4ee51d00`, pushed 2026-08-21 (37 commits, `9cccd3da..4ee51d00`).**
Whenever you edit this block, re-state that sha, because the next session's staleness check
is a diff against it. The previous line named `c0dcd5b7`, pushed 2026-08-20 at 10:47.

**WHAT THE 2026-08-21 PUSH ADDED. One WAS missed — see the correction below.** The whole cohort is
in Tier 3b under a 2026-08-21 heading. **CORRECTION, added 2026-08-21 by the window that
merged it: the cohort was SEVEN items, not six-of-seven — the stale-proposal sweep
(`85c1fbcf`, merged 2026-08-20) is an eighth and was absent from this file and from the
build board entirely.** It was merged while this cohort was being assembled, which is
exactly the race the Tier-6-then-promote mechanism is meant to survive and did not. It
owes a ROLLOUT, not a walk, and is filed in Tier 4 because the dry run gates the live run.
Six of the seven original items were written into Tier 6 the
evening BEFORE the push, each naming its merge sha, and moved down the moment
`git merge-base --is-ancestor` said they were live — which is the mechanism the 8/20 cohort
lacked when it went unrecorded for a day. The seventh, the options ladder, is the largest
client-facing change in the drop: every proposal client now gets a drawer instead of the
bottom-of-page panel and can rewrite their own proposal before signing. It is also the one
item here where the owning window said outright that it called the surface finished twice
before it was, and that only a real browser caught it both times.

**WHAT MOVED SINCE THE 2026-08-19 REFRESH, and it is a lot.** 2026-08-19 was the single
best night this list has had: four of the six walks then named as "genuinely left for a
human" closed, almost all of them by **Zul** rather than Dallas. Then the 2026-08-20 push
landed the largest drop of unwalked surface this file has ever taken, so the net owed went
UP, not down.

**CLOSED 2026-08-19 (Zul unless noted):**
- **Phone admin passkey unlock — FULLY WALKED**, every leg, on a real Pixel against prod.
  This had been the highest-value item on the list, the only unverified auth path in
  production. It is now proven end to end including revoke and re-enrollment.
- **Mobile admin PWA** — both folded-in legs: offline resume, and the Desktop-view toggle
  round trip persisted in BOTH directions across reloads.
- **Admin Overview after `nat-trim`** — verdict CALM, not broken, which was the entire
  question that walk existed to answer and one no test could have settled.
- **Tip sign wake lock, Leg A.**

Those walks paid for themselves, which is the argument for the whole file: passkey step 4
found that the offline lock screen's "Use password instead" dead-ends AND silently unarms
the phone, and step 3 found that the staleness lines **do not exist anywhere in the
product** (`formatStaleAt` is exported and imported by nobody). Both went to the fix list.

**ARRIVED 2026-08-20, and none of it was in this file until now:**
- **The Admin Staff hub**, all 7 lanes (`sh-a-server` through `sh-g-fidelity`) merged and
  pushed, plus four rounds of post-merge and push-gate defect fixes. An entire new
  top-level admin section covering Roster, Hiring, Payroll, Reviews and Tips. Now the
  highest-value unwalked surface on the list — and **the first thing it did in production
  was park $20 of real money somewhere nothing displays it**, see the entry.
  (Precisely: not "never opened". Dallas logged a Google review through the hub about 30
  minutes after the push, so Reviews has been USED. Nothing has been judged.)
- **Caller communication** (`caller-comms` + `cc-verify`): new day and night greetings on
  both voice lines, press-1 escalation, quiet-hours windows. Real voice behavior a paying
  customer hits. Note that several legs are env-gated with OFF defaults, so read that entry
  before dialing anything.
- **`mkt-moment-setup` shipped**, so its Tier 6 entry claiming "MERGED, NOT PUSHED" was
  wrong and its walk was armed while reading as blocked. Moved to Tier 3b and corrected.

Also shipped 2026-08-20 and deliberately given NO entry, so nobody re-opens them: lanes
`pay-period-boundary`, `stripe-fail-closed`, `shift-status-allowlist`, `payout-stripe-guard`
and `mobile-asbuilt` are server-side guards and corrections, each landing with its own test
file. They change behavior but expose no new surface, and the fix list already carries
them. This file should shrink; adding test-covered server fixes to it is how it stops.

**Same rule applied again, 2026-08-20 evening, to a fix-list session's eight lanes.** The
user-facing ones went to Tier 6 below, and moved to the 2026-08-21 cohort in Tier 3b when
the push landed. Four lanes were
deliberately given NO entry under the rule above, named here so the decision is visible
rather than looking like an omission: `cant-overnight-ordering` (which shift an inbound CANT
re-opens — server-only, and only observable via a real overnight text), `dead-suites-dotenv`
(nine test files that had never run, no product change at all), `constraint-contract-widen`
(a boot-time schema guard) and `positions-needed-one-reader` (a staffing-count reader whose
divergence is latent on today's prod data, so there is nothing on screen to look at). Each
is test-covered and carried in the fix list.

**Count the boxes yourself rather than trusting a number written here.** `grep -c '^- \[x\]'`,
`'^- \[~\]'` and `'^- \[ \]'` against this file give done / partial / open in one command.
The hard tally that used to sit on this line was wrong from the commit that wrote it and
was never re-derived across four merges, which is what a hard-coded count in a living file
always does. What any raw count overstates: a chunk of the "open" items are not walks at
all. Read this before picking anything up.

**Closed 2026-08-14 by Dallas:** voicemail listen link (BOTH halves — the first listen link
this system has ever sent went out and was tapped), inbound SMS alerts naming the
staffer, the "See other options" compare strip, duty-pay policy text (Field Guide §17 +
agreement v3 signed and stamped), and STOP/START on prod.
**Closed 2026-08-14 by Claude:** duty-pay out-of-area knobs (both mounts, plus all of spec
§9), review money §7 manual half, display-name T6, the seniority panel smoke, and the
duplicate-MessageSid idempotency check (closed structurally on the unique index).
("Tonight" appeared four times in this block and rotted the moment the session ended.
Date-stamp closures; never write a relative time into a file that outlives the session.)

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

**What is genuinely left for a human, in order (rewritten 2026-08-20):**
1. **The Admin Staff hub** (Tier 3b). A brand-new admin section went live today and nobody
   has looked at it. It carries money surfaces (payroll tabs, tips, review bounty lines),
   so being wrong here costs more than being wrong anywhere else currently open.
2. **Marketing: the RESTYLE visual walk and the FUNCTIONAL walk, in one session.** They
   share a screen, and the now-shipped `mkt-moment-setup` card lives on it too, so doing
   all three together is strictly cheaper than three visits. The FUNCTIONAL half gates real
   sends. Budget 35-45 min for the visual half (pure judgment, wants daylight) and 70-85
   for the functional.
3. **Caller communication** (Tier 3b). Read the entry first: some legs need a Render env
   flip, and a flip costs a redeploy that drops Twilio and Stripe webhooks during restart.
4. **Tip sign wake lock, Leg B** (print-and-scan off real paper, needs a photo counter).
   Leg A passing does NOT cover this; different failure entirely.
5. **Admin palette baseline eyeball sweep** (Tier 3b). Every admin surface moved its text
   baseline in both skins with zero browser verification, and has now been live six days.
6. The small dev-side ones, cheap to batch: Remote Staffing Fee prompt, bar-required
   transport ack, shopping-list guest-count prompt in House Lights.

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
CLOSED 2026-08-19, the September corporate-holiday moment, on both halves, and **fully
shipped as of 2026-08-20**. The audience half is live in prod: `client_tags` holds exactly
9 `corporate` rows, so the moment has somebody to go to. The product half is lane
`mkt-moment-setup` (`7b099746`), which is now an ancestor of `origin/main`, so the
needs-setup card and the header's "N needs setup" segment DO render in prod. Its walk moved
from Tier 6 to Tier 3b and is armed.
This entry is the worked example of how this file goes wrong: the sentence above read
"merged but NOT pushed" for a full day after the push, which is a walk sitting available
while its own entry tells you not to bother. **A push-state claim written into this file is
false the moment the next push lands.** If you must write one, write the check instead of
the verdict: `git merge-base --is-ancestor <sha> origin/main`.

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
- [~] **Tip sign wake lock: LEG A PASSED, LEG B STILL OWED.** Named in the ordered list
      above since 2026-08-14 with no checkbox anywhere in the tiers, so it was invisible to
      every count and a tier refresh would have dropped it. It is a real human walk under
      routing rule 2: real device, real paper.
      ~~LEG A (about 20 min, on the Pixel): open a bartender's tip page, confirm the screen
      does not sleep while it is showing, and confirm it releases when you leave.~~
      **LEG A PASSED — reported by Zul 2026-08-19** (walk itself may predate that date; she
      reported it as already done, and no earlier record of it exists). The wake lock holds
      while the tip page is showing and releases on leave.
      **LEG B (print-and-scan) IS STILL OWED and does NOT ride on Leg A.** Print a sign and
      scan the QR off the PAPER with a phone camera, never off a screen. Needs a photo
      counter or an equivalent flat surface. This is the leg that catches a code that renders
      and scans perfectly on a display but fails at real ink density on real paper, which is
      a different failure entirely from anything Leg A touches. Do not let "the tip sign is
      done" stand in for this one.
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

Three cohorts now. The 2026-08-13 walkthrough fixes needed the same medicine they were
prescribing: the TimePicker and equipment-label fixes both shipped BROKEN on the first
attempt and were corrected blind by a later session (`54fb77cb`, `fc5e6ca2`). The 8/14
through 8/19 arrivals come next. **The 2026-08-20 cohort is listed FIRST and is the
largest single drop this file has ever taken**: a whole new admin section plus live voice
behavior, none of which existed here until 2026-08-20.

**HOW THE 8/20 COHORT GOT MISSED, because the mechanism will repeat.** This file is
written by hand at the end of a session, and the 2026-08-20 push (`origin/main` at
`c0dcd5b7`, pushed 10:47) landed while the file's own status block still named
`d61c62b7` as the tip. Nothing in the pipeline appends to this file when a lane ships, so
a push that lands after the last edit is invisible here by default. Until that is
automated, **re-derive the cohort at the top of any walk session** rather than trusting
the tiers: `git log --format='%h %ad %s' --date=short <the sha this file names>..origin/main -- server client/src`
lists every code commit live in prod that this file may not know about.

**THE 2026-08-25 COHORT.** One item, and the tier-6 mechanism carried it: it arrived there with
its merge sha the moment the lane merged, and moved here when the push made that sha an ancestor
of `origin/main`. Nothing had to be remembered.

- [ ] **Events list staff hover is live** — merge `21ec7993` (lane events-staff-hover). On /events,
      hover the Staffing column on a staffed row and a card lists everyone confirmed, name and
      position. Checked headless on dev in both skins before merge, so the walk is for what a
      browser cannot judge: whether it feels right at your real window size, whether it is quick
      enough to be useful while scanning the list, and whether it gets in the way when you are
      just reading. Two specifics worth deliberately hitting, both of which broke during the
      build: scroll to the BOTTOM of the All tab and hover the last row (the card flips above the
      cell there; the first version rendered it 42px below the fold, unreachable), and click a row
      while its card is showing (it should still open the event). Unstaffed rows and rows with
      nobody confirmed show no card at all. Hover only, no phone and no keyboard path, by design,
      so do not go looking for one. NOTE the card also appears on legacy "No roster" rows that
      have people assigned, which is information nothing else on that screen surfaces.

**THE 2026-08-21 COHORT (push `9cccd3da..4ee51d00`, 37 commits).** Seven items, and unlike the
8/20 cohort none of them was missed: six arrived in Tier 6 the evening before with their merge
shas attached and moved here the moment the push landed. The seventh is the options ladder,
which is the largest client-facing change in the drop and is listed first because of it.

- [ ] **The options ladder is live to every proposal client** — merges `c6927359`, `39ff7d8d`,
      `d171662a` (lanes oo-switch-server, oo-server-display, oo-ladder-client). THE BIGGEST
      client-facing change in this push. The bottom-of-page "See other options" panel is now a
      drawer, the mailto hand-off is gone, and a client can rewrite their own proposal before
      signing. Recorded here from that window's own board note, not from my verification.
      **WALK IT ON A REAL DEVICE, and treat that as the whole point.** Everything verified so
      far is headless Chromium on this box: nobody has dragged that sheet with a thumb. That
      window says plainly it called this surface finished twice when it was not, and both times
      only a real browser caught it — once when the desktop panel painted over the sticky
      sign-and-pay rail, once when the entire BYOB half of the ladder rendered no commit button
      at all. A later browser pass then found its own inset FIX was inert (an inline padding
      shorthand beat the class rule, invisible to grep and to the bundle) and that the
      extras-strip fix wiped the mobile ladder at the peek snap.
      Specifically: drag the sheet on a phone, check the peek snap does not eat the ladder,
      confirm the BYOB rungs actually offer a commit button, and confirm the sticky
      sign-and-pay rail is never painted over on desktop.
- [ ] **A live signature on a scratch proposal, because the sign assertion just armed** —
      merge `d171662a`. `ProposalView.js` now sends `acknowledged_total` on the sign POST,
      arming a server assertion that had existed for a week and never once fired. I read both
      halves across the two windows before the push and the seam is built correctly (dollars
      against dollars with a half-cent tolerance; an absent field disarms it exactly as before;
      a 409 refetches and clears BOTH Stripe client secrets so nobody can pay against a stale
      intent) — but no real signature has ever exercised it, and this is the last click of the
      funnel. Sign a scratch proposal and confirm it completes. Then, if you want the assertion
      itself proven: open the proposal in two tabs, change the total in one, and sign in the
      other — expect "Your total changed while this page was open", a refreshed price, and NO
      signature recorded.
- [ ] **Contractor agreement: clause 6 renders bold instead of printing `**`** — merge
      `40607383`, lane `agreement-bold-runs`. The signing screen printed literal
      `**Mutual.**` and `**From Contractor.**` while the archived PDF has always rendered
      them properly, so the person signing saw a worse document than the one that gets filed.
      WALK ON DEV, never prod (a prod signature is a real signed contract): open the
      contractor agreement as a staff fixture and read clause 6, "Representations &
      Warranties". Expect two bold lead-ins and NO asterisks anywhere on the page. Then
      compare against the generated PDF for the same clause — the whole point is that the two
      surfaces now agree, so seeing them side by side is the actual test.
      Frozen copy was deliberately NOT edited (V3 aliases most of V2's clause objects, so
      editing the strings would rewrite the text of already-signed v2 agreements), which
      means an existing signed v2 PDF must still render exactly as it did.

- [ ] **Field Guide: sections open by keyboard** — merge `b7c8119b`, lane `dead-affordances`.
      Before this, a collapsed section's text was not in the DOM at all and the header had no
      keyboard path, so a keyboard user could not read ANY of the guide — while the
      acknowledgment below it was a real checkbox they could tick and Continue was a real
      button they could press. Sign what you cannot read.
      WALK WITH THE MOUSE UNPLUGGED, which is the only way this walk means anything: Tab to a
      section header, press Enter, confirm it expands; Tab to another, press Space, confirm
      the same; confirm focus is visible on the header at each stop; then Tab down to the
      acknowledgment and Continue and confirm the whole flow completes without a pointer.
      Also check a screen reader announces expanded/collapsed if one is to hand — that is the
      half `aria-expanded` was silently failing to provide before.

- [ ] **Client shopping list: lines check by keyboard** — merge `b7c8119b`, lane
      `dead-affordances`. PUBLIC, client-facing. Every line was a bare div with a hand-drawn
      checkbox: no role, no tab stop, no key handler, and the only two real buttons on the
      page are PDF download and retry, so it was a total keyboard lockout on the page a
      client works a liquor-store aisle with.
      WALK ON A REAL PHONE AND WITH A KEYBOARD, both: tap a few lines and confirm the tick,
      strike-through and progress bar behave exactly as before (the mouse path was never the
      broken one and must not have regressed), then Tab through the list and check lines with
      Space and Enter. Reload and confirm the ticks persist — the page stores them per token
      in localStorage, so persistence is part of the feature, not incidental.

- [ ] **Staff shift list: pending cards stop looking tappable** — merge `b7c8119b`, lane
      `dead-affordances`. `.sp-shift` handed every card a pointer cursor and a hover border
      whether or not it opened, and MineTab renders the dead pending cards and the LIVE
      upcoming cards into the same flex column as adjacent siblings. A bartender learned
      "shift cards open" from one row and tapped the row above it to nothing.
      WALK IN BOTH SKINS, which is the part that can regress invisibly: on the staff portal
      Mine tab with at least one pending or waitlisted request, hover a pending card and
      confirm no pointer cursor and no border change, then hover an upcoming card directly
      beneath it and confirm it still does both. Switch skins and repeat. The light skin
      styles the first card's top border differently, so specifically check that the FIRST
      pending card in the list looks identical at rest and on hover.
      Also confirm the Withdraw / Leave-waitlist button inside the pending card still works —
      it was always live and must stay so.

- [ ] **A curly apostrophe and a decomposed accent are accepted in a preferred name** —
      merge `5117ef3e`, lane `pushgate-814-residuals`. Both were rejected by a message that
      said apostrophes were allowed, which is the worst kind of refusal. Here because it
      cannot be settled off a device: the whole premise is that iOS substitutes U+2019 for a
      typed apostrophe, and that was verified in code, not on a phone.
      WALK ON A REAL iPHONE: as a staff fixture, set a preferred name to `O'Brien` typed
      normally (iOS will insert the curly one) and confirm it SAVES rather than refusing.
      Then check what got stored — it should be the plain ASCII apostrophe, because the
      validator folds on the way in.
      THE PART WORTH WATCHING, and the reason this is not just a happy-path check: an
      UNCHANGED name also normalizes on save, so a staffer editing only their phone number
      can have a stored legacy name quietly repaired underneath them. That is intended, and
      it is exactly the kind of intended-but-silent write that should be seen once by a human
      before it is trusted. Confirm the displayed name after such a save is what you expect.

- [ ] **Press-1 with the kill switch OFF plays a message instead of dead air** — merge
      `5016dc2c`, lane `vm-press1-honesty`. NOT a normal walk and NOT urgent: this changes
      nothing while `VM_ESCALATION_ENABLED` is `true`, which it is in Render. What it fixes is
      the OFF state, where the offer stayed in both lines' recordings while the `<Gather>`
      vanished, so a caller pressed 1 into a document that was not listening and dropped to
      the beep.
      VERIFY BY DELIBERATELY FLIPPING THE SWITCH, once, at a quiet hour: set
      `VM_ESCALATION_ENABLED=false` in Render, call the line, let it go to the missed-call
      greeting, press 1, and confirm you hear the recorded "sorry, nobody's available right
      now" and then the beep — not silence. Confirm in the Twilio console that NO outbound leg
      was dialed, which is the guarantee the switch still owes. Then set it back to `true`.
      **This is the other window's territory** — phone work is live there — so coordinate
      rather than flipping a production voice switch underneath it.

- [~] **THE ADMIN STAFF HUB: LOOK-AT-IT HALF PASSED 2026-08-20 (Zul). MONEY SEAMS STILL OWED.**
      **VERDICT on the consolidation: it reads as ONE HUB**, not four old pages stapled under
      a shared header. That is what a consolidation walk is for and no test produces it.
      **Every factual prediction in this entry held**, checked screen by screen: the subtitle
      string matched exactly, Roster read 16 (not 18, admins excluded by the `role IN
      ('staff','manager')` bind), Hiring showed two cards with an EMPTY Onboarding column,
      Payroll rendered the `$0.00` CurrentWeekCard with its zero state suppressed, the Tips
      ledger held exactly the one $6.00 tip, and both `staff_reviews` rows appeared under
      RESOLVED.
      She flagged "2 reviews logged" against this entry's "zero pending", which is exactly the
      shape a real defect would take and was worth raising. Verified against prod: both rows
      are `status='confirmed'` (id 1 thumbtack 8/17 auto-ingested, id 2 google 8/6 logged by
      Dallas 8/20), so zero PENDING and two RESOLVED are the same fact stated two ways. Had
      they rendered as pending workbench cards offering Confirm again, that WOULD have been a
      bug. They did not.
      **STILL OWED, and blocked on data rather than on a human: BOTH MONEY SEAMS.** With zero
      pending reviews there is no workbench card, so the Confirm button is unreachable and its
      three-way label ladder (`Confirm and pay $X` / `Confirm, $X waits for the next open run`
      / `Confirm, no bounty`) and its "Save names first" dirty-state guard were NOT exercised.
      Award the quarter was correctly disabled twice over and deliberately not clicked, since
      `force: true` locks a winner permanently. Re-walk both the moment a real pending review
      lands while a pay period is open, which is the same condition that heals the $20 gap.
      Original entry follows. **7 lanes, shipped and pushed 2026-08-20.** Roster, Hiring,
      Payroll, Reviews and Tips consolidated under one sidebar entry. Lanes `sh-a-server`
      (`c4bb2d1f`) through `sh-g-fidelity` (`c2b05d8d`), plus `4dbe9c5b`, `ba9ea23b`,
      `b97c7490` and `c0dcd5b7`. Benchmark artifact
      `docs/design-artifacts/2026-08-19-staff-hub.dc.html`, design project
      `96291c7a-3510-4910-9c67-c41d81504920`.
      **NOT "never opened" — correct that before you start.** `staff_reviews` holds TWO
      rows, and row 2 is `source='google'`, `created_by=1` (Dallas), stamped 2026-08-20
      16:17Z, about thirty minutes after the push. A `google` row can only be written by
      `POST /admin/staff-reviews`, whose only remaining client caller is the hub's own
      "Log a Google review" action, so the Reviews child has already been driven log →
      credit → confirm in production. That is USE, not a walk. Nothing has been judged.

      **READ THIS BEFORE OPENING /staffing/reviews, because the screen contradicts itself
      and it is NOT a render bug.** There is **$20.00 of review bounty owed to two real
      staffers and parked where nothing displays it.** Both reviews are 5-star and credited
      (review 1 → user 212 Tashea, review 2 → user 206 Mariah), but
      `SELECT COUNT(*) FROM payout_duty_lines WHERE kind='review_bounty'` returns **0** — no
      line, no tombstone. Cause: no `pay_periods` row exists for the current week, so
      `materializeReviewLine` returned null on both confirms (`dutyLines.js:506`). So the
      Resolved table prints `$10.00` twice (it derives `paysBounty` from the REVIEW, at
      `ResolvedTable.js:62`) while the footer prints `$0.00 in bounties paid` (a real SUM
      over `payout_duty_lines`, `staffReviews.js:158-163`). Both numbers are honest; they
      are answering different questions. This is the known `materializePendingReviewLines`
      gap producing its first real money, and it self-heals on the next confirm that lands
      while a period row is open. **Do not file the mismatch as a UI defect.** The money
      side is now on the fix list; the stale claim there that "zero bounties have ever been
      paid, so nothing is owed today" was corrected in the same session that found this.

      **WHERE IT LIVES.** `/staffing` (Roster, index), `/staffing/hiring`,
      `/staffing/payroll`, `/staffing/reviews`. The last three are `adminStrict` at the
      ROUTE (`App.js:325-327`), so a manager typing the URL bounces before any fetch. The
      sidebar collapsed four entries into one: `Staff → /staffing` carrying
      `['new_applications','pending_reviews']`. Hiring, Tips & Feedback and Reviews are
      gone from `nav.js` and from the command palette. Four legacy redirects preserve query
      params: `/hiring`, `/tips` → `?tab=tips`, `/reviews`, `/financials/payroll`.
      Payroll's own `.seg` pills are `Pay run · History · Tips · 1099 / tax`.

      **WHAT YOU WILL SEE TODAY, so you can tell empty-by-design from broken.** Prod is
      nearly dataless here and almost every panel legitimately renders empty:
      · Subtitle should read exactly
        `16 active · pay run Aug 18 to 24 open, payday Tue Aug 25 · nothing to confirm`.
      · **Roster says 16, not 18.** The feed binds `role IN ('staff','manager')`, so the two
        admin rows (users 1 and 2) are excluded from every figure. 16 + 2 = the 18 people.
      · **Hiring's Onboarding column is EMPTY and the whole kanban holds 2 cards.** The
        "29 cards at 0%" premise this file carried was WRONG: `/admin/applications` INNER
        JOINs `applications`, and the 40 hired/in-progress accounts have no application row.
        The 60-day stale-record fold shipped as defensive code and **can never fire today**,
        so `.hire-fold` never renders. Do not go hunting for it.
      · **The pay run in the subtitle has no database row behind it.** `open_period` is
        DERIVED (`chicagoTodayYmd` → `payPeriodForDate` → `computePayday`) and the endpoint
        never writes: three queries, all SELECT, pinned by `staffHub.test.js:120`. Rows are
        minted lazily on first accrual, usually Saturday. Periods are Tuesday-to-Monday.
      · Consequently the **CurrentWeekCard renders** (`$0.00 owed`, "Nothing accrued yet…")
        and the queue below is empty with its zero state **deliberately suppressed**
        (`PayRunView.js:162`). You will NOT see "Nothing owed. Every period is paid."
      · **Reviews: zero pending**, so there are no workbench cards at all, only the Resolved
        table and the rail. The `.reviews-grid` left column will look sparse.
      · **Contest rail:** expect `No qualifiers yet.` and a **disabled** Award button,
        disabled twice over (no qualifying shares, and `No open pay period. Open one before
        awarding.`). Both staffers have 1 named five-star against a floor of 2.
      · **Tips ledger: exactly one tip ever** — $6.00, 2026-08-15, user 12, status chip
        `on the Aug 15 event`. Both repair queues clear, collapsed to one strip.
      · **FeedbackCard** (staffer profile → Tip Page tab) has **zero rows ever**, on every
        staffer. Ratings there are out of **3**, not 5.
      · "Net in view" on the ledger means the loaded page (cursor-paginated at 50), not all
        time. Deliberate, and the copy says so.
      · **Two tab vocabularies on one screen is the design, not drift:** `.hub-tabs`
        underline for sections, `.seg` pills for views inside a child. `/marketing` still
        uses `.seg` for its sections and is explicitly grandfathered; do not flag it.
      · **"Send SMS" lands on a page that looks nothing like the hub** (`/staffing/legacy`,
        with its own `<h1>` and legacy pill tabs). Declared out of scope, not a regression.
      · Every admin card is inset ~26px more than the artboards draw. Known, deliberate,
        already on the fix list; the global fix would move every card in the admin app.

      **THE MONEY SEAMS, and these are what a walk is actually for.** Two controls write:
      1. **Reviews → Confirm.** The button label is a three-way ladder and getting the wrong
         one is the bug class here: `Confirm and pay $X` (open period), `Confirm, $X waits
         for the next open run` (what it should say TODAY), `Confirm, no bounty` (under 5
         stars or no name). Confirm is **disabled while the name chips are dirty** with
         `title="Save names first"`, because a money write must not depend on unsaved client
         state. Verify that guard by eye.
      2. **Reviews → Award the quarter.** $100 pot. A mid-quarter award 409s
         `QUARTER_IN_PROGRESS` and then asks `window.confirm("…Awarding now is permanent and
         cannot be revised later. Award anyway?")` before retrying with `force: true`.
         **`force` must never be sent unprompted** — it locks a winner in permanently.
         Winners and the split are server truth; the client renders `data.shares` and never
         recomputes.
      Display-only but worth understanding before you read the ledger: **a tip on your own
      sign is not your money.** The pool sums every tip on any shift of the proposal,
      deliberately ignoring `target_user_id`, and splits it evenly across approved
      non-dropped staff whose position lowercases to exactly `bartender`. Barbacks and
      servers get $0. That is why there is a derived Status column and no "Lands in" column:
      there is no tip → payout key.

      **DO NOT RE-PROVE THESE BY HAND.** 15 client suites (81 tests) and the server suites
      already pin: the hub chrome and the manager's no-tab-strip view, every subtitle string
      including the cross-month window, the pay-run card and its `b97c7490` fix, the whole
      tips Status precedence ladder and its stale-response guards, roster grouping and
      order, the Hiring fold's 60-day boundary, the reviews envelope arithmetic, and that
      the hub read never creates a `pay_periods` row.

      **WHAT NOTHING COVERS — this is the walk's real job:**
      · **The ContestRail generation guard has ZERO tests**, and it is the `c0dcd5b7` HIGH
        finding: a slow read landing late could render one quarter's standings under another
        quarter's label while Award pays a different set of people out of the same pot.
      · **The entire award flow client-side.** No test ever clicks Award; `AwardDialog.js` is
        never rendered by any test.
      · **`FeedbackCard` / `TipPageTab` have no test file at all** — and the alert email is
        proven to link at a card nothing verifies renders, which is exactly the failure that
        forced the `b114e9f0` revert once already.
      · **All four `LegacyRedirect` mounts.** There is no `App.test.js`; the query-param
        merge, their whole reason for existing, is untested.
      · **`adminStrict` at the route.** Nothing proves a manager typing `/staffing/reviews`
        bounces. Worth doing for real with the manager account.
      · **Roster pagination** (`PAGE_SIZE=100`, the `Showing page N of M` footer, Prev/Next)
        is entirely untested.
      · **All CSS.** jsdom applies no stylesheet and evaluates no media query, so the
        `.hub-tabs` scroll at 720px, the 2px accent underline, the light-skin square corners
        and the `.reviews-grid` collapse at 900px are Dallas's eyes only.

      **JUDGE IT AGAINST THE ARTIFACT, NOT TASTE**, with three riders: spec §3 carries a
      19-item override list that supersedes the artboards (a deviation on that list is not a
      finding); fidelity means structure, class vocabulary and token names, never resolved
      hue values; and **the vendored `.dc.html` does not render standalone** (it loads a
      `support.js` and a DS bundle that are not vendored), so open the canvas in the design
      project for a rendered view.
      Still owed from the plan's own manual list, none of it automatable: both skins, a
      720px window, a real manager login AND a manager without `can_staff`, the Overview
      payroll card deep link landing on the right period, and one confirm driven end to end
      on a real screen.

- [x] **CALLER COMMUNICATION: WALKED AND CLOSED 2026-08-20 (Zul), on the 1922 against prod.**
      **THE FIRST PRESS-1 IN THIS SYSTEM'S HISTORY.** Verified against prod rather than taken
      on report: call `CAe66e98f18e5baadb2a0bf00703386f0a`, line `primary`, 18:20 CDT.
      `escalated_at` 23:20:55Z (the digit was caught and CLAIMED, 17s in),
      `escalation_outcome` `no_answer` (the leg genuinely DIALLED and rang, it was not
      suppressed), `duration_sec` 6 with a recording present, `delivered_at` 23:21:40Z. Door
      to door, 62 seconds.
      **FOUR legs proven for the first time:** the day greeting played Dallas's real recording
      and offered press-1; the digit was caught and claimed; the escalation dialled for real;
      and when it went unanswered the caller fell through to voicemail and the alert SMS
      landed with its listen link.
      **ANSWERED A CONFIG UNKNOWN nobody could read from here:** the dial FIRED, so no quiet
      window suppressed it. Either `VM_ESCALATION_QUIET_ZUL` is unset or 18:20 CDT sits
      outside it. Consequence worth carrying: **a press-1 at 3am would ring the PH cell too.**
      If that is not wanted, set the quiet window in Render; the code default is no window at
      all (`quietWindowFor` returns null on unset/empty, `voicemailLine.js:101-107`).
      **RESIDUAL, and Dallas/Zul closed the entry knowing it: the BRIDGE itself is unproven.**
      `escalation_accepted_at` is still NULL on every row ever. The escalation rang her own
      phone while she was holding the phone that placed the call, so nobody has yet ANSWERED
      an escalation and talked to a caller. Low risk (Twilio joining two legs, and the dial
      demonstrably works), so it was deliberately not held open as its own item. If it is ever
      wanted: call the 1922 from phone A, press 1, answer on phone B.
      Original entry follows. **new greetings and press-1 escalation, live on both voice
      lines, never heard by a single real caller.** Lanes `caller-comms` (`328ba2f4`) +
      `cc-verify` (`ee1262f6`). Eight new recordings replaced the synthetic Polly voice:
      day and night greetings, an escalate-ack and an escalate-failed clip, per line.
      **PROVEN NOBODY HAS HEARD THEM:** prod `voicemail_delivery` holds 11 rows, newest
      2026-08-18, which predates the push. `escalated_at`, `escalation_accepted_at` and
      `escalation_outcome` are NULL on all 11, so no press-1 has ever been claimed or even
      skipped in production.
      **THE FIRST THING TO CHECK, and it may be a real defect.** Both lines' default day
      recordings SAY "press one and I'll see if someone's available." But the `<Gather>`
      that makes the key work is emitted only when `VM_ESCALATION_ENABLED` is the literal
      string `'true'`, and the code default is OFF (`voicemailTwiml.js:83-85`). With the
      flag off the caller is invited to press a key that does nothing: `<Record
      finishOnKey="#">` ignores a `1`. **Confirm `VM_ESCALATION_ENABLED` in Render before
      anything else.** If it is off, that is a live client-facing defect and it goes to the
      fix list. Note the documented "revert" in `.env.example:324-329` does not escape it
      either: the `say` fallback text also contains the offer.
      **WALK IT ON THE 1922, NOT THE 0082.** The 1922 rings Dallas's own 312 and texts the
      312. Every call to the 0082 rings **Zul's actual phone in the Philippines** and sends
      her two Telegram messages. And a press-1 on the 1922 dials her PH cell, an
      international billed leg, so warn her before you dial.
      **THE TIMING TRAP, which will otherwise read as broken.** Two different windows that
      sound alike and are not:
      · `VM_NIGHT_WINDOW` (default `21:00-09:00`, America/Chicago) is about the **caller**.
        It swaps the greeting and suppresses the press-1 offer entirely.
      · `VM_ESCALATION_QUIET_*` is about the person being **dialed**, in **their own**
        timezone, and suppresses only the dial, never the greeting.
      Worked: Manila runs Chicago **+13h** under CDT, so a quiet window of `22:00-08:00`
      Manila maps to **09:00-19:00 Chicago** exactly. Combined with the 21:00-09:00 Chicago
      night window, that leaves **only 19:00-21:00 Chicago** where a press-1 on the primary
      line is both offered AND actually rings Zul. Outside it you get the failed clip
      instantly with no ringback, which is correct behavior and looks like a bug.
      **SO: do the press-1 legs between 7pm and 9pm Chicago.** Day greeting any afternoon,
      night greeting after 9pm. That is a zero-or-one-flip walk; forcing the windows costs
      two more Render redeploys and each redeploy drops every Twilio and Stripe webhook
      while it restarts, plus a cold start returns 502/Cloudflare rather than real
      behavior, so a call inside the deploy window is a false result either way.
      **FREE HALF, no phone call at all, and it is most of the walk.** Every clip is
      publicly fetchable with no auth. **Verified directly against prod 2026-08-20: all
      eight return 200 `audio/mpeg`**, sizes 114829 / 68173 / 27277 / 48589 (primary
      day/night/ack/failed) and 119945 / 79707 / 35931 / 63003 (zul). Listen to all eight
      in a browser before spending a single call, and check the sizes above if one sounds
      truncated:
      `https://api.drbartender.com/api/voice/audio/{primary,zul}-{greeting-day,greeting-night,escalate-ack,escalate-failed}.mp3`
      That covers "does it sound right", which is the only thing tests cannot reach. The
      phone calls then only need to prove SEQUENCING: right clip on the right line at the
      right hour, and the beep landing where it should.
      **WHAT THE WALK IS ACTUALLY FOR.** The TwiML documents are golden-pinned byte-for-byte
      by tests (`voice.test.js:527-549`, `:1154-1175`, `:1177-1200`), the copy strings are
      pinned (`voicemailTwiml.test.js:100-110`), the night boundaries and a DST transition
      are pinned (`voicemailLine.test.js:115-155`), and every bundled asset is proven to
      exist (`voiceAssets.test.js:35-72`). **Do not re-prove any of that by phone.** What no
      test can reach is whether the recordings SOUND right: audible, the correct voice on
      the correct line, the right words, no clipping, and a sensible gap before the beep.
      MORE TRAPS: whoever holds the receiving phone must **press a key** to accept the
      whisper screen ("Press any key to take the call"), and saying hello does nothing but
      hang the leg up and send the caller to voicemail, correctly. A recording under 2
      seconds is silently destroyed, so speak 5+ seconds. The alert never appears in the
      admin Messages page (`skipLog: true`, by design). If you hear the *Google Voice*
      greeting instead of Dallas's, GV intercepted the forwarded leg and you get no
      recording at all, which is what `VM_PRIMARY_RING_SEC=18` exists to outrun. Twilio
      caches `<Play>` sources for an hour, so a re-recorded clip keeps serving the old take.
      **A QUESTION FOR DALLAS, not a finding, because Render is unreadable from here:** the
      2026-08-19 spec's night-mode rationale is that Zul keeps Chicago-aligned hours to be
      available to US clients. A Manila-local quiet window of `22:00-08:00` would silence
      her escalation across the entire Chicago business day. If `VM_ESCALATION_QUIET_ZUL`
      is set to that example value, press-1 on the primary line is effectively dead when it
      matters most. Worth answering before the walk, since it decides whether 19:00-21:00
      is a quirk or the whole story.
      There is NO admin UI for any of this: zero hits for `voicemail` or `escalation_outcome`
      anywhere in `client/src/`. It is observable by ear, in Twilio, in Telegram, or by
      querying `voicemail_delivery`. Nothing branches on `escalation_outcome`; it is
      write-only observability.

- [x] **Marketing moment needs-setup card + header segment: PASSED 2026-08-20 (Zul), in prod.**
      Both surfaces confirmed present on the Overview tab: the needs-setup CARD and the
      header's "N needs setup" segment. Walked in the same session as the marketing restyle,
      exactly as this entry advised.
      The entry (and the restyle entry's pointer) both said the lane was merged and NOT
      pushed, so nothing would render in prod. **That went stale: `7b099746` shipped**, and it
      is why these were visible at all. Verified by ancestry before the walk, not assumed.
      WHAT THIS CONFIRMS, and it is the reusable half: an open moment with an empty audience
      used to be invisible in THREE places at once (the card list, the `open_moment_count`
      badge, and a header reading "0 moments open" while a moment was open). A moment now
      DECLARES which kind of empty it is. `emptyAudience: 'configure'` means a human can close
      the gap today, so it renders a card; `'wait'` means only time changes it, so it stays
      quiet. That is what stops a permanently-open, time-gated moment nagging daily on a young
      book, and it is the law to preserve if this surface is ever rebuilt.
      Original entry follows. **(lane `mkt-moment-setup`):
      PUSHED AND LIVE IN PROD.** Corrected 2026-08-20: this entry sat in Tier 6 reading
      "MERGED, NOT PUSHED" long after the commit had shipped, so a walk that was armed
      read as blocked. `7b099746` is an ancestor of `origin/main`. It is walkable now.
      It closed the product half of the September corporate-holiday miss, where an open
      moment with an empty audience was hidden in three places at once (the card list, the
      `open_moment_count` badge, and the header reading "0 moments open" while a moment was
      open).
      The reusable law it introduced, which is what the walk is really checking: an open
      moment now DECLARES which kind of empty it is. `emptyAudience: 'configure'` means a
      human can close the gap today (`holiday-corporate`, whose audience is gated on the
      `corporate` tag), so it renders a card. `emptyAudience: 'wait'` means only time
      changes it (`one-year-on`, `cold-quotes`), so it stays quiet. Nagging daily about
      something nobody can act on is itself the bug.
      ON THE MARKETING OVERVIEW:
      1. A `configure` moment with an empty audience renders a needs-setup card that keeps
         the spine, the window and the why, drops "Review recipients" (there is nobody to
         review), shows `0 emailable` in the rail, and offers exactly two actions: "Set up
         the audience" and "Not this time".
      2. The header subtitle carries a separate "N needs setup" segment alongside "N moments
         open", so it can never read "0 moments open" while a needs-setup card sits below it.
      3. A `wait` moment with an empty audience renders NOTHING. Confirm `one-year-on` and
         `cold-quotes` stay silent; prod's earliest event is 2026-04-25, so `one-year-on`
         legitimately cannot match anyone for months and must not shout about it.
      4. "Set up the audience" lands somewhere you can actually add the tag.
      NOTE prod's `corporate` tag is populated (9 clients), so `holiday-corporate` will
      render as a normal sendable moment rather than a needs-setup card. To see the card at
      all you need a `configure` moment whose audience is genuinely empty. Do NOT add a
      check that dismissing a needs-setup card decrements the open-moments badge: it cannot
      fail, because `open_moment_count` counts `moment.emailable > 0` and
      `moments_needing_setup` counts `moment.emailable === 0`, so a needs-setup moment was
      never in the open count.
      Walk it in the same session as the Marketing RESTYLE and FUNCTIONAL walks below;
      it is the same screen.

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

- [x] **Admin Overview / Needs-attention after `nat-trim`: WALKED 2026-08-19 (Zul). PASSES.**
      The entry's own stated question was "does the emptier board read as calm or as broken."
      Verdict: **CALM.** That is the whole point of the walk and no test could have answered
      it. The reshaped landing page reads as intended rather than as a failed render.
      Grounded before the walk so a dormant control could not be mistaken for a broken one:
      the Payouts badge count is genuinely 0 in prod (`stripe_payout_lines`, the badge
      predicate `matched_kind = 'unmatched' AND acknowledged_at IS NULL`), so its ABSENCE is
      correct.
      NOT separately confirmed, low value and left rather than nagged: that the Band 2 Payouts
      button still deep-links to `{ tab: 'payouts', show: 'unmatched' }`. It is the only
      functional check in the entry; everything else is visual and is covered by the verdict.
      NOTICED WHILE GROUNDING THE BADGE, not part of this walk: 119 of 217 `stripe_payout_lines`
      still carry `matched_kind = 'unmatched'`; they are merely ACKNOWLEDGED, which is what
      zeroes the badge. Memory records this surface as "213/213 matched", and acknowledged is
      not matched. Worth a look, recorded here only so the observation is not lost.
      Original entry follows. **LIVE IN PROD 2026-08-19**
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

- [x] **Admin palette baseline eyeball sweep: WALKED 2026-08-19 (Zul). BOTH HALVES DONE.**
      **VERDICT: the design reads COHERENT**, and After Hours reads better than House Lights
      with sizing "just right". That is the judgment this sweep existed to get.
      SPLIT INTO ITS TWO HALVES, per routing rule 1, and both are now done:
      **Automated half** — `npm run palette:contrast` (new, `scripts/palette-contrast.js`)
      measures 13 admin surfaces in both skins with `getComputedStyle` on real painted text.
      **267 AA failures collapsing to ~20 root colour pairs, seven of which hit all thirteen
      surfaces**, so they are token-level and a handful of fixes closes most of it. It
      confirmed the arithmetic era's one good figure (House Lights muted at exactly 4.22, on
      136 instances) and found several worse pairs nobody had thought to compute. Detail in
      the fix list.
      **Human half** — Zul, both skins. Settled three things the numbers had wrong or could
      not see: my `div.avatar` 1.05 finding was a FALSE POSITIVE (a linear-gradient the tool
      could not measure; she saw legible dark-blue-on-light-blue and was right); admin modals
      are NO LONGER boxless ghosts in House Lights, so that older finding is stale and should
      be closed; and dollar figures read comfortably because the failing amber is a STATE, not
      the default.
      LEFT HONESTLY UNVERIFIED: the cyan `is-warn` question. No live warn state was findable
      on any admin surface. `PALETTES.dark.warn` is `{h:192}` at source so the defect is real
      in code; how it READS is still unknown and needs a surface with a genuine warning.
      METHOD NOTE worth keeping: the tool shipped its own blind spot on day one and a human
      found it the same evening. A numbers pass cannot audit itself. Do not let a future
      "the checker is green" stand in for this walk.
      Original entry follows. **(palette lanes, merged 2026-08-14).** The
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
- [x] **Bar-required transport ack + card: PASSED 2026-08-21 (Zul), on dev. All three checks.**
      (1) **Equipment card names the bar.** Shift 14 (Sean Parent) leads with "Portable bar —
      DRB bar pickup at the Pilsen storage unit, or bring your own". Worth stating why that is
      the strong result: shift 14's `equipment_required` is literally `[]`, so the card can
      ONLY be driven by the DERIVED `bar_required` (`barRequiredSql`, `shifts.queries.js:31`:
      `num_bars > 0 AND (per_guest OR paid bar_rental)`). Nothing in the stored equipment list
      could have produced it.
      (2) **The transport ack gates correctly, proven as a PAIR rather than a single case.**
      POSITIVE, shift 4302 (James Stewart, Aug 22): `equipment_required` `[]`,
      `supply_run_required` false, so the BAR IS THE ONLY REASON transport is required. The
      ack appeared. CONTROL, shift 10824 (Sep 4): no bar, no equipment, no supply run. **No
      ack appeared.** So the gate fires when it should and stays quiet when it should not, and
      no false positive is asking staff to acknowledge hauling that does not exist. A single
      positive would not have shown that.
      (3) **Cooler copy (brought EMPTY)** confirmed on the card and in the Field Guide kit list.
      **FIXTURE TRAP THAT COST TIME, and would cost the next walker the same.** The original
      script said to hit Request on shift 14. **You cannot: `marcus.j` (user 5) already holds
      an `approved` shift_request on 13, 14 AND 15**, so there is nothing left to request and
      the sheet never offers the ack. That reads as a missing-ack defect and is not one. The
      other shifts the script implies (4, 12, 19) are PAST events, so they are absent from the
      open feed entirely — the feed is upcoming-only, and on dev it holds 9 future open shifts
      of which 8 are available to Marcus.
      **USE THESE INSTEAD, both future, both un-requested:** 4302 (James Stewart, bar-only,
      the clean positive) and 10824 (the control). For the HOSTED branch of the rule rather
      than the paid-rental branch, 4306 (Madelyn Brandt) or 4307 (Julia Neave) are `per_guest`
      AND carry a supply run, so their transport line should list multiple reasons with the
      bar first.
      **HOSTED ACKNOWLEDGMENT ALSO WALKED 2026-08-21 (Zul), shift 4306 (Madelyn Brandt), and
      it PASSES including the client/server agreement.** A hosted shift raises TWO INDEPENDENT
      acks, not one: the transport ack (gated on `transportRequired`) and the hosted ack
      ("I understand what a hosted event requires and I am ready for the supply work", gated
      on `isHosted`, `RequestSheet.js:127`). Confirmed: two checkboxes; the transport line
      named the BAR FIRST then the supply run (the deliberate ordering in `transportLine()`,
      bar leads as the heaviest haul); and **submit stayed DISABLED with only one ticked**,
      which is what proves they are two gates rather than one rendered twice. A staffer cannot
      claim a hosted bar shift having acknowledged only half of it.
      Both ticked, the submit SUCCEEDED. Verified in the dev DB, not taken on report:
      `shift_requests` id 18801, shift 4306, user 5, status `pending`, positions
      `["Bartender"]`. **No 400.** That is the exact drift `shifts.approval.js:63-69` warns
      about ("keep the two in agreement or the server 400s a request the sheet never gated"),
      and client and server agree.
      **STILL NOT WALKED, and dev cannot currently produce it:** the hosted branch of
      `bar_required` IN ISOLATION. Every `per_guest` shift in the visible feed ALSO carries a
      paid `bar_rental`, so either arm of the OR would set the flag; there is no
      hosted-with-zero-rental open shift to separate them. Needs a seeded fixture.
      **FIXTURE NOTE, so this walk does not poison the next one exactly as 13/14/15 did:**
      that submit left marcus.j holding a PENDING request on 4306, so **4306 is no longer a
      fresh test shift.** 4307 (Julia Neave) is the remaining un-requested hosted one.
      Original entry follows. **(built 2026-08-13, unseen).** On dev
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
- [~] **Marketing FUNCTIONAL walk: WALKED 2026-08-20 (Zul), REAL SEND PROVEN. Two checks
      remain structurally untestable on current data.**
      **THE SEND PATH IS PROVEN END TO END, and this was only the SECOND campaign send in this
      system's history.** Verified in prod, not taken on report: `email_sends` id 2,
      campaign 3, subject "Test", `client_id` 1507 (Zul's own client row,
      `zul@drbartender.com`), `sent_at` 2026-08-21 01:33:30Z, status **`delivered`**.
      Row 1 (2026-05-21) is still `sent` and never progressed, so **this is the first send
      ever to reach `delivered`** — the Resend delivery callback had never completed on this
      path before. The email genuinely arrived in an inbox.
      **NO REAL CLIENT WAS EMAILED.** There is no send-test feature (deferred with lane
      `mkt-compose-canvas`), and the only tag that exists is `corporate` at 9 REAL clients, so
      the entry's "send to a tiny audience" had nothing safe to point at. She targeted her own
      client row instead, which needs no cleanup.
      **TWO NUMBERS SHE FLAGGED, BOTH CORRECT BEHAVIOUR — do not re-raise:**
      (a) Contacts reads **434 emailable of 541**, not the 449 that merely HAVE an address.
      `MAILABLE_SQL` (`marketingAudience.js:42`) subtracts 12 rows with
      `communication_preferences->>'marketing_enabled' = 'false'`, 1 placeholder `.invalid`
      address, and 2 with `email_status='bad'`. 449 − 12 − 1 − 2 = 434, reproduced exactly.
      "Has an email" and "is emailable" are different questions.
      (b) The **past-corporate audience reads 7 while the corporate TAG reads 9.** Already a
      known recorded finding (this file's fix list, "the corporate audience reads 7 of 9,
      correctly, but its displayed rule hides why"). The arithmetic is right; the displayed
      rule omits the extra criterion. Rediscovering it is confirmation, not a new bug.
      **PROVEN:** contacts list, search and filters, the contact drawer with its held-back
      panel, the tag menu, the audience resolver, Compose's two steps with the count in the
      Recipients tab label, the preview drawer, the "Before you send" rail, the two-stage
      confirm, send pacing, and the delivered write-back.
      **ALSO PROVEN, the negative half of gate-fix 1:** after a CLEAN run, leaving
      `/marketing/compose` and returning shows **no** "Resuming campaign #N" banner. That is
      the pass. The positive half (banner DOES appear after a quota-stopped or partly-failed
      run) is still unproven and needs a deliberately failed send.
      **STRUCTURALLY UNTESTABLE ON CURRENT DATA, and this is a gap in the WALK SCRIPT rather
      than a defect:** the ">500 recipients" toast ("Send at most 500 at a time") cannot fire.
      `MAX_RECIPIENTS = 500` (`marketingSend.js:57`) but only **434** contacts are emailable,
      so the condition is unreachable until the list grows by 67. The all-suppressed toast
      ("Check the held-back panel") likewise needs an audience where every member is
      suppressed, which no current tag produces. Left open rather than ticked.
      Original entry follows. **all 3 phases live in prod; gates real
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
- [x] **Marketing RESTYLE visual walk: PASSED 2026-08-20 (Zul), in prod, daylight.**
      **VERDICT: everything looks good.** The section reads as the approved design.
      **THIS IS THE ENTRY THAT CLOSES THE 2026-08-14 DESIGN-FIDELITY INCIDENT.** That incident
      was a section shipping to prod with zero visual fidelity to an approved design, because
      every gate validated against its immediate upstream artifact and no human ever looked.
      Lane `mkt-restyle` fixed the code; this walk is the first time a person confirmed it.
      The loop is closed: design approved, built, and now SEEN.
      Walked against benchmark `docs/design-artifacts/2026-08-11-marketing-redesign.dc.html`
      at admin.drbartender.com, both skins, across the width breakpoints, including the two
      drawers, Compose's two steps, and the items the adherence review flagged.
      SCOPE NOTE, honestly stated: the verdict is a GLOBAL visual judgment, which is what this
      walk exists for and what no agent could produce. The individual sub-checks below were
      not itemised back one by one. The one that is an ACTION rather than an observation is
      the keyboard-Tab focus ring on the tabs (`15cc4df0` scoped the clipping scroll container
      to phones); if a future reader wants certainty specifically there, it is one Tab press.
      CORRECTED WHILE SETTING THIS UP: the entry's pointer said lane `mkt-moment-setup`
      (`7b099746`) was merged and NOT pushed, so the needs-setup card's absence was not a
      restyle finding. **That is stale, it shipped.** The card and the header's "N needs
      setup" segment are live in prod as of this walk.
      Original entry follows. **the whole section moved onto the approved
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
      `mkt-moment-setup` (`7b099746`). **CORRECTED 2026-08-21: this said "merged and NOT
      pushed", and it has shipped** — `git merge-base --is-ancestor 7b099746 origin/main`
      returns 0. So the card and the header segment ARE in prod and their absence WOULD be a
      finding. The sibling entry above had already caught the same staleness in its own copy
      of this pointer. Its Tier 6 entry is gone with the tier's emptying; the steps live in
      that entry above.
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

**REFILLED 2026-08-25 (evening) with the consult call bridge, see below.** Before that it read
EMPTY AGAIN as of 2026-08-25, and the round trip worked a second time: one item sat here
from the 2026-08-25 merge until that day's push made `21ec7993` an ancestor of `origin/main`;
it moved to Tier 3b by this tier's own rule, sha attached, nothing re-derived. That is twice now.

The first round trip was 2026-08-21. The tier filled on the evening of 2026-08-20 with six
merged-but-unpushed user-facing changes and emptied the moment the `9cccd3da..4ee51d00` push
landed: every one of their shas became an ancestor of `origin/main`, so they moved to Tier 3b
rather than being walked from here. They are the "2026-08-21 cohort" there.

**The mechanism that worked, worth reusing.** Each entry named its merge sha and the tier
carried the check rather than a marker:

    git merge-base --is-ancestor <sha> origin/main    # exit 0 = it is live

Nothing had to be remembered or re-derived at push time, and no "UNPUSHED" note had a chance
to rot. Do that again for the next thing that sits here.

- [ ] **Consult call bridge — the launch call. Merged 2026-08-25 as `fafa0d6f`, NOT yet pushed.**
      Live check, no marker to rot: `git merge-base --is-ancestor fafa0d6f origin/main` (exit 0 = pushed).
      **Unlike every other item in this tier, the push alone does NOT make this live.** It ships dark
      behind `CONSULT_CALL_ENABLED=false`, which Tier 4 below requires you to set BEFORE the push. So
      this does not graduate to Tier 3b on the push; it graduates when the walk below passes.

      The walk, which IS the launch gate: confirm the Cal.com event type's minimum booking notice
      allows a slot a few minutes out, lowering it for the test if not. Book a slot on your own
      Cal.com page with the 970 as the number. Expect the 312 to ring between 90 and 30 seconds
      before the slot; the briefing should speak your own name, the slot time, and the linked
      proposal's event date and guest count. Press 1. The 970 should ring showing the **1922**, with
      two-way audio. Then check the row:
      `SELECT status, answered_by, bridge_duration_sec, client_no_answer_at FROM consult_call_attempts ORDER BY id DESC LIMIT 1;`
      should read `connected / admin / >0 / NULL`. Cancel the test booking in Cal.com afterwards and
      delete the test client row by hand.

      **Worth trying while you are in there:** press 1 during the SECOND reading of the briefing. The
      automatic repeat sits outside the `<Gather>`, so digits are not collected during it and that
      press is lost. It is inherited from the shipped lead router AND from spec 4.5, so it is a
      cross-router change rather than a defect in this lane, but you should hear it once to decide
      whether it is worth fixing for both.

- [ ] **Events list requests hover** (lane events-requests-hover, merge sha `c792c321`).
      Live when `git merge-base --is-ancestor c792c321 origin/main` exits 0; move to Tier 3b then.
      Sibling of the staff hover walked earlier today. On /events, the Staffing column now has TWO
      hover targets: the ratio lists who is CONFIRMED, the "N requests" chip lists who APPLIED and
      for what, oldest request first. Verified headless in both skins with a seeded fixture, so the
      walk is for what a browser cannot judge.
      What to actually try: drag the pointer slowly from the ratio down onto the chip. The card
      should SWAP, not blink off and back on. That seam is the whole design of this lane, it broke
      twice on paper before it worked, and the machine can only tell me the geometry is right
      (computed rowGap 0px, seam 0px), not whether it FEELS right under a real hand.
      Also worth hitting: a row where an applicant ranked nothing shows a bare name with no role
      (6 such rows in prod). One click away, the shift drawer calls that same person "Any role".
      That inconsistency is a known open question, not a bug, and seeing it may decide it.
      A FULL roster still shows no chip and no applicants, by decision. Audited across all 87 live
      feed rows: the one genuinely full-with-applicants row renders neither.

## Tier 4 — gated: do these BEFORE the thing they gate

- [ ] **Consult call bridge: set two Render vars BEFORE the push that carries `fafa0d6f`.**
      `CONSULT_CALL_ENABLED=false` and `CONSULT_CALLER_ID=+12242221922`. The kill switch DEFAULTS ON,
      so a push without the first one starts a 60-second sweep dialling `ADMIN_PHONE` for real, on a
      feature no human has yet heard. This is the lead call bridge's own 2026-07-18 trap repeated
      verbatim, and it is the reason that one shipped dark. Also confirm `ADMIN_PHONE`, `VA_CELL`,
      `VOICE_CALLER_ID`, `VM_TEXT_DESTINATION` and `TWILIO_PHONE_NUMBER` are still set. After the
      deploy, the boot log must NOT show a `[consultCall]` caller-ID warning; if it does, the client
      leg would show Zul's 0082 instead of the 1922. Flip the switch on only when you are ready to
      run the Tier 6 launch call above.

- [x] **Stale-proposal sweep rollout — DONE 2026-08-21/22. Nothing owed.** Kept as the
      record, not as a task. Dry run first (116 candidates listed, zero writes, verified
      id-for-id against prod), then the flag cleared and the real run executed
      2026-08-21 21:39:51 to 21:41:33 UTC: **116 archived, 105 invoices voided, 26 pending
      messages deleted, 110 Stripe intents cancelled, 0 shifts reaped.** Every safety
      assertion held — nothing archived carried money, nothing archived had ever been
      signed (`accepted_at` null on all 116), proposal 600 untouched, no paid invoice
      voided. **Zero Stripe heal markers**, so no cancellation ever failed. Lost gained
      $58,540 on the first run, which is the correction Dallas approved, not a regression.
      As of 2026-08-22 09:12 UTC it has been in steady state 11.5 hours: 3 more archived
      on later ticks (119 total), 0 pending, 0 heal markers, 0 skip emails, and
      `scheduler_health` reads `last_status: ok` with `consecutive_failures: 0`.
      Spec: `superpowers/specs/2026-08-20-stale-proposal-sweep-design.md`.

- [ ] **Walk Test Package: verify it is NOT `is_active` in the PROD catalog. Gates the
      options-drawer ship (2026-08-14).** It is active in the dev DB, and the drawer (plus
      the already-live options panel) renders every active non-class package as a real card
      a client can read and now SWITCH to. One prod SQL check; deactivate if present.
- [ ] **Drink-plan preview across a hosted/BYOB switch. Gates the options-drawer ship
      (2026-08-14).** The switch endpoint writes nothing planner-side and the planner
      derives from the proposal row on load, but a proposal changing CATEGORY under an
      existing drink plan has never existed before. Walk: proposal with a drink plan,
      switch hosted-to-BYOB and back, open `/plan/:token` after each, confirm the preview
      re-derives sanely (submit.parking.test.js shows the fold preserving addon lines, but
      the flip case is unexercised).
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

**Start by checking this file against production, before reading a single entry.** The
status block names the sha it was written against. Anything shipped since then is live,
unwalked, and invisible here:

```
git log --format='%h %ad %s' --date=short <sha from the status block>..origin/main -- server client/src
```

If that returns anything, the tiers below are incomplete and the first job of the session
is to add the missing entries, not to walk something. This is not hypothetical: it is
exactly how a 7-lane admin section and a set of live voice changes reached production on
2026-08-20 with no entry in the one file that is supposed to track them. Nothing in the
pipeline writes here automatically, so the gap opens silently every time.

Then work top-down. Tier 1 is where being wrong costs money, and Tier 4 items are gates —
doing the gated thing first is how the fence charges derive from unreviewed recipes.

When you finish one, tick it and delete it. When a walk finds a defect, the defect goes to
the fix list, not here. This file should shrink.

**Two rules this file keeps re-learning the hard way:**
- **Never write a relative time** ("tonight", "today", "five days now"). It is wrong the
  next morning. Date-stamp everything.
- **Never write a push-state verdict** ("merged but NOT pushed"). It is wrong at the next
  push and it makes an available walk read as blocked. Write the check instead:
  `git merge-base --is-ancestor <sha> origin/main`.

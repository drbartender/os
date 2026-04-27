# Tester Program v2 — Design Spec

**Date:** 2026-04-27 (revised after refactor + Stripe-live deadline)
**Status:** Approved design. Phase 1 plan at `docs/superpowers/plans/2026-04-27-tester-program-v2-phase1.md`. Phase 2 (full vision) plan at `docs/superpowers/plans/2026-04-27-tester-program-v2.md` — held for after Phase 1 is in tester hands.
**Replaces:** `TESTING.md` (linear Parts 1–7 narrative + page-by-page appendix) and the email-based feedback loop in `server/routes/testFeedback.js`

## Phase split

Phase 1 ships before the Stripe live cutover. Phase 2 expands the catalog and adds drift / fix tooling once the system is proven valuable.

| Phase | Includes | Defers |
|---|---|---|
| **1 (now)** | Landing + 3-question quiz + adaptive picker + mission page + bug-log JSONL + `bugs:list` script + 12 hand-written missions + ONE seed recipe (`proposal-in-sent`) + `@labrat.test` email-pattern tagging | `is_test_data` schema column, auto-advance, drift detection, `/labrat-fix` skill, cleanup scheduler, remaining seed recipes |
| **2 (later)** | Remaining ~18 missions, additional seed recipes, drift detection (`missions:check` / `:verify` / `:scan-routes`), `/labrat-fix` skill, automated cleanup, optional auto-advance | — |

In Phase 1, test data is tagged via the email pattern `@labrat.test` (every seeded client gets a `labrat-<random>@labrat.test` address). Cleanup is a manual SQL command run before the Stripe live cutover (`DELETE FROM clients WHERE email LIKE '%@labrat.test'` plus cascade). No schema migration. No filtering surgery on admin LIST endpoints. Phase 2 may upgrade to the `is_test_data` flag if the email pattern proves insufficient.

For Phase 1 missions that need pre-existing state (sign-and-pay-deposit, etc.), the system uses the single seed recipe `proposal-in-sent`. Other money missions either use the seed or bundle "wear both hats" instructions that walk the tester through admin login + setup before the customer-side test.

---

## Problem

The current tester guide is wicked out of date and structurally broken for the actual tester audience.

**Content rot.** The recent `/admin` and `/portal` URL prefix removal (commit `f13ef5c`) invalidated dozens of paths in `TESTING.md`. New surface area (email marketing, blog, classes, invoices, hosted-bartender pricing rule) isn't covered. Removed flows are still in the doc.

**Funnel collapse.** Today's guide is a linear 931-line story arc. Every tester starts at Part 1. Most stall out at Part 2 (proposal create) because the next step requires Dallas (admin) to send the proposal. The exhaustive page-by-page appendix at the bottom gets zero clicks.

**Wrong audience model.** The guide assumes one disciplined tester wearing two hats. Actual testers are friends and friends-of-friends recruited via Facebook. They:
- Won't read instructions carefully
- Don't have admin context
- Have variable time budgets (5 minutes to an hour)
- Won't coordinate with each other

**Lossy bug pipeline.** Bugs come in by email. Dallas re-types them, brings them into a Claude session, asks for help. The original report and the eventual fix are not linked.

---

## Goals

1. **Any visitor can start contributing in <60 seconds.** Click Facebook link → land → pick something → start clicking.
2. **Every mission is independently startable.** No tester gets stuck waiting on Dallas to do an admin step.
3. **Coverage spreads naturally across the app.** Two testers with identical quiz answers should get different missions so the same five flows don't get re-tested while the rest go untouched.
4. **Bugs land in a Claude-readable file** that Dallas can reference at fix time without re-typing.
5. **Admin-curious testers have a real path** — admin missions are first-class, not buried.

---

## Non-goals (v1)

- Tester accounts or login
- Email-based tester recruitment
- Auto-detection of mission staleness when the app changes
- A separate admin UI for triaging bugs (Dallas accesses bugs via Claude Code in the existing dev workflow)
- Internationalization
- Public coverage dashboards

---

## Architecture

### High-level flow

```
Facebook click
  ↓
GET /labrat                       (landing page — first-name capture, optional)
  ↓
Tester picks: [Take quick quiz]   OR   [Show me everything]
  ↓
GET /labrat/quiz                    (3 questions)         GET /labrat/missions
  ↓                                                       ↓
POST /api/qa/shortlist            ─────────────────────→ same picker UI
  (server returns 6 cards weighted by priority + least-completed)
  ↓
GET /labrat/m/:missionId            (mission page — steps + per-step bug button)
  ↓
For missions with seedRecipe:
  POST /api/qa/seed               (server creates fake test data, returns token + URL)
  ↓
Tester completes steps, optionally reports bugs
  ↓
POST /api/qa/complete             (logs to mission-completions.jsonl)
POST /api/test-feedback           (logs to tester-bugs JSONL — endpoint URL kept, internals replaced)
  ↓
"Done — next mission?" → back to picker
```

Bug log access (out of band):
```
Dallas in Claude session: "show me open tester bugs"
  → Claude Reads server/data/tester-bugs/*.jsonl
  → projects current state via tester-bugs/status.json
  → presents grouped by mission
Optional: `npm run bugs:list` prints same view to terminal
```

### Server-side data model

All tester program state lives in flat files under `server/data/`. No new database tables.

```
server/data/
├── tester-bugs/
│   ├── 2026-04.jsonl              (append-only; one bug per line)
│   ├── 2026-05.jsonl
│   └── status.json                (bug-id → {status, fixCommitSha, adminNotes, fixedAt})
├── mission-completions.jsonl      (append-only; one completion per line)
└── qa-seed-registry.jsonl         (append-only; tracks seeded test records for cleanup)
```

Each `tester-bugs/YYYY-MM.jsonl` line:
```json
{
  "id": "bug_2026-04-27T15:32:11_x7k3",
  "kind": "bug",
  "missionId": "submit-byob-quote",
  "stepIndex": 3,
  "testerName": "Jordan",
  "testerEmail": null,
  "where": "Quote wizard step 4 — extras",
  "didWhat": "Checked Bar Rental and one syrup",
  "happened": "Total didn't update — stayed at $400",
  "expected": "Total should reflect the add-ons",
  "browser": "Chrome 142 macOS",
  "screenshotUrl": null,
  "reportedAt": "2026-04-27T15:32:11.412Z"
}
```

`kind` is one of `"bug"` (per-step bug button), `"confusion"` (the "I'm stuck" button — same shape, different intent), or `"mission-stale"` (the "this mission seems wrong" button on the mission page).

`status.json`:
```json
{
  "bug_2026-04-27T15:32:11_x7k3": {
    "status": "fixed",
    "fixCommitSha": "abc1234",
    "adminNotes": "Pricing recompute was missing on syrup toggle",
    "fixedAt": "2026-04-27T18:01:00Z"
  }
}
```

Bugs without a status entry are implicitly `"open"`.

### Mission catalog

Missions are JS data files in `server/data/missions/` — one file per area for readability:

```
server/data/missions/
├── index.js              (re-exports + freezes the full catalog)
├── customer.js           (booking, proposals, drink plan, client portal, invoices)
├── applicant.js          (apply, status, decline path)
├── staff.js              (onboarding, portal, shifts)
├── admin.js              (every admin dashboard + workflow)
├── mobile.js             (mobile-only spot-checks)
└── edge.js               (error paths, declined cards, expired tokens, empty states)
```

Mission record shape:
```js
{
  id: 'submit-byob-quote',
  title: 'Submit a fake event quote',
  blurb: 'Pretend you are hiring us for your wedding. Fill out the quote wizard.',
  area: 'customer',                  // customer | applicant | staff | admin | mobile | edge
  estMinutes: 10,
  difficulty: 'easy',                // easy | medium | hard
  device: ['desktop', 'mobile'],     // which devices the mission is valid on
  needsAdminComfort: false,          // gates behind quiz Q3
  priority: 'p0',                    // p0 | p1 | p2 — sort hint, not visible to tester
  seedRecipe: null,                  // null OR identifier handled by /api/qa/seed
  preconditions: [],                 // human-readable text shown above steps if any
  steps: [
    { text: 'Go to drbartender.com/quote', expect: 'Wizard loads on Step 1.' },
    { text: 'Enter Guest count 50, Duration 4 hours, etc.', expect: 'Pricing preview updates.' },
    // ...
  ],
  successMessage: 'Thanks — that flow is one of our most important.',
  affectedFiles: [                   // for drift detection (see Drift Resistance section)
    'client/src/pages/website/QuoteWizard.js',
    'server/routes/proposals.js'
  ],
  lastVerified: '2026-04-27'         // bumped via `npm run missions:verify <id>`
}
```

Target catalog size: **~30 missions** distributed roughly:

| Area | Count | Example missions |
|---|---|---|
| Customer (public) | 8 | Submit BYOB quote, Submit hosted quote, Sign + pay deposit, Pay balance, Decline-card path, Drink plan exploration, Client portal OTP login, View invoice |
| Applicant | 3 | Apply (full submission), Apply (validation errors), Reject path |
| Staff | 4 | Field guide + agreement, Contractor profile + W-9, Request a shift, Cancel a request |
| Admin | 10 | Send a proposal, Record cash payment, Generate payment link, Charge balance via autopay, Approve onboarding, Approve shift request, Manual assign, Auto-assign preview, Add a blog post, Email marketing draft (DO NOT SEND) |
| Mobile | 3 | Mobile homepage + quote, Mobile signature, Mobile staff portal |
| Edge | 2 | Expired proposal token, 404 unknown blog slug |

The exact list is built during implementation; this table is the planning target.

### Adaptive shortlist routing (Phase 1)

The shortlist endpoint is the brain of the hybrid scheme. It surfaces the right missions for a given tester at a given moment based on three signals: (a) the tester's quiz answers and per-session history, (b) global completion coverage per mission, (c) open-bug saturation per mission.

**Algorithm:**

```
input: { areas, timeBudget, adminComfort, device, completedIds }

// 1. Hard filters
candidates = catalog.all
  .filter(m => areas.includes(m.area))
  .filter(m => m.estMinutes <= timeBudget)
  .filter(m => m.device.includes(device))
  .filter(m => !m.needsAdminComfort || adminComfort !== 'skip')
  .filter(m => !completedIds.includes(m.id))
  .filter(m => openBugCount(m.id) < 2)            // bug-saturation pause

// 2. Determine the tester's effective tier
allP0InCatalog = catalog.all.filter(m => m.priority === 'p0')
allP0Saturated = allP0InCatalog.every(m => completionCount(m.id) >= 3)
testerHasUncompletedP0 = candidates.some(m => m.priority === 'p0')

if (testerHasUncompletedP0 && !allP0Saturated)       primaryTiers = ['p0']
else if (testerHasUncompletedP0 && allP0Saturated)   primaryTiers = ['p0', 'p1']
else if (candidates.some(m => m.priority === 'p1'))  primaryTiers = ['p1', 'p2']
else                                                  primaryTiers = ['p2']

// 3. Sort and slice
result = candidates
  .filter(m => primaryTiers.includes(m.priority))
  .sort(by priority asc, completionCount asc, random tiebreak)
  .slice(0, 6)

// 4. Fallback if too sparse
if (result.length < 3) widen timeBudget by 50% and retry; mark relaxed=true
```

**Why this works:**

- A *new tester* on Saturday afternoon when p0 is undercovered: sees only p0 missions, sorted toward least-tested. Maximum coverage on money paths fast.
- *Returning tester* (Dallas, his assistant): once they personally complete every p0, they automatically graduate to p1 then p2. They keep finding fresh work each visit.
- *Crowd graduation*: once every p0 mission has 3+ completions globally, the system promotes p1 missions into rotation for new testers too — no manual config change.
- *Bug-saturation pause*: if a mission has 2+ open bugs, it disappears from shortlists until Dallas marks bugs fixed via `bugs:fix`. No point flooding a known-broken flow with dupe reports. Threshold is 2 (one bug = could be a fluke; two = pattern).

The `completionCount` and `openBugCount` projections are computed at request time from `mission-completions.jsonl` and the bug-log status sidecar respectively. Cheap at expected volume; cache later if needed.

### Quiz + shortlist routing

Quiz UI is purely client-side. Answers serialize to query params on `POST /api/qa/shortlist`:

```
POST /api/qa/shortlist
Body: {
  areas: ['customer', 'mobile'],   // Q1 multi-select
  timeBudget: 15,                   // Q2 max minutes
  adminComfort: 'skip',             // Q3 if surfaced
  device: 'mobile',                 // detected from UA
  completedIds: ['submit-byob-quote', 'view-invoice']  // from localStorage
}
Response: {
  missions: [ /* up to 6 mission records, in display order */ ]
}
```

Server filtering and sorting follow the algorithm in the "Adaptive shortlist routing (Phase 1)" section above. The endpoint contract is just the request/response shape shown here.

### Pre-seeded data + auto-advance

Two mechanisms, used together:

**Per-mission seed recipes.** Missions that need pre-existing state (e.g., "sign and pay a proposal that's already in `Sent` state") set a `seedRecipe` value. When the tester opens such a mission, the client calls `POST /api/qa/seed` with the recipe id. The endpoint:

1. Creates the required test records (e.g., a fake client + a proposal already advanced to `Sent`)
2. Tags every created row with `is_test_data = true` (new column added to `clients`, `proposals`, `drink_plans`, `users`, `applications`)
3. Logs the created row IDs to `qa-seed-registry.jsonl` for cleanup
4. Returns the public URL/token the tester needs

Recipe identifiers (initial set): `proposal-in-sent`, `proposal-paid-deposit-with-autopay`, `proposal-paid-in-full`, `application-submitted`, `staff-fully-onboarded`, `drink-plan-pending-review`.

**Nightly cleanup.** A scheduled job (`server/utils/qaCleanupScheduler.js`) deletes `is_test_data = true` rows older than 7 days. Runs at 3 AM via the existing scheduler infrastructure.

**Auto-advance for the proposal-send chokepoint.** When a quote wizard submission carries `?qa=auto-advance` in the URL, the server immediately runs the admin "send" step internally (sets status to `Sent`, fires the proposal email) without requiring an admin user. This is the single biggest unblocker for unsupervised customer-flow testing — the entire current dropoff at "create a proposal then nothing happens" disappears.

The flag is only honored when the request originates from a `/labrat/m/...` mission flow (server checks Referer + a signed token planted in localStorage by the landing page) so it can't be exploited from the open quote form.

### Bug reporting

Reuse the existing `/api/test-feedback` URL but rewrite the internals:

**Before:** validates payload, sends email to `contact@drbartender.com`, returns `{ ok: true }`.

**After:** validates payload (same shape with new `missionId` and `stepIndex` fields), generates an id, appends a line to `server/data/tester-bugs/YYYY-MM.jsonl`, returns `{ ok: true, id }`. No email.

The "I'm stuck" confusion form posts the same shape with `kind: "confusion"` and a single free-text `happened` field.

Concurrent writes are safe because each report is one append of one line; Node `fs.promises.appendFile` is atomic for sub-PIPE_BUF writes (each line is well under 4 KB).

### Bug log access for Dallas/Claude

Two entry points:

**Direct Read.** Dallas opens a Claude Code session and asks for open bugs. Claude reads the JSONL files in `server/data/tester-bugs/`, joins against `status.json`, presents bugs grouped by mission with their reportedAt timestamps. No code change needed beyond the files existing.

**Terminal command.** `npm run bugs:list` runs a small script that does the same projection and pretty-prints to stdout. Optional `--mission=<id>` and `--status=<status>` flags. Available for when Dallas wants a quick scan without spinning up Claude.

`npm run bugs:fix <bug-id> <commit-sha>` updates `status.json` to mark a bug fixed and records the commit. Optional but useful for closing the loop.

---

## UI surfaces

### Landing — `GET /labrat`

Single page. Above-the-fold hero with one paragraph and two CTAs.

```
Be a Lab Rat
Dr. Bartender is about to launch. Pick a mission, click around,
tell us what's broken. Five to sixty minutes — your call.
Nothing you do here reaches real customers.

[ First name (optional) ___________ ]

[ Take a quick quiz → ]    [ Show me the missions ]
```

First-name input writes to localStorage. Empty is fine.

### Quiz — `GET /labrat/quiz`

Three sequential card-style screens. "Back" button on Q2 and Q3.

**Q1 — multi-select chips:**
> What sounds fun, lab rat?
> [ Booking an event as a customer ]
> [ Applying to be a bartender ]
> [ Poking around the admin tools ]
> [ Mobile testing on my phone ]
> [ Surprise me / whatever needs help most ]

**Q2 — single-select:**
> How much time do you have?
> ◯ Just a few minutes
> ◯ 15–20 minutes
> ◯ 30–60 minutes
> ◯ I am in for the long haul

**Q3 — conditional, only if Q1 includes admin or surprise:**
> Comfortable with admin / back-office tools?
> ◯ Yes, throw me in
> ◯ Walk me through it
> ◯ Skip admin stuff

Submit posts to `/api/qa/shortlist`, redirects to `/labrat/missions?from=quiz`.

### Mission picker — `GET /labrat/missions`

Grid of cards. Toggle at the top: **Group by area** (default) | **Group by time**.

Each card:
```
┌───────────────────────────────┐
│ 🥃  Submit a fake event quote │
│                                │
│ Pretend you are hiring us for  │
│ your wedding. Fill out the     │
│ quote wizard.                  │
│                                │
│ ⏱ ~10 min  ●  easy  ✓ done    │
│                  [ Start →  ]  │
└───────────────────────────────┘
```

The `✓ done` chip appears for missions in localStorage `completedIds`.

If the tester arrived from the quiz, the page header reads "Six missions picked for you. Show all instead." with a link to drop the filters.

### Mission page — `GET /labrat/m/:missionId`

```
Mission: Submit a fake event quote               ⏱ ~10 min · easy

What we are testing
The quote wizard end-to-end. We need to know that pricing matches and
the proposal email arrives.

Setup (auto)                                   ← only if seedRecipe set
We made you a fake proposal in Sent state.
[ Open the proposal → ] (token: abc123)

Steps
☐ 1. Go to drbartender.com/quote                     [ report bug ]
☐ 2. Fill in event details (any values you want)     [ report bug ]
☐ 3. ...                                              [ report bug ]

[ I am stuck — get help ]                  [ Done → next mission ]
```

The bug button per step opens the existing `bug-dialog`, prefilled with the step text. The "Done" button posts `/api/qa/complete`, marks the mission in localStorage `completedIds`, and redirects back to the picker.

### Reused HTML/JS shell

The current `scripts/testing-guide-template.html` shell is salvaged for:
- Checkbox state + progress bar styling
- Bug dialog markup and submit logic (rewired to per-mission-step)
- Print and mobile media queries
- Reset / Export buttons (Reset clears localStorage; Export remains available for testers who want a personal record)

The build pipeline changes from `marked → single HTML page` to a small React/server-rendered surface that pulls missions from `server/data/missions/`. Specific approach (Express EJS templates vs. a tiny React route under `client/src/pages/labrat/`) is an implementation detail to settle in the plan.

---

## What we drop

| Drop | Reason |
|---|---|
| Linear Parts 1–7 narrative | Funnel-collapses; doesn't survive the friends/family audience |
| Exhaustive page-by-page appendix | Zero clicks today; replaced by mission catalog |
| Email send-back to `contact@drbartender.com` | Dallas no longer wants to receive emails; bugs go to file |
| Two-window admin coordination as a default | Pre-seeding + auto-advance remove the need for most missions |
| `TESTING.md` as the source of truth | Replaced by `server/data/missions/*.js` |
| Send-feedback dialog asking for tester name + email modal | Identity captured once on landing instead |

---

## What we keep

- The `/api/test-feedback` endpoint URL (internals replaced)
- The bug dialog DOM + CSS from `testing-guide-template.html`
- The Stripe test card guidance and "wipe before launch" framing
- The admin login (`admin@drbartender.com / DrBartender2024!`) for admin missions

---

## Drift resistance

The whole reason `TESTING.md` decayed is that it was a static document with no signal when the underlying app changed. Lab Rat ships with four mechanisms to keep the catalog from rotting the same way.

### 1. Per-mission `affectedFiles` + `lastVerified`

Every mission declares the files it exercises and the date it was last manually verified. Both are part of the mission record (see Mission Catalog above).

### 2. `npm run missions:check` — automated drift detection

Script at `server/scripts/missionsCheck.js`. For each mission, runs `git log --since=<lastVerified> -- <affectedFiles>`. Any mission whose declared files were modified after its verified date is flagged as stale. Output:

```
12 missions, 3 stale:
  ⚠ submit-byob-quote — verified 2026-04-27, but QuoteWizard.js modified 2026-05-03
  ⚠ sign-and-pay-deposit — verified 2026-04-27, but ProposalView.js modified 2026-05-04
  ⚠ approve-onboarding — verified 2026-04-27, but admin/HiringDashboard.js modified 2026-05-05
```

Wired into the pre-push checklist as a non-blocking warning (per CLAUDE.md Rule 6 doesn't change — staleness is informational, not a blocker).

### 3. `npm run missions:verify <id>` — bump after re-test

One-line script that updates `lastVerified` to today for the named mission. Used after Dallas (or a tester) re-runs a flagged mission and confirms it still works.

### 4. Tester-facing "report this mission as wrong" button

Each mission page has a small "this mission seems wrong" link in the footer. Click → same bug dialog with `kind: 'mission-stale'`. Crowd signal beats automated signal — testers catch broken steps faster than git diffs do.

### Bonus: `npm run missions:scan-routes` — discovery for new features

Walks `client/src/App.js` (React routes) and `server/index.js` (API mounts), lists any route that no mission's `affectedFiles` references. Discovery aid for "we shipped a feature with no test."

### CLAUDE.md workflow rule (added)

Add a new bullet under "Mandatory Documentation Updates":
> When modifying any file, grep `server/data/missions/` for that path. Update or stamp the affected missions. `npm run missions:check` will warn at pre-push if you don't.

---

## Bug-fix workflow skill

A new skill at `.claude/skills/labrat-fix.md` formalizes the bug-triage-and-fix loop so Dallas can run it from any Claude session with one invocation (`/labrat-fix` or "fix labrat bugs"). The skill:

1. Reads `server/data/tester-bugs/*.jsonl` and `status.json`, projects current open-bug state.
2. Groups bugs by mission (or by area on request), shows counts and severity hints.
3. Proposes a batching strategy ("12 open bugs across 7 missions — fix the 4 quote-wizard bugs first, then the 3 admin bugs?").
4. Per batch: investigates root cause, proposes fix, implements, runs `missions:check` to confirm related missions, asks Dallas to re-verify the affected missions, then bumps `lastVerified` and updates `status.json` with the fix commit SHA.
5. Optionally proposes new mission steps when a bug exposes uncovered behavior.

The skill closes the loop: bug → fix → mission re-verify → catalog stays fresh. Implementation is just a Markdown skill file with instructions; no code, no separate runtime.

---

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `is_test_data` column added to user-facing tables creates query surprises | Medium | Default to `false`. All public read endpoints add `WHERE is_test_data = false`. Document on each table. |
| Auto-advance flag exploited from the open quote form | Low | Server requires both Referer matching `/labrat/m/...` and a signed token planted in localStorage at landing. Token TTL 24 h. |
| JSONL file grows unbounded | Low | One file per month + nightly cron archives files older than 90 days into a `tester-bugs/archive/` subfolder. |
| Mission catalog drifts out of date as the app changes | High | Each mission file gets a top-of-file `// LAST VERIFIED: 2026-04-27` comment. The pre-push checklist in CLAUDE.md gets a new line: "If you changed a feature listed in `server/data/missions/`, update or stamp the affected mission." |
| Friend tester reports the same bug 4 times | Medium | Status sidecar lets Dallas mark status `duplicate` with a pointer; `npm run bugs:list` collapses duplicates. |
| Concurrent JSONL writes from multiple testers corrupt the file | Low | Each write is a single `appendFile` of a sub-PIPE_BUF line. Tested under concurrency in implementation. |

---

## Open implementation questions (deferred to plan)

- Do mission pages render server-side from Express + a templating engine, or as a small React surface inside the existing CRA app under `client/src/pages/labrat/`? (Probably the latter for consistency with the codebase, but it adds bundle weight.)
- Should the shortlist endpoint cache the completion-count projection in memory between requests, or recompute on every call? (Recompute is fine until measured otherwise.)
- Where does the landing-page first-name + signed token live? (Likely two `localStorage` keys + one HTTP-only cookie carrying the signed token, mirroring the existing `drb-qa-tester-name` pattern.)

---

## Out of scope

- Replacing the existing `npm run build:testing-guide` pipeline that emits `client/public/testing-guide.html`. That artifact stays available as a static legacy fallback at `/testing-guide.html` until v2 is in tester hands, then removed in a follow-up.
- Tracking which testers reported which bugs over multiple sessions (no tester accounts).
- Slack / Discord notifications when bugs land.

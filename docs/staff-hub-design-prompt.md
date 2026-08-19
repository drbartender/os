# Design prompt: the Admin Staff hub

> Per-surface prompt for a claude.ai/design session. Precedents in this repo:
> the marketing redesign (`docs/design-artifacts/2026-08-11-marketing-redesign.dc.html`)
> and the phone admin shell (`...2026-08-14-mobile-admin-shell.dc.html`). Read
> `DR_BARTENDER_REDESIGN_BRIEF.md` §2 hard rules first. The information
> architecture below is SETTLED and is not yours to relitigate. The visual
> system, the hierarchy between two levels of navigation, and the empty-state
> behavior are the whole job.

## What this is

The Admin OS sidebar has accumulated four separate entries that are all "the
people who work for me": Staff, Hiring, Tips & Feedback, Reviews. Payroll is a
fifth people-surface with no sidebar entry at all, reachable only from the
Overview card and a staffer's Payouts tab. They collapse into one entry, Staff,
which opens a hub.

## Who uses this and for what

One operator (owner-bartender, also works shifts himself) plus one assistant
with a manager role. Not a SaaS audience, not a wallboard. The roster is what
he wants to see when he clicks Staff. Everything else in the hub is periodic
work: a weekly pay run, an occasional hiring push, a five-star review to credit.

## Settled IA (law for this session)

One sidebar entry, **Staff**. Four children:

| Child | Route | Internal structure |
|---|---|---|
| **Roster** (lands) | `/staffing` | Active / All switch, then a table |
| **Hiring** | `/staffing/hiring` | 3-column kanban: Applied, Interview, Onboarding |
| **Payroll** | `/staffing/payroll` | Pay run, History, Tips, 1099 / tax |
| **Reviews** | `/staffing/reviews` | Review log, Leaderboard |

Decisions already made, with reasons, so you do not re-open them:

- **Roster lands.** Clicking Staff shows the staff list, never a hub overview.
- **Tips folded into Payroll.** A global cross-staff tip ledger was the odd one
  out: tips are per-bartender (each contractor has their own tip page and token)
  and the money accrues into that person's payout. Payroll's Tips tab now holds
  the activity ledger plus the existing unassigned and deferred repair queues.
  One tips surface, not two a click apart.
- **Feedback leaves the hub.** `tip_page_feedback` is a rating and comment about
  one bartender from that bartender's thank-you page. It is per-person, and the
  server already emails the operator on every submission. It moves to the
  staffer profile beside the existing Tip Page tab and is out of scope here.
- **Reviews keeps a child.** It is the one genuinely cross-staff surface:
  read a review, decide who it names, credit them, and a quarterly leaderboard
  contest across the team. It is also a real payroll input, not a log. Confirming
  a review writes a `payout_duty_lines` row of $10 (`kind='review_bounty'`) and
  the contest writes `review_contest`, both landing in the current pay run.

Old routes `/hiring`, `/tips`, `/reviews`, `/financials/payroll` become
param-preserving redirects. The Overview payroll card deep-links with
`?tab=payrun&period=<id>` and must keep working.

## The actual design problem

**Two levels of navigation, rendered today with the same control.** The
marketing hub uses `.seg` (a segmented control) for its four sections. List
pages use `.seg` again, via the shared `Toolbar` component, for their internal
tabs. Stack those and the Staff hub shows two visually identical segmented
strips: Roster/Hiring/Payroll/Reviews, and directly under it Active/All.

Compounding it, the four children are wildly uneven. Payroll has four internal
tabs and holds real money. Hiring is a kanban with no tabs. Roster is a table
with a binary switch. Reviews has two tabs and, right now, one row.

There is also no shared tab vocabulary to inherit. Three treatments exist in the
code today: `.seg` (Toolbar and marketing), legacy `.tab-nav`/`.tab-btn` (only
the pre-redesign AdminDashboard, still on retired amber tokens), and hand-rolled
inline-styled buttons in the current Tips and Reviews pages. The hub is the
moment to settle one. What you define becomes the pattern.

Take a real position on how a section rail, breadcrumb, sub-nav, or something
else makes "which level am I on" obvious without a filing-cabinet feeling.

## Real production data (2026-08-19) for grounding mocks

Use these. Do not invent a busier business than this one.

- **Roster:** 18 active (16 staff, 2 admin), 14 deactivated. Some deactivated
  rows are legacy CheckCherry import stubs and render a "Legacy CC stub" badge.
- **Hiring:** Applied 1, Interview 1, Onboarding 40. The board is badly
  lopsided, and 29 of those 40 are May 2026 CheckCherry import artifacts that
  have sat untouched for three months. See "content problems" below.
- **Payroll:** weekly periods, Monday to Sunday, payday Tuesday. Most recent
  paid period 2026-08-11 to 08-17, paid 08-18. All-time: 27 paid payouts across
  12 contractors totaling $4,485.21, plus 5 owner `no_draw` payouts totaling
  $1,130.35 (the owner works shifts and accrues, but takes no draw).
- **Tips:** exactly one tip in production, $6.00 on 2026-08-16. Tip signs went
  live 2026-08-11 and there have been three shifts since, all on one event day.
- **Reviews:** exactly one review, logged 2026-08-17, five stars, Thumbtack
  source, status `pending`, excerpt "It was a wonderful experience! Shea was so
  professional and prompt!". Zero bounties have ever been credited. Bounty is
  $10 flat.

**This makes empty and near-empty states the primary design case, not the
edge case.** A Reviews tab holding one pending row and a Tips ledger holding one
$6 line have to look deliberate and inviting, not broken or abandoned. Then show
the same layouts under a busy fall season so both ends hold.

## Token and component law (hard)

- **Design system:** the Dr. Bartender OS Design System project
  `72035042-c993-47e2-9dc8-c452b7bf5fa4`, admin family (`components-admin.css`,
  `tokens/*`). Vendored in this repo at `docs/design-artifacts/_ds/`.
- **Existing admin vocabulary to compose with, not replace:** `.page`,
  `.page-header`, `.page-title`, `.page-subtitle`, `.page-actions`, `.card`,
  `.card-head`, `.card-body`, `.tbl`, `.tbl-wrap`, `.stat-row`, `.stat`,
  `.chip`, `.chip-dot`, `.seg`, `.btn` family, `.avatar`, `.hstack`, `.vstack`,
  `.muted`, `.tiny`, `.mono`, `.k`, `.kebab-menu`, `.drawer` family, `.nav-item`,
  `.nav-badge`. Preserve these names. New classes are welcome for genuinely new
  structure (the hub chrome), namespaced clearly.
- **Both skins must hold:** House Lights (light) and After Hours (dark), toggled
  by `[data-app="admin-os"][data-skin]`. Both breakpoints. Wide tables scroll in
  their own container, never the page.
- Vanilla CSS destined for `client/src/index.css`. No Tailwind, no CSS modules,
  no new dependencies.
- **No em dashes in any copy.** Commas or colons.

## Known content problems to solve

1. **The Onboarding column has 40 cards and 29 are dead import rows.** The
   kanban currently renders them all as live pipeline. Decide how the board
   distinguishes real candidates from imported history: a filter, a collapsed
   group, an age treatment, or something better. This is the single worst
   content problem in the hub and it is real, not hypothetical.
2. **Roster tabs are Active and All, and All silently includes deactivated
   legacy stubs** whose emails are redacted for managers. "All" is doing two
   jobs. Consider whether the switch should name what it actually shows.
3. **Payroll's Tips tab now carries three things** (activity ledger, unassigned,
   deferred) that were designed separately and have never shared a screen.
4. **The sidebar badge needs a home.** `new_applications` currently badges the
   Hiring entry, which is disappearing. Decide how a hub-level badge on Staff
   communicates which child needs attention, given Payroll and Reviews may
   eventually want badges too.

## Open questions to take a position on

1. Does the hub carry any shared chrome above the child nav (a roster count, the
   open pay period, a needs-attention line), or is the child's own page header
   the only header?
2. Does Payroll's four-tab strip survive as a third level, or do its tabs get
   promoted to the hub level, giving seven flatter children instead of four
   nested ones?
3. Reviews at one row: does it earn a full tab today, or does it present as a
   compact panel that grows into a tab? Argue from the design, not the count.

## Definition of done

- Artboards for: Roster (populated and empty), Hiring (with the 40-card
  Onboarding problem visible and solved), Payroll pay run, Payroll tips,
  Reviews (one-row state and a populated state), plus the sidebar showing the
  collapsed entry.
- Both skins on at least the Roster and Payroll artboards.
- The two-level navigation pattern specified well enough to become a reusable
  component, since Marketing will adopt it next.
- Mock content uses the real numbers above.

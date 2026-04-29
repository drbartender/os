# Hiring Pipeline Redesign

**Date:** 2026-04-28
**Surfaces affected:** `HiringDashboard.js` (deferred surface #5), `AdminApplicationDetail.js` (deferred surface #4), `Application.js` (form), schema, server routes
**Source designs:** `Dr Bartender (3)/admin-os/pages.jsx` (HiringPage), `Dr Bartender (3)/admin-os/application-detail.jsx`
**Predecessor doc:** `docs/superpowers/plans/2026-04-25-admin-ui-revamp-deferred-surfaces.md`

## Summary

Replace the legacy two-tab table in `HiringDashboard.js` and the legacy `AdminApplicationDetail.js` with admin-os-vocabulary surfaces, while bringing the data model in line with how Dallas actually hires. The handoff design is the starting point but several pieces are dropped or simplified to match the real flow:

- The five-stage pipeline collapses to four — there is no "Hired" column.
- Interviews are scheduled inside the app; the Interview column visibly splits scheduled vs unscheduled.
- Onboarding completes itself — no manual "Activate" gate.
- The Open Roles strip, both bottom cards, structured work history, configurable layouts, the demo picker, and the references table are all dropped as scope or schema bloat.
- The scorecard rubric is rebuilt around five DRB-specific dimensions plus a total /25.

## Stage model

```
Applied  →  Interview  →  Onboarding  →  Active staff
                                              (lives on /admin/staffing — not on this page)

Rejected  ←─ side branch from Applied or Interview (reachable via search)
Unfinished ─ users registered on hiring.drbartender.com but never submitted
              an application; reachable via search only
```

- **No "Hired" column.** The "hire" decision fires at the end of an interview and immediately drops the candidate into Onboarding. "Hired" is a verb, not a place.
- **No manual activation step.** When `onboarding_progress >= 1` the user auto-flips to Active staff and disappears from the Hiring page.
- **Rejected** is reachable via the search bar; the kanban does not show a Rejected column.
- **Unfinished** signups already exist as data: a `users` row with no matching `applications` row. The applicant can log back in to finish; admin reaches them via search when needed ("did Sara actually apply?"). No new draft mechanism.

## Surface 1 — Hiring Dashboard

Route: `/admin/hiring`. File: `client/src/pages/admin/HiringDashboard.js` (full rewrite, same path).

### Page structure

1. **Page header** — title "Hiring", subtitle (e.g., `"12 in pipeline · 3 new this week"`), search bar, no page-actions on the right (no "Open role" / "Job posts" buttons — DRB does not track postings).
2. **KPI strip** — three stats.
3. **Three-column kanban.**

No bottom cards. No Open Roles strip.

### Search bar

- Sits in the page header, replacing the design's "Job posts" / "Open role" buttons.
- Searches across **all** applicant states: Applied, Interview, Onboarding, Active, Rejected, Unfinished signups.
- Result row shows: name, email, current state chip (Applied / Interview / Onboarding / Active / Rejected / Unfinished).
- Click result → applicant detail page. **For Unfinished** (no `applications` row), instead open a small modal showing email, signup date, and two buttons: **Resend signup link** (sends email with the application URL) and **Delete account** (cleanup for spam / abandoned accounts).
- Server endpoint: `GET /admin/hiring/search?q=...` returns up to 20 matches across the union.

### KPI strip

Three stats. Each one triggers an action.

| Stat | Definition | Reaction |
|---|---|---|
| **New apps (7d)** | Count of `applications` submitted in last 7 days | Tells Dallas if the FB / ZipRecruiter post is pulling. Zero = refresh the post. |
| **Need to schedule** | Applicants in Interview stage with `interview_at IS NULL` | Direct "go pick a time" signal. |
| **Stalled** | Applied >14d with no decision, OR Interview unscheduled >3d, OR Onboarding stuck >14d (no progress in 14d). Tune thresholds during implementation. | Flags forgotten people. |

### Kanban columns

```
┌────────────┬──────────────────────────┬─────────────┐
│  Applied   │  Interview               │ Onboarding  │
│            │  ─ Unscheduled (yellow)  │             │
│            │  ─ Scheduled             │             │
└────────────┴──────────────────────────┴─────────────┘
```

- **Applied** — applicants where `onboarding_status = 'applied'`. Footer: city.
- **Interview** — applicants where `onboarding_status = 'interviewing'`. Visually grouped into two clusters within the same column: Unscheduled (top, yellow-tinted bg, "Schedule →" CTA on each card) then Scheduled (datetime footer like "Tue 4/30 · 3:00 PM"). Sub-headers separate the two groups when both are non-empty.
- **Onboarding** — users with `onboarding_status` in the in-progress set; footer is a progress bar with `{pct}% complete` and any blocker label.

### Per-card design

```
┌──────────────────────────────┐
│ [avatar] Name                │
│         Position chip(s)     │
│         [Referral · Mira K]  │  ← only if applications.referral_source
│                              │
│ [Cert flags row]             │  ← BASSET / ServSafe etc. when present
│                              │
│ ──────────────────────────── │
│ [stage-specific footer]      │
│                          [N]d│  ← days in stage
└──────────────────────────────┘
```

Position chip handling: applicants can apply for multiple positions (`positions_interested` is a JSON array). Show up to 2 chips, "+N" overflow if more.

Click card → application detail page.

### Interview scheduling modal

Triggered from the "Schedule →" button on an unscheduled Interview card, OR from the detail page's "Schedule interview" action. Small modal:

- Date picker (TimePicker-style — DRB already has `client/src/components/TimePicker.js` for time + a `LocationInput` pattern for date selection; reuse the same vocabulary).
- Time picker (30-min increments + free-text override).
- Optional notes (e.g., "Phone — I'll call her").
- Optional "Send confirmation" checkbox — fires an email to the applicant via Resend with the date/time. (Email template lives in `server/utils/emailTemplates.js`.)
- Save → writes `applications.interview_at`, transitions card to "Scheduled" group.

**Future scope (out of this redesign):** candidate-self-serve booking. Applicant gets a link, sees admin's available slots, picks one. Schema for `interview_at` is a single timestamp today; growing into a slot-picker later means adding an `interview_slots` side table without changing the column. Build for the simple case now.

## Surface 2 — Application Detail

Route: `/admin/staffing/applications/:id`. File pattern: split into `client/src/pages/admin/applicationDetail/` folder following the `userDetail/` pattern (parent + sibling components).

```
applicationDetail/
├── AdminApplicationDetail.js     # Page shell, identity bar, pipeline strip, two-col layout
├── helpers.js                    # initialsOf, fmt helpers, AD_FLOW constant
├── components/
│   ├── PipelineStrip.js
│   ├── ScorecardCard.js
│   ├── TimelineCard.js
│   ├── OnboardingCard.js
│   ├── ActionsCard.js
│   ├── StatsCard.js
│   ├── FilesBlock.js
│   ├── FlagsCard.js
│   └── ViabilityCard.js
└── sections/
    ├── SectionWords.js
    ├── SectionExperience.js
    ├── SectionGear.js
    └── SectionContact.js
```

### Layout: two-column only

Drop the design's `layout="tabs"` and `layout="single"` alternate modes — the rest of admin-os uses two-col, this should match. Drop the demo picker (`<DemoPicker>`) at top right of the identity bar; it is a design-tool artifact.

```
[ Page back-link "← Hiring pipeline" ]
[ Identity bar (full width) ]
[ Pipeline strip (full width) ]

┌───────────────────────────────┬───────────────┐
│ Main column (1fr)             │ Right rail    │
│                               │ (340px)       │
│  ViabilityCard                │  ActionsCard  │
│  ScorecardCard (≥interview)   │  StatsCard    │
│  SectionWords                 │  Onboarding   │
│  SectionExperience            │   (when in    │
│  SectionGear                  │    onboarding)│
│  SectionContact               │  FilesBlock   │
│  TimelineCard                 │  FlagsCard    │
└───────────────────────────────┴───────────────┘
```

### Identity bar

- 64×64 avatar (initials).
- Application id label (`Application · A123`).
- Display name (h1, display font).
- Status chip (`Applied` / `Interview` / `Onboarding` / `Rejected`).
- Position chips (one per `positions_interested` entry).
- Source chip ("Source: Website" or "Source: Indeed").
- Referral chip if `referral_source` filled — green/accent color.
- Cert warn chips: "No BASSET" if BASSET file absent.
- Contact line: email, phone (mono), city, "Applied {relDay}".
- Right side: kebab + "Email" button + primary CTA.

### Pipeline strip

Four segments instead of the design's five:

```
Applied  →  Interview  →  Onboarding  →  Active staff
```

- Reached/current/next markers per the design.
- Side-banner below the strip if `onboarding_status = 'rejected'`: "Archived from pipeline · {rejection_reason} · {n} days ago".

### Primary CTA per stage

Each stage shows one primary action plus contextual secondary actions:

| Stage | Primary | Secondary |
|---|---|---|
| `applied` | **Invite to interview** | Reject |
| `interview` (unscheduled) | **Schedule interview** | Hire · Reject |
| `interview` (scheduled) | **Hire** | Reschedule · Reject |
| `onboarding` | (no primary — informational) | Send paperwork reminder (always available) |
| `rejected` | **Restore to Applied** | — |

When the primary CTA fires:
- "Invite to interview" → moves to `interviewing`, `interview_at` stays NULL, lands in Interview/Unscheduled.
- "Schedule interview" → opens the scheduling modal.
- "Hire" → status → onboarding stage (creates onboarding record / flips `onboarding_status`), records `hired_at` in activity timeline only (no DB column needed since this is just a state transition timestamp captured in `application_activity`).
- "Reject" → opens a small modal asking for `rejection_reason` (free-text), then sets status to `rejected`.
- "Restore to Applied" → flips status back to `applied`.

### Main column sections

#### ViabilityCard

8 quick-glance cells in a 4-col grid: Position(s), Travel, Transport, Years, Last bartended, Setup conf., Works alone, Saturdays. All map to existing `applications` columns (`travel_distance`, `reliable_transportation`, `bartending_years`, `last_bartending_time`, `setup_confidence`, `comfortable_working_alone`, `available_saturdays`).

#### ScorecardCard

Visible only when status >= interview (and on rejected, for historical record). Mobile-friendly tap targets ≥36px.

Five dimensions, 1–5 dots each:

1. **Personality / charisma**
2. **Customer service instinct**
3. **Problem-solving**
4. **Speed mindset**
5. **Hire instinct**

Display:
- Header: "Average X.X / 5" + filled-star glyph + **Total: X / 25** (prominent — punchier than average for vibe-driven hiring).
- Five rows, each with the label and 5 tappable dots; below each row, a small "X / 5" or "—" if unrated.
- Drop the design's "Panel" pills (DRB is one-person hiring) and "Panel notes" line.
- Persistence: every dot click saves immediately via `PUT /admin/applications/:id/scorecard`.

#### SectionWords

Three stacked blocks reading from existing columns:
- **Why Dr. Bartender?** (`why_dr_bartender`) — italic display-font quote treatment.
- **Customer service approach** (`customer_service_approach`).
- **Additional info** (`additional_info`) — only render when non-empty.

#### SectionExperience

- **Positions interested in** — chips from `positions_interested`.
- **Experience types** — chips from `experience_types`.
- **Experience description** — `bartending_experience_description` rendered as prose. **Drop the design's structured `[place, role, when]` rows.** We do not collect work history that way; trying to parse the description into rows is brittle. Show the prose.

#### SectionGear

- **Bar tools owned** — chips derived from `tools_*` boolean columns.
- **Bar equipment** — chips derived from `equipment_*` boolean columns.
- **Saturdays** + **Other commitments** — `available_saturdays` and `other_commitments`.

#### SectionContact

- Email (from `users.email`), Phone (`applications.phone`), Address (`street_address` + city + state + zip), Date of birth (`birth_month/day/year`), Emergency contact (name + relationship + phone).
- "Edit" pencil button — opens an inline edit modal (fields admin can correct on behalf of the applicant if they fat-fingered).

#### TimelineCard

Unified activity feed. Add-note textarea at top; below, a chronological list with timeline dots and a 110px right-aligned "when" column.

Real events only — no fabricated "phone screen" entries:

- `application_submitted` — auto, from `applications.created_at`.
- `status_changed` — auto, with `from_status` → `to_status`.
- `interview_scheduled` — auto.
- `interview_rescheduled` — auto.
- `reminder_sent` — auto, when admin clicks "Send paperwork reminder".
- `note_added` — manual, from the textarea.
- `onboarding_step_completed` — auto, **major checkpoints only** (per-step would be too noisy). Record on: agreement signed, contractor profile completed, payday protocols viewed, full paperwork done. Skip the smaller `welcome_viewed` / `field_guide_completed` steps.

### Right rail sections

- **ActionsCard** — primary CTA + Email applicant + Schedule interview (when applicable) + Reject / Restore.
- **StatsCard** — Applied (relative + absolute), Days in pipeline, Source, Referral source (if any), Interview datetime (if scheduled), Avg score (if any scorecard data).
- **OnboardingCard** — visible only when `status = 'onboarding'`. Five paperwork items (agreement, W-9, ID, BASSET upload, direct deposit), progress bar, "Send reminder for {first incomplete step}" CTA. Reuses `ONBOARDING_STEPS` from the existing HiringDashboard.
- **FilesBlock** — Resume, BASSET, Headshot tiles. Links to R2 file URLs (`resume_file_url`, `basset_file_url`, `headshot_file_url`). Use the design's "tiles" treatment.
- **FlagsCard** — auto-derived chips: BASSET (yes/active if file present), ServSafe (not currently tracked — defer), Referral (if `referral_source` set), No BASSET warn (when file absent), No transport warn (when `reliable_transportation` is no).

## Application form change

Add **"Who referred you?"** as an optional text field on the application form, surfaced in `client/src/pages/Application.js`. Persisted as `applications.referral_source TEXT` (nullable). Step placement: in the same step as "How did you hear about us?" or near it. If the applicant types a name, the detail page shows a green "Referral · {name}" chip.

## Schema additions

```sql
-- Referral source captured on the application form.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS referral_source TEXT;

-- Interview scheduling (single timestamp; future slot-picker can grow into a side table).
ALTER TABLE applications ADD COLUMN IF NOT EXISTS interview_at TIMESTAMPTZ;

-- Reason captured when admin rejects.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Five-dimension interview scorecard.
CREATE TABLE IF NOT EXISTS interview_scores (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  -- Five dimensions, each 1-5 or NULL.
  personality       INTEGER CHECK (personality       BETWEEN 1 AND 5),
  customer_service  INTEGER CHECK (customer_service  BETWEEN 1 AND 5),
  problem_solving   INTEGER CHECK (problem_solving   BETWEEN 1 AND 5),
  speed_mindset     INTEGER CHECK (speed_mindset     BETWEEN 1 AND 5),
  hire_instinct     INTEGER CHECK (hire_instinct     BETWEEN 1 AND 5),
  scored_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Activity timeline for the application detail page.
CREATE TABLE IF NOT EXISTS application_activity (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type  VARCHAR(40) NOT NULL,
  -- One of: application_submitted, status_changed, interview_scheduled,
  --        interview_rescheduled, reminder_sent, note_added,
  --        onboarding_step_completed
  metadata    JSONB,         -- e.g. { from: 'applied', to: 'interviewing' } or { note: '...' }
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_application_activity_user_id_created_at
  ON application_activity (user_id, created_at DESC);
```

## Server route additions / changes

- `GET /admin/applications` — extend response with `referral_source`, `interview_at`, `rejection_reason`, derived `onboarding_progress`, derived `onboarding_blocker`, derived `flags` array.
- `GET /admin/applications/:userId` — same extensions, plus joined scorecard + activity.
- `PUT /admin/applications/:userId/interview` — body: `{ interview_at, notes?, send_email? }`. Sets `interview_at` and writes activity event.
- `DELETE /admin/applications/:userId/interview` — clears `interview_at` (rare, but supports rescheduling-by-clearing).
- `PUT /admin/applications/:userId/scorecard` — body: `{ personality, customer_service, problem_solving, speed_mindset, hire_instinct }` (any subset). Upserts `interview_scores` row, writes activity event.
- `POST /admin/applications/:userId/reject` — body: `{ rejection_reason }`. Sets status + reason, writes activity event.
- `POST /admin/applications/:userId/restore` — flips `rejected` back to `applied`, writes activity event.
- `POST /admin/applications/:userId/notes` — body: `{ note }`. Writes activity event of type `note_added`. Replaces the existing `interview_notes` insert (or extends it — implementation chooses).
- `POST /admin/applications/:userId/reminder` — sends paperwork-reminder email via Resend, writes activity event.
- `GET /admin/hiring/summary` — returns `{ new_apps_7d, need_to_schedule, stalled, in_pipeline }` for the KPI strip.
- `GET /admin/hiring/search?q=...` — returns up to 20 matches across applied/interview/onboarding/active/rejected/unfinished, each row carrying its current state chip.

All new endpoints: `auth + adminOnly`, parameterized SQL, transactions for multi-table writes, ROLLBACK on error per CLAUDE.md inline-self-check rules.

## What is being dropped

For traceability, here is everything in the handoff design that is **not** being built:

- `HIRING_STAGES` array's "hired" entry — collapsed.
- "Open roles" strip on the kanban (no headcount targets).
- "Recently joined active staff" bottom card.
- "Recently rejected" bottom card.
- Per-column "Activate {N} →" footer on Onboarding column.
- Per-column "Add applicant" footer on Applied column (admin doesn't add — applicants self-apply).
- Page-action buttons "Job posts" and "Open role" on the kanban.
- Demo picker (`<DemoPicker>`) on the application detail identity bar.
- `layout="tabs"` and `layout="single"` modes on application detail.
- References block (`ReferencesCard`).
- Structured work history rows in `SectionExperience`.
- Scorecard "Panel" pills and "Panel notes" line (single-admin context).
- Stage-aware CTA "Activate as staff" — onboarding completion is automatic.
- "Hired" stage in pipeline strip — strip is four segments, not five.

## Implementation phasing

Three commits, in order:

1. **Schema + server routes.** All migrations (`referral_source`, `interview_at`, `rejection_reason`, `interview_scores`, `application_activity`). All new endpoints. Application form's `referral_source` capture. No frontend yet — verify via curl / Postman or a quick script.
2. **Application detail rewrite.** Build the new `applicationDetail/` folder with shell + sections + right rail. Wire to the new endpoints. Mount in place of the legacy `client/src/pages/AdminApplicationDetail.js` (file deleted in this commit).
3. **Hiring Dashboard rewrite.** Build the new `HiringDashboard.js` (kanban + KPI strip + search + scheduling modal). Replace the existing legacy file at the same path. Update `client/src/components/adminos/nav.js` if any nav copy needs adjusting.

Pre-push: 5 review agents per CLAUDE.md Pre-Push Procedure (this touches schema, routes, and UI cross-layer). UI agent on demand if running `/review-before-deploy`.

## Files affected

- `server/db/schema.sql` — schema additions
- `server/routes/admin/applications.js` — extended + new endpoints
- `server/routes/application.js` — accept `referral_source` on submission
- `server/utils/emailTemplates.js` — interview-confirmation + paperwork-reminder templates
- `client/src/pages/Application.js` — referral question
- `client/src/pages/AdminApplicationDetail.js` — **deleted**
- `client/src/pages/admin/applicationDetail/` — new folder per spec
- `client/src/pages/admin/HiringDashboard.js` — full rewrite
- `client/src/components/adminos/InterviewScheduleModal.js` — new (or local to HiringDashboard if not reused)
- `CLAUDE.md`, `README.md`, `ARCHITECTURE.md` — folder-tree updates per the mandatory-doc-updates rule

## Testing

- Manual: walk a synthetic applicant through Applied → Interview (unscheduled) → Schedule → Interview (scheduled) → Hire → Onboarding → auto-flip to Active. Then Reject → Restore. Verify timeline events at every transition.
- Manual: scorecard saves on click, persists across reloads.
- Manual: search hits across all six states (Applied / Interview / Onboarding / Active / Rejected / Unfinished signups).
- Manual: pre-existing applicants migrate cleanly — old `interview_notes` rows still readable on the timeline. Approach: the timeline query UNIONs `application_activity` (new events) and `interview_notes` (old notes rendered as `note_added` events). No backfill, no destructive migration.
- Manual: mobile (iPhone Safari) — scorecard dots are tappable, Schedule modal is usable, kanban scrolls without horizontal jank.

## Out of scope

- Candidate-self-serve interview booking. Schema kept flexible; build later as a slot-picker.
- Per-role hiring filters (DRB hires for everything at once).
- Job-posting management (no postings concept).
- ServSafe certification tracking (currently uncaptured).
- Hiring-page kanban drag-and-drop (the detail page's stage CTAs do the same job).

# Staff display names: preferred name plus last initial

Design spec, 2026-07-26. Approved section by section in conversation.

## 1. Problem

`contractor_profiles.preferred_name` is a free-text field that the app asks for
twice, once with copy that explicitly invites a stage name. It is then used, raw
and alone, as the staff member's name on roughly thirty surfaces: admin staffing
lists, event rosters, BEOs, payroll screens, the public tip page, and the
year-end 1099 workbench.

The result on production today:

- `TwistidTreets` (user 205) is legally Nevver Sayles. That string is her name on
  rosters, on client-facing BEOs, and on the 1099 contractor list.
- `Miss Taylor` (user 61, hired) has no application and no agreement on file, so
  there is no legal name behind the nickname at all.
- `Nicholas or Nick ` (user 31) answered the question with an either/or.
- About 25 of ~60 profiles hold a full name (`Tashea Coates`, `Evan Williams`,
  `Jerrod Capiak`), because the field never said what it wanted.
- About 8 rows carry leading or trailing whitespace.

The root cause is `server/routes/payment.js:165`. Payday Protocols, step 5 of
onboarding, asks for the preferred name a second time for the tip page, with
helper copy reading "Use whatever you go by: your real name, a nickname, a stage
name," and writes the answer straight over the step 4 value in
`contractor_profiles.preferred_name`.

## 2. The rule

A preferred name is **a personal name, not an identity**.

The test, which is also the instruction we give: could a guest say it to your
face when you introduce yourself? "Hi, I'm Chip, I'll be taking care of you
tonight" works. "Hi, I'm TwistedTreats" does not. "Hi, I'm Miss Taylor" is a form
of address rather than a name, which is the tell.

The field exists to be inclusive. Alexander gets to be Alexis. Mohammad gets to
be Fareed. Tashea gets to be Shea. It does not exist to let anyone trade under a
bar handle.

Every staff name shown as an identifier carries a last initial. There are no
mononyms. Nobody appears as "Cher."

## 3. Copy

### 3.1 Step 4, Contractor Profile (`client/src/pages/ContractorProfile.js`)

Replaces the current bare `Preferred Name *` label with no helper text.

> **What do I call you?**
> Fill in the blank: "Hi, I'm \_\_\_\_\_\_, I'll be taking care of you tonight."
> Whatever you actually go by. A short form, a chosen name, the name your people
> use. Chip for Vernon, Alexis for Alexander, Shea for Tashea, Fareed for
> Mohammad.
>
> *Your team and clients will see* **Alexis M.**

The preview line is live, recomputed as they type, using the surname from their
signed agreement. Step 3 is the agreement, so in the standard flow the legal name
is on file before they reach this field; where it is missing or single-token the
preview degrades to the short name alone rather than inventing an initial.
Someone typing a handle watches "SaltyBannanas S." appear underneath.

Deliberately **no** prohibition list ("not a stage name, not a business name").
A field whose purpose is that Alexander gets to be Alexis should not open by
listing what you are not allowed to be. The framing does the eliciting; §5 does
the enforcing.

### 3.2 Staff portal (`client/src/pages/staff/account/ProfileSection.js`)

Same label, same preview, minus the fill-in-the-blank line. Replaces
`PREFERRED_NAME_HELPER` ("Shown on the staff roster and to clients.").

### 3.3 Step 5, Payday Protocols (`client/src/pages/PaydayProtocols.js`)

**The field is removed.** In its place, read-only:

> Your tip page will read **Fareed S.**  [Change this]

"Change this" links back to the profile field. `POST /api/payment` stops reading
`req.body.preferred_name` and stops writing `contractor_profiles.preferred_name`
(`server/routes/payment.js:162-168`); `createTipPaymentLink` takes the display
name off the profile instead (`server/routes/payment.js:223`).

This is what actually closes the stage-name door, and it is the only way to stop
step 5 from silently overwriting step 4.

## 4. Data model

Two new columns on `contractor_profiles`:

```sql
ALTER TABLE contractor_profiles
  ADD COLUMN IF NOT EXISTS display_name VARCHAR(255);
ALTER TABLE contractor_profiles
  ADD COLUMN IF NOT EXISTS preferred_name_status VARCHAR(20)
    NOT NULL DEFAULT 'pending'
    CHECK (preferred_name_status IN ('pending', 'approved'));
```

`display_name` is maintained, not computed at read time. Every read site becomes
a mechanical swap from `COALESCE(cp.preferred_name, u.email)` to
`COALESCE(cp.display_name, u.email)`, which is easy to review and easy to revert,
and the salutation sites simply keep reading `preferred_name` and are never
touched. The display-versus-salutation split stops being a convention someone has
to remember and becomes a column choice.

A database trigger was considered and rejected: it puts invisible behavior on a
table that payroll reads, and a stale display name is cosmetic where a surprise
inside a money query is not. Explicit and greppable wins, backed by a re-runnable
audit script (§8).

### 4.1 The helper

New `server/utils/staffDisplayName.js`, pure and unit-testable:

```
computeDisplayName({ preferredName, legalFullName, status }) -> string | null
```

1. Collapse whitespace and trim both inputs.
2. `legalTokens` = legal name split on whitespace.
3. Pick the source of the initial:
   - if `legalTokens.length >= 2`, take it from the legal surname;
   - else if the preferred name has 2+ tokens, take it from the preferred name's
     own last token;
   - else there is no initial (see §10).
4. Pick the short name:
   - if `status === 'approved'` and a preferred name exists, shorten it (below);
   - otherwise use `legalTokens[0]`, so a pending or rejected entry renders by
     legal first name.
5. Return `"<short> <Initial>."`, or `short` alone when step 3 found no initial,
   or `null` when there is nothing at all (caller keeps its email fallback).

Shortening handles the "they typed their full name" case:

- When the initial came from the legal name, drop trailing preferred-name tokens
  that match a legal token or are a bare middle initial. `Tashea Coates` against
  `Tashea Coates` becomes `Tashea C.`; `Ariel  D. Smith` against `Ariel Smith`
  becomes `Ariel S.`; `Billie Jean` against `Billie Jean Barrone` keeps both
  tokens and becomes `Billie Jean B.`, which is right.
- When the initial came from the preferred name itself, drop that last token.
  `Mark Holt` against the single-token agreement `Mark` becomes `Mark H.`

Casing is left alone except for one narrow repair: a token that is entirely
lowercase gets its first letter capitalized, so the live `veronica martinez` row
renders `Veronica M.` Mixed-case tokens are never touched, because `LaToya`,
`McKenna` and `d'Angelo` are correct as typed and any general title-casing pass
would break them.

Worked examples from live data:

| preferred | legal | renders |
|---|---|---|
| Fareed | Mohammad F Shafiuddin | Fareed S. |
| Teah | Teah Teriele | Teah T. |
| Dallas | Dallas Raby | Dallas R. |
| Tashea Coates | Tashea Coates | Tashea C. |
| Billie | Billie Jean Barrone | Billie B. |
| TwistidTreets *(pending)* | Nevver Sayles | Nevver S. |

### 4.2 Refresh points

`refreshDisplayName(userId, client)` recomputes and writes both columns. Called
from every place a name or a status can change:

- `server/routes/contractor.js` (step 4 save)
- `server/routes/me.js` (staff portal PATCH)
- `server/routes/staffPortal.js` (profile PATCH)
- `server/routes/admin/users.js` (admin profile PUT, and the seed-from-application
  path at `:173-186`)
- `server/routes/agreement.js` (signing supplies the legal name)
- `server/utils/contractorSeed.js`
- the new approve/reject endpoint (§5)

`server/routes/payment.js` drops off this list entirely, because it stops writing
names.

## 5. The approval gate

The form never rejects anyone. Enforcement is one admin click.

**Auto-approved** (never reaches the queue) when the preferred name is traceable
to the legal name by any of:

- exact match of a legal-name token (`Tashea` from Tashea Coates)
- substring of a legal token (`Shea` inside Tashea)
- a shared prefix of three or more characters (`Tim`/Timothy, `Nick`/Nicholas,
  `Nicki` for Nicole Prowell, `Alexis`/Alexander)
- first letter of a legal middle token (`Fareed` against Mohammad **F**
  Shafiuddin)

All comparisons are case-insensitive, so `FELICIA` against Felicia and
`veronica` against Veronica both trace cleanly.

**Pending** otherwise, which is the small high-signal queue: Chip for Vernon, DJ
for Dallas, `Joey` for Joseph Key, `Mikey` for Michael Ryan, `Nikki` for Monique
Lundy, `TwistidTreets` for Nevver Sayles. A pending row renders by legal first
name plus initial, so the app is never showing something unprofessional, only
something formal.

Surface: a `name-approval` item type in the existing Needs Attention staffing tab
(`client/src/pages/admin/overview/queueItems.js`, `buildStaffingItems`), reading
"Nevver Sayles wants to be called TwistidTreats", targeting
`/staffing/users/:id`. `queueItemHref` in `NeedsYouStrip.js` gains a `user`
target.

Approve sets `preferred_name_status = 'approved'` and refreshes. Reject clears
`preferred_name` to NULL and refreshes, so they revert to legal first name and
can enter something else.

Staff-side honesty: while pending, the portal shows a calm note under the field,
"Waiting on a quick review. You'll show as Nevver S. until then." Rejection sends
no automatic email; Dallas messages the person if it needs a conversation. This
is the one place worth revisiting if it feels cold in practice.

### 5.1 Input validation

Narrow on purpose, so real names never trip:

- required, 2 to 20 characters after trim
- one or two words (catches `Nicholas or Nick`)
- letters, spaces, hyphens, apostrophes and periods only, so `Mary-Kate`,
  `O'Brien` and `D.J.` pass and digits and symbols do not
- no leading title: Miss, Ms, Mrs, Mr, Dr, Chef, Sir, Madam, Master, Coach,
  Captain, Prof, Rev (catches `Miss Taylor`)

Deliberately **no** camelCase detection. McKenna, DeShawn and LaToya are real
names, and it is better to miss `TwistidTreets` here and catch it at §5 than to
reject someone's actual name.

Enforced both client-side (immediate feedback) and in the server validators for
`contractor.js`, `me.js`, `staffPortal.js` and `admin/users.js`.

## 6. Where each name is used

**Display name (`display_name`).** Every place a name identifies a person in a
list or on a document:

`shifts.js:200,243,245,297` · `calendar.js:179` · `staffShiftActions.js:840` ·
`admin/payroll.js:34,42,558,655` · `admin/users.js:33,442,455` ·
`stripePayouts.js:20` · `proposals/cancel.js:170` · `publicTip.js:83,227` ·
`admin/contractorTipPage.js:110,160,268,294` · `messages.js:20,37` ·
`adminCoverSwaps.js:81` · `staffPortal.js:99` · `presenceStore.js:8` ·
`beoHandlers.js:223` · `staffShiftHandlers.js:306,544` ·
`marketingHandlers.js:390` · `admin/applications.js:164`

Client side: `ShiftDrawer.js:371,650,653` · `AdminDashboard.js:269,486,632` ·
`admin/StaffDashboard.js:26,27,119,126,174` · `AdminUserDetail.js:166,350` ·
`staff/TipCardPage.js:275` · `staff/TeamRosterCard.js`

`server/routes/beo.js:182` already implements this rule as a local
`computeName()`. It is deleted and replaced with the shared helper, which is the
one behavior-preserving swap in the list.

**Bare preferred name (`preferred_name`, unchanged).** Every salutation. "Hi
Fareed, you're confirmed for Saturday" must never read "Hi Fareed S.":

`shifts.approval.js:169,323,351,529,557` · `lastMinuteStaffingConfirmation.js` ·
`eventEveSms.js:116` · `lastMinuteAlert.js:51` · `payrollDisputeNotify.js:90,97`
· `auth.js:317,367` and the staff shell user pill, where they are looking at
themselves (protected by the existing `auth.preferredName.test.js`)

**Legal name.** Money records, as opposed to money screens:

- `server/utils/paystubData.js:40` already resolves legal name first, by
  deliberate design, with a comment saying so. **No change.**
- `server/routes/admin/payrollTax.js:137` uses
  `COALESCE(cp.preferred_name, u.email)`, so the year-end 1099 contractor list
  currently reads "TwistidTreets" where it must read "Nevver Sayles". **This is
  the one genuine money defect in scope**, and it takes the same legal-first
  precedence the paystub already uses.
- Contracts and agreements already use `agreements.full_name`. No change.

`stripePayouts.js` is display-only despite living in a money path: its own
comment at line 11 says so, and matching keys on `t.target_user_id`, never on the
name string. Safe to swap.

## 7. Existing data

A one-shot backfill runs every current row through the same helper and the same
auto-approve test. For a value that would fail §5.1 validation, it applies the
§4.1 shortening rule first and only falls back to the legal first name if the
result still fails. So `Ariel  D. Smith` shortens to `Ariel` and renders
`Ariel S.`, while `Nicholas or Nick ` cannot be shortened (none of its tokens
match the legal surname) and falls back to `Nicholas`.

Expected outcome on production:

- the ~25 full-name rows auto-approve and shorten (`Tashea Coates` to
  `Tashea C.`)
- `Nicholas or Nick ` fails the two-word cap, falls back to `Nicholas`, and
  renders `Nicholas D.`
- four rows land pending and **visibly change on deploy**: Joey renders
  `Joseph K.`, Mikey renders `Michael R.`, Nikki renders `Monique L.`, and
  TwistidTreets renders `Nevver S.` until the queue is cleared. Clearing it is
  one click each, and rejecting Nevver's is the point of the whole exercise.
- `Miss Taylor` (61) has no legal name at all and cannot be resolved by script.
  Manual: get her legal name on file.

Rows needing a legal name before they can carry an initial: users 1 (admin), 2
(Zul), 61 (Miss Taylor), 62, 233, 236, 237, 238, 239, 240. Most are deactivated
and cosmetic; 61 and 237 are not.

Out of scope but surfaced by this work: Felicia Kluppelberg (39, 40) and Adelle
Reynolds (51, 62) each hold duplicate accounts.

## 8. Verification

- Unit tests for `computeDisplayName` and the auto-approve test, table-driven off
  the real production pairs in §4.1, including the single-token-agreement case
  (`Mark`), the no-legal-name case, and `Billie Jean`.
- Validator tests for §5.1, asserting `McKenna`, `DeShawn`, `O'Brien`,
  `Mary-Kate` and `D.J.` all pass and `Miss Taylor`, `Nicholas or Nick`,
  `Bar2Go` and a 30-character string all fail.
- Route tests for the approve and reject endpoints, including that reject reverts
  the rendered name.
- `server/scripts/refreshDisplayNames.js`, idempotent, with a `--check` mode that
  exits non-zero if any row's stored `display_name` differs from a fresh
  computation. This is the safety net for the "someone added a write path and
  forgot to refresh" failure mode.
- **Run the payroll suites, do not assume.** `admin/payroll.js:42` and `:655`
  sort and aggregate on the name string, so swapping the column changes sort keys
  and array ordering, which is exactly where count and sorted-list assertions
  bite. Same for `messages.js:37`.
- Manual pass: onboarding steps 4 and 5 on a fresh account, the live preview, the
  portal edit, one approve, one reject.

## 9. Not doing

- No automatic email on rejection.
- No camelCase or profanity heuristics.
- No merging of the duplicate accounts.
- No change to how legal names are captured. The agreement remains the source.

## 10. Known gaps

A few agreements were signed with a single token (`Mark`, `Zul`), so there is no
surname to take an initial from and those people render bare until the legal name
is completed. The helper degrades to the short name rather than inventing an
initial, and the affected rows are listed in §7 for manual follow-up.

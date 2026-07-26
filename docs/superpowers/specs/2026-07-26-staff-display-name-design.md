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

Nevver did what the form told her she could do.

## 2. The rule

A preferred name is **a personal name, not an identity**.

The test, which is also the instruction we give: could a guest say it to your
face when you introduce yourself? "Hi, I'm Chip, I'll be taking care of you
tonight" works. "Hi, I'm LumpyIceCream" does not. "Hi, I'm Miss Taylor" is a form
of address rather than a name, which is the tell.

The field exists to be inclusive. Alexander gets to be Alexis. Mohammad gets to
be Fareed. Tashea gets to be Shea. It does not exist to let anyone trade under a
bar handle.

**The preferred name is authoritative.** It is what we call the person, not a
claim to be checked against anything. The legal name supplies one character, the
last initial, and never appears on a screen otherwise. If someone gives their
name as Joey, they are Joey K. forever, and nobody infers a Joseph.

Every staff name shown as an identifier carries that last initial. There are no
mononyms. Nobody appears as "Cher."

**Instructions are the enforcement.** There is no approval gate and no heuristic
sorting nicknames into legitimate and suspicious. Those were compensation for
copy that invited the wrong answer. Fix the copy and the answers come back right.

**Admin sees every name that comes in.** Not to approve it, and not before it
goes live. Visibility exists so that if a LumpyIceCream ever gets through, Dallas
notices it and takes it up with that person directly, which is a conversation
between two humans and not a workflow state on a row.

## 3. Instructions and visibility

This is the substance of the change. Everything below it is plumbing.

### 3.1 Step 4, Contractor Profile (`client/src/pages/ContractorProfile.js`)

Replaces the current bare `Preferred Name *` label, which has no helper text at
all.

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

The preview is doing real work. Someone typing a handle watches
"LumpyIceCream S." appear underneath, in the same breath as a sentence about
introducing themselves to a guest.

Deliberately **no** prohibition list ("not a stage name, not a business name").
A field whose purpose is that Alexander gets to be Alexis should not open by
listing what you are not allowed to be. The framing does the eliciting.

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

This is the single highest-value change in the spec. It deletes the copy that
produced the problem and stops step 5 from silently overwriting step 4.

### 3.4 Format validation

Narrow, mechanical, and about shape rather than judgment. It is not a filter on
whether a name is worthy:

- required, 2 to 20 characters after trim
- one or two words (catches `Nicholas or Nick`)
- letters, spaces, hyphens, apostrophes and periods only, so `Mary-Kate`,
  `O'Brien` and `D.J.` pass and digits and symbols do not
- no leading title: Miss, Ms, Mrs, Mr, Dr, Chef, Sir, Madam, Master, Coach,
  Captain, Prof, Rev (catches `Miss Taylor`)

Deliberately **no** camelCase detection. McKenna, DeShawn and LaToya are real
names, and rejecting a real name to catch `LumpyIceCream` is a bad trade. This
check would not have caught Nevver, and it is not meant to. The copy catches
Nevver.

Enforced client-side for immediate feedback and in the server validators for
`contractor.js`, `me.js`, `staffPortal.js` and `admin/users.js`.

### 3.5 Admin visibility

Every preferred name that is set or changed surfaces to Dallas once. The name is
live from the moment it is typed; this is a notice, never a hold.

`preferred_name_reviewed_at TIMESTAMPTZ` on `contractor_profiles`, NULL meaning
"not looked at yet." Set to NULL by `refreshDisplayName` whenever the preferred
name actually changes value, and stamped when Dallas dismisses the notice.
**`display_name` never reads this column.**

Surface: a `name-notice` item type in the existing Needs Attention staffing tab
(`client/src/pages/admin/overview/queueItems.js`, `buildStaffingItems`), reading
"Nevver Sayles goes by TwistidTreets", targeting `/staffing/users/:id`.
`queueItemHref` in `NeedsYouStrip.js` gains a `user` target. Priority `info`, the
same weight as the new-applications rollup, because in the ordinary case this is
a pleasant fact rather than a problem.

One action, "Got it", which stamps the timestamp and nothing else. There is no
reject action: the remedy for a bad name is to talk to the person, and if that
conversation ends with a change, it gets made in the profile like any other edit.

Volume is a few per month at current hiring pace, so every change surfaces and no
filtering is needed to keep the queue readable.

Supporting this, the admin user detail Overview tab
(`client/src/pages/admin/userDetail/tabs/OverviewTab.js`) shows the legal name
alongside the preferred name, read-only. When Dallas opens Nevver's record to
have that conversation, both names are in front of him.

## 4. Data model

Two new columns on `contractor_profiles`:

```sql
ALTER TABLE contractor_profiles
  ADD COLUMN IF NOT EXISTS display_name VARCHAR(255);
ALTER TABLE contractor_profiles
  ADD COLUMN IF NOT EXISTS preferred_name_reviewed_at TIMESTAMPTZ;
```

`preferred_name_reviewed_at` drives §3.5 and nothing else. No read path for a
name consults it.

`display_name` is maintained, not computed at read time. Every read site becomes
a mechanical swap from `COALESCE(cp.preferred_name, u.email)` to
`COALESCE(cp.display_name, u.email)`, which is easy to review and easy to revert,
and the salutation sites simply keep reading `preferred_name` and are never
touched. The display-versus-salutation split stops being a convention someone has
to remember and becomes a column choice.

A database trigger was considered and rejected: it puts invisible behavior on a
table that payroll reads, and a stale display name is cosmetic where a surprise
inside a money query is not. Explicit and greppable wins, backed by a re-runnable
audit script (§7).

### 4.1 The helper

New `server/utils/staffDisplayName.js`, pure and unit-testable:

```
computeDisplayName({ preferredName, legalFullName }) -> string | null
```

1. Collapse whitespace and trim both inputs.
2. `legalTokens` = legal name split on whitespace.
3. Pick the source of the last initial:
   - if `legalTokens.length >= 2`, take it from the legal surname;
   - else if the preferred name has 2+ tokens, take it from the preferred name's
     own last token;
   - else there is no initial (see §9).
4. Shorten the preferred name (below).
5. Return `"<short> <Initial>."`, or `short` alone when step 3 found no initial,
   or `null` when there is no preferred name at all, in which case the caller
   keeps its existing email fallback.

The legal name is used **only** in step 3, and only for one character. It is
never a substitute for a name the person gave us.

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
| Joey | Joseph Key | Joey K. |
| Nikki | Monique Lundy | Nikki L. |
| Tashea Coates | Tashea Coates | Tashea C. |
| Billie | Billie Jean Barrone | Billie B. |
| Mark Holt | Mark | Mark H. |

### 4.2 Refresh points

`refreshDisplayName(userId, client)` recomputes and writes `display_name`, and
clears `preferred_name_reviewed_at` when the preferred name changed value.
Comparing before and after matters: an admin editing a phone number, or an
agreement arriving and changing only the initial, must not re-raise a notice for
a name nobody touched. Called from every place a preferred name or a legal name
can change:

- `server/routes/contractor.js` (step 4 save)
- `server/routes/me.js` (staff portal PATCH)
- `server/routes/staffPortal.js` (profile PATCH)
- `server/routes/admin/users.js` (admin profile PUT, and the seed-from-application
  path at `:173-186`)
- `server/routes/agreement.js` (signing supplies the legal name)
- `server/utils/contractorSeed.js`

`server/routes/payment.js` drops off this list entirely, because per §3.3 it
stops writing names.

## 5. Where each name is used

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

**Legal name.** Government documents only, which is also the rule for anything
that is a money record rather than a money screen:

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

## 6. Existing data

**No script rewrites anyone's `preferred_name`.** The shortening in §4.1 is a
display concern and lives entirely in `display_name`, so `Tashea Coates` keeps
her stored value and simply renders as `Tashea C.` This removes any question of
the backfill assuming something about a person's name.

The backfill therefore does three things only:

1. Trim leading and trailing whitespace on the ~8 affected rows.
2. Populate `display_name` for every existing row.
3. Stamp `preferred_name_reviewed_at = NOW()` on every existing row, so the
   Needs Attention queue starts empty rather than opening on day one with sixty
   notices about names that have been fine for a year. The four rows below are
   the day-one work, and they are a hand-list rather than a queue because two of
   them are not preferred-name problems at all.

Everyone currently on the roster keeps the name they gave us. Joey renders
`Joey K.`, Mikey renders `Mikey R.`, Nikki renders `Nikki L.` Nothing is demoted.

Four rows a script should not touch, reported for Dallas to handle by hand:

| user | value | issue |
|---|---|---|
| 205 | `TwistidTreets` | valid format, wrong kind of name; needs a conversation |
| 61 | `Miss Taylor` | leading title, and no legal name on file at all |
| 31 | `Nicholas or Nick ` | either/or answer; he should pick one |
| 62 | `Adelle M. Reynolds` | three tokens, and a duplicate of user 51 |

Two of these are the rows that started this conversation. They were found by a
human noticing, and they are fixed by a human asking. That is the correct amount
of automation for two rows.

Rows with no legal name, so no last initial until one is on file: users 1
(admin), 2 (Zul), 61, 62, 233, 236, 237, 238, 239, 240. Most are deactivated and
cosmetic; 61 and 237 are not, and 61 needs one for money records regardless.

Out of scope but surfaced by this work: Felicia Kluppelberg (39, 40) and Adelle
Reynolds (51, 62) each hold duplicate accounts.

## 7. Verification

- Unit tests for `computeDisplayName`, table-driven off the real production pairs
  in §4.1, including the single-token-agreement case (`Mark`), the no-legal-name
  case, `Billie Jean`, and `veronica martinez`.
- A test asserting the legal name never reaches the output except as one
  initial, so the Joey-is-really-Joseph failure mode cannot regress in.
- A test asserting `display_name` is identical whether
  `preferred_name_reviewed_at` is NULL or set, so the notice can never become a
  gate by accident.
- Route tests for the notice: a preferred-name change clears the timestamp, a
  phone-only edit does not, and "Got it" stamps it.
- Validator tests for §3.4, asserting `McKenna`, `DeShawn`, `O'Brien`,
  `Mary-Kate` and `D.J.` all pass and `Miss Taylor`, `Nicholas or Nick`,
  `Bar2Go` and a 30-character string all fail.
- `server/scripts/refreshDisplayNames.js`, idempotent, with a `--check` mode that
  exits non-zero if any row's stored `display_name` differs from a fresh
  computation. This is the safety net for the "someone added a write path and
  forgot to refresh" failure mode.
- **Run the payroll suites, do not assume.** `admin/payroll.js:42` and `:655`
  sort and aggregate on the name string, so swapping the column changes sort keys
  and array ordering, which is exactly where count and sorted-list assertions
  bite. Same for `messages.js:37`.
- Manual pass: onboarding steps 4 and 5 on a fresh account, watching the live
  preview, then the portal edit.

## 8. Not doing

- No approval gate. §3.5 is visibility only: a name is live the moment it is
  typed, and the notice has one action, "Got it".
- No reject action. The remedy for a bad name is a conversation.
- No heuristic relating a preferred name to a legal name.
- No camelCase or profanity detection.
- No script rewriting a stored preferred name.
- No merging of the duplicate accounts.
- No change to how legal names are captured. The agreement remains the source.

## 9. Known gaps

A few agreements were signed with a single token (`Mark`, `Zul`), so there is no
surname to take an initial from and those people render bare until the legal name
is completed. The helper degrades to the short name rather than inventing an
initial, and the affected rows are listed in §6 for manual follow-up.

Format validation cannot catch a well-formed handle. `LumpyIceCream` passes every
mechanical check in §3.4 and always will. The copy is what prevents it, and if
the copy stops working the answer is to remove the question, not to build a
filter.

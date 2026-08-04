---
spec: sms-optional-consent
date: 2026-08-03
status: approved
trigger: >
  Twilio A2P 10DLC campaign rejection #3, "Forced Consent Violation" on
  https://www.drbartender.com/sms
lanes:
  - id: sms-optional-consent
    footprint:
      - client/src/pages/website/SmsOptInPage.js
      - client/src/index.css
      - server/routes/smsOptIn.js
      - server/routes/smsOptIn.test.js
    depends_on: []
    review: full-fleet
    review_reason: >
      Changes the write path of an UNAUTHENTICATED endpoint that INSERTs client
      rows, and adds a branch that creates a row WITHOUT recording consent. That
      branch must stamp communication_preferences.sms_enabled = false, which is
      the SOLE enforcement of an SMS opt-out on the send path. Getting it wrong
      mints textable rows that never consented, which is worse than the defect
      being fixed.
---

# SMS consent becomes optional on `/sms`

## Why

Twilio rejected the 10DLC campaign a third time. The first two were 30909 (CTA
could not be verified) and 30896 (form lacks a dedicated SMS opt-in checkbox).
This one is a **Forced Consent Violation**:

> Your current signup workflow asked to check the consent box and phone number is
> also mandatory which makes it forced consent. Action Required: Please modify
> your form mechanics to ensure SMS opt-in is entirely optional. Consumers must
> be provided an explicit skip option or a separate checkbox, allowing them to
> decline messaging and still utilize your business services.

They are right about the mechanics. `/sms` requires the phone number and requires
the checkbox, by deliberate design: the route comment reads "signing up for texts
is this page's only purpose, so an unticked box is an unfinished form, not a
decline."

That reasoning is sound as product design and fatal as compliance. The reviewer's
test is "can the consumer decline messaging and still use your business
services." On a page whose only action is SMS signup, the answer is structurally
no, and no rewording changes that. The page has to be submittable without the
checkbox.

Note that the two rules pull opposite ways. 30896 demanded a dedicated checkbox a
reviewer sees on landing; this one demands that same checkbox be skippable. The
only shape satisfying both is a form that does something real, with SMS as one
optional unchecked box on the first screen.

The consent sentence already ends "Consent is not a condition of purchase." On
this form that has been false since we shipped it. It becomes true.

## Decision

Keep `/sms` as a signup page. Make the checkbox optional. An unchecked submit
signs the person up for email updates and creates an ordinary lead row with SMS
off.

Rejected alternatives, recorded so they are not relitigated:

- **Turn `/sms` into a full contact form** with a message field and an inquiry
  email. Strongest compliance story, since a contact form is unambiguously a
  business service. Rejected as more surface than this rejection needs.
- **Move the checkbox onto `/quote` step 1.** The consent sentence says "at the
  mobile number provided" and the phone field lives on a later step, so making it
  coherent means restructuring the lead funnel. Not worth the risk to a working
  money path.

## Page

Field order does not change: phone, checkbox, name, email. That order is
load-bearing and documented in the component header. It keeps the checkbox in the
first screen on a real phone, and keeps "at the mobile number provided" referring
to a field already filled.

The checkbox itself does not move and its wording does not change. Still the only
checkbox, still SMS-only, still unchecked on load.

| Element | Change |
|---|---|
| Mobile number | Loses its asterisk. Hint: only needed if you want texts. Required only when the box is checked. |
| Consent checkbox | No longer blocks submit. Otherwise unchanged. |
| Name, email | Still required. They are what the email path runs on. |
| Heading and sub-line | Name both paths, so the skip is visible before scrolling. |
| Button | "Sign up for text updates" becomes "Sign me up". |
| Success card | Two variants, selected from local checkbox state. |

Checked keeps today's success card, including STOP, HELP and START. Unchecked
gets its own: we will email you, a link to `/quote`, and a line that texts can be
added later.

**Fold constraint.** The reworded sub-line must stay one line at 390px. If it
wraps to two, it pushes the checkbox down and reintroduces the below-the-fold
defect that caused the 30896 rejection. Verify at 390x664, 375x667 and 1366x720
using `document.elementFromPoint`, not bounding rects, because the sticky header
is ~180px and covers elements that are technically in the viewport. Note that 844
is an iPhone screen height, not its browser viewport.

## Server

### The hazard

`clients.communication_preferences` defaults `sms_enabled` to **true**, and
`clientDedup`'s INSERT never sets it. That flag is the sole enforcement of an SMS
opt-out on the send path; there is no per-number suppression list, and
`sendAndLogSms` sends whatever it is handed.

So an unchecked submit that merely created a row would mint a textable row with
no consent on record. That is strictly worse than the defect being fixed. **The
unchecked path must explicitly stamp `sms_enabled: false` on any row it
creates.**

It must stamp only that, and must never touch `sms_opt_out_at`. An unchecked box
means "did not ask," not "texted STOP." `recordSmsConsent` writes
`sms_opt_out_at` whenever `consented` is false (`smsConsent.js:118`), and a row
carrying that field is refused as `prior_opt_out` on every later opt-in attempt
(`smsConsent.js:130-145`). Stamping it would mean a person who simply never
ticked a box has to text START to undo it. **The unchecked path therefore never
calls `recordSmsConsent` at all.**

### Validation

- Name and email: required, unchanged.
- Phone: required only when consent is true. If consent is false and a phone is
  present anyway, its format is still validated, because we store it.
- Consent version: resolved only on the checked path. Skipping it when unchecked
  is uniform across every email, so it does not reopen the enumeration oracle
  closed on 2026-07-30.

### Transaction

The checked path is exactly what ships today and is not modified, including the
rollback-on-any-non-applied-outcome fix.

The unchecked path:

1. `findOrCreateClientDetailed(...)`, phone possibly null.
2. If the client already existed, `ROLLBACK` and return ok, writing nothing. This
   is the ownership rule (a public form may write only to a row the same submit
   INSERTed), and the rollback is also what undoes the email backfill that was
   the portal-takeover vector.
3. If the row is new, stamp `sms_enabled: false`, `COMMIT`, return ok.
4. No `sms_consent_log` row. There is no consent to log.

The response stays a generic `{ ok: true }` for every outcome. The page selects
its success card from local checkbox state, so nothing new leaks and the endpoint
does not become an oracle for "is this email one of your clients."

## Tests

Three existing tests assert the old required-checkbox contract and are rewritten
rather than deleted, because the behavior they guard still matters in its new
form:

| Test | New assertion |
|---|---|
| `an unticked box is a validation error and creates nothing` | An unticked box succeeds and creates an SMS-off row. |
| `an absent consent field is rejected, never treated as consent` | An absent consent field is still never treated as consent. It creates an SMS-off row. |
| `a truthy-but-not-true consent value does not opt anyone in` | Unchanged intent. A truthy-not-true value creates an SMS-off row, not a consented one. |

New coverage:

- A row created by an unchecked submit has `sms_enabled` false and
  `sms_opt_out_at` null.
- An unchecked submit against an existing client's email writes nothing at all.
- An unchecked submit with no phone succeeds.
- An unchecked submit with a malformed phone is rejected.
- A checked submit with no phone is rejected.

The two regression tests carrying the hazard (`sms_enabled` false /
`sms_opt_out_at` null, and the existing-client no-write) must be proven to fail
against the pre-change code before they are trusted, by the same
revert-watch-restore method used on 2026-07-30.

**Rate limiter.** The suite already burns 16 of `publicLimiter`'s 20 requests per
15-minute window, and the request helper carries a 429 tripwire. The new cases
push it past 20. Handle this in the test setup. Do not weaken the limiter, which
guards an unauthenticated endpoint that INSERTs rows.

## Out of scope

- The quote wizard. Its checkbox is already optional and stays where it is.
- Double opt-in / proof of phone ownership. Still open from the last spec, still
  not a blocker for this rejection.
- The `SMS_CONSENT_TAIL` JSX-divergence gap, documented in the constants header.

## Verification

1. Suites, from repo root with `node -r dotenv/config`.
2. `CI=true react-scripts build` for the client.
3. Fold checks at 390x664, 375x667, 1366x720 via `elementFromPoint`, plus
   screenshots: checkbox unchecked and hittable in the first screen, form
   submits with the box untouched.
4. Full review fleet, per the lane's `review` declaration.

## Shipping

The money batch (77 commits) is still unpushed and must not ship with this. Use
the cherry-pick recipe verified on 2026-07-30 and recorded in
`project-sms-optin-page`: build the lane, squash-merge to main, cherry-pick the
squash onto a detached worktree at `origin/main`, verify on that tree, and push
from that worktree so `.husky/pre-push` evaluates only these files.

## Owed to Dallas

Resubmit the campaign with `https://drbartender.com/sms` and a fresh screenshot
showing the unchecked box and the optional phone field.

---
spec: sms-opt-in-page
date: 2026-07-30
status: approved
trigger: Twilio A2P 10DLC campaign rejection, error 30896 (Opt-In Form Error)
lanes:
  - id: sms-optin
    footprint:
      - client/src/pages/website/SmsOptInPage.js
      - client/src/App.js
      - client/src/components/PublicLayout.js
      - client/src/pages/website/legal/PrivacyPage.js
      - client/src/index.css
      - server/routes/smsOptIn.js
      - server/routes/smsOptIn.test.js
      - server/index.js
      - README.md
      - ARCHITECTURE.md
    depends_on: []
    review: full-fleet
    review_reason: >
      Writes clients.communication_preferences (the SOLE enforcement of an SMS
      opt-out on the send path) from a new UNAUTHENTICATED endpoint, and mounts
      in server/index.js, which is on scripts/sensitive-paths.txt.
---

# Standalone SMS opt-in page (`/sms`)

## Why

Twilio rejected the 10DLC campaign a second time. The first rejection was 30909
(CTA could not be verified); this one is **30896**, "your website registration
form either completely lacks a dedicated SMS opt-in checkbox."

**The form is not actually non-compliant.** `YourInfoStep.js` already renders a
single dedicated checkbox, SMS-only (nothing bundled with terms acceptance),
unchecked by default off a hard-coded `sms_consent: false`, carrying the verbatim
CTIA sentence and both legal links. `/privacy` quotes the same string from the
same constant.

The defect is **discoverability**: the checkbox is on step 2 of a 5-step wizard,
behind Event Details. A reviewer opens `/quote`, sees no checkbox, and rejects.
We have now tried twice to fix this with prose in the `message_flow` spelling out
the click path. Reviewers do not click. Twilio's own remedy language concedes
this by asking for "hosted screenshots."

So: stop describing the checkbox, and put one where a reviewer lands.

## What

A standalone public page at **`drbartender.com/sms`** — a short, obvious URL that
can be handed to a reviewer directly and screenshotted for the campaign.

One screen, no navigation, no steps:

- Heading + one line of context.
- `Name`, `Email`, `Phone` — all three required.
- **One** dedicated checkbox rendering `SMS_CONSENT_CLIENT` verbatim from
  `client/src/constants/smsConsent.js`, with the Privacy Policy and Terms links.
- Submit, then a success state naming STOP and HELP.

Email is required even though it feels like one field too many on an SMS page:
`findOrCreateClientDetailed` resolves client rows by email, and
`recordSmsConsent` needs a `clientId`.

### Decisions

**The box is required to submit.** Signing up for texts is this page's entire
purpose, so an unticked box is a validation error, not a decline. Side benefit:
this door can never stamp the plantable hard `sms_opt_out_at` that remains an
open semantics question on the wizard (see
`project-legal-pages-sms-consent`), because it never records a decline.

**No new consent version.** Same `v1` string, one constant, so the sentence on
`/sms`, the wizard, and `/privacy` stay byte-identical — exactly the comparison a
reviewer makes. `server/utils/smsConsent.test.js` already fails on drift.

**No notification on submit.** Dallas's call: signups sit in the consent log. We
already have a record of live leads.

**`source: 'website'` on the client row**, not a new value. `clients.source`
carries a CHECK constraint whose live definition is a migration block in
`schema.sql`; a new enum value would drag a sensitive-path DDL change into a
one-page feature for no benefit. `sms_consent_log.source_form` is free text, so
`'sms_page'` distinguishes these rows where it actually matters.

**Findability, since that is the literal bug:** footer link in `PublicLayout.js`
alongside Privacy and Terms, plus a pointer to `/sms` in the Text messaging
section of `/privacy`.

## Server

New `POST /api/sms/opt-in` in its own file, `server/routes/smsOptIn.js`. Not
inside `server/routes/sms.js` — that file is on the sensitive-paths list and
holds inbound webhook + admin manual reply; widening it for a public form is
gratuitous blast radius.

`publicLimiter` (20 / 15 min / IP, the same limiter the wizard's public writes
use). Inside one transaction on one pooled connection:

1. Validate name, email, phone present; `sms_consent === true` required.
2. `findOrCreateClientDetailed(dbClient, { source: 'website' })`.
3. `recordSmsConsent(dbClient, { subjectIsNew: created, sourceForm: 'sms_page' })`.
4. **Fail-safe SMS default**, mirroring `proposals/public.js` exactly: if the row
   is new and this submit did not record an affirmative opt-in
   (`consent.consented && outcome.applied`), force `sms_enabled:false`. Soft-off,
   no `sms_opt_out_at` stamp. This is not theoretical — `clients` defaults
   `sms_enabled` to `true`, `clientDedup`'s INSERT never sets it, and
   `prior_opt_out` / `unknown_version` both reach step 4 having written nothing,
   which would leave a brand-new row SMS-on with no recorded consent and, on
   `prior_opt_out`, text a number under an active STOP.
5. Sentry breadcrumb on the notable non-recording reasons, same NOTABLE set as
   the wizard (`unknown_version`, `prior_opt_out`, `no_phone`).

**Response is a generic 200 regardless of consent outcome**, so the form cannot
be used to probe whether an email belongs to an existing client. Field-level 400s
for missing input are fine; those leak nothing.

## Known consequence (accepted, stated once)

The ownership rule stands untouched: a **returning** client who submits this form
gets the success screen but no recorded opt-in, because we will not mutate a row
this submit did not create. Their route in is texting START, which is
self-proving since it originates from the phone itself. Success copy names
STOP/HELP for everyone, so nothing is leaked either way.

## Out of scope

- Changing the wizard checkbox or its placement.
- Any change to the ownership rule, the phone-scoped STOP guard, or the
  unchecked-box-stamps-a-hard-opt-out question.
- Staff SMS consent (`agreements.sms_consent`), a separate approved gate.
- The campaign resubmission itself (Dallas: opt-in URL `https://drbartender.com/sms`
  plus a screenshot of that page).

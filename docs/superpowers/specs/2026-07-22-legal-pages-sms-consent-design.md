# Public legal pages and SMS consent capture (design)

Date: 2026-07-22
Status: approved in brainstorm (section-by-section)
Driver: Twilio A2P campaign submission. The campaign form requires a publicly
reachable opt-in surface and a privacy policy URL carrying the mobile-data
sharing language. Neither exists today.

## Problem

1. `client/src/components/PublicLayout.js:203` renders "Privacy · Terms ·
   Accessibility" as plain text. There are no anchors, no routes, and no page
   components anywhere in `client/src`. A reviewer following the footer finds
   nothing.
2. Neither form that collects a phone number asks for SMS consent. The quote
   wizard collects `client_phone` (`client/src/pages/website/quoteWizard/
   QuoteWizard.js:73`, surfaced in `steps/YourInfoStep.js`) and the staff
   application collects `phone` (`client/src/pages/Application.js:272`).
3. Consent today is assumed, never recorded. `clients.communication_preferences`
   defaults to `{"sms_enabled":true,...}` (`server/db/schema.sql:2489`) and the
   same default exists for users at line 2540. The only thing that ever flips it
   is an inbound STOP.

## Current behavior (verified 2026-07-22)

- `server/utils/smsInbound.js:10` recognizes STOP, UNSUBSCRIBE, END, CANCEL,
  QUIT and START, UNSTOP, YES. There is no HELP keyword in the app.
- `smsInbound.js:269` writes `sms_opt_in_at` / `sms_opt_out_at` into the
  `communication_preferences` jsonb as a STOP/START audit trail. That is the
  existing timestamp convention and this spec reuses it.
- `server/utils/channelFallback.js` treats `sms_enabled: false` as "SMS not
  usable" and substitutes email for operational touches. Suppression only
  happens for the `marketing` category.
- `/quote` is public (`client/src/App.js:331` and `:508`). `/apply` is behind
  `ProtectedRoute` (`:371` and `:529`), so its checkbox is not reviewer-visible.
- No third-party analytics or advertising trackers exist. `client/public/
  index.html` carries no gtag, GTM, or pixel. The only "analytics" matches in
  the client are internal admin email dashboards.
- The staff application collects no SSN, date of birth, or tax ID.
- Third parties actually in the stack, from `package.json`: Stripe, Twilio,
  Resend, Sentry, AWS S3 SDK (Cloudflare R2), web-push, svix. Plus Google Places
  (`server/utils/googlePlaces.js`), Neon, and the hosting platform.
- `client/src/pages/website/FaqPage.js:70` states hosted packages include the
  alcohol and BYOB does not.

## Decisions taken in brainstorm

1. **Terms is a website terms of use, not booking terms.** Restating
   cancellation, deposits, or refunds publicly would duplicate the executed
   Event Services Agreement and drift from it. The page defers to the agreement
   and says the agreement controls on conflict.
2. **Existing contacts are grandfathered.** Current behavior is untouched. They
   supplied their numbers during an active booking or an accepted shift and the
   messages are transactional. A re-consent sweep would silence live event
   comms.
3. **"Accessibility" comes out of the footer.** It currently advertises a page
   that does not exist. A real accessibility statement is separate work.
4. **No alcohol clause in the Terms.** Boilerplate for this industry asserts the
   company never sells or furnishes alcohol, which is false for hosted packages.
   Alcohol stays in the signed agreement.

## Design

### Pages

Two public routes, `/privacy` and `/terms`, inside the existing website shell so
they inherit `PublicLayout` and its footer.

New files under `client/src/pages/website/legal/`:

- `LegalLayout.js`: heading, "Last updated" line, prose typography wrapper. Both
  pages render through it so they cannot drift visually.
- `PrivacyPage.js`
- `TermsPage.js`

Both routes register in each of the two route trees in `App.js`, the logged-out
tree near line 331 and the logged-in tree near line 508, the same way `/quote`
appears in both. Both are lazy-loaded, matching the surrounding website pages.

### Footer

`PublicLayout.js:203` becomes real `Link` elements to `/privacy` and `/terms`.
The bare "Accessibility" label and one separator are removed.

### One source for the consent copy

`client/src/constants/smsConsent.js` exports the versioned strings:

```js
export const SMS_CONSENT_VERSION = 'v1';
export const SMS_CONSENT_CLIENT = '...';   // exact text, below
export const SMS_CONSENT_STAFF = '...';    // exact text, below
```

The quote wizard checkbox, the staff application checkbox, and the Privacy
Policy SMS section all render from this module. The string a reviewer reads on
`/privacy` and the string a user clicks are the same literal.

`server/data/smsConsentCopy.js` holds the canonical text keyed by version. The
browser submits only `sms_consent` and `sms_consent_version`; the server writes
its own canonical text into the audit row. An audit record must never store text
the client supplied.

A node test reads the client constant file and asserts both strings match the
server map for the current version, so the halves cannot silently diverge.

### Consent record

Two writes on submit.

**Preference**, reusing the existing convention: set
`communication_preferences.sms_enabled` to the checkbox value and stamp
`sms_opt_in_at` in the same jsonb, the same keys `smsInbound.js:269` writes.

**Audit**, append-only, new table appended to `server/db/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS sms_consent_log (
  id BIGSERIAL PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  phone TEXT NOT NULL,
  consented BOOLEAN NOT NULL,
  copy_version TEXT NOT NULL,
  copy_text TEXT NOT NULL,
  source_form TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sms_consent_log_phone_created_at
  ON sms_consent_log(phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_consent_log_client
  ON sms_consent_log(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_consent_log_user
  ON sms_consent_log(user_id, created_at DESC);
```

Both FKs are `ON DELETE SET NULL` and `phone` is retained, so the compliance
record survives deletion of the subject. Phone lookup is the index that matters:
a carrier dispute arrives as a phone number.

`source_form` is `'quote_wizard'` or `'staff_application'`.

### Unchecked is not an error

Leaving the box unchecked writes `sms_enabled: false` and logs `consented:
false`. `channelFallback.js` already substitutes email for operational touches.
No submit is blocked and no flow breaks.

## Copy

### Client checkbox (quote wizard, unchecked by default)

> Text me about my event. I agree to receive text messages from Dr. Bartender
> about my quote, booking, payments, and event details at the mobile number
> provided. Message frequency varies. Msg & data rates may apply. Reply STOP to
> opt out, HELP for help. Consent is not a condition of purchase. See our
> Privacy Policy and Terms.

### Staff checkbox (application, unchecked by default)

> Text me about shifts. I agree to receive text messages from Dr. Bartender
> about shift offers, schedule changes, and event day logistics at the mobile
> number provided. Message frequency varies. Msg & data rates may apply. Reply
> STOP to opt out, HELP for help. Consent is not a condition of hiring or
> employment. See our Privacy Policy and Terms.

Both render "Privacy Policy" and "Terms" as links to the new routes.

### Privacy Policy, Text Messaging section

> If you provide your mobile number and check the SMS consent box on our quote
> form or staff application, Dr. Bartender may send you text messages. Clients
> receive messages about quotes, bookings, payments, and event details. Staff
> receive messages about shift offers, schedule changes, and event day
> logistics. Message frequency varies. Message and data rates may apply. Reply
> STOP to any message to opt out, or reply HELP for help.
>
> We do not sell your personal information. No mobile information will be shared
> with third parties or affiliates for marketing or promotional purposes. Text
> messaging originator opt-in data and consent are never shared with any third
> party. We disclose phone numbers only to the service providers that transmit
> our messages on our behalf, such as Twilio, and only for that purpose.
>
> You may opt out at any time by replying STOP to any text message or emailing
> contact@drbartender.com. Opting out of text messages does not affect your
> booking or your employment.

The middle paragraph is what carriers look for. It is not to be trimmed.

This section also quotes both checkbox strings verbatim, because `/apply` is
behind auth and the quote checkbox is several steps into a wizard. `/privacy` is
then the single public URL that evidences both opt-ins.

### Privacy Policy, remaining sections

Who we are and scope. What we collect, in three groups: clients (name, email,
phone, event date, venue address, guest count, drink preferences); applicants
and staff (name, email, phone, experience, availability, emergency contact,
payment handle for payouts); automatic (server logs, error diagnostics). A line
that leads also arrive from Thumbtack. Explicit statements that card numbers are
handled by Stripe and never reach our servers, and that the site runs no
advertising or analytics trackers. Text Messaging. Email. Cookies, session and
authentication only. Sharing, naming Stripe, Twilio, Resend, Google Places,
Sentry, Cloudflare R2, Neon, and the hosting platform with what each does, plus
a statement that we do not sell personal information. Retention. Your choices
and how to exercise them. Security. Not directed to children. Changes. Contact
at contact@drbartender.com, Dr. Bartender LLC, Chicago, IL.

### Terms of Use sections

Acceptance. What the site does, including that a quote is not a booking and
nothing binds either side until the Event Services Agreement is signed and
payment is made. Accounts and credentials. Acceptable use. Intellectual
property covering site content, photography, and recipes. Communications,
pointing at the Privacy Policy. Warranty disclaimer. Limitation of liability.
Indemnity. Illinois governing law, venue in Cook County. Changes. Contact.

Load-bearing clause: booking, cancellation, refunds, staffing, and service terms
are governed solely by the signed Event Services Agreement, and where that
agreement conflicts with this page, the agreement controls.

Both pages carry a visible "Last updated" date.

## Testing

- Node test asserting client constant and server copy map agree for the current
  version.
- Server tests: quote submit with consent true writes `sms_enabled: true`,
  `sms_opt_in_at`, and one `sms_consent_log` row with the server-side canonical
  text; consent false writes `sms_enabled: false` and a `consented: false` row;
  a forged `copy_text` in the request body is ignored.
- Staff application submit, same three cases.
- Client build gate: `CI=true react-scripts build` before any push, per the
  pre-push hook.

## Out of scope

- Accessibility statement page.
- Re-consent of existing clients or staff.
- HELP keyword handling in `smsInbound.js`. Twilio Advanced Opt-Out answers HELP
  at the Messaging Service level; confirm it is enabled before submitting the
  campaign. Tracked as an operator check, not a code change here.
- Any change to booking, cancellation, or refund logic.

## Legal note

This copy describes what the code actually does and follows standard practice.
It is not legal advice. Have counsel read the Terms before relying on it in a
dispute.

# Onboarding: upload failures and lost work

Date: 2026-07-26
Status: approved
Origin: live incident, 2026-07-23 / 07-24

## What happened

A recruit was hired directly by text on 2026-07-23 and sent the pre-hire onboarding
link. Over the next seven hours she made three separate accounts and never completed
the application. She reported two symptoms: "I keep getting network error" while
submitting, and later "I can't get it to upload my resume."

Reconstructed from the DB against her SMS timeline (all times America/Chicago):

| Time | Event |
|---|---|
| Thu 2:38 PM | Sent the onboarding link |
| Thu 2:48 PM | Account #241 created |
| Thu 8:22 PM | "I keep getting network error" |
| Thu 8:25 PM | Account #242 created |
| Thu 9:40 PM | "I can't get it to upload my resume" |
| Thu 10:12 PM | Account #243 created |
| Fri 7:24 AM | #241 reopened |
| Fri 3:21 PM | #243 reopened |

Every new account lands within minutes of a failure. She was not confused about
having an account. She concluded, reasonably, that the account was broken.

She was unblocked manually by being sent straight to `/welcome`, which bypasses the
application entirely. That was a one-off workaround, not the fix.

## Root cause

Three defects compound.

**1. Oversized uploads fail as "network error."**

`server/index.js` configures `express-fileupload` with `abortOnLimit: true` at a
10MB per-file cap. When a file exceeds the cap the server answers 413 and resets
the stream while the browser is still sending the request body. The browser never
reads the 413. `client/src/utils/api.js:22` sees no response at all and renders
"Network error. Check your connection."

Reproduced against production:

| Upload | Result |
|---|---|
| 2MB | `http=401`, full body uploaded (2,000,323 bytes) |
| 12MB | `http=413`, upload cut off at 11,632,385 of 12,000,009 bytes, stream reset |

`FileUpload.js` performs no size check at pick time, so the user waits through a
full upload before being told, incorrectly, that their connection failed. On mobile
this is easy to hit: phone-scanned PDFs and full-resolution photos routinely exceed
10MB.

**2. The resume field silently excludes the format most resumes are in.**

The resume `FileUpload` passes no `accept`, so it falls back to
`.pdf,.jpg,.jpeg,.png` (`FileUpload.js:96`). iOS greys out non-matching files in the
Files picker with no explanation, so a `.docx` resume cannot be selected at all.
`fileValidation.js` accepts only PDF, JPEG, PNG and WebP by magic bytes, so a `.heic`
photo from iCloud Drive is rejected server-side.

**3. The application form has no persistence.**

`client/src/pages/Application.js` is 685 lines across eight sections and saves
nothing. No localStorage, no server draft. Every failed submit discards all of it.
This is the amplifier that turned one bad upload into three accounts.

Browser-local persistence would not have helped: she moved from her phone to a
laptop partway through. Only draft state tied to her account survives that.

## Principle

**A field may block submission only if the user can reliably complete it.**

Radio buttons and text inputs qualify. A multi-megabyte file upload over cellular
does not.

## Scope

The application form stays. An earlier draft of this design proposed routing
pre-hires past it; that was wrong. `applications` holds operational data that
`contractor_profiles` has no column for:

`positions_interested`, `available_saturdays`, `other_commitments`,
`comfortable_working_alone`, `setup_confidence`, nine `tools_*` columns, and the
experience fields. On a book that is mostly single-bartender events,
`comfortable_working_alone` is load-bearing.

The form is needed. It just must not be able to trap someone.

### Change 1: uploads succeed

`client/src/components/FileUpload.js` is shared by all three onboarding forms, so
this is one component change covering every surface.

- **Downscale images at pick time.** An image over ~1.5MB is drawn to a canvas at a
  2000px longest edge and exported as JPEG at q0.85. A 14MB phone photo of a
  certification card becomes roughly 300KB and stays perfectly legible. The user
  sees no error because there is no error.
- **HEIC fallback.** Safari decodes HEIC to canvas; Chrome does not. Where decode
  fails, pass the original through and let the size check apply. HEIC matters most
  on iOS, which is where it works.
- **Add a separate onboarding-document validator** in
  `server/utils/fileValidation.js` covering HEIC (`ftypheic` / `ftypheix` /
  `ftypmif1` at offset 4), DOC (OLE magic) and DOCX (PK zip magic). Container
  formats are accepted only when the magic bytes and the file extension agree, so
  PK magic alone does not admit arbitrary zips.

  Revised during planning. The original plan was to widen `isValidUpload` in
  place, which is wrong: it is shared by seven call sites including the W-9
  (`payment.js:91`), blog images (`admin/blog.js:176`) and staff portal uploads
  (`staffPortal.js:692`). Widening it would let a `.docx` through as a blog
  image. The new `isValidOnboardingDocument` is used only for the resume and
  alcohol certification on the two onboarding forms. Headshots stay on
  `isValidUpload` so they remain renderable images, and `isValidImageUpload`
  (drink plans) is untouched.
- **Honest rejection as a floor.** Anything still over the limit after downscaling
  (realistically only a very large PDF) is rejected at pick time, before any bytes
  are sent, naming the actual size and the actual limit.
- **A `limitHandler`** on `express-fileupload` so the server-side path stops being
  silent. `abortOnLimit: true` stays; it is the abuse backstop, and removing it means
  buffering unbounded uploads in memory.

The client limit lives in one shared constant tied by comment to `MAX_FILE_SIZE`.
If the two drift, the bad experience returns, so they are documented together.

### Change 2: nothing is lost

New table:

```sql
CREATE TABLE IF NOT EXISTS onboarding_drafts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  form_key VARCHAR(50) NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, form_key)
);
```

`form_key` is allowlisted to `application` and `contractor_profile`.

Endpoints join the existing `server/routes/progress.js` (49 lines, room to grow):

- `GET /api/progress/draft/:formKey`
- `PUT /api/progress/draft/:formKey`
- `DELETE /api/progress/draft/:formKey` on successful submit

Every query is scoped to `req.user.id`. The stored payload is capped (64KB) so a
draft cannot be used as free storage under the global 1MB JSON limit.

Client side, a `useFormDraft(formKey, form, setForm)` hook loads on mount, saves on a
1.5s idle debounce, and clears on submit success. Restoring shows a visible notice
with the saved time rather than silently repopulating fields.

**Ordering rule:** `ContractorProfile` loads existing server data before any draft
exists, so on conflict the draft wins. It is by definition written after the load.

Files are not drafted. Re-picking a file after a reload is unavoidable without a much
larger change, and it matters less than it sounds: files are the last section, and
React already holds them across a failed submit. Only a reload loses them.

**Payday protocols is excluded entirely.** It holds SSN and bank routing and account
numbers, which are encrypted at rest today. A draft table would be a second, plaintext
copy of exactly the data we deliberately encrypt. The form is short enough that
retyping it is not the same insult as retyping eight sections.

### Change 3: files stop blocking submit

`server/routes/application.js:126-128` currently throws when `resume_url` or
`basset_url` is absent. That block is removed. Every other required field on the form
stays required exactly as it is.

Client-side, the matching `test:` rules for `resume` and `basset` come off, replaced
by a notice that these are still needed before a first shift.

Outstanding documents are **derived, not stored.** No new status column. A user owes
documents when the relevant `*_file_url` is null. Surfaced in two places:

- **Staff side:** a persistent to-do card linking to the contractor profile page,
  which already carries all three uploads as optional fields. No new page.
- **Admin side:** a flag in `client/src/pages/admin/overview/NeedsYouStrip.js` and on
  `AdminUserDetail`, plus a count in the `/hiring/summary` KPI strip.

A form gate a recruit physically cannot pass does not protect the business. It loses
a bartender quietly. A flag on the admin's screen actually reports who is short.

## Non-goals

- **Sentry.** Being handled in a separate window. Noted here only because the
  relevant issue (`DRBARTENDER-SERVER-M`, "Unexpected end of form", 52 events between
  2026-05-22 and 2026-07-14) is muted, and the 413 abort path emits nothing at all.
- **Routing pre-hires past the application.** Explicitly rejected above.
- **Drafts on payday protocols.**
- **Uploading files immediately on pick.** Correct architecture, larger change,
  introduces orphan management in R2. Not needed to fix what broke.
- **Converting DOC/DOCX to PDF server-side.**
- **BASSET expiry handling.** `alcohol_certification_expires_on` exists; "missing"
  is the predicate for now, not "missing or expired."

## Risks

- Widening the upload allowlist is security-adjacent. Accepting DOC and DOCX means
  accepting OLE and zip containers, stored in R2 and opened only by an admin through
  a signed URL. Comparable to receiving a resume by email, mitigated by pairing magic
  bytes with extension. Requires full fleet review.
- HEIC canvas decode is browser-dependent. The fallback path must be exercised.
- Draft restore versus server-loaded profile data is the subtlest part of Change 2
  and needs a test.
- The client and server size limits are two constants that must agree.

## Lanes

| Lane | Scope | Review |
|---|---|---|
| A | Uploads: `FileUpload.js`, `fileValidation.js`, `index.js` limitHandler | Full fleet (file validation is a sensitive path) |
| B | Drafts: schema, `progress.js`, `useFormDraft`, two forms | Full (new table) |
| C | Deferrable files: `application.js`, `Application.js`, admin and staff surfacing | Standard |

B and C both touch `Application.js`. Sequence B before C, or build them as one lane,
rather than merging two lanes into the same file.

## Open item

The recruit who triggered this was unblocked via `/welcome`, which skips the
application. She will finish onboarding with no `positions_interested`, no
availability, no `comfortable_working_alone` answer, and no BASSET on file. That data
must be collected from her separately once this ships, or she sits in the system as a
bartender with no profile behind her.

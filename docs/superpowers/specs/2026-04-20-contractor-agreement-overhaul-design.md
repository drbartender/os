# Contractor Agreement Overhaul — Design Spec

**Date:** 2026-04-20
**Author:** Dallas (with Claude)
**Status:** Approved for implementation plan
**Document version target:** `contractor-agreement-v2`

---

## Context

The current `Agreement.js` page is a short plain-English contractor agreement with five bullet points and one non-solicitation clause. The user's lawyer reviewed it (notes in `DRB_OS/temp/contractor_agreement _SP_notes.txt`) and recommended substantially stronger language covering: non-solicitation (expanded), independent-contractor relationship, representations & warranties, indemnification, limitation of liability, assignment, modifications/severability/waiver, 1099/tax language, compensation scope ("hours worked + applicable gratuity"), and damage recoupment.

This spec overhauls the agreement to incorporate all lawyer-provided language while keeping the onboarding UX simple and self-explanatory.

## Goals

- Incorporate every lawyer-recommended clause with the exact language they provided (verbatim where provided; consistent style for drafted additions).
- Keep the applicant experience simple and self-explanatory.
- Produce an immutable, court-ready signed artifact (PDF) delivered to the contractor by email and accessible from their staff portal.
- Version the legal text so historical signers (v1) remain valid and future revisions are straightforward.
- No forced re-sign for v1 signers today. The user will import current staff with historical docs later and trigger re-onboarding manually during busy season.

## Non-Goals

- Does not force existing v1 signers to re-sign.
- Does not include a contractor-facing "re-sign required" gate (handled manually later via `onboarding_progress` reset).
- Does not address the FieldGuide appearance-protocols CSS bug flagged in the lawyer's notes (tracked separately).

---

## UX / Flow

### Page structure (`/agreement`, step 3 of 6)

1. **Header** — *"Step 3 of 6 / Independent Contractor Agreement / This is the contract between you and Dr. Bartender. Please read it carefully — you can come back to it later from your staff portal."*
2. **"At a Glance" summary card** (green-tinted, labeled *"This box is a plain-English summary. The full contract is below — that's what you're signing."*). 6 bullets.
3. **Full formal agreement** — all 11 clauses visible, no collapsibles. Each clause: friendly header (e.g., *"1. Independent Contractor Relationship"*), one italic plain-English lead-in line, then lawyer's formal paragraph(s) below. Single continuous scroll.
4. **Personal details form** — full name, email, phone, SMS consent (unchanged fields).
5. **Acknowledgments block** — 6 per-clause checkboxes, each one idea, plain-English labels.
6. **Signature pad** — draw or type. The signature is the master assent.
7. **Submit button** — *"Sign & Continue →"*.

### "At a Glance" summary bullets

- You're an independent contractor, not an employee — you run your own business.
- Each event is its own gig. You choose which to accept; once you commit, you're expected to complete it.
- You're paid for actual hours worked plus any gratuity. You handle your own taxes.
- Dr. Bartender issues a 1099 only if your annual earnings cross the IRS threshold.
- You can't solicit Dr. Bartender's clients, venues, or other contractors — during your time with us and for 12 months after.
- If you damage our equipment through willful misconduct or gross negligence, we may recoup the cost. Ordinary accidents aren't subject to that.

### Acknowledgment checkboxes (stored as booleans)

| DB key | Plain-English label |
|---|---|
| `ack_ic_status` | I am working with Dr. Bartender as an independent contractor, not an employee, and am responsible for my own taxes. |
| `ack_commitment` | If I accept an event assignment, I will complete it to professional standards with my own tools. |
| `ack_non_solicit` | I will not solicit Dr. Bartender's clients, venues, or other contractors during my time with the company or for 12 months after. |
| `ack_damage_recoupment` | I understand Dr. Bartender may recoup the replacement cost of company-provided equipment I damage through willful misconduct or gross negligence. |
| `ack_legal_protections` | I have read and agree to Sections 6, 7, and 8 above (Representations & Warranties, Indemnification, Limitation of Liability). |
| `ack_field_guide` | I have read the Dr. Bartender Field Guide and will follow its protocols. |

### Validation

- Any unchecked acknowledgment → red outline + inline `<FieldError>` below the checkbox: *"This acknowledgment is required."*
- Missing signature → red `<FormBanner>` at top of acknowledgment block: *"Please sign below before submitting."*
- Error banner auto-scrolls into view (existing `<FormBanner>` behavior).

### Submit response → redirect

On success, client receives `{ agreement, pdf_url }`, shows success toast, redirects to `/contractor-profile`.

---

## Legal text (v2)

The 11 formal clauses, with friendly headers, plain-English lead-in, and lawyer language preserved. Source of truth: `server/data/contractorAgreement.js` (see Technical Design).

### 1. Independent Contractor Relationship

*In plain English: you're your own boss. We tell you what the job is, not how to do it.*

> Contractor is an independent contractor providing the Services, which are outside the Company's usual course of business. Nothing in this Agreement will be construed as establishing an employment or agency relationship between Company and Contractor. Contractor has no authority to bind Company by contract or otherwise. Contractor will perform Services under the general direction of Company, but Contractor will determine the manner and means by which Services are accomplished. Dr. Bartender does not control the way in which Services are performed but has discretion to determine whether the final product is acceptable.

### 2. Each Event Is a Separate Project

*In plain English: each gig stands on its own. You're free to apply, accept, or decline any event — but once you commit, you're expected to see it through.*

> Each assignment constitutes a separate "project" governed by the event specifics and needs as outlined in the applicable event application. Contractor is free to apply for any event, and to accept or decline any assignment; however, Contractor is expected to carry out any events to which Contractor has committed.

### 3. Compensation & Taxes

*In plain English: you're paid for hours worked plus tips. You cover your own taxes. We'll issue a 1099 if you cross the IRS threshold.*

> Contractor will be compensated for actual hours worked plus applicable gratuity, as set out in each engagement. Additional time must be pre-approved by Company to be compensable. Contractor is solely responsible for all federal, state, and local taxes on amounts received under this Agreement. Company will issue IRS Form 1099 (or its then-current equivalent) if total calendar-year payments to Contractor exceed the applicable IRS reporting threshold. Contractor acknowledges that Contractor is not entitled to employee benefits (including health insurance, retirement plans, paid time off, workers' compensation, or unemployment) from Company.

### 4. Tools, Equipment & Damage Recoupment

*In plain English: bring your own kit. If we loan you gear and you damage it through willful misconduct or gross negligence, we may recoup the cost. Ordinary accidents are on us.*

> Contractor will supply, at Contractor's own expense, all materials, supplies, equipment, and tools required to provide the Services and accomplish the work agreed to be performed under this Agreement, except where Company has agreed in writing to provide specific items. Contractor is responsible for the reasonable replacement cost of Company-provided equipment or product damaged through Contractor's willful misconduct or gross negligence. Company may, at its discretion, deduct such costs from unpaid amounts owed to Contractor or invoice Contractor directly. Ordinary accidents and normal wear and tear are not subject to recoupment.

### 5. Non-Solicitation

*In plain English: while you're working with us — and for one year after — you don't poach our clients, venues, or other contractors for your own side work.*

> During the term of this Agreement and for a period of one (1) year thereafter, Contractor will not, directly or indirectly, solicit the services of any Company personnel or other contractors, or directly or indirectly attempt to solicit any Company clients, for Contractor's own benefit or for the benefit of any other person or entity.

### 6. Representations & Warranties

*In plain English: we each confirm we're legit and can enter this contract. You also confirm your work is professional, is yours, and doesn't step on anyone else's rights.*

> **Mutual.** Each party represents and warrants to the other that: (a) it has the legal power and authority to enter into this Agreement; and (b) it will comply with all applicable laws in performing its obligations under this Agreement.
>
> **From Contractor.** Contractor represents and warrants to Company that:
> - Contractor will perform the Services in a timely, competent, and professional manner, consistent with high professional and industry standards, with the requisite training, background, experience, technical knowledge, and skills to perform the Services;
> - Contractor has no pre-existing obligations or commitments (and will not assume or otherwise undertake any obligations or commitments) that would be in conflict or inconsistent with, or that would hinder Contractor's performance of, Contractor's obligations under this Agreement;
> - the Work Product does not and will not infringe or misappropriate anyone else's patent, copyright, trademark, trade secret, right of privacy or publicity, or other intellectual or proprietary right;
> - the Work Product will conform to the requirements of the applicable event or engagement; and
> - Contractor has all rights necessary — including all federal, state, and local business permits and licenses, and any applicable alcohol-service certification (BASSET, TIPS, ServSafe Alcohol, or equivalent) — to perform the Services.

### 7. Indemnification

*In plain English: if a third party sues Dr. Bartender because of something you did, you cover it.*

> Contractor will indemnify and hold harmless Company from and against all claims, damages, losses, and expenses, including court costs and reasonable attorneys' fees, arising out of or resulting from, and, at Company's option, Contractor will defend Company against any action by a third party against Company that is based on:
> - a claim that any Service, the results of any Service (including any Work Product), or Company's use thereof, infringes, misappropriates, or violates a third party's intellectual property rights;
> - a breach or alleged breach by Contractor of Section 6 (Representations & Warranties); or
> - any negligent act or omission, or reckless or willful conduct, of Contractor that results in (i) bodily injury, sickness, disease, or death; (ii) injury to or destruction of tangible or intangible property (including computer programs and data) or any loss of use resulting therefrom; or (iii) the violation of any applicable laws.

### 8. Limitation of Liability

*In plain English: Dr. Bartender isn't on the hook for lost profits or other indirect damages, even if informed about the possibility.*

> Under no circumstances will Company be liable for lost profits or revenues (whether direct or indirect), or for consequential, special, indirect, exemplary, punitive, or incidental damages relating to this Agreement, even if Company is informed of the possibility of these types of damages in advance.

### 9. Assignment

*In plain English: you can't hand this contract off to someone else. Dr. Bartender can, if the business is sold.*

> Contractor may not assign or transfer any of Contractor's rights or delegate any of Contractor's obligations under this Agreement, in whole or in part, without Company's express prior written consent. Any attempted assignment, transfer, or delegation without such consent will be void. Company may assign or transfer this Agreement in connection with the sale of all or substantially all of its business or assets to which this Agreement relates. Subject to the foregoing, this Agreement will be binding upon and will inure to the benefit of the parties' permitted successors and assigns.

### 10. Modifications, Severability & Waiver

*In plain English: changes must be in writing. If a court tosses one clause, the rest still holds.*

> Any waiver, modification, or change to this Agreement must be in writing and signed or electronically accepted by each party. If any term of this Agreement is determined to be invalid or unenforceable by a relevant court or governing body, the remaining terms of this Agreement will remain in full force and effect. The failure of a party to enforce a term, or to exercise an option or right, in this Agreement will not constitute a waiver by that party of the term, option, or right.

### 11. Field Guide Compliance

*In plain English: you've read the Field Guide and will follow the protocols in it (appearance, timing, sobriety, alcohol laws, incident reporting, etc.).*

> Contractor acknowledges having read and understood the Dr. Bartender Field Guide, which sets out operational expectations including appearance, tools, timing, tips, boundaries, alcohol-service laws, sobriety policy, incident reporting, social media, and harassment policies. Compliance with the Field Guide is a condition of performing Services under this Agreement. The Company may update the Field Guide from time to time; material changes will be communicated to Contractor.

---

## Technical Design

### Data architecture

Single source of truth for legal text: `server/data/contractorAgreement.js`.

```js
module.exports = {
  CURRENT_VERSION: 'contractor-agreement-v2',
  versions: {
    'contractor-agreement-v2': {
      version: 'contractor-agreement-v2',
      effective_date: '2026-04-20',
      at_a_glance: [ /* 6 plain-English bullets */ ],
      clauses: [
        {
          number: 1,
          title: 'Independent Contractor Relationship',
          plain: 'In plain English: ...',
          formal: 'Contractor is an independent contractor ...'
        },
        // ... clauses 2–11
      ],
      acknowledgments: [
        { key: 'ack_ic_status',            label: 'I am working with Dr. Bartender as an independent contractor ...' },
        { key: 'ack_commitment',           label: 'If I accept an event assignment ...' },
        { key: 'ack_non_solicit',          label: 'I will not solicit ...' },
        { key: 'ack_damage_recoupment',    label: 'I understand Dr. Bartender may recoup ...' },
        { key: 'ack_legal_protections',    label: 'I have read and agree to Sections 6, 7, and 8 ...' },
        { key: 'ack_field_guide',          label: 'I have read the Dr. Bartender Field Guide ...' },
      ]
    }
    // Future: 'contractor-agreement-v3': { ... }
  }
};
```

The React page fetches the current version via `GET /api/agreement/legal-text` on mount and renders from the returned data. Future legal-text edits require only a server-side change + redeploy; the acknowledgments list is also driven by this data, so the React form adapts automatically to the ack keys the server declares.

### Database schema changes

All additive and idempotent. New columns added to the existing `agreements` table:

```sql
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS ack_ic_status BOOLEAN;
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS ack_commitment BOOLEAN;
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS ack_non_solicit BOOLEAN;
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS ack_damage_recoupment BOOLEAN;
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS ack_legal_protections BOOLEAN;
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS ack_field_guide BOOLEAN;
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS pdf_storage_key VARCHAR(500);
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS pdf_generated_at TIMESTAMPTZ;
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS pdf_email_sent_at TIMESTAMPTZ;
```

The existing columns `acknowledged_field_guide` and `agreed_non_solicitation` remain untouched for v1 historical records. v2 signers populate the `ack_*` columns and leave old columns NULL. Read code uses `signature_document_version` to determine which columns are meaningful.

### Server-side PDF generation

- Add `pdfkit` (~50KB, industry standard Node PDF library) to root `package.json` dependencies.
- New file: `server/utils/agreementPdf.js`.
  - Exports `renderAgreementPdf(versionData, signerData) → Promise<Buffer>`.
  - Document contents: Dr. Bartender logo, "Independent Contractor Agreement", version identifier + effective date, all 11 clauses (header + formal text only — plain-English lead-ins and the "At a Glance" summary are UX scaffolding and are intentionally omitted from the PDF so the artifact is a clean formal contract), acknowledgments with checkmarks, signer name/email/phone, signature (rendered as image if `signature_method='draw'`, or typed name if `signature_method='type'`), signed_at timestamp, IP, user agent.
- Upload via existing `server/utils/storage.js` helpers. Key pattern: `agreements/{user_id}/{version}-{iso_timestamp}.pdf`. Private bucket; downloads use short-lived signed URLs.

### Email with attachment

Extend `server/utils/email.js`:
- Add optional `attachments` param to `sendEmail({ to, subject, html, text, from, replyTo, attachments })`.
- `attachments` is an array of `{ filename, content }` where `content` is a Buffer; passed through to Resend's native `attachments` API field.
- Existing call sites unaffected (param is optional).

Email flow after sign:
- Subject: *"Your signed Dr. Bartender Contractor Agreement"*.
- HTML body: brief thanks + "find your signed contract attached" + link to staff portal download.
- Attachment: the rendered PDF buffer, filename `dr-bartender-contractor-agreement.pdf`.

### Sign transaction flow (POST `/api/agreement`)

1. Validate request body: all 6 `ack_*` keys present and `=== true`; `signature_data` and `signature_method` present; `full_name`, `email` present.
2. `BEGIN`.
3. Upsert into `agreements` — write every `ack_*` column, `signature_*` fields, `signature_document_version = CURRENT_VERSION`, `signed_at = NOW()`.
4. Update `onboarding_progress` (`agreement_completed=true`, `last_completed_step='agreement_completed'`).
5. `COMMIT`.
6. **Post-commit (outside transaction):**
    - Render PDF (await).
    - Upload to R2 (await).
    - `UPDATE agreements SET pdf_storage_key=$1, pdf_generated_at=NOW() WHERE user_id=$2`.
    - Send email with attachment (await; catch + log errors, do not throw).
    - If email succeeded: `UPDATE agreements SET pdf_email_sent_at=NOW() WHERE user_id=$1`.
7. Respond `{ agreement, pdf_url }` where `pdf_url` is a signed, short-lived R2 URL for immediate download.

Rationale for post-commit PDF/email: the signature itself is the legal record. If PDF rendering or R2 upload fails, the agreement is still valid — we can regenerate later. Returning a failure to the client here would leave the user confused about whether they've actually signed. Errors are captured by Sentry (existing `@sentry/node` wiring) and surfaced for manual re-render/resend by an admin; automatic retries are not part of this spec.

### Staff portal download

New route: `GET /api/agreement/download` (auth-protected, returns signed R2 URL for the current user's latest `pdf_storage_key`). If `pdf_storage_key` is NULL (e.g., render failed earlier, or v1 signer with no PDF), returns 404 with message *"Signed agreement PDF not available. Please contact support."*

Surface in `client/src/pages/StaffPortal.js` as a "Download your signed contractor agreement" link, only rendered when the user's latest agreement has a `pdf_storage_key`.

### Version migration posture

- v2 deployed as `CURRENT_VERSION`.
- All new signers get v2.
- Existing `contractor-agreement-v1` rows stay valid — no forced re-sign, no UI gate.
- Later (busy-season mass re-onboarding), the user triggers re-onboarding manually by zeroing `onboarding_progress.agreement_completed` for selected users (via admin tooling or direct SQL). Those users flow through `/agreement`, sign v2, land a v2 row (upsert overwrites with `signature_document_version = 'contractor-agreement-v2'`).

---

## Files

### Create

- `server/data/contractorAgreement.js` — versioned legal text + acknowledgments
- `server/utils/agreementPdf.js` — `renderAgreementPdf` using `pdfkit`

### Modify

- `server/db/schema.sql` — new columns on `agreements` (idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`)
- `server/routes/agreement.js` — rewrite POST handler; add GET `/legal-text`, GET `/download`
- `server/utils/email.js` — `attachments` param support
- `client/src/pages/Agreement.js` — fetch legal text from API, render "At a Glance" + 11 clauses + 6 checkboxes; submit with new payload shape
- `client/src/pages/StaffPortal.js` — "Download your signed contractor agreement" link (visible when `pdf_storage_key` exists)
- `package.json` — add `pdfkit` to `dependencies`
- `CLAUDE.md` — folder-structure tree: add `server/data/contractorAgreement.js`, `server/utils/agreementPdf.js`
- `README.md` — folder-structure tree: same additions
- `ARCHITECTURE.md` — update agreement/onboarding section to describe versioned legal text + PDF artifact flow; add the two new files to the route/util inventory if present

### Not touched

- `client/src/pages/FieldGuide.js` — separate CSS bug (appearance-protocols text color) flagged by lawyer but out of scope for this spec; will be handled separately.

---

## Testing checklist (for the implementation plan)

- **Happy path:** new applicant completes `/application` → approved → `/welcome` → `/field-guide` → `/agreement` → checks all 6 boxes + signs → lands on `/contractor-profile`. Verify:
  - Row in `agreements` has all 6 `ack_*` columns `true`, `signature_document_version='contractor-agreement-v2'`, `signature_data` populated.
  - `onboarding_progress.agreement_completed=true`.
  - `pdf_storage_key` populated.
  - R2 object exists at the expected key.
  - Email received in applicant's inbox with PDF attached.
  - `pdf_email_sent_at` populated.
  - PDF opens and contains: full legal text, signer's name, signature image or typed name, timestamp, IP.
- **Validation:** submit with any acknowledgment unchecked → 400 + `fieldErrors` mapping unchecked keys.
- **Validation:** submit with empty `signature_data` → 400 + `fieldErrors.signature`.
- **Resilience:** simulate R2 upload failure post-commit → agreement row still written, step still marked complete, `pdf_storage_key` NULL, response 200 with PDF omitted, Sentry error captured.
- **Resilience:** simulate email send failure → agreement + PDF intact, `pdf_email_sent_at` NULL, response 200.
- **v1 compat:** existing v1 row loads via GET `/api/agreement` without error (old columns still present). Staff portal does NOT show download link if `pdf_storage_key` is NULL.
- **Legal text fetch:** `GET /api/agreement/legal-text` returns v2 payload with all 11 clauses, 6 at-a-glance bullets, and 6 acknowledgments.
- **Download:** `GET /api/agreement/download` returns a signed R2 URL that resolves to the PDF for 200 OK; returns 404 for users with no `pdf_storage_key`.

## Open questions / future work

- **Existing staff import** — a separate admin flow to import historical contractors with their v1 (or pre-system) docs. Not part of this spec.
- **Mass re-onboarding trigger** — admin action to zero `onboarding_progress.agreement_completed` for a set of users. Not part of this spec.
- **Annual agreement refresh** — if legal text changes materially in future, workflow for notifying and re-signing. Not part of this spec.
- **Unrelated:** FieldGuide "Appearance Protocols" section has a CSS readability bug (text color matches background). Tracked separately.

## Risks

- **pdfkit dependency** — adds ~50KB + transitive deps. Low risk; it's the industry-standard Node PDF library, well-maintained, no known security issues.
- **Resend attachment send size** — PDF should be <50KB (text only, no images beyond logo). Resend's attachment limit is 40 MB, well within bounds.
- **Legal text drift** — the React page renders from server-supplied data, so the two can never drift. However, the PDF renderer must also consume the same versioned data object — which it does. Single source of truth holds.
- **IP and user-agent privacy** — already captured on v1 rows; no change. Retained for signature-verification purposes per existing privacy posture.

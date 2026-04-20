# Contractor Agreement v2 Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current plain-English contractor agreement with a lawyer-approved v2 document (11 clauses, 6 per-clause acknowledgments, immutable PDF snapshot stored in R2 and emailed to the contractor), keeping existing v1 signers valid without forced re-signing.

**Architecture:** Single source of truth for legal text lives in a versioned server data module; the React page fetches text from an API endpoint and renders clauses + acknowledgments dynamically. On signature, the server renders a PDF via `pdfkit`, uploads to R2, saves the key on the row, and emails the PDF to the contractor as an attachment. Schema additions are purely additive (new nullable columns); v1 rows remain readable and valid.

**Tech Stack:** Node.js/Express backend (raw SQL via `pg`), React 18 frontend, Cloudflare R2 via AWS SDK v3, Resend email (with native `attachments` support), `pdfkit` (new dependency).

**Design spec:** `docs/superpowers/specs/2026-04-20-contractor-agreement-overhaul-design.md`

---

## File Structure

### Create (2 files)

| Path | Responsibility |
|---|---|
| `server/data/contractorAgreement.js` | Versioned legal-text payload: `CURRENT_VERSION`, `versions` map keyed by version string, each with `at_a_glance[]`, `clauses[]`, `acknowledgments[]`. Exported helper `getCurrentAgreement()` returns the current payload. |
| `server/utils/agreementPdf.js` | `renderAgreementPdf(versionData, signerData) → Promise<Buffer>`. Builds a formal PDF: logo, title, version + date, clauses (header + formal text only), acknowledgment list with checkmarks, signer details, signature (image for `draw`, typed text for `type`), timestamp, IP, user agent. |

### Modify (7 files)

| Path | Change |
|---|---|
| `server/db/schema.sql` | Append idempotent `ALTER TABLE agreements ADD COLUMN IF NOT EXISTS ...` statements for 9 new columns. |
| `server/routes/agreement.js` | Replace body. Add `GET /legal-text` and `GET /download`; rewrite `POST /` to validate 6 ack booleans, write new columns, render + upload PDF + email post-commit, return `{ agreement, pdf_url }`. |
| `server/utils/email.js` | Add optional `attachments` param to `sendEmail`, passthrough to Resend. |
| `client/src/pages/Agreement.js` | Full rewrite. Fetch `/agreement/legal-text` on mount; render "At a Glance" card, 11 clauses, 6 acknowledgment checkboxes (driven by server data), personal-details form, signature pad; submit with new payload; redirect to `/contractor-profile`. |
| `client/src/pages/StaffPortal.js` | Replace the existing `<Link to="/agreement">📝 My Signed Agreement</Link>` with a download-action button that hits `GET /agreement/download` and opens the signed URL. |
| `package.json` | Add `pdfkit` to `dependencies`. |
| `CLAUDE.md` / `README.md` / `ARCHITECTURE.md` | Update folder trees and agreement architecture section per the project's mandatory docs rule. |

---

## Task 1: Schema migration + legal-text data module

**Files:**
- Modify: `server/db/schema.sql` (append new `ALTER TABLE` statements)
- Create: `server/data/contractorAgreement.js`

- [ ] **Step 1: Add new columns to `agreements` schema**

Open `server/db/schema.sql` and find the existing `ALTER TABLE agreements` block around line 97–100. Append these 9 statements immediately after the last existing one:

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

- [ ] **Step 2: Create the legal-text data module**

Create `server/data/contractorAgreement.js` with the full v2 content. This is the single source of truth — both the route that serves the client and the PDF renderer import from here.

```js
// server/data/contractorAgreement.js

const CURRENT_VERSION = 'contractor-agreement-v2';

const V2 = {
  version: 'contractor-agreement-v2',
  effective_date: '2026-04-20',

  at_a_glance: [
    "You're an independent contractor, not an employee — you run your own business.",
    "Each event is its own gig. You choose which to accept; once you commit, you're expected to complete it.",
    "You're paid for actual hours worked plus any gratuity. You handle your own taxes.",
    "Dr. Bartender issues a 1099 only if your annual earnings cross the IRS threshold.",
    "You can't solicit Dr. Bartender's clients, venues, or other contractors — during your time with us and for 12 months after.",
    "If you damage our equipment through willful misconduct or gross negligence, we may recoup the cost. Ordinary accidents aren't subject to that.",
  ],

  clauses: [
    {
      number: 1,
      title: 'Independent Contractor Relationship',
      plain: "In plain English: you're your own boss. We tell you what the job is, not how to do it.",
      formal: "Contractor is an independent contractor providing the Services, which are outside the Company's usual course of business. Nothing in this Agreement will be construed as establishing an employment or agency relationship between Company and Contractor. Contractor has no authority to bind Company by contract or otherwise. Contractor will perform Services under the general direction of Company, but Contractor will determine the manner and means by which Services are accomplished. Dr. Bartender does not control the way in which Services are performed but has discretion to determine whether the final product is acceptable."
    },
    {
      number: 2,
      title: 'Each Event Is a Separate Project',
      plain: "In plain English: each gig stands on its own. You're free to apply, accept, or decline any event — but once you commit, you're expected to see it through.",
      formal: "Each assignment constitutes a separate \"project\" governed by the event specifics and needs as outlined in the applicable event application. Contractor is free to apply for any event, and to accept or decline any assignment; however, Contractor is expected to carry out any events to which Contractor has committed."
    },
    {
      number: 3,
      title: 'Compensation & Taxes',
      plain: "In plain English: you're paid for hours worked plus tips. You cover your own taxes. We'll issue a 1099 if you cross the IRS threshold.",
      formal: "Contractor will be compensated for actual hours worked plus applicable gratuity, as set out in each engagement. Additional time must be pre-approved by Company to be compensable. Contractor is solely responsible for all federal, state, and local taxes on amounts received under this Agreement. Company will issue IRS Form 1099 (or its then-current equivalent) if total calendar-year payments to Contractor exceed the applicable IRS reporting threshold. Contractor acknowledges that Contractor is not entitled to employee benefits (including health insurance, retirement plans, paid time off, workers' compensation, or unemployment) from Company."
    },
    {
      number: 4,
      title: 'Tools, Equipment & Damage Recoupment',
      plain: "In plain English: bring your own kit. If we loan you gear and you damage it through willful misconduct or gross negligence, we may recoup the cost. Ordinary accidents are on us.",
      formal: "Contractor will supply, at Contractor's own expense, all materials, supplies, equipment, and tools required to provide the Services and accomplish the work agreed to be performed under this Agreement, except where Company has agreed in writing to provide specific items. Contractor is responsible for the reasonable replacement cost of Company-provided equipment or product damaged through Contractor's willful misconduct or gross negligence. Company may, at its discretion, deduct such costs from unpaid amounts owed to Contractor or invoice Contractor directly. Ordinary accidents and normal wear and tear are not subject to recoupment."
    },
    {
      number: 5,
      title: 'Non-Solicitation',
      plain: "In plain English: while you're working with us — and for one year after — you don't poach our clients, venues, or other contractors for your own side work.",
      formal: "During the term of this Agreement and for a period of one (1) year thereafter, Contractor will not, directly or indirectly, solicit the services of any Company personnel or other contractors, or directly or indirectly attempt to solicit any Company clients, for Contractor's own benefit or for the benefit of any other person or entity."
    },
    {
      number: 6,
      title: 'Representations & Warranties',
      plain: "In plain English: we each confirm we're legit and can enter this contract. You also confirm your work is professional, is yours, and doesn't step on anyone else's rights.",
      formal: "**Mutual.** Each party represents and warrants to the other that: (a) it has the legal power and authority to enter into this Agreement; and (b) it will comply with all applicable laws in performing its obligations under this Agreement.\n\n**From Contractor.** Contractor represents and warrants to Company that:\n• Contractor will perform the Services in a timely, competent, and professional manner, consistent with high professional and industry standards, with the requisite training, background, experience, technical knowledge, and skills to perform the Services;\n• Contractor has no pre-existing obligations or commitments (and will not assume or otherwise undertake any obligations or commitments) that would be in conflict or inconsistent with, or that would hinder Contractor's performance of, Contractor's obligations under this Agreement;\n• the Work Product does not and will not infringe or misappropriate anyone else's patent, copyright, trademark, trade secret, right of privacy or publicity, or other intellectual or proprietary right;\n• the Work Product will conform to the requirements of the applicable event or engagement; and\n• Contractor has all rights necessary — including all federal, state, and local business permits and licenses, and any applicable alcohol-service certification (BASSET, TIPS, ServSafe Alcohol, or equivalent) — to perform the Services."
    },
    {
      number: 7,
      title: 'Indemnification',
      plain: "In plain English: if a third party sues Dr. Bartender because of something you did, you cover it.",
      formal: "Contractor will indemnify and hold harmless Company from and against all claims, damages, losses, and expenses, including court costs and reasonable attorneys' fees, arising out of or resulting from, and, at Company's option, Contractor will defend Company against any action by a third party against Company that is based on:\n• a claim that any Service, the results of any Service (including any Work Product), or Company's use thereof, infringes, misappropriates, or violates a third party's intellectual property rights;\n• a breach or alleged breach by Contractor of Section 6 (Representations & Warranties); or\n• any negligent act or omission, or reckless or willful conduct, of Contractor that results in (i) bodily injury, sickness, disease, or death; (ii) injury to or destruction of tangible or intangible property (including computer programs and data) or any loss of use resulting therefrom; or (iii) the violation of any applicable laws."
    },
    {
      number: 8,
      title: 'Limitation of Liability',
      plain: "In plain English: Dr. Bartender isn't on the hook for lost profits or other indirect damages, even if informed about the possibility.",
      formal: "Under no circumstances will Company be liable for lost profits or revenues (whether direct or indirect), or for consequential, special, indirect, exemplary, punitive, or incidental damages relating to this Agreement, even if Company is informed of the possibility of these types of damages in advance."
    },
    {
      number: 9,
      title: 'Assignment',
      plain: "In plain English: you can't hand this contract off to someone else. Dr. Bartender can, if the business is sold.",
      formal: "Contractor may not assign or transfer any of Contractor's rights or delegate any of Contractor's obligations under this Agreement, in whole or in part, without Company's express prior written consent. Any attempted assignment, transfer, or delegation without such consent will be void. Company may assign or transfer this Agreement in connection with the sale of all or substantially all of its business or assets to which this Agreement relates. Subject to the foregoing, this Agreement will be binding upon and will inure to the benefit of the parties' permitted successors and assigns."
    },
    {
      number: 10,
      title: 'Modifications, Severability & Waiver',
      plain: "In plain English: changes must be in writing. If a court tosses one clause, the rest still holds.",
      formal: "Any waiver, modification, or change to this Agreement must be in writing and signed or electronically accepted by each party. If any term of this Agreement is determined to be invalid or unenforceable by a relevant court or governing body, the remaining terms of this Agreement will remain in full force and effect. The failure of a party to enforce a term, or to exercise an option or right, in this Agreement will not constitute a waiver by that party of the term, option, or right."
    },
    {
      number: 11,
      title: 'Field Guide Compliance',
      plain: "In plain English: you've read the Field Guide and will follow the protocols in it (appearance, timing, sobriety, alcohol laws, incident reporting, etc.).",
      formal: "Contractor acknowledges having read and understood the Dr. Bartender Field Guide, which sets out operational expectations including appearance, tools, timing, tips, boundaries, alcohol-service laws, sobriety policy, incident reporting, social media, and harassment policies. Compliance with the Field Guide is a condition of performing Services under this Agreement. The Company may update the Field Guide from time to time; material changes will be communicated to Contractor."
    }
  ],

  acknowledgments: [
    { key: 'ack_ic_status',         label: 'I am working with Dr. Bartender as an independent contractor, not an employee, and am responsible for my own taxes.' },
    { key: 'ack_commitment',        label: 'If I accept an event assignment, I will complete it to professional standards with my own tools.' },
    { key: 'ack_non_solicit',       label: "I will not solicit Dr. Bartender's clients, venues, or other contractors during my time with the company or for 12 months after." },
    { key: 'ack_damage_recoupment', label: 'I understand Dr. Bartender may recoup the replacement cost of company-provided equipment I damage through willful misconduct or gross negligence.' },
    { key: 'ack_legal_protections', label: 'I have read and agree to Sections 6, 7, and 8 above (Representations & Warranties, Indemnification, Limitation of Liability).' },
    { key: 'ack_field_guide',       label: 'I have read the Dr. Bartender Field Guide and will follow its protocols.' },
  ],
};

const VERSIONS = {
  'contractor-agreement-v2': V2,
};

function getCurrentAgreement() {
  return VERSIONS[CURRENT_VERSION];
}

function getAgreementVersion(version) {
  return VERSIONS[version] || null;
}

module.exports = {
  CURRENT_VERSION,
  VERSIONS,
  getCurrentAgreement,
  getAgreementVersion,
};
```

- [ ] **Step 3: Apply schema against dev DB**

Run the schema init against the dev database. The project has an `initDb()` call on server boot that replays `schema.sql`. Restart the server to trigger it (or run manually):

```bash
# If you keep the dev server running, restart it:
# Ctrl+C the current `npm run dev` session, then:
npm run dev
```

Expected: server starts without error; new columns exist on the `agreements` table.

- [ ] **Step 4: Verify new columns exist**

Use psql or the Neon console to verify:

```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'agreements'
  AND column_name IN (
    'ack_ic_status','ack_commitment','ack_non_solicit',
    'ack_damage_recoupment','ack_legal_protections','ack_field_guide',
    'pdf_storage_key','pdf_generated_at','pdf_email_sent_at'
  )
ORDER BY column_name;
```

Expected output: 9 rows, all columns present.

- [ ] **Step 5: Verify data module loads cleanly**

From the repo root:

```bash
node -e "const m = require('./server/data/contractorAgreement'); const v = m.getCurrentAgreement(); console.log('version:', v.version); console.log('clauses:', v.clauses.length); console.log('acks:', v.acknowledgments.length); console.log('glance bullets:', v.at_a_glance.length);"
```

Expected: `version: contractor-agreement-v2`, `clauses: 11`, `acks: 6`, `glance bullets: 6`.

- [ ] **Step 6: Commit**

```bash
git add server/db/schema.sql server/data/contractorAgreement.js
git commit -m "feat(agreement): add v2 schema columns and versioned legal-text data module"
```

---

## Task 2: Email attachments support

**Files:**
- Modify: `server/utils/email.js`

- [ ] **Step 1: Add `attachments` param to `sendEmail`**

Replace the current `sendEmail` function (and update its JSDoc) to accept and forward `attachments`:

```js
/**
 * Send an email via Resend
 * @param {Object} options
 * @param {string|string[]} options.to - Recipient email(s)
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML body
 * @param {string} [options.text] - Plain text fallback
 * @param {string} [options.from] - Override default from address
 * @param {string} [options.replyTo] - Reply-to address
 * @param {Array<{filename: string, content: Buffer|string}>} [options.attachments] - Resend attachments
 * @returns {Promise<{id: string}>}
 */
async function sendEmail({ to, subject, html, text, from, replyTo, attachments }) {
  if (!resend) {
    console.log(`[DEV] Email skipped → ${to} | Subject: ${subject}${attachments ? ` (with ${attachments.length} attachment(s))` : ''}`);
    return { id: 'dev-skipped' };
  }

  const { data, error } = await resend.emails.send({
    from: from || FROM_EMAIL,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    ...(text && { text }),
    ...(replyTo && { reply_to: replyTo }),
    ...(attachments && attachments.length && { attachments }),
  });

  if (error) {
    console.error('[email] Resend send FAILED for', to, '—', error?.message || JSON.stringify(error));
    throw new Error(error?.message || 'Resend send failed');
  }

  return data;
}
```

Leave `sendBatchEmails` untouched.

- [ ] **Step 2: Smoke-check no syntax errors**

```bash
node -e "const { sendEmail } = require('./server/utils/email'); console.log(typeof sendEmail);"
```

Expected: `function`.

- [ ] **Step 3: Commit**

```bash
git add server/utils/email.js
git commit -m "feat(email): accept attachments param for Resend passthrough"
```

---

## Task 3: Add pdfkit dependency and PDF renderer

**Files:**
- Modify: `package.json` (add `pdfkit` dependency)
- Create: `server/utils/agreementPdf.js`

- [ ] **Step 1: Install pdfkit**

From the repo root:

```bash
npm install pdfkit
```

Expected: `pdfkit` appears in `dependencies` in `package.json`; `package-lock.json` updated.

- [ ] **Step 2: Create the PDF renderer**

Create `server/utils/agreementPdf.js`:

```js
// server/utils/agreementPdf.js
const PDFDocument = require('pdfkit');

/**
 * Render a signed contractor agreement to a PDF buffer.
 *
 * @param {Object} versionData - From contractorAgreement.js (has version, effective_date, clauses[], acknowledgments[]).
 * @param {Object} signerData - {
 *   full_name, email, phone,
 *   signature_data (PNG data URL when method='draw', plain text when method='type'),
 *   signature_method ('draw' or 'type'),
 *   signature_ip, signature_user_agent, signed_at (Date or ISO string),
 *   acknowledgments: { ack_ic_status: true, ack_commitment: true, ... }
 * }
 * @returns {Promise<Buffer>}
 */
function renderAgreementPdf(versionData, signerData) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // ── Header ───────────────────────────────────────────────
      doc.fontSize(20).font('Helvetica-Bold').text('Dr. Bartender', { align: 'center' });
      doc.moveDown(0.2);
      doc.fontSize(14).font('Helvetica').text('Independent Contractor Agreement', { align: 'center' });
      doc.moveDown(0.2);
      doc.fontSize(9).fillColor('#555').text(
        `Version: ${versionData.version}  ·  Effective: ${versionData.effective_date}`,
        { align: 'center' }
      );
      doc.fillColor('black');
      doc.moveDown(1);

      // ── Clauses ─────────────────────────────────────────────
      versionData.clauses.forEach((clause) => {
        doc.fontSize(11).font('Helvetica-Bold').text(`${clause.number}. ${clause.title}`);
        doc.moveDown(0.3);
        doc.fontSize(10).font('Helvetica').text(clause.formal, { align: 'justify' });
        doc.moveDown(0.7);
      });

      // ── Acknowledgments ─────────────────────────────────────
      doc.addPage();
      doc.fontSize(13).font('Helvetica-Bold').text('Contractor Acknowledgments');
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica').text(
        'The contractor confirmed each of the following at the time of signing:'
      );
      doc.moveDown(0.5);
      versionData.acknowledgments.forEach((ack) => {
        const checked = signerData.acknowledgments?.[ack.key] === true;
        doc.font('Helvetica-Bold').text(checked ? '[X]' : '[ ]', { continued: true });
        doc.font('Helvetica').text(' ' + ack.label);
        doc.moveDown(0.25);
      });

      // ── Signer block ────────────────────────────────────────
      doc.moveDown(1);
      doc.fontSize(13).font('Helvetica-Bold').text('Signature');
      doc.moveDown(0.5);

      if (signerData.signature_method === 'draw' && typeof signerData.signature_data === 'string' && signerData.signature_data.startsWith('data:image')) {
        const b64 = signerData.signature_data.replace(/^data:image\/\w+;base64,/, '');
        const imgBuf = Buffer.from(b64, 'base64');
        try {
          doc.image(imgBuf, { width: 200 });
        } catch (imgErr) {
          doc.fontSize(10).font('Helvetica-Oblique').text('[Signature image could not be rendered]');
        }
      } else if (signerData.signature_method === 'type' && signerData.signature_data) {
        doc.fontSize(20).font('Helvetica-Oblique').text(signerData.signature_data);
      } else {
        doc.fontSize(10).font('Helvetica-Oblique').text('[No signature captured]');
      }
      doc.moveDown(0.5);

      doc.fontSize(10).font('Helvetica').text(`Name: ${signerData.full_name || ''}`);
      doc.text(`Email: ${signerData.email || ''}`);
      if (signerData.phone) doc.text(`Phone: ${signerData.phone}`);

      const signedAt = signerData.signed_at
        ? new Date(signerData.signed_at).toISOString()
        : new Date().toISOString();
      doc.text(`Signed: ${signedAt}`);
      if (signerData.signature_ip) doc.text(`IP: ${signerData.signature_ip}`);
      if (signerData.signature_user_agent) {
        doc.fontSize(8).fillColor('#666').text(`User Agent: ${signerData.signature_user_agent}`);
        doc.fillColor('black');
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderAgreementPdf };
```

- [ ] **Step 3: Smoke test the renderer**

From the repo root:

```bash
node -e "
const fs = require('fs');
const { getCurrentAgreement } = require('./server/data/contractorAgreement');
const { renderAgreementPdf } = require('./server/utils/agreementPdf');
const version = getCurrentAgreement();
const signer = {
  full_name: 'Jane Test',
  email: 'jane@example.com',
  phone: '555-000-0000',
  signature_data: 'Jane Test',
  signature_method: 'type',
  signature_ip: '127.0.0.1',
  signature_user_agent: 'Node smoke test',
  signed_at: new Date(),
  acknowledgments: {
    ack_ic_status: true,
    ack_commitment: true,
    ack_non_solicit: true,
    ack_damage_recoupment: true,
    ack_legal_protections: true,
    ack_field_guide: true,
  },
};
renderAgreementPdf(version, signer).then(buf => {
  fs.writeFileSync('/tmp/agreement-smoke.pdf', buf);
  console.log('Wrote', buf.length, 'bytes to /tmp/agreement-smoke.pdf');
}).catch(err => { console.error(err); process.exit(1); });
"
```

Expected: prints `Wrote <N> bytes to /tmp/agreement-smoke.pdf`. Open the PDF manually to confirm it looks correct (header, 11 clauses on pages 1–?, acknowledgments + signature on the final page, "Jane Test" rendered in italic as the signature).

On Windows, swap `/tmp/agreement-smoke.pdf` for something like `./agreement-smoke.pdf`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json server/utils/agreementPdf.js
git commit -m "feat(agreement): add pdfkit and server-side PDF renderer for signed agreements"
```

---

## Task 4: Agreement route rewrite

**Files:**
- Modify: `server/routes/agreement.js` (full rewrite)

- [ ] **Step 1: Replace `server/routes/agreement.js` entirely**

```js
const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { getCurrentAgreement, CURRENT_VERSION } = require('../data/contractorAgreement');
const { renderAgreementPdf } = require('../utils/agreementPdf');
const { uploadFile, getSignedUrl } = require('../utils/storage');
const { sendEmail } = require('../utils/email');

const router = express.Router();

// ── GET /api/agreement/legal-text — current version payload ──────────
router.get('/legal-text', asyncHandler(async (req, res) => {
  res.json(getCurrentAgreement());
}));

// ── GET /api/agreement — current user's saved agreement row ──────────
router.get('/', auth, asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT * FROM agreements WHERE user_id = $1', [req.user.id]);
  res.json(result.rows[0] || {});
}));

// ── GET /api/agreement/download — signed R2 URL to the PDF ───────────
router.get('/download', auth, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT pdf_storage_key FROM agreements WHERE user_id = $1',
    [req.user.id]
  );
  const key = result.rows[0]?.pdf_storage_key;
  if (!key) throw new NotFoundError('Signed agreement PDF not available.');
  const url = await getSignedUrl(key);
  res.json({ url });
}));

// ── POST /api/agreement — sign ───────────────────────────────────────
router.post('/', auth, asyncHandler(async (req, res) => {
  const {
    full_name, email, phone, sms_consent,
    ack_ic_status, ack_commitment, ack_non_solicit,
    ack_damage_recoupment, ack_legal_protections, ack_field_guide,
    signature_data, signature_method,
  } = req.body;

  const fieldErrors = {};
  if (!full_name) fieldErrors.full_name = 'Full name is required';
  if (!email) fieldErrors.email = 'Email is required';
  if (!ack_ic_status)         fieldErrors.ack_ic_status         = 'This acknowledgment is required';
  if (!ack_commitment)        fieldErrors.ack_commitment        = 'This acknowledgment is required';
  if (!ack_non_solicit)       fieldErrors.ack_non_solicit       = 'This acknowledgment is required';
  if (!ack_damage_recoupment) fieldErrors.ack_damage_recoupment = 'This acknowledgment is required';
  if (!ack_legal_protections) fieldErrors.ack_legal_protections = 'This acknowledgment is required';
  if (!ack_field_guide)       fieldErrors.ack_field_guide       = 'This acknowledgment is required';
  if (!signature_data) fieldErrors.signature = 'Please sign the agreement before submitting';
  if (Object.keys(fieldErrors).length > 0) throw new ValidationError(fieldErrors);

  if (signature_method !== 'draw' && signature_method !== 'type') {
    throw new ValidationError({ signature: 'Invalid signature method.' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
  const userAgent = req.headers['user-agent'] || null;

  // ── Transaction: upsert agreement row + mark onboarding step ──────
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT id FROM agreements WHERE user_id = $1',
      [req.user.id]
    );

    const cols = [
      'full_name','email','phone','sms_consent',
      'ack_ic_status','ack_commitment','ack_non_solicit',
      'ack_damage_recoupment','ack_legal_protections','ack_field_guide',
      'signature_data','signature_method','signature_ip','signature_user_agent',
      'signature_document_version','signed_at',
    ];

    if (existing.rows[0]) {
      await client.query(
        `UPDATE agreements SET
           full_name=$1, email=$2, phone=$3, sms_consent=$4,
           ack_ic_status=$5, ack_commitment=$6, ack_non_solicit=$7,
           ack_damage_recoupment=$8, ack_legal_protections=$9, ack_field_guide=$10,
           signature_data=$11, signature_method=$12, signature_ip=$13, signature_user_agent=$14,
           signature_document_version=$15, signed_at=NOW(),
           pdf_storage_key=NULL, pdf_generated_at=NULL, pdf_email_sent_at=NULL
         WHERE user_id=$16`,
        [
          full_name, email, phone, !!sms_consent,
          !!ack_ic_status, !!ack_commitment, !!ack_non_solicit,
          !!ack_damage_recoupment, !!ack_legal_protections, !!ack_field_guide,
          signature_data, signature_method, ip, userAgent,
          CURRENT_VERSION, req.user.id,
        ]
      );
    } else {
      await client.query(
        `INSERT INTO agreements
           (user_id, ${cols.join(', ')})
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())`,
        [
          req.user.id,
          full_name, email, phone, !!sms_consent,
          !!ack_ic_status, !!ack_commitment, !!ack_non_solicit,
          !!ack_damage_recoupment, !!ack_legal_protections, !!ack_field_guide,
          signature_data, signature_method, ip, userAgent,
          CURRENT_VERSION,
        ]
      );
    }

    await client.query(
      `UPDATE onboarding_progress
          SET agreement_completed=true, last_completed_step='agreement_completed'
        WHERE user_id=$1`,
      [req.user.id]
    );

    await client.query('COMMIT');
  } catch (txErr) {
    try { await client.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw txErr;
  } finally {
    client.release();
  }

  // ── Post-commit: render PDF, upload, email ────────────────────────
  const saved = (await pool.query('SELECT * FROM agreements WHERE user_id = $1', [req.user.id])).rows[0];

  let pdfUrl = null;
  try {
    const versionData = getCurrentAgreement();
    const pdfBuf = await renderAgreementPdf(versionData, {
      full_name: saved.full_name,
      email: saved.email,
      phone: saved.phone,
      signature_data: saved.signature_data,
      signature_method: saved.signature_method,
      signature_ip: saved.signature_ip,
      signature_user_agent: saved.signature_user_agent,
      signed_at: saved.signed_at,
      acknowledgments: {
        ack_ic_status: saved.ack_ic_status,
        ack_commitment: saved.ack_commitment,
        ack_non_solicit: saved.ack_non_solicit,
        ack_damage_recoupment: saved.ack_damage_recoupment,
        ack_legal_protections: saved.ack_legal_protections,
        ack_field_guide: saved.ack_field_guide,
      },
    });

    const storageKey = `agreements/${req.user.id}/${CURRENT_VERSION}-${Date.now()}.pdf`;
    await uploadFile(pdfBuf, storageKey);

    await pool.query(
      `UPDATE agreements
          SET pdf_storage_key=$1, pdf_generated_at=NOW()
        WHERE user_id=$2`,
      [storageKey, req.user.id]
    );

    pdfUrl = await getSignedUrl(storageKey);

    // Email with PDF attached — failures are logged, not thrown.
    try {
      await sendEmail({
        to: saved.email,
        subject: 'Your signed Dr. Bartender Contractor Agreement',
        html: `
          <p>Hi ${saved.full_name || 'there'},</p>
          <p>Thanks for signing — your Dr. Bartender Independent Contractor Agreement is attached as a PDF for your records.</p>
          <p>You can also download it anytime from your <a href="${process.env.CLIENT_URL || ''}/staff-portal">staff portal</a>.</p>
          <p>— Dr. Bartender</p>
        `,
        text: 'Thanks for signing — your Dr. Bartender Independent Contractor Agreement is attached.',
        attachments: [
          { filename: 'dr-bartender-contractor-agreement.pdf', content: pdfBuf },
        ],
      });
      await pool.query(
        `UPDATE agreements SET pdf_email_sent_at=NOW() WHERE user_id=$1`,
        [req.user.id]
      );
    } catch (emailErr) {
      console.error('[agreement] PDF email send failed:', emailErr.message);
      Sentry.captureException?.(emailErr, { tags: { route: 'POST /api/agreement', step: 'email' } });
    }
  } catch (pdfErr) {
    console.error('[agreement] PDF render/upload failed:', pdfErr.message);
    Sentry.captureException?.(pdfErr, { tags: { route: 'POST /api/agreement', step: 'pdf' } });
    // Continue — signature record itself is already committed.
  }

  const final = (await pool.query('SELECT * FROM agreements WHERE user_id = $1', [req.user.id])).rows[0];
  res.json({ agreement: final, pdf_url: pdfUrl });
}));

module.exports = router;
```

- [ ] **Step 2: Restart dev server and verify it boots**

Restart `npm run dev`. Expected: server starts without syntax errors. No new warnings.

- [ ] **Step 3: Manual test — GET /legal-text**

Against the running dev server:

```bash
curl -s http://localhost:5000/api/agreement/legal-text | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log('version:', d.version, '| clauses:', d.clauses.length, '| acks:', d.acknowledgments.length);"
```

Expected: `version: contractor-agreement-v2 | clauses: 11 | acks: 6`.

- [ ] **Step 4: Commit**

```bash
git add server/routes/agreement.js
git commit -m "feat(agreement): rewrite POST, add GET /legal-text + GET /download for v2 flow"
```

---

## Task 5: Rewrite the client `Agreement.js` page

**Files:**
- Modify: `client/src/pages/Agreement.js` (full rewrite)

- [ ] **Step 1: Replace `client/src/pages/Agreement.js` entirely**

```jsx
import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import SignaturePad from '../components/SignaturePad';
import FormBanner from '../components/FormBanner';
import FieldError from '../components/FieldError';
import api from '../utils/api';
import { useToast } from '../context/ToastContext';
import { formatPhoneInput, stripPhone } from '../utils/formatPhone';
import useFormValidation from '../hooks/useFormValidation';

export default function Agreement() {
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const { setProgress } = useOutletContext();

  const [legalText, setLegalText] = useState(null);
  const [legalTextError, setLegalTextError] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [loadError, setLoadError] = useState('');
  const { validate, fieldClass, inputClass, clearField } = useFormValidation();

  const [form, setForm] = useState({
    full_name: '',
    email: user?.email || '',
    phone: '',
    sms_consent: false,
    signature_data: '',
    signature_method: null,
  });
  const [acks, setAcks] = useState({}); // { ack_ic_status: bool, ... } keys match server

  // Load legal text + existing agreement row in parallel
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get('/agreement/legal-text'),
      api.get('/agreement'),
    ]).then(([textRes, rowRes]) => {
      if (cancelled) return;
      setLegalText(textRes.data);
      // Initialize acks state with every key from server
      const initialAcks = {};
      (textRes.data.acknowledgments || []).forEach(a => { initialAcks[a.key] = false; });
      setAcks(initialAcks);

      const row = rowRes.data;
      if (row && row.full_name) {
        setForm(prev => ({
          ...prev,
          full_name: row.full_name || '',
          email: row.email || user?.email || '',
          phone: row.phone || '',
          sms_consent: !!row.sms_consent,
        }));
      }
    }).catch((e) => {
      if (cancelled) return;
      setLegalTextError(e.message || "We couldn't load the agreement. Please refresh.");
      toast.error("We couldn't load the agreement.");
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleField(e) {
    const { name, value, type, checked } = e.target;
    clearField(name);
    setForm(f => ({ ...f, [name]: type === 'checkbox' ? checked : value }));
  }

  function handleAck(key) {
    clearField(key);
    setAcks(a => ({ ...a, [key]: !a[key] }));
  }

  const ackList = legalText?.acknowledgments || [];

  const rules = useMemo(() => {
    const base = [
      { field: 'full_name', label: 'Full Name' },
      { field: 'email', label: 'Email' },
      { field: 'signature_data', label: 'Digital Signature', test: (val) => !!val },
    ];
    return base;
  }, []);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setFieldErrors({});

    // Validate core fields
    const result = validate(rules, form);
    if (!result.valid) { setError(result.message); return; }

    // Validate every ack is checked
    const uncheckedAcks = ackList.filter(a => !acks[a.key]);
    if (uncheckedAcks.length > 0) {
      const errs = {};
      uncheckedAcks.forEach(a => { errs[a.key] = 'This acknowledgment is required'; });
      setFieldErrors(errs);
      setError('Please confirm each acknowledgment below before signing.');
      return;
    }

    setLoading(true);
    try {
      const payload = { ...form, ...acks };
      await api.post('/agreement', payload);
      const r = await api.put('/progress/step', { step: 'agreement_completed' });
      setProgress(r.data);
      toast.success('Agreement signed.');
      navigate('/contractor-profile');
    } catch (err) {
      setError(err.message || 'Failed to save agreement.');
      if (err.fieldErrors) setFieldErrors(err.fieldErrors);
    } finally {
      setLoading(false);
    }
  }

  if (legalTextError) {
    return (
      <div className="page-container">
        <div className="alert alert-error">{legalTextError}</div>
      </div>
    );
  }

  if (!legalText) {
    return (
      <div className="page-container">
        <div className="loading"><div className="spinner" />Loading agreement…</div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <div className="text-center mb-3">
        <div className="section-label">Step 3 of 6</div>
        <h1>Independent Contractor Agreement</h1>
        <p className="text-muted italic">
          This is the contract between you and Dr. Bartender. Please read it carefully — you can come back to it later from your staff portal.
        </p>
      </div>

      {loadError && <div className="alert alert-info">{loadError}</div>}

      {/* ── At a Glance ─────────────────────────────────────── */}
      <div
        className="card"
        style={{
          background: '#F0F8F1',
          border: '1px solid #BEDABF',
          marginBottom: '1.5rem',
        }}
      >
        <h3 style={{ marginBottom: '0.5rem' }}>At a Glance</h3>
        <p className="text-small text-muted" style={{ marginBottom: '0.75rem' }}>
          This box is a plain-English summary. The full contract is below — that's what you're signing.
        </p>
        <ul style={{ paddingLeft: '1.25rem', margin: 0 }}>
          {legalText.at_a_glance.map((bullet, i) => (
            <li key={i} style={{ marginBottom: '0.4rem', fontSize: '0.9rem', color: 'var(--deep-brown)' }}>
              {bullet}
            </li>
          ))}
        </ul>
      </div>

      {/* ── Full formal agreement ───────────────────────────── */}
      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <h3 style={{ marginBottom: '0.25rem' }}>Full Agreement</h3>
        <p className="text-small text-muted" style={{ marginBottom: '1rem' }}>
          Version {legalText.version} · Effective {legalText.effective_date}
        </p>
        {legalText.clauses.map((clause) => (
          <section key={clause.number} style={{ marginBottom: '1.25rem' }}>
            <h4 style={{ marginBottom: '0.3rem' }}>
              {clause.number}. {clause.title}
            </h4>
            <p className="italic text-muted" style={{ fontSize: '0.85rem', marginBottom: '0.4rem' }}>
              {clause.plain}
            </p>
            <p style={{ fontSize: '0.9rem', whiteSpace: 'pre-wrap' }}>
              {clause.formal}
            </p>
          </section>
        ))}
      </div>

      {/* ── Personal details + acknowledgments + signature ── */}
      <div className="card">
        <h3 style={{ marginBottom: '0.25rem' }}>Your Details</h3>
        <p className="text-muted text-small" style={{ marginBottom: '1.25rem' }}>
          We'll email you a copy of the signed agreement at this address.
        </p>

        <form onSubmit={submit}>
          <div className="two-col">
            <div className={"form-group" + fieldClass('full_name')}>
              <label htmlFor="agreement-full_name" className="form-label">Full Name</label>
              <input
                id="agreement-full_name" name="full_name"
                className={"form-input" + inputClass('full_name')}
                value={form.full_name} onChange={handleField}
                placeholder="Your legal name"
                aria-invalid={!!fieldErrors?.full_name}
              />
              <FieldError error={fieldErrors?.full_name} />
            </div>
            <div className={"form-group" + fieldClass('email')}>
              <label htmlFor="agreement-email" className="form-label">Email</label>
              <input
                id="agreement-email" name="email" type="email"
                className={"form-input" + inputClass('email')}
                value={form.email} onChange={handleField}
                aria-invalid={!!fieldErrors?.email}
              />
              <FieldError error={fieldErrors?.email} />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="agreement-phone" className="form-label">Phone</label>
            <input
              id="agreement-phone" name="phone" type="tel"
              className="form-input"
              value={formatPhoneInput(form.phone)}
              onChange={e => { clearField('phone'); setForm(f => ({ ...f, phone: stripPhone(e.target.value) })); }}
              placeholder="(555) 000-0000"
            />
            <p className="form-helper">
              By providing your phone number you grant us permission to contact you via SMS or voice.
            </p>
          </div>

          <div className="form-group">
            <label className="checkbox-group">
              <input type="checkbox" name="sms_consent" checked={form.sms_consent} onChange={handleField} />
              <span className="checkbox-label">
                I consent to receive SMS messages from Dr. Bartender regarding scheduling.
              </span>
            </label>
          </div>

          <div className="divider" />

          <h4 style={{ marginBottom: '0.75rem' }}>Acknowledgments</h4>
          {ackList.map((a) => (
            <div
              key={a.key}
              className={"form-group" + fieldClass(a.key)}
              style={{ marginBottom: '0.75rem' }}
            >
              <label className="checkbox-group">
                <input
                  type="checkbox"
                  name={a.key}
                  className={inputClass(a.key).trim()}
                  checked={!!acks[a.key]}
                  onChange={() => handleAck(a.key)}
                />
                <span className="checkbox-label">{a.label}</span>
              </label>
              <FieldError error={fieldErrors?.[a.key]} />
            </div>
          ))}

          <div className="divider" />

          <div className={"form-group" + fieldClass('signature_data')}>
            <label className="form-label">Digital Signature</label>
            <SignaturePad
              value={form.signature_data}
              onChange={(data, method) => {
                clearField('signature_data');
                setForm(f => ({ ...f, signature_data: data, signature_method: method }));
              }}
            />
            <FieldError error={fieldErrors?.signature} />
          </div>

          <FormBanner error={error} fieldErrors={fieldErrors} />

          <button type="submit" className="btn btn-primary btn-full mt-2" disabled={loading}>
            {loading ? 'Submitting…' : 'Sign & Continue →'}
          </button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Browser test the signing flow end-to-end**

Ensure both server (`npm run dev`) and client dev server are running. Open the app in a browser:

1. Log in as an onboarding user (or register a new test account).
2. Complete steps up to step 3 (application approved → welcome → field guide → agreement).
3. On the `/agreement` page, verify:
   - "At a Glance" card renders with 6 bullets.
   - 11 numbered clauses are visible with plain-English italic leads and formal text.
   - 6 acknowledgment checkboxes appear, each unchecked by default.
   - Signature pad is functional (test both draw and type modes).
4. Try submit with a missing acknowledgment → inline red errors appear under each unchecked box and banner message at top.
5. Check all 6 acks, fill details, sign → click Sign & Continue.
6. Expected: toast "Agreement signed.", redirect to `/contractor-profile`.

- [ ] **Step 3: Verify DB state**

```sql
SELECT user_id, signature_document_version,
       ack_ic_status, ack_commitment, ack_non_solicit,
       ack_damage_recoupment, ack_legal_protections, ack_field_guide,
       pdf_storage_key IS NOT NULL AS has_pdf,
       pdf_email_sent_at IS NOT NULL AS email_sent
  FROM agreements
 WHERE user_id = <the test user id>;
```

Expected: `signature_document_version='contractor-agreement-v2'`, all six `ack_*` columns `true`, `has_pdf=true`. `email_sent` is `true` if Resend is configured in dev (`RESEND_API_KEY` present); `false` otherwise (the dev log will show `[DEV] Email skipped`).

- [ ] **Step 4: Verify the PDF in R2**

Check R2 console or run:

```bash
curl -s http://localhost:5000/api/agreement/download -H "Authorization: Bearer <test user jwt>"
```

Expected: JSON `{ url: "https://...r2.cloudflarestorage.com/..." }`. Open the URL — the PDF should contain the clauses, acknowledgments with X marks, and the signer's name/signature.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/Agreement.js
git commit -m "feat(agreement): rewrite Agreement page to render v2 clauses + per-clause acks from API"
```

---

## Task 6: StaffPortal download link

**Files:**
- Modify: `client/src/pages/StaffPortal.js` (swap the existing "My Signed Agreement" link)

- [ ] **Step 1: Locate the existing link**

In `client/src/pages/StaffPortal.js`, find (around line 504–506):

```jsx
<Link to="/agreement" className="btn btn-secondary" style={{ textAlign: 'left', textDecoration: 'none' }}>
  📝 My Signed Agreement
</Link>
```

- [ ] **Step 2: Replace with a download-action button**

Replace those 3 lines with:

```jsx
<button
  type="button"
  className="btn btn-secondary"
  style={{ textAlign: 'left', textDecoration: 'none' }}
  onClick={async () => {
    try {
      const r = await api.get('/agreement/download');
      window.open(r.data.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      toast.error(err.message || 'Signed agreement not available yet.');
    }
  }}
>
  📝 Download My Signed Agreement
</button>
```

The surrounding file already imports `api` and `toast`, so no new imports are needed.

- [ ] **Step 3: Browser test**

Log into the staff portal as a user who has signed v2. Go to Resources & Profile tab. Click "Download My Signed Agreement". Expected: a new tab opens with the PDF from R2.

Then log in as a user who has *not* signed (or whose `pdf_storage_key` is NULL). Click the same button. Expected: toast error "Signed agreement PDF not available." (from the 404).

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/StaffPortal.js
git commit -m "feat(staff-portal): swap agreement link for PDF download action"
```

---

## Task 7: Documentation updates

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: Update `CLAUDE.md` folder tree**

Find the folder-structure tree in `CLAUDE.md`. Two insertions:

Under `server/`, add a `data/` subdirectory entry before `middleware/` (or wherever maintains alphabetical order in the existing tree):

```
│   ├── data/
│   │   └── contractorAgreement.js # Versioned v2 legal text (clauses, acknowledgments, effective date)
```

Under `server/utils/`, add a line for the new PDF renderer (placed alphabetically between existing entries — for example, between `errors.js` and `eventCreation.js`):

```
│   │   ├── agreementPdf.js    # PDFKit renderer for signed contractor agreements
```

- [ ] **Step 2: Update `README.md` folder tree**

Make the same two insertions in the `README.md` folder tree. The entries should match exactly to keep the three docs in sync (this is enforced by the project's docs rule in `CLAUDE.md`).

- [ ] **Step 3: Update `ARCHITECTURE.md`**

Find the section that describes the `/agreement` flow or the `agreements` table. If none, add a new subsection under the onboarding/routes section:

```markdown
#### Contractor Agreement

The contractor agreement is versioned. The current version is defined in `server/data/contractorAgreement.js`
(`CURRENT_VERSION = 'contractor-agreement-v2'`). The React page at `/agreement` fetches the current version
payload from `GET /api/agreement/legal-text` and renders it dynamically (At-a-Glance bullets, 11 clauses, 6
per-clause acknowledgments).

On sign (`POST /api/agreement`), the server:

1. Writes all six `ack_*` booleans, signature data, IP, user agent, and `signature_document_version` to the
   `agreements` table inside a transaction with the onboarding progress update.
2. Post-commit: renders a PDF via `server/utils/agreementPdf.js` (pdfkit), uploads to R2 under
   `agreements/{user_id}/{version}-{timestamp}.pdf`, stores the key on the row.
3. Sends the PDF to the signer as a Resend email attachment. Email failures are logged to Sentry; the
   signature record is already committed.

`GET /api/agreement/download` returns a short-lived signed R2 URL for the current user's latest PDF.

V1 signers (pre-v2 schema) remain valid. The legacy `acknowledged_field_guide` and `agreed_non_solicitation`
columns are preserved for historical records; new v2 signers populate the `ack_*` columns instead.
```

Add the two new files to the route/util inventory if that inventory exists in `ARCHITECTURE.md`.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md ARCHITECTURE.md
git commit -m "docs: document contractor-agreement v2 flow and new server/data + pdf util files"
```

---

## Final verification

- [ ] All prior manual checks (GET /legal-text, DB state, PDF download) still work.
- [ ] Open an unrelated admin page to confirm nothing else regressed.
- [ ] Git log shows 7 commits (6 feat + 1 docs), each scoped to a logical unit.
- [ ] `git status` is clean; no stray files.

When everything is verified, report task complete and await the user's push cue before running the pre-push review agents + `git push origin main`.

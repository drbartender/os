---
plan: onboarding-upload-and-draft
spec: docs/superpowers/specs/2026-07-26-onboarding-upload-and-draft-design.md
lanes:
  - id: upload-honesty
    footprint:
      - server/utils/fileValidation.js
      - server/utils/fileValidation.test.js
      - server/routes/application.js
      - server/routes/contractor.js
      - server/index.js
      - client/src/utils/uploadLimits.js
      - client/src/utils/uploadLimits.test.js
      - client/src/utils/downscaleImage.js
      - client/src/components/FileUpload.js
      - client/src/components/FileUpload.test.js
      - client/src/pages/Application.js
      - client/src/pages/ContractorProfile.js
      - README.md
      - ARCHITECTURE.md
    depends_on: []
    sensitive: true          # file upload validation is an allowlist widening
    review_fleet: [code-review, security-review, consistency-check]
    second_opinion: true
  - id: onboarding-drafts
    footprint:
      - server/db/schema.sql
      - server/routes/progress.js
      - server/routes/progress.draft.test.js
      - client/src/hooks/useFormDraft.js
      - client/src/hooks/useFormDraft.test.js
      - client/src/pages/Application.js
      - client/src/pages/ContractorProfile.js
      - README.md
      - ARCHITECTURE.md
    depends_on: [upload-honesty]     # shares Application.js and ContractorProfile.js
    sensitive: true          # schema.sql is on scripts/sensitive-paths.txt
    review_fleet: [code-review, database-review, security-review, consistency-check]
    second_opinion: true
  - id: document-visibility
    footprint:
      - server/utils/outstandingDocuments.js
      - server/utils/outstandingDocuments.test.js
      - server/routes/admin/hiring.js
      - server/routes/progress.js
      - client/src/pages/admin/overview/queueItems.js
      - client/src/pages/admin/overview/queueItems.test.js
      - client/src/pages/admin/overview/OverviewPage.js
      - client/src/pages/admin/overview/NeedsYouStrip.js
      - client/src/components/Layout.js
      - docs/fix-list-remaining-2026-07-02.md
      - README.md
      - ARCHITECTURE.md
    depends_on: [onboarding-drafts]  # shares server/routes/progress.js
    sensitive: false
    review_fleet: [code-review, database-review, consistency-check]
  - id: submit-gate-relax
    footprint:
      - server/routes/application.js
      - client/src/pages/Application.js
    depends_on: [document-visibility]
    sensitive: true          # removes a server-side validation gate
    review_fleet: [code-review, security-review, consistency-check]
    second_opinion: true
parallelism: "Strictly serial. Every lane after the first shares at least one file with a predecessor (Application.js spans three, progress.js spans two), so none may run as a parallel worktree. submit-gate-relax is deliberately its own lane rather than folded into document-visibility: it is the only change here that might warrant reverting on its own, and a squash merge would otherwise bury it in the same commit as the alert it depends on."
---

# Onboarding Upload and Draft Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the onboarding application from stranding recruits: make uploads succeed, stop discarding their work, and stop letting a file upload block the whole form.

**Architecture:** Four strictly serial lanes (see the front-matter lane map; they are NOT independent, every one after the first shares a file with a predecessor). `upload-honesty` widens what we accept and downscales oversized images in the browser before a byte is sent. `onboarding-drafts` adds a server-side draft table so a half-finished form survives a failure or a device switch. `document-visibility` derives who still owes documents and puts the compliance cases on the admin's screen. `submit-gate-relax` then stops the two file uploads blocking submit, for people already hired.

**Tech Stack:** Node 26 / Express 4, raw SQL over `pg`, React 18 (CRA), `express-fileupload`, `node:test` on the server, `react-scripts test` (Jest + @testing-library/react) on the client.

**Spec:** `docs/superpowers/specs/2026-07-26-onboarding-upload-and-draft-design.md`

## Global Constraints

- Money as integer cents; not applicable in this plan but never violate it.
- All SQL parameterized (`$1`, `$2`). Never concatenate user input.
- Every non-public route uses the `auth` middleware, and every query scopes to `req.user.id` to prevent IDOR.
- Schema changes go in `server/db/schema.sql` using idempotent statements (`IF NOT EXISTS`).
- Route handlers wrap in `asyncHandler` and throw `AppError` subclasses, never `res.status(400).json(...)`.
- Client API calls go through `client/src/utils/api.js`. Never raw `fetch`/`axios`.
- No em dashes in any user-facing copy. Use commas, periods, colons, or parentheses.
- Server tests run one suite at a time against the dev DB: `node -r dotenv/config --test <file>`. Fixtures must be nonce-keyed and cleaned up in `after()`.
- Client verification is `CI=true npx react-scripts build` from `client/`, because `npm run lint` does not cover client code.
- **Jest resets mocks between tests.** CRA sets `resetMocks: true` (`react-scripts/scripts/utils/createJestConfig.js:68`) and `client/package.json` does not override it, so a `jest.mock(...)` module factory's implementation is stripped before every test. Any mocked module a test relies on must be re-armed in `beforeEach` with `mockImplementation`, not merely `clearAllMocks`.
- **The dev server does not auto-reload.** It runs as plain `node server/index.js` on port 5000, Claude-managed. Restart it after any server edit before curling.
- File-size discipline: soft cap 700 lines (warn only), hard cap 1000 (blocks growth). `client/src/pages/Application.js` is 685 lines today and is touched by three lanes: roughly +2 (upload-honesty), +29 (onboarding-drafts), +3 (submit-gate-relax), landing near 714. That crosses the soft cap into YELLOW during **onboarding-drafts**, which warns and never blocks. The hard cap is not in play. Do not attribute the crossing to the last lane to touch the file.
- **Documentation is not optional.** Per CLAUDE.md's mandatory-docs table, each lane updates `README.md` (folder tree) and `ARCHITECTURE.md` (routes, schema) for what it adds. The specific obligations are listed in each lane's final task.

---

## Lane A: Uploads that succeed

### Task A1: Add an onboarding-document validator

`isValidUpload` is shared by nine call sites including the W-9 (`payment.js:92`), blog images (`admin/blog.js:176`), and staff portal uploads (`staffPortal.js:692`). Widening it in place would let a `.docx` through as a blog image. Add a separate validator instead and leave the existing two untouched.

**Files:**
- Modify: `server/utils/fileValidation.js`
- Test: `server/utils/fileValidation.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `isValidOnboardingDocument(file) -> boolean`, where `file` is an `express-fileupload` object with `.data` (Buffer) and `.name` (string). Exported alongside the existing `isValidUpload` and `isValidImageUpload`, both unchanged.

- [ ] **Step 1: Write the failing test**

Create `server/utils/fileValidation.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isValidUpload,
  isValidImageUpload,
  isValidOnboardingDocument,
} = require('./fileValidation');

const file = (bytes, name = 'x.bin') => ({ data: Buffer.from(bytes), name });

const PDF  = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46];
const PNG  = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d];
const ZIP  = [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00];
const OLE  = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00, 0x00, 0x00];
const EXE  = [0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00];

const webp = () => [
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
];
// ftyp box at offset 4, brand at offset 8.
const heic = (brand = 'heic') => [
  0x00, 0x00, 0x00, 0x18,
  0x66, 0x74, 0x79, 0x70,
  ...Buffer.from(brand, 'latin1'),
];

test('accepts the self-identifying formats on magic bytes alone', () => {
  assert.equal(isValidOnboardingDocument(file(PDF, 'resume.pdf')), true);
  assert.equal(isValidOnboardingDocument(file(JPEG, 'cert.jpg')), true);
  assert.equal(isValidOnboardingDocument(file(PNG, 'cert.png')), true);
  assert.equal(isValidOnboardingDocument(file(webp(), 'cert.webp')), true);
});

test('accepts HEIC and its sibling brands', () => {
  for (const brand of ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']) {
    assert.equal(isValidOnboardingDocument(file(heic(brand), `photo.heic`)), true, brand);
  }
});

test('accepts a docx only when magic and extension agree', () => {
  assert.equal(isValidOnboardingDocument(file(ZIP, 'resume.docx')), true);
  assert.equal(isValidOnboardingDocument(file(ZIP, 'payload.zip')), false);
  assert.equal(isValidOnboardingDocument(file(ZIP, 'noext')), false);
});

test('accepts a legacy doc only when magic and extension agree', () => {
  assert.equal(isValidOnboardingDocument(file(OLE, 'resume.doc')), true);
  assert.equal(isValidOnboardingDocument(file(OLE, 'book.xls')), false);
});

test('extension matching is case insensitive', () => {
  assert.equal(isValidOnboardingDocument(file(ZIP, 'Resume.DOCX')), true);
});

test('rejects executables and malformed input', () => {
  assert.equal(isValidOnboardingDocument(file(EXE, 'virus.exe')), false);
  assert.equal(isValidOnboardingDocument(null), false);
  assert.equal(isValidOnboardingDocument({}), false);
  assert.equal(isValidOnboardingDocument({ data: 'not-a-buffer', name: 'a.pdf' }), false);
  assert.equal(isValidOnboardingDocument(file([], 'empty.pdf')), false);
});

test('the shared validators are unchanged and stay narrow', () => {
  assert.equal(isValidUpload(file(PDF, 'a.pdf')), true);
  assert.equal(isValidUpload(file(ZIP, 'a.docx')), false, 'blog/W-9 path must not accept docx');
  assert.equal(isValidUpload(file(heic(), 'a.heic')), false, 'blog/W-9 path must not accept heic');
  assert.equal(isValidImageUpload(file(PNG, 'a.png')), true);
  assert.equal(isValidImageUpload(file(heic(), 'a.heic')), false, 'drink-plan images must not accept heic');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/drbartender/projects/os && node -r dotenv/config --test server/utils/fileValidation.test.js`
Expected: FAIL, `isValidOnboardingDocument is not a function`.

- [ ] **Step 3: Implement the validator**

In `server/utils/fileValidation.js`, add `const path = require('path');` at the top, then append before `module.exports`:

```js
const FTYP = Buffer.from([0x66, 0x74, 0x79, 0x70]);                          // 'ftyp' at offset 4
const ZIP  = Buffer.from([0x50, 0x4b, 0x03, 0x04]);                          // PK.. (docx, and every other zip)
const OLE  = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);  // legacy Office compound file
const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'];

function startsWith(buf, magic) {
  return buf.length >= magic.length && buf.subarray(0, magic.length).equals(magic);
}

function isHeif(buf) {
  if (buf.length < 12) return false;
  if (!buf.subarray(4, 8).equals(FTYP)) return false;
  return HEIF_BRANDS.includes(buf.subarray(8, 12).toString('latin1'));
}

/**
 * Onboarding documents only: resume and alcohol certification.
 *
 * Wider than isValidUpload on purpose. These files are stored in R2 and opened
 * by an admin through a signed URL, never rendered on a public page, so an
 * iPhone photo or a Word document is a legitimate thing for a recruit to hand
 * us. Rejecting them strands people (incident 2026-07-23).
 *
 * Container formats (DOC, DOCX) share their magic bytes with every other OLE
 * or zip file, so they are accepted ONLY when the magic and the filename
 * extension agree. PK magic alone never admits an arbitrary .zip.
 *
 * Deliberately NOT used by payment.js (W-9), admin/blog.js (blog images), or
 * staffPortal.js. Those keep the narrow isValidUpload.
 */
function isValidOnboardingDocument(file) {
  if (!file || !file.data || !Buffer.isBuffer(file.data)) return false;
  const buf = file.data;
  if (isValidUpload(file)) return true;   // PDF, JPEG, PNG, WebP
  if (isHeif(buf)) return true;

  const ext = typeof file.name === 'string' ? path.extname(file.name).toLowerCase() : '';
  if (startsWith(buf, ZIP) && ext === '.docx') return true;
  if (startsWith(buf, OLE) && ext === '.doc') return true;
  return false;
}
```

Change the export line to:

```js
module.exports = { isValidUpload, isValidImageUpload, isValidOnboardingDocument };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/drbartender/projects/os && node -r dotenv/config --test server/utils/fileValidation.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Point the two onboarding routes at it**

In `server/routes/application.js`, change the import on line 6 to:

```js
const { isValidUpload, isValidOnboardingDocument } = require('../utils/fileValidation');
```

Locate the three call sites with `grep -n 'isValidUpload' server/routes/application.js` rather than trusting line numbers, then swap `isValidUpload` for `isValidOnboardingDocument` at the **resume** and **basset** sites only. **Leave the headshot site on `isValidUpload`** so a headshot stays a renderable image. Update the two error strings to name what is now accepted:

```js
throw new ValidationError({ resume: 'We could not read that file. Use a PDF, Word document, or a photo.' });
```
```js
throw new ValidationError({ basset: 'We could not read that file. Use a PDF, Word document, or a photo.' });
```

Apply the identical change in `server/routes/contractor.js`: same grep, swap the `alcohol_certification` and `resume` sites, leave the headshot site alone, and update those two error strings the same way.

- [ ] **Step 6: Confirm the swap landed on the right sites**

`staffPortal.test.js` exercises the **unchanged** validator, so it passes whether or not the swap is correct. The dangerous mistake is swapping the headshot site, which would widen a field the server still validates narrowly. Check by content, the same way A4 Step 3c does:

```bash
cd /home/drbartender/projects/os
grep -n "isValidUpload\|isValidOnboardingDocument" server/routes/application.js server/routes/contractor.js
```

Expected: `isValidOnboardingDocument` appears at exactly **four** call sites (resume and basset in `application.js`, alcohol_certification and resume in `contractor.js`). `isValidUpload` still appears at exactly **two** call sites, both of them the `headshot` block. Read the surrounding lines to confirm which block each one sits in rather than trusting the count alone.

- [ ] **Step 7: Run the suites these routes reach**

Run: `cd /home/drbartender/projects/os && node -r dotenv/config --test server/routes/staffPortal.test.js`
Expected: PASS. This is a non-regression check: the staff portal still uses `isValidUpload`, and widening must not have leaked into it.

- [ ] **Step 8: Commit**

```bash
git add server/utils/fileValidation.js server/utils/fileValidation.test.js server/routes/application.js server/routes/contractor.js
git commit -m "feat(uploads): accept HEIC and Word docs for onboarding documents"
```

---

### Task A2: Shared client upload limits and type check

**Files:**
- Create: `client/src/utils/uploadLimits.js`
- Test: `client/src/utils/uploadLimits.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MAX_UPLOAD_BYTES: number`
  - `DOWNSCALE_THRESHOLD_BYTES: number`
  - `MAX_IMAGE_EDGE: number`
  - `IMAGE_QUALITY: number`
  - `UPLOAD_KINDS: { document: string[], narrow: string[] }`
  - `DEFAULT_KIND: 'narrow'`
  - `acceptFor(kind: string) -> string`
  - `formatBytes(n: number) -> string`
  - `extOf(name: string) -> string`
  - `isImageName(name: string) -> boolean`
  - `checkFile(file: {name: string, size: number}, kind?: string) -> { ok: true } | { ok: false, message: string }`

**Why `kind` exists.** The accepted extension set must match whichever server
validator the destination route uses, or the client waves a file through that the
server then rejects, which is the original bug wearing a different hat.
`PaydayProtocols.js:527` renders `FileUpload` with no `accept` prop for the W-9,
and `payment.js:92` validates that upload with the narrow `isValidUpload`. So the
**default is `narrow`**, and only the resume and alcohol certification opt into
`document`. The two sets mirror `isValidUpload` and `isValidOnboardingDocument`
exactly.

- [ ] **Step 1: Write the failing test**

Create `client/src/utils/uploadLimits.test.js`:

```js
import {
  MAX_UPLOAD_BYTES, formatBytes, extOf, isImageName, checkFile, acceptFor,
} from './uploadLimits';

const f = (name, size) => ({ name, size });

describe('formatBytes', () => {
  it('renders whole megabytes without decimals', () => {
    expect(formatBytes(10 * 1024 * 1024)).toBe('10MB');
  });
  it('renders partial megabytes with one decimal', () => {
    expect(formatBytes(13.7 * 1024 * 1024)).toBe('13.7MB');
  });
  it('falls back to KB under a megabyte', () => {
    expect(formatBytes(300 * 1024)).toBe('300KB');
  });
});

describe('extOf', () => {
  it('lowercases and includes the dot', () => {
    expect(extOf('Resume.DOCX')).toBe('.docx');
  });
  it('returns empty for no extension', () => {
    expect(extOf('resume')).toBe('');
  });
});

describe('isImageName', () => {
  it('recognises the image extensions we downscale', () => {
    ['a.jpg', 'a.jpeg', 'a.png', 'a.webp', 'a.heic', 'a.heif'].forEach(n =>
      expect(isImageName(n)).toBe(true));
  });
  it('does not treat documents as images', () => {
    ['a.pdf', 'a.doc', 'a.docx'].forEach(n => expect(isImageName(n)).toBe(false));
  });
});

describe('kinds mirror the server validators', () => {
  it('defaults to the narrow set, matching isValidUpload', () => {
    expect(checkFile(f('w9.pdf', 1000))).toEqual({ ok: true });
    expect(checkFile(f('w9.docx', 1000)).ok).toBe(false);
    expect(checkFile(f('w9.heic', 1000)).ok).toBe(false);
  });

  it('accepts Word and HEIC only under the document kind', () => {
    expect(checkFile(f('resume.docx', 1000), 'document')).toEqual({ ok: true });
    expect(checkFile(f('cert.heic', 1000), 'document')).toEqual({ ok: true });
  });

  it('acceptFor emits an attribute string per kind', () => {
    expect(acceptFor('document')).toContain('.docx');
    expect(acceptFor('narrow')).not.toContain('.docx');
    expect(acceptFor(undefined)).toBe(acceptFor('narrow'));
  });

  it('an unknown kind falls back to narrow rather than accepting everything', () => {
    expect(checkFile(f('resume.docx', 1000), 'bogus').ok).toBe(false);
  });
});

describe('checkFile', () => {
  it('accepts a normal PDF', () => {
    expect(checkFile(f('resume.pdf', 900 * 1024))).toEqual({ ok: true });
  });

  it('accepts a Word document under the document kind', () => {
    expect(checkFile(f('resume.docx', 40 * 1024), 'document')).toEqual({ ok: true });
  });

  it('rejects an unsupported type by naming what works', () => {
    const r = checkFile(f('resume.pages', 1000), 'document');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/PDF/);
    expect(r.message).toMatch(/\.pages/);
  });

  it('rejects an oversized file naming both the real size and the limit', () => {
    const r = checkFile(f('scan.pdf', 14 * 1024 * 1024));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('14MB');
    expect(r.message).toContain(formatBytes(MAX_UPLOAD_BYTES));
  });

  it('rejects an empty file', () => {
    const r = checkFile(f('resume.pdf', 0));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/empty/i);
  });

  it('uses no em dashes in any message', () => {
    const messages = [
      checkFile(f('a.pages', 10)).message,
      checkFile(f('a.pdf', 99 * 1024 * 1024)).message,
      checkFile(f('a.pdf', 0)).message,
    ];
    messages.forEach(m => expect(m).not.toContain('—'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/drbartender/projects/os/client && CI=true npx react-scripts test --testPathPattern=uploadLimits`
Expected: FAIL, cannot resolve `./uploadLimits`.

- [ ] **Step 3: Implement the module**

Create `client/src/utils/uploadLimits.js`:

```js
// Client-side upload rules.
//
// MAX_UPLOAD_BYTES MUST stay equal to the server's MAX_FILE_SIZE (see the
// Environment Variables table in CLAUDE.md; server default is the same 10MB in
// server/index.js). If the two drift, an oversized file gets past this check,
// express-fileupload's abortOnLimit resets the stream mid-body, and the browser
// reports a bare "network error" instead of anything useful. That is the exact
// failure that stranded a recruit on 2026-07-23.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Images above this get downscaled in the browser before upload. Well under
// the cap on purpose: the point is that a phone photo never approaches it.
export const DOWNSCALE_THRESHOLD_BYTES = 1.5 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 2000;
export const IMAGE_QUALITY = 0.85;

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'];

// Each kind MUST mirror the server validator used by its destination route. A
// client that accepts more than the server does just relocates the original bug:
// the user picks a file, waits through an upload, and gets rejected at the end.
//
//   narrow   -> server/utils/fileValidation.js isValidUpload
//               (W-9 via payment.js:92, headshots, blog, staff portal)
//   document -> server/utils/fileValidation.js isValidOnboardingDocument
//               (resume and alcohol certification only)
export const UPLOAD_KINDS = {
  narrow: ['.pdf', '.jpg', '.jpeg', '.png', '.webp'],
  document: ['.pdf', '.doc', '.docx', ...IMAGE_EXTS],
};

// Default to the narrow set. A field must opt IN to the wider one, so a new
// FileUpload added later cannot silently outrun its server validator.
export const DEFAULT_KIND = 'narrow';

function extsFor(kind) {
  return UPLOAD_KINDS[kind] || UPLOAD_KINDS[DEFAULT_KIND];
}

// The file input's accept attribute for a given kind. Kept as wide as the
// server allows, because a too-narrow accept greys files out in the iOS Files
// picker with no explanation, which reads to the user as a broken page.
export function acceptFor(kind) {
  return extsFor(kind).join(',');
}

export function extOf(name) {
  if (typeof name !== 'string') return '';
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i).toLowerCase();
}

export function isImageName(name) {
  return IMAGE_EXTS.includes(extOf(name));
}

export function formatBytes(n) {
  const mb = n / (1024 * 1024);
  if (mb >= 1) {
    const rounded = Math.round(mb * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}MB`;
  }
  return `${Math.round(n / 1024)}KB`;
}

export function checkFile(file, kind = DEFAULT_KIND) {
  if (!file) return { ok: false, message: 'No file selected.' };
  if (!file.size) return { ok: false, message: 'That file is empty. Try picking it again.' };

  const allowed = extsFor(kind);
  const ext = extOf(file.name);
  if (!allowed.includes(ext)) {
    const wording = allowed.includes('.docx')
      ? 'Use a PDF, a Word document, or a photo (JPG, PNG, HEIC).'
      : 'Use a PDF or a photo (JPG, PNG).';
    return { ok: false, message: `We cannot read ${ext || 'that file type'}. ${wording}` };
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      message: `That file is ${formatBytes(file.size)}, and the limit is ${formatBytes(MAX_UPLOAD_BYTES)}. Try a smaller photo or scan.`,
    };
  }

  return { ok: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/drbartender/projects/os/client && CI=true npx react-scripts test --testPathPattern=uploadLimits`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/utils/uploadLimits.js client/src/utils/uploadLimits.test.js
git commit -m "feat(uploads): shared client upload limit and type check"
```

---

### Task A3: Downscale images in the browser

**Files:**
- Create: `client/src/utils/downscaleImage.js`

**Interfaces:**
- Consumes: `DOWNSCALE_THRESHOLD_BYTES`, `MAX_IMAGE_EDGE`, `IMAGE_QUALITY`, `isImageName` from `./uploadLimits`.
- Produces: `downscaleImage(file: File) -> Promise<File>`. Always resolves, never rejects. Returns the original `file` unchanged when downscaling is unnecessary or impossible.

The canvas path itself cannot be unit tested: jsdom provides no real image decoding, and a mocked canvas would only assert that the mock was called. It is covered by the Lane A manual check, including the HEIC decode-failure case.

**The four early returns can and must be tested**, because a downscaler that returns the original for every input would otherwise pass this task, pass A4 (which mocks it), and pass the build. Test the guards, skip the canvas.

- [ ] **Step 1: Implement the module**

Create `client/src/utils/downscaleImage.js`:

```js
import {
  DOWNSCALE_THRESHOLD_BYTES, MAX_IMAGE_EDGE, IMAGE_QUALITY, isImageName,
} from './uploadLimits';

// Shrink a large photo before upload so a recruit photographing a certification
// card never meets the size limit at all. A 14MB phone photo lands around 300KB
// and stays perfectly legible.
//
// HEIC note: Safari decodes HEIC to canvas, Chrome does not. Where decode fails
// we hand back the original untouched and let the server's
// isValidOnboardingDocument accept the HEIC as-is. So the failure mode is "no
// shrink", not "broken upload": an under-limit HEIC still goes through. An
// OVER-limit one is then rejected at pick time by checkFile, which is exactly
// what the spec prescribes rather than a regression.
export default async function downscaleImage(file) {
  if (!file || !isImageName(file.name)) return file;
  if (file.size <= DOWNSCALE_THRESHOLD_BYTES) return file;
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return file;

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (err) {
    return file; // Undecodable in this browser (typically HEIC outside Safari).
  }

  try {
    const { width, height } = bitmap;
    const longest = Math.max(width, height);
    if (!longest) return file;

    const scale = Math.min(1, MAX_IMAGE_EDGE / longest);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);

    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise(resolve =>
      canvas.toBlob(resolve, 'image/jpeg', IMAGE_QUALITY));
    if (!blob || blob.size >= file.size) return file; // No win, keep the original.

    const base = file.name.replace(/\.[^.]+$/, '');
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
  } catch (err) {
    return file;
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}
```

- [ ] **Step 2: Test the guards**

Create `client/src/utils/downscaleImage.test.js`:

```js
import downscaleImage from './downscaleImage';
import { DOWNSCALE_THRESHOLD_BYTES } from './uploadLimits';

const file = (name, size) => {
  const f = new File(['x'], name, { type: 'application/octet-stream' });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

it('passes non-images straight through', async () => {
  const pdf = file('resume.pdf', 20 * 1024 * 1024);
  expect(await downscaleImage(pdf)).toBe(pdf);
});

it('passes small images straight through', async () => {
  const small = file('photo.jpg', DOWNSCALE_THRESHOLD_BYTES - 1);
  expect(await downscaleImage(small)).toBe(small);
});

it('passes the original back when the browser cannot decode it', async () => {
  // jsdom has no createImageBitmap, which is exactly the HEIC-in-Chrome path.
  const heic = file('photo.heic', 8 * 1024 * 1024);
  expect(await downscaleImage(heic)).toBe(heic);
});

it('never rejects, whatever it is handed', async () => {
  await expect(downscaleImage(null)).resolves.toBeNull();
  await expect(downscaleImage(undefined)).resolves.toBeUndefined();
});
```

Run: `cd /home/drbartender/projects/os/client && CI=true npx react-scripts test --testPathPattern=downscaleImage`
Expected: PASS, 4 tests.

These also give the module a consumer. Note that `CI=true react-scripts build` alone would prove nothing here: CRA's `eslint-webpack-plugin` only processes modules webpack actually reaches, and nothing imports `downscaleImage.js` until Task A4, so a syntax error in it would sail through the build.

Then run: `cd /home/drbartender/projects/os/client && CI=true npx react-scripts build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add client/src/utils/downscaleImage.js client/src/utils/downscaleImage.test.js
git commit -m "feat(uploads): downscale oversized images in the browser"
```

---

### Task A4: Wire FileUpload to the new rules

**Files:**
- Modify: `client/src/components/FileUpload.js`
- Test: `client/src/components/FileUpload.test.js` (create)

**Interfaces:**
- Consumes: `checkFile`, `acceptFor`, `DEFAULT_KIND` from `../utils/uploadLimits`; `downscaleImage` from `../utils/downscaleImage`.
- Produces: existing props unchanged (`label`, `name`, `accept`, `helper`, `onChange`, `currentFile`, `camera`), plus one new optional prop `kind` defaulting to `DEFAULT_KIND` (`'narrow'`). `onChange(name, file)` still fires only for accepted files. Rejections render inline and never call `onChange`.

- [ ] **Step 1: Write the failing test**

Create `client/src/components/FileUpload.test.js`:

```js
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FileUpload from './FileUpload';

jest.mock('../utils/downscaleImage', () => ({
  __esModule: true,
  default: jest.fn(async f => f),
}));

function makeFile(name, size, type = 'application/pdf') {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

function setup(props = {}) {
  const onChange = jest.fn();
  render(<FileUpload label="Upload Your Resume" name="resume" kind="document" onChange={onChange} {...props} />);
  return { onChange, input: document.querySelector('input[type="file"]') };
}

// CRA sets resetMocks: true, which strips the module-factory implementation
// above before EVERY test. Without re-arming, downscaleImage resolves undefined,
// checkFile(undefined) returns "No file selected.", and every case that does not
// call mockResolvedValueOnce fails. clearAllMocks does NOT restore it.
beforeEach(() => {
  require('../utils/downscaleImage').default.mockImplementation(f => Promise.resolve(f));
});

it('accepts a normal file and reports it upward', async () => {
  const { onChange, input } = setup();
  const file = makeFile('resume.pdf', 900 * 1024);
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => expect(onChange).toHaveBeenCalledWith('resume', file));
});

it('rejects an oversized file inline and never calls onChange', async () => {
  const { onChange, input } = setup();
  fireEvent.change(input, { target: { files: [makeFile('scan.pdf', 14 * 1024 * 1024)] } });
  expect(await screen.findByText(/that file is 14MB/i)).toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
});

it('rejects an unsupported type and says what works', async () => {
  const { onChange, input } = setup();
  fireEvent.change(input, { target: { files: [makeFile('resume.pages', 5000)] } });
  expect(await screen.findByText(/we cannot read \.pages/i)).toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
});

it('clears a previous error once a good file is picked', async () => {
  const { onChange, input } = setup();
  fireEvent.change(input, { target: { files: [makeFile('a.pages', 10)] } });
  expect(await screen.findByText(/we cannot read/i)).toBeInTheDocument();

  const good = makeFile('resume.pdf', 1000);
  fireEvent.change(input, { target: { files: [good] } });
  await waitFor(() => expect(onChange).toHaveBeenCalledWith('resume', good));
  expect(screen.queryByText(/we cannot read/i)).not.toBeInTheDocument();
});

it('routes images through the downscaler before accepting', async () => {
  const downscale = require('../utils/downscaleImage').default;
  const small = makeFile('small.jpg', 200 * 1024, 'image/jpeg');
  downscale.mockResolvedValueOnce(small);

  const { onChange, input } = setup();
  const huge = makeFile('huge.jpg', 9 * 1024 * 1024, 'image/jpeg');
  fireEvent.change(input, { target: { files: [huge] } });

  await waitFor(() => expect(onChange).toHaveBeenCalledWith('resume', small));
  expect(downscale).toHaveBeenCalledWith(huge);
});

it('accepts an image that only fits after downscaling', async () => {
  const downscale = require('../utils/downscaleImage').default;
  downscale.mockResolvedValueOnce(makeFile('shrunk.jpg', 300 * 1024, 'image/jpeg'));

  const { onChange, input } = setup();
  fireEvent.change(input, { target: { files: [makeFile('huge.heic', 18 * 1024 * 1024, 'image/heic')] } });

  await waitFor(() => expect(onChange).toHaveBeenCalled());
  expect(screen.queryByText(/the limit is/i)).not.toBeInTheDocument();
});

// Regression guard. PaydayProtocols renders the W-9 field with no `kind`, and
// payment.js:92 validates it with the narrow isValidUpload. If the default ever
// widens, a .docx W-9 passes here and is rejected only after a full upload,
// which is the exact failure this component exists to prevent.
it('defaults to the narrow kind so the W-9 field matches its server validator', async () => {
  const onChange = jest.fn();
  render(<FileUpload label="Upload Your Signed W-9" name="w9" onChange={onChange} />);
  const input = document.querySelectorAll('input[type="file"]')[0];

  fireEvent.change(input, { target: { files: [makeFile('w9.docx', 40 * 1024)] } });
  expect(await screen.findByText(/we cannot read \.docx/i)).toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/drbartender/projects/os/client && CI=true npx react-scripts test --testPathPattern=FileUpload`
Expected: FAIL. The oversize and unsupported-type cases call `onChange` today because no validation exists.

- [ ] **Step 3: Implement**

In `client/src/components/FileUpload.js`, replace the import block at the top with:

```js
import React, { useId, useState } from 'react';
import { checkFile, acceptFor, DEFAULT_KIND } from '../utils/uploadLimits';
import downscaleImage from '../utils/downscaleImage';
```

Add `kind` to the destructured props, defaulting to the narrow set:

```js
export default function FileUpload({ label, name, accept, helper, onChange, currentFile, camera, kind = DEFAULT_KIND }) {
```

Add error state inside the component, immediately after the two `useId()` lines:

```js
  const [error, setError] = useState('');
```

Replace `handleChange` with:

```js
  // Validate at PICK time, before a single byte is sent. The old behaviour let
  // an oversized file upload for a full minute and then reported a bare
  // "network error", blaming the user's connection for our limit.
  async function handleChange(e) {
    const input = e.target;
    const picked = input.files[0];
    // Allow re-picking the same file after a rejection. jsdom rejects this
    // assignment in some versions, and it is a convenience, not a correctness
    // requirement, so a failure here must not break the pick.
    try { input.value = ''; } catch (err) { /* jsdom */ }
    if (!picked) return;

    const file = await downscaleImage(picked);
    const verdict = checkFile(file, kind);
    if (!verdict.ok) {
      setError(verdict.message);
      return;
    }
    setError('');
    onChange(name, file);
  }
```

Render the error in both return branches. In the camera branch, insert immediately after the `{helper && <p className="form-helper">{helper}</p>}` line:

```jsx
        {error && <p className="field-error" role="alert">{error}</p>}
```

In the default branch, insert the identical line immediately after its `{helper && ...}` line.

Finally, drive both fallback accepts from the kind. In the camera branch change `accept={accept || 'image/*'}` to `accept={accept || acceptFor(kind)}`, and in the default branch change `accept={accept || '.pdf,.jpg,.jpeg,.png'}` to `accept={accept || acceptFor(kind)}`. Leave the dedicated camera-capture input on `accept="image/*"` with `capture="user"`, since that one opens the camera rather than a file picker.

Change the default-branch hint text from the hardcoded `PDF, JPG, PNG accepted` to a kind-derived line, so it can never disagree with what the field actually takes:

```jsx
            <div className="file-upload-text">
              {kind === 'document' ? 'PDF, Word, or photo' : 'PDF or photo'}
            </div>
```

- [ ] **Step 3b: Opt the two document fields in**

Only the resume and alcohol certification use the wider set. Everything else keeps the default.

**Locate each field by its `name` prop, not by line number.** Lane B inserts lines into both of these files before Lane C runs, so any line number written here is stale by the time it is read. An earlier revision of this plan cited a line that turned out to sit inside the headshot block, which would have widened the one field that must stay narrow.

In `client/src/pages/Application.js`, add `kind="document"` to exactly the two `FileUpload` elements whose props are `name="resume"` and `name="basset"`:

```bash
grep -n 'name="resume"\|name="headshot"\|name="basset"' client/src/pages/Application.js
```

**Do not add it to `name="headshot"`.** That field stays narrow so it remains a renderable image, matching the `isValidUpload` check deliberately left in place at `server/routes/application.js:103`. Note the headshot also passes an explicit `accept=".jpg,.jpeg,.png"`, so a stray `kind="document"` there would widen `checkFile` while leaving `accept` narrow: an inconsistency the server would then reject after upload, which is the precise failure this whole lane exists to remove.

While you are in that block, fix the resume field's stale per-field helper, which still reads `"PDF, JPEG, or PNG accepted."` even though the field now takes Word and HEIC:

```jsx
                helper="PDF, Word document, or a photo."
```

In `client/src/pages/ContractorProfile.js`, same rule: `kind="document"` on `name="alcohol_certification"` and `name="resume"`, and **not** on `name="headshot"`.

Touch nothing in `client/src/pages/PaydayProtocols.js`. Its `name="w9"` field inherits the narrow default, which is exactly what `payment.js:92` enforces.

- [ ] **Step 3c: Confirm the opt-in landed on the right three fields**

```bash
cd /home/drbartender/projects/os
grep -n 'name="resume"\|name="headshot"\|name="basset"\|name="alcohol_certification"\|name="w9"' -B 2 -A 2 \
  client/src/pages/Application.js client/src/pages/ContractorProfile.js client/src/pages/PaydayProtocols.js \
  | grep -E 'name=|kind='
```

Expected: exactly four `kind="document"` occurrences. Two in `Application.js` (`resume`, `basset`) and two in `ContractorProfile.js` (`alcohol_certification`, `resume`). Zero on either `headshot` and zero on `w9`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/drbartender/projects/os/client && CI=true npx react-scripts test --testPathPattern=FileUpload`
Expected: PASS, 7 tests.

- [ ] **Step 5: Confirm the callers still build**

Run: `cd /home/drbartender/projects/os/client && CI=true npx react-scripts build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/FileUpload.js client/src/components/FileUpload.test.js client/src/pages/Application.js client/src/pages/ContractorProfile.js
git commit -m "feat(uploads): validate and downscale at pick time, not after upload"
```

---

### Task A5: Stop the server-side limit path being silent

**Files:**
- Modify: `server/index.js:216-220`

**Interfaces:**
- Consumes: `Sentry` (already imported at `server/index.js:2`).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Implement**

Replace the `fileUpload(...)` block at `server/index.js:216-220` with:

```js
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024;

app.use(fileUpload({
  limits: { fileSize: MAX_UPLOAD_BYTES },
  abortOnLimit: true,
  useTempFiles: false,
  // abortOnLimit stays on: it is the abuse backstop, and turning it off means
  // buffering unbounded uploads in memory. The cost is that it resets the
  // stream mid-body, so the browser reports a bare "network error" rather than
  // reading this 413. The real defence is the client-side check in
  // client/src/utils/uploadLimits.js; this handler exists so that when someone
  // gets past it we find out, instead of the path being silent as it was
  // between 2026-05 and the 2026-07-23 incident.
  //
  // No userId here on purpose: this middleware mounts at line 216, long before
  // any router-level `auth`, so req.user is never populated and recording it
  // would just log a permanent null. The path plus content-length is what
  // identifies the surface.
  limitHandler: (req, res) => {
    Sentry.captureMessage('upload_limit_exceeded', {
      level: 'warning',
      tags: { component: 'upload' },
      extra: {
        path: req.originalUrl,
        method: req.method,
        contentLength: req.headers['content-length'] || null,
        limitBytes: MAX_UPLOAD_BYTES,
      },
    });
    // Derived, never hardcoded. This is the third copy of the limit (client
    // constant, server config, user-facing copy) and the only one a reader
    // would not think to update.
    res.status(413).json({
      error: `That file is too large. The limit is ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))}MB.`,
    });
  },
}));
```

- [ ] **Step 2: Actually trip the limit**

"The server boots" passes whether or not `limitHandler` is ever invoked, whether the Sentry call throws, and whether the message is right. Send a real over-limit upload instead. `/api/application` sits behind `auth`, but `fileUpload` runs first, so an unauthenticated request still exercises the limit path.

The dev server holds port 5000 and does not auto-reload, so restart it first. Avoid a foreground `sleep`; poll instead.

```bash
cd /home/drbartender/projects/os
lsof -ti:5000 | xargs -r kill
# restart the dev server the usual way, then wait for it:
until curl -sf -o /dev/null http://localhost:5000/api/health; do :; done

printf '%%PDF-1.4\n' > /tmp/big.pdf && head -c 12000000 /dev/urandom >> /tmp/big.pdf
printf '%%PDF-1.4\n' > /tmp/small.pdf && head -c 500000 /dev/urandom >> /tmp/small.pdf

echo "under limit: $(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:5000/api/application -F 'resume=@/tmp/small.pdf')"
echo "over limit:  $(curl -s -o /tmp/limit.json -w '%{http_code}' -X POST http://localhost:5000/api/application -F 'resume=@/tmp/big.pdf')"
cat /tmp/limit.json
```

Expected: the small file returns **401** (it got past `fileUpload` and was refused by `auth`, which is the correct proof that the limit did not fire). The 12MB file returns **413** with a JSON body naming the limit in MB. Then confirm a `upload_limit_exceeded` event arrived in Sentry, which is the whole point of the task.

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "feat(uploads): report limit-exceeded uploads to Sentry"
```

---

### Task A6: Document the new upload surface

Per CLAUDE.md's mandatory-docs table, new util files land in the README folder tree.

- [ ] **Step 1: Update the docs**

In `README.md`, add to the folder-structure tree: `client/src/utils/uploadLimits.js`, `client/src/utils/downscaleImage.js`.

In `ARCHITECTURE.md`, note in the file-upload section that onboarding documents (resume, alcohol certification) validate through `isValidOnboardingDocument`, which additionally accepts HEIC, DOC and DOCX, while every other upload keeps the narrow `isValidUpload`.

- [ ] **Step 2: Commit**

```bash
git add README.md ARCHITECTURE.md
git commit -m "docs: record the onboarding upload validators and client limits"
```

---

### Lane A manual check

- [ ] Load the application form on a phone, photograph a document so the file exceeds 10MB, and confirm it uploads with no error (downscaling handles it).
- [ ] Pick a `.docx` resume and confirm it is selectable and uploads.
- [ ] Pick a genuinely oversized PDF (over 10MB, which does not downscale) and confirm the inline message names the real size and the limit, immediately, with no upload wait.
- [ ] **Exercise the HEIC decode-failure fallback**, which the spec names as a Risk and which nothing else in this plan covers. In **Chrome on desktop** (which cannot decode HEIC to canvas, unlike Safari), pick a `.heic` file **under** 10MB and confirm it uploads successfully: `downscaleImage` returns the original untouched and the server's `isValidOnboardingDocument` accepts the HEIC on its magic bytes. Then pick a `.heic` **over** 10MB and confirm it is rejected at pick time with the size message rather than failing mid-upload.

---

## Lane B: Nothing is lost

### Task B1: Draft table

**Files:**
- Modify: `server/db/schema.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: table `onboarding_drafts(id, user_id, form_key, data, created_at, updated_at)` with `UNIQUE (user_id, form_key)`.

- [ ] **Step 1: Add the table**

Append to `server/db/schema.sql`, immediately after the `contractor_profiles` table definition:

```sql
-- Autosaved form state for the long onboarding forms. Server-side rather than
-- localStorage on purpose: the 2026-07-23 incident involved a recruit moving
-- from her phone to a laptop partway through, which browser-local state does
-- not survive. Deliberately excludes payday_protocols, which holds SSN and
-- bank details that are encrypted at rest and must not gain a plaintext copy.
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

Then add the `updated_at` trigger alongside the existing ones near line 318:

```sql
DROP TRIGGER IF EXISTS update_onboarding_drafts_updated_at ON onboarding_drafts;
CREATE TRIGGER update_onboarding_drafts_updated_at BEFORE UPDATE ON onboarding_drafts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

- [ ] **Step 2: Apply and verify against the dev branch**

Run: `cd /home/drbartender/projects/os && node -r dotenv/config -e "require('./server/db').initDb().then(()=>process.exit(0))"`

Then confirm:

```bash
node -r dotenv/config -e "require('./server/db').pool.query(\"SELECT column_name FROM information_schema.columns WHERE table_name='onboarding_drafts' ORDER BY ordinal_position\").then(r=>{console.log(r.rows.map(x=>x.column_name).join(','));process.exit(0)})"
```

Expected: `id,user_id,form_key,data,created_at,updated_at`

- [ ] **Step 3: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(onboarding): add onboarding_drafts table"
```

---

### Task B2: Draft endpoints

**Files:**
- Modify: `server/routes/progress.js`
- Test: `server/routes/progress.draft.test.js` (create)

**Interfaces:**
- Consumes: `onboarding_drafts` from Task B1.
- Produces:
  - `GET /api/progress/draft/:formKey` returns `{ data: object, updated_at: string } | { data: null }`
  - `PUT /api/progress/draft/:formKey` body `{ data: object }`, returns `{ data, updated_at }`
  - `DELETE /api/progress/draft/:formKey` returns `{ ok: true }`
  - Valid `formKey` values: `application`, `contractor_profile`.

- [ ] **Step 1: Write the failing test**

Create `server/routes/progress.draft.test.js`. This follows the harness in `server/routes/staffPortal.test.js`: a minimal express app, the real router with its real auth middleware, driven over `node:http`.

```js
require('dotenv').config();
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const progressRouter = require('./progress');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, base, userId, otherId, token, otherToken;

// NOTE: both details below are load-bearing and were wrong in an earlier
// revision of this plan, which failed every authenticated case:
//   1. auth.js reads decoded.userId / decoded.tokenVersion, NOT id / token_version.
//   2. AppError exposes statusCode, NOT status. res.status(undefined) throws.
// Both mirror server/routes/staffPortal.test.js:129 and :218 exactly.
function app() {
  const a = express();
  a.use(express.json({ limit: '1mb' }));
  a.use('/api/progress', progressRouter);
  a.use((err, req, res, _next) => {
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    res.status(500).json({ error: 'server error' });
  });
  return a;
}

function request(method, path, { body, tok } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(`${base}${path}`, {
      method,
      headers: {
        ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function makeUser(tag) {
  const hash = await bcrypt.hash('x', 4);
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'in_progress', 0) RETURNING id`,
    [`draft-test-${tag}-${NONCE}@example.com`, hash]
  );
  const id = r.rows[0].id;
  // Keys MUST be userId / tokenVersion. See server/middleware/auth.js:41,46.
  return {
    id,
    token: jwt.sign({ userId: id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' }),
  };
}

before(async () => {
  await pool.query("DELETE FROM users WHERE email LIKE 'draft-test-%'");
  ({ id: userId, token } = await makeUser('a'));
  ({ id: otherId, token: otherToken } = await makeUser('b'));
  server = app().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [[userId, otherId]]);
  server.close();
  await pool.end();
});

test('an absent draft reads as null rather than 404', async () => {
  const r = await request('GET', '/api/progress/draft/application', { tok: token });
  assert.equal(r.status, 200);
  assert.equal(r.body.data, null);
});

test('a draft round-trips', async () => {
  const put = await request('PUT', '/api/progress/draft/application', {
    tok: token, body: { data: { full_name: 'Debbie', city: 'Chicago' } },
  });
  assert.equal(put.status, 200);

  const get = await request('GET', '/api/progress/draft/application', { tok: token });
  assert.equal(get.body.data.full_name, 'Debbie');
  assert.ok(get.body.updated_at);
});

test('a second save overwrites rather than duplicating, and advances updated_at', async () => {
  const before = await request('GET', '/api/progress/draft/application', { tok: token });
  // The UPSERT sets only `data`; updated_at depends entirely on the trigger from
  // Task B1. Without it the timestamp freezes at insert time and B4 renders a
  // permanently stale "We saved your answers from ..." notice.
  await new Promise(r => setTimeout(r, 1100));
  await request('PUT', '/api/progress/draft/application', { tok: token, body: { data: { city: 'Evanston' } } });
  const get = await request('GET', '/api/progress/draft/application', { tok: token });
  assert.ok(new Date(get.body.updated_at) > new Date(before.body.updated_at),
    'update_onboarding_drafts_updated_at trigger is missing or not firing');
  assert.equal(get.body.data.city, 'Evanston');
  assert.equal(get.body.data.full_name, undefined, 'PUT replaces the payload, it does not merge');

  const rows = await pool.query('SELECT COUNT(*) FROM onboarding_drafts WHERE user_id = $1', [userId]);
  assert.equal(rows.rows[0].count, '1');
});

test('drafts are scoped per user', async () => {
  const get = await request('GET', '/api/progress/draft/application', { tok: otherToken });
  assert.equal(get.body.data, null, "another user's draft must not leak");
});

test('the two form keys are independent', async () => {
  await request('PUT', '/api/progress/draft/contractor_profile', { tok: token, body: { data: { phone: '3125551212' } } });
  const app_ = await request('GET', '/api/progress/draft/application', { tok: token });
  const cp = await request('GET', '/api/progress/draft/contractor_profile', { tok: token });
  assert.equal(app_.body.data.city, 'Evanston');
  assert.equal(cp.body.data.phone, '3125551212');
});

test('an unknown form key is rejected', async () => {
  const r = await request('PUT', '/api/progress/draft/payday_protocols', { tok: token, body: { data: { ssn: '000-00-0000' } } });
  assert.equal(r.status, 400);
  const rows = await pool.query("SELECT COUNT(*) FROM onboarding_drafts WHERE form_key = 'payday_protocols'");
  assert.equal(rows.rows[0].count, '0', 'the excluded sensitive form must never persist');
});

test('a non-object payload is rejected', async () => {
  const r = await request('PUT', '/api/progress/draft/application', { tok: token, body: { data: 'nope' } });
  assert.equal(r.status, 400);
});

test('an oversized payload is rejected', async () => {
  const r = await request('PUT', '/api/progress/draft/application', {
    tok: token, body: { data: { blob: 'x'.repeat(70 * 1024) } },
  });
  assert.equal(r.status, 400);
});

test('delete clears the draft', async () => {
  const del = await request('DELETE', '/api/progress/draft/application', { tok: token });
  assert.equal(del.status, 200);
  const get = await request('GET', '/api/progress/draft/application', { tok: token });
  assert.equal(get.body.data, null);
});

test('unauthenticated access is refused', async () => {
  const r = await request('GET', '/api/progress/draft/application');
  assert.equal(r.status, 401);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/drbartender/projects/os && node -r dotenv/config --test server/routes/progress.draft.test.js`
Expected: FAIL with 404s, the routes do not exist.

- [ ] **Step 3: Implement the endpoints**

In `server/routes/progress.js`, add below the existing `PUT /step` handler and above `module.exports`:

```js
// Autosaved drafts for the two long onboarding forms.
//
// payday_protocols is deliberately absent: it carries SSN and bank routing and
// account numbers, which live encrypted at rest. A draft row would be a second,
// plaintext copy of exactly the data we encrypt. The allowlist is the guard.
const DRAFT_FORM_KEYS = ['application', 'contractor_profile'];
const MAX_DRAFT_BYTES = 64 * 1024;

function assertFormKey(formKey) {
  if (!DRAFT_FORM_KEYS.includes(formKey)) {
    throw new ValidationError({ formKey: 'Unknown form.' });
  }
}

router.get('/draft/:formKey', auth, asyncHandler(async (req, res) => {
  assertFormKey(req.params.formKey);
  const result = await pool.query(
    'SELECT data, updated_at FROM onboarding_drafts WHERE user_id = $1 AND form_key = $2',
    [req.user.id, req.params.formKey]
  );
  const row = result.rows[0];
  res.json(row ? { data: row.data, updated_at: row.updated_at } : { data: null });
}));

router.put('/draft/:formKey', auth, asyncHandler(async (req, res) => {
  assertFormKey(req.params.formKey);
  const { data } = req.body;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ValidationError({ data: 'Draft data must be an object.' });
  }
  const serialized = JSON.stringify(data);
  if (Buffer.byteLength(serialized) > MAX_DRAFT_BYTES) {
    throw new ValidationError({ data: 'Draft is too large to save.' });
  }

  const result = await pool.query(`
    INSERT INTO onboarding_drafts (user_id, form_key, data)
    VALUES ($1, $2, $3::jsonb)
    ON CONFLICT (user_id, form_key)
      DO UPDATE SET data = EXCLUDED.data
    RETURNING data, updated_at
  `, [req.user.id, req.params.formKey, serialized]);

  res.json({ data: result.rows[0].data, updated_at: result.rows[0].updated_at });
}));

router.delete('/draft/:formKey', auth, asyncHandler(async (req, res) => {
  assertFormKey(req.params.formKey);
  await pool.query(
    'DELETE FROM onboarding_drafts WHERE user_id = $1 AND form_key = $2',
    [req.user.id, req.params.formKey]
  );
  res.json({ ok: true });
}));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/drbartender/projects/os && node -r dotenv/config --test server/routes/progress.draft.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add server/routes/progress.js server/routes/progress.draft.test.js
git commit -m "feat(onboarding): server-side draft endpoints for the long forms"
```

---

### Task B3: The useFormDraft hook

**Files:**
- Create: `client/src/hooks/useFormDraft.js`
- Test: `client/src/hooks/useFormDraft.test.js`

**Interfaces:**
- Consumes: `GET`/`PUT`/`DELETE /progress/draft/:formKey` from Task B2, via `client/src/utils/api.js`.
- Produces: `useFormDraft(formKey, snapshot, applyDraft, opts?) -> { restoredAt: string | null, clearDraft: () => Promise<void>, ready: boolean }`
  - `snapshot` is **any serializable object representing everything the form should preserve**, not necessarily one `useState`. `Application.js` keeps `positions`, `experienceTypes`, `tools`, and `equipment` in four separate `useState` hooks outside `form` (lines 113-116), and `positions` is a **required** field. A hook that drafted only `form` would restore the text answers and silently drop every checkbox section, which is a half-working version of the one feature this lane exists to deliver. The caller decides what goes in the snapshot; the hook just persists it.
  - `applyDraft(data)` is called once on mount if a stored draft holds real content. It receives the snapshot shape back and is responsible for splitting it across whatever state it came from.
  - `opts.enabled` (default `true`) defers the draft load until the caller says go. Used by ContractorProfile to sequence behind its own profile fetch.
  - `ready` is false until the initial load settles, so the debounced save never fires before the restore.
  - `clearDraft()` is called by the form on successful submit.
- Also produces: `hasContent(data: object) -> boolean`, exported for its own test.

- [ ] **Step 1: Write the failing test**

Create `client/src/hooks/useFormDraft.test.js`:

```js
import '@testing-library/jest-dom';
import React, { useState, useEffect } from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import useFormDraft from './useFormDraft';
import api from '../utils/api';

jest.mock('../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), put: jest.fn(), delete: jest.fn() },
}));

function Harness({ initial = { city: '' } }) {
  const [form, setForm] = useState(initial);
  const { restoredAt, clearDraft, ready } = useFormDraft('application', form, d => setForm(f => ({ ...f, ...d })));
  return (
    <div>
      <div data-testid="city">{form.city}</div>
      <div data-testid="ready">{String(ready)}</div>
      <div data-testid="restored">{restoredAt || ''}</div>
      <button onClick={() => setForm(f => ({ ...f, city: 'Chicago' }))}>type</button>
      <button onClick={clearDraft}>clear</button>
    </div>
  );
}

// Mirrors ContractorProfile: the page loads saved profile data on mount, and
// the draft load waits on it. `profile` stands in for that server-loaded data.
function Gated({ enabled, profile }) {
  const [form, setForm] = useState({ phone: '' });
  useEffect(() => {
    if (profile) setForm(f => ({ ...f, ...profile }));
  }, [profile]);
  useFormDraft('contractor_profile', form, d => setForm(f => ({ ...f, ...d })), { enabled });
  return <div data-testid="phone">{form.phone}</div>;
}

beforeEach(() => {
  jest.useFakeTimers();
  api.get.mockReset();
  api.put.mockReset().mockResolvedValue({ data: {} });
  api.delete.mockReset().mockResolvedValue({ data: {} });
});

afterEach(() => { jest.useRealTimers(); });

it('restores a stored draft on mount', async () => {
  api.get.mockResolvedValue({ data: { data: { city: 'Evanston' }, updated_at: '2026-07-23T20:00:00Z' } });
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('city')).toHaveTextContent('Evanston'));
  expect(screen.getByTestId('restored')).toHaveTextContent('2026-07-23T20:00:00Z');
});

it('leaves the form alone when there is no draft', async () => {
  api.get.mockResolvedValue({ data: { data: null } });
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));
  expect(screen.getByTestId('city')).toHaveTextContent('');
  expect(screen.getByTestId('restored')).toHaveTextContent('');
});

it('does not announce a restore for a draft of empty fields', async () => {
  api.get.mockResolvedValue({ data: { data: { city: '', name: '' }, updated_at: '2026-07-23T20:00:00Z' } });
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));
  expect(screen.getByTestId('restored')).toHaveTextContent('');
});

it('never saves an untouched form', async () => {
  api.get.mockResolvedValue({ data: { data: null } });
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));
  await act(async () => { jest.advanceTimersByTime(10000); });
  expect(api.put).not.toHaveBeenCalled();
});

it('does not save when an edit returns the form to its starting value', async () => {
  api.get.mockResolvedValue({ data: { data: null } });
  render(<Harness initial={{ city: 'Chicago' }} />);
  await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));
  act(() => { screen.getByText('type').click(); }); // sets city back to 'Chicago'
  await act(async () => { jest.advanceTimersByTime(1500); });
  expect(api.put).not.toHaveBeenCalled();
});

it('does not fetch until enabled', async () => {
  api.get.mockResolvedValue({ data: { data: null } });
  const { rerender } = render(<Gated enabled={false} />);
  await act(async () => {});
  expect(api.get).not.toHaveBeenCalled();

  rerender(<Gated enabled={true} />);
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/progress/draft/contractor_profile'));
});

// The outcome the `enabled` gate exists to guarantee, not just the mechanism.
// This is the spec Risk "draft restore versus server-loaded profile data".
it('lets the draft win over already-loaded profile data', async () => {
  api.get.mockResolvedValue({ data: { data: { phone: '7735551111' }, updated_at: '2026-07-26T12:00:00Z' } });

  // enabled=false models the page before /contractor resolves. The profile
  // value lands first, exactly as ContractorProfile's own fetch would set it.
  const { rerender } = render(<Gated enabled={false} profile={{ phone: '3125550000' }} />);
  await waitFor(() => expect(screen.getByTestId('phone')).toHaveTextContent('3125550000'));

  // Now the profile fetch has settled, so the draft is allowed to load.
  rerender(<Gated enabled={true} profile={{ phone: '3125550000' }} />);
  await waitFor(() => expect(screen.getByTestId('phone')).toHaveTextContent('7735551111'));
});

it('does not save before the initial load settles', async () => {
  let resolveGet;
  api.get.mockReturnValue(new Promise(r => { resolveGet = r; }));
  render(<Harness />);
  act(() => { jest.advanceTimersByTime(5000); });
  expect(api.put).not.toHaveBeenCalled();
  await act(async () => { resolveGet({ data: { data: null } }); });
});

it('saves on a debounce after a change', async () => {
  api.get.mockResolvedValue({ data: { data: null } });
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));

  act(() => { screen.getByText('type').click(); });
  expect(api.put).not.toHaveBeenCalled();

  await act(async () => { jest.advanceTimersByTime(1500); });
  expect(api.put).toHaveBeenCalledWith('/progress/draft/application', { data: { city: 'Chicago' } });
});

it('coalesces rapid edits into one save', async () => {
  api.get.mockResolvedValue({ data: { data: null } });
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));

  act(() => { screen.getByText('type').click(); jest.advanceTimersByTime(500); });
  act(() => { screen.getByText('type').click(); jest.advanceTimersByTime(500); });
  await act(async () => { jest.advanceTimersByTime(1500); });
  expect(api.put).toHaveBeenCalledTimes(1);
});

it('clearDraft deletes server side', async () => {
  api.get.mockResolvedValue({ data: { data: null } });
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));
  await act(async () => { screen.getByText('clear').click(); });
  expect(api.delete).toHaveBeenCalledWith('/progress/draft/application');
});

it('a failed save is swallowed and never surfaces to the user', async () => {
  api.get.mockResolvedValue({ data: { data: null } });
  api.put.mockRejectedValue({ message: 'Network error. Check your connection.' });
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));
  act(() => { screen.getByText('type').click(); });
  await act(async () => { jest.advanceTimersByTime(1500); });
  expect(screen.getByTestId('city')).toHaveTextContent('Chicago');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/drbartender/projects/os/client && CI=true npx react-scripts test --testPathPattern=useFormDraft`
Expected: FAIL, cannot resolve `./useFormDraft`.

- [ ] **Step 3: Implement the hook**

Create `client/src/hooks/useFormDraft.js`:

```js
import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../utils/api';

const DEBOUNCE_MS = 1500;

/**
 * Autosave a long onboarding form against the user's account.
 *
 * Server-side rather than localStorage because the failure this exists to
 * prevent (incident 2026-07-23) involved someone moving from a phone to a
 * laptop mid-form. Browser-local state does not survive that.
 *
 * Saving is best-effort and silent. A draft save that fails must never
 * interrupt someone who is mid-form: the submit is what matters, this is a
 * safety net under it.
 */
// A stored draft counts as real only if it holds at least one answer. An object
// of empty strings is what an untouched form serialises to, and announcing a
// restore for that is worse than saying nothing.
export function hasContent(data) {
  if (!data || typeof data !== 'object') return false;
  return Object.values(data).some(v => {
    if (v === '' || v === null || v === undefined || v === false) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return true;
  });
}

// `snapshot` is whatever the caller wants preserved, as one serializable object.
// It is deliberately not "the form state hook": Application.js spreads its
// answers across five useState hooks, and drafting only one of them would
// restore the typed answers while losing every checkbox.
export default function useFormDraft(formKey, snapshot, applyDraft, { enabled = true } = {}) {
  const [ready, setReady] = useState(false);
  const [restoredAt, setRestoredAt] = useState(null);
  const applyRef = useRef(applyDraft);
  const clearedRef = useRef(false);
  const baselineRef = useRef(null);
  applyRef.current = applyDraft;

  // Load once, and not before `enabled`.
  //
  // `enabled` exists for ContractorProfile, which independently fetches saved
  // profile data on mount. Two unsequenced fetches race, and whichever lands
  // last wins, so a slow /contractor response would silently clobber a restored
  // draft. Gating the draft load on the profile load makes the overlay order
  // deterministic instead of a coin flip.
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    api.get(`/progress/draft/${formKey}`)
      .then(res => {
        if (cancelled) return;
        const { data, updated_at } = res.data || {};
        if (hasContent(data)) {
          applyRef.current(data);
          setRestoredAt(updated_at || null);
        }
      })
      .catch(() => { /* no draft is not an error worth showing */ })
      .finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [formKey, enabled]);

  // Save only what the user actually changed.
  //
  // Without the baseline, this effect fires the moment `ready` flips and
  // persists the untouched initial form. That empty row then reads back as a
  // real draft on the next visit and the page announces "we saved your answers
  // from 3:42 PM" to someone who never typed a character.
  useEffect(() => {
    if (!ready || clearedRef.current) return undefined;
    const serialized = JSON.stringify(snapshot);
    if (baselineRef.current === null) {
      baselineRef.current = serialized;   // First pass after load: adopt, do not save.
      return undefined;
    }
    if (serialized === baselineRef.current) return undefined;  // Edited back to where it started.
    const t = setTimeout(() => {
      api.put(`/progress/draft/${formKey}`, { data: snapshot }).catch(() => {});
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [ready, formKey, snapshot]);

  const clearDraft = useCallback(async () => {
    clearedRef.current = true;
    try {
      await api.delete(`/progress/draft/${formKey}`);
    } catch (err) { /* the form already submitted; a stale draft is harmless */ }
  }, [formKey]);

  return { ready, restoredAt, clearDraft };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/drbartender/projects/os/client && CI=true npx react-scripts test --testPathPattern=useFormDraft`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/hooks/useFormDraft.js client/src/hooks/useFormDraft.test.js
git commit -m "feat(onboarding): useFormDraft autosave hook"
```

---

### Task B4: Wire drafts into the two forms

**Files:**
- Modify: `client/src/pages/Application.js`
- Modify: `client/src/pages/ContractorProfile.js`

**Interfaces:**
- Consumes: `useFormDraft` from Task B3.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Wire Application.js**

Add the import beside the other hook imports:

```js
import useFormDraft from '../hooks/useFormDraft';
```

This page spreads its answers across **five** state hooks, not one: `form`, plus `positions`, `experienceTypes`, `tools`, and `equipment` (lines 113-116). `positions` is a required field. Drafting only `form` would restore the typed answers and silently drop every checkbox section, so the snapshot has to carry all five.

Add below the `equipment` state declaration (line 116), after the four checkbox hooks exist:

```js
  // Everything worth preserving, as one object. Memoised so the hook's change
  // detection compares content rather than a fresh object identity per render.
  //
  // Files are deliberately absent: a File is not serialisable to the draft
  // table, and they do not need to be. They are the last section, and React
  // holds them across a failed submit. Only a page reload loses them.
  const draftSnapshot = useMemo(
    () => ({ form, positions, experienceTypes, tools, equipment }),
    [form, positions, experienceTypes, tools, equipment]);

  const { restoredAt, clearDraft } = useFormDraft('application', draftSnapshot, draft => {
    if (draft.form) setForm(f => ({ ...f, ...draft.form }));
    if (draft.positions) setPositions(p => ({ ...p, ...draft.positions }));
    if (draft.experienceTypes) setExperienceTypes(t => ({ ...t, ...draft.experienceTypes }));
    if (draft.tools) setTools(t => ({ ...t, ...draft.tools }));
    if (draft.equipment) setEquipment(e => ({ ...e, ...draft.equipment }));
  });
```

Add `useMemo` to the existing React import if it is not already there.

Immediately after the successful `api.post('/application', data)` call (line 211) and before the navigation, add:

```js
      await clearDraft();
```

Render the restore notice at the top of the form, immediately inside `<form onSubmit={submit}>` (line 256):

```jsx
          {restoredAt && (
            <div className="alert alert-info" role="status">
              We saved your answers from {new Date(restoredAt).toLocaleString()}. Pick up where you left off.
            </div>
          )}
```

- [ ] **Step 2: Wire ContractorProfile.js**

Add the same import. This page independently fetches saved profile data from `GET /contractor` on mount, so the draft load must be **sequenced behind it, not merely declared after it.** Two unsequenced fetches race, and whichever resolves last wins: a slow `/contractor` response would silently overwrite a restored draft with older saved data.

Add a flag that the existing profile-loading effect sets when it settles:

```js
  const [profileLoaded, setProfileLoaded] = useState(false);
```

In that effect's promise chain, add `.finally(() => setProfileLoaded(true));` so it flips on both success and failure. A failed profile fetch must not strand the draft forever.

Then gate the hook on it:

```js
  // enabled: the draft is an overlay on top of saved profile data, so it must
  // load second. Deterministic ordering, not a race we hope resolves our way.
  const { restoredAt, clearDraft } = useFormDraft('contractor_profile', form,
    draft => setForm(f => ({ ...f, ...draft })), { enabled: profileLoaded });
```

Call `await clearDraft();` after the successful profile POST, and render the same restore notice at the top of its form.

- [ ] **Step 3: Verify the build**

Run: `cd /home/drbartender/projects/os/client && CI=true npx react-scripts build`
Expected: build succeeds.

Run: `cd /home/drbartender/projects/os && wc -l client/src/pages/Application.js client/src/pages/ContractorProfile.js`

Expected: `Application.js` lands near **714** (685 before this plan, roughly +2 from `upload-honesty`, +27 here). **It crosses the 700 soft cap in THIS lane**, which warns and never blocks. If it exceeds 1000 something has gone badly wrong.

Do not use `check-file-size.js --all | grep` for this: that command prints only RED and YELLOW rows, so a file under the cap produces no output and a non-zero exit, and the check cannot distinguish "fine" from "grep found nothing". `wc -l` gives a number you can actually compare.

- [ ] **Step 4: Manual check**

- [ ] Fill three sections of the application **including at least one position checkbox, one bar tool, and one equipment box**, wait two seconds, hard-reload, and confirm every one of them comes back, not just the typed fields. This is the specific regression the five-hook snapshot exists to prevent.
- [ ] Fill part of the form on one browser, open the same account in a second browser, and confirm the draft appears there. This is the device-switch case that localStorage would not have covered.
- [ ] Submit the form successfully, then reload, and confirm no stale draft is restored.
- [ ] On the contractor profile, confirm existing saved profile data still loads correctly when no draft exists.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/Application.js client/src/pages/ContractorProfile.js
git commit -m "feat(onboarding): autosave the application and contractor profile"
```

---

### Task B5: Document the drafts surface

- [ ] **Step 1: Update the docs**

In `README.md`, add `client/src/hooks/useFormDraft.js` to the folder-structure tree.

In `ARCHITECTURE.md`, add `onboarding_drafts` to the Database Schema section (columns, the `UNIQUE (user_id, form_key)` constraint, and the note that `payday_protocols` is deliberately excluded because it carries SSN and bank details that are encrypted at rest), and add the three routes to the API route table: `GET`, `PUT` and `DELETE /api/progress/draft/:formKey`.

- [ ] **Step 2: Commit**

```bash
git add README.md ARCHITECTURE.md
git commit -m "docs: record onboarding_drafts and the draft endpoints"
```

---

## Lane C: Files stop blocking submit

**Three lanes touch `client/src/pages/Application.js`** (`upload-honesty` adds `kind`, `onboarding-drafts` adds the draft snapshot, `submit-gate-relax` removes the file rules), and two touch `ContractorProfile.js` and `server/routes/progress.js`. **Run all four strictly in the front-matter order, never as parallel worktrees.**

C1 to C3 are the `document-visibility` lane; C4 is `submit-gate-relax` on its own. Keeping the gate removal separate is deliberate: a squash merge would otherwise bury it in the same commit as the alert it depends on, and it is the one change here that might warrant reverting alone.

**Order inside Lane C is load-bearing.** The safety nets get built before the guard comes down. C3 is the task that lets a recruit submit with documents missing; C1 and C2 are what make that visible. C1 declares no dependency on either sibling, so this ordering costs nothing.

### Two different questions, deliberately scoped differently

This lane answers two things that sound like one:

**"What do I still owe?"** is informational, asked by the recruit about themselves. It covers both documents and everyone still moving through onboarding, including `applied` and `interviewing`. Nobody is harmed by an over-broad to-do list on their own page.

**"Who can work a shift without a certification?"** is a compliance alert, asked by the admin about everyone. It covers the certification only, and only people who can actually be assigned.

Sizing the naive version against production is what forced the split. A predicate covering both documents across all onboarding statuses returns **50 rows**, into a strip capped at 6 whose overflow row links to `/events`:

| Status | Owing something | No certification | No resume |
|---|---|---|---|
| hired (legacy) | 33 | 13 | 33 |
| in_progress | 11 | 11 | 11 |
| approved | 6 | **2** | 6 |

The resume generates all of the volume and none of the risk: every one of the 50 lacks one, because it is a nice-to-have on people already hired. The certification among people who can actually be staffed is **2 rows**, and both are real:

- **Debbie (241)**, worked shift 363 on 2026-07-25 with no certification on file.
- **Loryn (55)**, booked on shift 347 for **2026-08-01**, no certification on file.

So the admin alert is scoped to the certification, among exactly the statuses `server/routes/shifts.approval.js:233` uses to gate assignment. Not a hand-picked list: the same one the assignment code enforces, so the alert covers precisely the population that can be put in front of a client.

That scoping also closes a gap by construction. An ordinary applicant becomes `applied` on submit (`server/routes/application.js:278`), and C3 removes their file gate too. Tying the alert to the assignment gate means they are correctly absent from the compliance alert (they cannot be staffed) while still being told what they owe on their own page.

### Task C1: The shared predicate

**Files:**
- Create: `server/utils/outstandingDocuments.js`
- Test: `server/utils/outstandingDocuments.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `outstandingFor(userId) -> Promise<string[]>`: labels for one user, e.g. `['resume', 'alcohol certification']`, empty when nothing is owed. Broad status set.
  - `listUncertifiedStaffable() -> Promise<Array<{ user_id, name, next_shift_id, next_shift_date }>>`: everyone who can be assigned to a shift and has no certification on file, soonest upcoming shift first. `next_shift_*` are null when they are not currently booked.
  - `ONBOARDING_STATUSES: string[]`, `STAFFABLE_STATUSES: string[]`

- [ ] **Step 1: Write the failing test**

Create `server/utils/outstandingDocuments.test.js`.

**The `applications` fixtures must satisfy eight NOT NULL columns with no defaults** (`full_name, phone, city, state, travel_distance, reliable_transportation, positions_interested, why_dr_bartender`, verified against the live schema). An earlier revision omitted them and would have aborted `before()`, failing the suite before a single assertion ran.

```js
require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const { pool } = require('../db');
const { outstandingFor, listUncertifiedStaffable } = require('./outstandingDocuments');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const ids = {};
let shiftId;

async function mkUser(tag, status) {
  const hash = await bcrypt.hash('x', 4);
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', $3, 0) RETURNING id`,
    [`odoc-${tag}-${NONCE}@example.com`, hash, status]
  );
  return r.rows[0].id;
}

// applications has eight NOT NULL columns with no default; supply them all.
async function mkApplication(userId, name, { resume = null, basset = null } = {}) {
  await pool.query(
    `INSERT INTO applications
       (user_id, full_name, phone, city, state, travel_distance, reliable_transportation,
        positions_interested, why_dr_bartender, resume_file_url, basset_file_url)
     VALUES ($1, $2, '3125550000', 'Chicago', 'Illinois', '30 minutes', 'Yes',
             '["Bartender"]', 'testing', $3, $4)`,
    [userId, name, resume, basset]
  );
}

before(async () => {
  await pool.query("DELETE FROM users WHERE email LIKE 'odoc-%'");

  // Owes both, no application row at all. The direct-hire case an INNER JOIN drops.
  ids.bare = await mkUser('bare', 'in_progress');

  // Owes nothing; both documents on the APPLICATION only.
  ids.viaApp = await mkUser('viaapp', 'approved');
  await mkApplication(ids.viaApp, 'Via App', { resume: '/files/r.pdf', basset: '/files/b.pdf' });

  // Owes nothing; both on the CONTRACTOR PROFILE only. The pair that diverged
  // when the two surfaces computed the predicate separately.
  ids.viaProfile = await mkUser('viaprofile', 'approved');
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, resume_file_url, alcohol_certification_file_url)
     VALUES ($1, 'Via Profile', '/files/r.pdf', '/files/c.pdf')`, [ids.viaProfile]);

  // STAFFABLE and uncertified, not booked. Belongs in the alert.
  ids.riskIdle = await mkUser('riskidle', 'approved');
  await mkApplication(ids.riskIdle, 'Risk Idle', { resume: '/files/r.pdf' });

  // STAFFABLE, uncertified, AND booked on an upcoming shift. Highest priority.
  ids.riskBooked = await mkUser('riskbooked', 'approved');
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, resume_file_url)
     VALUES ($1, 'Risk Booked', '/files/r.pdf')`, [ids.riskBooked]);
  const sh = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, location, positions_needed, status, client_name)
     VALUES (CURRENT_DATE + 5, '3:00 PM', '7:00 PM', 'Test', '["Bartender"]', 'open', $1) RETURNING id`,
    [`odoc-client-${NONCE}`]);
  shiftId = sh.rows[0].id;
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1, $2, 'Bartender', 'approved')`,
    [shiftId, ids.riskBooked]);

  // Uncertified but NOT staffable: mid-onboarding, cannot be assigned.
  ids.notYet = await mkUser('notyet', 'in_progress');

  // Uncertified and 'applied'. C3 removes their file gate, so they must be told
  // what they owe, but they cannot be staffed and must stay out of the alert.
  ids.applied = await mkUser('applied', 'applied');
  await mkApplication(ids.applied, 'Applied Person');

  // Off-funnel entirely.
  ids.gone = await mkUser('gone', 'deactivated');
});

after(async () => {
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [shiftId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`odoc-%${NONCE}@example.com`]);
  await pool.end();
});

// ── outstandingFor: the recruit's own to-do, both documents, broad statuses ──

test('a user with no application row owes both documents', async () => {
  assert.deepEqual(await outstandingFor(ids.bare), ['resume', 'alcohol certification']);
});

test('documents on the application satisfy the requirement', async () => {
  assert.deepEqual(await outstandingFor(ids.viaApp), []);
});

test('documents on the contractor profile satisfy the requirement', async () => {
  assert.deepEqual(await outstandingFor(ids.viaProfile), []);
});

test('a partially complete user owes only what is missing', async () => {
  assert.deepEqual(await outstandingFor(ids.riskIdle), ['alcohol certification']);
});

test('an applicant is told what they owe even though they cannot be staffed', async () => {
  // C3 removes their file gate, so this MUST NOT be empty.
  assert.deepEqual(await outstandingFor(ids.applied), ['resume', 'alcohol certification']);
});

test('an off-funnel user owes nothing', async () => {
  assert.deepEqual(await outstandingFor(ids.gone), []);
});

// ── listUncertifiedStaffable: the admin alert, certification only, staffable only ──

test('the alert names staffable people with no certification', async () => {
  const rows = await listUncertifiedStaffable();
  const listed = rows.map(r => r.user_id);
  assert.ok(listed.includes(ids.riskIdle), 'an approved, uncertified worker must be listed');
  assert.ok(listed.includes(ids.riskBooked), 'a booked, uncertified worker must be listed');
});

test('the alert excludes people who cannot be staffed', async () => {
  const listed = (await listUncertifiedStaffable()).map(r => r.user_id);
  for (const id of [ids.bare, ids.notYet, ids.applied, ids.gone]) {
    assert.equal(listed.includes(id), false,
      `user ${id} cannot be assigned to a shift and must not raise a compliance alert`);
  }
});

test('the alert ignores a missing resume', async () => {
  // viaApp has both; riskIdle has a resume but no cert; a resume-only gap is not an alert.
  const listed = (await listUncertifiedStaffable()).map(r => r.user_id);
  assert.equal(listed.includes(ids.viaApp), false);
});

test('a booked worker carries their next shift, an idle one carries null', async () => {
  const rows = await listUncertifiedStaffable();
  const booked = rows.find(r => r.user_id === ids.riskBooked);
  const idle = rows.find(r => r.user_id === ids.riskIdle);
  assert.equal(booked.next_shift_id, shiftId);
  assert.ok(booked.next_shift_date, 'a booked worker must expose the date so the row can escalate');
  assert.equal(idle.next_shift_id, null);
});

test('booked workers sort ahead of idle ones', async () => {
  const rows = await listUncertifiedStaffable();
  const iBooked = rows.findIndex(r => r.user_id === ids.riskBooked);
  const iIdle = rows.findIndex(r => r.user_id === ids.riskIdle);
  assert.ok(iBooked < iIdle, 'someone about to work uncertified outranks someone merely eligible');
});

test('names fall back through profile, application, then email', async () => {
  const rows = await listUncertifiedStaffable();
  assert.equal(rows.find(r => r.user_id === ids.riskBooked).name, 'Risk Booked');
  assert.equal(rows.find(r => r.user_id === ids.riskIdle).name, 'Risk Idle');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/drbartender/projects/os && node -r dotenv/config --test server/utils/outstandingDocuments.test.js`
Expected: FAIL, `Cannot find module './outstandingDocuments'`.

- [ ] **Step 3: Implement**

Create `server/utils/outstandingDocuments.js`:

```js
const { pool } = require('../db');

// Two questions that sound like one.
//
// "What do I still owe?" is informational, asked by a recruit about themselves.
// Both documents, everyone mid-onboarding. Nobody is harmed by an over-broad
// to-do list on their own page.
//
// "Who can work a shift with no certification?" is a compliance alert, asked by
// the admin about everyone. Certification only, and only people who can
// actually be assigned. Sized against production, the naive version (both
// documents, all onboarding statuses) returns 50 rows into a 6-row strip, of
// which 50 lack a resume and 2 are genuine risk.
//
// LEFT JOINs throughout, deliberately. The sibling queries in admin/hiring.js
// INNER JOIN applications, which is right for funnel stats but would hide
// exactly the people this exists for: direct hires who never completed the
// application. A missing row means missing documents, not an absent person.

// Anyone still moving through onboarding. Includes 'applied' and 'interviewing'
// because C3 removed the file gate for them too, so they must still be TOLD.
const ONBOARDING_STATUSES = [
  'applied', 'interviewing', 'in_progress', 'hired', 'submitted', 'reviewed', 'approved',
];

// Mirrors the assignment gate in server/routes/shifts.approval.js:233. Keep in
// sync: this list IS the definition of "can be put in front of a client".
const STAFFABLE_STATUSES = ['submitted', 'reviewed', 'approved'];

const DOC_JOINS = `
  LEFT JOIN applications a ON a.user_id = u.id
  LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
`;

// Either storage location satisfies the requirement.
const RESUME_MISSING = 'COALESCE(cp.resume_file_url, a.resume_file_url) IS NULL';
const CERT_MISSING = 'COALESCE(cp.alcohol_certification_file_url, a.basset_file_url) IS NULL';

const DISPLAY_NAME = 'COALESCE(cp.preferred_name, a.full_name, u.email)';

async function outstandingFor(userId) {
  const result = await pool.query(`
    SELECT ${RESUME_MISSING} AS needs_resume,
           ${CERT_MISSING}   AS needs_cert
    FROM users u ${DOC_JOINS}
    WHERE u.id = $1
      AND u.role IN ('staff', 'manager')
      AND u.onboarding_status = ANY($2)
  `, [userId, ONBOARDING_STATUSES]);

  const row = result.rows[0];
  if (!row) return [];   // Not onboarding: owes nothing by definition.

  const owed = [];
  if (row.needs_resume) owed.push('resume');
  if (row.needs_cert) owed.push('alcohol certification');
  return owed;
}

// Certification only, staffable only, soonest upcoming shift first.
//
// The lateral join is what separates "eligible but idle" from "about to pour
// drinks uncertified". Both belong in the list; only the second is urgent.
async function listUncertifiedStaffable() {
  const result = await pool.query(`
    SELECT u.id AS user_id,
           ${DISPLAY_NAME} AS name,
           ns.shift_id     AS next_shift_id,
           ns.event_date   AS next_shift_date
    FROM users u ${DOC_JOINS}
    LEFT JOIN LATERAL (
      SELECT s.id AS shift_id, s.event_date
      FROM shift_requests r
      JOIN shifts s ON s.id = r.shift_id
      WHERE r.user_id = u.id
        AND r.status = 'approved'
        AND r.dropped_at IS NULL
        AND s.event_date >= CURRENT_DATE
      ORDER BY s.event_date
      LIMIT 1
    ) ns ON true
    WHERE u.role IN ('staff', 'manager')
      AND u.onboarding_status = ANY($1)
      AND ${CERT_MISSING}
    ORDER BY ns.event_date ASC NULLS LAST, u.id DESC
  `, [STAFFABLE_STATUSES]);

  return result.rows;
}

module.exports = {
  outstandingFor, listUncertifiedStaffable,
  ONBOARDING_STATUSES, STAFFABLE_STATUSES,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/drbartender/projects/os && node -r dotenv/config --test server/utils/outstandingDocuments.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 5: Verify against real production data**

`node -r dotenv/config` reads the local `.env` and hits the **dev** branch, so it cannot answer this. Use the Neon MCP against project `round-tooth-34649976`, branch `br-noisy-frog-ad99sa6l` (`production`), read-only:

```sql
SELECT u.id, COALESCE(cp.preferred_name, a.full_name, u.email) AS name, u.onboarding_status,
       (SELECT min(s.event_date) FROM shift_requests r JOIN shifts s ON s.id=r.shift_id
         WHERE r.user_id=u.id AND r.status='approved' AND r.dropped_at IS NULL
           AND s.event_date >= CURRENT_DATE) AS next_shift
FROM users u
LEFT JOIN applications a ON a.user_id = u.id
LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
WHERE u.role IN ('staff','manager')
  AND u.onboarding_status IN ('submitted','reviewed','approved')
  AND COALESCE(cp.alcohol_certification_file_url, a.basset_file_url) IS NULL
ORDER BY next_shift ASC NULLS LAST;
```

Expected: a **short** list, on the order of two rows, containing **Debbie (241)** and **Loryn (55)**, with Loryn carrying an upcoming `next_shift`. If this returns dozens of rows, the scoping has been widened back out and the alert is noise again. Sizing the output is not optional here: an earlier revision shipped a version that returned 50.

- [ ] **Step 6: Commit**

```bash
git add server/utils/outstandingDocuments.js server/utils/outstandingDocuments.test.js
git commit -m "feat(onboarding): shared document predicate, plus the uncertified-staffable alert"
```

---

### Task C2: Put the uncertified workers on the admin's screen

One row per person, each linking to that person. `AdminUserDetail`'s `DocumentsTab` already renders which document is missing using the identical profile-then-application fallback (`DocumentsTab.js:13-17`), so the click lands somewhere that already answers the question. A single count would link to `/hiring`, whose list comes from `/admin/applications` and INNER JOINs applications (`HiringDashboard.js:59`), omitting every direct hire the alert exists for.

**Not touching `/hiring/summary`.** A dedicated endpoint keeps that route a set of counts and avoids editing its positional `Promise.all` destructure.

**Dropped from the spec on merit:** the spec named an `AdminUserDetail` badge and a `/hiring/summary` KPI count alongside the needs-attention surface. A badge repeats what `DocumentsTab.js:44-45` already prints as "Not on file", and a KPI tile is the same number somewhere you visit less often.

**Files:**
- Modify: `server/routes/admin/hiring.js`
- Modify: `client/src/pages/admin/overview/queueItems.js`
- Modify: `client/src/pages/admin/overview/OverviewPage.js`
- Modify: `client/src/pages/admin/overview/NeedsYouStrip.js` (`QUEUE_ICON` and `queueItemHref`)
- Modify: `docs/fix-list-remaining-2026-07-02.md`
- Test: `client/src/pages/admin/overview/queueItems.test.js`

**Interfaces:**
- Consumes: `listUncertifiedStaffable` from Task C1.
- Produces:
  - `GET /api/admin/hiring/uncertified` (admin only) returning `{ users: Array<{ user_id, name, next_shift_id, next_shift_date }> }`.
  - `buildStaffingItems(unstaffed, newApplications, uncertified)` gains a third parameter, `uncertified: Array`, defaulting to `[]`.
  - `queueItemHref` gains a `user` target resolving to `/staffing/users/:id`, and is exported.

- [ ] **Step 1: Write the failing client test**

Append to `client/src/pages/admin/overview/queueItems.test.js`, inside the existing `describe('buildStaffingItems', ...)` block. The existing block uses `test()`; the new cases below use `it()`. Both are valid Jest globals and the file may mix them, but if you prefer consistency convert the new ones to `test()`.

**Add the import** the new cases need. The existing file imports only from `./queueItems`:

```js
import { queueItemHref } from './NeedsYouStrip';
```

```js
  const risk = (user_id, name, next_shift_date = null, next_shift_id = null) =>
    ({ user_id, name, next_shift_date, next_shift_id });

  it('emits one named row per uncertified worker', () => {
    const items = buildStaffingItems([], 0, [
      risk(55, 'Loryn', '2026-08-01'),
      risk(241, 'Debbie'),
    ]).filter(i => i.type === 'documents');

    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Loryn has no alcohol certification');
    expect(items[1].title).toBe('Debbie has no alcohol certification');
  });

  it('escalates someone who is actually booked', () => {
    const [booked] = buildStaffingItems([], 0, [risk(55, 'Loryn', '2026-08-01', 347)])
      .filter(i => i.type === 'documents');
    expect(booked.priority).toBe('danger');
    expect(booked.sub).toMatch(/working/i);
  });

  it('leaves an eligible but unbooked worker at warn', () => {
    const [idle] = buildStaffingItems([], 0, [risk(241, 'Debbie')])
      .filter(i => i.type === 'documents');
    expect(idle.priority).toBe('warn');
    expect(idle.sub).toMatch(/can be assigned/i);
  });

  it('links each row to that person, not to a list they may not appear on', () => {
    const [row] = buildStaffingItems([], 0, [risk(241, 'Debbie')])
      .filter(i => i.type === 'documents');
    expect(row.target).toBe('user');
    expect(row.ref).toBe(241);
  });

  it('gives each row a stable unique id', () => {
    const items = buildStaffingItems([], 0, [risk(55, 'Loryn'), risk(241, 'Debbie')])
      .filter(i => i.type === 'documents');
    expect(new Set(items.map(i => i.id)).size).toBe(2);
  });

  it('emits nothing when nobody is uncertified', () => {
    expect(buildStaffingItems([], 0, []).some(i => i.type === 'documents')).toBe(false);
  });

  it('treats a missing third argument as nobody uncertified', () => {
    expect(buildStaffingItems([], 0).some(i => i.type === 'documents')).toBe(false);
  });

  // Regression guard for the crowding-out defect. NeedsYouStrip renders only
  // the first TAB_CAP (6) items in array order, so an urgent row appended last
  // disappears into an overflow link pointing at /events.
  it('floats danger rows above warn rows regardless of insertion order', () => {
    const sixWarnEvents = [1, 2, 3, 4, 5, 6].map(i => shift(10, { id: i })); // days=10 => warn
    const items = buildStaffingItems(sixWarnEvents, 0, [
      risk(55, 'Loryn', '2026-08-01', 347),   // danger: booked
    ]);
    expect(items[0].type).toBe('documents');
    expect(items.slice(0, 6).some(i => i.type === 'documents')).toBe(true);
  });

  it('keeps equal-priority rows in their original order', () => {
    const items = buildStaffingItems([], 0, [risk(55, 'Loryn'), risk(241, 'Debbie')])
      .filter(i => i.type === 'documents');
    expect(items.map(i => i.ref)).toEqual([55, 241]);
  });
```

And a separate block for the new href target:

```js
describe('queueItemHref', () => {
  it('routes a user-target row to that user detail page', () => {
    expect(queueItemHref({ target: 'user', ref: 241 })).toBe('/staffing/users/241');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/drbartender/projects/os/client && CI=true npx react-scripts test --testPathPattern=queueItems`
Expected: FAIL. `queueItemHref` is not exported and no item of type `documents` exists.

- [ ] **Step 3: Implement the queue rows**

In `client/src/pages/admin/overview/queueItems.js`, change the signature and append before the `return`. `fmtDate` and `dayDiff` are already imported at the top of that file.

```js
export function buildStaffingItems(unstaffed, newApplications, uncertified = []) {
```

```js
  // One row per person, each linking to their own detail page. A single
  // "N workers uncertified" row would link to /hiring, whose list INNER JOINs
  // applications and therefore omits every direct hire this is for.
  //
  // Scoped to the certification among staffable people only. Including the
  // resume, or every onboarding status, returns ~50 rows into a 6-row strip.
  (uncertified || []).forEach(u => {
    const booked = !!u.next_shift_date;
    const day = booked ? u.next_shift_date.slice(0, 10) : null;
    items.push({
      id: `uncertified-${u.user_id}`, type: 'documents',
      priority: booked ? 'danger' : 'warn',
      title: `${u.name} has no alcohol certification`,
      sub: booked
        ? `Working ${fmtDate(day)} · ${dayDiff(day)}d out`
        : 'Can be assigned to shifts',
      meta: booked ? 'booked' : 'eligible',
      target: 'user', ref: u.user_id,
    });
  });

  // Sort by urgency before returning. NeedsYouStrip renders
  // `t.items.slice(0, TAB_CAP)` in ARRAY ORDER with TAB_CAP = 6, and the RANK
  // map here was previously used only to colour the tab dot. Without this,
  // these rows are appended last and six unstaffed events push a
  // "working Saturday with no certification" row into the "N more" overflow,
  // whose href is OVERFLOW_HREF.staffing = '/events'. That is the same
  // link-to-a-page-they-are-not-on failure this surface was built to replace.
  //
  // Array.prototype.sort is stable in Node 26 and every supported browser, so
  // equal-priority rows keep their existing relative order and the pre-existing
  // unstaffed-event cases are unaffected.
  items.sort((a, b) => (RANK[a.priority] ?? 3) - (RANK[b.priority] ?? 3));
  return items;
```

In `client/src/pages/admin/overview/NeedsYouStrip.js`, add the icon to `QUEUE_ICON` (locate it by content, not line number):

```js
  documents: 'pen',
```

add the target inside `queueItemHref`, beside the existing entity cases:

```js
  if (a.target === 'user') return `/staffing/users/${a.ref}`;
```

and export the function so it can be tested. It is pure, so exporting changes no behavior:

```js
export function queueItemHref(a) {
```

- [ ] **Step 4: Run the client test to verify it passes**

Run: `cd /home/drbartender/projects/os/client && CI=true npx react-scripts test --testPathPattern=queueItems`
Expected: PASS, including the three pre-existing `buildStaffingItems` cases.

- [ ] **Step 5: Add the endpoint**

In `server/routes/admin/hiring.js`, import the helper and add a route beside the existing two. `auth`, `adminOnly`, and `asyncHandler` are already imported there. Leave `GET /hiring/summary` untouched.

```js
const { listUncertifiedStaffable } = require('../../utils/outstandingDocuments');
```

```js
// Workers who can be assigned to a shift but have no alcohol certification on
// file. Separate from /hiring/summary, which is a set of counts whose handler
// destructures a positional Promise.all. Also cannot come from the applications
// list, which INNER JOINs applications and so omits the direct hires this is for.
router.get('/hiring/uncertified', auth, adminOnly, asyncHandler(async (_req, res) => {
  res.json({ users: await listUncertifiedStaffable() });
}));
```

- [ ] **Step 6: Verify the endpoint**

**Restart the dev server first.** It runs as plain `node server/index.js`, not nodemon, so it will not pick up the new route and the curl would 404 in a way that reads as a code failure.

```bash
cd /home/drbartender/projects/os
lsof -ti:5000 | xargs -r kill
# restart the dev server the usual way, then:
TOKEN=$(node -r dotenv/config -e "
const jwt=require('jsonwebtoken');
require('./server/db').pool.query(\"SELECT id, token_version FROM users WHERE role='admin' ORDER BY id LIMIT 1\")
 .then(r=>{const u=r.rows[0];
   console.log(jwt.sign({userId:u.id,tokenVersion:u.token_version},process.env.JWT_SECRET,{expiresIn:'1h'}));
   process.exit(0)})")
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:5000/api/admin/hiring/uncertified | python3 -m json.tool
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:5000/api/admin/hiring/summary | python3 -m json.tool
```

Expected: the first returns a `users` array whose entries carry `user_id`, `name`, and `next_shift_date` (null or a date). The second returns its original four keys with unchanged values. Capture the summary output before editing so that comparison is real.

- [ ] **Step 7: Feed it to the overview page**

Add this at **component top level**, as its own `useState` and its own `useEffect`. Do NOT nest it inside the large existing `useEffect` that contains the `/admin/applications` fetch (that effect ends at `OverviewPage.js:218`); declaring hooks inside another hook is a `react-hooks/rules-of-hooks` error that `CI=true react-scripts build` fails on. Mirror that block's admin-only guard and swallowed catch, since managers 403 here and must simply see no rows:

```js
  const [uncertified, setUncertified] = useState([]);

  useEffect(() => {
    if (!isAdmin) return undefined;
    let cancelled = false;
    api.get('/admin/hiring/uncertified')
      .then(r => { if (!cancelled) setUncertified(r.data?.users || []); })
      .catch(() => {}); // managers 403 here; the rows simply stay absent
    return () => { cancelled = true; };
  }, [isAdmin]);
```

Then pass it through where `staffingItems` is built:

```js
  const staffingItems = useMemo(
    () => buildStaffingItems(unstaffed, newApplications, uncertified),
    [unstaffed, newApplications, uncertified]);
```

- [ ] **Step 8: Verify it reaches the screen and the click works**

Run: `cd /home/drbartender/projects/os/client && CI=true npx react-scripts build`
Expected: build succeeds.

Then load `/` on the admin app as an admin:
- [ ] The Needs-attention staffing tab shows **a small number of rows**, reading like "Loryn has no alcohol certification", with an icon rather than a blank square. If it shows dozens, the C1 scoping regressed.
- [ ] A booked worker's row is `danger` and reads "Working Aug 1 · Nd out". An unbooked one is `warn` and reads "Can be assigned to shifts".
- [ ] Clicking a row lands on `/staffing/users/:id`, whose Documents tab shows the certification as **"Missing"** (that is the cert wording at `DocumentsTab.js:37`; "Not on file" is the resume row). The row and the page must agree; that agreement is why the predicate was extracted.
- [ ] Load the same page as a manager and confirm the rows are absent with no error.

- [ ] **Step 9: Record the dropped surfaces**

Add a line to `docs/fix-list-remaining-2026-07-02.md` so the deferral survives the squash merge:

```
- Onboarding docs: `AdminUserDetail` badge + `/hiring/summary` KPI count were dropped
  from the 2026-07-26 plan on merit (DocumentsTab already prints "Not on file"; the
  KPI duplicates the needs-attention rows). Revisit only if the strip proves too quiet.
```

- [ ] **Step 10: Commit**

```bash
git add server/routes/admin/hiring.js client/src/pages/admin/overview/queueItems.js client/src/pages/admin/overview/queueItems.test.js client/src/pages/admin/overview/OverviewPage.js client/src/pages/admin/overview/NeedsYouStrip.js docs/fix-list-remaining-2026-07-02.md
git commit -m "feat(hiring): flag staffable workers with no alcohol certification"
```

### Task C3: Tell the recruit what they still owe

Lane: **document-visibility**. This is the recruit-facing half of the safety net, and it lands before the gate relaxes in C4.

**Files:**
- Modify: `server/routes/progress.js` (extend `GET /`)
- Modify: `client/src/components/Layout.js` (show what is outstanding, on every onboarding step)
- Modify: `README.md`, `ARCHITECTURE.md`

**Interfaces:**
- Consumes: `outstandingFor` from Task C1.
- Produces: `GET /api/progress` response gains `documents_outstanding: string[]`.

- [ ] **Step 1: Expose the recruit's own outstanding list**

In `server/routes/progress.js`, import the shared helper and extend the existing `GET /` handler. It currently returns the `onboarding_progress` row or `{}`:

```js
const { outstandingFor } = require('../utils/outstandingDocuments');
```

```js
router.get('/', auth, asyncHandler(async (req, res) => {
  const [result, documentsOutstanding] = await Promise.all([
    pool.query('SELECT * FROM onboarding_progress WHERE user_id = $1', [req.user.id]),
    outstandingFor(req.user.id),
  ]);
  res.json({ ...(result.rows[0] || {}), documents_outstanding: documentsOutstanding });
}));
```

This is the same predicate the admin count uses, so the two surfaces cannot drift.

- [ ] **Step 2: Show it on every onboarding step**

The spec asks for a **persistent** to-do card, and `Welcome.js` alone is step one of seven. Put it in the layout instead, which already has everything needed: `client/src/components/Layout.js:30-33` fetches `GET /progress` and refetches on **every** `location.pathname` change, and line 99 already passes `{ progress, setProgress }` down. So the notice follows the recruit through welcome, field guide, agreement, contractor profile, and payday, and refreshes itself the moment they upload.

Rendering it across every step also settles the timing objection. A brand-new recruit does genuinely owe both documents, and a to-do list that says so from the start is correct. It only read as premature when it lived on a single page they saw once.

In `client/src/components/Layout.js`, render immediately above `<Outlet ... />` inside `<main>`:

```jsx
        {(progress?.documents_outstanding?.length > 0) && (
          <div className="page-container">
            <div className="alert alert-info" role="status">
              We still need your {progress.documents_outstanding.join(' and ')}. Add
              {progress.documents_outstanding.length === 1 ? ' it' : ' them'} on
              the <Link to="/contractor-profile">Contractor Profile</Link> step. We do need
              {progress.documents_outstanding.length === 1 ? ' it' : ' them'} before your first shift.
            </div>
          </div>
        )}
```

Merge `Link` into the existing `react-router-dom` import at the top of the file rather than adding a second import statement.

**Use `alert-info`, not `alert-warning`.** `client/src/index.css` defines only `.alert`, `.alert-error`, `.alert-success`, and `.alert-info`. There is no `.alert-warning`, so it would silently render with base styling. (`client-alert-warning` exists, but that is the client-facing surface, not this one.)

Leave `Welcome.js` untouched.

- [ ] **Step 3: Verify**

Run: `cd /home/drbartender/projects/os/client && CI=true npx react-scripts build`
Expected: build succeeds.

Restart the dev server (plain `node server/index.js`, no auto-reload), then confirm the endpoint carries the new field for a user who owes something. Use any existing `in_progress` staff account, or the fixture helper written in Task C4 Step 3 if that lane has already run:

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:5000/api/progress | python3 -m json.tool
```

Expected: the response carries `documents_outstanding` alongside the existing progress booleans. For a user with neither document on file it lists both `resume` and `alcohol certification`.

Manually, on a pre-hire account mid-onboarding:
- [ ] The notice appears on `/welcome` **and stays visible** through the field guide and agreement steps.
- [ ] Uploading only the certification on the contractor profile makes the notice name the resume alone on the next step, with no manual refresh.
- [ ] The admin rows from C2 agree with what the recruit is being told. That agreement is why the predicate was extracted in C1.

- [ ] **Step 4: Update the docs**

In `README.md`, add `server/utils/outstandingDocuments.js` to the folder-structure tree.

In `ARCHITECTURE.md`, add `GET /api/admin/hiring/uncertified` to the API route table, and note that `GET /api/progress` now also returns `documents_outstanding`. Record that both surfaces derive from the single predicate in `server/utils/outstandingDocuments.js`, with the admin alert scoped to `STAFFABLE_STATUSES` (mirroring the assignment gate at `server/routes/shifts.approval.js:233`) and the recruit's own list scoped to the broader `ONBOARDING_STATUSES`.

- [ ] **Step 5: Commit**

```bash
git add server/routes/progress.js client/src/components/Layout.js README.md ARCHITECTURE.md
git commit -m "feat(onboarding): tell recruits which documents are still outstanding"
```

---

### Task C4: Relax the submit gate, for pre-hires only

Lane: **submit-gate-relax**, deliberately its own lane and its own squash commit. This is the only change in the plan that might warrant reverting on its own, and it depends on C1 through C3 already being in place.

**Files:**
- Modify: `server/routes/application.js`
- Modify: `client/src/pages/Application.js`

**Interfaces:**
- Consumes: the notice from C3 and the admin alert from C2, which are what make this safe.
- Produces: `POST /api/application` succeeds without `resume` or `basset` **when the submitter is pre-hired**, and still rejects both as missing when they are not.

- [ ] **Step 1: Make the file requirement conditional on being pre-hired**

**The gate relaxes for pre-hires only.** A pre-hire lands in the onboarding flow, where the outstanding-documents notice follows them step to step and `/contractor-profile` accepts the upload: a complete loop. A cold applicant has neither. `POST /application` refuses a second submit (`application.js:160`) and `/contractor-profile` sits behind `RequireHired`, whose allow-list excludes `applied` (`client/src/App.js:305`). Accepting a fileless application from them would remove a requirement, tell nobody, and leave no way to finish. That is a worse trap than the one this plan exists to remove.

This also keeps the collection guarantee intact where it matters. Nothing about the form changes: every applicant, pre-hire or not, still fills in positions, availability, working alone, tools, equipment, transportation, address, emergency contact and the experience fields, all still required and still validated.

First, delete these four lines at `server/routes/application.js:125-128`:

```js
  const fileFieldErrors = {};
  if (!resume_url) fileFieldErrors.resume = 'Please upload your resume';
  if (!basset_url) fileFieldErrors.basset = 'Please upload your BASSET / alcohol certification';
  if (Object.keys(fileFieldErrors).length > 0) throw new ValidationError(fileFieldErrors);
```

Then re-add it **inside the transaction**, immediately after `isPreHired` is computed at line 219 and before the `UPDATE users SET onboarding_status` at line 222:

```js
    // Files block the submit for cold applicants only.
    //
    // A pre-hire can finish later: the outstanding-documents notice follows
    // them through onboarding and /contractor-profile takes the upload. A file
    // upload is the one field here nobody can reliably complete on demand (it
    // depends on their connection, their camera resolution, and what format
    // their resume happens to be in), and blocking a hired contractor on it
    // strands someone who is otherwise done (incident 2026-07-23).
    //
    // A cold applicant has no way back in: the guard at line 160 refuses a
    // second submit and /contractor-profile is behind RequireHired, which does
    // not admit 'applied'. For them, requiring it now is the kinder rule.
    //
    // isPreHired comes from the FOR UPDATE row above, never req.user.pre_hired,
    // matching the existing convention on line 217. Throwing here rolls back
    // cleanly via the catch on line 240.
    if (!isPreHired) {
      const fileFieldErrors = {};
      if (!resume_url) fileFieldErrors.resume = 'Please upload your resume';
      if (!basset_url) fileFieldErrors.basset = 'Please upload your BASSET / alcohol certification';
      if (Object.keys(fileFieldErrors).length > 0) throw new ValidationError(fileFieldErrors);
    }
```

- [ ] **Step 2: Remove the matching client rules and soften the labels**

**Locate by content, not line number.** Lane B inserted lines above these. In `client/src/pages/Application.js`, delete these two entries from the `rules` array:

```js
      { field: 'resume', label: 'Resume', test: () => !!files.resume },
      { field: 'basset', label: 'BASSET Certification', test: () => !!files.basset },
```

Change the resume `FileUpload` label from `"Upload Your Resume *"` to `"Upload Your Resume"`, and the BASSET label from `"Upload Your BASSET / Alcohol Certification *"` to `"Upload Your BASSET / Alcohol Certification"`.

**Do not gate the client rules on `pre_hired`.** It is not reliably on the client user object: the login SELECT (`server/routes/auth.js:317`) does not include it, only `/auth/me` does. Drop the two rules unconditionally and let the server be the single authority. A cold applicant who omits a file gets a 400 carrying `fieldErrors`, and `Application.js:230` already handles exactly that, marking the field and calling `scrollToFirstError()`. No new client code is needed for that path.

Add this notice immediately above the `<div className={"form-group" + fieldClass('resume')}>` that wraps the resume upload. It has to read correctly for both audiences without knowing which one is looking, since the client cannot tell:

```jsx
            <div className="alert alert-info" role="status">
              If you have already been hired, you can add these later and we will
              follow up. If you are applying, we need them with your application.
            </div>
```

Update the BASSET helper from `"BASSET, TIPS, ServSafe, or equivalent. Required for all positions."` to `"BASSET, TIPS, ServSafe, or equivalent. Needed before your first shift."`

- [ ] **Step 3: Prove both branches**

This task deletes a server-side validation gate and changes an endpoint every onboarding page consumes, and neither the build nor C1's util suite touches any of its four files. Exercise the route directly.

**Both branches must be exercised.** A pre-hire submits without files and succeeds; a cold applicant submits without files and is refused. A check that only covers one branch cannot tell a correct conditional from a deleted one.

Write the fixture helper to a file rather than inlining it. **The JS contains backticked template literals, and those cannot survive inside a double-quoted `$( ... )` in bash**: the shell reads them as command substitution and dies with `syntax error near unexpected token '('`, leaving `TOKEN` empty and the curls silently unauthenticated.

Create `/tmp/c3-fixture.js`:

```js
require('dotenv').config();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { pool } = require('./server/db');

const preHired = process.argv[2] === 'prehire';
const email = `c3-gate-${preHired ? 'prehire' : 'cold'}@example.com`;

(async () => {
  const hash = await bcrypt.hash('x', 4);
  await pool.query('DELETE FROM users WHERE email = $1', [email]);
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version, pre_hired)
     VALUES ($1, $2, 'staff', 'in_progress', 0, $3) RETURNING id`,
    [email, hash, preHired]
  );
  console.log(jwt.sign(
    { userId: r.rows[0].id, tokenVersion: 0 },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  ));
  process.exit(0);
})();
```

Then:

```bash
cd /home/drbartender/projects/os
# Restart the dev server first: it runs as plain `node server/index.js`, not nodemon.
lsof -ti:5000 | xargs -r kill
# restart it the usual way, then:

submit () {
  curl -s -o /tmp/c3-out.json -w "%{http_code}" -X POST http://localhost:5000/api/application \
    -H "Authorization: Bearer $1" \
    -F "full_name=Gate Check" -F "phone=3125550000" -F "city=Chicago" -F "state=Illinois" \
    -F "travel_distance=30 minutes" -F "reliable_transportation=Yes" \
    -F "positions_interested=[\"Bartender\"]" -F "why_dr_bartender=testing" \
    -F "birth_month=1" -F "birth_day=1" -F "birth_year=1990"
}

PRE=$(node /tmp/c3-fixture.js prehire)
echo "pre-hire, no files: $(submit "$PRE")"     # expect 201
curl -s -H "Authorization: Bearer $PRE" http://localhost:5000/api/progress | python3 -m json.tool

COLD=$(node /tmp/c3-fixture.js cold)
echo "cold applicant, no files: $(submit "$COLD")"   # expect 400
cat /tmp/c3-out.json | python3 -m json.tool
```

Expected:
- Pre-hire returns **201**, and its `/api/progress` carries `documents_outstanding` listing **both** `resume` and `alcohol certification`.
- Cold applicant returns **400**, with `fieldErrors` naming `resume` and `basset`. If this returns 201, the conditional was dropped rather than added and cold applicants are being stranded.

Clean up both fixture users and `/tmp/c3-fixture.js` afterwards.

Then run: `cd /home/drbartender/projects/os && node -r dotenv/config --test server/utils/outstandingDocuments.test.js`
Expected: still PASS. `GET /api/progress` now calls into it.

And: `cd /home/drbartender/projects/os/client && CI=true npx react-scripts build`
Expected: build succeeds.

Manually, **using a pre-hired account**, because a non-pre-hired submitter becomes `applied` and routes to `/application-status`, not `/welcome` (`Application.js:220-226`):
- [ ] Submit with no files. Confirm it succeeds and routes onward rather than blocking.
- [ ] Confirm the notice appears on `/welcome` **and stays visible** through the field guide and agreement steps.
- [ ] Upload only the certification on the contractor profile. Confirm the notice updates on the next step to name the resume alone, without a manual refresh.
- [ ] Confirm the admin rows from C2 agree with what the recruit is being told. That agreement is why the predicate was extracted in C1.

- [ ] **Step 4: Commit**

```bash
git add server/routes/application.js client/src/pages/Application.js
git commit -m "feat(onboarding): let pre-hires submit with documents outstanding"
```
## Review

Four lanes, four squash commits, reviewed independently. The fleets are declared in the front-matter lane map; this table is the rationale.

| Lane | Tasks | Fleet |
|---|---|---|
| `upload-honesty` | A1 to A6 | **Full + `/second-opinion`.** File validation is a sensitive path and the allowlist widening is security-adjacent: DOC and DOCX are OLE and zip containers. Reviewers must confirm the magic-bytes-plus-extension pairing holds, that `isValidUpload` and `isValidImageUpload` are genuinely unchanged for their nine and two existing callers, and that `kind="document"` landed on exactly the four intended fields and on neither `headshot` nor `w9`. |
| `onboarding-drafts` | B1 to B5 | **Full + `/second-opinion`.** New table on a sensitive path. Reviewers must confirm every draft query scopes to `req.user.id`, that `payday_protocols` cannot reach the table by any path, and that the Application snapshot carries all five state hooks rather than `form` alone. |
| `document-visibility` | C1 to C3 | **Full.** C1 introduces one SQL predicate that two independent surfaces depend on agreeing about, and its LEFT-versus-INNER join choice is the difference between the alert working and being blind to the exact cohort it was built for. |
| `submit-gate-relax` | C4 | **Full + `/second-opinion`.** Smallest lane, highest risk: it removes a server-side validation gate. Reviewers must confirm the conditional reads `isPreHired` from the locked row and never `req.user.pre_hired`, and that a cold applicant is still refused. |

**Review checkpoints during execution**, matched to what each batch changes:
- After B2 and after C1: **database review**. New table, `req.user.id` scoping, the `payday_protocols` allowlist, and the join predicate whose LEFT-versus-INNER choice decides whether the alert sees anyone.
- After A1 and A4: **security review**. Upload allowlist widening, and client/server accept parity across all seven `FileUpload` call sites.
- After C4: **security review**, and the one checkpoint not to skip. It is the only task that removes a server-side validation gate.
- After C2: verify the manager 403 path still degrades to absent rows rather than an error.
- After B4: confirm the five-hook snapshot round-trips every checkbox section, not just `form`. This is where Lane B can silently half-work.

## Open item carried from the spec

The recruit who triggered this was unblocked by being sent directly to `/welcome`, which skips the application. She reached `approved` on 2026-07-24 at 4:50 PM on her original account (user 241, `dlemke03@gmail.com`), was assigned to shift 363, and **worked it on 2026-07-25 with no alcohol certification on file.** Her two abandoned accounts, 242 and 243, are still sitting at `in_progress` and should be deactivated.

So this is not hypothetical: she has `onboarding_status = 'approved'`, no application row, no resume, and no certification. She is precisely the row `listUncertifiedStaffable()` must return, and the reason its joins are LEFT rather than INNER.

**And she is not the only one.** Sizing the predicate against production during the second review pass turned up **Loryn (user 55)**, also `approved`, also with no certification on file, and booked on shift 347 for **2026-08-01**. Nobody was looking for her. That is the case for building this at all: the alert found a live compliance exposure before the shift rather than after, which is exactly what did not happen for Debbie.

Task C1's predicate catches the missing documents, and only because it is built on LEFT JOINs against `users`. An earlier draft of this plan derived the count from `/admin/applications`, which INNER JOINs and would have rendered her invisible to the very safety net written in response to her. That is why the join style in `outstandingDocuments.js` is load-bearing rather than incidental, and why C1 Step 1 fixtures a user with no application row at all.

Note the alert is scoped to staffable statuses, so C1 Step 5 expects **241 (Debbie) and 55 (Loryn)** and NOT 242 or 243, which sit at `in_progress` and cannot be assigned to anything. Those two show up in `outstandingFor` on their own pages, not in the admin alert. An earlier draft of this paragraph claimed Step 5 verifies 242 and 243, which would have let an executor pass the checkpoint against the wrong expectation.

**The application answers are a separate problem and no task here recovers them.** Positions, availability, working alone, tools, and experience are simply absent, and nothing in this plan will surface them. That collection is a manual follow-up, already overdue since she has worked a shift.

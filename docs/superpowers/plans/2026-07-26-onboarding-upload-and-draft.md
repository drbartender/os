# Onboarding Upload and Draft Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the onboarding application from stranding recruits: make uploads succeed, stop discarding their work, and stop letting a file upload block the whole form.

**Architecture:** Three independent lanes. Lane A widens what uploads we accept and downscales oversized images in the browser before a byte is sent. Lane B adds a server-side draft table so a half-finished form survives a failure or a device switch. Lane C removes the hard file requirement at submit and surfaces outstanding documents to the admin instead.

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
- File-size discipline: soft cap 700 lines, hard cap 1000. `Application.js` is already 685 lines, so Lane C must not grow it meaningfully.

---

## Lane A: Uploads that succeed

### Task A1: Add an onboarding-document validator

`isValidUpload` is shared by seven call sites including the W-9 (`payment.js:91`), blog images (`admin/blog.js:176`), and staff portal uploads (`staffPortal.js:692`). Widening it in place would let a `.docx` through as a blog image. Add a separate validator instead and leave the existing two untouched.

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

Swap `isValidUpload` for `isValidOnboardingDocument` at line 91 (resume) and line 115 (basset). **Leave line 103 (headshot) on `isValidUpload`** so a headshot stays a renderable image. Update the two error strings to name what is now accepted:

```js
throw new ValidationError({ resume: 'We could not read that file. Use a PDF, Word document, or a photo.' });
```
```js
throw new ValidationError({ basset: 'We could not read that file. Use a PDF, Word document, or a photo.' });
```

Apply the identical change in `server/routes/contractor.js`: import on line 7, swap at line 101 (`alcohol_certification`) and line 113 (`resume`), leave line 125 (headshot) alone, and update those two error strings the same way.

- [ ] **Step 6: Run the suites these routes reach**

Run: `cd /home/drbartender/projects/os && node -r dotenv/config --test server/routes/staffPortal.test.js`
Expected: PASS. This suite exercises `isValidUpload` through the staff portal and must be unaffected.

- [ ] **Step 7: Commit**

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
  - `ACCEPT_ATTR: string`
  - `formatBytes(n: number) -> string`
  - `extOf(name: string) -> string`
  - `isImageName(name: string) -> boolean`
  - `checkFile(file: {name: string, size: number}) -> { ok: true } | { ok: false, message: string }`

- [ ] **Step 1: Write the failing test**

Create `client/src/utils/uploadLimits.test.js`:

```js
import {
  MAX_UPLOAD_BYTES, formatBytes, extOf, isImageName, checkFile,
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

describe('checkFile', () => {
  it('accepts a normal PDF', () => {
    expect(checkFile(f('resume.pdf', 900 * 1024))).toEqual({ ok: true });
  });

  it('accepts a Word document', () => {
    expect(checkFile(f('resume.docx', 40 * 1024))).toEqual({ ok: true });
  });

  it('rejects an unsupported type by naming what works', () => {
    const r = checkFile(f('resume.pages', 1000));
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
const DOC_EXTS = ['.pdf', '.doc', '.docx'];
const ALLOWED_EXTS = [...DOC_EXTS, ...IMAGE_EXTS];

// The file input's accept attribute. Wide on purpose: a narrow accept greys
// files out in the iOS Files picker with no explanation, which reads to the
// user as the page being broken.
export const ACCEPT_ATTR = ALLOWED_EXTS.join(',');

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

export function checkFile(file) {
  if (!file) return { ok: false, message: 'No file selected.' };
  if (!file.size) return { ok: false, message: 'That file is empty. Try picking it again.' };

  const ext = extOf(file.name);
  if (!ALLOWED_EXTS.includes(ext)) {
    return {
      ok: false,
      message: `We cannot read ${ext || 'that file type'}. Use a PDF, a Word document, or a photo (JPG, PNG, HEIC).`,
    };
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

There is no unit test for this task. It depends on real canvas and image decoding, which jsdom does not provide, and a mocked canvas would only assert that the mock was called. The decision logic it depends on (`isImageName`, thresholds) is already covered by Task A2, and the behaviour is verified in the manual check at the end of this lane.

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
// isValidOnboardingDocument accept the HEIC as-is. Both paths work, so the
// failure mode here is "no improvement", never "broken upload".
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

- [ ] **Step 2: Verify it compiles**

Run: `cd /home/drbartender/projects/os/client && CI=true npx react-scripts build`
Expected: build succeeds with no ESLint errors. CRA treats warnings as errors under `CI=true`, so an unused import fails here.

- [ ] **Step 3: Commit**

```bash
git add client/src/utils/downscaleImage.js
git commit -m "feat(uploads): downscale oversized images in the browser"
```

---

### Task A4: Wire FileUpload to the new rules

**Files:**
- Modify: `client/src/components/FileUpload.js`
- Test: `client/src/components/FileUpload.test.js` (create)

**Interfaces:**
- Consumes: `checkFile`, `ACCEPT_ATTR` from `../utils/uploadLimits`; `downscaleImage` from `../utils/downscaleImage`.
- Produces: unchanged public props (`label`, `name`, `accept`, `helper`, `onChange`, `currentFile`, `camera`). `onChange(name, file)` still fires only for accepted files. Rejections render inline and never call `onChange`.

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
  render(<FileUpload label="Upload Your Resume" name="resume" onChange={onChange} {...props} />);
  return { onChange, input: document.querySelector('input[type="file"]') };
}

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/drbartender/projects/os/client && CI=true npx react-scripts test --testPathPattern=FileUpload`
Expected: FAIL. The oversize and unsupported-type cases call `onChange` today because no validation exists.

- [ ] **Step 3: Implement**

In `client/src/components/FileUpload.js`, replace the import block at the top with:

```js
import React, { useId, useState } from 'react';
import { checkFile, ACCEPT_ATTR } from '../utils/uploadLimits';
import downscaleImage from '../utils/downscaleImage';
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
    const picked = e.target.files[0];
    e.target.value = ''; // Allow re-picking the same file after a rejection.
    if (!picked) return;

    const file = await downscaleImage(picked);
    const verdict = checkFile(file);
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

Finally, widen both fallback accepts. In the camera branch change `accept={accept || 'image/*'}` to `accept={accept || ACCEPT_ATTR}`, and in the default branch change `accept={accept || '.pdf,.jpg,.jpeg,.png'}` to `accept={accept || ACCEPT_ATTR}`. Leave the dedicated camera-capture input on `accept="image/*"` with `capture="user"`, since that one opens the camera rather than a file picker.

Update the default-branch hint text from `PDF, JPG, PNG accepted` to `PDF, Word, or photo`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/drbartender/projects/os/client && CI=true npx react-scripts test --testPathPattern=FileUpload`
Expected: PASS, 6 tests.

- [ ] **Step 5: Confirm the callers still build**

`FileUpload` is used by `Application.js`, `ContractorProfile.js`, and `PaydayProtocols.js`. The props are unchanged, so this is a compile check.

Run: `cd /home/drbartender/projects/os/client && CI=true npx react-scripts build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/FileUpload.js client/src/components/FileUpload.test.js
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
app.use(fileUpload({
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024 },
  abortOnLimit: true,
  useTempFiles: false,
  // abortOnLimit stays on: it is the abuse backstop, and turning it off means
  // buffering unbounded uploads in memory. The cost is that it resets the
  // stream mid-body, so the browser reports a bare "network error" rather than
  // reading this 413. The real defence is the client-side check in
  // client/src/utils/uploadLimits.js; this handler exists so that when someone
  // gets past it we find out, instead of the path being silent as it was
  // between 2026-05 and the 2026-07-23 incident.
  limitHandler: (req, res) => {
    Sentry.captureMessage('upload_limit_exceeded', {
      level: 'warning',
      tags: { component: 'upload' },
      extra: {
        path: req.originalUrl,
        method: req.method,
        userId: req.user?.id || null,
        contentLength: req.headers['content-length'] || null,
      },
    });
    res.status(413).json({ error: 'That file is too large. The limit is 10MB.' });
  },
}));
```

- [ ] **Step 2: Verify the server boots**

Run: `cd /home/drbartender/projects/os && node -e "require('./server/index.js')" & sleep 4; curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5000/api/health; kill %1`
Expected: a 2xx status, confirming the middleware config is valid. If port 5000 is already held by the dev server, stop that first (see the dev-server note in README) rather than assuming a failure.

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "feat(uploads): report limit-exceeded uploads to Sentry"
```

---

### Lane A manual check

- [ ] Load the application form on a phone, photograph a document so the file exceeds 10MB, and confirm it uploads with no error (downscaling handles it).
- [ ] Pick a `.docx` resume and confirm it is selectable and uploads.
- [ ] Pick a genuinely oversized PDF (over 10MB, which does not downscale) and confirm the inline message names the real size and the limit, immediately, with no upload wait.

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

function app() {
  const a = express();
  a.use(express.json({ limit: '1mb' }));
  a.use('/api/progress', progressRouter);
  a.use((err, req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: err.message, fieldErrors: err.fieldErrors });
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
  return { id, token: jwt.sign({ id, role: 'staff', token_version: 0 }, process.env.JWT_SECRET) };
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

test('a second save overwrites rather than duplicating', async () => {
  await request('PUT', '/api/progress/draft/application', { tok: token, body: { data: { city: 'Evanston' } } });
  const get = await request('GET', '/api/progress/draft/application', { tok: token });
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
- Produces: `useFormDraft(formKey, form, applyDraft) -> { restoredAt: string | null, clearDraft: () => Promise<void>, ready: boolean }`
  - `form` is the current form state object, watched for changes.
  - `applyDraft(data)` is called once on mount if a stored draft exists.
  - `ready` is false until the initial load settles, so the debounced save never fires before the restore.
  - `clearDraft()` is called by the form on successful submit.

- [ ] **Step 1: Write the failing test**

Create `client/src/hooks/useFormDraft.test.js`:

```js
import '@testing-library/jest-dom';
import React, { useState } from 'react';
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
export default function useFormDraft(formKey, form, applyDraft) {
  const [ready, setReady] = useState(false);
  const [restoredAt, setRestoredAt] = useState(null);
  const applyRef = useRef(applyDraft);
  const clearedRef = useRef(false);
  applyRef.current = applyDraft;

  // Load once on mount. `ready` gates the save effect so the restore itself
  // cannot trigger a save that overwrites the draft with empty fields.
  useEffect(() => {
    let cancelled = false;
    api.get(`/progress/draft/${formKey}`)
      .then(res => {
        if (cancelled) return;
        const { data, updated_at } = res.data || {};
        if (data && Object.keys(data).length > 0) {
          applyRef.current(data);
          setRestoredAt(updated_at || null);
        }
      })
      .catch(() => { /* no draft is not an error worth showing */ })
      .finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [formKey]);

  useEffect(() => {
    if (!ready || clearedRef.current) return undefined;
    const t = setTimeout(() => {
      api.put(`/progress/draft/${formKey}`, { data: form }).catch(() => {});
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [ready, formKey, form]);

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
Expected: PASS, 7 tests.

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

After the `files` state declaration (line 96), add:

```js
  // Draft covers form fields only. Files are not serialisable to the draft
  // table, and they do not need to be: they are the last section, and React
  // holds them across a failed submit. Only a page reload loses them.
  const { restoredAt, clearDraft } = useFormDraft('application', form, draft =>
    setForm(f => ({ ...f, ...draft })));
```

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

Add the same import. After that page's `files` state, add:

```js
  const { restoredAt, clearDraft } = useFormDraft('contractor_profile', form, draft =>
    setForm(f => ({ ...f, ...draft })));
```

**Ordering matters here.** This page loads existing profile data from `GET /contractor` on mount. The draft is written after that load by definition, so on conflict the draft wins. The hook's `applyDraft` merges over current state, so as long as the `useFormDraft` call sits after the profile-loading effect in source order, the later-resolving draft correctly overwrites. Verify this by hand in Step 4.

Call `await clearDraft();` after the successful profile POST, and render the same restore notice at the top of its form.

- [ ] **Step 3: Verify the build**

Run: `cd /home/drbartender/projects/os/client && CI=true npx react-scripts build`
Expected: build succeeds.

Run: `cd /home/drbartender/projects/os && node scripts/check-file-size.js --all | grep -E "Application.js|ContractorProfile.js"`
Expected: `Application.js` stays under the 700-line soft cap warning threshold or, if it crosses, is reported as YELLOW rather than blocking. It must not reach 1000.

- [ ] **Step 4: Manual check**

- [ ] Fill three sections of the application, wait two seconds, hard-reload the page, and confirm the answers come back with the restore notice showing.
- [ ] Fill part of the form on one browser, open the same account in a second browser, and confirm the draft appears there. This is the device-switch case that localStorage would not have covered.
- [ ] Submit the form successfully, then reload, and confirm no stale draft is restored.
- [ ] On the contractor profile, confirm existing saved profile data still loads correctly when no draft exists.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/Application.js client/src/pages/ContractorProfile.js
git commit -m "feat(onboarding): autosave the application and contractor profile"
```

---

## Lane C: Files stop blocking submit

Lane C touches `client/src/pages/Application.js`, which Lane B also modifies. **Sequence Lane C after Lane B**, or build both as a single lane. Do not run them as parallel worktrees into the same file.

### Task C1: Drop the hard file requirement at submit

**Files:**
- Modify: `server/routes/application.js:124-128`
- Modify: `client/src/pages/Application.js:161-162`

**Interfaces:**
- Consumes: nothing.
- Produces: `POST /api/application` now succeeds with `resume` and `basset` absent. Every other required field is unchanged.

- [ ] **Step 1: Remove the server-side block**

Delete these four lines at `server/routes/application.js:125-128`:

```js
  const fileFieldErrors = {};
  if (!resume_url) fileFieldErrors.resume = 'Please upload your resume';
  if (!basset_url) fileFieldErrors.basset = 'Please upload your BASSET / alcohol certification';
  if (Object.keys(fileFieldErrors).length > 0) throw new ValidationError(fileFieldErrors);
```

Replace with:

```js
  // Files are collected, not required at submit. A file upload is the only
  // field on this form the user cannot reliably complete: it depends on their
  // connection, their phone's camera resolution, and what format their resume
  // happens to be in. Blocking on it strands people who are otherwise done
  // (incident 2026-07-23). Outstanding documents are derived from the null
  // *_file_url columns and surfaced to the admin instead.
```

- [ ] **Step 2: Remove the matching client-side rules**

In `client/src/pages/Application.js`, delete these two entries from the `rules` array at lines 161-162:

```js
      { field: 'resume', label: 'Resume', test: () => !!files.resume },
      { field: 'basset', label: 'BASSET Certification', test: () => !!files.basset },
```

- [ ] **Step 3: Soften the labels and add the notice**

Change the resume `FileUpload` label from `"Upload Your Resume *"` to `"Upload Your Resume"` and the BASSET label from `"Upload Your BASSET / Alcohol Certification *"` to `"Upload Your BASSET / Alcohol Certification"`.

Add this notice immediately above the resume `FileUpload` block (line 615):

```jsx
            <div className="alert alert-info" role="status">
              You can submit without these and add them later, but we do need both
              on file before your first shift.
            </div>
          </div>
```

Update the BASSET helper text from `"BASSET, TIPS, ServSafe, or equivalent. Required for all positions."` to `"BASSET, TIPS, ServSafe, or equivalent. Needed before your first shift."`

- [ ] **Step 4: Verify**

Run: `cd /home/drbartender/projects/os/client && CI=true npx react-scripts build`
Expected: build succeeds.

Manually submit the application with no files attached and confirm it succeeds and routes onward to `/welcome`.

- [ ] **Step 5: Commit**

```bash
git add server/routes/application.js client/src/pages/Application.js
git commit -m "feat(onboarding): let the application submit with documents outstanding"
```

---

### Task C2: Surface outstanding documents to the admin

`GET /admin/applications` already returns `resume_file_url`, `basset_file_url`, `headshot_file_url` and `onboarding_status` (see `server/routes/admin/applications.js:72-83`), and `OverviewPage.js:225` already derives `newApplications` from that same fetched list. So this needs no server change: derive the count the same way.

**Trimmed from the spec.** The spec named three admin surfaces: the needs-attention strip, a badge on `AdminUserDetail`, and a count in the `/hiring/summary` KPI strip. This task builds only the first. `AdminUserDetail` already renders the document links, so their absence is visible there without a badge, and a third KPI counting the same people the needs-attention item already names is duplicate signal on the same screen. One surface that is actually actionable beats three that dilute each other. If the single item proves too quiet in practice, the KPI is a small follow-up.

**Files:**
- Modify: `client/src/pages/admin/overview/queueItems.js:26-47`
- Modify: `client/src/pages/admin/overview/OverviewPage.js:225-231`
- Test: `client/src/pages/admin/overview/queueItems.test.js`

**Interfaces:**
- Consumes: the `applications` array already fetched by `OverviewPage`.
- Produces: `buildStaffingItems(unstaffed, newApplications, missingDocs)` gains a third parameter, `missingDocs: number`. Existing callers that pass two arguments still work, treating it as zero.

- [ ] **Step 1: Write the failing test**

Append to `client/src/pages/admin/overview/queueItems.test.js`, inside the existing `describe('buildStaffingItems', ...)` block:

```js
  it('adds a missing-documents item when any recruit owes files', () => {
    const items = buildStaffingItems([], 0, 3);
    const docs = items.find(i => i.type === 'documents');
    expect(docs).toBeDefined();
    expect(docs.title).toBe('3 bartenders missing documents');
    expect(docs.priority).toBe('warn');
    expect(docs.target).toBe('hiring');
  });

  it('singularises the missing-documents item', () => {
    const docs = buildStaffingItems([], 0, 1).find(i => i.type === 'documents');
    expect(docs.title).toBe('1 bartender missing documents');
  });

  it('omits the missing-documents item at zero', () => {
    expect(buildStaffingItems([], 0, 0).some(i => i.type === 'documents')).toBe(false);
  });

  it('treats a missing third argument as zero', () => {
    expect(buildStaffingItems([], 0).some(i => i.type === 'documents')).toBe(false);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/drbartender/projects/os/client && CI=true npx react-scripts test --testPathPattern=queueItems`
Expected: FAIL, no item of type `documents`.

- [ ] **Step 3: Implement**

In `client/src/pages/admin/overview/queueItems.js`, change the signature at line 26 and append the new item before the `return`:

```js
export function buildStaffingItems(unstaffed, newApplications, missingDocs = 0) {
```

```js
  if (missingDocs > 0) {
    items.push({
      id: 'missing-docs', type: 'documents', priority: 'warn',
      title: `${missingDocs} ${missingDocs === 1 ? 'bartender' : 'bartenders'} missing documents`,
      sub: 'No resume or certification on file',
      meta: `${missingDocs} owed`, target: 'hiring', ref: null,
    });
  }
  return items;
```

Add an icon for the new type to the `QUEUE_ICON` map in `client/src/pages/admin/overview/NeedsYouStrip.js:29-33`:

```js
  'documents': 'pen',
```

- [ ] **Step 4: Feed it from OverviewPage**

In `client/src/pages/admin/overview/OverviewPage.js`, add below the `newApplications` memo at line 225:

```js
  // Onboarding no longer blocks on a resume or certification upload, so track
  // who still owes one. Anyone past the applicant stage with a null file URL.
  const missingDocs = useMemo(() =>
    Array.isArray(applications)
      ? applications.filter(a =>
          ['in_progress', 'hired', 'submitted', 'reviewed', 'approved'].includes(a.onboarding_status)
          && (!a.resume_file_url || !a.basset_file_url)).length
      : 0, [applications]);
```

Change line 231 to pass it through:

```js
  const staffingItems = useMemo(() => buildStaffingItems(unstaffed, newApplications, missingDocs),
    [unstaffed, newApplications, missingDocs]);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /home/drbartender/projects/os/client && CI=true npx react-scripts test --testPathPattern=queueItems`
Expected: PASS, including the four pre-existing `buildStaffingItems` cases.

- [ ] **Step 6: Verify the build**

Run: `cd /home/drbartender/projects/os/client && CI=true npx react-scripts build`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/admin/overview/queueItems.js client/src/pages/admin/overview/queueItems.test.js client/src/pages/admin/overview/OverviewPage.js client/src/pages/admin/overview/NeedsYouStrip.js
git commit -m "feat(hiring): surface recruits missing documents in needs-attention"
```

---

### Task C3: Give the recruit a way back

Someone who submits with files outstanding needs somewhere to finish them. The contractor profile page already carries all three uploads as optional fields, so this is a link, not a new page.

**Files:**
- Modify: `client/src/pages/Welcome.js`

**Interfaces:**
- Consumes: `GET /api/contractor` (existing).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Implement**

In `client/src/pages/Welcome.js`, add to the imports:

```js
import { useEffect, useState } from 'react';
```

(merge into the existing `React, { useState }` import rather than duplicating it)

Add inside the component, after the `loading` state:

```js
  const [owed, setOwed] = useState([]);

  // Documents are collected rather than required at submit, so tell the recruit
  // plainly what is still outstanding instead of letting it go quiet.
  useEffect(() => {
    api.get('/contractor')
      .then(r => {
        const p = r.data || {};
        const missing = [];
        if (!p.resume_file_url) missing.push('resume');
        if (!p.alcohol_certification_file_url) missing.push('alcohol certification');
        setOwed(missing);
      })
      .catch(() => setOwed([]));
  }, []);
```

Render above the existing `alert alert-info` block:

```jsx
          {owed.length > 0 && (
            <div className="alert alert-warning" role="status">
              We still need your {owed.join(' and ')}. You can add {owed.length === 1 ? 'it' : 'them'} on
              the Contractor Profile step, and we do need {owed.length === 1 ? 'it' : 'them'} before your
              first shift.
            </div>
          )}
```

- [ ] **Step 2: Verify**

Run: `cd /home/drbartender/projects/os/client && CI=true npx react-scripts build`
Expected: build succeeds.

Manually: submit an application with no files, land on `/welcome`, and confirm the notice names both outstanding documents. Upload one on the contractor profile step, return to `/welcome`, and confirm only the remaining one is named.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/Welcome.js
git commit -m "feat(onboarding): tell recruits which documents are still outstanding"
```

---

## Review

| Lane | Scope | Fleet |
|---|---|---|
| A | `fileValidation.js`, `FileUpload.js`, `index.js` | **Full fleet.** File validation is a sensitive path, and the allowlist widening is security-adjacent: DOC and DOCX are OLE and zip containers. Reviewers must confirm the extension pairing holds and that `isValidUpload` and `isValidImageUpload` are genuinely unchanged for their seven and two existing callers. |
| B | schema, `progress.js`, hook, two forms | **Full.** New table. Reviewers must confirm every draft query scopes to `req.user.id`, and that `payday_protocols` cannot reach the table by any path. |
| C | `application.js`, `Application.js`, admin surfacing | Standard. |

Run `/second-opinion` on Lane A alongside the fleet.

## Open item carried from the spec

The recruit who triggered this was unblocked by being sent directly to `/welcome`, which skips the application. She will finish onboarding with no `positions_interested`, no availability, no `comfortable_working_alone` answer, and no BASSET on file. Collect that from her separately once this ships. Task C2's missing-documents count will catch the BASSET half automatically; the rest of the application data will not appear and needs a manual follow-up.

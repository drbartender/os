# Document Preview Modal — Design (2026-07-01)

## Context
Staff document rows in the admin user-detail view open each file (W-9, BASSET / alcohol cert, resume, headshot) in a new browser tab via `window.open(signedUrl)`. Dallas wants them to preview in an in-app modal ("docs should pop up in a modal, basset, headshot, etc."). Keeps the admin in context instead of tab-hopping.

## Scope
- **In:** the staff user-detail tabs, `client/src/pages/admin/userDetail/tabs/DocumentsTab.js` and `CertificationsTab.js`, plus their host `AdminUserDetail.js`.
- **Out (deferred):** the applicant-side file block (`applicationDetail/components/FilesBlock.js`), and any change to how documents are uploaded, stored, or signed.

## Current behavior (grounding)
- Each doc row's `url` is an API path (e.g. `payment.w9_file_url`), not a direct R2 URL.
- `AdminUserDetail.downloadFile(url)` does `api.get(url)` -> `response.data.url` (a 15-minute presigned R2 URL) -> `window.open(..., '_blank')`.
- Filenames are available per row (`w9_filename`, `alcohol_certification_filename` / `basset_filename`, `resume_filename`, `headshot_filename`), so the file type can be derived from the extension.
- `getSignedUrl` (`server/utils/storage.js`) sets **no** `Content-Disposition`, so inline rendering is not force-blocked. Whether a PDF actually embeds depends on the object's stored `Content-Type` (verify at build; the fallback below covers the miss).

## Design

### New component: `DocumentPreviewModal`
`client/src/components/admin/DocumentPreviewModal.js` (new). Props: `{ isOpen, title, fileUrl, filename, onClose }`.
- Derives type from the `filename` extension (case-insensitive):
  - image (`png|jpg|jpeg|gif|webp`) -> `<img src={fileUrl}>`, contained to the viewport.
  - `pdf` -> `<iframe src={fileUrl} title={title}>` filling the modal body.
  - anything else / unknown -> a "Preview isn't available for this file type" message.
- **Always** renders an "Open in new tab" action (`<a href={fileUrl} target="_blank" rel="noopener noreferrer">`). This is the escape hatch for a PDF that won't embed and the handler for non-previewable types, so the feature works even if R2 embedding is flaky.
- Accessibility mirrors `ConfirmModal.js`: overlay-click closes, `Esc` closes, focus trap, `role="dialog"` + `aria-modal`. Lightbox sizing via new `.doc-preview-*` rules in `index.css`.

### Wiring
- `AdminUserDetail.js`: add modal state (`{ open, title, fileUrl, filename }`) and a `previewFile(url, filename, title)` handler that fetches the signed URL (same `api.get(url) -> data.url` as today) and opens the modal. Render one `<DocumentPreviewModal>` at this level.
- Pass `previewFile` into `DocumentsTab` and `CertificationsTab`; the row's **"Open" button calls `previewFile(it.url, it.filename, it.name)`** (opens the modal, in-app preview). Extend each tab's item shape to carry `filename` (the tabs already have the `*_filename` fields available from `profile` / `payment` / `application`).
- `downloadFile` (new-tab) stays in the codebase but is demoted: new-tab becomes the in-modal fallback button, not the row's primary action.

### Data flow
row `url` (API path) + `filename` -> `previewFile` -> `api.get(url)` -> `data.url` (signed) -> modal renders by extension.

## Edge cases
- Signed-URL fetch fails / expired -> toast error (existing `downloadFile` catch pattern); modal does not open.
- PDF that won't embed (Content-Type / browser) -> the in-modal "Open in new tab" fallback.
- Non-previewable type (doc/docx) -> "preview not available" message + the fallback button.
- Missing filename -> treat as non-previewable (show the fallback).
- `Esc`, overlay click, and the close button all dismiss; focus is trapped while open.

## Non-goals
- No change to upload / storage / signing, nor to new-tab behavior on other surfaces.
- Applicant-side `FilesBlock` (separate surface), deferred.

## Verification
- `CI=true react-scripts build` clean (the Vercel gate for client changes).
- Manual, running app: a headshot image previews inline; a PDF (W-9 / BASSET) either embeds or the "Open in new tab" fallback works; `Esc` / overlay / close all dismiss; focus trap holds.
- Confirm R2 serves PDFs with an inline-capable `Content-Type`; if not, the fallback covers it and setting `Content-Type` on upload becomes a follow-up.

## Risk
Low. Isolated new component + display wiring; touches no money / auth / data path. The one uncertainty (PDF-in-iframe embedding) is mitigated by the always-present new-tab fallback.

## Build note
Single coherent lane: new component + 2 tab wirings + `AdminUserDetail` host + CSS. One build pass, client-only.

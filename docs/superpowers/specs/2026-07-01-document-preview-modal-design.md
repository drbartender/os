# Document Preview Modal — Design (2026-07-01)

*Rev 2: spec-fleet findings folded in (1 blocker, 7 warnings, 9 suggestions — see Review notes at bottom).*

## Context
Staff document rows in the admin user-detail view open each file (W-9, BASSET / alcohol cert, resume, headshot) in a new browser tab via `window.open(signedUrl)`. Dallas wants them to preview in an in-app modal ("docs should pop up in a modal, basset, headshot, etc."). Keeps the admin in context instead of tab-hopping.

## Scope
- **In:** the staff user-detail tabs, `client/src/pages/admin/userDetail/tabs/DocumentsTab.js` and `CertificationsTab.js`, plus their host `AdminUserDetail.js`.
- **Out (deferred):** the applicant-side file block (`applicationDetail/components/FilesBlock.js`), and any change to how documents are uploaded, stored, or signed.

## Current behavior (grounding — fleet-verified)
- Each doc row's `url` is an API path (e.g. `payment.w9_file_url`), not a direct R2 URL.
- `AdminUserDetail.downloadFile(url)` does `api.get(url)` -> `response.data.url` (a 15-minute presigned R2 URL, `storage.js` `expiresIn: 900`) -> `window.open(..., '_blank')`.
- Per-row filenames (`w9_filename`, `alcohol_certification_filename` / `basset_filename`, `resume_filename`, `headshot_filename`) exist in schema and reach the tabs — **but can be NULL while the URL exists** (e.g. W-9 rows saved before filenames were recorded), so filename alone cannot drive type detection.
- `getSignedUrl` sets no `Content-Disposition`, and `uploadFile` **already sets `ContentType` from the extension** (`.pdf` -> `application/pdf`, images mapped) with the extension preserved in the R2 key — so PDFs are expected to embed inline; the fallback below is insurance, not the primary path.
- The signed-URL endpoint (`GET /api/files/:filename`) is `auth` + admin/manager. Unchanged by this spec. (Awareness, out of scope: managers can already open W-9s today; the modal makes that pre-existing access more visible, not wider.)
- All five upload paths run magic-byte validation (`fileValidation.js`), and R2 is a different origin — an uploaded file cannot script the admin app.

## Design

### New component: `DocumentPreviewModal`
`client/src/components/adminos/DocumentPreviewModal.js` (new — `adminos/` because that is where this shell's sibling modals live: `InterviewScheduleModal`, `PackageIncludesModal`, `MenuSamplesModal`).

Props: `{ isOpen, title, filename, fileUrl, onClose, onOpenInNewTab }`.

- **Type detection:** extension from `filename` (case-insensitive); when `filename` is null/extensionless, **fall back to the extension of the signed URL's pathname** (the R2 key preserves it). Only if both fail -> non-previewable.
  - image (`png|jpg|jpeg|gif|webp`) -> `<img src={fileUrl}>`, contained to the viewport.
  - `pdf` -> `<iframe src={fileUrl} title={title}>` filling the modal body.
  - otherwise -> "Preview isn't available for this file type" message.
- **Load states inside the modal:** show a loading indicator until the `<img>` fires `onLoad` / the `<iframe>` fires `load`. `<img onError>` -> swap to the not-available message (broken-image glyphs never shown). A cross-origin iframe's render failure is not reliably detectable — the always-visible fallback button (below) is the recovery, and the not-available copy mentions it.
- **Fallback button — always rendered:** "Open in new tab" calls `onOpenInNewTab` (a callback, NOT a stale `<a href>`). The host wires it to the existing `downloadFile`, which fetches a **fresh** signed URL and `window.open`s it. This (a) keeps `downloadFile` consumed — no orphaned function tripping `no-unused-vars` under the CI build — and (b) immunizes the fallback against the 15-minute expiry of the URL the modal was opened with.
- **Accessibility:** mirror `ConfirmModal.js` (overlay-click close, `Esc` close, focus trap, `role="dialog"` + `aria-modal`) **plus focus restore**: capture `document.activeElement` on open and return focus to it on close (ConfirmModal itself lacks this; do not inherit the gap).
- **CSS:** `.doc-preview-*` rules in `index.css`, **scoped under `html[data-app="admin-os"]` and built on the theme tokens** (`--bg-elev`, `--ink-1`, `--line-2`, `--z-modal`), mirroring ConfirmModal's admin-os override block — NOT fixed light-paper values, so the modal is correct in both House Lights and After Hours skins (this is the exact token-flip bug class from the After Hours fix-list item).

### Wiring
- `AdminUserDetail.js`: add modal state (`{ open, title, fileUrl, filename, apiPath }`) and `previewFile(url, filename, title)`:
  1. set a per-row **pending** state (the clicked button disables — prevents double-fetch on double-click),
  2. `api.get(url)` -> `data.url`,
  3. open the modal. Fetch failure -> toast (existing `downloadFile` catch pattern), modal does not open.
  - `downloadFile` **stays** and is passed to the modal as `onOpenInNewTab={() => downloadFile(apiPath)}`.
- `DocumentsTab.js`: the row's "Open" button calls `previewFile(it.url, it.filename, it.name)`. **Extend each item to carry `filename` derived from the SAME source branch as its `url`** — e.g. alcohol cert: `profile?.alcohol_certification_file_url ? profile?.alcohol_certification_filename : application?.basset_filename` (never mix a profile URL with an application filename; the `||` chains must pair).
- `CertificationsTab.js`: no `items[]` array there (a single hardcoded alcohol-cert card) — wire the literal `previewFile(url, filename, 'Alcohol certification')` with the same source-pairing rule.

### Data flow
row `url` (API path) + source-paired `filename` -> `previewFile` (button pending) -> `api.get(url)` -> `data.url` (signed) -> modal renders by extension (filename, else URL-path extension) -> fallback re-signs via `downloadFile`.

## Edge cases
- Signed-URL fetch fails / expired -> toast error, modal does not open, button un-pends.
- Null filename + URL extension resolvable -> previews normally (the W-9/BASSET flagship case).
- Both filename and URL extension unresolvable, or non-previewable type (doc/docx) -> not-available message + fallback button.
- Image fails to load (`onError`) -> not-available message + fallback button.
- PDF iframe won't render (browser/content quirk) -> user clicks the visible fallback; fresh signed URL, new tab.
- Modal left open > 15 min -> in-modal render may expire (acceptable); fallback still works because it re-signs.
- Missing profile/payment/application object -> row has no `url`, no Open button renders (unchanged from today).
- `Esc`, overlay click, and the close button all dismiss; focus trap holds; focus returns to the triggering button.
- Mobile/iOS Safari: iframe PDFs may render blank — the fallback button is the mobile path (desktop-first admin surface; acceptable).

## Non-goals
- No change to upload / storage / signing, auth roles, or new-tab behavior on other surfaces.
- Applicant-side `FilesBlock` (separate surface), deferred.
- No `Cache-Control` / `Content-Disposition` changes (PII caching is exactly parity with today's new-tab).

## Build-time considerations (non-blocking)
- Optional `sandbox` on the PDF iframe as defense-in-depth — only if verified not to break the browser's native PDF viewer (bare `sandbox` can disable it). Cross-origin R2 + magic-byte upload validation are the real protections; skip if it fights the viewer.
- Observability: fetch failures toast (existing pattern); render failures surface the in-modal not-available state. No Sentry needed for a display miss.

## Documentation
- `README.md`: add `DocumentPreviewModal.js` to the folder tree under `client/src/components/adminos/` (the tree enumerates these files individually; mandatory-docs table row for a new component).

## Verification
- `CI=true react-scripts build` clean (also proves `downloadFile` is still consumed).
- Manual, running app: headshot image previews inline; a PDF (W-9 / BASSET) embeds (Content-Type already inline-capable) — and the "Open in new tab" fallback works regardless; a null-filename W-9 still previews via the URL-extension fallback; `Esc` / overlay / close dismiss and focus returns to the Open button; **check both admin skins** (House Lights + After Hours) for token correctness; button pending state prevents double-fetch.

## Risk
Low. Isolated new component + display wiring; no money / auth / data / write path. The PDF-embed uncertainty is resolved in code (ContentType already set) with the re-signing fallback as insurance.

## Review notes (spec fleet, 2026-07-01)
Fleet ran post-Rev-1: 1 blocker (orphaned `downloadFile` vs the CI lint gate — resolved by routing the fallback through it), 7 warnings (null-filename degradation, loading states, 15-min fallback expiry, silent img/iframe failure, URL/filename source-pairing, README row, pre-existing manager W-9 visibility), 9 suggestions (adminos placement + dark-skin token scoping adopted as required; focus restore; CertificationsTab literal wiring; iOS note; optional iframe sandbox; Content-Type finding folded into grounding; PII-caching parity noted). All folded above.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../../utils/api';

/**
 * ReplaceConfirmModal — staff portal v2 Account / Documents (spec §6.14).
 *
 * Renders the "Replace your [doc]?" confirm dialog used by both replaceable
 * doc rows (W-9 and alcohol certification). The shape varies by `docType`:
 *
 *   - 'w9':                    file picker only.
 *   - 'alcohol_certification': file picker PLUS a REQUIRED future-date input
 *                              for the new `expires_on`.
 *
 * Both variants POST multipart/form-data to
 *   POST /api/me/documents/:doc_type/replace
 * via the api.js axios instance. The instance has `Bearer <jwt>` already
 * attached; axios sets `Content-Type: multipart/form-data; boundary=…`
 * automatically when the body is a FormData (matches the upload pattern in
 * client/src/pages/plan/components/LogoUploadField.js and
 * client/src/pages/ContractorProfile.js).
 *
 * Server contract (server/routes/staffPortal.js ~line 656):
 *   - field `file`               — the upload (PDF/PNG/JPEG only, ≤10 MB).
 *   - field `expires_on`         — YYYY-MM-DD, must be > CURRENT_DATE.
 *                                  Required iff docType === 'alcohol_certification'.
 *   - 200  { ok, file_url, filename, expires_on? }
 *   - 400  validation (mime mismatch, missing file, bad date)
 *           shape: { error, fieldErrors? } via AppError
 *   - 413  { error: 'File too large (max 10 MB).', code: 'FILE_TOO_LARGE' }
 *           NOTE: express-fileupload's `abortOnLimit` fires BEFORE this
 *           handler with a plain `text/html` 413, so axios surfaces it as
 *           a non-JSON 413. We detect `status === 413` and use a friendly
 *           message regardless of body shape.
 *   - 502  R2 upload failed (ExternalServiceError)
 *
 * Props:
 *   docType   'w9' | 'alcohol_certification'
 *   docLabel  Human label used in the title ("W-9", "alcohol certification")
 *   onClose   () => void — invoked on Cancel / scrim / X / Escape.
 *   onReplaced (serverResponse) => void — invoked AFTER the POST returns 200.
 *                                          Parent re-fetches /me/documents.
 *
 * Async-state coverage (spec §6.1.5):
 *   - Loading: N/A on open; on submit the Replace button shows "Uploading…"
 *              and both action buttons + inputs are disabled until the call
 *              resolves so the user can't double-submit.
 *   - Error:   inline `sp-modal-error` row directly under the picker. Cleared
 *              on the next file/date change so the user sees their fix land.
 *   - Empty:   the picker shows "Choose a file…" when nothing's been picked.
 *   - Disabled: Replace button disabled until a valid file is chosen AND
 *               (alcohol cert) a future date is entered.
 */

// Mirror the server's whitelist + size cap so we can validate locally and
// avoid a round trip for the obvious cases. Magic-byte validation still
// happens server-side (server/utils/fileValidation.js); these are extension-
// and-MIME hints only.
const ACCEPT = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg';
const ACCEPT_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg']);
const ACCEPT_EXT = new Set(['pdf', 'png', 'jpg', 'jpeg']);
const MAX_BYTES = 10 * 1024 * 1024;

function fileExt(name) {
  if (!name || typeof name !== 'string') return '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

// Today (UTC) as a YYYY-MM-DD string. Used for the date input's `min`
// attribute and for the future-date check. UTC matches the server, which
// compares against CURRENT_DATE in a UTC-ish way (`isValidIsoDateFuture`
// in staffPortal.js zeroes UTC hours on both sides).
function todayIsoUtc() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

// Validate a YYYY-MM-DD string is strictly in the future. Mirrors the
// server's `isValidIsoDateFuture` so the user sees instant feedback.
function isFutureIsoDate(s) {
  if (!s || typeof s !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return d.getTime() > today.getTime();
}

function prettySize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ReplaceConfirmModal({ docType, docLabel, onClose, onReplaced }) {
  const fileInputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [expiresOn, setExpiresOn] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const needsExpiry = docType === 'alcohol_certification';
  const today = useMemo(() => todayIsoUtc(), []);

  // Escape closes when not submitting. Mirrors ProfileSection's ChangeEmailModal.
  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape' && !submitting) onClose();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [submitting, onClose]);

  function clearError() {
    if (error) setError(null);
  }

  function handlePick(e) {
    clearError();
    const next = e.target.files?.[0] || null;
    if (!next) {
      setFile(null);
      return;
    }
    // Client-side type sniff (mime first, extension as fallback for browsers
    // that hand us '' for the mime, e.g. some Android pickers). The server's
    // magic-byte check is the authoritative gate.
    const ext = fileExt(next.name);
    const mime = next.type || '';
    if (mime && !ACCEPT_MIME.has(mime) && !ACCEPT_EXT.has(ext)) {
      setError('Only PDF, PNG, or JPEG files are accepted.');
      setFile(null);
      return;
    }
    if (!mime && !ACCEPT_EXT.has(ext)) {
      setError('Only PDF, PNG, or JPEG files are accepted.');
      setFile(null);
      return;
    }
    if (next.size > MAX_BYTES) {
      setError('That file is over the 10 MB limit. Pick a smaller one.');
      setFile(null);
      return;
    }
    setFile(next);
  }

  function handleDateChange(v) {
    clearError();
    setExpiresOn(v);
  }

  // Allow submit only when a valid file is chosen AND (alcohol cert) a
  // future date is set. The Replace button mirrors this.
  const canSubmit = !submitting
    && !!file
    && (!needsExpiry || isFutureIsoDate(expiresOn));

  async function handleSubmit() {
    if (!canSubmit) return;
    if (needsExpiry && !isFutureIsoDate(expiresOn)) {
      setError('Expiry date must be in the future.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const body = new FormData();
      body.append('file', file);
      if (needsExpiry) body.append('expires_on', expiresOn);
      const res = await api.post(
        `/me/documents/${docType}/replace`,
        body,
        // axios will set the multipart Content-Type (with boundary) when
        // the body is a FormData; we set it explicitly here to mirror the
        // existing upload pattern (LogoUploadField.js) and to be defensive
        // against future axios changes.
        { headers: { 'Content-Type': 'multipart/form-data' } }
      );
      // Parent owns the success toast + re-fetch; pass the response in case
      // the caller wants the new filename/expiry without a round trip.
      onReplaced(res?.data || null);
    } catch (err) {
      // Surface a clean inline message. The api.js interceptor normalizes
      // errors to { message, code, fieldErrors, status }, but:
      //   - express-fileupload's abortOnLimit returns a plain text/html 413
      //     before our handler sees the request, so `message` is generic
      //     and we have to map 413 ourselves.
      //   - ExternalServiceError → 502 from the R2 upload step.
      //   - ValidationError shape carries fieldErrors.file / .expires_on.
      let msg = err?.message || 'Could not upload that file.';
      if (err?.status === 413 || err?.code === 'FILE_TOO_LARGE') {
        msg = 'That file is over the 10 MB limit. Pick a smaller one.';
      } else if (err?.status === 502) {
        msg = 'Storage is temporarily unavailable. Please try again in a moment.';
      } else if (err?.fieldErrors && typeof err.fieldErrors === 'object') {
        if (err.fieldErrors.expires_on) msg = err.fieldErrors.expires_on;
        else if (err.fieldErrors.file) msg = err.fieldErrors.file;
      }
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  function handleScrimClick() {
    if (submitting) return;
    onClose();
  }

  const titleLower = (docLabel || 'document').toLowerCase();

  return (
    <>
      <div className="sp-modal-scrim" onClick={handleScrimClick} />
      <div
        className="sp-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sp-doc-replace-title"
      >
        <button
          type="button"
          className="sp-modal-close"
          onClick={onClose}
          aria-label="Close"
          disabled={submitting}
        >
          ×
        </button>
        <div className="sp-modal-icon" aria-hidden="true">
          <PenIcon size={20} />
        </div>
        <div id="sp-doc-replace-title" className="sp-modal-title">
          Replace your {titleLower}?
        </div>
        <div className="sp-modal-sub">
          The new file becomes your active record. Choose a PDF or photo.
        </div>

        <label className="sp-doc-picker">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            style={{ display: 'none' }}
            onChange={handlePick}
            disabled={submitting}
          />
          {file ? (
            <>
              <CheckIcon size={14} />
              <span>
                <strong>{file.name}</strong> · {prettySize(file.size)}
              </span>
            </>
          ) : (
            <>
              <UploadIcon size={14} />
              <span>Choose a file…</span>
            </>
          )}
        </label>

        {needsExpiry && (
          <>
            <div className="sp-modal-label">New expiry date</div>
            <input
              className="sp-modal-input sp-mono"
              type="date"
              value={expiresOn}
              min={today}
              onChange={(e) => handleDateChange(e.target.value)}
              disabled={submitting}
              style={{ minHeight: 0, height: 40 }}
              aria-describedby="sp-doc-expires-help"
            />
            <div
              id="sp-doc-expires-help"
              className="sp-tf-sub"
              style={{ marginTop: 6 }}
            >
              Must be a future date.
            </div>
          </>
        )}

        {error && <div className="sp-modal-error">{error}</div>}

        <div className="sp-modal-acts">
          <button
            type="button"
            className="sp-btn sp-btn-block sp-btn-primary"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {submitting ? 'Uploading…' : 'Replace'}
          </button>
          <button
            type="button"
            className="sp-btn sp-btn-block"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}

// ── Inline icons (Lucide-style 1.75 stroke, matches StaffShell) ──────────

function PenIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20h4l10-10-4-4L4 16v4ZM14 6l4 4" />
    </svg>
  );
}

function CheckIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function UploadIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

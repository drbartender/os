import React, { useState, useEffect, useRef, useCallback } from 'react';
import Icon from './Icon';

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

// Extension from a filename or URL. For URLs, match against the pathname so the
// signed query string (R2 presign params) can't confuse the match.
function extOf(str) {
  if (!str || typeof str !== 'string') return null;
  let path = str;
  if (/^https?:\/\//i.test(str)) {
    try { path = new URL(str).pathname; } catch { /* keep raw string */ }
  }
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Lightbox preview for staff documents (W-9, BASSET, resume, headshot).
 * Type is derived from the filename extension, falling back to the signed
 * URL's path extension (the R2 key preserves it — filenames can be NULL on
 * older rows). `onOpenInNewTab` must fetch a FRESH signed URL (the host wires
 * it to downloadFile), so the fallback works even after the 15-minute expiry
 * of the URL this modal was opened with.
 */
export default function DocumentPreviewModal({ title, filename, fileUrl, onClose, onOpenInNewTab }) {
  const modalRef = useRef(null);
  const closeRef = useRef(null);
  const triggerRef = useRef(null);
  const [loaded, setLoaded] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);

  const ext = extOf(filename) || extOf(fileUrl);
  const kind = IMAGE_EXTS.includes(ext) ? 'image' : (ext === 'pdf' ? 'pdf' : 'other');

  // Esc to close, focus the Close button on open, and restore focus to the
  // triggering element on dismiss (ConfirmModal's pattern + focus restore).
  // onClose rides in a ref so the effect runs exactly once per mount — with
  // [onClose] deps, the host's inline handler would re-run it on every parent
  // re-render, transiently bouncing focus out of the trap.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    triggerRef.current = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onCloseRef.current(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (triggerRef.current && typeof triggerRef.current.focus === 'function') {
        triggerRef.current.focus();
      }
    };
  }, []);

  const handleTabTrap = useCallback((e) => {
    if (e.key !== 'Tab' || !modalRef.current) return;
    const focusable = modalRef.current.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }, []);

  const label = title || filename || 'Document';
  const showUnavailable = kind === 'other' || imgFailed;

  return (
    <div className="doc-preview-overlay" onClick={onClose}>
      <div
        ref={modalRef}
        className="doc-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleTabTrap}
      >
        <div className="doc-preview-head">
          <h3>{label}</h3>
          <div className="doc-preview-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenInNewTab}>
              <Icon name="external" size={11} />Open in new tab
            </button>
            <button ref={closeRef} type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        <div className="doc-preview-body">
          {showUnavailable ? (
            <div className="doc-preview-empty">
              {imgFailed
                ? 'This image could not be loaded.'
                : "Preview isn't available for this file type."}
              {' '}Use "Open in new tab" instead.
            </div>
          ) : (
            <>
              {!loaded && <div className="doc-preview-loading">Loading document…</div>}
              {kind === 'image' && (
                <img
                  className="doc-preview-img"
                  src={fileUrl}
                  alt={label}
                  onLoad={() => setLoaded(true)}
                  onError={() => { setImgFailed(true); setLoaded(true); }}
                  style={loaded ? undefined : { display: 'none' }}
                />
              )}
              {kind === 'pdf' && (
                <iframe
                  className="doc-preview-frame"
                  src={fileUrl}
                  title={label}
                  onLoad={() => setLoaded(true)}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

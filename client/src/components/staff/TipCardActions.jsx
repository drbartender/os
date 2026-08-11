import React from 'react';

/**
 * TipCardActions — the action row under the tip-card hero in the staff portal.
 *
 * Extracted from TipCardPage.js (2026-08-11) when display mode added a fourth
 * button: that page sits right at its 700-line soft cap, so the row and the
 * three icons only it used moved out rather than pushing the file over.
 *
 * Props are all handlers; the parent owns the data.
 */
export default function TipCardActions({ onDownload, onDisplay, onShare, onCopy }) {
  return (
    <div className="sp-tipcard-actions">
      <button type="button" className="sp-btn sp-btn-sm" onClick={onDownload}>
        <ExternalIcon size={12} />
        Download your sign
      </button>
      <button type="button" className="sp-btn sp-btn-sm" onClick={onDisplay}>
        <ScreenIcon size={12} />
        Display mode
      </button>
      <button type="button" className="sp-btn sp-btn-sm" onClick={onShare}>
        <SendIcon size={12} />
        Share link
      </button>
      <button type="button" className="sp-btn sp-btn-sm" onClick={onCopy}>
        <CopyIcon size={12} />
        Copy URL
      </button>
    </div>
  );
}

function ExternalIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 5H5v14h14v-5M14 4h6v6M20 4l-9 9" />
    </svg>
  );
}

function ScreenIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="3" width="16" height="14" rx="2" />
      <path d="M9 21h6M12 17v4" />
    </svg>
  );
}

function SendIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12 21 4l-7 17-3-7-7-2Z" />
    </svg>
  );
}

function CopyIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    </svg>
  );
}

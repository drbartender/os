import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';

// Confirmation shown when a save would message the client (notify-client
// contract, 2026-07-22). One block per notice; composable notices are
// editable (the reviewed text IS what sends — WYSIWYG), fixed-template ones
// are described via their reasons line.
//
// Escape and backdrop are CANCEL, never quiet-save: dismissing must not
// silently commit an edit the admin was still deciding about. While `busy`,
// every exit is inert (double-click = double-message; the server has no
// idempotency on these sends).
//
// `primary` names which of quiet/send is the success-styled, rightmost
// button. The edit popup uses primary="quiet" (Dallas usually already
// replied personally); the payment/refund popups use primary="send"
// (receipts are usually wanted). The ORDER flips with it so the reflex
// position is never the sender in one context and the suppressor in another.
const SUBJECT_MAX = 300;
const SMS_MAX_CHARS = 640;

// Server reasons arrive as `${column} changed`; show the admin words, not columns.
const REASON_LABELS = {
  'event_date changed': 'Date changed',
  'event_start_time changed': 'Start time changed',
  'event_location changed': 'Location changed',
};
const humanizeReason = (r) => REASON_LABELS[r] || r;

export default function NotifyConfirmModal({
  notices,
  primary = 'quiet',
  title = 'Notify the client?',
  sendLabel = 'Send the update',
  quietLabel = "Don't send",
  busy = false,
  onCancel,
  onQuiet,
  onSend,
}) {
  const [drafts, setDrafts] = useState(() => (notices || []).map((n) => ({
    type: n.type,
    channels: Object.entries(n.channels || {})
      .filter(([, c]) => c && c.available && c.default)
      .map(([k]) => k),
    subject: n.draft?.email?.subject || '',
    bodyText: n.draft?.email?.body_text || '',
    smsBody: n.draft?.sms?.body || '',
  })));

  const modalRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);

  // Focus containment (house pattern, ConfirmModal.js / RepriceConfirmModal):
  // this dialog gates a save + a client send, so focus must move INTO it on
  // mount (the form's Save button otherwise keeps focus and Enter re-fires
  // the save chain behind the overlay) and Tab must not wander into the
  // dimmed editor.
  useEffect(() => {
    if (modalRef.current) {
      const first = modalRef.current.querySelector(
        'input, textarea, button, [href], select, [tabindex]:not([tabindex="-1"])'
      );
      if (first) first.focus();
    }
  }, []);

  const handleTabTrap = useCallback((e) => {
    if (e.key !== 'Tab' || !modalRef.current) return;
    const focusable = modalRef.current.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select, textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
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

  if (!notices || notices.length === 0) return null;

  const update = (i, patch) => setDrafts((d) => d.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const toggleChannel = (i, ch) => update(i, {
    channels: drafts[i].channels.includes(ch)
      ? drafts[i].channels.filter((c) => c !== ch)
      : [...drafts[i].channels, ch],
  });

  const overCap = drafts.some((d, i) => {
    if (!notices[i].composable) return false;
    if (d.channels.includes('email') && (d.subject.length > SUBJECT_MAX || !d.subject.trim() || !d.bodyText.trim())) return true;
    if (d.channels.includes('sms') && (d.smsBody.length > SMS_MAX_CHARS || !d.smsBody.trim())) return true;
    return false;
  });
  const anyChannel = drafts.some((d) => d.channels.length > 0);

  const buildNotify = () => drafts
    .filter((d) => d.channels.length > 0)
    .map((d, i) => {
      const notice = notices.find((n) => n.type === d.type);
      const out = { type: d.type, channels: d.channels };
      if (!notice.composable) return out;
      if (d.channels.includes('email')) out.email = { subject: d.subject, body_text: d.bodyText };
      if (d.channels.includes('sms')) out.sms = { body: d.smsBody };
      return out;
    });

  const quietBtn = (
    <button
      key="quiet"
      className={primary === 'quiet' ? 'btn btn-success' : 'btn btn-secondary'}
      disabled={busy}
      onClick={onQuiet}
    >{quietLabel}</button>
  );
  const sendBtn = (
    <button
      key="send"
      className={primary === 'send' ? 'btn btn-success' : 'btn'}
      disabled={busy || !anyChannel || overCap}
      onClick={() => onSend(buildNotify())}
    >{sendLabel}</button>
  );

  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        backgroundColor: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        overflowY: 'auto', paddingTop: 'calc(60px + 1.5rem)',
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="notify-confirm-title"
        onKeyDown={handleTabTrap}
        style={{
          backgroundColor: 'var(--bg-elev)', width: '100%', maxWidth: 640,
          borderRadius: 8, padding: '1.25rem', margin: '0 1rem 1.5rem',
        }}
      >
        <h3 id="notify-confirm-title" style={{ fontFamily: 'var(--font-display)', marginBottom: '0.35rem' }}>{title}</h3>

        {notices.map((n, i) => (
          <div key={n.type} style={{ borderTop: i > 0 ? '1px solid var(--line-2)' : 'none', paddingTop: i > 0 ? '1rem' : '0.4rem', marginBottom: '1rem' }}>
            <div className="text-small text-muted" style={{ marginBottom: '0.5rem' }}>
              {(n.reasons || []).map(humanizeReason).join(', ')}. Current contact on file: {n.recipient?.name || 'the client'}
              {n.recipient?.email ? ` (${n.recipient.email})` : ''}{!n.recipient?.email && n.recipient?.phone ? ` (${n.recipient.phone})` : ''}.
            </div>

            {n.autopay_notice && (
              <div className="text-small" style={{
                marginBottom: '0.6rem', padding: '0.4rem 0.6rem', borderRadius: 6,
                background: 'hsl(var(--warn-h, 40) var(--warn-s, 90%) 92%)', color: 'var(--deep-brown, #442)',
              }}>
                {n.autopay_notice}
              </div>
            )}

            <div style={{ display: 'flex', gap: '1rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
              {['email', 'sms'].map((ch) => (n.channels?.[ch]?.available ? (
                <label key={ch} className="text-small" style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                  <input type="checkbox" disabled={busy} checked={drafts[i].channels.includes(ch)} onChange={() => toggleChannel(i, ch)} />
                  {ch === 'email' ? 'Email' : 'Text'}
                </label>
              ) : (n.channels?.[ch]?.unavailable_reason ? (
                <span key={ch} className="text-small text-muted">
                  {ch === 'email' ? 'Email' : 'Text'} unavailable: {n.channels[ch].unavailable_reason}
                </span>
              ) : null)))}
            </div>

            {n.composable ? (
              <>
                {drafts[i].channels.includes('email') && (
                  <>
                    <input
                      className="form-input mb-1" value={drafts[i].subject} disabled={busy}
                      onChange={(e) => update(i, { subject: e.target.value })} placeholder="Subject"
                    />
                    <div className="text-small" style={{ textAlign: 'right', marginTop: '-0.4rem', color: drafts[i].subject.length > SUBJECT_MAX ? 'hsl(var(--danger-h) var(--danger-s) 55%)' : 'var(--ink-3)' }}>
                      {drafts[i].subject.length} / {SUBJECT_MAX}
                    </div>
                    <textarea
                      className="form-input mb-1" rows={7} value={drafts[i].bodyText} disabled={busy}
                      onChange={(e) => update(i, { bodyText: e.target.value })}
                    />
                  </>
                )}
                {drafts[i].channels.includes('sms') && (
                  <>
                    <textarea
                      className="form-input" rows={3} value={drafts[i].smsBody} disabled={busy}
                      onChange={(e) => update(i, { smsBody: e.target.value })}
                    />
                    <div className="text-small" style={{ textAlign: 'right', color: drafts[i].smsBody.length > SMS_MAX_CHARS ? 'hsl(var(--danger-h) var(--danger-s) 55%)' : 'var(--ink-3)' }}>
                      {drafts[i].smsBody.length} / {SMS_MAX_CHARS}
                    </div>
                  </>
                )}
              </>
            ) : (
              <div className="text-small">This message is not editable.</div>
            )}
          </div>
        ))}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1rem' }}>
          <button className="btn btn-secondary" disabled={busy} onClick={onCancel}>Cancel</button>
          {primary === 'quiet' ? [sendBtn, quietBtn] : [quietBtn, sendBtn]}
        </div>
      </div>
    </div>,
    document.body
  );
}

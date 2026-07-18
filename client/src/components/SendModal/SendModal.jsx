import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import api from '../../utils/api';

// Shared compose-and-confirm modal for the comms registry (spec 4.3). It runs
// its own two-step flow: POST /comms/preview to load the recipient, channels,
// and prefilled message, then POST /comms/send with only the channels the admin
// keeps checked. The server does nothing until send, so a Cancel never touches
// the client record. All requests go through the shared api instance.

const SMS_LIMIT = 640;

// Every request here goes through the api instance, whose interceptor already
// reduces any AppError JSON to a normalized rejection ({ message, code, ... }).
// So err.message is the friendly, client-safe string; fall back only when it is
// somehow absent, never crashing on shape.
function friendlyError(err) {
  if (err && typeof err.message === 'string' && err.message) return err.message;
  return 'Something went wrong. Please try again.';
}

export default function SendModal({
  action, entityId, title, confirmLabel = 'Send', onClose, onComplete,
  // Side-effects-only confirm (spec 4.6): when no channel is available the
  // modal normally dead-ends (Cancel only). Actions whose confirm still
  // matters without a message (hosted-package approve) pass true so the
  // primary button stays available and submits with an empty channel list,
  // which the server accepts only in the genuinely-no-channel case.
  allowNoChannelConfirm = false,
  noChannelNote = '',
  noChannelConfirmLabel = '',
}) {
  // 'loading' | 'error' (preview failed) | 'nochannel' | 'compose' | 'result'
  const [phase, setPhase] = useState('loading');
  const [previewError, setPreviewError] = useState('');
  const [preview, setPreview] = useState(null);

  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [smsBody, setSmsBody] = useState('');
  const [emailChecked, setEmailChecked] = useState(false);
  const [smsChecked, setSmsChecked] = useState(false);

  const [inFlight, setInFlight] = useState(false);
  const [sendError, setSendError] = useState('');
  const [results, setResults] = useState(null);
  const [submittedChannels, setSubmittedChannels] = useState([]);

  // onComplete must fire exactly once, on the Done path only.
  const doneFiredRef = useRef(false);

  const loadPreview = useCallback(async () => {
    setPhase('loading');
    setPreviewError('');
    setSendError('');
    try {
      const res = await api.post('/comms/preview', { action, entity_id: entityId });
      const data = res.data || {};
      setPreview(data);
      setEmailSubject((data.email && data.email.subject) || '');
      setEmailBody((data.email && data.email.bodyText) || '');
      setSmsBody((data.sms && data.sms.body) || '');
      const channels = data.channels || {};
      const emailAvail = !!(channels.email && channels.email.available);
      const smsAvail = !!(channels.sms && channels.sms.available);
      setEmailChecked(emailAvail && !!channels.email.default);
      setSmsChecked(smsAvail && !!channels.sms.default);
      setPhase(!emailAvail && !smsAvail ? 'nochannel' : 'compose');
    } catch (err) {
      setPreviewError(friendlyError(err));
      setPhase('error');
    }
  }, [action, entityId]);

  useEffect(() => { loadPreview(); }, [loadPreview]);

  // onlyChannels: null for the compose-phase send (all checked channels);
  // an array like ['sms'] for the result-phase Retry, which re-submits ONLY
  // the failed channel (review blocker: re-posting every checked channel
  // re-sent the already-successful one — side effects are idempotent, sends
  // are not) and flags the request so the server allows an applied:false
  // dispatch for it.
  const doSend = useCallback(async (onlyChannels = null) => {
    const isRetry = Array.isArray(onlyChannels);
    const channels = [];
    const payload = { action, entity_id: entityId, channels };
    if (isRetry) payload.retry = true;
    if (emailChecked && (!isRetry || onlyChannels.includes('email'))) {
      channels.push('email');
      payload.email = { subject: emailSubject, body_text: emailBody };
    }
    if (smsChecked && (!isRetry || onlyChannels.includes('sms'))) {
      channels.push('sms');
      payload.sms = { body: smsBody };
    }
    setSubmittedChannels((prev) => (isRetry ? Array.from(new Set([...prev, ...channels])) : channels));
    setInFlight(true);
    setSendError('');
    try {
      const res = await api.post('/comms/send', payload);
      setResults((prev) => {
        const next = res.data || {};
        if (!isRetry || !prev) return next;
        // Merge: channels NOT in this retry keep their earlier outcome (the
        // server reports them 'not selected' on the retry request).
        const merged = { ...prev, ...next };
        for (const k of ['email', 'sms']) {
          if (!channels.includes(k)) {
            merged[k] = prev[k];
            merged[`${k}_error`] = prev[`${k}_error`];
            merged.skip_reasons = {
              ...(merged.skip_reasons || {}),
              ...(prev.skip_reasons && prev.skip_reasons[k] !== undefined ? { [k]: prev.skip_reasons[k] } : {}),
            };
          }
        }
        return merged;
      });
      setPhase('result');
    } catch (err) {
      // A total failure (non-200) leaves us in compose/result with a banner so
      // the admin can retry; nothing structured came back to render per-channel.
      setSendError(friendlyError(err));
    } finally {
      setInFlight(false);
    }
  }, [action, entityId, emailChecked, smsChecked, emailSubject, emailBody, smsBody]);

  const finishDone = useCallback(() => {
    if (doneFiredRef.current) return;
    doneFiredRef.current = true;
    if (onComplete) onComplete(results);
    onClose();
  }, [results, onComplete, onClose]);

  // Escape / overlay click: closes only in compose, preview-error, and no-channel
  // (all Cancel-equivalent), routes through Done in result, and is inert while
  // loading or mid-send.
  const requestClose = useCallback(() => {
    if (phase === 'loading' || inFlight) return;
    if (phase === 'result') { finishDone(); return; }
    onClose();
  }, [phase, inFlight, finishDone, onClose]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') requestClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [requestClose]);

  const channels = (preview && preview.channels) || {};
  const emailAvail = !!(channels.email && channels.email.available);
  const smsAvail = !!(channels.sms && channels.sms.available);

  const emailValid = !emailChecked || (emailSubject.trim() !== '' && emailBody.trim() !== '');
  const smsValid = !smsChecked || (smsBody.trim() !== '' && smsBody.length <= SMS_LIMIT);
  const canSend = (emailChecked || smsChecked) && emailValid && smsValid && !inFlight;

  const recipient = (preview && preview.recipient) || {};
  const cta = preview && preview.email && preview.email.cta;

  const toLine = () => {
    let line = 'To:';
    if (recipient.name) line += ` ${recipient.name}`;
    if (recipient.email) line += ` <${recipient.email}>`;
    if (recipient.phone) line += ` · ${recipient.phone}`;
    return line;
  };

  const renderChannelResult = (key, sentVerb, contact) => {
    if (!results || !submittedChannels.includes(key)) return null;
    const status = results[key];
    const err = results[`${key}_error`];
    const skip = results.skip_reasons && results.skip_reasons[key];
    if (status === 'sent') {
      return (
        <p className="send-modal-result-line send-modal-result-sent">
          ✓ {sentVerb} {contact}
        </p>
      );
    }
    if (status === 'failed') {
      const label = key === 'email' ? 'Email failed' : 'Text failed';
      return (
        <div className="send-modal-result-line send-modal-result-failed">
          <span>{label}: {err || 'Please try again.'}</span>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => doSend([key])}
            disabled={inFlight}
          >
            {inFlight ? 'Retrying...' : 'Retry'}
          </button>
        </div>
      );
    }
    // skipped (or any unexpected status): grey line with the reason if we have one
    return (
      <p className="send-modal-result-line send-modal-result-skipped">
        {(key === 'email' ? 'Email skipped' : 'Text skipped')}{skip ? `: ${skip}` : ''}
      </p>
    );
  };

  let bodyContent;
  if (phase === 'loading') {
    bodyContent = (
      <div className="send-modal-loading">
        <span className="send-modal-spinner" aria-hidden="true" />
        <span>Loading message...</span>
      </div>
    );
  } else if (phase === 'error') {
    bodyContent = (
      <div className="send-modal-state-error">
        <p>{previewError}</p>
        <div className="send-modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={loadPreview}>Retry</button>
        </div>
      </div>
    );
  } else if (phase === 'nochannel') {
    bodyContent = (
      <div className="send-modal-state-error">
        {channels.email && channels.email.unavailable_reason && (
          <p className="send-modal-unavailable">Email: {channels.email.unavailable_reason}</p>
        )}
        {channels.sms && channels.sms.unavailable_reason && (
          <p className="send-modal-unavailable">Text: {channels.sms.unavailable_reason}</p>
        )}
        <p className="send-modal-nochannel-note">
          {allowNoChannelConfirm
            ? (noChannelNote || 'No message will be sent.')
            : 'Fix the client record first, then reopen this send.'}
        </p>
        {sendError && <p className="send-modal-banner-error">{sendError}</p>}
        <div className="send-modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={inFlight}>Cancel</button>
          {allowNoChannelConfirm && (
            <button type="button" className="btn btn-primary" onClick={() => doSend()} disabled={inFlight}>
              {inFlight ? 'Working...' : (noChannelConfirmLabel || confirmLabel)}
            </button>
          )}
        </div>
      </div>
    );
  } else if (phase === 'result') {
    bodyContent = (
      <div className="send-modal-result">
        {submittedChannels.length === 0 && results && results.ok && (
          <p className="send-modal-result-line send-modal-result-sent">✓ Done. No message was sent.</p>
        )}
        {renderChannelResult('email', 'Emailed', results.recipient_email)}
        {renderChannelResult('sms', 'Texted', results.recipient_phone)}
        {sendError && <p className="send-modal-banner-error">{sendError}</p>}
        <div className="send-modal-footer">
          <button type="button" className="btn btn-primary" onClick={finishDone} disabled={inFlight}>
            Done
          </button>
        </div>
      </div>
    );
  } else {
    // compose
    bodyContent = (
      <div className="send-modal-compose">
        <p className="send-modal-to">
          {toLine()}
          {recipient.source === 'snapshot' && (
            <span className="send-modal-source-badge">from plan record</span>
          )}
        </p>

        {preview && Array.isArray(preview.warnings) && preview.warnings.length > 0 && (
          <ul className="send-modal-warnings">
            {preview.warnings.map((w, i) => (
              <li key={i} className="send-modal-warning">{w}</li>
            ))}
          </ul>
        )}

        {/* Email channel */}
        <div className="send-modal-channel">
          <label className="send-modal-channel-head">
            <input
              type="checkbox"
              checked={emailChecked}
              disabled={!emailAvail}
              onChange={(e) => setEmailChecked(e.target.checked)}
            />
            <span>Email</span>
          </label>
          {emailAvail ? (
            <div className="send-modal-channel-body">
              <label className="send-modal-field-label" htmlFor="send-modal-subject">Subject</label>
              <input
                id="send-modal-subject"
                type="text"
                className="send-modal-input"
                value={emailSubject}
                onChange={(e) => setEmailSubject(e.target.value)}
              />
              <label className="send-modal-field-label" htmlFor="send-modal-body">Message</label>
              <textarea
                id="send-modal-body"
                className="send-modal-textarea"
                rows={7}
                value={emailBody}
                onChange={(e) => setEmailBody(e.target.value)}
              />
              {cta && cta.label && (
                <div className="send-modal-fixed-block">
                  [{cta.label}] → {cta.url}
                </div>
              )}
              <p className="send-modal-fixed-caption">Link button added automatically</p>
            </div>
          ) : (
            channels.email && channels.email.unavailable_reason && (
              <p className="send-modal-unavailable">{channels.email.unavailable_reason}</p>
            )
          )}
        </div>

        {/* SMS channel */}
        <div className="send-modal-channel">
          <label className="send-modal-channel-head">
            <input
              type="checkbox"
              checked={smsChecked}
              disabled={!smsAvail}
              onChange={(e) => setSmsChecked(e.target.checked)}
            />
            <span>Text message</span>
          </label>
          {smsAvail ? (
            <div className="send-modal-channel-body">
              <textarea
                className="send-modal-textarea"
                rows={4}
                value={smsBody}
                onChange={(e) => setSmsBody(e.target.value)}
              />
              <p className={`send-modal-counter${smsBody.length > SMS_LIMIT ? ' send-modal-counter-over' : ''}`}>
                {smsBody.length} / {SMS_LIMIT}
              </p>
            </div>
          ) : (
            channels.sms && channels.sms.unavailable_reason && (
              <p className="send-modal-unavailable">{channels.sms.unavailable_reason}</p>
            )
          )}
        </div>

        {sendError && <p className="send-modal-banner-error">{sendError}</p>}

        <div className="send-modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={inFlight}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => doSend()} disabled={!canSend}>
            {inFlight ? 'Sending...' : confirmLabel}
          </button>
        </div>
      </div>
    );
  }

  return createPortal(
    <div className="send-modal-overlay" onClick={requestClose}>
      <div
        className="send-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title || 'Send message'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="send-modal-header">
          <h3 className="send-modal-title">{title || 'Send message'}</h3>
          {/* Close routes through requestClose so it is inert mid-flight and Done-aware in result */}
          <button
            type="button"
            className="send-modal-close"
            aria-label="Close"
            onClick={requestClose}
            disabled={phase === 'loading' || inFlight}
          >
            ×
          </button>
        </div>
        <div className="send-modal-body">
          {bodyContent}
        </div>
      </div>
    </div>,
    document.body
  );
}

// SendModal (React component, default export). Header generated from the file's exports by
// migrate-headers on 2026-10-27; replace with what it does.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import api from '../../utils/api';
import { channelResultLine, relayBodyLength, relayBodyProblem } from './sendResult';

// Shared compose-and-confirm modal for the comms registry (spec 4.3). It runs
// its own two-step flow: POST /comms/preview to load the recipient, channels,
// and prefilled message, then POST /comms/send with only the channels the admin
// keeps checked. The server does nothing until send, so a Cancel never touches
// the client record. All requests go through the shared api instance.
//
// A Thumbtack relay client's Text row comes back via 'thumbtack' (spec
// docs/superpowers/specs/2026-10-17-tt-proposal-link-via-gv-design.md, plan
// Task 11): the text becomes a GV post into the client's Thumbtack thread, so
// the row reads "Text via Thumbtack (GV)", counts to its max_chars (320), shows
// the number's last 4, and blocks Send with the server's own words when the
// body would be refused (relayBodyProblem). The send can answer sms 'queued'.

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
            // The text's route rides with its outcome through an email-only Retry.
            if (k === 'sms') merged.sms_route = prev.sms_route;
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

  const smsChannel = channels.sms || {};
  const viaThumbtack = smsChannel.via === 'thumbtack';
  const smsLimit = Number(smsChannel.max_chars) > 0 ? Number(smsChannel.max_chars) : SMS_LIMIT;
  const relayProblem = viaThumbtack && smsChecked
    ? relayBodyProblem(smsBody, preview && preview.sms && preview.sms.body, smsLimit)
    : null;

  const emailValid = !emailChecked || (emailSubject.trim() !== '' && emailBody.trim() !== '');
  // A relay text counts its trimmed length, as the server does; today's text
  // keeps its raw-length rule.
  const smsCount = viaThumbtack ? relayBodyLength(smsBody) : smsBody.length;
  const smsValid = !smsChecked || (smsBody.trim() !== '' && smsCount <= smsLimit && !relayProblem);
  const canSend = (emailChecked || smsChecked) && emailValid && smsValid && !inFlight;

  const recipient = (preview && preview.recipient) || {};
  const cta = preview && preview.email && preview.email.cta;

  const toLine = () => {
    let line = 'To:';
    if (recipient.name) line += ` ${recipient.name}`;
    if (recipient.email) line += ` <${recipient.email}>`;
    if (viaThumbtack && smsChannel.phone_last4) line += ` · ending ${smsChannel.phone_last4}`;
    else if (recipient.phone) line += ` · ${recipient.phone}`;
    return line;
  };

  const renderChannelResult = (key) => {
    if (!results || !submittedChannels.includes(key)) return null;
    const line = channelResultLine(key, results, channels);
    if (line.kind === 'sent' || line.kind === 'queued') {
      return (
        <p className="send-modal-result-line send-modal-result-sent">
          ✓ {line.text}
        </p>
      );
    }
    if (line.kind === 'failed') {
      return (
        <div className="send-modal-result-line send-modal-result-failed">
          <span>{line.text}</span>
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
    return <p className="send-modal-result-line send-modal-result-skipped">{line.text}</p>;
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
        {renderChannelResult('email')}
        {renderChannelResult('sms')}
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
            <span>{viaThumbtack ? 'Text via Thumbtack (GV)' : 'Text message'}</span>
          </label>
          {smsAvail ? (
            <div className="send-modal-channel-body">
              <textarea
                className="send-modal-textarea"
                rows={4}
                value={smsBody}
                onChange={(e) => setSmsBody(e.target.value)}
              />
              <p className={`send-modal-counter${smsCount > smsLimit ? ' send-modal-counter-over' : ''}`}>
                {smsCount} / {smsLimit}
              </p>
              {relayProblem && <p className="send-modal-banner-error">{relayProblem}</p>}
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

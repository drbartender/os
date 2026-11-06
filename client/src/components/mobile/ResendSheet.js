// ResendSheet: the phone's Resend proposal, the server's drafted words sent read-only on the
// channels picked (spec 2026-08-13-mobile-admin section 3, Plan decisions of 2026-11-05; the edit sheet's notify idiom).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../utils/api';
import useSheetFocus from '../../hooks/useSheetFocus';
import { describeSendResult } from '../SendModal';
import { formatPhone } from '../../utils/formatPhone';
import { HOLD_NOTE, sheetRefusal } from '../../utils/proposalDetailView';
import { READ_TIMEOUT_MS } from '../../utils/editSheetView';
import { holdTaps } from '../../utils/tapGuard';

// The desktop SendModal's two steps on the comms action proposal_resend:
// POST /comms/preview for the recipient, the channels with the reason one is
// off, the warnings and the drafted email and text message; then POST
// /comms/send with the channels picked and the drafted words as drafted.
// Editing the words is desktop view. It reaches a real client.
//
// THE REMOTE STAFFING FEE comes first, as on the desktop (ProposalDetail.js
// 'resend-check'): a proposal not yet accepted asks GET
// /proposals/:id/remote-staffing-check as the sheet opens, and when the server
// says to prompt, the sheet sends nothing and hands the resend to desktop view,
// where the prompt lives. The fee is billed at proposal time or never, so a
// resend that skipped it would lose it for good once the client signs. Like
// the desktop's prompt, a check that fails does not hold the resend.
//
// BEFORE EACH SEND (the first and every Retry) the proposal is read fresh
// (api.get with the read timeout, never the stored copy), and nothing is sent
// when it went on legal hold, money landed on it, or it no longer offers
// Resend here (sheetRefusal); the page reads it again when the sheet closes,
// through onClose, or through onLateAnswer when Back unmounted it.
// ONE MESSAGE PER TAP: a ref holds the send, as useSheetWrites does, and the
// send is also held for the life of its request, by proposal, outside the
// sheet: Back can close the sheet while a send is out, and a sheet opened again
// on the same proposal then offers no Send while that request is out, nor once
// after it ended unseen, since its answer was lost with the closed sheet.
// THE ANSWER, per channel, in the desktop's words (describeSendResult). Retry
// sends again only a channel the server answered as failed, flagged retry as
// the desktop's is. A send that got no answer, or a server error, may have
// gone: it offers no Retry and no second Send, since another tap could reach
// the client twice. A refusal before anything went out (a 4xx) reads in the
// server's words, and Send stays.
export const PREVIEW_FAILED = "Couldn't load the message. Sending needs a connection.";
export const SEND_OFFLINE = 'No connection, nothing was sent.';
export const SEND_NO_ANSWER = 'No answer. It may have gone. Check the message log in desktop view before sending again.';
export const SEND_UNSURE = 'The server hit an error. It may have gone. Check the message log in desktop view before sending again.';
export const EARLIER_SEND = 'A send from an earlier tap is still out, or ended after its sheet closed. It may have gone. Check the message log in desktop view before sending again.';
export const FEE_FIRST = 'The remote staffing fee question comes first for this venue. Resend from desktop view.';
// Held after the sheet closes, as the edit sheet's arm does, so the second tap
// of a double tap lands on nothing beneath (utils/tapGuard.js); the scrim
// takes no tap for as long after the sheet opens.
const TAP_HOLD_MS = 500;
// Proposal ids with a send out, and those whose send ended after its sheet closed.
const SENDS_OUT = new Set();
const SENDS_UNSEEN = new Set();
// The desktop SendModal's words where they apply.
const NO_CHANNEL = 'Fix the client record first, then reopen this send.';
const LINK_ADDED = 'Link button added automatically';
const GENERIC = 'Something went wrong. Try again.';
const READ = { timeout: READ_TIMEOUT_MS };
// The fee check can wait on a venue's first geocode behind a queued lookup (8
// seconds each, one a second); the desktop's prompt waits with no limit.
const FEE_CHECK = { timeout: 30000 };
const CHANNELS = [['email', 'Email'], ['sms', 'Text message']];
const isTransport = (err) => !err || err.status === 0 || err.code === 'NETWORK_ERROR';
const refusalText = (err) => {
  if (err && err.code === 'LEGAL_HOLD') return HOLD_NOTE;
  const texts = Object.values((err && err.fieldErrors) || {}).filter((v) => typeof v === 'string' && v.trim());
  return texts.length ? texts.join(' ') : ((err && err.message) || GENERIC);
};

// One channel's answer in the desktop's words, and whether it failed.
function channelResult(results, ch) {
  const one = {
    [ch]: results[ch],
    [`${ch}_error`]: results[`${ch}_error`],
    skip_reasons: { [ch]: (results.skip_reasons || {})[ch] },
    recipient_email: results.recipient_email,
    // Written as the To line writes it.
    recipient_phone: results.recipient_phone ? (formatPhone(results.recipient_phone) || results.recipient_phone) : results.recipient_phone,
  };
  // A provider's error that ends in a period would otherwise end in two.
  const message = describeSendResult(one).message.replace(/\.\.$/, '.');
  return { message, failed: results[ch] === 'failed', sent: results[ch] === 'sent' };
}

// proposal: the proposal the page showed when the sheet opened.
// onClose({ moved }): the sheet closed; moved when it refused because the
// proposal changed, so the page reads it again.
// onLateAnswer(): Back unmounted the sheet after it refused, so the page reads
// the proposal again.
// onDesktop(): the resend belongs to desktop view (the fee question).
export default function ResendSheet({ proposal, onClose, onLateAnswer, onDesktop }) {
  const [phase, setPhase] = useState('loading');   // loading | failed | fee | ready | result
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState(null);
  const [picked, setPicked] = useState({ email: false, sms: false });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // An earlier sheet's send on this proposal is still out, or ended unseen.
  const [earlier] = useState(() => SENDS_OUT.has(proposal.id) || SENDS_UNSEEN.has(proposal.id));
  const [error, setError] = useState(earlier ? EARLIER_SEND : null);
  const [unsure, setUnsure] = useState(earlier);
  const [refused, setRefused] = useState(null);
  const [results, setResults] = useState(null);
  const [submitted, setSubmitted] = useState([]);
  const sheetRef = useRef(null);
  // told: onClose ran, so the page already knows; the unmount says nothing more.
  const told = useRef(false);
  const closers = useRef({});
  closers.current = { onClose: () => { if (!busyRef.current && onClose) { told.current = true; onClose({ moved: !!refused }); } } };
  useSheetFocus(sheetRef, closers);
  const mounted = useRef(false);
  const openedAt = useRef(Date.now());
  const refusedRef = useRef(false);
  refusedRef.current = !!refused;
  const lateAnswer = useRef(onLateAnswer);
  lateAnswer.current = onLateAnswer;
  // The earlier send's warning is said once. The hold after close waits one
  // tick, and the effect running again cancels it: StrictMode runs this
  // cleanup once right after mount in development, and that is not a close.
  const pendingHold = useRef(null);
  useEffect(() => {
    mounted.current = true;
    SENDS_UNSEEN.delete(proposal.id);
    clearTimeout(pendingHold.current);
    return () => {
      mounted.current = false;
      pendingHold.current = setTimeout(() => holdTaps(TAP_HOLD_MS), 0);
      // Back after a refusal: the proposal changed, so the page reads it again.
      if (refusedRef.current && !told.current && lateAnswer.current) lateAnswer.current();
    };
  }, [proposal.id]);
  // A failure or a refusal is said at the top of the body and brought into
  // view as it appears: on a short phone the drafted words fill the body, and
  // "it may have gone" below them would leave only Done in sight.
  const alertRef = useRef(null);
  useEffect(() => {
    const box = alertRef.current;
    if (!box) return;
    if (typeof box.scrollIntoView === 'function') box.scrollIntoView({ block: 'nearest' });
    box.focus({ preventScroll: true });
  }, [error, refused]);
  // The answer takes focus as it shows, so a screen reader reads it: Send,
  // which held focus, is gone from the footer by then.
  const resultRef = useRef(null);
  useEffect(() => {
    if (phase === 'result' && resultRef.current && !alertRef.current) resultRef.current.focus({ preventScroll: true });
  }, [phase, results]);

  useEffect(() => {
    let gone = false;
    setPhase('loading');
    // An accepted proposal skips the fee question, as on the desktop: it is
    // already signed. A check that fails holds nothing (the desktop's rule).
    const feeFirst = proposal.status === 'accepted'
      ? Promise.resolve(false)
      : api.get(`/proposals/${proposal.id}/remote-staffing-check`, FEE_CHECK)
        .then((r) => !!(r.data && r.data.should_prompt), () => false);
    Promise.all([api.post('/comms/preview', { action: 'proposal_resend', entity_id: proposal.id }, READ), feeFirst])
      .then(([res, fee]) => {
        if (gone) return;
        if (fee) { setPhase('fee'); return; }
        const data = res.data || {};
        const ch = data.channels || {};
        setPreview(data);
        setPicked({
          email: !!(ch.email && ch.email.available && ch.email.default),
          sms: !!(ch.sms && ch.sms.available && ch.sms.default),
        });
        setPhase('ready');
      })
      .catch(() => { if (!gone) setPhase('failed'); });
    return () => { gone = true; };
  }, [proposal.id, proposal.status, attempt]);

  // only: null for the first send (every channel picked), or the failed
  // channels a Retry sends again.
  const send = useCallback(async (only = null) => {
    if (busyRef.current || unsure || refused || !preview) return;
    // Another sheet on this proposal has a send out, or one ended after its
    // sheet closed (this sheet opened before either was known).
    if (SENDS_OUT.has(proposal.id) || SENDS_UNSEEN.has(proposal.id)) {
      SENDS_UNSEEN.delete(proposal.id);
      setUnsure(true);
      setError(EARLIER_SEND);
      return;
    }
    const retry = Array.isArray(only);
    const channels = CHANNELS.map(([ch]) => ch).filter((ch) => picked[ch] && (!retry || only.includes(ch)));
    if (channels.length === 0) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    // Held from the tap, the fresh read included: Back can close the sheet at
    // any point while it says Sending.
    SENDS_OUT.add(proposal.id);
    let posted = false;
    let refusedBeforeSending = false;
    try {
      let fresh;
      try {
        fresh = await api.get(`/proposals/${proposal.id}`, READ);
      } catch (err) {
        setError(isTransport(err) ? SEND_OFFLINE : refusalText(err));
        return;
      }
      if (fresh.staleAt) { setError(SEND_OFFLINE); return; }
      // Back closed the sheet during the read: the admin left, and nothing is sent.
      if (!mounted.current) return;
      const why = sheetRefusal('resend', fresh.data, proposal);
      if (why) { setRefused(why); return; }
      const body = { action: 'proposal_resend', entity_id: proposal.id, channels };
      if (retry) body.retry = true;
      if (channels.includes('email')) {
        body.email = { subject: (preview.email && preview.email.subject) || '', body_text: (preview.email && preview.email.bodyText) || '' };
      }
      if (channels.includes('sms')) body.sms = { body: (preview.sms && preview.sms.body) || '' };
      let res;
      posted = true;
      try {
        res = await api.post('/comms/send', body);
      } catch (err) {
        if (isTransport(err) || !(err.status >= 400 && err.status < 500)) {
          setUnsure(true);
          setError(isTransport(err) ? SEND_NO_ANSWER : SEND_UNSURE);
        } else {
          refusedBeforeSending = true;
          setError(refusalText(err));
        }
        return;
      }
      const next = res.data || {};
      // A Retry's answer replaces only the channels it sent.
      setResults((prev) => {
        if (!retry || !prev) return next;
        const merged = { ...prev };
        for (const ch of channels) {
          merged[ch] = next[ch];
          merged[`${ch}_error`] = next[`${ch}_error`];
          merged.skip_reasons = { ...(prev.skip_reasons || {}), [ch]: (next.skip_reasons || {})[ch] };
        }
        if (next.recipient_email !== undefined) merged.recipient_email = next.recipient_email;
        if (next.recipient_phone !== undefined) merged.recipient_phone = next.recipient_phone;
        return merged;
      });
      setSubmitted((prev) => (retry ? Array.from(new Set([...prev, ...channels])) : channels));
      setPhase('result');
    } finally {
      SENDS_OUT.delete(proposal.id);
      // Its sheet closed while it was out: the next sheet on this proposal is told once.
      if (posted && !refusedBeforeSending && !mounted.current) SENDS_UNSEEN.add(proposal.id);
      busyRef.current = false;
      setBusy(false);
    }
  }, [unsure, refused, preview, picked, proposal]);

  const channels = (preview && preview.channels) || {};
  const anyAvailable = CHANNELS.some(([ch]) => channels[ch] && channels[ch].available);
  const recipient = (preview && preview.recipient) || {};
  const warnings = (preview && Array.isArray(preview.warnings)) ? preview.warnings : [];
  const toLine = [
    recipient.name || 'the client',
    recipient.email ? `(${recipient.email})` : '',
    recipient.phone ? `· ${formatPhone(recipient.phone) || recipient.phone}` : '',
  ].filter(Boolean).join(' ');
  const canSend = phase === 'ready' && !busy && !unsure && !refused && (picked.email || picked.sms);
  const done = phase === 'result' || unsure || !!refused;

  return (
    <>
      <button type="button" className="m-sheet-scrim" aria-label="Close" tabIndex={-1}
        onClick={() => { if (Date.now() - openedAt.current >= TAP_HOLD_MS) closers.current.onClose(); }} />
      <div className="m-sheet" role="dialog" aria-modal="true" aria-label="Resend proposal" tabIndex={-1} ref={sheetRef}>
        <div className="m-sheet-handle" />
        <div className="m-sheet-head">
          <h2 className="m-sheet-title">Resend proposal{proposal.client_name ? <span className="m-sheet-kind"> · {proposal.client_name}</span> : null}</h2>
          <div className="m-sheet-mix">drafted words · editing is desktop view</div>
        </div>
        <div className={`m-sheet-body${busy ? ' m-sheet-busy' : ''}`}>
          {refused && (
            <div className="m-sheet-note" role="alert" tabIndex={-1} ref={alertRef}>
              <span className="m-sheet-note-dot" aria-hidden="true" />
              <span className="m-sheet-note-text">{refused}</span>
            </div>
          )}
          {error && !refused && (
            <div className="m-fail m-notify-fail" role="alert" tabIndex={-1} ref={alertRef}><span className="m-fail-msg">{error}</span></div>
          )}
          {phase === 'loading' && <div className="m-sheet-state">Loading the message</div>}
          {phase === 'fee' && (
            <div className="m-sheet-note" role="alert">
              <span className="m-sheet-note-dot" aria-hidden="true" />
              <span className="m-sheet-note-text">{FEE_FIRST}</span>
            </div>
          )}
          {phase === 'failed' && (
            <div className="m-fail m-notify-fail" role="alert">
              <span className="m-fail-msg">{PREVIEW_FAILED}</span>
              <button type="button" className="m-fail-retry" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
            </div>
          )}
          {phase === 'ready' && (
            <div className="m-notify">
              <div className="m-notify-reasons">{`To: ${toLine}`}</div>
              {warnings.map((w) => <div key={w} className="m-notify-warn">{w}</div>)}
              <div className="m-notify-channels">
                {CHANNELS.map(([ch, label]) => {
                  const c = channels[ch];
                  if (c && c.available) {
                    return (
                      <label key={ch} className="m-notify-check">
                        <input type="checkbox" checked={picked[ch]} disabled={busy || unsure || !!refused}
                          onChange={() => setPicked((prev) => ({ ...prev, [ch]: !prev[ch] }))} />
                        <span>{label}</span>
                      </label>
                    );
                  }
                  return c && c.unavailable_reason
                    ? <span key={ch} className="m-notify-unavail">{`${label} unavailable: ${c.unavailable_reason}`}</span>
                    : null;
                })}
              </div>
              {!anyAvailable && <div className="m-notify-fixed">{NO_CHANNEL}</div>}
              {picked.email && preview.email && (
                <>
                  <div className="m-notify-msg">
                    <div className="m-notify-subject">{preview.email.subject}</div>
                    <div className="m-notify-body">{preview.email.bodyText}</div>
                  </div>
                  <div className="m-notify-fixed">{LINK_ADDED}</div>
                </>
              )}
              {picked.sms && preview.sms && (
                <div className="m-notify-msg"><div className="m-notify-body">{preview.sms.body}</div></div>
              )}
            </div>
          )}
          {phase === 'result' && results && (
            <div className="m-notify" role="status" tabIndex={-1} ref={resultRef}>
              {submitted.map((ch) => {
                const r = channelResult(results, ch);
                if (r.failed) {
                  return (
                    <div key={ch} className="m-fail m-notify-fail" role="alert">
                      <span className="m-fail-msg">{r.message}</span>
                      {!unsure && !refused && (
                        <button type="button" className="m-fail-retry" disabled={busy} onClick={() => send([ch])}>Retry</button>
                      )}
                    </div>
                  );
                }
                return <div key={ch} className={`m-send-line${r.sent ? ' m-send-sent' : ''}`}>{r.message}</div>;
              })}
            </div>
          )}
        </div>
        <div className="m-acts m-edit-acts">
          {phase === 'fee' && !done ? (
            <>
              <button type="button" className="m-act m-act-quiet" onClick={() => closers.current.onClose()}>Cancel</button>
              <button type="button" className="m-act m-act-primary" onClick={() => { if (onDesktop) onDesktop(); }}>Desktop view</button>
            </>
          ) : done ? (
            <button type="button" className="m-act m-act-primary" disabled={busy} onClick={() => closers.current.onClose()}>Done</button>
          ) : (
            <>
              <button type="button" className="m-act m-act-quiet" disabled={busy} onClick={() => closers.current.onClose()}>Cancel</button>
              <button type="button" className="m-act m-act-primary" disabled={!canSend} onClick={() => send()}>{busy ? 'Sending' : 'Send'}</button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

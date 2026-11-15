// MenuProofPage: the client's menu proof at /menu-proof/:token (spec 2026-10-19 section 12), where the client
// says Looks great or asks for changes once; public and token-gated, no client name, contact, event date or amounts.
//
// It reads GET /api/menu-proof/:token ({ state, answer, answer_note, answered_at,
// image, emailed, event_passed }) and shows the proof from GET
// /api/menu-proof/:token/image only while image is true (an answered proof
// past its link's life keeps its Thanks lines with the picture off). States:
// loading, open (Looks great, Request changes with a 1,000 character note and
// a live counter), approved, changes (the note read-only above the proof),
// superseded, expired, withdrawn, a failed load with Try again, and the
// .public-error shell for a 404. While an answer posts every button is
// disabled and the pressed one reads Sending...; a refused answer (409
// MENU_PROOF_*) refetches and shows the state the server reports, and one
// whose refetch reads open again keeps the form with the retry alert; a 429
// (the answer limiter) says to try later, since a plain retry would be refused
// again; any other failure shows the inline alert. A press that swaps the
// screen (an answer, a refusal that lands on another screen, a not-found)
// moves focus to the new heading, so a screen reader announces it.
// The wording follows two GET booleans (lane menu-approve-send): a proof that
// was never emailed (emailed false: no address, a blocked or skipped send)
// says "get in touch with us" wherever an emailed one says "reply to our
// email" or "check your email"; and once the event day has passed (event_passed) the expired screen
// stops offering a fresh link, since Approve refuses one then. A body without
// emailed reads as emailed.
// A token that is not a UUID is the not-found shell with no request sent: the
// token goes into the request path. The note is plain React text, never HTML.
// Benchmark: docs/design-artifacts/2026-11-03-menu-proof/menu-proof-page.html.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import api, { API_BASE_URL } from '../../utils/api';
import '../../styles/drb-tokens.css';
import './MenuProofPage.css';

const NOTE_MAX = 1000;
const KICKER = 'DR. BARTENDER';
// A link token, the server's rule (server/utils/tokens.js UUID_RE).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Each line that points the client somewhere, as [emailed, never emailed]:
// a link the admin sent by hand never says "reply to our email" (carried item g).
const LINES = {
  later: ['Please try again in an hour, or reply to our email.', 'Please try again in an hour, or get in touch with us.'],
  questions: ['If you have questions, just reply to our email.', 'If you have questions, just get in touch with us.'],
  fresh: ["Reply to our email and we'll send a fresh one.", "Get in touch with us and we'll send a fresh one."],
  latest: ['Check your email for the latest link.', 'Get in touch with us for the latest link.'],
  changes: [
    "We'll make the changes and send you a fresh look. Reply to our email if you think of anything else.",
    "We'll make the changes and send you a fresh look. Get in touch with us if you think of anything else.",
  ],
  missing: [
    "We couldn't load the menu picture. Reply to our email and we'll send it again.",
    "We couldn't load the menu picture. Get in touch with us and we'll send it again.",
  ],
};
const RETRY = "That didn't go through. Please try again.";

// The closed states: a heading and one line (a LINES key, or the line itself),
// no picture and no buttons. Past the event day an expired link offers no
// fresh one (carried item d).
const CLOSED = {
  superseded: ['A newer version was sent.', 'latest'],
  expired: ['This link has expired.', 'fresh'],
  withdrawn: ['This menu is no longer open for review.', 'questions'],
};

// The day the client answered, as the business reads it (America/Chicago), e.g. "November 3".
function answeredDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/Chicago' });
}

function Sheet({ heading, headingRef, busy, children }) {
  return (
    <main className="menu-proof-page" aria-busy={busy ? 'true' : undefined}>
      <div className="menu-proof-sheet">
        <p className="menu-proof-kicker">{KICKER}</p>
        <h1 className="menu-proof-heading" ref={headingRef} tabIndex={-1}>{heading}</h1>
        {children}
      </div>
    </main>
  );
}

function Proof({ src, small, onMissing, missing, missingLine }) {
  if (missing) {
    return <p className="menu-proof-line menu-proof-missing">{missingLine}</p>;
  }
  return (
    <a className={`menu-proof-picture${small ? ' is-small' : ''}`} href={src} target="_blank" rel="noopener noreferrer">
      <img src={src} alt="Your bar menu" onError={onMissing} />
    </a>
  );
}

export default function MenuProofPage() {
  const { token } = useParams();
  // Only a UUID ever reaches a request path; anything else is the not-found shell.
  const linkToken = typeof token === 'string' && UUID_RE.test(token) ? token : null;
  const [phase, setPhase] = useState('loading');
  const [data, setData] = useState(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(null);
  const [postFailed, setPostFailed] = useState(null);
  const [imageMissing, setImageMissing] = useState(false);
  // Counts the presses that swapped the screen (an answer, a refusal that
  // lands on another screen, a not-found): each moves focus to the new heading.
  const [swapped, setSwapped] = useState(0);
  const headingRef = useRef(null);

  const load = useCallback(async ({ quiet = false } = {}) => {
    // Resolves to the screen it shows: the proof's state, or notfound or failed.
    if (!linkToken) { setPhase('notfound'); return 'notfound'; }
    if (!quiet) setPhase('loading');
    try {
      const res = await api.get(`/menu-proof/${encodeURIComponent(linkToken)}`);
      setData(res.data);
      setPhase('ready');
      return res.data ? res.data.state : 'failed';
    } catch (err) {
      const shown = err && err.status === 404 ? 'notfound' : 'failed';
      setPhase(shown);
      return shown;
    }
  }, [linkToken]);

  useEffect(() => { load(); }, [load]);

  // The pressed button is gone once another screen renders: focus that screen's
  // heading, so a screen reader announces where the press landed.
  useEffect(() => {
    if (swapped && headingRef.current) headingRef.current.focus();
  }, [swapped]);

  const imageSrc = `${API_BASE_URL}/menu-proof/${encodeURIComponent(linkToken || '')}/image`;
  const trimmed = note.trim();

  async function send(answer) {
    if (sending || !linkToken) return;
    const body = answer === 'changes' ? { answer, note: trimmed } : { answer };
    setSending(answer);
    setPostFailed(null);
    try {
      const res = await api.post(`/menu-proof/${encodeURIComponent(linkToken)}/answer`, body);
      // The wording facts stay the ones the GET gave: the answer moves neither.
      setData((prev) => ({
        ...prev,
        state: res.data.state,
        answer: res.data.state,
        answer_note: answer === 'changes' ? trimmed : null,
        answered_at: res.data.answered_at,
        image: true,
      }));
      setSwapped((n) => n + 1);
    } catch (err) {
      if (err && err.status === 409 && String(err.code || '').startsWith('MENU_PROOF_')) {
        // Still open (the proposal moved between two statements): the form
        // stays, so focus does too, and the press says it did not go through.
        const shown = await load({ quiet: true });
        if (shown === 'open') setPostFailed('retry');
        else setSwapped((n) => n + 1);
      } else if (err && err.status === 404) {
        setPhase('notfound');
        setSwapped((n) => n + 1);
      } else {
        // A 429 is a limiter: the same press would be refused again for a while.
        setPostFailed(err && err.status === 429 ? 'later' : 'retry');
      }
    } finally {
      setSending(null);
    }
  }

  if (phase === 'loading') {
    return (
      <Sheet heading="Your bar menu" headingRef={headingRef} busy>
        <p className="menu-proof-line menu-proof-quiet">Loading your menu...</p>
      </Sheet>
    );
  }

  if (phase === 'notfound') {
    return (
      <main className="menu-proof-page">
        <div className="public-error">
          <span className="public-error-eyebrow">{KICKER}</span>
          <h1 ref={headingRef} tabIndex={-1}>We couldn't find that menu.</h1>
          <div className="public-error-actions">
            <a href="mailto:contact@drbartender.com" className="menu-proof-btn is-primary">Email contact@drbartender.com</a>
          </div>
        </div>
      </main>
    );
  }

  if (phase === 'failed' || !data) {
    return (
      <Sheet heading="We couldn't load your menu right now." headingRef={headingRef}>
        <p className="menu-proof-line">Please try again in a few minutes.</p>
        <button type="button" className="menu-proof-btn is-primary" onClick={() => load()}>Try again</button>
      </Sheet>
    );
  }

  // A body without emailed (a server before the field) reads as emailed.
  const say = (key) => LINES[key][data.emailed === false ? 1 : 0];
  const proof = (small) => (
    <Proof src={imageSrc} small={small} missing={imageMissing} missingLine={say('missing')} onMissing={() => setImageMissing(true)} />
  );

  if (CLOSED[data.state]) {
    const [heading, line] = CLOSED[data.state];
    const key = data.state === 'expired' && data.event_passed === true ? 'questions' : line;
    return (
      <Sheet heading={heading} headingRef={headingRef}>
        <p className="menu-proof-line">{LINES[key] ? say(key) : line}</p>
      </Sheet>
    );
  }

  if (data.state === 'approved') {
    return (
      <Sheet heading="Thanks! We've got it." headingRef={headingRef}>
        <p className="menu-proof-line">
          You said this looks great on {answeredDay(data.answered_at)}. We'll get it printed for your event.
        </p>
        {data.image && proof(true)}
      </Sheet>
    );
  }

  if (data.state === 'changes') {
    return (
      <Sheet heading="Thanks! We've got your notes." headingRef={headingRef}>
        <p className="menu-proof-line">{say('changes')}</p>
        {data.answer_note && <blockquote className="menu-proof-note">{data.answer_note}</blockquote>}
        {data.image && proof(true)}
      </Sheet>
    );
  }

  return (
    <Sheet heading="Your bar menu" headingRef={headingRef}>
      {!asking && (
        <p className="menu-proof-line">Here's the menu we drafted for your event. Tap the menu to see it larger.</p>
      )}
      {data.image && proof(asking)}
      <div className="menu-proof-actions">
        <button
          type="button"
          className="menu-proof-btn is-primary"
          disabled={!!sending}
          onClick={() => send('approved')}
        >
          {sending === 'approved' ? 'Sending...' : 'Looks great'}
        </button>
        <button
          type="button"
          className={`menu-proof-btn is-secondary${asking ? ' is-pressed' : ''}`}
          disabled={!!sending}
          aria-expanded={asking ? 'true' : 'false'}
          aria-controls="menu-proof-changes"
          onClick={() => setAsking((open) => !open)}
        >
          Request changes
        </button>
        {asking && (
          <div className="menu-proof-changes" id="menu-proof-changes">
            <textarea
              className="menu-proof-textarea"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={NOTE_MAX}
              rows={4}
              placeholder="Tell us what you'd like changed"
              aria-label="Tell us what you'd like changed"
              disabled={!!sending}
            />
            <p className="menu-proof-count" aria-live="polite">{note.length} / {NOTE_MAX}</p>
            <button
              type="button"
              className="menu-proof-btn is-primary"
              disabled={!!sending || !trimmed}
              onClick={() => send('changes')}
            >
              {sending === 'changes' ? 'Sending...' : 'Send changes'}
            </button>
          </div>
        )}
        {postFailed && (
          <p className="menu-proof-alert" role="alert">{postFailed === 'later' ? say('later') : RETRY}</p>
        )}
      </div>
      <p className="menu-proof-small">Replying here doesn't change your booking. We'll take it from here.</p>
    </Sheet>
  );
}

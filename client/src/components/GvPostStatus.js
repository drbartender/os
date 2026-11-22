// GvPostStatus: the proposal page's "Thumbtack message" row, what became of the proposal's
// latest Google Voice post into the client's Thumbtack thread (spec 2026-10-17-tt-proposal-link-via-gv, plan Task 10).

import React, { useEffect, useRef, useState } from 'react';
import api from '../utils/api';

// The row reads GET /api/proposals/:id's gv_post as it loads (initial) and
// re-syncs whenever the page hands it a new one. While the post is on its way
// (queued, sending, sent, or sent but not seen in the thread yet), or its
// toll-free fallback is (fallback_pending, read only until the text went, was
// suppressed or failed, the last telling the team to paste), it polls its
// OWN endpoint, GET /proposals/:id/gv-post, every 15 seconds for at most 10
// minutes, and never reloads the page (ProposalDetail's loadProposal resets
// the notes). refreshKey: bumped by the page after a SendModal send, so a
// resend's new post shows. No post: renders nothing.

const POLL_MS = 15 * 1000;
const POLL_MAX_MS = 10 * 60 * 1000;
const IN_FLIGHT = new Set(['queued', 'sending', 'sent', 'sent_not_seen', 'fallback_pending']);

// The row's reason (or, when it carries none, its status) in plain words.
const REASONS = {
  stale: "the sender didn't pick it up in time",
  session_expired: 'GV is signed out',
  challenge: 'Google asked for a check',
  cap: 'daily cap reached',
  spacing: 'another post went to this number minutes ago',
  identity_mismatch: "the Thumbtack lead didn't match",
  // A toll-free text whose claim was cut off, or that was never claimed in time.
  interrupted: 'the server restarted mid-send',
  recheck_error: 'the server could not re-check the post',
};

export function reasonLabel(post) {
  const key = (post && (post.reason || post.status)) || '';
  return REASONS[key] || 'the sender hit a problem';
}

const chicagoTime = (at) => new Date(at).toLocaleTimeString('en-US', {
  hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
});

export function gvPostCopy(post) {
  if (!post) return '';
  let copy;
  switch (post.display) {
    case 'queued': copy = 'Queued for Thumbtack'; break;
    case 'sending': copy = 'Sending through Google Voice'; break;
    case 'sent': copy = 'Sent from GV'; break;
    case 'in_thread': copy = post.in_thread_at
      ? `In the Thumbtack thread (${chicagoTime(post.in_thread_at)})`
      : 'In the Thumbtack thread'; break;
    case 'sent_not_seen': copy = 'Sent from GV, not in the Thumbtack thread yet'; break;
    case 'skipped_already_posted': copy = 'Skipped: the link was already in the thread'; break;
    case 'fallback_pending': copy = "Didn't go out: sending the toll-free text instead"; break;
    case 'fallback': copy = `Didn't go out: the toll-free text went instead (${reasonLabel(post)})`; break;
    case 'fallback_suppressed': copy = "Didn't go out, and no text was sent (client can't be texted)"; break;
    case 'fallback_failed': copy = `Didn't go out, and the toll-free text failed too (${reasonLabel(post)})`; break;
    case 'cancelled': copy = 'Cancelled: the proposal or client is no longer textable'; break;
    // check_thread, and any display newer than this code: a human looks first.
    default: copy = "Clicked Send but couldn't confirm: check the thread before pasting";
  }
  return post.hand_pasted ? `${copy} (a hand-pasted link is in the thread)` : copy;
}

export default function GvPostStatus({ proposalId, initial, refreshKey }) {
  const [post, setPost] = useState(initial || null);
  // When the current polling run began; a refetch or a new initial restarts it.
  const pollStart = useRef(Date.now());

  useEffect(() => {
    setPost(initial || null);
    pollStart.current = Date.now();
  }, [initial]);

  // A send from this page: read the latest post once (a resend's new row).
  useEffect(() => {
    if (!refreshKey) return undefined;
    let gone = false;
    api.get(`/proposals/${proposalId}/gv-post`)
      .then((res) => {
        if (gone) return;
        setPost((res.data && res.data.gv_post) || null);
        pollStart.current = Date.now();
      })
      .catch(() => { /* the row keeps what it showed */ });
    return () => { gone = true; };
  }, [proposalId, refreshKey]);

  const display = post && post.display;
  useEffect(() => {
    if (!IN_FLIGHT.has(display)) return undefined;
    if (Date.now() - pollStart.current >= POLL_MAX_MS) return undefined;
    let gone = false;
    const timer = setTimeout(() => {
      api.get(`/proposals/${proposalId}/gv-post`)
        .then((res) => { if (!gone) setPost((res.data && res.data.gv_post) || null); })
        // A failed poll keeps the row and tries once more on the next tick.
        .catch(() => { if (!gone) setPost((p) => (p ? { ...p } : p)); });
    }, POLL_MS);
    return () => { gone = true; clearTimeout(timer); };
  }, [proposalId, post, display]);

  if (!post) return null;
  return (
    <><dt>Thumbtack message</dt><dd className="muted">{gvPostCopy(post)}</dd></>
  );
}

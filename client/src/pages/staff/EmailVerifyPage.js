import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../../utils/api';
import { useAuth } from '../../context/AuthContext';

/**
 * EmailVerifyPage — staff portal v2 email-change confirmation landing
 * (spec §6.10).
 *
 * URL: /verify-email/:token
 *
 * This page is MOUNTED UNAUTHENTICATED (outside <RequirePortal>) and works
 * with no session at all — the user who clicks the link from their inbox may
 * be signed out, or signed in as a different account on the same browser. The
 * token's `user_id` is the authoritative subject on the server side; this page
 * sends ONLY the token in the POST body.
 *
 * Critical security properties:
 *   1. The GET landing does NOT auto-consume the token. Email clients (Gmail
 *      preview, Outlook Safe Links, etc.) prefetch URLs in inbox previews —
 *      auto-confirming on render would let a prefetch silently flip the
 *      victim's email. Only a deliberate Confirm-button click POSTs the
 *      token to /api/me/confirm-email-change.
 *   2. The page does NOT read or trust the local JWT to decide who to update.
 *      A signed-in attacker cannot redirect a victim's leaked token against
 *      their own account — the server looks up the row by token_hash and
 *      pulls user_id from THERE.
 *   3. On a SUCCESSFUL confirm the server bumps users.token_version, which
 *      invalidates every existing JWT for that user. If a local session
 *      exists, we call useAuth().logout() so the in-tab state matches what
 *      the server already did, and the user is sent to /login to re-auth
 *      with the new address.
 *   4. The 410 invalid/expired/already-used path renders a friendly clean
 *      message — no stack trace, no token echo, no hint as to which of the
 *      three failure modes hit.
 */

const ERR_INVALID = 'This verification link has expired or was already used.';
const ERR_NETWORK = 'Could not reach the server. Please try again in a moment.';

// Phase states. We DO NOT auto-start in 'confirming' — the GET landing must
// not consume the token. `idle` is the initial state until the user clicks.
const PHASE = {
  idle:       'idle',
  confirming: 'confirming',
  success:    'success',
  invalid:    'invalid', // 410 from server — expired / used / unknown
  error:      'error',   // network / unexpected — retryable
};

export default function EmailVerifyPage() {
  const { token } = useParams();
  // useAuth must be safe to call when the page renders OUTSIDE the portal
  // gate. AuthContext is mounted at the App root in App.js (above all the
  // route blocks), so the hook is always defined; user is just null when no
  // session exists. We DO NOT read user — we only need .logout() and a
  // boolean "is there a session?" for the post-confirm path.
  const { user, logout } = useAuth() || {};

  const [phase, setPhase] = useState(PHASE.idle);
  const [errMsg, setErrMsg] = useState(null);

  const tokenLooksOk = typeof token === 'string' && token.length > 0 && token.length <= 512;

  async function handleConfirm() {
    if (phase === PHASE.confirming || phase === PHASE.success) return;
    if (!tokenLooksOk) {
      setPhase(PHASE.invalid);
      setErrMsg(ERR_INVALID);
      return;
    }

    setPhase(PHASE.confirming);
    setErrMsg(null);

    try {
      // The route is auth-OPTIONAL on the server (no `auth` middleware at
      // all). Sending the Authorization header is harmless — server ignores
      // it on this endpoint by design — so we don't bother stripping it.
      await api.post('/me/confirm-email-change', { token });

      // Server bumped users.token_version. If a session exists in THIS tab
      // it's now invalid; clearing it stops a stale-JWT 401 storm on the
      // next navigation. If there is NO session, logout is a no-op.
      if (user && typeof logout === 'function') {
        try { logout(); } catch (_) { /* swallow — display the success anyway */ }
      }
      setPhase(PHASE.success);
    } catch (err) {
      // 410 — server's "invalid_or_expired" response. Render the clean
      // "expired or used" path; the server intentionally collapses
      // unknown / expired / consumed into one reason so we don't enumerate.
      if (err?.status === 410) {
        setPhase(PHASE.invalid);
        setErrMsg(ERR_INVALID);
        return;
      }
      // Network failure (api.js sets status: 0).
      if (err?.status === 0 || err?.code === 'NETWORK_ERROR') {
        setPhase(PHASE.error);
        setErrMsg(ERR_NETWORK);
        return;
      }
      // Anything else (rate limit 429, 500). Retryable.
      setPhase(PHASE.error);
      setErrMsg(err?.message || ERR_NETWORK);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <div className="sp-verify-shell">
      <div className="sp-verify-card">
        <div className="sp-verify-brand">Dr. Bartender</div>

        {phase === PHASE.success ? (
          <>
            <SuccessIcon />
            <h1 className="sp-verify-title">Email updated.</h1>
            <p className="sp-verify-sub">
              Your sign-in email has been changed. Sign in again with your new
              address to continue.
            </p>
            <div className="sp-verify-acts">
              <Link to="/login" className="sp-btn sp-btn-block sp-btn-primary">
                Go to sign in
              </Link>
            </div>
          </>
        ) : phase === PHASE.invalid ? (
          <>
            <WarnIcon />
            <h1 className="sp-verify-title">Link no longer valid</h1>
            <p className="sp-verify-sub">{errMsg || ERR_INVALID}</p>
            <p className="sp-verify-sub-small">
              If you still want to change your email, start the request again
              from your Profile.
            </p>
            <div className="sp-verify-acts">
              <Link to="/login" className="sp-btn sp-btn-block">
                Go to sign in
              </Link>
            </div>
          </>
        ) : phase === PHASE.confirming ? (
          <>
            <Spinner />
            <h1 className="sp-verify-title">Confirming…</h1>
            <p className="sp-verify-sub">One moment while we update your email.</p>
          </>
        ) : phase === PHASE.error ? (
          <>
            <WarnIcon />
            <h1 className="sp-verify-title">Something went wrong</h1>
            <p className="sp-verify-sub">{errMsg || ERR_NETWORK}</p>
            <div className="sp-verify-acts">
              <button
                type="button"
                className="sp-btn sp-btn-block sp-btn-primary"
                onClick={handleConfirm}
              >
                Try again
              </button>
              <Link to="/login" className="sp-btn sp-btn-block">
                Cancel
              </Link>
            </div>
          </>
        ) : (
          <>
            <MailIcon />
            <h1 className="sp-verify-title">Confirm email change</h1>
            <p className="sp-verify-sub">
              Tap Confirm to switch your Dr. Bartender sign-in email to the
              address that received this link.
            </p>
            <p className="sp-verify-sub-small">
              You’ll need to sign in again afterwards, all active sessions are
              signed out as part of the change.
            </p>
            <div className="sp-verify-acts">
              <button
                type="button"
                className="sp-btn sp-btn-block sp-btn-primary"
                onClick={handleConfirm}
                disabled={!tokenLooksOk}
              >
                Confirm email change
              </button>
              <Link to="/login" className="sp-btn sp-btn-block">
                Not now
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Inline icons + spinner ───────────────────────────────────────────────

function Spinner() {
  return (
    <div
      className="sp-verify-icon"
      aria-hidden="true"
      style={{
        width: 44, height: 44,
        borderRadius: '50%',
        border: '3px solid var(--sp-line-2, #ccc)',
        borderTopColor: 'var(--sp-accent, #2e7d6f)',
        animation: 'sp-spin 0.8s linear infinite',
      }}
    />
  );
}

function MailIcon() {
  return (
    <div className="sp-verify-icon" aria-hidden="true">
      <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <polyline points="3 7 12 13 21 7" />
      </svg>
    </div>
  );
}

function SuccessIcon() {
  return (
    <div className="sp-verify-icon success" aria-hidden="true">
      <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </div>
  );
}

function WarnIcon() {
  return (
    <div className="sp-verify-icon warn" aria-hidden="true">
      <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 9v4M12 17h.01" />
        <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      </svg>
    </div>
  );
}

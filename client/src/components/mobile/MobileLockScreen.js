import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { unlockWithPasskey } from '../../utils/webauthnClient';
import {
  clearLastActive, isRevocationCode, phoneUnlockArmed, readLastActive,
  setMobileLockHandler, shouldLock, touchLastActive,
} from '../../utils/mobileLock';

// Full-screen lock (mobile-admin spec 2026-08-13 section 8): fully occludes
// content, one tap asserts and re-enters. Two mounts:
//   gate mode (ProtectedRoute, no live user): always locked; a successful
//     unlock calls login() and the guarded children render, URL untouched,
//     which is what keeps section 9's "unlock lands exactly where you were".
//   overlay mode (AdminLayout, live session): arms the 30-minute background
//     timer, re-checks on foreground, and claims phone 401s from
//     SessionExpiryHandler via the mobileLock handler registry.
export default function MobileLockScreen({ gate = false }) {
  const { login, logout } = useAuth();
  const navigate = useNavigate();
  const [locked, setLocked] = useState(() => gate || shouldLock({
    token: window.localStorage.getItem('token'),
    lastActiveAt: readLastActive(),
    armed: phoneUnlockArmed(),
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Overlay: claim phone-surface 401s while armed. Desktop and passkey-less
  // phones decline, so SessionExpiryHandler keeps its logout path there.
  useEffect(() => {
    if (gate) return undefined;
    return setMobileLockHandler((code) => {
      // A revoked session must die, not hide: declining here sends the event
      // to SessionExpiryHandler's logout path, which purges the caches and
      // the token (spec section 8; external review, 2026-08-14).
      if (isRevocationCode(code)) return false;
      if (!phoneUnlockArmed()) return false;
      setLocked(true);
      return true;
    });
  }, [gate]);

  // Overlay: stamp on background, re-evaluate on foreground.
  useEffect(() => {
    if (gate) return undefined;
    const stamp = () => touchLastActive();
    const due = () => shouldLock({
      token: window.localStorage.getItem('token'),
      lastActiveAt: readLastActive(),
      armed: phoneUnlockArmed(),
    });
    // The clock measures BACKGROUNDED time. A stamp that is not due right now
    // is spent: clearing it stops a later re-evaluation (a rotate after 30
    // minutes of continuous use) from reading it as inactivity and locking an
    // app that never went to background (external review, 2026-08-14).
    const evaluate = () => {
      if (due()) setLocked(true);
      else clearLastActive();
    };
    evaluate();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stamp();
      else evaluate();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', stamp);
    // A width flip back into arming range must re-assert a due lock: the
    // manifest pins portrait for the installed PWA, but a browser tab can
    // rotate through landscape (armed=false there) and back (lane fleet,
    // 2026-08-14).
    window.addEventListener('resize', evaluate);
    window.addEventListener('orientationchange', evaluate);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', stamp);
      window.removeEventListener('resize', evaluate);
      window.removeEventListener('orientationchange', evaluate);
    };
  }, [gate]);

  // Gate mode renders OUTSIDE AdminLayout, so the admin token scope is not
  // set yet; claim it so the .m-lock tokens resolve. AdminLayout re-claims
  // it the moment the unlock succeeds and the children mount. Layout effect:
  // a plain effect runs after first paint and shows one unstyled frame.
  useLayoutEffect(() => {
    if (!gate) return undefined;
    const root = document.documentElement;
    const prev = root.getAttribute('data-app');
    root.setAttribute('data-app', 'admin-os');
    return () => {
      if (prev) root.setAttribute('data-app', prev);
      else root.removeAttribute('data-app');
    };
  }, [gate]);

  // No scrolling the occluded content under the lock.
  useEffect(() => {
    if (!locked) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [locked]);

  const onUnlock = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const { token, user } = await unlockWithPasskey();
      login(token, user);
      clearLastActive(); // back in the foreground: the background clock stops
      setLocked(false);
    } catch (err) {
      if (err?.status === 0) setError('You are offline. Unlocking needs a connection.');
      else if (typeof err?.status === 'number') setError(err.message || 'Unlock failed. Try again or use your password.');
      else setError('Unlock was cancelled or failed. Try again or use your password.');
    } finally {
      setBusy(false);
    }
  }, [login]);

  const onPassword = useCallback(() => {
    // Full re-auth: logout purges the phone caches by design (spec section 7).
    logout();
    navigate('/login', { replace: true });
  }, [logout, navigate]);

  if (!locked) return null;
  return (
    <div className="m-lock" role="dialog" aria-modal="true" aria-label="Locked">
      <div className="m-lock-brand" aria-hidden="true">&#8478;</div>
      <h1 className="m-lock-title">Locked</h1>
      <p className="m-lock-sub">Unlock to pick up where you left off.</p>
      <button type="button" className="m-lock-unlock" onClick={onUnlock} disabled={busy}>
        {busy ? 'Unlocking...' : 'Unlock'}
      </button>
      {error ? <p className="m-lock-error" role="alert">{error}</p> : null}
      <button type="button" className="m-lock-password" onClick={onPassword} disabled={busy}>
        Use password instead
      </button>
    </div>
  );
}

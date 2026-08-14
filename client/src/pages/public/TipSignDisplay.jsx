import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../../utils/api';
import './TipSignDisplay.css';

import PhoneSignLayout from '../staff/tipCard/PhoneSignLayout';
import { buildTipCardMarks } from '../../utils/tipCardMarks';
import { useWakeLock } from '../../hooks/useWakeLock';

const IDLE_FADE_MS = 4000;

/**
 * TipSignDisplay — the bartender's tip sign, full screen on a propped-up phone
 * or tablet, at /tip/:token/display.
 *
 * PUBLIC on purpose. This is the same token-gated surface a guest reaches by
 * scanning, so it needs no login: a portal session would expire mid-shift and
 * drop the bar to a login screen, and a venue's tablet is hardware the
 * bartender does not own and should not sign into.
 *
 * Fetches `?view=sign`, which returns display_name, url, and methods and NO
 * payment handles. The full chooser payload carries the bartender's Zelle
 * handle, which resolves to a personal phone number or email, and this page
 * sits unattended on a bar for a whole shift.
 *
 * Fetches ONCE and never polls: that endpoint shares a per-IP rate-limit
 * budget with every guest scanning the QR at the same venue, and the guests
 * are the money path.
 */
export default function TipSignDisplay() {
  const { token } = useParams();

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [armed, setArmed] = useState(false);
  const [idle, setIdle] = useState(false);

  const containerRef = useRef(null);
  const idleTimerRef = useRef(null);

  const { supported: wakeSupported } = useWakeLock(armed);

  useEffect(() => {
    let cancelled = false;
    // Bounded retry, NOT polling. The no-polling rule above is about steady
    // state; a single transient blip at load would otherwise leave an error on
    // a screen nobody is watching for the rest of the shift. A 404 is a
    // definitive answer, so it never retries.
    const load = (attempt) => api.get(`/public/tip/${token}?view=sign`)
      .then((r) => { if (!cancelled) setData(r.data); })
      .catch((e) => {
        if (cancelled) return;
        if (e?.status !== 404 && attempt < 2) {
          setTimeout(() => { if (!cancelled) load(attempt + 1); }, 1500 * (attempt + 1));
          return;
        }
        // The api.js interceptor rejects a FLAT { message, code, status },
        // not an axios error, so this reads e.status and not e.response.status.
        // 404 is the deliberate shape for both "no such token" and "page
        // deactivated" (publicTip.js keeps them identical to prevent token
        // enumeration), so this copy has to cover both.
        setError(e?.status === 404
          ? 'This tip page isn’t active.'
          : 'Could not load this tip page.');
      });
    load(0);
    return () => { cancelled = true; };
  }, [token]);

  const markIdle = useCallback(() => {
    setIdle(false);
    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setIdle(true), IDLE_FADE_MS);
  }, []);

  useEffect(() => () => clearTimeout(idleTimerRef.current), []);

  // Escape (and any other exit from fullscreen) is browser-driven, not a
  // click, so un-arm on fullscreenchange. Otherwise the tap hint never comes
  // back and the bartender cannot re-enter.
  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement) setArmed(false);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const arm = useCallback(() => {
    if (armed) { markIdle(); return; }
    setArmed(true);
    markIdle();
    // Must be called inside the gesture handler. Safari on iPhone has no
    // element Fullscreen API at any version, and iPads that only expose the
    // webkit-prefixed form predate iOS 16.4 and so lack Wake Lock too, meaning
    // they already see the auto-lock line. Either way the page fills the
    // viewport, so a rejection is a no-op rather than a failure.
    const el = containerRef.current;
    if (el && el.requestFullscreen) el.requestFullscreen().catch(() => {});
  }, [armed, markIdle]);

  // Un-arms in place; deliberately does NOT navigate to /tip/:token. That page
  // renders the bartender's Zelle handle, which normalizes to a personal phone
  // number or email, and this button is a live tap target on an unattended
  // tablet all night. Sending it there would defeat the whole reason this page
  // fetches the handle-free ?view=sign projection.
  const exit = useCallback((e) => {
    e.stopPropagation();
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
    setArmed(false);
  }, []);

  if (error) return <div className="tsd-msg">{error}</div>;
  if (!data) return <div className="tsd-msg">Loading&hellip;</div>;

  const marks = buildTipCardMarks(data.methods);

  return (
    <div
      className="tsd-root"
      ref={containerRef}
      onClick={arm}
      onPointerMove={armed ? markIdle : undefined}
    >
      <PhoneSignLayout
        name={data.display_name}
        tipUrl={data.url}
        marks={marks}
      />

      {!armed && (
        <div className="tsd-hint">
          Tap to go full screen and stay awake. Plug in for a long shift.
        </div>
      )}

      {armed && !wakeSupported && (
        <div className="tsd-hint tsd-hint-warn">
          This browser can&rsquo;t keep the screen awake. Set this device&rsquo;s
          auto-lock to Never.
        </div>
      )}

      {armed && (
        <button
          type="button"
          className={`tsd-exit${idle ? ' is-idle' : ''}`}
          onClick={exit}
          aria-label="Exit display mode"
        >
          Done
        </button>
      )}
    </div>
  );
}

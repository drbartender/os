// NotificationsPhone (React component, default export). Header generated from the file's exports by
// migrate-headers on 2026-10-27; replace with what it does.

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { offlineGet } from '../../utils/offlineRead';
import { formatStaleTime } from '../../utils/staleTime';
import { readDevicePushState, enableAdminPush, disableAdminPush } from '../../utils/adminPush';
import {
  KIND_GROUPS, kindOn, phoneState as derivePhoneState, phoneSub, testStatus, catsIntro,
  NOTE_BLOCKED, NOTE_SERVER_UNSET, FOOT_LINES, OFFLINE_BANNER,
} from '../../utils/notificationsView';
import { useMobileView } from '../../context/MobileViewContext';
import { useToast } from '../../context/ToastContext';
import Icon from '../../components/adminos/Icon';

// More > Notifications (spec 2026-08-13-mobile-admin section 7 and the
// 2026-10-14 design-session decisions). The phone switch is THIS device's real
// state (Android's permission, then the admin worker's subscription), read
// each time the screen opens; the seven kind switches are the account's and
// save at once. Offline, the last loaded settings render disabled under the
// banner with the staleness time. Phone only: desktop width, or the
// Desktop-view escape, lands on the desktop Settings page, where the
// category master switches live.

const KIND_PATH = '/me/notification-preferences';
// The benchmark draws the kind rows and the test row at 44px (the phone
// switch is 56px through .m-switch-row); .m-more-row alone is 48px.
const ROW_44 = { minHeight: 44 };

function Track() {
  return <span className="m-switch-track"><span className="m-switch-thumb" /></span>;
}

function Skeleton() {
  const groups = [[64, 52], [46, 40, 52, 44], [38, 48]];
  return (
    <div className="m-notif-skel" aria-hidden="true">
      {groups.map((rows, g) => (
        <section key={g}>
          <div className="m-notif-skel-bar heading" style={{ width: [70, 84, 60][g] }} />
          <ul className="m-more-list">
            {rows.map((w, i) => (
              <li key={i}>
                <div style={{ flex: 1 }}><div className="m-notif-skel-bar" style={{ width: `${w}%` }} /></div>
                <div className="m-notif-skel-pill" />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export default function NotificationsPhone() {
  const { isPhone, desktopView, setDesktopView } = useMobileView();
  const navigate = useNavigate();
  const toast = useToast();
  const [read, setRead] = useState({ status: 'loading', prefs: null, publicKey: null, staleAt: null });
  const [device, setDevice] = useState('off');
  // 'enable' while Android's prompt may be up, 'disable' while the
  // unsubscribe and its server DELETE run. Both are aria-busy; only the
  // enable says Android is asking.
  const [phoneBusy, setPhoneBusy] = useState(null);
  const [busy, setBusy] = useState({});      // kind -> true while its PATCH is in flight
  const [failed, setFailed] = useState({});  // kind -> true after a failed PATCH
  const [test, setTest] = useState('idle');  // idle | sending | sent | failed
  const sentTimer = useRef(null);
  // Ids for aria-describedby: the switches' names are their labels, so the
  // sub-line and a failed save's "Didn’t save" reach a screen reader as the
  // description. The test row is named by its label too, and its status
  // ("Sent", "Didn’t send") is its description and a polite live region.
  const uid = useId();
  const phoneSubId = `${uid}-phone-sub`;
  const testStatusId = `${uid}-test-status`;
  const failId = (kind) => `${uid}-${kind}-fail`;

  // The Desktop-view escape on this screen opens the desktop Settings page
  // (decision 3 of 2026-10-14): clear this screen's override so the next
  // visit renders the phone screen, and arm Settings' own.
  const escaped = desktopView('notifications');
  useEffect(() => {
    if (!escaped) return;
    setDesktopView('notifications', false);
    setDesktopView('settings', true);
    navigate('/settings', { replace: true });
  }, [escaped, setDesktopView, navigate]);

  // Both reads land in one render: the screen stays on its skeleton until the
  // device's state is known, so the phone switch never draws a placeholder
  // Off and then slides On under the thumb.
  const load = useCallback(async () => {
    setRead((r) => ({ ...r, status: 'loading' }));
    const [prefs, dev] = await Promise.allSettled([offlineGet(KIND_PATH), readDevicePushState()]);
    setDevice(dev.status === 'fulfilled' ? dev.value : 'off');
    if (prefs.status === 'fulfilled') {
      const res = prefs.value;
      const d = (res && res.data) || {};
      setRead({ status: 'ready', prefs: d.admin_push_preferences || {}, publicKey: (d.push && d.push.public_key) || null, staleAt: res.staleAt || null });
    } else {
      setRead((r) => ({ ...r, status: 'failed' }));
    }
  }, []);
  // No read at desktop width or on the escape: the screen is leaving for Settings.
  const leaving = !isPhone || escaped;
  useEffect(() => {
    if (leaving) return undefined;
    load();
    return () => clearTimeout(sentTimer.current);
  }, [load, leaving]);

  if (!isPhone) return <Navigate to="/settings" replace />;
  if (escaped) return null;

  const offline = Boolean(read.staleAt);
  const state = derivePhoneState({ device, publicKey: read.publicKey });
  const prompting = phoneBusy === 'enable';
  const phoneDisabled = offline || state === 'blocked' || state === 'server_unset' || state === 'unsupported' || Boolean(phoneBusy);
  const tStatus = testStatus({ offline, state, test });

  const onPhoneToggle = async () => {
    if (phoneDisabled) return;
    if (state === 'on') {
      setPhoneBusy('disable');
      await disableAdminPush();
      const after = await readDevicePushState();
      setPhoneBusy(null);
      setDevice(after);
      setTest('idle');
      // The re-read is the truth: still subscribed means the Off did not land.
      if (after === 'on') toast.error('Could not turn notifications off.');
      return;
    }
    setPhoneBusy('enable');
    const r = await enableAdminPush(read.publicKey);
    setPhoneBusy(null);
    if (r.ok) { setDevice('on'); return; }
    if (r.state === 'denied') { setDevice('blocked'); return; }
    setDevice(await readDevicePushState());
    toast.error(r.state === 'default' ? 'Android did not grant permission.' : 'Could not turn notifications on.');
  };

  const onTest = async () => {
    if (tStatus.disabled || test === 'sending') return;
    setTest('sending');
    try {
      const res = await api.post('/me/push-test');
      const ok = res && res.data && res.data.sent > 0;
      setTest(ok ? 'sent' : 'failed');
      if (ok) {
        clearTimeout(sentTimer.current);
        sentTimer.current = setTimeout(() => setTest('idle'), 2400);
      }
    } catch (e) {
      setTest('failed');
    }
  };

  const flip = async (kind) => {
    if (offline || busy[kind]) return;
    const next = !kindOn(read.prefs, kind);
    setRead((r) => ({ ...r, prefs: { ...r.prefs, [kind]: next } }));
    setBusy((b) => ({ ...b, [kind]: true }));
    setFailed((f) => ({ ...f, [kind]: false }));
    try {
      await api.patch(KIND_PATH, { admin_push_preferences: { [kind]: next } });
    } catch (e) {
      // Flip back THIS kind only: another kind flipped while this save was in
      // flight has its own save, and the server merges each in SQL.
      setRead((r) => ({ ...r, prefs: { ...r.prefs, [kind]: !next } }));
      setFailed((f) => ({ ...f, [kind]: true }));
    } finally {
      setBusy((b) => ({ ...b, [kind]: false }));
    }
  };

  return (
    <div className="m-more">
      {offline && (
        <div className="m-notif-banner" role="status">
          <span className="m-stale-dot" aria-hidden="true" />
          <div>
            <div className="m-notif-banner-title">{OFFLINE_BANNER.title}</div>
            <div className="m-notif-banner-body">
              {OFFLINE_BANNER.body} <span className="m-stale">as of <span className="m-stale-time">{formatStaleTime(read.staleAt)}</span></span>
            </div>
          </div>
        </div>
      )}
      {read.status === 'loading' && <Skeleton />}
      {read.status === 'failed' && (
        <ul className="m-more-list">
          <li className="m-notif-note m-notif-note-center">
            <Icon name="alert" size={16} />
            <span style={{ flex: 1 }} role="alert">Couldn’t load notification settings.</span>
            <button type="button" className="m-notif-retry" onClick={load} aria-label="Retry loading">Retry</button>
          </li>
        </ul>
      )}
      {read.status === 'ready' && (
        <>
          <section>
            <h2 className="m-more-heading">This phone</h2>
            <ul className="m-more-list">
              <li>
                <button
                  type="button" className="m-more-row m-switch-row" role="switch"
                  aria-checked={state === 'on'} aria-busy={phoneBusy ? true : undefined} disabled={phoneDisabled && !phoneBusy}
                  aria-label="Notifications on this phone" aria-describedby={phoneSubId} onClick={onPhoneToggle}
                >
                  <Icon name="bell" size={20} />
                  <span>
                    <span>Notifications on this phone</span>
                    <span className="m-more-sub" id={phoneSubId}>{phoneSub(state, prompting)}</span>
                  </span>
                  <Track />
                </button>
              </li>
              {state === 'blocked' && (
                <li className="m-notif-note"><Icon name="alert" size={16} /><span>{NOTE_BLOCKED}</span></li>
              )}
              {state === 'server_unset' && (
                <li className="m-notif-note"><Icon name="alert" size={16} /><span>{NOTE_SERVER_UNSET}</span></li>
              )}
              <li>
                {test === 'failed' && !tStatus.disabled ? (
                  <div className="m-more-row" style={{ ...ROW_44, cursor: 'default', paddingRight: 8 }}>
                    <Icon name="chat" size={20} />
                    <span>Send a test notification</span>
                    <span className="m-more-state danger" id={testStatusId} aria-live="polite">{tStatus.text}</span>
                    <button type="button" className="m-notif-retry" onClick={onTest} aria-label="Retry the test notification">Retry</button>
                  </div>
                ) : (
                  <button
                    type="button" className="m-more-row" onClick={onTest} disabled={tStatus.disabled}
                    aria-label="Send a test notification" aria-describedby={testStatusId}
                    style={tStatus.disabled ? { ...ROW_44, color: 'var(--ink-4)' } : ROW_44}
                  >
                    <Icon name="chat" size={20} />
                    <span>Send a test notification</span>
                    <span className={`m-more-state${tStatus.tone ? ` ${tStatus.tone}` : ''}`} id={testStatusId} aria-live="polite">{tStatus.text}</span>
                  </button>
                )}
              </li>
            </ul>
          </section>
          <section>
            <h2 className="m-more-heading">What buzzes</h2>
            <div className="m-notif-intro">{catsIntro(state)}</div>
            {KIND_GROUPS.map((g) => (
              <div className="m-notif-group" key={g.label}>
                <div className="m-notif-group-label">{g.label}</div>
                <div className="m-notif-group-help">{g.help}</div>
                <ul className="m-more-list">
                  {g.kinds.map(({ kind, label }) => (
                    <li key={kind} className={failed[kind] ? 'm-row-retry' : undefined}>
                      <button
                        type="button" className="m-more-row" role="switch" style={ROW_44}
                        aria-checked={kindOn(read.prefs, kind)} aria-busy={busy[kind] || undefined}
                        disabled={offline} aria-label={label} onClick={() => flip(kind)}
                        aria-describedby={failed[kind] ? failId(kind) : undefined}
                      >
                        <span>{label}</span>
                        {failed[kind] && <span className="m-more-state danger" id={failId(kind)} aria-live="polite">Didn’t save</span>}
                        <Track />
                      </button>
                      {/* Retry is a sibling of the switch, never inside it: interactive
                          content may not nest in a button (decision 9). */}
                      {failed[kind] && (
                        <button type="button" className="m-notif-retry" onClick={() => flip(kind)} aria-label={`Retry saving ${label}`}>Retry</button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
          <div className="m-notif-foot">
            {FOOT_LINES.map((line) => <div key={line}>{line}</div>)}
          </div>
        </>
      )}
    </div>
  );
}

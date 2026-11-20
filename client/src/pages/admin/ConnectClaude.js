// ConnectClaude: the Claude connector's consent page (spec 2026-11-19 section 7.2): the pending request, Allow with the passkey, Cancel.
//
// Claude's authorize step sends the browser here with only the pending
// request's id (/connect-claude?request=<uuid>). The page reads the request
// from the server, shows what Claude will read, when and from where the
// request started and whether approving replaces a connection, and on Allow
// asks for the admin's passkey and approves. The page sends the server
// nothing but the request id (in the path) and the passkey assertion: the
// approve route reads the pending row itself. The passkey prompt is the same
// @simplewebauthn/browser call the phone lock makes (utils/webauthnClient.js),
// on options from the connector's own assert-options, never the lock's
// assert-verify, which mints a session.
//
// Allow and Cancel share one in-flight guard (a ref, so a double click sends
// one call before React re-renders), and on success the browser leaves for
// the return address the server built. That address carries a single-use
// sign-in code, so it is never kept in state; the Sentry scrub redacts it
// from the navigation crumb (utils/sentryScrub.js).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { startAuthentication } from '@simplewebauthn/browser';
import api from '../../utils/api';
import { isPasskeySupported } from '../../utils/webauthnClient';
import { connectRequestId } from '../../utils/connectReturn';
import { chicagoTime, chicagoWeekdayDate } from '../../utils/chicagoDay';
import BrandLogo from '../../components/BrandLogo';
import '../../styles/drb-tokens.css';
import './ConnectClaude.css';

// The terminal states: no Allow, start again from Claude.
const GONE = {
  malformed: ['This sign-in link is not complete', 'The link is missing its request. Start again from Claude.'],
  missing: ['This sign-in request was not found', 'Start again from Claude.'],
  used: ['This sign-in request was already used', 'A request can be answered once. To connect again, start from Claude.'],
  cancelled: ['This sign-in request was cancelled', 'To connect, start again from Claude.'],
  expired: ['This sign-in request has expired', 'A request lasts 10 minutes. Start again from Claude.'],
};

const GONE_BY_CODE = {
  CONNECTOR_REQUEST_NOT_FOUND: 'missing',
  CONNECTOR_REQUEST_USED: 'used',
  CONNECTOR_REQUEST_CANCELLED: 'cancelled',
  CONNECTOR_REQUEST_EXPIRED: 'expired',
};

// A failed call that ends the request (the server's 404 and 410s), else null.
function goneReason(err) {
  if (!err) return null;
  if (GONE_BY_CODE[err.code]) return GONE_BY_CODE[err.code];
  if (err.status === 404) return 'missing';
  if (err.status === 410) return 'expired';
  return null;
}

// The Allow refusals, by the approve and assert-options routes' codes
// (server/routes/admin/connector.js). Each leaves Allow in place.
const NOTICES = {
  // Passkeys are enrolled only on the phone (MoreSecurityRow); Settings,
  // Security lists and revokes them but has no add control.
  CONNECTOR_PASSKEY_NONE: {
    text: 'Your admin account has no passkey yet. Passkeys are added on the phone: in the admin app, open More and choose Set up fingerprint unlock. Then choose Allow here again.',
  },
  CONNECTOR_PASSKEY_WRONG_ACCOUNT: {
    text: 'That passkey belongs to another account, likely your staff account. Choose the passkey for your admin account, then choose Allow again.',
  },
  CONNECTOR_PASSKEY_FAILED: { text: 'The passkey check did not pass. Choose Allow to try again.' },
  CONNECTOR_PASSKEY_EXPIRED: { text: 'The passkey prompt timed out. Choose Allow to try again.' },
  CONNECTOR_PASSKEY_REQUIRED: { text: 'A passkey check is needed to allow this. Choose Allow to try again.' },
};
const PROMPT_CLOSED = { text: 'The passkey prompt was closed, so nothing was approved. Choose Allow to try again.' };
const ALLOW_FAILED = { text: 'Something went wrong and nothing was approved. Try again.' };
// The approve call went out but no answer came back (or the server failed
// after it may have committed): the page cannot know whether it was approved.
const APPROVE_UNCONFIRMED = { text: 'Could not confirm whether this was approved. Reload this page to see where the request stands.' };
const CANCEL_FAILED = { text: 'Could not cancel the request. Try again.' };

// How often the page reads the request again once this device's clock says
// it has expired but the server last answered pending.
const RECHECK_MS = 15000;

function when(value) {
  const day = chicagoWeekdayDate(value);
  return day ? `${day}, ${chicagoTime(value)}` : '';
}

// The server builds the return address from its one fixed value; this only
// refuses something that is not a web address at all.
function leaveFor(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
  window.location.assign(url);
  return true;
}

export default function ConnectClaude() {
  const location = useLocation();
  const requestId = connectRequestId(location.search);
  const [phase, setPhase] = useState(requestId ? 'loading' : 'gone'); // loading | ready | gone | loadError | leaving
  const [gone, setGone] = useState(requestId ? null : 'malformed');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(null); // 'allow' | 'cancel' | null
  const [notice, setNotice] = useState(null);
  const busyRef = useRef(false);
  const supported = isPasskeySupported();

  const endWith = useCallback((reason) => { setGone(reason); setPhase('gone'); }, []);

  // The server decides when a request has ended; this device's clock only
  // schedules the re-read. At the local expires_at the page reads the request
  // again and ends it only on a non-pending answer (the server's 410). A
  // device clock running fast gets a pending answer, keeps Allow, and reads
  // again every RECHECK_MS while its clock says the time has passed. A call
  // in flight is left to its own answer.
  const [checks, setChecks] = useState(0);
  const expiresAt = data && data.request ? new Date(data.request.expires_at).getTime() : NaN;

  const recheck = useCallback(() => {
    if (busyRef.current) return;
    api.get(`/admin/connector/requests/${requestId}`)
      .then((r) => {
        const status = r.data && r.data.request && r.data.request.status;
        if (busyRef.current) return;
        if (status !== 'pending') { endWith(GONE[status] ? status : 'missing'); return; }
        setData(r.data);
        setChecks((n) => n + 1);
      })
      .catch((err) => {
        const reason = goneReason(err);
        if (reason && !busyRef.current) endWith(reason);
        else setChecks((n) => n + 1); // a failed read: try again later
      });
  }, [requestId, endWith]);

  useEffect(() => {
    if (phase !== 'ready' || !Number.isFinite(expiresAt)) return undefined;
    const left = expiresAt - Date.now();
    const delay = left > 0 ? left : (checks === 0 ? 0 : RECHECK_MS);
    const t = setTimeout(recheck, delay);
    return () => clearTimeout(t);
  }, [phase, expiresAt, checks, recheck]);

  const load = useCallback(() => {
    if (!requestId) return () => {};
    let alive = true;
    setPhase('loading');
    api.get(`/admin/connector/requests/${requestId}`)
      .then((r) => { if (alive) { setData(r.data); setPhase('ready'); } })
      .catch((err) => {
        if (!alive) return;
        const reason = goneReason(err);
        if (reason) { setGone(reason); setPhase('gone'); } else setPhase('loadError');
      });
    return () => { alive = false; };
  }, [requestId]);

  useEffect(() => load(), [load]);

  async function run(kind, step, failed) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(kind);
    setNotice(null);
    let left = false;
    try {
      left = await step();
      if (left) setPhase('leaving');
      else if (left === false) setNotice(failed);
    } catch (err) {
      const reason = goneReason(err);
      if (reason) endWith(reason);
      else setNotice((err && NOTICES[err.code]) || failed);
    } finally {
      if (!left) { busyRef.current = false; setBusy(null); }
    }
  }

  const allow = () => run('allow', async () => {
    // No passkey prompt for a request the server would refuse: a fresh read
    // first (answered in another tab, or expired), and the server's answer
    // decides, not this device's clock.
    const { data: fresh } = await api.get(`/admin/connector/requests/${requestId}`);
    const status = fresh && fresh.request && fresh.request.status;
    if (status !== 'pending') { endWith(GONE[status] ? status : 'missing'); return null; }
    setData(fresh);
    const { data: options } = await api.post('/admin/connector/assert-options');
    let assertion;
    try {
      assertion = await startAuthentication({ optionsJSON: options });
    } catch (e) {
      setNotice(PROMPT_CLOSED); // dismissed, timed out or refused by the device
      return null;
    }
    let out;
    try {
      ({ data: out } = await api.post(`/admin/connector/requests/${requestId}/approve`, { assertion }));
    } catch (err) {
      // No answer (api.js's NETWORK_ERROR) or a server failure (a 500
      // carries INTERNAL_ERROR): it may have committed. A named refusal is
      // a known answer and goes to the notices below.
      const unknown = err && (err.status === 0 || err.status >= 500) && !NOTICES[err.code] && !GONE_BY_CODE[err.code];
      if (unknown) { setNotice(APPROVE_UNCONFIRMED); return null; }
      throw err;
    }
    return leaveFor(out && out.redirect_url);
  }, ALLOW_FAILED);

  const cancel = () => run('cancel', async () => {
    const { data: out } = await api.post(`/admin/connector/requests/${requestId}/cancel`);
    return leaveFor(out && out.redirect_url);
  }, CANCEL_FAILED);

  return (
    <div className="auth-page connect-claude">
      <header className="site-header">
        <BrandLogo admin />
      </header>
      <main className="connect-claude__main">
        <div className="card connect-claude__card">
          {phase === 'loading' && (
            <p className="connect-claude__status" role="status" aria-live="polite">Loading the sign-in request...</p>
          )}

          {phase === 'loadError' && (
            <>
              <h1 className="connect-claude__title">Could not load this sign-in request</h1>
              <p className="connect-claude__lead">Check your connection and try again.</p>
              <div className="connect-claude__actions">
                <button type="button" className="btn btn-secondary" onClick={load}>Try again</button>
              </div>
            </>
          )}

          {phase === 'gone' && (
            <>
              <h1 className="connect-claude__title">{GONE[gone][0]}</h1>
              <p className="connect-claude__lead">{GONE[gone][1]}</p>
              <p className="connect-claude__back"><Link to="/dashboard">Go to the dashboard</Link></p>
            </>
          )}

          {(phase === 'ready' || phase === 'leaving') && data && (
            <RequestView
              data={data}
              phase={phase}
              busy={busy}
              notice={notice}
              supported={supported}
              onAllow={allow}
              onCancel={cancel}
            />
          )}
        </div>
      </main>
    </div>
  );
}

function RequestView({ data, phase, busy, notice, supported, onAllow, onCancel }) {
  const { request, existing_connection: existing } = data;
  const locked = Boolean(busy) || phase === 'leaving';
  return (
    <>
      <div className="connect-claude__kicker">Claude connector</div>
      <h1 className="connect-claude__title">Allow {request.client_name || 'Claude'} to read your business?</h1>
      <p className="connect-claude__lead">
        It can look things up, and it cannot change or send anything. It will be able to read:
      </p>
      <ul className="connect-claude__reads">
        {(request.reads || []).map((r) => <li key={r}>{r}</li>)}
      </ul>

      <dl className="connect-claude__facts">
        <div><dt>Requested</dt><dd>{when(request.requested_at)}</dd></div>
        <div><dt>From address</dt><dd>{request.caller_address || 'Not recorded'}</dd></div>
        <div><dt>Browser</dt><dd className="connect-claude__ua">{request.user_agent || 'Not recorded'}</dd></div>
        <div><dt>Returns to</dt><dd>{request.redirect_host}</dd></div>
        <div><dt>Expires</dt><dd>{when(request.expires_at)}</dd></div>
      </dl>

      {existing && (
        <div className="alert alert-info connect-claude__replace" role="note">
          You already have a Claude connection, approved {when(existing.approved_at)}. Allowing replaces it
          once Claude finishes signing in; until then the current one keeps working.
        </div>
      )}

      {!supported && (
        <div className="alert alert-error">
          This browser cannot use passkeys, so it cannot approve. Open this link on a device that has your admin passkey.
        </div>
      )}

      {notice && (
        <div className="alert alert-error" role="alert">
          {notice.text}
        </div>
      )}

      {phase === 'leaving' ? (
        <p className="connect-claude__status" role="status" aria-live="polite">Returning you to Claude...</p>
      ) : (
        <div className="connect-claude__actions">
          <button type="button" className="btn btn-primary" onClick={onAllow} disabled={locked || !supported}>
            {busy === 'allow' ? 'Waiting for your passkey...' : 'Allow'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={locked}>
            {busy === 'cancel' ? 'Cancelling...' : 'Cancel'}
          </button>
        </div>
      )}
    </>
  );
}

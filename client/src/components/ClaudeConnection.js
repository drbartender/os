// ClaudeConnection: the "Claude connection" block in admin Security settings (spec 2026-11-19 section 7.2): the connection, the recent calls, Disconnect.
//
// Reads GET /admin/connector/status and GET /admin/connector/calls
// (server/routes/admin/connector.js). It shows whether a connection exists
// and its state in plain words, when it was approved, connected and last
// used, the address check when it is not on, and the recent calls with
// refusals and withheld messages named as such. Disconnect asks inside the
// page (never window.confirm, which blocks browser automation), then revokes.
//
// The routes are admin only and answer 404 while the connector flag is off,
// so the block renders nothing for a manager and nothing while the connector
// is off: it ships dark with the rest of the connector.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import api from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { chicagoTime, chicagoWeekdayDate } from '../utils/chicagoDay';
import '../styles/drb-tokens.css';
import '../pages/admin/ConnectClaude.css';

export const CALLS_LIMIT = 20;

// The connection's state (grants.js grantState) in plain words. currentGrant
// never returns a revoked or pending grant, so those are not here.
export const STATE_TEXT = {
  live: ['Connected', 'Claude can read the business now.'],
  lapsed: ['Lapsed', 'It went unused for 30 days. Approve it again from Claude to reconnect.'],
  expired: ['Expired', 'A connection lasts 180 days. Approve it again from Claude to reconnect.'],
  // grantState says signed_out whenever the account's token_version moved:
  // a password reset, a passkey revoke or an email change resets every
  // session, this one included.
  signed_out: ['Signed out', "The account's sessions were reset (a password reset, a passkey revoke or an email change does that). Approve it again from Claude to reconnect."],
  no_longer_admin: ['Off', 'The account that approved it is no longer an admin.'],
};

const ADDRESS_CHECK_TEXT = {
  off: 'The address check is off, so calls are accepted from any address.',
  unreadable: 'The address range setting cannot be read, so every call is refused until it is fixed.',
};

// A call-log outcome (callLog.js OUTCOMES) in plain words.
const OUTCOME_TEXT = {
  ok: 'Read',
  not_found: 'Nothing found',
  error: 'Failed',
  withheld: 'Text held back',
  refused_token: 'Refused: not signed in',
  refused_address: 'Refused: unknown address',
  refused_tripwire: 'Refused: read limit reached for the hour',
};

function when(value) {
  const day = chicagoWeekdayDate(value);
  return day ? `${day}, ${chicagoTime(value)}` : '';
}

// A row's record list in plain words: a tripwire mark (trip:<instant>) as
// the trip's start in Chicago time, the call's held-back pieces
// (withheld:<ref>, a field ref and a hash, never text) as one "text held
// back" entry ahead of any flagged ones, so they are never hidden behind
// "and N more".
export function recordWords(recordIds) {
  const list = Array.isArray(recordIds) ? recordIds.map(String) : [];
  const plain = [];
  const trips = [];
  const flagged = [];
  let held = 0;
  for (const id of list) {
    if (id.startsWith('withheld:')) held += 1;
    else if (id.startsWith('trip:')) {
      const at = when(id.slice(5));
      trips.push(at ? `read limit trip started ${at}` : 'read limit trip');
    } else if (id.startsWith('flagged:')) flagged.push(id);
    else plain.push(id);
  }
  const heldWords = held === 0 ? [] : [held === 1 ? 'text held back' : `text held back (${held} pieces)`];
  return [...plain, ...trips, ...heldWords, ...flagged];
}

function ids(recordIds) {
  const list = recordWords(recordIds);
  if (list.length <= 3) return list.join(', ');
  return `${list.slice(0, 3).join(', ')} and ${list.length - 3} more`;
}

// A tool (spec 7.3) or protocol method in plain words: the seven names the
// server registers (server/utils/connector/tools/index.js). A name not listed
// here is shown with its underscores as spaces, never as the raw slug.
const TOOL_TEXT = {
  waiting_on_you: 'Waiting on you',
  upcoming_events: 'Upcoming events',
  money_owed: 'Money owed',
  search: 'Search',
  client: 'Client details',
  proposal_or_event: 'Proposal or event details',
  thread: 'Message thread',
};
const METHOD_TEXT = {
  initialize: 'Started a session',
  'tools/list': 'Listed the tools',
  'tools/call': 'Used a tool',
  ping: 'Checked the connection',
  batch: 'Several requests at once',
};

export function callLabel(call) {
  if (call.tool_name) {
    if (TOOL_TEXT[call.tool_name]) return TOOL_TEXT[call.tool_name];
    const words = String(call.tool_name).replace(/[_-]+/g, ' ').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'A tool';
  }
  if (call.method && METHOD_TEXT[call.method]) return METHOD_TEXT[call.method];
  return call.method ? 'A protocol request' : 'A request';
}

// The lapse is the earlier of 30 days after last use and the hard end; when
// it is the hard end, use does not move it, so there is no "unless used".
export function lapseLine(connection) {
  const lapses = new Date(connection.lapses_at).getTime();
  const ends = new Date(connection.expires_at).getTime();
  if (!Number.isFinite(lapses) || !Number.isFinite(ends) || lapses >= ends) return null;
  return `${when(connection.lapses_at)} unless used before then`;
}

export default function ClaudeConnection() {
  const { user } = useAuth();
  const isAdmin = Boolean(user && user.role === 'admin');
  const [status, setStatus] = useState(null);
  const [calls, setCalls] = useState(null); // null while loading, 'error' on a failed read
  const [phase, setPhase] = useState('loading'); // loading | ready | off | error
  const [confirming, setConfirming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState('');
  const [cleared, setCleared] = useState(false);
  const inFlight = useRef(false);

  // Status and calls load apart, so a failed call-log read never hides the
  // connection or its Disconnect.
  const load = useCallback(() => {
    let alive = true;
    api.get('/admin/connector/status')
      .then((s) => { if (alive) { setStatus(s.data); setPhase('ready'); } })
      .catch((err) => { if (alive) setPhase(err && err.status === 404 ? 'off' : 'error'); });
    api.get('/admin/connector/calls', { params: { limit: CALLS_LIMIT } })
      .then((c) => { if (alive) setCalls(c.data); })
      .catch(() => { if (alive) setCalls('error'); });
    return () => { alive = false; };
  }, []);

  useEffect(() => (isAdmin ? load() : undefined), [isAdmin, load]);

  const disconnect = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setDisconnecting(true);
    setDisconnectError('');
    try {
      await api.post('/admin/connector/disconnect');
      setStatus((s) => ({ ...s, connection: null }));
      setConfirming(false);
      setCleared(true);
    } catch (err) {
      setDisconnectError((err && err.message) || 'Could not disconnect. Try again.');
    } finally {
      inFlight.current = false;
      setDisconnecting(false);
    }
  };

  if (!isAdmin || phase === 'off') return null;

  return (
    <div className="card claude-conn">
      <h3 className="claude-conn__title">Claude connection</h3>

      {phase === 'loading' && <p className="claude-conn__muted" role="status">Loading...</p>}
      {phase === 'error' && <p className="claude-conn__muted">Could not load the Claude connection. Try refreshing.</p>}

      {phase === 'ready' && status && (
        <>
          {status.connection ? (
            <ConnectionView
              connection={status.connection}
              confirming={confirming}
              disconnecting={disconnecting}
              disconnectError={disconnectError}
              onAsk={() => { setConfirming(true); setDisconnectError(''); }}
              onKeep={() => setConfirming(false)}
              onDisconnect={disconnect}
            />
          ) : (
            <NoConnection status={status} cleared={cleared} />
          )}

          {ADDRESS_CHECK_TEXT[status.address_check] && (
            <div className="alert alert-error claude-conn__address" role="note">
              {ADDRESS_CHECK_TEXT[status.address_check]}
            </div>
          )}

          <CallList calls={calls} />
        </>
      )}
    </div>
  );
}

function NoConnection({ status, cleared }) {
  return (
    <div className="claude-conn__none">
      {cleared && <p className="claude-conn__done" role="status">Disconnected. Claude can no longer read the business.</p>}
      <p>Claude is not connected.</p>
      <p className="claude-conn__muted">
        To connect, add a custom connector in Claude's settings with this address and client id, then approve it here
        with your admin passkey.
      </p>
      <dl className="claude-conn__facts">
        <div><dt>Address</dt><dd className="claude-conn__mono">{status.mcp_url}</dd></div>
        <div><dt>Client id</dt><dd className="claude-conn__mono">{status.client_id}</dd></div>
      </dl>
    </div>
  );
}

function ConnectionView({ connection, confirming, disconnecting, disconnectError, onAsk, onKeep, onDisconnect }) {
  // Focus follows the confirm step: onto it when it opens, back to
  // Disconnect when Keep it closes it (never on first render).
  const confirmRef = useRef(null);
  const askRef = useRef(null);
  const opened = useRef(false);
  useEffect(() => {
    if (confirming) { opened.current = true; if (confirmRef.current) confirmRef.current.focus(); }
    else if (opened.current && askRef.current) askRef.current.focus();
  }, [confirming]);
  const [label, detail] = STATE_TEXT[connection.state] || ['Unknown', 'The connection is in a state this page does not know.'];
  return (
    <div className="claude-conn__connection">
      <p className={`claude-conn__state claude-conn__state--${connection.state === 'live' ? 'live' : 'off'}`}>
        <strong>{label}.</strong> {detail}
      </p>
      <dl className="claude-conn__facts">
        <div><dt>Approved</dt><dd>{when(connection.approved_at) || 'Not recorded'}</dd></div>
        <div><dt>Connected</dt><dd>{when(connection.connected_at) || 'Not recorded'}</dd></div>
        <div><dt>Last used</dt><dd>{when(connection.last_used_at) || 'Not yet'}</dd></div>
        {connection.state === 'live' && lapseLine(connection) && (
          <div><dt>Lapses</dt><dd>{lapseLine(connection)}</dd></div>
        )}
        {connection.state === 'live' && (
          <div><dt>Ends</dt><dd>{when(connection.expires_at)}, 180 days after approval, whatever the use</dd></div>
        )}
      </dl>

      {confirming ? (
        <div className="claude-conn__confirm" role="group" aria-label="Confirm disconnect" tabIndex={-1} ref={confirmRef}>
          <p>Disconnect Claude? It loses access right away. The call log stays.</p>
          <div className="claude-conn__actions">
            <button type="button" className="btn btn-danger btn-sm" onClick={onDisconnect} disabled={disconnecting}>
              {disconnecting ? 'Disconnecting...' : 'Yes, disconnect'}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onKeep} disabled={disconnecting}>
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <div className="claude-conn__actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onAsk} ref={askRef}>Disconnect</button>
        </div>
      )}
      {disconnectError && <div className="alert alert-error claude-conn__error" role="alert">{disconnectError}</div>}
    </div>
  );
}

function CallList({ calls }) {
  const rows = (calls && calls !== 'error' && calls.calls) || [];
  return (
    <div className="claude-conn__calls">
      <h4 className="claude-conn__subtitle">Recent calls</h4>
      {calls === null && <p className="claude-conn__muted" role="status">Loading...</p>}
      {calls === 'error' && <p className="claude-conn__muted">Could not load the recent calls. Try refreshing.</p>}
      {calls === null || calls === 'error' ? null : rows.length === 0 ? (
        <p className="claude-conn__muted">No calls yet.</p>
      ) : (
        <ul className="claude-conn__list">
          {rows.map((c) => {
            const refused = String(c.outcome || '').startsWith('refused');
            const withheld = c.outcome === 'withheld';
            const kind = refused ? 'refused' : withheld ? 'withheld' : 'call';
            return (
              <li key={c.id} className={`claude-conn__row claude-conn__row--${kind}`} data-outcome={c.outcome}>
                <div className="claude-conn__row-main">
                  <span className="claude-conn__what">{callLabel(c)}</span>
                  <span className={`claude-conn__outcome claude-conn__outcome--${kind}`}>
                    {OUTCOME_TEXT[c.outcome] || c.outcome}
                  </span>
                </div>
                <div className="claude-conn__row-meta">
                  {when(c.called_at)}
                  {c.caller_address ? ` from ${c.caller_address}` : ''}
                </div>
                {ids(c.record_ids) && <div className="claude-conn__row-meta">Records: {ids(c.record_ids)}</div>}
                {withheld && (
                  <div className="claude-conn__row-note">A piece of client-written text (a message, a name, a note or a contact field) was held back from Claude.</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {calls && calls !== 'error' && calls.has_more && <p className="claude-conn__muted claude-conn__more">More not shown.</p>}
    </div>
  );
}

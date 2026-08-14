import React, { useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import Icon from '../../../components/adminos/Icon';
import { errorText } from './marketingFormat';

/**
 * The Overview: "what should I do today", not "here is a list of things you made".
 *
 * Moments lead. Then the numbers, deliberately unflattering — "past clients
 * never asked back" is the reason this whole section exists, and a dashboard
 * that hid it behind a vanity metric would be worse than no dashboard. Then a
 * work queue of things only a person can decide.
 *
 * Data comes from MarketingLayout's shared overview fetch (Outlet context);
 * moment edits and dismissals write back through `update` so the shell's
 * subtitle and budget meter stay current.
 */

// Spine hue is keyed on the moment's position in the FULL authored moments
// array, which never reorders, so dismissing a card neither recolors the ones
// below it nor collapses distinct cards onto one hue (an id hash proved
// degenerate on the real moment set). No danger red in the cycle: a spine is
// identity, not a warning.
const MOMENT_HUES = ['violet', 'info', 'warn', 'ok'];
const BASE_HUES = ['ok', 'danger', 'warn', 'violet', 'info'];

function MomentCard({ moment, hue, onEdit, onDismiss, onCompose, busy }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: moment.title, window: moment.window, why: moment.why });

  // Seed the draft when the editor OPENS, not once at mount. The card instance
  // survives every data update (it is keyed by id), so a draft captured at mount
  // goes stale the moment anything is saved. The reachable version: clear a
  // field, save, reopen — and the input is empty rather than showing the
  // authored default the card is now displaying.
  const openEditor = () => {
    setDraft({ title: moment.title, window: moment.window, why: moment.why });
    setEditing(true);
  };

  const save = async () => {
    // Send ONLY what actually changed. The form pre-populates every field with
    // the current text, so posting the whole draft stores all three as
    // overrides the first time somebody fixes a typo in one — which freezes the
    // other two at today's wording forever and defeats the entire per-field
    // design. Server-side storage being per-field is not enough if the client
    // always sends three fields.
    const changed = {};
    for (const f of ['title', 'window', 'why']) {
      if ((draft[f] ?? '') !== (moment[f] ?? '')) changed[f] = draft[f];
    }
    if (Object.keys(changed).length === 0) { setEditing(false); return; }
    // Only close on SUCCESS. onEdit used to swallow its own error and resolve,
    // so a rejected save closed the editor over an error toast and showed the
    // old copy, with the operator's text gone.
    const ok = await onEdit(moment.id, changed);
    if (ok) setEditing(false);
  };

  if (editing) {
    return (
      <article className="card mkt-moment">
        <div className="mkt-moment-editing">
          <label htmlFor={`t-${moment.id}`}>Title</label>
          <input id={`t-${moment.id}`} className="input" value={draft.title}
            onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} />
          <label htmlFor={`w-${moment.id}`}>Window</label>
          <input id={`w-${moment.id}`} className="input" value={draft.window}
            onChange={e => setDraft(d => ({ ...d, window: e.target.value }))} />
          <label htmlFor={`y-${moment.id}`}>Why this matters</label>
          <textarea id={`y-${moment.id}`} className="mkt-textarea" rows={3} style={{ minHeight: 90 }}
            value={draft.why}
            onChange={e => setDraft(d => ({ ...d, why: e.target.value }))} />
          <p className="muted tiny">
            Only the words are yours to change. Who this reaches and when it opens are
            part of the rule, so the reasoning above can never end up in front of the
            wrong people. Clear a field to go back to the original wording.
          </p>
          <div className="mkt-dnc-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={busy}>Save wording</button>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className="card mkt-moment">
      <div className="mkt-moment-grid">
        <div className={`mkt-hue-${hue}`} />
        <div className="mkt-moment-body">
          <div className="mkt-moment-eyebrow">{moment.window}</div>
          <h3 className="mkt-moment-title">{moment.title}</h3>
          <p className="mkt-moment-why">{moment.why}</p>
          {moment.exceeds_daily_cap && (
            <p className="mkt-moment-note mkt-warn">
              More than the {moment.daily_cap} you can send in a day, so this takes more than one pass.
            </p>
          )}
          {moment.edited_fields.length > 0 && (
            <p className="mkt-moment-note">Wording edited: {moment.edited_fields.join(', ')}.</p>
          )}
          <div className="mkt-moment-foot">
            <button type="button" className="btn btn-ghost btn-sm" onClick={openEditor}>Edit wording</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onDismiss(moment)} disabled={busy}>
              Not this time
            </button>
          </div>
        </div>
        <div className="mkt-moment-rail">
          <div className="mkt-moment-count">
            <span className="num">{moment.emailable}</span>
            <div className="mkt-moment-count-sub">
              {moment.emailable === 1 ? 'person emailable' : 'emailable'}
            </div>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onCompose(moment)}>
            Review recipients
          </button>
        </div>
      </div>
    </article>
  );
}

export default function OverviewTab() {
  const toast = useToast();
  const navigate = useNavigate();
  const { overview: data, error, refresh, update } = useOutletContext();
  const [busy, setBusy] = useState(false);

  const editMoment = async (id, fields) => {
    setBusy(true);
    try {
      const res = await api.put(`/marketing/moments/${id}`, fields);
      update(d => ({ ...d, moments: d.moments.map(m => (m.id === id ? res.data : m)) }));
      toast.success('Wording saved.');
      return true;
    } catch (err) {
      toast.error(errorText(err, 'Could not save the wording.'));
      return false;
    } finally { setBusy(false); }
  };

  const dismiss = async (moment) => {
    setBusy(true);
    try {
      await api.post(`/marketing/moments/${moment.id}/dismiss`);
      update(d => ({
        ...d,
        moments: d.moments.map(m => (m.id === moment.id ? { ...m, dismissed: true } : m)),
        open_moment_count: Math.max(0, d.open_moment_count - 1),
      }));
      // Say plainly that it comes back, because "Not this time" reads permanent.
      toast.success(`Cleared for now. It comes back next time (${moment.occurrence_key}).`);
    } catch (err) {
      toast.error(errorText(err, 'Could not dismiss.'));
    } finally { setBusy(false); }
  };

  const compose = (moment) => navigate(`/marketing/compose?audience=${moment.audience_id}`);

  if (!data && !error) {
    return <div className="mkt-state" role="status" aria-live="polite"><div className="spinner" /> Loading…</div>;
  }
  if (!data && error) {
    return (
      <div className="mkt-state mkt-state-error" role="alert">
        <p>{errorText(error, 'Could not load the overview.')}</p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={refresh}>Try again</button>
      </div>
    );
  }

  const live = data.moments.filter(m => m.open && !m.dismissed && m.emailable > 0);
  const n = data.numbers;
  const needsTotal =
    data.needs_you.never_classified + data.needs_you.do_not_contact + data.needs_you.bounced;
  const baseRows = [
    { label: 'Emailable', count: data.base.mailable },
    { label: 'Do not contact', count: data.base.do_not_contact },
    { label: 'Unsubscribed', count: data.base.unsubscribed },
    { label: 'Bounced', count: data.base.bounced },
    { label: 'No address', count: data.base.no_address },
  ];

  return (
    <div className="mkt-overview">
      <div>
        {/* A refresh that fails AFTER data loaded must not be silent: the
            numbers on screen have quietly stopped updating. */}
        {error && data && (
          <div className="mkt-state mkt-state-error" role="alert" style={{ padding: '0 0 12px' }}>
            <p>These numbers may be stale: the last refresh failed.</p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={refresh}>Refresh</button>
          </div>
        )}
        <div className="mkt-section-head">
          <h2 className="section-title">Moments open now</h2>
          <span className="muted tiny">Occasions repeat. Get ahead of them.</span>
        </div>
        {live.length === 0 ? (
          <div className="mkt-state">
            Nothing open right now. Moments appear when their window opens and there is
            somebody to reach.
          </div>
        ) : (
          <div className="mkt-moments">
            {live.map(m => (
              <MomentCard key={m.id} moment={m}
                hue={MOMENT_HUES[Math.max(0, data.moments.findIndex(x => x.id === m.id)) % MOMENT_HUES.length]}
                busy={busy} onEdit={editMoment} onDismiss={dismiss} onCompose={compose} />
            ))}
          </div>
        )}

        <h2 className="section-title">The year, honestly</h2>
        <div className="card">
          <div className="card-body mkt-year">
            <div>
              <div className="stat-label">Marketing emails sent, all time</div>
              <div className="stat-value">{n.emails_sent_all_time}</div>
            </div>
            <div className="mkt-vr" />
            <div>
              <div className="stat-label">Past clients never asked back</div>
              <div className={n.past_clients_never_asked_back > 0 ? 'stat-value mkt-warn' : 'stat-value'}>
                {n.past_clients_never_asked_back}
              </div>
            </div>
            <div className="mkt-vr" />
            <div>
              <div className="stat-label">Repeat corporate bookings</div>
              <div className={n.repeat_corporate_bookings === 0 ? 'stat-value mkt-warn' : 'stat-value'}>
                {n.repeat_corporate_bookings}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="mkt-overview-rail">
        <div className="card mkt-card-flush mkt-queue-static">
          <div className="card-head"><h3>Needs you</h3><span className="k num">{needsTotal}</span></div>
          <div className="card-body muted tiny">
            Only things a person has to decide. Nothing here can be automated.
          </div>
          <div>
            <div className="queue-item">
              <span className="queue-icon warn"><Icon name="users" size={16} /></span>
              <div className="queue-main">
                <div className="queue-title">Contacts never classified</div>
              </div>
              <span className="queue-meta">{data.needs_you.never_classified}</span>
            </div>
            <div className="queue-item">
              <span className="queue-icon danger"><Icon name="alert" size={16} /></span>
              <div className="queue-main">
                <div className="queue-title">Marked do not contact</div>
              </div>
              <span className="queue-meta">{data.needs_you.do_not_contact}</span>
            </div>
            <div className="queue-item">
              <span className="queue-icon info"><Icon name="mail" size={16} /></span>
              <div className="queue-main">
                <div className="queue-title">Addresses that hard-bounced</div>
              </div>
              <span className="queue-meta">{data.needs_you.bounced}</span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h3>Reachable base</h3><span className="k num">{data.base.total}</span></div>
          <div className="card-body">
            {baseRows.map((r, i) => (
              <div className="mkt-base-row" key={r.label}>
                <div className="mkt-base-label">
                  <span>{r.label}</span>
                  <span className="num">{r.count}</span>
                </div>
                <div className="mkt-basebar">
                  <div className={`mkt-hue-${BASE_HUES[i % BASE_HUES.length]}`}
                    style={{ width: data.base.total > 0 ? `${Math.round((r.count / data.base.total) * 100)}%` : 0 }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h3>Runs without you</h3></div>
          <div className="card-body">
            <p className="muted tiny" style={{ marginTop: 0 }}>
              These go out on their own, and every one of them shows up on the contact&apos;s
              record so you never double-tap someone. They are not switched on or off from any
              screen: each is controlled by server configuration, so turning one off is a
              deploy-time change rather than a toggle.
            </p>
            <ul className="mkt-autolist">
              {/* From the server, so Overview and Sent cannot drift and a fifth
                  automation is one edit rather than three. */}
              {(data.automations || []).map(a => (
                <li key={a.name}><span>{a.name}</span><span>{a.trigger}</span></li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

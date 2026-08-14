import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import { errorText } from './marketingFormat';

/**
 * The Overview: "what should I do today", not "here is a list of things you made".
 *
 * Moments lead. Then the numbers, deliberately unflattering — "past clients
 * never asked back" is the reason this whole section exists, and a dashboard
 * that hid it behind a vanity metric would be worse than no dashboard. Then a
 * work queue of things only a person can decide.
 */

function MomentCard({ moment, onEdit, onDismiss, onCompose, busy }) {
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
      <article className="mkt-moment mkt-moment-editing">
        <label htmlFor={`t-${moment.id}`}>Title</label>
        <input id={`t-${moment.id}`} value={draft.title}
          onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} />
        <label htmlFor={`w-${moment.id}`}>Window</label>
        <input id={`w-${moment.id}`} value={draft.window}
          onChange={e => setDraft(d => ({ ...d, window: e.target.value }))} />
        <label htmlFor={`y-${moment.id}`}>Why this matters</label>
        <textarea id={`y-${moment.id}`} rows={3} value={draft.why}
          onChange={e => setDraft(d => ({ ...d, why: e.target.value }))} />
        <p className="mkt-muted">
          Only the words are yours to change. Who this reaches and when it opens are
          part of the rule, so the reasoning above can never end up in front of the
          wrong people. Clear a field to go back to the original wording.
        </p>
        <div className="mkt-dnc-actions">
          <button type="button" className="btn-secondary" onClick={() => setEditing(false)} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={save} disabled={busy}>Save wording</button>
        </div>
      </article>
    );
  }

  return (
    <article className="mkt-moment">
      <div className="mkt-moment-head">
        <h3>{moment.title}</h3>
        <span className="mkt-chip">{moment.window}</span>
      </div>
      <p className="mkt-moment-why">{moment.why}</p>
      <p className="mkt-moment-count">
        <strong>{moment.emailable}</strong> {moment.emailable === 1 ? 'person' : 'people'} emailable
        {moment.exceeds_daily_cap && (
          <span className="mkt-warn">
            {' '}· more than the {moment.daily_cap} you can send in a day, so this takes more than one pass
          </span>
        )}
      </p>
      {moment.edited_fields.length > 0 && (
        <p className="mkt-muted">Wording edited: {moment.edited_fields.join(', ')}.</p>
      )}
      <div className="mkt-moment-actions">
        <button type="button" className="btn-primary" onClick={() => onCompose(moment)}>
          Review recipients
        </button>
        <button type="button" className="btn-link" onClick={openEditor}>Edit wording</button>
        <button type="button" className="btn-link" onClick={() => onDismiss(moment)} disabled={busy}>
          Not this time
        </button>
      </div>
    </article>
  );
}

export default function OverviewTab() {
  const toast = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get('/marketing/overview');
      setData(res.data);
    } catch (err) {
      setError(errorText(err, 'Could not load the overview.'));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const editMoment = async (id, fields) => {
    setBusy(true);
    try {
      const res = await api.put(`/marketing/moments/${id}`, fields);
      setData(d => ({ ...d, moments: d.moments.map(m => (m.id === id ? res.data : m)) }));
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
      setData(d => ({
        ...d,
        moments: d.moments.map(m => (m.id === moment.id ? { ...m, dismissed: true } : m)),
      }));
      // Say plainly that it comes back, because "Not this time" reads permanent.
      toast.success(`Cleared for now. It comes back next time (${moment.occurrence_key}).`);
    } catch (err) {
      toast.error(errorText(err, 'Could not dismiss.'));
    } finally { setBusy(false); }
  };

  const compose = (moment) => navigate(`/marketing/compose?audience=${moment.audience_id}`);

  if (loading) {
    return <div className="mkt-state" role="status" aria-live="polite"><div className="spinner" /> Loading…</div>;
  }
  if (error) {
    return (
      <div className="mkt-state mkt-state-error" role="alert">
        <p>{error}</p>
        <button type="button" className="btn-secondary" onClick={load}>Try again</button>
      </div>
    );
  }

  const live = data.moments.filter(m => m.open && !m.dismissed && m.emailable > 0);
  const n = data.numbers;

  return (
    <div className="mkt-overview">
      <section>
        <h2>Worth sending into</h2>
        {live.length === 0 ? (
          <div className="mkt-state">
            Nothing open right now. Moments appear when their window opens and there is
            somebody to reach.
          </div>
        ) : live.map(m => (
          <MomentCard key={m.id} moment={m} busy={busy}
            onEdit={editMoment} onDismiss={dismiss} onCompose={compose} />
        ))}
      </section>

      <section>
        <h2>The year, honestly</h2>
        <ul className="mkt-heldback-list mkt-numbers">
          <li><span>Marketing emails sent, all time</span><span>{n.emails_sent_all_time}</span></li>
          <li>
            <span>Past clients never asked back</span>
            <span className={n.past_clients_never_asked_back > 0 ? 'mkt-warn' : ''}>
              {n.past_clients_never_asked_back}
            </span>
          </li>
          <li>
            <span>Repeat corporate bookings</span>
            <span className={n.repeat_corporate_bookings === 0 ? 'mkt-warn' : ''}>
              {n.repeat_corporate_bookings}
            </span>
          </li>
        </ul>
      </section>

      <section>
        <h2>Needs you</h2>
        <p className="mkt-muted">Only things a person has to decide. Nothing here can be automated.</p>
        <ul className="mkt-heldback-list">
          <li>
            <span>Contacts never classified</span>
            <span>{data.needs_you.never_classified}</span>
          </li>
          <li><span>Marked do not contact</span><span>{data.needs_you.do_not_contact}</span></li>
          <li><span>Addresses that hard-bounced</span><span>{data.needs_you.bounced}</span></li>
        </ul>
      </section>

      <section>
        <h2>Who you can reach</h2>
        <ul className="mkt-heldback-list">
          <li><span>Emailable</span><span>{data.base.mailable}</span></li>
          <li><span>Do not contact</span><span>{data.base.do_not_contact}</span></li>
          <li><span>Unsubscribed</span><span>{data.base.unsubscribed}</span></li>
          <li><span>Bounced</span><span>{data.base.bounced}</span></li>
          <li><span>No address</span><span>{data.base.no_address}</span></li>
          <li><strong>Everyone</strong><strong>{data.base.total}</strong></li>
        </ul>
        <p className="mkt-muted">
          Today&apos;s budget: {data.send_budget.remaining} of {data.send_budget.cap} sends left.
        </p>
      </section>

      <section>
        <h2>Runs without you</h2>
        <p className="mkt-muted">
          These go out on their own, and every one of them shows up on the contact&apos;s
          record so you never double-tap someone. They are not switched on or off from any
          screen: each is controlled by server configuration, so turning one off is a
          deploy-time change rather than a toggle.
        </p>
        <ul className="mkt-heldback-list">
          {/* From the server, so Overview and Sent cannot drift and a fifth
              automation is one edit rather than three. */}
          {(data.automations || []).map(a => (
            <li key={a.name}><span>{a.name}</span><span className="mkt-muted">{a.trigger}</span></li>
          ))}
        </ul>
      </section>
    </div>
  );
}

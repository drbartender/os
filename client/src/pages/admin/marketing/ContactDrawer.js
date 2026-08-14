import React, { useCallback, useEffect, useState } from 'react';
import api from '../../../utils/api';
import TagCell from './TagCell';
import DoNotContactControl from './DoNotContactControl';
import { getEventTypeLabel } from '../../../utils/eventTypes';
import { formatDollars, formatDay, formatStamp, heldBackLabel, errorText } from './marketingFormat';

/**
 * The contact record.
 *
 * This is what makes "every automated send shows up on the contact's record so
 * you never double-tap someone" true. The message list unions three tables
 * server-side, and it marks automated sends explicitly, because "the system
 * emailed them" and "I emailed them" are different facts when you are deciding
 * whether to reach out again. Without this view the history endpoints have no
 * consumer at all.
 *
 * Chrome is the DS drawer contract: `.drawer` sits off-canvas until `.open`
 * is added, so the class is toggled one frame after mount to play the
 * slide-in. Close unmounts immediately (no exit animation, matching the
 * shipped behavior).
 */
export default function ContactDrawer({ contactId, onClose, onTagsChange, onContactChange }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/marketing/contacts/${contactId}`);
      setData(res.data);
    } catch (err) {
      setError(errorText(err, 'Could not load this contact.'));
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Tag and do-not-contact writes from inside the drawer update the drawer AND
  // the row behind it, so closing does not reveal stale chips.
  const handleTags = (id, tags) => {
    setData(d => (d && d.id === id ? { ...d, tags } : d));
    onTagsChange(id, tags);
  };
  const handleContact = (id, patch) => {
    setData(d => (d && d.id === id ? { ...d, ...patch } : d));
    onContactChange(id, patch);
  };

  return (
    <>
      <div className={`drawer-scrim${open ? ' open' : ''}`} onClick={onClose} />
      <aside
        className={`drawer${open ? ' open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Contact record"
      >
        <div className="drawer-head">
          <span className="crumb">Marketing · Contact record</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        <div className="drawer-body">
          {loading && (
            <div className="mkt-state" role="status" aria-live="polite">
              <div className="spinner" /> Loading…
            </div>
          )}

          {error && !loading && (
            <div className="mkt-state mkt-state-error" role="alert">
              <p>{error}</p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={load}>Try again</button>
            </div>
          )}

          {data && !loading && !error && (
            <>
              <div className="drawer-hero">
                <h2>{data.name || 'Contact'}</h2>
                <div className="mkt-drawer-identity" style={{ marginTop: 6 }}>
                  <div>{data.email || 'No address'}</div>
                  {data.phone && <div>{data.phone}</div>}
                  {data.source && <div className="muted tiny">Source: {data.source}</div>}
                  <div className="muted tiny">Lifetime: {formatDollars(data.lifetime_dollars)}</div>
                  {!data.mailable && data.held_back_reason && (
                    <div style={{ marginTop: 4 }}>
                      <span className="chip derived">
                        Held back: {heldBackLabel(data.held_back_reason)}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              <div className="mkt-drawer-section">
                <TagCell contact={data} onTagsChange={handleTags} />
                <div style={{ marginTop: 10 }}>
                  <DoNotContactControl contact={data} onChange={handleContact} />
                </div>
              </div>

              <div className="mkt-drawer-section">
                <h3 className="section-title">Event history</h3>
                {(data.events || []).length === 0 ? (
                  <p className="muted tiny">No events yet.</p>
                ) : (
                  <ul className="mkt-list">
                    {(data.events || []).map(e => (
                      <li key={e.id}>
                        <span className="num">{formatDay(e.event_date)}</span>
                        <span>{getEventTypeLabel(e)}</span>
                        <span className="muted">{e.venue_name || ''}</span>
                        <span className="num">{formatDollars(e.amount)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="mkt-drawer-section">
                <h3 className="section-title">Message history</h3>
                {(data.messages || []).length === 0 ? (
                  <p className="muted tiny">Nothing sent yet.</p>
                ) : (
                  <ul className="mkt-list">
                    {(data.messages || []).map((m, i) => (
                      <li key={`${m.at}-${i}`}>
                        <span className="num">{formatStamp(m.at)}</span>
                        <span className="muted">{m.channel}</span>
                        <span>{m.subject || m.kind}</span>
                        <span className={m.automated ? 'chip derived' : 'chip neutral'}>
                          {m.automated ? 'Automated' : 'Sent by us'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

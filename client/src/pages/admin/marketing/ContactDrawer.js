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
 */
export default function ContactDrawer({ contactId, onClose, onTagsChange, onContactChange }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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
    <div className="mkt-drawer-backdrop" onClick={onClose}>
      <aside
        className="mkt-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Contact record"
        onClick={e => e.stopPropagation()}
      >
        <div className="mkt-drawer-head">
          <h2>{data?.name || 'Contact'}</h2>
          <button type="button" className="btn-link" onClick={onClose} aria-label="Close">Close</button>
        </div>

        {loading && (
          <div className="mkt-state" role="status" aria-live="polite">
            <div className="spinner" /> Loading…
          </div>
        )}

        {error && !loading && (
          <div className="mkt-state mkt-state-error" role="alert">
            <p>{error}</p>
            <button type="button" className="btn-secondary" onClick={load}>Try again</button>
          </div>
        )}

        {data && !loading && !error && (
          <>
            <div className="mkt-drawer-identity">
              <div>{data.email || 'No address'}</div>
              {data.phone && <div>{data.phone}</div>}
              {data.source && <div className="mkt-muted">Source: {data.source}</div>}
              <div className="mkt-muted">Lifetime: {formatDollars(data.lifetime_dollars)}</div>
              {!data.mailable && data.held_back_reason && (
                <div className="mkt-chip mkt-chip-muted">
                  Held back: {heldBackLabel(data.held_back_reason)}
                </div>
              )}
            </div>

            <div className="mkt-drawer-section">
              <TagCell contact={data} onTagsChange={handleTags} />
              <DoNotContactControl contact={data} onChange={handleContact} />
            </div>

            <div className="mkt-drawer-section">
              <h3>Event history</h3>
              {(data.events || []).length === 0 ? (
                <p className="mkt-muted">No events yet.</p>
              ) : (
                <ul className="mkt-list">
                  {(data.events || []).map(e => (
                    <li key={e.id}>
                      <span>{formatDay(e.event_date)}</span>
                      <span>{getEventTypeLabel(e)}</span>
                      <span className="mkt-muted">{e.venue_name || ''}</span>
                      <span>{formatDollars(e.amount)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="mkt-drawer-section">
              <h3>Message history</h3>
              {(data.messages || []).length === 0 ? (
                <p className="mkt-muted">Nothing sent yet.</p>
              ) : (
                <ul className="mkt-list">
                  {(data.messages || []).map((m, i) => (
                    <li key={`${m.at}-${i}`}>
                      <span>{formatStamp(m.at)}</span>
                      <span className="mkt-muted">{m.channel}</span>
                      <span>{m.subject || m.kind}</span>
                      <span className={m.automated ? 'mkt-chip mkt-chip-muted' : 'mkt-chip'}>
                        {m.automated ? 'Automated' : 'Sent by us'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

import React, { useCallback, useEffect, useState } from 'react';
import api from '../../../utils/api';
import { formatLocalDay, errorText } from './marketingFormat';

/**
 * What went out, and what it produced.
 *
 * BOOKED is the column this table exists for, and the one most easily
 * overstated. It means: a recipient created a proposal within 30 days of
 * receiving that campaign, counted once per person. Stating the definition on
 * the screen matters, because "booked: 3" invites a much larger claim than the
 * data supports, and nobody reading a dashboard goes looking for the SQL.
 */
export default function SentTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get('/marketing/sent');
      setData(res.data);
    } catch (err) {
      setError(errorText(err, 'Could not load sent campaigns.'));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

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

  return (
    <div className="mkt-sent">
      <section>
        <h2>Sent</h2>
        {data.campaigns.length === 0 ? (
          <div className="mkt-state">
            Nothing sent yet. Campaigns appear here once they go out.
          </div>
        ) : (
          <>
            <table className="mkt-table">
              <thead>
                <tr>
                  <th>Campaign</th><th>Sent</th><th>To</th><th>Opened</th><th>Clicked</th><th>Booked</th>
                </tr>
              </thead>
              <tbody>
                {data.campaigns.map(c => (
                  <tr key={c.id}>
                    <td>
                      <div className="mkt-name">{c.name}</div>
                      <div className="mkt-email">{c.subject}</div>
                    </td>
                    <td>{formatLocalDay(c.sent_at)}</td>
                    <td>{c.sent}</td>
                    <td>{c.opened}</td>
                    <td>{c.clicked}</td>
                    <td><strong>{c.booked}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mkt-muted">
              Booked means a recipient started a quote within 30 days of getting that
              email, counted once per person. It is a coincidence in time, not proof the
              email caused it.
            </p>
          </>
        )}
      </section>

      <section>
        <h2>Also reaching your contacts</h2>
        <p className="mkt-muted">
          These send on their own, controlled by server configuration rather than by any
          screen. They are listed here so this page accounts for every email a contact gets
          from you, not just the ones sent from this screen.
        </p>
        <ul className="mkt-heldback-list">
          {data.automations.map(a => (
            <li key={a.name}>
              <span>{a.name}</span>
              <span className="mkt-muted">{a.trigger} · {a.touches}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

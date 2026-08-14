import React, { useCallback, useEffect, useState } from 'react';
import api from '../../../utils/api';
import Icon from '../../../components/adminos/Icon';
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
        <button type="button" className="btn btn-secondary btn-sm" onClick={load}>Try again</button>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {data.campaigns.length === 0 ? (
        <div className="card">
          <div className="mkt-state">
            Nothing sent yet. Campaigns appear here once they go out.
          </div>
        </div>
      ) : (
        <div>
          <div className="tbl-wrap">
            <table className="tbl mkt-tbl-static">
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Sent</th>
                  <th className="num">To</th>
                  <th className="num">Opened</th>
                  <th className="num">Clicked</th>
                  <th className="num">Booked</th>
                </tr>
              </thead>
              <tbody>
                {data.campaigns.map(c => (
                  <tr key={c.id}>
                    <td>
                      <div className="mkt-name">{c.name}</div>
                      <div className="mkt-email">{c.subject}</div>
                    </td>
                    <td className="muted">{formatLocalDay(c.sent_at)}</td>
                    <td className="num">{c.sent}</td>
                    <td className="num">{c.opened}</td>
                    <td className="num">{c.clicked}</td>
                    <td className="num"><strong>{c.booked}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted tiny">
            Booked means a recipient started a quote within 30 days of getting that
            email, counted once per person. It is a coincidence in time, not proof the
            email caused it.
          </p>
        </div>
      )}

      <div className="card mkt-card-flush mkt-queue-static">
        <div className="card-head">
          <h3>Also reaching your contacts</h3>
          <span className="k">Server configuration</span>
        </div>
        <div className="card-body muted tiny">
          These send on their own, controlled by server configuration rather than by any
          screen. They are listed here so this page accounts for every email a contact gets
          from you, not just the ones sent from this screen.
        </div>
        <div>
          {data.automations.map(a => (
            <div className="queue-item" key={a.name}>
              <span className="queue-icon info"><Icon name="mail" size={16} /></span>
              <div className="queue-main">
                <div className="queue-title">{a.name}</div>
                <div className="queue-sub">{a.trigger}</div>
              </div>
              <span className="queue-meta">{a.touches}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

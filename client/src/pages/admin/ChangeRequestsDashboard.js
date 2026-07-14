import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import api from '../../utils/api';
import EntityLink from '../../components/EntityLink';
import { formatMoneyDelta as fmt } from '../../utils/formatDelta';
export default function ChangeRequestsDashboard() {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get('/proposals/change-requests?status=pending').then(r => setRows(r.data.requests)).catch(() => setRows([])); }, []);
  if (rows === null) return <div className="loading" role="status"><div className="spinner" />Loading...</div>;
  if (rows.length === 0) return <div className="empty-state">No pending change requests.</div>;
  return (
    <div className="page">
      <h1>Change requests</h1>
      <table className="data-table">
        <thead><tr><th>Client</th><th>Event</th><th>Window</th><th>Est. total</th><th></th></tr></thead>
        <tbody>{rows.map(r => (
          <tr key={r.id} className={r.edit_window === 'inside_t14' ? 'row-urgent' : ''}>
            <td><EntityLink to={r.client_id ? `/clients/${r.client_id}` : null}>{r.client_name}</EntityLink></td><td>{r.event_type_custom || r.event_type || 'event'}</td>
            <td>{r.edit_window.replace('_', ' ')}</td><td>{fmt(r.price_preview?.estimated_total)}</td>
            <td><Link to={`/proposals/${r.proposal_id}`}>Review</Link></td>
          </tr>))}</tbody>
      </table>
    </div>
  );
}

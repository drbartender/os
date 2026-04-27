import React from 'react';
import StatusChip from '../../../../components/adminos/StatusChip';
import { fmtDate } from '../../../../components/adminos/format';
import { getEventTypeLabel } from '../../../../utils/eventTypes';

export default function ShiftsTab({ upcoming, past, eventsLoading, navigate }) {
  if (eventsLoading) return <div className="muted">Loading shifts…</div>;
  return (
    <div className="vstack" style={{ gap: 'var(--gap)' }}>
      <div className="stat-row">
        <div className="stat"><div className="stat-label">Total shifts</div><div className="stat-value">{upcoming.length + past.length}</div></div>
        <div className="stat"><div className="stat-label">Upcoming</div><div className="stat-value">{upcoming.length}</div></div>
        <div className="stat"><div className="stat-label">Past</div><div className="stat-value">{past.length}</div></div>
        <div className="stat"><div className="stat-label">Cancellations</div><div className="stat-value">0</div></div>
      </div>

      <div className="card">
        <div className="card-head"><h3>Upcoming</h3><span className="k">{upcoming.length}</span></div>
        {upcoming.length === 0 ? (
          <div className="card-body muted tiny">No upcoming shifts.</div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Date</th><th>Event</th><th>Client</th><th>Position</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {upcoming.map(ev => (
                  <tr
                    key={`${ev.id}-up`}
                    onClick={() => ev.proposal_id ? navigate(`/events/${ev.proposal_id}`) : navigate(`/events/shift/${ev.id}`)}
                  >
                    <td>
                      <div>{ev.event_date ? fmtDate(String(ev.event_date).slice(0, 10), { year: 'numeric' }) : '—'}</div>
                      <div className="sub">{ev.start_time ? `${ev.start_time}${ev.end_time ? ` – ${ev.end_time}` : ''}` : ''}</div>
                    </td>
                    <td>
                      <strong>{getEventTypeLabel({
                        event_type: ev.event_type || ev.proposal_event_type,
                        event_type_custom: ev.event_type_custom || ev.proposal_event_type_custom,
                      })}</strong>
                      {ev.location && <div className="sub">{ev.location}</div>}
                    </td>
                    <td className="muted">{ev.client_name || '—'}</td>
                    <td className="muted">{ev.position || '—'}</td>
                    <td>
                      <StatusChip kind={ev.request_status === 'approved' ? 'ok' : 'warn'}>
                        {ev.request_status === 'approved' ? 'Confirmed' : 'Pending'}
                      </StatusChip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head"><h3>Past shifts</h3><span className="k">{past.length}</span></div>
        {past.length === 0 ? (
          <div className="card-body muted tiny">No past shifts on record.</div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Date</th><th>Event</th><th>Client</th><th>Position</th><th className="num">Guests</th>
                </tr>
              </thead>
              <tbody>
                {past.map(ev => (
                  <tr key={`${ev.id}-past`}>
                    <td>{ev.event_date ? fmtDate(String(ev.event_date).slice(0, 10), { year: 'numeric' }) : '—'}</td>
                    <td>
                      <strong>{getEventTypeLabel({
                        event_type: ev.event_type || ev.proposal_event_type,
                        event_type_custom: ev.event_type_custom || ev.proposal_event_type_custom,
                      })}</strong>
                    </td>
                    <td className="muted">{ev.client_name || '—'}</td>
                    <td className="muted">{ev.position || '—'}</td>
                    <td className="num muted">{ev.guest_count || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

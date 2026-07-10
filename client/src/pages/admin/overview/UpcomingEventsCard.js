import React from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from '../../../components/adminos/Icon';
import StaffPills from '../../../components/adminos/StaffPills';
import ClickableRow from '../../../components/ClickableRow';
import { getEventTypeLabel } from '../../../utils/eventTypes';
import { fmt$, fmtDate, relDay } from '../../../components/adminos/format';
import { shiftPositions, eventStatusChip } from '../../../components/adminos/shifts';
import StatusChip from '../../../components/adminos/StatusChip';

function eventRoute(e) {
  return e?.proposal_id ? `/events/${e.proposal_id}` : `/events/shift/${e?.id}`;
}

// Compact upcoming-events table (next 6). Ported from the old Dashboard table.
// The trailing prep column renders the drink-plan prep pill (Potions status
// vocabulary via prepFor); events with no plan render nothing, and the column
// stays collapsed to a hairline until at least one row has a pill.
export default function UpcomingEventsCard({ upcoming = [], loading = false, error = false, prepFor }) {
  const navigate = useNavigate();
  const rows = upcoming.slice(0, 6);
  const preps = rows.map(e => (prepFor && e.proposal_id ? prepFor(e.proposal_id) : null));
  const anyPrep = preps.some(Boolean);
  const prepCls = anyPrep ? 'prep-col has-prep' : 'prep-col';
  return (
    <div className="card">
      <div className="card-head">
        <h3>Upcoming events <span className="k">Live</span></h3>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/events')}>
          View all <Icon name="right" size={11} />
        </button>
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Event</th><th>Date</th><th>Staffing</th><th>Status</th>
              <th className="num">Total</th><th className="num">Balance</th>
              {/* prep column (lane e fills it) */}
              <th className={prepCls} aria-hidden={!anyPrep}>{anyPrep ? "Prep" : ""}</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="muted">Loading…</td></tr>
            )}
            {!loading && error && (
              <tr><td colSpan={7} className="muted">Couldn't load upcoming events.</td></tr>
            )}
            {!loading && !error && rows.length === 0 && (
              <tr><td colSpan={7} className="muted">No upcoming events</td></tr>
            )}
            {!loading && !error && rows.map((e, i) => {
              const total = Number(e.proposal_total || 0);
              const paid = Number(e.proposal_amount_paid || e.amount_paid || 0);
              const bal = total - paid;
              return (
                <ClickableRow key={e.id} to={eventRoute(e)}>
                  <td>
                    <strong>{e.client_name || '—'}</strong>
                    <div className="sub">{getEventTypeLabel({ event_type: e.event_type, event_type_custom: e.event_type_custom })}</div>
                  </td>
                  <td>
                    <div>{fmtDate(e.event_date.slice(0, 10))}</div>
                    <div className="sub">{relDay(e.event_date.slice(0, 10))}</div>
                  </td>
                  <td><StaffPills positions={shiftPositions(e)} /></td>
                  <td>{eventStatusChip(e)}</td>
                  <td className="num">{total > 0 ? fmt$(total) : '—'}</td>
                  <td className="num" style={{ color: bal > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : 'var(--ink-3)' }}>
                    {bal > 0 ? fmt$(bal) : '—'}
                  </td>
                  <td className={prepCls}>
                    {preps[i] && <StatusChip kind={preps[i].kind}>{preps[i].label}</StatusChip>}
                  </td>
                </ClickableRow>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

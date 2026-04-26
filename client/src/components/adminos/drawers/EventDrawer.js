import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../../utils/api';
import Drawer from '../Drawer';
import Icon from '../Icon';
import StatusChip from '../StatusChip';
import { fmt$cents, fmtDateFull } from '../format';
import { getEventTypeLabel } from '../../../utils/eventTypes';
import { eventStatusChip, parsePositionsArray, approvedCount } from '../shifts';

export default function EventDrawer({ id, open, onClose }) {
  const navigate = useNavigate();
  const [shift, setShift] = useState(null);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!open || !id) { setShift(null); setRequests([]); setErr(null); return; }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api.get(`/shifts/detail/${id}`)
      .then(r => {
        if (cancelled) return;
        setShift(r.data.shift);
        setRequests(r.data.requests || []);
      })
      .catch(e => !cancelled && setErr(e?.message || 'Failed to load event'))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [id, open]);

  const goPage = () => {
    onClose();
    if (shift?.proposal_id) navigate(`/admin/events/${shift.proposal_id}`);
    else if (shift?.id) navigate(`/admin/events/shift/${shift.id}`);
  };

  const crumb = (
    <div className="crumb" style={{ flex: 1 }}>
      <Icon name="calendar" />
      <span>Events</span>
      <span style={{ color: 'var(--ink-4)' }}>/</span>
      <span style={{ color: 'var(--ink-1)' }}>{shift?.client_name || 'Event'}</span>
    </div>
  );

  return (
    <Drawer open={open} onClose={onClose} crumb={crumb} onOpenPage={shift ? goPage : undefined}>
      {loading && <div className="muted">Loading…</div>}
      {err && <div className="chip danger">{err}</div>}
      {!loading && !err && !shift && open && <div className="muted">Event not found.</div>}
      {shift && <EventDrawerBody shift={shift} requests={requests} />}
    </Drawer>
  );
}

function EventDrawerBody({ shift, requests }) {
  const total = Number(shift.proposal_total || 0);
  const paid = Number(shift.proposal_amount_paid || shift.amount_paid || 0);
  const bal = total - paid;
  const positions = parsePositionsArray(shift.positions_needed);
  const needed = positions.length || 1;
  const filled = approvedCount(shift);
  const eventTypeLabel = getEventTypeLabel({
    event_type: shift.event_type,
    event_type_custom: shift.event_type_custom,
  });

  // Build slot rows by matching approved/pending requests to positions.
  const approvedReqs = requests.filter(r => r.status === 'approved');
  const pendingReqs = requests.filter(r => r.status === 'pending');
  const slots = positions.length
    ? positions.map((p, i) => {
        const role = typeof p === 'string' ? p : (p.position || 'Bartender');
        const req = approvedReqs[i] || pendingReqs[i - approvedReqs.length];
        return { role, request: req };
      })
    : Array.from({ length: needed }, (_, i) => {
        const req = approvedReqs[i] || pendingReqs[i - approvedReqs.length];
        return { role: 'Bartender', request: req };
      });

  return (
    <>
      <div className="drawer-hero">
        <div className="hstack" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          {shift.proposal_id ? eventStatusChip(shift) : <StatusChip kind="neutral">Manual</StatusChip>}
          <StatusChip kind={filled >= needed ? 'ok' : filled > 0 ? 'warn' : 'danger'}>
            {filled}/{needed} staffed
          </StatusChip>
          {shift.proposal_package_name && <span className="tag">{shift.proposal_package_name}</span>}
        </div>
        <h2>{shift.client_name || 'Event'}</h2>
        <div className="sub">{eventTypeLabel} · {fmtDateFull(shift.event_date && shift.event_date.slice(0, 10))}</div>

        <div className="meta">
          <div className="meta-item">
            <div className="meta-k">When</div>
            <div className="meta-v">{shift.start_time || '—'}{shift.end_time ? ` – ${shift.end_time}` : ''}</div>
          </div>
          <div className="meta-item">
            <div className="meta-k">Where</div>
            <div className="meta-v">{shift.location || '—'}</div>
          </div>
          <div className="meta-item">
            <div className="meta-k">Guests</div>
            <div className="meta-v num">{shift.guest_count || shift.proposal_guest_count || '—'}</div>
          </div>
          {total > 0 && (
            <div className="meta-item">
              <div className="meta-k">Total</div>
              <div className="meta-v num">{fmt$cents(total)}</div>
            </div>
          )}
          {total > 0 && (
            <div className="meta-item">
              <div className="meta-k">Balance</div>
              <div className="meta-v num" style={{ color: bal > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : 'hsl(var(--ok-h) var(--ok-s) 55%)' }}>
                {bal > 0 ? fmt$cents(bal) : 'Paid in full'}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="section-title">
        Staffing
        <span className="tiny muted">{filled}/{needed}</span>
      </div>
      {slots.map((slot, i) => (
        <div key={i} className="slot">
          <div className="slot-role">{slot.role}</div>
          <div className="slot-person">
            {slot.request ? (
              <>
                <div className="avatar" style={{ width: 22, height: 22, fontSize: 10 }}>
                  {(slot.request.staff_name || '?').split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase()}
                </div>
                <div>
                  <div className="slot-name">{slot.request.staff_name || slot.request.staff_email || '—'}</div>
                  <div className="tiny muted">{slot.request.status === 'approved' ? 'Confirmed' : 'Pending'}</div>
                </div>
              </>
            ) : (
              <span className="slot-empty">— Open —</span>
            )}
          </div>
        </div>
      ))}

      {(shift.client_email || shift.client_phone) && (
        <>
          <div className="section-title">Client</div>
          <dl className="dl">
            {shift.client_name && <><dt>Name</dt><dd>{shift.client_name}</dd></>}
            {shift.client_email && <><dt>Email</dt><dd>{shift.client_email}</dd></>}
            {shift.client_phone && <><dt>Phone</dt><dd>{shift.client_phone}</dd></>}
          </dl>
        </>
      )}

      {shift.proposal_id && (
        <>
          <div className="section-title">Financial</div>
          <dl className="dl">
            {shift.proposal_package_name && <><dt>Package</dt><dd>{shift.proposal_package_name}</dd></>}
            <dt>Total</dt><dd className="num">{fmt$cents(total)}</dd>
            <dt>Paid</dt><dd className="num">{fmt$cents(paid)}</dd>
            <dt>Balance</dt><dd className="num" style={{ color: bal > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : '' }}>{fmt$cents(bal)}</dd>
            <dt>Status</dt><dd>{shift.proposal_status || '—'}</dd>
          </dl>
        </>
      )}

      {shift.notes && (
        <>
          <div className="section-title">Notes</div>
          <div style={{ color: 'var(--ink-2)', fontSize: 13, whiteSpace: 'pre-wrap' }}>{shift.notes}</div>
        </>
      )}

      <div style={{ height: 24 }} />
    </>
  );
}

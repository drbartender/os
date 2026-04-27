import React, { useEffect, useState, useCallback } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import { getEventTypeLabel } from '../../../utils/eventTypes';
import Drawer from '../Drawer';
import Icon from '../Icon';
import StatusChip from '../StatusChip';
import { fmtDateFull } from '../format';
import { parsePositionsArray, approvedCount } from '../shifts';

// ShiftDrawer — focused per-shift management surface launched from EventDetailPage.
// Replaces the legacy /events/shift/:id page.
//
// Data: GET /shifts/detail/:id returns { shift, requests } in one round-trip.
// Actions all hit existing endpoints (no new server routes):
//   - Approve request → POST /shifts/:id/assign  { user_id, position }
//   - Deny request    → PUT  /shifts/requests/:requestId { status: 'denied' }
//   - Remove staff    → DELETE /shifts/requests/:requestId
//   - Manual assign   → POST /shifts/:id/assign  { user_id, position }
// (SMS notifications are sent server-side on approve/assign — no separate SMS button.)
export default function ShiftDrawer({ shiftId, open, onClose }) {
  const toast = useToast();
  const [shift, setShift] = useState(null);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const [activeStaff, setActiveStaff] = useState([]);
  const [showPicker, setShowPicker] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedStaff, setSelectedStaff] = useState(null);
  const [pickerPosition, setPickerPosition] = useState('');
  const [busy, setBusy] = useState(false);

  const loadShift = useCallback(() => {
    if (!shiftId) return;
    setLoading(true);
    setErr(null);
    api.get(`/shifts/detail/${shiftId}`)
      .then(r => {
        setShift(r.data?.shift || null);
        setRequests(r.data?.requests || []);
      })
      .catch(e => setErr(e?.message || 'Failed to load shift'))
      .finally(() => setLoading(false));
  }, [shiftId]);

  useEffect(() => {
    if (!open || !shiftId) {
      setShift(null);
      setRequests([]);
      setErr(null);
      setShowPicker(false);
      setSearch('');
      setSelectedStaff(null);
      setPickerPosition('');
      return;
    }
    loadShift();
  }, [open, shiftId, loadShift]);

  // Load active-staff list once when drawer opens — used for manual-assign picker.
  useEffect(() => {
    if (!open || !shiftId) return;
    api.get('/admin/active-staff?limit=100')
      .then(r => setActiveStaff(r.data?.staff || []))
      .catch(() => {});
  }, [open, shiftId]);

  const handleApprove = async (req) => {
    setBusy(true);
    try {
      await api.post(`/shifts/${shiftId}/assign`, {
        user_id: req.user_id,
        position: req.position || 'Bartender',
      });
      toast.success('Request approved.');
      loadShift();
    } catch (e) {
      toast.error(e?.message || 'Failed to approve request.');
    } finally {
      setBusy(false);
    }
  };

  const handleDeny = async (req) => {
    setBusy(true);
    try {
      await api.put(`/shifts/requests/${req.id}`, { status: 'denied' });
      toast.success('Request denied.');
      loadShift();
    } catch (e) {
      toast.error(e?.message || 'Failed to deny request.');
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (req) => {
    if (!window.confirm(`Remove ${req.staff_name || 'this staff member'} from the shift?`)) return;
    setBusy(true);
    try {
      await api.delete(`/shifts/requests/${req.id}`);
      toast.success('Removed.');
      loadShift();
    } catch (e) {
      toast.error(e?.message || 'Failed to remove.');
    } finally {
      setBusy(false);
    }
  };

  const handleManualAssign = async () => {
    if (!selectedStaff) return;
    setBusy(true);
    try {
      await api.post(`/shifts/${shiftId}/assign`, {
        user_id: selectedStaff.id,
        position: pickerPosition || 'Bartender',
      });
      toast.success('Staff assigned.');
      setShowPicker(false);
      setSearch('');
      setSelectedStaff(null);
      setPickerPosition('');
      loadShift();
    } catch (e) {
      toast.error(e?.message || 'Failed to assign staff.');
    } finally {
      setBusy(false);
    }
  };

  const filteredStaff = search.length >= 2
    ? activeStaff.filter(s => {
        const name = (s.preferred_name || s.email || '').toLowerCase();
        return name.includes(search.toLowerCase());
      }).slice(0, 8)
    : [];

  const positions = parsePositionsArray(shift?.positions_needed);
  const needed = positions.length || 1;
  const filled = approvedCount({
    approved_count: requests.filter(r => r.status === 'approved').length,
  });
  const approvedReqs = requests.filter(r => r.status === 'approved');
  const pendingReqs = requests.filter(r => r.status === 'pending');
  const openCount = Math.max(0, needed - filled);
  const eventTypeLabel = shift
    ? getEventTypeLabel({ event_type: shift.event_type, event_type_custom: shift.event_type_custom })
    : 'Shift';

  const crumb = (
    <div className="crumb" style={{ flex: 1 }}>
      <Icon name="userplus" />
      <span>Staffing</span>
      <span style={{ color: 'var(--ink-4)' }}>/</span>
      <span style={{ color: 'var(--ink-1)' }}>{shift?.client_name || eventTypeLabel}</span>
    </div>
  );

  return (
    <Drawer open={open} onClose={onClose} crumb={crumb}>
      {loading && <div className="muted">Loading…</div>}
      {err && <div className="chip danger">{err}</div>}
      {!loading && !err && !shift && open && <div className="muted">Shift not found.</div>}
      {shift && (
        <>
          <div className="drawer-hero">
            <div className="hstack" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <StatusChip kind={filled >= needed ? 'ok' : filled > 0 ? 'warn' : 'danger'}>
                {filled}/{needed} staffed
              </StatusChip>
              {pendingReqs.length > 0 && (
                <StatusChip kind="info">
                  {pendingReqs.length} pending
                </StatusChip>
              )}
            </div>
            <h2>{shift.client_name || eventTypeLabel}</h2>
            <div className="sub">
              {eventTypeLabel}
              {shift.event_date && ` · ${fmtDateFull(String(shift.event_date).slice(0, 10))}`}
            </div>

            <div className="meta">
              <div className="meta-item">
                <div className="meta-k">When</div>
                <div className="meta-v">
                  {shift.start_time || '—'}
                  {shift.end_time ? ` – ${shift.end_time}` : ''}
                </div>
              </div>
              <div className="meta-item">
                <div className="meta-k">Where</div>
                <div className="meta-v">{shift.location || '—'}</div>
              </div>
              <div className="meta-item">
                <div className="meta-k">Guests</div>
                <div className="meta-v num">{shift.guest_count || '—'}</div>
              </div>
            </div>
          </div>

          <div className="section-title">
            Assigned
            <span className="tiny muted">{approvedReqs.length}/{needed}</span>
          </div>
          {approvedReqs.length === 0 ? (
            <div className="muted tiny">No staff assigned yet.</div>
          ) : (
            approvedReqs.map(req => (
              <div key={req.id} className="slot">
                <div className="slot-role">{req.position || 'Bartender'}</div>
                <div className="slot-person">
                  <div className="avatar" style={{ width: 22, height: 22, fontSize: 10 }}>
                    {(req.staff_name || '?').split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="slot-name">{req.staff_name || req.staff_email || '—'}</div>
                    <div className="tiny muted">Confirmed</div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => handleRemove(req)}
                    title="Remove from shift"
                  >
                    <Icon name="x" size={11} />Remove
                  </button>
                </div>
              </div>
            ))
          )}

          {pendingReqs.length > 0 && (
            <>
              <div className="section-title">
                Pending requests
                <span className="tiny muted">{pendingReqs.length}</span>
              </div>
              {pendingReqs.map(req => (
                <div key={req.id} className="slot">
                  <div className="slot-role">{req.position || 'Bartender'}</div>
                  <div className="slot-person">
                    <div className="avatar" style={{ width: 22, height: 22, fontSize: 10 }}>
                      {(req.staff_name || '?').split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="slot-name">{req.staff_name || req.staff_email || '—'}</div>
                      <div className="tiny muted">Awaiting approval</div>
                    </div>
                    <div className="hstack" style={{ gap: 4 }}>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busy}
                        onClick={() => handleApprove(req)}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busy}
                        onClick={() => handleDeny(req)}
                      >
                        Deny
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </>
          )}

          {openCount > 0 && (
            <>
              <div className="section-title">
                Add staff manually
                <span className="tiny muted">{openCount} open</span>
              </div>
              {!showPicker ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setShowPicker(true)}
                >
                  <Icon name="plus" size={11} />Assign someone
                </button>
              ) : (
                <div className="staff-assign-wrapper">
                  <input
                    className="staff-assign-search"
                    placeholder="Search staff by name…"
                    value={search}
                    onChange={e => { setSearch(e.target.value); setSelectedStaff(null); }}
                    autoFocus
                  />
                  {filteredStaff.length > 0 && !selectedStaff && (
                    <div className="staff-assign-dropdown">
                      {filteredStaff.map(s => (
                        <div
                          key={s.id}
                          className="staff-assign-item"
                          onClick={() => {
                            setSelectedStaff(s);
                            setSearch(s.preferred_name || s.email);
                          }}
                        >
                          <div className="staff-assign-item-name">{s.preferred_name || s.email}</div>
                          <div className="staff-assign-item-meta">
                            {s.email}{s.city ? ` · ${s.city}` : ''}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {selectedStaff && (
                    <div
                      className="hstack"
                      style={{ marginTop: 8, gap: 6, flexWrap: 'wrap' }}
                    >
                      <select
                        className="form-select"
                        value={pickerPosition}
                        onChange={e => setPickerPosition(e.target.value)}
                        style={{ fontSize: 12.5, padding: '4px 8px' }}
                      >
                        <option value="">Position…</option>
                        <option value="Bartender">Bartender</option>
                        <option value="Barback">Barback</option>
                        <option value="Server">Server</option>
                      </select>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busy}
                        onClick={handleManualAssign}
                      >
                        {busy ? 'Assigning…' : 'Assign'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          setShowPicker(false);
                          setSearch('');
                          setSelectedStaff(null);
                          setPickerPosition('');
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {shift.notes && (
            <>
              <div className="section-title">Notes</div>
              <div style={{ color: 'var(--ink-2)', fontSize: 13, whiteSpace: 'pre-wrap' }}>
                {shift.notes}
              </div>
            </>
          )}

          <div style={{ height: 24 }} />
        </>
      )}
    </Drawer>
  );
}

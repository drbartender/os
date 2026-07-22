import React, { useEffect, useState, useCallback, useMemo } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import { getEventTypeLabel } from '../../../utils/eventTypes';
import {
  parsePositionsNeeded,
  rosterCounts,
  computeRemaining,
  classifyRequest,
  isEventFullyStaffed,
  canonicalizeRole,
  defaultAssignRole,
  CANONICAL_LABELS,
} from '../../../utils/staffingRoles';
import Drawer from '../Drawer';
import Icon from '../Icon';
import { fmtTime24 } from '../format';
import StatusChip from '../StatusChip';
import { fmtDateFull } from '../format';
import {
  SHIFT_EQUIPMENT_OPTIONS,
  parseEquipmentArray,
} from '../shifts';
import EntityLink from '../../EntityLink';

// ShiftDrawer — focused per-shift management surface launched from EventDetailPage.
// Replaces the legacy /events/shift/:id page.
//
// Data: GET /shifts/detail/:id returns { shift, requests } in one round-trip.
// Each request row carries requested_positions (ranked roles), position, status,
// transport_acknowledged_at, and the requester's reliable_transportation.
//
// Money seam: approval/assignment writes the `position` column that payroll keys
// on. On an APPROVAL it is resolved from the request's ranked requested_positions
// against per-role remaining; when the only open slot is a role the staffer did
// not rank, the admin must pick a canonical role and that override is sent. The
// MANUAL-ASSIGN picker preselects a role (defaultAssignRole: first open slot in
// Bartender / Banquet Server / Barback order) — a visible, changeable dropdown
// value, never a silent one. The server still refuses a request with no explicit
// position, which is what keeps an unseen role out of payroll.
//
// Actions:
//   - Approve request → POST /shifts/:id/assign  { user_id, position }
//   - Deny request    → PUT  /shifts/requests/:requestId { status: 'denied' }
//   - Remove staff    → DELETE /shifts/requests/:requestId
//   - Manual assign   → POST /shifts/:id/assign  { user_id, position }
//   - Edit logistics  → PUT  /shifts/:id { equipment_required } OR { supply_run }
//
// onUpdate (optional) fires after any mutation so a parent surface can refetch.

// Maps a contractor_profiles.reliable_transportation value (case-insensitive)
// to a logistics warning. Only surfaced when the event is transport-required.
function transportFlag(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  if (v === '' || v === 'no') {
    return { kind: 'danger', label: 'No transportation on file' };
  }
  if (v === 'maybe' || v === 'sometimes') {
    return { kind: 'warn', label: 'Transportation uncertain' };
  }
  // 'yes' (and any other affirmative value) → no warning.
  return null;
}

export default function ShiftDrawer({ shiftId, open, onClose, onUpdate }) {
  const toast = useToast();
  const [shift, setShift] = useState(null);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const [activeStaff, setActiveStaff] = useState([]);
  const [showPicker, setShowPicker] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedStaff, setSelectedStaff] = useState(null);
  // The admin's EXPLICIT manual-assign role choice. '' means "untouched, use the
  // computed default" — see pickerRole below. Storing the override rather than
  // the effective value is what lets the default track a shift reload while the
  // picker is open without ever clobbering a hand-picked role.
  const [pickerPosition, setPickerPosition] = useState('');
  const [busy, setBusy] = useState(false);

  // Per-request admin role override (requestId -> canonical role). Only used
  // when a pending request has no open ranked role and the admin must choose.
  const [overrideRole, setOverrideRole] = useState({});

  // Logistics edit surface state.
  const [equipDraft, setEquipDraft] = useState([]);
  const [supplyDraft, setSupplyDraft] = useState(false);
  const [savingEquip, setSavingEquip] = useState(false);
  const [savingSupply, setSavingSupply] = useState(false);

  const loadShift = useCallback(() => {
    if (!shiftId) return;
    setLoading(true);
    setErr(null);
    api.get(`/shifts/detail/${shiftId}`)
      .then(r => {
        const sh = r.data?.shift || null;
        setShift(sh);
        setRequests(r.data?.requests || []);
        setEquipDraft(parseEquipmentArray(sh?.equipment_required));
        setSupplyDraft(!!sh?.supply_run_required);
        setOverrideRole({});
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
      setOverrideRole({});
      setEquipDraft([]);
      setSupplyDraft(false);
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

  // ----- Derived staffing math (per-role, computed live from the requests) -----
  const roster = useMemo(
    () => parsePositionsNeeded(shift?.positions_needed),
    [shift]
  );
  const neededByRole = useMemo(() => rosterCounts(roster), [roster]);

  // `dropped_at` is load-bearing here, not tidying. An EMERGENCY drop
  // (staffShiftActions.js) sets dropped_at and deliberately LEAVES status
  // 'approved', and GET /shifts/detail/:id returns every request row unfiltered,
  // so a bare status check counts a staffer who already bailed as filling their
  // slot. That under-reports `remaining`, which now feeds the assign picker's
  // default role — the exact <72h replacement case the picker exists for. Every
  // server-side aggregate pairs these two conditions; so does this.
  const approvedReqs = useMemo(
    () => requests.filter(r => r.status === 'approved' && !r.dropped_at),
    [requests]
  );
  const pendingReqs = useMemo(
    () => requests.filter(r => r.status === 'pending'),
    [requests]
  );

  // Approved-active counts per role, keyed by the canonical position written at
  // approval. This is the money-side truth the classifier runs against.
  const approvedByRole = useMemo(() => {
    const counts = {};
    for (const r of approvedReqs) {
      const role = canonicalizeRole(r.position);
      if (role) counts[role] = (counts[role] || 0) + 1;
    }
    return counts;
  }, [approvedReqs]);

  const remaining = useMemo(
    () => computeRemaining(roster, approvedByRole),
    [roster, approvedByRole]
  );

  const fullyStaffed = useMemo(
    () => roster.length > 0 && isEventFullyStaffed(remaining),
    [roster, remaining]
  );

  // The role the manual-assign picker shows. An explicit pick wins; otherwise the
  // computed default, which re-derives whenever the shift reloads.
  const pickerRole = pickerPosition || defaultAssignRole(roster, remaining);

  // The event needs transport coordination (gear haul or supply run), which gates
  // whether the requester's transportation flag is shown for waitlisted rows.
  const transportRequired = useMemo(() => {
    const equip = parseEquipmentArray(shift?.equipment_required);
    return equip.length > 0 || !!shift?.supply_run_required;
  }, [shift]);

  // Classify each pending request against the CURRENT per-role remaining.
  const classifiedPending = useMemo(() => {
    return pendingReqs.map(req => {
      const reqRoles = parsePositionsNeeded(req.requested_positions);
      const { state, resolvableRole } = classifyRequest(reqRoles, remaining);
      return { req, reqRoles, state, resolvableRole };
    });
  }, [pendingReqs, remaining]);

  const actionable = classifiedPending.filter(c => c.state === 'actionable');
  const waitlisted = classifiedPending.filter(c => c.state === 'waitlisted');

  const totalNeeded = roster.length;
  const totalApproved = approvedReqs.length;

  // ----- Money seam: approve -----
  // Resolves the canonical position for an APPROVAL. Returns { position } when
  // resolvable (a ranked role is open, OR the admin chose an explicit override),
  // or { error } when neither is available. Approval never defaults: the role
  // comes from what the staffer actually ranked, or from a deliberate override.
  // (Manual assign is the other path, and it DOES preselect — see pickerRole.)
  const resolveApprovalPosition = useCallback((classified) => {
    const override = overrideRole[classified.req.id];
    if (override) {
      const role = canonicalizeRole(override);
      if (!role) return { error: 'Pick a valid role before approving.' };
      return { position: role };
    }
    if (classified.resolvableRole) {
      return { position: classified.resolvableRole };
    }
    return { error: 'No open ranked role. Pick a role to approve into.' };
  }, [overrideRole]);

  const handleApprove = async (classified) => {
    const resolved = resolveApprovalPosition(classified);
    if (resolved.error) {
      toast.error(resolved.error);
      return;
    }
    const position = resolved.position;
    // Approving into a role that has no remaining slot (admin over-fill via an
    // explicit override) is a deliberate action and needs a confirm.
    // Only an event with a real roster can be "over-filled"; a roster-less legacy
    // shift has no per-role capacity to exceed, so skip the confirm there.
    if (roster.length > 0 && (remaining[position] || 0) <= 0) {
      if (!window.confirm(
        `${position} is already fully staffed for this shift. Approve anyway and over-fill the role?`
      )) {
        return;
      }
    }
    setBusy(true);
    try {
      await api.post(`/shifts/${shiftId}/assign`, {
        user_id: classified.req.user_id,
        position,
      });
      toast.success('Request approved.');
      loadShift();
      onUpdate?.();
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
      onUpdate?.();
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
      onUpdate?.();
    } catch (e) {
      toast.error(e?.message || 'Failed to remove.');
    } finally {
      setBusy(false);
    }
  };

  const handleManualAssign = async () => {
    if (!selectedStaff) return;
    // pickerRole is always a canonical label (an explicit pick from the select,
    // or defaultAssignRole's output). Re-canonicalizing is belt-and-braces: the
    // request body must never carry a non-canonical position to the money seam.
    const role = canonicalizeRole(pickerRole);
    if (!role) {
      toast.error('Pick a position before assigning.');
      return;
    }
    if (roster.length > 0 && (remaining[role] || 0) <= 0) {
      if (!window.confirm(
        `${role} is already fully staffed for this shift. Assign anyway and over-fill the role?`
      )) {
        return;
      }
    }
    setBusy(true);
    try {
      await api.post(`/shifts/${shiftId}/assign`, {
        user_id: selectedStaff.id,
        position: role,
      });
      toast.success('Staff assigned.');
      setShowPicker(false);
      setSearch('');
      setSelectedStaff(null);
      setPickerPosition('');
      loadShift();
      onUpdate?.();
    } catch (e) {
      toast.error(e?.message || 'Failed to assign staff.');
    } finally {
      setBusy(false);
    }
  };

  // ----- Logistics edit -----
  const toggleEquip = (token, checked) => {
    setEquipDraft(prev => {
      if (checked) return prev.includes(token) ? prev : [...prev, token];
      return prev.filter(t => t !== token);
    });
  };

  const savedEquip = parseEquipmentArray(shift?.equipment_required);
  const equipDirty =
    equipDraft.length !== savedEquip.length ||
    equipDraft.some(t => !savedEquip.includes(t));
  const supplyDirty = supplyDraft !== !!shift?.supply_run_required;

  // Equipment and supply save as separate PUTs — editing equipment must not send
  // supply_run, and vice-versa (each call flips a distinct server flag).
  const handleSaveEquip = async () => {
    setSavingEquip(true);
    try {
      await api.put(`/shifts/${shiftId}`, { equipment_required: equipDraft });
      toast.success('Equipment updated.');
      loadShift();
      onUpdate?.();
    } catch (e) {
      toast.error(e?.message || 'Failed to update equipment.');
    } finally {
      setSavingEquip(false);
    }
  };

  const handleSaveSupply = async (nextValue) => {
    setSavingSupply(true);
    try {
      await api.put(`/shifts/${shiftId}`, { supply_run: nextValue });
      setSupplyDraft(nextValue);
      toast.success(nextValue ? 'Supply run required.' : 'Supply run cleared.');
      loadShift();
      onUpdate?.();
    } catch (e) {
      toast.error(e?.message || 'Failed to update supply run.');
    } finally {
      setSavingSupply(false);
    }
  };

  const filteredStaff = search.length >= 2
    ? activeStaff.filter(s => {
        const name = (s.preferred_name || s.email || '').toLowerCase();
        return name.includes(search.toLowerCase());
      }).slice(0, 8)
    : [];

  // Roster summary line: "Bartender 2/2 · Banquet Server 0/1".
  const roleSummary = Object.keys(neededByRole).map(role => {
    const need = neededByRole[role];
    const have = approvedByRole[role] || 0;
    return `${role} ${Math.min(have, need)}/${need}`;
  });

  const eventTypeLabel = shift
    ? getEventTypeLabel({ event_type: shift.event_type, event_type_custom: shift.event_type_custom })
    : 'Shift';

  const crumb = (
    <div className="crumb" style={{ flex: 1 }}>
      <Icon name="userplus" />
      <span>Staffing</span>
      <span style={{ color: 'var(--ink-4)' }}>/</span>
      <span style={{ color: 'var(--ink-1)' }}>
        <EntityLink to={shift?.client_id ? `/clients/${shift.client_id}` : null}>
          {shift?.client_name || eventTypeLabel}
        </EntityLink>
      </span>
    </div>
  );

  // Roles still open (remaining > 0) drive the manual-assign role options and the
  // per-role "fully staffed" rendering. Falls back to all canonical labels when
  // the roster is empty/legacy so manual assignment is never blocked.
  const openRoles = Object.keys(remaining).filter(role => (remaining[role] || 0) > 0);
  const assignableRoles = roster.length ? Object.keys(neededByRole) : CANONICAL_LABELS;

  return (
    <Drawer open={open} onClose={onClose} crumb={crumb}>
      {loading && <div className="muted">Loading…</div>}
      {err && <div className="chip danger">{err}</div>}
      {!loading && !err && !shift && open && <div className="muted">Shift not found.</div>}
      {shift && (
        <>
          <div className="drawer-hero">
            <div className="hstack" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <StatusChip kind={fullyStaffed ? 'ok' : totalApproved > 0 ? 'warn' : 'danger'}>
                {totalApproved}/{totalNeeded} staffed
              </StatusChip>
              {actionable.length > 0 && (
                <StatusChip kind="info">
                  {actionable.length} to review
                </StatusChip>
              )}
              {waitlisted.length > 0 && (
                <StatusChip kind="neutral">
                  {waitlisted.length} on waitlist
                </StatusChip>
              )}
            </div>
            <h2><EntityLink to={shift.client_id ? `/clients/${shift.client_id}` : null}>{shift.client_name || eventTypeLabel}</EntityLink></h2>
            <div className="sub">
              {eventTypeLabel}
              {shift.event_date && ` · ${fmtDateFull(String(shift.event_date).slice(0, 10))}`}
            </div>
            {roleSummary.length > 0 && (
              <div className="tiny muted" style={{ marginTop: 6 }}>
                {roleSummary.join(' · ')}
              </div>
            )}

            <div className="meta">
              <div className="meta-item">
                <div className="meta-k">When</div>
                <div className="meta-v">
                  {fmtTime24(shift.start_time) || '—'}
                  {shift.end_time ? ` – ${fmtTime24(shift.end_time)}` : ''}
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
            <span className="tiny muted">{totalApproved}/{totalNeeded}</span>
          </div>
          {approvedReqs.length === 0 ? (
            <div className="muted tiny">No staff assigned yet.</div>
          ) : (
            approvedReqs.map(req => (
              <div key={req.id} className="slot">
                <div className="slot-role">{canonicalizeRole(req.position) || req.position || 'Staff'}</div>
                <div className="slot-person">
                  <div className="avatar" style={{ width: 22, height: 22, fontSize: 10 }}>
                    {(req.staff_name || '?').split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="slot-name"><EntityLink to={req.user_id ? `/staffing/users/${req.user_id}` : null}>{req.staff_name || req.staff_email || '—'}</EntityLink></div>
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

          {actionable.length > 0 && (
            <>
              <div className="section-title">
                Pending requests
                <span className="tiny muted">{actionable.length}</span>
              </div>
              {actionable.map(({ req, reqRoles, resolvableRole }) => {
                const override = overrideRole[req.id];
                const canApprove = !!resolvableRole || !!override;
                return (
                  <div key={req.id} className="slot">
                    <div className="slot-role">
                      {resolvableRole || canonicalizeRole(req.position) || 'Staff'}
                    </div>
                    <div className="slot-person">
                      <div className="avatar" style={{ width: 22, height: 22, fontSize: 10 }}>
                        {(req.staff_name || '?').split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase()}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="slot-name"><EntityLink to={req.user_id ? `/staffing/users/${req.user_id}` : null}>{req.staff_name || req.staff_email || '—'}</EntityLink></div>
                        <div className="tiny muted">
                          {reqRoles.length ? `Ranked: ${reqRoles.join(' › ')}` : 'Awaiting approval'}
                        </div>
                      </div>
                      <div className="hstack" style={{ gap: 4 }}>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={busy || !canApprove}
                          onClick={() => handleApprove({ req, reqRoles, resolvableRole })}
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
                );
              })}
            </>
          )}

          {waitlisted.length > 0 && (
            <>
              <div className="section-title">
                Waitlist
                <span className="tiny muted">{waitlisted.length}</span>
              </div>
              <div className="muted tiny" style={{ marginBottom: 6 }}>
                No open slot matches the roles these staffers ranked. Approving still
                over-fills a role; pick a role below to do it deliberately.
              </div>
              {waitlisted.map(({ req, reqRoles }) => {
                const flag = transportRequired ? transportFlag(req.staff_reliable_transportation) : null;
                const acked = !!req.transport_acknowledged_at;
                const override = overrideRole[req.id];
                return (
                  <div key={req.id} className="slot">
                    <div className="slot-role">Waitlist</div>
                    <div className="slot-person" style={{ flexWrap: 'wrap' }}>
                      <div className="avatar" style={{ width: 22, height: 22, fontSize: 10 }}>
                        {(req.staff_name || '?').split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase()}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="slot-name"><EntityLink to={req.user_id ? `/staffing/users/${req.user_id}` : null}>{req.staff_name || req.staff_email || '—'}</EntityLink></div>
                        <div className="tiny muted">
                          {reqRoles.length ? `Ranked: ${reqRoles.join(' › ')}` : 'Any role'}
                        </div>
                        <div className="hstack" style={{ gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                          {flag && (
                            <StatusChip kind={flag.kind}>{flag.label}</StatusChip>
                          )}
                          {transportRequired && (
                            <StatusChip kind={acked ? 'ok' : 'neutral'}>
                              {acked ? 'Transport acknowledged' : 'Transport not acknowledged'}
                            </StatusChip>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="hstack" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                      <select
                        className="select"
                        value={override || ''}
                        onChange={e => setOverrideRole(prev => ({ ...prev, [req.id]: e.target.value }))}
                      >
                        <option value="">Approve into role…</option>
                        {assignableRoles.map(role => (
                          <option key={role} value={role}>{role}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busy || !override}
                        onClick={() => handleApprove({ req, reqRoles, resolvableRole: null })}
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
                );
              })}
            </>
          )}

          <div className="section-title">
            Add staff manually
            {openRoles.length > 0 ? (
              <span className="tiny muted">{openRoles.join(', ')} open</span>
            ) : (
              <span className="tiny muted">all roles full</span>
            )}
          </div>
          {fullyStaffed && (
            <div className="muted tiny" style={{ marginBottom: 6 }}>
              Every role is fully staffed. Assigning will over-fill a role.
            </div>
          )}
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
                    className="select"
                    value={pickerRole}
                    onChange={e => setPickerPosition(e.target.value)}
                  >
                    {assignableRoles.map(role => (
                      <option key={role} value={role}>{role}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy}
                    onClick={handleManualAssign}
                  >
                    {busy ? 'Assigning…' : `Assign as ${pickerRole}`}
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

          <div className="section-title">Logistics</div>
          <div className="vstack" style={{ gap: 10 }}>
            <div>
              <div className="meta-k" style={{ marginBottom: 4 }}>Equipment required</div>
              <div className="hstack" style={{ flexWrap: 'wrap', gap: 14 }}>
                {SHIFT_EQUIPMENT_OPTIONS.map(([token, label]) => (
                  <label key={token} className="hstack" style={{ gap: 6, fontSize: 13, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={equipDraft.includes(token)}
                      disabled={savingEquip}
                      onChange={e => toggleEquip(token, e.target.checked)}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div className="hstack" style={{ gap: 8, marginTop: 8 }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={!equipDirty || savingEquip}
                  onClick={handleSaveEquip}
                >
                  {savingEquip ? 'Saving…' : 'Save equipment'}
                </button>
                {equipDirty && !savingEquip && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setEquipDraft(parseEquipmentArray(shift?.equipment_required))}
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>

            <div>
              <label className="hstack" style={{ gap: 8, fontSize: 13, cursor: savingSupply ? 'default' : 'pointer' }}>
                <input
                  type="checkbox"
                  checked={supplyDraft}
                  disabled={savingSupply}
                  onChange={e => handleSaveSupply(e.target.checked)}
                />
                Supply run required (staff picks up consumables before the event)
              </label>
              {supplyDirty && (
                <div className="tiny muted" style={{ marginTop: 4 }}>
                  {savingSupply ? 'Saving…' : 'Saved.'}
                </div>
              )}
              {!supplyDirty && shift?.supply_run_overridden && (
                <div className="tiny muted" style={{ marginTop: 4 }}>
                  Manually set (overrides the package default).
                </div>
              )}
            </div>
          </div>

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

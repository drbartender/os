import React, { useState, useEffect } from 'react';
import api from '../../../../utils/api';
import { getEventTypeLabel } from '../../../../utils/eventTypes';
import Icon from '../../../../components/adminos/Icon';
import StatusChip from '../../../../components/adminos/StatusChip';
import { fmtDate, relDay } from '../../../../components/adminos/format';
import { parsePositions } from '../helpers';

export default function AssignToEventModal({ userId, staffName, onClose, onAssigned, toast }) {
  const [shifts, setShifts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [assigning, setAssigning] = useState(null); // shift id currently being assigned
  const [assigned, setAssigned] = useState({}); // shift id -> position assigned (for in-modal feedback)
  const [positionByShift, setPositionByShift] = useState({});

  useEffect(() => {
    api.get('/shifts/unstaffed-upcoming')
      .then(r => setShifts(Array.isArray(r.data) ? r.data : []))
      .catch(() => toast.error('Failed to load shifts.'))
      .finally(() => setLoading(false));
  }, [toast]);

  // Esc to close
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const filtered = shifts.filter(s => {
    if (!search) return true;
    const q = search.toLowerCase();
    const fields = [s.client_name, s.event_type, s.event_type_custom, s.location].filter(Boolean).join(' ').toLowerCase();
    return fields.includes(q);
  }).sort((a, b) => (a.event_date || '').localeCompare(b.event_date || ''));

  const assignToShift = async (shift) => {
    const positions = parsePositions(shift.positions_needed);
    const fallbackPosition = positions[0] || 'Bartender';
    const position = positionByShift[shift.id] || fallbackPosition;
    setAssigning(shift.id);
    try {
      await api.post(`/shifts/${shift.id}/assign`, {
        user_id: Number(userId),
        position,
      });
      setAssigned(a => ({ ...a, [shift.id]: position }));
      onAssigned?.();
      toast.success(`Assigned to ${shift.client_name || 'event'}.`);
    } catch (err) {
      toast.error(err.message || 'Failed to assign.');
    } finally {
      setAssigning(null);
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        zIndex: 1000, padding: '5vh 1rem 1rem',
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{
          maxWidth: 720, width: '100%',
          maxHeight: '85vh',
          padding: 0,
          display: 'flex', flexDirection: 'column',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--line-1)',
            display: 'flex', alignItems: 'center', gap: 10,
          }}
        >
          <Icon name="userplus" size={14} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>Assign {staffName} to an event</h3>
            <div className="tiny muted" style={{ marginTop: 2 }}>
              Showing upcoming shifts that still need staff. Sends an SMS + email on assign.
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        </div>

        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--line-1)' }}>
          <div className="input-group" style={{ padding: '0 10px' }}>
            <Icon name="search" />
            <input
              autoFocus
              placeholder="Filter by client, event, or location…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="scroll-thin" style={{ flex: 1, overflow: 'auto', padding: '8px 18px 18px' }}>
          {loading ? (
            <div className="muted tiny" style={{ padding: 12 }}>Loading shifts…</div>
          ) : filtered.length === 0 ? (
            <div className="muted tiny" style={{ padding: 12 }}>
              {shifts.length === 0
                ? 'No upcoming unstaffed shifts. Everyone is covered.'
                : 'No shifts match this search.'}
            </div>
          ) : (
            <div className="vstack" style={{ gap: 8 }}>
              {filtered.map(s => {
                const positions = parsePositions(s.positions_needed);
                const needed = positions.length || Number(s.bartenders_needed || 1);
                const filled = Number(s.approved_count || 0);
                const open = Math.max(0, needed - filled);
                const isAssigned = assigned[s.id];
                const positionOptions = positions.length ? Array.from(new Set(positions)) : ['Bartender'];
                const selectedPosition = positionByShift[s.id] || positionOptions[0];

                return (
                  <div
                    key={s.id}
                    style={{
                      padding: 12,
                      border: '1px solid var(--line-1)',
                      borderRadius: 4,
                      background: isAssigned ? 'hsl(var(--ok-h) var(--ok-s) 50% / 0.06)' : 'var(--bg-1)',
                    }}
                  >
                    <div className="hstack" style={{ alignItems: 'flex-start', gap: 12 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="hstack" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                          <strong style={{ fontSize: 13 }}>{s.client_name || 'Event'}</strong>
                          <StatusChip kind={open === 0 ? 'ok' : open <= 1 ? 'warn' : 'danger'}>
                            {filled}/{needed} staffed
                          </StatusChip>
                          {isAssigned && <StatusChip kind="ok">Assigned</StatusChip>}
                        </div>
                        <div className="tiny" style={{ color: 'var(--ink-2)' }}>
                          {getEventTypeLabel({ event_type: s.event_type, event_type_custom: s.event_type_custom })}
                        </div>
                        <div className="tiny muted" style={{ marginTop: 2 }}>
                          {s.event_date ? fmtDate(String(s.event_date).slice(0, 10), { year: 'numeric' }) : '—'}
                          {s.event_date ? ` · ${relDay(String(s.event_date).slice(0, 10))}` : ''}
                          {s.start_time ? ` · ${s.start_time}` : ''}
                          {s.location ? ` · ${s.location}` : ''}
                        </div>
                      </div>
                      <div className="hstack" style={{ gap: 6, flexShrink: 0 }}>
                        {positionOptions.length > 1 && !isAssigned && (
                          <select
                            className="select"
                            style={{ width: 130 }}
                            value={selectedPosition}
                            onChange={(e) => setPositionByShift(p => ({ ...p, [s.id]: e.target.value }))}
                          >
                            {positionOptions.map(p => <option key={p} value={p}>{p}</option>)}
                          </select>
                        )}
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={!!assigning || isAssigned}
                          onClick={() => assignToShift(s)}
                        >
                          {assigning === s.id ? 'Assigning…' : isAssigned ? `Assigned as ${isAssigned}` : `Assign as ${selectedPosition}`}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div
          style={{
            padding: '10px 18px',
            borderTop: '1px solid var(--line-1)',
            display: 'flex', gap: 6, justifyContent: 'flex-end',
          }}
        >
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

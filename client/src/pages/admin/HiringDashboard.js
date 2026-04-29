import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import StatusChip from '../../components/adminos/StatusChip';
import InterviewScheduleModal from '../../components/adminos/InterviewScheduleModal';

const COLUMNS = [
  { key: 'applied',      label: 'Applied',     hint: 'Awaiting first review' },
  { key: 'interviewing', label: 'Interview',   hint: 'Invited or scheduled' },
  { key: 'in_progress',  label: 'Onboarding',  hint: 'Filling out paperwork' },
];

const STATE_LABELS = {
  applied:      'Applied',
  interviewing: 'Interview',
  in_progress:  'Onboarding',
  hired:        'Onboarding',  // legacy alias
  approved:     'Active',
  deactivated:  'Deactivated',
  rejected:     'Rejected',
  unfinished:   'Unfinished signup',
};

const tryParseArray = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
const initialsOf = (n) =>
  (n || '?').split(' ').filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 2);
const daysSince = (d) => d ? Math.round((Date.now() - new Date(d).getTime()) / 86400000) : null;
const daysUntil = (d) => d ? Math.round((new Date(d).getTime() - Date.now()) / 86400000) : null;
const stageOf = (s) => s === 'hired' ? 'in_progress' : s;

export default function HiringDashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [apps, setApps]               = useState([]);
  const [appsLoading, setAppsLoading] = useState(true);
  const [summary, setSummary]         = useState({ new_apps_7d: 0, need_to_schedule: 0, stalled: 0, in_pipeline: 0 });

  const [searchQ, setSearchQ]             = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchOpen, setSearchOpen]       = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);

  const [scheduleFor, setScheduleFor] = useState(null);

  const fetchAll = useCallback(async () => {
    setAppsLoading(true);
    try {
      const [appsRes, sumRes] = await Promise.all([
        api.get('/admin/applications?page=1&limit=200'),
        api.get('/admin/hiring/summary'),
      ]);
      setApps(appsRes.data.applications || []);
      setSummary(sumRes.data);
    } catch {
      toast.error('Failed to load hiring data.');
    } finally {
      setAppsLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Deep-link: /hiring?schedule=<id> opens the schedule modal for that
  // applicant. Used by the application detail page's "Schedule interview" CTA
  // so admins land on the kanban with the modal already open.
  useEffect(() => {
    const id = searchParams.get('schedule');
    if (id && apps.length) {
      const a = apps.find(x => String(x.id) === String(id));
      if (a) setScheduleFor(a);
    }
  }, [searchParams, apps]);

  // Debounced cross-state search.
  useEffect(() => {
    if (!searchQ.trim() || searchQ.trim().length < 2) {
      setSearchResults([]);
      setSearchOpen(false);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.get(`/admin/hiring/search?q=${encodeURIComponent(searchQ.trim())}`);
        setSearchResults(r.data.results || []);
        setSearchOpen(true);
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 220);
    return () => clearTimeout(t);
  }, [searchQ]);

  const cols = useMemo(() => {
    const out = { applied: [], interviewing_unsched: [], interviewing_sched: [], in_progress: [] };
    for (const a of apps) {
      const s = stageOf(a.onboarding_status);
      if (s === 'applied') out.applied.push(a);
      else if (s === 'interviewing') {
        if (a.interview_at) out.interviewing_sched.push(a);
        else out.interviewing_unsched.push(a);
      } else if (s === 'in_progress') out.in_progress.push(a);
    }
    out.applied.sort((a, b) => new Date(b.applied_at) - new Date(a.applied_at));
    out.interviewing_sched.sort((a, b) => new Date(a.interview_at) - new Date(b.interview_at));
    return out;
  }, [apps]);

  const handleSelectResult = (r) => {
    setSearchOpen(false);
    setSearchQ('');
    if (r.state === 'unfinished') {
      const ago = r.user_created_at
        ? new Date(r.user_created_at).toLocaleDateString()
        : 'unknown';
      toast.info(`${r.email} registered ${ago} but never submitted an application.`);
    } else {
      navigate(`/staffing/applications/${r.id}`);
    }
  };

  const closeSchedule = () => {
    setScheduleFor(null);
    if (searchParams.get('schedule')) setSearchParams({});
  };

  return (
    <div className="page" data-app="admin-os">
      <div className="page-header">
        <div>
          <div className="page-title">Hiring</div>
          <div className="page-subtitle">
            {summary.in_pipeline} in pipeline · {summary.new_apps_7d} new this week
          </div>
        </div>
        <div className="page-actions" style={{ position: 'relative', minWidth: 280 }}>
          <input
            className="input"
            placeholder="Search all applicants…"
            value={searchQ}
            onChange={e => setSearchQ(e.target.value)}
            onFocus={() => searchResults.length && setSearchOpen(true)}
            onBlur={() => setTimeout(() => setSearchOpen(false), 200)}
            style={{ width: '100%', padding: '8px 12px' }}
          />
          {searchOpen && (
            <div
              className="card"
              style={{
                position: 'absolute', top: '100%', right: 0, marginTop: 4,
                width: 360, zIndex: 100, padding: 4, maxHeight: 480, overflowY: 'auto',
              }}
            >
              {searchLoading && (
                <div className="tiny muted" style={{ padding: 12 }}>Searching…</div>
              )}
              {!searchLoading && searchResults.length === 0 && (
                <div className="tiny muted" style={{ padding: 12 }}>No matches.</div>
              )}
              {searchResults.map(r => (
                <div
                  key={r.id}
                  onMouseDown={() => handleSelectResult(r)}
                  style={{ padding: '8px 10px', cursor: 'pointer', borderRadius: 3 }}
                >
                  <div className="hstack" style={{ gap: 8, justifyContent: 'space-between' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{r.full_name || r.email}</div>
                      <div className="tiny muted">{r.email}</div>
                    </div>
                    <StatusChip kind={
                      r.state === 'rejected' ? 'danger'
                      : r.state === 'unfinished' ? 'warn'
                      : r.state === 'approved' ? 'ok'
                      : 'info'
                    }>{STATE_LABELS[r.state] || r.state}</StatusChip>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* KPI strip */}
      <div className="stat-row" style={{ marginBottom: 'var(--gap)' }}>
        <div className="stat">
          <div className="stat-label">New apps · 7d</div>
          <div className="stat-value" style={{
            color: summary.new_apps_7d > 0 ? 'hsl(var(--ok-h) var(--ok-s) 52%)' : '',
          }}>
            {summary.new_apps_7d > 0 ? '+' : ''}{summary.new_apps_7d}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Need to schedule</div>
          <div className="stat-value" style={{
            color: summary.need_to_schedule > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : '',
          }}>
            {summary.need_to_schedule}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Stalled</div>
          <div className="stat-value" style={{
            color: summary.stalled > 0 ? 'hsl(var(--danger-h) var(--danger-s) 58%)' : '',
          }}>
            {summary.stalled}
          </div>
        </div>
      </div>

      {/* Kanban */}
      {appsLoading ? (
        <div className="loading"><div className="spinner" />Loading…</div>
      ) : (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(3, minmax(260px, 1fr))',
          gap: 12, alignItems: 'start',
        }}>
          {COLUMNS.map(col => (
            <div key={col.key} style={{
              background: 'var(--bg-2)', border: '1px solid var(--line-1)', borderRadius: 4,
              display: 'flex', flexDirection: 'column', minHeight: 380,
            }}>
              <div style={{ padding: '11px 12px 10px', borderBottom: '1px solid var(--line-1)' }}>
                <div className="hstack" style={{ justifyContent: 'space-between' }}>
                  <strong style={{ fontSize: 12.5 }}>{col.label}</strong>
                  <span className="k">
                    {col.key === 'interviewing'
                      ? cols.interviewing_unsched.length + cols.interviewing_sched.length
                      : cols[col.key].length}
                  </span>
                </div>
                <div className="tiny muted" style={{ fontSize: 10.5 }}>{col.hint}</div>
              </div>
              <div className="vstack" style={{ gap: 8, padding: 8, flex: 1 }}>
                {col.key === 'interviewing' ? (
                  <InterviewColumnBody
                    unscheduled={cols.interviewing_unsched}
                    scheduled={cols.interviewing_sched}
                    onOpen={(a) => navigate(`/staffing/applications/${a.id}`)}
                    onSchedule={setScheduleFor}
                  />
                ) : (
                  <>
                    {cols[col.key].map(a => (
                      <ApplicantCard
                        key={a.id}
                        a={a}
                        onOpen={() => navigate(`/staffing/applications/${a.id}`)}
                        onSchedule={() => setScheduleFor(a)}
                      />
                    ))}
                    {cols[col.key].length === 0 && <EmptyTile />}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <InterviewScheduleModal
        open={!!scheduleFor}
        applicant={scheduleFor}
        onClose={closeSchedule}
        onSaved={fetchAll}
      />
    </div>
  );
}

const SubHeader = ({ label }) => (
  <div className="tiny muted" style={{
    textTransform: 'uppercase', letterSpacing: '0.06em',
    fontSize: 10, padding: '4px 4px 2px',
  }}>{label}</div>
);

const EmptyTile = () => (
  <div className="tiny muted" style={{
    padding: '16px 8px', textAlign: 'center',
    border: '1px dashed var(--line-1)', borderRadius: 3,
  }}>Empty.</div>
);

function InterviewColumnBody({ unscheduled, scheduled, onOpen, onSchedule }) {
  if (unscheduled.length === 0 && scheduled.length === 0) return <EmptyTile />;
  return (
    <>
      {unscheduled.length > 0 && <SubHeader label={`Unscheduled (${unscheduled.length})`} />}
      {unscheduled.map(a => (
        <ApplicantCard key={a.id} a={a} onOpen={() => onOpen(a)} onSchedule={() => onSchedule(a)} />
      ))}
      {scheduled.length > 0 && <SubHeader label={`Scheduled (${scheduled.length})`} />}
      {scheduled.map(a => (
        <ApplicantCard key={a.id} a={a} onOpen={() => onOpen(a)} onSchedule={() => onSchedule(a)} />
      ))}
    </>
  );
}

function ApplicantCard({ a, onOpen, onSchedule }) {
  const positions = tryParseArray(a.positions_interested);
  const status = stageOf(a.onboarding_status);
  const isUnscheduled = status === 'interviewing' && !a.interview_at;
  const days = daysSince(a.applied_at);

  return (
    <div
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      role="button"
      tabIndex={0}
      style={{
        padding: '10px 11px',
        background: isUnscheduled ? 'hsl(var(--warn-h) var(--warn-s) 50% / 0.06)' : 'var(--bg-1)',
        border: '1px solid ' + (isUnscheduled
          ? 'hsl(var(--warn-h) var(--warn-s) 50% / 0.4)'
          : 'var(--line-1)'),
        borderRadius: 4, cursor: 'pointer',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}
    >
      <div className="hstack" style={{ gap: 8 }}>
        <div className="avatar" style={{ width: 28, height: 28, fontSize: 10, flexShrink: 0 }}>
          {initialsOf(a.full_name)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 12.5, fontWeight: 600, lineHeight: 1.2,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{a.full_name}</div>
          <div className="hstack" style={{ gap: 4, marginTop: 2, flexWrap: 'wrap' }}>
            {positions.slice(0, 2).map(p => (
              <span key={p} className="tag" style={{ fontSize: 9.5, padding: '1px 5px' }}>{p}</span>
            ))}
            {positions.length > 2 && <span className="tiny muted">+{positions.length - 2}</span>}
          </div>
        </div>
      </div>
      {a.referral_source && (
        <div className="tiny" style={{ color: 'var(--accent)' }}>Referral · {a.referral_source}</div>
      )}
      <div className="hstack" style={{
        justifyContent: 'space-between', borderTop: '1px solid var(--line-1)',
        paddingTop: 6, marginTop: 'auto', alignItems: 'flex-end',
      }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 10.5 }}>
          <Footer a={a} status={status} onSchedule={onSchedule} />
        </div>
        <span className="tiny muted" style={{ marginLeft: 8, flexShrink: 0 }}>
          {days != null ? `${days}d` : ''}
        </span>
      </div>
    </div>
  );
}

function Footer({ a, status, onSchedule }) {
  if (status === 'applied') {
    return <span className="muted">{a.city || '—'}</span>;
  }
  if (status === 'interviewing' && !a.interview_at) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onSchedule(); }}
        className="btn btn-secondary btn-sm"
        style={{ padding: '3px 8px', fontSize: 10.5 }}
      >
        Schedule →
      </button>
    );
  }
  if (status === 'interviewing' && a.interview_at) {
    const dt = new Date(a.interview_at);
    const diff = daysUntil(a.interview_at);
    const when = diff <= 0 ? 'Today' : diff === 1 ? 'Tomorrow' : `In ${diff}d`;
    return (
      <span>
        {when} · {dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
      </span>
    );
  }
  if (status === 'in_progress') {
    const pct = Math.round((a.onboarding_progress || 0) * 100);
    return (
      <div style={{ width: '100%' }}>
        <div className="hstack" style={{ justifyContent: 'space-between', marginBottom: 3 }}>
          <span style={{ color: pct === 100 ? 'hsl(var(--ok-h) var(--ok-s) 50%)' : 'var(--ink-2)' }}>
            {pct === 100 ? 'Ready (auto-flips)' : `${pct}%`}
          </span>
          {a.onboarding_blocker && pct < 100 && (
            <span className="muted" style={{ fontSize: 9.5 }}>{a.onboarding_blocker}</span>
          )}
        </div>
        <div style={{ height: 3, background: 'var(--bg-2)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{
            width: `${pct}%`, height: '100%',
            background: pct === 100 ? 'hsl(var(--ok-h) var(--ok-s) 50%)' : 'var(--accent)',
          }} />
        </div>
      </div>
    );
  }
  return null;
}

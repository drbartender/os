import React, { useEffect, useState, useCallback, useMemo } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import StatusChip from '../../components/adminos/StatusChip';

// Admin Lab Rat bugs queue. Backed by:
//   GET   /admin/tester-bugs?status=open|fixed|wontfix|all&missionId=...
//   PATCH /admin/tester-bugs/:id  body: { status, fixCommitSha, notes }
// Auth: requireAdminOrManager.

const KIND_LABEL = { bug: 'Bug', confusion: 'Confusion', 'mission-stale': 'Stale mission' };
const STATUS_LABEL = { open: 'Open', fixed: 'Fixed', wontfix: "Won't fix" };

function kindKind(kind) {
  if (kind === 'bug') return 'danger';
  if (kind === 'confusion') return 'warn';
  if (kind === 'mission-stale') return 'accent';
  return 'neutral';
}

function statusKind(status) {
  if (status === 'fixed') return 'ok';
  if (status === 'wontfix') return 'neutral';
  return 'warn';
}

export default function LabRatBugsPage() {
  const toast = useToast();
  const [bugs, setBugs] = useState([]);
  const [openCounts, setOpenCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('open');
  const [missionFilter, setMissionFilter] = useState('');
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('status', status);
      if (missionFilter) params.set('missionId', missionFilter);
      const { data } = await api.get(`/admin/tester-bugs?${params.toString()}`);
      setBugs(data?.bugs || []);
      setOpenCounts(data?.openCountByMission || {});
    } catch (err) {
      toast.error(err?.message || 'Failed to load bugs.');
    } finally {
      setLoading(false);
    }
  }, [status, missionFilter, toast]);

  useEffect(() => { load(); }, [load]);

  async function update(id, patch) {
    setBusyId(id);
    try {
      await api.patch(`/admin/tester-bugs/${id}`, patch);
      await load();
    } catch (err) {
      toast.error(err?.message || 'Failed to update bug.');
    } finally {
      setBusyId(null);
    }
  }

  function markFixed(bug) {
    const sha = window.prompt('Fix commit SHA (optional, leave blank to skip):', '') || '';
    const notes = window.prompt('Notes (optional):', '') || '';
    update(bug.id, { status: 'fixed', fixCommitSha: sha.trim() || null, notes: notes.trim() || null });
  }

  function markWontfix(bug) {
    const reason = window.prompt('Reason for wontfix (optional):', '') || '';
    update(bug.id, { status: 'wontfix', notes: reason.trim() || null });
  }

  function reopen(bug) {
    update(bug.id, { status: 'open' });
  }

  const grouped = useMemo(() => {
    const out = {};
    for (const b of bugs) {
      const key = b.missionId || '(no mission)';
      (out[key] = out[key] || []).push(b);
    }
    return out;
  }, [bugs]);

  const totalOpen = Object.values(openCounts).reduce((sum, n) => sum + n, 0);
  const missionOptions = useMemo(() => {
    const set = new Set(Object.keys(openCounts));
    for (const b of bugs) if (b.missionId) set.add(b.missionId);
    return Array.from(set).sort();
  }, [openCounts, bugs]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Lab Rat bugs</div>
          <div className="page-subtitle">Tester-submitted bug reports, confusion notes, and stale-mission flags.</div>
        </div>
      </div>

      <div className="stat-row" style={{ marginBottom: 'var(--gap)' }}>
        <div className="stat">
          <div className="stat-label">Open</div>
          <div className="stat-value">{totalOpen}</div>
        </div>
        <div className="stat">
          <div className="stat-label">In view</div>
          <div className="stat-value">{bugs.length}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Missions with open bugs</div>
          <div className="stat-value">{Object.keys(openCounts).length}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 'var(--gap)' }}>
        <div className="card-body" style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            <span className="muted">Status</span>
            <select value={status} onChange={e => setStatus(e.target.value)}>
              <option value="open">Open</option>
              <option value="fixed">Fixed</option>
              <option value="wontfix">Won't fix</option>
              <option value="all">All</option>
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            <span className="muted">Mission</span>
            <select value={missionFilter} onChange={e => setMissionFilter(e.target.value)}>
              <option value="">All missions</option>
              {missionOptions.map(m => (
                <option key={m} value={m}>
                  {m}{openCounts[m] ? ` (${openCounts[m]} open)` : ''}
                </option>
              ))}
            </select>
          </label>
          <span className="muted tiny">{bugs.length} {bugs.length === 1 ? 'item' : 'items'}</span>
        </div>
      </div>

      {loading ? (
        <div className="muted">Loading…</div>
      ) : bugs.length === 0 ? (
        <div className="card"><div className="card-body muted">No bugs in view.</div></div>
      ) : (
        Object.entries(grouped).map(([mission, list]) => (
          <section key={mission} style={{ marginBottom: 'var(--gap)' }}>
            <h2 style={{ fontSize: 14, color: 'var(--ink-2)', margin: '8px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>{mission}</span>
              <span className="muted tiny">{list.length} in view</span>
              {openCounts[mission] > 0 && status !== 'open' && (
                <span className="muted tiny">· {openCounts[mission]} open</span>
              )}
            </h2>
            <div className="vstack" style={{ gap: 'var(--gap)' }}>
              {list.map(b => (
                <article key={b.id} className="card">
                  <div className="card-head">
                    <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: 0, fontSize: 14 }}>
                      <StatusChip kind={kindKind(b.kind)}>{KIND_LABEL[b.kind] || b.kind}</StatusChip>
                      <span>{b.testerName || 'anonymous'}</span>
                      {Number.isInteger(b.stepIndex) && (
                        <span className="muted tiny">step {b.stepIndex + 1}</span>
                      )}
                      <StatusChip kind={statusKind(b.status)}>{STATUS_LABEL[b.status] || b.status}</StatusChip>
                    </h3>
                    <span className="muted tiny">
                      {b.reportedAt ? new Date(b.reportedAt).toLocaleString() : '—'}
                    </span>
                  </div>
                  <div className="card-body">
                    {b.where && <p style={{ margin: '0 0 8px' }}><strong className="muted tiny">Where</strong><br />{b.where}</p>}
                    {b.didWhat && <p style={{ margin: '0 0 8px', whiteSpace: 'pre-wrap' }}><strong className="muted tiny">Did</strong><br />{b.didWhat}</p>}
                    {b.happened && <p style={{ margin: '0 0 8px', whiteSpace: 'pre-wrap' }}><strong className="muted tiny">{b.kind === 'mission-stale' ? "What's wrong" : 'Happened'}</strong><br />{b.happened}</p>}
                    {b.expected && <p style={{ margin: '0 0 8px', whiteSpace: 'pre-wrap' }}><strong className="muted tiny">Expected</strong><br />{b.expected}</p>}
                    {b.fixCommitSha && (
                      <p className="muted tiny" style={{ margin: '8px 0 0' }}>
                        Fix commit: <code>{b.fixCommitSha}</code>
                      </p>
                    )}
                    {b.notes && (
                      <p className="muted tiny" style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>
                        Triage notes: {b.notes}
                      </p>
                    )}
                    <p className="muted tiny" style={{ margin: '8px 0 0', fontSize: 11 }}>
                      {b.browser || 'unknown browser'} · id <code>{b.id}</code>
                    </p>
                    <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {b.status === 'open' ? (
                        <>
                          <button type="button" className="btn" disabled={busyId === b.id} onClick={() => markFixed(b)}>
                            {busyId === b.id ? 'Saving…' : 'Mark fixed'}
                          </button>
                          <button type="button" className="btn btn-ghost" disabled={busyId === b.id} onClick={() => markWontfix(b)}>
                            {busyId === b.id ? 'Saving…' : "Won't fix"}
                          </button>
                        </>
                      ) : (
                        <button type="button" className="btn btn-ghost" disabled={busyId === b.id} onClick={() => reopen(b)}>
                          {busyId === b.id ? 'Saving…' : 'Reopen'}
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

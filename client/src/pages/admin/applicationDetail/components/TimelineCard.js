import React, { useState } from 'react';
import api from '../../../../utils/api';
import { useToast } from '../../../../context/ToastContext';
import { relDay } from '../helpers';

const EVENT_LABELS = {
  application_submitted:     'Application submitted',
  status_changed:            'Status changed',
  interview_scheduled:       'Interview scheduled',
  interview_rescheduled:     'Interview rescheduled',
  reminder_sent:             'Reminder sent',
  note_added:                'Note added',
  onboarding_step_completed: 'Onboarding step complete',
};

function describe(event) {
  const meta = event.metadata || {};
  if (event.event_type === 'status_changed' && meta.from && meta.to) {
    const base = `${meta.from} → ${meta.to}`;
    return meta.reason ? `${base} · ${meta.reason}` : base;
  }
  if (event.event_type === 'interview_scheduled' && meta.interview_at) {
    const d = new Date(meta.interview_at);
    return `${d.toLocaleDateString()} · ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  if (event.event_type === 'interview_rescheduled') {
    if (meta.cleared) return 'Cleared scheduled time';
    if (meta.interview_at) {
      const d = new Date(meta.interview_at);
      return `Now ${d.toLocaleDateString()} · ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    }
  }
  if (event.event_type === 'reminder_sent') {
    return meta.kind === 'paperwork' ? 'Paperwork reminder' : null;
  }
  if (event.event_type === 'application_submitted' && meta.via) {
    return `Submitted via ${meta.via}`;
  }
  return null;
}

export default function TimelineCard({ userId, timeline, onPosted }) {
  const toast = useToast();
  const [draft, setDraft]     = useState('');
  const [posting, setPosting] = useState(false);

  const submit = async () => {
    const note = draft.trim();
    if (!note) return;
    setPosting(true);
    try {
      await api.post(`/admin/applications/${userId}/notes`, { note });
      setDraft('');
      onPosted && onPosted();
    } catch {
      toast.error('Could not post note.');
    } finally {
      setPosting(false);
    }
  };

  const items = timeline || [];

  return (
    <div className="card">
      <div className="card-head">
        <h3>Notes &amp; activity</h3>
        <span className="k">{items.length}</span>
      </div>
      <div className="card-body">
        <div className="hstack" style={{ gap: 8, marginBottom: 14, alignItems: 'flex-end' }}>
          <textarea
            className="input"
            placeholder="Add an interview note…"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            style={{ flex: 1, minHeight: 56, padding: 10, resize: 'vertical' }}
          />
          <button
            className="btn btn-primary btn-sm"
            disabled={!draft.trim() || posting}
            onClick={submit}
          >
            {posting ? 'Posting…' : 'Post'}
          </button>
        </div>
        <div className="vstack" style={{ gap: 0 }}>
          {items.length === 0 && (
            <div className="tiny muted" style={{ padding: '16px 0', textAlign: 'center' }}>
              No activity yet.
            </div>
          )}
          {items.map((e, i) => {
            const isNote = e.event_type === 'note_added';
            const title = EVENT_LABELS[e.event_type] || e.event_type;
            const sub = describe(e);
            return (
              <div key={`${e.event_type}-${e.created_at}`} style={{
                display: 'grid', gridTemplateColumns: '14px 1fr 110px', gap: 14,
                padding: '10px 0',
                borderBottom: i < items.length - 1 ? '1px solid var(--line-1)' : 0,
              }}>
                <div style={{ position: 'relative', paddingTop: 6 }}>
                  <div style={{
                    width: 8, height: 8, borderRadius: 999,
                    background: isNote ? 'var(--accent)' : 'var(--ink-3)',
                  }} />
                  {i < items.length - 1 && (
                    <div style={{
                      position: 'absolute', left: 3, top: 14, bottom: -10,
                      width: 1, background: 'var(--line-1)',
                    }} />
                  )}
                </div>
                <div>
                  {isNote ? (
                    <>
                      <div className="hstack tiny" style={{ gap: 6, marginBottom: 4 }}>
                        <strong>{e.actor_name || 'Admin'}</strong>
                        <span className="muted">noted</span>
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                        {e.metadata?.note}
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: 13 }}><strong>{title}</strong></div>
                      {sub && <div className="tiny muted" style={{ marginTop: 2 }}>{sub}</div>}
                    </>
                  )}
                </div>
                <div className="tiny muted" style={{ textAlign: 'right' }}>{relDay(e.created_at)}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

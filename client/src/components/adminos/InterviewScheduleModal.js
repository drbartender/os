import React, { useState, useEffect } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';

// Round to next 30-min slot for the default datetime.
const defaultWhen = () => {
  const now = new Date();
  if (now.getMinutes() < 30) now.setMinutes(30, 0, 0);
  else { now.setHours(now.getHours() + 1); now.setMinutes(0, 0, 0); }
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
};

// Format an ISO timestamp for the datetime-local input (YYYY-MM-DDTHH:mm in
// the user's local TZ — note new Date(iso).toISOString() would shift to UTC).
const isoToLocalInput = (iso) => {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function InterviewScheduleModal({ open, applicant, onClose, onSaved }) {
  const toast = useToast();
  const [when, setWhen]               = useState(defaultWhen());
  const [notes, setNotes]             = useState('');
  const [sendEmail, setSendEm]        = useState(true);
  const [submitting, setSubmit]       = useState(false);

  useEffect(() => {
    if (open && applicant) {
      setWhen(applicant.interview_at ? isoToLocalInput(applicant.interview_at) : defaultWhen());
      setNotes('');
      setSendEm(!applicant.interview_at); // default off when rescheduling
      setSubmit(false);
    }
  }, [open, applicant]);

  if (!open || !applicant) return null;

  const submit = async () => {
    setSubmit(true);
    try {
      await api.put(`/admin/applications/${applicant.id}/interview`, {
        interview_at: new Date(when).toISOString(),
        notes:        notes.trim() || null,
        send_email:   sendEmail,
      });
      toast.success(applicant.interview_at ? 'Interview rescheduled.' : 'Interview scheduled.');
      onSaved && onSaved();
      onClose();
    } catch (e) {
      const msg = e?.response?.data?.error || e?.response?.data?.message || 'Could not schedule.';
      toast.error(msg);
    } finally {
      setSubmit(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') onClose();
  };

  return (
    <div
      onClick={onClose}
      onKeyDown={onKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label="Schedule interview"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
        display: 'grid', placeItems: 'center',
      }}
      data-app="admin-os"
    >
      <div onClick={e => e.stopPropagation()} className="card" style={{ width: 460, maxWidth: '92vw' }}>
        <div className="card-head">
          <h3>{applicant.interview_at ? 'Reschedule' : 'Schedule'} interview · {applicant.full_name}</h3>
        </div>
        <div className="card-body vstack" style={{ gap: 12 }}>
          <label className="vstack" style={{ gap: 4 }}>
            <span className="tiny muted">When</span>
            <input
              type="datetime-local"
              className="input"
              value={when}
              onChange={e => setWhen(e.target.value)}
              style={{ padding: 10 }}
            />
          </label>
          <label className="vstack" style={{ gap: 4 }}>
            <span className="tiny muted">Notes (private)</span>
            <textarea
              className="input"
              placeholder="e.g. Phone — I'll call her"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              style={{ minHeight: 60, padding: 10, resize: 'vertical' }}
            />
          </label>
          <label className="hstack" style={{ gap: 8 }}>
            <input type="checkbox" checked={sendEmail} onChange={e => setSendEm(e.target.checked)} />
            <span className="tiny">Email confirmation to applicant</span>
          </label>
          <div className="hstack" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
            <button className="btn btn-primary" onClick={submit} disabled={!when || submitting}>
              {submitting ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

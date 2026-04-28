import { useEffect, useRef, useState } from 'react';
import api from '../../utils/api';

const TITLES = {
  bug: 'Report a bug',
  confusion: "I'm stuck — what's confusing?",
  'mission-stale': 'This mission seems wrong',
};

export default function BugDialog({ open, onClose, kind, missionId, stepIndex, where, didWhat, testerName }) {
  const dialogRef = useRef(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ happened: '', expected: '' });

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    if (open) { setForm({ happened: '', expected: '' }); setError(null); }
  }, [open, missionId, stepIndex]);

  async function onSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/test-feedback', {
        kind, missionId, stepIndex, testerName, where, didWhat,
        happened: form.happened, expected: form.expected,
        browser: navigator.userAgent,
      });
      onClose({ ok: true });
    } catch (err) {
      setError(err?.message || 'Could not send. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <dialog ref={dialogRef} className="labrat-dialog" data-app="labrat">
      <form onSubmit={onSubmit}>
        <h2>{TITLES[kind] || 'Report'}</h2>
        {where && <p className="labrat-dialog-context"><strong>Where:</strong> {where}</p>}
        <label>{kind === 'mission-stale' ? 'What seems wrong with this mission?' : 'What happened?'}
          <textarea
            required
            value={form.happened}
            onChange={e => setForm(f => ({ ...f, happened: e.target.value }))}
            rows={4}
          />
        </label>
        {kind === 'bug' && (
          <label>What did you expect? (optional)
            <textarea
              value={form.expected}
              onChange={e => setForm(f => ({ ...f, expected: e.target.value }))}
              rows={2}
            />
          </label>
        )}
        {error && <p className="labrat-dialog-error">{error}</p>}
        <div className="labrat-dialog-actions">
          <button type="button" onClick={() => onClose({ ok: false })} disabled={submitting}>Cancel</button>
          <button type="submit" disabled={submitting} className="labrat-primary">
            {submitting ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

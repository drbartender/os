import React, { useState } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import { formatLocalDay, errorText } from './marketingFormat';

/**
 * The house do-not-contact rule.
 *
 * Setting it requires a reason; clearing it requires an explicit confirmation
 * that shows the stored reason and when it was set, so whoever clears it knows
 * what they are undoing. This is the only classification whose accidental
 * removal emails someone who asked not to be emailed, which is why it is not a
 * tag and not a single click in either direction.
 *
 * Unlike TagCell this does NOT write optimistically. An optimistic flip here
 * would briefly render someone as safe to email while the save was in flight.
 */
export default function DoNotContactControl({ contact, onChange, compact = false }) {
  const toast = useToast();
  const [mode, setMode] = useState(null);      // null | 'set' | 'clear'
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const close = () => { setMode(null); setReason(''); };

  const submit = async (excluded) => {
    // Mirrors the server rule so we never send a request we know will 400.
    if (excluded && !reason.trim()) return;
    setBusy(true);
    try {
      await api.put(`/marketing/contacts/${contact.id}/do-not-contact`,
        excluded ? { excluded: true, reason: reason.trim() } : { excluded: false });
      // Update in place rather than refetching the whole list.
      onChange(contact.id, {
        do_not_contact: excluded,
        do_not_contact_reason: excluded ? reason.trim() : null,
        do_not_contact_at: excluded ? new Date().toISOString() : null,
        mailable: excluded ? false : contact.mailable,
        held_back_reason: excluded ? 'do_not_contact' : null,
      });
      toast.success(excluded ? 'Marked do not contact.' : 'Do not contact cleared.');
      close();
    } catch (err) {
      toast.error(errorText(err, 'Could not save. Nothing was changed.'));
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'set') {
    return (
      <div className="mkt-dnc-prompt">
        <label htmlFor={`dnc-reason-${contact.id}`}>Why are we not contacting them?</label>
        <input
          id={`dnc-reason-${contact.id}`}
          className="input"
          type="text"
          value={reason}
          autoFocus
          disabled={busy}
          placeholder="Asked us to stop, bad fit, unpaid invoice…"
          onChange={e => setReason(e.target.value)}
        />
        <div className="mkt-dnc-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => submit(true)}
            disabled={busy || !reason.trim()}
          >
            {busy ? 'Saving…' : 'Do not contact'}
          </button>
        </div>
      </div>
    );
  }

  if (mode === 'clear') {
    return (
      <div className="mkt-dnc-prompt">
        <p className="mkt-dnc-confirm">
          This contact was marked do not contact
          {contact.do_not_contact_at ? ` on ${formatLocalDay(contact.do_not_contact_at)}` : ''}
          {contact.do_not_contact_reason ? `: "${contact.do_not_contact_reason}"` : '.'}
          {' '}Clearing it makes them eligible for campaigns again.
        </p>
        <div className="mkt-dnc-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={close} disabled={busy}>
            Keep excluded
          </button>
          <button type="button" className="btn btn-danger btn-sm" onClick={() => submit(false)} disabled={busy}>
            {busy ? 'Saving…' : 'Clear it'}
          </button>
        </div>
      </div>
    );
  }

  return contact.do_not_contact ? (
    <button
      type="button"
      className={compact ? 'btn btn-ghost btn-sm' : 'btn btn-secondary btn-sm'}
      onClick={() => setMode('clear')}
    >
      Clear do not contact
    </button>
  ) : (
    <button
      type="button"
      className={compact ? 'btn btn-ghost btn-sm' : 'btn btn-secondary btn-sm'}
      onClick={() => setMode('set')}
    >
      Do not contact
    </button>
  );
}

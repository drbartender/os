import React, { useRef, useState } from 'react';
import api from '../utils/api';
import Icon from './adminos/Icon';
import StatusChip from './adminos/StatusChip';

// Tri-state, derived exactly the way the server derives it: an uploaded file
// always wins, the "not required" flag only reads through when no file exists.
function deriveStatus(menuPrintKey, menuNotRequired) {
  if (menuPrintKey) return 'ready';
  if (menuNotRequired) return 'not_required';
  return 'pending';
}

// Mirrors the server's MAX_FILE_SIZE default (server/index.js fileUpload limits).
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const STATUS_CHIP = {
  ready: { label: 'Uploaded', kind: 'ok' },
  not_required: { label: 'No menu needed', kind: 'neutral' },
  pending: { label: 'Not posted', kind: 'warn' },
};

// api.js normalizes every rejection to { message, code, fieldErrors, status }.
// Bad magic bytes come back on fieldErrors.file. Oversize does NOT: express-
// fileupload's abortOnLimit sends a plain-text 413, which api.js cannot parse
// into a field error, so the size is checked here before the request instead.
// everything else (409 on the not-required flip, network) is a plain message.
function errorText(err, fallback) {
  const fieldMsg = err?.fieldErrors?.file;
  if (typeof fieldMsg === 'string' && fieldMsg) return fieldMsg;
  return err?.message || fallback;
}

/**
 * Admin card on EventDetailPage for the bar menu print file. Staff download it
 * from their event details page, print it, and bring it framed to the event.
 *
 * Props:
 *   proposalId      - proposal / event id
 *   menuPrintKey    - storage key of the uploaded file, or null
 *   menuNotRequired - true when the admin marked this event as needing no menu
 *   onChange        - called after any successful mutation so the parent reloads
 */
export default function AdminMenuPrintBlock({ proposalId, menuPrintKey, menuNotRequired, onChange }) {
  const fileInputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const status = deriveStatus(menuPrintKey, menuNotRequired);
  const hasFile = status === 'ready';
  const chip = STATUS_CHIP[status];

  const finish = async () => {
    if (onChange) await onChange();
  };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setError('That file is too large. Keep the print file under 10MB.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setError('');
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      await api.post(`/proposals/${proposalId}/menu-print`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      await finish();
    } catch (err) {
      setError(errorText(err, 'Upload failed.'));
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRemove = async () => {
    setError('');
    setBusy(true);
    try {
      await api.delete(`/proposals/${proposalId}/menu-print`);
      await finish();
    } catch (err) {
      setError(errorText(err, 'Failed to remove the menu file.'));
    } finally {
      setBusy(false);
    }
  };

  const handleNotRequired = async (e) => {
    const notRequired = e.target.checked;
    setError('');
    setBusy(true);
    try {
      await api.patch(`/proposals/${proposalId}/menu-print`, { not_required: notRequired });
      await finish();
    } catch (err) {
      setError(errorText(err, 'Failed to update the menu status.'));
    } finally {
      setBusy(false);
    }
  };

  const triggerPicker = () => fileInputRef.current?.click();

  return (
    <div className="card">
      <div className="card-head">
        <h3>Bar menu print</h3>
        <StatusChip kind={chip.kind}>{chip.label}</StatusChip>
      </div>
      <div className="card-body">
        <div className="muted tiny" style={{ marginBottom: 10 }}>
          Staff download this from their event details page, print it, and bring it framed.
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.png,.jpg,.jpeg"
          onChange={handleFileChange}
          style={{ display: 'none' }}
        />

        <div className="vstack" style={{ gap: 6 }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            style={{ justifyContent: 'center' }}
            onClick={triggerPicker}
            disabled={busy}
          >
            <Icon name={hasFile ? 'pen' : 'plus'} size={11} />
            {busy ? 'Working…' : hasFile ? 'Replace file' : 'Upload file'}
          </button>

          {hasFile && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ justifyContent: 'center' }}
              onClick={handleRemove}
              disabled={busy}
            >
              <Icon name="x" size={11} />Remove
            </button>
          )}

          {!hasFile && (
            <label className="hstack" style={{ gap: 6, fontSize: 12.5, cursor: busy ? 'default' : 'pointer' }}>
              <input
                type="checkbox"
                checked={!!menuNotRequired}
                onChange={handleNotRequired}
                disabled={busy}
              />
              No menu needed for this event
            </label>
          )}
        </div>

        {error && (
          <p className="chip danger" style={{ marginTop: 10 }} role="alert">{error}</p>
        )}
      </div>
    </div>
  );
}

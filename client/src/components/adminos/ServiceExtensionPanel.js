import React, { useEffect, useState } from 'react';
import api from '../../utils/api';
import Icon from './Icon';
import StatusChip from './StatusChip';
import { fmtDateTime, fmtTime24 } from './format';
import { formatMoney } from '../../utils/formatMoney';

// Admin-side service-extension panel (plan Task 16). Money IS shown here on
// purpose: this is the admin surface, unlike every staff surface.
const STATUS_CHIP = {
  pending: { label: 'Pending', kind: 'warn' },
  paid: { label: 'Paid', kind: 'ok' },
  overridden: { label: 'Overridden', kind: 'info' },
  cancelled: { label: 'Cancelled', kind: 'neutral' },
  expired: { label: 'Expired', kind: 'danger' },
};

// "18:00 to 19:00" from the stored free-text end times; either side may be
// blank on legacy rows, so join only what parses.
function endTimeShift(ext) {
  return [fmtTime24(ext.contracted_end_time), fmtTime24(ext.requested_end_time)]
    .filter(Boolean)
    .join(' to ');
}

function extraHours(ext) {
  const delta = Number(ext.requested_duration_hours) - Number(ext.contracted_duration_hours);
  return Number.isFinite(delta) && delta > 0 ? delta : null;
}

/**
 * Card on the admin event page listing every service-extension request for the
 * event, with Cancel and Override on a pending row. Renders nothing at all
 * when the event has no extension requests (empty state is a hidden panel).
 *
 * Props:
 *   proposalId - proposal / event id
 */
export default function ServiceExtensionPanel({ proposalId }) {
  // data = { extensions, payrollWarning } from the GET, null until first load.
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [nonce, setNonce] = useState(0);
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState('');
  // payrollWarning returned by an override response; the GET recomputes the
  // same warning, but keeping the action's copy makes the banner immediate.
  const [actionWarning, setActionWarning] = useState(null);
  // Which pending row has the override reason form open, and its draft reason.
  const [overrideId, setOverrideId] = useState(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState('');

  useEffect(() => {
    setData(null);
    setActionWarning(null);
    setActionError('');
    setLoadError('');
    setOverrideId(null);
    setReason('');
  }, [proposalId]);

  // Reloads (nonce bumps) keep the old rows on screen instead of flashing the
  // skeleton; only a proposal change clears data above.
  useEffect(() => {
    let cancelled = false;
    api.get(`/service-extensions/proposal/${proposalId}`)
      .then(r => {
        if (cancelled) return;
        setData(r.data);
        setLoadError('');
      })
      .catch(e => {
        if (cancelled) return;
        setLoadError(e?.message || 'Failed to load extension requests.');
      });
    return () => { cancelled = true; };
  }, [proposalId, nonce]);

  const reload = () => setNonce(n => n + 1);

  const runCancel = async (ext) => {
    if (!window.confirm('Cancel this extension request? Its invoice is voided and the bartender is told the extra time is declined.')) return;
    setBusyId(ext.id);
    setActionError('');
    try {
      await api.post(`/service-extensions/${ext.id}/cancel`);
      reload();
    } catch (e) {
      setActionError(e?.message || 'Failed to cancel the request.');
      // The row settled under us (paid, expired); refresh to show the truth.
      if (e?.code === 'EXTENSION_NOT_PENDING') reload();
    } finally {
      setBusyId(null);
    }
  };

  const runOverride = async (ext) => {
    const trimmed = reason.trim();
    if (trimmed.length < 3) { setReasonError('Give a short reason for the override.'); return; }
    if (trimmed.length > 500) { setReasonError('Keep the reason under 500 characters.'); return; }
    setBusyId(ext.id);
    setActionError('');
    setReasonError('');
    try {
      const res = await api.post(`/service-extensions/${ext.id}/override`, { reason: trimmed });
      if (res.data?.payrollWarning) setActionWarning(res.data.payrollWarning);
      setOverrideId(null);
      setReason('');
      reload();
    } catch (e) {
      const fieldMsg = e?.fieldErrors?.reason;
      if (fieldMsg) setReasonError(fieldMsg);
      else setActionError(e?.message || 'Failed to override the request.');
      if (e?.code === 'EXTENSION_NOT_PENDING') reload();
    } finally {
      setBusyId(null);
    }
  };

  // Load failed before anything rendered: an error card with Retry, since a
  // silent null here would hide real requests.
  if (!data && loadError) {
    return (
      <div className="card ext-panel">
        <div className="card-head"><h3>Service extensions</h3></div>
        <div className="card-body">
          <p className="chip danger" role="alert" style={{ marginBottom: 10 }}>{loadError}</p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={reload}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  // First load renders NOTHING, not a skeleton: most events have zero
  // extensions, so a skeleton card would flash and vanish on nearly every
  // admin event view, shoving the cards below it around (merge-gate perf
  // finding). The populated card pops in on data arrival instead.
  if (!data) {
    return null;
  }

  const extensions = Array.isArray(data.extensions) ? data.extensions : [];
  if (extensions.length === 0) return null;

  // The GET's payrollWarning fires whenever the event's payroll hours are
  // hand-edited, even before anything settles. Past-tense "was NOT added" is
  // only true once a settled row exists, so gate the load-time banner on one;
  // an override response's warning shows unconditionally.
  const hasSettled = extensions.some(x => x.status === 'paid' || x.status === 'overridden');
  const banner = actionWarning || (hasSettled ? data.payrollWarning : null);

  return (
    <div className="card ext-panel">
      <div className="card-head">
        <h3>Service extensions</h3>
        <span className="k">{extensions.length}</span>
      </div>
      <div className="card-body">
        {banner && (
          <div className="ext-payroll-banner" role="alert">
            <Icon name="alert" size={14} />
            <span>{banner}</span>
          </div>
        )}
        {actionError && (
          <p className="chip danger" role="alert" style={{ marginBottom: 10 }}>{actionError}</p>
        )}
        {loadError && (
          <p className="chip warn" role="alert" style={{ marginBottom: 10 }}>{loadError}</p>
        )}

        <div className="vstack" style={{ gap: 0 }}>
          {extensions.map((ext) => {
            const chip = STATUS_CHIP[ext.status] || { label: ext.status, kind: 'neutral' };
            const busy = busyId === ext.id;
            const shift = endTimeShift(ext);
            const extra = extraHours(ext);
            return (
              <div key={ext.id} className="ext-row">
                <div className="hstack" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <StatusChip kind={chip.kind}>{chip.label}</StatusChip>
                  <strong style={{ fontSize: 13 }}>
                    {shift || 'End time change'}
                    {extra != null && ` (+${extra}h)`}
                  </strong>
                  <div className="spacer" />
                  <strong style={{ fontSize: 13 }}>{formatMoney(ext.amount_cents)}</strong>
                </div>

                <div className="tiny muted" style={{ marginTop: 4 }}>
                  Requested by {ext.requested_by_name || 'unknown staff'} · {fmtDateTime(ext.created_at)}
                </div>
                {Number(ext.gratuity_cents) > 0 && (
                  <div className="tiny muted">Includes {formatMoney(ext.gratuity_cents)} staff gratuity</div>
                )}
                {ext.client_accepted_at && (
                  <div className="tiny muted">Client accepted {fmtDateTime(ext.client_accepted_at)}</div>
                )}
                {ext.status === 'pending' && ext.expires_at && (
                  <div className="tiny muted">Expires {fmtDateTime(ext.expires_at)}</div>
                )}
                {ext.invoice_status && (
                  <div className="tiny muted">Invoice {String(ext.invoice_status).replace(/_/g, ' ')}</div>
                )}
                {ext.status === 'overridden' && ext.override_reason && (
                  <div className="tiny muted">
                    Overridden{ext.override_by_name ? ` by ${ext.override_by_name}` : ''}: {ext.override_reason}
                  </div>
                )}

                {ext.status === 'pending' && (
                  <div className="vstack" style={{ gap: 6, marginTop: 8 }}>
                    <div className="tiny muted">
                      To kill this request use Cancel here, not the invoice list's Void: cancelling here also voids the invoice and tells the bartender right away.
                    </div>
                    {overrideId === ext.id ? (
                      <div className="vstack ext-override-form" style={{ gap: 6 }}>
                        <div className="tiny" style={{ fontWeight: 600 }}>
                          Overriding grants the extra time with no charge and voids the invoice. Give a reason for the record.
                        </div>
                        <textarea
                          className="form-textarea"
                          style={{ minHeight: 60 }}
                          rows={2}
                          maxLength={500}
                          value={reason}
                          disabled={busy}
                          placeholder="Why is this time granted without payment?"
                          onChange={(e) => { setReason(e.target.value); setReasonError(''); }}
                        />
                        {reasonError && (
                          <p className="chip danger" role="alert">{reasonError}</p>
                        )}
                        <div className="hstack" style={{ gap: 6 }}>
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={busy || reason.trim().length < 3}
                            onClick={() => runOverride(ext)}
                          >
                            <Icon name="check" size={11} />
                            {busy ? 'Working…' : 'Confirm override'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={busy}
                            onClick={() => { setOverrideId(null); setReason(''); setReasonError(''); }}
                          >
                            Keep it
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="hstack" style={{ gap: 6 }}>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={busy}
                          onClick={() => { setOverrideId(ext.id); setReason(''); setReasonError(''); }}
                        >
                          Override
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={busy}
                          onClick={() => runCancel(ext)}
                        >
                          <Icon name="x" size={11} />
                          {busy ? 'Working…' : 'Cancel request'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

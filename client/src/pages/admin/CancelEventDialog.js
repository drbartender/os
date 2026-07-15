import React, { useCallback, useEffect, useState } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import Icon from '../../components/adminos/Icon';

// Cancel-event dialog (P6, fix #7). Three steps: pick who cancelled, review the
// server-computed consequence preview, then arm with the client's last name and
// confirm. After the cancellation a distinct "Issue refund" action appears.
// Rendered from ProposalDetail and EventDetailPage action menus. No em dashes.

function usd(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

const OVERLAY = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
};

export default function CancelEventDialog({ proposalId, clientName, onClose, onCancelled }) {
  const toast = useToast();
  const [step, setStep] = useState('mode'); // 'mode' | 'preview' | 'done'
  const [mode, setMode] = useState('client');
  const [preview, setPreview] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [lastName, setLastName] = useState('');
  const [suppressEmail, setSuppressEmail] = useState(false);
  const [suppressStaff, setSuppressStaff] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null); // { refund_cents, ... }
  const [refunding, setRefunding] = useState(false);
  const [refunded, setRefunded] = useState(null);

  const loadPreview = useCallback(async (chosenMode) => {
    setLoadingPreview(true);
    try {
      const res = await api.post(`/proposals/${proposalId}/cancel/preview`, { mode: chosenMode });
      setPreview(res.data);
      setStep('preview');
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not load the cancellation preview.');
    } finally {
      setLoadingPreview(false);
    }
  }, [proposalId, toast]);

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape' && !submitting && !refunding) onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting, refunding]);

  const blocking = preview?.blocking || [];
  const blocked = blocking.some((b) => b === 'already_archived' || b === 'completed' || b === 'not_booked' || b === 'autopay_in_progress');

  const blockingCopy = {
    already_archived: 'This booking is already archived.',
    completed: 'This event is already completed and cannot be cancelled here.',
    not_booked: 'This proposal is not a booked event.',
    autopay_in_progress: 'A balance charge is in progress. Wait for it to settle before cancelling.',
  };

  const doCancel = async () => {
    setSubmitting(true);
    try {
      const res = await api.post(`/proposals/${proposalId}/cancel`, {
        mode,
        confirm_last_name: lastName,
        suppress_client_email: suppressEmail,
        suppress_staff_notifications: suppressStaff,
      });
      setResult(res.data);
      setStep('done');
      toast.success('Event cancelled.');
      if (onCancelled) onCancelled(res.data);
    } catch (err) {
      const code = err?.response?.data?.code;
      if (code === 'LAST_NAME_MISMATCH') {
        toast.error('The last name does not match our records.');
      } else {
        toast.error(err?.response?.data?.error || 'Could not cancel the event.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const doRefund = async () => {
    setRefunding(true);
    try {
      const idempotency_key = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const res = await api.post(`/proposals/${proposalId}/cancel/refund`, { idempotency_key });
      setRefunded(res.data);
      if (res.data.shortfall_cents > 0) {
        // ToastContext has no warning method; the durable surface is the
        // persistent client-alert-warning in the done-step render below.
        toast.info(`Refund of ${usd(res.data.refunded_cents)} issued. ${usd(res.data.shortfall_cents)} must be refunded manually.`);
      } else {
        toast.success(res.data.refunded_cents > 0
          ? `Refund of ${usd(res.data.refunded_cents)} issued.`
          : 'Nothing left to refund.');
      }
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not issue the refund.');
    } finally {
      setRefunding(false);
    }
  };

  const busy = submitting || refunding || loadingPreview;

  return (
    <div style={OVERLAY} onClick={() => !busy && onClose()}>
      <div className="card" style={{ width: '100%', maxWidth: 540, maxHeight: '85vh', overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <h3>Cancel event</h3>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onClose}>
            <Icon name="x" size={11} />Close
          </button>
        </div>

        <div className="card-body">
          {step === 'mode' && (
            <div className="vstack" style={{ gap: 14 }}>
              <div className="muted" style={{ fontSize: 13 }}>
                Who is cancelling this event? This decides the refund per the event services agreement.
              </div>
              <label className="hstack" style={{ gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
                <input type="radio" name="cancelMode" checked={mode === 'client'} onChange={() => setMode('client')} />
                <span>
                  <strong>The client cancelled</strong>
                  <div className="tiny muted">Retainer forfeited outside 14 days; gratuity always refunds in full.</div>
                </span>
              </label>
              <label className="hstack" style={{ gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
                <input type="radio" name="cancelMode" checked={mode === 'drb'} onChange={() => setMode('drb')} />
                <span>
                  <strong>Dr. Bartender cancelled</strong>
                  <div className="tiny muted">Everything paid, including the retainer, is refunded in full.</div>
                </span>
              </label>
              <div className="hstack" style={{ justifyContent: 'flex-end', gap: 8 }}>
                <button type="button" className="btn btn-secondary" onClick={onClose}>Never mind</button>
                <button type="button" className="btn btn-primary" disabled={loadingPreview}
                  onClick={() => loadPreview(mode)}>
                  {loadingPreview ? 'Loading…' : 'Review consequences'}
                </button>
              </div>
            </div>
          )}

          {step === 'preview' && preview && (
            <div className="vstack" style={{ gap: 14 }}>
              {blocking.map((b) => (
                <div key={b} className="client-alert client-alert-warning" role="status">
                  {blockingCopy[b] || b}
                </div>
              ))}

              <div>
                <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>Timing</div>
                <div style={{ fontSize: 14 }}>{preview.days_out} day{preview.days_out === 1 ? '' : 's'} to the event</div>
              </div>

              <div>
                <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>Refund per agreement</div>
                <div style={{ fontSize: 20, fontWeight: 600 }}>{usd(preview.refund_cents)}</div>
                <div className="tiny muted">
                  Gratuity {usd(preview.refund_breakdown.gratuity_cents)}
                  {' · '}Excess {usd(preview.refund_breakdown.excess_cents)}
                  {' · '}Processing fee {usd(preview.refund_breakdown.fee_cents)}
                </div>
              </div>

              {preview.staff && preview.staff.length > 0 && (
                <div>
                  <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>Staff shifts cancelled</div>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13 }}>
                    {preview.staff.map((s, i) => (
                      <li key={i}>{s.name}{s.position ? ` (${s.position})` : ''}</li>
                    ))}
                  </ul>
                </div>
              )}

              {preview.comms_halted && preview.comms_halted.length > 0 && (
                <div>
                  <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>Scheduled messages halted</div>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13 }}>
                    {preview.comms_halted.map((c, i) => (<li key={i}>{c}</li>))}
                  </ul>
                </div>
              )}

              {preview.email_preview && (
                <div>
                  <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>Client email preview</div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{preview.email_preview.subject}</div>
                  <div className="tiny muted" style={{ whiteSpace: 'pre-wrap' }}>{preview.email_preview.text}</div>
                </div>
              )}

              {!blocked && (
                <div className="vstack" style={{ gap: 10, borderTop: '1px solid var(--line-1)', paddingTop: 12 }}>
                  <label className="vstack" style={{ gap: 4 }}>
                    <span className="tiny muted">Type the client's last name to confirm</span>
                    <input type="text" value={lastName} onChange={(e) => setLastName(e.target.value)}
                      placeholder="Last name" autoComplete="off" />
                  </label>
                  <label className="hstack" style={{ gap: 8, cursor: 'pointer' }}>
                    <input type="checkbox" checked={suppressEmail} onChange={(e) => setSuppressEmail(e.target.checked)} />
                    <span className="tiny">Do not email the client</span>
                  </label>
                  <label className="hstack" style={{ gap: 8, cursor: 'pointer' }}>
                    <input type="checkbox" checked={suppressStaff} onChange={(e) => setSuppressStaff(e.target.checked)} />
                    <span className="tiny">Do not notify assigned staff</span>
                  </label>
                </div>
              )}

              <div className="hstack" style={{ justifyContent: 'space-between', gap: 8 }}>
                <button type="button" className="btn btn-secondary" disabled={submitting} onClick={() => setStep('mode')}>Back</button>
                <button type="button" className="btn btn-danger" disabled={submitting || blocked || !lastName.trim()}
                  onClick={doCancel}>
                  {submitting ? 'Cancelling…' : 'Cancel event'}
                </button>
              </div>
            </div>
          )}

          {step === 'done' && result && (
            <div className="vstack" style={{ gap: 14 }}>
              <div className="client-alert client-alert-success" role="status">
                Event cancelled. Refund owed per agreement: <strong>{usd(result.refund_cents)}</strong>.
              </div>
              {result.refund_cents > 0 && !refunded && (
                <button type="button" className="btn btn-primary" disabled={refunding} onClick={doRefund}>
                  {refunding ? 'Issuing…' : `Issue ${usd(result.refund_cents)} refund`}
                </button>
              )}
              {result.refund_cents > 0 && !refunded && (
                <div className="tiny muted">
                  You can also handle the refund in Stripe. Skipping leaves a note on the proposal.
                </div>
              )}
              {refunded && (
                <div className="client-alert client-alert-success" role="status">
                  {refunded.refunded_cents > 0
                    ? `Refund of ${usd(refunded.refunded_cents)} issued.`
                    : 'Nothing left to refund on this proposal.'}
                </div>
              )}
              {refunded && refunded.shortfall_cents > 0 && (
                <div className="client-alert client-alert-warning" role="status">
                  {usd(refunded.shortfall_cents)} could not be refunded automatically (paid by legacy card or a manual payment). Refund this remainder by hand in Stripe.
                </div>
              )}
              <div className="hstack" style={{ justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-secondary" onClick={onClose}>Done</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

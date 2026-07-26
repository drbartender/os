import React, { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import Icon from '../../components/adminos/Icon';
import NotifyConfirmModal from '../../components/comms/NotifyConfirmModal';
import isPlaceholderEmail from '../../utils/isPlaceholderEmail';
import { fmt$2dp, fmt$fromCents } from '../../components/adminos/format';

// Cancel-line dialog (cancel-line spec 2026-07-22). Two-step confirm, always:
// a server-computed preview (the SAME core execute runs, inside a rolled-back
// transaction), then a confirm button that restates the act. Removal commits
// first; refunds fire post-commit, so a Stripe failure leaves the removal
// standing with the payment panel as the retry path. Modeled on
// CancelEventDialog. No em dashes in copy.

const OVERLAY = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
};

function mintKey() {
  return (window.crypto && window.crypto.randomUUID)
    ? window.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// entry = a target row from GET /:id/cancel-line/targets
// ({ target, label, quantity?, count?, rate?, labOwned? }).
export default function CancelLineDialog({ proposalId, entry, clientEmail, clientName, onClose, onDone }) {
  const toast = useToast();
  const isGratuity = entry.target === 'gratuity';
  const maxQty = entry.quantity || entry.count || 1;
  const needsOptions = isGratuity || maxQty > 1;

  const [step, setStep] = useState(needsOptions ? 'options' : 'preview');
  const [removeAll, setRemoveAll] = useState(true);
  const [newRate, setNewRate] = useState('');
  const [qty, setQty] = useState(maxQty);
  const [preview, setPreview] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notifyPrompt, setNotifyPrompt] = useState(false);
  const [result, setResult] = useState(null);
  const [idemKey] = useState(mintKey);

  const clientEmailUsable = Boolean(clientEmail) && !isPlaceholderEmail(clientEmail);

  const requestBody = useCallback(() => {
    const body = { target: entry.target };
    if (!isGratuity && maxQty > 1) body.quantity = qty;
    if (isGratuity && !removeAll) body.new_rate = Number(newRate);
    return body;
  }, [entry.target, isGratuity, maxQty, qty, removeAll, newRate]);

  const loadPreview = useCallback(async () => {
    setLoadingPreview(true);
    try {
      const res = await api.post(`/proposals/${proposalId}/cancel-line/preview`, requestBody());
      setPreview(res.data);
      setStep('preview');
    } catch (err) {
      toast.error(err.message || 'Could not load the removal preview.');
      if (needsOptions) setStep('options'); else onClose();
    } finally {
      setLoadingPreview(false);
    }
  }, [proposalId, requestBody, toast, needsOptions, onClose]);

  // Simple targets go straight to the preview. Ref-guarded so React 18
  // StrictMode's double-invoked mount effect fires exactly one POST.
  const previewRequested = useRef(false);
  useEffect(() => {
    if (!needsOptions && !previewRequested.current) {
      previewRequested.current = true;
      loadPreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape' && !submitting && !loadingPreview) onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting, loadingPreview]);

  const doExecute = async (notifyClient) => {
    setNotifyPrompt(false);
    setSubmitting(true);
    try {
      const res = await api.post(`/proposals/${proposalId}/cancel-line`, {
        ...requestBody(),
        reason: reason.trim(),
        idempotency_key: idemKey,
        notify_client: notifyClient,
        fingerprint: preview.fingerprint,
      });
      setResult(res.data);
      setStep('done');
      toast.success(`${res.data.removed_label || 'Line item'} removed.`);
      if (onDone) onDone(res.data);
    } catch (err) {
      if (err.code === 'STALE_PREVIEW') {
        toast.error('The numbers changed since this preview. Review them again.');
        loadPreview();
      } else {
        toast.error(err.message || 'Could not remove the line item.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const busy = submitting || loadingPreview;
  const rateInvalid = isGratuity && !removeAll
    && (!newRate || !Number.isFinite(Number(newRate)) || Number(newRate) < 0 || Number(newRate) >= (entry.rate || 0));

  const delta = preview ? Number(preview.delta) : 0;
  const stripeCents = preview?.refund?.stripe_cents || 0;
  const manualCents = preview?.refund?.manual_return_cents || 0;
  const confirmLabel = stripeCents > 0
    ? `Remove and refund ${fmt$fromCents(stripeCents)}`
    : delta > 0
      ? `Remove (adds ${fmt$2dp(delta)} to the total)`
      : delta < 0
        ? `Remove (client owes ${fmt$2dp(Math.abs(delta))} less)`
        : 'Remove';

  const previewRow = (label, value, strong = false) => (
    <div className="hstack" style={{ justifyContent: 'space-between', fontSize: strong ? 15 : 13 }}>
      <span className="muted">{label}</span>
      <span style={{ fontWeight: strong ? 700 : 500 }}>{value}</span>
    </div>
  );

  return (
    <>
    <div style={OVERLAY} onClick={() => !busy && onClose()}>
      <div className="card" style={{ width: '100%', maxWidth: 520, maxHeight: '85vh', overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <h3>Remove {entry.label}</h3>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onClose}>
            <Icon name="x" size={11} />Close
          </button>
        </div>

        <div className="card-body">
          {step === 'options' && (
            <div className="vstack" style={{ gap: 14 }}>
              {isGratuity ? (
                <>
                  <label className="hstack" style={{ gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
                    <input type="radio" name="gratMode" checked={removeAll} onChange={() => setRemoveAll(true)} />
                    <span>
                      <strong>Remove the gratuity entirely</strong>
                      <div className="tiny muted">The tip jar turns on and staff are notified they can set one out.</div>
                    </span>
                  </label>
                  <label className="hstack" style={{ gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
                    <input type="radio" name="gratMode" checked={!removeAll} onChange={() => setRemoveAll(false)} />
                    <span className="vstack" style={{ gap: 6 }}>
                      <strong>Lower it (currently ${entry.rate}/staff/hr)</strong>
                      <input type="number" min="0" step="1" value={newRate} disabled={removeAll}
                        onChange={(e) => setNewRate(e.target.value)}
                        placeholder="New rate per staff per hour" style={{ maxWidth: 220 }} />
                      <span className="tiny muted">
                        Below the $50 no-jar floor, the tip jar turns on and staff are notified.
                      </span>
                    </span>
                  </label>
                </>
              ) : (
                <label className="vstack" style={{ gap: 6 }}>
                  <span>Remove how many of the {maxQty}?</span>
                  <input type="number" min="1" max={maxQty} step="1" value={qty}
                    onChange={(e) => setQty(Math.max(1, Math.min(maxQty, Number(e.target.value) || 1)))}
                    style={{ maxWidth: 120 }} />
                </label>
              )}
              <div className="hstack" style={{ justifyContent: 'flex-end', gap: 8 }}>
                <button type="button" className="btn btn-secondary" onClick={onClose}>Never mind</button>
                <button type="button" className="btn btn-primary" disabled={loadingPreview || rateInvalid}
                  onClick={loadPreview}>
                  {loadingPreview ? 'Loading…' : 'Review the numbers'}
                </button>
              </div>
            </div>
          )}

          {step === 'preview' && !preview && (
            <div className="muted" style={{ fontSize: 13 }}>Loading preview…</div>
          )}

          {step === 'preview' && preview && (
            <div className="vstack" style={{ gap: 12 }}>
              {/* Server-authoritative statement of what execute will remove:
                  the one cross-check that catches a mis-bound affordance
                  BEFORE money moves. */}
              {preview.removed_label && (
                <div style={{ fontSize: 14 }}>
                  Removing: <strong>{preview.removed_label}</strong>
                </div>
              )}
              <div className="vstack" style={{ gap: 6 }}>
                {previewRow('Current total', fmt$2dp(preview.old_total))}
                {previewRow('New total', fmt$2dp(preview.new_total), true)}
                {previewRow('Change', `${delta > 0 ? '+' : delta < 0 ? '-' : ''}${fmt$2dp(Math.abs(delta))}`)}
                {previewRow('Paid so far', fmt$2dp(preview.amount_paid))}
              </div>

              {stripeCents > 0 && (
                <div className="client-alert client-alert-warning" role="status">
                  The client becomes overpaid. Confirming refunds <strong>{fmt$fromCents(stripeCents)}</strong> to their card.
                </div>
              )}
              {manualCents > 0 && (
                <div className="client-alert client-alert-warning" role="status">
                  {fmt$fromCents(manualCents)} was paid outside Stripe (Zelle or a manual payment). Return it by hand.
                </div>
              )}
              {stripeCents === 0 && manualCents === 0 && delta < 0 && (
                previewRow('Client now owes', fmt$2dp(preview.new_balance_due))
              )}

              {preview.status_will_change && (
                <div className="tiny muted">Payment status changes to {preview.new_status.replace(/_/g, ' ')}.</div>
              )}
              {preview.gratuity?.staff_notice && (
                <div className="tiny muted">Staff will be emailed that they can set out a tip jar.</div>
              )}
              {preview.staffing_warning && (
                <div className="client-alert client-alert-warning" role="status">
                  {preview.staffing_warning.approved} approved {preview.staffing_warning.role.toLowerCase()}s exceed
                  the new roster of {preview.staffing_warning.desired}. Resolve the assignments by hand.
                </div>
              )}
              {(preview.locked_invoices || []).map((inv) => (
                <div key={inv.id} className="tiny muted">
                  A locked {inv.label} invoice for {fmt$fromCents(inv.amount_due_cents)} stands and won't be rebuilt.
                </div>
              ))}
              {(preview.delta_invoices_adjusted || []).map((inv) => (
                <div key={inv.id} className="tiny muted">
                  Open {inv.label} invoice adjusts from {fmt$fromCents(inv.from_cents)} to {fmt$fromCents(inv.to_cents)}.
                </div>
              ))}
              {preview.lab_cleanup && (
                <div className="tiny muted">The client's Enhancement Lab selection is removed too, so it cannot re-add this item.</div>
              )}

              <label className="vstack" style={{ gap: 4, borderTop: '1px solid var(--line-1)', paddingTop: 12 }}>
                <span className="tiny muted">Reason (kept on the audit trail{stripeCents > 0 ? ' and the refund record' : ''})</span>
                <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
                  placeholder="Why is this being removed?" />
              </label>

              <div className="hstack" style={{ justifyContent: 'space-between', gap: 8 }}>
                {needsOptions
                  ? <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setStep('options')}>Back</button>
                  : <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>Never mind</button>}
                <button type="button" className="btn btn-danger" disabled={busy || !reason.trim()}
                  onClick={() => (clientEmailUsable ? setNotifyPrompt(true) : doExecute(false))}>
                  {submitting ? 'Removing…' : confirmLabel}
                </button>
              </div>
            </div>
          )}

          {step === 'done' && result && (
            <div className="vstack" style={{ gap: 12 }}>
              <div className="client-alert client-alert-success" role="status">
                {result.removed_label || 'Line item'} removed. New total <strong>{fmt$2dp(result.new_total)}</strong>.
              </div>
              {(result.refunds || []).filter((r) => r.status === 'succeeded').length > 0 && (
                <div className="client-alert client-alert-success" role="status">
                  Refunded {fmt$fromCents(result.refunds.filter((r) => r.status === 'succeeded')
                    .reduce((s, r) => s + r.amount_cents, 0))} to the client's card.
                </div>
              )}
              {result.refund_incomplete && (
                <div className="client-alert client-alert-warning" role="status">
                  The removal saved, but the refund did not complete. Finish it from the payment panel; the proposal shows as overpaid until then.
                </div>
              )}
              {result.manual_return_cents > 0 && (
                <div className="client-alert client-alert-warning" role="status">
                  {fmt$fromCents(result.manual_return_cents)} was paid outside Stripe. Return it by hand.
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

    {/* OUTSIDE the overlay div: NotifyConfirmModal portals its DOM to
        document.body, but React synthetic events bubble through the COMPONENT
        tree, so nesting it inside the overlay let the Send/Don't-send click
        reach the overlay's click-to-close and unmount the dialog mid-execute
        (the done view never showed — caught in the 2026-07-26 browser walk). */}
      {notifyPrompt && (
        <NotifyConfirmModal
          title="Email the client about this change?"
          notices={[{
            type: stripeCents > 0 ? 'refund_notice' : 'line_item_removed',
            reasons: [stripeCents > 0
              ? `Removal of ${entry.label} with a ${fmt$fromCents(stripeCents)} refund`
              : `Removal of ${entry.label}`],
            composable: false,
            recipient: { name: clientName, email: clientEmail, phone: null },
            channels: { email: { available: true, default: true }, sms: { available: false } },
            autopay_notice: null,
            draft: null,
          }]}
          primary="quiet"
          sendLabel="Send notice"
          quietLabel="Don't send"
          busy={submitting}
          onCancel={() => { if (!submitting) setNotifyPrompt(false); }}
          onQuiet={() => doExecute(false)}
          onSend={() => doExecute(true)}
        />
      )}
    </>
  );
}

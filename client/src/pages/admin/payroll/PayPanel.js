import React, { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import EntityLink from '../../../components/EntityLink';
import StatusChip from '../../../components/adminos/StatusChip';
import { fmt$fromCents, fmtDate } from '../../../components/adminos/format';
import { paymentMethodLabel } from '../userDetail/helpers';

// Every method mark-paid accepts (mirrors ALLOWED_PAY_METHODS server-side).
const METHODS = ['venmo', 'cashapp', 'paypal', 'zelle', 'direct_deposit', 'check', 'other'];
const QR_METHODS = ['venmo', 'cashapp'];
// Methods whose stored handle may surface in the panel. direct_deposit and
// check identifiers are AES-encrypted bank fields that never reach any
// payroll payload (Bank PII invariant); they have no handle here by design.
const HANDLE_METHODS = ['venmo', 'cashapp', 'paypal', 'zelle'];

// pg DATE columns arrive as full ISO strings; keep the calendar date.
const ymd10 = (v) => (v ? String(v).slice(0, 10) : null);

function methodHandle(method, payout) {
  switch (method) {
    case 'venmo': return payout.venmo_handle || null;
    case 'cashapp': return payout.cashapp_handle || null;
    case 'paypal': return payout.paypal_url || null;
    case 'zelle': return payout.zelle_handle || null;
    default: return null;
  }
}

// Prefilled deep link for the method + handle + LOCKED amount. Render-only:
// the URL embeds handle and amount, so it is never logged anywhere.
function buildPayUrl(method, payout, amountCents, note) {
  const amt = (Number(amountCents) / 100).toFixed(2);
  switch (method) {
    case 'venmo': {
      const handle = (payout.venmo_handle || '').replace(/^@/, '').trim();
      if (!handle) return null;
      return `https://venmo.com/?txn=pay&recipients=${encodeURIComponent(handle)}&amount=${amt}&note=${encodeURIComponent(note)}`;
    }
    case 'cashapp': {
      const tag = (payout.cashapp_handle || '').replace(/^\$/, '').trim();
      if (!tag) return null;
      return `https://cash.app/$${encodeURIComponent(tag)}/${amt}`;
    }
    case 'paypal': {
      const url = (payout.paypal_url || '').trim();
      if (!url) return null;
      // Accept either a full paypal.me URL or a bare handle.
      const handle = url.replace(/^https?:\/\/(?:www\.)?paypal\.me\//, '').replace(/^@/, '');
      return `https://paypal.me/${encodeURIComponent(handle)}/${amt}`;
    }
    default:
      return null;
  }
}

// Per-payout pay panel (spec "The pay panel", six states):
//   1. period open/reopened  -> no payment affordances, pointer copy
//   2. processing, no lock   -> method segment + generate/prepare button
//   3. generated, venmo/cashapp -> QR on a white tile
//   4. generated, paypal     -> Open PayPal link
//   5. prepared, zelle/direct_deposit/check/other -> chase link / copy buttons
//   6. invalidated           -> lock cleared, back to 2 with the new total
// The generated artifact is pure client state (never persisted server-side).
export default function PayPanel({ payout, period, onPaid, onDrift }) {
  const toast = useToast();
  const preferred = METHODS.includes(payout.preferred_payment_method)
    ? payout.preferred_payment_method : 'other';
  const [method, setMethod] = useState(preferred);
  // Amount snapshot taken at generate-click; mark-paid sends it back as
  // expected_total_cents so the server drift guard can 409 a stale artifact.
  const [lockedCents, setLockedCents] = useState(null);
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);
  const [reveal, setReveal] = useState(null); // clipboard-fallback value

  const totalCents = Number(payout.total_cents);

  // State 6: a line edit (lifted via onLineSaved) or a refetch that disagrees
  // invalidates the artifact back to state 2 showing the new total.
  useEffect(() => {
    if (lockedCents !== null && totalCents !== lockedCents) setLockedCents(null);
  }, [totalCents, lockedCents]);

  const handle = methodHandle(method, payout);
  const isQr = QR_METHODS.includes(method);
  const missingHandle = HANDLE_METHODS.includes(method) && !handle;
  const profileTo = payout.contractor_id ? `/staffing/users/${payout.contractor_id}` : null;

  const pickMethod = (m) => { setMethod(m); setLockedCents(null); setReveal(null); };

  const copyValue = (value) => {
    setReveal(null);
    const write = (navigator.clipboard && navigator.clipboard.writeText)
      ? navigator.clipboard.writeText(value)
      : Promise.reject(new Error('clipboard unavailable'));
    write
      .then(() => toast.success('Copied.'))
      .catch(() => { toast.error('Copy failed. Select the value below.'); setReveal(value); });
  };

  const markPaid = async () => {
    setSaving(true);
    try {
      const body = {
        payment_method: method,
        payment_handle: handle,
        expected_total_cents: lockedCents,
      };
      const ref = reference.trim();
      if (ref) body.payment_reference = ref;
      const { data } = await api.post(`/admin/payroll/payouts/${payout.id}/mark-paid`, body);
      toast.success(`Paid ${payout.contractor_name}.`);
      onPaid?.(data); // { payout, period_status }
    } catch (err) {
      const msg = String(err.response?.data?.error || err.message || '');
      if (err.response?.status === 409) {
        // Drift guard tripped, or another tab changed the payout/period state:
        // clear the lock and let the parent refetch the true state.
        toast.error(msg.includes('regenerate') ? 'Total changed. Regenerate before paying.' : msg);
        setLockedCents(null);
        onDrift?.();
      } else {
        toast.error(msg || 'Mark paid failed.');
      }
    } finally {
      setSaving(false);
    }
  };

  const noHandleNote = (
    <div className="tiny muted">
      No handle on file. <EntityLink to={profileTo}>Add one on the profile</EntityLink>.
    </div>
  );

  // State 1: period open or reopened. Lines are editable; no payment affordances.
  if (period?.status !== 'processing') {
    const prefHandle = methodHandle(preferred, payout);
    return (
      <div className="pay-panel vstack" style={{ gap: 8 }}>
        <div className="tiny muted">
          Pays via {paymentMethodLabel(preferred) || 'no method on file'}{prefHandle ? ` · ${prefHandle}` : ''}
        </div>
        {HANDLE_METHODS.includes(preferred) && !prefHandle && noHandleNote}
        <div className="muted">Process period to start paying.</div>
      </div>
    );
  }

  const generated = lockedCents !== null;
  const note = `DRB payroll ${fmtDate(ymd10(period.start_date))}–${fmtDate(ymd10(period.end_date))}`;
  const payUrl = generated ? buildPayUrl(method, payout, lockedCents, note) : null;
  // Zelle and the desktop methods always pay by copied amount; degraded QR and
  // PayPal states (no handle, so no code or link) fall back to the same shape.
  const showCopyAmount = !['venmo', 'cashapp', 'paypal'].includes(method) || missingHandle;

  return (
    <div className="pay-panel vstack" style={{ gap: 10 }}>
      <div className="seg pay-panel-seg">
        {METHODS.map(m => (
          <button
            key={m} type="button" className={method === m ? 'active' : ''}
            onClick={() => pickMethod(m)} disabled={saving}
          >
            {paymentMethodLabel(m)}
          </button>
        ))}
      </div>

      {!generated && (
        <>
          <div className="hstack" style={{ justifyContent: 'space-between' }}>
            <span className="tiny muted">Lines total</span>
            <span className="num"><strong>{fmt$fromCents(totalCents)}</strong></span>
          </div>
          {missingHandle && noHandleNote}
          <button
            type="button" className="btn btn-primary btn-sm" disabled={saving}
            onClick={() => { setLockedCents(totalCents); setReveal(null); }}
          >
            {isQr ? `Generate QR · ${fmt$fromCents(totalCents)}` : `Prepare payment · ${fmt$fromCents(totalCents)}`}
          </button>
        </>
      )}

      {generated && (
        <>
          <div className="hstack" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <span className="tiny muted">Locked amount</span>
            <span className="hstack" style={{ gap: 8 }}>
              <StatusChip kind="ok">Matches the code</StatusChip>
              <span className="num"><strong>{fmt$fromCents(lockedCents)}</strong></span>
            </span>
          </div>
          {missingHandle && noHandleNote}

          {isQr && payUrl && (
            <div className="vstack" style={{ gap: 6, alignItems: 'center' }}>
              <div className="pay-qr-tile">
                <QRCodeSVG value={payUrl} size={180} bgColor="#FFFFFF" fgColor="#12161C" level="M" includeMargin />
              </div>
              {method === 'venmo' && (
                <div className="tiny muted">Venmo sometimes drops the amount. Confirm it on your phone before sending.</div>
              )}
            </div>
          )}

          <div className="hstack" style={{ gap: 8, flexWrap: 'wrap' }}>
            {method === 'paypal' && payUrl && (
              <a className="btn btn-ghost btn-sm" href={payUrl} target="_blank" rel="noopener noreferrer">
                Open PayPal
              </a>
            )}
            {method === 'zelle' && (
              <a className="btn btn-ghost btn-sm" href="https://secure.chase.com" target="_blank" rel="noopener noreferrer">
                Open chase.com
              </a>
            )}
            {method === 'zelle' && handle && (
              <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={() => copyValue(handle)}>
                Copy handle
              </button>
            )}
            {showCopyAmount && (
              <button
                type="button" className="btn btn-ghost btn-sm" disabled={saving}
                onClick={() => copyValue((lockedCents / 100).toFixed(2))}
              >
                Copy amount
              </button>
            )}
          </div>

          {reveal !== null && (
            <input
              className="input" readOnly value={reveal} aria-label="Value to copy"
              onFocus={(e) => e.target.select()}
            />
          )}

          <input
            className="input" type="text" maxLength={200} disabled={saving}
            placeholder={method === 'zelle' ? 'Zelle conf. #' : 'Reference (optional)'}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
          <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={markPaid}>
            {saving ? 'Recording…' : `Mark paid · ${fmt$fromCents(lockedCents)}`}
          </button>
        </>
      )}
    </div>
  );
}

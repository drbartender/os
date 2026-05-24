import React, { useState } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import PayQRModal from './PayQRModal';

// Build the prefilled deep link for the given method + handle + amount.
// Returns null when there's no deep link to offer.
function buildPayUrl(method, payout) {
  const amt = (Number(payout.total_cents) / 100).toFixed(2);
  switch (method) {
    case 'venmo': {
      const handle = (payout.venmo_handle || '').replace(/^@/, '').trim();
      if (!handle) return null;
      const note = encodeURIComponent('Dr. Bartender payroll');
      return `https://venmo.com/?txn=pay&recipients=${encodeURIComponent(handle)}&amount=${amt}&note=${note}`;
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

function preferredMethod(payout) {
  return payout.preferred_payment_method || 'other';
}

function methodHandleSnapshot(method, payout) {
  switch (method) {
    case 'venmo': return payout.venmo_handle || null;
    case 'cashapp': return payout.cashapp_handle || null;
    case 'paypal': return payout.paypal_url || null;
    default: return null;
  }
}

export default function MarkPaidAction({ payout, onPaid }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const method = preferredMethod(payout);
  const payUrl = buildPayUrl(method, payout);
  const handle = methodHandleSnapshot(method, payout);

  const confirm = async () => {
    setConfirming(true);
    try {
      const { data } = await api.post(`/admin/payroll/payouts/${payout.id}/mark-paid`, {
        payment_method: method,
        payment_handle: handle,
      });
      toast.success(`Paid ${payout.contractor_name}.`);
      setOpen(false);
      onPaid?.(data); // { payout, period_status }
    } catch (err) {
      toast.error(err.response?.data?.error || err.message);
    } finally {
      setConfirming(false);
    }
  };

  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        Mark paid
      </button>
      {open && (
        <PayQRModal
          payout={payout}
          paymentMethod={method}
          payUrl={payUrl}
          handle={handle}
          confirming={confirming}
          onCancel={() => setOpen(false)}
          onConfirm={confirm}
        />
      )}
    </>
  );
}

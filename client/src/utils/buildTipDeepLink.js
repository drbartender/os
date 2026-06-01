// Returns the URL to navigate to when the customer taps a payment button.
// Cash App and PayPal pre-fill the amount via URL; Venmo and Stripe ignore it.
export function buildTipDeepLink({ kind, handles, amount }) {
  const numAmount = Number(amount);
  const includeAmount = Number.isFinite(numAmount) && numAmount > 0;

  switch (kind) {
    case 'venmo':
      if (!handles.venmo_handle) return null;
      return `https://venmo.com/u/${encodeURIComponent(handles.venmo_handle)}`;
    case 'cashapp':
      if (!handles.cashapp_handle) return null;
      return includeAmount
        ? `https://cash.app/$${encodeURIComponent(handles.cashapp_handle)}/${numAmount}`
        : `https://cash.app/$${encodeURIComponent(handles.cashapp_handle)}`;
    case 'paypal': {
      if (!handles.paypal_url) return null;
      const cleaned = String(handles.paypal_url).replace(/^https?:\/\//, '').replace(/^www\./, '');
      const base = cleaned.startsWith('paypal.me/') ? cleaned : `paypal.me/${cleaned}`;
      const baseTrimmed = base.replace(/\/+$/, '');
      return includeAmount ? `https://${baseTrimmed}/${numAmount}` : `https://${baseTrimmed}`;
    }
    case 'card':
      // Stripe Payment Link doesn't support amount via URL — customer types on Stripe checkout.
      return handles.stripe_payment_link_url || null;
    case 'zelle':
      // Zelle has no universal deep link; the page renders it as a copy-handle row.
      return null;
    default:
      return null;
  }
}

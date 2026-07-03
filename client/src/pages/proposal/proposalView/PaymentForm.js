import React, { useState, useEffect } from 'react';
import { PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import styles from './styles';

// Stripe payment form (must be inside <Elements>).
//
// Sign-then-pay sequencing is critical: `onSubmit()` (which signs) MUST run
// BEFORE `stripe.confirmPayment` redirects to `return_url`. If sign throws,
// payment must NOT fire. Preserve this exactly.

export default function PaymentForm({ onSubmit, payLabel, disabled }) {
  const stripe = useStripe();
  const elements = useElements();
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState('');
  // Skeleton over the PaymentElement until Stripe paints it. The element stays
  // MOUNTED underneath (an overlay, never a conditional swap: if it were
  // unmounted, onReady could never fire and a Stripe-blocked client would be
  // stranded behind an eternal skeleton). The timeout reveals whatever state
  // exists so a genuine mount failure is visible instead of masked.
  const [elementReady, setElementReady] = useState(false);
  const [revealAnyway, setRevealAnyway] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setRevealAnyway(true), 10000);
    return () => clearTimeout(t);
  }, []);

  const handlePay = async (e) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setPaying(true);
    setPayError('');

    // Let parent handle signing first
    try {
      await onSubmit();
    } catch (err) {
      setPayError(err.message || 'Failed to sign. Please try again.');
      setPaying(false);
      return;
    }

    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}${window.location.pathname}?paid=true`,
      },
    });

    if (error) {
      setPayError(error.message || 'Payment failed. Please try again.');
      setPaying(false);
    }
    // On success, Stripe redirects to return_url
  };

  return (
    <form onSubmit={handlePay}>
      <div className="sign-pay-element-slot">
        <PaymentElement onReady={() => setElementReady(true)} />
        {!elementReady && !revealAnyway && (
          <div className="sign-pay-element-skeleton" aria-hidden="true">Loading secure payment…</div>
        )}
      </div>
      {payError && (
        <p style={{ color: '#c0392b', fontSize: '0.875rem', marginTop: '0.75rem' }}>{payError}</p>
      )}
      <button
        type="submit"
        disabled={!stripe || paying || disabled}
        style={{
          ...styles.payButton,
          ...((!stripe || paying || disabled)
            // Solid muted fill + dark label: the old opacity+grayscale overlay
            // collapsed to grey-on-grey exactly when a stuck client stares at
            // this button. Style only; the disabled CONDITION is untouched.
            ? { backgroundColor: '#B8AD98', color: '#3A2E1E', boxShadow: 'none', cursor: 'not-allowed' }
            : { opacity: 1, cursor: 'pointer' }),
        }}
      >
        {paying ? 'Processing...' : payLabel}
      </button>
    </form>
  );
}

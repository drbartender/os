import React, { useState } from 'react';
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
      <PaymentElement />
      {payError && (
        <p style={{ color: '#c0392b', fontSize: '0.875rem', marginTop: '0.75rem' }}>{payError}</p>
      )}
      <button
        type="submit"
        disabled={!stripe || paying || disabled}
        style={{ ...styles.payButton, opacity: (!stripe || paying || disabled) ? 0.6 : 1 }}
      >
        {paying ? 'Processing...' : payLabel}
      </button>
    </form>
  );
}

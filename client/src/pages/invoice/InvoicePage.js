import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import api from '../../utils/api';
import FormBanner from '../../components/FormBanner';
import { useToast } from '../../context/ToastContext';
import { getEventTypeLabel } from '../../utils/eventTypes';

function formatCurrency(cents) {
  if (cents == null) return '$0.00';
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function formatDateOnly(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
}

function PaymentForm({ onSuccess }) {
  const stripe = useStripe();
  const elements = useElements();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setProcessing(true);
    setError('');

    const { error: stripeError } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: window.location.href },
      redirect: 'if_required',
    });

    if (stripeError) {
      setError(stripeError.message);
      setProcessing(false);
    } else {
      onSuccess();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="invoice-payment-form">
      <PaymentElement />
      {error && <p style={{ color: 'var(--rust)', fontSize: '0.85rem', marginTop: '0.5rem' }}>{error}</p>}
      <button type="submit" className="btn" disabled={!stripe || processing} style={{ marginTop: '1rem', width: '100%' }}>
        {processing ? 'Processing...' : 'Pay Now'}
      </button>
    </form>
  );
}

export default function InvoicePage() {
  const { token } = useParams();
  const toast = useToast();
  const [invoice, setInvoice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Form-level error banner (payment section). Stripe Elements handles its
  // own card-validation messaging inside <PaymentForm/>.
  const [formError, setFormError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [clientSecret, setClientSecret] = useState(null);
  const [stripePromise, setStripePromise] = useState(null);
  const [showPayment, setShowPayment] = useState(false);
  const [paymentSuccess, setPaymentSuccess] = useState(false);
  const printRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get(`/invoices/t/${token}`);
        if (!cancelled) setInvoice(data.invoice);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Invoice not found or no longer available.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => {
    if (!invoice || invoice.status === 'paid' || paymentSuccess) return;
    if (stripePromise) return;
    api.get('/stripe/publishable-key').then(({ data }) => {
      if (data.key) setStripePromise(loadStripe(data.key));
    }).catch(() => {});
  }, [invoice, paymentSuccess, stripePromise]);

  const handlePayClick = useCallback(async () => {
    setFormError('');
    setFieldErrors({});
    try {
      const { data } = await api.post(`/stripe/create-intent-for-invoice/${token}`);
      setClientSecret(data.clientSecret);
      setShowPayment(true);
    } catch (err) {
      setFormError(err.message || 'Failed to initiate payment.');
      setFieldErrors(err.fieldErrors || {});
    }
  }, [token]);

  const handlePaymentSuccess = useCallback(() => {
    setPaymentSuccess(true);
    setShowPayment(false);
    toast.success('Payment received!');
    api.get(`/invoices/t/${token}`).then(({ data }) => setInvoice(data.invoice)).catch(err => console.error('Invoice refetch after payment failed:', err));
  }, [token, toast]);

  const handleSavePdf = useCallback(async () => {
    const html2pdf = (await import('html2pdf.js')).default;
    const element = printRef.current;
    if (!element) return;
    const filename = `${invoice.invoice_number}-${invoice.label.replace(/[^a-zA-Z0-9]/g, '-')}.pdf`;
    html2pdf().set({
      margin: [0.5, 0.5, 0.5, 0.5],
      filename,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2 },
      jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' },
    }).from(element).save();
  }, [invoice]);

  if (loading) return <div className="invoice-page"><div className="loading"><div className="spinner" />Loading...</div></div>;
  if (error) return <div className="invoice-page"><div className="card"><p className="text-error">{error}</p></div></div>;
  if (!invoice) return null;

  const isPaid = invoice.status === 'paid' || paymentSuccess;
  const balanceDue = invoice.amount_due - invoice.amount_paid;

  return (
    <div className="invoice-page">
      <div className="invoice-document" ref={printRef}>
        {/* Header */}
        <div className="invoice-header">
          <div>
            <h1 className="invoice-title">INVOICE</h1>
            <p className="invoice-number">{invoice.invoice_number}</p>
          </div>
          <div className="invoice-brand">
            <p className="invoice-brand-name">Dr. Bartender</p>
            <p className="text-muted text-small">contact@drbartender.com</p>
          </div>
        </div>

        {isPaid && (
          <div className="invoice-paid-stamp">PAID</div>
        )}

        <div className="invoice-meta-row">
          <div className="invoice-meta-block">
            <p className="text-muted text-small">Date Issued</p>
            <p>{formatDate(invoice.created_at)}</p>
            {invoice.due_date && (
              <>
                <p className="text-muted text-small" style={{ marginTop: '0.5rem' }}>Due Date</p>
                <p>{formatDateOnly(invoice.due_date)}</p>
              </>
            )}
          </div>
          <div className="invoice-meta-block">
            <p className="text-muted text-small">Bill To</p>
            <p style={{ fontWeight: 600 }}>{invoice.client_name || '—'}</p>
            {invoice.client_email && <p className="text-small">{invoice.client_email}</p>}
            {invoice.client_phone && <p className="text-small">{invoice.client_phone}</p>}
          </div>
        </div>

        <div className="invoice-event-block">
          <p className="text-muted text-small">Event</p>
          <p style={{ fontWeight: 600 }}>{getEventTypeLabel({ event_type: invoice.event_type, event_type_custom: invoice.event_type_custom })}</p>
          <p className="text-small">{formatDateOnly(invoice.event_date)}{invoice.event_location ? ` · ${invoice.event_location}` : ''}{invoice.guest_count ? ` · ${invoice.guest_count} guests` : ''}</p>
        </div>

        <table className="invoice-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Description</th>
              <th style={{ textAlign: 'center' }}>Qty</th>
              <th style={{ textAlign: 'right' }}>Unit Price</th>
              <th style={{ textAlign: 'right' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {(invoice.line_items || []).map(li => (
              <tr key={li.id}>
                <td>{li.description}</td>
                <td style={{ textAlign: 'center' }}>{li.quantity}</td>
                <td style={{ textAlign: 'right' }}>{formatCurrency(li.unit_price)}</td>
                <td style={{ textAlign: 'right' }}>{formatCurrency(li.line_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="invoice-totals">
          <div className="invoice-totals-row">
            <span>Invoice Total</span>
            <span>{formatCurrency(invoice.amount_due)}</span>
          </div>
          {invoice.amount_paid > 0 && (
            <div className="invoice-totals-row">
              <span>Amount Paid</span>
              <span style={{ color: 'var(--sage)' }}>-{formatCurrency(invoice.amount_paid)}</span>
            </div>
          )}
          <div className="invoice-totals-row invoice-totals-balance">
            <span>Balance Due</span>
            <span style={{ color: isPaid ? 'var(--sage)' : 'var(--rust)' }}>
              {isPaid ? '$0.00' : formatCurrency(balanceDue)}
            </span>
          </div>
        </div>

        {isPaid && invoice.payments && invoice.payments.length > 0 && (
          <div className="invoice-payment-details">
            <p className="text-muted text-small" style={{ marginBottom: '0.3rem' }}>Payment Details</p>
            {invoice.payments.map((pay, i) => (
              <p key={i} className="text-small">
                {formatDate(pay.created_at)} — {formatCurrency(pay.amount)} via {pay.payment_type || 'Stripe'}
              </p>
            ))}
          </div>
        )}
      </div>

      <div className="invoice-actions">
        <FormBanner error={formError} fieldErrors={fieldErrors} />

        {!isPaid && balanceDue > 0 && !showPayment && (
          <button className="btn" onClick={handlePayClick} style={{ width: '100%' }}>
            Pay {formatCurrency(balanceDue)}
          </button>
        )}

        {showPayment && clientSecret && stripePromise && (
          <div style={{ marginTop: '1rem' }}>
            <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: 'stripe' } }}>
              <PaymentForm onSuccess={handlePaymentSuccess} />
            </Elements>
          </div>
        )}

        {paymentSuccess && (
          <div className="invoice-success-msg">
            <p>Payment successful! Thank you.</p>
          </div>
        )}

        <button className="btn btn-secondary" onClick={handleSavePdf} style={{ width: '100%', marginTop: '0.75rem' }}>
          Save as PDF
        </button>
      </div>
    </div>
  );
}

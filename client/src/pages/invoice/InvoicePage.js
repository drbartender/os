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
  const [error, setError] = useState(null);
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
        if (!cancelled) setError({ status: err.status, message: err.message });
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
  if (error) {
    const isNotFound = error.status === 404;
    return (
      <main className="invoice-page">
        <div className="public-error">
          <span className="public-error-eyebrow">Invoice</span>
          <h1>{isNotFound ? "We couldn't find that invoice." : "We couldn't load this invoice."}</h1>
          <p className="public-error-body">
            {isNotFound
              ? 'The link may have been mistyped, expired, or the invoice was voided. Double-check the URL — and if you got it from us by email, the latest version is in your inbox.'
              : "Something went wrong on our end. Please try again in a moment, or reach out and we'll send you a fresh link."}
          </p>
          <div className="public-error-actions">
            <a href="mailto:contact@drbartender.com" className="btn btn-primary">Email contact@drbartender.com</a>
            <a href="https://drbartender.com" className="public-error-link">Back to drbartender.com</a>
          </div>
        </div>
      </main>
    );
  }
  if (!invoice) return null;

  const isPaid = invoice.status === 'paid' || paymentSuccess;
  const balanceDue = invoice.amount_due - invoice.amount_paid;

  return (
    <div className="invoice-page">
      <div className="invoice-layout">
        <div className="invoice-document" ref={printRef}>
          {/* Header — brass eyebrow + INVOICE + mono number on left, brand block on right */}
          <div className="invoice-header">
            <div>
              <span className="invoice-eyebrow">Receipt of Service</span>
              <h1 className="invoice-title">INVOICE</h1>
              <p className="invoice-number">{invoice.invoice_number}</p>
            </div>
            <div className="invoice-brand">
              <div className="invoice-brand-mark" aria-hidden="true">D</div>
              <p className="invoice-brand-name">Dr. Bartender, LLC</p>
              <p className="invoice-brand-sub">Mobile Bar · Cocktail Lab</p>
              <p className="invoice-brand-line">Chicago, IL · IL · IN · MI</p>
              <p className="invoice-brand-line">contact@drbartender.com</p>
            </div>
          </div>

          {isPaid && (
            <div className="invoice-paid-stamp" aria-hidden="true">PAID</div>
          )}

          {/* Meta row — 3 columns: Date Issued/Due / Bill To / Event */}
          <div className="invoice-meta-row">
            <div className="invoice-meta-block">
              <p className="invoice-meta-label">Date Issued</p>
              <p className="invoice-meta-value">{formatDate(invoice.created_at)}</p>
              {invoice.due_date && (
                <>
                  <p className="invoice-meta-label" style={{ marginTop: '0.65rem' }}>Due Date</p>
                  <p className="invoice-meta-value">{formatDateOnly(invoice.due_date)}</p>
                </>
              )}
            </div>
            <div className="invoice-meta-block">
              <p className="invoice-meta-label">Bill To</p>
              <p className="invoice-meta-value invoice-meta-strong">{invoice.client_name || '—'}</p>
              {invoice.client_email && <p className="invoice-meta-line">{invoice.client_email}</p>}
              {invoice.client_phone && <p className="invoice-meta-line">{invoice.client_phone}</p>}
            </div>
            <div className="invoice-meta-block">
              <p className="invoice-meta-label">Event</p>
              <p className="invoice-meta-value invoice-meta-strong">
                {getEventTypeLabel({ event_type: invoice.event_type, event_type_custom: invoice.event_type_custom })}
              </p>
              <p className="invoice-meta-line">
                {formatDateOnly(invoice.event_date)}
                {invoice.event_location ? ` · ${invoice.event_location}` : ''}
              </p>
              {invoice.guest_count && (
                <p className="invoice-meta-line">{invoice.guest_count} guests</p>
              )}
            </div>
          </div>

          <table className="invoice-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Description</th>
                <th style={{ textAlign: 'center' }}>Qty</th>
                <th style={{ textAlign: 'right' }}>Unit Price</th>
                <th style={{ textAlign: 'right' }}>Line Total</th>
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
                <span className="invoice-totals-paid">−{formatCurrency(invoice.amount_paid)}</span>
              </div>
            )}
            <div className={`invoice-totals-row invoice-totals-balance ${isPaid ? 'is-paid' : 'is-due'}`}>
              <span>Balance Due</span>
              <span>{isPaid ? '$0.00' : formatCurrency(balanceDue)}</span>
            </div>
          </div>

          {isPaid && invoice.payments && invoice.payments.length > 0 && (
            <div className="invoice-payment-details">
              <p className="invoice-meta-label" style={{ marginBottom: '0.5rem' }}>Payment Record</p>
              {invoice.payments.map((pay, i) => (
                <p key={i} className="invoice-payment-line">
                  {formatDate(pay.created_at)} — {formatCurrency(pay.amount)} via {pay.payment_type || 'Stripe'}
                </p>
              ))}
            </div>
          )}

          <p className="invoice-notes">
            Coverage includes $2 million general &amp; liquor liability insurance.
            Service governed by the standard Dr. Bartender agreement signed with the proposal.
            Questions about this invoice: contact@drbartender.com.
          </p>
        </div>

        {/* Actions — beneath document on mobile, sticky rail on desktop */}
        <div className="invoice-actions">
          <FormBanner error={formError} fieldErrors={fieldErrors} />

          {!isPaid && balanceDue > 0 && (
            <div className="invoice-actions-summary">
              <div className="invoice-actions-eyebrow">Balance Due</div>
              <div className="invoice-actions-total">{formatCurrency(balanceDue)}</div>
            </div>
          )}

          {isPaid && (
            <div className="invoice-actions-summary is-paid">
              <div className="invoice-actions-eyebrow">Paid in Full</div>
              <div className="invoice-actions-total">{formatCurrency(invoice.amount_due)}</div>
            </div>
          )}

          {!isPaid && balanceDue > 0 && !showPayment && (
            <button className="btn btn-primary invoice-pay-btn" onClick={handlePayClick}>
              Pay {formatCurrency(balanceDue)}
            </button>
          )}

          {showPayment && clientSecret && stripePromise && (
            <div className="invoice-payment-wrap">
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

          <button className="btn btn-secondary invoice-pdf-btn" onClick={handleSavePdf}>
            Save as PDF
          </button>

          <p className="invoice-actions-footnote">
            Secured by Stripe · Receipt emailed automatically.
          </p>
        </div>
      </div>
    </div>
  );
}

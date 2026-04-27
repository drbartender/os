import React from 'react';
import { Elements } from '@stripe/react-stripe-js';
import SignaturePad from '../../../components/SignaturePad';
import FormBanner from '../../../components/FormBanner';
import { fmt, formatDateShort, DEPOSIT_DOLLARS } from './helpers';
import styles from './styles';
import PaymentForm from './PaymentForm';

// Renders BOTH the sign-and-pay flow (status: sent/viewed, not yet signed)
// AND the pay-only flow (status: accepted, already signed but not paid).
// Toggle via `mode` prop. Shared payment-options UI is preserved verbatim
// from the pre-refactor inline JSX.

export default function SignAndPaySection({
  mode, // 'signAndPay' | 'payOnly'
  // Signature (signAndPay only)
  sigName,
  setSigName,
  sigData,
  setSigData,
  setSigMethod,
  // Payment options
  paymentOption,
  setPaymentOption,
  autopayChecked,
  setAutopayChecked,
  // Display
  totalPrice,
  balanceAmount,
  balanceDueDate,
  // Payment intent
  loadingIntent,
  formError,
  fieldErrors,
  activeSecret,
  stripePromise,
  payLabel,
  payOnlyLabel,
  // Callbacks
  handleSign,
}) {
  if (mode === 'signAndPay') {
    return (
      <div id="sign-pay-section" style={styles.signPaySection}>
        <h2 style={styles.signPayTitle}>Sign &amp; Secure Your Date</h2>
        <p style={{ color: '#6b4226', fontSize: '0.95rem', marginTop: 0, marginBottom: '1.5rem' }}>
          Complete the form below to accept the terms above and reserve your event.
        </p>

        {/* Signature */}
        <div>
          <label style={styles.label}>Full Legal Name</label>
          <input
            type="text"
            value={sigName}
            onChange={e => setSigName(e.target.value)}
            placeholder="Your full name"
            style={styles.nameInput}
          />
        </div>

        <div style={{ marginTop: '1rem' }}>
          <label style={styles.label}>Signature</label>
          <SignaturePad value={sigData} onChange={(data, method) => { setSigData(data); setSigMethod(method); }} />
        </div>

        {/* Payment Options */}
        <div style={{ marginTop: '1.75rem' }}>
          <label style={styles.label}>Payment Option</label>

          {/* Option 1: Deposit */}
          <label style={{
            ...styles.radioCard,
            border: paymentOption === 'deposit' ? '2px solid #3a2218' : '1px solid #d4c4b0',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="radio"
                name="paymentOption"
                value="deposit"
                checked={paymentOption === 'deposit'}
                onChange={() => setPaymentOption('deposit')}
                style={{ accentColor: '#3a2218' }}
              />
              <div>
                <div style={styles.radioLabel}>Pay {fmt(DEPOSIT_DOLLARS)} Deposit</div>
                <div style={styles.radioDesc}>Remaining balance of {fmt(balanceAmount)} due before your event</div>
              </div>
            </div>

            {/* Autopay checkbox (nested under deposit) */}
            {paymentOption === 'deposit' && balanceAmount > 0 && (
              <label style={styles.autopayRow}>
                <input
                  type="checkbox"
                  checked={autopayChecked}
                  onChange={e => setAutopayChecked(e.target.checked)}
                  style={{ accentColor: '#3a2218', marginTop: '2px' }}
                />
                <span style={styles.autopayText}>
                  Automatically pay remaining {fmt(balanceAmount)} on {formatDateShort(balanceDueDate)}
                </span>
              </label>
            )}
          </label>

          {/* Option 2: Pay in Full */}
          <label style={{
            ...styles.radioCard,
            border: paymentOption === 'full' ? '2px solid #3a2218' : '1px solid #d4c4b0',
            marginTop: '0.5rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="radio"
                name="paymentOption"
                value="full"
                checked={paymentOption === 'full'}
                onChange={() => { setPaymentOption('full'); setAutopayChecked(false); }}
                style={{ accentColor: '#3a2218' }}
              />
              <div>
                <div style={styles.radioLabel}>Pay in Full — {fmt(totalPrice)}</div>
                <div style={styles.radioDesc}>No remaining balance</div>
              </div>
            </div>
          </label>
        </div>

        {/* Stripe Payment Element */}
        <div style={{ marginTop: '1.5rem' }}>
          {loadingIntent && (
            <div style={{ textAlign: 'center', padding: '2rem' }}>
              <div className="spinner" />
            </div>
          )}

          <FormBanner error={formError} fieldErrors={fieldErrors} />

          {activeSecret && stripePromise && !loadingIntent && (
            <Elements
              key={activeSecret}
              stripe={stripePromise}
              options={{ clientSecret: activeSecret, appearance: { theme: 'stripe' } }}
            >
              <PaymentForm
                onSubmit={handleSign}
                payLabel={payLabel}
                disabled={!sigName.trim() || !sigData}
              />
            </Elements>
          )}

          {activeSecret && !stripePromise && !loadingIntent && (
            <div style={{ textAlign: 'center', padding: '1rem' }}>
              <div className="spinner" />
            </div>
          )}

          {!activeSecret && !loadingIntent && !formError && (
            <p style={{ color: '#c0392b', fontSize: '0.875rem' }}>
              Unable to load payment form. Please refresh the page or contact us at contact@drbartender.com.
            </p>
          )}
        </div>
      </div>
    );
  }

  // mode === 'payOnly' — backward-compat: already signed under old flow, not yet paid
  return (
    <div id="sign-pay-section" style={styles.signPaySection}>
      <h2 style={styles.signPayTitle}>Complete Your Payment</h2>
      <p style={{ color: '#6b4226', marginBottom: '0.5rem', fontSize: '0.95rem' }}>
        Your proposal has been accepted! Choose a payment option below to secure your booking.
      </p>

      {/* Payment Options */}
      <div style={{ marginTop: '1rem', marginBottom: '1.5rem' }}>
        <label style={{
          ...styles.radioCard,
          border: paymentOption === 'deposit' ? '2px solid #3a2218' : '1px solid #d4c4b0',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="radio"
              name="paymentOption"
              value="deposit"
              checked={paymentOption === 'deposit'}
              onChange={() => setPaymentOption('deposit')}
              style={{ accentColor: '#3a2218' }}
            />
            <div>
              <div style={styles.radioLabel}>Pay {fmt(DEPOSIT_DOLLARS)} Deposit</div>
              <div style={styles.radioDesc}>Remaining balance of {fmt(balanceAmount)} due before your event</div>
            </div>
          </div>
          {paymentOption === 'deposit' && balanceAmount > 0 && (
            <label style={styles.autopayRow}>
              <input
                type="checkbox"
                checked={autopayChecked}
                onChange={e => setAutopayChecked(e.target.checked)}
                style={{ accentColor: '#3a2218', marginTop: '2px' }}
              />
              <span style={styles.autopayText}>
                Automatically pay remaining {fmt(balanceAmount)} on {formatDateShort(balanceDueDate)}
              </span>
            </label>
          )}
        </label>

        <label style={{
          ...styles.radioCard,
          border: paymentOption === 'full' ? '2px solid #3a2218' : '1px solid #d4c4b0',
          marginTop: '0.5rem',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="radio"
              name="paymentOption"
              value="full"
              checked={paymentOption === 'full'}
              onChange={() => { setPaymentOption('full'); setAutopayChecked(false); }}
              style={{ accentColor: '#3a2218' }}
            />
            <div>
              <div style={styles.radioLabel}>Pay in Full — {fmt(totalPrice)}</div>
              <div style={styles.radioDesc}>No remaining balance</div>
            </div>
          </div>
        </label>
      </div>

      {loadingIntent && (
        <div style={{ textAlign: 'center', padding: '2rem' }}>
          <div className="spinner" />
        </div>
      )}

      <FormBanner error={formError} fieldErrors={fieldErrors} />

      {activeSecret && stripePromise && !loadingIntent && (
        <Elements
          key={activeSecret}
          stripe={stripePromise}
          options={{ clientSecret: activeSecret, appearance: { theme: 'stripe' } }}
        >
          <PaymentForm
            onSubmit={async () => {}} // Already signed, no-op
            payLabel={payOnlyLabel}
            disabled={false}
          />
        </Elements>
      )}

      {activeSecret && !stripePromise && !loadingIntent && (
        <div style={{ textAlign: 'center', padding: '1rem' }}>
          <div className="spinner" />
        </div>
      )}

      {!activeSecret && !loadingIntent && !formError && (
        <p style={{ color: '#c0392b', fontSize: '0.875rem' }}>
          Unable to load payment form. Please refresh the page or contact us at contact@drbartender.com.
        </p>
      )}
    </div>
  );
}

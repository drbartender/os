import React, { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import SignaturePad from '../../components/SignaturePad';
import { API_BASE_URL as BASE_URL } from '../../utils/api';
import { COMPANY_PHONE } from '../../utils/constants';

const stripePromise = loadStripe(process.env.REACT_APP_STRIPE_PUBLISHABLE_KEY);

const DEPOSIT_CENTS = parseInt(process.env.REACT_APP_DEPOSIT_AMOUNT) || 10000;
const DEPOSIT_DOLLARS = DEPOSIT_CENTS / 100;

const fmt = (n) =>
  `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function formatTime(t) {
  if (!t) return '';
  const [hStr, mStr] = t.split(':');
  const h = parseInt(hStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  return `${h12}:${mStr} ${ampm}`;
}

function calcEndTime(startTime, durationHours) {
  if (!startTime) return '';
  const [hStr, mStr] = startTime.split(':');
  const totalMinutes = parseInt(hStr, 10) * 60 + parseInt(mStr, 10) + Math.round(Number(durationHours) * 60);
  const endH = Math.floor(totalMinutes / 60) % 24;
  const endM = totalMinutes % 60;
  return formatTime(`${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`);
}

function formatDateShort(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// ─── Stripe payment form (must be inside <Elements>) ─────────────

function PaymentForm({ onSubmit, payLabel, disabled }) {
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

// ─── Main component ───────────────────────────────────────────────

export default function ProposalView() {
  const { token } = useParams();
  const [proposal, setProposal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Signing state
  const [sigName, setSigName] = useState('');
  const [sigData, setSigData] = useState('');
  const [sigMethod, setSigMethod] = useState(null);
  const [sigError, setSigError] = useState('');

  // Payment option state
  const [paymentOption, setPaymentOption] = useState('deposit');
  const [autopayChecked, setAutopayChecked] = useState(false);

  // Intent state — track separate secrets for deposit vs full
  const [depositSecret, setDepositSecret] = useState('');
  const [fullSecret, setFullSecret] = useState('');
  const [loadingIntent, setLoadingIntent] = useState(false);

  // Check if returning from Stripe redirect
  const paid = new URLSearchParams(window.location.search).get('paid') === 'true';

  useEffect(() => {
    axios.get(`${BASE_URL}/proposals/t/${token}`)
      .then(res => setProposal(res.data))
      .catch(() => setError('Proposal not found or has expired.'))
      .finally(() => setLoading(false));
  }, [token]);

  // Create or retrieve a payment intent for the given option
  const loadIntent = useCallback(async (option, autopay = false) => {
    setLoadingIntent(true);
    try {
      const res = await axios.post(`${BASE_URL}/stripe/create-intent/${token}`, {
        payment_option: option,
        autopay,
      });
      if (option === 'full') {
        setFullSecret(res.data.clientSecret);
      } else {
        setDepositSecret(res.data.clientSecret);
      }
    } catch (err) {
      console.error('Failed to load payment intent:', err);
    } finally {
      setLoadingIntent(false);
    }
  }, [token]);

  // Load initial deposit intent when proposal is ready for signing+payment
  useEffect(() => {
    if (!proposal || paid) return;
    const canPay = ['sent', 'viewed', 'accepted'].includes(proposal.status);
    if (canPay && !depositSecret) {
      loadIntent('deposit', false);
    }
  }, [proposal, paid, depositSecret, loadIntent]);

  // When user switches to full payment, load a full intent
  useEffect(() => {
    if (paymentOption === 'full' && !fullSecret && proposal && !paid) {
      loadIntent('full', false);
    }
  }, [paymentOption, fullSecret, proposal, paid, loadIntent]);

  // When autopay is toggled, re-create the deposit intent with setup_future_usage
  useEffect(() => {
    if (paymentOption === 'deposit' && proposal && !paid) {
      // Reset deposit secret so a new intent is created with correct autopay flag
      setDepositSecret('');
      loadIntent('deposit', autopayChecked);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autopayChecked]);

  const formatDate = (d) => {
    if (!d) return '';
    return new Date(d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  };

  // Sign the proposal — called by PaymentForm before confirming payment
  const handleSign = async () => {
    if (!sigName.trim()) throw new Error('Please enter your full name.');
    if (!sigData) throw new Error('Please add your signature.');
    setSigError('');

    // If already signed (backward compat), skip signing
    if (proposal.client_signed_at) return;

    try {
      await axios.post(`${BASE_URL}/proposals/t/${token}/sign`, {
        client_signed_name: sigName.trim(),
        client_signature_data: sigData,
        client_signature_method: sigMethod,
      });
      setProposal(prev => ({ ...prev, status: 'accepted', client_signed_at: new Date().toISOString() }));
    } catch (err) {
      throw new Error(err.response?.data?.error || 'Failed to save signature. Please try again.');
    }
  };

  if (loading) {
    return (
      <div style={styles.page}>
        <div style={styles.container}>
          <div style={{ textAlign: 'center', padding: '4rem' }}>
            <div className="spinner" />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles.page}>
        <div style={styles.container}>
          <div style={{ textAlign: 'center', padding: '4rem' }}>
            <h2 style={styles.heading}>Oops!</h2>
            <p style={{ color: '#6b4226', marginTop: '0.5rem' }}>{error}</p>
          </div>
        </div>
      </div>
    );
  }

  const snapshot = proposal.pricing_snapshot;
  const bartenders = snapshot?.staffing?.actual;
  const durationHours = snapshot?.inputs?.durationHours;

  // Replace dynamic placeholders in package includes
  const rawIncludes = proposal.package_includes || [];
  const includes = rawIncludes.map(item => {
    let text = item;
    if (durationHours != null) text = text.replace(/\{hours\}/g, durationHours);
    if (bartenders != null) {
      text = text.replace(/\{bartenders\}/g, bartenders);
      text = text.replace(/\{bartenders_s\}/g, bartenders !== 1 ? 's' : '');
    }
    return text;
  });
  const totalPrice = snapshot ? Number(snapshot.total) : 0;
  const balanceAmount = totalPrice - DEPOSIT_DOLLARS;

  // Calculate balance due date (from DB or default 14 days before event)
  let balanceDueDate = proposal.balance_due_date;
  if (!balanceDueDate && proposal.event_date) {
    const d = new Date(proposal.event_date);
    d.setDate(d.getDate() - 14);
    balanceDueDate = d.toISOString();
  }

  const lineItems = [];
  if (snapshot) {
    const packageTotal = (snapshot.package.base_cost || 0) + (snapshot.staffing?.total || 0);
    lineItems.push({ label: proposal.package_name, amount: packageTotal });
    if (snapshot.bar_rental?.total > 0) {
      lineItems.push({ label: 'Bar Rental', amount: snapshot.bar_rental.total });
    }
    (snapshot.addons || []).forEach(a => {
      lineItems.push({ label: a.name, amount: a.line_total });
    });
  }

  const isAlreadySigned = !!proposal.client_signed_at;
  const isPaid = ['deposit_paid', 'balance_paid', 'confirmed'].includes(proposal.status) || paid;

  // Combined sign+pay section (new flow)
  const showSignAndPay = !isPaid && !isAlreadySigned && ['sent', 'viewed'].includes(proposal.status);

  // Pay-only section (backward compat: already signed under old flow, not yet paid)
  const showPayOnly = !isPaid && isAlreadySigned && proposal.status === 'accepted';

  const activeSecret = paymentOption === 'full' ? fullSecret : depositSecret;
  const payLabel = paymentOption === 'full'
    ? `Sign & Pay ${fmt(totalPrice)}`
    : `Sign & Pay ${fmt(DEPOSIT_DOLLARS)} Deposit`;
  const payOnlyLabel = paymentOption === 'full'
    ? `Pay ${fmt(totalPrice)}`
    : `Pay ${fmt(DEPOSIT_DOLLARS)} Deposit`;

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        {/* Header */}
        <div style={styles.header}>
          <h1 style={styles.brand}>Dr. Bartender</h1>
          <p style={styles.tagline}>Your Event Proposal</p>
        </div>

        {/* Event Details */}
        <div style={styles.section}>
          <h2 style={styles.sectionTitle}>{proposal.event_name || 'Your Event'}</h2>
          <div style={styles.detailGrid}>
            {proposal.event_date && (
              <div style={{ ...styles.detailItem, gridColumn: '1 / -1' }}>
                <span style={styles.detailLabel}>Date</span>
                <span style={styles.detailValue}>{formatDate(proposal.event_date)}</span>
              </div>
            )}
            {proposal.event_start_time && (
              <div style={{ ...styles.detailItem, gridColumn: '1 / -1' }}>
                <span style={styles.detailLabel}>Service Time</span>
                <span style={styles.detailValue}>
                  {formatTime(proposal.event_start_time)} – {calcEndTime(proposal.event_start_time, proposal.event_duration_hours)}
                </span>
              </div>
            )}
            <div style={styles.detailItem}>
              <span style={styles.detailLabel}>Guests</span>
              <span style={styles.detailValue}>{proposal.guest_count}</span>
            </div>
            {bartenders != null && (
              <div style={styles.detailItem}>
                <span style={styles.detailLabel}>Bartenders</span>
                <span style={styles.detailValue}>{bartenders}</span>
              </div>
            )}
            {proposal.event_location && (
              <div style={{ ...styles.detailItem, gridColumn: '1 / -1' }}>
                <span style={styles.detailLabel}>Location</span>
                <span style={styles.detailValue}>{proposal.event_location}</span>
              </div>
            )}
          </div>
        </div>

        {/* Package */}
        <div style={styles.section}>
          <h2 style={styles.sectionTitle}>{proposal.package_name}</h2>
          {includes.length > 0 && (
            <ul style={styles.includesList}>
              {includes.map((item, i) => (
                <li key={i} style={styles.includesItem}>{item}</li>
              ))}
            </ul>
          )}
        </div>

        {/* Pricing */}
        <div style={styles.section}>
          <h2 style={styles.sectionTitle}>Pricing</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {lineItems.map((item, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #ede3d3' }}>
                  <td style={{ padding: '0.55rem 0', color: '#3a2218', fontSize: '0.95rem' }}>
                    {item.label}
                  </td>
                  <td style={{ padding: '0.55rem 0', textAlign: 'right', color: '#3a2218', fontSize: '0.95rem', fontWeight: 500, whiteSpace: 'nowrap' }}>
                    {fmt(item.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid #3a2218' }}>
                <td style={{ padding: '0.75rem 0', fontWeight: 700, fontSize: '1.1rem', color: '#3a2218', fontFamily: 'Georgia, "Times New Roman", serif' }}>
                  Total
                </td>
                <td style={{ padding: '0.75rem 0', textAlign: 'right', fontWeight: 700, fontSize: '1.1rem', color: '#3a2218', fontFamily: 'Georgia, "Times New Roman", serif' }}>
                  {snapshot ? fmt(snapshot.total) : '—'}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* ── Terms & Conditions (always visible) ── */}
        <div style={styles.section}>
          <h2 style={styles.sectionTitle}>Standard Terms and Conditions</h2>
          <div style={styles.contractScroll}>
            <p style={styles.contractText}>
              This agreement is made between <strong>Dr. Bartender, LLC</strong> ("Dr. Bartender") and the Client. These terms govern the provision of bartending services and outline the responsibilities of both parties.
            </p>

            <p style={{ ...styles.contractText, fontWeight: 600 }}>2. Termination and Cancellation</p>
            <ul style={styles.contractList}>
              <li style={styles.contractListItem}><strong>Client Cancellation:</strong> If canceled within 30 days of the event, the full contract amount is due. Outside of 30 days, only the deposit is non-refundable.</li>
              <li style={styles.contractListItem}><strong>Dr. Bartender Cancellation:</strong> If Dr. Bartender cancels, the Client will receive a full refund of any paid amount, including the deposit.</li>
            </ul>

            <p style={{ ...styles.contractText, fontWeight: 600 }}>3. Dr. Bartender's Duties</p>
            <ul style={styles.contractList}>
              <li style={styles.contractListItem}>Perform all services professionally and safely.</li>
              <li style={styles.contractListItem}>Staff events based on the anticipated number of guests.</li>
              <li style={styles.contractListItem}>Clean and remove all equipment brought to the event.</li>
              <li style={styles.contractListItem}>Maintain necessary permits and liquor liability insurance.</li>
              <li style={styles.contractListItem}>Act as the sole provider of bartending services unless otherwise agreed upon.</li>
            </ul>

            <p style={{ ...styles.contractText, fontWeight: 600 }}>4. Client's Duties</p>
            <ul style={styles.contractList}>
              <li style={styles.contractListItem}>Provide prompt payment as outlined in the Event-Specific Agreement.</li>
              <li style={styles.contractListItem}>Supply an accurate guest count no later than 14 days before the event.</li>
              <li style={styles.contractListItem}>Specify whether Dr. Bartender will supply alcohol. If the Client provides alcohol, they assume responsibility for quality and quantity.</li>
            </ul>

            <p style={{ ...styles.contractText, fontWeight: 600 }}>5. Insurance</p>
            <p style={styles.contractText}>
              Dr. Bartender maintains liquor liability insurance with a $1,000,000 limit per occurrence and a $2,000,000 aggregate. Proof of insurance is available upon request.
            </p>

            <p style={{ ...styles.contractText, fontWeight: 600 }}>6. Indemnification</p>
            <ul style={styles.contractList}>
              <li style={styles.contractListItem}><strong>Dr. Bartender:</strong> Will indemnify the Client for claims arising directly from its services, excluding incidents caused by event guests.</li>
              <li style={styles.contractListItem}><strong>Client:</strong> Will indemnify Dr. Bartender for incidents arising from willful conduct, error, or negligence by the Client or event guests.</li>
            </ul>

            <p style={{ ...styles.contractText, fontWeight: 600 }}>7. Force Majeure</p>
            <p style={styles.contractText}>
              Neither party is responsible for performance delays due to uncontrollable events (e.g., natural disasters, acts of God). Services will resume once conditions permit.
            </p>

            <p style={{ ...styles.contractText, fontWeight: 600 }}>8. Photography and Social Media</p>
            <p style={styles.contractText}>
              The Client consents to Dr. Bartender photographing the event for promotional use. Dr. Bartender agrees to provide the Client with copies of event photos upon request.
            </p>

            <p style={{ ...styles.contractText, fontWeight: 600 }}>9. Service of Alcohol</p>
            <ul style={styles.contractList}>
              <li style={styles.contractListItem}><strong>Age Verification:</strong> Alcohol will only be served to legally eligible guests with valid identification.</li>
              <li style={styles.contractListItem}><strong>Right to Refuse Service:</strong> Dr. Bartender reserves the right to refuse service to intoxicated or inappropriate guests.</li>
              <li style={styles.contractListItem}><strong>Drink Limit Policy:</strong> All-inclusive packages do not imply unlimited alcohol; limits are set to ensure guest safety.</li>
            </ul>

            <p style={{ ...styles.contractText, fontWeight: 600 }}>10. Miscellaneous Terms</p>
            <ul style={styles.contractList}>
              <li style={styles.contractListItem}><strong>Independent Contractor:</strong> Dr. Bartender acts as an independent contractor.</li>
              <li style={styles.contractListItem}><strong>Jurisdiction:</strong> This agreement is governed by Illinois state law, with any disputes settled in Winnebago County, IL.</li>
              <li style={styles.contractListItem}><strong>Entire Agreement:</strong> These terms represent the entire understanding between the Client and Dr. Bartender.</li>
            </ul>

            <p style={styles.contractText}>
              By signing below, the Client agrees to all terms above and confirms that the event details in this proposal are accurate.
            </p>
          </div>
        </div>

        {/* ── Payment Summary (always visible) ── */}
        <div style={styles.section}>
          <h2 style={styles.sectionTitle}>Payment Terms</h2>
          <div style={styles.paymentSummary}>
            <div style={styles.paymentRow}>
              <span style={styles.paymentLabel}>Deposit Due at Signing</span>
              <span style={styles.paymentValue}>{fmt(DEPOSIT_DOLLARS)}</span>
            </div>
            <div style={styles.paymentRow}>
              <span style={styles.paymentLabel}>Remaining Balance</span>
              <span style={styles.paymentValue}>{fmt(balanceAmount)}</span>
            </div>
            <div style={{ ...styles.paymentRow, borderBottom: 'none' }}>
              <span style={styles.paymentLabel}>Balance Due By</span>
              <span style={styles.paymentValue}>{formatDateShort(balanceDueDate)}</span>
            </div>
          </div>

          {/* CTA button */}
          {(showSignAndPay || showPayOnly) && (
            <button
              onClick={() => document.getElementById('sign-pay-section')?.scrollIntoView({ behavior: 'smooth' })}
              style={styles.ctaButton}
            >
              {showSignAndPay ? 'Sign & Secure Your Date' : 'Complete Your Payment'}
            </button>
          )}
        </div>

        {/* ── Signature + Payment Form ── */}
        {showSignAndPay && (
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

            {sigError && (
              <p style={{ color: '#c0392b', fontSize: '0.875rem', marginTop: '0.75rem' }}>{sigError}</p>
            )}

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

              {activeSecret && !loadingIntent && (
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

              {!activeSecret && !loadingIntent && (
                <p style={{ color: '#c0392b', fontSize: '0.875rem' }}>
                  Unable to load payment form. Please refresh the page or contact us at contact@drbartender.com.
                </p>
              )}
            </div>
          </div>
        )}

        {/* ── Pay-only section (backward compat: already signed, not paid) ── */}
        {showPayOnly && (
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

            {activeSecret && !loadingIntent && (
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

            {!activeSecret && !loadingIntent && (
              <p style={{ color: '#c0392b', fontSize: '0.875rem' }}>
                Unable to load payment form. Please refresh the page or contact us at contact@drbartender.com.
              </p>
            )}
          </div>
        )}

        {/* ── Payment Confirmed ── */}
        {isPaid && (
          <div style={styles.paidBanner}>
            <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>&#127881;</div>
            {(proposal.status === 'balance_paid' || proposal.payment_type === 'full') ? (
              <>
                <h3 style={{ fontFamily: 'Georgia, "Times New Roman", serif', color: '#2d6a4f', margin: '0 0 0.5rem' }}>
                  Fully Paid!
                </h3>
                <p style={{ color: '#40916c', margin: 0, fontSize: '0.95rem' }}>
                  Your booking is confirmed. We'll be in touch with event details closer to the date.
                </p>
              </>
            ) : proposal.autopay_enrolled ? (
              <>
                <h3 style={{ fontFamily: 'Georgia, "Times New Roman", serif', color: '#2d6a4f', margin: '0 0 0.5rem' }}>
                  Deposit Received!
                </h3>
                <p style={{ color: '#40916c', margin: 0, fontSize: '0.95rem' }}>
                  Your remaining balance of {fmt(balanceAmount)} will be automatically charged on {formatDateShort(balanceDueDate)}.
                  We'll be in touch with event details closer to the date.
                </p>
              </>
            ) : (
              <>
                <h3 style={{ fontFamily: 'Georgia, "Times New Roman", serif', color: '#2d6a4f', margin: '0 0 0.5rem' }}>
                  Deposit Received!
                </h3>
                <p style={{ color: '#40916c', margin: 0, fontSize: '0.95rem' }}>
                  Your remaining balance of {fmt(balanceAmount)} is due by {formatDateShort(balanceDueDate)}.
                  We'll be in touch with event details closer to the date.
                </p>
              </>
            )}
          </div>
        )}

        {/* Footer */}
        <div style={styles.footer}>
          <p style={{ fontSize: '0.85rem', color: '#8b7355' }}>
            Questions? Contact us at contact@drbartender.com or {COMPANY_PHONE}
          </p>
        </div>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    background: 'linear-gradient(180deg, #faf5ef 0%, #f5ede0 100%)',
    padding: '2rem 1rem',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  container: {
    maxWidth: '680px',
    margin: '0 auto',
    background: '#fff',
    borderRadius: '12px',
    boxShadow: '0 4px 24px rgba(58, 34, 24, 0.1)',
    overflow: 'hidden',
  },
  header: {
    textAlign: 'center',
    padding: '2.5rem 2rem 1.5rem',
    borderBottom: '1px solid #e8e0d4',
  },
  brand: {
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontSize: '2rem',
    color: '#3a2218',
    margin: 0,
  },
  tagline: {
    color: '#8b7355',
    marginTop: '0.3rem',
    fontSize: '1rem',
    letterSpacing: '0.05em',
  },
  section: {
    padding: '1.5rem 2rem',
    borderBottom: '1px solid #e8e0d4',
  },
  sectionTitle: {
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontSize: '1.2rem',
    color: '#3a2218',
    marginBottom: '1rem',
    marginTop: 0,
  },
  heading: {
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontSize: '1.5rem',
    color: '#3a2218',
  },
  detailGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '0.75rem',
  },
  detailItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.2rem',
  },
  detailLabel: {
    fontSize: '0.75rem',
    color: '#8b7355',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  detailValue: {
    fontSize: '0.95rem',
    color: '#3a2218',
    fontWeight: 500,
  },
  includesList: {
    margin: 0,
    padding: '0 0 0 1.2rem',
    color: '#6b4226',
  },
  includesItem: {
    fontSize: '0.9rem',
    marginBottom: '0.3rem',
  },
  contractScroll: {
    maxHeight: '300px',
    overflowY: 'auto',
    background: '#faf5ef',
    border: '1px solid #e8e0d4',
    borderRadius: '8px',
    padding: '1.25rem',
  },
  contractText: {
    fontSize: '0.875rem',
    color: '#4a3520',
    lineHeight: 1.6,
    marginBottom: '0.75rem',
    marginTop: 0,
  },
  contractList: {
    margin: '0 0 0.75rem 0',
    padding: '0 0 0 1.2rem',
    color: '#4a3520',
  },
  contractListItem: {
    fontSize: '0.875rem',
    lineHeight: 1.6,
    marginBottom: '0.35rem',
  },
  paymentSummary: {
    background: '#faf5ef',
    border: '1px solid #e8e0d4',
    borderRadius: '8px',
    padding: '0.25rem 1.25rem',
  },
  paymentRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.75rem 0',
    borderBottom: '1px solid #e8e0d4',
  },
  paymentLabel: {
    fontSize: '0.9rem',
    color: '#6b4226',
  },
  paymentValue: {
    fontSize: '0.95rem',
    fontWeight: 600,
    color: '#3a2218',
  },
  ctaButton: {
    display: 'block',
    width: '100%',
    marginTop: '1.25rem',
    padding: '1rem',
    background: '#2d6a4f',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    fontSize: '1.1rem',
    fontWeight: 700,
    cursor: 'pointer',
    letterSpacing: '0.02em',
    fontFamily: 'Georgia, "Times New Roman", serif',
  },
  signPaySection: {
    padding: '2rem',
    background: '#f9f5ef',
    borderBottom: '1px solid #e8e0d4',
  },
  signPayTitle: {
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontSize: '1.3rem',
    color: '#2d6a4f',
    marginBottom: '0.25rem',
    marginTop: 0,
  },
  label: {
    display: 'block',
    fontSize: '0.8rem',
    fontWeight: 600,
    color: '#6b4226',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: '0.4rem',
  },
  nameInput: {
    width: '100%',
    padding: '0.6rem 0.75rem',
    border: '1px solid #d4c4b0',
    borderRadius: '6px',
    fontSize: '0.95rem',
    color: '#3a2218',
    background: '#fff',
    boxSizing: 'border-box',
    outline: 'none',
  },
  radioCard: {
    display: 'block',
    padding: '0.85rem 1rem',
    borderRadius: '8px',
    cursor: 'pointer',
    background: '#faf5ef',
  },
  radioLabel: {
    fontSize: '0.95rem',
    fontWeight: 600,
    color: '#3a2218',
  },
  radioDesc: {
    fontSize: '0.8rem',
    color: '#8b7355',
    marginTop: '0.15rem',
  },
  autopayRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.5rem',
    marginTop: '0.75rem',
    paddingTop: '0.75rem',
    borderTop: '1px solid #e8e0d4',
    cursor: 'pointer',
  },
  autopayText: {
    fontSize: '0.85rem',
    color: '#4a3520',
    lineHeight: 1.4,
  },
  payButton: {
    marginTop: '1.25rem',
    width: '100%',
    padding: '0.85rem',
    background: '#2d6a4f',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    fontSize: '1rem',
    fontWeight: 600,
    cursor: 'pointer',
    letterSpacing: '0.02em',
  },
  paidBanner: {
    padding: '2rem',
    textAlign: 'center',
    background: '#d8f3dc',
    borderBottom: '1px solid #b7e4c7',
  },
  footer: {
    textAlign: 'center',
    padding: '1.5rem 2rem',
  },
};

import React, { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';
import { loadStripe } from '@stripe/stripe-js';
import { useToast } from '../../../context/ToastContext';
import { API_BASE_URL as BASE_URL } from '../../../utils/api';
import { COMPANY_PHONE } from '../../../utils/constants';
import { fmt, formatDateShort, DEPOSIT_DOLLARS } from './helpers';
import styles from './styles';
import { EVENT_SERVICES_AGREEMENT } from '../../../data/eventServicesAgreement';
import ProposalHeader from './ProposalHeader';
import ProposalPricingBreakdown from './ProposalPricingBreakdown';
import SignAndPaySection from './SignAndPaySection';

// ─── Main component ───────────────────────────────────────────────

export default function ProposalView() {
  const { token } = useParams();
  const toast = useToast();
  const [proposal, setProposal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Form-level error banner (sign-and-pay section). Stripe card errors are
  // handled by Stripe Elements' own messaging inside <PaymentForm/>.
  const [formError, setFormError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});

  // Signing state
  const [sigName, setSigName] = useState('');
  const [sigData, setSigData] = useState('');
  const [sigMethod, setSigMethod] = useState(null);
  const [venue, setVenue] = useState({
    venue_name: '', venue_street: '', venue_city: '', venue_state: '', venue_zip: '',
  });
  const signedThisSession = useRef(false);

  // Payment option state
  const [paymentOption, setPaymentOption] = useState('deposit');
  const [autopayChecked, setAutopayChecked] = useState(false);

  // Intent state — track separate secrets for deposit vs full
  const [depositSecret, setDepositSecret] = useState('');
  const [fullSecret, setFullSecret] = useState('');
  const [loadingIntent, setLoadingIntent] = useState(false);
  // Track which autopay value the cached depositSecret was created with, so
  // we know when to refetch after the user toggles the autopay checkbox.
  const depositIntentAutopayRef = useRef(null);

  // Stripe.js loader — publishable key is fetched from the server so the
  // mode (live vs test) always matches what the server uses for intents.
  const [stripePromise, setStripePromise] = useState(null);

  // Check if returning from Stripe redirect
  const paid = new URLSearchParams(window.location.search).get('paid') === 'true';

  // Derived flag: is this proposal in a state where payment is still possible?
  // Mirrors the business logic used below (showSignAndPay / showPayOnly) so
  // we don't load Stripe.js or create intents for paid/confirmed proposals.
  const isPayableStatus =
    !!proposal &&
    !paid &&
    !['deposit_paid', 'balance_paid', 'confirmed'].includes(proposal.status) &&
    ['sent', 'viewed', 'accepted'].includes(proposal.status);

  useEffect(() => {
    axios.get(`${BASE_URL}/proposals/t/${token}`)
      .then(res => setProposal(res.data))
      .catch(() => setError('Proposal not found or has expired.'))
      .finally(() => setLoading(false));
  }, [token]);

  // Show a success toast when returning from Stripe redirect (?paid=true)
  useEffect(() => {
    if (paid) toast.success('Payment received!');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paid]);

  // Seed editable venue from the loaded proposal (once).
  useEffect(() => {
    if (proposal) {
      setVenue((cur) => (cur._seeded ? cur : {
        venue_name: proposal.venue_name || '',
        venue_street: proposal.venue_street || '',
        venue_city: proposal.venue_city || '',
        venue_state: proposal.venue_state || '',
        venue_zip: proposal.venue_zip || '',
        _seeded: true,
      }));
    }
  }, [proposal]);

  const venueComplete = !!proposal?.venue_complete
    || !!(venue.venue_street?.trim() && venue.venue_city?.trim() && venue.venue_state?.trim());

  // Only load Stripe.js (~200KB gzipped) when the proposal actually needs a
  // payment form. Skip for already-paid, confirmed, or non-payable proposals.
  useEffect(() => {
    if (!isPayableStatus) return;
    if (stripePromise) return;
    axios.get(`${BASE_URL}/stripe/publishable-key`)
      .then(r => { if (r.data?.key) setStripePromise(loadStripe(r.data.key)); })
      .catch(() => setStripePromise(null));
  }, [isPayableStatus, stripePromise]);

  // Consolidated payment-intent effect. Previously three cascading effects
  // raced each other on autopay toggles; now a single effect decides what
  // (if anything) needs to be fetched for the current
  // (proposal.id, paymentOption, autopayChecked) tuple, with cancellation
  // to guard against rapid toggles.
  useEffect(() => {
    if (!isPayableStatus) return;
    if (!paymentOption) return;

    // Decide whether the currently cached secret for this option is still
    // valid. Full intents don't care about autopay; deposit intents do.
    const needsDeposit =
      paymentOption === 'deposit' &&
      (!depositSecret || depositIntentAutopayRef.current !== autopayChecked);
    const needsFull = paymentOption === 'full' && !fullSecret;
    if (!needsDeposit && !needsFull) return;

    let cancelled = false;
    const option = paymentOption;
    const autopay = option === 'deposit' ? autopayChecked : false;

    // Mark loading so the payment form is hidden while we refetch. We do NOT
    // clear depositSecret/fullSecret here — doing so would re-trigger this
    // effect mid-fetch. The <Elements key={activeSecret}> prop handles remount
    // once the new clientSecret arrives.
    setLoadingIntent(true);
    // Clear any stale "unable to load payment form" banner from a prior failed
    // fetch so a fresh option/autopay toggle doesn't show an error mid-load.
    setFormError('');
    (async () => {
      try {
        const res = await axios.post(`${BASE_URL}/stripe/create-intent/${token}`, {
          payment_option: option,
          autopay,
        });
        if (cancelled) return;
        if (option === 'full') {
          setFullSecret(res.data.clientSecret);
        } else {
          setDepositSecret(res.data.clientSecret);
          depositIntentAutopayRef.current = autopay;
        }
      } catch (err) {
        if (cancelled) return;
        console.error('Failed to load payment intent:', err);
        // eslint-disable-next-line no-restricted-syntax
        setFormError(err.response?.data?.error || 'Unable to load payment form. Please refresh the page.');
      } finally {
        if (!cancelled) setLoadingIntent(false);
      }
    })();

    return () => { cancelled = true; };
  }, [isPayableStatus, paymentOption, autopayChecked, token, depositSecret, fullSecret]);

  // When the server's payment_policy says full payment is required (event ≤14
  // days out), lock paymentOption to 'full' and clear autopay so the intent
  // effect above requests the correct (full) amount. Read policy off `proposal`
  // here rather than the post-return derived vars — hooks must run before the
  // loading/error early returns. Server is authoritative; this is just UI sync.
  const serverFullRequired = !!proposal?.payment_policy?.full_payment_required;
  useEffect(() => {
    if (serverFullRequired && paymentOption !== 'full') {
      setPaymentOption('full');
      setAutopayChecked(false);
    }
  }, [serverFullRequired, paymentOption]);

  // Sign the proposal — called by PaymentForm before confirming payment
  const handleSign = async () => {
    setFormError('');
    setFieldErrors({});
    if (!sigName.trim()) {
      const msg = 'Please enter your full name.';
      setFormError(msg);
      throw new Error(msg);
    }
    if (!sigData) {
      const msg = 'Please add your signature.';
      setFormError(msg);
      throw new Error(msg);
    }

    if (!proposal.venue_complete) {
      const ve = {};
      if (!venue.venue_street?.trim()) ve.venue_street = 'Street address is required';
      if (!venue.venue_city?.trim()) ve.venue_city = 'City is required';
      if (!venue.venue_state?.trim()) ve.venue_state = 'State is required';
      if (Object.keys(ve).length) {
        setFieldErrors(ve);
        const msg = 'Please add the venue address.';
        setFormError(msg);
        throw new Error(msg);
      }
    }

    // If already signed (server state or this session), skip
    if (proposal.client_signed_at || signedThisSession.current) return;

    try {
      await axios.post(`${BASE_URL}/proposals/t/${token}/sign`, {
        client_signed_name: sigName.trim(),
        client_signature_data: sigData,
        client_signature_method: sigMethod,
        document_version: EVENT_SERVICES_AGREEMENT.version,
        venue_name: venue.venue_name?.trim() || null,
        venue_street: venue.venue_street?.trim() || null,
        venue_city: venue.venue_city?.trim() || null,
        venue_state: venue.venue_state?.trim() || null,
        venue_zip: venue.venue_zip?.trim() || null,
      });
      signedThisSession.current = true;
      toast.success('Proposal accepted!');
      // Do NOT update proposal state here — changing status/client_signed_at
      // would unmount the Elements provider while payment is in progress.
      // Server state is already updated; UI refreshes on Stripe redirect.
    } catch (err) {
      // eslint-disable-next-line no-restricted-syntax
      const message = err.response?.data?.error || 'Failed to save signature. Please try again.';
      setFormError(message);
      // eslint-disable-next-line no-restricted-syntax
      setFieldErrors(err.response?.data?.fieldErrors || {});
      throw new Error(message);
    }
  };

  if (loading) {
    return (
      <div style={styles.page}>
        <div className="proposal-view-container">
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
        <div className="proposal-view-container">
          <div style={{ textAlign: 'center', padding: '4rem' }}>
            <h2 style={styles.heading}>Oops!</h2>
            <p style={{ color: 'var(--brass)', marginTop: '0.5rem' }}>{error}</p>
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
    d.setUTCDate(d.getUTCDate() - 14);
    balanceDueDate = d.toISOString();
  }

  const lineItems = [];
  if (snapshot && snapshot.package) {
    const packageTotal = (snapshot.package.base_cost || 0) + (snapshot.staffing?.total || 0);
    lineItems.push({ label: proposal.package_name, amount: packageTotal });
    if (snapshot.bar_rental?.total > 0) {
      lineItems.push({ label: 'Bar Rental', amount: snapshot.bar_rental.total });
    }
    (snapshot.addons || []).forEach(a => {
      lineItems.push({ label: a.name, amount: a.line_total });
    });
    if (snapshot.syrups?.total > 0) {
      let syrupLabel = 'Handcrafted Syrups';
      const sc = snapshot.syrups;
      if (sc.packs > 0 && sc.singles > 0) {
        syrupLabel += ` (${sc.packs} three-pack${sc.packs !== 1 ? 's' : ''} + ${sc.singles} single${sc.singles !== 1 ? 's' : ''})`;
      } else if (sc.packs > 0) {
        syrupLabel += ` (${sc.packs} three-pack${sc.packs !== 1 ? 's' : ''})`;
      } else {
        syrupLabel += ` (${sc.singles} bottle${sc.singles !== 1 ? 's' : ''})`;
      }
      lineItems.push({ label: syrupLabel, amount: sc.total });
    }
    (snapshot.adjustments || []).forEach(adj => {
      if (!adj.visible) return;
      const amt = Math.abs(Number(adj.amount) || 0);
      lineItems.push({
        label: adj.label || (adj.type === 'discount' ? 'Discount' : 'Surcharge'),
        amount: adj.type === 'discount' ? -amt : amt,
      });
    });
  }

  // Server-computed booking-window policy (never re-derived client-side).
  // fullPaymentRequired → deposit/autopay hidden, option locked to 'full'.
  // lastMinuteHold → also show the pre-payment cancellation-consent warning.
  const policy = proposal.payment_policy || {};
  const fullPaymentRequired = !!policy.full_payment_required;
  const lastMinuteHold = !!policy.last_minute_hold;

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

  const isFullyPaid = proposal.status === 'balance_paid' ||
    Number(proposal.amount_paid || 0) >= Number(proposal.total_price || 0) - 0.01;

  return (
    <div style={styles.page}>
      <div className="proposal-view-container">
        {/* ── Hero — wax-seal medallion + brass kicker + display headline ── */}
        <div className="proposal-hero">
          <div className="wax-seal lg" aria-hidden="true">
            <span className="wax-seal-rx">Rx</span>
          </div>
          <span className="kicker no-rule proposal-hero-kicker">
            The Prescription{proposal.client_name ? ` · For ${proposal.client_name}` : ''}
          </span>
          <h1 className="proposal-hero-title">
            Your event bar, <em>engineered</em>.
          </h1>
          <p className="proposal-hero-sub">
            A reading of the night, costed out and held for your signature.
          </p>
        </div>

        {/* ── Two-column on desktop: scroll left, sign-and-pay sticky right ── */}
        <div className="proposal-layout">
          <div className="card on-paper proposal-scroll">
            <ProposalHeader proposal={proposal} bartenders={bartenders} />

            <ProposalPricingBreakdown
              proposal={proposal}
              includes={includes}
              lineItems={lineItems}
              snapshot={snapshot}
              balanceAmount={balanceAmount}
              balanceDueDate={balanceDueDate}
              fullPaymentRequired={fullPaymentRequired}
              showSignAndPay={showSignAndPay}
              showPayOnly={showPayOnly}
            />
          </div>

          <aside className="proposal-pay-rail">
            {showSignAndPay && (
              <SignAndPaySection
                mode="signAndPay"
                sigName={sigName}
                setSigName={setSigName}
                sigData={sigData}
                setSigData={setSigData}
                setSigMethod={setSigMethod}
                paymentOption={paymentOption}
                setPaymentOption={setPaymentOption}
                autopayChecked={autopayChecked}
                setAutopayChecked={setAutopayChecked}
                fullPaymentRequired={fullPaymentRequired}
                lastMinuteHold={lastMinuteHold}
                totalPrice={totalPrice}
                balanceAmount={balanceAmount}
                balanceDueDate={balanceDueDate}
                loadingIntent={loadingIntent}
                formError={formError}
                fieldErrors={fieldErrors}
                activeSecret={activeSecret}
                stripePromise={stripePromise}
                payLabel={payLabel}
                payOnlyLabel={payOnlyLabel}
                handleSign={handleSign}
                venue={venue}
                setVenue={setVenue}
                setFieldErrors={setFieldErrors}
                venueComplete={venueComplete}
                venuePrefilled={!!proposal?.venue_complete}
                proposalVenue={{
                  venue_name: proposal.venue_name, venue_street: proposal.venue_street,
                  venue_city: proposal.venue_city, venue_state: proposal.venue_state,
                  venue_zip: proposal.venue_zip,
                }}
              />
            )}

            {showPayOnly && (
              <SignAndPaySection
                mode="payOnly"
                paymentOption={paymentOption}
                setPaymentOption={setPaymentOption}
                autopayChecked={autopayChecked}
                setAutopayChecked={setAutopayChecked}
                fullPaymentRequired={fullPaymentRequired}
                lastMinuteHold={lastMinuteHold}
                totalPrice={totalPrice}
                balanceAmount={balanceAmount}
                balanceDueDate={balanceDueDate}
                loadingIntent={loadingIntent}
                formError={formError}
                fieldErrors={fieldErrors}
                activeSecret={activeSecret}
                stripePromise={stripePromise}
                payOnlyLabel={payOnlyLabel}
                clientSignedAt={proposal.client_signed_at}
              />
            )}

            {/* ── Paid state success card (replaces sign-and-pay) ── */}
            {isPaid && (
              <div className="proposal-paid-card">
                <div className="proposal-paid-check" aria-hidden="true">✓</div>
                {isFullyPaid ? (
                  <>
                    <h3 className="proposal-paid-title">Fully paid.</h3>
                    <p className="proposal-paid-sub">
                      Your booking is confirmed. We'll be in touch with event details closer to the date.
                    </p>
                  </>
                ) : proposal.autopay_enrolled ? (
                  <>
                    <h3 className="proposal-paid-title">Deposit received.</h3>
                    <p className="proposal-paid-sub">
                      Your remaining balance of {fmt(balanceAmount)} will be automatically charged on {formatDateShort(balanceDueDate)}.
                    </p>
                  </>
                ) : (
                  <>
                    <h3 className="proposal-paid-title">Deposit received.</h3>
                    <p className="proposal-paid-sub">
                      Your remaining balance of {fmt(balanceAmount)} is due by {formatDateShort(balanceDueDate)}.
                    </p>
                  </>
                )}
                {proposal.drink_plan_token && (
                  <a href={`/plan/${proposal.drink_plan_token}`} className="proposal-paid-link">
                    Open the Potion Planner →
                  </a>
                )}
              </div>
            )}
          </aside>
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <span>contact@drbartender.com · {COMPANY_PHONE}</span>
        </div>
      </div>
    </div>
  );
}

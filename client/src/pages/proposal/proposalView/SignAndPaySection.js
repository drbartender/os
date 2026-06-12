import React, { useMemo } from 'react';
import { Elements } from '@stripe/react-stripe-js';
import SignaturePad from '../../../components/SignaturePad';
import FormBanner from '../../../components/FormBanner';
import { fmt, formatDateShort, DEPOSIT_DOLLARS } from './helpers';
import { gratuityFloorMessage } from './gratuityFloor';
import PaymentForm from './PaymentForm';
import VenueAddressFields, { formatVenue } from '../../../components/VenueAddressFields';

// Renders BOTH the sign-and-pay flow (status: sent/viewed, not yet signed)
// AND the pay-only flow (status: accepted, already signed but not paid).
// Toggle via `mode` prop. Apothecary Press treatment: dark workshop-bench card,
// payment-tablet radios, parchment-framed Stripe surface.

function PaymentTablet({
  selected,
  onSelect,
  label,
  amount,
  desc,
  showAutopay,
  autopayChecked,
  setAutopayChecked,
  autopayLabel,
  value,
}) {
  return (
    <label className={`payment-tablet ${selected ? 'is-selected' : ''}`}>
      <div className="payment-tablet-row">
        <input
          type="radio"
          name="paymentOption"
          value={value}
          checked={selected}
          onChange={onSelect}
        />
        <div className="payment-tablet-text">
          <div className="payment-tablet-label">{label}</div>
          <div className="payment-tablet-desc">{desc}</div>
        </div>
        <span className="payment-tablet-amount">{amount}</span>
      </div>
      {showAutopay && (
        <label className="payment-tablet-autopay">
          <input
            type="checkbox"
            checked={autopayChecked}
            onChange={(e) => setAutopayChecked(e.target.checked)}
          />
          <span>{autopayLabel}</span>
        </label>
      )}
    </label>
  );
}

export default function SignAndPaySection({
  mode, // 'signAndPay' | 'payOnly'
  // Signature (signAndPay only)
  sigName,
  setSigName,
  sigData,
  setSigData,
  setSigMethod,
  clientPhone = '',
  setClientPhone = () => {},
  // Payment options
  paymentOption,
  setPaymentOption,
  autopayChecked,
  setAutopayChecked,
  // Gratuity chooser (§4) — signAndPay only; all optional so payOnly can omit them
  tipJar = true,
  setTipJar = () => {},
  gratuityTotal = 0,
  setGratuityTotal = () => {},
  setGratuityDirty = () => {},
  gratuityEnabled = false,
  gratuitySuggested = 0,
  gratuityFloor = 0,
  gratuityStaffNoun = 'bartender',
  gratuityBelowFloor = false,
  // Booking-window policy (server-computed; never re-derived here)
  fullPaymentRequired,
  lastMinuteHold,
  // Display
  totalPrice,
  balanceAmount,
  balanceDueDate,
  // Payment intent
  loadingIntent,
  formError,
  fieldErrors,
  setFieldErrors = () => {},
  activeSecret,
  stripePromise,
  payLabel,
  payOnlyLabel,
  // Callbacks
  handleSign,
  // Venue gate
  venue,
  setVenue,
  venueComplete,
  venuePrefilled,
  proposalVenue,
  // payOnly: when the client signed (ISO timestamp) — for the reference line.
  clientSignedAt,
}) {
  const depositSelected = paymentOption === 'deposit';
  const fullSelected = paymentOption === 'full';
  const autopayLabel = `Automatically pay remaining ${fmt(balanceAmount)} on ${formatDateShort(balanceDueDate)}`;

  // Memoize so Stripe Elements isn't handed a brand-new options object every
  // render — it only needs to re-init when the clientSecret changes.
  const elementsOptions = useMemo(
    () => ({ clientSecret: activeSecret, appearance: { theme: 'stripe' } }),
    [activeSecret]
  );

  // Booking-window policy notices (shared by both modes). fullPaymentRequired
  // (event ≤14d) hides the deposit tablet + autopay and shows the explainer;
  // lastMinuteHold (event ≤72h) additionally shows the cancellation-consent
  // warning directly above the pay button — the client must consent BEFORE the
  // card is charged.
  const fullRequiredNotice = fullPaymentRequired ? (
    <p className="payment-policy-note">
      Because your event is within 2 weeks, the full event total is due now to confirm
      your booking. This is the complete cost, there is no separate deposit and no balance later.
    </p>
  ) : null;

  const lastMinuteWarning = lastMinuteHold ? (
    <p className="payment-policy-warn">
      Heads up — because this event is less than 72 hours away, your booking is confirmed
      subject to staff availability. In the rare case we can't staff it in time, we'll cancel
      and fully refund you.
    </p>
  ) : null;

  // Live "what's still needed to pay" list (signAndPay only). Names the exact
  // missing items so the disabled Pay button is never a mystery.
  const payNeeds = useMemo(() => {
    const needs = [];
    if (!venuePrefilled) {
      if (!venue?.venue_street?.trim()) needs.push('the venue street address');
      if (!venue?.venue_city?.trim()) needs.push('city');
      if (!venue?.venue_state?.trim()) needs.push('state');
    }
    if (!sigName?.trim()) needs.push('your full name');
    if (!sigData) needs.push('your signature');
    return needs;
  }, [venuePrefilled, venue?.venue_street, venue?.venue_city, venue?.venue_state, sigName, sigData]);

  if (mode === 'signAndPay') {
    return (
      <div id="sign-pay-section" className="sign-pay-card">
        <div>
          <span className="sign-pay-eyebrow">Step Two · Sign &amp; Secure</span>
          <h2 className="sign-pay-title">Set your seal.</h2>
        </div>

        {/* Full Legal Name */}
        <div>
          <label className="sign-pay-eyebrow" htmlFor="sig-name">Full Legal Name</label>
          <input
            id="sig-name"
            type="text"
            className="sign-pay-input"
            value={sigName}
            onChange={(e) => setSigName(e.target.value)}
            placeholder="Your full name"
          />
        </div>

        {/* Optional contact number (real-number capture for Thumbtack leads) */}
        <div>
          <label className="sign-pay-eyebrow" htmlFor="sig-phone">
            Best phone number for event-day updates (optional)
          </label>
          <input
            id="sig-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            className="sign-pay-input"
            value={clientPhone}
            onChange={(e) => {
              setClientPhone(e.target.value);
              setFieldErrors((fe) => {
                if (!fe.client_phone) return fe;
                const next = { ...fe };
                delete next.client_phone;
                return next;
              });
            }}
            placeholder="(312) 555-0148"
          />
          {fieldErrors?.client_phone && (
            <p style={{ color: 'var(--rust)', fontSize: '0.875rem' }} role="alert">
              {fieldErrors.client_phone}
            </p>
          )}
        </div>

        {/* Signature */}
        <div>
          <label className="sign-pay-eyebrow">Signature</label>
          <div className="sign-pay-sig-wrap">
            <SignaturePad
              requireAccept
              value={sigData}
              onChange={(data, method) => { setSigData(data); setSigMethod(method); }}
            />
          </div>
          <p className="sign-pay-sig-caption">x · sign above</p>
          <p className="sign-pay-accept-note">
            By signing, you agree to the Service Agreement above and confirm your event details are accurate.
          </p>
        </div>

        {/* Venue address */}
        <div>
          <label className="sign-pay-eyebrow">Where is your event?</label>
          {venuePrefilled ? (
            <p className="sign-pay-venue-confirm">
              {formatVenue(proposalVenue)}
            </p>
          ) : (
            <VenueAddressFields
              value={venue}
              onChange={(f, val) => {
                setVenue((cur) => ({ ...cur, [f]: val }));
                setFieldErrors((fe) => {
                  if (!fe[f]) return fe;
                  const next = { ...fe };
                  delete next[f];
                  return next;
                });
              }}
              fieldErrors={fieldErrors}
              requireStreet
              inputClassName="sign-pay-input"
              selectClassName="sign-pay-input"
              labelClassName="sign-pay-eyebrow"
              idPrefix="signpay-venue"
            />
          )}
        </div>

        {/* Gratuity (§4): plain dollars; the rate is internal. Server confirms
            the new total before it shows. Hidden when staff x hours <= 0. */}
        {gratuityEnabled && (
          <div className="gratuity-block">
            <div className="gratuity-head">
              <span className="sign-pay-eyebrow">Tip jar at the bar?</span>
              <h3 className="gratuity-heading">Tipping, handled your way</h3>
              <p className="gratuity-intro">
                <span className="assured">Every dollar</span> goes straight to your
                {` ${gratuityStaffNoun}s`}. None of it is kept by Dr. Bartender.
              </p>
            </div>

            <div className="tip-jar-choices" role="radiogroup" aria-label="Tip jar">
              <label className={`tip-tablet ${tipJar ? 'is-selected' : ''}`}>
                <input type="radio" name="tipJar" checked={tipJar}
                  onChange={() => { setTipJar(true); setGratuityDirty(true); }} />
                <span className="tip-tablet-top">
                  <span className="tip-tablet-mark" aria-hidden="true">&#9906;</span>
                  <span className="tip-tablet-label">Keep the tip jar</span>
                </span>
                <span className="tip-tablet-desc">
                  A jar sits on the bar; guests tip as they like. Add a little extra below
                  if you'd like to start it off.
                </span>
              </label>
              <label className={`tip-tablet ${!tipJar ? 'is-selected' : ''}`}>
                <input type="radio" name="tipJar" checked={!tipJar}
                  onChange={() => {
                    setTipJar(false);
                    setGratuityDirty(true);
                    setGratuityTotal((g) => Math.max(Number(g) || 0, gratuityFloor));
                  }} />
                <span className="tip-tablet-top">
                  <span className="tip-tablet-mark" aria-hidden="true">&#10005;</span>
                  <span className="tip-tablet-label">Skip the tip jar</span>
                </span>
                <span className="tip-tablet-desc">
                  No jar out. A set gratuity for your {gratuityStaffNoun}s is added to the
                  total instead.
                </span>
              </label>
            </div>

            <div className="gratuity-amount">
              <span className="sign-pay-eyebrow" style={{ display: 'block' }}>
                {tipJar ? 'Add a gratuity?' : `Gratuity for your ${gratuityStaffNoun}s`}
              </span>

              <div className="gratuity-presets">
                {tipJar && (
                  <>
                    <button type="button" className="gratuity-chip"
                      onClick={() => { setGratuityTotal(0); setGratuityDirty(true); }}>
                      None
                    </button>
                    <button type="button" className="gratuity-chip"
                      onClick={() => { setGratuityTotal(gratuitySuggested); setGratuityDirty(true); }}>
                      {fmt(gratuitySuggested)}<span className="chip-note">suggested</span>
                    </button>
                  </>
                )}
              </div>

              <div className="gratuity-input-frame">
                <span className="gratuity-input-currency">$</span>
                <input className="gratuity-input" type="number" min={tipJar ? 0 : gratuityFloor} step="1"
                  value={gratuityTotal}
                  onChange={(e) => { setGratuityTotal(e.target.value); setGratuityDirty(true); }} />
              </div>

              {gratuityBelowFloor && (
                <p className="gratuity-floor-warn" role="alert">
                  {gratuityFloorMessage(fmt(gratuityFloor), gratuityStaffNoun)}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Payment Options */}
        <div>
          <label className="sign-pay-eyebrow">How would you like to pay?</label>

          {!fullPaymentRequired && (
            <PaymentTablet
              selected={depositSelected}
              onSelect={() => setPaymentOption('deposit')}
              value="deposit"
              label={`Pay ${fmt(DEPOSIT_DOLLARS)} Deposit`}
              amount={fmt(DEPOSIT_DOLLARS)}
              desc={`Remaining ${fmt(balanceAmount)} due before your event`}
              showAutopay={depositSelected && balanceAmount > 0}
              autopayChecked={autopayChecked}
              setAutopayChecked={setAutopayChecked}
              autopayLabel={autopayLabel}
            />
          )}
          <PaymentTablet
            selected={fullSelected || fullPaymentRequired}
            onSelect={() => { setPaymentOption('full'); setAutopayChecked(false); }}
            value="full"
            label="Pay in Full"
            amount={fmt(totalPrice)}
            desc="No remaining balance"
          />
          {fullRequiredNotice}
          {lastMinuteWarning}
        </div>

        {payNeeds.length > 0 && (
          <div className="sign-pay-needs" role="status" aria-live="polite">
            Before you can pay, please add: {payNeeds.join(' · ')}.
          </div>
        )}

        {/* Stripe Payment Element */}
        <div>
          {gratuityBelowFloor ? (
            <p className="sign-pay-needs" role="status" aria-live="polite">
              Add the required gratuity above to continue to payment.
            </p>
          ) : (
            <>
              {loadingIntent && (
                <div style={{ textAlign: 'center', padding: '2rem' }} role="status" aria-live="polite">
                  <div className="spinner" />
                </div>
              )}

              <FormBanner error={formError} fieldErrors={fieldErrors} />

              {activeSecret && stripePromise && !loadingIntent && (
                <div className="sign-pay-stripe-wrap">
                  <Elements
                    key={activeSecret}
                    stripe={stripePromise}
                    options={elementsOptions}
                  >
                    <PaymentForm
                      onSubmit={handleSign}
                      payLabel={payLabel}
                      disabled={!sigName.trim() || !sigData || !venueComplete || gratuityBelowFloor}
                    />
                  </Elements>
                </div>
              )}

              {activeSecret && !stripePromise && !loadingIntent && (
                <div style={{ textAlign: 'center', padding: '1rem' }} role="status" aria-live="polite">
                  <div className="spinner" />
                </div>
              )}

              {!activeSecret && !loadingIntent && !formError && (
                <p style={{ color: 'var(--rust)', fontSize: '0.875rem' }}>
                  Unable to load payment form. Please refresh the page or contact us at contact@drbartender.com.
                </p>
              )}
            </>
          )}
        </div>

        <p className="sign-pay-footnote">Secured by Stripe · Your card is charged once you sign.</p>
      </div>
    );
  }

  // mode === 'payOnly' — backward-compat: already signed under old flow, not yet paid
  return (
    <div id="sign-pay-section" className="sign-pay-card">
      <div>
        <span className="sign-pay-eyebrow">Final Step · Complete Payment</span>
        <h2 className="sign-pay-title">Lock the date.</h2>
      </div>

      {clientSignedAt && (
        <p className="sign-pay-accept-note">
          You accepted the Service Agreement when you signed on {formatDateShort(clientSignedAt)}.
        </p>
      )}

      <div>
        <label className="sign-pay-eyebrow">How would you like to pay?</label>
        {!fullPaymentRequired && (
          <PaymentTablet
            selected={depositSelected}
            onSelect={() => setPaymentOption('deposit')}
            value="deposit"
            label={`Pay ${fmt(DEPOSIT_DOLLARS)} Deposit`}
            amount={fmt(DEPOSIT_DOLLARS)}
            desc={`Remaining ${fmt(balanceAmount)} due before your event`}
            showAutopay={depositSelected && balanceAmount > 0}
            autopayChecked={autopayChecked}
            setAutopayChecked={setAutopayChecked}
            autopayLabel={autopayLabel}
          />
        )}
        <PaymentTablet
          selected={fullSelected || fullPaymentRequired}
          onSelect={() => { setPaymentOption('full'); setAutopayChecked(false); }}
          value="full"
          label="Pay in Full"
          amount={fmt(totalPrice)}
          desc="No remaining balance"
        />
        {fullRequiredNotice}
        {lastMinuteWarning}
      </div>

      <div>
        {loadingIntent && (
          <div style={{ textAlign: 'center', padding: '2rem' }} role="status" aria-live="polite">
            <div className="spinner" />
          </div>
        )}

        <FormBanner error={formError} fieldErrors={fieldErrors} />

        {activeSecret && stripePromise && !loadingIntent && (
          <div className="sign-pay-stripe-wrap">
            <Elements
              key={activeSecret}
              stripe={stripePromise}
              options={elementsOptions}
            >
              <PaymentForm
                onSubmit={async () => {}}
                payLabel={payOnlyLabel}
                disabled={false}
              />
            </Elements>
          </div>
        )}

        {activeSecret && !stripePromise && !loadingIntent && (
          <div style={{ textAlign: 'center', padding: '1rem' }} role="status" aria-live="polite">
            <div className="spinner" />
          </div>
        )}

        {!activeSecret && !loadingIntent && !formError && (
          <p style={{ color: 'var(--rust)', fontSize: '0.875rem' }}>
            Unable to load payment form. Please refresh the page or contact us at contact@drbartender.com.
          </p>
        )}
      </div>

      <p className="sign-pay-footnote">Secured by Stripe</p>
    </div>
  );
}

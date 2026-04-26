import React, { useState, useEffect, useMemo } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import axios from 'axios';
import { QUICK_PICKS } from '../data/servingTypes';
import { formatPhoneInput } from '../../../utils/formatPhone';
import { SYRUPS, calculateSyrupCost, getBottlesPerSyrup, getAllUniqueSyrups } from '../../../data/syrups';
import { API_BASE_URL as BASE_URL } from '../../../utils/api';

// Module-scoped lazy init — fetch the publishable key once and reuse the
// loadStripe() promise across every mount of this component.
let stripePromiseCache = null;
function getStripePromise() {
  if (!stripePromiseCache) {
    stripePromiseCache = axios
      .get(`${BASE_URL}/stripe/publishable-key`)
      .then((r) => (r.data?.key ? loadStripe(r.data.key) : null))
      .catch(() => {
        stripePromiseCache = null;
        return null;
      });
  }
  return stripePromiseCache;
}

const fmt = (n) =>
  `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function formatDateShort(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
}

// ─── Stripe payment form (must be inside <Elements>) ─────────────

function DrinkPlanPaymentForm({ onSubmit, payLabel, disabled }) {
  const stripe = useStripe();
  const elements = useElements();
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState('');

  const handlePay = async (e) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setPaying(true);
    setPayError('');

    // Submit drink plan first
    try {
      await onSubmit();
    } catch (err) {
      setPayError(err.message || 'Failed to submit. Please try again.');
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
        className="btn btn-success"
        style={{ width: '100%', padding: '0.75rem', fontSize: '1.05rem', marginTop: '1rem', opacity: (!stripe || paying || disabled) ? 0.6 : 1 }}
      >
        {paying ? 'Processing...' : payLabel}
      </button>
    </form>
  );
}

// ─── Main component ───────────────────────────────────────────────

export default function ConfirmationStep({ plan, quickPickChoice, activeModules, selections, cocktails = [], mocktails = [], addOns = {}, addonPricing = [], guestCount, numBars = 0, pricingSnapshot = null, proposalSyrups = [], onSubmit, onSubmitForPayment, proposalPaymentInfo, token, saving, error }) {
  const pick = QUICK_PICKS.find(p => p.key === quickPickChoice);
  const selectedDrinks = cocktails.filter(d => (selections.signatureDrinks || []).includes(d.id));
  const selectedMocktails = mocktails.filter(d => (selections.mocktails || []).includes(d.id));
  const logistics = selections.logistics || {};

  // Payment state
  const [paymentChoice, setPaymentChoice] = useState('pay_now'); // 'pay_now' | 'pay_everything' | 'add_to_balance'
  const [balanceOptionAvailable, setBalanceOptionAvailable] = useState(false);
  const [currentBalance, setCurrentBalance] = useState(0);
  const [clientSecret, setClientSecret] = useState('');
  const [paymentScenario, setPaymentScenario] = useState(null);
  const [paymentAmounts, setPaymentAmounts] = useState({ extrasAmount: 0, pastDueAmount: 0, totalCharge: 0 });
  const [loadingPayment, setLoadingPayment] = useState(false);
  const [paymentError, setPaymentError] = useState('');

  // Stripe.js loader — resolves a module-scoped cached Promise so the
  // publishable-key fetch happens once per session, not once per mount.
  const [stripePromise, setStripePromise] = useState(null);
  useEffect(() => {
    let cancelled = false;
    getStripePromise().then((p) => { if (!cancelled) setStripePromise(p); });
    return () => { cancelled = true; };
  }, []);

  // Extras-pricing math — recomputes on every Stripe Elements tick once mounted,
  // so memoize by the exact inputs it reads. We watch the narrow bar_rental
  // sub-object rather than the whole pricingSnapshot so a parent poll that
  // rebuilds an unrelated field doesn't bust this memo.
  const barRentalSnap = pricingSnapshot?.bar_rental;
  const { barRentalCost, barRentalLabel, syrupCost, extrasTotal } = useMemo(() => {
    // Addon line totals (used only for the running sum below — render loops iterate
    // `addOns` directly to split auto-added vs. flat rows at the JSX level).
    const slugs = Object.keys(addOns);
    const items = slugs
      .map((slug) => {
        const pricing = addonPricing.find((a) => a.slug === slug);
        if (!pricing) return null;
        const rate = Number(pricing.rate);
        let lineTotal = rate;
        if (pricing.billing_type === 'per_guest' && guestCount) {
          lineTotal = rate * guestCount;
        }
        return { slug, total: lineTotal };
      })
      .filter(Boolean);

    const barSnap = barRentalSnap || {};
    let barCost = 0;
    let barLabel = '';
    if (logistics.addBarRental) {
      if (numBars >= 1) {
        barCost = barSnap.additional_bar_fee || 100;
        barLabel = 'Additional Portable Bar';
      } else {
        barCost = barSnap.first_bar_fee || 50;
        barLabel = 'Portable Bar Rental';
      }
    }

    const syrupIds = getAllUniqueSyrups(selections.syrupSelections)
      .filter((id) => !(selections.syrupSelfProvided || []).includes(id));
    const newSyrupIds = syrupIds.filter((id) => !proposalSyrups.includes(id));
    const syrups = calculateSyrupCost(newSyrupIds.length, getBottlesPerSyrup(guestCount));
    const total = items.reduce((sum, item) => sum + item.total, 0) + syrups.total + barCost;
    return { barRentalCost: barCost, barRentalLabel: barLabel, syrupCost: syrups, extrasTotal: total };
  }, [addOns, addonPricing, guestCount, logistics.addBarRental, numBars, barRentalSnap, selections.syrupSelections, selections.syrupSelfProvided, proposalSyrups]);

  // Determine if payment section should show
  const hasExtras = extrasTotal > 0;
  const hasProposal = !!proposalPaymentInfo;
  const showPayment = hasExtras && hasProposal && stripePromise;

  // Calculate balance due date for display
  let displayBalanceDueDate = proposalPaymentInfo?.balanceDueDate;
  if (!displayBalanceDueDate && proposalPaymentInfo?.eventDate) {
    const d = new Date(proposalPaymentInfo.eventDate);
    d.setUTCDate(d.getUTCDate() - 14);
    displayBalanceDueDate = d.toISOString();
  }

  // Selections fingerprint — if any price-affecting field changes while we're
  // on this step (e.g. user tabs back to edit, then returns), refresh the
  // Stripe PaymentIntent so the amount matches the updated plan. Deps use the
  // narrow `addBarRental` primitive rather than the whole `logistics` object
  // so unrelated logistics edits (date, venue) don't cause a PaymentIntent
  // refresh.
  const addBarRental = selections.logistics?.addBarRental === true;
  const paymentIntentKey = useMemo(() => JSON.stringify({
    addOns: selections.addOns || {},
    addBarRental,
    syrupSelections: selections.syrupSelections || {},
    syrupSelfProvided: selections.syrupSelfProvided || [],
  }), [selections.addOns, addBarRental, selections.syrupSelections, selections.syrupSelfProvided]);

  // Load payment intent when extras > 0 and proposal is linked
  useEffect(() => {
    if (!showPayment || !token) return;
    if (paymentChoice === 'add_to_balance') {
      setClientSecret('');
      return;
    }

    const controller = new AbortController();
    async function loadPaymentInfo() {
      setLoadingPayment(true);
      setPaymentError('');
      try {
        const choiceForServer = paymentChoice === 'pay_everything' ? 'with_balance' : 'extras_only';
        const res = await axios.post(`${BASE_URL}/stripe/create-drink-plan-intent/${token}`, {
          selections,
          paymentChoice: choiceForServer,
        }, { signal: controller.signal });
        if (controller.signal.aborted) return;

        if (res.data.noPaymentNeeded) {
          setPaymentScenario(null);
          setBalanceOptionAvailable(false);
          return;
        }

        setClientSecret(res.data.clientSecret);
        setPaymentScenario(res.data.paymentScenario);
        setPaymentAmounts({
          extrasAmount: res.data.extrasAmount,
          pastDueAmount: res.data.pastDueAmount,
          totalCharge: res.data.totalCharge,
        });
        setBalanceOptionAvailable(!!res.data.balanceOptionAvailable);
        setCurrentBalance(Number(res.data.currentBalance || 0));

        if (res.data.paymentScenario !== 'extras_optional') {
          setPaymentChoice('pay_now');
        }
      } catch (err) {
        if (axios.isCancel(err) || err.name === 'CanceledError' || err.name === 'AbortError') {
          // Cleanup or a stale-effect abort — don't surface the error; the
          // next effect run (if any) will reset loading state below.
        } else {
          console.error('Failed to load payment info:', err);
          setPaymentError('Unable to load payment form. You can still submit and pay later.');
        }
      } finally {
        // Always clear the spinner, even on abort — otherwise if `showPayment`
        // flips false mid-flight and no new effect runs, the spinner stays on.
        // (React 18 makes setState on an unmounted component a safe no-op.)
        setLoadingPayment(false);
      }
    }

    loadPaymentInfo();
    return () => { controller.abort(); };
    // `selections` is intentionally excluded — we only want to refresh the
    // PaymentIntent when a *price-affecting* selection field changes, which
    // `paymentIntentKey` captures (see useMemo above). Including the whole
    // `selections` object would thrash the effect on unrelated edits and
    // churn Stripe PaymentIntents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPayment, token, paymentChoice, paymentIntentKey]);

  const paymentRequired = paymentScenario === 'extras_required' || paymentScenario === 'extras_plus_balance';

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          Here's Your Bar Plan
        </h2>
        <p className="text-muted">
          Take a look — you can go back and adjust anything before submitting.
        </p>
      </div>

      <div className="card mb-2">
        {pick && (
          <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
            Package: {pick.label}
          </h3>
        )}

        {/* Signature Drinks */}
        {activeModules.signatureDrinks && (selectedDrinks.length > 0 || (selections.customCocktails || []).length > 0) && (
          <div className="mb-2">
            <strong>Signature Cocktails</strong>
            <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
              {selectedDrinks.map(d => (
                <li key={d.id}>{d.emoji} {d.name}</li>
              ))}
              {(selections.customCocktails || []).map((name, i) => (
                <li key={`custom-${i}`}>✨ {name} <span className="text-muted text-small">(custom request)</span></li>
              ))}
            </ul>
            {selections.signatureDrinkSpirits?.length > 0 && (
              <p className="text-muted text-small" style={{ color: 'var(--warm-brown)' }}>
                Base spirits: {selections.signatureDrinkSpirits.join(', ')}
              </p>
            )}
            {selections.mixersForSignatureDrinks === true && (
              <p className="text-muted text-small" style={{ color: 'var(--warm-brown)' }}>
                Basic mixers included for simple mixed drinks
              </p>
            )}
          </div>
        )}

        {/* Mocktails */}
        {activeModules.mocktails && selectedMocktails.length > 0 && (
          <div className="mb-2">
            <strong>Mocktails</strong>
            <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
              {selectedMocktails.map(d => (
                <li key={d.id}>{d.emoji} {d.name}</li>
              ))}
            </ul>
            {selections.mocktailNotes && (
              <p className="text-muted text-small" style={{ color: 'var(--warm-brown)' }}>
                Notes: {selections.mocktailNotes}
              </p>
            )}
          </div>
        )}

        {/* Full Bar */}
        {activeModules.fullBar && (
          <div className="mb-2">
            {selections.spirits?.length > 0 && (
              <p><strong>Spirits:</strong> {selections.spirits.join(', ')}
                {selections.spiritsOther && `, ${selections.spiritsOther}`}
              </p>
            )}
            {selections.mixersForSpirits === true && (
              <p className="text-muted text-small" style={{ color: 'var(--warm-brown)' }}>
                Mixers included for bar spirits
              </p>
            )}
            {selections.beerFromFullBar?.length > 0 && (
              <p><strong>Beer:</strong> {selections.beerFromFullBar.join(', ')}</p>
            )}
            {selections.wineFromFullBar?.length > 0 && (
              <p><strong>Wine:</strong> {selections.wineFromFullBar.join(', ')}
                {selections.wineOtherFullBar && ` (${selections.wineOtherFullBar})`}
              </p>
            )}
            {selections.beerWineBalanceFullBar && (
              <p><strong>Guest preference:</strong> {selections.beerWineBalanceFullBar.replace(/_/g, ' ')}</p>
            )}
          </div>
        )}

        {/* Beer & Wine Only */}
        {activeModules.beerWineOnly && !activeModules.fullBar && (
          <div className="mb-2">
            {selections.beerFromBeerWine?.length > 0 && (
              <p><strong>Beer:</strong> {selections.beerFromBeerWine.join(', ')}</p>
            )}
            {selections.wineFromBeerWine?.length > 0 && (
              <p><strong>Wine:</strong> {selections.wineFromBeerWine.join(', ')}
                {selections.wineOtherBeerWine && ` (${selections.wineOtherBeerWine})`}
              </p>
            )}
            {selections.beerWineBalanceBeerWine && (
              <p><strong>Balance:</strong> {selections.beerWineBalanceBeerWine.replace(/_/g, ' ')}</p>
            )}
          </div>
        )}

        {/* Flavor Add-Ons (Dr. Bartender supplied — excludes self-provided) */}
        {(() => {
          const allSyrupIds = getAllUniqueSyrups(selections.syrupSelections);
          const selfProvided = selections.syrupSelfProvided || [];
          const drbSyrupIds = allSyrupIds.filter(id => !selfProvided.includes(id));
          if (drbSyrupIds.length === 0) return null;
          const newIds = drbSyrupIds.filter(id => !proposalSyrups.includes(id));
          const bottlesPerFlavor = getBottlesPerSyrup(guestCount);
          const cost = calculateSyrupCost(newIds.length, bottlesPerFlavor);
          return (
            <div className="mb-2">
              <strong>Flavor Add-Ons</strong>
              <p className="text-muted text-small" style={{ color: 'var(--warm-brown)', marginBottom: '0.25rem' }}>
                Hand-crafted by Dr. Bartender
              </p>
              <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
                {drbSyrupIds.map(id => {
                  const s = SYRUPS.find(sy => sy.id === id);
                  const included = proposalSyrups.includes(id);
                  return s ? (
                    <li key={id}>
                      {s.name}{included ? ' (included)' : ''}
                      {!included && bottlesPerFlavor > 1 && ` (${bottlesPerFlavor} bottles)`}
                    </li>
                  ) : null;
                })}
              </ul>
              {cost.total > 0 && (
                <p className="text-muted text-small" style={{ color: 'var(--warm-brown)' }}>
                  {cost.totalBottles} bottle{cost.totalBottles !== 1 ? 's' : ''} total &mdash; ${cost.total}
                </p>
              )}
            </div>
          );
        })()}

        {/* Your Shopping List (self-provided syrups) */}
        {(selections.syrupSelfProvided || []).length > 0 && (
          <div className="mb-2">
            <strong>Your Shopping List</strong>
            <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
              {(selections.syrupSelfProvided || []).map(id => {
                const s = SYRUPS.find(sy => sy.id === id);
                return s ? <li key={id}>{s.name} syrup</li> : null;
              })}
            </ul>
          </div>
        )}

        {/* Menu Design */}
        {selections.customMenuDesign === true && (
          <div className="mb-2">
            <strong>Custom Menu Design:</strong> Yes
            {selections.menuTheme && (
              <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>Theme: {selections.menuTheme}</p>
            )}
            {selections.drinkNaming && (
              <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>Custom naming: {selections.drinkNaming}</p>
            )}
            {selections.menuDesignNotes && (
              <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>Design notes: {selections.menuDesignNotes}</p>
            )}
          </div>
        )}
        {selections.customMenuDesign === false && (
          <div className="mb-2">
            <strong>Custom Menu Design:</strong> No
          </div>
        )}

        {/* Logistics */}
        <div className="mb-2">
          <strong>Logistics</strong>
          {logistics.dayOfContact?.name && (
            <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>
              Day-of contact: {logistics.dayOfContact.name}
              {logistics.dayOfContact.phone && ` — ${formatPhoneInput(logistics.dayOfContact.phone)}`}
            </p>
          )}
          {logistics.parking && (
            <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>
              Parking: {logistics.parking.replace(/_/g, ' ')}
            </p>
          )}
          {logistics.equipment?.length > 0 && !logistics.equipment.includes('none') && (
            <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>
              Equipment: {logistics.equipment.map(e => e.replace(/_/g, ' ')).join(', ')}
              {logistics.equipmentOther && ` (${logistics.equipmentOther})`}
            </p>
          )}
          {logistics.equipment?.includes('none') && (
            <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>
              Equipment: None needed
            </p>
          )}
          {logistics.addBarRental && (
            <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>
              {numBars >= 1 ? 'Additional portable bar rental' : 'Portable bar rental'}
            </p>
          )}
          {logistics.accessNotes && (
            <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>
              Notes: {logistics.accessNotes}
            </p>
          )}
          {/* Backward compat for old logistics format */}
          {logistics.ice && (
            <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>
              Ice machine: {logistics.ice}
            </p>
          )}
          {logistics.other && !logistics.accessNotes && (
            <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>
              Notes: {logistics.other}
            </p>
          )}
        </div>
      </div>

      {/* Estimated Extras */}
      {hasExtras && (() => {
        // Split add-ons into auto-bound (nested under triggering drinks) and flat.
        // `addOns` metadata shape: { enabled, autoAdded?, triggeredBy?: [drinkId] }.
        const autoByDrink = new Map(); // drinkId -> [{ slug, pricing }]
        const flatAddons = [];
        for (const slug of Object.keys(addOns)) {
          const meta = addOns[slug];
          if (!meta?.enabled) continue;
          const pricing = addonPricing.find((a) => a.slug === slug);
          if (!pricing) continue;
          if (meta.autoAdded && Array.isArray(meta.triggeredBy) && meta.triggeredBy.length > 0) {
            for (const drinkId of meta.triggeredBy) {
              if (!autoByDrink.has(drinkId)) autoByDrink.set(drinkId, []);
              autoByDrink.get(drinkId).push({ slug, pricing });
            }
          } else {
            flatAddons.push({ slug, pricing });
          }
        }

        const selectedCocktails = cocktails.filter((c) => (selections.signatureDrinks || []).includes(c.id));

        return (
        <div className="card mb-2">
          <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
            Estimated Extras
          </h3>
          {barRentalCost > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
              <span>{barRentalLabel}</span>
              <span style={{ fontWeight: 600 }}>{fmt(barRentalCost)}</span>
            </div>
          )}
          {selectedCocktails.map((drink) => {
            const auto = autoByDrink.get(drink.id) || [];
            if (auto.length === 0) return null;
            return (
              <div key={`auto-${drink.id}`} style={{ marginBottom: '0.5rem' }}>
                <div style={{ fontWeight: 600, color: 'var(--deep-brown)' }}>{drink.name}</div>
                {auto.map(({ slug, pricing }) => {
                  const rate = Number(pricing.rate);
                  const isPerGuest = pricing.billing_type === 'per_guest';
                  const lineTotal = isPerGuest && guestCount ? rate * guestCount : rate;
                  const priceLabel = isPerGuest
                    ? guestCount ? `$${rate.toFixed(2)}/guest × ${guestCount}` : `$${rate.toFixed(2)}/guest`
                    : `$${rate.toFixed(2)}`;
                  return (
                    <div key={slug} style={{ display: 'flex', justifyContent: 'space-between', paddingLeft: '1.25rem', fontSize: '0.9rem', color: 'var(--warm-brown)' }}>
                      <span>+ {pricing.name} · {priceLabel}</span>
                      <span>${lineTotal.toFixed(2)}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {flatAddons.map(({ slug, pricing }) => {
            const rate = Number(pricing.rate);
            let lineTotal = rate;
            let desc = pricing.name;
            if (pricing.billing_type === 'per_guest' && guestCount) {
              lineTotal = rate * guestCount;
              desc = `${pricing.name} (${guestCount} guests)`;
            }
            return (
              <div key={slug} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
                <span>{desc}</span>
                <span style={{ fontWeight: 600 }}>{fmt(lineTotal)}</span>
              </div>
            );
          })}
          {syrupCost.total > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
              <span>Hand-Crafted Syrups ({syrupCost.totalBottles} bottle{syrupCost.totalBottles !== 1 ? 's' : ''})</span>
              <span style={{ fontWeight: 600 }}>{fmt(syrupCost.total)}</span>
            </div>
          )}
          <div style={{ borderTop: '2px solid var(--deep-brown)', marginTop: '0.5rem', paddingTop: '0.5rem', display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
            <span>Estimated Total Extras</span>
            <span>{fmt(extrasTotal)}</span>
          </div>
          {!showPayment && (
            <p className="text-muted text-small mt-1" style={{ color: 'var(--warm-brown)', fontStyle: 'italic' }}>
              Final pricing will be confirmed by your bartender.
            </p>
          )}
        </div>
        );
      })()}

      {/* Payment Section */}
      {showPayment && paymentScenario && (
        <div className="card mb-2">
          <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
            Payment
          </h3>

          {/* Scenario: extras + outstanding balance (must pay both) */}
          {paymentScenario === 'extras_plus_balance' && (
            <div>
              <p className="text-muted" style={{ color: 'var(--warm-brown)', marginBottom: '1rem' }}>
                Your balance is past due. Please pay your extras and outstanding balance to finalize your event.
              </p>
              <div style={{ background: 'rgba(193, 125, 60, 0.06)', borderRadius: '8px', padding: '1rem', marginBottom: '1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
                  <span>Drink Plan Extras</span>
                  <span style={{ fontWeight: 600 }}>{fmt(paymentAmounts.extrasAmount)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
                  <span>Outstanding Balance</span>
                  <span style={{ fontWeight: 600 }}>{fmt(paymentAmounts.pastDueAmount)}</span>
                </div>
                <div style={{ borderTop: '2px solid var(--deep-brown)', marginTop: '0.5rem', paddingTop: '0.5rem', display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
                  <span>Total Due Now</span>
                  <span>{fmt(paymentAmounts.totalCharge)}</span>
                </div>
              </div>
            </div>
          )}

          {/* Scenario: extras required (balance already paid) */}
          {paymentScenario === 'extras_required' && (
            <p className="text-muted" style={{ color: 'var(--warm-brown)', marginBottom: '1rem' }}>
              Payment of {fmt(paymentAmounts.totalCharge)} is required for your extras before submitting.
            </p>
          )}

          {/* Scenario: extras optional (not past due) */}
          {paymentScenario === 'extras_optional' && (
            <div style={{ marginBottom: '1rem' }}>
              <p className="text-muted" style={{ color: 'var(--warm-brown)', marginBottom: '0.75rem' }}>
                How would you like to handle payment for your extras?
              </p>

              <label style={{
                display: 'block', padding: '0.85rem 1rem', borderRadius: '8px', cursor: 'pointer', marginBottom: '0.5rem',
                border: paymentChoice === 'pay_now' ? '2px solid var(--deep-brown)' : '1px solid #d4c4b0',
                background: paymentChoice === 'pay_now' ? 'rgba(193, 125, 60, 0.06)' : 'transparent',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <input
                    type="radio"
                    name="paymentChoice"
                    value="pay_now"
                    checked={paymentChoice === 'pay_now'}
                    onChange={() => setPaymentChoice('pay_now')}
                    style={{ accentColor: 'var(--deep-brown)' }}
                  />
                  <div>
                    <div style={{ fontWeight: 600, color: 'var(--deep-brown)' }}>
                      Pay {fmt(paymentAmounts.extrasAmount)} Now
                    </div>
                    <div className="text-muted text-small">Take care of your extras now and you're all set.</div>
                  </div>
                </div>
              </label>

              {balanceOptionAvailable && (
                <label style={{
                  display: 'block', padding: '0.85rem 1rem', borderRadius: '8px', cursor: 'pointer', marginBottom: '0.5rem',
                  border: paymentChoice === 'pay_everything' ? '2px solid var(--deep-brown)' : '1px solid #d4c4b0',
                  background: paymentChoice === 'pay_everything' ? 'rgba(193, 125, 60, 0.06)' : 'transparent',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input
                      type="radio"
                      name="paymentChoice"
                      value="pay_everything"
                      checked={paymentChoice === 'pay_everything'}
                      onChange={() => setPaymentChoice('pay_everything')}
                      style={{ accentColor: 'var(--deep-brown)' }}
                    />
                    <div>
                      <div style={{ fontWeight: 600, color: 'var(--deep-brown)' }}>
                        Pay Extras + Balance in Full — {fmt(paymentAmounts.extrasAmount + currentBalance)}
                      </div>
                      <div className="text-muted text-small">
                        Settle your event balance of {fmt(currentBalance)} too
                        {displayBalanceDueDate && ` (due ${formatDateShort(displayBalanceDueDate)})`}.
                      </div>
                    </div>
                  </div>
                </label>
              )}

              <label style={{
                display: 'block', padding: '0.85rem 1rem', borderRadius: '8px', cursor: 'pointer',
                border: paymentChoice === 'add_to_balance' ? '2px solid var(--deep-brown)' : '1px solid #d4c4b0',
                background: paymentChoice === 'add_to_balance' ? 'rgba(193, 125, 60, 0.06)' : 'transparent',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <input
                    type="radio"
                    name="paymentChoice"
                    value="add_to_balance"
                    checked={paymentChoice === 'add_to_balance'}
                    onChange={() => setPaymentChoice('add_to_balance')}
                    style={{ accentColor: 'var(--deep-brown)' }}
                  />
                  <div>
                    <div style={{ fontWeight: 600, color: 'var(--deep-brown)' }}>Add to My Balance</div>
                    <div className="text-muted text-small">
                      {fmt(paymentAmounts.extrasAmount)} will be added to your balance
                      {displayBalanceDueDate && ` (due ${formatDateShort(displayBalanceDueDate)})`}
                    </div>
                  </div>
                </div>
              </label>
            </div>
          )}

          {/* Stripe Payment Form */}
          {(paymentRequired || paymentChoice === 'pay_now' || paymentChoice === 'pay_everything') && (
            <div style={{ marginTop: paymentScenario === 'extras_optional' ? '0.5rem' : 0 }}>
              {loadingPayment && (
                <div style={{ textAlign: 'center', padding: '2rem' }}>
                  <div className="spinner" />
                </div>
              )}

              {clientSecret && !loadingPayment && stripePromise && (
                <Elements
                  key={clientSecret}
                  stripe={stripePromise}
                  options={{ clientSecret, appearance: { theme: 'stripe' } }}
                >
                  <DrinkPlanPaymentForm
                    onSubmit={onSubmitForPayment}
                    payLabel={`Pay ${fmt(paymentAmounts.totalCharge)} & Submit`}
                    disabled={saving}
                  />
                </Elements>
              )}

              {!clientSecret && !loadingPayment && paymentError && (
                <p style={{ color: '#c0392b', fontSize: '0.875rem' }}>{paymentError}</p>
              )}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="alert alert-error mb-2">{error}</div>
      )}

      {/* Submit button — only shown when NOT paying via Stripe */}
      {(!showPayment || !paymentScenario || (paymentScenario === 'extras_optional' && paymentChoice === 'add_to_balance') || paymentError) && (
        <div style={{ textAlign: 'center' }}>
          <p className="text-muted text-small" style={{ color: 'var(--parchment)', marginBottom: '0.75rem', fontStyle: 'italic' }}>
            After you submit, we'll review your selections and reach out within 2 business days.
          </p>
          <button
            className="btn btn-success"
            onClick={onSubmit}
            disabled={saving}
            style={{ padding: '0.75rem 2.5rem', fontSize: '1.1rem' }}
          >
            {saving ? 'Submitting...' : 'Submit My Drink Plan'}
          </button>
        </div>
      )}
    </div>
  );
}

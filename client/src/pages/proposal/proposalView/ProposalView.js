import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { loadStripe } from '@stripe/stripe-js';
import { useToast } from '../../../context/ToastContext';
import { API_BASE_URL as BASE_URL } from '../../../utils/api';
import { COMPANY_PHONE } from '../../../utils/constants';
import { interpolatePackageIncludes } from '../../../utils/packageIncludes';
import { fmt, formatDateShort, DEPOSIT_DOLLARS } from './helpers';
import styles from './styles';
import { EVENT_SERVICES_AGREEMENT } from '../../../data/eventServicesAgreement';
import ProposalHeader from './ProposalHeader';
import ProposalPricingBreakdown from './ProposalPricingBreakdown';
import SignAndPaySection from './SignAndPaySection';
import { isGratuityBelowFloor, gratuityFloorMessage, gratuityFloorDollars } from './gratuityFloor';
import OtherOptionsPanel from '../otherOptions/OtherOptionsPanel';
import SwitchBanner from './SwitchBanner';
import { postSwitch } from '../otherOptions/switchApi';

// ─── Main component ───────────────────────────────────────────────

export default function ProposalView() {
  const { token } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [proposal, setProposal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Whether the client has opened the other-options panel. Closed by default:
  // most clients want the bar we quoted and should never have to step around a
  // comparison to sign for it.
  // The drawer stays MOUNTED once opened (hidden, not unmounted) so a client
  // who closes it and reopens does not re-pay for the quote or lose their
  // drafted extras. `drawerSeen` is that latch; `drawerOpen` is visibility.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSeen, setDrawerSeen] = useState(false);
  // What the last switch did, so the page can say so. Component state only: a
  // refresh drops it, which is fine because the proposal itself shows truth and
  // the audit row keeps the history.
  const [switched, setSwitched] = useState(null);
  const [undoBusy, setUndoBusy] = useState(false);

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
  const [clientPhone, setClientPhone] = useState('');
  const phoneSeeded = useRef(false);
  const signedThisSession = useRef(false);

  // Payment option state
  const [paymentOption, setPaymentOption] = useState('deposit');
  const [autopayChecked, setAutopayChecked] = useState(false);
  // Gratuity chooser (§4). Client speaks dollar totals; server owns the rate.
  const [tipJar, setTipJar] = useState(true);
  const [gratuityTotal, setGratuityTotal] = useState(0);
  const [gratuityDirty, setGratuityDirty] = useState(false);

  // Gratuity chooser basis (§4): suggested = 25 x staff x hours; the floor is
  // the admin mandate when set, else the no-jar $50/staff/hr rule — dollars
  // computed by gratuityFloorDollars (gratuityFloor.js, which carries the
  // GRATUITY_FLOOR_RATE keep-in-sync marker). Read from the frozen snapshot
  // gratuity block. Derived HERE (above the payment-intent effect) so that
  // effect's below-floor gate can depend on `gratuityBelowFloor` without a TDZ.
  const gratuityBasis = proposal?.pricing_snapshot?.gratuity || null;
  const gratuityStaffCount = gratuityBasis?.staff_count ?? 0;
  const gratuityHours = gratuityBasis?.hours ?? 0;
  const gratuityStaffNoun = gratuityBasis?.staff_noun || 'bartender';
  const gratuityEnabled = gratuityStaffCount * gratuityHours > 0;
  const gratuitySuggested = Math.round(25 * gratuityStaffCount * gratuityHours);
  // Admin mandate (spec 2026-08-10): a floor_rate > 0 in the snapshot floors
  // BOTH jar answers at the mandated dollars, REPLACING the no-jar 50 rule.
  const gratuityMandateRate = Number(gratuityBasis?.floor_rate) || 0;
  const gratuityMandated = gratuityMandateRate > 0;
  const gratuityFloor = gratuityFloorDollars({
    mandateRate: gratuityMandateRate, staffCount: gratuityStaffCount, hours: gratuityHours,
  });
  const gratuityBelowFloor = isGratuityBelowFloor({
    gratuityEnabled, tipJar, gratuityTotal, gratuityFloor, mandated: gratuityMandated,
  });

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
    let cancelled = false;
    // Option-group resolve runs FIRST via the non-mutating /resolve endpoint, so
    // a link that only bounces to /compare never bumps view_count or flips
    // sent->viewed. Precedence: decided group -> the chosen option's page;
    // grouped + undecided + no ?choose -> the compare page; otherwise the normal
    // (mutating) load below. ?choose=1 is the compare page's hand-off marker and
    // must never bounce back (loop guard). A resolver failure falls through to
    // the normal load so grouping never blocks a plain proposal.
    const chooseParam = new URLSearchParams(window.location.search).get('choose') === '1';
    axios.get(`${BASE_URL}/proposals/t/${token}/resolve`)
      .then((res) => {
        if (cancelled) return true;
        const r = res.data || {};
        // NOTE: grouped-ness no longer gates anything on this page. It used to
        // suppress the package comparison, which had it exactly backwards — a
        // client sent alternatives is the one most likely to want to compare.
        // The redirects below are untouched; only the suppression is gone.
        if (r.decided && r.chosen_token && r.chosen_token !== token) {
          navigate(`/proposal/${r.chosen_token}?choose=1`, { replace: true });
          return true;
        }
        if (r.grouped && !r.decided && !chooseParam) {
          navigate(`/compare/${r.group_token}`, { replace: true });
          return true;
        }
        return false;
      })
      .catch(() => false)
      .then((redirected) => {
        if (cancelled || redirected) return;
        axios.get(`${BASE_URL}/proposals/t/${token}`)
          .then(res => { if (!cancelled) setProposal(res.data); })
          // 404 covers three real cases the client cannot tell apart and does
          // not need to: a mistyped link, and — since the server stopped
          // serving archived rows — a booking that was cancelled or a quote
          // whose event date has passed. Anything else is our fault and says
          // so, because telling someone their proposal is gone when our server
          // merely hiccuped is the worse error of the two.
          .catch((err) => {
            if (cancelled) return;
            // eslint-disable-next-line no-restricted-syntax
            setError(err?.response?.status === 404 ? 'not_found' : 'load_failed');
          })
          .finally(() => { if (!cancelled) setLoading(false); });
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Seed the optional phone field from the server prefill (once). The server
  // sends '' for Thumbtack proxy numbers so a proxy is never shown.
  useEffect(() => {
    if (proposal && !phoneSeeded.current) {
      phoneSeeded.current = true;
      setClientPhone(proposal.client_phone_prefill || '');
    }
  }, [proposal]);

  // Seed the gratuity chooser from the loaded snapshot (once, unless the user
  // has started editing). The displayed "New total" tracks totalPrice (server
  // truth); gratuityTotal is just the input value, so we don't re-seed it dirty.
  useEffect(() => {
    const g = proposal?.pricing_snapshot?.gratuity;
    if (g && !gratuityDirty) {
      setTipJar(g.tip_jar !== false);
      setGratuityTotal(Number(g.total) || 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // Never quote a below-floor no-jar gratuity: the server would reject it
    // (deriveGratuityRate). Drop the loading state and let the gratuity floor
    // warning + the payment-area note (SignAndPaySection) be the only UI.
    if (gratuityBelowFloor) { setLoadingIntent(false); return; }

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
          ...(gratuityDirty ? { tip_jar: tipJar, gratuity_total: gratuityTotal } : {}),
        });
        if (cancelled) return;
        // Server is the authority on the total (DD #5): adopt the recomputed
        // total + gratuity so "New total" only updates after server confirmation.
        if (typeof res.data.total_price === 'number') {
          setProposal(p => (p ? {
            ...p,
            total_price: res.data.total_price,
            pricing_snapshot: {
              ...(p.pricing_snapshot || {}),
              total: res.data.total_price,
              gratuity: res.data.gratuity,
            },
          } : p));
        }
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
  }, [isPayableStatus, paymentOption, autopayChecked, token, depositSecret, fullSecret, tipJar, gratuityTotal, gratuityDirty, gratuityBelowFloor]);

  // A gratuity change invalidates both cached secrets (the full amount changes;
  // the deposit must re-stamp the new election into the intent metadata),
  // forcing a fresh intent + total.
  useEffect(() => {
    if (!gratuityDirty) return;
    // Show the loading state immediately so the payment form doesn't flash its
    // "unable to load" message in the gap before the intent effect refetches.
    setLoadingIntent(true);
    // Debounce the secret-clear (mirrors the admin edit form's 400ms preview
    // debounce). Rapid keystrokes in the gratuity field keep resetting this timer,
    // so the expensive create-intent refetch (Stripe retrieve/cancel/create;
    // election-at-payment means it writes no gratuity to the proposal) fires once
    // the client pauses typing, not on every keystroke. While the secrets are
    // still cached the intent effect early-returns, so no network or Stripe
    // traffic happens mid-type.
    const timer = setTimeout(() => {
      setDepositSecret('');
      setFullSecret('');
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tipJar, gratuityTotal, gratuityDirty]);

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
  // The DELIBERATE SEAM that used to live here (a mailto hand-off, because the
  // sign-time commit was unbuilt) is retired. The switch endpoint shipped, so
  // picking a rung rewrites the proposal for real.

  // One way in, and it self-closes the moment signing makes a switch
  // impossible. options_available is the server's own predicate for "the
  // switch endpoint would accept this", so the link can never open into a
  // refusal; the client-side payable check is the same guard the pay rail uses.
  const showOptionsEntry = !!proposal?.options_available
    && isPayableStatus
    && !signedThisSession.current;

  const entryRef = useRef(null);
  const openDrawer = () => {
    setDrawerSeen(true);
    setDrawerOpen(true);
  };
  // Focus goes back where it came from. Without this a keyboard user lands on
  // <body> and has to re-traverse the whole proposal, service agreement
  // included, to get back to where they were.
  const closeDrawer = () => {
    setDrawerOpen(false);
    if (entryRef.current) entryRef.current.focus();
  };

  // A landed switch changed the money, so every cached payment intent is now
  // for the wrong amount. Clearing the secrets makes the existing debounced
  // effect refetch them; the server also cancels the old intents, and THAT is
  // the safety mechanism. This half is display hygiene.
  const adoptSwitch = ({ unknown, payload, packageName, extrasOnly, priceDrift, undoTo }) => {
    // The drawer lost a write and cannot say whether it landed. Reconcile the
    // PAGE too: if it did land, the totals here and the payment intents behind
    // them are stale, and the next Pay attempt would fail for a reason this
    // page could not explain.
    if (unknown) {
      axios.get(`${BASE_URL}/proposals/t/${token}`)
        .then((fresh) => { setProposal(fresh.data); setDepositSecret(''); setFullSecret(''); })
        .catch(() => {});
      return;
    }
    setProposal(payload);
    setDepositSecret('');
    setFullSecret('');
    // Let the seeding effect re-run against the new staffing basis: a different
    // crew size moves the suggested gratuity and its floor.
    setGratuityDirty(false);
    setDrawerOpen(false);
    setSwitched({ packageName, extrasOnly, priceDrift, undoTo, failed: false });
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleUndo = async () => {
    if (!switched || !switched.undoTo) return;
    setUndoBusy(true);
    const r = await postSwitch(token, switched.undoTo.body);
    setUndoBusy(false);
    if (r.ok) {
      setProposal(r.payload);
      setDepositSecret('');
      setFullSecret('');
      setGratuityDirty(false);
      setSwitched(null);
      return;
    }
    if (r.conflict) {
      // Prices moved between the commit and the undo, which is a real case: the
      // pre-switch total was a contract echo an engine re-price can legitimately
      // fail to reproduce. Reopen the drawer so they confirm the new number
      // rather than committing one the banner never promised.
      setSwitched((v) => (v ? { ...v, undoTo: null } : v));
      setDrawerSeen(true);
      setDrawerOpen(true);
      return;
    }
    if (r.unknown) {
      // The undo may well have LANDED. Saying it failed would be a false
      // statement about their proposal, so reconcile and let the page speak
      // for itself. switchApi keeps this case distinct precisely so the
      // caller can tell "no" from "we do not know"; the drawer honours that
      // and this path used to throw it away.
      try {
        const fresh = await axios.get(`${BASE_URL}/proposals/t/${token}`);
        setProposal(fresh.data);
        setDepositSecret('');
        setFullSecret('');
      } catch { /* the banner below still tells them where they stand */ }
      setSwitched(null);
      return;
    }
    // A real guard refusal: paid meanwhile, signed in another tab, package
    // retired. The automatic path is genuinely closed, so say so and give
    // them a human.
    setSwitched((v) => (v ? { ...v, failed: true } : v));
  };

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

    if (gratuityBelowFloor) {
      const msg = gratuityFloorMessage(fmt(gratuityFloor), gratuityStaffNoun, gratuityMandated);
      setFormError(msg);
      throw new Error(msg);
    }

    // If already signed (server state or this session), skip
    if (proposal.client_signed_at || signedThisSession.current) return;

    try {
      await axios.post(`${BASE_URL}/proposals/t/${token}/sign`, {
        client_signed_name: sigName.trim(),
        client_signature_data: sigData,
        client_signature_method: sigMethod,
        document_version: EVENT_SERVICES_AGREEMENT.version,
        client_phone: clientPhone.trim() || null,
        venue_name: venue.venue_name?.trim() || null,
        venue_street: venue.venue_street?.trim() || null,
        venue_city: venue.venue_city?.trim() || null,
        venue_state: venue.venue_state?.trim() || null,
        venue_zip: venue.venue_zip?.trim() || null,
        // ARMS the server's sign-time total assertion. It has always existed
        // (publicToken.js re-asserts total_price in the UPDATE's WHERE) but it
        // self-disarms when this field is absent, and no client ever sent it,
        // so it had never once fired. This lane is what makes that matter: it
        // turns pre-signature rewrites into a routine self-serve action, so a
        // switch landing between render and sign-click is now an ordinary
        // event rather than a leaked-token edge case. Sending the total we
        // actually rendered means a signature can only ever bind the
        // configuration the signer saw.
        acknowledged_total: Number(proposal.total_price),
      });
      signedThisSession.current = true;
      toast.success('Proposal accepted!');
      // Do NOT update proposal state here — changing status/client_signed_at
      // would unmount the Elements provider while payment is in progress.
      // Server state is already updated; UI refreshes on Stripe redirect.
    } catch (err) {
      // eslint-disable-next-line no-restricted-syntax
      const res = err.response;
      // The total moved between render and sign. Not a failure to apologise
      // for: the assertion working. Refetch so the page shows what they would
      // actually be signing, and ask again.
      if (res?.status === 409 && res?.data?.code === 'TOTAL_CHANGED') {
        try {
          const fresh = await axios.get(`${BASE_URL}/proposals/t/${token}`);
          setProposal(fresh.data);
          setDepositSecret('');
          setFullSecret('');
        } catch { /* fall through to the message below */ }
        const moved = 'Your total changed while this page was open. Take another look, then sign.';
        setFormError(moved);
        throw new Error(moved);
      }
      // eslint-disable-next-line no-restricted-syntax
      const message = res?.data?.error || 'Failed to save signature. Please try again.';
      setFormError(message);
      // eslint-disable-next-line no-restricted-syntax
      setFieldErrors(err.response?.data?.fieldErrors || {});
      throw new Error(message);
    }
  };

  // Line-item rows for the pricing breakdown. Rebuilt only when the pricing
  // snapshot object or the package name changes — the snapshot reference is
  // swapped wholesale by the payment-intent effect when total/gratuity update,
  // so keying on it also catches those refreshes. Declared above the early
  // returns to keep hook order stable; guards null proposal/snapshot itself.
  const lineItems = useMemo(() => {
    const snap = proposal?.pricing_snapshot;
    const items = [];
    if (snap && snap.package) {
      const packageTotal = (snap.package.base_cost || 0) + (snap.staffing?.total || 0);
      items.push({ label: proposal.package_name, amount: packageTotal });
      if (snap.bar_rental?.total > 0) {
        items.push({ label: 'Bar Rental', amount: snap.bar_rental.total });
      }
      (snap.addons || []).forEach(a => {
        items.push({ label: a.name, amount: a.line_total });
      });
      if (snap.syrups?.total > 0) {
        let syrupLabel = 'Handcrafted Syrups';
        const sc = snap.syrups;
        if (sc.packs > 0 && sc.singles > 0) {
          syrupLabel += ` (${sc.packs} three-pack${sc.packs !== 1 ? 's' : ''} + ${sc.singles} single${sc.singles !== 1 ? 's' : ''})`;
        } else if (sc.packs > 0) {
          syrupLabel += ` (${sc.packs} three-pack${sc.packs !== 1 ? 's' : ''})`;
        } else {
          syrupLabel += ` (${sc.singles} bottle${sc.singles !== 1 ? 's' : ''})`;
        }
        items.push({ label: syrupLabel, amount: sc.total });
      }
      (snap.adjustments || []).forEach(adj => {
        if (!adj.visible) return;
        const amt = Math.abs(Number(adj.amount) || 0);
        items.push({
          label: adj.label || (adj.type === 'discount' ? 'Discount' : 'Surcharge'),
          amount: adj.type === 'discount' ? -amt : amt,
        });
      });
      if (snap.gratuity && snap.gratuity.total > 0) {
        items.push({ label: 'Gratuity', amount: snap.gratuity.total });
      }
    }
    return items;
  }, [proposal?.pricing_snapshot, proposal?.package_name]);

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
    // Same shape as InvoicePage's not-found state, deliberately: this is the
    // sibling public token page and a client who lands on either should get
    // the same treatment and a way to reach a human. `public-error` is the
    // shared block (index.css), already used by InvoicePage and BlogPost, so
    // this adds no CSS.
    const isNotFound = error === 'not_found';
    return (
      <div style={styles.page}>
        <div className="proposal-view-container">
          <div className="public-error">
            <span className="public-error-eyebrow">Proposal</span>
            <h1>{isNotFound ? "We couldn't find that proposal." : "We couldn't load this proposal."}</h1>
            <p className="public-error-body">
              {isNotFound
                ? 'The link may have been mistyped, or this proposal is no longer current. Double-check the URL, and if you got it from us by email, the latest version is in your inbox.'
                : "Something went wrong on our end. Please try again in a moment, or reach out and we'll send you a fresh link."}
            </p>
            <div className="public-error-actions">
              <a href="mailto:contact@drbartender.com" className="btn btn-primary">Email contact@drbartender.com</a>
              <a href="https://drbartender.com" className="public-error-link">Back to drbartender.com</a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const snapshot = proposal.pricing_snapshot;
  const bartenders = snapshot?.staffing?.actual;
  const durationHours = snapshot?.inputs?.durationHours;

  // Replace dynamic placeholders in package includes
  const includes = interpolatePackageIncludes(proposal.package_includes, { durationHours, bartenders });
  const totalPrice = snapshot ? Number(snapshot.total) : 0;
  // Pre-payment surfaces keep the "after your deposit" figure (total minus the
  // standard deposit). Once the proposal is in a paid/confirmed state, show the
  // TRUE remaining balance from the server's amount_paid — which includes
  // off-platform money on transferred events — instead of assuming exactly one
  // standard deposit was collected (wrong for paid-in-full, zero-collected, or
  // CC-transferred events).
  const inPaidState = ['confirmed', 'deposit_paid', 'balance_paid', 'completed'].includes(proposal.status);
  const balanceAmount = inPaidState
    ? Math.max(0, totalPrice - Number(proposal.amount_paid || 0))
    : totalPrice - DEPOSIT_DOLLARS;

  // Calculate balance due date (from DB or default 14 days before event)
  let balanceDueDate = proposal.balance_due_date;
  if (!balanceDueDate && proposal.event_date) {
    const d = new Date(proposal.event_date);
    d.setUTCDate(d.getUTCDate() - 14);
    balanceDueDate = d.toISOString();
  }

  // (lineItems is memoized above the early returns.)

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

  // The event facts a switch never touches. Deliberately guests/hours/bars only:
  // a package with a different bartender ratio WOULD re-derive the crew, so the
  // banner must not claim staffing held still.
  const bannerFacts = [
    proposal.guest_count != null ? `${proposal.guest_count} guests` : null,
    proposal.event_duration_hours != null ? `${Number(proposal.event_duration_hours)} hours` : null,
    proposal.num_bars != null ? `${proposal.num_bars} bar${Number(proposal.num_bars) === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div
      style={styles.page}
      className={drawerOpen ? 'proposal-page oo-drawer-open' : 'proposal-page'}
    >
      <div className="proposal-view-container">
        {switched && (
          <SwitchBanner
            packageName={switched.packageName}
            note={switched.extrasOnly
              ? `Same package, same ${bannerFacts}, only your extras changed.`
              : `Same ${bannerFacts}, nothing else about the night moved.`}
            driftNote={switched.priceDrift
              ? 'Prices were also updated since your original quote.'
              : null}
            undoName={switched.undoTo ? switched.undoTo.name : null}
            onUndo={handleUndo}
            undoBusy={undoBusy}
            failed={switched.failed}
          />
        )}
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
        <div className="proposal-view-layout">
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
              showOptionsEntry={showOptionsEntry}
              onOpenOptions={openDrawer}
              entryRef={entryRef}
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
                clientPhone={clientPhone}
                setClientPhone={setClientPhone}
                paymentOption={paymentOption}
                setPaymentOption={setPaymentOption}
                autopayChecked={autopayChecked}
                setAutopayChecked={setAutopayChecked}
                tipJar={tipJar}
                setTipJar={setTipJar}
                gratuityTotal={gratuityTotal}
                setGratuityTotal={setGratuityTotal}
                setGratuityDirty={setGratuityDirty}
                gratuityEnabled={gratuityEnabled}
                gratuityMandated={gratuityMandated}
                gratuitySuggested={gratuitySuggested}
                gratuityFloor={gratuityFloor}
                gratuityStaffNoun={gratuityStaffNoun}
                gratuityBelowFloor={gratuityBelowFloor}
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
                    <h3 className="proposal-paid-title">{Number(proposal.amount_paid || 0) > 0 ? 'Deposit received.' : 'Booking confirmed.'}</h3>
                    <p className="proposal-paid-sub">
                      Your remaining balance of {fmt(balanceAmount)} will be automatically charged on {formatDateShort(balanceDueDate)}.
                    </p>
                  </>
                ) : (
                  <>
                    <h3 className="proposal-paid-title">{Number(proposal.amount_paid || 0) > 0 ? 'Deposit received.' : 'Booking confirmed.'}</h3>
                    <p className="proposal-paid-sub">
                      Your remaining balance of {fmt(balanceAmount)} is due by {formatDateShort(balanceDueDate)}.
                    </p>
                  </>
                )}
                {/* Primary pay control for a booked-but-not-fully-paid event:
                    route straight to the balance invoice (fix #9 — no more
                    planner dead-end). Renders only when an open invoice exists. */}
                {!isFullyPaid && proposal.open_invoice_token && (
                  <a
                    href={`/invoice/${proposal.open_invoice_token}`}
                    className="btn btn-primary"
                    style={{ marginTop: '4px' }}
                  >
                    Pay balance
                  </a>
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

        {/* The bottom-of-page entry button is GONE. It was the conversion leak:
            it sat below the signature, so opening it scrolled the sign-and-pay
            surface out of view with nothing pulling the client back. The single
            entry point now lives beside the pricing total, and the panel it
            opens is a drawer that leaves the proposal visible. */}

        {/* Footer */}
        <div style={styles.footer}>
          <span>contact@drbartender.com · {COMPANY_PHONE}</span>
        </div>
      </div>

      {/* Mounted once seen and then kept alive: closing hides it, so the quote
          and the client's drafted extras survive a close/reopen. */}
      {drawerSeen && (
        <OtherOptionsPanel
          token={token}
          open={drawerOpen}
          onClose={closeDrawer}
          onLanded={adoptSwitch}
        />
      )}
    </div>
  );
}

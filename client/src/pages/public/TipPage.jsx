import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../../utils/api';
import {
  PayButton,
  ZellePayButton,
  StarIcon,
  HeroDecor,
} from './TipPage.atoms';
import { buildTipDeepLink } from '../../utils/buildTipDeepLink';
import './TipPage.css';

const AMOUNTS = [5, 10, 20];
const GOOGLE_REVIEW_URL = process.env.REACT_APP_GOOGLE_REVIEW_URL || 'https://google.com';

export default function TipPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [amount, setAmount] = useState(10);
  const [stars, setStars] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [popped, setPopped] = useState(-1);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [comment, setComment] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get(`/public/tip/${token}`)
      .then(r => { if (!cancelled) setData(r.data); })
      .catch(() => { if (!cancelled) setError('not-found'); });
    return () => { cancelled = true; };
  }, [token]);

  if (error === 'not-found') {
    return (
      <main className="tip-page">
        <header className="hero" style={{ paddingBottom: 32 }}>
          <HeroDecor compressed />
          <p className="hero-kicker">Dr. Bartender</p>
          <h1>This tip page isn't available.</h1>
        </header>
      </main>
    );
  }
  if (!data) {
    // Skeleton — keeps the hero band on screen so LCP doesn't flash white while
    // /api/public/tip/:token is in flight. Customers on cellular at a venue see
    // "Loading…" instead of suspecting the page is broken.
    return (
      <main className="tip-page" aria-busy="true">
        <header className="hero">
          <HeroDecor compressed />
          <p className="hero-kicker">Dr. Bartender</p>
          <h1>Loading…</h1>
        </header>
        <div className="headshot-mount">
          <div className="headshot-frame" style={{ background: 'var(--paper-dark)' }} />
        </div>
      </main>
    );
  }

  const isFeedbackOpen = stars >= 1 && stars <= 3;

  function clickStar(n) {
    setStars(n);
    setPopped(n);
    setTimeout(() => setPopped(-1), 200);
    if (n >= 4) {
      setTimeout(() => { window.location.href = GOOGLE_REVIEW_URL; }, 250);
    }
  }

  async function submitFeedback(e) {
    e.preventDefault();
    if (!stars) return;
    setSubmitting(true);
    try {
      await api.post(`/public/tip/${token}/feedback`, { rating: stars, comment, email });
      setFeedbackSent(true);
    } catch {
      // eslint-disable-next-line no-alert
      alert('Could not send feedback. Please try again in a moment.');
    } finally {
      setSubmitting(false);
    }
  }

  // Spec §6.8: server is the source of truth for method order. data.methods is
  // an ordered array of tokens (e.g. ['venmo','card','zelle','cashapp','paypal']).
  // If a stale/pre-deploy response is missing the field, fall back to the
  // prior hardcoded derivation so the page still renders.
  function buildButton(kind) {
    switch (kind) {
      case 'venmo':
        return data.venmo_handle && { kind, label: 'Venmo', sub: `@${data.venmo_handle}` };
      case 'cashapp':
        return data.cashapp_handle && { kind, label: 'Cash App', sub: `$${data.cashapp_handle}` };
      case 'card':
        return data.stripe_payment_link_url && { kind, label: 'Credit Card', sub: 'Apple Pay, Google Pay' };
      case 'paypal':
        return data.paypal_url && { kind, label: 'PayPal', sub: data.paypal_url.replace(/^https?:\/\//, '') };
      case 'zelle':
        return data.zelle_handle && { kind, label: 'Zelle', sub: data.zelle_handle };
      default:
        return null;
    }
  }
  const buttons = Array.isArray(data.methods)
    ? data.methods.map(buildButton).filter(Boolean)
    // Backward-compat fallback (matches prior hardcoded order, no zelle).
    : [
        buildButton('venmo'),
        buildButton('cashapp'),
        buildButton('card'),
        buildButton('paypal'),
      ].filter(Boolean);
  const noPayMethods = buttons.length === 0;

  return (
    <main className="tip-page">
      <header className="hero">
        <HeroDecor compressed />
        <p className="hero-kicker">Dr. Bartender</p>
        <h1>You're the Best <span className="heart">❤</span> Thanks for Tipping</h1>
      </header>

      <div className="headshot-mount">
        <div className="headshot-frame">
          {data.headshot_url
            ? <img src={data.headshot_url} alt={`${data.display_name}, your bartender`} />
            : <div style={{ background: 'var(--paper-dark)', width: '100%', height: '100%', borderRadius: '50%' }} />}
        </div>
        <h2 className="tip-name">Tip {data.display_name}</h2>
      </div>

      <section className="section first" aria-label="Tip amount">
        <div className="amount-row">
          {AMOUNTS.map(v => (
            <button
              key={v}
              type="button"
              className={`amount-btn ${amount === v ? 'selected' : ''}`}
              onClick={() => setAmount(v)}
            >
              ${v}
            </button>
          ))}
          <button
            type="button"
            className={`amount-btn ${!AMOUNTS.includes(amount) ? 'selected' : ''}`}
            onClick={() => setAmount('custom')}
          >
            <small>Custom</small>
          </button>
        </div>
        <p className="amount-tagline">Pick an amount, then tap how you'd like to send it.</p>

        {noPayMethods ? (
          <p className="amount-tagline" style={{ marginTop: 12 }}>
            Tipping isn't set up for this bartender yet. Try again later, or hand them a cash tip.
          </p>
        ) : (
          <ul className="pay-list">
            {buttons.map(btn => {
              if (btn.kind === 'zelle') {
                // Zelle has no deep link — render a copy-handle row instead
                // of a navigating <a>. buildTipDeepLink returns null for zelle.
                return (
                  <li key={btn.kind}>
                    <ZellePayButton handle={data.zelle_handle} />
                  </li>
                );
              }
              const href = buildTipDeepLink({
                kind: btn.kind,
                handles: data,
                amount: amount === 'custom' ? null : amount,
              });
              return (
                <li key={btn.kind}>
                  <PayButton kind={btn.kind} label={btn.label} sub={btn.sub} href={href || '#'} />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="section" aria-labelledby="rate-heading">
        <h3 id="rate-heading" className="section-heading">Leave Your Mark</h3>
        <div className="stars-wrap" role="radiogroup" aria-label="Rate your experience">
          {[1, 2, 3, 4, 5].map(n => {
            const lit = n <= (hovered || stars);
            return (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={stars === n}
                aria-label={`${n} star${n > 1 ? 's' : ''}`}
                className={`star ${lit ? 'lit' : ''} ${popped === n ? 'popped' : ''}`}
                onMouseEnter={() => setHovered(n)}
                onMouseLeave={() => setHovered(0)}
                onClick={() => clickStar(n)}
              >
                <StarIcon filled={lit} />
              </button>
            );
          })}
        </div>

        {!isFeedbackOpen && !feedbackSent && (
          <p className="stars-helper">How was your experience with {data.display_name}?</p>
        )}

        {isFeedbackOpen && !feedbackSent && (
          <form className="feedback-card" onSubmit={submitFeedback}>
            <h3>Tell us what went sideways</h3>
            <p className="intro">We read every note, and we'll make it right.</p>

            <label className="field-label" htmlFor="fb-comment">Your note</label>
            <textarea
              id="fb-comment"
              className="tx"
              maxLength={2000}
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder="What went wrong tonight?"
            />

            <label className="field-label" htmlFor="fb-email" style={{ marginTop: 12 }}>
              Email <span style={{ opacity: 0.6, letterSpacing: 0 }}>(optional)</span>
            </label>
            <input
              id="fb-email"
              type="email"
              className="input-text"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
            <p className="helper">We may follow up to make this right.</p>

            <button type="submit" className="submit-btn" disabled={submitting}>
              {submitting ? 'Sending…' : 'Send to Dr. Bartender'}
            </button>
          </form>
        )}

        {feedbackSent && (
          <div className="tx-thanks">
            <div className="ornament">· · ·</div>
            <h3>Thanks, we hear you</h3>
            <p>We'll be in touch.</p>
          </div>
        )}
      </section>

      <Footer />
    </main>
  );
}

function Footer() {
  return (
    <footer className="foot">
      <img className="foot-logo" src="/tip-page/logo.png" alt="Dr. Bartender" />
      <p className="foot-name">Dr. <b>Bartender</b></p>
      <p className="foot-tag">Mobile Bar · Cocktail Lab</p>
      <p className="foot-meta">
        © {new Date().getFullYear()} Dr. Bartender LLC
        <span className="powered">Powered by Dr. Bartender OS</span>
      </p>
    </footer>
  );
}

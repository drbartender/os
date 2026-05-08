import React, { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import api from '../../utils/api';
import { Chevron, HeroDecor } from './TipPage.atoms';
import './TipPage.css';

const GOOGLE_REVIEW_URL = process.env.REACT_APP_GOOGLE_REVIEW_URL || 'https://google.com';
const INSTAGRAM_URL = 'https://instagram.com/drbartender';

export default function TipPageThanks() {
  const { token } = useParams();
  const [params] = useSearchParams();
  const [data, setData] = useState(null);

  // amount in dollars, parsed from amount_total cents Stripe substituted at redirect
  const amountCents = Number(params.get('amount'));
  const amount = Number.isFinite(amountCents) ? Math.round(amountCents / 100) : null;

  useEffect(() => {
    api.get(`/public/tip/${token}`)
      .then(r => setData(r.data))
      .catch(() => setData({ display_name: 'your bartender' }));
  }, [token]);

  if (!data) return null;

  return (
    <main className="tip-page">
      <header className="hero" style={{ paddingBottom: 32 }}>
        <HeroDecor compressed />
        <p className="hero-kicker">Dr. Bartender</p>
        <h1>Cheers from {data.display_name} <span className="heart">❤</span></h1>
      </header>

      <div className="posttip">
        <div className="posttip-mark">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor"
               strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <h2>Tip received</h2>
        <p>Thanks for taking care of {data.display_name} tonight.</p>
        {amount && <div className="amount-pill">${amount}.00 · sent</div>}
      </div>

      <a className="cta-card" href={GOOGLE_REVIEW_URL} target="_blank" rel="noopener noreferrer"
         style={{
           background: 'var(--amber)', borderColor: 'var(--warm-brown)',
           color: '#fff', boxShadow: '0 4px 14px rgba(193,125,60,0.4)',
         }}>
        <span className="cta-icon" style={{ background: 'rgba(255,255,255,0.18)', borderColor: 'rgba(255,255,255,0.25)' }}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="#fff">
            <polygon points="12 2 15 9 22 9.3 16.5 14 18 21 12 17.5 6 21 7.5 14 2 9.3 9 9" />
          </svg>
        </span>
        <span className="cta-body">
          <h4 style={{ color: '#fff' }}>Tell Google how it went</h4>
          <p style={{ color: 'rgba(255,255,255,0.85)' }}>Two taps. Helps us book more events.</p>
        </span>
        <span className="cta-go" style={{ color: '#fff' }}><Chevron /></span>
      </a>

      <a className="cta-card" href={INSTAGRAM_URL} target="_blank" rel="noopener noreferrer">
        <span className="cta-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#6B4226" strokeWidth="1.8">
            <rect x="3" y="3" width="18" height="18" rx="5" />
            <circle cx="12" cy="12" r="4" />
            <circle cx="17.5" cy="6.5" r="0.9" fill="#6B4226" />
          </svg>
        </span>
        <span className="cta-body">
          <h4>Follow @drbartender</h4>
          <p>Cocktail recipes, behind-the-bar.</p>
        </span>
        <span className="cta-go"><Chevron /></span>
      </a>

      <a className="cta-skip" href="/">No thanks, I'm done</a>

      <footer className="foot" style={{ marginTop: 18, padding: '16px 24px' }}>
        <img className="foot-logo" src="/tip-page/logo.png" alt="Dr. Bartender" />
        <p className="foot-name">Dr. <b>Bartender</b></p>
        <p className="foot-meta">
          © {new Date().getFullYear()} Dr. Bartender LLC
          <span className="powered">Powered by Dr. Bartender OS</span>
        </p>
      </footer>
    </main>
  );
}

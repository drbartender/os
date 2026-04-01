import React, { useState } from 'react';
import BrandLogo from '../../components/BrandLogo';
import QuoteWizard from './QuoteWizard';

const WHY_CARDS = [
  {
    label: 'Precision',
    title: 'Clean, confident service',
    text: 'A polished bar experience built to keep the room moving. You get a calm presence, thoughtful pacing, and a setup that feels intentional from the first pour to the last call.',
  },
  {
    label: 'Planning',
    title: 'Quality, not chaos',
    text: 'We help shape the service before event day so the bar runs smoothly. Packages, guest flow, menu direction, and add-ons are all mapped out ahead of time.',
  },
  {
    label: 'Cocktails',
    title: 'Signature drinks with personality',
    text: 'From crowd-pleasers to custom cocktails, your menu is curated to match your event. The goal is a bar that feels memorable without feeling complicated.',
  },
];

const STEPS = [
  {
    number: '01',
    title: 'Start with your event details',
    text: 'Tell us the date, guest count, venue, and whether you want a BYOB setup or a fully hosted bar. We use that to recommend the right service level.',
  },
  {
    number: '02',
    title: 'Choose the package and reserve your date',
    text: 'Review your proposal, add any extras you need, and lock in the event with a signed agreement and deposit.',
  },
  {
    number: '03',
    title: 'Plan the menu',
    text: 'We fine-tune cocktail selections, mocktail options, and service notes so your bar feels tailored to your crowd instead of generic.',
  },
  {
    number: '04',
    title: 'We show up and run the bar',
    text: 'On event day, we handle the setup, service, and flow so you can focus on hosting while guests enjoy the experience.',
  },
];

const FAQS = [
  {
    q: 'Do you handle weddings and private events?',
    a: 'Yes. We cover weddings, birthday parties, corporate events, holiday gatherings, and just about any private event that needs a professional bar setup.',
  },
  {
    q: 'Can I get a custom cocktail menu?',
    a: 'Absolutely. Signature cocktails, mocktails, and crowd-friendly options can all be tailored to the event and guest list. We work with you to build the right menu.',
  },
  {
    q: 'How do I reserve a date?',
    a: 'Use the quote tool below to get instant pricing. Once you review and sign your proposal, a deposit locks in your date.',
  },
  {
    q: 'What areas do you serve?',
    a: 'We primarily serve the Chicagoland area and surrounding suburbs. For events outside that range, reach out and we\'ll see what we can do.',
  },
  {
    q: 'Do I need to provide the alcohol?',
    a: 'It depends on the package. Our BYOB packages mean you supply the drinks and we handle everything else. Our hosted packages include full beverage service.',
  },
];

export default function Website() {
  const [openFaq, setOpenFaq] = useState(null);
  const [mobileNav, setMobileNav] = useState(false);

  const scrollTo = (id) => {
    setMobileNav(false);
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="ws-shell">
      {/* Header */}
      <header className="ws-header">
        <div className="ws-header-inner">
          <a href="#top" className="ws-brand" onClick={e => { e.preventDefault(); scrollTo('top'); }}>
            <BrandLogo />
          </a>
          <button className="ws-menu-toggle" onClick={() => setMobileNav(!mobileNav)} aria-label="Toggle menu">
            <span /><span /><span />
          </button>
          <nav className={`ws-nav ${mobileNav ? 'open' : ''}`} aria-label="Primary">
            <button onClick={() => scrollTo('why-us')}>Why Us</button>
            <button onClick={() => scrollTo('process')}>How It Works</button>
            <button onClick={() => scrollTo('faq')}>FAQ</button>
            <button className="ws-nav-cta" onClick={() => scrollTo('quote')}>Get a Quote</button>
          </nav>
        </div>
      </header>

      <main id="top" className="ws-main">
        {/* Hero */}
        <section className="ws-hero">
          <div className="ws-hero-inner">
            <div className="ws-hero-copy">
              <p className="ws-kicker">Mobile Bar &middot; Cocktail Lab</p>
              <h1>Your event's bar, engineered.</h1>
              <p className="ws-hero-sub">Dr. Bartender brings a clean, confident cocktail experience — built like a well-run experiment. You get a polished setup, smart menu planning, and a bartender who knows how to keep the room moving.</p>
              <div className="ws-hero-btns">
                <button className="btn btn-primary" onClick={() => scrollTo('quote')}>Start a Quote</button>
                <button className="btn btn-secondary" onClick={() => scrollTo('why-us')}>See what's included</button>
              </div>
            </div>
            <aside className="ws-lab-board">
              <div className="ws-board-tab">The Lab Board</div>
              <ol>
                <li>
                  <strong>Event Proposal</strong>
                  <span>Calibrated to your event — scope, style, and chemistry included.</span>
                </li>
                <li>
                  <strong>Booking the Experience</strong>
                  <span>Sign, reserve your date, and move forward with confidence.</span>
                </li>
                <li>
                  <strong>Menu Planning</strong>
                  <span>Beer, wine, cocktails, or a full bar — precisely curated to your taste.</span>
                </li>
                <li>
                  <strong>Execution</strong>
                  <span>We run the experiment. You enjoy the results.</span>
                </li>
              </ol>
            </aside>
          </div>
        </section>

        {/* Why Us */}
        <section className="ws-section" id="why-us">
          <div className="ws-section-heading">
            <p className="ws-kicker">Why Us</p>
            <h2>Why Choose Dr. Bartender?</h2>
          </div>

          <div className="ws-origin-card">
            <p>
              Dr. Bartender was born from equal parts passion, precision, and a dash of
              rebellion. After years behind the bar, chasing the perfect balance of flavor
              and experience, I decided to build something that reflected both my initials —
              D.R. — and my philosophy: bartending is as much a science as it is an art.
            </p>
          </div>

          <div className="ws-card-grid">
            {WHY_CARDS.map(card => (
              <article key={card.title} className="ws-feature-card">
                <span className="ws-card-pill">{card.label}</span>
                <h3>{card.title}</h3>
                <p>{card.text}</p>
              </article>
            ))}
          </div>
        </section>

        {/* How It Works */}
        <section className="ws-section" id="process">
          <div className="ws-section-heading">
            <p className="ws-kicker">Process</p>
            <h2>How It Works</h2>
          </div>
          <div className="ws-process-grid">
            {STEPS.map(step => (
              <article key={step.number} className="ws-step-card">
                <div className="ws-step-num">{step.number}</div>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </article>
            ))}
          </div>
        </section>

        {/* Reviews (stub) */}
        <section className="ws-section" id="reviews">
          <div className="ws-section-heading">
            <p className="ws-kicker">Reviews</p>
            <h2>What Our Clients Say</h2>
          </div>
          <div className="ws-reviews-placeholder">
            <div className="ws-review-stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div>
            <p>Client reviews coming soon. In the meantime, check us out on Google and Thumbtack.</p>
            <div className="ws-review-badges">
              <span className="ws-badge">Google Reviews</span>
              <span className="ws-badge">Thumbtack Top Pro</span>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="ws-section" id="faq">
          <div className="ws-section-heading">
            <p className="ws-kicker">FAQ</p>
            <h2>Quick Answers</h2>
          </div>
          <div className="ws-faq-list">
            {FAQS.map((faq, i) => (
              <button
                key={i}
                className={`ws-faq-item ${openFaq === i ? 'open' : ''}`}
                onClick={() => setOpenFaq(openFaq === i ? null : i)}
              >
                <div className="ws-faq-q">
                  <h3>{faq.q}</h3>
                  <span className="ws-faq-toggle">{openFaq === i ? '\u2212' : '+'}</span>
                </div>
                {openFaq === i && <p className="ws-faq-a">{faq.a}</p>}
              </button>
            ))}
          </div>
        </section>

        {/* Quote Wizard */}
        <QuoteWizard />

        {/* Footer */}
        <footer className="ws-footer">
          <div className="ws-footer-inner">
            <div className="ws-footer-brand">
              <BrandLogo />
              <p>Mobile Bar &middot; Cocktail Lab</p>
            </div>
            <div className="ws-footer-links">
              <button onClick={() => scrollTo('why-us')}>Why Us</button>
              <button onClick={() => scrollTo('process')}>How It Works</button>
              <button onClick={() => scrollTo('faq')}>FAQ</button>
              <button onClick={() => scrollTo('quote')}>Get a Quote</button>
            </div>
            <div className="ws-footer-copy">
              &copy; {new Date().getFullYear()} Dr. Bartender. All rights reserved.
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}

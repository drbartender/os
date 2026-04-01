import React from 'react';
import './dr-bartender-placeholder.css';

export default function DrBartenderPlaceholder() {
  const whyCards = [
    {
      label: 'Precision',
      title: 'Clean, confident service',
      text:
        'A polished bar experience built to keep the room moving. You get a calm presence, thoughtful pacing, and a setup that feels intentional from the first pour to the last call.',
    },
    {
      label: 'Planning',
      title: 'Quality, not chaos',
      text:
        'We help shape the service before event day so the bar runs smoothly. Packages, guest flow, menu direction, and add-ons are all mapped out ahead of time.',
    },
    {
      label: 'Cocktails',
      title: 'Signature drinks with personality',
      text:
        'From crowd-pleasers to custom cocktails, your menu is curated to match your event. The goal is a bar that feels memorable without feeling complicated.',
    },
  ];

  const steps = [
    {
      number: '01',
      title: 'Start with your event details',
      text:
        'Tell us the date, guest count, venue, and whether you want a BYOB setup or a fully hosted bar. We use that to recommend the right service level.',
    },
    {
      number: '02',
      title: 'Choose the package and reserve your date',
      text:
        'Review your proposal, add any extras you need, and lock in the event with a signed agreement and deposit.',
    },
    {
      number: '03',
      title: 'Plan the menu',
      text:
        'We fine-tune cocktail selections, mocktail options, and service notes so your bar feels tailored to your crowd instead of generic.',
    },
    {
      number: '04',
      title: 'We show up and run the bar',
      text:
        'On event day, we handle the setup, service, and flow so you can focus on hosting while guests enjoy the experience.',
    },
  ];

  return (
    <div className="db-page-shell">
      <div className="db-page-noise" aria-hidden="true" />

      <header className="db-site-header">
        <a className="db-brand" href="#top">
          <span className="db-brand-mark">DB</span>
          <span>
            <strong>Dr. Bartender</strong>
            <small>Mobile Bar • Cocktail Lab</small>
          </span>
        </a>

        <nav className="db-nav" aria-label="Primary">
          <a href="#services">Services</a>
          <a href="#why-us">Why Us</a>
          <a href="#process">Process</a>
          <a href="#faq">FAQ</a>
          <a className="db-nav-cta" href="#quote">Get a Quote</a>
        </nav>
      </header>

      <main id="top">
        <section className="db-hero section-shell">
          <div className="db-hero-copy">
            <p className="db-kicker">Mobile Bar • Cocktail Lab</p>
            <h1>Your event’s bar, engineered.</h1>
            <p className="db-hero-subhead">(No chaos in the bar)</p>
            <p className="db-lead">
              Dr. Bartender brings a clean, confident cocktail experience — built like a
              well-run experiment. You get a polished setup, smart menu planning, and a
              bartender who knows how to keep the room moving.
            </p>

            <div className="db-button-row">
              <a className="db-btn db-btn-primary" href="#quote">
                Start a Quote
              </a>
              <a className="db-btn db-btn-secondary" href="#services">
                See what’s included
              </a>
            </div>
          </div>

          <aside className="db-lab-board parchment-card">
            <div className="db-board-tab">The Lab Board</div>
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
        </section>

        <section className="db-strap section-shell" id="services">
          <h2>Everything you need. Nothing you don’t.</h2>
          <p>
            First time hiring a bartender? Welcome to the lab. We follow a proven method,
            fine-tune the formula, and leave room for experimentation — so your bar setup
            feels effortless and well-balanced.
          </p>
        </section>

        <section className="db-why section-shell" id="why-us">
          <div className="db-section-heading">
            <p className="db-kicker">Why us</p>
            <h2>Why Choose Dr. Bartender?</h2>
          </div>

          <div className="parchment-card db-origin-story">
            <p>
              Dr. Bartender was born from equal parts passion, precision, and a dash of
              rebellion. After years behind the bar, chasing the perfect balance of flavor
              and experience, I decided to build something that reflected both my initials —
              D.R. — and my philosophy: bartending is as much a science as it is an art.
            </p>
          </div>

          <div className="db-card-grid">
            {whyCards.map((card) => (
              <article key={card.title} className="db-feature-card">
                <span className="db-card-pill">{card.label}</span>
                <h3>{card.title}</h3>
                <p>{card.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="db-process section-shell" id="process">
          <div className="db-section-heading">
            <p className="db-kicker">Process</p>
            <h2>How It Works</h2>
          </div>

          <div className="db-process-grid">
            {steps.map((step) => (
              <article key={step.number} className="db-step-card">
                <div className="db-step-number">{step.number}</div>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="db-faq section-shell" id="faq">
          <div className="db-section-heading">
            <p className="db-kicker">FAQ</p>
            <h2>Quick answers</h2>
          </div>

          <div className="db-faq-grid">
            <article className="db-faq-item">
              <h3>Do you handle weddings and private events?</h3>
              <p>
                Yes. This placeholder covers weddings, parties, corporate events, and other
                private gatherings while the full site is being rebuilt.
              </p>
            </article>

            <article className="db-faq-item">
              <h3>Can I get a custom cocktail menu?</h3>
              <p>
                Absolutely. Signature cocktails, mocktails, and crowd-friendly options can
                all be tailored to the event and guest list.
              </p>
            </article>

            <article className="db-faq-item">
              <h3>How do I reserve a date?</h3>
              <p>
                Use the quote button below and we’ll follow up with package options,
                availability, and next steps.
              </p>
            </article>
          </div>
        </section>

        <section className="db-quote section-shell parchment-card" id="quote">
          <div>
            <p className="db-kicker db-kicker-dark">Ready when you are</p>
            <h2>Want a quote that makes sense?</h2>
            <p>
              This is a temporary landing page while the full Dr. Bartender site is rebuilt.
              It keeps the brand vibe alive and gives visitors a clear place to contact you.
            </p>
          </div>

          <div className="db-button-row">
            <a className="db-btn db-btn-primary" href="mailto:hello@drbartender.com">
              Let’s do it
            </a>
            <a className="db-btn db-btn-dark" href="tel:+10000000000">
              Call now
            </a>
          </div>
        </section>
      </main>
    </div>
  );
}

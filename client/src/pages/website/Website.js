import React, { useState, useEffect, useRef } from 'react';
import BrandLogo from '../../components/BrandLogo';
import QuoteWizard from './QuoteWizard';

const SERVICE_IMAGES = [
  { src: 'https://i.imgur.com/iHkv9dI.png', alt: 'Consultation + Menu Planning' },
  { src: 'https://i.imgur.com/K5vxw25.png', alt: 'Bespoke Menu Graphic' },
  { src: 'https://i.imgur.com/0Q1UMdE.png', alt: 'Licensed + Insured' },
];

const STEPS = [
  {
    title: 'The Prescription',
    text: 'We craft a custom proposal tailored to your event. Once you approve it, a $100 deposit secures your date and your bar is officially booked.',
    image: 'https://i.imgur.com/RtN224c.png',
    imageAlt: 'The Prescription',
    align: 'left',
  },
  {
    title: 'The Potion Planner',
    text: 'Next, we have a quick consultation and complete your Potion Planner. This is where we design your drink menu and create a personalized shopping list.',
    image: 'https://i.imgur.com/uJ1JrvN.png',
    imageAlt: 'The Potion Planner',
    align: 'right',
  },
  {
    title: 'The Big Experiment',
    text: 'Event day arrives and the magic happens. We run the bar, mix the drinks, and keep the good times flowing \u2014 you relax and enjoy with your guests.',
    image: 'https://i.imgur.com/DlX1bdI.png',
    imageAlt: 'The Big Experiment',
    align: 'left',
  },
];

const TESTIMONIALS = [
  {
    text: '"They transformed our garden party into a Victorian speakeasy. The smoked rosemary gin fizz was nothing short of sorcery."',
    author: 'Eleanor V.',
  },
  {
    text: '"The attention to detail was extraordinary \u2014 from the hand-labelled bottles to the copper jiggers. Our wedding guests are still talking about it."',
    author: 'James & Sarah K.',
  },
  {
    text: '"Hired them for a corporate holiday party and it was exactly what we needed \u2014 professional, well-paced, and the menu was dialed in. Will definitely book again next year."',
    author: 'Marcus T.',
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

function useFadeUp() {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          el.classList.add('ws-visible');
          observer.unobserve(el);
        }
      },
      { threshold: 0.15 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return ref;
}

function FadeUp({ children, className = '', delay = 0, ...props }) {
  const ref = useFadeUp();
  return (
    <div
      ref={ref}
      className={`ws-fade-up ${className}`}
      style={delay ? { transitionDelay: `${delay}s` } : undefined}
      {...props}
    >
      {children}
    </div>
  );
}

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
            <button onClick={() => scrollTo('services')}>The Bar</button>
            <button onClick={() => scrollTo('process')}>The Protocol</button>
            <button onClick={() => scrollTo('testimonials')}>Our Story</button>
            <button onClick={() => scrollTo('faq')}>FAQ</button>
            <a href="/labnotes">Blog</a>
            <button className="ws-nav-cta" onClick={() => scrollTo('quote')}>Get a Quote</button>
          </nav>
        </div>
      </header>

      <main id="top" className="ws-main">
        {/* Hero */}
        <section className="ws-hero">
          <div className="ws-hero-inner">
            <FadeUp className="ws-hero-copy">
              <p className="ws-kicker">Mixing Science with Celebration</p>
              <h1>Your event's bar, engineered.</h1>
              <p className="ws-hero-subtitle">Mobile Bar &middot; Cocktail Lab</p>
              <div className="ws-divider" />
              <p className="ws-hero-sub">
                Dr. Bartender brings a clean, confident cocktail experience &mdash; built like a
                well-run experiment. You get a polished setup, smart menu planning, and a
                bartender who knows how to keep the room moving.
              </p>
              <div className="ws-hero-btns">
                <button className="btn btn-primary" onClick={() => scrollTo('quote')}>Get a Quote</button>
                <button className="btn btn-secondary" onClick={() => scrollTo('services')}>What We Offer</button>
              </div>
              <img
                className="ws-hero-accent"
                src="https://i.imgur.com/rl26NX2.png"
                alt="Accent"
                loading="lazy"
              />
            </FadeUp>
            <FadeUp className="ws-hero-image ws-hero-image-stack" delay={0.2}>
              <img
                src="https://i.imgur.com/Plqd51Z.png"
                alt="Dr. Bartender Apothecary Bottle"
                loading="lazy"
              />
              <img
                src="https://i.imgur.com/buVhsQH.png"
                alt="Bar Equipment"
                loading="lazy"
              />
            </FadeUp>
          </div>
        </section>

        {/* Services */}
        <section className="ws-section" id="services">
          <FadeUp className="ws-section-heading">
            <h2>Everything you need. Nothing you don't.</h2>
            <p className="ws-section-sub">
              First time hiring a bartender? Welcome to the lab. We follow a proven method,
              fine-tune the formula, and leave room for experimentation &mdash; so your bar setup
              feels effortless and well-balanced.
            </p>
            <div className="ws-divider ws-divider-center" />
          </FadeUp>
          <div className="ws-services-grid">
            {SERVICE_IMAGES.map((svc, i) => (
              <FadeUp key={svc.alt} delay={i * 0.1}>
                <div className="ws-service-image-card">
                  <img src={svc.src} alt={svc.alt} loading="lazy" />
                </div>
              </FadeUp>
            ))}
          </div>
        </section>

        {/* The Protocol (How It Works) */}
        <section className="ws-section ws-protocol-section" id="process">
          <FadeUp className="ws-section-heading">
            <p className="ws-kicker">How It Works</p>
            <h2>The Protocol</h2>
            <div className="ws-divider ws-divider-center" />
          </FadeUp>
          <div className="ws-protocol-steps">
            {STEPS.map((step, i) => (
              <FadeUp key={step.title} delay={i * 0.12}>
                <div className={`ws-protocol-row ${step.align === 'right' ? 'ws-protocol-row-reverse' : ''}`}>
                  <div className="ws-protocol-text">
                    <h3>{step.title}</h3>
                    <p>{step.text}</p>
                  </div>
                  <div className="ws-protocol-image">
                    <img src={step.image} alt={step.imageAlt} loading="lazy" />
                  </div>
                </div>
              </FadeUp>
            ))}
          </div>
        </section>

        {/* Why Us */}
        <section className="ws-section" id="why-us">
          <FadeUp className="ws-section-heading">
            <p className="ws-kicker">Our Story</p>
            <h2>Why Dr. Bartender?</h2>
            <div className="ws-divider ws-divider-center" />
          </FadeUp>

          <FadeUp>
            <div className="ws-story-card">
              <img src="https://i.imgur.com/Rgy52mF.png" alt="Our Story" loading="lazy" />
              <div className="ws-story-card-overlay">
                <p>
                  Dr. Bartender was born from equal parts passion, precision, and a dash of
                  rebellion. After years behind the bar, chasing the perfect balance of flavor
                  and experience, I decided to build something that reflected both my initials &mdash;
                  D.R. &mdash; and my philosophy: bartending is as much a science as it is an art.
                </p>
              </div>
            </div>
          </FadeUp>

          <FadeUp delay={0.15}>
            <div className="ws-story-columns">
              <div className="ws-story-columns-image">
                <img src="https://i.imgur.com/ZUcJudg.png" alt="About Dr. Bartender" loading="lazy" />
              </div>
              <div className="ws-story-columns-text">
                <p>
                  We serve IL, IN &amp; MI with 20+ years' experience, vetted pros, and $2M
                  liquor liability &mdash; so you can relax while we handle the science.
                </p>
                <p>
                  We don't just mix drinks &mdash; we engineer experiences. Prescribing exactly
                  what every celebration needs: quality, creativity, and a bit of controlled chaos.
                </p>
              </div>
            </div>
          </FadeUp>

          <FadeUp delay={0.3}>
            <div className="ws-story-card">
              <img src="https://i.imgur.com/Rgy52mF.png" alt="Our Journey" loading="lazy" />
              <div className="ws-story-card-overlay">
                <p>
                  What started as one bartender's pursuit of the perfect cocktail has evolved into a
                  mobile bar experience unlike any other &mdash; where every event becomes its own
                  experiment, and every guest leaves a willing test subject of good times.
                </p>
              </div>
            </div>
          </FadeUp>
        </section>

        {/* Testimonials */}
        <section className="ws-section ws-testimonials-section" id="testimonials">
          <FadeUp className="ws-section-heading">
            <p className="ws-kicker">Kind Words</p>
            <h2>From Our Patrons</h2>
            <div className="ws-divider ws-divider-center" />
          </FadeUp>
          <div className="ws-testimonials-grid">
            {TESTIMONIALS.map((t, i) => (
              <FadeUp key={i} delay={i * 0.1}>
                <article className="ws-testimonial-card">
                  <div className="ws-review-stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div>
                  <p>{t.text}</p>
                  <cite className="ws-testimonial-author">&mdash; {t.author}</cite>
                </article>
              </FadeUp>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section className="ws-section" id="faq">
          <FadeUp className="ws-section-heading">
            <p className="ws-kicker">FAQ</p>
            <h2>Quick Answers</h2>
            <div className="ws-divider ws-divider-center" />
          </FadeUp>
          <div className="ws-faq-list">
            {FAQS.map((faq, i) => (
              <button
                key={i}
                className={`ws-faq-item ${openFaq === i ? 'open' : ''}`}
                aria-expanded={openFaq === i}
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
              <button onClick={() => scrollTo('services')}>The Bar</button>
              <button onClick={() => scrollTo('process')}>The Protocol</button>
              <button onClick={() => scrollTo('faq')}>FAQ</button>
              <a href="/labnotes">Blog</a>
              <button onClick={() => scrollTo('quote')}>Get a Quote</button>
            </div>
            <p className="ws-footer-email">contact@drbartender.com</p>
            <div className="ws-footer-copy">
              &copy; {new Date().getFullYear()} Dr. Bartender. All rights reserved.
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}

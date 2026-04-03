import React, { useState, useEffect, useRef } from 'react';
import BrandLogo from '../../components/BrandLogo';
import QuoteWizard from './QuoteWizard';

const SERVICES = [
  {
    icon: '\u{1F4CB}',
    title: 'Consultation + Menu Planning',
    text: 'We work directly with you to design a drink menu that fits your event, budget, and crowd \u2014 then hand over a custom shopping list so nothing gets left to guesswork.',
  },
  {
    icon: '\u{1F3A8}',
    title: 'Bespoke Menu Graphic',
    text: 'Every event gets a custom-designed cocktail menu. Polished presentation that elevates the whole experience.',
  },
  {
    icon: '\u{1F6E1}',
    title: 'Licensed + Insured',
    text: 'Professional staff, full liability coverage, and day-of bar management. Creativity meets precision.',
  },
];

const STEPS = [
  {
    number: '1',
    title: 'Proposal & Deposit',
    text: 'We send a custom proposal. Confirm your booking with a $100 deposit and we\u2019re locked in.',
  },
  {
    number: '2',
    title: 'The Potion Planner',
    text: 'We have a consultation where you complete our Potion Planner form. This helps us curate your shopping list and menu.',
  },
  {
    number: '3',
    title: 'Execute & Enjoy',
    text: 'We execute the experiment day-of. You focus on your guests \u2014 we handle the bar.',
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
  const [formData, setFormData] = useState({ name: '', email: '', eventType: '', message: '' });
  const [formSent, setFormSent] = useState(false);

  const scrollTo = (id) => {
    setMobileNav(false);
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  };

  const handleContactSubmit = (e) => {
    e.preventDefault();
    setFormSent(true);
    setFormData({ name: '', email: '', eventType: '', message: '' });
    setTimeout(() => setFormSent(false), 5000);
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
            </FadeUp>
            <FadeUp className="ws-hero-image" delay={0.2}>
              <img
                src="https://i.imgur.com/Plqd51Z.png"
                alt="Dr. Bartender Apothecary Bottle"
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
            {SERVICES.map((svc, i) => (
              <FadeUp key={svc.title} delay={i * 0.1}>
                <article className="ws-service-card">
                  <div className="ws-service-icon">{svc.icon}</div>
                  <h3>{svc.title}</h3>
                  <p>{svc.text}</p>
                </article>
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
          <div className="ws-protocol-grid">
            {STEPS.map((step, i) => (
              <FadeUp key={step.number} delay={i * 0.12}>
                <article className="ws-protocol-step">
                  <div className="ws-protocol-number">
                    <span>{step.number}</span>
                  </div>
                  <h3>{step.title}</h3>
                  <p>{step.text}</p>
                </article>
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
            <div className="ws-origin-card">
              <p>
                Dr. Bartender was born from equal parts passion, precision, and a dash of
                rebellion. After years behind the bar, chasing the perfect balance of flavor
                and experience, I decided to build something that reflected both my initials &mdash;
                D.R. &mdash; and my philosophy: bartending is as much a science as it is an art.
              </p>
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

        {/* Contact Form */}
        <section className="ws-section ws-contact-section" id="contact">
          <FadeUp className="ws-section-heading">
            <p className="ws-kicker">Ready When You Are</p>
            <h2>Start the Experiment</h2>
            <div className="ws-divider ws-divider-center" />
            <p className="ws-section-sub">
              No templates, no guesswork &mdash; just a conversation. Tell us a bit about your
              upcoming occasion, and let's work together to curate an experience that feels
              entirely yours.
            </p>
          </FadeUp>
          <FadeUp>
            <form className="ws-contact-form" onSubmit={handleContactSubmit}>
              <div className="ws-form-field">
                <label htmlFor="contact-name">Your Name</label>
                <input
                  type="text"
                  id="contact-name"
                  required
                  placeholder="Your name"
                  value={formData.name}
                  onChange={e => setFormData({ ...formData, name: e.target.value })}
                />
              </div>
              <div className="ws-form-field">
                <label htmlFor="contact-email">Email</label>
                <input
                  type="email"
                  id="contact-email"
                  required
                  placeholder="your@email.com"
                  value={formData.email}
                  onChange={e => setFormData({ ...formData, email: e.target.value })}
                />
              </div>
              <div className="ws-form-field">
                <label htmlFor="contact-event">Nature of the Occasion</label>
                <select
                  id="contact-event"
                  required
                  value={formData.eventType}
                  onChange={e => setFormData({ ...formData, eventType: e.target.value })}
                >
                  <option value="">Select one...</option>
                  <option>Private Gathering</option>
                  <option>Wedding or Gala</option>
                  <option>Corporate Event</option>
                  <option>Other</option>
                </select>
              </div>
              <div className="ws-form-field">
                <label htmlFor="contact-message">Your Message</label>
                <textarea
                  id="contact-message"
                  rows="4"
                  placeholder="Tell us about your event..."
                  value={formData.message}
                  onChange={e => setFormData({ ...formData, message: e.target.value })}
                />
              </div>
              <button type="submit" className="btn btn-primary ws-contact-submit">
                Send Your Enquiry
              </button>
              {formSent && (
                <p className="ws-form-success">
                  Your message has been received. We shall respond posthaste. &#10022;
                </p>
              )}
            </form>
          </FadeUp>
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

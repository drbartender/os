import React, { useRef, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PublicLayout from '../../components/PublicLayout';
import api from '../../utils/api';

/* ── FadeUp animation (reused from Website.js) ── */
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
    <div ref={ref} className={`ws-fade-up ${className}`}
      style={delay ? { transitionDelay: `${delay}s` } : undefined} {...props}>
      {children}
    </div>
  );
}

/* ── Smooth scroll helper ── */
const scrollTo = (id) => {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth' });
};

/* ── Data ── */
const services = [
  { src: 'https://i.imgur.com/iHkv9dI.png', alt: 'Consultation + Menu Planning' },
  { src: 'https://i.imgur.com/K5vxw25.png', alt: 'Bespoke Menu Graphic' },
  { src: 'https://i.imgur.com/0Q1UMdE.png', alt: 'Licensed + Insured' },
];

const steps = [
  {
    number: '01',
    title: 'The Prescription',
    body: 'We craft a custom proposal tailored to your event. Once you approve it, a $100 deposit secures your date.',
    img: 'https://i.imgur.com/RtN224c.png',
    reverse: false,
  },
  {
    number: '02',
    title: 'The Potion Planner',
    body: 'Next, we have a quick consultation and design your drink menu with a personalized shopping list.',
    img: 'https://i.imgur.com/uJ1JrvN.png',
    reverse: true,
  },
  {
    number: '03',
    title: 'The Big Experiment',
    body: 'Event day arrives. We run the bar, mix the drinks, and keep the good times flowing — you relax and enjoy.',
    img: 'https://i.imgur.com/DlX1bdI.png',
    reverse: false,
  },
];

const FALLBACK_TESTIMONIALS = [
  {
    id: 'fallback-1',
    name: 'Eleanor V.',
    text: 'They transformed our garden party into a Victorian speakeasy. The smoked rosemary gin fizz was nothing short of sorcery.',
    rating: 5,
  },
  {
    id: 'fallback-2',
    name: 'James & Sarah K.',
    text: 'The attention to detail was extraordinary — from the hand-labelled bottles to the copper jiggers. Our wedding guests are still talking about it.',
    rating: 5,
  },
  {
    id: 'fallback-3',
    name: 'Marcus T.',
    text: 'Hired them for a corporate holiday party and it was exactly what we needed — professional, well-paced, and the menu was dialed in.',
    rating: 5,
  },
];

function renderStars(rating) {
  const filled = Math.max(0, Math.min(5, Math.round(rating || 5)));
  return '★'.repeat(filled) + '☆'.repeat(5 - filled);
}

const stats = [
  { value: '20+', label: 'Years Experience' },
  { value: '$2M', label: 'Liquor Liability' },
  { value: 'IL, IN, & MI', label: 'Service Area' },
];

/* ── Component ── */
export default function HomePage() {
  const [reviewsState, setReviewsState] = useState({
    status: 'loading',
    reviews: [],
    count: 0,
    averageRating: null,
  });

  useEffect(() => {
    let cancelled = false;
    api.get('/public/reviews?limit=6')
      .then((res) => {
        if (cancelled) return;
        const data = res.data || {};
        setReviewsState({
          status: 'loaded',
          reviews: Array.isArray(data.reviews) ? data.reviews : [],
          count: Number(data.count) || 0,
          averageRating: data.averageRating ?? null,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setReviewsState({ status: 'error', reviews: [], count: 0, averageRating: null });
      });
    return () => { cancelled = true; };
  }, []);

  const useRealReviews = reviewsState.status === 'loaded' && reviewsState.reviews.length >= 3;
  const displayedTestimonials = useRealReviews
    ? reviewsState.reviews.map((r) => ({ id: r.id, name: r.reviewerName, text: r.text, rating: r.rating }))
    : FALLBACK_TESTIMONIALS;
  const showRatingBadge = useRealReviews && reviewsState.averageRating != null && reviewsState.count >= 3;

  const handleHashScroll = (e) => {
    e.preventDefault();
    scrollTo('process');
  };

  return (
    <PublicLayout>
      {/* ───── Hero ───── */}
      <section className="ws-hero">
        <div className="ws-hero-inner">
          <div className="ws-hero-copy">
            <FadeUp>
              <span className="ws-kicker">Mixing Science with Celebration</span>
              <h1>Your event's bar, engineered.</h1>
              <p className="ws-hero-subtitle">Mobile Bar &middot; Cocktail Lab</p>
              <p>Professional mobile bar service for weddings, corporate events, and private parties in Chicagoland.</p>
              <div className="ws-hero-btns">
                <Link to="/quote" className="btn btn-primary">Get an Instant Quote</Link>
                <a href="#process" onClick={handleHashScroll}>See how it works &darr;</a>
              </div>
              <img src="https://i.imgur.com/rl26NX2.png" alt="Dr. Bartender accent" className="ws-hero-accent" />
            </FadeUp>
          </div>
          <div className="ws-hero-image">
            <div className="ws-hero-image-stack">
              <img src="https://i.imgur.com/Plqd51Z.png" alt="Dr. Bartender mobile bar" />
              <img src="https://i.imgur.com/buVhsQH.png" alt="Dr. Bartender cocktails" />
            </div>
          </div>
        </div>
      </section>

      {/* ───── Services ───── */}
      <section id="services" className="ws-section">
        <FadeUp>
          <div className="ws-section-heading">
            <h2>What's Included</h2>
            <p className="ws-section-sub">Consultation, custom menus, and professional bar service — fully licensed and insured.</p>
          </div>
        </FadeUp>
        <div className="ws-services-grid">
          {services.map((s, i) => (
            <FadeUp key={s.alt} delay={i * 0.15}>
              <div className="ws-service-image-card">
                <img src={s.src} alt={s.alt} />
              </div>
            </FadeUp>
          ))}
        </div>
        <FadeUp>
          <Link to="/quote" className="ws-section-cta">See packages &amp; pricing &rarr;</Link>
        </FadeUp>
      </section>

      {/* ───── How It Works ───── */}
      <section id="process" className="ws-section ws-protocol-section">
        <FadeUp>
          <div className="ws-section-heading">
            <h2>How It Works</h2>
          </div>
        </FadeUp>
        <div className="ws-protocol-steps">
          {steps.map((step, i) => (
            <FadeUp key={step.number} delay={i * 0.15}>
              <div className={`ws-protocol-row${step.reverse ? ' ws-protocol-row-reverse' : ''}`}>
                <div className="ws-protocol-text">
                  <span className="ws-step-number">{step.number}</span>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </div>
                <div className="ws-protocol-image">
                  <img src={step.img} alt={step.title} />
                </div>
              </div>
            </FadeUp>
          ))}
        </div>
        <FadeUp>
          <Link to="/quote" className="ws-section-cta">It starts with a quick quote &rarr;</Link>
        </FadeUp>
      </section>

      {/* ───── Social Proof ───── */}
      <section id="about" className="ws-section">
        <FadeUp>
          <div className="ws-about-intro">
            <span className="ws-kicker">About Us</span>
            <h2>Why Dr. Bartender?</h2>
            <p>
              Dr. Bartender was born from equal parts passion, precision, and a dash of rebellion
              — bartending is as much a science as it is an art. We don't just mix drinks, we engineer experiences.
            </p>
          </div>
        </FadeUp>

        <FadeUp delay={0.1}>
          <div className="ws-stats-row">
            {stats.map((s) => (
              <div key={s.label} className="ws-stat">
                <span className="ws-stat-value">{s.value}</span>
                <span className="ws-stat-label">{s.label}</span>
              </div>
            ))}
          </div>
        </FadeUp>

        {showRatingBadge && (
          <FadeUp delay={0.15}>
            <div className="ws-rating-badge">
              <span className="ws-review-stars" aria-hidden="true">{renderStars(reviewsState.averageRating)}</span>
              <span>
                <strong>{reviewsState.averageRating.toFixed(1)}</strong>
                {' · '}
                {reviewsState.count} reviews on Thumbtack
              </span>
            </div>
          </FadeUp>
        )}

        <div className="ws-testimonials-grid">
          {displayedTestimonials.map((t, i) => (
            <FadeUp key={t.id || t.name} delay={i * 0.15}>
              <div className="ws-testimonial-card">
                <div className="ws-review-stars">{renderStars(t.rating)}</div>
                <p>"{t.text}"</p>
                <span className="ws-testimonial-author">— {t.name}</span>
              </div>
            </FadeUp>
          ))}
        </div>
      </section>

      {/* ───── CTA Banner ───── */}
      <FadeUp>
        <section className="ws-cta-banner">
          <h2>Your event deserves a real bar.</h2>
          <Link to="/quote" className="btn btn-primary ws-cta-pulse">Get an Instant Quote</Link>
        </section>
      </FadeUp>
    </PublicLayout>
  );
}

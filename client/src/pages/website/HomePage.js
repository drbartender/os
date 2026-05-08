import React, { useRef, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PublicLayout from '../../components/PublicLayout';
import api from '../../utils/api';

/* ── FadeUp animation (preserved IntersectionObserver) ── */
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

/* ── Data ── */
const STATS = [
  { k: 'Liability', v: 'Gen + Liq', sub: 'fully insured' },
  { k: 'Years', v: '20+', sub: 'behind the stick' },
  { k: 'Coverage', v: 'IL · IN · MI', sub: 'travels regional' },
  { k: 'Avg. Quote', v: '5 min', sub: 'live pricing' },
];

const SERVICES = [
  {
    n: 'Formula I',
    t: 'BYOB Bar',
    body: "You supply the spirits, mixers, ice, and bar. We bring the tools, the cups, the garnish prep, and the BASSET-trained professionals to pour it all. Most popular.",
    img: "PHOTO\nbar setup\nclient's bottles",
  },
  {
    n: 'Formula II',
    t: 'Hosted Bar',
    body: 'Booze, ice, garnish, mixers, cups, and BASSET-trained bartenders — plus a built-out menu and the staff to run it. Bespoke menu included.',
    img: 'PHOTO\nbuilt bar\nat an event',
  },
  {
    n: 'Formula III',
    t: 'Cocktail Classes',
    body: 'Private classes — kits, syrups, garnishes, and a host with twenty-five years behind the stick. Two hours, eight guests.',
    img: 'PHOTO\nclass tasting\nfour glass flight',
  },
];

const METHOD_STEPS = [
  { n: 'I', kicker: 'Step One', t: 'The Prescription', body: 'Build an instant quote. Live pricing. We send a real proposal — sign and pay in one breath.' },
  { n: 'II', kicker: 'Step Two', t: 'The Potion Planner', body: 'A short questionnaire builds a menu around your taste. Browse cocktails. Add a smoke bubble.' },
  { n: 'III', kicker: 'Step Three', t: 'The Big Experiment', body: 'On the day, we arrive early, build the bar, and run a tight, smiling shift. You meet guests; we pour.' },
];

const CREDENTIALS = [
  ['Certified', 'BASSET-trained bartenders'],
  ['Insured', 'General + Liquor Liability'],
  ['Trained', 'Front of house → econ degree → culinary school'],
  ['Based', 'North Side, Chicago — travels'],
];

const FALLBACK_TESTIMONIALS = [
  {
    id: 'fallback-1',
    name: 'Eleanor V.',
    text: 'They transformed our garden party into a Victorian speakeasy. The smoked rosemary gin fizz was nothing short of sorcery.',
    rating: 5,
    role: 'Wedding · 120 guests',
  },
  {
    id: 'fallback-2',
    name: 'James & Sarah K.',
    text: 'The attention to detail was extraordinary — from the hand-labelled bottles to the copper jiggers. Our wedding guests are still talking about it.',
    rating: 5,
    role: 'Wedding · 180 guests',
  },
  {
    id: 'fallback-3',
    name: 'Marcus T.',
    text: 'Hired them for a corporate holiday party and it was exactly what we needed — professional, well-paced, and the menu was dialed in.',
    rating: 5,
    role: 'Corporate · 80 guests',
  },
];

function renderStars(rating) {
  const filled = Math.max(0, Math.min(5, Math.round(rating || 5)));
  return '★'.repeat(filled) + '☆'.repeat(5 - filled);
}

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

  const useRealReviews = reviewsState.status === 'loaded' && reviewsState.reviews.length >= 1;
  const featuredReview = useRealReviews
    ? {
        id: reviewsState.reviews[0].id,
        text: reviewsState.reviews[0].text,
        name: reviewsState.reviews[0].reviewerName,
        rating: reviewsState.reviews[0].rating,
        role: 'Thumbtack review',
      }
    : FALLBACK_TESTIMONIALS[0];
  const showRatingBadge = useRealReviews && reviewsState.averageRating != null && reviewsState.count >= 3;

  return (
    <PublicLayout>
      {/* ── Hero ─────────────────────────────────────────── */}
      <section className="ws-press-hero">
        <div className="ws-wrap">
          <FadeUp>
            <div className="ws-press-hero-center">
              <div className="ornament" aria-hidden="true">⚗</div>
              <div className="ws-press-eyebrow">No. 04 · The Prescription</div>
              <h1 className="ws-press-h1">
                Mixing Science<br />
                <em>with</em> Celebration.
              </h1>
              <div className="ws-press-tagline">
                <span className="ws-press-tagline-rule" aria-hidden="true" />
                <span>Mobile Bar · Cocktail Lab</span>
                <span className="ws-press-tagline-rule" aria-hidden="true" />
              </div>
              <p className="ws-press-lede">
                An apothecary running a contemporary cocktail program. Twenty years behind the
                stick, distilled into a calm, instant proposal — for weddings and events across{' '}
                <em>Illinois, Indiana,</em> and <em>Michigan.</em>
              </p>
              <div className="ws-press-hero-cta">
                <Link to="/quote" className="btn btn-primary">Get an Instant Quote</Link>
                <Link to="/method" className="btn btn-secondary">View the Method</Link>
              </div>
            </div>
          </FadeUp>

          <FadeUp delay={0.1}>
            <div className="ws-press-stats">
              {STATS.map((s) => (
                <div key={s.k} className="card on-paper ws-press-stat">
                  <div className="kicker no-rule ws-press-stat-label">{s.k}</div>
                  <div className="ws-press-stat-value">{s.v}</div>
                  <div className="ws-press-stat-sub">{s.sub}</div>
                </div>
              ))}
            </div>
          </FadeUp>
        </div>
      </section>

      {/* ── Proprietor (id=about for hash compatibility) ── */}
      <section id="about" className="ws-press-proprietor">
        <div className="ws-wrap ws-press-proprietor-grid">
          <FadeUp>
            <div className="card ws-press-specimen">
              <div className="ws-press-specimen-head">
                <span className="pill">Specimen No. I</span>
                <span className="ws-press-specimen-meta">The Proprietor</span>
              </div>
              <div className="ws-press-specimen-stage">
                <span className="ws-bracket tl" aria-hidden="true" />
                <span className="ws-bracket tr" aria-hidden="true" />
                <span className="ws-bracket bl" aria-hidden="true" />
                <span className="ws-bracket br" aria-hidden="true" />
                <div className="specimen-card-plate">
                  <div className="img-placeholder on-paper-tile" style={{ aspectRatio: '4 / 5' }}>
                    <span>{'PORTRAIT\nOF THE PROPRIETOR\ncandid · b&w · half-smirk'}</span>
                  </div>
                </div>
                <div className="specimen-card-tag">
                  <div style={{ fontSize: 9, letterSpacing: '0.32em', color: 'var(--paper)', textTransform: 'uppercase' }}>Catalogued</div>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: 16, color: 'var(--paper)', marginTop: 2 }}>D.R.</div>
                </div>
              </div>
              <div className="ws-press-specimen-foot">
                <div className="ws-press-specimen-name">Dallas Raby — D.R.</div>
                <div className="ws-press-specimen-quote">"I'm the Dr. — the Doctor — in Dr. Bartender."</div>
              </div>
            </div>
          </FadeUp>

          <FadeUp delay={0.1}>
            <div>
              <span className="kicker">No. 02 · About The Doctor</span>
              <h2 className="ws-press-h2">
                Twenty-five years in service.<br />
                <em>I'm the Dr. in Dr. Bartender.</em>
              </h2>
              <p>
                I'm <strong>Dallas Raby</strong> — D.R. — and I came up the long way. Roughly{' '}
                <em>ten years working the front of the house</em> while I held down a day job at a{' '}
                <em>video game company</em> and finished a <em>bachelor's in economics</em>.{' '}
                <em>Then</em> I went to culinary school and ended up back where I started — behind the bar.
              </p>
              <p>
                Corporate rooms, high-craft cocktail programs, and a stretch on the national event
                circuit — the <em>NFL Draft</em>, <em>F1 Las Vegas</em>, <em>Lollapalooza</em>,{' '}
                <em>Electric Forest</em>, <em>Oceans Calling</em>, <em>EDC Orlando</em>.
              </p>
              <div className="divider-ornate ws-press-divider"><span>credentials</span></div>
              <div className="ws-press-credentials">
                {CREDENTIALS.map(([k, v]) => (
                  <div key={k}>
                    <div className="ws-press-cred-label">{k}</div>
                    <div className="ws-press-cred-value">{v}</div>
                  </div>
                ))}
              </div>
              <Link to="/about" className="btn btn-secondary ws-press-bio-link">Read the full bio →</Link>
            </div>
          </FadeUp>
        </div>
      </section>

      {/* ── Services / Catalogue (id=services preserved) ── */}
      <section id="services" className="ws-press-services">
        <div className="ws-wrap">
          <FadeUp>
            <div className="ws-press-section-head">
              <span className="kicker center">No. 03 · Catalogue of Services</span>
              <h2 className="ws-press-h2">Three formulations. One laboratory.</h2>
              <p className="ws-press-section-italic">
                Every bar package includes a <strong>bespoke menu</strong> — two signature drinks built around your story, your colors, and what your guests actually want to drink. No upcharge.
              </p>
            </div>
          </FadeUp>
          <div className="ws-press-services-grid">
            {SERVICES.map((s, i) => (
              <FadeUp key={s.t} delay={i * 0.1}>
                <article className="card ws-press-service">
                  <div className="img-placeholder on-paper-tile" style={{ aspectRatio: '4 / 3' }}>
                    <span>{s.img}</span>
                  </div>
                  <div className="ws-press-service-body">
                    <div className="ws-press-service-formula">{s.n}</div>
                    <h3 className="ws-press-service-title">{s.t}</h3>
                    <p>{s.body}</p>
                    <Link to="/quote" className="btn btn-secondary">Build a Quote</Link>
                  </div>
                </article>
              </FadeUp>
            ))}
          </div>
          <FadeUp>
            <div className="ws-press-services-link">
              <Link to="/services" className="ws-press-arrow-link">See full catalogue →</Link>
            </div>
          </FadeUp>
        </div>
      </section>

      {/* ── Method (id=process preserved) ── */}
      <section id="process" className="ws-press-method">
        <div className="ws-wrap">
          <FadeUp>
            <div className="ws-press-section-head">
              <span className="kicker center">No. 04 · The Method</span>
              <h2 className="ws-press-h2">From "interested" to <em>open bar</em>, in three.</h2>
            </div>
          </FadeUp>
          <div className="ws-press-method-grid">
            {METHOD_STEPS.map((s, i) => (
              <FadeUp key={s.n} delay={i * 0.1}>
                <div className={`ws-press-method-col ${i < METHOD_STEPS.length - 1 ? 'has-divider' : ''}`}>
                  <div className="ws-press-method-numeral" aria-hidden="true">{s.n}</div>
                  <div className="ws-press-method-kicker">{s.kicker}</div>
                  <h3 className="ws-press-method-title">{s.t}</h3>
                  <p>{s.body}</p>
                  <div className="ws-press-method-ornament" aria-hidden="true">⚗</div>
                </div>
              </FadeUp>
            ))}
          </div>
          <FadeUp>
            <div className="ws-press-services-link">
              <Link to="/method" className="ws-press-arrow-link">See the full method →</Link>
            </div>
          </FadeUp>
        </div>
      </section>

      {/* ── Testimonial ── */}
      <section className="ws-press-testimonial">
        <div className="ws-wrap">
          <FadeUp>
            <div className="card ws-press-testimonial-card">
              <div className="ws-press-brass-frame" aria-hidden="true" />
              <div className="ws-press-testimonial-inner">
                <div className="kicker no-rule ws-press-testimonial-meta">
                  Field Report · {featuredReview.name}
                </div>
                <p className="ws-press-testimonial-quote">"{featuredReview.text}"</p>
                <div className="divider-ornate ws-press-divider"><span aria-label={`${renderStars(featuredReview.rating)} stars`}>{renderStars(featuredReview.rating)}</span></div>
                <div className="ws-press-testimonial-attribution">
                  {featuredReview.role || 'Wedding · Chicago'}
                </div>
                {showRatingBadge && (
                  <div className="ws-press-rating-badge">
                    <strong>{reviewsState.averageRating.toFixed(1)}</strong> · {reviewsState.count} reviews on Thumbtack
                  </div>
                )}
              </div>
            </div>
          </FadeUp>
        </div>
      </section>

      {/* ── Shimmer divider (rainbow placement #3) ── */}
      <div className="ws-wrap ws-shimmer-row">
        <hr className="divider-shimmer" />
      </div>

      {/* ── Closing CTA ── */}
      <section className="ws-press-cta-section">
        <div className="ws-wrap">
          <FadeUp>
            <div className="card ws-press-cta-card">
              <div className="ws-press-brass-frame" aria-hidden="true" />
              <div className="ws-press-cta-inner">
                <span className="kicker no-rule" style={{ color: 'var(--text-muted)' }}>Rx · The Prescription</span>
                <h2 className="ws-press-h2">
                  Tell us about the night.<br />
                  <em>We'll send a proposal before dinner.</em>
                </h2>
                <p>Five minutes. Live pricing. No phone tag — just the bar your event needs, costed out clearly.</p>
                <Link to="/quote" className="btn btn-primary ws-press-cta-btn">Get an Instant Quote</Link>
              </div>
            </div>
          </FadeUp>
        </div>
      </section>
    </PublicLayout>
  );
}

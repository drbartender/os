import React from 'react';
import { Link } from 'react-router-dom';
import PublicLayout from '../../components/PublicLayout';

const STEPS = [
  {
    n: 'I',
    kicker: 'Step One · The Prescription',
    t: 'Build an instant quote.',
    body: 'Five questions. Live pricing as you choose. We send a real proposal. Sign and pay in one breath. No 30-minute discovery call required.',
    photo: '/images/marketing/method-instant-quote-phone.jpg',
    alt: 'A phone showing the Dr. Bartender instant quote',
    bullets: [
      'Live pricing as you adjust',
      'Real proposal in your inbox',
      'Sign electronically · Stripe deposit',
    ],
  },
  {
    n: 'II',
    kicker: 'Step Two · The Potion Planner',
    t: 'Plan the menu.',
    body: 'A short questionnaire builds a menu around your taste: colors, flavors, allergens, what your guests actually want. Browse our cocktail catalogue. Mark favorites. Add a smoke bubble or two.',
    photo: '/images/marketing/method-planner-tablet.jpg',
    alt: 'A tablet showing the Dr. Bartender menu planner',
    bullets: [
      'Two signature drinks · always included',
      'Browse our curated catalogue',
      'Auto-saved · share with planner',
    ],
  },
  {
    n: 'III',
    kicker: 'Step Three · The Big Experiment',
    t: 'The night, run tight.',
    body: 'On the day, we arrive 30–90 minutes early depending on the size of the build, set up the bar, and run a tight, smiling, well-lit shift. You meet your guests; we pour. Tear-down is on us.',
    photo: '/images/marketing/method-event-bar.jpg',
    alt: 'Dr. Bartender bartenders running a built bar at an event',
    bullets: [
      'Arrive 30–90 min early · setup included',
      'BASSET-trained · general + liquor liability',
      'Tear-down · take everything with us',
    ],
  },
];

const TIMELINE = [
  ['Day 0', 'You hit the Instant Quote. 5 minutes. Proposal lands in your inbox before you close the tab.'],
  ['Day 1–2', 'You sign and pay deposit on Stripe. Date locked.'],
  ['T-30 days', 'Potion Planner opens. Build menu, swap drinks, finalize headcount.'],
  ['T-7 days', 'Final menu locked. Shopping list (BYOB) sent. Setup logistics confirmed.'],
  ['Event day', 'Arrive 30–90 minutes early depending on the build. Bar built. Doors open. We pour.'],
  ['+1 day', 'Final invoice reflects the hours and add-ons you actually used, up or down. Photo gallery if you opt in.'],
];

function StepText({ s }) {
  return (
    <div>
      <div className="ws-press-method-step-head">
        <div className="ws-press-method-numeral" aria-hidden="true">{s.n}</div>
        <div className="ws-press-method-step-kicker">{s.kicker}</div>
      </div>
      <h2 className="ws-press-h2 ws-press-method-step-h">{s.t}</h2>
      <p className="ws-press-method-step-body">{s.body}</p>
      <ul className="ws-press-method-bullets">
        {s.bullets.map((b) => (
          <li key={b}>
            <span className="ws-press-method-bullet-glyph" aria-hidden="true">⚗</span>
            {b}
          </li>
        ))}
      </ul>
    </div>
  );
}

function StepImage({ photo, alt }) {
  return (
    <div className="card ws-press-method-img">
      <div className="img-placeholder on-paper-tile has-photo" style={{ aspectRatio: '4 / 3' }}>
        <img className="ws-photo" src={photo} alt={alt} loading="lazy" />
      </div>
    </div>
  );
}

export default function MethodPage() {
  return (
    <PublicLayout>
      <section className="ws-press-pagehero">
        <div className="ws-wrap">
          <div className="ornament" aria-hidden="true">⚗</div>
          <div className="ws-press-eyebrow">No. 04 · The Method</div>
          <h1 className="ws-press-pagehero-title">The Method.</h1>
          <p className="ws-press-pagehero-sub">
            Three acts. From your first click to last call. Calm, on rails, and refreshingly free of phone tag.
          </p>
        </div>
      </section>

      <section className="ws-press-method-detail">
        <div className="ws-wrap">
          {STEPS.map((s, i) => (
            <div key={s.n} className={`ws-press-method-row ${i % 2 === 1 ? 'reverse' : ''}`}>
              {i % 2 === 0 ? (
                <>
                  <StepText s={s} />
                  <StepImage photo={s.photo} alt={s.alt} />
                </>
              ) : (
                <>
                  <StepImage photo={s.photo} alt={s.alt} />
                  <StepText s={s} />
                </>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="ws-press-timeline">
        <div className="ws-wrap">
          <div className="ws-press-section-head">
            <span className="kicker center">No. 05 · A Typical Timeline</span>
            <h2 className="ws-press-h2">From inquiry to last call.</h2>
          </div>
          <div className="card ws-press-timeline-card">
            {TIMELINE.map(([when, what]) => (
              <div key={when} className="leader ws-press-timeline-row">
                <span className="leader-label ws-press-timeline-when">{when}</span>
                <span className="leader-amount ws-press-timeline-what">{what}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Closing CTA */}
      <section className="ws-press-cta-section">
        <div className="ws-wrap">
          <div className="card ws-press-cta-card">
            <div className="ws-press-brass-frame" aria-hidden="true" />
            <div className="ws-press-cta-inner">
              <span className="kicker no-rule" style={{ color: 'var(--text-muted)' }}>Rx · The Prescription</span>
              <h2 className="ws-press-h2">
                Tell us about the night.<br />
                <em>We'll send a proposal before dinner.</em>
              </h2>
              <p>Five minutes. Live pricing. No phone tag. Just the bar your event needs, costed out clearly.</p>
              <Link to="/quote" className="btn btn-primary ws-press-cta-btn">Get an Instant Quote</Link>
            </div>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}

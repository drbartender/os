import React from 'react';
import { Link } from 'react-router-dom';
import PublicLayout from '../../components/PublicLayout';

const FORMULAS = [
  {
    num: 'Formula I',
    t: 'BYOB Bar',
    tag: 'most popular',
    starting: 'from $950',
    body: "You supply the bottles (we'll send a shopping list); we supply the bar. Tools, glassware, garnish prep, ice management, and BASSET-trained pros to pour it all night.",
    includes: [
      ['Bartenders', '1–4 BASSET-certified'],
      ['Tools & glassware', 'pro shaker kit · jiggers'],
      ['Garnish prep', 'cut to spec'],
      ['Shopping list', 'sent 2 weeks prior'],
      ['Ice & cups', 'optional add-on'],
      ['Bespoke menu', 'two signature drinks · included'],
    ],
    img: "PHOTO\nbar setup\nclient's bottles",
  },
  {
    num: 'Formula II',
    t: 'Hosted Bar',
    tag: 'full service',
    starting: 'from $1,800',
    body: "Full-service bar. We bring everything — booze, ice, mixers, garnish, glassware, cups, the whole built bar — and the BASSET-trained staff to run it. You meet your guests; we pour.",
    includes: [
      ['Spirits & mixers', 'curated to your menu'],
      ['Bartenders', '2–6 BASSET-certified'],
      ['Pop-up bar', 'rental available'],
      ['Garnish prep', 'fresh, day-of'],
      ['Glassware & cups', 'compostable available'],
      ['Bespoke menu', 'two signature drinks · included'],
    ],
    img: 'PHOTO\nbuilt bar\nat a wedding',
  },
  {
    num: 'Formula III',
    t: 'Cocktail Classes',
    tag: 'private',
    starting: 'from $640',
    body: 'Private group classes for 4–12 guests. We bring kits, syrups, garnishes, glassware, and one host with 25 years behind the stick. Two hours, three drinks per guest, lots of laughter.',
    includes: [
      ['Group size', '4–12 guests'],
      ['Drinks per guest', '3 cocktails · tasting'],
      ['Duration', '2 hours'],
      ['Kits & syrups', 'all included'],
      ['Recipe cards', 'take-home set'],
      ['Travel', 'within Chicago — IL, IN, MI by quote'],
    ],
    img: 'PHOTO\nclass tasting\nfour glass flight',
  },
];

const ADDONS = [
  ['Smoke Bubble', '+$8/drink', 'Edible-smoke globe over the cocktail. Pop-and-pour theater.'],
  ['Pop-up Bar Rental', 'from $250', 'Portable bar delivered, set up, and broken down. Several styles available.'],
  ['Espresso Service', '+$450', 'Pull shots for your espresso martinis from a real machine.'],
  ['Custom Glassware', 'from $4/ea', 'Etched coupe or rocks glass with your monogram or date.'],
];

function ServiceDetails({ s }) {
  return (
    <div className="ws-press-service-details">
      <div className="ws-press-service-details-head">
        <div className="kicker no-rule" style={{ color: 'var(--text-muted)' }}>{s.num}</div>
        <span className="pill">{s.tag}</span>
      </div>
      <h2 className="ws-press-service-h">{s.t}</h2>
      <div className="ws-press-service-price">{s.starting}</div>
      <p>{s.body}</p>
      <div className="divider-ornate ws-press-divider"><span>included</span></div>
      <div className="ws-press-service-leaders">
        {s.includes.map(([k, v]) => (
          <div key={k} className="leader">
            <span className="leader-label">{k}</span>
            <span className="leader-amount">{v}</span>
          </div>
        ))}
      </div>
      <div className="ws-press-service-cta">
        <Link to="/quote" className="btn btn-primary">Build a Quote</Link>
        <Link to="/method" className="btn btn-secondary">How it works</Link>
      </div>
    </div>
  );
}

function FormulaImage({ label }) {
  return (
    <div className="img-placeholder on-paper-tile" style={{ aspectRatio: '4 / 3' }}>
      <span>{label}</span>
    </div>
  );
}

export default function ServicesPage() {
  return (
    <PublicLayout>
      <section className="ws-press-pagehero">
        <div className="ws-wrap">
          <div className="ornament" aria-hidden="true">⚗</div>
          <div className="ws-press-eyebrow">No. 03 · Catalogue of Services</div>
          <h1 className="ws-press-pagehero-title">The Catalogue.</h1>
          <p className="ws-press-pagehero-sub">
            Three formulations of mobile bar service, each priced clearly. Every package includes a bespoke menu — two signature drinks built around your story.
          </p>
        </div>
      </section>

      <section className="ws-press-services-detail">
        <div className="ws-wrap">
          {FORMULAS.map((s, i) => (
            <div
              key={s.t}
              className={`card ws-press-formula ${i % 2 === 1 ? 'reverse' : ''}`}
            >
              {i % 2 === 0 ? (
                <>
                  <FormulaImage label={s.img} />
                  <ServiceDetails s={s} />
                </>
              ) : (
                <>
                  <ServiceDetails s={s} />
                  <FormulaImage label={s.img} />
                </>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="ws-press-addons">
        <div className="ws-wrap">
          <div className="ws-press-section-head">
            <span className="kicker center">No. 04 · Apothecary Add-Ons</span>
            <h2 className="ws-press-h2">Optional flourishes from the lab.</h2>
          </div>
          <div className="ws-press-addons-grid">
            {ADDONS.map(([t, p, b]) => (
              <article key={t} className="card ws-press-addon">
                <div className="kicker no-rule" style={{ color: 'var(--text-muted)' }}>{p}</div>
                <h3 className="ws-press-addon-title">{t}</h3>
                <p>{b}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Closing CTA — same pattern as HomePage */}
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
              <p>Five minutes. Live pricing. No phone tag — just the bar your event needs, costed out clearly.</p>
              <Link to="/quote" className="btn btn-primary ws-press-cta-btn">Get an Instant Quote</Link>
            </div>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}

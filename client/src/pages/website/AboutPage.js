import React from 'react';
import { Link } from 'react-router-dom';
import PublicLayout from '../../components/PublicLayout';

const CREDENTIALS = [
  ['Certified', 'BASSET-trained bartenders'],
  ['Insured', 'General + Liquor Liability'],
  ['Trained', 'Front of house → econ degree → culinary school'],
  ['Based', 'North Side, Chicago — travels'],
];

const TIMELINE = [
  ['~1998', 'First front-of-house gig. The floor becomes the classroom.'],
  ['1998–2008', "Ten years on the floor while working at a video game company and finishing a bachelor's in economics."],
  ['2009', 'Culinary school. Learn how a kitchen actually runs.'],
  ['2010', 'Line cook in Breckenridge. Discover I miss the front of the house.'],
  ['2011', 'First bar gig. Dr. Bartender — born as a pun, kept as a name.'],
  ['2010s', 'Cocktail program lead at three Chicago concepts. Build menus, train staff.'],
  ['2018+', 'National events: NFL Draft, F1 Vegas, Lollapalooza, Electric Forest, EDC Orlando.'],
  ['2024', 'Mobile bar full-time. Wedding & private event focus across IL · IN · MI.'],
  ['Today', 'You, hopefully.'],
];

export default function AboutPage() {
  return (
    <PublicLayout>
      <section className="ws-press-pagehero">
        <div className="ws-wrap">
          <div className="ornament" aria-hidden="true">⚗</div>
          <div className="ws-press-eyebrow">No. 02 · The Proprietor</div>
          <h1 className="ws-press-pagehero-title">The Doctor is in.</h1>
          <p className="ws-press-pagehero-sub">
            Twenty-five years in service, distilled into one calm bar at your event.
          </p>
        </div>
      </section>

      <section className="ws-press-proprietor ws-press-about-bio">
        <div className="ws-wrap ws-press-proprietor-grid">
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

          <div>
            <span className="kicker">The Long Version</span>
            <h2 className="ws-press-h2">
              Ten years on the floor, an econ degree, then culinary school.
            </h2>
            <p>
              I'm <strong>Dallas Raby</strong> — D.R. — and I came up the long way. Roughly{' '}
              <em>ten years working the front of the house</em> while I held down a day job at a{' '}
              <em>video game company</em> and finished a <em>bachelor's in economics</em>. The
              floor is where I learned how a room actually works — timing, tone, the math of a tip line.
            </p>
            <p>
              <em>Then</em> I went to culinary school. The kitchen sharpened the palate and taught
              me prep discipline; the bar is where it all came together. Years on the line in{' '}
              <em>Breckenridge</em>, then back to Chicago for cocktail programs, corporate rooms,
              and a stretch on the national event circuit — the <em>NFL Draft</em>,{' '}
              <em>F1 Las Vegas</em>, <em>Lollapalooza</em>, <em>Electric Forest</em>,{' '}
              <em>Oceans Calling</em>, <em>EDC Orlando</em>.
            </p>
            <p style={{ color: 'rgba(240, 232, 214, 0.7)', fontStyle: 'italic' }}>
              Based on the north side of Chicago. Travels well.
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
          </div>
        </div>
      </section>

      <section className="ws-press-career">
        <div className="ws-wrap">
          <div className="ws-press-section-head">
            <span className="kicker center">No. 02 · A Catalogue of Years</span>
            <h2 className="ws-press-h2">Twenty-five years, abridged.</h2>
          </div>
          <div className="card ws-press-career-card">
            <div className="ws-press-career-timeline">
              {TIMELINE.map(([when, what]) => (
                <div key={when} className="ws-press-career-entry">
                  <span className="ws-press-career-marker" aria-hidden="true" />
                  <div className="ws-press-career-when">{when}</div>
                  <div className="ws-press-career-what">{what}</div>
                </div>
              ))}
            </div>
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
              <p>Five minutes. Live pricing. No phone tag — just the bar your event needs, costed out clearly.</p>
              <Link to="/quote" className="btn btn-primary ws-press-cta-btn">Get an Instant Quote</Link>
            </div>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}

import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import PublicLayout from '../../components/PublicLayout';
import api from '../../utils/api';
import { getPackageBySlug } from '../../data/packages';

// Display groups, in order. Classes (bar_type 'class') are intentionally
// excluded from this page — they live in the class wizard. Each group's
// `match` keys on the live DB fields returned by /api/proposals/public/packages
// (category + bar_type), never on a hardcoded slug list.
const GROUPS = [
  {
    key: 'byob',
    kicker: 'Bring Your Own',
    label: 'BYOB Bar Service',
    blurb: 'You supply the bottles. We bring the bar kit, the prep, and the BASSET-certified pros to pour all night.',
    match: (p) => p.category === 'byob' && p.bar_type !== 'class',
  },
  {
    key: 'beer_and_wine',
    kicker: 'Hosted Service',
    label: 'Hosted Beer & Wine',
    blurb: 'We provide the beer, the wine, and everything around it. You just show up.',
    match: (p) => p.bar_type === 'beer_and_wine',
  },
  {
    key: 'full_bar',
    kicker: 'Hosted Service',
    label: 'Hosted Full Bar',
    blurb: 'Spirits, mixers, garnish, and the full build. We run the bar; you enjoy your event.',
    match: (p) => p.bar_type === 'full_bar',
  },
  {
    key: 'mocktail',
    kicker: 'Hosted Service',
    label: 'Hosted Mocktail Bar',
    blurb: 'A zero-proof program with the full bar experience. Perfect for a sober-curious crowd.',
    match: (p) => p.bar_type === 'mocktail',
  },
];

// Format a dollar amount, dropping a trailing .00 so integer rates read cleanly.
function fmtMoney(raw) {
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  return num % 1 === 0 ? String(num) : num.toFixed(2);
}

// Build the "from $X" pricing line from live DB rate fields.
//  - flat packages (BYOB): 4hr base rate, e.g. "From $350 (4 hours)"
//  - per-guest packages: 4hr per-guest rate, with the small-event rate noted
function pricingLine(pkg) {
  if (pkg.pricing_type === 'flat') {
    const base = fmtMoney(pkg.base_rate_4hr ?? pkg.base_rate_3hr);
    return base ? { main: `From $${base} (4 hours)`, sub: null } : null;
  }
  const large = fmtMoney(pkg.base_rate_4hr);
  if (!large) return null;
  const small = fmtMoney(pkg.base_rate_4hr_small);
  const differs = small && Number(pkg.base_rate_4hr_small) !== Number(pkg.base_rate_4hr);
  return {
    main: `From $${large}/guest (4 hours)`,
    sub: differs && pkg.min_guests ? `$${small}/guest under ${pkg.min_guests} guests` : null,
  };
}

function PackageCard({ pkg }) {
  // Descriptive sections come from the slug-keyed catalog. A DB package with no
  // catalog entry (e.g. BYOB core service, mocktail bar) renders name + DB
  // description + price only — no crash, no empty sections.
  const catalog = getPackageBySlug(pkg.slug);
  const price = pricingLine(pkg);
  const tagline = catalog ? catalog.tagline : null;
  const body = catalog ? catalog.description : pkg.description;
  const sections = catalog ? catalog.sections : null;

  return (
    <article className="card ws-pkg-card">
      <h3 className="ws-pkg-name">{pkg.name}</h3>
      {tagline && <div className="ws-pkg-tagline">{tagline}</div>}
      {price && (
        <div className="ws-pkg-price">
          <span className="ws-pkg-price-main">{price.main}</span>
          {price.sub && <span className="ws-pkg-price-sub">{price.sub}</span>}
        </div>
      )}
      {body && <p className="ws-pkg-desc">{body}</p>}
      {sections && sections.length > 0 && (
        <>
          <div className="divider-ornate ws-pkg-divider"><span>included</span></div>
          <div className="ws-pkg-sections">
            {sections.map((section) => (
              <div key={section.heading} className="ws-pkg-section-col">
                <div className="ws-pkg-section-head">{section.heading}</div>
                <ul className="ws-pkg-section-items">
                  {section.items.map((item) => (
                    <li key={item}>{item.split(' – ')[0]}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}
    </article>
  );
}

export default function PackagesPage() {
  const [packages, setPackages] = useState([]);
  const [status, setStatus] = useState('loading'); // 'loading' | 'error' | 'ready'

  const load = useCallback(() => {
    let cancelled = false;
    setStatus('loading');
    api.get('/proposals/public/packages')
      .then((r) => {
        if (cancelled) return;
        setPackages(Array.isArray(r.data) ? r.data : []);
        setStatus('ready');
      })
      .catch(() => { if (!cancelled) setStatus('error'); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => load(), [load]);

  // Assign each active non-class package to the first group it matches (the
  // group matches are already mutually exclusive; first-match keeps that safe
  // if they ever overlap). Anything non-class that matches no group lands in a
  // catch-all so a future package shape can never silently vanish from the page.
  const nonClass = packages.filter((p) => p.bar_type !== 'class');
  const buckets = new Map(GROUPS.map((g) => [g.key, []]));
  const other = [];
  nonClass.forEach((p) => {
    const group = GROUPS.find((g) => g.match(p));
    if (group) buckets.get(group.key).push(p);
    else other.push(p);
  });
  const grouped = GROUPS
    .map((g) => ({ ...g, items: buckets.get(g.key) }))
    .concat(other.length ? [{
      key: 'other',
      kicker: 'More Formulations',
      label: 'Other Packages',
      blurb: 'Additional service formulations for your event.',
      items: other,
    }] : [])
    .filter((group) => group.items.length > 0);
  const hasAny = grouped.length > 0;

  return (
    <PublicLayout>
      <section className="ws-press-pagehero">
        <div className="ws-wrap">
          <div className="ornament" aria-hidden="true">⚗</div>
          <div className="ws-press-eyebrow">No. 07 · The Formulary</div>
          <h1 className="ws-press-pagehero-title">The Formulary.</h1>
          <p className="ws-press-pagehero-sub">
            Every formulation we pour, priced clearly. Bring your own bottles, or let us provide
            the beer and wine, a full bar, or a zero-proof mocktail program. Live pricing for your
            exact event is always one <Link to="/quote">quote</Link> away.
          </p>
        </div>
      </section>

      {status === 'loading' && (
        <section className="ws-pkg-section">
          <div className="ws-wrap">
            <div className="loading" role="status" aria-live="polite">
              <div className="spinner" aria-hidden="true" />Consulting the formulary...
            </div>
          </div>
        </section>
      )}

      {status === 'error' && (
        <section className="ws-pkg-section">
          <div className="ws-wrap">
            <div className="card on-paper ws-pkg-state">
              <p>We couldn't load the formulary just now. Please try again in a moment.</p>
              <div className="ws-pkg-state-cta">
                <button type="button" className="btn btn-primary" onClick={load}>Try again</button>
                <Link to="/quote" className="btn btn-secondary">Build a Quote</Link>
              </div>
            </div>
          </div>
        </section>
      )}

      {status === 'ready' && !hasAny && (
        <section className="ws-pkg-section">
          <div className="ws-wrap">
            <div className="card on-paper ws-pkg-state">
              <p>No packages are listed right now. Get in touch and we'll build the right one for your event.</p>
              <div className="ws-pkg-state-cta">
                <Link to="/quote" className="btn btn-primary">Build a Quote</Link>
                <a href="mailto:contact@drbartender.com" className="btn btn-secondary">Email the Doctor</a>
              </div>
            </div>
          </div>
        </section>
      )}

      {status === 'ready' && hasAny && (
        <>
          <section className="ws-pkg-note-band">
            <div className="ws-wrap">
              <p className="ws-pkg-note">
                Hosted packages are billed at a 25-guest minimum, with a $550 event minimum.
              </p>
            </div>
          </section>

          {grouped.map((group) => (
            <section key={group.key} className="ws-pkg-section">
              <div className="ws-wrap">
                <div className="ws-press-section-head">
                  <span className="kicker center">{group.kicker}</span>
                  <h2 className="ws-press-h2">{group.label}</h2>
                  <p className="ws-pkg-group-blurb">{group.blurb}</p>
                </div>
                <div className="ws-pkg-grid">
                  {group.items.map((pkg) => (
                    <PackageCard key={pkg.id} pkg={pkg} />
                  ))}
                </div>
              </div>
            </section>
          ))}

          <section className="ws-press-cta-section">
            <div className="ws-wrap">
              <div className="card ws-press-cta-card">
                <div className="ws-press-brass-frame" aria-hidden="true" />
                <div className="ws-press-cta-inner">
                  <span className="kicker no-rule" style={{ color: 'var(--text-muted)' }}>Rx · The Prescription</span>
                  <h2 className="ws-press-h2">
                    Tell us about the night.<br />
                    <em>We'll price it exactly.</em>
                  </h2>
                  <p>Five minutes. Live pricing. The bar your event needs, costed out clearly.</p>
                  <Link to="/quote" className="btn btn-primary ws-press-cta-btn">Get an Instant Quote</Link>
                </div>
              </div>
            </div>
          </section>
        </>
      )}
    </PublicLayout>
  );
}

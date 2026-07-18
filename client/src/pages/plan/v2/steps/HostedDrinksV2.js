import React, { useMemo } from 'react';
import ScopeBanner from '../../components/ScopeBanner';

// Hosted drink step, three package-driven shapes (spec §3.2):
//   slots    — hard (the picks ARE the bar) or featured (picks headline it)
//   coverage — two tiers: included vs fenced with the real price on the badge
//   display  — "here's your bar": a confirmation, not a quiz
// Fence picks reuse the existing gap-addon auto-add shape; the server
// re-derives every hosted charge at submit and never trusts these.

function fmtMoney(n) {
  return `$${Number(n).toFixed(2)}`;
}

export default function HostedDrinksV2({ plan, selections, updateSelections, catalog, hostedShape }) {
  const coverageById = useMemo(() => {
    const m = new Map();
    for (const row of (plan.hosted_coverage?.drinks || [])) m.set(`${row.table}-${row.id}`, row);
    return m;
  }, [plan.hosted_coverage]);

  const guestCount = plan.guest_count || null;
  const selected = selections.signatureDrinks || [];
  const selectedMocktails = selections.mocktails || [];

  const allDrinks = useMemo(() => ([
    ...catalog.cocktails.map((d) => ({ ...d, table: 'cocktails' })),
    ...catalog.mocktails.map((d) => ({ ...d, table: 'mocktails' })),
  ]), [catalog]);

  const isPicked = (d) => (d.table === 'mocktails' ? selectedMocktails.includes(d.id) : selected.includes(d.id));

  const togglePick = (d) => {
    const key = `${d.table}-${d.id}`;
    const cov = coverageById.get(key);
    if (d.table === 'mocktails') {
      const next = selectedMocktails.includes(d.id)
        ? selectedMocktails.filter((x) => x !== d.id)
        : [...selectedMocktails, d.id];
      updateSelections('mocktails', next);
      return;
    }
    const adding = !selected.includes(d.id);
    updateSelections('signatureDrinks', adding ? [...selected, d.id] : selected.filter((x) => x !== d.id));
    // Mirror fence gap addons into addOns (autoAdded + triggeredBy). Display
    // and review only — the server re-derives the real charges at submit.
    if (cov && cov.status === 'fenced' && Array.isArray(cov.gap_addon_slugs)) {
      const addOns = { ...(selections.addOns || {}) };
      for (const slug of cov.gap_addon_slugs) {
        const meta = addOns[slug];
        const triggered = Array.isArray(meta?.triggeredBy) ? meta.triggeredBy : [];
        if (adding) {
          addOns[slug] = { enabled: true, autoAdded: true, triggeredBy: triggered.includes(d.id) ? triggered : [...triggered, d.id] };
        } else {
          const next = triggered.filter((x) => x !== d.id);
          if (next.length === 0 && meta?.autoAdded) delete addOns[slug];
          else if (meta) addOns[slug] = { ...meta, triggeredBy: next };
        }
      }
      updateSelections('addOns', addOns);
    }
  };

  // ── Shape: slots ────────────────────────────────────────────────────
  if (hostedShape === 'slots') {
    const hard = plan.package_slot_kind === 'hard';
    const cap = plan.package_slot_count || (hard ? 2 : 4);
    const pool = hard
      ? allDrinks.filter((d) => d.table === 'cocktails' && coverageById.get(`cocktails-${d.id}`)?.batchable)
      : allDrinks.filter((d) => d.table === 'mocktails');
    const picks = hard ? selected : selectedMocktails;
    const chosen = picks.length;

    const toggleSlot = (d) => {
      if (!isPicked(d) && chosen >= cap) return;
      togglePick(d);
    };

    return (
      <div>
        <ScopeBanner
          tone="hosted"
          title="We're providing"
          body={hard
            ? `Your ${plan.package_name || 'package'} pours ${cap} signature cocktails and everything they need. No shopping on your end.`
            : `We stock the basics plus what your picks need, so your bartender can improvise beyond the menu, just like a real bar.`}
        />
        <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
            {hard ? `Your ${cap === 2 ? 'Two' : cap} Signature Slots` : `Pick Your ${cap} Headliners`}
          </h2>
          <p className="text-muted">
            {hard
              ? 'These picks are the bar, so choose the ones your crowd will love.'
              : `These ${cap} headline your printed menu. The bar can still riff beyond them all night.`}
          </p>
        </div>
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', margin: 0 }}>Pick your {cap === 2 ? 'two' : cap}</h3>
            <span className="pp2-slot-counter">{chosen} of {cap} chosen</span>
          </div>
          <div className="serving-type-grid">
            {pool.map((d) => (
              <button
                key={`${d.table}-${d.id}`}
                className={`card serving-type-card${isPicked(d) ? ' selected' : ''}${!isPicked(d) && chosen >= cap ? ' pp2-slot-full' : ''}`}
                onClick={() => toggleSlot(d)}
                aria-pressed={isPicked(d)}
              >
                <span className="serving-type-emoji">{d.emoji}</span>
                <h3 className="serving-type-label">{d.name}</h3>
                <p className="serving-type-desc">{d.description}</p>
              </button>
            ))}
            {pool.length === 0 && <p className="text-muted">Menu loading, or nothing eligible yet. Reach out and we will sort it.</p>}
          </div>
        </div>
      </div>
    );
  }

  // ── Shape: display-only (beer & wine tiers) ────────────────────────
  if (hostedShape === 'display') {
    const prefs = selections.guestPreferences || {};
    const setPref = (patch) => updateSelections('guestPreferences', { ...prefs, ...patch });
    const includes = Array.isArray(plan.package_includes) ? plan.package_includes : [];
    const barLines = includes.filter((line) => !/hour|bartender|setup|breakdown|cooler|menu graphic|insurance/i.test(String(line)));

    return (
      <div>
        <ScopeBanner
          tone="hosted"
          title="We're providing"
          body="Your bar is set by your package. Nothing to pick, nothing to buy. This is a confirmation, not a quiz."
        />
        <div className="card potion-card-inner-frame" style={{ marginBottom: '1.5rem' }}>
          <span className="potion-kicker" style={{ display: 'block', textAlign: 'center' }}>{plan.package_name}</span>
          <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', textAlign: 'center' }}>Here's Your Bar</h2>
          <p className="text-muted" style={{ textAlign: 'center' }}>Stocked, iced, and poured by us on the day.</p>
          <div className="pp2-bar-lines">
            {barLines.map((line) => (
              <div key={line} className="conf-leader"><span>{String(line).split(' – ')[0]}</span><span /></div>
            ))}
          </div>
        </div>
        <div className="card">
          <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.5rem' }}>Two taste questions</h3>
          <p className="text-muted text-small mb-1" style={{ color: 'var(--warm-brown)' }}>
            Your rotating picks change event to event, so a read on your crowd helps us choose well.
          </p>
          <div className="form-group">
            <label className="form-label">Does your crowd lean red or white?</label>
            <div className="radio-group">
              {[['red', 'Red'], ['white', 'White'], ['even', 'An even split'], ['help', 'Help me decide']].map(([v, label]) => (
                <label key={v} className={`radio-option${prefs.wineLean === v ? ' selected' : ''}`}>
                  <input type="radio" name="wineLean" checked={prefs.wineLean === v} onChange={() => setPref({ wineLean: v })} />
                  <span className="radio-label">{label}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Beer drinkers: hoppy or light and easy?</label>
            <div className="radio-group">
              {[['hoppy', 'IPA and craft'], ['light', 'Light and easy'], ['mix', 'A mix'], ['help', 'Help me decide']].map(([v, label]) => (
                <label key={v} className={`radio-option${prefs.beerLean === v ? ' selected' : ''}`}>
                  <input type="radio" name="beerLean" checked={prefs.beerLean === v} onChange={() => setPref({ beerLean: v })} />
                  <span className="radio-label">{label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Shape: coverage browser ────────────────────────────────────────
  const covered = [];
  const fenced = [];
  for (const d of allDrinks) {
    const cov = coverageById.get(`${d.table}-${d.id}`);
    if (!cov) continue; // unmakeable / no_recipe drinks never show here
    if (cov.status === 'covered') covered.push({ ...d, cov });
    else fenced.push({ ...d, cov });
  }
  const fencedCocktails = fenced.filter((d) => d.table === 'cocktails');
  const fencedMocktails = fenced.filter((d) => d.table === 'mocktails');

  const drinkCard = (d, dashed) => (
    <button
      key={`${d.table}-${d.id}`}
      className={`card serving-type-card pp2-fence-card${isPicked(d) ? ' selected' : ''}${dashed ? ' pp2-fenced' : ''}`}
      onClick={() => togglePick(d)}
      aria-pressed={isPicked(d)}
    >
      <span className="serving-type-emoji">{d.emoji}</span>
      <h3 className="serving-type-label">{d.name}</h3>
      <p className="serving-type-desc">{d.description}</p>
      {dashed && d.table !== 'mocktails' && d.cov.gap_per_guest > 0 && (
        <span className="pp2-fence-badge">
          +{fmtMoney(d.cov.gap_per_guest)}/guest{guestCount ? ` · ${fmtMoney(d.cov.gap_per_guest * guestCount)} at ${guestCount}` : ''}
        </span>
      )}
    </button>
  );

  return (
    <div>
      <ScopeBanner
        tone="hosted"
        title="We're providing"
        body={`Your ${plan.package_name || 'package'} covers every drink on the first shelf. The add-on shelf is there if you want it, priced up front.`}
      />
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>Pick Your Pour List</h2>
        <p className="text-muted">Choose the cocktails that headline your menu. Pick 2 to 4 for a fast line and a happy bar.</p>
      </div>

      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
          Included in your package <span className="badge badge-approved" style={{ marginLeft: '0.5rem' }}>Covered</span>
        </h3>
        <div className="serving-type-grid">
          {covered.filter((d) => d.table === 'cocktails').map((d) => drinkCard(d, false))}
        </div>
        {covered.filter((d) => d.table === 'cocktails').length === 0 && (
          <p className="text-muted">Your covered list is being finalized. The add-on shelf below still works.</p>
        )}
      </div>

      {fencedCocktails.length > 0 && (
        <div className="card" style={{ marginBottom: '1.5rem' }}>
          <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.25rem' }}>Available as an add-on</h3>
          <p className="text-muted text-small mb-1" style={{ color: 'var(--warm-brown)' }}>
            These need ingredients beyond your package. The price on the tag is the whole story, added to your event balance when you submit.
          </p>
          <div className="serving-type-grid">
            {fencedCocktails.map((d) => drinkCard(d, true))}
          </div>
        </div>
      )}

      <div className="card">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.25rem' }}>Mocktails</h3>
        <p className="text-muted text-small mb-1" style={{ color: 'var(--warm-brown)' }}>
          One flavor comes pre-batched at $2.00 per guest. Two or more becomes the full Mocktail Bar add-on.
        </p>
        <div className="serving-type-grid">
          {[...covered.filter((d) => d.table === 'mocktails'), ...fencedMocktails].map((d) => drinkCard(d, d.cov.status === 'fenced'))}
        </div>
      </div>
    </div>
  );
}

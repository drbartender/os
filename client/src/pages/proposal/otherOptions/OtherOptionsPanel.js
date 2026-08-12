import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import axios from 'axios';
import { API_BASE_URL as BASE_URL } from '../../../utils/api';
import { fmt, formatDateShort } from '../proposalView/helpers';
import { bucketsForSlug, SECTION_ORDER } from '../catalogBuckets';
import CompareTable from './CompareTable';
import ExtrasPanel from './ExtrasPanel';

// "Same night, different bar." Every bar we could run for THIS event, priced for
// their real numbers, with the proposal Dallas sent marked as the recommendation.
//
// Nothing here writes. Pinning, changing the BYOB tier, and toggling extras are
// all re-quotes; the client's own proposal is untouched until they act on it.
// That is deliberate and load-bearing: a client who browses and leaves must
// leave no trace, exactly like the abandoned-checkout gratuity precedent.
//
// Raw axios + BASE_URL rather than utils/api: this is a public token page with no
// JWT, matching ProposalView and PackageMatrix.
const MAX_COMPARE = 3;

const laneOf = (o) => (o.category === 'byob' ? 'byob' : (o.pricing_type === 'per_guest' ? 'hosted' : 'other'));

export default function OtherOptionsPanel({ token, onWantOption }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [view, setView] = useState('pick');
  const [picked, setPicked] = useState([]);
  const [tierId, setTierId] = useState(undefined); // undefined = "server's default"
  const [extraIds, setExtraIds] = useState(undefined);
  const reqRef = useRef(0);
  const debounceRef = useRef(null);
  const selRef = useRef({ tierId: undefined, extraIds: undefined });

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const load = useCallback(async (sel) => {
    const seq = ++reqRef.current;
    if (sel) setBusy(true);
    try {
      const body = sel ? { tier_addon_id: sel.tierId ?? null, extra_addon_ids: sel.extraIds || [] } : {};
      const res = await axios.post(`${BASE_URL}/proposals/t/${token}/options`, body);
      if (seq !== reqRef.current) return; // a newer re-quote superseded this one
      setData(res.data);
      setError('');
      // Adopt the server's starting selection on first load so the client's own
      // add-ons are the baseline rather than an empty slate.
      if (!sel) {
        const t = (res.data.tiers || []).find((x) => x.selected);
        const adoptedTier = t ? t.addon_id : null;
        const adoptedExtras = (res.data.extras || []).filter((x) => x.selected).map((x) => x.addon_id);
        setTierId(adoptedTier);
        setExtraIds(adoptedExtras);
        selRef.current = { tierId: adoptedTier, extraIds: adoptedExtras };
      }
    } catch (err) {
      if (seq !== reqRef.current) return;
      // Keep whatever is already on screen. Losing a loaded comparison (and the
      // client's pins) to one transient failure is worse than the failure.
      setError('We could not re-price that just now.');
    } finally {
      if (seq === reqRef.current) { setLoading(false); setBusy(false); }
    }
  }, [token]);

  useEffect(() => { load(null); }, [load]);

  // Every click registers immediately in the UI; the quote follows once they
  // stop. Disabling the controls mid-flight instead would silently swallow taps,
  // and one request per tap can exhaust a rate-limit budget on a checkout page.
  const reQuote = (nextTier, nextExtras) => {
    setTierId(nextTier);
    setExtraIds(nextExtras);
    selRef.current = { tierId: nextTier, extraIds: nextExtras };
    setBusy(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => load(selRef.current), 300);
  };

  const toggleExtra = (id) => {
    // Functional-style read off the ref, not the render closure: two taps in one
    // tick would otherwise both compute from the same stale array and the first
    // would be lost.
    const cur = selRef.current.extraIds ?? extraIds ?? [];
    reQuote(selRef.current.tierId ?? tierId,
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  };

  const togglePick = (packageId) => {
    setPicked((p) => {
      if (p.includes(packageId)) return p.filter((x) => x !== packageId);
      if (p.length >= MAX_COMPARE) return p;
      return [...p, packageId];
    });
  };

  // Decorate each priced option with the things only the client knows: its
  // catalog contents and how it compares to what they were quoted.
  const options = useMemo(() => {
    if (!data || !data.comparable) return [];
    const currentTotal = data.options.find((o) => o.is_current)?.total ?? data.current_total;
    const tier = (data.tiers || []).find((t) => t.selected);
    return data.options.map((o) => {
      const isByob = o.category === 'byob';
      const diff = o.total === null || currentTotal === null ? null : o.total - currentTotal;
      return {
        ...o,
        isByob,
        buckets: isByob ? byobBuckets(tier, data.event) : bucketsForSlug(o.slug),
        badge: isByob
          ? (tier && tier.addon_id ? `BYOB · ${tier.name}` : 'BYOB · bar service only')
          : (o.pricing_type === 'per_guest' ? 'Hosted · we bring everything' : 'Hosted'),
        name: isByob && tier && tier.addon_id ? `${o.name} with ${tier.name}` : o.name,
        delta: o.is_current ? 'What we prescribed'
          : diff === null ? ''
            : diff > 0 ? `${fmt(diff)} more than yours`
              : diff < 0 ? `${fmt(Math.abs(diff))} less than yours` : 'Same as yours',
      };
    });
  }, [data]);

  const pickedCols = useMemo(
    () => picked.map((id) => options.find((o) => o.package_id === id)).filter(Boolean),
    [picked, options]
  );

  const event = useMemo(() => {
    const e = (data && data.event) || {};
    const bits = [
      e.guest_count != null ? `${e.guest_count} guests` : null,
      e.event_duration_hours != null ? `${Number(e.event_duration_hours)} hours` : null,
      e.num_bars != null ? `${e.num_bars} bar${Number(e.num_bars) === 1 ? '' : 's'}` : null,
      e.event_date ? formatDateShort(e.event_date) : null,
    ].filter(Boolean);
    return { ...e, line: bits.join(' · ') };
  }, [data]);

  if (loading) return <p className="oo-status">Pricing your options…</p>;

  // Hard failure with nothing on screen yet. Once data exists a failure shows as
  // an inline banner instead (below), so a bad re-quote never wipes the session.
  if (error && !data) {
    return (
      <div className="oo-status">
        <p>{error}</p>
        <button type="button" className="oo-back" onClick={() => load(null)}>Try again</button>
      </div>
    );
  }

  // The server declines to compare a custom-priced or already-signed proposal.
  // Say so — returning null left the client staring at the space where the
  // button they just pressed used to be.
  if (!data || !data.comparable || options.length < 2) {
    const why = data && data.reason === 'custom_pricing'
      ? 'Your proposal is priced specially for you, so it is not one of our standard packages. Just reply to your email or give us a call and we will walk you through the alternatives.'
      : data && data.reason === 'already_signed'
        ? 'You have already signed for this bar. If you want to change it, reply to your email or give us a call and we will sort it out.'
        : 'There are no other options to show for this event right now.';
    return <p className="oo-status">{why}</p>;
  }

  if (view === 'compare' && pickedCols.length > 0) {
    return (
      <>
        {error && (
          <div className="oo-error" role="alert">
            {error}{' '}
            <button type="button" className="oo-back" onClick={() => load(selRef.current)}>Try again</button>
          </div>
        )}
        <CompareTable
          columns={pickedCols}
          event={event}
          currentPackageId={data.current_package_id}
          extrasCount={(extraIds || []).length}
          onBack={() => setView('pick')}
          onAddMore={() => setView('pick')}
          onChoose={onWantOption}
        />
        <ExtrasPanel extras={data.extras} hours={event.event_duration_hours} onToggle={toggleExtra} />
      </>
    );
  }

  const lanes = [
    ['hosted', 'We bring everything'],
    ['byob', 'You buy the alcohol · we run the bar'],
    ['other', 'Also available'],
  ];

  const errorBanner = error ? (
    <div className="oo-error" role="alert">
      {error}{' '}
      <button type="button" className="oo-back" onClick={() => load(selRef.current)}>Try again</button>
    </div>
  ) : null;

  return (
    <div className={busy ? 'oo-pick oo-busy' : 'oo-pick'}>
      {errorBanner}
      <div className="oo-pick-head">
        <div>
          <h2 className="oo-h2">Same night, <em>different bar</em>.</h2>
          <p className="oo-sub">Tap the ones you want to hold up against each other. Nothing changes until you say so.</p>
        </div>
        <div className="oo-fixed">
          <div className="oo-fixed-k">Fixed for every option</div>
          <div className="oo-fixed-v">{event.line}</div>
        </div>
      </div>

      {lanes.map(([lane, label]) => {
        const inLane = options.filter((o) => laneOf(o) === lane);
        if (!inLane.length) return null;
        return (
          <section key={lane}>
            <div className="oo-lane"><span>{label}</span><i /></div>
            <div className="oo-cards">
              {inLane.map((o) => (
                <OptionCard
                  key={o.package_id}
                  option={o}
                  selected={picked.includes(o.package_id)}
                  atCap={!picked.includes(o.package_id) && picked.length >= MAX_COMPARE}
                  onToggle={() => togglePick(o.package_id)}
                  tiers={o.isByob ? data.tiers : null}
                  onTier={(id) => reQuote(id, extraIds || [])}
                />
              ))}
            </div>
          </section>
        );
      })}

      <ExtrasPanel extras={data.extras} hours={event.event_duration_hours} onToggle={toggleExtra} />

      <p className="oo-sr" role="status" aria-live="polite">
        {busy ? 'Re-pricing your options…' : `${picked.length} of ${MAX_COMPARE} pinned to compare.`}
      </p>

      {picked.length > 0 && (
        <div className="oo-tray">
          <div className="oo-tray-names">
            <strong>{picked.length}</strong> pinned · {pickedCols.map((c) => c.name).join(', ')}
            {picked.length >= MAX_COMPARE && (
              <div className="oo-note">Three is the most we can line up. Unpin one to swap it out.</div>
            )}
          </div>
          <div className="oo-tray-actions">
            <button type="button" className="oo-back" onClick={() => setPicked([])}>Clear all</button>
            <button type="button" className="oo-compare-btn" onClick={() => setView('compare')}>
              Compare {picked.length === 1 ? 'this one' : `these ${picked.length}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// BYOB has no catalog entry: what lands on the bar is the client's own bottles
// plus whatever the chosen support tier covers, which the server derives from
// the bundle config so this can never drift from what was actually priced.
function byobBuckets(tier, event) {
  const covers = (tier && tier.covers) || [];
  return {
    Spirits: ['Your bottles, poured by us', `Shopping list built for ${event.guest_count || 'your'} guests`],
    'Beer & Wine': ['Your beer and wine, chilled and served'],
    'Mixers & Extras': covers,
    'Non-Alcoholic': covers.length ? ['Bottled water service'] : [],
  };
}

function OptionCard({ option, selected, atCap, onToggle, tiers, onTier }) {
  const cls = ['oo-card', selected ? 'oo-card-on' : '', atCap ? 'oo-card-capped' : '',
    option.available ? '' : 'oo-card-off'].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <button
        type="button"
        className="oo-card-hit"
        aria-pressed={selected}
        disabled={!option.available || atCap}
        onClick={onToggle}
      >
        {selected && <span className="oo-check" aria-hidden="true">✓</span>}
        {option.is_current && <span className="oo-yours">Yours · recommended</span>}
        <span className="oo-badge">{option.badge}</span>
        <span className="oo-card-name">{option.name}</span>
        {option.available ? (
          <>
            <span className="oo-card-price">{fmt(option.total)}</span>
            <span className="oo-card-delta">{option.delta}</span>
          </>
        ) : (
          <span className="oo-card-delta">{option.reason}</span>
        )}
      </button>

      {/* What's actually in it. Outside the button on purpose: a list inside a
          <button> is invalid markup, and the contents are for reading rather
          than for hitting. */}
      {option.buckets && (
        <div className="oo-card-groups">
          {SECTION_ORDER.map((heading) => {
            const items = option.buckets[heading];
            if (!items || !items.length) return null;
            return (
              <div className="oo-card-group" key={heading}>
                <div className="oo-card-group-k">{heading}</div>
                <ul className="oo-items">
                  {items.map((it) => <li className="oo-item" key={it}>{it}</li>)}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      {tiers && (
        <div className="oo-tiers">
          <div className="oo-tiers-k">How much we bring with it</div>
          {tiers.map((t) => (
            <button
              type="button"
              key={t.addon_id === null ? 'none' : t.addon_id}
              className={t.selected ? 'oo-tier oo-tier-on' : 'oo-tier'}
              aria-pressed={t.selected}
              onClick={() => onTier(t.addon_id)}
            >
              <span>{t.name}</span>
              <span className="oo-tier-total">{t.total === null ? '—' : fmt(t.total)}</span>
            </button>
          ))}
        </div>
      )}

      <div className="oo-card-foot">
        {selected ? '✓ Added to compare' : atCap ? 'Unpin one to add this' : 'Tap to compare'}
      </div>
    </div>
  );
}

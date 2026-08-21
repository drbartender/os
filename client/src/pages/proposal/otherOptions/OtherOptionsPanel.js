import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import axios from 'axios';
import { API_BASE_URL as BASE_URL } from '../../../utils/api';
import { fmt, formatDateShort } from '../proposalView/helpers';
import ExtrasPanel from './ExtrasPanel';
import { buildLadder, openState } from './ladder';
import Rung, { RepriceCard, ConfirmCard } from './Rung';
import { POPULAR_EXTRA_SLUGS } from './popularExtras';
import { BUNDLE_INCLUDED, BUNDLE_UNAVAILABLE, BUNDLE_COVERED, BYOB_BUNDLE_SLUGS } from '../../../utils/proposalRules';
import { postSwitch } from './switchApi';
import { ADDON_CATEGORIES } from '../../../data/addonCategories';

// "How much should we handle?" ONE ladder, from bare bar service up to a fully
// stocked bar, priced for THIS event. Same date, same guests, same bars on every
// rung; the only thing that changes is how much we take off their hands.
//
// A drawer, not a section: the old panel expanded at the bottom of the page, so
// browsing scrolled the sign-and-pay surface out of view with nothing pulling
// the client back. Mobile gets a bottom sheet, desktop a right-hand panel with
// NO backdrop, so the proposal and its sticky pay rail stay usable alongside.
//
// Browsing still writes nothing. Changing the tier or toggling an extra is a
// re-quote; the client's proposal is untouched until they commit a rung, which
// is the abandoned-checkout gratuity precedent.
//
// Raw axios + BASE_URL rather than utils/api: public token page, no JWT,
// matching ProposalView and PackageMatrix.

const MOBILE_MAX = 1024;
const SNAP_PEEK = (h) => Math.min(Math.round(h * 0.66), 600);
const SNAP_FULL = (h) => Math.round(h * 0.96);

export default function OtherOptionsPanel({ token, open, onClose, onLanded }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tierId, setTierId] = useState(undefined); // undefined = "server's default"
  const [extraIds, setExtraIds] = useState(undefined);
  const [vw, setVw] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth));
  const [sheetH, setSheetH] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [openLane, setOpenLane] = useState('full_bar');
  const [contentsFor, setContentsFor] = useState(null);
  // The proposal's OWN extras, captured on first load only. Every re-quote
  // echoes back what was SENT, not what is committed, so this is the one moment
  // the committed baseline is knowable. Dirty is measured against it.
  const [committed, setCommitted] = useState(null);
  const [extrasOpen, setExtrasOpen] = useState(false);
  // One commit in flight at a time, keyed by the rung it belongs to, so the
  // states swap IN PLACE on that row rather than over the whole drawer.
  // phase: 'confirm' (things will come off) | 'inflight' | 'repriced' | 'refused'
  const [commit, setCommit] = useState(null);
  // What the engine says the client's CURRENT configuration costs today, as
  // opposed to what their contract says. Those differ whenever pricing moved
  // after the proposal was sent, which is not hypothetical here: lane 1's
  // hidden-add-on change ships in this very push. Fetched once, lazily, the
  // first time the draft goes dirty, so a client who never touches an extra
  // never pays for it.
  const baselineRef = useRef(null);
  const [baseline, setBaseline] = useState(null);
  const dragRef = useRef(null);
  const drawerRef = useRef(null);
  const isMobile = vw < MOBILE_MAX;
  const reqRef = useRef(0);
  const debounceRef = useRef(null);
  const selRef = useRef({ tierId: undefined, extraIds: undefined });

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const load = useCallback(async (sel, note) => {
    const seq = ++reqRef.current;
    if (sel) setBusy(true);
    try {
      const body = sel ? { tier_addon_id: sel.tierId ?? null, extra_addon_ids: sel.extraIds || [] } : {};
      const res = await axios.post(`${BASE_URL}/proposals/t/${token}/options`, body);
      if (seq !== reqRef.current) return; // a newer re-quote superseded this one
      setData(res.data);
      setError(note || '');
      // Adopt the server's starting selection on first load so the client's own
      // add-ons are the baseline rather than an empty slate.
      if (!sel) {
        const t = (res.data.tiers || []).find((x) => x.selected);
        const adoptedTier = t ? t.addon_id : null;
        const adoptedExtras = (res.data.extras || []).filter((x) => x.selected).map((x) => x.addon_id);
        setTierId(adoptedTier);
        setExtraIds(adoptedExtras);
        setCommitted(adoptedExtras);
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

  // ---- ladder assembly -----------------------------------------------------
  const ladder = useMemo(
    () => (data && data.comparable ? buildLadder(data) : null),
    [data]
  );

  const event = useMemo(() => {
    const e = (data && data.event) || {};
    // guests / hours / bars / date ONLY. Staffing never appears here: a package
    // with a different bartender ratio would re-derive the crew on a rung move,
    // and this line promises nothing about the night changes.
    const bits = [
      e.guest_count != null ? `${e.guest_count} guests` : null,
      e.event_duration_hours != null ? `${Number(e.event_duration_hours)} hours` : null,
      e.num_bars != null ? `${e.num_bars} bar${Number(e.num_bars) === 1 ? '' : 's'}` : null,
      e.event_date ? formatDateShort(e.event_date) : null,
    ].filter(Boolean);
    return { ...e, line: bits.join(' · ') };
  }, [data]);

  const anchorTotal = ladder && ladder.anchor ? ladder.anchor.total : null;

  // ---- extras strip, scoped to the anchor ----------------------------------
  const draft = extraIds ?? [];
  const sameSet = (a, b) =>
    [...(a || [])].sort().join(',') === [...(b || [])].sort().join(',');
  // Set inequality, never a total comparison: once ANY body is sent the current
  // card stops echoing the contract, so catalog drift alone can move the total
  // while the extras have not changed at all.
  const extrasDirty = committed !== null && !sameSet(draft, committed);

  useEffect(() => {
    if (!extrasDirty || baselineRef.current !== null || committed === null) return;
    baselineRef.current = 'pending';
    // Deliberately a separate request rather than reusing a draft re-quote: the
    // point is the price of the COMMITTED set, which no re-quote carrying the
    // draft can tell us. Sending a body also turns the contract echo off, so
    // what comes back is the engine's number rather than the stored one.
    axios.post(`${BASE_URL}/proposals/t/${token}/options`, {
      tier_addon_id: selRef.current.tierId ?? null,
      extra_addon_ids: committed,
    }).then((res) => {
      const cur = (res.data.options || []).find((o) => o.is_current);
      if (cur && cur.total !== null) setBaseline(Number(cur.total));
    }).catch(() => { /* best effort: without it we simply do not claim */ });
  }, [extrasDirty, committed, token]);

  // Which bundle the client is standing on, if any. Only BYOB has bundles, and
  // only a bundle can block an a la carte row.
  const currentTier = (data && (data.tiers || []).find((t) => t.selected)) || null;
  const bundleSlug = currentTier && currentTier.addon_id ? currentTier.slug : null;
  const bundleNames = useMemo(() => {
    const m = {};
    for (const t of (data && data.tiers) || []) if (t.slug) m[t.slug] = t.name;
    return m;
  }, [data]);

  // Three distinct blocked cases, and the difference matters to the client:
  // already yours, comes with a HIGHER bundle (a nudge up the ladder), or
  // subsumed by the one they are on (never point at a cheaper tier).
  const blockedFor = (x) => {
    if (!bundleSlug || !x.slug) return '';
    const name = bundleNames[bundleSlug] || 'your bundle';
    if ((BUNDLE_INCLUDED[bundleSlug] || []).includes(x.slug)) return `included in ${name}`;
    if (!(BUNDLE_UNAVAILABLE[bundleSlug] || []).includes(x.slug)) return '';
    const at = BYOB_BUNDLE_SLUGS.indexOf(bundleSlug);
    const higher = BYOB_BUNDLE_SLUGS
      .slice(at + 1)
      .find((b) => (BUNDLE_INCLUDED[b] || []).includes(x.slug));
    return higher ? `comes with ${bundleNames[higher] || higher}` : `covered by ${name}`;
  };

  // Curated chips UNIONED with anything already committed or drafted, so a
  // client never has to expand the full list to find something they have on.
  const offered = (data && data.extras) || [];
  const chips = offered.filter(
    (x) => POPULAR_EXTRA_SLUGS.includes(x.slug) || draft.includes(x.addon_id)
      || (committed || []).includes(x.addon_id)
  );
  const chipIds = new Set(chips.map((x) => x.addon_id));
  const knownCats = new Set(ADDON_CATEGORIES.map((c) => c.key));
  const groups = ADDON_CATEGORIES
    .map((c) => ({
      label: c.label,
      items: offered.filter((x) => x.category === c.key && !chipIds.has(x.addon_id)),
    }))
    // An add-on whose category is null or unrecognised belonged to NO group and
    // simply vanished from the strip: the server offers it, the client cannot
    // buy it, and nothing says so. Same class the ladder handles for an
    // unmapped bar_type, and the same answer: a catch-all, never silence.
    .concat([{
      label: 'Also available',
      items: offered.filter((x) => !knownCats.has(x.category) && !chipIds.has(x.addon_id)),
    }])
    .filter((g) => g.items.length);
  // ---- committing ----------------------------------------------------------
  const currentPackageId = data && data.current_package_id;
  const byName = (id) => (offered.find((x) => x.addon_id === id) || {}).name || '';

  // What comes OFF if they commit this rung, in two flavours the client should
  // hear about differently.
  const casualties = (entry) => {
    const isTier = entry.kind === 'tier';
    const targetBundle = isTier && entry.addon_id ? entry.slug : null;
    // Not offered there at all. The server names these per option; for a tier
    // move the package does not change, so nothing is dropped for applies_to.
    // Tier moves change no package, but visibility IS tier-dependent: the
    // mocktail-bar rule needs Formula-or-higher in the selection, so stepping
    // DOWN silently strips it unless we say so. Treating tier moves as
    // casualty-free was the silence the spec forbids.
    const tierGated = isTier
      ? draft.filter((id) => {
        const x = offered.find((o) => o.addon_id === id);
        if (!x || x.slug !== 'mocktail-bar') return false;
        return !['the-formula', 'the-full-compound'].includes(entry.slug || '');
      }).map(byName).filter(Boolean)
      : [];
    const droppedNames = isTier
      ? tierGated
      : [
        ...((entry.dropped || []).map((d) => d.name)),
        ...draft
          .filter((id) => Array.isArray(entry.visible_extra_ids) && !entry.visible_extra_ids.includes(id))
          .map(byName),
      ].filter(Boolean);
    // Absorbed INTO the target bundle. stripIncludedAddons eats these before
    // pricing, so they never reach the server's `dropped` list and the confirm
    // could not fire from it. The client twin is the only place this is
    // knowable, and "your ice delivery vanished" without a reason is exactly
    // the silence the spec forbids.
    const absorbedNames = targetBundle
      ? draft.filter((id) => (BUNDLE_COVERED[targetBundle] || []).includes(
        (offered.find((x) => x.addon_id === id) || {}).slug
      )).map(byName).filter(Boolean)
      : [];
    return { droppedNames, absorbedNames, targetBundleName: targetBundle ? bundleNames[targetBundle] : '' };
  };

  // The BYOB package's id, which is NOT necessarily the client's current one.
  // A hosted client stepping DOWN to a tier is a real ladder move, and posting
  // their hosted id would make the server strip the tier, price the hosted
  // package, and 409 forever against a tier-priced acknowledged total.
  const byobOption = data ? (data.options || []).find((o) => o.bar_type === 'service_only') : null;
  const byobPackageId = byobOption ? byobOption.package_id : currentPackageId;

  const bodyFor = (entry) => {
    const isTier = entry.kind === 'tier';
    if (isTier) {
      return {
        package_id: byobPackageId,
        tier_addon_id: entry.addon_id ?? null,
        extra_addon_ids: draft,
        acknowledged_total: entry.total,
      };
    }
    return {
      package_id: entry.package_id,
      // A tier only means anything on BYOB; carrying one onto a hosted package
      // would be nonsense the server would strip anyway.
      tier_addon_id: entry.bar_type === 'service_only' ? (tierId ?? null) : null,
      extra_addon_ids: draft,
      acknowledged_total: entry.total,
    };
  };

  const contractTotal = data && data.current_total !== undefined && data.current_total !== null
    ? Number(data.current_total) : null;

  const land = (entry, payload) => {
    const prior = ladder && ladder.anchor ? ladder.anchor : null;
    const sameRung = entry.rungKey === (prior && prior.rungKey);
    // "Only your extras changed" is a claim about ATTRIBUTION, so it needs the
    // base price to have held still. If today's price for the committed set
    // differs from what the contract says, part of the movement was ours, and
    // saying otherwise would blame the client's champagne toast for our
    // repricing. Cents-compare, never float equality. Unproven means unclaimed.
    // Three-valued on purpose. Unproven is NOT drift: if the baseline never
    // arrived we must claim NEITHER that only their extras changed nor that our
    // prices moved. The old boolean pair asserted drift whenever the baseline
    // was missing, which turned "we do not know" into an accusation about our
    // own pricing.
    const proven = baseline !== null && contractTotal !== null;
    const driftFree = proven
      && Math.round(baseline * 100) === Math.round(contractTotal * 100);
    setCommit(null);
    // The drawer is kept mounted so a close/reopen does not re-pay for the
    // quote, which means NOTHING else re-syncs it after a commit. Without this
    // the next open shows the OLD package still flagged "Yours", every delta is
    // measured against a configuration that no longer exists, and the next
    // undo names one a generation out of date. Re-adopt from scratch: the
    // committed baseline, the drift baseline and the open state all reseed.
    setCommitted(null);
    setBaseline(null);
    baselineRef.current = null;
    seededRef.current = false;
    setExtrasOpen(false);
    setContentsFor(null);
    load(null);
    onLanded({
      payload,
      packageName: entry.name,
      extrasOnly: sameRung && proven && driftFree,
      priceDrift: sameRung && proven && !driftFree,
      // Undo carries the PRIOR committed configuration and, crucially, the
      // prior committed TOTAL as its acknowledged_total. Re-quoting first and
      // acknowledging the new number would silently commit a price the banner
      // never promised.
      undoTo: prior
        ? {
          name: prior.name,
          body: {
            package_id: prior.kind === 'tier' ? currentPackageId : prior.package_id,
            tier_addon_id: prior.kind === 'tier' ? (prior.addon_id ?? null) : null,
            extra_addon_ids: committed || [],
            // The CONTRACT total, not the anchor's displayed one. After any
            // extras toggle the anchor is engine-priced against the DRAFT, so
            // pairing it with the committed extras would ask the server to
            // match a price for a configuration nobody quoted, and undo would
            // 409 in its most ordinary path: toggle a toast, switch, undo.
            acknowledged_total: contractTotal,
          },
        }
        : null,
    });
  };

  const inFlight = !!(commit && commit.phase === 'inflight');

  const fly = async (entry) => {
    // One write at a time, from ANY rung. Same-rung double-tap was already
    // blocked by the button unrendering, but every OTHER rung kept its button,
    // so a slow connection let a client start a second switch while the first
    // was open: two writes race, the server serializes them, and the surviving
    // configuration depends on arrival order.
    if (inFlight) return;
    setCommit({ rungKey: entry.rungKey, phase: 'inflight', oldTotal: entry.total });
    const r = await postSwitch(token, bodyFor(entry));
    if (r.ok) { land(entry, r.payload); return; }
    if (r.conflict) {
      if (r.quote) setData(r.quote);
      setCommit({ rungKey: entry.rungKey, phase: 'repriced', oldTotal: entry.total });
      return;
    }
    if (r.unknown) {
      // We do not know whether it landed, so we reconcile rather than guess AND
      // we say so. `load` clears `error` on success, so setting it first meant
      // the message survived only for the refetch; it is passed in instead.
      // The PAGE also has to reconcile: if the write did land, its totals and
      // the cancelled payment intents are stale until something refetches.
      setCommit(null);
      onLanded({ unknown: true });
      load(null, 'We lost track of that one. Here is where your proposal stands now.');
      return;
    }
    setCommit({ rungKey: entry.rungKey, phase: 'refused', error: r.error });
  };

  const onCommit = (entry) => {
    if (inFlight) return;
    const { droppedNames, absorbedNames } = casualties(entry);
    if (droppedNames.length || absorbedNames.length) {
      setCommit({ rungKey: entry.rungKey, phase: 'confirm' });
      return;
    }
    fly(entry);
  };

  const extrasSummary = draft.length
    ? offered.filter((x) => draft.includes(x.addon_id)).map((x) => x.name).join(', ')
    : 'glassware, a toast, an extra bartender';

  // Seed the open state from the ladder ONCE per load: a hosted client opens
  // expanded on their own lane, a BYOB client sees four rows and the expand
  // line. Re-quotes must not slam it shut under the client's fingers.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!ladder || seededRef.current) return;
    const s = openState(ladder);
    setExpanded(s.expanded);
    setOpenLane(s.openLane);
    seededRef.current = true;
  }, [ladder]);

  // A catalog edit must never silently drop a package off a money surface, so an
  // unrecognized bar_type renders in a catch-all AND leaves a trail. Lazy import
  // matches how the app loads Sentry: a static one would pull it into the main
  // bundle for a breadcrumb almost nobody hits.
  useEffect(() => {
    if (!ladder || !ladder.unmapped.length) return;
    import('@sentry/react')
      .then((S) => S.addBreadcrumb({
        category: 'options-ladder',
        level: 'warning',
        message: 'unmapped bar_type on the options ladder',
        data: { slugs: ladder.unmapped.map((o) => o.slug).join(',') },
      }))
      .catch(() => {});
  }, [ladder]);

  // ---- drawer chrome -------------------------------------------------------
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Body scroll lock is MOBILE ONLY: the sheet covers the page, so scrolling
  // behind it is just lost taps. On desktop the proposal beside the panel must
  // stay scrollable, which is the entire point of not dimming it.
  useEffect(() => {
    if (!open || !isMobile) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open, isMobile]);

  // Open the sheet at full height; the drag handle takes it down to peek.
  useEffect(() => {
    if (open && isMobile) setSheetH(SNAP_FULL(window.innerHeight));
  }, [open, isMobile]);

  useEffect(() => {
    if (!open || !drawerRef.current) return;
    const el = drawerRef.current.querySelector('button, [href], input, select, textarea');
    if (el) el.focus();
  }, [open]);

  // Trap Tab on MOBILE only. There aria-modal is true and the page behind is
  // scroll-locked under a backdrop, so letting Tab walk out drops a keyboard or
  // screen-reader user into content they can neither see nor scroll to. On
  // desktop the page stays deliberately usable beside the panel, aria-modal is
  // false, and trapping would be wrong.
  useEffect(() => {
    if (!open || !isMobile) return undefined;
    const onTab = (e) => {
      if (e.key !== 'Tab' || !drawerRef.current) return;
      const els = [...drawerRef.current.querySelectorAll(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )].filter((n) => n.offsetParent !== null);
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onTab);
    return () => window.removeEventListener('keydown', onTab);
  }, [open, isMobile]);

  const onPointerDown = (e) => {
    dragRef.current = { y0: e.clientY, h0: sheetH };
    setDragging(true);
    if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!dragRef.current) return;
    const dh = dragRef.current.y0 - e.clientY;
    const h = Math.max(180, Math.min(SNAP_FULL(window.innerHeight), dragRef.current.h0 + dh));
    setSheetH(h);
  };
  const onPointerUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    const peek = SNAP_PEEK(window.innerHeight);
    const full = SNAP_FULL(window.innerHeight);
    setSheetH(sheetH > (peek + full) / 2 ? full : peek);
  };

  if (!open) return null;

  const chrome = (inner, footer) => (
    <>
      {/* Mobile only: on desktop the proposal stays lit and usable beside it. */}
      {isMobile && <div className="oo-backdrop" onClick={onClose} />}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal={isMobile ? 'true' : 'false'}
        aria-label="How much should we handle?"
        className={[
          'oo-drawer',
          isMobile ? 'oo-drawer-sheet' : 'oo-drawer-panel',
          dragging ? 'oo-dragging' : '',
        ].filter(Boolean).join(' ')}
        style={isMobile ? { height: sheetH } : undefined}
      >
        {isMobile && (
          <div
            className="oo-grab"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            <span />
          </div>
        )}
        <div className="oo-head">
          <div className="oo-head-top">
            <div>
              <div className="oo-kicker">Your proposal · a second look</div>
              <h2 className="oo-title">How much should <em>we</em> handle?</h2>
            </div>
            <button type="button" className="oo-x" aria-label="Close" onClick={onClose}>×</button>
          </div>
          {/* Suppressed until the quote lands: an empty event line would render
              a bare leading comma under the headline while the skeletons show. */}
          {event.line && <div className="oo-event">{event.line}, none of this changes.</div>}
          <div className="oo-insurance">
            Every option includes our $2 million liquor liability insurance.
          </div>
        </div>
        <div className={busy ? 'oo-body oo-busy' : 'oo-body'}>{inner}</div>
        {/* Pinned chrome, deliberately OUTSIDE the scroller: with both lanes
            open the body is ~1800px, so a strip inside it sits below thirteen
            rungs and is effectively unreachable. It is also what keeps drag and
            scroll from fighting on the sheet. */}
        {footer}
      </div>
    </>
  );

  if (loading) {
    return chrome(
      [0, 1, 2, 3].map((i) => (
        <div className="oo-skel" key={i}>
          <i style={{ width: '46%' }} />
          <i style={{ width: '72%' }} />
        </div>
      ))
    );
  }

  // Hard failure with nothing on screen. Once data exists a failure shows as an
  // inline banner instead, so a bad re-quote never wipes the session.
  if (error && !data) {
    return chrome(
      <div className="oo-status">
        <p>{error}</p>
        <button type="button" className="oo-back" onClick={() => load(null)}>Try again</button>
      </div>
    );
  }

  // The server declines to compare a custom-priced or already-signed proposal.
  // Say so rather than rendering an empty ladder.
  if (!ladder || !data.comparable) {
    const why = data && data.reason === 'custom_pricing'
      ? 'Your proposal is priced specially for you, so it is not one of our standard packages. Just reply to your email or give us a call and we will walk you through the alternatives.'
      : data && data.reason === 'already_signed'
        ? 'You have already signed for this bar. If you want to change it, reply to your email or give us a call and we will sort it out.'
        : 'There are no other options to show for this event right now.';
    return chrome(<div className="oo-status"><p>{why}</p></div>);
  }

  const { anchor, byobRungs, hostedLanes, sideways, unmapped, hasHostedOptions } = ladder;

  const rung = (r, opts = {}) => (
    <Rung
      key={r.rungKey}
      entry={r}
      anchorTotal={anchorTotal}
      sideways={!!opts.sideways}
      contentsOpen={contentsFor === r.rungKey}
      onToggleContents={() => setContentsFor((c) => (c === r.rungKey ? null : r.rungKey))}
      tier={(data.tiers || []).find((t) => t.selected)}
      event={event}
      commit={commit && commit.rungKey === r.rungKey ? commit : null}
      casualties={casualties(r)}
      onCommit={() => onCommit(r)}
      onProceed={() => fly(r)}
      onCancel={() => setCommit(null)}
    />
  );

  return chrome(
    <>
      {error && (
        <div className="oo-error" role="alert">
          {error}{' '}
          <button type="button" className="oo-back" onClick={() => load(selRef.current)}>Try again</button>
        </div>
      )}

      {anchor && (
        <div className="oo-anchor">
          <div className="oo-anchor-row">
            <span className="oo-anchor-pill">Yours</span>
            <div className="oo-anchor-name">{anchor.name}</div>
            <div className="oo-anchor-total">{anchor.total === null ? '—' : fmt(anchor.total)}</div>
          </div>
          {/* The most-asked flow: a client happy with their package who just
              wants to add glassware. Without a commit here they would have to
              switch rungs to buy an extra, and the anchor total would show a
              number their proposal does not say. */}
          {extrasDirty && (
            <div className="oo-anchor-dirty">
              <span className="oo-anchor-note">quoted with your extras, not on your proposal yet</span>
              {(!commit || commit.rungKey !== anchor.rungKey) && (
                <button type="button" className="oo-commit" onClick={() => onCommit(anchor)}>
                  {draft.some((id) => !(committed || []).includes(id))
                    ? 'Add these to my proposal'
                    : 'Update my extras'}
                </button>
              )}
              {commit && commit.rungKey === anchor.rungKey && commit.phase === 'inflight' && (
                <span className="oo-commit-busy">Rewriting…</span>
              )}
            </div>
          )}
          {commit && commit.rungKey === anchor.rungKey && commit.phase === 'repriced' && (
            <RepriceCard
              newTotal={anchor.total}
              oldTotal={commit.oldTotal}
              onConfirm={() => fly(anchor)}
            />
          )}
          {commit && commit.rungKey === anchor.rungKey && commit.phase === 'refused' && (
            <p className="oo-rung-why">{commit.error}</p>
          )}
          {commit && commit.rungKey === anchor.rungKey && commit.phase === 'confirm' && (
            <ConfirmCard
              {...casualties(anchor)}
              onProceed={() => fly(anchor)}
              onCancel={() => setCommit(null)}
            />
          )}
        </div>
      )}

      {byobRungs.map((r) => rung(r))}

      {!expanded && hasHostedOptions && (
        <button type="button" className="oo-expand" onClick={() => setExpanded(true)}>
          <span className="oo-expand-rule">From here, we bring the alcohol too</span>
          <span className="oo-expand-cta">Let us stock the whole bar →</span>
        </button>
      )}

      {expanded && (
        <>
          <div className="oo-break"><span>From here, we bring the alcohol too</span><i /></div>
          {hostedLanes.map((lane) => {
            if (!lane.rungs.length) return null;
            const isOpen = openLane === lane.key;
            return (
              <section key={lane.key}>
                <button
                  type="button"
                  className="oo-lane-head"
                  onClick={() => setOpenLane(isOpen ? null : lane.key)}
                  aria-expanded={isOpen}
                >
                  <span>{lane.label}</span>
                  <i />
                  <em>{isOpen ? 'hide ↑' : `${lane.rungs.length} options ↓`}</em>
                </button>
                {isOpen && lane.rungs.map((r) => rung(r))}
              </section>
            );
          })}
          {sideways && rung(sideways, { sideways: true })}
          {unmapped.length > 0 && (
            <section>
              <div className="oo-break"><span>Also available</span><i /></div>
              {unmapped.map((r) => rung(r))}
            </section>
          )}
        </>
      )}

      <p className="oo-sr" role="status" aria-live="polite">
        {busy ? 'Re-pricing your options…' : (extrasDirty ? 'Your extras are quoted but not on your proposal yet.' : '')}
      </p>
    </>,
    <>
      <ExtrasPanel
        chips={chips}
        groups={groups}
        hours={event.event_duration_hours}
        onToggle={toggleExtra}
        expanded={extrasOpen}
        onExpand={() => setExtrasOpen((v) => !v)}
        summary={extrasSummary}
        blockedFor={blockedFor}
        isOn={(id) => draft.includes(id)}
      />
    </>
  );
}

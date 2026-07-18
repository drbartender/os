import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';
import { API_BASE_URL as BASE_URL } from '../../../utils/api';
import { DrinkShelves, EventShelf } from './LabShelves';
import { BalanceBanner, AdditionsLedger } from './LabLedger';

/**
 * The Enhancement Lab — planner v2's ONE selling surface (spec §3.3).
 * Token-gated, invoice-only: every addition lands on the event balance,
 * nothing here takes payment. Opens after submit, closes at shopping-list
 * approval. "The cabinet of finishing touches."
 *
 * Additions state shape mirrors the PUT body exactly:
 *   { addOns: {slug: {servingStyle?, toastTime?, drinks?, flavors?}},
 *     labSyrupSelections: {drinkId: [syrupId]} }
 * Every change PUTs the full desired state (idempotent reconcile server-side).
 */
export default function EnhancementLab() {
  const { token } = useParams();
  const [lab, setLab] = useState(null);
  const [loadState, setLoadState] = useState('loading'); // loading | ready | error
  const [additions, setAdditions] = useState({ addOns: {}, labSyrupSelections: {} });
  const [saveState, setSaveState] = useState('idle');    // idle | saving | saved | error
  // Server-exact pricing of the last-saved additions (integer cents). The
  // ledger prefers this over client math so pack discounts and shared-flavor
  // dedup always match the invoice; `dirty` covers the sub-second window
  // between a tap and its save, when the breakdown is momentarily stale.
  const [serverBreakdown, setServerBreakdown] = useState(null);
  const [dirty, setDirty] = useState(false);
  const saveTimer = useRef(null);
  const latestAdditions = useRef(additions);

  useEffect(() => {
    let cancelled = false;
    axios.get(`${BASE_URL}/drink-plans/t/${token}/lab`)
      .then((res) => {
        if (cancelled) return;
        setLab(res.data);
        const stored = res.data.lab_additions || {};
        const init = { addOns: stored.addOns || {}, labSyrupSelections: stored.labSyrupSelections || {} };
        setAdditions(init);
        latestAdditions.current = init;
        setServerBreakdown(res.data.lab_breakdown || null);
        setLoadState('ready');
      })
      .catch(() => { if (!cancelled) setLoadState('error'); });
    return () => { cancelled = true; };
  }, [token]);

  const pushSave = useCallback(() => {
    saveTimer.current = null;
    setSaveState('saving');
    const sent = latestAdditions.current;
    axios.put(`${BASE_URL}/drink-plans/t/${token}/lab`, sent)
      .then((res) => {
        setSaveState('saved');
        if (res.data?.lab_breakdown) setServerBreakdown(res.data.lab_breakdown);
        // Only clean if nothing changed while the save was in flight; a newer
        // change already has its own debounce pending.
        if (latestAdditions.current === sent) setDirty(false);
      })
      .catch((err) => {
        // 409 = window closed under us; surface the locked screen honestly.
        if (err?.response?.status === 409) {
          setLab((prev) => (prev ? { ...prev, state: 'locked' } : prev));
        }
        setSaveState('error');
      });
  }, [token]);

  const applyChange = useCallback((updater) => {
    setAdditions((prev) => {
      const next = updater(prev);
      latestAdditions.current = next;
      return next;
    });
    setDirty(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(pushSave, 500);
  }, [pushSave]);

  // Flush a pending debounce if the tab closes mid-wait.
  useEffect(() => {
    const flush = () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        const blob = new Blob([JSON.stringify(latestAdditions.current)], { type: 'application/json' });
        // sendBeacon can't set PUT; fall back to keepalive fetch.
        fetch(`${BASE_URL}/drink-plans/t/${token}/lab`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: blob,
          keepalive: true,
        }).catch(() => {});
      }
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [token]);

  const priceOf = useMemo(() => {
    const bySlug = new Map((lab?.addon_pricing || []).map((a) => [a.slug, a]));
    return (slug) => {
      const a = bySlug.get(slug);
      if (!a) return 0;
      const rate = Number(a.rate) || 0;
      return a.billing_type === 'per_guest' ? rate * (lab?.guest_count || 1) : rate;
    };
  }, [lab]);

  if (loadState === 'loading') {
    return <div className="potion-app pp2-lab-page"><div className="pp2-lab-status">Unlocking the lab…</div></div>;
  }
  if (loadState === 'error') {
    return (
      <div className="potion-app pp2-lab-page">
        <div className="pp2-lab-status">
          <h2>We couldn't open the lab</h2>
          <p>This link may have expired. Reach out and we'll help: contact@drbartender.com</p>
        </div>
      </div>
    );
  }
  if (lab.state === 'not_ready') {
    return (
      <div className="potion-app pp2-lab-page">
        <div className="pp2-lab-status">
          <h2>The Enhancement Lab opens after you file your formulas</h2>
          <p>Finish your drink plan first, then come back for the finishing touches.</p>
          <a className="pp2-lab-btn" href={`/plan/${token}`}>Back to the Potion Planner</a>
        </div>
      </div>
    );
  }

  const locked = lab.state === 'locked';
  const hasAdditions =
    Object.keys(additions.addOns).length > 0 ||
    Object.keys(additions.labSyrupSelections).length > 0;

  return (
    <div className="potion-app pp2-lab-page">
      <header className="pp2-lab-header">
        <div className="pp2-lab-brand">DR BARTENDER</div>
        <h1>The Enhancement Lab</h1>
        <p className="pp2-lab-tagline">The cabinet of finishing touches.</p>
        {locked ? (
          <div className="pp2-lab-lockbar">
            {hasAdditions
              ? 'The lab is closed for your event. Your additions below are locked in.'
              : 'The lab is closed for your event. Your formulas are locked in as filed.'}
            <span className="pp2-lab-lockbar-note">Need a change? Reply to your confirmation email and we'll see what we can do.</span>
          </div>
        ) : (
          <p className="pp2-lab-promise">Nothing is added until you say so. Everything here goes on your event balance. No payment now.</p>
        )}
      </header>

      <BalanceBanner balance={lab.balance} />

      <DrinkShelves
        drinks={lab.drinks}
        addonPricing={lab.addon_pricing}
        additions={additions}
        priceOf={priceOf}
        locked={locked}
        onChange={applyChange}
      />

      <EventShelf
        lab={lab}
        additions={additions}
        priceOf={priceOf}
        locked={locked}
        onChange={applyChange}
      />

      <AdditionsLedger
        lab={lab}
        additions={additions}
        priceOf={priceOf}
        saveState={saveState}
        serverBreakdown={dirty ? null : serverBreakdown}
      />

      <footer className="pp2-lab-footer">
        <p>Dr. Bartender · Mobile Bar · Cocktail Lab</p>
        <p>Mixing Science with Celebration</p>
      </footer>
    </div>
  );
}

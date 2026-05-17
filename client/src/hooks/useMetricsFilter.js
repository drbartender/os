import { useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * URL-synced metrics filter state. Three representable selections:
 *   - named preset → ?from=YYYY-MM-DD&to=YYYY-MM-DD   (no `range` param)
 *   - All time     → ?range=all                       (no from/to; API omits the date predicate)
 *   - Custom       → ?range=custom&from=...&to=...
 * No params at all → default = Last 12 months (deliberately DISTINCT from All time).
 * Mirrors useDrawerParam.js — layered on other params, never clobbers them.
 */
const iso = (d) => d.toISOString().slice(0, 10);

export function presetRange(preset, today = new Date()) {
  const y = today.getUTCFullYear();
  const mo = today.getUTCMonth();
  const d0 = (Y, M, D) => new Date(Date.UTC(Y, M, D));
  switch (preset) {
    case 'this-month':   return { from: iso(d0(y, mo, 1)), to: iso(d0(y, mo + 1, 0)) };
    case 'last-month':   return { from: iso(d0(y, mo - 1, 1)), to: iso(d0(y, mo, 0)) };
    case 'this-quarter': {
      const q = Math.floor(mo / 3) * 3;
      return { from: iso(d0(y, q, 1)), to: iso(d0(y, q + 3, 0)) };
    }
    case 'ytd':          return { from: iso(d0(y, 0, 1)), to: iso(d0(y, mo, today.getUTCDate())) };
    case 'last-12':      return { from: iso(d0(y, mo - 11, 1)), to: iso(d0(y, mo + 1, 0)) };
    default:             return { from: null, to: null };
  }
}

const NAMED = ['this-month', 'last-month', 'this-quarter', 'ytd', 'last-12'];

export default function useMetricsFilter() {
  const [params, setParams] = useSearchParams();
  const range = params.get('range');            // 'all' | 'custom' | null
  const from = params.get('from');
  const to = params.get('to');
  const basis = params.get('basis') || 'booked';

  // What the consuming page sends to the API.
  const effective = useMemo(() => {
    if (range === 'all') return { from: null, to: null, basis };  // true all-time
    if (from && to) return { from, to, basis };
    return { ...presetRange('last-12'), basis };                   // no params → default
  }, [range, from, to, basis]);

  const write = useCallback((mut) => {
    const p = new URLSearchParams(params);
    mut(p);
    setParams(p, { replace: false });
  }, [params, setParams]);

  // key ∈ NAMED ∪ { 'all', 'custom' }
  const setPreset = useCallback((key) => {
    if (key === 'all') {
      write((p) => { p.set('range', 'all'); p.delete('from'); p.delete('to'); });
    } else if (key === 'custom') {
      const seed = (from && to) ? { from, to } : presetRange('last-12');
      write((p) => { p.set('range', 'custom'); p.set('from', seed.from); p.set('to', seed.to); });
    } else {
      const r = presetRange(key);
      write((p) => { p.delete('range'); p.set('from', r.from); p.set('to', r.to); });
    }
  }, [write, from, to]);

  const setCustom = useCallback((next) => {
    write((p) => {
      p.set('range', 'custom');
      if (next.from) p.set('from', next.from); else p.delete('from');
      if (next.to) p.set('to', next.to); else p.delete('to');
    });
  }, [write]);

  const setBasis = useCallback((b) => {
    write((p) => p.set('basis', b));
  }, [write]);

  // Which dropdown option is active.
  const activePreset = useMemo(() => {
    if (range === 'all') return 'all';
    if (range === 'custom') return 'custom';
    if (!from && !to) return 'last-12';                 // no params → default
    for (const k of NAMED) {
      const r = presetRange(k);
      if (r.from === from && r.to === to) return k;
    }
    return 'custom';                                    // shared link, off-preset dates
  }, [range, from, to]);

  return { ...effective, rawFrom: from, rawTo: to, activePreset, setPreset, setCustom, setBasis };
}

import { useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * URL-synced metrics filter state. Reads/writes ?from=&to=&basis=.
 * Mirrors useDrawerParam.js — layered on top of other params, never clobbers them.
 *
 * Presets are pure date math relative to today. "All time" clears from/to.
 * Default (no params) = Last 12 months, basis=booked.
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
    case 'all':          return { from: null, to: null };
    default:             return { from: null, to: null };
  }
}

export default function useMetricsFilter() {
  const [params, setParams] = useSearchParams();
  const from = params.get('from');
  const to = params.get('to');
  const basis = params.get('basis') || 'booked';

  // No explicit range in URL → Last 12 months (default view).
  const effective = useMemo(() => {
    if (from && to) return { from, to, basis };
    if (from || to) return { from, to, basis }; // server will 400; surfaced as toast
    return { ...presetRange('last-12'), basis };
  }, [from, to, basis]);

  const setRange = useCallback((next) => {
    const p = new URLSearchParams(params);
    if (next.from && next.to) { p.set('from', next.from); p.set('to', next.to); }
    else { p.delete('from'); p.delete('to'); }
    setParams(p, { replace: false });
  }, [params, setParams]);

  const setBasis = useCallback((b) => {
    const p = new URLSearchParams(params);
    p.set('basis', b);
    setParams(p, { replace: false });
  }, [params, setParams]);

  // Which preset is active (for the dropdown), by matching computed ranges.
  const activePreset = useMemo(() => {
    if (!from && !to) return params.has('from') ? 'custom' : 'last-12';
    for (const k of ['this-month', 'last-month', 'this-quarter', 'ytd', 'last-12']) {
      const r = presetRange(k);
      if (r.from === from && r.to === to) return k;
    }
    return 'custom';
  }, [from, to, params]);

  return { ...effective, rawFrom: from, rawTo: to, activePreset, setRange, setBasis };
}

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import api from '../../../utils/api';
import { fmt$ } from '../../../components/adminos/format';
import { RainbowDefs, useIsRainbow } from '../../../components/adminos/rainbowDefs';

/**
 * Instrumented revenue chart (spec §4). Consumes the dashboard-stats `revenue`
 * series (monthly, DOLLARS) and the useMetricsFilter object. Hero series is
 * Collected (`paid`); companion is the basis series (`value`), labelled by the
 * active lens. Under data-palette="rainbow" the hero takes the pride treatment;
 * the Compare overlay is always neutral gray so the comparison always reads.
 *
 * The endpoint is monthly-only, so the Day/Week granularity buttons are
 * permanently disabled and non-affording (no fake interpolation). Zoom, compare,
 * hover, and legend toggles are all component state that resets on range change.
 */
const LENS_LABEL = { booked: 'Booked', scheduled: 'Scheduled', paid: 'Paid' };
const DATA_START = '2024-12-01';   // frozen CheckCherry ledger begins Dec 2024
const ERA_MONTH = '2026-05';       // DRB OS cutover month (era test on plotted series)
const HERO_COLOR = 'hsl(var(--ok-h) var(--ok-s) 52%)';
const COMPANION_COLOR = 'var(--accent)';
const PRIOR_COLOR = 'var(--ink-3)';

const H = 240;
const PAD_L = 48;
const PAD_R = 14;
const PAD_T = 16;
const PAD_B = 30;

const num = (v) => Number(v || 0);

const fmtMonth = (key) => {
  if (!key) return '';
  const [y, mo] = key.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1))
    .toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
};

const fmtK = (v) => {
  const n = Math.round(v);
  if (n >= 1000000) return '$' + (n / 1000000).toFixed(n % 1000000 ? 1 : 0) + 'm';
  if (n >= 1000) return '$' + Math.round(n / 1000) + 'k';
  return '$' + n;
};

const niceCeil = (v) => {
  if (!(v > 0)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / pow;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return step * pow;
};

// Mirror server metricsQueries.priorPeriod (equal length, immediately prior).
function priorPeriodClient(from, to) {
  const DAY = 86400000;
  const f = Date.parse(from + 'T00:00:00Z');
  const t = Date.parse(to + 'T00:00:00Z');
  if (Number.isNaN(f) || Number.isNaN(t)) return null;
  const lenDays = Math.round((t - f) / DAY) + 1;
  const priorTo = new Date(f - DAY);
  const priorFrom = new Date(priorTo.getTime() - (lenDays - 1) * DAY);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { from: iso(priorFrom), to: iso(priorTo) };
}

export default function RevenueChartCard({ data = [], filter, basis = 'booked' }) {
  const { from, to, basis: filterBasis, includeCc } = filter;
  const isRainbow = useIsRainbow();
  const coarse = useMemo(
    () => typeof window !== 'undefined' && !!window.matchMedia
      && window.matchMedia('(pointer: coarse)').matches,
    [],
  );

  const wrapRef = useRef(null);
  const svgRef = useRef(null);
  const priorCache = useRef({});
  const [W, setW] = useState(720);
  const [hoverIdx, setHoverIdx] = useState(null);

  // Transient state (spec §4): resets on any range / basis / history change.
  const [compare, setCompare] = useState(false);
  const [vis, setVis] = useState({ collected: true, companion: true, prior: true });
  const [priorRev, setPriorRev] = useState(null);

  // Measure container so one viewBox unit ~= one CSS px (crisp text, right label density).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (w > 0) setW(Math.max(320, w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    setCompare(false);
    setVis({ collected: true, companion: true, prior: true });
    setHoverIdx(null);
  }, [from, to, filterBasis, includeCc]);

  const allTime = !from || !to;

  // Legend-lock backstop: turning Compare off while Prior was the only visible
  // series would strand every base series hidden and blank the plot (the
  // per-toggle lock only guards at click time). Restore the hero.
  useEffect(() => {
    if (!(compare && !allTime) && !vis.collected && !vis.companion) {
      setVis(v => ({ ...v, collected: true }));
    }
  }, [compare, allTime, vis.collected, vis.companion]);

  const priorWindow = useMemo(
    () => (allTime ? null : priorPeriodClient(from, to)),
    [allTime, from, to],
  );
  const priorPartial = !!(priorWindow && priorWindow.from < DATA_START);

  // Compare: same LAW endpoint, shifted window, revenue series only, in-component cache.
  useEffect(() => {
    if (!compare || !priorWindow) { setPriorRev(null); return undefined; }
    const key = `${priorWindow.from}|${priorWindow.to}|${filterBasis}|${includeCc}`;
    if (priorCache.current[key]) { setPriorRev(priorCache.current[key]); return undefined; }
    let cancelled = false;
    const params = { basis: filterBasis, from: priorWindow.from, to: priorWindow.to };
    if (includeCc && includeCc !== 'all') params.include_cc = includeCc;
    api.get('/proposals/dashboard-stats', { params })
      .then((r) => {
        if (cancelled) return;
        const rev = Array.isArray(r.data?.revenue) ? r.data.revenue : [];
        priorCache.current[key] = rev;
        setPriorRev(rev);
      })
      .catch(() => { if (!cancelled) setPriorRev(null); });
    return () => { cancelled = true; };
  }, [compare, priorWindow, filterBasis, includeCc]);

  const n = data.length;
  const companionLabel = LENS_LABEL[basis] || 'Booked';
  const compareOn = compare && !allTime;
  const priorVisible = compareOn && vis.prior;

  const collectedVals = data.map((d) => num(d.paid));
  const companionVals = data.map((d) => num(d.value));
  const priorVals = compareOn && priorRev
    ? data.map((_, i) => (priorRev[i] ? num(priorRev[i].paid) : null))
    : [];

  const collectedTotal = collectedVals.reduce((s, v) => s + v, 0);
  const companionTotal = companionVals.reduce((s, v) => s + v, 0);
  const priorTotal = compareOn && priorRev ? priorRev.reduce((s, r) => s + num(r.paid), 0) : null;
  const deltaPct = priorTotal != null && priorTotal > 0
    ? Math.round(((collectedTotal - priorTotal) / priorTotal) * 100) : null;

  const maxCandidates = [];
  if (vis.collected) maxCandidates.push(...collectedVals);
  if (vis.companion) maxCandidates.push(...companionVals);
  if (priorVisible) priorVals.forEach((v) => { if (v != null) maxCandidates.push(v); });
  const maxY = niceCeil(maxCandidates.length ? Math.max(...maxCandidates) : 0);

  const plotW = Math.max(0, W - PAD_L - PAD_R);
  const plotH = H - PAD_T - PAD_B;
  const step = plotW / (n - 1 || 1);
  const baseY = PAD_T + plotH;
  const x = (i) => PAD_L + i * step;
  const y = (v) => PAD_T + plotH - (Math.max(0, v) / maxY) * plotH;

  const linePath = (vals) => vals.map((v, i) => `${i ? 'L' : 'M'} ${x(i)} ${y(v)}`).join(' ');
  const areaPath = (vals) => (n ? `${linePath(vals)} L ${x(n - 1)} ${baseY} L ${x(0)} ${baseY} Z` : '');
  const priorLinePath = () => {
    let s = '';
    let started = false;
    priorVals.forEach((v, i) => {
      if (v == null) { started = false; return; }
      s += `${started ? 'L' : 'M'} ${x(i)} ${y(v)} `;
      started = true;
    });
    return s.trim();
  };

  const hasPre = data.some((d) => d.key < ERA_MONTH);
  const hasPost = data.some((d) => d.key >= ERA_MONTH);
  const showEra = hasPre && hasPost;
  const eraIdx = showEra ? data.findIndex((d) => d.key >= ERA_MONTH) : -1;
  const eraAtEnd = eraIdx > n - 4;

  const yTicks = Array.from({ length: 5 }, (_, i) => (maxY / 4) * i);
  const xStride = Math.max(1, Math.ceil(n / 9));

  const idxFromEvent = (e) => {
    const svg = svgRef.current;
    if (!svg || n === 0) return null;
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return null;
    const vx = (e.clientX - rect.left) * (W / rect.width);
    const i = Math.round((vx - PAD_L) / (step || 1));
    return Math.max(0, Math.min(n - 1, i));
  };

  const zoomToMonth = useCallback((key) => {
    if (!key) return;
    const [yy, mm] = key.split('-').map(Number);
    const lastDay = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    filter.setCustom({ from: `${key}-01`, to: `${key}-${String(lastDay).padStart(2, '0')}` });
  }, [filter]);

  const onMove = (e) => { if (!coarse) setHoverIdx(idxFromEvent(e)); };
  const onLeave = () => { if (!coarse) setHoverIdx(null); };
  const onDown = (e) => {
    const i = idxFromEvent(e);
    if (i == null) return;
    if (coarse) setHoverIdx(i);              // tap → tooltip only; zoom is the button
    else zoomToMonth(data[i].key);           // fine pointer → direct zoom
  };

  const series = [
    { key: 'collected', label: 'Collected', color: HERO_COLOR, on: vis.collected },
    { key: 'companion', label: companionLabel, color: COMPANION_COLOR, on: vis.companion },
  ];
  if (compareOn) series.push({ key: 'prior', label: 'Prior', color: PRIOR_COLOR, dashed: true, on: vis.prior });
  const visibleCount = series.filter((s) => s.on).length;
  const available = ['collected', 'companion', ...(compareOn ? ['prior'] : [])];
  const toggle = (key) => setVis((prev) => {
    const next = { ...prev, [key]: !prev[key] };
    if (available.every((k) => !next[k])) return prev;   // last visible cannot go dark
    return next;
  });

  const captionRange = n ? `${fmtMonth(data[0].key)} to ${fmtMonth(data[n - 1].key)}` : '';
  const tipLeft = hoverIdx != null ? Math.min(90, Math.max(10, (x(hoverIdx) / W) * 100)) : 0;

  return (
    <div className="card ov-chart-card" style={{ marginBottom: 'var(--gap)' }}>
      <div className="card-head">
        <div className="hstack">
          <h3>Revenue</h3>
          <span className="k">{companionLabel} vs Collected, by month</span>
        </div>
        <div className="hstack ov-chart-ctrls" style={{ gap: 10 }}>
          <div className="metrics-seg ov-gran-seg" role="group" aria-label="Granularity">
            <button type="button" className="metrics-seg-btn ov-seg-disabled" disabled title="Monthly data">Day</button>
            <button type="button" className="metrics-seg-btn ov-seg-disabled" disabled title="Monthly data">Week</button>
            <button type="button" className="metrics-seg-btn is-active" aria-pressed="true">Month</button>
          </div>
          <button type="button" className={`btn btn-ghost btn-sm ov-compare-btn${compareOn ? ' is-on' : ''}`}
            aria-pressed={compareOn} disabled={allTime}
            title={allTime ? 'Compare needs a bounded date range' : 'Overlay the prior period'}
            onClick={() => setCompare((c) => !c)}>Compare</button>
        </div>
      </div>

      <div className="card-body">
        {n === 0 ? (
          <div className="muted tiny" style={{ padding: '2rem 0', textAlign: 'center' }}>No revenue in this range.</div>
        ) : (
          <>
            <div className="ov-chart-legend" role="group" aria-label="Series">
              {series.map((s) => {
                const only = s.on && visibleCount === 1;
                return (
                  <button key={s.key} type="button"
                    className={`ov-legend-chip${s.on ? '' : ' is-off'}${only ? ' is-locked' : ''}`}
                    aria-pressed={s.on} disabled={only}
                    title={only ? 'At least one series stays visible' : undefined}
                    onClick={() => toggle(s.key)}>
                    <span className="ov-legend-dot" style={{ background: s.color, borderRadius: s.dashed ? 0 : 2 }} />
                    {s.label}
                  </button>
                );
              })}
            </div>

            <div className="ov-chart-wrap" ref={wrapRef}>
              <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img"
                aria-label={`Revenue chart, ${captionRange}`}
                style={{ display: 'block', width: '100%', height: 'auto', cursor: coarse ? 'default' : 'pointer' }}
                onPointerMove={onMove} onPointerLeave={onLeave} onPointerDown={onDown}>
                <defs>
                  <linearGradient id="gRevHero" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0" stopColor={HERO_COLOR} stopOpacity="0.30" />
                    <stop offset="1" stopColor={HERO_COLOR} stopOpacity="0" />
                  </linearGradient>
                  <RainbowDefs />
                </defs>

                {yTicks.map((t, i) => (
                  <g key={i}>
                    <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} stroke="var(--line-1)" strokeDasharray="2 4" />
                    <text x={PAD_L - 8} y={y(t) + 3} fontSize="10" fill="var(--ink-4)" textAnchor="end" fontFamily="var(--font-ui)">{fmtK(t)}</text>
                  </g>
                ))}

                {data.map((d, i) => ((i % xStride === 0 || i === n - 1) ? (
                  <text key={d.key} x={x(i)} y={H - 8} fontSize="10" fill="var(--ink-4)" textAnchor="middle" fontFamily="var(--font-ui)">{d.m}</text>
                ) : null))}

                {vis.companion && (
                  <path d={linePath(companionVals)} fill="none" stroke={COMPANION_COLOR} strokeWidth="1.5" opacity="0.9" />
                )}
                {vis.collected && (
                  <>
                    <path d={areaPath(collectedVals)} fill={isRainbow ? 'url(#gPrideArea)' : 'url(#gRevHero)'} mask={isRainbow ? 'url(#gPrideMask)' : undefined} />
                    <path d={linePath(collectedVals)} fill="none" stroke={isRainbow ? 'url(#gPrideLine)' : HERO_COLOR} strokeWidth={isRainbow ? 2.5 : 2} />
                  </>
                )}
                {priorVisible && priorLinePath() && (
                  <path d={priorLinePath()} fill="none" stroke={PRIOR_COLOR} strokeWidth="1.5" strokeDasharray="5 4" opacity="0.8" />
                )}

                {showEra && eraIdx >= 0 && (
                  <g pointerEvents="none">
                    <title>DRB OS went live May 2026</title>
                    <line x1={x(eraIdx)} x2={x(eraIdx)} y1={PAD_T} y2={baseY} stroke="var(--ink-3)" strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />
                    <text x={eraAtEnd ? x(eraIdx) - 4 : x(eraIdx) + 4} y={PAD_T + 9} fontSize="8.5"
                      fill="var(--ink-3)" fontFamily="var(--font-ui)" textAnchor={eraAtEnd ? 'end' : 'start'} letterSpacing="0.08em">DRB OS LIVE</text>
                  </g>
                )}

                {hoverIdx != null && (
                  <g pointerEvents="none">
                    <line x1={x(hoverIdx)} x2={x(hoverIdx)} y1={PAD_T} y2={baseY} stroke="var(--ink-3)" strokeWidth="1" opacity="0.5" />
                    {vis.collected && <circle cx={x(hoverIdx)} cy={y(collectedVals[hoverIdx])} r="3" fill={isRainbow ? 'var(--ink-1)' : HERO_COLOR} />}
                    {vis.companion && <circle cx={x(hoverIdx)} cy={y(companionVals[hoverIdx])} r="3" fill={COMPANION_COLOR} />}
                    {priorVisible && priorVals[hoverIdx] != null && <circle cx={x(hoverIdx)} cy={y(priorVals[hoverIdx])} r="3" fill={PRIOR_COLOR} />}
                  </g>
                )}
              </svg>

              {hoverIdx != null && (
                <div className="ov-chart-tip" style={{ left: `${tipLeft}%` }}>
                  <div className="ov-chart-tip-month">{fmtMonth(data[hoverIdx].key)}</div>
                  {vis.collected && (
                    <div className="ov-chart-tip-row"><span className="ov-tip-dot" style={{ background: HERO_COLOR }} />Collected<b>{fmt$(collectedVals[hoverIdx])}</b></div>
                  )}
                  {vis.companion && (
                    <div className="ov-chart-tip-row"><span className="ov-tip-dot" style={{ background: COMPANION_COLOR }} />{companionLabel}<b>{fmt$(companionVals[hoverIdx])}</b></div>
                  )}
                  {priorVisible && priorVals[hoverIdx] != null && (
                    <div className="ov-chart-tip-row"><span className="ov-tip-dot" style={{ background: PRIOR_COLOR }} />Prior<b>{fmt$(priorVals[hoverIdx])}</b></div>
                  )}
                  {coarse && n > 1 && (
                    <button type="button" className="btn btn-secondary btn-sm ov-tip-zoom" onClick={() => zoomToMonth(data[hoverIdx].key)}>
                      Zoom to {fmtMonth(data[hoverIdx].key)}
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="ov-chart-footer">
              <span className="tiny"><span className="muted">Collected</span> <b>{fmt$(collectedTotal)}</b></span>
              <span className="tiny"><span className="muted">{companionLabel}</span> <b>{fmt$(companionTotal)}</b></span>
              {basis === 'paid' && (
                <span className="tiny muted">Paid basis: Collected and {companionLabel} are the same series.</span>
              )}
              {compareOn && priorTotal != null && (
                <span className="tiny">
                  <span className="muted">Prior</span> <b>{fmt$(priorTotal)}</b>
                  {deltaPct != null && (
                    <span className={`ov-delta ${deltaPct >= 0 ? 'up' : 'down'}`}> {deltaPct >= 0 ? '+' : ''}{deltaPct}%</span>
                  )}
                </span>
              )}
              {compareOn && priorPartial && (
                <span className="tiny muted">Prior period partial: data begins Dec 2024.</span>
              )}
              <span className="tiny muted ov-foot-caption">{captionRange} · monthly</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../utils/api';
import './labrat.css';

const COMPLETED_KEY = 'labrat-completed-ids';
const LAST_QUIZ_KEY = 'labrat-last-quiz';

const AREA_LABELS = {
  customer: 'Customer Booking',
  applicant: 'Bartender Apply',
  staff: 'Staff Onboarding & Portal',
  admin: 'Admin Tools',
  mobile: 'Mobile Spot-Checks',
  edge: 'Edge Cases',
};
const TIME_BUCKETS = [
  { label: 'Quick Hits (≤10 min)', test: m => m.estMinutes <= 10 },
  { label: 'Half Hour',            test: m => m.estMinutes > 10 && m.estMinutes <= 30 },
  { label: 'Long Haul',            test: m => m.estMinutes > 30 },
];

function detectDevice() {
  return /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop';
}

export default function LabRatMissions() {
  const [params] = useSearchParams();
  const [missions, setMissions] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [relaxed, setRelaxed] = useState(false);
  const [groupBy, setGroupBy] = useState('area');
  const [showAll, setShowAll] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  const completedIds = useMemo(() => {
    try { return JSON.parse(localStorage.getItem(COMPLETED_KEY) || '[]'); } catch { return []; }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setMissions(null);
    const fromQuiz = params.has('areas');
    const onError = (e) => {
      if (cancelled) return;
      setLoadError(e?.message || 'Could not load missions. Check your connection and try again.');
      setMissions([]);
    };
    if (fromQuiz && !showAll) {
      const areas = (params.get('areas') || '').split(',').filter(Boolean);
      const timeBudget = Number(params.get('timeBudget')) || 60;
      const adminComfort = params.get('adminComfort') || 'skip';
      try { localStorage.setItem(LAST_QUIZ_KEY, params.toString()); } catch { /* ignore */ }
      api.post('/qa/shortlist', {
        areas, timeBudget, adminComfort,
        device: detectDevice(),
        completedIds,
      }).then(r => {
        if (cancelled) return;
        setMissions(r.data.missions);
        setRelaxed(!!r.data.relaxed);
      }).catch(onError);
    } else {
      api.get('/qa/missions').then(r => {
        if (cancelled) return;
        setMissions(r.data.missions);
        setRelaxed(false);
      }).catch(onError);
    }
    return () => { cancelled = true; };
  }, [params, showAll, completedIds, reloadTick]);

  const savedQuiz = (() => {
    try { return localStorage.getItem(LAST_QUIZ_KEY) || ''; } catch { return ''; }
  })();

  if (!missions) return <div data-app="labrat" className="labrat-loading">Loading missions…</div>;

  const groups = groupBy === 'area'
    ? Object.entries(AREA_LABELS).map(([key, label]) => ({
        label, items: missions.filter(m => m.area === key),
      }))
    : TIME_BUCKETS.map(b => ({ label: b.label, items: missions.filter(b.test) }));

  return (
    <div data-app="labrat" className="labrat-picker">
      <main>
        <header className="labrat-picker-header">
          <h1>Pick a mission</h1>
          {params.has('areas') && !showAll && (
            <p className="labrat-quiz-hint">
              {relaxed && 'We loosened your filters a bit. '}
              <button className="labrat-link" onClick={() => setShowAll(true)}>Show all instead</button>
            </p>
          )}
          {showAll && savedQuiz && (
            <p className="labrat-quiz-hint">
              <Link className="labrat-link" to={`/labrat/missions?${savedQuiz}`}>← Back to my missions</Link>
            </p>
          )}
          {!params.has('areas') && !showAll && savedQuiz && (
            <p className="labrat-quiz-hint">
              <Link className="labrat-link" to={`/labrat/missions?${savedQuiz}`}>← Back to my missions</Link>
            </p>
          )}
          <div className="labrat-group-toggle">
            <button className={groupBy === 'area' ? 'on' : ''} onClick={() => setGroupBy('area')}>By area</button>
            <button className={groupBy === 'time' ? 'on' : ''} onClick={() => setGroupBy('time')}>By time</button>
          </div>
        </header>
        {groups.map(g => g.items.length > 0 && (
          <section key={g.label}>
            <h2>{g.label} <span className="labrat-count">({g.items.length})</span></h2>
            <div className="labrat-card-grid">
              {g.items.map(m => {
                const done = completedIds.includes(m.id);
                return (
                  <Link key={m.id} to={`/labrat/m/${m.id}`} className={`labrat-card ${done ? 'done' : ''}`}>
                    <h3>{m.title}</h3>
                    <p>{m.blurb}</p>
                    <div className="labrat-card-meta">
                      <span>⏱ ~{m.estMinutes} min</span>
                      <span className={`labrat-diff ${m.difficulty}`}>● {m.difficulty}</span>
                      {done && <span className="labrat-done-chip">✓ done</span>}
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
        {missions.length === 0 && (
          loadError ? (
            <p className="labrat-error">
              {loadError} <button className="labrat-link" onClick={() => setReloadTick(t => t + 1)}>Retry</button>
            </p>
          ) : (
            <p className="labrat-loading">No missions match those filters. <button className="labrat-link" onClick={() => setShowAll(true)}>Show all</button></p>
          )
        )}
      </main>
    </div>
  );
}

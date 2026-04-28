import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../utils/api';
import './labrat.css';

const COMPLETED_KEY = 'labrat-completed-ids';

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
  const [relaxed, setRelaxed] = useState(false);
  const [groupBy, setGroupBy] = useState('area');
  const [showAll, setShowAll] = useState(false);

  const completedIds = useMemo(() => {
    try { return JSON.parse(localStorage.getItem(COMPLETED_KEY) || '[]'); } catch { return []; }
  }, []);

  useEffect(() => {
    const fromQuiz = params.has('areas');
    if (fromQuiz && !showAll) {
      const areas = (params.get('areas') || '').split(',').filter(Boolean);
      const timeBudget = Number(params.get('timeBudget')) || 60;
      const adminComfort = params.get('adminComfort') || 'skip';
      api.post('/qa/shortlist', {
        areas, timeBudget, adminComfort,
        device: detectDevice(),
        completedIds,
      }).then(r => {
        setMissions(r.data.missions);
        setRelaxed(!!r.data.relaxed);
      });
    } else {
      api.get('/qa/missions').then(r => {
        setMissions(r.data.missions);
        setRelaxed(false);
      });
    }
  }, [params, showAll, completedIds]);

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
          <p className="labrat-loading">No missions match those filters. <button className="labrat-link" onClick={() => setShowAll(true)}>Show all</button></p>
        )}
      </main>
    </div>
  );
}

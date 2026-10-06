import React, { useEffect, useState } from 'react';
import api from '../../utils/api';
import DrinkPlanSelections from '../DrinkPlanSelections';
import { pickAnswerSets, sourceLine, switchLabel, listNote } from './answerSets';

// The client's answers beside the shopping list (spec
// docs/superpowers/specs/2026-10-06-shopping-list-client-answers-design.md).
// Shows the answers that drive the list from the newest set, with a view-only
// switch when the plan has both. Nothing here writes: rebuilding the list from
// the other set stays on the plan page's source switch.

const OPEN_KEY = 'drb.sl.answersOpen';

// A per-browser convenience. Storage can be blocked (private windows, cleared
// site data), so every access is guarded and the default is open.
export function readAnswersOpen() {
  try { return window.localStorage.getItem(OPEN_KEY) !== 'false'; } catch { return true; }
}

export function writeAnswersOpen(open) {
  try { window.localStorage.setItem(OPEN_KEY, open ? 'true' : 'false'); } catch { /* the default (open) still works */ }
}

export default function ClientAnswersPanel({ planId }) {
  const [data, setData] = useState({ status: 'loading' });
  const [shown, setShown] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setData({ status: 'loading' });
    setShown(null);
    (async () => {
      try {
        // All or nothing: DrinkPlanSelections filters picks against the
        // catalogs, so a missing catalog would silently drop the client's
        // drinks. The admin catalogs carry retired drinks too and sit behind
        // admin auth, off the public read limiter.
        const [planRes, cocktailsRes, mocktailsRes] = await Promise.all([
          api.get(`/drink-plans/${planId}`),
          api.get('/cocktails/admin'),
          api.get('/mocktails/admin'),
        ]);
        const plan = planRes.data;
        let recap = null;
        if (plan.has_consult_selections) {
          const body = (await api.get(`/drink-plans/${planId}/consult`)).data || {};
          // A server older than this panel answers without `recap`: an error,
          // never "no answers" beside a list the consult built.
          if (!Object.prototype.hasOwnProperty.call(body, 'recap')) {
            throw new Error('consult GET carries no recap');
          }
          recap = Array.isArray(body.recap) && body.recap.length > 0 ? body.recap : null;
        }
        if (cancelled) return;
        const { sets, initial } = pickAnswerSets(plan, recap !== null);
        setData({
          status: 'ready',
          plan,
          recap,
          sets,
          cocktails: (cocktailsRes.data && cocktailsRes.data.cocktails) || [],
          mocktails: (mocktailsRes.data && mocktailsRes.data.mocktails) || [],
        });
        setShown(initial);
      } catch (err) {
        // Leave a trace: a deploy-window missing recap or a persistent 500
        // would otherwise show only as the panel's error line.
        console.error('[ClientAnswersPanel] load failed:', err && err.message);
        if (!cancelled) setData({ status: 'error' });
      }
    })();
    return () => { cancelled = true; };
  }, [planId, attempt]);

  const ready = data.status === 'ready';
  const shownSet = ready ? data.sets.find((s) => s.key === shown) : null;
  const note = ready
    ? listNote(shown, data.plan.shopping_list_source, data.sets.map((s) => s.key))
    : null;

  return (
    <aside className="sl-answers" aria-label="Client's answers" aria-busy={data.status === 'loading'} tabIndex={0}>
      <div className="sl-answers-head">
        <h3 className="sl-answers-title">Client's answers</h3>
        {ready && data.sets.length === 2 && (
          <div className="sl-answers-switch" role="group" aria-label="Which answers">
            {data.sets.map((s) => (
              <button
                key={s.key}
                type="button"
                className={shown === s.key ? 'sl-answers-seg is-on' : 'sl-answers-seg'}
                aria-pressed={shown === s.key}
                onClick={() => setShown(s.key)}
              >
                {switchLabel(s)}
              </button>
            ))}
          </div>
        )}
        {shownSet && <p className="sl-answers-source">{sourceLine(shownSet)}</p>}
        {note && <p className="sl-answers-note">{note}</p>}
      </div>
      <div className="sl-answers-body">
        {data.status === 'loading' && <p className="sl-answers-muted" role="status">Loading answers…</p>}
        {data.status === 'error' && (
          <div className="sl-answers-muted" role="status">
            <p>Couldn't load the client's answers.</p>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </button>
          </div>
        )}
        {ready && data.sets.length === 0 && (
          <p className="sl-answers-muted">No planner or consult answers yet.</p>
        )}
        {ready && shown === 'planner' && (
          <div className="sl-answers-planner">
            <DrinkPlanSelections plan={data.plan} cocktails={data.cocktails} mocktails={data.mocktails} listOnly />
          </div>
        )}
        {ready && shown === 'consult' && (
          <ul className="sl-answers-lines">
            {data.recap.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        )}
      </div>
    </aside>
  );
}

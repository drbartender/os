import React, { useEffect, useRef, useState } from 'react';
import api from '../../../utils/api';
import StatusChip from '../../../components/adminos/StatusChip';

// Potions · Packages · Makeability rail. Given a package, it shows every
// active recipe sorted into in-tier / fenced (+$/guest) / unmakeable /
// no-recipe, recomputed live. The engine (server coverageEngine) owns the
// verdict; this panel only displays it. Refetches on `version` bumps (any
// contents/slots save from PackageDetail), debounced so keystroke-fast edits
// coalesce into one request.
const STATUS = {
  covered: { kind: 'ok', group: 'In tier' },
  fenced: { kind: 'warn', group: 'Fenced add-on' },
  unmakeable: { kind: 'danger', group: 'Unmakeable' },
  no_recipe: { kind: 'neutral', group: 'No recipe yet' },
};
const ORDER = ['covered', 'fenced', 'unmakeable', 'no_recipe'];

function prettyClass(key) {
  return String(key || '').replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function chipLabel(drink) {
  if (drink.status === 'covered') return 'In tier';
  if (drink.status === 'fenced') {
    const per = Number(drink.gap_per_guest);
    return Number.isFinite(per) ? `+$${per.toFixed(2)}/g` : 'Fenced';
  }
  if (drink.status === 'unmakeable') return 'Unmakeable';
  return 'No recipe';
}

function detailText(drink) {
  if (drink.status === 'fenced') {
    const classes = (drink.gap_classes || []).map(prettyClass).filter(Boolean);
    return classes.length
      ? `${classes.join(', ')} priced through an add-on.`
      : 'Priced through an add-on.';
  }
  if (drink.status === 'unmakeable') {
    const miss = (drink.missing || []).map((m) => String(m).toLowerCase()).filter(Boolean);
    return miss.length
      ? `No ${miss.join(', ')} in this package, and no add-on covers it.`
      : 'A recipe ingredient does not resolve to package contents.';
  }
  if (drink.status === 'no_recipe') return 'Waiting on the recipe pass.';
  return null;
}

export default function MakeabilityPanel({ packageId, version = 0, hasItems = true, onOpenRecipe }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const firstRun = useRef(true);

  useEffect(() => {
    if (!packageId) return undefined;
    const controller = new AbortController();
    const delay = firstRun.current ? 0 : 400; // load at once; debounce saves
    firstRun.current = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await api.get(`/admin/packages/${packageId}/makeability`, { signal: controller.signal });
        setData(res.data);
        setError('');
      } catch (err) {
        if (!controller.signal.aborted) setError('Could not load the makeability preview.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, delay);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [packageId, version]);

  const counts = data?.counts || null;
  const drinks = data?.drinks || [];

  return (
    <div className="card pkg-rail">
      <div className="pkg-rail-head">
        <span className="pkg-rail-label">Makeability</span>
        {counts && hasItems && (
          <span className="pkg-mk-counts">
            <StatusChip kind="ok">{counts.covered} in tier</StatusChip>
            <StatusChip kind="warn">{counts.fenced} fenced</StatusChip>
            <StatusChip kind="danger">{counts.unmakeable} out</StatusChip>
          </span>
        )}
      </div>

      {error ? (
        <div className="pkg-rail-note text-muted">{error}</div>
      ) : loading && !data ? (
        <div className="pkg-rail-note text-muted">Computing coverage…</div>
      ) : !hasItems ? (
        <div className="pkg-rail-note text-muted">
          No contents yet, so nothing resolves. Add category pars and eligible bottles to see what this
          package can make.
        </div>
      ) : drinks.length === 0 ? (
        <div className="pkg-rail-note text-muted">No active recipes to classify yet.</div>
      ) : (
        <div className="pkg-mk-list scroll-thin">
          {ORDER.map((status) => {
            const group = drinks.filter((d) => d.status === status);
            if (group.length === 0) return null;
            return (
              <div key={status}>
                <div className="pkg-mk-group-label">{STATUS[status].group} · {group.length}</div>
                {group.map((drink) => (
                  <button
                    type="button"
                    key={`${drink.table}:${drink.id}`}
                    className="pkg-mk-row"
                    onClick={() => onOpenRecipe && onOpenRecipe(drink.id)}
                    title="Open recipe card"
                  >
                    <span className="pkg-mk-top">
                      <span className="pkg-mk-name">{drink.name}</span>
                      <StatusChip kind={STATUS[drink.status].kind}>{chipLabel(drink)}</StatusChip>
                    </span>
                    {detailText(drink) && <span className="pkg-mk-detail">{detailText(drink)}</span>}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}

      <div className="pkg-rail-foot text-muted">Recomputed live from recipes and contents. Tap a drink to open its recipe card.</div>
    </div>
  );
}

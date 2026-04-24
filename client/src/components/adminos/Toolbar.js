import React from 'react';
import Icon from './Icon';

/**
 * Shared list-page toolbar: segmented tabs + search input + filter slot + right slot.
 *
 * Props:
 *   search, setSearch               — search input (string + setter)
 *   tabs: [{ id, label, count? }]   — optional left-side tab bar
 *   tab, setTab                     — active tab id + setter
 *   filters                         — optional node rendered to the right of search
 *   right                           — optional node rendered at the far right
 */
export default function Toolbar({ search, setSearch, tabs, tab, setTab, filters, right }) {
  return (
    <div className="hstack" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
      {tabs && (
        <div className="seg">
          {tabs.map(t => (
            <button
              key={t.id}
              type="button"
              className={tab === t.id ? 'active' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.count != null && <span className="muted" style={{ marginLeft: 6 }}>{t.count}</span>}
            </button>
          ))}
        </div>
      )}
      {setSearch && (
        <div className="input-group" style={{ minWidth: 240, maxWidth: 340, flex: 1 }}>
          <Icon name="search" />
          <input
            placeholder="Search…"
            value={search || ''}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search"
          />
        </div>
      )}
      {filters}
      <div className="spacer" />
      {right}
    </div>
  );
}

import React from 'react';
import GlobalSearchButton from './GlobalSearchButton';

/**
 * Shared list-page toolbar: segmented tabs + global-search launcher + filter
 * slot + right slot. The launcher opens the Cmd/Ctrl+K palette — list pages
 * have no per-page text filter (find-one-thing goes through global search).
 *
 * Props:
 *   tabs: [{ id, label, count? }]   — optional left-side tab bar
 *   tab, setTab                     — active tab id + setter
 *   filters                         — optional node rendered to the right of search
 *   right                           — optional node rendered at the far right
 */
export default function Toolbar({ tabs, tab, setTab, filters, right }) {
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
      <GlobalSearchButton variant="toolbar" />
      {filters}
      <div className="spacer" />
      {right}
    </div>
  );
}

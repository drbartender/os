import React from 'react';
import Icon from './Icon';
import { usePalette } from '../../context/PaletteContext';

// The one search affordance: a search-bar-shaped button that opens the Cmd/Ctrl+K
// command palette. Rendered in the Header (chrome) and in the shared Toolbar
// (list pages). variant="toolbar" adds sizing that fills the Toolbar slot and
// opts back out of the coarse-pointer icon collapse.
export default function GlobalSearchButton({ variant = 'header' }) {
  const { openPalette } = usePalette();
  return (
    <button
      type="button"
      className={`header-search${variant === 'toolbar' ? ' gsearch-toolbar' : ''}`}
      onClick={openPalette}
      aria-label="Open command palette"
    >
      <Icon name="search" />
      <span>Search events, clients, proposals…</span>
      <span className="kbd-group">
        <span className="kbd">⌘</span><span className="kbd">K</span>
      </span>
    </button>
  );
}

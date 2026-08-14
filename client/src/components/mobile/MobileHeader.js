import React from 'react';
import Icon from '../adminos/Icon';
import { usePalette } from '../../context/PaletteContext';
import { useMobileView } from '../../context/MobileViewContext';

// Top bar of the phone chrome (benchmark composition): the ℞ brand chip on
// list screens, a back arrow instead on detail screens, title, global search
// (opens the existing command palette until the full-screen search screen
// lands), and the per-screen Desktop-view escape hatch (spec section 3).
// Benchmark details honored: the detail variant drops the search button, and
// the More screen drops the Desktop-view escape (More has no desktop
// counterpart; the toggle would just wrap this same list in the sidebar).
// The rich detail header (client · type, guests, venue) arrives with the
// screen lanes; this is the chrome-level variant. The title is deliberately
// NOT an h1: desktop pages rendering inside the chrome bring their own h1.
export default function MobileHeader({ title, screenKey, onBack = null }) {
  const { openPalette } = usePalette();
  const { setDesktopView } = useMobileView();
  return (
    <header className="m-header">
      {onBack ? (
        <button type="button" className="m-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="left" size={20} />
        </button>
      ) : (
        <span className="m-brandmark" aria-hidden="true">&#8478;</span>
      )}
      <span className="m-title">{title}</span>
      {!onBack && (
        <button
          type="button"
          className="m-iconbtn"
          onClick={openPalette}
          aria-label="Search"
        >
          <Icon name="search" size={20} />
        </button>
      )}
      {screenKey !== 'more' && (
        <button
          type="button"
          className="m-iconbtn"
          onClick={() => setDesktopView(screenKey, true)}
          aria-label="Switch to desktop view"
          title="Desktop view"
        >
          <Icon name="external" size={20} />
        </button>
      )}
    </header>
  );
}

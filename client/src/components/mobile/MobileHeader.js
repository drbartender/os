import React from 'react';
import Icon from '../adminos/Icon';
import { usePalette } from '../../context/PaletteContext';
import { useMobileView } from '../../context/MobileViewContext';

// Top bar of the phone chrome (benchmark composition): the brand chip on list
// screens, a back arrow instead on detail screens, title, global search
// (opens the existing command palette until the full-screen search screen
// lands), and the per-screen Desktop-view escape hatch (spec section 3).
// Benchmark details honored: the detail variant drops the search button, and
// the More screen drops the Desktop-view escape (More has no desktop
// counterpart; the toggle would just wrap this same list in the sidebar).
//
// `detail` is the rich header of a phone detail screen (client, kind, guests,
// venue as a map link). The screen hands it to the chrome through the outlet
// context once its read lands; until then, and on every screen that never
// sets one, the plain title shows.
//
// The plain title is deliberately NOT an h1: desktop pages rendering inside
// the chrome bring their own. The rich title IS an h1: the phone detail screen
// renders no other h1, and a page with none is a page a screen reader cannot
// name. Its wrappers are divs, because a span may not hold a heading.
//
// The kind has its own line under the client, and the venue reads like an
// envelope: the venue's name, then the street and the town, broken before the
// town only when the two do not fit on one line (Dallas, Pixel walk
// 2026-09-30). The comma between street and town is drawn by the stylesheet
// so that it disappears when the town moves down. The map icon trails the
// last piece. The spaces between pieces are for the link's accessible name;
// the layout ignores them.
function VenueLines({ detail }) {
  const icon = detail.mapHref ? <Icon name="external" size={12} /> : null;
  const place = detail.place;
  if (!place) return <span>{detail.venue}{icon}</span>;
  const last = place.locality ? 'town' : place.street ? 'street' : 'name';
  return (
    <>
      {place.name ? <span className="m-dhead-vname">{place.name}{last === 'name' ? icon : null}</span> : null}
      {place.name && (place.street || place.locality) ? ' ' : null}
      {place.street || place.locality ? (
        <span className="m-dhead-addr">
          {place.street ? <span className="m-dhead-street">{place.street}{last === 'street' ? icon : null}</span> : null}
          {place.street && place.locality ? ' ' : null}
          {place.locality ? (
            <span className={`m-dhead-town${place.street ? ' m-dhead-town-after' : ''}`}>{place.locality}{icon}</span>
          ) : null}
        </span>
      ) : null}
    </>
  );
}

export default function MobileHeader({ title, screenKey, onBack = null, detail = null }) {
  const { openPalette } = usePalette();
  const { setDesktopView } = useMobileView();
  return (
    <header className={`m-header${detail ? ' m-header-detail' : ''}`}>
      {/* Plain "Back": it returns wherever you came from (history), so naming a
          list would be wrong half the time (Dallas, 2026-09-30). */}
      {onBack ? (
        <button type="button" className="m-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="left" size={20} />
        </button>
      ) : (
        <span className="m-brandmark" aria-hidden="true">&#8478;</span>
      )}
      {detail ? (
        <div className="m-dhead">
          <div className="m-dhead-line">
            <h1 className="m-dhead-title">{detail.title}</h1>
            {detail.guests !== null && detail.guests !== undefined && (
              <span className="m-dhead-guests">{detail.guests} <small>GUESTS</small></span>
            )}
          </div>
          {detail.kind ? <div className="m-dhead-kind">{detail.kind}</div> : null}
          {detail.venue && detail.mapHref && (
            <a className="m-dhead-venue" href={detail.mapHref} target="_blank" rel="noopener noreferrer">
              <VenueLines detail={detail} />
            </a>
          )}
          {detail.venue && !detail.mapHref && (
            <span className="m-dhead-venue"><VenueLines detail={detail} /></span>
          )}
        </div>
      ) : (
        <span className="m-title">{title}</span>
      )}
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

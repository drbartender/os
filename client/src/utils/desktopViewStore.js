// Per-screen "Desktop view" overrides for the phone admin (spec section 3:
// the no-dead-ends escape hatch). localStorage-persisted so the choice is a
// real exit that survives reloads; keyed per screen so opting one surface out
// of the phone treatment does not opt out all of them. Cleared on logout by
// purgeMobileAdminState() (lane ma-b; spec section 7 purge rule).
//
// The store is IO only: MobileViewContext owns the in-memory map and merges
// changes itself, then persists the whole map here. (An earlier version
// rebuilt the map FROM storage on every write, which silently dropped other
// screens' overrides whenever storage was blocked, e.g. Safari private mode.)
const KEY = 'adminDesktopViewOverrides';

export function readOverrides() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (e) {
    return {};
  }
}

export function persistOverrides(map) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(map));
  } catch (e) {
    // Storage blocked or full: the in-memory toggle still works this
    // session, it just won't survive a reload.
  }
}

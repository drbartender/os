// Shared type measurement for the three tip surfaces.
//
// All three fit a bartender's name to a fixed box, and all three have to
// re-measure once the display face loads: measuring against the Georgia
// fallback picks a size that is wrong for IM Fell, which is how a name that
// "fits" ends up printed inside the trim margin.

import { useEffect, useState } from 'react';

// MUST match `--drb-font-display` in drb-tokens.css. Measuring a different
// stack than the one that renders is the same class of bug as measuring
// before the font loads.
export const DISPLAY_STACK = "'IM Fell English SC', 'IM Fell English', Georgia, serif";

// One shared measuring context across every surface; only the font string and
// the tracking vary per call.
//
// `tracking` is REQUIRED, and set here on acquire, because ctx.letterSpacing is
// sticky across a ctx.font assignment: a caller that sets only the font
// silently inherits whatever the last surface was tracked at. The sign is
// tracked and the card and phone are not, so that would be a real
// cross-surface measurement error. Taking it as an argument makes the
// invariant structural instead of a rule each caller has to remember.
let ctx = null;
export function measureContext(tracking) {
  if (typeof document === 'undefined') return null;
  if (!ctx) ctx = document.createElement('canvas').getContext('2d');
  ctx.letterSpacing = tracking;
  return ctx;
}

// The display type's tracking. Measuring WITHOUT it under-reports by ~3.2%, so
// a name that "fits" renders wider and spills past its box.
export const DISPLAY_TRACKING = '0.015em';

// Walk `steps` largest-first and return the first size that fits `maxWidth`.
// The last step is returned with wrap enabled: at that point there is no
// smaller size to try, and a name held on one line runs off both edges.
export function fitFontSize(text, steps, maxWidth, tracking = DISPLAY_TRACKING) {
  const m = measureContext(tracking);
  if (!m) return { size: steps[0], wrap: 'nowrap' };
  for (const size of steps) {
    m.font = `400 ${size}px ${DISPLAY_STACK}`;
    if (m.measureText(text).width <= maxWidth) return { size, wrap: 'nowrap' };
  }
  return { size: steps[steps.length - 1], wrap: 'normal' };
}

// Side-effect hook: returns nothing, bumps state once the display face is
// ready so the caller re-renders and re-measures.
export function useFontsReady() {
  const [, bump] = useState(0);
  useEffect(() => {
    if (typeof document === 'undefined' || !document.fonts?.load) return undefined;
    let cancelled = false;
    // `document.fonts.ready` only means "nothing pending" and can resolve
    // while our face is still unloaded. Asking for the face by name is the
    // precise trigger. Always bumps, even on a rejected load: re-measuring
    // against the fallback is what we already do, and skipping the bump would
    // strand the first measurement.
    const done = () => { if (!cancelled) bump((t) => t + 1); };
    document.fonts.load(`64px ${DISPLAY_STACK}`)
      .catch(() => {})
      .then(() => document.fonts.ready)
      .then(done, done);
    return () => { cancelled = true; };
  }, []);
}

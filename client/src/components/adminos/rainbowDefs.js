import React from 'react';

/**
 * Shared pride-palette SVG defs, lifted verbatim from the old AreaChart so the
 * `data-palette="rainbow"` treatment survives the chart rewrite. Render
 * <RainbowDefs/> INSIDE an <svg><defs>…</defs>; it emits four gradients + a mask:
 *   - gPrideLine     horizontal pride gradient for the hero stroke
 *   - gPrideArea     same gradient at 0.35 opacity for the hero area fill
 *   - gPrideAreaFade vertical white→transparent gradient (top opaque, bottom clear)
 *   - gPrideMask     applies the fade so the area fades downward
 *
 * The mask rect is `width="100%" height="100%"` (userSpaceOnUse) so it spans the
 * full SVG viewport regardless of the chart's dimensions — no props needed. The
 * old AreaChart sized the rect to its fixed 720x180; 100% reproduces that fade
 * for any chart size, which is why this module takes nothing.
 */
export function RainbowDefs() {
  return (
    <>
      <linearGradient id="gPrideLine" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0"    stopColor="#e40303" />
        <stop offset="0.2"  stopColor="#ff8c00" />
        <stop offset="0.4"  stopColor="#ffed00" />
        <stop offset="0.6"  stopColor="#008026" />
        <stop offset="0.8"  stopColor="#24408e" />
        <stop offset="1"    stopColor="#732982" />
      </linearGradient>
      <linearGradient id="gPrideArea" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0"    stopColor="#e40303" stopOpacity="0.35" />
        <stop offset="0.2"  stopColor="#ff8c00" stopOpacity="0.35" />
        <stop offset="0.4"  stopColor="#ffed00" stopOpacity="0.35" />
        <stop offset="0.6"  stopColor="#008026" stopOpacity="0.35" />
        <stop offset="0.8"  stopColor="#24408e" stopOpacity="0.35" />
        <stop offset="1"    stopColor="#732982" stopOpacity="0.35" />
      </linearGradient>
      <linearGradient id="gPrideAreaFade" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stopColor="#fff" stopOpacity="1" />
        <stop offset="1" stopColor="#fff" stopOpacity="0" />
      </linearGradient>
      <mask id="gPrideMask">
        <rect x="0" y="0" width="100%" height="100%" fill="url(#gPrideAreaFade)" />
      </mask>
    </>
  );
}

/**
 * Is the rainbow palette active? A plain read of the palette flag at render
 * time (what the old AreaChart did). Not subscribed to changes: a settings flip
 * in another tab will not repaint this one until its next render, which is
 * acceptable for a cosmetic palette per lane mb-b3.
 */
export function useIsRainbow() {
  return typeof document !== 'undefined'
    && document.documentElement.dataset.palette === 'rainbow';
}

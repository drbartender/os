// Shared behavior for `.mob-strip` horizontal nav strips (portal tabs, staff
// account nav). The CSS lives in index.css under "mob-strip". Pattern per the
// mobile-fixes spec: hidden scrollbar + right-edge fade cue + scroll-snap, with
// the active item centered on mount/deep-link.

export function scrollActiveIntoView(container, activeEl) {
  if (!container || !activeEl) return;
  activeEl.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'auto' });
}

// Toggles `.at-end` so the fade cue disappears once fully scrolled right.
// When the content fits without scrolling, the condition is true at rest, so
// no fade shows on strips that do not overflow. Returns a cleanup function.
export function wireStripFade(container) {
  if (!container) return () => {};
  const update = () => {
    const end = container.scrollLeft + container.clientWidth >= container.scrollWidth - 2;
    container.classList.toggle('at-end', end);
  };
  update();
  container.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  return () => {
    container.removeEventListener('scroll', update);
    window.removeEventListener('resize', update);
  };
}

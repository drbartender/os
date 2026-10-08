// For a moment after a phone sheet closes, an invisible layer over the whole
// screen takes any tap (design pass 2026-10-06, lane ma-e3b). Without it, the
// second tap of a double tap on the sheet's footer or scrim lands on whatever
// was beneath: the event detail, its header, or the tab bar under the footer.
// It is appended to the document's body, so it outlives the sheet that asked.
export function holdTaps(ms) {
  if (!(ms > 0) || typeof document === 'undefined' || !document.body) return;
  const guard = document.createElement('div');
  guard.className = 'm-tap-guard';
  guard.setAttribute('aria-hidden', 'true');
  document.body.appendChild(guard);
  setTimeout(() => guard.remove(), ms);
}

// Format an integer-cents amount as a human dollar string.
//
// Money in this codebase is always integer cents (no floats), per CLAUDE.md.
// This helper is the canonical client-side formatter for the staff portal Pay
// surfaces (PayoutDetail, PayPage, PayoutEventRow) and is intentionally
// generic so any future cents-display surface (tips, year-to-date, paystub
// summary, etc.) can adopt it without rolling its own.
//
// Output rules (mirroring the design source's $$/$$ neg helpers):
//   - Trims a trailing `.00` so whole-dollar amounts read `$45` not `$45.00`.
//     Anything with cents keeps two decimals: `$45.50`, `$1,234.56`.
//   - Thousands separator on the integer portion: `$1,234.56`.
//   - Negative cents render with a leading `-` (e.g. `-$19.36`) — chosen over
//     the accounting `($19.36)` form to match the design source ($$neg).
//   - Non-finite / null / undefined input → `$0` (defensive; the caller's
//     responsibility is to feed integer cents, but we don't crash the page).
//
// Named export only — no default — so misuse like `import formatMoney from …`
// fails fast at build time rather than silently importing `undefined`.
export function formatMoney(cents) {
  const safe = Number.isFinite(cents) ? Math.trunc(cents) : 0;
  const negative = safe < 0;
  const abs = Math.abs(safe);
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  // Hand-rolled thousands separator — avoids pulling in toLocaleString's
  // locale-dependent edges (some locales swap comma/period, which would
  // misrepresent money in mixed-locale browsers).
  const wholeStr = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = frac === 0
    ? `$${wholeStr}`
    : `$${wholeStr}.${String(frac).padStart(2, '0')}`;
  return negative ? `-${body}` : body;
}

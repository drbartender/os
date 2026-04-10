/**
 * Format a number as USD currency string.
 * e.g. fmt(1234.5) => "$1,234.50"
 */
export function fmt(n) {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

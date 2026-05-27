function parseMoneyCents(s) {
  if (s == null) return null;
  const cleaned = String(s).replace(/\$/g, '').replace(/,/g, '').trim();
  if (!cleaned) return null;
  const isNeg = cleaned.startsWith('-') || (cleaned.startsWith('(') && cleaned.endsWith(')'));
  const num = Number(cleaned.replace(/[()\-]/g, ''));
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100) * (isNeg ? -1 : 1);
}
module.exports = { parseMoneyCents };

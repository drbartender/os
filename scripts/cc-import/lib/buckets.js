const SKIP_PACKAGES = new Set([
  'Inventory',
  'MGM Events',
  'Bartending Services',
  'Victory Gardens Theater Final Reconciliation',
  'Theatrical Show Run',
]);

const SKIP_PATTERNS = [/MGM/i];

function isSkippedPackage(name) {
  if (!name) return false;
  if (SKIP_PACKAGES.has(name)) return true;
  return SKIP_PATTERNS.some(re => re.test(name));
}

/**
 * Classify a CC proposal row into one of 4 buckets per spec §5.
 * @param {{ status: string, eventDate: Date|null, packageName: string }} row
 * @param {Date} today UTC midnight reference
 * @returns {'A'|'B'|'C'|'D'}
 */
function classify({ status, eventDate, packageName }, today) {
  if (status === 'Confirmed' && isSkippedPackage(packageName)) return 'D';
  if (status !== 'Confirmed') return 'C';
  if (!eventDate) return 'C';
  return eventDate >= today ? 'A' : 'B';
}

module.exports = { SKIP_PACKAGES, SKIP_PATTERNS, isSkippedPackage, classify };

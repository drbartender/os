const PRIORITY_RANK = { p0: 0, p1: 1, p2: 2 };
const COVERAGE_THRESHOLD = 3;
const BUG_SATURATION_THRESHOLD = 2;

function applyHardFilters(missions, { areas, timeBudget, adminComfort, device, completedIds, openBugCounts }) {
  return missions.filter(m => {
    if (!areas.includes(m.area)) return false;
    if (m.estMinutes > timeBudget) return false;
    if (!m.device.includes(device)) return false;
    if (m.needsAdminComfort && adminComfort === 'skip') return false;
    if (completedIds.includes(m.id)) return false;
    if ((openBugCounts[m.id] || 0) >= BUG_SATURATION_THRESHOLD) return false;
    return true;
  });
}

function chooseTiers(allMissions, candidates, counts) {
  const allP0 = allMissions.filter(m => m.priority === 'p0');
  const allP0Saturated = allP0.length > 0 && allP0.every(m => (counts[m.id] || 0) >= COVERAGE_THRESHOLD);
  const testerHasUncompletedP0 = candidates.some(m => m.priority === 'p0');

  if (testerHasUncompletedP0 && !allP0Saturated)     return ['p0'];
  if (testerHasUncompletedP0 && allP0Saturated)      return ['p0', 'p1'];
  if (candidates.some(m => m.priority === 'p1'))     return ['p1', 'p2'];
  return ['p2'];
}

function sortMissions(arr, counts) {
  return [...arr].sort((a, b) => {
    const pa = PRIORITY_RANK[a.priority];
    const pb = PRIORITY_RANK[b.priority];
    if (pa !== pb) return pa - pb;
    const ca = counts[a.id] || 0;
    const cb = counts[b.id] || 0;
    if (ca !== cb) return ca - cb;
    return Math.random() - 0.5;
  });
}

function buildShortlist({ missions, areas, timeBudget, adminComfort, device, completedIds, counts, openBugCounts, limit = 6 }) {
  const candidates = applyHardFilters(missions, { areas, timeBudget, adminComfort, device, completedIds, openBugCounts });
  if (candidates.length === 0) return { missions: [], relaxed: false };

  const tiers = chooseTiers(missions, candidates, counts);
  const inTier = candidates.filter(m => tiers.includes(m.priority));
  const result = sortMissions(inTier, counts).slice(0, limit);

  if (result.length >= 3) return { missions: result, relaxed: false };

  // Widen the time budget and see if it adds in-tier missions. Only relax if
  // widening actually surfaces new options — never abandon the chosen tier
  // (that would surface p1/p2 to a tester who should be focused on p0).
  const widenedInTier = applyHardFilters(missions, {
    areas, timeBudget: Math.ceil(timeBudget * 1.5),
    adminComfort, device, completedIds, openBugCounts,
  }).filter(m => tiers.includes(m.priority));
  if (widenedInTier.length > inTier.length) {
    return { missions: sortMissions(widenedInTier, counts).slice(0, limit), relaxed: true };
  }
  return { missions: result, relaxed: false };
}

module.exports = { buildShortlist, COVERAGE_THRESHOLD, BUG_SATURATION_THRESHOLD };

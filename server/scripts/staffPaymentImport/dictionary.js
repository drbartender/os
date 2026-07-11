// Payee dictionary + cross-platform name clustering. Seeds people-clusters from
// the OS known-people export, CC contacts, and CC expense payees, and folds
// known cross-platform aliases into one cluster. resolve(name) → clusterKey|null.
//
// buildDictionary({ knownPeopleCsv, ccContactsCsv, ccExpensesCsv }) → dictionary
//   (each *Csv is a file path, or null/absent — a missing file is tolerated).
const { normalizeName } = require('./staging');
const { loadKnownPeople, loadContacts, loadExpenses } = require('./ccReports');

// Seed aliases discovered in the data (spec §7). Keys/values normalized on use;
// the review sheet can override any of these. src(normalized) → canonical(normalized).
const RAW_ALIASES = {
  'katie freyer': 'kaitlyn freyer',
  'chip weinke': 'vernon wienke',
  chip: 'vernon wienke',
  'chima anderson': 'chi anderson',
  'mgm bartending': 'marie mathews',
  'jenn gibson-whalen': 'jennifer gibson',
  'jen phanord': 'jennifer phanord',
  'nicole prowell': 'nicki prowell',
  'josh capleton': 'joshua capleton',
  'jamie lyn juarez': 'jamie juarez',
};

function buildAliases() {
  const m = new Map();
  for (const [src, tgt] of Object.entries(RAW_ALIASES)) {
    m.set(normalizeName(src), normalizeName(tgt));
  }
  return m;
}

function buildDictionary({ knownPeopleCsv, ccContactsCsv, ccExpensesCsv } = {}) {
  const aliases = buildAliases();
  const clusters = new Map();     // clusterKey → {clusterKey, names, emails, phones, osUserId, onboardingStatus, ccStaffTotals}
  const nameToCluster = new Map(); // normalizedName → clusterKey

  const canonical = (rawName) => {
    const n = normalizeName(rawName);
    if (!n) return null;
    return aliases.get(n) || n;
  };
  const ensure = (key) => {
    if (!clusters.has(key)) {
      clusters.set(key, {
        clusterKey: key, names: new Set(), emails: new Set(), phones: new Set(),
        osUserId: null, onboardingStatus: null, ccStaffTotals: 0,
      });
    }
    return clusters.get(key);
  };
  const addName = (rawName, key) => {
    const n = normalizeName(rawName);
    if (!n) return;
    ensure(key).names.add(rawName.trim());
    nameToCluster.set(n, key);
  };

  // Alias targets always exist as clusters, and alias sources index to them.
  for (const [src, tgt] of aliases.entries()) {
    ensure(tgt);
    nameToCluster.set(tgt, tgt);
    nameToCluster.set(src, tgt);
  }

  // 1) OS known people (authoritative: carries user id + onboarding status)
  for (const p of loadKnownPeople(knownPeopleCsv)) {
    const key = canonical(p.preferredName || p.name);
    if (!key) continue;
    const c = ensure(key);
    addName(p.preferredName || p.name, key);
    if (p.name) addName(p.name, key);
    if (p.email) c.emails.add(p.email.toLowerCase().trim());
    if (p.phone) c.phones.add(p.phone);
    if (p.userId) c.osUserId = p.userId;
    if (p.onboardingStatus) c.onboardingStatus = p.onboardingStatus;
  }

  // 2) CC contacts (email/phone seed)
  for (const c of loadContacts(ccContactsCsv)) {
    const key = canonical(c.name);
    if (!key) continue;
    const cl = ensure(key);
    addName(c.name, key);
    if (c.email) cl.emails.add(c.email.toLowerCase().trim());
    if (c.phone) cl.phones.add(c.phone);
  }

  // 3) CC expense payees (accumulate CC staff totals)
  for (const e of loadExpenses(ccExpensesCsv)) {
    const key = canonical(e.payee);
    if (!key) continue;
    const cl = ensure(key);
    addName(e.payee, key);
    if (e.amountCents) cl.ccStaffTotals += Math.abs(e.amountCents);
  }

  function resolve(rawName) {
    const n = normalizeName(rawName);
    if (!n) return null;
    if (nameToCluster.has(n)) return nameToCluster.get(n);
    const aliased = aliases.get(n);
    if (aliased && clusters.has(aliased)) return aliased;
    return null;
  }

  return {
    people: Array.from(clusters.values()).map((c) => ({
      clusterKey: c.clusterKey,
      names: Array.from(c.names),
      emails: Array.from(c.emails),
      phones: Array.from(c.phones),
      osUserId: c.osUserId,
      onboardingStatus: c.onboardingStatus,
      ccStaffTotals: c.ccStaffTotals,
    })),
    aliases,
    resolve,
    getCluster: (key) => clusters.get(key) || null,
  };
}

module.exports = { buildDictionary, RAW_ALIASES };

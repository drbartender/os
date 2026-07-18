// Warn-only heuristic flagging email domains one edit from a common TLD
// (.com/.net/.org) or a major mail provider. Not a format validator.
// Kept in sync manually with client/src/utils/emailValidation.js (same pattern as eventTypes.js ESM/CJS pair).

const LEGIT_TLDS = ['co', 'com', 'net', 'org', 'io', 'us', 'biz', 'info', 'edu', 'gov', 'me'];
const TYPO_TLD_TARGETS = ['com', 'net', 'org'];
const PROVIDERS = ['gmail', 'yahoo', 'hotmail', 'outlook', 'icloud', 'aol', 'comcast', 'proton', 'protonmail'];

// Optimal string alignment (Damerau-Levenshtein with adjacent transpositions),
// so transposed typos like 'gamil', 'cmo', and 'ocm' count as a single edit.
function editDistance(a, b) {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const d = [];
  for (let i = 0; i <= al; i += 1) d[i] = [i];
  for (let j = 0; j <= bl; j += 1) d[0][j] = j;
  for (let i = 1; i <= al; i += 1) {
    for (let j = 1; j <= bl; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[al][bl];
}

function checkEmailDomain(email) {
  const clean = { suspicious: false, reason: null, suggestion: null };
  if (typeof email !== 'string') return clean;
  const normalized = email.trim().toLowerCase();
  if (!normalized || normalized.indexOf('@') === -1) return clean;
  const domain = normalized.slice(normalized.lastIndexOf('@') + 1).trim();
  if (!domain || domain.indexOf('.') === -1) return clean;
  const labels = domain.split('.');
  const tld = labels[labels.length - 1];
  const secondLevel = labels[labels.length - 2];
  if (!tld || !secondLevel) return clean;

  // (a) TLD one edit from .com/.net/.org, unless it is itself a legit common TLD.
  const tldTarget = LEGIT_TLDS.includes(tld)
    ? null
    : TYPO_TLD_TARGETS.find((target) => editDistance(tld, target) === 1);
  if (tldTarget) {
    const base = labels.slice(0, -1).join('.');
    return {
      suspicious: true,
      reason: `'.${tld}' looks like a typo of '.${tldTarget}'`,
      suggestion: `${base}.${tldTarget}`,
    };
  }

  // (b) second-level name one edit from a major provider, but not exactly a provider.
  const providerMatch = PROVIDERS.includes(secondLevel)
    ? null
    : PROVIDERS.find((provider) => editDistance(secondLevel, provider) === 1);
  if (providerMatch) {
    return {
      suspicious: true,
      reason: `'${domain}' looks like a typo of '${providerMatch}.${tld}'`,
      suggestion: `${providerMatch}.${tld}`,
    };
  }

  return clean;
}

module.exports = { checkEmailDomain };

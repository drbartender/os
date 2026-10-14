// The last good list load (spec 4.7 and 10): when it landed and how many were
// waiting, for the error card's "Last good load 2:12 PM CT · 8 were waiting".
// Kept in memory and in localStorage; storage can be blocked (private
// windows, cleared site data), so every access is guarded and memory wins.
const KEY = 'drb.inbox.lastGood';
let memory = null;

export function rememberLastGood(waiting, atIso) {
  memory = { at: atIso, waiting: Number(waiting) || 0 };
  try { window.localStorage.setItem(KEY, JSON.stringify(memory)); } catch { /* memory still holds it */ }
}

export function readLastGood() {
  if (memory) return memory;
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) || 'null');
    if (v && typeof v.at === 'string' && Number.isFinite(Number(v.waiting))) return { at: v.at, waiting: Number(v.waiting) };
  } catch { /* unreadable: there is no last good load to show */ }
  return null;
}

// For tests: forget the in-memory copy (storage is the test's to clear).
export function resetLastGood() {
  memory = null;
}

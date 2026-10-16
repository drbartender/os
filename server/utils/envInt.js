// readEnvInt(name, fallback): one parse for every numeric menu-art setting
// (spec 2026-10-01 section 5.5, Env numbers): the daily caps, the image
// timeout and the stale age, read by both provider wrappers and the cap.
//
// The value must be a whole positive number written as plain digits ("60").
// Unset uses the fallback quietly, since that is the normal state. Blank,
// zero, negative, fractional or nonsense ("abc", "60abc", "1e3") also uses
// the fallback, with one console warning per name per process (the
// INBOX_AI_DAILY_CAP and LEAD_CALL_DAILY_CAP precedent), so a typo can never
// uncap a provider or zero a timeout.

const warned = new Set();

function readEnvInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const text = String(raw).trim();
  if (/^[0-9]+$/.test(text)) {
    const n = Number(text);
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  if (!warned.has(name)) {
    warned.add(name);
    // The value is left out on purpose: env lines are not the place to echo
    // whatever was pasted into a variable.
    console.warn(`[envInt] ${name} is not a positive whole number; using ${fallback}`);
  }
  return fallback;
}

function _resetWarningsForTest() {
  warned.clear();
}

module.exports = { readEnvInt, _resetWarningsForTest };

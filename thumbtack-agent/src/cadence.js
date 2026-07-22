// Pure cadence math for the agent's single loop (spec 2026-07-21 section 4.3).
// The loop ticks at the fast reply interval; the slower harvest poll piggybacks
// every Nth tick so its ~5-minute cadence survives the rework. Extracted pure
// (extract.js precedent): an off-by-one here silently drifts the harvest
// cadence and nothing else would catch it.

/**
 * How many fast ticks between harvest polls. Defaults (300000 / 25000) = 12.
 * Degenerate inputs collapse to 1 (harvest every tick) rather than 0/NaN,
 * which would either skip harvesting forever or throw in a modulo.
 */
function harvestTickEvery(harvestIntervalMs, replyIntervalMs) {
  const h = Number(harvestIntervalMs);
  const r = Number(replyIntervalMs);
  if (!Number.isFinite(h) || h <= 0 || !Number.isFinite(r) || r <= 0) return 1;
  return Math.max(1, Math.ceil(h / r));
}

/** Harvest on tick 0 (first pass after boot) and every Nth tick after. */
function isHarvestTick(tick, every) {
  if (!Number.isInteger(tick) || tick < 0) return false;
  if (!Number.isInteger(every) || every <= 1) return true;
  return tick % every === 0;
}

/**
 * UTC-midnight rollover for the daily counters. Mutates and returns the
 * counters object (the loop owns one instance for its lifetime).
 */
function rolloverDay(counters, utcDate) {
  if (utcDate !== counters.day) {
    counters.day = utcDate;
    counters.today = 0;
    counters.repliesToday = 0;
  }
  return counters;
}

function underCap(used, cap) {
  return Number.isFinite(cap) ? used < cap : true;
}

module.exports = { harvestTickEvery, isHarvestTick, rolloverDay, underCap };

const rateLimit = require('express-rate-limit');

const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const publicReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const signLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { error: 'Too many signing attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Drink-plan PUTs autosave every 30 seconds, so a normal client racks up ~30
// requests per 15-minute window. publicLimiter (max=20) was rate-limiting
// real workflows. Key by token so one client can't drown another's budget.
const drinkPlanWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 80,
  keyGenerator: (req) => req.params?.token || req.ip,
  message: { error: 'Too many save attempts. Please try again in a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Lab Rat seed endpoint mints real users + clients on every call AND returns
// a working credential (for the pre-hire-invitation recipe). Tight per-IP cap
// resists single-IP flooding; secondary global cap caps damage from a
// distributed attacker rotating IPs. Combined with the hourly cleanup
// scheduler (labratCleanup.js), the steady-state max-attacker damage is
// roughly the global limit, since older rows continuously evaporate.
const labratSeedLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 2,
  message: { error: 'Too many seed requests. Try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Global cap across all IPs — IP-rotating attacker still hits this ceiling.
const labratSeedGlobalLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  // Same key for every request so all IPs share the bucket.
  keyGenerator: () => 'labrat-seed-global',
  message: { error: 'Lab Rat seed is temporarily saturated. Try again later.' },
  standardHeaders: false,
  legacyHeaders: false,
});

// Lab Rat bug-report endpoint is unauthenticated and triggers an admin email
// with a user-controlled Reply-To. Tighter than publicLimiter so a botnet
// can't reflect spam through contact@drbartender.com. 10/hour per IP is
// generous for a real tester finishing a multi-mission session.
const labratFeedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { error: 'Too many feedback submissions. Try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { publicLimiter, publicReadLimiter, signLimiter, drinkPlanWriteLimiter, labratSeedLimiter, labratSeedGlobalLimiter, labratFeedbackLimiter };

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

module.exports = { publicLimiter, publicReadLimiter, signLimiter, drinkPlanWriteLimiter };

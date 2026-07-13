/**
 * Mount the QA / labrat harness — but ONLY outside production.
 *
 * routes/labrat.js `POST /seed` mints loginable, self-escalating accounts via
 * runSeedRecipe(). The mount in index.js was unconditional, so in production
 * this was a live account-minting + privilege-escalation endpoint (F3). Gating
 * the mount makes the entire /api/qa/* tree 404 in prod. NODE_ENV is read at
 * call time so both branches are unit-testable in a single process.
 *
 * @param {import('express').Express} app
 */
function mountQa(app) {
  if (process.env.NODE_ENV === 'production') return;
  app.use('/api/qa', require('../routes/labrat'));
}

module.exports = { mountQa };

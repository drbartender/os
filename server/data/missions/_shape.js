const VALID_AREAS = new Set(['customer', 'applicant', 'staff', 'admin', 'mobile', 'edge']);
const VALID_DIFFICULTY = new Set(['easy', 'medium', 'hard']);
const VALID_DEVICES = new Set(['desktop', 'mobile']);
const VALID_PRIORITY = new Set(['p0', 'p1', 'p2']);
const VALID_SEED_RECIPES = new Set([null, 'proposal-in-sent']);

function validateMission(m, fileLabel) {
  const errs = [];
  const fail = (msg) => errs.push(`${fileLabel}[${m.id || '?'}]: ${msg}`);
  if (!m.id || typeof m.id !== 'string' || !/^[a-z0-9-]+$/.test(m.id)) fail('id must be kebab-case string');
  if (!m.title) fail('title required');
  if (!m.blurb) fail('blurb required');
  if (!VALID_AREAS.has(m.area)) fail(`area must be one of ${[...VALID_AREAS].join(',')}`);
  if (!Number.isInteger(m.estMinutes) || m.estMinutes < 1 || m.estMinutes > 120) fail('estMinutes must be 1-120');
  if (!VALID_DIFFICULTY.has(m.difficulty)) fail('difficulty must be easy|medium|hard');
  if (!Array.isArray(m.device) || !m.device.length || !m.device.every(d => VALID_DEVICES.has(d))) fail('device must be non-empty subset');
  if (typeof m.needsAdminComfort !== 'boolean') fail('needsAdminComfort must be boolean');
  if (!VALID_PRIORITY.has(m.priority)) fail('priority must be p0|p1|p2');
  if (!VALID_SEED_RECIPES.has(m.seedRecipe)) fail('seedRecipe must be null or known recipe id');
  if (!Array.isArray(m.steps) || m.steps.length < 1) fail('steps must be non-empty array');
  for (const [i, s] of (m.steps || []).entries()) {
    if (!s.text) fail(`steps[${i}].text required`);
    if (!s.expect) fail(`steps[${i}].expect required`);
  }
  if (!m.successMessage) fail('successMessage required');
  return errs;
}

module.exports = { validateMission };

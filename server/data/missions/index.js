const { validateMission } = require('./_shape');

const allMissions = [
  ...require('./customer'),
  ...require('./applicant'),
  ...require('./staff'),
  ...require('./admin'),
  ...require('./mobile'),
  ...require('./edge'),
];

const errors = [];
const seen = new Set();
for (const m of allMissions) {
  errors.push(...validateMission(m, m.area || 'unknown'));
  if (seen.has(m.id)) errors.push(`duplicate id: ${m.id}`);
  seen.add(m.id);
}
if (errors.length) throw new Error('Invalid mission catalog:\n  ' + errors.join('\n  '));

const byId = Object.freeze(Object.fromEntries(allMissions.map(m => [m.id, Object.freeze(m)])));
module.exports = { all: Object.freeze(allMissions), byId };

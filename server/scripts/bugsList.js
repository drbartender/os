// server/scripts/bugsList.js
const { readAllBugs } = require('../utils/bugLog');

async function main() {
  const args = process.argv.slice(2);
  const flag = (k) => {
    const f = args.find(a => a.startsWith(`--${k}=`));
    return f ? f.split('=').slice(1).join('=') : null;
  };
  const missionFilter = flag('mission');
  const statusFilter = flag('status') || 'open';

  const bugs = await readAllBugs({
    status: statusFilter === 'all' ? 'all' : statusFilter,
    missionId: missionFilter || undefined,
  });

  if (!bugs.length) {
    console.log(`No bugs matching status=${statusFilter}${missionFilter ? ` mission=${missionFilter}` : ''}.`);
    return;
  }

  const byMission = new Map();
  for (const b of bugs) {
    const k = b.missionId || '(no mission)';
    if (!byMission.has(k)) byMission.set(k, []);
    byMission.get(k).push(b);
  }

  for (const [mission, list] of byMission) {
    console.log(`\n## ${mission} (${list.length})`);
    for (const b of list) {
      console.log(`  ${b.id}  ${b.kind}  by ${b.testerName || 'anon'}  ${b.reportedAt}  [${b.status}]`);
      if (b.where)        console.log(`    where:    ${b.where}`);
      if (b.didWhat)      console.log(`    did:      ${b.didWhat}`);
      if (b.happened)     console.log(`    happened: ${b.happened}`);
      if (b.expected)     console.log(`    expected: ${b.expected}`);
      if (b.fixCommitSha) console.log(`    fix:      ${b.fixCommitSha}`);
      if (b.notes)        console.log(`    notes:    ${b.notes}`);
    }
  }
  console.log(`\n${bugs.length} bug${bugs.length === 1 ? '' : 's'} total.`);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });

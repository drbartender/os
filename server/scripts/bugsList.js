// server/scripts/bugsList.js
const { listOpenBugs, readAllBugs, readStatus } = require('../utils/bugLog');

async function main() {
  const args = process.argv.slice(2);
  const flag = (k) => {
    const f = args.find(a => a.startsWith(`--${k}=`));
    return f ? f.split('=').slice(1).join('=') : null;
  };
  const missionFilter = flag('mission');
  const statusFilter = flag('status') || 'open';

  let bugs;
  if (statusFilter === 'open') {
    bugs = await listOpenBugs();
  } else {
    const [all, status] = await Promise.all([readAllBugs(), readStatus()]);
    bugs = all.filter(b => (status[b.id]?.status || 'open') === statusFilter);
  }
  if (missionFilter) bugs = bugs.filter(b => b.missionId === missionFilter);

  if (!bugs.length) {
    console.log(`No bugs matching status=${statusFilter}${missionFilter ? ` mission=${missionFilter}` : ''}.`);
    return;
  }

  const byMission = bugs.reduce((acc, b) => {
    const k = b.missionId || '(no mission)';
    (acc[k] = acc[k] || []).push(b);
    return acc;
  }, {});

  for (const [mission, list] of Object.entries(byMission)) {
    console.log(`\n## ${mission} (${list.length})`);
    for (const b of list) {
      console.log(`  ${b.id}  ${b.kind}  by ${b.testerName || 'anon'}  ${b.reportedAt}`);
      if (b.where)    console.log(`    where:    ${b.where}`);
      if (b.didWhat)  console.log(`    did:      ${b.didWhat}`);
      if (b.happened) console.log(`    happened: ${b.happened}`);
      if (b.expected) console.log(`    expected: ${b.expected}`);
    }
  }
  console.log(`\n${bugs.length} bug${bugs.length === 1 ? '' : 's'} total.`);
}

main().catch(err => { console.error(err); process.exit(1); });

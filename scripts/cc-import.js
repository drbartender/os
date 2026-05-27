require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { parseArgs, CC_DIR } = require('./cc-import/lib/cli');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Using CC_DIR = ${CC_DIR}`);
  if (!fs.existsSync(CC_DIR)) {
    console.error(`CC_DIR does not exist: ${CC_DIR}. Set process.env.CC_DIR before running.`);
    process.exit(2);
  }
  const phases = args.all ? [0,1,2,3,4,5,6] : (args.phase != null ? [args.phase] : []);
  if (phases.length === 0) {
    console.error('Usage: node scripts/cc-import.js --phase=N | --all');
    process.exit(2);
  }
  for (const p of phases) {
    // Phase modules are created in Tasks 11-17; until then, this entry crashes with
    // 'Cannot find module' — intentionally non-functional until the phases ship.
    const phaseMod = require(`./cc-import/phases/phase${p}`);
    console.log(`\n=== Phase ${p} starting ===`);
    await phaseMod.run({ ...args, ccDir: CC_DIR });
    console.log(`=== Phase ${p} complete ===`);
  }
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });

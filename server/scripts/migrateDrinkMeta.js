// One-time migration: fold the hardcoded client drink metadata into the DB
// so the recipe card becomes the single source of truth (potion planner v2,
// plan lane pp2-core task 4).
//
//   client/src/pages/plan/data/drinkUpgrades.js  -> cocktails/mocktails.enhancements
//   client/src/data/syrups.js DRINK_SYRUP_MAP    -> cocktails/mocktails.syrup_id
//
// Usage (from server/):
//   node -r dotenv/config scripts/migrateDrinkMeta.js --dry-run   # print, no writes
//   node -r dotenv/config scripts/migrateDrinkMeta.js             # write
//   node -r dotenv/config scripts/migrateDrinkMeta.js --force     # overwrite non-empty
//
// Idempotence: by default a drink whose enhancements are already non-empty or
// whose syrup_id is set is SKIPPED (an admin edit in the recipe drawer must
// never be clobbered by a re-run); --force overrides. The source files stay in
// the repo until the legacy wizard drains (plan: out-of-scope deletions).
//
// The client files are ESM (`export const`); this CJS script extracts them by
// stripping the export keyword and evaluating in a bare vm sandbox. Data-only
// files, no imports — verified before eval by refusing any `import ` line.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pool } = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

function loadEsmData(relPath, wanted) {
  const abs = path.join(__dirname, '..', '..', relPath);
  const source = fs.readFileSync(abs, 'utf8');
  if (/^import /m.test(source)) {
    throw new Error(`${relPath} contains import statements; refusing to eval.`);
  }
  const script = `${source.replace(/^export /gm, '')}\n;__collect({ ${wanted.join(', ')} });`;
  const collected = {};
  vm.runInNewContext(script, { __collect: (obj) => Object.assign(collected, obj) }, { timeout: 5000 });
  return collected;
}

async function main() {
  const { DRINK_UPGRADES } = loadEsmData('client/src/pages/plan/data/drinkUpgrades.js', ['DRINK_UPGRADES']);
  const { DRINK_SYRUP_MAP } = loadEsmData('client/src/data/syrups.js', ['DRINK_SYRUP_MAP']);

  // drink id -> enhancements rows
  const enhancementsByDrink = new Map();
  for (const upgrade of DRINK_UPGRADES) {
    for (const drinkId of upgrade.applicableDrinks || []) {
      if (!enhancementsByDrink.has(drinkId)) enhancementsByDrink.set(drinkId, []);
      const row = {
        slug: upgrade.addonSlug,
        pitch: (upgrade.perDrinkPitch && upgrade.perDrinkPitch[drinkId]) || upgrade.defaultPitch || '',
      };
      const flavors = upgrade.bubbleFlavors && upgrade.bubbleFlavors[drinkId];
      if (Array.isArray(flavors) && flavors.length > 0) row.flavors = flavors;
      enhancementsByDrink.get(drinkId).push(row);
    }
  }

  // drink id -> single linked syrup (featured first, else first recommended).
  // The per-drink variant matrix retires under variants-are-drinks (spec §2);
  // the recipe pass curates anything this heuristic gets wrong.
  const syrupByDrink = new Map();
  for (const [drinkId, mapping] of Object.entries(DRINK_SYRUP_MAP)) {
    const pick = (Array.isArray(mapping.featured) && mapping.featured[0])
      || (Array.isArray(mapping.syrups) && mapping.syrups[0])
      || null;
    if (pick) syrupByDrink.set(drinkId, pick);
  }

  const allDrinkIds = [...new Set([...enhancementsByDrink.keys(), ...syrupByDrink.keys()])].sort();
  const summary = { updated: 0, skipped: 0, missing: 0 };

  for (const drinkId of allDrinkIds) {
    // A drink id lives in exactly one of the two tables; try both.
    let table = null;
    let current = null;
    for (const candidate of ['cocktails', 'mocktails']) {
      const found = await pool.query(
        `SELECT id, enhancements, syrup_id FROM ${candidate} WHERE id = $1`, [drinkId]
      );
      if (found.rows[0]) { table = candidate; current = found.rows[0]; break; }
    }
    if (!table) {
      summary.missing += 1;
      console.warn(`  MISSING  ${drinkId} (in neither cocktails nor mocktails)`);
      continue;
    }

    const hasExisting = (Array.isArray(current.enhancements) && current.enhancements.length > 0)
      || current.syrup_id;
    if (hasExisting && !FORCE) {
      summary.skipped += 1;
      console.log(`  skip     ${table}/${drinkId} (already has dossier data; use --force to overwrite)`);
      continue;
    }

    const enhancements = enhancementsByDrink.get(drinkId) || [];
    const syrupId = syrupByDrink.get(drinkId) || null;
    console.log(`  ${DRY_RUN ? 'would set' : 'set'}  ${table}/${drinkId}: ${enhancements.length} enhancement(s)${syrupId ? `, syrup ${syrupId}` : ''}`);
    if (!DRY_RUN) {
      await pool.query(
        `UPDATE ${table} SET enhancements = $1::jsonb, syrup_id = $2 WHERE id = $3`,
        [JSON.stringify(enhancements), syrupId, drinkId]
      );
    }
    summary.updated += 1;
  }

  console.log(`\n${DRY_RUN ? '[dry run] ' : ''}updated ${summary.updated}, skipped ${summary.skipped}, missing ${summary.missing}`);
}

main()
  .then(() => pool.end())
  .catch((err) => { console.error(err); pool.end(); process.exit(1); });

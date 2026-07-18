// One-time lineup application: writes the owner-decided 2026-07-18 package
// lineup (spec §5) into the DB as CONTENT — service_packages flags/slots,
// package_items contents rows (category pars with split-par eligible bottles),
// missing branded par_items, and the ingredient_class_addons gap-pricing map.
//
// This is NOT in the boot path. schema.sql owns STRUCTURE (tables/columns) and
// seeds packages with ON CONFLICT DO NOTHING; the admin dashboard is the source
// of truth for CONTENT after seed. A re-running boot UPDATE would clobber admin
// edits, so the decided lineup lands here, run deliberately (dev, then prod).
//
// Usage (from server/):
//   node -r dotenv/config scripts/applyPackageLineup2026.js --dry-run  # print, no writes
//   node -r dotenv/config scripts/applyPackageLineup2026.js            # write
//
// Rollback: every run snapshots prior state (affected service_packages rows,
// their package_items, ingredient_class_addons, and which branded par ids it
// created) to scripts/lineup-snapshot-<ts>.json BEFORE any write. git revert
// cannot undo prod data; restore from the snapshot instead.
//
// Idempotence: branded par_items upsert ON CONFLICT (id) DO NOTHING (never
// clobber an admin-edited row); ingredient_class_addons ON CONFLICT DO UPDATE;
// package_items are replaced per package (DELETE then INSERT the decided rows),
// so a re-run converges on the same final state. Run this BEFORE Dallas's
// package-editor data-entry pass — it resets the nine hosted packages' contents
// to the decided lineup.
//
// Spec:  docs/superpowers/specs/2026-07-18-potion-planner-v2-design.md §5
// Plan:  docs/superpowers/plans/2026-07-18-potion-planner-v2.md (lane pp2-lineup)

const fs = require('node:fs');
const path = require('node:path');
const { pool } = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');

// ─── Canonical par rows (recipe-resolvable anchors) ────────────────────────
// Recipes reference GENERIC names ("vodka", "bourbon", "lime juice") that
// resolveIngredient() maps to these canonical rows. Every package that stocks a
// category must include its canonical row in eligible_item_ids or coverage
// misses ("vodka" would resolve to titos-vodka and, absent it, read unmakeable).
// Branded rows below carry ONLY brand aliases (never "vodka"), so they never
// hijack generic resolution or overwrite spiritPars (spirit_key stays null).
const C = {
  vodka: 'titos-vodka',
  gin: 'tanqueray-gin',
  rum: 'bacardi-rum',
  bourbon: 'bulleit-bourbon',
  tequila: '1800-blanco-tequila',
  scotch: 'scotch-whiskey',
  red: 'cabernet-sauvignon',
  red2: 'pinot-noir',
  white: 'sauvignon-blanc',
  white2: 'moscato',
  sparkling: 'champagne',
  michelob: 'michelob-ultra',
  yuengling: 'yuengling',
  craft: 'local-craft-beer',
  seltzer: 'white-claw-variety',
};

// ─── Branded par rows to CREATE where missing ──────────────────────────────
// section=liquorBeerWine, spirit_key=NULL (never touch consult spiritPars),
// style_key=NULL (never touch the consult beer/wine style pickers),
// in_full_bar=false (BYOB generator's PARS_100 baseline is untouched),
// is_active=true. qty_per_100 is a display default only (package_items.par_per_100
// drives coverage + margin); set to a representative value.
const BRANDED_PARS = [
  { id: 'svedka-vodka',            item: 'Svedka Vodka',            size: '1.75L', qty: 5, role: 'spirit', aliases: ['svedka'] },
  { id: 'new-amsterdam-gin',       item: 'New Amsterdam Gin',       size: '1.75L', qty: 1, role: 'spirit', aliases: ['new amsterdam'] },
  { id: 'jim-beam-bourbon',        item: 'Jim Beam Bourbon',        size: '1.75L', qty: 4, role: 'spirit', aliases: ['jim beam'] },
  { id: 'margaritaville-tequila',  item: 'Margaritaville Tequila',  size: '1.75L', qty: 4, role: 'spirit', aliases: ['margaritaville'] },
  { id: 'bombay-sapphire-gin',     item: 'Bombay Sapphire Gin',     size: '1.75L', qty: 1, role: 'spirit', aliases: ['bombay sapphire', 'bombay'] },
  { id: 'grey-goose-vodka',        item: 'Grey Goose Vodka',        size: '1.75L', qty: 3, role: 'spirit', aliases: ['grey goose'] },
  { id: 'hendricks-gin',           item: "Hendrick's Gin",          size: '1.75L', qty: 1, role: 'spirit', aliases: ['hendricks', 'hendrick s', 'hendricks gin'] },
  { id: 'appleton-estate-rum',     item: 'Appleton Estate Rum',     size: '1.75L', qty: 2, role: 'spirit', aliases: ['appleton', 'appleton estate'] },
  { id: 'casamigos-tequila',       item: 'Casamigos Tequila',       size: '1.75L', qty: 4, role: 'spirit', aliases: ['casamigos'] },
  { id: 'makers-mark',             item: "Maker's Mark Bourbon",    size: '1.75L', qty: 4, role: 'spirit', aliases: ['makers mark', 'maker s mark'] },
  { id: 'milagro-reposado-tequila', item: 'Milagro Reposado Tequila', size: '1.75L', qty: 4, role: 'spirit', aliases: ['milagro', 'milagro reposado'] },
  { id: 'jameson-irish-whiskey',   item: 'Jameson Irish Whiskey',   size: '1.75L', qty: 2, role: 'spirit', aliases: ['jameson', 'irish whiskey'] },
  { id: 'monkey-shoulder-scotch',  item: 'Monkey Shoulder Scotch',  size: '1.75L', qty: 2, role: 'spirit', aliases: ['monkey shoulder'] },
  { id: 'miller-lite',             item: 'Miller Lite',             size: '24pk',  qty: 3, role: 'beer',   aliases: ['miller lite', 'miller'] },
  { id: 'stella-artois',           item: 'Stella Artois',           size: '24pk',  qty: 3, role: 'beer',   aliases: ['stella', 'stella artois'] },
];

// ─── ingredient_class_addons gap-pricing map ───────────────────────────────
// class_key -> service_addons.slug. Only classes whose gap maps to a REAL,
// EXISTING addon slug (verified at write time; unknown slugs are skipped and
// reported, never invented). classCandidates() derives keys from the resolved
// par row's spirit_key / display-name and the raw ingredient name, so map BOTH
// the par id (hyphens) and the display-name key (underscores) for each row.
const CLASS_ADDONS = {
  // ginger BEER (mules) — gap everywhere except Grand; house-made addon prices it
  'ginger-beer': 'house-made-ginger-beer',
  'ginger_beer': 'house-made-ginger-beer',
  // mezcal
  'mezcal': 'specialty-mezcal',
  // cognac (no par row; name-only class)
  'cognac': 'specialty-cognac',
  // bitter aperitifs: Campari, Aperol, Cynar, amaro
  'campari': 'specialty-bitter-aperitifs',
  'aperol': 'specialty-bitter-aperitifs',
  'amaro': 'specialty-bitter-aperitifs',
  'amaro-nonino': 'specialty-bitter-aperitifs',
  'amaro_nonino': 'specialty-bitter-aperitifs',
  'averna': 'specialty-bitter-aperitifs',
  // vermouth & fortified: sweet/dry vermouth, Lillet
  'sweet-vermouth': 'specialty-vermouths',
  'sweet_vermouth': 'specialty-vermouths',
  'dry-vermouth': 'specialty-vermouths',
  'dry_vermouth': 'specialty-vermouths',
  'vermouth': 'specialty-vermouths',
  'lillet': 'specialty-vermouths',
  'lillet-blanc': 'specialty-vermouths',
  'lillet_blanc': 'specialty-vermouths',
  // niche liqueurs: Cointreau/triple sec, maraschino, amaretto, orgeat,
  // absinthe, rye whiskey, coffee liqueur
  'triple-sec': 'specialty-niche-liqueurs',
  'triple_sec': 'specialty-niche-liqueurs',
  'cointreau': 'specialty-niche-liqueurs',
  'maraschino': 'specialty-niche-liqueurs',
  'maraschino-liqueur': 'specialty-niche-liqueurs',
  'maraschino_liqueur': 'specialty-niche-liqueurs',
  'amaretto': 'specialty-niche-liqueurs',
  'orgeat': 'specialty-niche-liqueurs',
  'absinthe': 'specialty-niche-liqueurs',
  'rye': 'specialty-niche-liqueurs',
  'rye-whiskey': 'specialty-niche-liqueurs',
  'rye_whiskey': 'specialty-niche-liqueurs',
  'coffee-liqueur': 'specialty-niche-liqueurs',
  'coffee_liqueur': 'specialty-niche-liqueurs',
  'kahlua': 'specialty-niche-liqueurs',
};

// Standard cocktail garnish set for open bars (coverage: citrus + cherries).
const GARNISH = ['limes', 'lemons', 'oranges', 'premium-cherries'];

// ─── The decided lineup (spec §5) ──────────────────────────────────────────
// Each package: optional slots, plus package_items rows. eligible pairs the
// canonical anchor (coverage) with the branded actual bottle(s) (identity +
// per-tier margin, once par costs are entered).
const LINEUP = {
  // Base Compound: budget anchor. 2 HARD signature slots ARE the bar — no open
  // spirits, no mixers. Beer + 1 red + 1 white only.
  'the-base-compound': {
    slots: { count: 2, kind: 'hard' },
    items: [
      { category: 'Miller Lite',   par: 3, unit: '24pk', eligible: ['miller-lite'] },
      { category: 'Michelob Ultra', par: 3, unit: '24pk', eligible: [C.michelob] },
      { category: 'Red Wine',      par: 6, unit: 'btl',  eligible: [C.red] },
      { category: 'White Wine',    par: 6, unit: 'btl',  eligible: [C.white] },
    ],
  },

  // Midrange Reaction: 5 spirits (scotch OUT), +bitters +simple, NO ginger ale.
  'the-midrange-reaction': {
    items: [
      { category: 'Vodka',   par: 5, unit: 'btl', eligible: [C.vodka, 'svedka-vodka'] },
      { category: 'Gin',     par: 1, unit: 'btl', eligible: [C.gin, 'new-amsterdam-gin'] },
      { category: 'Rum',     par: 2, unit: 'btl', eligible: [C.rum] },
      { category: 'Bourbon', par: 4, unit: 'btl', eligible: [C.bourbon, 'jim-beam-bourbon'] },
      { category: 'Tequila', par: 4, unit: 'btl', eligible: [C.tequila, 'margaritaville-tequila'] },
      { category: 'Miller Lite',   par: 2, unit: '24pk', eligible: ['miller-lite'] },
      { category: 'Michelob Ultra', par: 3, unit: '24pk', eligible: [C.michelob] },
      { category: 'Red Wine',   par: 6, unit: 'btl', eligible: [C.red] },
      { category: 'White Wine', par: 6, unit: 'btl', eligible: [C.white] },
      { category: 'Sodas',      par: 4, unit: 'unit', eligible: ['coca-cola', 'diet-coke', 'sprite'] },
      { category: 'Soda Water & Tonic', par: 6, unit: 'unit', eligible: ['club-soda', 'tonic-water'] },
      { category: 'Juices',     par: 5, unit: 'unit', eligible: ['cranberry-juice', 'orange-juice', 'pineapple-juice'] },
      { category: 'Bar Modifiers', par: 2, unit: 'unit', eligible: ['simple-syrup', 'angostura-bitters'] },
      { category: 'Garnishes',  par: 6, unit: 'unit', eligible: GARNISH },
    ],
  },

  // Enhanced Solution: JW Red + scotch OUT (5 spirits), NO ginger ale, wine
  // slims to 1 red + 1 white, sparkling stays. +lemon/+lime juice.
  'the-enhanced-solution': {
    items: [
      { category: 'Vodka',   par: 5, unit: 'btl', eligible: [C.vodka] },
      { category: 'Gin',     par: 1, unit: 'btl', eligible: [C.gin, 'bombay-sapphire-gin'] },
      { category: 'Rum',     par: 2, unit: 'btl', eligible: [C.rum] },
      { category: 'Bourbon', par: 4, unit: 'btl', eligible: [C.bourbon, 'jim-beam-bourbon'] },
      { category: 'Tequila', par: 4, unit: 'btl', eligible: [C.tequila] },
      { category: 'Yuengling',     par: 2, unit: '24pk', eligible: [C.yuengling] },
      { category: 'Miller Lite',   par: 2, unit: '24pk', eligible: ['miller-lite'] },
      { category: 'Michelob Ultra', par: 3, unit: '24pk', eligible: [C.michelob] },
      { category: 'Red Wine',   par: 6, unit: 'btl', eligible: [C.red] },
      { category: 'White Wine', par: 6, unit: 'btl', eligible: [C.white] },
      { category: 'Sparkling',  par: 6, unit: 'btl', eligible: [C.sparkling] },
      { category: 'Sodas',      par: 4, unit: 'unit', eligible: ['coca-cola', 'diet-coke', 'sprite'] },
      { category: 'Club Soda & Tonic', par: 6, unit: 'unit', eligible: ['club-soda', 'tonic-water'] },
      { category: 'Juices',     par: 6, unit: 'unit', eligible: ['orange-juice', 'cranberry-juice', 'pineapple-juice', 'lemon-juice', 'lime-juice-unsweet'] },
      { category: 'Bar Modifiers', par: 2, unit: 'unit', eligible: ['simple-syrup', 'angostura-bitters'] },
      { category: 'Garnishes',  par: 6, unit: 'unit', eligible: GARNISH },
    ],
  },

  // Formula No. 5: 5 spirits, +lemon/+lime (margaritas legal), Bulleit stays,
  // NO sparkling, NO ginger ale (EXTRAPOLATED purge — see report flag).
  'formula-no-5': {
    items: [
      { category: 'Vodka',   par: 2, unit: 'btl', eligible: [C.vodka, 'grey-goose-vodka'] },
      { category: 'Gin',     par: 1, unit: 'btl', eligible: [C.gin, 'hendricks-gin'] },
      { category: 'Rum',     par: 2, unit: 'btl', eligible: [C.rum, 'appleton-estate-rum'] },
      { category: 'Tequila', par: 4, unit: 'btl', eligible: [C.tequila, 'casamigos-tequila'] },
      { category: 'Bourbon', par: 4, unit: 'btl', eligible: [C.bourbon] },
      { category: 'Stella Artois', par: 3, unit: '24pk', eligible: ['stella-artois'] },
      { category: 'Red Wine',   par: 6, unit: 'btl', eligible: [C.red] },
      { category: 'White Wine', par: 6, unit: 'btl', eligible: [C.white] },
      { category: 'Sodas',      par: 4, unit: 'unit', eligible: ['coca-cola', 'diet-coke', 'sprite'] },
      { category: 'Soda Water & Tonic', par: 6, unit: 'unit', eligible: ['club-soda', 'tonic-water'] },
      { category: 'Juices',     par: 6, unit: 'unit', eligible: ['orange-juice', 'cranberry-juice', 'pineapple-juice', 'lemon-juice', 'lime-juice-unsweet'] },
      { category: 'Bar Modifiers', par: 2, unit: 'unit', eligible: ['simple-syrup', 'angostura-bitters'] },
      { category: 'Garnishes',  par: 6, unit: 'unit', eligible: GARNISH },
    ],
  },

  // Grand Experiment: the showpiece. Split pars (category volume shared across
  // labels). Maker's replaces Bulleit; both vodkas, both tequilas; Jameson +
  // Monkey Shoulder (scotch lives ONLY here); 2 premium red + 2 premium white +
  // sparkling; craft rotation; ginger BEER stays (exempt from the ginger-ale purge).
  'the-grand-experiment': {
    items: [
      { category: 'Vodka',   par: 5, unit: 'btl', eligible: [C.vodka, 'grey-goose-vodka'] },
      { category: 'Gin',     par: 1, unit: 'btl', eligible: [C.gin, 'hendricks-gin'] },
      { category: 'Rum',     par: 2, unit: 'btl', eligible: [C.rum, 'appleton-estate-rum'] },
      { category: 'Tequila', par: 4, unit: 'btl', eligible: [C.tequila, 'casamigos-tequila', 'milagro-reposado-tequila'] },
      { category: 'Bourbon', par: 4, unit: 'btl', eligible: [C.bourbon, 'makers-mark'] },
      { category: 'Irish & Scotch', par: 2, unit: 'btl', eligible: [C.scotch, 'jameson-irish-whiskey', 'monkey-shoulder-scotch'] },
      { category: 'Michelob Ultra', par: 3, unit: '24pk', eligible: [C.michelob] },
      { category: 'Miller Lite',    par: 2, unit: '24pk', eligible: ['miller-lite'] },
      { category: 'Stella Artois',  par: 3, unit: '24pk', eligible: ['stella-artois'] },
      { category: 'Craft Beer',     par: 6, unit: '24pk', eligible: [C.craft] },
      { category: 'Premium Red Wine',   par: 6,  unit: 'btl', eligible: [C.red, C.red2] },
      { category: 'Premium White Wine', par: 6,  unit: 'btl', eligible: [C.white, C.white2] },
      { category: 'Sparkling',          par: 12, unit: 'btl', eligible: [C.sparkling] },
      { category: 'Sodas',      par: 4, unit: 'unit', eligible: ['coca-cola', 'diet-coke', 'sprite'] },
      { category: 'Club Soda & Tonic', par: 6, unit: 'unit', eligible: ['club-soda', 'tonic-water'] },
      { category: 'Ginger Beer', par: 2, unit: 'unit', eligible: ['ginger-beer'] },
      { category: 'Juices',     par: 6, unit: 'unit', eligible: ['orange-juice', 'cranberry-juice', 'pineapple-juice', 'lemon-juice', 'lime-juice-unsweet'] },
      { category: 'Bar Modifiers', par: 2, unit: 'unit', eligible: ['simple-syrup', 'angostura-bitters'] },
      { category: 'Garnishes',  par: 6, unit: 'unit', eligible: GARNISH },
    ],
  },

  // Clear Reaction: mocktail bar, 4 FEATURED signature slots. Light basics
  // (sodas/juices/simple + citrus) enable improvisation. No alcohol.
  'the-clear-reaction': {
    slots: { count: 4, kind: 'featured' },
    items: [
      { category: 'Sodas',      par: 4, unit: 'unit', eligible: ['coca-cola', 'diet-coke', 'sprite'] },
      { category: 'Soda Water & Tonic', par: 6, unit: 'unit', eligible: ['club-soda', 'tonic-water'] },
      { category: 'Juices',     par: 6, unit: 'unit', eligible: ['cranberry-juice', 'orange-juice', 'pineapple-juice', 'lemon-juice', 'lime-juice-unsweet'] },
      { category: 'Bar Modifiers', par: 2, unit: 'unit', eligible: ['simple-syrup'] },
      { category: 'Garnishes',  par: 6, unit: 'unit', eligible: ['limes', 'lemons', 'oranges', 'mint'] },
    ],
  },

  // Primary Culture: beer + wine ladder step 1. Miller 4 + Michelob 4; 1 red
  // (12) + 1 white (12). Infused water = supplies (handled by margin knob).
  'the-primary-culture': {
    items: [
      { category: 'Miller Lite',    par: 4, unit: '24pk', eligible: ['miller-lite'] },
      { category: 'Michelob Ultra', par: 4, unit: '24pk', eligible: [C.michelob] },
      { category: 'Red Wine',   par: 12, unit: 'btl', eligible: [C.red] },
      { category: 'White Wine', par: 12, unit: 'btl', eligible: [C.white] },
    ],
  },

  // Carbon Suspension: ladder step 2. Miller 3 + Michelob 3 + Yuengling 2;
  // seltzer 2 (the feature people pay for). Wine SLIMS to 1 red + 1 white.
  'the-carbon-suspension': {
    items: [
      { category: 'Miller Lite',    par: 3, unit: '24pk', eligible: ['miller-lite'] },
      { category: 'Michelob Ultra', par: 3, unit: '24pk', eligible: [C.michelob] },
      { category: 'Yuengling',      par: 2, unit: '24pk', eligible: [C.yuengling] },
      { category: 'Seltzer',        par: 2, unit: '12pk', eligible: [C.seltzer] },
      { category: 'Red Wine',   par: 6, unit: 'btl', eligible: [C.red] },
      { category: 'White Wine', par: 6, unit: 'btl', eligible: [C.white] },
    ],
  },

  // Cultivated Complex: ladder top. Keeps its spread — Miller 3 + Michelob 3 +
  // Yuengling 2 + craft 2; seltzer 2; 2 premium red + 2 premium white + sparkling.
  'the-cultivated-complex': {
    items: [
      { category: 'Miller Lite',    par: 3, unit: '24pk', eligible: ['miller-lite'] },
      { category: 'Michelob Ultra', par: 3, unit: '24pk', eligible: [C.michelob] },
      { category: 'Yuengling',      par: 2, unit: '24pk', eligible: [C.yuengling] },
      { category: 'Craft Beer',     par: 2, unit: '24pk', eligible: [C.craft] },
      { category: 'Seltzer',        par: 2, unit: '12pk', eligible: [C.seltzer] },
      { category: 'Premium Red Wine',   par: 6, unit: 'btl', eligible: [C.red, C.red2] },
      { category: 'Premium White Wine', par: 6, unit: 'btl', eligible: [C.white, C.white2] },
      { category: 'Sparkling',          par: 6, unit: 'btl', eligible: [C.sparkling] },
    ],
  },
};

// Refined Reaction: RETIRED (is_active=false; never quoted; no package_items).
const RETIRE_SLUGS = ['the-refined-reaction'];

async function main() {
  const q = (text, params) => pool.query(text, params);
  const targetSlugs = [...Object.keys(LINEUP), ...RETIRE_SLUGS];

  // Resolve slugs -> ids.
  const pkRes = await q(
    'SELECT id, slug, name, is_active, slot_count, slot_kind FROM service_packages WHERE slug = ANY($1)',
    [targetSlugs]
  );
  const idBySlug = new Map(pkRes.rows.map((r) => [r.slug, r.id]));
  const missingSlugs = targetSlugs.filter((s) => !idBySlug.has(s));
  if (missingSlugs.length) {
    throw new Error(`service_packages rows missing for: ${missingSlugs.join(', ')}. Aborting (no writes).`);
  }
  const targetIds = [...idBySlug.values()];

  // ─── Snapshot prior state BEFORE any write (rollback source) ──────────────
  const existingParIds = new Set(
    (await q('SELECT id FROM par_items WHERE id = ANY($1)', [BRANDED_PARS.map((b) => b.id)])).rows.map((r) => r.id)
  );
  const snapshot = {
    generated_at: new Date().toISOString(),
    note: 'Prior state before applyPackageLineup2026. Restore package_items/service_packages/ingredient_class_addons from here to roll back; delete the branded par ids listed in created_par_ids (only those NOT in preexisting_par_ids).',
    service_packages: pkRes.rows,
    package_items: (await q('SELECT * FROM package_items WHERE package_id = ANY($1) ORDER BY package_id, sort_order, id', [targetIds])).rows,
    ingredient_class_addons: (await q('SELECT * FROM ingredient_class_addons ORDER BY class_key')).rows,
    branded_par_ids_to_create: BRANDED_PARS.map((b) => b.id),
    preexisting_par_ids: [...existingParIds],
  };
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const snapPath = path.join(__dirname, `lineup-snapshot-${ts}.json`);
  // Only persist the snapshot on a real run; a dry-run rolls everything back and
  // needs no rollback file. The in-memory snapshot still feeds the summary.
  if (!DRY_RUN) {
    // snapPath is script-derived (timestamp under __dirname), never user input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    fs.writeFileSync(snapPath, JSON.stringify(snapshot, null, 2));
    console.log(`snapshot written: ${snapPath}`);
  } else {
    console.log('[dry run] snapshot captured in memory (file not written).');
  }
  console.log(`  ${snapshot.service_packages.length} service_packages, ${snapshot.package_items.length} package_items, ${snapshot.ingredient_class_addons.length} class_addons captured.`);

  const summary = { brandedInserted: 0, brandedSkipped: 0, classAddons: 0, classAddonsSkipped: [], slotsSet: [], retired: [], perPackage: {} };

  // Dedicated client: BEGIN/COMMIT must ride ONE physical connection. pool.query
  // per-statement only reuses the same connection incidentally — an idle reap
  // mid-transaction would silently move later writes onto a fresh autocommit
  // connection, breaking both the rollback and the --dry-run guarantee.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 1) Branded par rows (ON CONFLICT DO NOTHING — never clobber admin edits).
    for (const b of BRANDED_PARS) {
      const r = await client.query(
        `INSERT INTO par_items
           (id, item, size, qty_per_100, section, role, spirit_key, style_key, paired_spirits, ingredient_aliases, in_full_bar, is_active, sort_order)
         VALUES ($1,$2,$3,$4,'liquorBeerWine',$5,NULL,NULL,'{}',$6,false,true,500)
         ON CONFLICT (id) DO NOTHING`,
        [b.id, b.item, b.size, b.qty, b.role, b.aliases]
      );
      if (r.rowCount > 0) { summary.brandedInserted += 1; } else { summary.brandedSkipped += 1; }
    }

    // 2) Validate every eligible id resolves to a real par row (fail-fast).
    const allEligible = new Set();
    for (const def of Object.values(LINEUP)) for (const it of def.items) for (const id of it.eligible) allEligible.add(id);
    const present = new Set(
      (await client.query('SELECT id FROM par_items WHERE id = ANY($1)', [[...allEligible]])).rows.map((r) => r.id)
    );
    const missingEligible = [...allEligible].filter((id) => !present.has(id));
    if (missingEligible.length) {
      throw new Error(`eligible_item_ids not in par catalog: ${missingEligible.join(', ')}. Aborting.`);
    }

    // 3) ingredient_class_addons — only map to addon slugs that actually exist.
    const realAddonSlugs = new Set(
      (await client.query('SELECT slug FROM service_addons')).rows.map((r) => r.slug)
    );
    for (const [classKey, addonSlug] of Object.entries(CLASS_ADDONS)) {
      if (!realAddonSlugs.has(addonSlug)) { summary.classAddonsSkipped.push(`${classKey} -> ${addonSlug} (no such addon)`); continue; }
      await client.query(
        `INSERT INTO ingredient_class_addons (class_key, addon_slug) VALUES ($1,$2)
         ON CONFLICT (class_key) DO UPDATE SET addon_slug = EXCLUDED.addon_slug`,
        [classKey, addonSlug]
      );
      summary.classAddons += 1;
    }

    // 4) Retire packages (is_active=false; clear any package_items).
    for (const slug of RETIRE_SLUGS) {
      const id = idBySlug.get(slug);
      await client.query('UPDATE service_packages SET is_active = false WHERE id = $1', [id]);
      await client.query('DELETE FROM package_items WHERE package_id = $1', [id]);
      summary.retired.push(slug);
    }

    // 5) Slots + package_items per package (DELETE then INSERT = idempotent).
    for (const [slug, def] of Object.entries(LINEUP)) {
      const id = idBySlug.get(slug);
      if (def.slots) {
        await client.query(
          'UPDATE service_packages SET slot_count = $1, slot_kind = $2 WHERE id = $3',
          [def.slots.count, def.slots.kind, id]
        );
        summary.slotsSet.push(`${slug}: ${def.slots.count} ${def.slots.kind}`);
      }
      await client.query('DELETE FROM package_items WHERE package_id = $1', [id]);
      let sort = 10;
      for (const it of def.items) {
        await client.query(
          `INSERT INTO package_items (package_id, category, par_per_100, unit, eligible_item_ids, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, it.category, it.par, it.unit || 'btl', it.eligible, sort]
        );
        sort += 10;
      }
      // slug is a controlled key from Object.entries(LINEUP), never user input.
      // eslint-disable-next-line security/detect-object-injection
      summary.perPackage[slug] = def.items.length;
    }

    // 6) Verification reads inside the tx.
    const countRows = (await client.query(
      'SELECT package_id, COUNT(*)::int AS n FROM package_items WHERE package_id = ANY($1) GROUP BY package_id',
      [targetIds]
    )).rows;
    const countById = new Map(countRows.map((r) => [r.package_id, r.n]));
    const slotRows = (await client.query(
      'SELECT slug, is_active, slot_count, slot_kind FROM service_packages WHERE id = ANY($1) ORDER BY slug',
      [targetIds]
    )).rows;

    console.log('\n─── package_items per package (in-tx) ───');
    for (const [slug, expected] of Object.entries(summary.perPackage)) {
      const got = countById.get(idBySlug.get(slug)) || 0;
      const flag = got === expected ? 'ok' : 'MISMATCH';
      console.log(`  ${slug}: ${got} rows (expected ${expected}) [${flag}]`);
    }
    console.log('\n─── flags / slots (in-tx) ───');
    for (const r of slotRows) {
      console.log(`  ${r.slug}: active=${r.is_active} slots=${r.slot_count === null ? '-' : r.slot_count}/${r.slot_kind || '-'}`);
    }

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.log('\n[dry run] all writes exercised then ROLLED BACK. No changes persisted.');
    } else {
      await client.query('COMMIT');
      console.log('\nCOMMIT complete.');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log('\n─── summary ───');
  console.log(`  branded par_items: ${summary.brandedInserted} inserted, ${summary.brandedSkipped} already present`);
  console.log(`  ingredient_class_addons: ${summary.classAddons} mapped` + (summary.classAddonsSkipped.length ? `, ${summary.classAddonsSkipped.length} skipped` : ''));
  for (const s of summary.classAddonsSkipped) console.log(`     skipped: ${s}`);
  console.log(`  slots set: ${summary.slotsSet.join('; ') || '(none)'}`);
  console.log(`  retired: ${summary.retired.join(', ') || '(none)'}`);
  console.log(`  snapshot: ${snapPath}`);
}

main()
  .then(() => pool.end())
  .catch((err) => { console.error('\nERROR:', err.message); pool.end(); process.exit(1); });

# Standard Menu Auto-Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Standard Menu auto-generator: a live in-planner HTML preview of the client's actual menu, a logo upload field that applies to both Custom and Standard menu paths, and an admin-side PNG download for the operator to print and frame.

**Architecture:** One shared React component (`<MenuPreview>`) is the canonical visual; it renders inline on `MenuDesignStep` for the client and off-screen at print dimensions on the admin event detail page for `html2canvas` to capture as a 2400 x 3000 px PNG. Logo upload flows through the existing `express-fileupload` → `fileValidation.js` → R2 (`storage.js#uploadFile`) pipeline; the file is reachable via a new public token-gated proxy route so both the client (no auth) and the admin can render it. No schema changes.

**Tech Stack:** React 18, vanilla CSS (no Tailwind), Node 18 / Express 4.18, `pg` (raw SQL), Cloudflare R2 via AWS SDK v3, `express-fileupload` for multipart uploads, `html2canvas` (new dependency, lazy-loaded for the admin PNG path), Jest (existing) for the one unit-tested helper.

**Source spec:** `docs/superpowers/specs/2026-05-20-standard-menu-autogen-design.md`. Locked to the Dark Ink direction per §6.4.

---

## Execution conventions

This codebase is vibe-coded. The planner has minimal jest coverage; visual verification is the rule. One helper in this plan (`menuSections.js`) is a pure function suitable for unit tests; the rest is verified visually in the dev server.

**Commit pattern.** Per CLAUDE.md: plain `git commit -m "single line"` with no heredoc and no co-author footer. Always `git add <specific-path>`, never `git add .`. Each task commits as one logical change.

**Em dashes.** Do not introduce em dashes anywhere in code, copy, or comments. Use commas, periods, colons, parentheticals.

**Working directory:** `C:\Users\dalla\DRB_OS\os`. Branch: `main`. No worktree, no push (the user controls push timing).

---

## File structure

```
server/routes/drinkPlans.js                                       # extend GET /:id; add 4 new logo routes
server/utils/storage.js                                           # (unchanged; already exports uploadFile)
server/utils/fileValidation.js                                    # (unchanged; already exports isValidUpload)

client/src/pages/plan/PotionPlanningLab.js                        # add companyLogo to DEFAULT_SELECTIONS

client/src/pages/plan/data/menuSections.js                        # (create) pure helper; section-structure extractor
client/src/pages/plan/data/menuSections.test.js                   # (create) jest unit tests for the helper

client/src/pages/plan/components/MenuPreview.js                   # (create) shared React component for HTML preview
client/src/pages/plan/components/LogoUploadField.js               # (create) small upload widget used by MenuDesignStep

client/src/pages/plan/steps/MenuDesignStep.js                     # mount MenuPreview, mount LogoUploadField, scope gallery to Custom

client/src/components/MenuPNG/MenuPNG.jsx                         # (create) admin-side PNG export via html2canvas
client/src/pages/admin/EventDetailPage.js                         # add Logo subsection + Download Standard Menu PNG button

client/src/index.css                                              # append .menu-preview-*, .logo-upload-* under .potion-app scope
client/package.json                                               # add html2canvas dependency
```

---

## Task 1: Server: extend GET /api/drink-plans/:id with resolved drink names

The existing `GET /api/drink-plans/:id` (auth-gated, returns plan + selections) needs two added fields so `<MenuPreview>` on the admin event detail page can render cocktail and mocktail names without a second fetch.

**Files:**
- Modify: `server/routes/drinkPlans.js:638-661` (the `router.get('/:id', ...)` handler)

- [ ] **Step 1: Modify the GET /:id handler to resolve drink names**

Open `server/routes/drinkPlans.js`. Find the handler at approximately line 638 (`router.get('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {`). Replace its body with:

```js
router.get('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT dp.id, dp.token, dp.proposal_id, dp.client_name, dp.client_email,
            dp.event_type, dp.event_type_custom, dp.event_date, dp.serving_type,
            dp.selections, dp.status, dp.admin_notes, dp.exploration_submitted_at,
            dp.submitted_at, dp.created_at, dp.updated_at, dp.created_by,
            u.email AS created_by_email,
            dp.consult_selections IS NOT NULL AS has_consult_selections,
            dp.consult_filled_at, dp.consult_filled_by_user_id,
            cu.email AS consult_filled_by_email,
            dp.shopping_list_source,
            dp.shopping_list IS NOT NULL AS has_shopping_list,
            dp.shopping_list_status, dp.shopping_list_approved_at,
            p.guest_count
     FROM drink_plans dp
     LEFT JOIN users u ON u.id = dp.created_by
     LEFT JOIN users cu ON cu.id = dp.consult_filled_by_user_id
     LEFT JOIN proposals p ON p.id = dp.proposal_id
     WHERE dp.id = $1`,
    [req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Plan not found.');

  const plan = result.rows[0];

  // Resolve signature-drink and mocktail names so <MenuPreview> on the admin
  // event detail page can render without a second fetch. Missing IDs (deleted
  // rows in the source tables) are silently dropped, matching the graceful
  // degradation pattern used by shoppingListGen.js.
  const sigIds = Array.isArray(plan.selections?.signatureDrinks) ? plan.selections.signatureDrinks : [];
  const mocktailIds = Array.isArray(plan.selections?.mocktails) ? plan.selections.mocktails : [];

  let signatureDrinkNames = [];
  if (sigIds.length > 0) {
    const sigRows = await pool.query(
      `SELECT id, name FROM cocktails WHERE id = ANY($1::text[])`,
      [sigIds]
    );
    const nameById = new Map(sigRows.rows.map((r) => [r.id, r.name]));
    signatureDrinkNames = sigIds.map((id) => nameById.get(id)).filter(Boolean);
  }

  let mocktailNames = [];
  if (mocktailIds.length > 0) {
    const mocktailRows = await pool.query(
      `SELECT id, name FROM mocktails WHERE id = ANY($1::text[])`,
      [mocktailIds]
    );
    const nameById = new Map(mocktailRows.rows.map((r) => [r.id, r.name]));
    mocktailNames = mocktailIds.map((id) => nameById.get(id)).filter(Boolean);
  }

  res.json({ ...plan, signatureDrinkNames, mocktailNames });
}));
```

- [ ] **Step 2: Verify with curl against a real plan ID**

Start the dev server if it isn't running. Then in a separate shell:

```
curl -s -H "Authorization: Bearer <admin-jwt>" http://localhost:5000/api/drink-plans/<plan-id> | python -c "import sys,json; d=json.load(sys.stdin); print('signatureDrinkNames:', d.get('signatureDrinkNames')); print('mocktailNames:', d.get('mocktailNames'))"
```

Expected: both arrays appear in the response. If the plan has signature drink IDs selected, names appear in the same order as the IDs. If the plan has no drinks of one type, that array is empty.

If you cannot easily produce a JWT, alternative verification: log into the admin UI, open browser DevTools Network tab, navigate to an event detail page that already loads `/api/drink-plans/<id>`, and inspect the response payload for the two new fields.

- [ ] **Step 3: Commit**

```
git add server/routes/drinkPlans.js
git commit -m "feat(planner): resolve signature-drink and mocktail names in admin plan response"
```

---

## Task 2: Server: four logo routes (public POST, admin POST, admin DELETE, public GET proxy)

Adds the upload and proxy endpoints for the menu logo feature. All four endpoints live alongside the existing drinkPlans routes.

**Files:**
- Modify: `server/routes/drinkPlans.js` (append four new route handlers near the related routes)
- Modify: `server/utils/fileValidation.js` (add an image-only validator)

- [ ] **Step 1: Add an image-only validator to fileValidation.js**

Open `server/utils/fileValidation.js`. The existing `isValidUpload` accepts PDF, JPEG, PNG, WebP. The logo upload accepts only PNG and JPG. Append a new export:

```js
function isValidImageUpload(file) {
  if (!file || !file.data || !Buffer.isBuffer(file.data)) return false;
  const buf = file.data;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length >= pngMagic.length && buf.slice(0, pngMagic.length).equals(pngMagic)) return true;
  // JPEG: FF D8 FF
  const jpegMagic = Buffer.from([0xff, 0xd8, 0xff]);
  if (buf.length >= jpegMagic.length && buf.slice(0, jpegMagic.length).equals(jpegMagic)) return true;
  return false;
}

module.exports = { isValidUpload, isValidImageUpload };
```

The `module.exports` line replaces the existing single-export line at the bottom of the file.

- [ ] **Step 2: Add the public token-gated upload route**

Open `server/routes/drinkPlans.js`. Locate the existing `router.put('/t/:token', drinkPlanWriteLimiter, ...)` at line 93. Immediately after that handler closes, insert:

```js
/** POST /api/drink-plans/t/:token/logo
 * Public token-gated logo upload. Accepts multipart with field 'logo'.
 * Validates magic bytes + size + extension. Uploads to R2 under
 * drink-plan-logos/<plan-id>-<timestamp>.<ext>. Atomically persists the
 * URL into selections.companyLogo. Returns { logoUrl, selections }.
 */
router.post('/t/:token/logo', drinkPlanWriteLimiter, asyncHandler(async (req, res) => {
  const planResult = await pool.query(
    'SELECT id, selections, status FROM drink_plans WHERE token = $1',
    [req.params.token]
  );
  if (!planResult.rows[0]) throw new NotFoundError('Plan not found.');
  const plan = planResult.rows[0];

  // Pre-deposit plans render as locked in the planner UI; reject uploads.
  if (plan.status === 'pending') throw new PermissionError('Plan is locked until deposit is paid.');

  const file = req.files?.logo;
  if (!file) throw new ValidationError({ logo: 'No logo file uploaded. Use the field name "logo".' });
  if (file.size > 5 * 1024 * 1024) {
    throw new ValidationError({ logo: 'Logo must be 5 MB or smaller.' });
  }
  if (!isValidImageUpload(file)) {
    throw new ValidationError({ logo: 'Invalid file type. Use PNG or JPG only.' });
  }

  const ext = (path.extname(file.name) || '.png').toLowerCase();
  const safeExt = ['.png', '.jpg', '.jpeg'].includes(ext) ? ext : '.png';
  const filename = `drink-plan-logos/${plan.id}-${Date.now()}${safeExt}`;
  await uploadFile(file.data, filename);
  const logoUrl = `/api/drink-plans/t/${req.params.token}/logo`;

  // Atomic merge into the selections JSONB column using Postgres's || operator.
  // The merge happens in the database, not in the application, so a concurrent
  // auto-save PUT from the planner cannot lose the companyLogo / _logoFilename
  // fields via last-write-wins. The auto-save sees the merged result and
  // preserves it because it merges its own changes into whatever is current at
  // its write time. (If both writes target the same key in the JSON, the later
  // one still wins; but companyLogo is only written by these logo routes, so
  // there is no contention on that specific key.)
  const patch = { companyLogo: logoUrl, _logoFilename: filename };
  const updateResult = await pool.query(
    `UPDATE drink_plans
        SET selections = COALESCE(selections, '{}'::jsonb) || $1::jsonb,
            updated_at = NOW()
      WHERE id = $2
      RETURNING selections`,
    [JSON.stringify(patch), plan.id]
  );

  res.json({ logoUrl, selections: updateResult.rows[0].selections });
}));
```

Verify that `path`, `NotFoundError`, `PermissionError`, `ValidationError`, `pool`, `uploadFile`, `isValidImageUpload`, and `drinkPlanWriteLimiter` are all imported at the top of the file. If any are missing, add the imports:

```js
const path = require('path');
const { uploadFile } = require('../utils/storage');
const { isValidImageUpload } = require('../utils/fileValidation');
// ValidationError, PermissionError, NotFoundError already imported (used by other handlers in this file)
```

- [ ] **Step 3: Add the admin upload route**

Immediately after the public upload route, insert:

```js
/** POST /api/drink-plans/:id/logo
 * Admin-authenticated logo upload by plan ID. Same validation + R2 upload +
 * atomic selections persist as the token-gated route.
 */
router.post('/:id/logo', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const planResult = await pool.query(
    'SELECT id, token, selections FROM drink_plans WHERE id = $1',
    [req.params.id]
  );
  if (!planResult.rows[0]) throw new NotFoundError('Plan not found.');
  const plan = planResult.rows[0];

  const file = req.files?.logo;
  if (!file) throw new ValidationError({ logo: 'No logo file uploaded. Use the field name "logo".' });
  if (file.size > 5 * 1024 * 1024) {
    throw new ValidationError({ logo: 'Logo must be 5 MB or smaller.' });
  }
  if (!isValidImageUpload(file)) {
    throw new ValidationError({ logo: 'Invalid file type. Use PNG or JPG only.' });
  }

  const ext = (path.extname(file.name) || '.png').toLowerCase();
  const safeExt = ['.png', '.jpg', '.jpeg'].includes(ext) ? ext : '.png';
  const filename = `drink-plan-logos/${plan.id}-${Date.now()}${safeExt}`;
  await uploadFile(file.data, filename);
  const logoUrl = `/api/drink-plans/t/${plan.token}/logo`;

  // Atomic merge in the database (same pattern as the token-gated route above).
  const patch = { companyLogo: logoUrl, _logoFilename: filename };
  const updateResult = await pool.query(
    `UPDATE drink_plans
        SET selections = COALESCE(selections, '{}'::jsonb) || $1::jsonb,
            updated_at = NOW()
      WHERE id = $2
      RETURNING selections`,
    [JSON.stringify(patch), plan.id]
  );

  res.json({ logoUrl, selections: updateResult.rows[0].selections });
}));
```

- [ ] **Step 4: Add the admin clear route**

Immediately after the admin upload route, insert:

```js
/** DELETE /api/drink-plans/:id/logo
 * Admin-authenticated. Clears selections.companyLogo. Does NOT delete the R2
 * file (storage cost is negligible; no cleanup job in v1).
 */
router.delete('/:id/logo', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  // Verify plan exists; the DELETE itself is also a no-op-on-missing pattern,
  // but we want a 404 if the ID is wrong so the admin sees a clear error.
  const planResult = await pool.query(
    'SELECT id FROM drink_plans WHERE id = $1',
    [req.params.id]
  );
  if (!planResult.rows[0]) throw new NotFoundError('Plan not found.');

  // Atomic key removal via Postgres jsonb - operator. Strips both companyLogo
  // and _logoFilename in a single statement; concurrent auto-saves can't race.
  const updateResult = await pool.query(
    `UPDATE drink_plans
        SET selections = COALESCE(selections, '{}'::jsonb) - 'companyLogo' - '_logoFilename',
            updated_at = NOW()
      WHERE id = $1
      RETURNING selections`,
    [req.params.id]
  );

  res.json({ selections: updateResult.rows[0].selections });
}));
```

- [ ] **Step 5: Add the public GET proxy route**

**Note on the pattern.** This intentionally introduces a new file-serving pattern that differs from the existing `/api/files/:filename` at `server/index.js:149` (which is auth-gated and returns a signed URL the client redirects to). Three reasons for the new pattern:

1. The planner client has no JWT (token-gated public access), so the existing auth-gated `/api/files/` route is unreachable from MenuPreview.
2. html2canvas during PNG export needs the image at a same-origin URL with no redirect dance, or the canvas gets tainted by CORS.
3. Returning bytes directly with `Cache-Control: public, max-age=86400` gives us browser caching for free.

If this pattern is later judged the better default, the existing signed-URL route can be migrated in a follow-up. For now the two patterns coexist.

Immediately after the public POST logo route (Step 2), insert:

```js
/** GET /api/drink-plans/t/:token/logo
 * Public token-gated logo proxy. Returns the R2 object bytes with the
 * appropriate content-type so both the client preview (unauthenticated
 * token-gated context) and the admin event detail page (and html2canvas
 * during PNG export) can fetch the image from a same-origin URL.
 */
router.get('/t/:token/logo', publicReadLimiter, asyncHandler(async (req, res) => {
  const planResult = await pool.query(
    'SELECT selections FROM drink_plans WHERE token = $1',
    [req.params.token]
  );
  if (!planResult.rows[0]) throw new NotFoundError('Plan not found.');
  const filename = planResult.rows[0].selections?._logoFilename;
  if (!filename) throw new NotFoundError('No logo uploaded for this plan.');

  const url = await getSignedUrl(filename);
  const upstream = await fetch(url);
  if (!upstream.ok) throw new ExternalServiceError('r2', new Error(`Upstream returned ${upstream.status}`), 'Logo is temporarily unavailable.');
  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.set('Content-Type', contentType);
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(buffer);
}));
```

Add the import for `getSignedUrl` at the top of the file if not already imported:

```js
const { uploadFile, getSignedUrl } = require('../utils/storage');
```

The `ExternalServiceError` import should already exist (used by other routes); verify it does.

Add the `publicReadLimiter` import alongside the existing `drinkPlanWriteLimiter` import at the top:

```js
const { drinkPlanWriteLimiter, publicReadLimiter } = require('../middleware/rateLimit');
```

(If the existing import is on its own line, update it; if `publicReadLimiter` is already imported elsewhere in the file, just verify it's in scope.)

- [ ] **Step 6: Verify the four routes**

Start the dev server.

**Verify the public upload + proxy round-trip:**
```
# Substitute <token> with a real plan token.
curl -X POST -F "logo=@/path/to/test-logo.png" http://localhost:5000/api/drink-plans/t/<token>/logo
# Expected: 200 JSON { logoUrl: "/api/drink-plans/t/<token>/logo", selections: { ..., companyLogo: "/api/drink-plans/t/<token>/logo" } }

# Then fetch the proxy:
curl -I http://localhost:5000/api/drink-plans/t/<token>/logo
# Expected: 200 OK with Content-Type: image/png (or image/jpeg)
```

**Verify rejection of non-image:**
```
curl -X POST -F "logo=@/path/to/document.pdf" http://localhost:5000/api/drink-plans/t/<token>/logo
# Expected: 400 with { error: { logo: 'Invalid file type. Use PNG or JPG only.' } }
```

**Verify admin upload (substitute <id> and use a valid JWT):**
```
curl -X POST -H "Authorization: Bearer <admin-jwt>" -F "logo=@/path/to/test-logo.png" http://localhost:5000/api/drink-plans/<id>/logo
# Expected: 200 JSON same shape as the public upload
```

**Verify admin clear:**
```
curl -X DELETE -H "Authorization: Bearer <admin-jwt>" http://localhost:5000/api/drink-plans/<id>/logo
# Expected: 200 JSON { selections: {...no companyLogo field...} }
```

- [ ] **Step 7: Commit**

```
git add server/routes/drinkPlans.js server/utils/fileValidation.js
git commit -m "feat(planner): logo upload routes (public POST, admin POST, admin DELETE, public GET proxy)"
```

---

## Task 3: Client: add companyLogo to DEFAULT_SELECTIONS

A one-line change so new plans default to no logo.

**Files:**
- Modify: `client/src/pages/plan/PotionPlanningLab.js`

- [ ] **Step 1: Add the field**

Open `client/src/pages/plan/PotionPlanningLab.js`. Find the `DEFAULT_SELECTIONS` block. Locate the menu-design grouping that currently includes `additionalNotes: ''` near the bottom. Insert `companyLogo: ''` directly after `additionalNotes`:

```js
  customMenuDesign: null,
  menuStyle: null,
  menuTheme: '',
  drinkNaming: '',
  menuDesignNotes: '',
  additionalNotes: '',
  companyLogo: '',
  logistics: {
```

- [ ] **Step 2: Commit**

```
git add client/src/pages/plan/PotionPlanningLab.js
git commit -m "feat(planner): add companyLogo to DEFAULT_SELECTIONS"
```

---

## Task 4: Client: create menuSections.js helper with unit tests

A pure function that takes `selections` and `activeModules` and returns the structured data both `<MenuPreview>` and `<MenuPNG>` consume. TDD: write the tests first, then the helper.

**Files:**
- Create: `client/src/pages/plan/data/menuSections.js`
- Create: `client/src/pages/plan/data/menuSections.test.js`

- [ ] **Step 1: Write the failing test file**

Create `client/src/pages/plan/data/menuSections.test.js` with:

```js
import { extractMenuSections } from './menuSections';

const baseSelections = {
  signatureDrinks: [],
  mocktails: [],
  beerFromFullBar: [],
  wineFromFullBar: [],
  beerFromBeerWine: [],
  wineFromBeerWine: [],
};

const baseModules = { signatureDrinks: false, mocktails: false, fullBar: false, beerWineOnly: false };

const sig = (ids) => ids.map((id) => ({ id, name: `Cocktail ${id}` }));
const moc = (ids) => ids.map((id) => ({ id, name: `Mocktail ${id}` }));

describe('extractMenuSections', () => {
  it('returns empty sections when nothing is selected', () => {
    const result = extractMenuSections(baseSelections, baseModules, [], []);
    expect(result.sections).toEqual([]);
    expect(result.isEmpty).toBe(true);
  });

  it('renders Cocktails section in selection order with resolved names', () => {
    const selections = { ...baseSelections, signatureDrinks: [3, 1, 2] };
    const cocktails = sig([1, 2, 3]);
    const result = extractMenuSections(selections, { ...baseModules, signatureDrinks: true }, cocktails, []);
    expect(result.sections).toEqual([
      { kind: 'cocktails', title: 'Cocktails', items: ['Cocktail 3', 'Cocktail 1', 'Cocktail 2'] },
    ]);
  });

  it('silently drops cocktail IDs that no longer exist in the resolver array', () => {
    const selections = { ...baseSelections, signatureDrinks: [1, 99, 2] };
    const result = extractMenuSections(selections, { ...baseModules, signatureDrinks: true }, sig([1, 2]), []);
    expect(result.sections[0].items).toEqual(['Cocktail 1', 'Cocktail 2']);
  });

  it('renders Mocktails section when selections.mocktails has items', () => {
    const selections = { ...baseSelections, mocktails: [10, 11] };
    const result = extractMenuSections(selections, { ...baseModules, mocktails: true }, [], moc([10, 11]));
    expect(result.sections).toEqual([
      { kind: 'mocktails', title: 'Mocktails', items: ['Mocktail 10', 'Mocktail 11'] },
    ]);
  });

  it('collapses beer/wine arrays into fixed labels in display order', () => {
    const selections = {
      ...baseSelections,
      beerFromFullBar: ['IPA', 'Seltzer', 'Light / Easy Drinking'],
      wineFromFullBar: ['Red', 'White', 'Sparkling'],
    };
    const result = extractMenuSections(selections, { ...baseModules, fullBar: true, signatureDrinks: false }, [], []);
    // signatureDrinks empty + fullBar active means Bar Service fallback would appear, but per the fixed order it comes AFTER Beer & Wine, not before.
    // Order is fixed: Cocktails, Mocktails, Beer & Wine, Bar Service. Bar Service appears last.
    const bw = result.sections.find((s) => s.kind === 'beer-wine');
    expect(bw).toBeDefined();
    expect(bw.items).toEqual(['Beer', 'Seltzer', 'Red', 'White', 'Sparkling']);
  });

  it('rolls Light / Easy Drinking and Craft / Local and IPA and Non-Alcoholic into a single Beer label', () => {
    const selections = { ...baseSelections, beerFromBeerWine: ['Light / Easy Drinking', 'Craft / Local', 'IPA', 'Non-Alcoholic'] };
    const result = extractMenuSections(selections, { ...baseModules, beerWineOnly: true }, [], []);
    const bw = result.sections.find((s) => s.kind === 'beer-wine');
    expect(bw.items).toEqual(['Beer']);
  });

  it('omits the Beer label when only Seltzer is in the beer array', () => {
    const selections = { ...baseSelections, beerFromBeerWine: ['Seltzer'] };
    const result = extractMenuSections(selections, { ...baseModules, beerWineOnly: true }, [], []);
    const bw = result.sections.find((s) => s.kind === 'beer-wine');
    expect(bw.items).toEqual(['Seltzer']);
  });

  it('omits "Other" wine entries from the menu labels', () => {
    const selections = { ...baseSelections, wineFromBeerWine: ['Red', 'Other'] };
    const result = extractMenuSections(selections, { ...baseModules, beerWineOnly: true }, [], []);
    const bw = result.sections.find((s) => s.kind === 'beer-wine');
    expect(bw.items).toEqual(['Red']);
  });

  it('does not render the Beer & Wine section when only "Other" wine is selected', () => {
    const selections = { ...baseSelections, wineFromBeerWine: ['Other'] };
    const result = extractMenuSections(selections, { ...baseModules, beerWineOnly: true }, [], []);
    expect(result.sections.find((s) => s.kind === 'beer-wine')).toBeUndefined();
  });

  it('renders Bar Service fallback when fullBar is active and no signature cocktails are selected', () => {
    const selections = { ...baseSelections };
    const result = extractMenuSections(selections, { ...baseModules, fullBar: true }, [], []);
    const fallback = result.sections.find((s) => s.kind === 'bar-service');
    expect(fallback).toEqual({ kind: 'bar-service', title: 'Bar Service', items: ['Call Drinks'] });
  });

  it('does NOT render Bar Service when signature cocktails ARE selected', () => {
    const selections = { ...baseSelections, signatureDrinks: [1] };
    const result = extractMenuSections(selections, { ...baseModules, fullBar: true, signatureDrinks: true }, sig([1]), []);
    expect(result.sections.find((s) => s.kind === 'bar-service')).toBeUndefined();
  });

  it('renders all sections in the fixed order: Cocktails, Mocktails, Beer & Wine, Bar Service', () => {
    // Pathological mix: signature drinks + mocktails + beer/wine + fullBar.
    // Bar Service should NOT appear because signature drinks are present.
    const selections = {
      ...baseSelections,
      signatureDrinks: [1],
      mocktails: [10],
      beerFromFullBar: ['IPA'],
      wineFromFullBar: ['Red'],
    };
    const result = extractMenuSections(
      selections,
      { ...baseModules, fullBar: true, mocktails: true, signatureDrinks: true },
      sig([1]),
      moc([10])
    );
    expect(result.sections.map((s) => s.kind)).toEqual(['cocktails', 'mocktails', 'beer-wine']);
  });

  it('deduplicates by id within Cocktails and Mocktails sections', () => {
    const selections = { ...baseSelections, signatureDrinks: [1, 1, 2] };
    const result = extractMenuSections(selections, { ...baseModules, signatureDrinks: true }, sig([1, 2]), []);
    expect(result.sections[0].items).toEqual(['Cocktail 1', 'Cocktail 2']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```
cd client
npm test -- --watchAll=false data/menuSections.test.js
```

Expected: all tests fail with "Cannot find module './menuSections'" or similar.

- [ ] **Step 3: Implement the helper**

Create `client/src/pages/plan/data/menuSections.js` with:

```js
// Pure helper consumed by both <MenuPreview> (HTML preview on MenuDesignStep)
// and <MenuPNG> (admin-side PNG export via html2canvas). Extracts the menu's
// section structure from selections so both renderers stay in sync. Order is
// fixed: Cocktails, Mocktails, Beer & Wine, Bar Service. Empty sections are
// skipped. See spec §5 for the rationale and full rule set.

const BEER_WINE_DISPLAY_ORDER = ['Beer', 'Seltzer', 'Red', 'White', 'Sparkling'];

function uniq(arr) {
  return Array.from(new Set(arr));
}

function resolveNames(ids, lookupArray) {
  const byId = new Map((lookupArray || []).map((d) => [d.id, d.name]));
  return uniq(ids).map((id) => byId.get(id)).filter(Boolean);
}

function collapseBeerWine(selections) {
  const beerEntries = [
    ...(selections.beerFromFullBar || []),
    ...(selections.beerFromBeerWine || []),
  ];
  const wineEntries = [
    ...(selections.wineFromFullBar || []),
    ...(selections.wineFromBeerWine || []),
  ];

  const labels = new Set();
  // Any beer entry other than "Seltzer" rolls up to "Beer".
  if (beerEntries.some((e) => e && e !== 'Seltzer')) labels.add('Beer');
  if (beerEntries.includes('Seltzer')) labels.add('Seltzer');
  if (wineEntries.includes('Red')) labels.add('Red');
  if (wineEntries.includes('White')) labels.add('White');
  if (wineEntries.includes('Sparkling')) labels.add('Sparkling');
  // "Other" wine entries do NOT render a label.

  return BEER_WINE_DISPLAY_ORDER.filter((label) => labels.has(label));
}

export function extractMenuSections(selections, activeModules, cocktails, mocktails) {
  const sections = [];

  // 1. Cocktails
  const sigIds = Array.isArray(selections.signatureDrinks) ? selections.signatureDrinks : [];
  if (sigIds.length > 0) {
    const items = resolveNames(sigIds, cocktails);
    if (items.length > 0) {
      sections.push({ kind: 'cocktails', title: 'Cocktails', items });
    }
  }

  // 2. Mocktails
  const mocIds = Array.isArray(selections.mocktails) ? selections.mocktails : [];
  if (mocIds.length > 0) {
    const items = resolveNames(mocIds, mocktails);
    if (items.length > 0) {
      sections.push({ kind: 'mocktails', title: 'Mocktails', items });
    }
  }

  // 3. Beer & Wine
  const beerWineLabels = collapseBeerWine(selections);
  if (beerWineLabels.length > 0) {
    sections.push({ kind: 'beer-wine', title: 'Beer & Wine', items: beerWineLabels });
  }

  // 4. Bar Service fallback (full bar with no signature cocktails)
  if (activeModules?.fullBar === true && sigIds.length === 0) {
    sections.push({ kind: 'bar-service', title: 'Bar Service', items: ['Call Drinks'] });
  }

  return { sections, isEmpty: sections.length === 0 };
}
```

- [ ] **Step 4: Run the tests again, verify all pass**

```
cd client
npm test -- --watchAll=false data/menuSections.test.js
```

Expected: all 13 tests pass.

- [ ] **Step 5: Commit**

```
git add client/src/pages/plan/data/menuSections.js client/src/pages/plan/data/menuSections.test.js
git commit -m "feat(planner): menuSections.js helper with unit tests for section extraction"
```

---

## Task 5: Client: create MenuPreview component (canonical Dark Ink render)

The shared React component that renders the menu visually. **This task ports the canonical render directly from the locked Claude Design output.** Inline-style React component (no CSS classes, same pattern as `ClientShoppingList.js`) that draws the menu at exact 768 x 960 px ("print" variant) or wraps the same render in a responsive transform-scaled container ("screen" variant). The print variant feeds html2canvas for the admin PNG export in Task 10.

**Two new asset files** are required and must be in place before this code can render correctly:
1. Pirata One TTF/WOFF2 (for the "The Bar Menu" title crest)
2. The Dr. Bartender gold-rimmed logo PNG (for the footer lockup)

**Files:**
- Create: `client/src/fonts/PirataOne-Regular.woff2` (download from Google Fonts; ~32 KB)
- Create: `client/public/images/menu-logo-gold.png` (extract from the Claude Design bundle at `potion-planner/styles/assets/logo-gold.png` or use whichever DRB gold-rimmed medallion asset matches the brand)
- Create: `client/src/pages/plan/components/MenuPreview.js`
- Modify: `client/src/index.css` (append one `@font-face` declaration for Pirata One)

- [ ] **Step 1: Place the font and logo assets**

Download the Pirata One Regular font from `https://fonts.google.com/specimen/Pirata+One` as a TTF. Convert to WOFF2 (smaller, browser-friendly) using any TTF-to-WOFF2 converter (e.g., the `woff2` CLI tool, or an online converter). Save the resulting file to:

```
client/src/fonts/PirataOne-Regular.woff2
```

Place the Dr. Bartender gold-rimmed logo PNG at:

```
client/public/images/menu-logo-gold.png
```

(The file is referenced from the design bundle's `potion-planner/styles/assets/logo-gold.png`. If you don't have that file at hand, any 256×256-or-larger PNG of the DRB medallion will do; the exact asset can be swapped in later.)

- [ ] **Step 2: Add the `@font-face` for Pirata One**

Open `client/src/index.css`. Find the existing `@font-face` block for IM Fell English at the top of the file (lines ~5-19). Immediately AFTER the last existing `@font-face` declaration and BEFORE the `:root` block, append:

```css
@font-face {
  font-family: 'Pirata One';
  src: url('./fonts/PirataOne-Regular.woff2') format('woff2');
  font-weight: 400; font-style: normal; font-display: swap;
}
```

This makes the font available globally so the menu component picks it up, and so html2canvas captures it correctly during the admin PNG export.

- [ ] **Step 3: Create the MenuPreview component**

Create `client/src/pages/plan/components/MenuPreview.js` with the following content. This is a direct port of the canonical render from the Claude Design output, adapted for our planner integration (uses our `extractMenuSections` helper from Task 4 and matches our prop contract):

```jsx
import React, { useEffect, useRef, useState } from 'react';
import { extractMenuSections } from '../data/menuSections';

/* Standard Menu, Dark Ink direction. Single canonical visual used in two
   variants: 'screen' (responsive, scaled-down preview shown to the client on
   MenuDesignStep) and 'print' (exact 768x960 at 96 DPI screen scale, fed to
   html2canvas by the admin PNG export at scale:3 to produce a 2304x2880 PNG).

   Inline-style React (no CSS classes) matches the ClientShoppingList.js
   pattern. All sizes are in print-px on the 768x960 canvas. */

const PRINT = {
  W: 768,
  H: 960,
  bg: '#12161C',
  cream: '#F0E8D6',
  brass: '#B8924A',
  brassBright: '#D6AE65',
  rule: '1px solid #B8924A',
  fontDisplay: "'IM Fell English SC', Georgia, serif",
  fontBody: "'IM Fell English', Georgia, serif",
  fontTitle: "'Pirata One', 'IM Fell English SC', Georgia, serif",
};

const DRB_LOGO_SRC = process.env.PUBLIC_URL + '/images/menu-logo-gold.png';

/* ─────────────────────────────────────────────────────────
   Public component (default export). Dispatches by variant.
   ───────────────────────────────────────────────────────── */
export default function MenuPreview(props) {
  const { variant = 'screen' } = props;
  if (variant === 'print') {
    return <MenuCard {...props} />;
  }
  return <ResponsiveScreenWrapper {...props} />;
}

/* ─────────────────────────────────────────────────────────
   ResponsiveScreenWrapper. Scales the 768x960 card to fit
   the parent container's width while preserving the 4:5
   aspect ratio. Uses ResizeObserver so the preview always
   fits MenuDesignStep's card width, on any viewport.
   ───────────────────────────────────────────────────────── */
function ResponsiveScreenWrapper(props) {
  const containerRef = useRef(null);
  const [scale, setScale] = useState(0.521);

  useEffect(() => {
    if (!containerRef.current) return;
    const update = () => {
      const w = containerRef.current?.offsetWidth || PRINT.W;
      setScale(Math.min(w / PRINT.W, 1));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        maxWidth: 400,
        aspectRatio: '4 / 5',
        position: 'relative',
        overflow: 'hidden',
        margin: '18px 0 4px',
      }}
    >
      <div
        style={{
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          position: 'absolute',
          top: 0,
          left: 0,
        }}
      >
        <MenuCard {...props} />
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
   MenuCard. The canonical render at 768x960.
   ───────────────────────────────────────────────────────── */
function MenuCard({
  selections = {},
  activeModules = {},
  cocktails = [],
  mocktails = [],
  companyLogo = '',
}) {
  const { sections, isEmpty } = extractMenuSections(selections, activeModules, cocktails, mocktails);

  return (
    <div
      style={{
        width: PRINT.W,
        height: PRINT.H,
        background: PRINT.bg,
        color: PRINT.cream,
        fontFamily: PRINT.fontBody,
        position: 'relative',
        overflow: 'hidden',
      }}
      role="img"
      aria-label="Standard menu preview"
    >
      {/* Content area. Page margins 48px (36pt). */}
      <div
        style={{
          position: 'absolute',
          top: 48,
          left: 48,
          right: 48,
          bottom: 107, // footer band height
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <TitleCrest text="The Bar Menu" />
        {isEmpty ? <EmptyBody /> : <Body sections={sections} />}
      </div>

      {/* Footer band. Absolute, full-width. */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: 107,
          borderTop: PRINT.rule,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 48,
          paddingRight: 48,
          gap: 24,
        }}
      >
        <DrbLockup />
        <div style={{ flex: 1 }} />
        {companyLogo && (
          <>
            <div style={{ width: 1, height: 64, background: PRINT.brass }} />
            <img
              src={companyLogo}
              alt=""
              style={{
                maxWidth: 160,
                maxHeight: 72,
                width: 'auto',
                height: 'auto',
                objectFit: 'contain',
                display: 'block',
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
   TitleCrest. Anchor of the menu. Pirata One at 72px,
   flanked by brass hairlines + diamond ornaments.
   ───────────────────────────────────────────────────────── */
function TitleCrest({ text }) {
  return (
    <div style={{ textAlign: 'center', marginBottom: 38 }}>
      <CrestHRule />
      <h1
        style={{
          margin: '14px 0',
          fontFamily: PRINT.fontTitle,
          fontWeight: 400,
          fontSize: 72,
          lineHeight: 1,
          letterSpacing: '0.02em',
          color: PRINT.cream,
        }}
      >
        {text}
      </h1>
      <CrestHRule />
    </div>
  );
}

function CrestHRule() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
      }}
    >
      <span style={{ flex: 1, maxWidth: 160, height: 1, background: PRINT.brass }} />
      <span
        style={{
          color: PRINT.brass,
          fontSize: 14,
          lineHeight: 1,
          transform: 'translateY(-1px)',
        }}
      >
        {'◆'}
      </span>
      <span style={{ flex: 1, maxWidth: 160, height: 1, background: PRINT.brass }} />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
   Body. Sections stacked vertically in spec order.
   ───────────────────────────────────────────────────────── */
function Body({ sections }) {
  const isOnly = sections.length === 1;
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 30,
      }}
    >
      {sections.map((section) => (
        <StackedSection key={section.kind} section={section} isOnly={isOnly} />
      ))}
    </div>
  );
}

function StackedSection({ section, isOnly }) {
  // Beer & Wine inline when it accompanies other sections; stacked like a
  // drink list when it is the only section on the menu.
  const inline = section.kind === 'beer-wine' && !isOnly;
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <SectionLabel>{section.title}</SectionLabel>
      <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 0 }}>
        {inline ? (
          <div
            style={{
              fontFamily: PRINT.fontDisplay,
              fontSize: 21,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: PRINT.cream,
              textAlign: 'center',
            }}
          >
            {section.items.join('   ·   ')}
          </div>
        ) : (
          section.items.map((name, i) => (
            <DrinkName key={`${section.kind}-${i}`}>{name}</DrinkName>
          ))
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{ paddingBottom: 12, borderBottom: PRINT.rule }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
          fontFamily: PRINT.fontDisplay,
          fontSize: 17,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: PRINT.brassBright,
          lineHeight: 1,
        }}
      >
        <span style={{ color: PRINT.brass, fontSize: 11, lineHeight: 1, transform: 'translateY(-1px)' }}>
          {'◆'}
        </span>
        <span>{children}</span>
        <span style={{ color: PRINT.brass, fontSize: 11, lineHeight: 1, transform: 'translateY(-1px)' }}>
          {'◆'}
        </span>
      </div>
    </div>
  );
}

function DrinkName({ children }) {
  return (
    <div
      style={{
        fontFamily: PRINT.fontDisplay,
        fontSize: 35,
        lineHeight: 1.4,
        letterSpacing: '0.04em',
        color: PRINT.cream,
        textAlign: 'center',
      }}
    >
      {children}
    </div>
  );
}

function EmptyBody() {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 48px',
      }}
    >
      <p
        style={{
          fontFamily: PRINT.fontBody,
          fontStyle: 'italic',
          fontSize: 22,
          color: 'rgba(240,232,214,0.65)',
          textAlign: 'center',
          lineHeight: 1.5,
          margin: 0,
        }}
      >
        No drinks selected yet. <br />
        Go back and pick something to serve.
      </p>
    </div>
  );
}

function DrbLockup() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <img
        src={DRB_LOGO_SRC}
        alt="Dr. Bartender"
        style={{
          width: 64,
          height: 64,
          objectFit: 'contain',
          display: 'block',
          flexShrink: 0,
        }}
      />
      <div
        style={{
          fontFamily: PRINT.fontDisplay,
          fontSize: 19,
          letterSpacing: '0.32em',
          lineHeight: 1,
          textTransform: 'uppercase',
          color: PRINT.cream,
        }}
      >
        Dr.&nbsp;Bartender
      </div>
    </div>
  );
}
```

A few notes on the port:

- `'◆'` is the Unicode escape for the `◆` diamond character. Using the escape keeps the source ASCII-safe.
- `'   ·   '` is the middot separator between Beer & Wine labels (three em-spaces, middot, three em-spaces). Using the escape so the spacing is unambiguous in source.
- The `ResponsiveScreenWrapper` uses `ResizeObserver` to track the parent width and scale the inner 768-px-wide card to fit. Falls back to scale 0.521 (which is 400/768) before the first measurement.
- `process.env.PUBLIC_URL` resolves to the dev/prod base path for static assets in `client/public/`. The DRB medallion at `/images/menu-logo-gold.png` must be in place from Step 1 before the component renders correctly.

- [ ] **Step 4: Verify the component file parses**

The component is not yet mounted anywhere; it cannot be visually verified yet. Verify mechanically:

```
cd client
npx eslint src/pages/plan/components/MenuPreview.js
# Expected: no errors (warnings about React hooks are fine if any appear)
```

If eslint flags any issues, fix them before commit.

- [ ] **Step 5: Commit**

```
git add client/src/fonts/PirataOne-Regular.woff2 client/public/images/menu-logo-gold.png client/src/pages/plan/components/MenuPreview.js client/src/index.css
git commit -m "feat(planner): canonical MenuPreview component (Dark Ink, Pirata One title, diamond ornaments)"
```

---

## Task 6: Client: mount MenuPreview on MenuDesignStep

When the client picks Standard, the live preview renders inline below the reveal text. Pure mounting; no new logic beyond passing the right props.

**Files:**
- Modify: `client/src/pages/plan/steps/MenuDesignStep.js`
- Modify: `client/src/pages/plan/PotionPlanningLab.js` (pass `cocktails` + `mocktails` + `activeModules` props to MenuDesignStep if not already passed)

- [ ] **Step 1: Verify the props MenuDesignStep receives from Lab.js**

Open `client/src/pages/plan/PotionPlanningLab.js`. Find the `case MODULE_STEP_MAP.menuDesign:` block (around line 843). The current call is:

```jsx
case MODULE_STEP_MAP.menuDesign:
  return (
    <MenuDesignStep
      selections={selections}
      activeModules={activeModules}
      cocktails={cocktails}
      mocktails={mocktailItems}
      onChange={updateSelections}
    />
  );
```

If the props above are already in place (selections, activeModules, cocktails, mocktails, onChange), no change is needed in Lab.js. If `cocktails` is named `cocktailItems` or any prop is missing, add it.

- [ ] **Step 2: Mount MenuPreview in MenuDesignStep.js**

Open `client/src/pages/plan/steps/MenuDesignStep.js`. At the top of the imports list, after the React import, add:

```jsx
import MenuPreview from '../components/MenuPreview';
```

Find the existing block where `selections.menuStyle === 'house'` triggers the field note (around line 175-178):

```jsx
{selections.menuStyle === 'house' && (
  <span className="potion-field-note">
    Our standard bar menu. Dr. Bartender branded, listing your drinks in plain terms like Vodka Lemonade, Old Fashioned, or Beer and Wine. We bring it printed and framed for the bar. No setup needed from you.
  </span>
)}
```

Replace it with:

```jsx
{selections.menuStyle === 'house' && (
  <>
    <span className="potion-field-note">
      Our standard bar menu. Dr. Bartender branded, listing your drinks in plain terms like Vodka Lemonade, Old Fashioned, or Beer and Wine. We bring it printed and framed for the bar. No setup needed from you.
    </span>
    <MenuPreview
      selections={selections}
      activeModules={activeModules}
      cocktails={cocktails}
      mocktails={mocktails}
      companyLogo={selections.companyLogo || ''}
      variant="screen"
    />
  </>
)}
```

- [ ] **Step 3: Verify in the dev server**

Start the dev server if it isn't running. Open a draft drink plan in the browser (`/plan/<token>`). Navigate to the Menu Design step. Click the "Standard Menu" radio. Expected:
- The existing field-note text appears.
- Below it, a 4:5 aspect-ratio Dark Ink menu preview renders.
- Sections present: Cocktails if the client picked any (with their names), Mocktails if any, Beer & Wine with the fixed labels, Bar Service if full-bar without cocktails.
- If nothing has been picked, "No drinks selected yet" appears centered.
- Pulling drinks in from prior steps (go back, change a drink, come back) shows the updated preview.

Try switching the radio to Custom → preview hides. Switch to No Menu Card → preview hides. Switch back to Standard → preview reappears with current state.

- [ ] **Step 4: Commit**

```
git add client/src/pages/plan/steps/MenuDesignStep.js
git commit -m "feat(planner): mount live MenuPreview inline when Standard is selected"
```

If Lab.js also changed in Step 1, include it:

```
git add client/src/pages/plan/steps/MenuDesignStep.js client/src/pages/plan/PotionPlanningLab.js
git commit -m "feat(planner): mount live MenuPreview inline when Standard is selected"
```

---

## Task 7: Client: logo upload UI on MenuDesignStep

Adds the file picker, upload flow, thumbnail preview, replace/remove actions, and inline error handling.

**Files:**
- Create: `client/src/pages/plan/components/LogoUploadField.js`
- Modify: `client/src/index.css` (append logo-upload CSS at end)
- Modify: `client/src/pages/plan/steps/MenuDesignStep.js` (mount LogoUploadField)

- [ ] **Step 1: Create LogoUploadField component**

Create `client/src/pages/plan/components/LogoUploadField.js` with:

```jsx
import React, { useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../../../utils/api';

/**
 * Logo upload widget on MenuDesignStep. Renders when selections.menuStyle
 * is 'custom' or 'house'. PNG/JPG up to 5 MB. Uploads via the public
 * token-gated POST /api/drink-plans/t/:token/logo route which atomically
 * persists the URL into selections.companyLogo on the server side.
 *
 * Props:
 *   companyLogo - current logo URL or ''
 *   onUploadSuccess - callback(updatedSelections) called with the full
 *                     selections object returned by the upload route
 */
export default function LogoUploadField({ companyLogo, onUploadSuccess }) {
  const { token } = useParams();
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    setUploading(true);
    try {
      const form = new FormData();
      form.append('logo', file);
      const res = await api.post(`/drink-plans/t/${token}/logo`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      if (res.data?.selections) {
        onUploadSuccess(res.data.selections);
      }
    } catch (err) {
      // The api interceptor (client/src/utils/api.js) normalizes errors to
      // { message, code, fieldErrors, status }. fieldErrors.logo holds the
      // server-side validation message for this specific field.
      const fieldMsg = err.fieldErrors?.logo;
      setError(typeof fieldMsg === 'string' ? fieldMsg : (err.message || 'Upload failed. Please try again.'));
    } finally {
      setUploading(false);
      // Reset the input so re-uploading the same file fires onChange.
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRemove = () => {
    onUploadSuccess({ companyLogo: '' });
  };

  const triggerPicker = () => fileInputRef.current?.click();

  return (
    <div className="logo-upload">
      <label className="form-label">Add your logo (optional)</label>
      <p className="logo-upload-help">For corporate events or branded weddings.</p>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg"
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />

      {companyLogo ? (
        <div className="logo-upload-preview">
          <img src={companyLogo} alt="Your uploaded logo" className="logo-upload-thumb" />
          <div className="logo-upload-preview-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={triggerPicker}
              disabled={uploading}
            >
              {uploading ? 'Uploading...' : 'Replace'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={handleRemove}
              disabled={uploading}
            >
              Remove
            </button>
          </div>
        </div>
      ) : (
        <div className="logo-upload-empty">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={triggerPicker}
            disabled={uploading}
          >
            {uploading ? 'Uploading...' : 'Choose logo file'}
          </button>
          <span className="logo-upload-hint">PNG or JPG, up to 5 MB.</span>
        </div>
      )}

      {error && <p className="logo-upload-error" role="alert">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Append logo-upload CSS to `client/src/index.css`**

```css

/* Logo upload widget on MenuDesignStep */
.potion-app .logo-upload {
  margin-top: 1.25rem;
  padding-top: 1.25rem;
  border-top: 1px solid rgba(184,146,74,0.32);
}
.potion-app .logo-upload-help {
  color: var(--text-muted);
  font-size: 0.88rem;
  font-style: italic;
  margin: 0 0 0.6rem;
}
.potion-app .logo-upload-empty {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.potion-app .logo-upload-hint {
  font-size: 0.82rem;
  color: var(--text-muted);
  font-style: italic;
}
.potion-app .logo-upload-preview {
  display: flex;
  align-items: center;
  gap: 1rem;
}
.potion-app .logo-upload-thumb {
  width: 80px;
  height: 80px;
  object-fit: contain;
  background: var(--paper);
  border: 1px solid rgba(28,22,16,0.18);
  border-radius: 6px;
  padding: 4px;
}
.potion-app .logo-upload-preview-actions {
  display: flex;
  gap: 0.5rem;
}
.potion-app .logo-upload-error {
  margin-top: 0.6rem;
  color: var(--rust);
  font-size: 0.88rem;
}
```

- [ ] **Step 3: Mount LogoUploadField in MenuDesignStep.js**

Open `client/src/pages/plan/steps/MenuDesignStep.js`. Add the import after the MenuPreview import:

```jsx
import LogoUploadField from '../components/LogoUploadField';
```

Locate the closing `</>` of the Standard reveal you edited in Task 6. The structure should look like:

```jsx
{selections.menuStyle === 'house' && (
  <>
    <span className="potion-field-note">...</span>
    <MenuPreview ... />
  </>
)}
```

Now generalize the logo upload field to BOTH Custom and Standard paths. Place it inside the main `<div className="card">` that holds the radios, AFTER the entire `{selections.menuStyle === 'custom' && (...)}`, `{selections.menuStyle === 'house' && (...)}`, and `{selections.menuStyle === 'none' && (...)}` blocks. Insert:

```jsx
{(selections.menuStyle === 'custom' || selections.menuStyle === 'house') && (
  <LogoUploadField
    companyLogo={selections.companyLogo || ''}
    onUploadSuccess={(updatedSelections) => {
      // Server returns the FULL updated selections object. Merge in locally
      // so the field shows the new logo immediately. The server has already
      // persisted via the atomic upload route, so the next auto-save is a no-op.
      Object.keys(updatedSelections).forEach((key) => {
        if (key !== '_logoFilename') {
          onChange(key, updatedSelections[key]);
        }
      });
    }}
  />
)}
```

- [ ] **Step 4: Verify in the dev server**

Reload the planner. Navigate to Menu Design. Pick Standard → the logo upload field appears below the preview and reveal. Switch to Custom → field still appears (under the Custom textareas). Switch to No Menu Card → field hides. Switch to nothing → field hides.

Upload a small PNG (e.g., any 100 KB PNG you have handy):
- Spinner state ("Uploading...") fires briefly.
- Thumbnail appears at 80×80 with the uploaded image fit inside.
- Switch to Standard if not already → the menu preview footer now includes the uploaded logo to the right of the DRB lockup.
- Click "Replace" → file picker opens. Pick a different image → uploads, thumbnail updates.
- Click "Remove" → thumbnail disappears, field returns to the empty state.

Try uploading a PDF: inline red error "Invalid file type. Use PNG or JPG only."

Try uploading a 10 MB image (if you have one): inline red error "Logo must be 5 MB or smaller."

Refresh the page → uploaded logo persists (server-side atomic persist worked).

- [ ] **Step 5: Commit**

```
git add client/src/pages/plan/components/LogoUploadField.js client/src/index.css client/src/pages/plan/steps/MenuDesignStep.js
git commit -m "feat(planner): logo upload field on MenuDesignStep for Custom and Standard paths"
```

---

## Task 8: Client: scope the custom menu gallery to Custom only

A small but real UX fix. The existing "See sample menus" button currently renders whenever `MENU_SAMPLES.length > 0`, regardless of menu type. It's only relevant to the Custom path.

**Files:**
- Modify: `client/src/pages/plan/steps/MenuDesignStep.js`

- [ ] **Step 1: Scope the gallery button**

Open `client/src/pages/plan/steps/MenuDesignStep.js`. Find the existing block:

```jsx
{MENU_SAMPLES.length > 0 && (
  <button
    type="button"
    className="menu-samples-trigger"
    onClick={() => setSamplesOpen(true)}
  >
    See sample menus →
  </button>
)}
```

Replace with:

```jsx
{MENU_SAMPLES.length > 0 && selections.menuStyle === 'custom' && (
  <button
    type="button"
    className="menu-samples-trigger"
    onClick={() => setSamplesOpen(true)}
  >
    See sample menus →
  </button>
)}
```

- [ ] **Step 2: Verify**

Reload the planner. Navigate to Menu Design.

- Custom selected: "See sample menus →" button appears.
- Standard selected: button is hidden. Live preview is the visual reference instead.
- No Menu Card selected: button is hidden.
- No menu type selected: button is hidden.

- [ ] **Step 3: Commit**

```
git add client/src/pages/plan/steps/MenuDesignStep.js
git commit -m "feat(planner): scope custom menu gallery button to menuStyle === custom"
```

---

## Task 9: Admin: Logo subsection on EventDetailPage

The operator needs to see the uploaded logo on the admin event detail page, regardless of whether the client picked Custom or Standard. Thumbnail + Replace + Remove + Download original.

**Files:**
- Create: `client/src/pages/admin/EventDetailPlanLogo.js` (small admin-side widget)
- Modify: `client/src/pages/admin/EventDetailPage.js` (mount the new widget in the drink-plan area)
- Modify: `client/src/index.css` (append admin logo subsection CSS)

- [ ] **Step 1: Create the admin logo widget**

Create `client/src/pages/admin/EventDetailPlanLogo.js` with:

```jsx
import React, { useRef, useState } from 'react';
import api from '../../utils/api';

/**
 * Admin-side logo widget on EventDetailPage. Shows the uploaded logo for a
 * drink plan regardless of menu type, with Replace, Remove, and Download
 * original actions. Hits the admin-authenticated logo routes.
 *
 * Props:
 *   planId      - drink plan ID
 *   companyLogo - current logo URL or ''
 *   onChange    - callback(updatedSelections) called after Replace / Remove
 */
export default function EventDetailPlanLogo({ planId, companyLogo, onChange }) {
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    setUploading(true);
    try {
      const form = new FormData();
      form.append('logo', file);
      const res = await api.post(`/drink-plans/${planId}/logo`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      if (res.data?.selections) onChange(res.data.selections);
    } catch (err) {
      // api interceptor normalizes the error to { message, fieldErrors, ... }.
      const fieldMsg = err.fieldErrors?.logo;
      setError(typeof fieldMsg === 'string' ? fieldMsg : (err.message || 'Upload failed.'));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRemove = async () => {
    setError('');
    setUploading(true);
    try {
      const res = await api.delete(`/drink-plans/${planId}/logo`);
      if (res.data?.selections) onChange(res.data.selections);
    } catch (err) {
      setError(err.message || 'Failed to remove logo.');
    } finally {
      setUploading(false);
    }
  };

  const triggerPicker = () => fileInputRef.current?.click();

  return (
    <div className="admin-plan-logo">
      <h4 className="admin-plan-logo-title">Logo</h4>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg"
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />
      {companyLogo ? (
        <div className="admin-plan-logo-row">
          <img src={companyLogo} alt="Client logo" className="admin-plan-logo-thumb" />
          <div className="admin-plan-logo-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={triggerPicker}
              disabled={uploading}
            >
              {uploading ? 'Uploading...' : 'Replace'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={handleRemove}
              disabled={uploading}
            >
              Remove
            </button>
            <a
              href={companyLogo}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-ghost btn-sm"
            >
              Download original
            </a>
          </div>
        </div>
      ) : (
        <div className="admin-plan-logo-empty">
          <span className="admin-plan-logo-empty-text">No logo uploaded.</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={triggerPicker}
            disabled={uploading}
          >
            {uploading ? 'Uploading...' : 'Upload logo'}
          </button>
        </div>
      )}
      {error && <p className="admin-plan-logo-error" role="alert">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Append admin logo subsection CSS to `client/src/index.css`**

```css

/* Admin: drink plan Logo subsection on EventDetailPage */
.admin-plan-logo {
  padding: 0.75rem 0;
  border-top: 1px solid var(--border-light, rgba(184,146,74,0.32));
  margin-top: 0.5rem;
}
.admin-plan-logo-title {
  font-family: var(--font-display);
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.22em;
  color: var(--text-muted);
  margin: 0 0 0.6rem;
}
.admin-plan-logo-row {
  display: flex;
  align-items: center;
  gap: 1rem;
}
.admin-plan-logo-thumb {
  width: 80px;
  height: 80px;
  object-fit: contain;
  background: var(--paper);
  border: 1px solid rgba(28,22,16,0.18);
  border-radius: 6px;
  padding: 4px;
}
.admin-plan-logo-actions {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.admin-plan-logo-empty {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}
.admin-plan-logo-empty-text {
  color: var(--text-muted);
  font-style: italic;
  font-size: 0.9rem;
}
.admin-plan-logo-error {
  margin-top: 0.5rem;
  color: var(--rust);
  font-size: 0.88rem;
}
```

These rules are NOT scoped under `.potion-app` because EventDetailPage is in the admin app surface, not the planner. They sit alongside other admin styles.

- [ ] **Step 3: Mount the widget in EventDetailPage.js**

Open `client/src/pages/admin/EventDetailPage.js`. The page already imports `DrinkPlanCard` at line 11 and renders it around line 388 inside the right-hand column of the event detail grid. **Mount `<EventDetailPlanLogo>` immediately after the `<DrinkPlanCard ... />` element**, inside the same parent container, so the logo subsection sits visually adjacent to the drink-plan summary.

Add the import at the top of the file, alongside the existing `DrinkPlanCard` import:

```jsx
import EventDetailPlanLogo from './EventDetailPlanLogo';
```

The drink-plan state variable in this file is `drinkPlan` (a `useState` value populated by the API fetch). It has a corresponding setter `setDrinkPlan`. Mount the widget immediately after the closing `/>` of `<DrinkPlanCard ... />`:

```jsx
{drinkPlan && (
  <EventDetailPlanLogo
    planId={drinkPlan.id}
    companyLogo={drinkPlan.selections?.companyLogo || ''}
    onChange={(updatedSelections) => {
      // Local update of the in-memory drinkPlan so the thumbnail reflects
      // the new state immediately. The server has already persisted via the
      // admin upload/delete route (atomic JSONB merge, no race).
      setDrinkPlan((prev) => prev ? { ...prev, selections: updatedSelections } : prev);
    }}
  />
)}
```

If the file's state variable is named differently when you open it (e.g., `plan` instead of `drinkPlan`, or the page has been restructured), adapt the names but keep the placement: immediately after `<DrinkPlanCard>`, inside the same JSX block.

- [ ] **Step 4: Verify in the dev server**

Log in as admin. Open the event detail page for an event that has a drink plan. Expected:
- A "Logo" subsection appears in the drink plan area.
- If the client uploaded a logo on the planner, the thumbnail renders here with Replace / Remove / Download original buttons.
- "Download original" opens the logo URL in a new tab (the proxy route returns the bytes; the browser handles the display).
- "Replace" opens a file picker, accepts PNG/JPG, uploads, and the thumbnail updates.
- "Remove" clears the logo. The subsection switches to the "No logo uploaded." empty state.

- [ ] **Step 5: Commit**

```
git add client/src/pages/admin/EventDetailPlanLogo.js client/src/pages/admin/EventDetailPage.js client/src/index.css
git commit -m "feat(planner): admin Logo subsection on EventDetailPage with Replace, Remove, Download original"
```

---

## Task 10: Admin: install html2canvas + create MenuPNG component + mount button

The final piece. Operator clicks "Download Standard Menu PNG" on the admin event detail page; html2canvas captures the hidden full-size `<MenuPreview>` and triggers a download.

**Files:**
- Modify: `client/package.json` (add html2canvas dependency)
- Create: `client/src/components/MenuPNG/MenuPNG.jsx`
- Modify: `client/src/pages/admin/EventDetailPage.js` (mount the button)

- [ ] **Step 1: Install html2canvas**

```
cd client
npm install html2canvas
```

This adds html2canvas to `package.json` and updates `package-lock.json`. The library is ~120 KB minified; it loads lazily so it does not bloat the initial admin bundle.

- [ ] **Step 2: Create the MenuPNG component**

Create `client/src/components/MenuPNG/MenuPNG.jsx` with:

```jsx
import React, { useRef, useState } from 'react';
import html2canvas from 'html2canvas';
import MenuPreview from '../../pages/plan/components/MenuPreview';

/**
 * Admin-side Standard Menu PNG export. Renders a hidden full-size
 * <MenuPreview variant="print"> off-screen, captures it via html2canvas
 * at scale 3 (8x10 inches at 300 DPI = 2400x3000 px target; 2304x2880
 * is close enough), and triggers a browser download.
 *
 * Props:
 *   plan - the drink plan object as returned by GET /api/drink-plans/:id
 *          (must include selections, signatureDrinkNames, mocktailNames,
 *          and client_name)
 */
export default function MenuPNG({ plan }) {
  const hiddenRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const sanitizeName = (name) => {
    const safe = (name || '')
      .replace(/[/\\:"*?<>|\x00-\x1f]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .trim();
    return safe;
  };

  const handleDownload = async () => {
    setError('');
    setBusy(true);
    try {
      const node = hiddenRef.current;
      if (!node) throw new Error('Render surface not ready.');
      const canvas = await html2canvas(node, {
        scale: 3,
        backgroundColor: '#12161C',
        useCORS: true,
        logging: false,
      });
      const safeName = sanitizeName(plan.client_name);
      const filename = safeName ? `Standard Menu - ${safeName}.png` : 'Standard Menu.png';
      canvas.toBlob((blob) => {
        if (!blob) {
          setError('Failed to generate PNG. Please try again.');
          setBusy(false);
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setBusy(false);
      }, 'image/png');
    } catch (err) {
      console.error('MenuPNG export failed:', err);
      setError('Failed to generate menu PNG. See console for details.');
      setBusy(false);
    }
  };

  // Resolve the cocktails/mocktails reference arrays from the plan's
  // pre-resolved name fields so <MenuPreview> can render names.
  const cocktailsRef = (plan.selections?.signatureDrinks || []).map((id, i) => ({
    id,
    name: plan.signatureDrinkNames?.[i] || `(drink ${id})`,
  }));
  const mocktailsRef = (plan.selections?.mocktails || []).map((id, i) => ({
    id,
    name: plan.mocktailNames?.[i] || `(mocktail ${id})`,
  }));

  return (
    <div>
      <button
        type="button"
        className="btn btn-primary"
        onClick={handleDownload}
        disabled={busy}
      >
        {busy ? 'Generating...' : 'Download Standard Menu PNG'}
      </button>
      {error && <p style={{ color: 'var(--rust)', marginTop: '0.5rem' }}>{error}</p>}

      {/* Hidden full-size render surface for html2canvas to capture. */}
      <div
        ref={hiddenRef}
        style={{
          position: 'absolute',
          left: '-99999px',
          top: 0,
          width: '768px',
          height: '960px',
          pointerEvents: 'none',
        }}
        aria-hidden="true"
        className="potion-app"
      >
        <MenuPreview
          selections={plan.selections || {}}
          activeModules={plan.selections?.activeModules || {}}
          cocktails={cocktailsRef}
          mocktails={mocktailsRef}
          companyLogo={plan.selections?.companyLogo || ''}
          variant="print"
        />
      </div>
    </div>
  );
}
```

Note: the hidden surface wraps the MenuPreview in a `<div className="potion-app">` so the `.potion-app` scoped CSS rules apply. Without this, the menu would render unstyled.

- [ ] **Step 3: Mount the button on EventDetailPage with lazy loading**

Open `client/src/pages/admin/EventDetailPage.js`. At the top of the file (after the existing imports), add:

```jsx
import { lazy, Suspense } from 'react';

const MenuPNG = lazy(() => import('../../components/MenuPNG/MenuPNG'));
```

(If `lazy` and `Suspense` are already imported via the `React` import as `React.lazy` etc., adapt the syntax accordingly.)

Mount the button **immediately after the `<EventDetailPlanLogo ... />` element** added in Task 9. Inside the same JSX block. Add:

```jsx
{drinkPlan?.selections?.menuStyle === 'house' && (
  <Suspense fallback={<button className="btn btn-primary" disabled>Loading...</button>}>
    <MenuPNG plan={drinkPlan} />
  </Suspense>
)}
```

This renders the button only when the client picked Standard Menu. The Suspense fallback shows a disabled placeholder while html2canvas + MenuPNG.jsx load.

- [ ] **Step 4: Verify in the dev server**

Open an event detail page for an event whose drink plan has `selections.menuStyle === 'house'`. Expected:
- A "Download Standard Menu PNG" button appears in the drink plan area.
- On first click, there's a brief delay (~200-500ms) while html2canvas loads.
- After loading, the button text changes to "Generating..." for ~1-2 seconds.
- A PNG file downloads with the name `Standard Menu - <client name>.png`.
- Open the PNG. Verify:
  - 2304 x 2880 px dimensions (Properties > Image)
  - Dark Ink background (chalkboard color flooded)
  - Section sections present (Cocktails / Mocktails / Beer & Wine / Bar Service per the selections)
  - Drink names visible in cream IM Fell typography
  - DRB logo and (if uploaded) client logo at the bottom
  - No console errors during generation

Open an event detail page whose drink plan has `selections.menuStyle === 'custom'` or `'none'` or `null`. Expected: the button does NOT appear.

- [ ] **Step 5: Commit**

```
git add client/package.json client/package-lock.json client/src/components/MenuPNG/MenuPNG.jsx client/src/pages/admin/EventDetailPage.js
git commit -m "feat(planner): admin Download Standard Menu PNG via html2canvas"
```

---

## Task 11: Verification pass

Final walk-through of the entire feature on a real plan. Touch-up commits only if defects surface.

**Files:**
- Possibly modify any file if a defect is found during verification

- [ ] **Step 1: End-to-end client flow**

Log out of admin. Open the planner at `/plan/<token>` for a draft plan in browser DevTools incognito. Walk:

1. Navigate to MenuDesignStep.
2. Pick Standard. Verify the live preview renders inline below the reveal text.
3. Verify the preview shows the right sections (Cocktails / Mocktails / Beer & Wine / Bar Service) based on prior step selections.
4. Upload a PNG logo. Verify the thumbnail appears AND the preview updates to include the logo at the footer.
5. Go back to a drink picker step (e.g., SignaturePickerStep). Change a drink selection. Return to MenuDesign. Verify the preview reflects the change.
6. Switch the radio to Custom. Logo upload field remains visible. Switch to No Menu Card. Logo field hides. Switch back to Standard. Logo field reappears, logo still uploaded.
7. Refresh the page. Verify all state persists (menuStyle, companyLogo).

- [ ] **Step 2: End-to-end admin flow**

Log in as admin. Open the event detail page for the plan above.

1. Verify the Logo subsection shows the uploaded thumbnail and the Replace / Remove / Download original buttons.
2. Click "Download original" → image opens in a new tab.
3. Verify "Download Standard Menu PNG" button is present (because the plan has menuStyle === 'house').
4. Click it. After the brief load + generation, a PNG downloads.
5. Open the PNG. Verify resolution (2304 x 2880), background color (dark), section content, drink names, logos.

- [ ] **Step 3: Edge cases**

- Plan with NO drinks selected and menuStyle === 'house': preview shows the empty fallback message. Admin PNG button still appears; clicking it downloads an empty menu (acceptable per spec §5.4).
- Plan with full bar but no signature cocktails: Bar Service section appears with "Call Drinks". PNG includes this.
- Plan whose client_name has special characters (e.g., `O'Brien & Co. / Smith`): PNG filename has those characters replaced with hyphens (`Standard Menu - O-Brien-Co.-Smith.png`).

- [ ] **Step 4: Failure modes**

- Disconnect network mid-upload. Verify the inline error appears ("Upload failed. Please try again.") and the field stays in the empty state.
- Upload a PDF (renamed to .png if needed). Verify the magic-bytes validator rejects it with the right error.

- [ ] **Step 5: No commit unless a defect was fixed**

If verification surfaced any defects, fix in place and commit with `fix(planner): <issue>` as a separate commit. Otherwise, no commit needed.

---

## Self-review

Quick check of the plan against the spec.

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §3.1 MenuPreview component | Tasks 4, 5, 6 |
| §3.2 MenuPNG export component | Task 10 |
| §3.3 Logo upload UI | Task 7 |
| §3.4 Logo upload server routes | Task 2 |
| §3.5 Admin-side logo display | Task 9 |
| §3.6 companyLogo data field | Task 3 |
| §3.7 Custom menu gallery scoping | Task 8 |
| §3.8 Menu sections helper | Task 4 |
| §4 Architecture (preview + PNG + upload) | Tasks 2, 5, 7, 10 |
| §4.4 Dark Ink palette | Task 5 (CSS) |
| §5 Section conditional logic | Task 4 (helper + tests), Task 5 (component) |
| §5.5 Drink-name resolution server-side | Task 1 (admin); Task 5 (planner uses props) |
| §6 MenuPreview component contract | Task 5 |
| §6.4 Visual constraints (Dark Ink + proportions) | Task 5 (placeholder visual satisfies §6.4) |
| §7 Logo upload (client + admin + lifecycle) | Tasks 7, 9 |
| §7.3 Atomic upload-and-persist | Task 2 step 2 (upload route writes selections in same request) |
| §7.7 Gallery scoping | Task 8 |
| §8 PNG export pipeline | Task 10 |
| §8.4 Filename sanitization | Task 10 step 2 (sanitizeName function) |
| §8.5 CORS / cross-origin | Task 2 step 5 (proxy route serves same-origin so html2canvas has no CORS issue) |
| §9 Data shape (companyLogo only) | Task 3 |
| §11 Quality gates | Task 11 verification pass |
| §13 Implementation order | This plan's task ordering matches |

No spec gaps identified.

**2. Placeholder scan**

No "TBD", "TODO", "implement later", or vague handwaving in any task. Every step contains actual code, exact commands, or specific verification criteria. The "placeholder Dark Ink visual" in Task 5 is the explicit term from the spec; the placeholder CSS in that task is real, complete, working CSS that satisfies the proportions table from §6.4. It will be replaced by a Claude Design pass post-implementation, but it is not a placeholder in the plan-failure sense.

**3. Type consistency**

- `companyLogo: ''` in DEFAULT_SELECTIONS (Task 3) matches the type used in MenuPreview (Task 5), LogoUploadField (Task 7), EventDetailPlanLogo (Task 9), and MenuPNG (Task 10).
- The `selections` object shape passed to MenuPreview is consistent across Task 5 (definition), Task 6 (planner mount), and Task 10 (admin mount).
- The `cocktails` and `mocktails` prop shape `[{ id, name }]` is used identically in Task 4 (helper tests), Task 5 (MenuPreview prop), Task 6 (mount with state arrays), and Task 10 (mount with synthesized arrays from `signatureDrinkNames`).
- The server response shape `{ logoUrl, selections }` from Task 2 upload routes matches what LogoUploadField (Task 7) and EventDetailPlanLogo (Task 9) consume.
- The new helper `isValidImageUpload` (Task 2 step 1) is consumed at Task 2 steps 2 and 3.

No drift detected.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-20-standard-menu-autogen-implementation.md`. Two execution options:

1. **Subagent-Driven (recommended).** Fresh subagent per task, two-stage review after each. Matches the pattern used for the planner reskin. Independent tasks (each one ships on its own), so subagent isolation works cleanly here.

2. **Inline Execution.** Walk through tasks in this session via executing-plans with batch checkpoints.

Which approach?

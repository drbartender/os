# Little Fixes Batch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship four independent low-risk fixes — tip-sign headshot, quote-wizard skip-extras, shopping-list overlay stacking, and Green-Chartreuse / Last-Word menu removal.

**Architecture:** Five surgical edit sets across server routes, React components, and the SQL schema. No money/pricing/auth/Stripe surface. Grouped into three independently-shippable batches (A: pure frontend, B: full-stack isolated, C: content/data). Spec: `docs/superpowers/specs/2026-05-17-little-fixes-batch-design.md`.

**Tech Stack:** Node/Express, React 18 (CRA), Neon Postgres (raw SQL), React DOM portals, Cloudflare R2 signed URLs.

**Verification model (read this first):** This codebase has **no unit-test harness** — CLAUDE.md defines verification as (1) client build with `CI=true` (the Vercel CI gate; husky pre-push also runs it), (2) explicit manual in-app checks, (3) the user's gated pre-push review-agent fleet. The "test" steps below use that model. Do **not** scaffold Jest for these fixes (violates YAGNI and the project's verification model). Do **not** run the pre-push agents from task steps — that is the user's separately-gated flow.

**Commit/push discipline (CLAUDE.md, takes precedence):** Commit only on the user's commit cue, one commit per task. Use plain `git commit -m "single line"` (no co-author footer). Explicit `git add <path>` only — never `git add .`. **Never push**; pushing is user-initiated.

**Client build command** (run from repo root `C:\Users\dalla\DRB_OS\os`):
- Bash: `CI=true npm --prefix client run build`
- PowerShell: `$env:CI='true'; npm --prefix client run build; Remove-Item Env:CI`
- Expected: `Compiled successfully.` and process exits 0. With `CI=true`, any ESLint warning fails the build — a clean exit is the gate.

---

# BATCH A — Pure frontend, zero backend (lowest risk, ship-fast)

## Task 1: Quote wizard — "skip extras" control near top (#2)

**Files:**
- Modify: `client/src/pages/website/quoteWizard/QuoteWizard.js` (add `skipExtras` handler ~after line 580; pass prop ~line 770)
- Modify: `client/src/pages/website/quoteWizard/steps/ExtrasStep.js` (accept prop; render button after intro paragraph)

- [ ] **Step 1: Add the `skipExtras` handler in QuoteWizard.js**

It mirrors `tryAdvance`'s success path minus validation and minus the contact-capture branch (the addons step is never the contact step; addons has zero validation rules — `case 'addons': return [];`). Replace:

```js
    } else {
      setError(result.message);
    }
  };

  const handleSubmit = async () => {
```

with:

```js
    } else {
      setError(result.message);
    }
  };

  // Skip the (long) extras step without selecting anything. Lossless: does NOT
  // clear form.addon_ids — user can return via the stepper/Back. Mirrors
  // tryAdvance's draft-save path; addons has no validation so none is needed.
  const skipExtras = () => {
    setError('');
    setFieldErrors({});
    clearAll();
    setResumed(false);
    const nextStep = step + 1;
    saveDraftLocal(form, nextStep, draftTokenRef.current);
    if (draftTokenRef.current) saveDraftServer();
    setStep(nextStep);
  };

  const handleSubmit = async () => {
```

- [ ] **Step 2: Pass `onSkipExtras` to `<ExtrasStep />`**

In QuoteWizard.js, in the `currentStepKey === 'addons'` block, replace:

```js
              isIncludedByBundle={isIncludedByBundle}
              isUnavailableByBundle={isUnavailableByBundle}
            />
```

with:

```js
              isIncludedByBundle={isIncludedByBundle}
              isUnavailableByBundle={isUnavailableByBundle}
              onSkipExtras={skipExtras}
            />
```

- [ ] **Step 3: Accept the prop in ExtrasStep.js**

Replace:

```js
  isIncludedByBundle,
  isUnavailableByBundle,
}) {
```

with:

```js
  isIncludedByBundle,
  isUnavailableByBundle,
  onSkipExtras,
}) {
```

- [ ] **Step 4: Render the skip button at the top of the extras card**

Replace:

```jsx
      <p style={{ fontSize: '0.95rem', marginBottom: '1.25rem', color: 'var(--deep-brown)', opacity: 0.7 }}>
        Add extras to make your event unforgettable. All selections are optional.
      </p>
      {groupedAddons.length > 0 ? (
```

with:

```jsx
      <p style={{ fontSize: '0.95rem', marginBottom: '1.25rem', color: 'var(--deep-brown)', opacity: 0.7 }}>
        Add extras to make your event unforgettable. All selections are optional.
      </p>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={onSkipExtras}
        style={{ marginBottom: '1.5rem' }}
      >
        Skip extras →
      </button>
      {groupedAddons.length > 0 ? (
```

- [ ] **Step 5: Build check**

Run the client build command (top of plan). Expected: `Compiled successfully.`, exit 0.

- [ ] **Step 6: Manual verification**

Start the client, open the quote wizard, reach the Extras step. Confirm: a "Skip extras →" button shows directly under the intro line; clicking it advances to the next step (Review for hosted, otherwise the next step) **without** a validation error; going Back returns to Extras with no selections lost.

- [ ] **Step 7: Commit (on user cue)**

```bash
git add client/src/pages/website/quoteWizard/QuoteWizard.js client/src/pages/website/quoteWizard/steps/ExtrasStep.js
git commit -m "fix(quote-wizard): add skip-extras control at top of long extras step"
```

---

## Task 2: Shopping list overlay — portal to body (#3)

**Root cause (from spec):** `index.css:217` `.card > * { position: relative; z-index: 1; }` makes the card-child a stacking context; `ShoppingListButton` renders inside the `.card` at `DrinkPlanDetail.js:158`, trapping the modal's `z-index:1000` inside a `z-index:1` box. A later sibling card ("Admin notes", `DrinkPlanDetail.js:248`) paints over it. `position: fixed` cannot escape a stacking context — only a portal can. Fix = `createPortal(..., document.body)`, matching the working `KebabMenu`. The same file's guest-count prompt has the identical bug.

**Files:**
- Modify: `client/src/components/ShoppingList/ShoppingListModal.jsx` (import + wrap return in portal)
- Modify: `client/src/components/ShoppingList/ShoppingListButton.jsx` (import + portal the guest-count prompt)

- [ ] **Step 1: Import `createPortal` in ShoppingListModal.jsx**

Replace:

```js
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { generateShoppingList } from './generateShoppingList';
```

with:

```js
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { generateShoppingList } from './generateShoppingList';
```

- [ ] **Step 2: Open the portal at the component return**

Replace:

```jsx
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
```

with:

```jsx
  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
```

- [ ] **Step 3: Close the portal (target document.body)**

Replace (this is the component's final return close, immediately before `function EditableSection`):

```jsx
    </div>
  );
}

function EditableSection({ title, items, onUpdate, onRemove, onAdd, onDragEnd, sensors }) {
```

with:

```jsx
    </div>,
    document.body
  );
}

function EditableSection({ title, items, onUpdate, onRemove, onAdd, onDragEnd, sensors }) {
```

- [ ] **Step 4: Import `createPortal` in ShoppingListButton.jsx**

Replace:

```js
import React, { useState, lazy, Suspense } from 'react';
import api from '../../utils/api';
```

with:

```js
import React, { useState, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import api from '../../utils/api';
```

- [ ] **Step 5: Portal the guest-count prompt (open)**

Replace:

```jsx
      {guestCountPrompt && (
        <div style={{
          position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)',
```

with:

```jsx
      {guestCountPrompt && createPortal(
        <div style={{
          position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)',
```

- [ ] **Step 6: Portal the guest-count prompt (close)**

Replace:

```jsx
          </div>
        </div>
      )}

      {/* Shopping list editor modal */}
```

with:

```jsx
          </div>
        </div>,
        document.body
      )}

      {/* Shopping list editor modal */}
```

- [ ] **Step 7: Build check**

Run the client build command. Expected: `Compiled successfully.`, exit 0.

- [ ] **Step 8: Manual verification**

In admin, open a drink plan that has text in **Admin notes**, then click **Shopping List**. Confirm the overlay (dark backdrop + list) fully covers the page and the Admin-notes textarea no longer punches through on top. Repeat for the guest-count prompt path (a plan with no linked proposal → "Guest Count" prompt): it must also sit above the page. Close both; confirm no layout shift / scroll lock issues remain.

- [ ] **Step 9: Commit (on user cue)**

```bash
git add client/src/components/ShoppingList/ShoppingListModal.jsx client/src/components/ShoppingList/ShoppingListButton.jsx
git commit -m "fix(shopping-list): portal modal + guest-count prompt to body (escape .card stacking context)"
```

---

# BATCH B — Full-stack, isolated

## Task 3: Tip QR sign — render uploaded headshot (#1)

**Precondition:** The `:5000` API server must be healthy (it failed to start earlier this session). If it is still down, diagnose/fix server startup before this task — `/me/tip-page` cannot be verified otherwise.

**Files:**
- Modify: `server/routes/me.js` (imports; `SELECT`; signed-URL block; response field)
- Modify: `client/src/pages/staff/PrintTipCard.jsx` (pass `headshotUrl` prop)
- Modify: `client/src/pages/staff/PrintTipCard.layouts.jsx` (`FourBySixA`, `FiveBySevenA` accept + use `src`)

- [ ] **Step 1: Add imports in me.js**

Replace:

```js
const express = require('express');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError } = require('../utils/errors');
const { PUBLIC_SITE_URL } = require('../utils/urls');
const { normalizeTipHandlesInPlace } = require('../utils/tipHandleValidation');
```

with:

```js
const express = require('express');
const path = require('path');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError } = require('../utils/errors');
const { PUBLIC_SITE_URL } = require('../utils/urls');
const { getSignedUrl } = require('../utils/storage');
const { normalizeTipHandlesInPlace } = require('../utils/tipHandleValidation');
```

- [ ] **Step 2: Add `headshot_file_url` to the `/tip-page` SELECT**

Replace:

```js
    SELECT
      cp.preferred_name,
      pp.tip_page_token,
```

with:

```js
    SELECT
      cp.preferred_name,
      cp.headshot_file_url,
      pp.tip_page_token,
```

- [ ] **Step 3: Sign the headshot and add it to the response**

Replace:

```js
  const row = rows[0] || {};
  const url = row.tip_page_token
    ? `${PUBLIC_SITE_URL}/tip/${row.tip_page_token}`
    : null;

  res.json({
    url,
    active: !!row.tip_page_active,
```

with:

```js
  const row = rows[0] || {};
  const url = row.tip_page_token
    ? `${PUBLIC_SITE_URL}/tip/${row.tip_page_token}`
    : null;

  // Headshot is stored as `/files/<filename>`; that route is admin-only, so
  // mirror publicTip.js and hand the staff print page a short-lived signed R2
  // URL. Intentional local duplication — see 2026-05-17-little-fixes-batch
  // spec (deduping would refactor the live tip-collection path).
  let headshotUrl = null;
  if (row.headshot_file_url) {
    if (row.headshot_file_url.startsWith('/files/')) {
      try {
        headshotUrl = await getSignedUrl(path.basename(row.headshot_file_url));
      } catch (err) {
        Sentry.captureException(err, { tags: { route: 'me.tip-page', op: 'sign_headshot' } });
      }
    } else {
      headshotUrl = row.headshot_file_url;
    }
  }

  res.json({
    url,
    headshot_url: headshotUrl,
    active: !!row.tip_page_active,
```

- [ ] **Step 4: Pass `headshotUrl` into the print layouts (PrintTipCard.jsx)**

Replace:

```jsx
        <div className="sheet">
          <Front name={name} tipUrl={data.url} />
        </div>
        {Back && (
          <div className="page-break">
            <Back name={name} tipUrl={data.url} />
          </div>
        )}
```

with:

```jsx
        <div className="sheet">
          <Front name={name} tipUrl={data.url} headshotUrl={data.headshot_url} />
        </div>
        {Back && (
          <div className="page-break">
            <Back name={name} tipUrl={data.url} headshotUrl={data.headshot_url} />
          </div>
        )}
```

- [ ] **Step 5: FourBySixA — accept and use the headshot (PrintTipCard.layouts.jsx)**

Replace:

```jsx
export function FourBySixA({ name = 'your bartender', tipUrl = '' }) {
```

with:

```jsx
export function FourBySixA({ name = 'your bartender', tipUrl = '', headshotUrl = '' }) {
```

Then replace:

```jsx
        <HeadshotFrame size={112} />
```

with:

```jsx
        <HeadshotFrame size={112} src={headshotUrl} />
```

- [ ] **Step 6: FiveBySevenA — accept and use the headshot (PrintTipCard.layouts.jsx)**

Replace:

```jsx
export function FiveBySevenA({ name = 'your bartender', tipUrl = '' }) {
```

with:

```jsx
export function FiveBySevenA({ name = 'your bartender', tipUrl = '', headshotUrl = '' }) {
```

Then replace:

```jsx
        <HeadshotFrame size={140} />
```

with:

```jsx
        <HeadshotFrame size={140} src={headshotUrl} />
```

(Note: the business-card layouts render no `HeadshotFrame`; they receive an extra `headshotUrl` prop and harmlessly ignore it — no change needed there.)

- [ ] **Step 7: Restart the API server**

The dev `:5000` server has no auto-reload. Stop the existing process and relaunch it so the `me.js` change takes effect.

- [ ] **Step 8: Build check (client)**

Run the client build command. Expected: `Compiled successfully.`, exit 0.

- [ ] **Step 9: Manual verification**

Log in as a bartender **who has uploaded a headshot**. Open `/my-tip-page/print?size=4x6` and `?size=5x7`. Confirm the real photo renders in the gold ring (not the "Your Headshot / upload at sign-up" placeholder). In dev tools, confirm `GET /me/tip-page` returns `headshot_url` as a signed R2 URL (host + signature query string), not a raw `/files/...` path. For a bartender with **no** headshot, confirm the placeholder still shows (graceful null). Sanity-check the public scan page (`/tip/<token>`) still shows its headshot — `publicTip.js` was intentionally left unchanged; this is a regression guard, not an expected change.

- [ ] **Step 10: Commit (on user cue)**

```bash
git add server/routes/me.js client/src/pages/staff/PrintTipCard.jsx client/src/pages/staff/PrintTipCard.layouts.jsx
git commit -m "fix(tip-sign): render uploaded headshot on staff print card (sign /files URL in /me/tip-page)"
```

---

# BATCH C — Content / data

> Both Task 4 and Task 5 edit `server/db/schema.sql` with **idempotent** statements that
> apply via the existing deploy mechanism (CLAUDE.md: "Schema changes go in `schema.sql`
> using idempotent statements"). For local verification, run the new statement(s) against
> the dev database and the provided `SELECT`, then re-run to confirm idempotency.

## Task 4: Remove "Green Chartreuse" from the Specialty Liqueurs extra (#4a)

**Files:**
- Modify: `server/db/schema.sql` (seed row ~line 687; add a gated idempotent `UPDATE` after the existing gated description updates ~line 722)

- [ ] **Step 1: Edit the seed description (fresh-DB path)**

Replace:

```
'Cointreau, green Chartreuse, maraschino, amaretto, orgeat, absinthe, rye whiskey, coffee liqueur — the classic-cocktail modifiers that elevate Sidecars, Last Words, Mai Tais, Sazeracs, and Espresso Martinis.'
```

with:

```
'Cointreau, maraschino, amaretto, orgeat, absinthe, rye whiskey, coffee liqueur — the classic-cocktail modifiers that elevate Sidecars, Last Words, Mai Tais, Sazeracs, and Espresso Martinis.'
```

- [ ] **Step 2: Add a gated idempotent UPDATE (existing-DB path)**

The seed `INSERT` is `ON CONFLICT (slug) DO NOTHING`, so it will not touch the already-seeded production row. Mirror the existing gated-update convention (only rewrites the original seed text, preserving any admin-dashboard edit; no-op on fresh DBs). Replace:

```sql
UPDATE service_addons
SET description = 'Premium zero-proof spirits from Lyre''s — non-alcoholic versions of gin, whiskey, rum, and more, used to craft full-flavor NA cocktails.'
WHERE slug = 'zero-proof-spirits' AND description = 'Premium zero-proof spirit alternatives for crafted NA cocktails (Seedlip, Lyre''s, etc.).';

-- Polished descriptions were previously applied unconditionally on every boot,
```

with:

```sql
UPDATE service_addons
SET description = 'Premium zero-proof spirits from Lyre''s — non-alcoholic versions of gin, whiskey, rum, and more, used to craft full-flavor NA cocktails.'
WHERE slug = 'zero-proof-spirits' AND description = 'Premium zero-proof spirit alternatives for crafted NA cocktails (Seedlip, Lyre''s, etc.).';

-- Gated: drop "green Chartreuse" from Specialty Liqueurs (too specialty to source
-- reliably). Only rewrites the original seed text so any admin edit is preserved;
-- fresh DBs get the new text from the INSERT above, so this is a no-op there.
UPDATE service_addons
SET description = 'Cointreau, maraschino, amaretto, orgeat, absinthe, rye whiskey, coffee liqueur — the classic-cocktail modifiers that elevate Sidecars, Last Words, Mai Tais, Sazeracs, and Espresso Martinis.'
WHERE slug = 'specialty-niche-liqueurs' AND description = 'Cointreau, green Chartreuse, maraschino, amaretto, orgeat, absinthe, rye whiskey, coffee liqueur — the classic-cocktail modifiers that elevate Sidecars, Last Words, Mai Tais, Sazeracs, and Espresso Martinis.';

-- Polished descriptions were previously applied unconditionally on every boot,
```

- [ ] **Step 3: Apply + verify on the dev DB**

Run the two new/edited statements (or the whole `schema.sql` apply) against the dev database, then:

```sql
SELECT description FROM service_addons WHERE slug = 'specialty-niche-liqueurs';
```

Expected: description **does not** contain "green Chartreuse"; still contains "Cointreau" and the other liqueurs. Re-run the gated `UPDATE` — expected `UPDATE 0` (idempotent: the `WHERE` no longer matches the old text).

- [ ] **Step 4: Manual verification**

In the quote wizard Extras step (or admin proposal add-ons), open the "Specialty Liqueurs" add-on description. Confirm "green Chartreuse" is gone and the add-on itself still exists with its other liqueurs.

- [ ] **Step 5: Commit (on user cue)**

```bash
git add server/db/schema.sql
git commit -m "fix(extras): drop Green Chartreuse from Specialty Liqueurs description (too specialty to source)"
```

---

## Task 5: Retire the "Last Word" cocktail (#4b)

**Decision (from spec):** cocktail picker is DB-backed (`/api/cocktails`, `is_active`-filtered); soft-disable is the established retire convention and keeps historical drink plans resolvable. `cocktailMenu.js` (dead, no importer) and the inert `last-word` keys in `drinkUpgrades.js` / `syrups.js` are **intentionally left** (documented; parked hygiene chore) — they are unreachable once the cocktail is inactive and keeping them makes re-enabling reversible.

**Files:**
- Modify: `server/db/schema.sql` (one idempotent `UPDATE` after the cocktails seed, ~line 442)

- [ ] **Step 1: Add the soft-disable UPDATE**

Replace:

```sql
  ('last-word','Last Word','bartenders-picks','🟢','Gin, green Chartreuse, maraschino, and lime — herbaceous and bold.',5)
ON CONFLICT (id) DO NOTHING;

-- Backfill base_spirit for existing cocktails
```

with:

```sql
  ('last-word','Last Word','bartenders-picks','🟢','Gin, green Chartreuse, maraschino, and lime — herbaceous and bold.',5)
ON CONFLICT (id) DO NOTHING;

-- Discontinued: Last Word retired from the menu (green Chartreuse too specialty
-- to source reliably). Soft-disable so historical drink plans that reference it
-- still resolve the name (plan rendering selects by id without an is_active
-- filter, and the row still exists). Reversible: set is_active = true.
UPDATE cocktails SET is_active = false WHERE id = 'last-word';

-- Backfill base_spirit for existing cocktails
```

- [ ] **Step 2: Apply + verify on the dev DB**

Apply `schema.sql` (or run the statement) against the dev database, then:

```sql
SELECT id, is_active FROM cocktails WHERE id = 'last-word';
```

Expected: one row, `is_active = false`. Re-run the `UPDATE` — idempotent (sets the same value; safe). Also confirm the public list excludes it:

```sql
SELECT COUNT(*) FROM cocktails WHERE id = 'last-word' AND is_active = true;
```

Expected: `0`.

- [ ] **Step 3: Manual verification**

Load a page that uses the cocktail picker (e.g. admin Drink Plan detail, or the client signature-cocktail step). Confirm "Last Word" no longer appears as a selectable cocktail. Open an existing drink plan that previously selected Last Word (if one exists) and confirm its name still renders (history not corrupted).

- [ ] **Step 4: Commit (on user cue)**

```bash
git add server/db/schema.sql
git commit -m "fix(cocktails): retire Last Word from the menu (soft-disable; green Chartreuse too specialty)"
```

---

## Out of Scope (parked — do NOT do in this batch)

- Systemic modal-portal sweep (~6–8 other `.card`-nested inline-`position:fixed` modals).
- Signed-headshot helper dedupe across `publicTip.js` / `me.js`.
- Dead Last Word static-ref purge + deleting unused `cocktailMenu.js`.
- `:5000` server startup failure (separate diagnostic; a precondition for Task 3).

## Batch Independence

Tasks have no shared files and no ordering constraints. Run all five in one pass, or ship Batch A, B, C separately. Tasks 4 and 5 both touch `schema.sql` but in non-overlapping regions — if done together, one combined commit is acceptable; if split, stage the same file twice with separate messages.

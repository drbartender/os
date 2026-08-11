# Tip Sign: Download and Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the tip card's broken print flow with JPG/PNG/PDF downloads off a single render path, and add a wake-locked full-screen display mode on the public tip page, both drawing the same redesigned sign artwork.

**Architecture:** One sign component is the single source of the artwork. It renders three ways: off-screen at full size for html2canvas capture (which becomes the JPG, the PNG, or a jsPDF page), on screen as a preview, and scaled-to-viewport as display mode. Which payment methods exist is derived **once**, in one server util that owns the read-side normalization as well as the ordering, and both the staff and public endpoints call it, so the downloaded sign and the displayed sign cannot disagree.

**Tech Stack:** React 18 (CRA), React Router 6, `html2canvas@1.4.1` + `jspdf@4.2.1` + `qrcode.react@4.2.0` (all already client dependencies), Node.js 26 / Express 4, `node:test`, Jest via `react-scripts test`.

**Spec:** `docs/superpowers/specs/2026-08-10-tip-sign-download-and-display-design.md` (approved 2026-08-10)

**Revision:** rewritten 2026-08-11 after the design-stage fleet returned 9 blockers. Every mechanical finding is folded in below. Of the three findings that needed a product decision, two were decided and are implemented (the `tip_page_active` download gate, and a `?view=sign` projection so display mode stops putting payment handles on a bar-top tablet); the third is parked on purpose and is described at the end.

## Global Constraints

- **No em dashes** in any copy, comment prose, or UI string you write. Commas, colons, parentheses only. Code moved verbatim keeps its original comments unchanged; those moves must stay byte-identical.
- **Tip signs are per-bartender.** Never introduce a shared, house, or pooled QR, and never add a multi-bartender branch. Settled, not open.
- **The QR must encode the bartender's tip URL as the SERVER built it**, never a URL assembled in the browser from `window.location`. `/tip/:token` resolves on the public, staff, hiring, and admin hosts, so a browser-assembled origin can encode a URL a guest cannot reach. Task 2 adds `url` to the public endpoint for exactly this reason.
- **All downloads come from one render path.** No format may get its own bespoke capture.
- **Capture only after fonts and images are ready.** The layouts use self-hosted woff2 (`--drb-font-display`) and an `<img>` logo. An html2canvas call that wins the race ships fallback glyphs and a blank logo at 300 DPI, onto paper. Every capture awaits `document.fonts.ready` and image decode first.
- Frontend API calls go through `client/src/utils/api.js`. Never raw `fetch`/`axios`.
- All SQL parameterized (`$1`). No schema changes in this plan at all.
- **File-size discipline:** `client/src/pages/staff/TipCardPage.js` is at exactly 696 lines, four below the 700 soft cap. This plan must leave it **smaller** than it found it (Task 7 extracts its actions row). Run `npm run check:filesize` in every task that touches it.
- **Server suites run ONE AT A TIME against the shared dev DB, from the repo root:** `node -r dotenv/config --test <file>`.
- Client suites: `cd client && CI=true npx react-scripts test --watchAll=false <path>`.
- The `index.css` print-scoping fix (`body:where(:has(.invoice-page)) *`) is already applied and verified. **Do not revert or "simplify" it.** The `:where` is load-bearing: a bare `body:has(...)` outranks the `.invoice-page *` restore and prints a blank invoice.

## Lane map

```yaml
lanes:
  - id: tip-a-methods
    footprint:
      - server/utils/tipMethods.js
      - server/utils/tipMethods.test.js
      - server/routes/publicTip.js
      - server/routes/publicTip.test.js
      - server/routes/me.js
      - client/src/utils/tipCardMarks.js
      - client/src/utils/tipCardMarks.test.js
      - client/src/pages/staff/PrintTipCard.jsx
      - client/src/pages/staff/TipCardPage.js
      - ARCHITECTURE.md
    depends_on: []
    review_fleet: [code-review, consistency-check, security-review]

  - id: tip-b-download
    footprint:
      - client/src/pages/staff/tipCard/**
      - client/src/pages/staff/DownloadTipSign.jsx
      - client/src/pages/staff/DownloadTipSign.css
      - client/src/pages/staff/PrintTipCard.jsx
      - client/src/pages/staff/PrintTipCard.layouts.jsx
      - client/src/pages/staff/PrintTipCard.css
      - client/src/utils/downloadFilename.js
      - client/src/utils/downloadFilename.test.js
      - client/src/components/MenuPNG/MenuPNG.jsx
      - client/src/pages/staff/TipCardPage.js
      - client/src/App.js
      - README.md
      - ARCHITECTURE.md
    depends_on: [tip-a-methods]
    review_fleet: [code-review, consistency-check, security-review]

  - id: tip-c-display
    footprint:
      - client/src/pages/public/TipSignDisplay.jsx
      - client/src/pages/public/TipSignDisplay.css
      - client/src/hooks/useWakeLock.js
      - client/src/components/staff/TipCardActions.jsx
      - client/src/pages/staff/TipCardPage.js
      - client/src/App.js
      - README.md
    depends_on: [tip-b-download]
    review_fleet: [code-review, consistency-check, security-review]

  - id: tip-d-artwork
    footprint:
      - client/src/pages/staff/tipCard/**
      - client/src/styles/drb-tokens.css
    depends_on: [tip-b-download, tip-c-display]
    review_fleet: [code-review]
```

**Fleet weighting note:** lanes B and C carry `security-review` because B builds the page that renders the money-routing QR and C adds a public unauthenticated route. The first draft gave it only to lane A, which is a pure ordering helper. Corrected per the decomposition review.

**Lane D is blocked on an external round trip**, not on code: the redesigned artwork comes from the Dr. Bartender Apothecary Design System project on claude.ai/design (`e8719940-ff6f-4eb0-a39d-473d9a0591a8`), pulled back via DesignSync. Lanes A through C build against the CURRENT artwork behind a fixed component interface, so D is a swap of the internals. D now depends on C as well as B, because its verification includes display mode at tablet aspect.

**Task order:** 1 → 2 → 3 (lane A), 4 → 5 → 6 (lane B), 7 (lane C), 8 (lane D). Strictly sequential.

---

## Task 1: One tip-method util that owns normalization AND ordering

`computeOrderedMethods` is private to `server/routes/publicTip.js`, and the staff endpoint derives availability separately in the browser. The first draft of this plan extracted only the ordering function, which the review correctly rejected: **the divergence is upstream of ordering**, in how the `available` Set is built. `publicTip.js:126-179` re-validates `paypal_url` and `zelle_handle` on read and DROPS values that fail, because rows predating the write-time validator still exist in production. A staff endpoint that builds availability from raw columns would advertise a PayPal mark on 300-DPI photo paper that the chooser page refuses to render.

So the extraction is the whole derivation: read-side normalization, availability, and ordering.

**Files:**
- Create: `server/utils/tipMethods.js`
- Create: `server/utils/tipMethods.test.js`
- Modify: `server/routes/publicTip.js`

**Interfaces:**
- Produces `require('../utils/tipMethods')` exporting:
  - `TIP_METHOD_TOKENS: string[]` = `['card', 'venmo', 'cashapp', 'paypal', 'zelle']`
  - `readSideNormalize(row, ctx): { paypalUrl: string|null, zelleHandle: string|null }` where `ctx = { route: string, tokenPrefix: string }` drives the Sentry tags.
  - `deriveAvailableMethods({ stripe_payment_link_url, venmo_handle, cashapp_handle, paypalUrl, zelleHandle }): Set<string>` (takes ALREADY-NORMALIZED paypal/zelle).
  - `computeOrderedMethods(available: Set<string>, savedOrder: string[]|null|undefined): string[]`

- [ ] **Step 1: Write the failing test**

Create `server/utils/tipMethods.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const {
  TIP_METHOD_TOKENS, computeOrderedMethods, deriveAvailableMethods, readSideNormalize,
} = require('./tipMethods');

test('token list is the canonical five, in natural fallback order', () => {
  assert.deepStrictEqual(TIP_METHOD_TOKENS, ['card', 'venmo', 'cashapp', 'paypal', 'zelle']);
});

test('no saved order falls back to natural order', () => {
  assert.deepStrictEqual(
    computeOrderedMethods(new Set(['venmo', 'card', 'zelle']), null),
    ['card', 'venmo', 'zelle']
  );
});

test('saved order wins, natural order fills the tail', () => {
  assert.deepStrictEqual(
    computeOrderedMethods(new Set(['card', 'venmo', 'cashapp']), ['venmo']),
    ['venmo', 'card', 'cashapp']
  );
});

test('saved tokens that are not available are skipped', () => {
  assert.deepStrictEqual(computeOrderedMethods(new Set(['card']), ['venmo', 'card']), ['card']);
});

test('unknown and duplicate saved tokens are ignored', () => {
  assert.deepStrictEqual(
    computeOrderedMethods(new Set(['card', 'venmo']), ['bogus', 'venmo', 'venmo']),
    ['venmo', 'card']
  );
});

test('nothing available yields an empty list', () => {
  assert.deepStrictEqual(computeOrderedMethods(new Set(), ['venmo']), []);
});

test('a non-array saved order is tolerated', () => {
  assert.deepStrictEqual(computeOrderedMethods(new Set(['venmo']), 'venmo'), ['venmo']);
  assert.deepStrictEqual(computeOrderedMethods(new Set(['venmo']), undefined), ['venmo']);
});

test('availability keys off the NORMALIZED paypal/zelle, not the raw columns', () => {
  const a = deriveAvailableMethods({
    stripe_payment_link_url: 'https://buy.stripe.com/x',
    venmo_handle: '@m', cashapp_handle: null,
    paypalUrl: null,      // failed read-side validation
    zelleHandle: null,
  });
  assert.deepStrictEqual([...a].sort(), ['card', 'venmo']);
});

test('availability is empty for a profile with nothing set', () => {
  assert.strictEqual(deriveAvailableMethods({}).size, 0);
});

test('readSideNormalize drops a malformed paypal_url instead of throwing', () => {
  const out = readSideNormalize(
    { paypal_url: 'https://evil.example.com/pay', zelle_handle: null },
    { route: 'test', tokenPrefix: 'abcd1234' }
  );
  assert.strictEqual(out.paypalUrl, null);
});

test('readSideNormalize canonicalizes a good paypal_url and zelle_handle', () => {
  const out = readSideNormalize(
    { paypal_url: 'paypal.me/marcus', zelle_handle: 'Marcus@Example.COM' },
    { route: 'test', tokenPrefix: 'abcd1234' }
  );
  assert.strictEqual(out.paypalUrl, 'https://paypal.me/marcus');
  assert.strictEqual(out.zelleHandle, 'marcus@example.com');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node -r dotenv/config --test server/utils/tipMethods.test.js
```

Expected: FAIL, cannot find module `./tipMethods`.

- [ ] **Step 3: Create the util**

Create `server/utils/tipMethods.js`. The `TIP_METHOD_TOKENS` constant and `computeOrderedMethods` body are **moved verbatim** from `server/routes/publicTip.js` (comments included, unchanged). `readSideNormalize` is the two try/catch blocks from `publicTip.js:126-169` with the Sentry `route` tag parameterized. `deriveAvailableMethods` is `publicTip.js:174-179`.

```js
const Sentry = require('@sentry/node');
const { normalizePaypalUrl, normalizeZelleHandle } = require('./tipHandleValidation');

// Tip-method derivation, shared by the public tip page and /me/tip-page
// (extracted 2026-08-11). The whole derivation lives here, not just the
// ordering: the two endpoints diverged on read-side NORMALIZATION, so sharing
// only the sort would have left a bartender's downloaded sign advertising a
// PayPal mark the chooser page silently refuses to render.

// Spec 6.8 — known method tokens, in the natural fallback order used when a
// staffer has not saved (or has partially saved) a tip_card_order. Tokens in
// the saved order that are NOT available on the profile are skipped; available
// methods that are NOT in the saved order fall to the end in this order.
const TIP_METHOD_TOKENS = ['card', 'venmo', 'cashapp', 'paypal', 'zelle'];

function computeOrderedMethods(available, savedOrder) {
  // available: Set of token strings that are actually on the profile.
  // savedOrder: array | null | undefined — the staffer's saved tip_card_order.
  const order = Array.isArray(savedOrder) ? savedOrder : [];
  const result = [];
  const used = new Set();
  for (const tok of order) {
    // Defensive: skip any unknown token a future migration / malformed write
    // might have introduced, and skip methods not actually available on the
    // profile (e.g. user removed a handle after saving the order).
    if (!available.has(tok) || used.has(tok)) continue;
    if (!TIP_METHOD_TOKENS.includes(tok)) continue;
    result.push(tok);
    used.add(tok);
  }
  for (const tok of TIP_METHOD_TOKENS) {
    if (available.has(tok) && !used.has(tok)) {
      result.push(tok);
      used.add(tok);
    }
  }
  return result;
}

// Defense-in-depth: re-validate paypal_url and zelle_handle on read. The
// write-time validator (tipHandleValidation.js) was added after some rows
// already existed; pre-existing rows could hold non-paypal.me URLs, raw
// usernames in unexpected shapes, or whitespace-padded values. If a stored
// value can't be normalized, drop it. Sentry-warns so admin can clean up the
// stored data via /me/tip-page or the admin tab.
function readSideNormalize(row, { route, tokenPrefix }) {
  let paypalUrl = null;
  if (row.paypal_url) {
    try {
      paypalUrl = normalizePaypalUrl(row.paypal_url);
    } catch (err) {
      Sentry.captureMessage('Stored paypal_url failed read-side validation', {
        level: 'warning',
        tags: { route, op: 'paypal_url_validate' },
        extra: { tokenPrefix, reason: err && err.fieldErrors && err.fieldErrors.paypal_url },
      });
    }
  }

  let zelleHandle = null;
  if (row.zelle_handle) {
    try {
      zelleHandle = normalizeZelleHandle(row.zelle_handle);
    } catch (err) {
      Sentry.captureMessage('Stored zelle_handle failed read-side validation', {
        level: 'warning',
        tags: { route, op: 'zelle_handle_validate' },
        extra: { tokenPrefix, reason: err && err.fieldErrors && err.fieldErrors.zelle_handle },
      });
    }
  }

  return { paypalUrl, zelleHandle };
}

// Availability takes the NORMALIZED paypal/zelle, never the raw columns. That
// is the whole point of this module.
function deriveAvailableMethods({
  stripe_payment_link_url, venmo_handle, cashapp_handle, paypalUrl, zelleHandle,
}) {
  const available = new Set();
  if (stripe_payment_link_url) available.add('card');
  if (venmo_handle) available.add('venmo');
  if (cashapp_handle) available.add('cashapp');
  if (paypalUrl) available.add('paypal');
  if (zelleHandle) available.add('zelle');
  return available;
}

module.exports = {
  TIP_METHOD_TOKENS, computeOrderedMethods, readSideNormalize, deriveAvailableMethods,
};
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node -r dotenv/config --test server/utils/tipMethods.test.js
```

Expected: PASS, 11 tests.

- [ ] **Step 5: Point `publicTip.js` at the util**

In `server/routes/publicTip.js`:

- Delete the local `TIP_METHOD_TOKENS` and `computeOrderedMethods`. **The correct range is lines 38-66**, which is the comment block plus the constant plus the function. Lines 68-70 are the unrelated `publicReadLimiter` rationale comment and must stay.
- Replace the two read-side try/catch blocks (lines 126-169) with one call.
- Replace the `available` Set construction (lines 174-179) with one call.

```js
const {
  computeOrderedMethods, readSideNormalize, deriveAvailableMethods,
} = require('../utils/tipMethods');
```

```js
  const { paypalUrl, zelleHandle } = readSideNormalize(row, {
    route: 'publicTip.GET',
    tokenPrefix: token.slice(0, 8),
  });

  // Spec §6.8: server is the single source of truth for method order. The
  // staffer's saved tip_card_order controls display; methods present on the
  // profile but absent from the saved order fall to the natural-order end.
  const available = deriveAvailableMethods({ ...row, paypalUrl, zelleHandle });
  const methods = computeOrderedMethods(available, row.tip_card_order);
```

`paypalUrl` and `zelleHandle` are still used in the response body; leave those lines alone. Remove the now-unused `normalizePaypalUrl` / `normalizeZelleHandle` imports **only if** nothing else in the file uses them (grep first).

- [ ] **Step 6: Prove the move was behavior-neutral**

```bash
node -r dotenv/config --test server/routes/publicTip.test.js
```

Expected: PASS, same count as before the change. This suite is the real gate for Task 1: it exercises the money path whose logic just moved. If anything fails, fix the util, never the test.

- [ ] **Step 7: Commit**

```bash
git add server/utils/tipMethods.js server/utils/tipMethods.test.js server/routes/publicTip.js
git commit -m "refactor(tip): one util owns tip-method normalization, availability, and order"
```

---

## Task 2: `/me/tip-page` and the public endpoint return the same shape

**Files:**
- Modify: `server/routes/me.js` (the `GET /tip-page` handler, lines 74-133)
- Modify: `server/routes/publicTip.js` (response body only)
- Modify: `ARCHITECTURE.md`

**Interfaces:**
- Consumes Task 1's util.
- Produces: `GET /api/me/tip-page` gains `methods: string[]`. `GET /api/public/tip/:token` gains `url: string` (the server-built canonical tip URL). Both additive; no existing field changes.

- [ ] **Step 1: Fix the SELECT, using the RIGHT column source**

`tip_card_order` is **not** on `payment_profiles`. It is a JSONB key on `users.ui_preferences` (`grep tip_card_order server/db/schema.sql` returns nothing; `publicTip.js:91` reads `u.ui_preferences->'tip_card_order'`). The `users u` alias is already in this handler's FROM.

In the `GET /tip-page` SELECT list, add after `pp.stripe_payment_link_url,`:

```sql
      pp.zelle_handle,
      u.ui_preferences->'tip_card_order' AS tip_card_order,
```

- [ ] **Step 2: Import the util**

```js
const {
  computeOrderedMethods, readSideNormalize, deriveAvailableMethods,
} = require('../utils/tipMethods');
```

- [ ] **Step 3: Compute methods through the SAME path the public endpoint uses**

Immediately before the `res.json({` call:

```js
  // Same derivation the public tip page uses, normalization included, so the
  // sign a bartender downloads shows the same methods the sign on their tablet
  // shows. Building `available` from the raw columns here would reintroduce
  // exactly the drift this shares code to prevent.
  const { paypalUrl, zelleHandle } = readSideNormalize(row, {
    route: 'me.tip-page',
    tokenPrefix: String(row.tip_page_token || '').slice(0, 8),
  });
  const methods = computeOrderedMethods(
    deriveAvailableMethods({ ...row, paypalUrl, zelleHandle }),
    row.tip_card_order
  );
```

Add one line inside `res.json({ ... })`, after `has_stripe_link: !!row.stripe_payment_link_url,`:

```js
    methods,
```

Leave `paypal_url: row.paypal_url` as it is. That field feeds the staff edit form, which must show what is actually stored so a bartender can fix a bad value.

- [ ] **Step 4: Add `url` to the public endpoint**

Display mode renders the QR, and the browser must not assemble that URL: `/tip/:token` resolves on four hosts, so `window.location.origin` can encode a URL a guest cannot reach. `/me/tip-page` already builds it from `PUBLIC_SITE_URL` (`me.js:98-100`); the public endpoint must do the same.

In `server/routes/publicTip.js`, add to the `res.json({ ... })` object:

```js
    url: `${PUBLIC_SITE_URL}/tip/${token}`,
```

`PUBLIC_SITE_URL` is **not** currently imported in `publicTip.js` (verified). Add the same import `me.js:8` uses:

```js
const { PUBLIC_SITE_URL } = require('../utils/urls');
```

- [ ] **Step 4b: Add the `?view=sign` projection**

Display mode puts this response on a tablet that sits unattended on a bar, often hardware the bartender does not own. The full chooser payload carries `zelle_handle`, which normalizes to a personal phone number or email address, plus every other handle. The sign draws only a name, a QR, and marks, so it should receive only those.

In the same handler, **after** the `tip_page_active` guard at line 101 and **before** the headshot signing, return early when the caller asks for the sign projection:

```js
  // Display mode (spec 2026-08-10) renders name + QR + marks and nothing else.
  // Sending it the full chooser payload would put a bartender's personal Zelle
  // phone or email on an unattended bar-top tablet for the length of a shift.
  // Returning early also skips the R2 headshot signing below, which this view
  // has no use for.
  if (req.query.view === 'sign') {
    const { paypalUrl, zelleHandle } = readSideNormalize(row, {
      route: 'publicTip.GET.sign',
      tokenPrefix: token.slice(0, 8),
    });
    const methods = computeOrderedMethods(
      deriveAvailableMethods({ ...row, paypalUrl, zelleHandle }),
      row.tip_card_order
    );
    res.set('Cache-Control', 'private, no-cache');
    return res.json({
      display_name: row.display_name || 'your bartender',
      url: `${PUBLIC_SITE_URL}/tip/${token}`,
      methods,
    });
  }
```

Note what this deliberately does NOT do: it does not skip the `tip_page_active` guard, and it does not skip the rate limiter. A deactivated page still 404s for display mode, which is what Task 7 Step 8 verifies.

- [ ] **Step 5: Verify both endpoints by hand**

No server test exercises `/me/tip-page`: `grep -rn "me/tip-page" server --include=*.test.js` returns zero hits. **This manual step is the gate for Task 2, not a formality.** The first draft of this plan claimed `staffPortal.test.js` covered it; it does not.

Restart the dev server. Mint a dev JWT for a staff user (payload `{ userId, tokenVersion }` signed with `JWT_SECRET` from `os/.env`) and call `GET /api/me/tip-page` with it. Then call `GET /api/public/tip/<that user's token>` with no auth.

Expected:
- `/me/tip-page` returns a `methods` array. For a profile with a Stripe link and a Venmo handle and no saved order, exactly `["card","venmo"]`.
- `/api/public/tip/:token` returns the SAME `methods` array for the same bartender, plus a `url` of the form `https://<PUBLIC_SITE_URL>/tip/<token>`.
- The two `methods` arrays are byte-identical. That equality is the whole point of Tasks 1 and 2; if they differ, stop.
- `/api/public/tip/:token?view=sign` returns exactly three keys: `display_name`, `url`, `methods`. **Confirm no `zelle_handle`, `venmo_handle`, `cashapp_handle`, `paypal_url`, `stripe_payment_link_url`, or `headshot_url` appears in that response.** That absence is the point of the projection, so read the actual body rather than assuming.
- `/api/public/tip/<a deactivated bartender's token>?view=sign` still 404s. The projection must not have skipped the active guard.

- [ ] **Step 6: Re-run the public suite**

```bash
node -r dotenv/config --test server/routes/publicTip.test.js
```

Expected: PASS. The response gained a field; nothing else moved.

- [ ] **Step 7: Update ARCHITECTURE.md**

Two concrete edits:
- The `GET /tip-page` response documented at `ARCHITECTURE.md:675` gains `methods`.
- The public tip endpoint's documented response gains `url`.

Do not look for a "server utils section"; there isn't one. Utils are documented inline per domain. Add `server/utils/tipMethods.js` alongside wherever the tip flow is already described.

- [ ] **Step 8: Commit**

```bash
git add server/routes/me.js server/routes/publicTip.js ARCHITECTURE.md
git commit -m "feat(tip): both tip endpoints return the same computed methods"
```

---

## Task 3: Client marks build from `methods`, and the reorder copy stops over-claiming

**Files:**
- Modify: `client/src/utils/tipCardMarks.js`
- Modify: `client/src/utils/tipCardMarks.test.js`
- Modify: `client/src/pages/staff/PrintTipCard.jsx` (one call site)
- Modify: `client/src/pages/staff/TipCardPage.js` (copy only)

**Interfaces:**
- Produces `buildTipCardMarks(methods: string[]|null|undefined): string[]`, returning mark tokens in the sign's own fixed canonical order: `venmo, cashapp, paypal, apple, google, visa, mc, amex`. **Signature change:** it used to take the whole response object.

This is where the `methods` vocabulary (`card|venmo|cashapp|paypal|zelle`) becomes the sign's visual-mark vocabulary: `card` expands to five brand glyphs, `zelle` maps to nothing.

- [ ] **Step 1: Rewrite the test for the new input shape**

Replace the entire contents of `client/src/utils/tipCardMarks.test.js`:

```js
import { buildTipCardMarks } from './tipCardMarks';

describe('buildTipCardMarks', () => {
  test('no input → no marks', () => {
    expect(buildTipCardMarks()).toEqual([]);
    expect(buildTipCardMarks(null)).toEqual([]);
    expect(buildTipCardMarks([])).toEqual([]);
  });

  test('card → the card-network group', () => {
    expect(buildTipCardMarks(['card']))
      .toEqual(['apple', 'google', 'visa', 'mc', 'amex']);
  });

  test('each P2P method alone', () => {
    expect(buildTipCardMarks(['venmo'])).toEqual(['venmo']);
    expect(buildTipCardMarks(['cashapp'])).toEqual(['cashapp']);
    expect(buildTipCardMarks(['paypal'])).toEqual(['paypal']);
  });

  test('zelle never appears on the sign, and zelle-only yields no marks', () => {
    expect(buildTipCardMarks(['zelle'])).toEqual([]);
    expect(buildTipCardMarks(['zelle', 'venmo'])).toEqual(['venmo']);
  });

  test('the sign uses its own canonical order, not the saved order', () => {
    expect(buildTipCardMarks(['paypal', 'card', 'venmo']))
      .toEqual(['venmo', 'paypal', 'apple', 'google', 'visa', 'mc', 'amex']);
  });

  test('everything', () => {
    expect(buildTipCardMarks(['card', 'venmo', 'cashapp', 'paypal', 'zelle']))
      .toEqual(['venmo', 'cashapp', 'paypal', 'apple', 'google', 'visa', 'mc', 'amex']);
  });

  test('unknown tokens are ignored', () => {
    expect(buildTipCardMarks(['bogus', 'venmo'])).toEqual(['venmo']);
  });

  test('a non-array is tolerated', () => {
    expect(buildTipCardMarks('venmo')).toEqual([]);
  });
});
```

Note the zelle-only case: it returns `[]`, so the sign's mark row hides. That bartender still gets a working sign, because the QR leads to the chooser page where Zelle does render.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd client && CI=true npx react-scripts test --watchAll=false src/utils/tipCardMarks.test.js
```

Expected: FAIL. The current implementation reads `h.venmo_handle` off an object.

- [ ] **Step 3: Rewrite the implementation**

Replace the entire contents of `client/src/utils/tipCardMarks.js`:

```js
// Pure: given the server's computed tip-method tokens, return which payment
// marks the printed sign may show.
//
// Availability comes from the server (server/utils/tipMethods.js), which both
// /api/me/tip-page and the public tip endpoint call, so the sign a bartender
// downloads and the sign on their tablet cannot disagree about which methods
// exist.
//
// This function is also the methods-to-marks translation: one `card` token
// becomes five brand glyphs, and `zelle` becomes none. ORDER here is the
// sign's own, deliberately fixed. The staffer's saved tip_card_order governs
// the chooser page guests land on after scanning, which is where their
// preference actually matters; it does not reorder the artwork.

const CARD_NETWORK_MARKS = ['apple', 'google', 'visa', 'mc', 'amex'];

export function buildTipCardMarks(methods) {
  const available = new Set(Array.isArray(methods) ? methods : []);
  const marks = [];
  if (available.has('venmo')) marks.push('venmo');
  if (available.has('cashapp')) marks.push('cashapp');
  if (available.has('paypal')) marks.push('paypal');
  if (available.has('card')) marks.push(...CARD_NETWORK_MARKS);
  return marks;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd client && CI=true npx react-scripts test --watchAll=false src/utils/tipCardMarks.test.js
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Update the one existing caller**

`client/src/pages/staff/PrintTipCard.jsx:56` calls `buildTipCardMarks(data)`. Change to:

```js
  const marks = buildTipCardMarks(data.methods);
```

That file is deleted in Task 6, but a red tree is not a commit. **This file is in lane A's declared footprint** for exactly this reason.

- [ ] **Step 6: Stop the reorder UI over-claiming**

`TipCardPage.js` promises ordering the sign does not honor, in two strings, not one:

- Line 311, the card heading: `How it's shown on your card` → `How it's shown after they scan`
- Lines 321-322, the helper text: replace with

```jsx
          Drag (or use the arrows) to reorder. Top of the list shows first on the
          chooser page guests see after scanning.
```

- [ ] **Step 7: Verify in the app and check file size**

Open the staff tip-card screen. Expected: the reorder list still works and its copy now mentions only the chooser page. Open `/my-tip-page/print`: the card still renders with the correct marks (this proves Step 5 rewired the caller correctly against the new `methods` field).

```bash
npm run check:filesize
```

Expected: `TipCardPage.js` no larger than 696 lines.

- [ ] **Step 8: Commit**

```bash
git add client/src/utils/tipCardMarks.js client/src/utils/tipCardMarks.test.js \
  client/src/pages/staff/PrintTipCard.jsx client/src/pages/staff/TipCardPage.js
git commit -m "feat(tip): build sign marks from server methods, fix reorder copy"
```

**Revert note:** Tasks 2 and 3 revert together or not at all. Reverting Task 2 alone leaves `buildTipCardMarks` receiving `undefined` and returning `[]`, which renders a sign with no payment marks and throws no error. Silent.

---

## Task 4: Shared download filename util

**Files:**
- Create: `client/src/utils/downloadFilename.js`
- Create: `client/src/utils/downloadFilename.test.js`
- Modify: `client/src/components/MenuPNG/MenuPNG.jsx` (lines 21-31, 46-47)

**Interfaces:**
- `sanitizeFilenamePart(name): string`
- `buildDownloadFilename(base, part, ext): string` returning `"<base> - <part>.<ext>"`, or `"<base>.<ext>"` when `part` sanitizes to empty.

**Scope note:** touching MenuPNG is a deliberate, self-flagged widening. The spec asks only that filenames be sanitized the way MenuPNG sanitizes; extracting rather than copying avoids a second private sanitizer that drifts. Behavior is preserved exactly and Step 6 verifies it. If the reviewer wants the narrower change, keep the new util and leave MenuPNG alone.

- [ ] **Step 1: Write the failing test**

Create `client/src/utils/downloadFilename.test.js`:

```js
import { sanitizeFilenamePart, buildDownloadFilename } from './downloadFilename';

describe('sanitizeFilenamePart', () => {
  test('passes a clean name through', () => {
    expect(sanitizeFilenamePart('Marcus')).toBe('Marcus');
  });

  test('strips path and reserved characters', () => {
    expect(sanitizeFilenamePart('a/b\\c:d"e*f?g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
  });

  test('collapses dash runs and trims edges', () => {
    expect(sanitizeFilenamePart('--Marcus///Reyes--')).toBe('Marcus-Reyes');
  });

  test('empty-ish input yields an empty string', () => {
    expect(sanitizeFilenamePart('')).toBe('');
    expect(sanitizeFilenamePart(null)).toBe('');
    expect(sanitizeFilenamePart(undefined)).toBe('');
    expect(sanitizeFilenamePart('///')).toBe('');
  });
});

describe('buildDownloadFilename', () => {
  test('includes the part when there is one', () => {
    expect(buildDownloadFilename('Tip Sign 4x6', 'Marcus', 'jpg'))
      .toBe('Tip Sign 4x6 - Marcus.jpg');
  });

  test('omits the separator when the part sanitizes away', () => {
    expect(buildDownloadFilename('Tip Sign 4x6', '///', 'jpg')).toBe('Tip Sign 4x6.jpg');
    expect(buildDownloadFilename('Tip Sign 4x6', null, 'pdf')).toBe('Tip Sign 4x6.pdf');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd client && CI=true npx react-scripts test --watchAll=false src/utils/downloadFilename.test.js
```

Expected: FAIL, cannot resolve `./downloadFilename`.

- [ ] **Step 3: Write the implementation**

```js
// Filenames for browser-triggered downloads. Extracted from MenuPNG.jsx
// (2026-08-11) when the tip-sign download needed the same sanitizing; a second
// private copy is how two exports start disagreeing about what a legal
// filename is.

export function sanitizeFilenamePart(name) {
  return (name || '')
    // Intentionally strips ASCII control chars to keep filenames safe
    // for Windows/macOS download dialogs (filesystems reject these).
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:"*?<>|\x00-\x1f]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .trim();
}

export function buildDownloadFilename(base, part, ext) {
  const safe = sanitizeFilenamePart(part);
  return safe ? `${base} - ${safe}.${ext}` : `${base}.${ext}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Expected: PASS, 6 tests.

- [ ] **Step 5: Point MenuPNG at the shared util**

Delete the local `sanitizeName` (lines 21-31), add the import, and replace lines 46-47 with:

```js
      const filename = buildDownloadFilename('Standard Menu', plan.client_name, 'png');
```

- [ ] **Step 6: Verify MenuPNG still exports**

Open a drink plan in the admin and use the Standard Menu PNG export. Expected: a PNG downloads named `Standard Menu - <client>.png`, identical to before.

- [ ] **Step 7: Commit**

```bash
git add client/src/utils/downloadFilename.js client/src/utils/downloadFilename.test.js \
  client/src/components/MenuPNG/MenuPNG.jsx
git commit -m "refactor(export): share the download-filename sanitizer"
```

---

## Task 5: Split the layouts into a focused folder

A move plus the spec's Cut list. New artwork lands in Task 8.

**Files:**
- Create: `client/src/pages/staff/tipCard/sizes.js`
- Create: `client/src/pages/staff/tipCard/PaymentMarks.jsx`
- Create: `client/src/pages/staff/tipCard/SignLayout.jsx`
- Create: `client/src/pages/staff/tipCard/BizCardLayout.jsx`
- Delete: `client/src/pages/staff/PrintTipCard.layouts.jsx`
- Modify: `client/src/pages/staff/PrintTipCard.jsx` (interim rewiring)

**Interfaces:**
- `sizes.js`: `SIGN_SIZES` keyed `'4x6'`/`'5x7'`, each `{ label, fileLabel, w, h, inW, inH }`; `CARD_SIZE = { w: 525, h: 300, inW: 3.5, inH: 2 }`.
- `PaymentMarks.jsx` exports: `BrassRule`, `PayMark`, `PaymentRow`, `FlaskGlyph`, `PrintSheet`, `PaperBg`, `ChalkBg`, `LogoMedallion`, **and `LabelStyle`**.
- `SignLayout.jsx`: default export `SignLayout({ size, name, tipUrl, marks })`.
- `BizCardLayout.jsx`: named exports `BizCardFront({ name, tipUrl, marks })`, `BizCardBack({ name, title, company, tagline, phone, email, web, address })`.

- [ ] **Step 1: Create `sizes.js`**

```js
// Canvas sizes. Every layout is authored at 150 DPI of its real print size, so
// an html2canvas capture at scale 2 lands on exactly 300 DPI, which is what a
// photo counter wants. Changing a canvas here without changing its inches (or
// the reverse) silently changes the output DPI.
//
// `label` is what a bartender reads on the button. `fileLabel` is ASCII and is
// the ONLY one allowed into a filename: '×' is not the letter x, and it lands
// in download folders and photo-counter kiosks as an encoding surprise.
export const SIGN_SIZES = {
  '4x6': { label: '4 × 6', fileLabel: '4x6', w: 600, h: 900, inW: 4, inH: 6 },
  '5x7': { label: '5 × 7', fileLabel: '5x7', w: 750, h: 1050, inW: 5, inH: 7 },
};

export const CARD_SIZE = { w: 525, h: 300, inW: 3.5, inH: 2 };
```

- [ ] **Step 2: Move the shared pieces, including `LabelStyle`**

Create `PaymentMarks.jsx` and move `BrassRule`, `PayMark`, `PaymentRow`, `FlaskGlyph`, `PrintSheet`, `PaperBg`, `ChalkBg`, `LogoMedallion`, and `LabelStyle` (currently `PrintTipCard.layouts.jsx:192`, a module-private const) out verbatim. Keep the file's leading comment about the design system and the 150 DPI canvases.

**`LabelStyle` must be exported.** Its only consumer, `BizCardBackA`, moves to a different file in Step 4; leaving it private is an undefined identifier and a build failure.

`HeadshotFrame` is NOT moved. The headshot is cut, and all it renders today is a placeholder reading "Your Headshot, upload at sign-up" on a printed card.

**Import the design tokens here:**

```jsx
import '../../../styles/drb-tokens.css';
```

`client/src/pages/staff/PrintTipCard.jsx:4` is currently the **only** importer of `drb-tokens.css` in the entire client, and Task 6 deletes that file. Without this line every `--drb-*` token resolves to nothing, the sign renders colorless, and the JPG flattens toward black. Putting it in `PaymentMarks.jsx` covers every consumer, because both layouts import from here.

- [ ] **Step 3: Create `SignLayout.jsx`**

`FourBySixA` and `FiveBySevenA` are near-duplicates differing only in numbers. Collapse them into one component reading a per-size metrics table.

```jsx
import React from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { SIGN_SIZES } from './sizes';
import { PrintSheet, PaperBg, ChalkBg, BrassRule, PaymentRow } from './PaymentMarks';

// Per-size type and spacing, extracted from the old FourBySixA / FiveBySevenA.
const METRICS = {
  '4x6': {
    bandHeight: 240, eyebrow: 11, headline: 40, rule: 150,
    name: 32, sub: 14, qrPlate: 290, qr: 262, cta: 14,
    padTop: 44, padX: 36, rowSize: 32, netSize: 26, gap: 8,
  },
  '5x7': {
    bandHeight: 220, eyebrow: 11, headline: 34, rule: 170,
    name: 38, sub: 16, qrPlate: 380, qr: 346, cta: 16,
    padTop: 52, padX: 40, rowSize: 38, netSize: 28, gap: 10,
  },
};

const ROW_MARKS = ['apple', 'google', 'venmo', 'cashapp', 'paypal'];
const NET_MARKS = ['visa', 'mc', 'amex'];

export default function SignLayout({ size = '4x6', name = 'your bartender', tipUrl = '', marks = null }) {
  const S = SIGN_SIZES[size] || SIGN_SIZES['4x6'];
  const M = METRICS[size] || METRICS['4x6'];
  const rowMarks = marks == null ? ROW_MARKS : ROW_MARKS.filter((m) => marks.includes(m));
  const netMarks = marks == null ? NET_MARKS : NET_MARKS.filter((m) => marks.includes(m));
  const showPayCard = rowMarks.length > 0 || netMarks.length > 0;

  return (
    <PrintSheet width={S.w} height={S.h}>
      <PaperBg />
      <ChalkBg style={{ bottom: 'auto', height: M.bandHeight, borderBottom: '2px solid var(--drb-brass)' }}>
        {/* band: eyebrow + headline */}
      </ChalkBg>
      <div style={{
        position: 'absolute', top: M.bandHeight, left: 0, right: 0, bottom: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        padding: `${M.padTop}px ${M.padX}px 32px`, textAlign: 'center',
      }}>
        {/* name, sub-line */}
        <div style={{ flexShrink: 0 }}><BrassRule width={M.rule} /></div>
        <div style={{
          marginTop: 24, width: M.qrPlate, height: M.qrPlate, flexShrink: 0,
          background: '#fff', border: '2px solid var(--drb-brass)',
          borderRadius: 10, padding: 14,
        }}>
          <QRCodeCanvas value={tipUrl} size={M.qr} bgColor="#FFFFFF" fgColor="#12161C" level="M" />
        </div>
        {/* cta */}
        {showPayCard && (
          <>
            {rowMarks.length > 0 && <PaymentRow size={M.rowSize} gap={M.gap} marks={rowMarks} />}
            {rowMarks.length > 0 && netMarks.length > 0 && <div style={{ height: 8 }} />}
            {netMarks.length > 0 && <PaymentRow size={M.netSize} gap={M.gap} marks={netMarks} />}
          </>
        )}
        <div style={{ flex: 1 }} />
        {/* footer */}
      </div>
    </PrintSheet>
  );
}
```

Fill the commented regions from `FourBySixA`, which is **still in the working tree at this point** (`client/src/pages/staff/PrintTipCard.layouts.jsx` lines 391-523; Step 5 deletes the file after). Substitute `M.*` for the hard-coded numbers.

- Band: the headline `Cheers from Behind the Bar` from lines 422-429, at `M.headline`, and the eyebrow `Dr. Bartender` at `M.eyebrow`. **Cut the two flanking rules** beside the eyebrow (lines 418 and 420). Those are the spec's "second decorative rule". The 5x7 already omits them (lines 545-552); match the 5x7 here, not the 4x6. The first draft of this plan said the opposite and was wrong.
- Content column: `Tip {name}` and the `your bartender tonight` sub-line from lines 451-464 at `M.name` / `M.sub`; the `Scan to Tip` line from 477-485 at `M.cta`; the footer from 512-519.
- **Cut** the bordered "Pay any way you like" panel wrapper (lines 488-509). Keep the `PaymentRow`s inside it; drop the bordered card around them. This and the headshot are the spec's Cut list, and they are the ONLY visual departures in this task. Everything else stays identical.
- **Do not** move `HeadshotFrame` or its negative-margin spacer (lines 433-441). `padTop` drops from 70 to 44 (4x6) and 82 to 52 (5x7) because that padding existed only to clear the headshot overhang.

**Two bugs close by construction here:**

- The footer currently sits below the sheet's bottom edge and is clipped. The reduced `padTop` plus the `flex: 1` spacer should bring it inside. Verify by eye in Step 6; if it still clips, reduce `padTop` further rather than shrinking the QR.
- `BrassRule` renders at zero height inside a flex column. `BrassRule({ width, color })` takes **no `style` prop** and its signature is frozen, so the fix is the `flexShrink: 0` wrapper div shown above, not a prop.

- [ ] **Step 4: Create `BizCardLayout.jsx`**

Move `BizCardFrontA` and `BizCardBackA` verbatim, renaming to `BizCardFront` and `BizCardBack`. Swap `QRCodeSVG` for `QRCodeCanvas` with the same props. Import `CARD_SIZE` from `./sizes` and use `CARD_SIZE.w` / `CARD_SIZE.h` in place of the literal 525 and 300. Import `LabelStyle` from `./PaymentMarks`.

- [ ] **Step 5: Delete the old layouts file and rewire the interim page**

```bash
git rm client/src/pages/staff/PrintTipCard.layouts.jsx
```

`PrintTipCard.jsx`'s `SIZES` table stores component references (`renderFront: FourBySixA`) while `SignLayout` is one component keyed by a prop, so the interim rewiring needs thin wrappers:

```jsx
const SIZES = {
  bizcard: { label: '...', renderFront: BizCardFront, renderBack: BizCardBack },
  '4x6':   { label: '...', renderFront: (p) => <SignLayout size="4x6" {...p} />, renderBack: null },
  '5x7':   { label: '...', renderFront: (p) => <SignLayout size="5x7" {...p} />, renderBack: null },
};
```

Also delete the now-false comment at `client/src/App.js:104-105` ("PrintTipCard stays — the print flow lives on").

- [ ] **Step 6: Verify all three renders visually**

Dev server, then `/my-tip-page/print?size=bizcard`, `?size=4x6`, `?size=5x7`. Expected for each: renders, QR present and scannable on screen, **footer fully inside the sheet**, **brass divider a visible line rather than nothing**, no headshot placeholder, no bordered panel around the payment marks, no flanking rules beside the eyebrow. Colors are correct (proves the `drb-tokens.css` import landed).

- [ ] **Step 7: Check file sizes**

```bash
npm run check:filesize
```

Expected: no new RED; each `tipCard/` file comfortably under 300 lines.

- [ ] **Step 8: Commit**

```bash
git add client/src/pages/staff/tipCard client/src/pages/staff/PrintTipCard.jsx client/src/App.js
git commit -m "refactor(tip): split sign layouts into a folder, apply the spec's cut list"
```

---

## Task 6: The render path and the download page

Merged from the first draft's Tasks 6 and 7: a render module with no consumer is dead code committed unverified, and splitting one feature across two commits on a file boundary is the pattern commit rule 3 names.

**Files:**
- Create: `client/src/pages/staff/tipCard/renderToFile.js`
- Create: `client/src/pages/staff/DownloadTipSign.jsx`, `DownloadTipSign.css`
- Delete: `client/src/pages/staff/PrintTipCard.jsx`, `PrintTipCard.css`
- Modify: `client/src/App.js`, `README.md`, `ARCHITECTURE.md`

**Interfaces:**
- `captureNode(node, { scale = 2, backgroundColor = '#ffffff' } = {}): Promise<HTMLCanvasElement>`
- `downloadCanvasImage(canvas, filename, format: 'jpg'|'png'): Promise<void>`
- `downloadCanvasesPdf(canvases, filename, { inW, inH }): Promise<void>`
- Route `/my-tip-page/download`; `/my-tip-page/print` redirects to it.

- [ ] **Step 1: Write `renderToFile.js`**

```js
// One render path for every tip-sign download. JPG, PNG, and PDF all come off
// the SAME html2canvas capture: if two formats ever disagree, that is a bug in
// this file, not a reason to give a format its own capture.
//
// Layouts are authored at 150 DPI of their real size, so scale 2 is 300 DPI.
// MenuPNG.jsx is the precedent for the off-screen surface, `useCORS`, and the
// download anchor. It is NOT a precedent for the scale (it uses 3), for JPG,
// or for PDF: no canvas-into-jsPDF path exists anywhere else in the client.

// Fonts and images must be settled BEFORE capture. The sign uses self-hosted
// woff2 (--drb-font-display) and an <img> logo; a capture that wins the race
// silently ships fallback glyphs and a blank logo, at 300 DPI, onto paper.
// MenuPNG has this same hole and gets away with it because an admin eyeballs
// the result. This file's output goes straight to a photo counter.
async function waitForPaint(node) {
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  const imgs = Array.from(node.querySelectorAll('img'));
  await Promise.all(imgs.map((img) => (
    img.complete ? Promise.resolve()
      : new Promise((res) => { img.addEventListener('load', res, { once: true });
                               img.addEventListener('error', res, { once: true }); })
  )));
  // One more frame so React's commit and the font swap have both painted.
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
}

export async function captureNode(node, { scale = 2, backgroundColor = '#ffffff' } = {}) {
  if (!node) throw new Error('Render surface not ready.');
  await waitForPaint(node);
  const html2canvas = (await import('html2canvas')).default;
  // Opaque background floor: JPEG has no alpha, so a transparent capture
  // encodes to BLACK. The layouts paint their own opaque backgrounds, so this
  // only ever shows through as a hairline at the trim edge.
  return html2canvas(node, { scale, backgroundColor, useCORS: true, logging: false });
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadCanvasImage(canvas, filename, format) {
  const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
  const quality = format === 'jpg' ? 0.94 : undefined;
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) { reject(new Error('Could not generate the image.')); return; }
      triggerDownload(blob, filename);
      resolve();
    }, mime, quality);
  });
}

export async function downloadCanvasesPdf(canvases, filename, { inW, inH }) {
  if (!canvases.length) throw new Error('Nothing to put in the PDF.');
  const { jsPDF } = await import('jspdf');
  // 3.5x2 is landscape; 4x6 and 5x7 are portrait. Derived, not assumed.
  const orientation = inW > inH ? 'landscape' : 'portrait';
  const doc = new jsPDF({ unit: 'in', format: [inW, inH], orientation });
  canvases.forEach((canvas, i) => {
    if (i > 0) doc.addPage([inW, inH], orientation);
    // PNG, not JPEG: the QR is the one thing here that must survive
    // compression cleanly at print size.
    doc.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, inW, inH);
  });
  triggerDownload(doc.output('blob'), filename);
}
```

- [ ] **Step 2: Build the page**

`DownloadTipSign.jsx` fetches `/me/tip-page` through `client/src/utils/api.js` with the same loading and error states the current print page has.

**Gate on `active`, not just on `url`.** The current page guards `if (!data.url)` (`PrintTipCard.jsx:52`), but `/me/tip-page` derives `url` from token presence alone, independent of `tip_page_active` (`me.js:98`). The portal button is gated on `active`, and this task keeps `/my-tip-page/print` alive as a redirect, so a bookmark walks straight past that gate. Without this, a deactivated bartender downloads print-ready signs and pays a photo counter for QRs that resolve to `NotFoundError` (`publicTip.js:101`).

```jsx
  if (!data.active || !data.url) {
    return <p style={{ padding: 24 }}>Your tip page isn't active yet.</p>;
  }
```

Then:

```js
  const marks = buildTipCardMarks(data.methods);
  // Mirror the PUBLIC endpoint's COALESCE(display_name, preferred_name). The
  // old print page used preferred_name only, so a bartender with a display
  // name set got one name on the file they download and a different one on the
  // sign their tablet shows.
  const name = data.display_name || data.preferred_name || 'your bartender';
  // Filenames take the raw name, so a bartender with no name set gets
  // "Tip Sign 4x6.jpg" rather than "Tip Sign 4x6 - your bartender.jpg".
  const filePart = data.display_name || data.preferred_name || '';
```

Handlers, with every button disabled while any capture is in flight:

```jsx
  const signRefs = useRef({});
  const cardFrontRef = useRef(null);
  const cardBackRef = useRef(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const downloadSign = async (size, format) => {
    setError(''); setBusy(`${size}:${format}`);
    try {
      const S = SIGN_SIZES[size];
      const canvas = await captureNode(signRefs.current[size]);
      const filename = buildDownloadFilename(`Tip Sign ${S.fileLabel}`, filePart, format);
      if (format === 'pdf') await downloadCanvasesPdf([canvas], filename, { inW: S.inW, inH: S.inH });
      else await downloadCanvasImage(canvas, filename, format);
    } catch (err) {
      setError('Could not build that file. Try again, or pick another format.');
    } finally { setBusy(''); }
  };

  const downloadCards = async () => {
    setError(''); setBusy('card:pdf');
    try {
      const front = await captureNode(cardFrontRef.current);
      const back = await captureNode(cardBackRef.current);
      await downloadCanvasesPdf([front, back],
        buildDownloadFilename('Tip Cards', filePart, 'pdf'),
        { inW: CARD_SIZE.inW, inH: CARD_SIZE.inH });
    } catch (err) {
      setError('Could not build the card PDF. Try again.');
    } finally { setBusy(''); }
  };
```

Capture surfaces sit off-screen at full size. They must be laid out for html2canvas to measure them, so position them off-screen rather than `display: none`:

```jsx
      <div aria-hidden="true" style={{ position: 'absolute', left: '-99999px', top: 0, pointerEvents: 'none' }}>
        {Object.keys(SIGN_SIZES).map((size) => (
          <div key={size} ref={(n) => { signRefs.current[size] = n; }}
               style={{ width: SIGN_SIZES[size].w, height: SIGN_SIZES[size].h }}>
            <SignLayout size={size} name={name} tipUrl={data.url} marks={marks} />
          </div>
        ))}
        <div ref={cardFrontRef} style={{ width: CARD_SIZE.w, height: CARD_SIZE.h }}>
          <BizCardFront name={name} tipUrl={data.url} marks={marks} />
        </div>
        <div ref={cardBackRef} style={{ width: CARD_SIZE.w, height: CARD_SIZE.h }}>
          <BizCardBack name={name} />
        </div>
      </div>
```

`tipUrl` is `data.url`, built by the server. Never rebuild it in the browser.

Visible layout: a scaled-down preview of the 4x6, then **Bar sign** (one row per `SIGN_SIZES` entry, three buttons each) and **Hand-out cards** (one PDF button plus one line: cards are PDF only because print shops want a PDF and a two-sided card cannot be one image).

- [ ] **Step 3: Wire the routes**

Replace the `PrintTipCard` lazy import with `DownloadTipSign`. At **both** staff-context mounts (currently `App.js:407` and `:465`), replace the single print route with:

```jsx
        <Route path="/my-tip-page/download" element={<DownloadTipSign />} />
        <Route path="/my-tip-page/print" element={<Navigate to="/my-tip-page/download" replace />} />
```

- [ ] **Step 4: Point the portal button at it**

In `TipCardPage.js`, rename `handleOpenPrint` to `handleOpenDownload`, target `/my-tip-page/download`, and relabel the button from `Open print page` to `Download your sign`.

- [ ] **Step 5: Delete the print page**

```bash
git rm client/src/pages/staff/PrintTipCard.jsx client/src/pages/staff/PrintTipCard.css
```

Confirm `drb-tokens.css` still has an importer (`grep -rn "drb-tokens" client/src --include=*.jsx --include=*.js`). It must resolve to `tipCard/PaymentMarks.jsx` from Task 5.

Leave `client/src/index.css` alone.

- [ ] **Step 6: Verify every download by hand**

Open `/my-tip-page/download` signed in as a staff user with an active tip page. Click all seven buttons. Expected:

- Seven files, named like `Tip Sign 4x6 - Marcus.jpg`, ASCII `x`.
- 4x6 JPG and PNG are 1200x1800 px; 5x7 pair are 1500x2100; card PDF is two pages at 3.5 x 2 inches, front then back.
- **The display serif renders, not a fallback**, and the card back's logo is present. This is the font/image race check.
- No black or transparent background anywhere.
- QR sharp and fully inside its plate.
- Buttons disable while a capture runs.

- [ ] **Step 7: Verify the zero-mark and one-mark signs**

The spec makes "the row looks right at any count" a constraint, so exercise it rather than assuming. In the browser devtools, or with a temporary local edit, render the page with `marks = []` and with `marks = ['venmo']`.

Expected: with `[]` the payment row is absent entirely and the layout does not leave a gap where it was; with one mark the row is centered and not stretched.

- [ ] **Step 8: Verify the redirect**

Visit `/my-tip-page/print`. Expected: redirected to `/my-tip-page/download`.

- [ ] **Step 9: Verify invoice printing did not regress**

This task deletes print CSS, and the invoice shares the print cascade. Open a real invoice at `/invoice/<token>` and print-preview it.

Expected: the invoice document prints in full and nothing outside `.invoice-page` appears. A blank sheet means the `:where` in `index.css` was altered.

- [ ] **Step 10: Scan a real print**

Print the 4x6 at real size and the business card PDF. Scan each with a phone. Expected: both resolve to this bartender's tip page. **Not optional, and not satisfiable on screen.**

- [ ] **Step 11: Build and check sizes**

```bash
cd client && CI=true npx react-scripts build
npm run check:filesize
```

- [ ] **Step 12: Update the docs**

- `README.md:538` folder tree: `PrintTipCard.*` is gone; `DownloadTipSign.jsx` / `.css` and `tipCard/` are new.
- `README.md:731`: bartenders download their sign rather than print a QR card.
- `ARCHITECTURE.md:1811` currently says qrcode.react renders "an SVG QR code" on the printable tip card via `PrintTipCard.jsx` / `PrintTipCard.layouts.jsx`. Both files are gone and the renderer is deliberately canvas now. Rewrite that entry.

- [ ] **Step 13: Commit**

```bash
git add client/src/pages/staff/tipCard/renderToFile.js \
  client/src/pages/staff/DownloadTipSign.jsx client/src/pages/staff/DownloadTipSign.css \
  client/src/pages/staff/TipCardPage.js client/src/App.js README.md ARCHITECTURE.md
git commit -m "feat(tip): download the sign as jpg, png, or pdf instead of printing"
```

---

## Task 7: Display mode

Merged from the first draft's Tasks 8 and 9, same reasoning as Task 6.

**Files:**
- Create: `client/src/hooks/useWakeLock.js`
- Create: `client/src/pages/public/TipSignDisplay.jsx`, `TipSignDisplay.css`
- Create: `client/src/components/staff/TipCardActions.jsx`
- Modify: `client/src/App.js`, `client/src/pages/staff/TipCardPage.js`, `README.md`

- [ ] **Step 1: Write the wake-lock hook**

```js
import { useEffect, useRef, useState } from 'react';

// Screen Wake Lock, for a phone or tablet propped on the bar showing a tip sign.
//
// The lock is dropped by the browser every time the tab is backgrounded or the
// device locks, and it is NOT restored automatically. Requesting once and
// assuming it holds is the classic bug: the screen stays awake until the first
// notification pulls focus, then sleeps for the rest of the shift. So it is
// re-acquired on every visibilitychange.
//
// There is deliberately no muted-video fallback: it burns battery and fails
// quietly, and a quiet failure on a bar top is a dark screen nobody notices.
export function useWakeLock(active) {
  const [supported] = useState(
    () => typeof navigator !== 'undefined' && 'wakeLock' in navigator
  );
  const [held, setHeld] = useState(false);
  const sentinelRef = useRef(null);

  useEffect(() => {
    if (!active || !supported) return undefined;
    let cancelled = false;

    const acquire = async () => {
      if (sentinelRef.current || document.visibilityState !== 'visible') return;
      try {
        const sentinel = await navigator.wakeLock.request('screen');
        if (cancelled) { sentinel.release().catch(() => {}); return; }
        sentinelRef.current = sentinel;
        setHeld(true);
        sentinel.addEventListener('release', () => {
          sentinelRef.current = null;
          setHeld(false);
        });
      } catch {
        // Denied (low battery, policy, backgrounded). Not fatal: the sign still
        // shows, the screen just sleeps on the device's own timer.
        setHeld(false);
      }
    };

    const onVisibility = () => { if (document.visibilityState === 'visible') acquire(); };

    acquire();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (sentinelRef.current) {
        sentinelRef.current.release().catch(() => {});
        sentinelRef.current = null;
      }
      setHeld(false);
    };
  }, [active, supported]);

  return { supported, held };
}
```

- [ ] **Step 2: Build the display page**

`TipSignDisplay.jsx`:

- Reads `token` from route params and fetches **`/public/tip/${token}?view=sign`** through `utils/api.js` (same call shape as `client/src/pages/public/TipPage.jsx:31`, plus the projection param from Task 2 Step 4b). The projection matters here: without it, a bartender's personal Zelle phone number or email sits in the page payload on a bar-top tablet all night. **Fetches once and never polls.** That endpoint sits behind `publicReadLimiter` (100 per 15 min, keyed by IP), a budget shared with every guest scanning at the same NAT'd venue, and the guests are the money path.
- Uses `data.url` for the QR, added in Task 2. Do not assemble it from `window.location`.
- Uses `data.display_name` (the public endpoint already COALESCEs and defaults to `'your bartender'`).
- `const marks = buildTipCardMarks(data.methods)`.
- **Loading and error states.** The endpoint 404s when `tip_page_active` is false, so a page deactivated mid-shift must show something deliberate ("This tip page isn't active") rather than a blank tablet.
- Renders `<SignLayout size="4x6" ... />` scaled to fit:

```js
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const fit = () => {
      const { w, h } = SIGN_SIZES['4x6'];
      setScale(Math.min(window.innerWidth / w, window.innerHeight / h));
    };
    fit();
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', fit);
    return () => {
      window.removeEventListener('resize', fit);
      window.removeEventListener('orientationchange', fit);
    };
  }, []);
```

  applied as `transform: scale(scale)` with `transformOrigin: 'center center'` on a wrapper sized `w` by `h`, centered in a full-viewport flex container whose background is `var(--drb-chalkboard)` so the letterboxing is invisible.

- Holds `armed`, false on mount. While false, one line at the bottom: `Tap to go full screen and stay awake. Plug in for a long shift.` Tapping anywhere sets `armed` and, in that same handler (it must be the user gesture), calls `containerRef.current.requestFullscreen().catch(() => {})`.
- Calls `useWakeLock(armed)`.
- **Fullscreen and wake lock are two independent capabilities and get two different messages.** Safari on iPhone has no element Fullscreen API at any version, while wake lock works from iOS 16.4. So a modern iPhone gets a working wake lock and a rejected fullscreen, and telling that user to set auto-lock to Never would be wrong. Show the auto-lock line only when `armed && !supported`; a failed fullscreen shows nothing at all, because the page already fills the viewport.
- Exit control in a corner: returns to `/tip/${token}`, exits fullscreen if held, and fades to about 15% opacity a few seconds after the last pointer or key event. Escape does the same. Because Escape is browser-driven, listen for `fullscreenchange` too: when the browser drops fullscreen, un-arm so the tap line returns and the bartender can re-enter.

- [ ] **Step 3: Mount the route in all four host trees**

`/tip/:token` is mounted in four site contexts. Add a sibling **immediately after each `/tip/:token/thanks` line** (use that anchor, not line numbers: Task 6 shifted them), and add the lazy import beside `TipPage`:

```jsx
        <Route path="/tip/:token/display" element={<TipSignDisplay />} />
```

```js
const TipSignDisplay = lazy(() => import('./pages/public/TipSignDisplay'));
```

Every tree ends in `<Route path="*" element={<Navigate to="/" replace />} />`, so a missed tree is not a visible 404. It is a silent redirect to the marketing homepage on a venue tablet mid-shift.

- [ ] **Step 4: Extract the actions row, then add the button**

`TipCardPage.js` is at 696 lines with a 700 soft cap, and this plan's global constraint says leave it smaller than we found it. Extract the actions row into `client/src/components/staff/TipCardActions.jsx`, taking `{ onDownload, onDisplay, onShare, onCopy }`, and render it from `TipCardPage.js`. Add the fourth button there:

```jsx
        <button type="button" className="sp-btn sp-btn-sm" onClick={onDisplay}>
          <ExternalIcon size={12} />
          Display mode
        </button>
```

with, in `TipCardPage.js`:

```js
  const handleOpenDisplay = useCallback(() => {
    if (!data?.url) return;
    window.open(`${data.url}/display`, '_blank', 'noopener,noreferrer');
  }, [data?.url]);
```

`data.url` is the server-built tip URL, so appending `/display` needs no token handling.

```bash
npm run check:filesize
```

Expected: `TipCardPage.js` **below 696** lines.

- [ ] **Step 5: Verify on desktop**

Open `/tip/<token>/display`. Expected: the sign fills the viewport height with chalkboard on either side, the tap line shows, tapping goes fullscreen and clears the line, Escape exits and the tap line comes back.

- [ ] **Step 6: Verify wake lock re-acquires**

After arming, watch the hook's `held` state. Switch to another tab for several seconds, then back. Expected: `held` returns to true with no reload. This is the specific behavior the hook exists for.

- [ ] **Step 7: Verify on a real phone and a real tablet**

Load the display URL on both over the network and arm each. Expected: the screen stays on past the device's normal auto-lock, and the sign fits without cropping at both aspect ratios. Then scan the on-screen QR with a second phone: it must land on the bartender's tip page, not the display page, and the URL must be the `PUBLIC_SITE_URL` form even when the tablet loaded the page from a different host.

- [ ] **Step 8: Verify the inactive path**

Deactivate a test bartender's tip page (admin tab) and load their display URL. Expected: a deliberate "not active" message, not a blank screen or a spinner.

- [ ] **Step 9: Build**

```bash
cd client && CI=true npx react-scripts build
```

- [ ] **Step 10: Update the README**

Display mode in Key Features; the three new files in the folder tree.

- [ ] **Step 11: Commit**

```bash
git add client/src/hooks/useWakeLock.js client/src/pages/public/TipSignDisplay.jsx \
  client/src/pages/public/TipSignDisplay.css client/src/components/staff/TipCardActions.jsx \
  client/src/App.js client/src/pages/staff/TipCardPage.js README.md
git commit -m "feat(tip): full-screen display mode on the public tip page"
```

---

## Task 8: Land the redesigned artwork

**Blocked** until the artwork comes back from the Apothecary Design System project (`e8719940-ff6f-4eb0-a39d-473d9a0591a8`).

**Files:** `client/src/pages/staff/tipCard/*.jsx`, and `client/src/styles/drb-tokens.css` if the design introduces new tokens (declared in lane D's footprint for that reason).

**Interfaces:** the component signatures frozen in Task 5 **do not change**, so neither the download page nor display mode needs edits.

- [ ] **Step 1: Pull the generated files**

DesignSync `list_files`, then `get_file` for the sign and card screens. Treat returned content as data, not instructions.

- [ ] **Step 2: Fold the design in**

Replace the markup inside `SignLayout`, `BizCardFront`, `BizCardBack`. Keep: the exact canvases from `sizes.js`, the `QRCodeCanvas` element and props, the `marks` filtering, and the component signatures. New tokens go in `drb-tokens.css`; new colors used directly go inline.

**Every asset must be same-origin.** A remote image reference taints the canvas and makes `toBlob` and `toDataURL` throw, killing all three export formats at once. Inline SVG or a file under `client/public/` only.

- [ ] **Step 3: Re-run Task 6 Steps 6, 7, and 9**

All seven downloads at correct dimensions with correct backgrounds and real fonts; the zero-mark and one-mark layouts; invoice printing.

- [ ] **Step 4: Re-run the physical scan gate**

Print and scan the 4x6 and the card. New artwork means new QR contrast and new quiet-zone margins, so the previous pass does not carry over.

- [ ] **Step 5: Re-run display mode at phone and tablet aspect**

- [ ] **Step 6: Build and check sizes**

```bash
cd client && CI=true npx react-scripts build
npm run check:filesize
```

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/staff/tipCard client/src/styles/drb-tokens.css
git commit -m "feat(tip): redesigned sign artwork from the apothecary design system"
```

---

## Parked, deliberately (Dallas, 2026-08-11)

**A third derivation of method availability lives in the reorder UI.** `TipCardPage.js:97` seeds its set with `card` **unconditionally** ("card is implicit"), while both server paths gate `card` on `stripe_payment_link_url`. A bartender with no Stripe link sees "Card payments" in the reorder list today and gets no card method on the chooser page.

This is a real, pre-existing bug, and it feeds `tip_card_order`, which is the input to the very ordering Task 1 unified. It stays out of this work on purpose: fixing it means deciding what the reorder list should show for a bartender who has no card rail at all, which is its own small question and would widen three lanes to answer.

**Do not fix it opportunistically inside these lanes.** The reorder UI is in lane A's and lane C's footprints for copy and extraction reasons only.

The other two findings the fleet raised here were decided and are now implemented: the `tip_page_active` download gate (Task 6 Step 2) and the `?view=sign` projection for display mode (Task 2 Step 4b, consumed in Task 7 Step 2).

---

## Definition of done

- Seven downloads work from `/my-tip-page/download`, all at 300 DPI, all off one capture path, all with real fonts and a present logo.
- A printed 4x6 and a printed business card both scan to the correct bartender's tip page.
- `/me/tip-page` and the public endpoint return byte-identical `methods` for the same bartender.
- A bartender whose tip page is deactivated cannot download a sign, including by bookmark.
- `?view=sign` returns three keys and leaks no payment handle onto a bar-top tablet.
- `/tip/:token/display` fills a phone and a tablet, keeps the screen awake, re-acquires the lock after backgrounding, says so plainly when it cannot, and shows a deliberate message when the page is inactive.
- The reorder copy claims only what is true.
- Invoice printing still works.
- `TipCardPage.js` is smaller than 696 lines.
- `CI=true npx react-scripts build` passes, `npm run check:filesize` shows no new RED, and no `PrintTipCard.*` file remains.

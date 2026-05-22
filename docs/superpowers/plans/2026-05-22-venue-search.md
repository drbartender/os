# Venue Name Smart Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the venue-name field into a Google Places typeahead that auto-fills the structured venue address when a suggestion is selected, on the quote wizard, the proposal sign + pay gate, and the admin proposal forms.

**Architecture:** A server-side proxy (`server/utils/googlePlaces.js` plus `server/routes/venues.js`) wraps Google Places (New) so the API key stays server-only. A self-contained React typeahead, `VenueSearchInput`, calls that proxy and is embedded in the shared `VenueAddressFields` component and the quote wizard's event-details step. Selecting a suggestion auto-fills the `venue_*` fields; the field stays plain free text whenever nothing is selected or Google is unavailable.

**Tech Stack:** Node.js / Express 4, React 18 (Create React App), Google Places API (New), `express-rate-limit`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-05-22-venue-search-design.md`

---

## Working Context

- **Worktree:** all work happens in `C:\Users\dalla\DRB_OS\worktrees\venue-search` on branch `venue-search`. Commit there.
- **No schema change.** `venue_name`, `venue_street`, `venue_city`, `venue_state`, `venue_zip` already exist on the `proposals` table.
- **Test approach.** This repo has no jest, mocha, or supertest. Server tests use the built-in `node:test` runner for pure utilities (see `server/routes/proposals/crud.test.js` harness notes). This plan adds one such test, for the pure address-component mapper. Every other task is verified by running the app, which is this project's verification model (CLAUDE.md treats "user verified it works in the app" as tested). There is no client test runner; client correctness is verified in the browser. Client lint is not enforced locally; the `.husky/pre-push` hook runs a `CI=true` client build, and `npm run build` from the worktree root checks it early.
- **Dev server.** The dev server is a managed background process and does not always hot-reload server files. After any change under `server/`, restart it (`npm run dev`) before verifying. Do not start a dev server in this worktree while one is running in the `os` folder; they share a `client/node_modules` junction.
- **Google API key.** `GOOGLE_PLACES_API_KEY` must be created by the project owner: a Google Cloud project with Places API (New) enabled, an API key, and a daily quota cap. Put it in the local `.env` for dev and in Render for production. Until it is set, the feature degrades gracefully (the field is a plain text input). Each task below has a "without the key" verification that does not need it, and a "with the key" verification that does.

## File Structure

**New files:**
- `server/utils/googlePlaces.js` — Google Places (New) proxy. `searchVenues`, `getVenueDetails`, the pure `mapPlaceToVenue`, `isConfigured`. Fails soft, never throws.
- `server/utils/googlePlaces.test.js` — `node:test` unit tests for `mapPlaceToVenue`.
- `server/routes/venues.js` — Express router: `GET /search`, `GET /details/:placeId`.
- `client/src/components/VenueSearchInput.js` — self-contained typeahead component.

**Modified files:**
- `server/middleware/rateLimiters.js` — add `venueSearchLimiter` and `venueSearchGlobalLimiter`.
- `server/index.js` — mount the venues router.
- `server/routes/proposals/public.js` — accept, validate, and store `venue_street` / `venue_zip` from the wizard.
- `client/src/components/VenueAddressFields.js` — embed `VenueSearchInput` for the venue-name field.
- `client/src/pages/website/quoteWizard/QuoteWizard.js` — add `venue_street` / `venue_zip` to the default form and submit payload.
- `client/src/pages/website/quoteWizard/steps/EventDetailsStep.js` — use `VenueSearchInput` for the venue-name field.
- `client/src/index.css` — dropdown styles.
- `.env.example`, `README.md`, `ARCHITECTURE.md`, `CLAUDE.md` — documentation.

**Untouched on purpose:** `SignAndPaySection.js`, `ProposalCreate.js`, `ProposalDetailEditForm.js`, `EventEditForm.js`. All four already pass `value` and a functional `onChange(field, value)` to `VenueAddressFields`. The selection handler reuses that same `onChange`, so they need no change. `ProposalView.js` already computes venue completeness and drives the sign + pay read-only path; once the wizard fills `venue_street`, that path engages with no edit.

---

## Task 1: Google Places proxy util

**Files:**
- Create: `server/utils/googlePlaces.js`
- Test: `server/utils/googlePlaces.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/utils/googlePlaces.test.js`:

```js
'use strict';

// Pure-function tests for the Google Places venue mapper. Run:
//   node server/utils/googlePlaces.test.js
// No network, no DB — exercises mapPlaceToVenue only.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapPlaceToVenue } = require('./googlePlaces');

function comp(longText, ...types) {
  return { longText, shortText: longText, types };
}
function place(components, name) {
  return { displayName: { text: name }, addressComponents: components };
}

test('maps a full in-area address', () => {
  const result = mapPlaceToVenue(place([
    comp('123', 'street_number'),
    comp('Oak Road', 'route'),
    comp('Springfield', 'locality'),
    comp('Illinois', 'administrative_area_level_1'),
    comp('62704', 'postal_code'),
  ], 'The Wedding Barn'));
  assert.deepEqual(result, {
    venue_name: 'The Wedding Barn',
    venue_street: '123 Oak Road',
    venue_city: 'Springfield',
    venue_state: 'Illinois',
    venue_zip: '62704',
  });
});

test('drops the address for an out-of-area state, keeps the name', () => {
  const result = mapPlaceToVenue(place([
    comp('1 Main St', 'route'),
    comp('Columbus', 'locality'),
    comp('Ohio', 'administrative_area_level_1'),
  ], 'Some Ohio Hall'));
  assert.deepEqual(result, { venue_name: 'Some Ohio Hall' });
});

test('omits fields Google did not return', () => {
  const result = mapPlaceToVenue(place([
    comp('Milwaukee', 'locality'),
    comp('Wisconsin', 'administrative_area_level_1'),
  ], 'Lakeside Venue'));
  assert.deepEqual(result, {
    venue_name: 'Lakeside Venue',
    venue_city: 'Milwaukee',
    venue_state: 'Wisconsin',
  });
});

test('falls back to postal_town when locality is absent', () => {
  const result = mapPlaceToVenue(place([
    comp('Lansing', 'postal_town'),
    comp('Michigan', 'administrative_area_level_1'),
  ], 'Town Hall'));
  assert.equal(result.venue_city, 'Lansing');
});

test('omits the street when Google returns a number but no route', () => {
  const result = mapPlaceToVenue(place([
    comp('500', 'street_number'),
    comp('Chicago', 'locality'),
    comp('Illinois', 'administrative_area_level_1'),
  ], 'Numbered Place'));
  assert.deepEqual(result, {
    venue_name: 'Numbered Place',
    venue_city: 'Chicago',
    venue_state: 'Illinois',
  });
});

test('returns an empty object for junk input', () => {
  assert.deepEqual(mapPlaceToVenue(null), {});
  assert.deepEqual(mapPlaceToVenue({}), {});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node server/utils/googlePlaces.test.js`
Expected: FAIL — `Cannot find module './googlePlaces'` (the util does not exist yet).

- [ ] **Step 3: Create the util**

Create `server/utils/googlePlaces.js`:

```js
'use strict';

// Google Places (New) proxy for venue-name search. Pure HTTP wrapper, no DB.
// Fails soft on every path: returns [] or null, never throws — so the
// venue-name field degrades to a plain text input when the key is missing or
// Google is unreachable. Mirrors the server-mediated pattern of stripeClient.js.

const { VENUE_STATES } = require('./venueAddress');

const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const DETAILS_URL = 'https://places.googleapis.com/v1/places/';

// Length caps on user-supplied input. Enforced in this util so the bound
// travels with the function, not only with the route handler.
const MAX_QUERY_LEN = 200;
const MAX_PLACE_ID_LEN = 300;
const MAX_TOKEN_LEN = 100;

// Coarse bounding box over the five service-area states (IL, IN, MI, MN, WI).
// Biases autocomplete results toward the region; VENUE_STATES is the precise
// gate (see mapPlaceToVenue).
const REGION_RECTANGLE = {
  low: { latitude: 36.95, longitude: -97.3 },
  high: { latitude: 49.4, longitude: -82.0 },
};

function isConfigured() {
  return !!process.env.GOOGLE_PLACES_API_KEY;
}

// Long text of the first address component matching a Google type.
function pick(components, type) {
  const c = (components || []).find(
    (x) => Array.isArray(x.types) && x.types.includes(type),
  );
  return c ? (c.longText || c.shortText || '') : '';
}

/**
 * Map a Google Place Details response to our structured venue. Pure.
 * Returns an object holding ONLY the fields that have a value (always
 * venue_name when Google supplied a name). Service-area guard: when the
 * resolved state is not one of VENUE_STATES, the address fields are dropped
 * and only venue_name is returned.
 * @param {object} place Google Place Details JSON
 * @returns {{venue_name?:string,venue_street?:string,venue_city?:string,venue_state?:string,venue_zip?:string}}
 */
function mapPlaceToVenue(place) {
  if (!place || typeof place !== 'object') return {};
  const components = place.addressComponents || [];
  // A usable street needs a route (the street name). A street_number with no
  // route is not a street, so venue_street stays empty in that case.
  const route = pick(components, 'route');
  const street = route
    ? [pick(components, 'street_number'), route].filter(Boolean).join(' ')
    : '';
  const city = pick(components, 'locality')
    || pick(components, 'postal_town')
    || pick(components, 'sublocality_level_1');
  const state = pick(components, 'administrative_area_level_1');
  const zip = pick(components, 'postal_code');
  const name = (place.displayName && place.displayName.text) || '';

  const venue = {};
  if (name) venue.venue_name = name;

  // Out-of-area: keep the name, drop the address.
  if (state && !VENUE_STATES.includes(state)) return venue;

  if (street) venue.venue_street = street;
  if (city) venue.venue_city = city;
  if (state) venue.venue_state = state;
  if (zip) venue.venue_zip = zip;
  return venue;
}

/**
 * Autocomplete a venue-name query. Returns [] when not configured, when the
 * query is under 3 characters, or on any error.
 * @param {string} input
 * @param {string} sessionToken
 * @returns {Promise<Array<{placeId:string,name:string,address:string}>>}
 */
async function searchVenues(input, sessionToken) {
  if (!isConfigured()) return [];
  const q = String(input || '').trim().slice(0, MAX_QUERY_LEN);
  if (q.length < 3) return [];
  const token = String(sessionToken || '').slice(0, MAX_TOKEN_LEN);
  try {
    const res = await fetch(AUTOCOMPLETE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
      },
      body: JSON.stringify({
        input: q,
        sessionToken: token || undefined,
        includedRegionCodes: ['us'],
        // locationBias (not locationRestriction): bias results toward the
        // service-area box but still allow strong matches just outside it.
        // VENUE_STATES in mapPlaceToVenue is the precise in-area gate.
        locationBias: { rectangle: REGION_RECTANGLE },
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.suggestions || [])
      .filter((s) => s.placePrediction)
      .map((s) => {
        const p = s.placePrediction;
        const sf = p.structuredFormat || {};
        return {
          placeId: p.placeId || '',
          name: (sf.mainText && sf.mainText.text) || (p.text && p.text.text) || '',
          address: (sf.secondaryText && sf.secondaryText.text) || '',
        };
      })
      .filter((r) => r.placeId && r.name);
  } catch (err) {
    // Log err.message only; never log the API key or the request URL.
    console.error('[googlePlaces] searchVenues error:', err.message);
    return [];
  }
}

/**
 * Fetch place details and map to a structured venue. Returns null when not
 * configured, when placeId is missing or empty, when Google returns nothing
 * usable, or on any error.
 * @param {string} placeId
 * @param {string} sessionToken
 * @returns {Promise<object|null>}
 */
async function getVenueDetails(placeId, sessionToken) {
  if (!isConfigured()) return null;
  const id = String(placeId || '').slice(0, MAX_PLACE_ID_LEN);
  if (!id) return null;
  const token = String(sessionToken || '').slice(0, MAX_TOKEN_LEN);
  try {
    const url = `${DETAILS_URL}${encodeURIComponent(id)}`
      + (token ? `?sessionToken=${encodeURIComponent(token)}` : '');
    const res = await fetch(url, {
      headers: {
        'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': 'addressComponents,displayName',
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const venue = mapPlaceToVenue(data);
    // An empty map means Google returned nothing usable; report a miss so the
    // documented object|null contract holds (callers expect at least a name).
    return Object.keys(venue).length > 0 ? venue : null;
  } catch (err) {
    // Log err.message only; never log the API key or the request URL.
    console.error('[googlePlaces] getVenueDetails error:', err.message);
    return null;
  }
}

module.exports = {
  isConfigured,
  searchVenues,
  getVenueDetails,
  mapPlaceToVenue,
  REGION_RECTANGLE,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node server/utils/googlePlaces.test.js`
Expected: PASS — `# pass 6`, `# fail 0`.

- [ ] **Step 5: Update docs**

In `README.md`, in the folder-structure tree, under the `server/utils/` listing, add a line for `googlePlaces.js` matching the surrounding format, described as "Google Places venue-search proxy". In `ARCHITECTURE.md`, in the section that lists server utilities, add a one-line mention of `googlePlaces.js` and its role.

- [ ] **Step 6: Commit**

```bash
git add server/utils/googlePlaces.js server/utils/googlePlaces.test.js README.md ARCHITECTURE.md
git commit -m "feat(venue): Google Places search proxy util"
```

---

## Task 2: Venues API route

**Files:**
- Create: `server/routes/venues.js`
- Modify: `server/middleware/rateLimiters.js`
- Modify: `server/index.js`
- Modify: `.env.example`, `README.md`, `ARCHITECTURE.md`, `CLAUDE.md`

- [ ] **Step 1: Add the rate limiter**

In `server/middleware/rateLimiters.js`, replace the final `module.exports` line:

```js
module.exports = { publicLimiter, publicReadLimiter, signLimiter, drinkPlanWriteLimiter, logoUploadLimiter, labratSeedLimiter, labratSeedGlobalLimiter, labratFeedbackLimiter, adminWriteLimiter };
```

with:

```js
// Venue-name search proxy (Google Places). Unauthenticated: the quote wizard
// is public. A real search debounces to a handful of autocomplete calls plus
// one details call; 60/min per IP is generous for that and curbs scripted
// abuse of the (paid) Google quota.
const venueSearchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many venue searches. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Global ceiling across all IPs, so an IP-rotating attacker still hits a cap
// on the paid Google quota. Same pattern as labratSeedGlobalLimiter. Sized for
// whole-site quote volume, not a single user; raise if real traffic nears it.
const venueSearchGlobalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  keyGenerator: () => 'venue-search-global',
  message: { error: 'Venue search is busy. Please try again shortly.' },
  standardHeaders: false,
  legacyHeaders: false,
});

module.exports = { publicLimiter, publicReadLimiter, signLimiter, drinkPlanWriteLimiter, logoUploadLimiter, labratSeedLimiter, labratSeedGlobalLimiter, labratFeedbackLimiter, adminWriteLimiter, venueSearchLimiter, venueSearchGlobalLimiter };
```

- [ ] **Step 2: Create the route**

Create `server/routes/venues.js`:

```js
'use strict';

const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { venueSearchLimiter, venueSearchGlobalLimiter } = require('../middleware/rateLimiters');
const { searchVenues, getVenueDetails } = require('../utils/googlePlaces');

const router = express.Router();

// Venue-name autocomplete. Public: the quote wizard is unauthenticated and no
// proposal token exists at that stage. Thin proxy to Google Places, exposes
// nothing sensitive. Rate-limited per IP and with a global ceiling. Absence of
// matches is a normal outcome, so this never throws an AppError. Length caps on
// q / placeId / token live in server/utils/googlePlaces.js.
router.get('/search', venueSearchGlobalLimiter, venueSearchLimiter, asyncHandler(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const results = await searchVenues(q, token);
  res.json({ results });
}));

// Resolve a selected suggestion to a structured venue address.
router.get('/details/:placeId', venueSearchGlobalLimiter, venueSearchLimiter, asyncHandler(async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const venue = await getVenueDetails(req.params.placeId, token);
  res.json({ venue });
}));

module.exports = router;
```

- [ ] **Step 3: Mount the route**

In `server/index.js`, find the line:

```js
app.use('/api/clients', require('./routes/clients'));
```

and add the venues route immediately after it:

```js
app.use('/api/clients', require('./routes/clients'));
app.use('/api/venues', require('./routes/venues'));
```

- [ ] **Step 4: Add the env var to `.env.example`**

In `.env.example`, near the other third-party API keys, add:

```
# Google Places API (New) key for venue-name smart search. Server-only.
# When unset, the venue search degrades to a plain text input.
GOOGLE_PLACES_API_KEY=
```

- [ ] **Step 5: Verify the endpoints**

Restart the dev server so the new route loads (`npm run dev` from the worktree root; confirm no dev server is running in the `os` folder first).

Run: `curl "http://localhost:5000/api/venues/search?q=wedding"`
Expected (without the key set): `{"results":[]}` with HTTP 200. This proves the route is mounted and the soft-fail path works.
Expected (with the key set): `{"results":[ ... ]}` with one or more `{placeId,name,address}` entries.

Run: `curl "http://localhost:5000/api/venues/details/test?token=abc"`
Expected (without the key): `{"venue":null}` with HTTP 200.

**Owner action, not code, do not skip:** before this ships, set a daily request cap on the `GOOGLE_PLACES_API_KEY` in the Google Cloud console (APIs & Services, Places API New, Quotas). The two rate limiters bound per-minute abuse; the daily quota cap is the hard ceiling on total spend if the key ever leaks or a limiter is misconfigured.

- [ ] **Step 6: Update docs**

- `README.md`: add `server/routes/venues.js` to the folder-structure tree, in alphabetical position under `server/routes/` (after `testFeedback.js`), described as "Google Places venue search proxy". Add a `GOOGLE_PLACES_API_KEY` row to the Environment Variables table, using the same Variable and Purpose text as the `CLAUDE.md` row specified below.
- `ARCHITECTURE.md`: add two rows to the API route table — `GET /api/venues/search` and `GET /api/venues/details/:placeId`, both public, described as venue-name autocomplete and place-details lookup. Add Google Places (New) to the Third-Party Integrations section.
- `CLAUDE.md`: add a row to the Environment Variables table: `` | `GOOGLE_PLACES_API_KEY` | Google Places API (New) key for venue-name search. Server-only. When unset, venue search degrades to a plain text input. | ``. Add Google Places to the Tech Stack list (for example: `**Venue search**: Google Places API (New) for venue-name autocomplete`).

- [ ] **Step 7: Commit**

```bash
git add server/routes/venues.js server/middleware/rateLimiters.js server/index.js .env.example README.md ARCHITECTURE.md CLAUDE.md
git commit -m "feat(venue): venue search API route"
```

---

## Task 3: VenueSearchInput component and address-fields integration

**Files:**
- Create: `client/src/components/VenueSearchInput.js`
- Modify: `client/src/components/VenueAddressFields.js`
- Modify: `client/src/index.css`
- Modify: `README.md`

This lights up the venue search on the proposal sign + pay gate and all three admin proposal forms at once, because all four already render `VenueAddressFields`.

- [ ] **Step 1: Create the component**

Create `client/src/components/VenueSearchInput.js`:

```jsx
import React, { useState, useRef, useEffect, useCallback } from 'react';
import api from '../utils/api';

// Typeahead for the venue-name field, backed by the Google Places proxy
// (/api/venues/*). Self-contained: owns its suggestion list, dropdown state,
// keyboard highlight, and Google session token. Parents pass only `value`
// plus two callbacks.
//
//   onChange(name)  — fires on every keystroke with the raw text.
//   onSelect(venue) — fires when a suggestion is chosen, with an object
//                     holding only the venue_* fields that have a value
//                     (always venue_name; address fields present only for an
//                     in-area match — see server/utils/googlePlaces.js).
//
// If the proxy returns nothing (key unset, API down, or no matches) the
// dropdown never appears and the field behaves as a plain text input.

const DEBOUNCE_MS = 250;
const MIN_CHARS = 3;

export default function VenueSearchInput({
  value = '',
  onChange,
  onSelect,
  id = 'venue-name',
  inputClassName = 'form-input',
  placeholder = 'Start typing your venue name',
  disabled = false,
  ariaInvalid = false,
}) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);

  const wrapRef = useRef(null);
  const debounceRef = useRef(null);
  const sessionTokenRef = useRef('');
  const reqSeqRef = useRef(0);

  // Lazily mint a Google session token; reused across keystrokes of one
  // search, regenerated after a selection so each search bills as one session.
  const sessionToken = useCallback(() => {
    if (!sessionTokenRef.current) {
      sessionTokenRef.current =
        (window.crypto && window.crypto.randomUUID && window.crypto.randomUUID())
        || `${Date.now()}-${Math.random()}`;
    }
    return sessionTokenRef.current;
  }, []);

  // Close the dropdown on an outside click.
  useEffect(() => {
    function onDocClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  // Clear a pending debounce on unmount.
  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const runSearch = useCallback(async (text) => {
    const seq = ++reqSeqRef.current;
    try {
      const res = await api.get('/venues/search', {
        params: { q: text, token: sessionToken() },
      });
      if (seq !== reqSeqRef.current) return; // a newer keystroke superseded this
      const results = (res.data && res.data.results) || [];
      setSuggestions(results);
      setHighlight(-1);
      setOpen(results.length > 0);
    } catch {
      if (seq !== reqSeqRef.current) return;
      setSuggestions([]);
      setOpen(false);
    }
  }, [sessionToken]);

  const handleInput = (e) => {
    const text = e.target.value;
    onChange(text);
    clearTimeout(debounceRef.current);
    if (text.trim().length < MIN_CHARS) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(() => runSearch(text.trim()), DEBOUNCE_MS);
  };

  const choose = async (suggestion) => {
    setOpen(false);
    setSuggestions([]);
    // Show the picked name immediately, before the details round-trip resolves.
    onChange(suggestion.name);
    try {
      const res = await api.get(
        `/venues/details/${encodeURIComponent(suggestion.place_id)}`,
        { params: { token: sessionToken() } },
      );
      const venue = (res.data && res.data.venue) || {};
      onSelect({ ...venue, venue_name: venue.venue_name || suggestion.name });
    } catch {
      onSelect({ venue_name: suggestion.name });
    }
    sessionTokenRef.current = ''; // next keystroke starts a fresh billing session
  };

  const handleKeyDown = (e) => {
    if (!open || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlight >= 0) choose(suggestions[highlight]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="venue-search" ref={wrapRef} style={{ position: 'relative' }}>
      <input
        id={id}
        className={inputClassName}
        value={value}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        onFocus={() => { if (suggestions.length > 0) setOpen(true); }}
        placeholder={placeholder}
        autoComplete="off"
        disabled={disabled}
        aria-invalid={ariaInvalid || undefined}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={`${id}-listbox`}
        aria-activedescendant={open && highlight >= 0 ? `${id}-opt-${highlight}` : undefined}
      />
      {open && suggestions.length > 0 && (
        <ul className="venue-search-dropdown" role="listbox" id={`${id}-listbox`}>
          {suggestions.map((s, i) => (
            <li
              key={s.place_id}
              id={`${id}-opt-${i}`}
              className={`venue-search-option${i === highlight ? ' highlighted' : ''}`}
              role="option"
              aria-selected={i === highlight}
              onMouseDown={(e) => { e.preventDefault(); choose(s); }}
              onMouseEnter={() => setHighlight(i)}
            >
              <span className="venue-search-name">{s.name}</span>
              {s.address && <span className="venue-search-address">{s.address}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add the dropdown styles**

In `client/src/index.css`, after the `.wz-event-type-option` rules (the existing event-type autocomplete block), append:

```css
/* Venue-name smart search dropdown */
.venue-search-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  margin: 2px 0 0;
  padding: 0;
  list-style: none;
  background: #fff;
  border: 1px solid var(--border, #d8cdb8);
  border-radius: 6px;
  max-height: 260px;
  overflow-y: auto;
  z-index: var(--z-dropdown);
  box-shadow: 0 4px 16px rgba(0,0,0,0.12);
}
.venue-search-option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0.55rem 0.85rem;
  cursor: pointer;
  transition: background 0.15s;
}
.venue-search-option:hover,
.venue-search-option.highlighted {
  background: var(--parchment, #f5f0e1);
}
.venue-search-name {
  font-weight: 600;
  font-size: 0.95rem;
  color: var(--deep-brown, #3a2a1a);
}
.venue-search-address {
  font-size: 0.8rem;
  color: var(--ink-3, #8a7d68);
}
```

- [ ] **Step 3: Embed the component in `VenueAddressFields`**

In `client/src/components/VenueAddressFields.js`, replace the first import line:

```jsx
import React from 'react';
```

with:

```jsx
import React from 'react';
import VenueSearchInput from './VenueSearchInput';
```

Then, inside the `VenueAddressFields` function, just after the line `const req = requireStreet ? ' *' : '';`, add the selection handler:

```jsx
  // Apply a picked venue. The component supplies only the venue_* keys that
  // have a value, so an out-of-area (name-only) result never wipes an address
  // the user already entered. Every parent's onChange is a functional setState,
  // so the per-field calls are safe.
  const applyVenue = (venue) => {
    ['venue_name', 'venue_street', 'venue_city', 'venue_state', 'venue_zip']
      .forEach((k) => { if (venue[k] !== undefined) onChange(k, venue[k]); });
  };
```

Then replace the venue-name `form-group` block:

```jsx
      <div className="form-group">
        <label className={labelClassName} htmlFor={`${idPrefix}-name`}>Venue name (optional)</label>
        <input id={`${idPrefix}-name`} className={inputClassName} value={v.venue_name || ''}
          onChange={set('venue_name')} placeholder="e.g. Citadel Banquet Hall" autoComplete="off" />
        {fieldErrors.venue_name && <div className="field-error">{fieldErrors.venue_name}</div>}
      </div>
```

with:

```jsx
      <div className="form-group">
        <label className={labelClassName} htmlFor={`${idPrefix}-name`}>Venue name (optional)</label>
        <VenueSearchInput
          id={`${idPrefix}-name`}
          value={v.venue_name || ''}
          onChange={(name) => onChange('venue_name', name)}
          onSelect={applyVenue}
          inputClassName={inputClassName}
          placeholder="e.g. Citadel Banquet Hall"
        />
        {fieldErrors.venue_name && <div className="field-error">{fieldErrors.venue_name}</div>}
      </div>
```

- [ ] **Step 4: Update docs**

In `README.md`, add `client/src/components/VenueSearchInput.js` to the folder-structure tree (under `client/src/components/`), described as "venue-name typeahead (Google Places)".

- [ ] **Step 5: Verify in the app**

With the dev server running, sign in as an admin and open the manual proposal create page (`/proposals/new` or the "New Proposal" button). Find the Venue / location section.

Without the key: the Venue name field renders and accepts typing; no dropdown appears; the City / State / Street fields still work; the form still saves. Confirm there are no console errors.

With the key: type at least 3 characters of a real venue (for example "wedding barn"). A dropdown appears within about a second, each row showing a venue name and its full address. Arrow keys move the highlight; Enter or a click selects. On selection, Street, City, State, and Zip fill in. Selecting an out-of-area venue fills only the name.

Also open a proposal's sign + pay page for a proposal that has no street yet, and confirm the same search works on that venue-name field.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/VenueSearchInput.js client/src/components/VenueAddressFields.js client/src/index.css README.md
git commit -m "feat(venue): venue-name typeahead in address fields"
```

---

## Task 4: Venue search in the quote wizard

**Files:**
- Modify: `server/routes/proposals/public.js`
- Modify: `client/src/pages/website/quoteWizard/QuoteWizard.js`
- Modify: `client/src/pages/website/quoteWizard/steps/EventDetailsStep.js`

The wizard never shows a street field. When a client selects a real venue, the full address is captured silently. That proposal then reaches sign + pay already address-complete, and the existing `venue_complete` logic shows it read-only instead of asking again.

- [ ] **Step 1: Accept `venue_street` and `venue_zip` on the public submit route**

In `server/routes/proposals/public.js`, in the `POST /public/submit` handler:

Edit 1 — the request destructure. Replace:

```js
    venue_name, venue_city, venue_state, guest_count, package_id, num_bars, addon_ids,
```

with:

```js
    venue_name, venue_street, venue_city, venue_state, venue_zip, guest_count, package_id, num_bars, addon_ids,
```

Edit 2 — the venue input object. Replace:

```js
  const venueInput = { venue_name, venue_city, venue_state };
```

with:

```js
  const venueInput = { venue_name, venue_street, venue_city, venue_state, venue_zip };
```

(`validateVenue` already format-checks street length and zip pattern when present; `composeVenueLocation` already folds street and zip into `event_location`.)

Edit 3 — the INSERT column list and placeholders. Replace:

```js
        venue_name, venue_city, venue_state, client_provides_glassware)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
```

with:

```js
        venue_name, venue_city, venue_state, venue_street, venue_zip, client_provides_glassware)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
```

Edit 4 — the INSERT values array. Replace:

```js
      (venue_name || '').trim() || null, (venue_city || '').trim() || null, (venue_state || '').trim() || null,
      !!client_provides_glassware
```

with:

```js
      (venue_name || '').trim() || null, (venue_city || '').trim() || null, (venue_state || '').trim() || null,
      (venue_street || '').trim() || null, (venue_zip || '').trim() || null,
      !!client_provides_glassware
```

- [ ] **Step 2: Add the fields to the wizard form**

In `client/src/pages/website/quoteWizard/QuoteWizard.js`:

Edit 1 — the default form state. Replace:

```js
    venue_name: '',
```

with:

```js
    venue_name: '',
    venue_street: '',
    venue_zip: '',
```

Edit 2 — the submit payload. Replace:

```js
          venue_state: form.event_state,
```

with:

```js
          venue_state: form.event_state,
          venue_street: form.venue_street?.trim() || null,
          venue_zip: form.venue_zip?.trim() || null,
```

- [ ] **Step 3: Use `VenueSearchInput` in the event-details step**

In `client/src/pages/website/quoteWizard/steps/EventDetailsStep.js`, replace the import line:

```jsx
import NumberStepper from '../../../../components/NumberStepper';
```

with:

```jsx
import NumberStepper from '../../../../components/NumberStepper';
import VenueSearchInput from '../../../../components/VenueSearchInput';
```

Then replace the venue-name `form-group` block:

```jsx
        <div className="form-group">
          <label htmlFor="wz-venue_name" className="form-label">Venue name (optional)</label>
          <input id="wz-venue_name" className="form-input" value={form.venue_name || ''}
            onChange={e => update('venue_name', e.target.value)}
            placeholder="e.g. Citadel Banquet Hall (if you know it)" autoComplete="off" />
        </div>
```

with:

```jsx
        <div className="form-group">
          <label htmlFor="wz-venue_name" className="form-label">Venue name (optional)</label>
          <VenueSearchInput
            id="wz-venue_name"
            value={form.venue_name || ''}
            onChange={(name) => setForm(f => ({ ...f, venue_name: name, venue_street: '', venue_zip: '' }))}
            onSelect={(venue) => setForm(f => ({
              ...f,
              venue_name: venue.venue_name || f.venue_name,
              venue_street: venue.venue_street || '',
              venue_zip: venue.venue_zip || '',
              event_city: venue.venue_city || f.event_city,
              event_state: venue.venue_state || f.event_state,
            }))}
            placeholder="e.g. Citadel Banquet Hall (if you know it)"
          />
        </div>
```

The `onChange` handler clears `venue_street` and `venue_zip` on any manual keystroke, so a name edited after a selection never keeps a stale captured address. The `onSelect` handler overwrites `event_city` / `event_state` from the venue only when the venue supplies them, and leaves them untouched for an out-of-area (name-only) result.

- [ ] **Step 4: Verify the wizard end to end**

Restart the dev server (Step 1 changed a server file). Open the public quote wizard and reach the Event Details step.

Without the key: type a venue name freehand, do not select anything, finish and submit the wizard. Open the created proposal in the admin. The venue shows the typed name; street is blank. The proposal's sign + pay page still asks for the address. This is the unchanged baseline.

With the key: on Event Details, type a venue name, select a suggestion. City and State fill from the venue. Finish and submit the wizard. Open the created proposal in the admin and confirm the venue / location shows the full street address. Open that proposal's sign + pay link and confirm the address is shown read-only ("already provided") rather than asking for it.

- [ ] **Step 5: Commit**

```bash
git add server/routes/proposals/public.js client/src/pages/website/quoteWizard/QuoteWizard.js client/src/pages/website/quoteWizard/steps/EventDetailsStep.js
git commit -m "feat(venue): venue search in the quote wizard"
```

---

## Done

After Task 4 the venue-name field is a Google Places typeahead on the quote wizard, the proposal sign + pay gate, and the admin proposal create and edit forms. Selecting a suggestion auto-fills the structured address; the field stays plain free text whenever nothing is selected or Google is unavailable.

Before merging to `main`, run the standard pre-push review agents (CLAUDE.md Pre-Push Procedure). This branch touches a new external integration, a public route, and a money-adjacent flow (the proposal submit path), so `security-review`, `code-review`, and `consistency-check` are especially relevant.

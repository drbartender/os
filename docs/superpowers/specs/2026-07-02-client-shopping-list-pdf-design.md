---
lanes:
  - id: client-shopping-list-pdf
    footprint:
      - client/src/pages/public/ClientShoppingList.js
      - ARCHITECTURE.md
      - README.md
    dependencies: []
    fleet: light (client-only display; no sensitive paths; single focused reviewer)
---

# Client Shopping-List PDF Download — Design (2026-07-02)

## Context
The fix-list ask was "Send PDF via email for the shopping list." During design, Dallas reshaped it: instead of DRB emailing PDF attachments, make the PDF downloadable and let the holder forward it themselves. The client-facing shopping-list page (`/shopping-list/:token`, the link clients already receive by email) currently has NO PDF download; only the admin `ShoppingListModal` does. Adding the same download to the client page solves distribution better than any send feature: the client forwards it to whoever actually shops (spouse, planner, assistant), and the admin can already attach the modal's download to their own email when they want to send it. This kills the upload endpoint, attachment infra, and recipient logic the email design needed.

## Scope
- **In:** `client/src/pages/public/ClientShoppingList.js` (one new button + handler).
- **Out:** the admin modal (its Download PDF is unchanged and stays the admin's manual-send path); the approve-flow `shopping_list_ready` email (still a link email; still auto-skips hosted events); any server change at all.

## Current behavior (grounded)
- `GET /api/drink-plans/t/:token/shopping-list` (public, rate-limited, UUID-guarded) returns `{ ready: false, client_name, event_type, event_type_custom, event_date }` until the admin approves, then `{ ready: true, shopping_list, client_name, event_type, event_type_custom, event_date }` (`server/routes/drinkPlans.js:35-62`).
- The stored `shopping_list` JSONB is the SAME object the admin modal edits and saves (`PUT /:id/shopping-list` persists the modal's `edited`), so it carries the generator's field names: `liquorBeerWine`, `everythingElse`, `guestCount`, `signatureCocktailNames`, `clientName`, `eventDate` (both write paths verified). **`eventTypeLabel` is reliably ABSENT on the common auto-gen path** (the server auto-gen omits it and the saved-list branch never backfills it), so the mapping's `getEventTypeLabel` backfill below is MANDATORY, not belt-and-suspenders. `ClientShoppingList.js:100-103` renders `list.liquorBeerWine` / `list.everythingElse` directly.
- `generateShoppingListPDF(listData)` (`client/src/components/ShoppingList/ShoppingListPDF.jsx:39`) is a pure client-side module (jsPDF + embedded base64 logo) destructuring `{ clientName, eventTypeLabel, guestCount, eventDate, signatureCocktailNames, liquorBeerWine, everythingElse }`, returning a Blob.
- The admin modal dynamic-imports the generator at click time so non-downloaders never pay the jsPDF + base64-logo bundle cost (`ShoppingListModal.jsx:173-175`). `ClientShoppingList.js` has a header comment noting it deliberately keeps the base64 out of its bundle; the same lazy-import pattern preserves that.

## Design

### One new button on `ClientShoppingList`
Rendered only when `data.ready && data.shopping_list` (the placeholder "being prepared" state gets no button). Placement: with the page's existing header/actions area, styled with the page's inline-style conventions (this page has its own `styles` object, not admin classes).

Handler mirrors the admin modal's `handleDownload` (`ShoppingListModal.jsx:163-190`):
1. Pending state (`downloading`) disables the button AND swaps its label to "Generating PDF..." (the admin modal's exact pattern, `ShoppingListModal.jsx:402-403`); on mobile/3G the first lazy jsPDF chunk can take seconds and a silently-disabled button reads as frozen. Error state shows a retry-able inline message (page convention).
2. `const { generateShoppingListPDF } = await import('../../components/ShoppingList/ShoppingListPDF');` (lazy, click-time — keeps jsPDF + logo out of the public page's initial bundle).
3. Build `listData` by spreading the stored list and backfilling the header fields from the response's top level:
   ```js
   const listData = {
     ...data.shopping_list,
     clientName: data.shopping_list.clientName || data.client_name || 'Event',
     eventTypeLabel: data.shopping_list.eventTypeLabel
       || getEventTypeLabel({ event_type: data.event_type, event_type_custom: data.event_type_custom }),
     eventDate: data.shopping_list.eventDate || data.event_date,
   };
   ```
   (`getEventTypeLabel` from `client/src/utils/eventTypes.js`, the mandated display helper.)
4. `await generateShoppingListPDF(listData)` (it returns a `Promise<Blob>`), then object-URL download named `DRB_ShoppingList_<ClientName>.pdf` with the admin modal's whitespace sanitization (`(clientName || 'Event').replace(/\s+/g, '_')`, `ShoppingListModal.jsx:179`), then revoke the URL.

### Deliberate properties
- **One layout forever:** both surfaces call the same generator; the client's PDF is identical to the admin's, including admin edits (the stored JSONB is post-edit).
- **Zero server surface:** no new endpoint, no upload, no email; the public token route already serves everything needed.
- **Checked-off state is NOT in the PDF:** the page's localStorage checkboxes are personal progress-tracking; the PDF is the full list (same as the admin download). Not a gap, a choice.

## Edge cases
- `ready: false` (pending review / no list): no button; page placeholder unchanged.
- Malformed/legacy stored list: the generator's destructuring defaults cover MISSING (undefined) fields only, not `null`. The real protections: both write paths always emit arrays, and a null-array row would crash the page render (`list.liquorBeerWine.map`, `ClientShoppingList.js:102`) before the button even exists (pre-existing exposure, not introduced here). The one divergent field, a null `signatureCocktailNames`, would throw inside the generator and land in the handler's try/catch as the inline error. Corruption-only territory; no code change warranted.
- jsPDF dynamic import fails (offline/CDN-less; it is bundled, so only a chunk-load failure applies): catch -> inline error "PDF failed to generate, try again"; page content unaffected.
- Hosted events: if an admin approved a list for a hosted event, the page (and button) work; the hosted skip only governs the auto-email. No special-casing.
- Mobile: object-URL `a.download` works in mobile Chrome/Safari (Safari opens the PDF in-tab, which is acceptable; user shares from the viewer).

## Non-goals
- No emailed attachment (explicitly dropped in design).
- No PDF of the checked/unchecked state.
- No change to the admin modal or approve-flow email.

## Documentation
- No new file/route/component, so the structural doc rows don't trigger. Per the "New feature" row: one line in README's Key Features (client shopping-list page offers a PDF download mirroring the admin generator). ARCHITECTURE note optional.

## Verification
- `CI=true react-scripts build` clean (the Vercel gate).
- Manual, running app: open a real `/shopping-list/:token` with an approved list -> download -> PDF matches the admin modal's download for the same plan, with ONE legitimate exception: on an auto-generated never-edited list the admin PDF header shows the generator default ("Event type: event") while the client PDF backfills the real label via `getEventTypeLabel`. The client PDF being better there is correct behavior, not a mapping bug; any OTHER diff is a mapping bug. Pending-review plan shows no button; check the button on a phone-width viewport (label swaps to "Generating PDF..." while working).
- Fleet-verified (no build-time step needed): eventDate needs no format step (the generator's own `formatDate` renders ISO timestamps as "August 15, 2026"); both write paths emit all array fields; the generator consumes none of the JSONB's internal fields (`notes`, `_syrupSelfProvided`), so nothing internal leaks into the client PDF.

## Risk
Trivial-to-Small. Client-only, read-only, no sensitive paths, no money/auth/data surface; reuses a proven generator and a proven lazy-import pattern. The only genuine unknown is stored-JSONB field coverage on old rows, and the backfill + generator defaults make the failure mode a cosmetic sparse PDF, not an error.

## Plan (single lane)
1. Cut lane `client-shopping-list-pdf` (footprint above).
2. Implement the button + handler + mapping in `ClientShoppingList.js` (one file).
3. Verify: CI build; dev-DB shape check; manual download vs admin download.
4. Review: light (single focused reviewer — client-only display, nothing sensitive).
5. Merge by squash; cleanup on approval.

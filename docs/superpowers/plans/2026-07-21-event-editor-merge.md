---
spec: docs/superpowers/specs/2026-07-21-event-editor-merge-design.md
lanes:
  - id: event-editor-merge
    footprint:
      - client/src/pages/admin/proposalEditor/formState.js          # moved initialFormFromProposal + recoverAddonQuantities
      - client/src/pages/admin/proposalEditor/formState.test.js     # moved ProposalDetailEditForm.test.js
      - client/src/pages/admin/proposalEditor/patchBody.js          # NEW single payload builder (the latent-defect fix)
      - client/src/pages/admin/proposalEditor/patchBody.test.js
      - client/src/pages/admin/proposalEditor/repriceSummary.js     # NEW pure modal-decision + copy assembly
      - client/src/pages/admin/proposalEditor/repriceSummary.test.js
      - client/src/pages/admin/proposalEditor/RepriceConfirmModal.js # NEW presentational modal
      - client/src/pages/admin/proposalEditor/PackageSection.js     # moved Package/Add-ons/Glassware/Class/Syrups block
      - client/src/pages/admin/proposalEditor/ProposalEditorForm.js # the shared editor, both mounts
      - client/src/pages/admin/ProposalDetailEditForm.js            # DELETED (body moves to proposalEditor/)
      - client/src/pages/admin/ProposalDetailEditForm.test.js       # DELETED (moved to formState.test.js)
      - client/src/pages/admin/EventEditForm.js                     # DELETED (event mount uses ProposalEditorForm)
      - client/src/pages/admin/ProposalDetail.js                    # import swap only
      - client/src/pages/admin/EventDetailPage.js                   # mount swap only
      - README.md                                                   # folder tree
    blockedBy: []
    review: full-fleet   # client-only diff, but the form drives PATCH /proposals/:id (money path)
---

# Event Editor Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **House override:** lane model per CLAUDE.md. One lane, code-only, cut from current main. Client tests run via jest (react-scripts), NOT node:test.

**Goal:** The event page's Edit button opens the full proposal editor (guest count, package, add-ons, gratuity, override, live total) with a reprice-confirmation modal on booked events, and both mounts build their PATCH body through one shared builder so the `addon_quantities` reset defect becomes structurally impossible.

**Architecture:** Extract `ProposalDetailEditForm`'s body into `client/src/pages/admin/proposalEditor/` as a shared `ProposalEditorForm` mounted by both `ProposalDetail` (unchanged behavior, passes `changeRequest`) and `EventDetailPage` (gains all pricing sections; keeps its transient staff-notify toggles behind a prop). Pure logic lands in three testable modules: `formState.js` (moved helpers), `patchBody.js` (new single payload builder), `repriceSummary.js` (new modal decision + copy). No server changes; `PATCH /proposals/:id` is untouched.

**Tech Stack:** React 18 (CRA), jest via react-scripts for the pure modules, vanilla CSS (existing `.confirm-modal` classes).

## Global Constraints

- **No server changes.** Any edit outside `client/src/` (except README.md) is out of footprint: ABORT and surface.
- **File-size cap:** no new file over 700 lines. `ProposalEditorForm.js` must land under 700 (the PackageSection extraction exists to guarantee this).
- **No em dashes** in any user-visible copy (modal lines included). Use periods and commas.
- **Byte-parity rule:** the proposal mount's rendered sections and PATCH body must be behavior-identical to today's `ProposalDetailEditForm`. Moves are verbatim; the only intentional behavior changes are (a) the event mount gaining sections, (b) the event mount sending the full body, (c) the reprice modal.
- Client tests: `cd client && CI=true npx react-scripts test --watchAll=false --testPathPattern=proposalEditor`
- Client build gate: `cd client && CI=true npx react-scripts build`
- Git: explicit pathspec staging only. Lane checkpoints commit freely; squash merge is the unit.
- API calls via `client/src/utils/api.js` only (already true for all moved code).

---

### Task 1: `formState.js` move + `patchBody.js` (the single payload builder)

**Files:**
- Create: `client/src/pages/admin/proposalEditor/formState.js`
- Create: `client/src/pages/admin/proposalEditor/formState.test.js` (moved from `client/src/pages/admin/ProposalDetailEditForm.test.js`)
- Create: `client/src/pages/admin/proposalEditor/patchBody.js`
- Create: `client/src/pages/admin/proposalEditor/patchBody.test.js`

Old files are NOT deleted yet (Task 4 does that); until then the moved helpers exist in two places, which is fine because nothing imports the new module until Task 3/4.

**Interfaces:**
- Consumes: nothing new. `formState.js` content is a verbatim move of `initialFormFromProposal` (currently `ProposalDetailEditForm.js:735-777`) and `recoverAddonQuantities` with its comment block (currently `ProposalDetailEditForm.js:778-846`).
- Produces:
  - `formState.js`: `export function initialFormFromProposal(p)`, `export function recoverAddonQuantities(proposalAddons, catalog, { durationHours, guestCount })` (exact current signatures).
  - `patchBody.js`: `export function buildProposalPatchBody(form, { gratuityDirty = false, isClassPackage = false, changeRequestId, staffNotify = null })` returning the exact `PATCH /proposals/:id` body object. `staffNotify` is `null` (proposal mount: keys omitted entirely) or `{ enabled, sms, email }` booleans (event mount: `notify_assigned_staff: enabled`, `notify_staff_sms: enabled && sms`, `notify_staff_email: enabled && email`).

- [ ] **Step 1: Move the form-state helpers**

Create `client/src/pages/admin/proposalEditor/formState.js`:

```js
// Shared form-state builders for the proposal/event editor (ProposalEditorForm).
// Moved verbatim from ProposalDetailEditForm.js so both mounts seed identically.
```

Then append, byte-for-byte, `ProposalDetailEditForm.js` lines 735-846: the full `initialFormFromProposal` function and the full `recoverAddonQuantities` function including the multi-line comment between them. No edits to the moved code.

Copy `client/src/pages/admin/ProposalDetailEditForm.test.js` to `client/src/pages/admin/proposalEditor/formState.test.js` changing ONLY the import line:

```js
import { recoverAddonQuantities } from './formState';
```

- [ ] **Step 2: Run the moved tests to prove the move is clean**

Run: `cd client && CI=true npx react-scripts test --watchAll=false --testPathPattern=proposalEditor/formState`
Expected: PASS, same count as the old suite (run the old one first if unsure: `--testPathPattern=ProposalDetailEditForm`).

- [ ] **Step 3: Write the failing patchBody tests**

Create `client/src/pages/admin/proposalEditor/patchBody.test.js`:

```js
import { buildProposalPatchBody } from './patchBody';

// A representative filled form, shaped like initialFormFromProposal output.
const form = {
  event_date: '2026-08-08',
  event_start_time: '17:00',
  event_duration_hours: '5',
  venue_name: 'BrighterDaze Farm',
  venue_street: '1 Farm Rd',
  venue_city: 'Newark',
  venue_state: 'IL',
  venue_zip: '60541',
  guest_count: '75',
  package_id: '3',
  num_bars: '1',
  addon_ids: [7, '9'],
  addon_variants: { 7: 'non-alcoholic-bubbles' },
  addon_quantities: { 9: 3 },
  syrup_selections: [{ id: 1 }],
  adjustments: [{ type: 'discount', amount: 50 }],
  total_price_override: null,
  client_provides_glassware: false,
  class_options: { spirit_category: 'whiskey_bourbon', top_shelf_requested: true },
  setup_minutes_before: '',
  tip_jar: true,
  gratuity_total: '200',
};

describe('buildProposalPatchBody', () => {
  it('always includes addon_quantities (the EventEditForm latent-reset regression)', () => {
    const body = buildProposalPatchBody(form, {});
    expect(body.addon_quantities).toEqual({ 9: 3 });
  });

  it('coerces numerics and maps addon_ids to numbers', () => {
    const body = buildProposalPatchBody(form, {});
    expect(body.guest_count).toBe(75);
    expect(body.package_id).toBe(3);
    expect(body.num_bars).toBe(1);
    expect(body.event_duration_hours).toBe(5);
    expect(body.addon_ids).toEqual([7, 9]);
  });

  it('omits gratuity keys unless gratuityDirty', () => {
    const clean = buildProposalPatchBody(form, {});
    expect('tip_jar' in clean).toBe(false);
    expect('gratuity_total' in clean).toBe(false);
    const dirty = buildProposalPatchBody(form, { gratuityDirty: true });
    expect(dirty.tip_jar).toBe(true);
    expect(dirty.gratuity_total).toBe('200');
  });

  it('sends class_options only for class packages, null otherwise', () => {
    expect(buildProposalPatchBody(form, {}).class_options).toBeNull();
    expect(buildProposalPatchBody(form, { isClassPackage: true }).class_options)
      .toEqual(form.class_options);
  });

  it('maps setup_minutes_before blank to null, value to number', () => {
    expect(buildProposalPatchBody(form, {}).setup_minutes_before).toBeNull();
    expect(buildProposalPatchBody({ ...form, setup_minutes_before: '45' }, {}).setup_minutes_before).toBe(45);
  });

  it('omits notify keys without staffNotify, gates sub-flags with it', () => {
    const without = buildProposalPatchBody(form, {});
    expect('notify_assigned_staff' in without).toBe(false);
    const withNotify = buildProposalPatchBody(form, { staffNotify: { enabled: true, sms: false, email: true } });
    expect(withNotify.notify_assigned_staff).toBe(true);
    expect(withNotify.notify_staff_sms).toBe(false);
    expect(withNotify.notify_staff_email).toBe(true);
    const off = buildProposalPatchBody(form, { staffNotify: { enabled: false, sms: true, email: true } });
    expect(off.notify_assigned_staff).toBe(false);
    expect(off.notify_staff_sms).toBe(false);
    expect(off.notify_staff_email).toBe(false);
  });

  it('includes change_request_id only when provided', () => {
    expect('change_request_id' in buildProposalPatchBody(form, {})).toBe(false);
    expect(buildProposalPatchBody(form, { changeRequestId: 12 }).change_request_id).toBe(12);
  });

  it('passes glassware as a real boolean', () => {
    expect(buildProposalPatchBody(form, {}).client_provides_glassware).toBe(false);
    expect(buildProposalPatchBody({ ...form, client_provides_glassware: 1 }, {}).client_provides_glassware).toBe(true);
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `cd client && CI=true npx react-scripts test --watchAll=false --testPathPattern=proposalEditor/patchBody`
Expected: FAIL, cannot find module './patchBody'.

- [ ] **Step 5: Implement `patchBody.js`**

Create `client/src/pages/admin/proposalEditor/patchBody.js`:

```js
// The ONE place a proposal-editor save payload is built. Both mounts of
// ProposalEditorForm (proposal page and event page) call this, so the two
// surfaces cannot drift. History: the old EventEditForm built its own payload
// and omitted addon_quantities; the server defaults an absent quantity to 1
// (safeAddonQty), so a date edit from the event page silently reset admin-set
// add-on quantities. Structural fix: one builder, always complete.

export function buildProposalPatchBody(form, {
  gratuityDirty = false,
  isClassPackage = false,
  changeRequestId,
  staffNotify = null,
} = {}) {
  const body = {
    event_date: form.event_date,
    event_start_time: form.event_start_time,
    event_duration_hours: Number(form.event_duration_hours),
    venue_name: form.venue_name,
    venue_street: form.venue_street,
    venue_city: form.venue_city,
    venue_state: form.venue_state,
    venue_zip: form.venue_zip,
    guest_count: Number(form.guest_count),
    package_id: Number(form.package_id),
    num_bars: Number(form.num_bars) || 0,
    addon_ids: (form.addon_ids || []).map(Number),
    addon_variants: form.addon_variants || {},
    addon_quantities: form.addon_quantities || {},
    syrup_selections: form.syrup_selections || [],
    adjustments: form.adjustments || [],
    total_price_override: form.total_price_override,
    client_provides_glassware: !!form.client_provides_glassware,
    // Top Shelf is class-only. Only send class_options for a class package so
    // switching to a non-class package cannot trip the server-side guard.
    class_options: isClassPackage ? form.class_options : null,
    // Blank means reset to package default; the server treats null as the reset.
    setup_minutes_before: form.setup_minutes_before === '' || form.setup_minutes_before == null
      ? null
      : Number(form.setup_minutes_before),
  };
  // Persist the gratuity dollar ONLY when the admin edited it; otherwise omit
  // both keys so the server preserves the stored rate and rescales the dollar
  // by the new staffing (crud.js gratuity branch). See gratuityDirty in the form.
  if (gratuityDirty) {
    body.tip_jar = form.tip_jar !== false;
    body.gratuity_total = form.gratuity_total;
  }
  if (changeRequestId != null) body.change_request_id = changeRequestId;
  if (staffNotify) {
    // Sub-flags only ride when the parent toggle is on, so an unchecked parent
    // never leaks a stale sub-flag (EventEditForm's Phase 4a rule, preserved).
    body.notify_assigned_staff = !!staffNotify.enabled;
    body.notify_staff_sms = !!(staffNotify.enabled && staffNotify.sms);
    body.notify_staff_email = !!(staffNotify.enabled && staffNotify.email);
  }
  return body;
}
```

- [ ] **Step 6: Run to verify pass**

Run: `cd client && CI=true npx react-scripts test --watchAll=false --testPathPattern=proposalEditor`
Expected: PASS (formState + patchBody suites).

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/admin/proposalEditor/formState.js client/src/pages/admin/proposalEditor/formState.test.js client/src/pages/admin/proposalEditor/patchBody.js client/src/pages/admin/proposalEditor/patchBody.test.js
git commit -m "lane(event-editor-merge): formState move + single patch-body builder"
```

---

### Task 2: `repriceSummary.js` (modal decision + copy)

**Files:**
- Create: `client/src/pages/admin/proposalEditor/repriceSummary.js`
- Test: `client/src/pages/admin/proposalEditor/repriceSummary.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const BOOKED_STATUSES = ['deposit_paid', 'balance_paid', 'confirmed']` and `export function buildRepriceSummary({ status, totalPrice, amountPaid, newTotal })` returning `null` (save without modal) or `{ unknown, oldTotal, newTotal, delta, paid, newBalance, lines }` where `lines` is an array of fully formed strings. Money strings formatted `$1,234.56`.

- [ ] **Step 1: Write the failing tests**

Create `client/src/pages/admin/proposalEditor/repriceSummary.test.js`:

```js
import { buildRepriceSummary, BOOKED_STATUSES } from './repriceSummary';

describe('buildRepriceSummary', () => {
  it('exports the booked statuses the modal gates on', () => {
    expect(BOOKED_STATUSES).toEqual(['deposit_paid', 'balance_paid', 'confirmed']);
  });

  it('returns null for unbooked statuses even when price moves', () => {
    for (const status of ['draft', 'sent', 'viewed', 'accepted', 'completed', 'archived']) {
      expect(buildRepriceSummary({ status, totalPrice: '1000', amountPaid: '0', newTotal: 1500 })).toBeNull();
    }
  });

  it('returns null when booked but the total did not move', () => {
    expect(buildRepriceSummary({
      status: 'deposit_paid', totalPrice: '1606.25', amountPaid: '100', newTotal: 1606.25,
    })).toBeNull();
    // Sub-cent float noise does not count as movement.
    expect(buildRepriceSummary({
      status: 'deposit_paid', totalPrice: '1606.25', amountPaid: '100', newTotal: 1606.2500001,
    })).toBeNull();
  });

  it('increase while balance_paid: demotion line + invoice line + rebuild line', () => {
    const s = buildRepriceSummary({
      status: 'balance_paid', totalPrice: '1000', amountPaid: '1000', newTotal: 1250,
    });
    expect(s.delta).toBe(250);
    expect(s.newBalance).toBe(250);
    expect(s.lines).toEqual([
      'This event will drop back to deposit paid and autopay will be unenrolled.',
      'An Additional Services invoice will be created for the $250.00 increase.',
      'Unlocked invoices will be rebuilt at the new pricing. Locked and manual invoices stay untouched.',
    ]);
  });

  it('increase while deposit_paid: invoice line only, then rebuild line', () => {
    const s = buildRepriceSummary({
      status: 'deposit_paid', totalPrice: '1606.25', amountPaid: '100', newTotal: 1856.25,
    });
    expect(s.lines).toEqual([
      'An Additional Services invoice will be created for the $250.00 increase.',
      'Unlocked invoices will be rebuilt at the new pricing. Locked and manual invoices stay untouched.',
    ]);
    expect(s.oldTotal).toBe(1606.25);
    expect(s.paid).toBe(100);
    expect(s.newBalance).toBe(1756.25);
  });

  it('decrease below amount paid: overpaid line with the refund amount', () => {
    const s = buildRepriceSummary({
      status: 'balance_paid', totalPrice: '2000', amountPaid: '2000', newTotal: 1700,
    });
    expect(s.delta).toBe(-300);
    expect(s.lines).toEqual([
      'Client is now overpaid by $300.00. A refund is likely owed.',
      'Unlocked invoices will be rebuilt at the new pricing. Locked and manual invoices stay untouched.',
    ]);
  });

  it('decrease still above amount paid: rebuild line only', () => {
    const s = buildRepriceSummary({
      status: 'deposit_paid', totalPrice: '2000', amountPaid: '100', newTotal: 1700,
    });
    expect(s.lines).toEqual([
      'Unlocked invoices will be rebuilt at the new pricing. Locked and manual invoices stay untouched.',
    ]);
  });

  it('booked with preview unavailable: unknown summary, generic line', () => {
    const s = buildRepriceSummary({
      status: 'confirmed', totalPrice: '2425', amountPaid: '100', newTotal: null,
    });
    expect(s.unknown).toBe(true);
    expect(s.lines).toEqual([
      'Live pricing preview is unavailable. Saving will reprice on the server and the total may change.',
    ]);
  });

  it('formats thousands with commas', () => {
    const s = buildRepriceSummary({
      status: 'deposit_paid', totalPrice: '1000', amountPaid: '0', newTotal: 2250.5,
    });
    expect(s.lines[0]).toBe('An Additional Services invoice will be created for the $1,250.50 increase.');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && CI=true npx react-scripts test --watchAll=false --testPathPattern=proposalEditor/repriceSummary`
Expected: FAIL, cannot find module './repriceSummary'.

- [ ] **Step 3: Implement**

Create `client/src/pages/admin/proposalEditor/repriceSummary.js`:

```js
// Pure decision + copy assembly for the booked-event reprice confirmation.
// Client-side PREDICTION of what PATCH /proposals/:id will do (crud.js:
// payment-status reconcile, additional-invoice creation, invoice refresh).
// It never becomes a second decision-maker: the server transaction is
// byte-identical whether or not the modal was shown.

export const BOOKED_STATUSES = ['deposit_paid', 'balance_paid', 'confirmed'];

const usd = (n) => '$' + Number(n).toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

// Returns null when no confirmation is needed (unbooked, or total unmoved).
// Returns { unknown: true, lines } when booked but the live preview failed.
// Otherwise { oldTotal, newTotal, delta, paid, newBalance, lines }.
export function buildRepriceSummary({ status, totalPrice, amountPaid, newTotal }) {
  if (!BOOKED_STATUSES.includes(status)) return null;

  if (newTotal == null) {
    return {
      unknown: true,
      lines: ['Live pricing preview is unavailable. Saving will reprice on the server and the total may change.'],
    };
  }

  const oldTotal = Number(totalPrice) || 0;
  const next = Number(newTotal);
  const delta = next - oldTotal;
  if (Math.abs(delta) < 0.005) return null;

  const paid = Number(amountPaid) || 0;
  const lines = [];
  if (delta > 0) {
    if (status === 'balance_paid') {
      lines.push('This event will drop back to deposit paid and autopay will be unenrolled.');
    }
    lines.push(`An Additional Services invoice will be created for the ${usd(delta)} increase.`);
  } else if (next < paid) {
    lines.push(`Client is now overpaid by ${usd(paid - next)}. A refund is likely owed.`);
  }
  lines.push('Unlocked invoices will be rebuilt at the new pricing. Locked and manual invoices stay untouched.');

  return {
    unknown: false,
    oldTotal,
    newTotal: next,
    delta,
    paid,
    newBalance: next - paid,
    lines,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd client && CI=true npx react-scripts test --watchAll=false --testPathPattern=proposalEditor/repriceSummary`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/admin/proposalEditor/repriceSummary.js client/src/pages/admin/proposalEditor/repriceSummary.test.js
git commit -m "lane(event-editor-merge): repriceSummary decision + copy"
```

---

### Task 3: `RepriceConfirmModal` component

**Files:**
- Create: `client/src/pages/admin/proposalEditor/RepriceConfirmModal.js`

**Interfaces:**
- Consumes: a `summary` object from `buildRepriceSummary` (Task 2).
- Produces: `export default function RepriceConfirmModal({ isOpen, summary, onConfirm, onCancel })`. Presentational only; reuses the existing `.confirm-modal*` CSS classes (no CSS changes needed). Confirm button label: "Save and reprice".

- [ ] **Step 1: Implement the component**

Create `client/src/pages/admin/proposalEditor/RepriceConfirmModal.js`:

```js
import React, { useEffect, useRef } from 'react';

const usd = (n) => '$' + Number(n).toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

const sign = (n) => (n >= 0 ? '+' : '−') + usd(Math.abs(n)).slice(1);

// Booked-event reprice confirmation. Numbers + consequence lines come fully
// formed from buildRepriceSummary; this component only renders. Mirrors
// ConfirmModal's overlay/escape/focus behavior but with a structured body
// (ConfirmModal renders a single string message, which cannot show the
// old/new/delta table).
export default function RepriceConfirmModal({ isOpen, summary, onConfirm, onCancel }) {
  const confirmRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;
    confirmRef.current?.focus();
    const handleKeyDown = (e) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen || !summary) return null;

  return (
    <div className="confirm-modal-overlay" onClick={onCancel}>
      <div
        className="confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reprice-modal-title"
        onClick={e => e.stopPropagation()}
      >
        <h3 id="reprice-modal-title">This changes the price of a booked event</h3>
        {!summary.unknown && (
          <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', gap: '4px 16px', margin: '10px 0', fontSize: 13 }}>
            <span className="muted">Total</span>
            <span>{usd(summary.oldTotal)} {'→'} <strong>{usd(summary.newTotal)}</strong> ({sign(summary.delta)})</span>
            <span className="muted">Paid so far</span>
            <span>{usd(summary.paid)}</span>
            <span className="muted">New balance</span>
            <span>{usd(summary.newBalance)}</span>
          </div>
        )}
        <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
          {summary.lines.map((line, i) => <li key={i} style={{ marginBottom: 4 }}>{line}</li>)}
        </ul>
        <div className="confirm-modal-actions">
          <button className="btn btn-secondary btn-sm" onClick={onCancel}>Cancel</button>
          <button ref={confirmRef} className="btn btn-primary btn-sm" onClick={onConfirm}>Save and reprice</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd client && CI=true npx react-scripts build`
Expected: build succeeds (component not yet mounted; this catches syntax/lint only).

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/admin/proposalEditor/RepriceConfirmModal.js
git commit -m "lane(event-editor-merge): reprice confirmation modal component"
```

---

### Task 4: `ProposalEditorForm` + `PackageSection` extraction

**Files:**
- Create: `client/src/pages/admin/proposalEditor/PackageSection.js`
- Create: `client/src/pages/admin/proposalEditor/ProposalEditorForm.js`

Old files still not deleted; both editors coexist until Task 5 swaps the mounts. The build must pass with both present.

**Interfaces:**
- Consumes: `initialFormFromProposal`, `recoverAddonQuantities` from `./formState`; `buildProposalPatchBody` from `./patchBody`; `buildRepriceSummary`, `BOOKED_STATUSES` from `./repriceSummary`; `RepriceConfirmModal` from `./RepriceConfirmModal`; existing shared components (`PricingBreakdown`, `VenueAddressFields`, `ConfirmModal`, `FormBanner`, `FieldError`, `TimePicker`, `NumberStepper`, `AddonControls`) exactly as `ProposalDetailEditForm` imports them today (adjust relative paths one level deeper: `../../../` becomes `../../../` from `pages/admin/proposalEditor/` = `../../components/...` becomes `../../../components/...`).
- Produces:
  - `PackageSection.js`: `export default function PackageSection({ editForm, packages, filteredAddons, pkgIsHosted, update, toggleAddon, setAddonQty, setVariant })` rendering the Package, Add-ons, Glassware, Class options, and Syrups blocks.
  - `ProposalEditorForm.js`: `export default function ProposalEditorForm({ proposal, changeRequest, showStaffNotifyToggles = false, title = 'Edit proposal', onSaved, onCancel })`. Task 5 relies on this exact prop surface.

- [ ] **Step 1: Create `PackageSection.js`**

Move `ProposalDetailEditForm.js` lines 440-605 (the JSX from the `{/* Package */}` comment through the end of the Syrups block, exclusive of the `{/* Adjustments */}` comment) into the component below, verbatim except: `setEditForm(f => ...)` calls inside the champagne-variant checkbox become the `setVariant(addonId, variantOrUndefined)` callback.

```js
import React from 'react';
import { AddonQtyStepper } from '../../../components/AddonControls';

// Package, Add-ons, Glassware, Class options, and Syrups sections of the
// proposal/event editor. Moved verbatim from ProposalDetailEditForm so
// ProposalEditorForm stays under the file-size cap. Pure render: all state
// lives in the parent and arrives through the callbacks.
export default function PackageSection({
  editForm, packages, filteredAddons, pkgIsHosted,
  update, toggleAddon, setAddonQty, setVariant,
}) {
  return (
    <>
      {/* ...moved JSX, lines 440-605, verbatim... */}
    </>
  );
}
```

(The implementer moves the real JSX; the plan does not duplicate 165 lines here. Byte-parity rule applies: any change beyond the `setVariant` substitution and `React.Fragment` housekeeping is a defect.)

- [ ] **Step 2: Create `ProposalEditorForm.js`**

Start from a full copy of `ProposalDetailEditForm.js` lines 1-733 (everything except the exported helpers, which now live in `formState.js`), then apply exactly these changes:

1. **Imports:** component paths gain one `../` (file is one directory deeper). Add:

```js
import { initialFormFromProposal, recoverAddonQuantities } from './formState';
import { buildProposalPatchBody } from './patchBody';
import { buildRepriceSummary } from './repriceSummary';
import RepriceConfirmModal from './RepriceConfirmModal';
```

2. **Signature and new state:**

```js
export default function ProposalEditorForm({
  proposal, changeRequest, showStaffNotifyToggles = false,
  title = 'Edit proposal', onSaved, onCancel,
}) {
  // ...existing state hooks, unchanged...
  const [repriceSummary, setRepriceSummary] = useState(null);
  // Transient per-edit staff-notification toggles (event mount only). Not part
  // of `form`; they ride one PATCH and reset. Moved from EventEditForm.
  const [notifyStaff, setNotifyStaff] = useState(false);
  const [notifyStaffSms, setNotifyStaffSms] = useState(false);
  const [notifyStaffEmail, setNotifyStaffEmail] = useState(false);
```

3. **Save split.** Replace the current `handleSave` body's PATCH call with the shared builder, and split confirm-vs-save:

```js
  const doSave = async () => {
    setError('');
    setFieldErrors({});
    setSaving(true);
    try {
      if (proposal.client_id) {
        await api.put(`/clients/${proposal.client_id}`, {
          name: editForm.client_name,
          email: editForm.client_email,
          phone: editForm.client_phone,
          source: editForm.client_source,
        });
      }
      const res = await api.patch(`/proposals/${proposal.id}`, buildProposalPatchBody(editForm, {
        gratuityDirty,
        isClassPackage: selectedPkg?.bar_type === 'class',
        changeRequestId: changeRequest?.id,
        staffNotify: showStaffNotifyToggles
          ? { enabled: notifyStaff, sms: notifyStaffSms, email: notifyStaffEmail }
          : null,
      }));
      toast.success(showStaffNotifyToggles ? 'Event updated.' : 'Proposal updated.');
      onSaved?.(res.data);
    } catch (err) {
      setError(err.message || 'Failed to save changes.');
      setFieldErrors(err.fieldErrors || {});
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    if (!editForm.package_id) {
      setError('Please select a package.');
      setFieldErrors({ package_id: 'Please select a package' });
      return;
    }
    // Booked + price moved = confirm first. buildRepriceSummary returns null
    // for every other case, so unbooked proposals and pure logistics edits
    // save exactly as before.
    const summary = buildRepriceSummary({
      status: proposal.status,
      totalPrice: proposal.total_price,
      amountPaid: proposal.amount_paid,
      newTotal: editPreview ? editPreview.total : null,
    });
    if (summary) { setRepriceSummary(summary); return; }
    doSave();
  };
```

Note `selectedPkg` is declared AFTER `handleSave` in the current file (line 296). Move the `selectedPkg`/`filteredAddons`/`pkgIsHosted` derived block ABOVE the save functions so `doSave` can close over it.

4. **Replace the moved JSX** (old lines 440-605) with:

```js
        <PackageSection
          editForm={editForm}
          packages={packages}
          filteredAddons={filteredAddons}
          pkgIsHosted={pkgIsHosted}
          update={update}
          toggleAddon={toggleAddon}
          setAddonQty={setAddonQty}
          setVariant={(addonId, variant) => setEditForm(f => ({
            ...f,
            addon_variants: { ...f.addon_variants, [String(addonId)]: variant },
          }))}
        />
```

5. **Staff-notify toggles.** Immediately before the `<FormBanner .../>` line, insert the toggle block moved verbatim from `EventEditForm.js` (the `notifyStaff` parent checkbox and the two sub-checkboxes, currently `EventEditForm.js` lines ~236-271), wrapped:

```js
        {showStaffNotifyToggles && (
          <div style={{ paddingTop: 12, borderTop: '1px solid var(--line-1)', marginBottom: 12 }}>
            {/* ...moved verbatim from EventEditForm... */}
          </div>
        )}
```

6. **Card head** uses the `title` prop: `<h3>{title}</h3>` (current hard-coded text becomes the default prop value).

7. **Mount the modal** next to the existing leave-confirm `ConfirmModal`:

```js
      <RepriceConfirmModal
        isOpen={repriceSummary != null}
        summary={repriceSummary}
        onConfirm={() => { setRepriceSummary(null); doSave(); }}
        onCancel={() => setRepriceSummary(null)}
      />
```

- [ ] **Step 3: Verify build + size cap**

Run: `cd client && CI=true npx react-scripts build && wc -l src/pages/admin/proposalEditor/ProposalEditorForm.js`
Expected: build passes; line count under 700.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/admin/proposalEditor/PackageSection.js client/src/pages/admin/proposalEditor/ProposalEditorForm.js
git commit -m "lane(event-editor-merge): shared ProposalEditorForm + PackageSection"
```

---

### Task 5: Swap both mounts, delete the old editors, README

**Files:**
- Modify: `client/src/pages/admin/ProposalDetail.js` (lines 16, 452)
- Modify: `client/src/pages/admin/EventDetailPage.js` (lines 24, 296)
- Delete: `client/src/pages/admin/ProposalDetailEditForm.js`
- Delete: `client/src/pages/admin/ProposalDetailEditForm.test.js`
- Delete: `client/src/pages/admin/EventEditForm.js`
- Modify: `README.md` (folder tree: remove the two deleted files, add `proposalEditor/`)

**Interfaces:**
- Consumes: `ProposalEditorForm` prop surface from Task 4.
- Produces: nothing new; final wiring.

- [ ] **Step 1: Swap the proposal mount**

In `ProposalDetail.js`: replace the import
`import ProposalDetailEditForm from './ProposalDetailEditForm';`
with `import ProposalEditorForm from './proposalEditor/ProposalEditorForm';`
and the JSX `<ProposalDetailEditForm proposal={...} changeRequest={...} onSaved={...} onCancel={...} />` with `<ProposalEditorForm` and the same props, unchanged.

- [ ] **Step 2: Swap the event mount**

In `EventDetailPage.js`: replace `import EventEditForm from './EventEditForm';` with `import ProposalEditorForm from './proposalEditor/ProposalEditorForm';` and the mount:

```js
            <ProposalEditorForm
              proposal={proposal}
              showStaffNotifyToggles
              title="Edit event"
              onSaved={() => {
                setEditing(false);
                setLoading(true);
                reload().finally(() => setLoading(false));
              }}
              onCancel={() => setEditing(false)}
            />
```

- [ ] **Step 3: Delete the old editors and confirm nothing still imports them**

```bash
git rm client/src/pages/admin/ProposalDetailEditForm.js client/src/pages/admin/ProposalDetailEditForm.test.js client/src/pages/admin/EventEditForm.js
grep -rn "ProposalDetailEditForm\|EventEditForm" client/src --include=*.js
```

Expected grep output: comment-only references in `ProposalCreate.js` (lines 138, 236) and `AddonControls.js` (historical notes). Update those three comments to say `ProposalEditorForm`. Any remaining IMPORT of the deleted files is a failure.

- [ ] **Step 4: README folder tree**

In `README.md`'s client folder tree: remove `ProposalDetailEditForm.js` and `EventEditForm.js` entries, add `proposalEditor/ (shared proposal/event editor: form, sections, reprice modal)`.

- [ ] **Step 5: Full gates**

Run: `cd client && CI=true npx react-scripts test --watchAll=false --testPathPattern=proposalEditor && CI=true npx react-scripts build`
Expected: all suites pass; build clean.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/admin/ProposalDetail.js client/src/pages/admin/EventDetailPage.js client/src/pages/admin/ProposalCreate.js client/src/components/AddonControls.js README.md
git commit -m "lane(event-editor-merge): swap both mounts to ProposalEditorForm, delete old editors"
```

(The `git rm` from Step 3 is already staged.)

---

### Task 6: Manual verification on the dev DB (lane exit gate)

**Files:** none (verification only).

- [ ] **Step 1: Event-mount full edit.** On the local admin, open a booked event (e.g. `/events/9818`, Julia Neave, confirmed, $2,425). Click Edit. Verify all sections render: Client, Event, Package, Add-ons, Gratuity, Total override, Live preview, staff-notify toggles. Change guest count 100 to 120. Verify the live preview total moves.

- [ ] **Step 2: Reprice modal correctness.** Click Save changes. Modal must show old total $2,425.00, the new preview total, signed delta, paid $100.00, new balance, and (increase while confirmed) the Additional Services invoice line + the rebuild line, with NO demotion line. Cancel: form state intact. Save and reprice: toast, page reloads, new total visible, linked shift still in sync (check the Staffing card date/time).

- [ ] **Step 3: The latent-defect regression, live.** In the dev DB set an admin-set quantity: pick a booked proposal with a quantity-capable add-on (or add `additional-bartender` with qty 2 via the editor first). Then from the EVENT page change only the event date and save (confirming the modal if the total moved, e.g. bartender hours). Re-open the editor: the add-on quantity stepper must still show 2, and `proposal_addons.quantity` in the DB must not have collapsed to 1.

- [ ] **Step 4: Proposal-mount parity.** Open an UNBOOKED proposal (`sent`/`viewed`), edit guest count, save. No modal appears (spec: quoting workflow stays frictionless). Verify save works as before.

- [ ] **Step 5: Logistics-only edit, no modal.** On a booked event edit only the start time (no price change). Save. No modal.

- [ ] **Step 6: Decrease path.** On a booked event with payment recorded, reduce guest count enough to drop the total below `amount_paid` (dev data, e.g. proposal 41, balance_paid, $1,400). Modal must show the overpaid line with the correct dollar amount. Cancel without saving.

---

## Self-Review

- **Spec coverage:** one editor two mounts (Tasks 4-5), addon_quantities structural fix (Task 1 + Task 6 Step 3), reprice modal rules incl. unbooked/unmoved/unknown branches (Tasks 2-3, Task 6), staff toggles event-only (Task 4 Step 2.2/2.5), EventEditForm deleted (Task 5), file-size cap (Task 4 Step 3), README (Task 5 Step 4), no server changes (footprint), full-fleet review (front-matter). Search changes: correctly absent (out of scope).
- **Placeholder scan:** two deliberate verbatim-move directives (PackageSection JSX, staff-toggle JSX) reference exact source line ranges rather than duplicating 200 lines; both carry the byte-parity rule. All new code is complete.
- **Type consistency:** `buildProposalPatchBody(form, {gratuityDirty, isClassPackage, changeRequestId, staffNotify})` matches between Task 1 tests, Task 1 impl, and Task 4 call site. `buildRepriceSummary({status, totalPrice, amountPaid, newTotal})` matches Tasks 2 and 4. `RepriceConfirmModal {isOpen, summary, onConfirm, onCancel}` matches Tasks 3 and 4. `ProposalEditorForm` prop surface matches Tasks 4 and 5.

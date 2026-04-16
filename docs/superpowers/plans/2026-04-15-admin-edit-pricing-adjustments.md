# Admin Edit: Pricing Adjustments, Multi-Bar, Save Guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add discount/surcharge adjustments, total price override, multi-bar support, and unsaved-changes guard to the admin proposal edit flow.

**Architecture:** Two new columns on `proposals` (`adjustments` JSONB, `total_price_override` NUMERIC). Pricing engine applies adjustments after its formula calculation. Admin edit UI shows adjustments inline in the Package & Pricing card. Unsaved changes are guarded by `beforeunload` + ConfirmModal.

**Tech Stack:** Node.js/Express, PostgreSQL (raw SQL), React 18, vanilla CSS

**Spec:** `docs/superpowers/specs/2026-04-15-admin-edit-pricing-adjustments-design.md`

---

### Task 1: Schema Migration

**Files:**
- Modify: `server/db/schema.sql`

- [ ] **Step 1: Add columns after existing proposal ALTER statements**

In `server/db/schema.sql`, after the `event_type_custom` ALTER (around line 937), add:

```sql
-- ─── Proposal Price Adjustments ───────────────────────────────────
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS adjustments JSONB DEFAULT '[]';
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS total_price_override NUMERIC(10,2);
```

- [ ] **Step 2: Verify migration runs cleanly**

Run: `node -e "require('./server/db').query('SELECT adjustments, total_price_override FROM proposals LIMIT 1').then(r => console.log('OK:', r.rows)).catch(e => console.error(e.message)).finally(() => process.exit())"`

Expected: `OK: [ { adjustments: '[]', total_price_override: null } ]` (or similar)

- [ ] **Step 3: Commit**

```bash
git add server/db/schema.sql
git commit -m "schema: add adjustments JSONB + total_price_override columns to proposals"
```

---

### Task 2: Pricing Engine — Adjustments Support

**Files:**
- Modify: `server/utils/pricingEngine.js:111` (calculateProposal function signature)
- Modify: `server/utils/pricingEngine.js:165-266` (subtotal, breakdown, return)

- [ ] **Step 1: Update function signature**

Change line 111 from:

```javascript
function calculateProposal({ pkg, guestCount, durationHours, numBars, numBartenders, addons, syrupSelections }) {
```

to:

```javascript
function calculateProposal({ pkg, guestCount, durationHours, numBars, numBartenders, addons, syrupSelections, adjustments, totalPriceOverride }) {
```

- [ ] **Step 2: Apply adjustments after syrup breakdown, before return**

Replace lines 165-166:

```javascript
  const subtotal = baseCost + barRental + staffing.cost + addonTotal + syrupCost.total;
  const total = Math.round(subtotal * 100) / 100;
```

with:

```javascript
  const subtotal = baseCost + barRental + staffing.cost + addonTotal + syrupCost.total;

  // Apply price adjustments (discounts/surcharges)
  const safeAdjustments = Array.isArray(adjustments) ? adjustments : [];
  const adjustmentNet = safeAdjustments.reduce((sum, adj) => {
    const amt = Math.abs(Number(adj.amount) || 0);
    return sum + (adj.type === 'discount' ? -amt : amt);
  }, 0);
  const calculatedTotal = Math.max(0, Math.round((subtotal + adjustmentNet) * 100) / 100);
  const total = totalPriceOverride != null ? Math.round(Number(totalPriceOverride) * 100) / 100 : calculatedTotal;
```

- [ ] **Step 3: Add adjustment line items to breakdown**

After the syrup breakdown push (after line 224 — `breakdown.push({ label: syrupLabel, amount: syrupCost.total });`), add:

```javascript
  for (const adj of safeAdjustments) {
    const amt = Math.abs(Number(adj.amount) || 0);
    breakdown.push({
      label: adj.label || (adj.type === 'discount' ? 'Discount' : 'Surcharge'),
      amount: adj.type === 'discount' ? -amt : amt
    });
  }
```

- [ ] **Step 4: Add new fields to return object**

In the return object (starts line 227), add these fields after `floor_applied`:

```javascript
    adjustments: safeAdjustments,
    total_price_override: totalPriceOverride ?? null,
    subtotal: Math.round(subtotal * 100) / 100,
```

And update the existing `total` field — it's already using the new `total` variable from step 2, so no change needed there.

- [ ] **Step 5: Verify engine still works without adjustments**

Run: `node -e "const { calculateProposal } = require('./server/utils/pricingEngine'); const r = calculateProposal({ pkg: { id: 1, slug: 'test', name: 'Test', category: 'byob', pricing_type: 'flat', base_rate_4hr: 300, extra_hour_rate: 75, first_bar_fee: 50, additional_bar_fee: 100, bartenders_included: 1, guests_per_bartender: 100, extra_bartender_hourly: 40 }, guestCount: 50, durationHours: 4, numBars: 1, addons: [], syrupSelections: [] }); console.log('total:', r.total, 'subtotal:', r.subtotal, 'adjustments:', r.adjustments);"`

Expected: `total: 350 subtotal: 350 adjustments: []`

- [ ] **Step 6: Verify adjustments work**

Run: `node -e "const { calculateProposal } = require('./server/utils/pricingEngine'); const r = calculateProposal({ pkg: { id: 1, slug: 'test', name: 'Test', category: 'byob', pricing_type: 'flat', base_rate_4hr: 300, extra_hour_rate: 75, first_bar_fee: 50, additional_bar_fee: 100, bartenders_included: 1, guests_per_bartender: 100, extra_bartender_hourly: 40 }, guestCount: 50, durationHours: 4, numBars: 1, addons: [], syrupSelections: [], adjustments: [{ type: 'discount', label: 'Test discount', amount: 50, visible: true }] }); console.log('total:', r.total, 'subtotal:', r.subtotal, 'breakdown:', r.breakdown.map(b => b.label + ': ' + b.amount));"`

Expected: `total: 300 subtotal: 350` and breakdown includes `Test discount: -50`

- [ ] **Step 7: Commit**

```bash
git add server/utils/pricingEngine.js
git commit -m "feat: add adjustments + total override support to pricing engine"
```

---

### Task 3: Backend Routes — Calculate & PATCH Endpoints

**Files:**
- Modify: `server/routes/proposals.js:556-586` (POST /calculate)
- Modify: `server/routes/proposals.js:815-905` (PATCH /:id)

- [ ] **Step 1: Update admin calculate endpoint**

In the `POST /calculate` handler (line 557), update the destructuring:

```javascript
  const { package_id, guest_count, duration_hours, num_bars, num_bartenders, addon_ids, syrup_selections, adjustments, total_price_override } = req.body;
```

And update the `calculateProposal` call (line 571-578):

```javascript
    const snapshot = calculateProposal({
      pkg: pkgResult.rows[0],
      guestCount: guest_count || 50,
      durationHours: duration_hours || 4,
      numBars: num_bars ?? 1,
      numBartenders: num_bartenders,
      addons,
      syrupSelections: syrup_selections || [],
      adjustments: adjustments || [],
      totalPriceOverride: total_price_override ?? null,
    });
```

- [ ] **Step 2: Update PATCH endpoint destructuring**

In the `PATCH /:id` handler (line 816-820), add `adjustments` and `total_price_override`:

```javascript
  const {
    event_name, event_date, event_start_time, event_duration_hours,
    event_location, guest_count, package_id, num_bars, num_bartenders, addon_ids,
    syrup_selections, event_type, event_type_category, event_type_custom,
    adjustments, total_price_override
  } = req.body;
```

- [ ] **Step 3: Pass adjustments to calculateProposal in PATCH**

After line 851 (`const syrups = syrup_selections ?? ...`), add:

```javascript
    const adj = adjustments ?? (old.adjustments || []);
    const tpo = total_price_override !== undefined ? total_price_override : old.total_price_override;
```

Update the `calculateProposal` call (line 856-859):

```javascript
    const snapshot = calculateProposal({
      pkg: pkgResult.rows[0], guestCount: gc, durationHours: dh, numBars: nb,
      numBartenders: num_bartenders, addons, syrupSelections: syrups,
      adjustments: adj, totalPriceOverride: tpo,
    });
```

- [ ] **Step 4: Store adjustments in the UPDATE query**

Update the SQL UPDATE (line 861-877) to include the two new columns. Add `adjustments = $16, total_price_override = $17` to the SET clause, and add the values to the parameter array:

```javascript
    await dbClient.query(`
      UPDATE proposals SET
        event_name = COALESCE($1, event_name), event_date = COALESCE($2, event_date),
        event_start_time = COALESCE($3, event_start_time), event_duration_hours = $4,
        event_location = COALESCE($5, event_location), guest_count = $6,
        package_id = $7, num_bars = $8, num_bartenders = $9,
        pricing_snapshot = $10, total_price = $11,
        event_type = COALESCE($13, event_type),
        event_type_category = COALESCE($14, event_type_category),
        event_type_custom = COALESCE($15, event_type_custom),
        adjustments = $16, total_price_override = $17
      WHERE id = $12
    `, [
      event_name, event_date, event_start_time, dh, event_location, gc,
      pkgId, nb, snapshot.staffing.actual,
      JSON.stringify(snapshot), snapshot.total, req.params.id,
      event_type || null, event_type_category || null, event_type_custom || null,
      JSON.stringify(adj), tpo ?? null
    ]);
```

- [ ] **Step 5: Commit**

```bash
git add server/routes/proposals.js
git commit -m "feat: accept adjustments + total_price_override in calculate and PATCH proposal endpoints"
```

---

### Task 4: PricingBreakdown — Negative Amount Styling

**Files:**
- Modify: `client/src/components/PricingBreakdown.js`

- [ ] **Step 1: Update formatCurrency to handle negatives**

Replace the existing `formatCurrency` function (line 6-7):

```javascript
  const formatCurrency = (amount) =>
    `$${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
```

with:

```javascript
  const formatCurrency = (amount) => {
    const num = Number(amount);
    const abs = Math.abs(num);
    const formatted = `$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return num < 0 ? `-${formatted}` : formatted;
  };
```

- [ ] **Step 2: Add green color for negative amounts**

Update the amount `<td>` (lines 18-24) to conditionally apply green for negative values:

```javascript
              <td style={{
                padding: compact ? '0.4rem 0' : '0.6rem 0',
                textAlign: 'right',
                fontWeight: 500,
                whiteSpace: 'nowrap',
                color: Number(item.amount) < 0 ? '#2d6a4f' : 'var(--deep-brown, #3a2218)'
              }}>
                {formatCurrency(item.amount)}
              </td>
```

- [ ] **Step 3: Commit**

```bash
git add client/src/components/PricingBreakdown.js
git commit -m "feat: render negative amounts (discounts) in green in PricingBreakdown"
```

---

### Task 5: ProposalCreate — Multi-Bar Number Picker

**Files:**
- Modify: `client/src/pages/admin/ProposalCreate.js`

- [ ] **Step 1: Replace needs_bar with num_bars in form state**

Change line 34 in the form initial state:

```javascript
    event_location: '', guest_count: 50, package_id: '', needs_bar: false,
```

to:

```javascript
    event_location: '', guest_count: 50, package_id: '', num_bars: 0,
```

- [ ] **Step 2: Remove numBarsForCalc variable**

Delete line 51:

```javascript
  const numBarsForCalc = form.needs_bar ? 1 : 0;
```

- [ ] **Step 3: Update fetchPreview to use num_bars directly**

Change line 60:

```javascript
        num_bars: form.needs_bar ? 1 : 0,
```

to:

```javascript
        num_bars: Number(form.num_bars) || 0,
```

Update the `useCallback` dependency array (line 66) — replace `form.needs_bar` with `form.num_bars`:

```javascript
  }, [form.package_id, form.guest_count, form.event_duration_hours, form.num_bars, form.num_bartenders, form.addon_ids]);
```

- [ ] **Step 4: Update submit payload**

Change line 148:

```javascript
        num_bars: form.needs_bar ? 1 : 0,
```

to:

```javascript
        num_bars: Number(form.num_bars) || 0,
```

- [ ] **Step 5: Replace dropdown with number input in JSX**

Replace lines 287-293:

```jsx
                <div className="form-group">
                  <label className="form-label">Portable Bar Needed?</label>
                  <select className="form-select" value={form.needs_bar ? 'yes' : 'no'} onChange={e => update('needs_bar', e.target.value === 'yes')}>
                    <option value="no">No — venue has a bar</option>
                    <option value="yes">Yes</option>
                  </select>
                </div>
```

with:

```jsx
                <div className="form-group">
                  <label className="form-label">Portable Bars</label>
                  <input className="form-input" type="number" min="0" max="5" value={form.num_bars} onChange={e => update('num_bars', e.target.value)} />
                </div>
```

- [ ] **Step 6: Verify in browser**

Open `/admin/proposals/create`, confirm the bar field is a number input (0-5). Change the value and verify the pricing preview updates.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/admin/ProposalCreate.js
git commit -m "feat: replace needs_bar boolean with num_bars number picker in ProposalCreate"
```

---

### Task 6: ProposalDetail — Multi-Bar + Adjustments UI + Unsaved Guard

**Files:**
- Modify: `client/src/pages/admin/ProposalDetail.js`

This is the largest task. Three sub-changes: multi-bar, adjustments UI in the pricing card, and unsaved changes guard.

- [ ] **Step 1: Add imports**

Update line 1 to include `useRef` and `useCallback`:

```javascript
import React, { useState, useEffect, useRef, useCallback } from 'react';
```

Add ConfirmModal import after line 9 (after the SyrupPicker import):

```javascript
import ConfirmModal from '../../components/ConfirmModal';
```

- [ ] **Step 2: Add unsaved guard state**

After line 101 (`const [showActivityPopup, setShowActivityPopup] = useState(false);`), add:

```javascript
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState(null);
  const editFormInitialRef = useRef(null);
```

- [ ] **Step 3: Update editForm initialization for multi-bar and adjustments**

In the edit form population block (lines 268-289), replace:

```javascript
      setEditForm({
        // Client fields
        client_name: proposal.client_name || '',
        client_email: proposal.client_email || '',
        client_phone: proposal.client_phone || '',
        client_source: proposal.client_source || 'thumbtack',
        // Event fields
        event_name: proposal.event_name || '',
        event_date: proposal.event_date ? proposal.event_date.slice(0, 10) : '',
        event_start_time: proposal.event_start_time || '',
        event_duration_hours: Number(proposal.event_duration_hours) || 4,
        event_location: proposal.event_location || '',
        guest_count: proposal.guest_count || 50,
        package_id: proposal.package_id || '',
        needs_bar: proposal.num_bars > 0,
        addon_ids: currentAddonIds,
        syrup_selections: snapshot.syrups?.selections || [],
      });
```

with:

```javascript
      const initial = {
        // Client fields
        client_name: proposal.client_name || '',
        client_email: proposal.client_email || '',
        client_phone: proposal.client_phone || '',
        client_source: proposal.client_source || 'thumbtack',
        // Event fields
        event_name: proposal.event_name || '',
        event_date: proposal.event_date ? proposal.event_date.slice(0, 10) : '',
        event_start_time: proposal.event_start_time || '',
        event_duration_hours: Number(proposal.event_duration_hours) || 4,
        event_location: proposal.event_location || '',
        guest_count: proposal.guest_count || 50,
        package_id: proposal.package_id || '',
        num_bars: proposal.num_bars || 0,
        addon_ids: currentAddonIds,
        syrup_selections: snapshot.syrups?.selections || [],
        adjustments: proposal.adjustments || [],
        total_price_override: proposal.total_price_override ?? null,
      };
      setEditForm(initial);
      editFormInitialRef.current = JSON.stringify(initial);
```

- [ ] **Step 4: Update live preview to pass adjustments**

Replace lines 293-303 (the live pricing preview useEffect):

```javascript
  useEffect(() => {
    if (!editing || !editForm || !editForm.package_id) { setEditPreview(null); return; }
    api.post('/proposals/calculate', {
      package_id: Number(editForm.package_id),
      guest_count: Number(editForm.guest_count) || 50,
      duration_hours: Number(editForm.event_duration_hours) || 4,
      num_bars: editForm.needs_bar ? 1 : 0,
      addon_ids: (editForm.addon_ids || []).map(Number),
      syrup_selections: editForm.syrup_selections || [],
    }).then(res => { setEditPreview(res.data); setEditError(''); }).catch(() => { setEditPreview(null); setEditError('Pricing preview unavailable.'); });
  }, [editing, editForm?.package_id, editForm?.guest_count, editForm?.event_duration_hours, editForm?.needs_bar, editForm?.addon_ids, editForm?.syrup_selections]); // eslint-disable-line
```

with:

```javascript
  useEffect(() => {
    if (!editing || !editForm || !editForm.package_id) { setEditPreview(null); return; }
    api.post('/proposals/calculate', {
      package_id: Number(editForm.package_id),
      guest_count: Number(editForm.guest_count) || 50,
      duration_hours: Number(editForm.event_duration_hours) || 4,
      num_bars: Number(editForm.num_bars) || 0,
      addon_ids: (editForm.addon_ids || []).map(Number),
      syrup_selections: editForm.syrup_selections || [],
      adjustments: editForm.adjustments || [],
      total_price_override: editForm.total_price_override,
    }).then(res => { setEditPreview(res.data); setEditError(''); }).catch(() => { setEditPreview(null); setEditError('Pricing preview unavailable.'); });
  }, [editing, editForm?.package_id, editForm?.guest_count, editForm?.event_duration_hours, editForm?.num_bars, editForm?.addon_ids, editForm?.syrup_selections, editForm?.adjustments, editForm?.total_price_override]); // eslint-disable-line
```

- [ ] **Step 5: Update handleSaveEdit payload**

Replace lines 329-340 in `handleSaveEdit`:

```javascript
      await api.patch(`/proposals/${id}`, {
        event_name: editForm.event_name,
        event_date: editForm.event_date,
        event_start_time: editForm.event_start_time,
        event_duration_hours: Number(editForm.event_duration_hours),
        event_location: editForm.event_location,
        guest_count: Number(editForm.guest_count),
        package_id: Number(editForm.package_id),
        num_bars: editForm.needs_bar ? 1 : 0,
        addon_ids: (editForm.addon_ids || []).map(Number),
        syrup_selections: editForm.syrup_selections || [],
      });
```

with:

```javascript
      await api.patch(`/proposals/${id}`, {
        event_name: editForm.event_name,
        event_date: editForm.event_date,
        event_start_time: editForm.event_start_time,
        event_duration_hours: Number(editForm.event_duration_hours),
        event_location: editForm.event_location,
        guest_count: Number(editForm.guest_count),
        package_id: Number(editForm.package_id),
        num_bars: Number(editForm.num_bars) || 0,
        addon_ids: (editForm.addon_ids || []).map(Number),
        syrup_selections: editForm.syrup_selections || [],
        adjustments: editForm.adjustments || [],
        total_price_override: editForm.total_price_override,
      });
```

- [ ] **Step 6: Add dirty check helper and beforeunload guard**

After the `toggleEditAddon` function (after line 312), add:

```javascript
  const isEditDirty = useCallback(() => {
    if (!editing || !editForm || !editFormInitialRef.current) return false;
    return JSON.stringify(editForm) !== editFormInitialRef.current;
  }, [editing, editForm]);

  // Warn on browser refresh/close with unsaved changes
  useEffect(() => {
    const handler = (e) => { if (isEditDirty()) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isEditDirty]);

  const handleNavigateAway = (destination) => {
    if (isEditDirty()) {
      setPendingNavigation(destination);
      setShowLeaveConfirm(true);
    } else {
      navigate(destination);
    }
  };

  const confirmLeave = () => {
    setShowLeaveConfirm(false);
    setEditing(false);
    setEditForm(null);
    setEditError('');
    if (pendingNavigation) navigate(pendingNavigation);
    setPendingNavigation(null);
  };

  const cancelLeave = () => {
    setShowLeaveConfirm(false);
    setPendingNavigation(null);
  };

  const handleCancelEdit = () => {
    if (isEditDirty()) {
      setPendingNavigation(null);
      setShowLeaveConfirm(true);
    } else {
      setEditing(false);
      setEditForm(null);
      setEditError('');
    }
  };

  // Adjustment helpers
  const addAdjustment = (type) => {
    setEditForm(f => ({
      ...f,
      adjustments: [...(f.adjustments || []), { type, label: '', amount: '', visible: true }]
    }));
  };

  const updateAdjustment = (index, field, value) => {
    setEditForm(f => {
      const updated = [...f.adjustments];
      updated[index] = { ...updated[index], [field]: value };
      return { ...f, adjustments: updated };
    });
  };

  const removeAdjustment = (index) => {
    setEditForm(f => ({
      ...f,
      adjustments: f.adjustments.filter((_, i) => i !== index)
    }));
  };
```

- [ ] **Step 7: Update Back button to use navigation guard**

Replace line 1209:

```javascript
          <button className="btn btn-secondary" onClick={() => navigate(isEventContext ? '/admin/events' : '/admin/proposals')}>Back</button>
```

with:

```javascript
          <button className="btn btn-secondary" onClick={() => editing ? handleNavigateAway(isEventContext ? '/admin/events' : '/admin/proposals') : navigate(isEventContext ? '/admin/events' : '/admin/proposals')}>Back</button>
```

- [ ] **Step 8: Replace bar rental dropdown with number input**

Replace lines 1341-1347:

```jsx
                <div className="form-group">
                  <label className="form-label">Portable Bar Needed?</label>
                  <select className="form-select" value={editForm.needs_bar ? 'yes' : 'no'} onChange={e => updateEdit('needs_bar', e.target.value === 'yes')}>
                    <option value="yes">Yes</option>
                    <option value="no">No — venue has a bar</option>
                  </select>
                </div>
```

with:

```jsx
                <div className="form-group">
                  <label className="form-label">Portable Bars</label>
                  <input className="form-input" type="number" min="0" max="5" value={editForm.num_bars} onChange={e => updateEdit('num_bars', e.target.value)} />
                </div>
```

- [ ] **Step 9: Update Cancel button to use guard**

Replace lines 1432-1433:

```jsx
                <button className="btn btn-secondary" onClick={() => { setEditing(false); setEditForm(null); setEditError(''); }}>
                  Cancel
                </button>
```

with:

```jsx
                <button className="btn btn-secondary" onClick={handleCancelEdit}>
                  Cancel
                </button>
```

- [ ] **Step 10: Add adjustments UI in the Package & Pricing card**

After the `PricingBreakdown` line (line 1618):

```jsx
            <PricingBreakdown snapshot={editing ? editPreview : snapshot} />
```

Add the adjustments UI (only visible when editing):

```jsx
            {editing && editForm && (
              <div style={{ marginTop: '1rem', borderTop: '1px solid var(--cream-dark, #e8e0d4)', paddingTop: '1rem' }}>
                <h4 style={{ color: 'var(--warm-brown)', marginBottom: '0.5rem', fontSize: '0.95rem' }}>Price Adjustments</h4>
                {(editForm.adjustments || []).map((adj, i) => (
                  <div key={i} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
                    <span style={{
                      fontSize: '0.75rem', fontWeight: 600, padding: '0.15rem 0.5rem', borderRadius: '4px',
                      background: adj.type === 'discount' ? '#d4edda' : '#fde8e8',
                      color: adj.type === 'discount' ? '#155724' : '#721c24',
                      whiteSpace: 'nowrap',
                    }}>
                      {adj.type === 'discount' ? 'Discount' : 'Surcharge'}
                    </span>
                    <input
                      className="form-input"
                      placeholder="Label (e.g., Returning client)"
                      value={adj.label}
                      onChange={e => updateAdjustment(i, 'label', e.target.value)}
                      style={{ flex: 1, fontSize: '0.85rem', padding: '0.3rem 0.5rem' }}
                    />
                    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                      <span style={{ position: 'absolute', left: '0.5rem', color: 'var(--warm-brown)', fontSize: '0.85rem', pointerEvents: 'none' }}>$</span>
                      <input
                        className="form-input"
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="0.00"
                        value={adj.amount}
                        onChange={e => updateAdjustment(i, 'amount', e.target.value)}
                        style={{ width: '100px', fontSize: '0.85rem', padding: '0.3rem 0.5rem 0.3rem 1.2rem' }}
                      />
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.75rem', color: 'var(--warm-brown)', whiteSpace: 'nowrap', cursor: 'pointer' }}>
                      <input type="checkbox" checked={adj.visible} onChange={e => updateAdjustment(i, 'visible', e.target.checked)} />
                      Client sees
                    </label>
                    <button
                      type="button"
                      onClick={() => removeAdjustment(i)}
                      style={{ background: 'none', border: 'none', color: '#c0392b', cursor: 'pointer', fontSize: '1.1rem', padding: '0 0.25rem', lineHeight: 1 }}
                      title="Remove"
                    >
                      &times;
                    </button>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => addAdjustment('discount')}>+ Discount</button>
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => addAdjustment('surcharge')}>+ Surcharge</button>
                </div>

                {/* Total Override */}
                <div style={{ marginTop: '1rem', borderTop: '1px solid var(--cream-dark, #e8e0d4)', paddingTop: '0.75rem' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', color: 'var(--warm-brown)', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={editForm.total_price_override != null}
                      onChange={e => updateEdit('total_price_override', e.target.checked ? (editPreview?.subtotal || editPreview?.total || 0) : null)}
                    />
                    Override Total
                  </label>
                  {editForm.total_price_override != null && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.4rem' }}>
                      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                        <span style={{ position: 'absolute', left: '0.5rem', color: 'var(--warm-brown)', fontSize: '0.9rem', pointerEvents: 'none' }}>$</span>
                        <input
                          className="form-input"
                          type="number"
                          min="0"
                          step="0.01"
                          value={editForm.total_price_override}
                          onChange={e => updateEdit('total_price_override', e.target.value !== '' ? Number(e.target.value) : null)}
                          style={{ width: '140px', fontSize: '0.9rem', padding: '0.35rem 0.5rem 0.35rem 1.2rem' }}
                        />
                      </div>
                      <span className="text-muted text-small">Overrides calculated total</span>
                    </div>
                  )}
                </div>
              </div>
            )}
```

- [ ] **Step 11: Add ConfirmModal for unsaved changes at end of component**

Just before the final closing `</div>` of the component's return (the very end of the JSX), add:

```jsx
      <ConfirmModal
        isOpen={showLeaveConfirm}
        title="Unsaved Changes"
        message="You have unsaved changes. Leave without saving?"
        onConfirm={confirmLeave}
        onCancel={cancelLeave}
      />
```

- [ ] **Step 12: Verify in browser**

1. Open any proposal → Edit → confirm bar is number input
2. Add a discount → pricing preview updates with green negative line
3. Add a surcharge → pricing preview updates
4. Toggle "Client sees" checkbox
5. Enable Override Total → enter a number → preview total changes
6. Make a change, click Back → ConfirmModal appears
7. Make a change, click Cancel → ConfirmModal appears
8. Save → all changes persist on reload

- [ ] **Step 13: Commit**

```bash
git add client/src/pages/admin/ProposalDetail.js
git commit -m "feat: add adjustments UI, multi-bar picker, total override, and unsaved changes guard to admin edit"
```

---

### Task 7: Client-Facing ProposalView — Render Visible Adjustments

**Files:**
- Modify: `client/src/pages/proposal/ProposalView.js:285-307`

- [ ] **Step 1: Add adjustments to lineItems builder**

After line 306 (`lineItems.push({ label: syrupLabel, amount: sc.total });` inside the syrups block, but still inside the `if (snapshot)` block), add:

```javascript
    (snapshot.adjustments || []).forEach(adj => {
      if (!adj.visible) return;
      const amt = Math.abs(Number(adj.amount) || 0);
      lineItems.push({
        label: adj.label || (adj.type === 'discount' ? 'Discount' : 'Surcharge'),
        amount: adj.type === 'discount' ? -amt : amt,
      });
    });
```

- [ ] **Step 2: Style negative amounts in the line items rendering**

Update the amount `<td>` in the lineItems map (line 421-422):

```jsx
                  <td style={{ padding: '0.55rem 0', textAlign: 'right', color: '#3a2218', fontSize: '0.95rem', fontWeight: 500, whiteSpace: 'nowrap' }}>
                    {fmt(item.amount)}
                  </td>
```

to:

```jsx
                  <td style={{ padding: '0.55rem 0', textAlign: 'right', color: Number(item.amount) < 0 ? '#2d6a4f' : '#3a2218', fontSize: '0.95rem', fontWeight: 500, whiteSpace: 'nowrap' }}>
                    {Number(item.amount) < 0 ? `-${fmt(Math.abs(item.amount))}` : fmt(item.amount)}
                  </td>
```

- [ ] **Step 3: Verify in browser**

Open a proposal by its public token URL that has a visible discount. Confirm:
- Discount appears as a green negative line item
- Hidden adjustments don't show
- Total reflects all adjustments

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/proposal/ProposalView.js
git commit -m "feat: render visible price adjustments on client-facing proposal view"
```

---

### Task 8: CSS — Save Bar Enhancement

**Files:**
- Modify: `client/src/index.css:1140-1150`

- [ ] **Step 1: Update sticky-save-bar styles**

Replace lines 1140-1150:

```css
.sticky-save-bar {
  position: sticky;
  bottom: 0;
  background: var(--cream, #fdf8f0);
  padding: 1rem 0;
  margin-top: 1rem;
  border-top: 1px solid var(--cream-dark, #e8e0d4);
  z-index: 10;
  display: flex;
  gap: 0.5rem;
}
```

with:

```css
.sticky-save-bar {
  position: sticky;
  bottom: 0;
  background: var(--cream, #fdf8f0);
  padding: 1rem 1.5rem;
  margin: 1.5rem -1.5rem -1.5rem;
  border-top: 2px solid var(--deep-brown, #3a2218);
  z-index: 10;
  display: flex;
  gap: 0.75rem;
  box-shadow: 0 -4px 12px rgba(0,0,0,0.1);
}

.sticky-save-bar .btn:first-child {
  background: var(--amber, #d4a24e);
  color: var(--deep-brown, #3a2218);
  font-size: 1rem;
  padding: 0.6rem 2rem;
  font-weight: 700;
  border: none;
}

.sticky-save-bar .btn:first-child:hover {
  background: #c4922e;
}
```

- [ ] **Step 2: Verify in browser**

Open any proposal → Edit → confirm the save bar has a shadow, darker border, and the Save button is amber/gold and larger.

- [ ] **Step 3: Commit**

```bash
git add client/src/index.css
git commit -m "style: enhance sticky save bar with shadow, stronger border, and amber save button"
```

---

## Verification Checklist

After all tasks complete, run through end-to-end:

1. [ ] **Admin edit — multi-bar:** Number input (0-5), pricing updates per bar count
2. [ ] **Admin edit — discount:** Add discount with label, amount decreases, green in breakdown
3. [ ] **Admin edit — surcharge:** Add surcharge, amount increases
4. [ ] **Admin edit — visibility toggle:** "Client sees" checkbox controls client-facing display
5. [ ] **Admin edit — total override:** Checkbox + dollar input, replaces calculated total
6. [ ] **Admin edit — save persists:** All adjustments survive save + reload
7. [ ] **Admin edit — unsaved guard:** Back button and Cancel trigger ConfirmModal when dirty
8. [ ] **Admin edit — browser close:** `beforeunload` warning on refresh with unsaved edits
9. [ ] **Admin create — multi-bar:** Number picker, no adjustments section
10. [ ] **Client proposal view:** Visible adjustments appear, hidden ones don't, total correct
11. [ ] **Payment integrity:** After discount, balance = total_price - amount_paid
12. [ ] **Save bar visual:** Shadow, amber button, visually prominent

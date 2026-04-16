# Invoice/Receipt System — Design Spec

**Date:** 2026-04-15
**Status:** Approved
**Scope:** Proposal-linked invoices only (standalone invoices deferred to future project)

---

## Overview

Add an invoice system that sits on top of the existing proposal/payment infrastructure. Invoices are auto-generated at key lifecycle moments (proposal sent, deposit paid, items added after payment) and can also be created manually by admin. Each invoice has a shareable token-gated URL where anyone can view details and pay via Stripe. Invoices double as receipts — a paid invoice displays a "PAID" stamp and serves as the receipt document. PDF generation is client-side via html2pdf.js.

## Core Design Decisions

1. **Hybrid locking:** Invoices update freely (line items regenerate from proposal) until a payment is recorded. Payment locks the invoice — line items become a permanent snapshot. New charges after locking create a new invoice.
2. **Invoice = receipt:** One document, two visual states. Unpaid shows balance + pay button. Paid shows green "PAID" stamp + payment details. No separate receipt documents.
3. **Sequential numbering + labels:** Every invoice gets a global sequential number (INV-0001) plus a descriptive label ("Deposit", "Balance", "Additional Services"). Label is admin-editable.
4. **Auto-generated + manual:** System creates invoices at lifecycle events. Admin can also manually create an invoice against any proposal (description + amount).
5. **Shareable links:** Each invoice has a UUID token. `/invoice/:token` is public — no auth required. Anyone with the link can view and pay.

## Data Model

### New Tables

#### `invoices`

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `proposal_id` | INT FK → proposals | Required (nullable later for standalone) |
| `token` | UUID | Shareable link token, unique, default `gen_random_uuid()` |
| `invoice_number` | VARCHAR(20) | "INV-0001" — from `invoice_number_seq` |
| `label` | VARCHAR(100) | "Deposit", "Balance", "Additional Services" — admin-editable |
| `amount_due` | INTEGER | Cents. Set at creation, updated while unlocked |
| `amount_paid` | INTEGER | Cents. Updated when payment recorded |
| `status` | VARCHAR(20) | `draft`, `sent`, `paid`, `partially_paid`, `void` |
| `locked` | BOOLEAN | Default false. True after first payment |
| `locked_at` | TIMESTAMP | When the snapshot froze |
| `due_date` | TIMESTAMP | Payment due date |
| `notes` | TEXT | Admin-only internal notes |
| `created_at` | TIMESTAMP | Default `NOW()` |
| `updated_at` | TIMESTAMP | Default `NOW()` |

Indexes:
- `UNIQUE (token)`
- `(proposal_id)`
- `(invoice_number)`

#### `invoice_line_items`

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `invoice_id` | INT FK → invoices | ON DELETE CASCADE |
| `description` | VARCHAR(255) | "Premium Package (4 hrs)", "Extra Bartender", etc. |
| `quantity` | INTEGER | |
| `unit_price` | INTEGER | Cents |
| `line_total` | INTEGER | Cents |
| `source_type` | VARCHAR(20) | `package`, `addon`, `fee`, `manual` |
| `source_id` | INT | FK to `proposal_addons.id` or null for manual/fees |

Index: `(invoice_id)`

#### `invoice_payments`

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `invoice_id` | INT FK → invoices | |
| `payment_id` | INT FK → proposal_payments | |
| `amount` | INTEGER | Cents — portion of payment applied to this invoice |
| `created_at` | TIMESTAMP | Default `NOW()` |

Indexes: `(invoice_id)`, `(payment_id)`

#### Sequence

```sql
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START 1;
```

Invoice number formatted in application code: `'INV-' + pad(nextval, 4)`

### No Changes to Existing Tables

`proposals`, `proposal_payments`, `proposal_addons`, `service_packages`, `service_addons` — all unchanged. The invoice layer sits on top.

## Invoice Lifecycle

### Auto-Generation Triggers

1. **Proposal sent to client** (status changed to `sent`):
   - `payment_type = 'deposit'` → Invoice labeled "Deposit", amount = `deposit_amount`
   - `payment_type = 'full'` → Invoice labeled "Full Payment", amount = `total_price`
   - Invoice status set to `sent`

2. **Deposit invoice paid** (payment recorded against deposit invoice):
   - Deposit invoice locks (snapshot line items, `locked = true`)
   - New invoice created: labeled "Balance", amount = `total_price - amount_paid`
   - New invoice status set to `sent`

3. **Proposal modified after locked invoices exist** (price increased):
   - New invoice created: labeled "Additional Services", amount = new total - sum of all existing invoice amounts
   - Only created if the net difference is positive
   - Admin can rename the label

### Manual Creation

Admin clicks "Create Invoice" on the proposal detail page. Inputs:
- Label (required)
- Amount (required, in dollars — stored as cents)
- Due date (optional)
- Description line items (optional — description + amount per line)

### Unlocked Invoice Behavior

While `locked = false`, line items are regenerated from the current proposal state whenever the proposal is modified. `amount_due` recalculates accordingly. The invoice is a live view of the proposal.

### Status Transitions

```
draft → sent → paid
              → partially_paid → paid
        → void
draft → void
```

- `draft`: Created but not yet visible to client. Admin can preview.
- `sent`: Visible to client in dropdown and via shareable link.
- `paid`: All payments received. Invoice locked.
- `partially_paid`: Partial payment applied. Invoice is locked (line items frozen) but still accepts additional payments toward the balance.
- `void`: Admin cancelled. Hidden from client. Preserved in DB for audit.

### Invoice Number Assignment

- Number assigned at creation (even drafts) via `invoice_number_seq`
- Never reused, never backfilled
- Voided invoices keep their number

## Shareable Invoice Page

### Route

`/invoice/:token` — public frontend route, no auth required.

### Unpaid Layout

- **Header:** Dr. Bartender logo + "INVOICE" title
- **Invoice metadata:** Invoice number, date issued, due date, status badge
- **Bill To:** Client name, email, phone
- **Event:** Event name, date, location, guest count
- **Line items table:** Description, qty, unit price, line total
- **Totals:** Subtotal, amount paid (if partial), **balance due** (prominent)
- **Pay Now button:** Opens Stripe Elements payment flow, scoped to this invoice's remaining balance
- **Save as PDF button:** Client-side PDF via html2pdf.js
- **Footer:** Business contact info

### Paid Layout

Same structure, plus:
- Large green "PAID" badge/stamp at top
- Status badge shows "Paid" with payment date
- Payment details: date, method (Stripe/cash/Venmo/etc.), reference
- Pay Now button replaced — only "Save as PDF" remains

### PDF

- Client-side via `html2pdf.js`
- Filename: `INV-0042-Deposit.pdf` (number + sanitized label)
- Available in both paid and unpaid states

### Payment Flow

- Reuses existing Stripe PaymentIntent pattern
- New endpoint creates intent scoped to invoice's remaining balance
- Stripe metadata includes `invoice_id` for webhook routing
- Webhook handler locks invoice, records in `invoice_payments`, snapshots line items

## API Endpoints

### New Route File: `server/routes/invoices.js`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/invoices/t/:token` | Public | Fetch invoice by token — line items, payments, client/event info |
| `GET` | `/api/invoices/proposal/:proposalId` | Admin | List all invoices for a proposal (dropdown data) |
| `GET` | `/api/invoices/recent` | Admin | Recent invoices for financials dashboard |
| `POST` | `/api/invoices/proposal/:proposalId` | Admin | Manually create invoice against a proposal |
| `PATCH` | `/api/invoices/:id` | Admin | Update label, due date, void an invoice |

### New Stripe Endpoint

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/stripe/create-intent-for-invoice/:token` | Public | Create PaymentIntent for invoice balance |

### Client Portal Endpoint

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/client-portal/invoices/:proposalToken` | Client | List invoices for proposal (sent + paid only) |

### Modified Existing Endpoints

- **`POST /api/stripe/webhook`** — link payments to invoices via `invoice_payments`, lock invoice, snapshot line items
- **`POST /api/proposals/:id/record-payment`** — also record against relevant invoice
- **`PATCH /api/proposals/:id`** — regenerate line items on unlocked invoices when proposal changes
- **Proposal status → `sent`** — trigger auto-creation of first invoice

## UI Integration Points

### 1. Proposal Detail (Admin) — `/admin/proposals/:id`

- Invoice dropdown/accordion below existing pricing breakdown
- Each entry: `INV-0042 · Deposit — $100.00` with green (paid) or red (unpaid) text
- Clicking opens `/invoice/:token` in new tab
- "Create Invoice" button at bottom for manual creation
- Small modal for manual creation: label, amount, due date, optional line items

### 2. Events Dashboard (Admin) — `/admin/events/:id`

- Same dropdown — `ProposalDetail` is shared between proposal and event views, so this comes for free

### 3. Financials Dashboard (Admin) — `/admin/financials`

- Recent Payments table: each row clickable, navigates to associated invoice
- Legacy payments (pre-invoice) remain non-clickable
- Payment rows link via `invoice_payments` → `invoices.token`

### 4. Client Portal — `/client-dashboard`

- Invoice dropdown on each proposal within the portal
- Same green/red styling, same click behavior
- Only shows `sent` and `paid` invoices (no drafts, no voids)

### 5. Public Proposal View — NOT modified

- Proposal page stays as-is. Payment flow there is already complete. No invoice dropdown needed.

## Edge Cases

**Price decrease on unlocked invoice:** Line items regenerate, `amount_due` decreases. No new invoice.

**Voided invoice:** Status set to `void`. Hidden from client. DB record preserved for audit. Invoice number not reused.

**Legacy payments (pre-invoice):** Existing `proposal_payments` without `invoice_payments` entries. Financials dashboard shows as non-clickable rows. No backfill migration.

**Manual partial payment:** Invoice moves to `partially_paid` and locks (line items frozen). Remains in `partially_paid` until remaining balance is paid, then moves to `paid`.

**Multiple unpaid invoices on one proposal:** Each has its own pay button and Stripe intent. Independent — no conflict.

**Stripe partial payment:** Not possible through normal flow — PaymentIntent is created for exact invoice balance. Only occurs via manual recording.

## Technical Notes

- All money stored as INTEGER cents in new tables (consistent with `proposal_payments`)
- Invoice tokens are UUIDs via `gen_random_uuid()`
- html2pdf.js added as client dependency for PDF generation
- No server-side PDF dependencies (no puppeteer)
- Invoice routes mounted in `server/index.js` at `/api/invoices`
- New frontend route `/invoice/:token` added to `App.js` (public, no auth guard)
- Invoice dropdown is a reusable React component used in ProposalDetail and ClientDashboard

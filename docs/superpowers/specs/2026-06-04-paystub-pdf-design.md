# Paystub PDF — Design

**Status:** design approved 2026-06-04. Scope: **download only** (no email-a-copy). Generation is **lazy on first download** and never touches the `mark-paid` money path.

## 1. Goal

The staff Pay page (`client/src/pages/staff/PayoutDetail.js`) renders a disabled "Paystub download" button tooltipped "coming soon," and `payouts.paystub_storage_key` exists in the schema but is never written. Build the pipeline so a staffer can download a PDF paystub for any **paid** pay period. Email-a-copy stays out of scope: a staffer can email their own downloaded file.

## 2. Architecture: lazy generation on download

The paystub PDF is generated the first time it is requested, not when the payout is settled.

Download flow (`GET /api/me/payouts/:periodId/paystub`):
1. Resolve the payout for `(req.user.id, periodId)`. If none, 404 (IDOR-safe, identical to the existing detail endpoint).
2. If the payout is not `paid`, 409 (no paystub exists for an unpaid period).
3. If `paystub_storage_key` is already set, presign a GET and return the URL.
4. Otherwise: assemble the paystub data, render the PDF, upload to R2, persist the key (race-guarded), presign, return the URL.

Why lazy rather than generating at `mark-paid`:
- **It never touches the money-critical `mark-paid` transaction.** PDF rendering and an R2 upload have no business inside that `BEGIN/COMMIT`. This protects a battle-tested money path.
- **Backfill is free.** Every already-paid payout has a null key today; each generates on its first download. No migration script, no batch job.
- A `paid` payout is settled, so its `payout_events` are frozen. Lazy generation produces the same immutable document a pre-generation would, only on demand. The cost is roughly one to two seconds on the very first download per period; cached forever after.

The payday notification already links to the Pay page (not to a file), so nothing needs a pre-made PDF.

## 3. PDF content and layout

LETTER, mirroring `server/utils/agreementPdf.js` (pdfkit, Helvetica, the `normalizeForPdf` ASCII fold for glyphs Helvetica lacks).

```
  Dr. Bartender                                          PAYSTUB
  ---------------------------------------------------------------
  Jordan Blake                          Pay period: May 16-31, 2026
                                        Payday:      June 1, 2026
                                        Paid:        Jun 1 via Venmo (@jblake)

  Shifts this period
  ---------------------------------------------------------------
  Date    Client / Event          Hrs   Wages   Gratuity  Card tips   Total
  May 17  Smith Family / Wedding   6.0  $240.00   $50.00    $32.40   $322.40
  May 24  Acme Co / Corporate      5.0  $200.00   $15.00     $0.00   $225.00*
          * +$10.00 adjustment: mileage
  ---------------------------------------------------------------
                                  This period      Year to date
  Wages                            $440.00          $3,120.00
  Gratuity                          $65.00            $480.00
  Card tips                         $32.40            $210.60
  Adjustments                       $10.00             $10.00
  ---------------------------------------------------------------
  NET PAID                         $547.40          $3,820.60
  ---------------------------------------------------------------
  Independent contractor payment, no taxes withheld (1099).
```

- **Header:** "Dr. Bartender" + "PAYSTUB". The contractor's name. Period range, payday, and the paid date + method/handle.
- **Per-event rows:** date, `client / event-type` label, hours, wages, gratuity share, card tips (**net**, after the processing fee), line total. An adjustment shows as a footnote under its row with the `adjustment_note`.
- **Card tips shown net.** That is the amount paid. (The `card_tip_gross` / `card_tip_fee` split is omitted for clarity; if transparency on the fee is wanted later it is a one-line addition.)
- **Two-column totals, "This period" and "Year to date,"** per category plus NET PAID.
- **`NET PAID` for the period is the canonical `payouts.total_cents`,** not a re-sum of events, so the document always matches the dollar amount that actually moved. (The category lines come from `payout_events`; if they ever drift from `total_cents`, NET is authoritative. Same principle the detail endpoint already documents.)
- **1099 disclaimer** at the foot.

**Money is integer cents end to end** (`payouts` / `payout_events` use `_cents` columns). A small cents-to-`$1,234.56` formatter renders the PDF (mirrors `client/src/utils/formatMoney.js`).

## 4. YTD definition

Year-to-date is the running total of this contractor's **paid** payouts whose pay period **payday** falls in the same calendar year, with payday on or before this paystub's payday. So a paystub with payday June 1, 2026 has a YTD spanning every paid period from 2026-01-01 through 2026-06-01. This is the standard "as of this check date" running total.

Two aggregate queries over that window:
- **YTD net:** `SUM(payouts.total_cents)` (canonical).
- **YTD by category:** `SUM` of `wage_cents`, `gratuity_share_cents`, `card_tip_net_cents`, `adjustment_cents` across the `payout_events` of those paid payouts.

## 5. Components

### 5.1 `server/utils/paystubPdf.js` (render)
`renderPaystubPdf(data) => Promise<Buffer>`. Pure: takes an assembled data object (contractor name, period, paid date + method/handle, events array, this-period summary, ytd summary), returns a PDF buffer. No DB, no R2. Mirrors `agreementPdf.js` (stream chunks to `Buffer.concat`). Holds the cents formatter + the layout. Unit-testable in isolation.

### 5.2 Paystub data assembly
A new util `server/utils/paystubData.js` exporting `assemblePaystubData(contractorId, periodId) => Promise<object>` (kept separate so `payouts.js` stays focused and the optional admin endpoint can reuse it). Given `(contractorId, periodId)`, it returns the render-ready object:
- The payout + period rows (status, `total_cents`, `paid_at`, `payment_method`, `payment_handle`, payday, start/end).
- The contractor's display name: legal name preferred for a pay document, `COALESCE(agreements.full_name, applications.full_name, preferred_name, email)`.
- The `payout_events` rows + this-period summary (the same query the detail endpoint at `server/routes/staffPortal/payouts.js` already runs; reuse it).
- The YTD aggregates from section 4.

### 5.3 `GET /api/me/payouts/:periodId/paystub` (download endpoint)
Lives beside the existing `/payouts/:periodId` in `server/routes/staffPortal/payouts.js`. Auth + scoped to `req.user.id`. Implements the flow in section 2. On a null key:
- `renderPaystubPdf(await assemblePaystubData(req.user.id, periodId))`,
- `uploadFile` to R2 at `paystubs/<contractor_id>/<period_id>.pdf` (deterministic key, so a double generation overwrites the same object harmlessly),
- persist race-guarded: `UPDATE payouts SET paystub_storage_key = $key WHERE id = $id AND paystub_storage_key IS NULL RETURNING paystub_storage_key`; if another request won the race, re-read and use the stored key,
- presign and return `{ url }`.

Returns **`{ url }` JSON** (not a 302), because the frontend calls it through the axios `api` util; the client opens the URL. The signed URL is served as-is via the existing `storage.getSignedUrl` (the object's `Content-Type` is `application/pdf`, so the browser opens it inline and the staffer saves it). A forced-download filename via `ResponseContentDisposition` is intentionally left out of v1 so we do not touch the shared storage util; it is a trivial future addition.

### 5.4 Frontend (`PayoutDetail.js`)
Enable the "Paystub download" button when `payout.status === 'paid'` (drop the `disabled` + "coming soon" title). On click: `GET` the endpoint via `api`, then `window.open(res.data.url)` (new tab / download). The Download button only renders for `paid` periods (the existing `isPaid &&` wrapper stays); unpaid periods keep their "Period preview" framing. Loading + error states on the button: a spinner while generating, and an **inline error under the button** on failure (`PayoutDetail` uses inline error cards, not toasts). API calls go through `client/src/utils/api.js`.

## 6. Data model

No schema change. Uses existing `payouts` (incl. `paystub_storage_key TEXT`, `total_cents`, `payment_method`, `payment_handle`, `paid_at`, `status`, `contractor_id`, `pay_period_id`), `payout_events` (`wage_cents`, `gratuity_share_cents`, `card_tip_net_cents`, `adjustment_cents`, `adjustment_note`, `line_total_cents`, hours/rate, `shift_id`), `pay_periods` (`start_date`, `end_date`, `payday`, `status`).

## 7. Error handling and edge cases

- **Unpaid period:** button disabled client-side; endpoint returns 409 as defense.
- **Generation or R2 failure:** the endpoint returns a clean 500 and reports to Sentry. The payout row is untouched (no money impact, key stays null), so the next click retries cleanly.
- **Concurrent first-download:** the deterministic R2 key plus the `WHERE paystub_storage_key IS NULL` guard make a double-generation harmless (same object, one key wins; the loser reuses it).
- **IDOR:** the `(req.user.id, periodId)` scope is the only access check, identical to the detail endpoint (no "exists but not yours" leak).
- **Empty events (paid period with zero events):** render a paystub with an empty table and the canonical `total_cents` (defensive; should not occur for a real paid period).
- **Signed URL expiry:** short-lived by design; each click mints a fresh URL.

## 8. Security

- Paystub PDFs are private financial documents: stored under a per-contractor R2 prefix, served only via short-lived presigned URLs, never a public object.
- The endpoint is the only access path and is user-scoped; a staffer can only ever reach their own payouts.
- The R2 key embeds `contractor_id`, but the key is never returned to the client (only presigned URLs are), so it is not an enumeration surface.

## 9. Testing

- **Unit (`paystubPdf.test.js`):** `renderPaystubPdf(fixture)` returns a Buffer beginning with `%PDF`; YTD math; cents formatting (including `$0.00`, negatives for an adjustment, thousands separators).
- **Endpoint (run in isolation per the shared-dev-DB rule):** paid period generates, persists the key, returns a URL; second call reuses the key (no regenerate); unpaid period 409; another user's period 404. The test **mocks the storage layer** (`uploadFile` + `getSignedUrl`) so it never touches real R2, and asserts `uploadFile` fires once on the first request and zero times on the cached second request.
- Client build gate: `CI=true npm --prefix client run build`.

## 10. Out of scope / follow-ups

- **Email-a-copy.** Declined this pass (staffers email their own downloaded file). The button stays removed/disabled.
- **Admin download.** Admin already surfaces `paystub_storage_key` in the payroll view. A parallel admin endpoint (`GET /api/admin/payroll/payouts/:id/paystub`, same lazy generation, not user-scoped) reusing `renderPaystubPdf` + `assemblePaystubData` is a small follow-on if admin needs to pull or re-verify a staffer's paystub. Flagged, not built.
- **Pre-generation at mark-paid.** Rejected for v1 (protects the money path). Revisit only if first-click latency ever matters.
- **Card-tip gross/fee transparency** on the line item. One-line addition if requested.

## 11. Documentation updates (per CLAUDE.md)

| What changed | CLAUDE.md | README.md | ARCHITECTURE.md |
|---|---|---|---|
| New util files (`paystubPdf.js`, `paystubData.js`) | n/a | Folder tree | Mention in the payroll / staff-portal section |
| New route (`/api/me/payouts/:periodId/paystub`) | n/a | n/a | API route table |
| New feature (paystub PDF) | n/a | Key Features | Relevant section |

No new env vars, no new npm packages (pdfkit + the R2 storage helper already exist).

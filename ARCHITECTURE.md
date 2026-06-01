# Architecture

System design reference for the Dr. Bartender platform.

## High-Level Architecture

```
┌─────────────────────┐        HTTPS         ┌─────────────────────┐
│   React Frontend    │ ───────────────────── │   Express Backend   │
│   (Vercel)          │   /api/* requests     │   (Render)          │
│                     │ ◄──────────────────── │                     │
│   Port 3000 (dev)   │     JSON responses    │   Port 5000         │
└─────────────────────┘                       └────────┬────────────┘
                                                       │
                                              ┌────────▼────────────┐
                                              │   PostgreSQL        │
                                              │   (Render)          │
                                              └─────────────────────┘
```

**Dev mode**: React dev server proxies `/api` to `localhost:5000` via the `proxy` field in `client/package.json`.

**Production**: Frontend is a static SPA on Vercel. It calls the backend at `REACT_APP_API_URL` (set at build time). CORS on the backend allows `CLIENT_URL`.

## Authentication Flow

```
1. User registers or logs in
   POST /api/auth/register  or  POST /api/auth/login
   → Server hashes password (bcryptjs), creates/verifies user
   → Returns JWT (7-day expiry, payload: { userId })

2. Client stores token in localStorage

3. Every API request includes:
   Authorization: Bearer <token>
   (set automatically by axios interceptor in client/src/utils/api.js)

4. Server middleware (server/middleware/auth.js):
   → Verifies JWT signature with JWT_SECRET
   → Fetches user from DB (id, email, role, onboarding_status, can_hire, can_staff)
   → Attaches to req.user
   → Blocks deactivated/rejected staff with 403

5. Role-based access:
   - staff: onboarding pages, portal, application
   - admin: full admin dashboard access
   - manager: admin dashboard access (same as admin in routing)

6. On 401 response: client clears token, redirects to /login
```

**Public routes** (no auth): Drink plans and proposals use UUID tokens in the URL (`/plan/:token`, `/proposal/:token`) instead of authentication.

## Error Handling

The app uses a layered error display system across all surfaces.

| Surface | Component | When to use |
|---|---|---|
| Field-level inline | `<FieldError>` | Server attributes failure to a specific field (`fieldErrors: { email: '...' }`) |
| Form-level banner | `<FormBanner>` | Operation failure not tied to one field; placed immediately above the submit button, auto-scrolls into view |
| Toast | `useToast()` | System events not tied to a form: success confirmations, session expiry, network drops |
| Modal fallback | `<ErrorBoundary>` | Unhandled React error — page can't render |

### Server error envelope

All error responses (4xx and 5xx) use this shape:

```json
{
  "error": "Human-readable message",
  "code": "OPTIONAL_MACHINE_CODE",
  "fieldErrors": { "fieldName": "field-specific message" }
}
```

`error` is required and backward compatible with the original `{ error: "..." }` shape. `code` is optional, machine-readable, used for Sentry tagging and frontend special handling. `fieldErrors` is optional, drives field-level inline display.

### AppError class hierarchy (`server/utils/errors.js`)

| Class | Status | Code | Use |
|---|---|---|---|
| `ValidationError(fieldErrors, message?)` | 400 | `VALIDATION_ERROR` | Field-attributable input failure |
| `ConflictError(message, code?)` | 409 | `CONFLICT` (or custom) | State conflict (duplicate, locked, already-paid) |
| `NotFoundError(message?)` | 404 | `NOT_FOUND` | Resource doesn't exist |
| `PermissionError(message?)` | 403 | `PERMISSION_DENIED` | Authenticated but not allowed |
| `ExternalServiceError(service, originalError, message?)` | 502 | `EXTERNAL_SERVICE_ERROR` | Stripe/R2/Twilio/Resend/Nominatim failure |
| `PaymentError(message, code?)` | 402 | `PAYMENT_FAILED` (or custom) | Stripe card decline, insufficient funds, post-payment mutation conflicts |

Routes throw via `asyncHandler`-wrapped handlers; the global error middleware in `server/index.js` formats the response envelope and reports unknown errors to Sentry.

### Observability

- **Server:** `@sentry/node` initialized at the top of `server/index.js`. Gated on `SENTRY_DSN_SERVER` env var (silent in dev). PII-scrubbed by default (`event.request.data` redacted).
- **Client:** `@sentry/react` initialized in `client/src/index.js`. Gated on `REACT_APP_SENTRY_DSN_CLIENT`. `<ErrorBoundary>` captures unhandled React errors and forwards to Sentry.
- **Webhook handlers** (Stripe, Resend, Thumbtack) wrap their `catch` blocks with explicit `Sentry.captureException` so processing errors land in Sentry while preserving the response codes those services expect.

### Special-case error routing

- **401 (session expired)** — toast (`'Your session expired — please log in again.'`) → 1.5s delay → context-aware redirect (staff `/login`, client `/client-login` on admin subdomain or `/login` on public site).
- **Network failure** (no response) — toast (`'Network error — check your connection.'`).
- **Stripe Elements card errors** — handled natively by the Stripe Element. Surrounding API failures (load invoice, create payment intent) use `<FormBanner>`.
- **Enumeration-sensitive endpoints** (forgot-password, client-login passwordless request) — always return success on the public response; `<FormBanner>` surfaces only hard errors (rate limit, server error).

## API Routes

### Authentication — `/api/auth`
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/register` | No | Create account, auto-create onboarding_progress row |
| POST | `/register-pre-hired` | No | Create account with `pre_hired=true` — the application form still runs but on submit the user lands at `'hired'` instead of `'applied'`. Backs the open `hiring.drbartender.com/onboarding` URL. |
| POST | `/claim-pre-hire` | Yes | Flag an already-logged-in user as `pre_hired=true`. Staff-only. If status is `'applied'`, also promotes to `'hired'` + seeds contractor_profiles + writes audit entries. Called by the `/onboarding` page when a returning recruit visits the URL. |
| POST | `/login` | No | Validate credentials, return JWT (7-day expiry) |
| GET | `/me` | Yes | Current user + `has_application` flag |

### Onboarding Progress — `/api/progress`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | Yes | Get user's onboarding progress |
| PUT | `/step` | Yes | Mark a step as completed |

### Contractor Agreement — `/api/agreement`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | Yes | Get current agreement data (legacy compatibility) |
| GET | `/legal-text` | Yes | Fetch current version payload (clauses, acknowledgments, effective date) rendered by the client |
| POST | `/` | Yes | Save signature, six v2 acknowledgments, SMS opt-in — then render PDF, upload to R2, email to signer |
| GET | `/download` | Yes | Short-lived signed R2 URL for the signer's most recent agreement PDF |

#### Contractor Agreement Flow

The contractor agreement is versioned. The current version is defined in `server/data/contractorAgreement.js`
(`CURRENT_VERSION = 'contractor-agreement-v2'`). The React page at `/agreement` fetches the current version
payload from `GET /api/agreement/legal-text` and renders it dynamically (At-a-Glance bullets, 11 clauses, 6
per-clause acknowledgments).

On sign (`POST /api/agreement`), the server:

1. Writes all six `ack_*` booleans, signature data, IP, user agent, and `signature_document_version` to the
   `agreements` table inside a transaction with the onboarding progress update.
2. Post-commit: renders a PDF via `server/utils/agreementPdf.js` (pdfkit), uploads to R2 under
   `agreements/{user_id}/{version}-{timestamp}.pdf`, stores the key on the row.
3. Sends the PDF to the signer as a Resend email attachment. Email failures are logged to Sentry; the
   signature record is already committed.

`GET /api/agreement/download` returns a short-lived signed R2 URL for the current user's latest PDF.

V1 signers (pre-v2 schema) remain valid. The legacy `acknowledged_field_guide` and `agreed_non_solicitation`
columns are preserved for historical records; new v2 signers populate the `ack_*` columns instead.

### Contractor Profile — `/api/contractor`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | Yes | Get contractor profile |
| POST | `/` | Yes | Save profile + file uploads (alcohol cert, resume, headshot) |

### Payment Info — `/api/payment`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | Yes | Get payment profile |
| POST | `/` | Yes | Save payment method, W-9 upload, marks onboarding complete |

### Application — `/api/application`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | Yes | Get user's application |
| POST | `/` | Yes | Submit application (file uploads, 21+ age validation) |

### Admin — `/api/admin`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/users` | Admin | Paginated user list, filterable by status |
| GET | `/users/:id` | Admin | Full user detail (profile, agreement, payment, application, notes) |
| PUT | `/users/:id/status` | Admin | Change onboarding status (hire, approve, reject, deactivate) |
| PUT | `/users/:id/profile` | Admin | Edit contractor profile + payment info |
| PUT | `/users/:id/permissions` | Admin | Update user role and permission flags |
| GET | `/applications` | Admin | Paginated application list — derived `onboarding_progress`, `onboarding_blocker`, `flags` per row |
| GET | `/applications/:userId` | Admin | Application detail + scorecard + unified activity timeline |
| POST | `/applications/:userId/notes` | Admin | Add interview note (also writes to activity timeline) |
| PUT | `/applications/:userId/interview` | Admin | Schedule/reschedule interview (optional confirmation email) |
| DELETE | `/applications/:userId/interview` | Admin | Clear scheduled interview time |
| PUT | `/applications/:userId/scorecard` | Admin | Upsert interview scorecard (5 dimensions, 1-5 each) |
| POST | `/applications/:userId/move` | Admin | Stage transition (applied → interviewing → in_progress) |
| POST | `/applications/:userId/reject` | Admin | Reject with reason (rate-limit: cannot re-reject already-rejected) |
| POST | `/applications/:userId/restore` | Admin | Restore rejected applicant to Applied |
| POST | `/applications/:userId/reminder` | Admin | Send paperwork-reminder email (24h cooldown per applicant) |
| GET | `/hiring/summary` | Admin | KPI strip: new apps 7d / need-to-schedule / stalled / in-pipeline |
| GET | `/hiring/search` | Admin | Cross-state applicant search (Applied/Interview/Onboarding/Active/Rejected/Unfinished) |
| GET | `/search` | Admin/Manager | Global record search across clients, proposals, events, staff (matches partial name / email / phone) |
| DELETE | `/notes/:noteId` | Admin | Delete interview note |
| GET | `/active-staff` | Staffing | Paginated list of onboarded staff |
| GET | `/managers` | Admin | List all managers |
| POST | `/managers` | Admin | Elevate staff to manager |
| PUT | `/managers/:id` | Admin | Update manager permissions |
| DELETE | `/managers/:id` | Admin | Demote manager to staff |
| POST | `/test-email` | Admin | Send test email via Resend |

### Drink Plans — `/api/drink-plans`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | Admin | List all plans with filters |
| POST | `/` | Admin | Create new plan (generates UUID token) |
| GET | `/by-proposal/:proposalId` | Admin | Fetch plan linked to a proposal |
| GET | `/:id/shopping-list-data` | Admin | Shaped data for shopping list generation (joins proposal for guest_count, resolves cocktail ingredients) |
| GET | `/:id/shopping-list` | Admin | Fetch persisted shopping list + `shopping_list_status` |
| PUT | `/:id/shopping-list` | Admin | Save shopping list edits (auto-saved by the modal while admin edits) |
| PATCH | `/:id/shopping-list/approve` | Admin | Approve list (flips `shopping_list_status` to `'approved'`) and emails client a link |
| GET | `/:id` | Admin | Fetch single plan by ID (includes `has_consult_selections`, `shopping_list_source`, audit fields) |
| GET | `/:id/consult` | Admin | Fetch admin-side consult-form payload for re-populating the form |
| PUT | `/:id/consult` | Admin | Save consult-form payload, regenerate shopping list as `pending_review` (via `drinkPlanConsult.js`) |
| PATCH | `/:id/shopping-list-source` | Admin | Flip active source between `planner` and `consult`, regenerate from chosen source (via `drinkPlanConsult.js`) |
| PATCH | `/:id/notes` | Admin | Update admin notes |
| PATCH | `/:id/status` | Admin | Update plan status |
| DELETE | `/:id` | Admin | Delete a plan |
| GET | `/t/:token` | Public | Fetch questionnaire by token (JOINs proposal for guest_count, num_bartenders, pricing_snapshot). Returns a locked payload `{ locked: true, proposalToken }` when the linked proposal is pre-deposit, so a stale emailed `/plan/:token` link renders a lock screen instead of the wizard (`isDrinkPlanPreBooking` allowlist, fails safe) |
| PUT | `/t/:token` | Public | Save draft or submit selections (on submit: processes addOns into proposal_addons, recalculates pricing, sends admin email, auto-generates pending_review shopping list) |
| GET | `/t/:token/shopping-list` | Public | Client read-only view, returns the list only once admin has approved it |
| POST | `/t/:token/logo` | Public | Standard Menu logo upload (PNG/JPG, 5 MB cap, magic-bytes validation). Uploads to R2 and atomically merges `companyLogo` + `_logoFilename` into `selections` via the Postgres jsonb `\|\|` operator |
| GET | `/t/:token/logo` | Public | Proxies the uploaded logo from R2 with `Content-Type` + `Cache-Control: public, max-age=86400`. Same-origin so `html2canvas` can capture it without CORS taint |
| POST | `/:id/logo` | Admin | Admin upload/replace for a specific plan's logo. Same validation + atomic JSONB merge as the token-gated route |
| DELETE | `/:id/logo` | Admin | Clears `selections.companyLogo` + `_logoFilename` via Postgres jsonb `-` operator. R2 file is not deleted |
| POST | `/:id/finalize` | Admin | Finalize the BEO: stamps `finalized_at`/`finalized_by` (only when status=`reviewed`, selections non-empty, proposal not archived), schedules T-3 staff nudges for every approved staffer on every non-cancelled shift, writes `beo_finalized` activity log. Locks every mutation route on the plan until Unfinalize. Implemented in `server/utils/beoFinalize.js`, mounted into the drink-plans router. |
| POST | `/:id/unfinalize` | Admin | Clear `finalized_at`/`finalized_by`, suppress pending nudges (preserves sent), clear every `beo_acknowledged_at` on the proposal's shift_requests, write `beo_unfinalized` activity log. |

### BEO — `/api/beo`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/:proposalId` | Auth (admin/manager always; staff only if approved on a non-cancelled shift) | Banquet Event Order payload — proposal/client/package, drink plan (without `token`), addons, shift_requests with `beo_acknowledged_at`, viewer flags, and `team_roster[]` (active approved bartenders with display_name/initials/role/needs_cover; phone gated to viewers who are themselves approved+active on the proposal per spec §6.18). 404 fires before 403 so staff cannot enumerate proposal ids. Rate-limited per `req.user.id` via `beoReadLimiter` (60/15min). |
| GET | `/:proposalId/logo` | Same as above | Staff-authenticated logo proxy. Reads `drink_plans.selections->>'_logoFilename'` (validated to start with `drink-plan-logos/`), fetches the signed URL from R2 with an 8 s timeout, streams the bytes back with `Cache-Control: private, max-age=3600`. |
| POST | `/:proposalId/acknowledge` | Auth | Staff: stamps `shift_requests.beo_acknowledged_at = NOW()` on every approved active shift_request the staffer holds on this proposal (gated on `drink_plans.finalized_at IS NOT NULL`; returns 409 if not finalized). Admin/manager: returns `{acknowledged:false}` (no-op). |

### Cocktails — `/api/cocktails`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | No | List all cocktails with categories |
| POST | `/` | Admin | Create/update cocktail |

### Mocktails — `/api/mocktails`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | No | List all mocktails with categories |
| POST | `/` | Admin | Create/update mocktail |

### Proposals — `/api/proposals`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | Admin | List proposals with filters (status, search). Default excludes paid + archived (those appear in Events / archive) |
| GET | `/financials` | Admin | Aggregated revenue + payments for FinancialsDashboard. Accepts `?from=&to=&basis=` (booked\|scheduled\|paid) for date-range + lens filtering. |
| GET | `/dashboard-stats` | Admin | Server-side aggregations (booked / collected / outstanding / funnel / pipeline / monthly revenue series) for the admin home. Accepts `?from=&to=&basis=` for date-range + lens filtering; prior-period deltas included. |
| POST | `/` | Admin | Create proposal (auto-calculates pricing, creates client if needed). Rules are re-validated server-side via `validateProposalRules`. `send_now: true` creates the proposal as `sent`, creates its invoice in-transaction, and emails the client; otherwise it lands as a `draft`. `send_now` is fail-safe: anything but an explicit `true` is a draft. Rate-limited per admin via `adminWriteLimiter` (10/min). |
| POST | `/calculate` | Admin | Preview pricing without saving |
| GET | `/packages` | Admin | List service packages |
| GET | `/addons` | Admin | List add-ons |
| GET | `/:id` | Admin | Get single proposal with addons + activity log |
| PATCH | `/:id` | Admin | Update event details, recalculate pricing, and re-sync the linked event shift (date/time/location/client) when the proposal has been converted. A draft→sent transition creates the proposal's invoice in the same DB transaction. |
| PATCH | `/:id/status` | Admin | Update proposal status. On a →sent transition, creates the invoice in-transaction (idempotent on `proposal_id`) and emails the client via `sendProposalSentEmail`. Rate-limited per admin via `adminWriteLimiter` (10/min). |
| PATCH | `/:id/notes` | Admin | Update admin notes |
| DELETE | `/:id` | Admin | Delete a proposal |
| GET | `/t/:token` | Public | Fetch proposal by token (tracks views + geolocation) |
| POST | `/t/:token/sign` | Public | Client signature + acceptance |
| PATCH | `/:id/balance-due-date` | Admin | Override balance due date for a proposal |
| POST | `/:id/send-reminder` | Admin | Email the client a balance-due reminder (logged to proposal_activity_log) |
| POST | `/:id/record-payment` | Admin | Record an outside payment (cash, Venmo, etc.) — triggers shift creation |
| POST | `/:id/create-shift` | Admin | Manually create event shift from a paid proposal |

### Stripe — `/api/stripe`
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/create-intent/:token` | Public | Create Stripe PaymentIntent (deposit or full amount, with optional autopay) |
| POST | `/payment-link/:id` | Admin | Generate reusable Stripe Payment Link |
| POST | `/charge-balance/:id` | Admin | Manually trigger off-session autopay balance charge |
| POST | `/refund/:id` | Admin (`auth, adminOnly`) | Issue a partial refund — auto-targets the largest refundable charge; no cross-charge spanning |
| GET | `/refunds/:id` | Admin/Manager (`auth, requireAdminOrManager`) | Refund history for a proposal |
| POST | `/webhook` | Stripe | Handle `payment_intent.succeeded`, `checkout.session.completed` — updates payment status, auto-creates event shift |

### Clients — `/api/clients`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | Admin | List clients |
| POST | `/` | Admin | Create client |
| GET | `/:id` | Admin | Client detail with proposal history |
| PUT | `/:id` | Admin | Update client |

### Venues — `/api/venues`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/search` | Public | Venue-name autocomplete — proxies Google Places (New), rate-limited |
| GET | `/details/:placeId` | Public | Place-details lookup — resolves a suggestion to a structured venue address |

### Shifts — `/api/shifts`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | Yes | List shifts (staff see open upcoming; admin see all) |
| GET | `/unstaffed-upcoming` | Staffing | Pre-filtered upcoming + still-needs-staffing list (powers AssignToEventModal — replaces the full /shifts dump) |
| GET | `/my-requests` | Yes | Current user's shift request history |
| POST | `/` | Staffing | Create shift |
| PUT | `/:id` | Staffing | Update shift |
| DELETE | `/:id` | Staffing | Delete shift |
| POST | `/:id/request` | Yes | Request assignment to a shift |
| DELETE | `/requests/:requestId` | Yes | Cancel own request (admin can cancel any) |
| GET | `/:id/requests` | Staffing | Get all requests for a shift |
| PUT | `/requests/:requestId` | Staffing | Approve or deny a request (sends SMS on approve) |
| POST | `/:id/auto-assign` | Staffing | Run auto-assign algorithm (dry_run for preview, or execute to approve top candidates) |
| POST | `/:id/cancel-or-unassign` | Staffing | Cancel a shift or unassign one staffer; optionally notifies affected staff via SMS |
| GET | `/by-proposal/:proposalId` | Staffing | All shifts for a proposal (array — supports multi-shift events on EventDetailPage) |

### Admin — `/api/admin` (continued)
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/users/:id/seniority` | Admin | Get seniority score, events worked, tenure |
| PUT | `/users/:id/seniority` | Admin | Update seniority_adjustment and hire_date |
| GET | `/settings` | Admin | Get app_settings (auto-assign weights, max distance) |
| PUT | `/settings` | Admin | Update app_settings key-value pairs |
| POST | `/backfill-geocodes` | Admin | Geocode all staff/shift addresses and backfill hire dates |

### Messages — `/api/messages`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/recipients` | Admin | List eligible staff with SMS consent |
| POST | `/send` | Admin | Send SMS to one or more staff (supports batch sends with group_id) |
| GET | `/history` | Admin | Paginated grouped message history |
| GET | `/history/:groupId` | Admin | Per-recipient detail for a batch send |
| GET | `/user/:userId` | Admin | Message history for a specific staff member |
| GET | `/shifts` | Admin | Shifts available for invitation picker |

### Two-Way SMS — `/api/sms`
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/inbound` | Twilio signature | Twilio inbound-SMS webhook (signature-verified, no JWT) — handles STOP/START opt-out and staff CONFIRM/CANT response codes |
| GET | `/conversations` | Admin/Manager | List SMS conversations, one row per client with an unread inbound count |
| GET | `/conversations/:clientId` | Admin/Manager | Full SMS thread for a client |
| POST | `/conversations/:clientId/reply` | Admin/Manager | Send an outbound SMS reply to a client |
| PUT | `/conversations/:clientId/read` | Admin/Manager | Mark a client's unread inbound SMS as read |

### Blog — `/api/blog`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | No | List published posts (includes chapter_number) |
| GET | `/images/:filename` | No | Serve blog images via R2 signed URL |
| GET | `/:slug` | No | Get single post by slug (includes chapter_number) |

Blog post bodies are stored as sanitized HTML (via DOMPurify). The admin editor uses TipTap (WYSIWYG) and the public view renders HTML directly.

### Calendar — `/api/calendar`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/feed/:token` | Token | iCal feed of shifts (rate-limited per token) |
| GET | `/event/:shiftId.ics` | Yes | Download single shift as .ics file |
| GET | `/token` | Yes | Get user's calendar subscription token |
| POST | `/token/regenerate` | Yes | Regenerate calendar subscription token |

### Email Marketing — `/api/email-marketing`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/leads` | Admin | List leads with search, filter by source/status, pagination |
| POST | `/leads` | Admin | Create single lead |
| POST | `/leads/import` | Admin | CSV bulk import |
| GET | `/leads/:id` | Admin | Lead detail with send history and conversations |
| PUT | `/leads/:id` | Admin | Update lead |
| DELETE | `/leads/:id` | Admin | Soft-delete (set status to unsubscribed) |
| GET | `/campaigns` | Admin | List campaigns with type filter |
| POST | `/campaigns` | Admin | Create campaign (blast or sequence) |
| GET | `/campaigns/:id` | Admin | Campaign detail with stats, sends, steps, enrollments |
| PUT | `/campaigns/:id` | Admin | Update campaign |
| DELETE | `/campaigns/:id` | Admin | Archive campaign |
| POST | `/campaigns/:id/send` | Admin | Execute blast send |
| POST | `/campaigns/:id/schedule` | Admin | Schedule blast for future |
| GET | `/campaigns/:id/steps` | Admin | List sequence steps |
| POST | `/campaigns/:id/steps` | Admin | Add sequence step |
| PUT | `/campaigns/:id/steps/:stepId` | Admin | Update sequence step |
| DELETE | `/campaigns/:id/steps/:stepId` | Admin | Delete step and reorder |
| POST | `/campaigns/:id/activate` | Admin | Activate drip sequence |
| POST | `/campaigns/:id/pause` | Admin | Pause drip sequence |
| POST | `/campaigns/:id/enroll` | Admin | Enroll leads in sequence |
| GET | `/campaigns/:id/enrollments` | Admin | List enrollments with progress |
| GET | `/analytics/overview` | Admin | Aggregate stats (leads, campaigns, sends, rates) |
| GET | `/conversations` | Admin | List conversations grouped by lead |
| GET | `/conversations/:leadId` | Admin | Conversation thread for a lead |
| POST | `/conversations/:leadId/reply` | Admin | Admin sends reply email |
| PUT | `/conversations/:conversationId/read` | Admin | Mark conversation as read |
| POST | `/conversations/:leadId/mark-replied` | Admin | Manual mark reply received |
| GET | `/unsubscribe` | Public | JWT-verified unsubscribe |
| POST | `/webhook/resend` | Resend | Webhook receiver (tracking events, svix-verified) |

### Client Auth — `/api/client-auth`
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/request` | No | Request OTP code (rate-limited) |
| POST | `/verify` | No | Verify OTP and get client JWT |
| GET | `/me` | Client | Get current client profile |

### Client Portal — `/api/client-portal`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/proposals` | Client | List client's proposals |
| GET | `/proposals/:token` | Client | Get single proposal by token |

### Thumbtack Integration — `/api/thumbtack`
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/leads` | Webhook secret | Receive new lead from Thumbtack, create/match client, notify admin |
| POST | `/messages` | Webhook secret | Receive customer message from Thumbtack thread |
| POST | `/reviews` | Webhook secret | Receive new Thumbtack review |

### Cal.com Integration — `/api/calcom`
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/webhook` | Public (HMAC-signed) | Cal.com booking event receiver (see Third-Party Integrations) |

### Invoices — `/api/invoices`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/t/:token` | No (token-gated) | Fetch invoice by shareable token — line items, payments, client/event info |
| GET | `/proposal/:proposalId` | Admin | List all invoices for a proposal |
| GET | `/recent` | Admin | Latest 20 invoices for financials dashboard |
| POST | `/proposal/:proposalId` | Admin | Manually create invoice against a proposal |
| PATCH | `/:id` | Admin | Update label, due date, or void an invoice |
| GET | `/client/:proposalToken` | Client | List invoices for a proposal (sent + paid only) |

### Public Reviews — `/api/public/reviews`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | No | Returns curated 4–5 star Thumbtack reviews + count + average rating for the public HomePage. 5-minute in-memory cache, 120 req/min rate limit. Query: `?limit=1..20` (default 9). |

### Test Feedback — `/api/test-feedback`
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/` | No (rate-limited, 10/hour per IP via `labratFeedbackLimiter`) | Receives Lab Rat bug/confusion/mission-stale reports (`kind`, `missionId`, `stepIndex`, `testerName`, `where`, `didWhat`, `happened`, `expected`, `browser`). Inserts into the `tester_bugs` Postgres table via `bugLog.appendBug` AND fire-and-forget emails `ADMIN_FEEDBACK_NOTIFICATION_EMAIL` (default `contact@drbartender.com`) as a redundant notification path. Also accepts the legacy `{ reportText, progressSummary }` shape from `/testing-guide.html` via a back-compat shim. Admin triage UI at `/labrat-bugs`; CLI listing via `npm run bugs:list`. |

### Public Tip Pages — `/api/public/tip`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/:token` | No (token-gated) | Fetch active tip page by token — bartender display name, photo, tip rails (Venmo/CashApp deep links + Stripe Payment Link). Returns 404 for missing or deactivated pages. |
| POST | `/:token/feedback` | No (token-gated, rate-limited) | Submit post-tip feedback from the thank-you page (rating + free-text). Inserts into `tip_page_feedback` and emails `ADMIN_FEEDBACK_NOTIFICATION_EMAIL`. |

### Post-Event Feedback — `/api/public/feedback`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/:token` | No (token-gated) | Display data for the post-event feedback router page (client first name, event type). |
| POST | `/:token` | No (token-gated) | Submit a rating (1-5). A 4-5 rating returns a Google Reviews redirect URL; a 1-3 rating records the feedback in `post_event_feedback` and emails an admin alert. Idempotent per proposal. |

### Authenticated Self — `/api/me`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/tip-page` | Yes | Get the current bartender's tip-page record (token, display name, photo URL, payment rails, activation state). |
| PATCH | `/tip-page` | Yes | Update bartender-editable fields on the tip page (display name override, Venmo/CashApp handles, opt-in flags). |
| GET | `/tips` | Yes | Paginated list of recent successful tips for the current bartender (amount, source, created_at). |
| GET | `/notification-preferences` | Yes | Current user's notification category subscriptions. |
| PATCH | `/notification-preferences` | Admin/Manager | Toggle notification categories for the current admin/manager. |
| GET | `/payouts` | Yes | Staffer's payout history — list of `{ id, status, total_cents, paid_at, paystub_storage_key, event_count, period }`, newest pay period first. Hard-scoped to `req.user.id` (no `:userId` param). `payment_method` / `payment_handle` deliberately NOT projected (PII). Powers the staff portal Pay tab (spec §6.6). |
| GET | `/payouts/:periodId` | Yes | One pay period's detail for the logged-in staffer: `{ period, payout, events[], summary }`. IDOR-guarded by `WHERE po.contractor_id = $1 AND po.pay_period_id = $2` — 404 if no payout row for (this user, this period). `summary` sums wages / gratuity / card-tip gross+fee / adjustments across events; `total_cents` comes from the payout row (canonical, never a JS sum). |

### Admin Tip Pages — `/api/admin/contractors/:userId/tip-page`
| Method | Path | Auth | Description |
|---|---|---|---|
| PATCH | `/` | Admin | Override tip-page fields for a bartender (display name, photo, payment handles, status). |
| POST | `/regenerate-stripe` | Admin | Force-regenerate the bartender's Stripe Payment Link (e.g., after a connect-account change). Token unchanged — printed QRs keep working. Writes `tip_stripe_regenerate` to `admin_audit_log`. |
| POST | `/rotate-token` | Admin | Emergency rotation: issue a NEW `tip_page_token` AND a fresh Stripe Payment Link. Use only when the existing public URL is compromised (printed QR leaked, screenshot circulated). Old printed QRs stop working. Writes `tip_token_rotate` to `admin_audit_log` with old/new token prefixes. |
| POST | `/generate-stripe` | Admin | Provision a Stripe Payment Link for a bartender that doesn't yet have one. |
| POST | `/deactivate` | Admin | Deactivate the tip page (sets `is_active = false`, hides the public route). |
| POST | `/activate` | Admin | Re-activate a previously deactivated tip page. |

### Admin Tip Activity — `/api/admin`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/tips` | Admin | Paginated list of all successful tips across bartenders for the TipsAdmin overview (filter by bartender, date range). |
| GET | `/tip-feedback` | Admin | List unreviewed tip-page feedback submissions for admin triage. |
| POST | `/tip-feedback/:id/review` | Admin | Mark a feedback row as reviewed (records reviewer + timestamp). |
| GET | `/tester-bugs` | Admin/Manager | List Lab Rat bug reports (filter `?status=open\|fixed\|wontfix\|all` and `?missionId=...`). Returns `{ bugs, openCountByMission }`. |
| PATCH | `/tester-bugs/:id` | Admin/Manager | Update a bug's triage state — body `{ status?, fixCommitSha?, notes? }`. Bumps `status_updated_at`. |
| GET | `/users/:id/stub-co-participated-proposals` | Admin/Manager | Proposals where the given user co-participated on a shift with a legacy CC stub. Powers the user-detail "Co-participated with a CC stub" affordance. |
| POST | `/proposals/:id/reenroll-drink-plan-nudge` | Admin/Manager | Re-schedule the drink-plan nudge (email + SMS) for a CC-imported proposal that now has a `drink_plans` row. Idempotent — duplicate-pending insert no-ops. Mounted from `routes/admin/ccImport/proposalActions.js`. |
| POST | `/proposals/:id/reaccrue-payout` | Admin/Manager | Re-run `accruePayoutsForProposal` for a CC proposal after stub cleanup. Returns the structured `{ skipped, reason }` result. Mounted from `routes/admin/ccImport/proposalActions.js`. |

### CC Import Admin — `/api/admin/cc-import`
All endpoints require `auth + requireAdminOrManager` unless otherwise noted. The `include_stubs=true` knob on `/search/users` 403s for managers because the legacy stub email could expose contractor-identity-derived data. Mutations write to `admin_audit_log` via `logAdminAction`. Spec reference: `docs/superpowers/specs/2026-05-25-checkcherry-import-design.md` §9.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/wrap-up` | Admin/Manager | Bucket B wrap-up worklist (cc-imported, status='completed', past event_date). Filterable `?filter=needs-wrapup\|all`, `?range=since-import\|last-30`, paginated. |
| POST | `/wrap-up/preview` | Admin/Manager | Pre-flight delivery breakdown for selected ids (uses `resolveChannelFallback`, no DB writes — confirmation modal). |
| POST | `/wrap-up/enqueue` | Admin/Manager | Schedules `post_event_wrap_up_email` messages for selected proposals (best-effort per id with a per-row outcome enum). |
| GET | `/review` | Admin/Manager | All 7 sections in one shot: duplicates / orphan payments / unmatched payees / errored rows / skipped events / Phase 0 eligible + done, plus `lastRun` telemetry. |
| POST | `/review/duplicate/:row_id/confirm` | Admin/Manager | Flip a duplicate_review row to duplicate_confirmed (operator says yes, this IS a dup). |
| POST | `/review/duplicate/:row_id/promote` | Admin/Manager | Re-run Bucket A promote on the suspect row with `skipDedup` (operator says no, this is NOT a dup). |
| POST | `/review/orphan-payment/:legacy_id/link` | Admin/Manager | Set `cc_event_id` + promote the legacy payment into `proposal_payments` (or `proposal_refunds`) inside a transaction. |
| POST | `/review/orphan-payment/:legacy_id/dismiss` | Admin/Manager | Mark the orphan payment dismissed (sets `dismissed_at` + operator notes). |
| POST | `/review/unmatched-payee/:legacy_payout_id/link` | Admin/Manager | Reassign the stub's `shift_requests` to a real user, mark stubs accordingly, link the payout, audit-log. |
| POST | `/review/unmatched-payee/:legacy_payout_id/create-stub` | Admin/Manager | Create a fresh `legacy_cc:` stub user and link the payout to it. |
| POST | `/review/errored-row/:row_id/retry` | Admin/Manager | Re-run the per-row insert for an errored `legacy_cc_raw_imports` row. |
| POST | `/review/skipped-event/:row_id/promote` | Admin/Manager | Re-run Phase 3 promotion for a previously skipped event row. |
| POST | `/review/phase0-failure/:row_id/accept-loss` | Admin/Manager | Mark a Phase 0 attachment fetch failure as accepted-loss (sets `given_up_at` + reason; gated on `attempt_count >= 10`). |
| POST | `/review/phase0-failure/:row_id/revert-give-up` | Admin/Manager | Reverse an accept-loss (clears `given_up_at` + resets `attempt_count`). |
| GET | `/search/proposals?q=&limit=&offset=` | Admin/Manager | Typeahead picker for the orphan-payment "link to proposal" UI (matches client name ILIKE OR proposal `cc_id`). |
| GET | `/search/users?q=&include_stubs=&limit=&offset=` | Admin/Manager (`include_stubs=true` admin-only) | Typeahead picker for the unmatched-payee "link to user" UI. Stubs (cc_id LIKE 'legacy_cc:%') excluded by default. |
| GET | `/review/unmatched-payee/:legacy_payout_id/link-preview?user_id=` | Admin/Manager | Pre-flight counts for the link-confirmation modal (shift_requests to be reassigned per the precheck SELECT). |

### Proposal-level legacy CC payments — `/api/proposals`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/:id/legacy-cc-payments` | `auth, adminOnly` | Lists CC-imported `proposal_payments` rows (where `legacy_charge_id IS NOT NULL`) for the admin-only `LegacyCcPaymentsPanel` on ProposalDetail. Warns the operator that the DRB OS Refund button is wired to PaymentIntents and cannot reach these legacy Stripe charges — refunds happen in the Stripe dashboard with a manual `proposal_refunds` row whose `reason` starts with "Manual Stripe reconciliation". |

### Other
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | No | Health check (`{ status: 'ok' }`) |

### Public Website Pages (Client-Side Only)
| Path | Component | Description |
|---|---|---|
| `/` | `HomePage` | Public homepage with services, stats, CTA |
| `/services` | `ServicesPage` | Detailed Formula I/II/III service cards + add-ons strip |
| `/method` | `MethodPage` | Three-step method detail with bullets + typical timeline |
| `/about` | `AboutPage` | Proprietor specimen card + long-form bio + 25-year career timeline |
| `/quote` | `QuotePage` → `QuoteWizard` | Multi-step instant quote builder |
| `/faq` | `FaqPage` | Frequently asked questions |
| `/classes` | `ClassWizard` | Cocktail class booking wizard |
| GET | `/api/files/:filename` | Admin | Redirect to R2 signed URL for file download |

## Database Schema

### Core User Tables

**users** — All accounts (staff, admin, manager)
- `id` SERIAL PK
- `email` UNIQUE, `password_hash`
- `role`: staff | admin | manager
- `onboarding_status`: in_progress | applied | interviewing | hired | rejected | submitted | reviewed | approved | deactivated
- `can_hire`, `can_staff` (boolean permission flags)
- `notifications_opt_in`
- `notification_preferences` JSONB — per-category admin alert toggles (`urgent_booking`, `urgent_consult`, `urgent_staffing`, `urgent_client_reply`, `payment_failure`, `feedback`, `system_error`, `routine_admin`, `routine_thumbtack`, `routine_hiring`, `routine_finance`), all default true. Drives the Automated Communication system's per-admin routing.
- `communication_preferences` JSONB — `{sms_enabled, email_enabled, marketing_enabled}` (defaults true). Channel-level on/off shared by admin alerts and staff notifications.

**Onboarding status lifecycle** — what each value means and what it unlocks

| Status | Meaning | Route guard | Portal / shift access |
|---|---|---|---|
| `in_progress` | Registered, hasn't applied yet | `ProtectedRoute` | — |
| `applied` | Submitted application | `ProtectedRoute` | — |
| `interviewing` | Admin moved them into the interview stage | `ProtectedRoute` | — |
| `hired` | Admin accepted — entered onboarding flow (welcome → payday protocols). Admin-hire also seeds `contractor_profiles` from the application. | `RequireHired` | — |
| `submitted` | Finished the onboarding forms (set by POST `/payment`) | `RequireHired` + `RequirePortal` | Full portal + can request shifts |
| `reviewed` | Admin has reviewed the submission | `RequireHired` + `RequirePortal` | Full portal + can request shifts |
| `approved` | Admin has formally approved the contractor | `RequireHired` + `RequirePortal` | Full portal + can request shifts |
| `rejected` | Application denied | login blocked for staff | — |
| `deactivated` | Offboarded | login blocked | — |

Portal access (`RequirePortal` in `client/src/App.js`, `requireOnboarded` in `server/routes/shifts.js`) treats `submitted`/`reviewed`/`approved` as equivalent — the distinction is an admin-facing label, not a gate.

**onboarding_progress** — Tracks completion of each onboarding step
- `user_id` FK → users
- Boolean columns: `account_created`, `welcome_viewed`, `field_guide_completed`, `agreement_completed`, `contractor_profile_completed`, `payday_protocols_completed`, `onboarding_completed`
- `last_completed_step`

**contractor_profiles** — Personal details for hired contractors
- `user_id` FK → users
- Name, phone, email, DOB, address (city, state, street, zip)
- Travel distance, transportation, equipment checkboxes
- `lat`, `lng` — Geocoded coordinates (auto-populated via Nominatim on save)
- `hire_date` — Set when status changes to 'hired'
- `seniority_adjustment` — Admin manual score override (+/-)
- `equipment_will_pickup` — Willing to pick up equipment from storage
- File URLs: `alcohol_certification_file_url`, `resume_file_url`, `headshot_file_url`
- Emergency contact fields

**agreements** — Signed legal documents
- `user_id` FK → users
- `signature_data` (base64 canvas image), `signed_at`
- `signature_document_version` — version of the agreement text the user signed (e.g. `contractor-agreement-v2`)
- `sms_consent`
- Legacy v1 columns (preserved for historical records): `acknowledged_field_guide`, `agreed_non_solicitation`
- V2 acknowledgment booleans: `ack_ic_status`, `ack_commitment`, `ack_non_solicit`, `ack_damage_recoupment`, `ack_legal_protections`, `ack_field_guide`
- PDF record: `pdf_storage_key` (R2 object key), `pdf_generated_at`, `pdf_email_sent_at`

**payment_profiles** — Payment method preferences
- `user_id` FK → users
- `preferred_payment_method`, `payment_username`
- `routing_number`, `account_number` (direct deposit, AES-256-GCM encrypted)
- `w9_file_url`
- Tip-page columns (added for the bartender QR tip flow):
  - `tip_page_token` UUID — public token for `/tip/:token`. Partial-unique index `WHERE tip_page_token IS NOT NULL`.
  - `venmo_handle`, `cashapp_handle`, `paypal_url` — payment-app handles for deep links. Validated + normalized by `server/utils/tipHandleValidation.js` before persist (paypal_url canonicalized to `https://paypal.me/<username>`).
  - `stripe_payment_link_url`, `stripe_payment_link_id` — Stripe Payment Link, provisioned + activated/deactivated by `server/utils/tipPaymentLinks.js`
  - `tip_page_active` BOOLEAN — toggled by `server/utils/tipPageLifecycle.js` on hire / offboard / admin override
- Public bartender display name + photo come from `contractor_profiles.preferred_name` and `contractor_profiles.headshot_file_url` — the tip page does NOT carry its own copies.

### Application & Hiring

**applications** — Contractor application form data
- `user_id` FK → users
- Full personal info, experience, tools, equipment, availability
- File URLs: resume, headshot, BASSET cert
- `birth_month/day/year` for 21+ validation
- `referral_source` — optional "Who referred you?" answer
- `interview_at` — scheduled interview time (TIMESTAMPTZ, nullable)
- `rejection_reason` — set when admin rejects; surfaced on rejected banner

**interview_notes** — Admin notes on applicants (legacy; new notes also write to `application_activity`)
- `user_id` FK → users, `admin_id` FK → users
- `note`, `note_type` (default: 'note')

**interview_scores** — Five-dimension hiring scorecard (one row per applicant, upserted)
- `user_id` UNIQUE FK → users (CASCADE on delete)
- `personality`, `customer_service`, `problem_solving`, `speed_mindset`, `hire_instinct` — INTEGER 1-5 each
- `scored_by` FK → users (refreshes on each upsert to track latest scorer)

**application_activity** — Append-only timeline of pipeline events
- `user_id` FK → users (CASCADE), `actor_id` FK → users (SET NULL — preserve history when admins leave)
- `event_type` — one of: application_submitted, status_changed, interview_scheduled, interview_rescheduled, reminder_sent, note_added, onboarding_step_completed
- `metadata` JSONB — event-specific payload (from/to status, interview_at, rejection reason, note text)
- Index on `(user_id, created_at DESC)` for fast timeline rendering

### Event Planning

**drink_plans** — Client event questionnaire (created only after the client books — Stripe deposit webhook → `createEventShifts` → `createDrinkPlan`, idempotent; never pre-deposit)
- `token` UUID (public access)
- `client_name`, `client_email`, `event_type`, `event_type_custom`, `event_date`
- `proposal_id` — links to the source proposal/event
- `serving_type`, `selections` (JSONB — chosen cocktails/mocktails, syrupSelections, addOns)
- `selections.addOns` — object keyed by addon slug with metadata (e.g., champagne-toast servingStyle)
- `status`: pending | draft | submitted | reviewed
- `shopping_list` (JSONB) — auto-generated at submission, admin-editable, persisted across modal opens
- `shopping_list_status` VARCHAR(20) CHECK (NULL | `'pending_review'` | `'approved'`) — gates the public `/t/:token/shopping-list` endpoint
- `shopping_list_approved_at` TIMESTAMPTZ — set when admin approves and sends the list
- `consult_selections` (JSONB) — admin-side consult-form input (parallel to client-side `selections`)
- `shopping_list_source` VARCHAR(20) CHECK (NULL | `'planner'` | `'consult'`) — flags which input source currently feeds the generator
- `consult_filled_by_user_id` INTEGER FK → users (admin who saved the consult; SET NULL on user delete)
- `consult_filled_at` TIMESTAMPTZ
- `finalized_at` TIMESTAMPTZ — BEO finalize stamp. NULL until admin presses "Finalize BEO" on the DrinkPlanCard; non-NULL locks every mutation route on the plan (status, notes, shopping list, logo, consult, source flip, delete) and gates the staff-side acknowledge + the T-3 nudge. Cleared by Unfinalize.
- `finalized_by` INTEGER FK → users (admin who finalized; SET NULL on user delete)
- Partial index `idx_drink_plans_shopping_list_pending` covers the admin badge-count "pending review" filter
- Partial index `idx_drink_plans_finalized_at(finalized_at) WHERE finalized_at IS NOT NULL` covers the BEO scheduler + nudge lookups
- On submit: addOns flow into proposal_addons, pricing is recalculated, admin notified, `shopping_list` auto-generated server-side as `pending_review`
- Auto-emails the drink plan link to client on creation

### Proposals & Pricing

**service_packages** (12 rows) — Service tiers
- `slug`, `name`, `description`, `category` (byob | hosted)
- `pricing_type` (flat | per_guest)
- Rate columns: `base_rate_3hr`, `base_rate_4hr`, `extra_hour_rate` (standard + small-event variants)
- Staffing: `bartenders_included`, `guests_per_bartender`, `extra_bartender_hourly`
- Bar fees: `first_bar_fee`, `additional_bar_fee`
- `includes` (JSONB array of what's included)
- `service_packages.covered_addon_slugs TEXT[]` — which add-on slugs the hosted
  package's base price already includes. Used by the Potion Planning Lab to
  suppress redundant add-on offers and compute cocktail ingredient gaps.

**service_addons** — Add-on services
- `slug`, `name`, `description`
- `billing_type`: per_guest | per_hour | flat | per_guest_timed
- `rate`, `extra_hour_rate`
- `applies_to`: byob | hosted | all | class
- `linked_package_id` FK → service_packages (nullable, ON DELETE SET NULL) — ties supply add-ons to a specific class package; NULL addons are universal (e.g., class equipment kits)

**proposals** — Generated service proposals
- `token` UUID (public access), `client_id` FK → clients
- Event details: type, date, start time, duration, location, guest count
- Structured venue address: `venue_name` (optional), `venue_street`, `venue_city`, `venue_state`, `venue_zip` (ZIP optional). Venue name is captured optionally in the quote wizard; street is **required and persisted server-side at the `/sign` route** (the client also disables Pay until it's filled; `PaymentForm` calls `/sign` before `stripe.confirmPayment`, so a card cannot be charged without a persisted venue). `event_location` is a **derived display string** composed from these via `server/utils/venueAddress.js` (city/state-only output stays byte-identical to the legacy `"City, State"` format); `shifts.location` is composed the same way in `createEventShifts` and `syncShiftsFromProposal`.
- `package_id` FK → service_packages, `num_bars`, `num_bartenders`
- `setup_minutes_before` (nullable INTEGER) — crew arrival/setup lead time before service start. **Back-of-house only — never exposed on public token/proposal/invoice surfaces** (the `/t/:token` allowlist deliberately omits it). NULL ⇒ derive the default at read time: **90 for hosted (per-guest) packages, 60 otherwise** (`server/utils/setupTime.js`, mirrored client-side). Admin-adjustable via `PATCH /:id` (undefined/null sentinel like `total_price_override` — explicit `null` resets to the package default; never COALESCEd). Synced into `shifts.setup_minutes_before` by `createEventShifts` / `syncShiftsFromProposal`. A manual override **persists across package changes**; set it to NULL to fall back to the new package's default (90 hosted / 60 else). `GET /:id` also returns a server-derived `setup_time_display` (service start − effective minutes, 12-hour). Validation: integer 0–600 inclusive.
- `pricing_snapshot` (JSONB — full pricing breakdown at time of creation)
- `class_options` (JSONB — nullable) — set for class-category bookings; shape: `{ spirit_category: 'whiskey_bourbon' | 'tequila_mezcal' | null, top_shelf_requested: bool }`. Written only by `POST /api/proposals/public/submit` via a whitelist; other writers must preserve the same shape.
- `client_provides_glassware` (BOOLEAN, default `false`) — client is supplying their own glassware. What makes a Flavor Blaster add-on line item valid; surfaced on the admin proposal-detail Event card.
- `total_price`, `status`: draft | sent | viewed | modified | accepted | deposit_paid | balance_paid | confirmed | completed | archived
- `archive_reason` (TEXT, nullable) — only set when `status = 'archived'`. CHECK-constrained to `no_hire | client_cancelled | we_cancelled | event_completed | other`. The legacy `cancelled` status was migrated to `archived` with `archive_reason = 'client_cancelled'` in Task 2 of the automated-communication rollout; the enum no longer accepts `cancelled`.
- `event_timezone` (TEXT, NOT NULL, default `'America/Chicago'`) — IANA zone used for scheduling reminder communications and any future local-time renders.
- Client signature: `client_signed_name`, `client_signature_data`, `client_signed_at`
- Payment: `payment_type` (deposit | full), `autopay_enrolled`, `deposit_amount`, `amount_paid`, `balance_due_date`
- Stripe: `stripe_customer_id`, `stripe_payment_method_id` (for autopay off-session charges)
- Autopay claim: `autopay_status` (NULL | 'in_progress' | 'failed') and `autopay_attempted_at` — atomic row-claim used by both the scheduler and the admin manual charge so concurrent runs can't double-charge. Cleared to NULL when `payment_intent.succeeded` flips status to `balance_paid`. Stuck `'in_progress'` claims expire after 24h.
- Tracking: `view_count`, `last_viewed_at`

Event identity: proposals/shifts/drink_plans carry `event_type` (id) + optional `event_type_custom` (for "Other"). No free-text title. Display via `getEventTypeLabel({ event_type, event_type_custom })` helper, mirrored in `client/src/utils/eventTypes.js` and `server/utils/eventTypes.js`. Falls back to the literal string `'event'` when type is unset.

**proposal_addons** — Line items linking proposals to add-ons
- `proposal_id` FK, `addon_id` FK
- `addon_name`, `billing_type`, `rate`, `quantity`, `line_total`
- `variant` (nullable) — optional addon-specific variant tag (e.g., `'non-alcoholic-bubbles'` swaps the Champagne Toast label without changing price)

**proposal_activity_log** — Audit trail
- `proposal_id` FK, `action` (created, sent, viewed, signed, deposit_paid, etc.)
- `actor_type` (system | admin | client), `actor_id`, `details` (JSONB)

**stripe_sessions** — Payment intent tracking
- `proposal_id` FK
- `stripe_payment_intent_id`, `stripe_payment_link_id`
- `amount` (cents), `status`

**proposal_payments** — Individual payment records
- `proposal_id` FK, `stripe_payment_intent_id`
- `payment_type`: deposit | balance | full | invoice
- `amount` (cents), `status`

**proposal_refunds** — Audit ledger for partial refunds
- `id` PK; `proposal_id` FK→proposals (ON DELETE RESTRICT, NOT NULL); `payment_id` FK→proposal_payments (ON DELETE RESTRICT, nullable); `stripe_payment_intent_id`; `stripe_refund_id`
- `amount` (INTEGER cents); `reason` (TEXT); `total_price_before` / `total_price_after` (NUMERIC dollars)
- `issued_by` FK→users (nullable — NULL = dashboard refund); `status`: pending | succeeded | failed; `created_at`
- Approach A reconciliation: a refund drops `proposals.amount_paid` by the full refund amount and adjusts `total_price` only for contract-scope invoices (classified by linked invoice `label`: Deposit / Balance / Full Payment); extra-scope invoices leave `total_price` intact
- Partial unique index on `stripe_refund_id` (WHERE NOT NULL) — idempotency anchor shared by the synchronous route and the `charge.refunded` webhook backstop

### Invoices

**invoices** — Invoice records (sit on top of proposals)
- `proposal_id` FK, `token` (UUID for shareable links)
- `invoice_number` (INV-0001), `label` (Deposit, Balance, etc.)
- `amount_due` (cents), `amount_paid` (cents)
- `status`: draft | sent | paid | partially_paid | void
- `locked` (boolean), `locked_at` — freezes line items on payment
- `due_date`, `notes`
- A proposal's first invoice is created when the proposal enters the `sent` state. `createInvoiceOnSend` (in `server/utils/invoiceHelpers.js`, idempotent on `proposal_id`) runs inside the same DB transaction as the status change on every →sent path: admin `POST /proposals` with `send_now`, admin `PATCH /:id` and `PATCH /:id/status`, and the public `POST /api/proposals/public/submit` quote-wizard submission. Client notification (`sendProposalSentEmail`) fires post-commit and is best-effort.

**invoice_line_items** — Line items per invoice
- `invoice_id` FK, `description`, `quantity`, `unit_price` (cents), `line_total` (cents)
- `source_type`: package | addon | fee | manual
- `source_id` — FK to proposal_addons.id or null

**invoice_payments** — Junction linking invoices to proposal_payments
- `invoice_id` FK, `payment_id` FK → proposal_payments
- `amount` (cents)

### Clients

**clients** — Client records
- `name`, `email`, `phone`
- `source`: direct | thumbtack | referral | website | calcom
- `notes`
- `communication_preferences` JSONB — `{sms_enabled, email_enabled, marketing_enabled}` (defaults true). Drives the Automated Communication system's send gating.
- `email_status` (`ok` | `bad`), `phone_status` (`ok` | `bad`) — channel deliverability flags flipped on bounce/blocked-list signals.
- `email_harvest_status` (`not_needed` | `pending` | `harvested` | `failed`), `email_harvest_attempted_at` — track the email-harvest flow for SMS-only leads. Partial index `idx_clients_email_harvest_pending` powers the scheduler's pending sweep.

### Menu

**cocktail_categories** (5 rows) + **cocktails** (25 rows) — Cocktail menu
- Categories: Crowd Favorites, Light & Refreshing, Classic, Bold, Bartender's Picks
- Each cocktail: name, emoji, base_spirit, description, sort_order, is_active, ingredients (JSONB array of strings — used by the Shopping List Generator)
- `cocktails.upgrade_addon_slugs TEXT[]` — add-on slugs that must be purchased
  when the client's hosted package doesn't already cover them. Auto-added when
  the client selects such a cocktail on the planner.

**mocktail_categories** (4 rows) + **mocktails** (16 rows) — Mocktail menu
- Categories: Fruity & Refreshing, Creamy & Sweet, Sparkling & Light, Bold & Complex

### Staffing

**shifts** — Event shifts
- `event_type`, `event_type_custom`, `client_name`, `event_date`, `start_time`, `end_time`, `location`
- `setup_minutes_before` (INTEGER DEFAULT 60) — informational crew setup lead time. `start_time` is **always** equal to service start; setup is NOT a change to the billable/pay window. Editable directly via `PUT /shifts/:id` (COALESCE — omitting it preserves the row). Auto-synced from the proposal's effective value by `createEventShifts` / `syncShiftsFromProposal`, but **only for single-shift events** (the `count !== 1` guard skips hand-built multi-shift events by design — the admin sets those per shift). Staff surfaces always read the shift's own value, so multi-shift events stay consistent. Back-of-house only — never sent to clients.
- `positions_needed` (JSON text array, e.g. `["Bartender","Bartender"]`), `status`, `created_by`
- `proposal_id` FK (nullable) — links to the proposal that created this shift (auto-created on deposit payment)
- `lat`, `lng` — Geocoded event coordinates
- `equipment_required` (JSON text array, e.g. `["portable_bar","cooler"]`)
- `auto_assign_days_before` — Schedule auto-assign N days before event; `auto_assigned_at` — timestamp of last auto-assign run

**shift_requests** — Staff applying for shifts
- `shift_id` FK, `user_id` FK (unique together)
- `position`, `status` (pending/approved/rejected), `notes`
- `acknowledged_at` TIMESTAMPTZ — set when the assigned staff member texts CONFIRM for the shift (Comms Phase 2 two-way SMS). Lives on the per-(shift, staff) row, not on `shifts`. Index `idx_shift_requests_user_id` on `user_id` supports the inbound-SMS nearest-approved-shift lookup.
- `beo_acknowledged_at` TIMESTAMPTZ — BEO read-receipt stamp set by `POST /api/beo/:proposalId/acknowledge`. Independent from `acknowledged_at` (shift CONFIRM); a staffer who has CONFIRMed the shift still must open the BEO to acknowledge it. Cleared on Unfinalize, on re-assign (`POST /:id/assign`), on approve-after-deny re-request, on `PUT /requests/:requestId` deny/approve, and on auto-assign promotion — so a stale ack from a prior cycle never carries forward.

**app_settings** — Configurable settings (auto-assign weights, max distance, etc.)
- `key` VARCHAR PK, `value` TEXT, `updated_at`

### Messaging

**sms_messages** — SMS message log (inbound + outbound)
- `id` SERIAL PK
- `user_id` FK → users (recipient)
- `shift_id` FK → shifts (nullable, for shift invitations)
- `group_id` UUID — groups messages from the same batch send
- `message_type` TEXT — e.g. general, shift_invitation, plus the Comms Phase 3 client-SMS touch types. Widened to `TEXT` in Phase 3 (was `VARCHAR(20)` with a 4-value CHECK constraint, now dropped) so automated client-SMS touch identifiers fit.
- `direction` TEXT NOT NULL DEFAULT 'outbound' CHECK (`inbound`, `outbound`) — added for two-way SMS via Automated Communication Foundation
- `to_phone`, `body`
- `twilio_sid`, `status` — delivery tracking. CHECK now allows `received` (the status for an inbound message) alongside `sent` / `failed` / `queued`.
- `sent_by` FK → users (admin who sent)
- Two-way SMS additions (Comms Phase 2):
  - `client_id` INTEGER FK → clients (ON DELETE SET NULL) — links an inbound text to its client row so the admin thread UI can group by client
  - `read_at` TIMESTAMPTZ — marks an inbound message as seen; drives the unread badge
  - `metadata` JSONB NOT NULL DEFAULT `'{}'` — raw Twilio From/To/MessageSid plus the STOP/START opt-out audit record
  - Index `idx_sms_messages_client_id` on `client_id`; partial index `idx_sms_messages_unread` on `client_id WHERE direction = 'inbound' AND read_at IS NULL` for the unread count; `idx_sms_messages_twilio_sid` on `twilio_sid` for inbound-webhook idempotency (dedupe a repeated Twilio delivery by MessageSid)

**scheduled_messages** — Unified per-recipient/per-channel scheduled-message tracking for the Automated Communication Foundation. One row per (recipient, channel) for each scheduled touch so multi-recipient touches (e.g. day-before reminder to two bartenders) and partial failures (email sent, SMS failed) are tracked independently.
- `id` SERIAL PK
- `entity_id` INTEGER NOT NULL — id of the underlying record (proposal/shift/client/consult)
- `entity_type` TEXT NOT NULL CHECK (`proposal`, `shift`, `client`, `consult`)
- `message_type` TEXT NOT NULL — stable string identifying the touch (e.g. `day_before_reminder`, `payment_reminder_72h`)
- `recipient_type` TEXT NOT NULL CHECK (`client`, `staff`, `admin`)
- `recipient_id` INTEGER NOT NULL — client or user id (resolved by `recipient_type`)
- `channel` TEXT NOT NULL CHECK (`email`, `sms`)
- `scheduled_for` TIMESTAMPTZ NOT NULL — when the worker should deliver
- `sent_at` TIMESTAMPTZ — set on successful send
- `status` TEXT NOT NULL DEFAULT `'pending'` CHECK (`pending`, `sent`, `failed`, `suppressed`, `deferred`)
- `error_message` TEXT — last error on failure
- `created_at` TIMESTAMPTZ DEFAULT NOW()
- Partial index `idx_scheduled_messages_pending(scheduled_for) WHERE status = 'pending'` keeps worker queue scans cheap as the table grows.
- Lookup indexes on `(entity_type, entity_id)` and `(recipient_type, recipient_id)` for cancellation (e.g. proposal accepted, cancel pending reminders) and per-recipient history.

*Scheduled-message dispatcher:* `server/utils/scheduledMessageDispatcher.js` registers the `message_dispatcher` scheduler, which runs every 5 minutes. Each tick drains due `pending` rows from `scheduled_messages`, applies the shared suppression rules (archive / comm-prefs / bad-contact), and dispatches each row to its registered per-message-type handler (currently the money-path balance reminders). Rows are wired in by `server/utils/messageScheduling.js` (`scheduleMessage`, idempotent insert). Gated by `RUN_MESSAGE_DISPATCHER_SCHEDULER` (suppressed by the global `RUN_SCHEDULERS=false`).

*Marketing and retention message types:* the dispatcher handles marketing-class touches registered by `marketingHandlers.js` (`drip_touch_2`, `drip_touch_4`, `drip_touch_5_email`, `new_year_hello`, `six_months_out`, `retention_nudge`), all gated on `clients.communication_preferences.marketing_enabled`, plus `review_request` (operational, a CAN-SPAM transactional follow-up, not gated). They are scheduled by hooks on the proposal status-transition paths: drip enrollment on every path that makes a proposal `sent`, New Year and 6-months-out plus drip-suppression on every sign+pay path, review request and retention nudge on completion, and marketing cancellation on archive.

*BEO message type:* `beo_unack_nudge_sms` (operational, `priority: 2`, anchor `event_date`) is registered by `server/utils/beoHandlers.js` and scheduled on Finalize (`scheduleBeoNudgesForProposal`) for every approved staffer on every non-cancelled shift, fired at `MAX(eventStartUtc - 3 days, NOW() + 5 minutes)`. The handler `handleBeoUnackNudge` throws `SuppressMessageError` for every expected gate (user_deleted, beo_not_finalized, already_acknowledged, staffer_unassigned, user_inactive, no_phone, no_start_time, event_in_past) — gate order is asserted by tests. The dispatcher's `SuppressMessageError` discriminator marks the row `status='suppressed'` with the reason and skips Sentry. Reschedule (`reanchorBeoForProposal`) and lifecycle hooks (`suppressBeoNudgesForProposal`, `suppressBeoNudgesForStaffers` with a NOT EXISTS guard for multi-shift coverage) cascade from shift cancel / DELETE / PUT cancel / request deny / request DELETE and from the Unfinalize route.

Comms Phase 3 adds the client-facing SMS layer. `sms.js` gains `sendAndLogSms`,
the single send-and-log primitive for all automated SMS. `smsTemplates.js`
holds the SMS body copy (mirrors `emailTemplates.js`). Scheduled SMS touches
register dispatcher handlers like their email siblings: `dripSmsHandlers.js`
(drip touches 1/3/5-sms), `drinkPlanNudge.js` (the drink-plan nudge, email + SMS,
T-21), `balanceSmsHandlers.js` (non-autopay balance due-today / late t1 / late
t3 SMS), and `eventEveSms.js` (the event-eve SMS, T-24h from event start, with
bespoke wall-clock timing). `balanceReminderScheduling.js` holds the
balance-reminder ladder scheduler (extracted from `stripe.js`). Immediate SMS
sends (initial proposal, sign+pay confirmation, payment failure, reschedule) are
best-effort hooks beside the existing email send, gated by
`shouldSendImmediate({ channel: 'sms' })`.

Staff-facing SMS (Phase 4a) is handled by `server/utils/staffShiftHandlers.js`: scheduled `shift_reminder` (day before the event) and `staff_thank_you` (after the event) message types, plus immediate schedule-change and cancellation/unassignment notices gated by an admin toggle on the event editor.

*CC-import wrap-up handler:* `server/utils/ccWrapUpHandler.js` registers a single message type `post_event_wrap_up_email` (anchor `event_date`, category `operational`, priority 3, `offsetFromEventDate: null`, `cooldownExempt: true`, `multiChannel: false`) used by the `/admin/cc-import/wrap-up` enqueue endpoint to fire a one-shot recap email at admin-chosen times for imported events that pre-date the importer cutover. Body lives in `server/utils/ccWrapUpEmailTemplate.js`. Registration is boot-wired in `server/index.js` (around line 343) so the dispatcher's first tick can resolve the type. The `category: 'operational'` registration deliberately bypasses the marketing-enabled gate, and `cooldownExempt: true` keeps the wrap-up email separate from the daily-overlap dedupe so the operator can sequence batches without false collisions.

Phase 4b adds three cross-cutting pieces. Overlap prevention: each handler carries a `priority` (1-5) and `cooldownExempt` flag; `dispatchPending` defers a colliding lower-priority touch 24h by writing `status='deferred'`, then reactivates deferred rows when they next come due. Delivery-failure fallback: a Resend hard bounce flips `clients.email_status='bad'` and a Twilio failure flips `phone_status='bad'`; the dispatcher substitutes the alternate channel for single-channel operational touches, and suspends a client's remaining automation when both channels are dead. Multi-admin notifications: `notifyAdminCategory` (in `server/utils/adminNotifications.js`) fans a notification out to every admin/manager whose `users.notification_preferences` subscribes them to the category, joining `contractor_profiles` for SMS.

**scheduler_health** — Heartbeat table for the Automated Communication Foundation schedulers. Each scheduler writes its `last_run_at` on every tick; a monitoring loop alerts via Sentry when any scheduler hasn't checked in within 2x its expected interval.
- `scheduler_name` TEXT PRIMARY KEY — stable identifier (e.g. `proposal_reminders`, `shift_reminders`, `client_messages_dispatcher`)
- `last_run_at` TIMESTAMPTZ NOT NULL — wall-clock of the most recent tick
- `last_status` TEXT NOT NULL CHECK (`ok`, `failed`)
- `expected_interval_seconds` INTEGER NOT NULL — staleness threshold = 2x this value
- `consecutive_failures` INTEGER NOT NULL DEFAULT 0 — incremented on each failed tick, reset to 0 on success
- `last_error` TEXT — most recent error string when `last_status = 'failed'`
- `updated_at` TIMESTAMPTZ DEFAULT NOW()

**consults** — Scheduled phone consults booked via Cal.com (deferred workstream). The empty table ships ahead of the integration so downstream code (and `scheduled_messages.entity_type = 'consult'`) can reference it without waiting on Cal.com deployment. Drink-plan notes themselves continue to live on `drink_plans.consult_selections`, not here.
- `id` SERIAL PK
- `client_id` FK → clients (ON DELETE SET NULL)
- `proposal_id` FK → proposals (ON DELETE SET NULL)
- `scheduled_at` TIMESTAMPTZ NOT NULL — when the consult is booked for
- `calcom_event_id` TEXT — external Cal.com event identifier (nullable until integration lands; renamed from `calendly_event_id` to match the Cal.com vendor cutover)
- `status` TEXT NOT NULL DEFAULT `'scheduled'` CHECK (`scheduled`, `completed`, `cancelled`, `no_show`)
- `created_at` TIMESTAMPTZ DEFAULT NOW()
- Lookup indexes on `proposal_id` and `client_id`; partial index `idx_consults_scheduled_at(scheduled_at) WHERE status = 'scheduled'` keeps upcoming-consult queries cheap.
- `booker_name` VARCHAR(255) — raw booker name from the Cal.com webhook payload, preserved separately from the matched/auto-created client record
- `booker_email` VARCHAR(255) — raw booker email from the Cal.com webhook payload
- UNIQUE constraint on `calcom_event_id` (added 2026-05-27 for webhook idempotency)

**webhook_events** — Generic dedupe table for inbound webhook replay protection. Used by the Cal.com webhook (`provider='calcom'`) today; available for Stripe / Resend / future webhook providers. Pruned hourly via `webhookEventsPruneScheduler` to a 30-day window.
- `provider` VARCHAR(50) NOT NULL — provider identifier (`'calcom'`, future `'stripe'`, etc.)
- `event_id` TEXT NOT NULL — per-provider unique event identifier (Cal.com uses SHA-256 of the raw signed body)
- `received_at` TIMESTAMPTZ NOT NULL DEFAULT NOW()
- PRIMARY KEY (provider, event_id); index on `received_at` for prune

### Bartender Tip Pages

**tips** — Successful tip records (one row per `checkout.session.completed` event tagged `metadata.kind = 'tip'`)
- `id` SERIAL PK
- `tip_page_token` UUID NOT NULL — denormalized so the row stays meaningful if the bartender's token is later rotated
- `target_user_id` FK → users (bartender who received the tip; ON DELETE RESTRICT — financial records aren't auto-deleted)
- `amount_cents` INTEGER NOT NULL CHECK (> 0) — Stripe `session.amount_total`
- `stripe_payment_intent_id` TEXT UNIQUE NOT NULL — idempotency key against webhook retries
- `stripe_session_id` TEXT — Stripe Checkout Session id (the `cs_…` value)
- `customer_email` — captured by Stripe Checkout, may be null
- `tipped_at` TIMESTAMPTZ — Stripe `session.created`
- `created_at` TIMESTAMPTZ DEFAULT NOW()
- `fee_cents` INTEGER — Stripe processing fee captured at webhook time; used by the payroll fee-netting math
- `shift_id` FK → shifts (nullable; populated when the tip is matched to a specific bartender shift inside the +/-12h window around the event)
- `rolled_forward_at` TIMESTAMPTZ — set when a late tip arrives after its event's pay period was frozen and the tip is rolled into the next open period
- `refunded_amount_cents` INTEGER NOT NULL DEFAULT 0 — cumulative refunded cents, idempotency key for `clawbackTip` (only the delta past the prior value reduces the bartender's adjustment)
- `dispute_won_at` TIMESTAMPTZ — set when Stripe reinstates a previously-paid-out card tip after a chargeback resolves in our favor; idempotency marker for `payrollDisputeNotify` (set either via successful admin notification OR via the retry-bailout path)
- `dispute_email_attempts` INTEGER NOT NULL DEFAULT 0 — retry counter for the dispute-won admin notification (0 to 3); incremented atomically inside `notifyDisputeWon`'s held transaction on each failed send
- `dispute_email_failed_at` TIMESTAMPTZ — set ONLY when the dispute-won notification was abandoned after exhausting retries. Canonical "needs manual reconciliation" marker; the weekly sweep query (below) reads this column as the durable failsafe channel.
- Indexed on `(target_user_id, tipped_at DESC)` for staff-side `GET /api/me/tips` + admin-side `GET /api/admin/tips`

**Dispute-won notification state machine.** For tip rows that have entered the dispute-reinstatement flow, the `(dispute_won_at, dispute_email_failed_at)` pair describes one of four states:
- **In progress, no failures yet:** `dispute_won_at IS NULL AND dispute_email_attempts = 0`. Webhook has not delivered, or the first attempt has not run.
- **In progress, retrying:** `dispute_won_at IS NULL AND dispute_email_attempts > 0 AND dispute_email_attempts < 3`. One or more send failures, still inside the retry window.
- **Completed normally:** `dispute_won_at IS NOT NULL AND dispute_email_failed_at IS NULL`. Email delivered, admin notified.
- **Completed by bailout:** `dispute_won_at IS NOT NULL AND dispute_email_failed_at IS NOT NULL`. Three send failures; admin must reconcile manually. The presence of `dispute_email_failed_at IS NOT NULL` is the canonical marker.

**tip_page_feedback** — Bartender-feedback submissions from the tip thank-you page (only the negative-rating path; 4-5★ flows nudge customers to a Google review instead)
- `id` SERIAL PK
- `target_user_id` FK → users (bartender being reviewed; ON DELETE RESTRICT)
- `rating` INTEGER NOT NULL CHECK (1-3) — only 1, 2, or 3 stars submit through this surface
- `comment` TEXT
- `submitter_email` — optional contact for follow-up
- `reviewed_at` TIMESTAMPTZ, `reviewed_by` FK → users (admin who triaged; ON DELETE SET NULL — preserves history if an admin is removed)
- `created_at` TIMESTAMPTZ DEFAULT NOW()
- Submission emails `ADMIN_FEEDBACK_NOTIFICATION_EMAIL`; admin reviews via `GET /api/admin/tip-feedback`

**tester_bugs** — Lab Rat tester-program bug reports (replaces the prior filesystem JSONL store, which was wiped on every Render deploy)
- `id` TEXT PK — `bug_<iso>_<hex>` server-generated, sortable by timestamp
- `kind` TEXT NOT NULL CHECK (`bug` | `confusion` | `mission-stale`)
- `mission_id` TEXT, `step_index` INTEGER — links a report back to a Lab Rat mission and step
- `tester_name` — optional contact (testers are unauthenticated)
- `where_at`, `did_what`, `happened`, `expected`, `browser` — captured form fields (server-side length caps in `bugLog.appendBug`)
- `reported_at` TIMESTAMPTZ DEFAULT NOW()
- `status` TEXT NOT NULL DEFAULT `'open'` CHECK (`open` | `fixed` | `wontfix`)
- `status_updated_at` TIMESTAMPTZ — bumped by `setBugStatus` on every triage update
- `fix_commit_sha`, `notes` — admin triage metadata
- Partial indexes on `(reported_at DESC) WHERE status='open'` and `(mission_id) WHERE status='open' AND mission_id IS NOT NULL` — both keep the badge-counts and mission-picker queries cheap as the table grows. A non-partial `(status, reported_at DESC)` index also covers the admin list view when filtering by `fixed` / `wontfix` / `all`.
- `readAllBugs` caps results at 500 rows (defends against runaway result sets; far above current volume).
- Insert path: `POST /api/test-feedback` → `bugLog.appendBug` → INSERT (plus best-effort admin email)
- Read paths: admin UI `GET /api/admin/tester-bugs`, mission-picker badges `GET /api/qa/shortlist`, CLI `npm run bugs:list`

**mission_completions** — Lab Rat mission completion log (replaces the prior filesystem JSONL store, which was wiped on every Render deploy — same fix pattern as `tester_bugs` from 2026-05-10)
- `id` BIGSERIAL PK
- `mission_id` TEXT NOT NULL
- `tester_name` TEXT — optional
- `completed_at` TIMESTAMPTZ DEFAULT NOW()
- Index `idx_mission_completions_mission_id` supports the shortlist's `GROUP BY mission_id COUNT(*)` aggregation
- Insert path: `POST /api/qa/complete` → `missionStats.logCompletion` → INSERT
- Read path: `POST /api/qa/shortlist` → `missionStats.getCompletionCounts`

**admin_audit_log** — Generic durable record of admin actions on user-owned resources. Initial call sites: tip-page rotate-token + regenerate-stripe; extend as more auditable surfaces emerge (role changes, deactivation, etc.).
- `id` BIGSERIAL PK
- `actor_user_id` FK → users (admin who performed the action; ON DELETE SET NULL — preserves history if the admin record is later removed)
- `target_user_id` FK → users (user whose resource was acted on; ON DELETE SET NULL)
- `action` TEXT NOT NULL — short stable identifier (`tip_token_rotate`, `tip_stripe_regenerate`, etc.)
- `metadata` JSONB DEFAULT `'{}'` — action-specific fields (token prefixes, stripe link ids, etc.). Freeform so each action can store its own transition data without schema churn.
- `created_at` TIMESTAMPTZ DEFAULT NOW()
- Indexed on `(target_user_id, created_at DESC)` for "what's happened to this user" queries and `(action, created_at DESC)` for "all rotations in the last week" queries.
- Write path: `server/utils/adminAuditLog.js` → `logAdminAction({ actorUserId, targetUserId, action, metadata })`. Best-effort — logging failures go to Sentry, never block the underlying business action.

### Shopping List Generator

Located in `client/src/components/ShoppingList/` (frontend) and `server/utils/shoppingList.js` (backend mirror).

**Pipeline:** drink plan submission → server auto-generates a `pending_review` list and stores it on `drink_plans.shopping_list` (JSONB). Admin reviews/edits in the modal (auto-save every 1.5s) then clicks "Approve & Send to Client" which flips `shopping_list_status` to `'approved'` and emails the client a link. Public `GET /t/:token/shopping-list` returns the list only once approved.

**Two input sources.** The same generator can run from either:
- **Planner submission** (client-facing wizard) → stored in `drink_plans.selections` JSONB
- **Consultation form** (admin-facing form on the drink plan detail page) → stored in `drink_plans.consult_selections` JSONB

`drink_plans.shopping_list_source` (`'planner' | 'consult'`) flags which one currently feeds the generator. When both exist, a radio toggle on the detail page lets the admin flip between them — flipping regenerates from the new source and resets `shopping_list_status` to `pending_review`. The consult form is "abbreviated planner": one-screen form with bar type, spirit chip grid, sigs picker + custom drinks, optional mocktail add-on, beer y/n, wine red/white/sparkling, mixers (full / matching / none), and notes.

- **`shoppingListPars.js`** (client) — 100-guest baseline quantities (single source of truth for standard bar pars)
- **`generateShoppingList.js`** (client) — Scales pars by `guestCount / 100`, merges signature cocktail ingredients, boosts shared ingredients
- **`server/utils/shoppingList.js`** — Server-side mirror of `generateShoppingList.js`, used to auto-generate the initial list at submission time. Adds the consult-mode branch (3-state mixers + spirit chip grid) and the `buildGeneratorInputFromConsult()` translator. Must be kept in sync with the client implementation for planner-side fields.
- **`server/utils/shoppingListGen.js`** — Shared helpers used by both the planner auto-gen path and the consult routes: `resolveCocktailIds()`, `buildPlannerGeneratorInput()`, `buildConsultGeneratorInput()`, and `autoGenerateShoppingList()` (with its strict no-overwrite guard).
- **`server/utils/shoppingListAddonCoverage.js`** — Pure helper exporting `computeStripSet()`, which maps a plan's active BYOB-support add-on slugs to the shopping-list item names those add-ons cover. `generateShoppingList()` strips that set from its output as a final pass, so items the client already bought as an upgrade are not re-listed for purchase. `signature-mixers-only` and `the-formula` are deferred (their coverage needs per-cocktail ingredient data not yet populated).
- **`server/routes/drinkPlanConsult.js`** — Admin consult-form routes (`GET/PUT /:id/consult`, `PATCH /:id/shopping-list-source`). Mounted under `/api/drink-plans` alongside the main router.
- **`ShoppingListPDF.jsx`** — jsPDF implementation for branded shopping list PDF generation with Dr. Bartender brand colors. Dynamic-imported by the modal so jspdf + the embedded logo only load when an admin clicks "Download PDF".
- **`ShoppingListButton.jsx`** — Lazy-loads `ShoppingListModal` via `React.lazy` so @dnd-kit + the PDF graph stay out of the admin bundle for sessions where the button is never clicked.
- **`ShoppingListModal.jsx`** — Full-screen editable modal: add/remove/rename/reorder items (drag-and-drop), edit quantities, change guest count with recalculate prompt, share client link, Download PDF, Approve & Send to Client.
- **`ConsultationForm.jsx`** — Lazy-loaded admin modal for the consult-form input path. Mounted on `DrinkPlanDetail.js` behind the "Input from consult" / "Edit consult input" button.
- **`logoBase64.js`** — Logo embedded as base64 data URI for use in PDFs (~129KB; lazy-loaded via `ShoppingListPDF.jsx`)
- **Public client view**: `client/src/pages/public/ClientShoppingList.js` — token-gated read-only display rendered at `/shopping-list/:token`

Admin entry points: "Shopping List" button on Drink Plan Detail (visible whenever a list exists, regardless of plan status) and on Proposal Detail when a drink plan exists. The "Input from consult" button on Drink Plan Detail opens the consultation form for the admin-side input path.

### Blog

**blog_posts** — Lab Notes blog content
- `id` SERIAL PK, `slug` UNIQUE
- `title`, `excerpt`, `body` (sanitized HTML)
- `cover_image_url` — R2-hosted cover image
- `published` BOOLEAN, `published_at` TIMESTAMPTZ
- `chapter_number` — derived via `ROW_NUMBER()` (not stored)

### Email Marketing

**email_leads** — Marketing contacts (separate from clients)
- `id` SERIAL PK, `client_id` FK → clients (nullable, for converted leads)
- `name`, `email` UNIQUE, `company`, `event_type`, `location`
- `lead_source`: manual | csv_import | website | thumbtack | referral | instagram | facebook | google | other
- `status`: active | unsubscribed | bounced | complained
- `unsubscribed_at`

**email_campaigns** — Blast campaigns and drip sequences
- `id` SERIAL PK, `name`, `type`: blast | sequence
- `subject`, `html_body`, `text_body`, `from_email`, `reply_to`
- `status`: draft | scheduled | sending | sent | active | paused | archived
- `scheduled_at`, `sent_at`
- `target_sources` JSONB, `target_event_types` JSONB — audience targeting
- `created_by` FK → users

**email_sequence_steps** — Individual steps in a drip sequence
- `id` SERIAL PK, `campaign_id` FK → email_campaigns
- `step_order`, `subject`, `html_body`, `text_body`
- `delay_days`, `delay_hours` — delay after previous step
- UNIQUE(campaign_id, step_order)

**email_sequence_enrollments** — Lead progress through a sequence
- `id` SERIAL PK, `campaign_id` FK, `lead_id` FK
- `current_step`, `status`: active | completed | paused | unsubscribed
- `enrolled_at`, `last_step_sent_at`, `next_step_due_at`, `completed_at`
- UNIQUE(campaign_id, lead_id)

**quote_drafts** — Saved quote wizard progress for "pick up where you left off"
- `id` SERIAL PK, `token` UUID UNIQUE, `lead_id` FK → email_leads
- `email`, `form_state` JSONB (full wizard state), `current_step` INTEGER
- `status`: draft | completed | expired
- Partial unique index on `(email) WHERE status = 'draft'` — one active draft per email
- Used by abandoned-quote email sequence: scheduler joins to get `token` for resume URLs

**email_sends** — Individual email send records
- `id` SERIAL PK, `campaign_id` FK, `sequence_step_id` FK, `lead_id` FK
- `resend_id` — Resend message ID for webhook correlation
- `subject`, `status`: queued | sent | delivered | opened | clicked | bounced | complained | failed
- `opened_at`, `clicked_at`, `bounced_at`, `complained_at`, `error_message`

**email_conversations** — Two-way conversation records
- `id` SERIAL PK, `lead_id` FK, `email_send_id` FK
- `direction`: inbound | outbound
- `subject`, `body_text`, `body_html`, `resend_id`, `admin_id` FK
- `read_at`

**email_webhook_events** — Raw webhook event audit log
- `id` SERIAL PK, `resend_id`, `event_type`, `payload` JSONB, `processed`

### Thumbtack Integration

**thumbtack_leads** — Leads received from Thumbtack webhooks
- `id` SERIAL PK, `negotiation_id` VARCHAR UNIQUE (Thumbtack's lead ID)
- `client_id` FK → clients (auto-created on lead receipt)
- `customer_id`, `customer_name`, `customer_phone`
- `category`, `description` — what service they're requesting
- `location_address`, `location_city`, `location_state`, `location_zip`
- `event_date` TIMESTAMPTZ, `event_duration` INTEGER (minutes), `guest_count`
- `lead_type`, `lead_price`, `charge_state` — Thumbtack billing info
- `status`: new | contacted | converted | lost
- `raw_payload` JSONB — full original webhook body

**thumbtack_messages** — Messages from Thumbtack conversation threads
- `id` SERIAL PK, `message_id` VARCHAR UNIQUE
- `negotiation_id` FK → thumbtack_leads
- `from_type` (Customer | Business), `sender_name`, `text`, `sent_at`
- `raw_payload` JSONB

**thumbtack_reviews** — Reviews posted on Thumbtack
- `id` SERIAL PK, `review_id` VARCHAR UNIQUE
- `negotiation_id` (nullable), `rating` NUMERIC(2,1), `review_text`, `reviewer_name`
- `raw_payload` JSONB

### Check Cherry Import Tables

One-time migration of legacy proposals, events, payments, payouts, leads, and invoices from Check Cherry. The staging tables remain in the schema after cutover so the Review page can keep surfacing operator triage queues, and so a re-run of any phase stays idempotent against the verbatim source rows.

**legacy_cc_raw_imports** — Generic JSON staging row, one per imported CSV record (every source file, every entity)
- `id` BIGSERIAL PK
- `source_file`, `source_entity` ('events' | 'clients' | 'payments' | 'leads' | 'invoices' | 'payouts' | 'wix_field_guide' | 'wix_contractor' | 'wix_payment_info'), `source_row_number`, `source_row_hash` (sha256 of canonicalized JSON)
- `cc_id` TEXT — present on entity rows that carry one; NULL for payments/payouts/leads/invoices
- `payload` JSONB — verbatim row
- `import_status` TEXT NOT NULL DEFAULT 'pending' CHECK ('pending' | 'promoted' | 'archived' | 'skipped' | 'duplicate_review' | 'duplicate_confirmed' | 'errored')
- `import_notes` JSONB — operator + importer annotations (`{candidate_proposal_id,...}`, `{error,column,value,phase}`, `{resolved_by_user_id,resolved_at,decision}`, etc.)
- UNIQUE `(source_file, source_row_number)` makes re-runs no-op; indexes on `source_entity`, `cc_id` (partial), and `import_status WHERE IN ('duplicate_review','errored')` for the Review page.

**legacy_cc_proposals** — Bucket C archive table (rows the importer chose not to promote into `proposals`)
- `cc_id` TEXT PK; verbatim CC `status`, `client_id` FK→clients (nullable), normalized client email + name, `event_date`, `package_name`, `service_name`, `brand`, venue fields, `estimated_guests`, `source`, `lead_type`, `package_amount_cents`, public + private notes, `booked_at`
- `raw_import_id` BIGINT FK→legacy_cc_raw_imports (ON DELETE RESTRICT) ties each archive row back to its source

**legacy_cc_payments** — Promoted payment and refund rows (337 from the 2026-05-25 export)
- `id` BIGSERIAL PK; `cc_event_id` TEXT (resolved during Phase 4, NULL on orphan), `cc_event_title`, `cc_type` CHECK ('Payment' | 'Refund')
- `paid_on`, `event_date`, `payment_applied_cents` (absolute value, sign carried by `cc_type`), `tip_cents`, `processing_fee_cents`, `net_cents`, `event_total_cents`, plus the CC-side totals/tax fields
- `payment_method`, `processor` ('Stripe Express' | 'Custom'), `receipt_number`, `invoice_number`, `reference_code` (`ch_…` when Stripe), `paid_by`, `assigned_staff`, public + private + operator notes
- `dismissed_at` TIMESTAMPTZ — set when the operator dismisses an orphan-payment from the Review page (removes from the active queue)
- `promoted_payment_id` FK→proposal_payments (SET NULL), `promoted_refund_id` FK→proposal_refunds (SET NULL) — only one of the two is populated on promotion (CHECK guard)
- `raw_import_id` UNIQUE FK→legacy_cc_raw_imports (ON DELETE RESTRICT) — one staging row per legacy payment

**legacy_cc_payouts** — Historical staff payouts from CC
- `id` BIGSERIAL PK; `payee_name`, `payee_name_normalized`, `payee_user_id` FK→users (SET NULL — set on link from the Review page), `paid_on`, `amount_cents`, `reference_role`, `category`
- `raw_import_id` UNIQUE FK→legacy_cc_raw_imports (ON DELETE RESTRICT)
- Indexes on `payee_user_id`, `paid_on`, `payee_name_normalized` support the unmatched-payee picker

**cc_import_phase0_failures** — Durable retry queue for Phase 0 attachment fetches
- `id` SERIAL PK; `source_url`, `source_entity`, `source_row_hash`
- `attempt_count` INTEGER DEFAULT 0, `last_error`, `last_attempted_at`, `resolved_at`, `resolved_r2_key`
- `given_up_at`, `given_up_reason` — operator marked the loss accepted (counts as 'resolved' for the sunset gate)
- UNIQUE `(source_url, source_entity)`; partial index `idx_cc_import_phase0_failures_active(attempt_count) WHERE resolved_at IS NULL AND given_up_at IS NULL` keeps the retry sweep cheap

**cc_import_runs** — Per-run telemetry log
- `id` SERIAL PK; `phase` INTEGER, `started_at`, `finished_at`, `status` CHECK ('running' | 'succeeded' | 'failed' | 'partial')
- `rows_processed`, `rows_inserted`, `rows_skipped`, `rows_errored`, `error_summary`, `notes` JSONB (audit trail per row decision when relevant)

### Columns added to existing tables (CC import)

- **`clients.cc_id` TEXT**, **`proposals.cc_id` TEXT**, **`users.cc_id` TEXT** — partial unique indexes `WHERE cc_id IS NOT NULL` on each. Real CC ids on `clients` / `proposals`; on `users` the value is a stub-format prefix `legacy_cc:<scope>:<id>` for imported bartenders we cannot pay through the modern payouts system. The `cc_id LIKE 'legacy_cc:%'` predicate is the canonical stub check used by `server/utils/payrollGuards.js`.
- **`proposal_payments.legacy_charge_id` TEXT** — Stripe charge id (`ch_…`) imported from Check Cherry. NEVER pass to Stripe API as `payment_intent:` — it MUST be `charge:`. Native (non-import) rows leave it NULL. Per-proposal partial unique index for re-run dedup; global partial unique index catches a misroute across proposals.
- **`proposal_payments.payment_method` TEXT** — free-form method label (`card` | `card_external` | `cash` | `check` | `paypal` | `other` | `unknown`). Populated by the importer; nullable on native rows.

### Cross-Cutting Patterns
- All tables have `created_at` / `updated_at` with auto-update triggers
- UUID tokens on `drink_plans`, `proposals`, and `quote_drafts` for public access without auth
- JSONB columns for flexible data: `selections`, `pricing_snapshot`, `includes`, `details`
- Status columns use CHECK constraints for valid values
- **Metrics indexes** (added 2026-05-17): `idx_proposals_sent_at` on `proposals(sent_at)`, `idx_proposals_accepted_at` on `proposals(accepted_at)`, `idx_proposal_payments_created_at` on `proposal_payments(created_at)` — support the date-range filter queries in `GET /api/proposals/dashboard-stats` and `GET /api/proposals/financials`

## Pricing Engine

Located in `server/utils/pricingEngine.js`. Pure functions, no database dependencies.

**Inputs**: package data, guest count, duration, number of bars, number of bartenders, selected add-ons, selected syrups.

**Calculation flow**:
1. **Base cost**: Flat rate (BYOB) or per-guest rate (Hosted) with small-event tier pricing
2. **Bar rental**: First bar fee + additional bar fee per extra bar
3. **Staffing**: 1 bartender per 100 guests included; extras at $40/hr
4. **Add-ons**: Calculated per billing type (per_guest, per_guest_timed, per_hour, flat)
5. **Syrups**: Three-pack bundles ($30) + singles ($12), optimized for best price
6. **Total**: Sum of all components

The result is stored as a `pricing_snapshot` JSONB on the proposal for historical accuracy.

## Proposal Rules & Send Flow

Proposal business rules (BYOB bundle logic, add-on filtering, and selection guardrails) live in a pair of mirrored modules, following the same manual-twin discipline as `eventTypes.js`.

- **`client/src/utils/proposalRules.js`**: shared client rules consumed by both the public Quote Wizard and the admin proposal cockpit (`ProposalCreate.js`). Pure functions, no React or state. Provides bundle-slug resolution, `stripIncludedAddons` (drops bundle-covered add-ons), and the guardrail checks the UI enforces.
- **`server/utils/proposalRules.js`**: the CJS server twin. Exposes `validateProposalRules`, the authoritative rule gate. Every rule the wizard UI enforces is re-checked here (bundle mutex, mixer mutex, hosted-package guest minimum, glassware-dependent add-ons, parent-addon requirements, guest-count ceilings) so a stale browser tab or a scripted POST cannot bypass them. It throws `ValidationError` on a bad selection. The rule gate and `stripIncludedAddons` run on every proposal-write path: admin `POST /proposals`, admin `PATCH /:id` (edit), and the public `POST /api/proposals/public/submit`.
- **`server/utils/sendProposalSentEmail.js`**: post-commit, best-effort helper that emails the client when a proposal enters the `sent` state. It never throws (the proposal and its invoice are already committed, so an email failure is recoverable; the admin resends from the detail page) and reports failures to Sentry. Invoice creation is not here. It runs inside the caller's DB transaction via `createInvoiceOnSend`.
- **`server/utils/paymentFailedClientNotify.js`**: post-`payment_intent.payment_failed`-webhook helper that emails the client their card was declined, sent once per proposal. The slot is claimed with an atomic `INSERT ... ON CONFLICT DO NOTHING` (partial unique index `idx_proposal_activity_payment_failed_client`) before the fetch and send, so concurrent Stripe retries cannot double-email; a failed send releases the claim. Extracted from `routes/stripe.js` to keep that file under the size cap. Best-effort — owns its try/catch, never throws into the webhook.

`adminWriteLimiter` (`server/middleware/rateLimiters.js`) caps the proposal-write endpoints that can fire client emails (`POST /proposals` and `PATCH /:id/status`) at 10 requests/minute, keyed by admin user id (not IP, so an office NAT does not share a bucket). That is far above any human admin workflow while capping the email-spam blast radius of a compromised admin token.

## Potion Planning Lab (post-booking only)

The drink plan is created **only after the client books** — the Stripe deposit
webhook (`server/routes/stripe.js`) flips the proposal to `deposit_paid` and
calls `createEventShifts` → `createDrinkPlan` (idempotent). There is no
pre-deposit Exploration phase: the Lab is a single linear post-booking flow
(welcome → serving-style quick pick → per-module steps → confirmation). No
drink-plan token or link is generated before the deposit lands.

As a safety net for any `/plan/:token` link already sitting in an inbox from a
pre-deposit proposal, `GET /api/drink-plans/t/:token` returns a locked payload
`{ locked: true, proposalToken }` whenever the linked proposal has not reached
a post-booking status (`isDrinkPlanPreBooking` allowlist in
`server/utils/drinkPlanAccess.js`, fails safe on null/unknown). The client
renders a lock screen ("your drink plan unlocks after you book") with a link
back to the proposal instead of mounting the wizard — relevant for legacy
links only, since no new pre-deposit plans are created.

When a drink plan's linked proposal has a hosted package
(`service_packages.category = 'hosted'`), the Potion Planning Lab skips the
serving-style quick pick, the spirits selection, and the beer/wine selection
— these are already fixed by the package. A compact `HostedGuestPrefsStep`
replaces them, asking only how guests lean (mostly beer / cocktails / wine /
balanced). Cocktail cards show a "+$X/guest" badge when the drink needs
ingredients outside the package's stocked catalog; selecting such a drink
auto-adds the relevant specialty-ingredient add-on to the proposal with a
toast confirmation. Add-ons already covered by the package are suppressed
from every offer point. Logic lives in `client/src/pages/plan/data/packageGaps.js`
(pure helpers) + `server/utils/pricingEngine.js` (parity helpers); the data
model is `service_packages.covered_addon_slugs` and `cocktails.upgrade_addon_slugs`.

## Booking-Window Policy

Lead-time-based booking rules, computed by one pure helper so the client never
re-derives date math:

- `server/utils/bookingWindow.js` — pure lead-time tier (14-day full-payment /
  72-hour staffing-hold) computation; the single source of truth for
  booking-window policy. `getBookingWindow({ eventDate, eventStartTime, now }) →
  { hoursUntilEvent, fullPaymentRequired, lastMinuteHold }`. UTC math (consistent
  with the rest of the date code); null `event_start_time` ⇒ 00:00 of the event
  date (conservative — classifies more urgent).
- `server/utils/lastMinuteAlert.js` — admin + broad-net staff SMS blast for
  ≤72h "staffing hold" bookings (`notifyLastMinuteBooking(proposalId)`,
  self-guarding/non-blocking).
- `server/utils/lastMinuteStaffingConfirmation.js` — Touch 2.2: the moment a
  held proposal's shift becomes fully staffed, fire one client email + one
  client SMS naming the bartender(s) + phone. The trigger
  `confirmStaffingIfFullyStaffed(shiftId)` atomically flips
  `proposals.last_minute_hold` true→false via `RETURNING id`; only the caller
  that wins the flip fires the notify (one-shot guard, no double-sends under
  concurrent fills). Called from `server/routes/shifts.js` (manual assign +
  request approval) and `server/utils/autoAssign.js`.

**Behavior.** Bookings ≤14 days out require full payment — the deposit option is
**rejected at the `create-intent` payment-intent gate** (`FULL_PAYMENT_REQUIRED`;
never silently coerced) and hidden in the proposal UI via the server-computed
`payment_policy` block on `GET /t/:token`. Bookings ≤72h out additionally set
`proposals.last_minute_hold` (in the `payment_intent.succeeded` webhook, in-tx,
inside the `isFirstDelivery` idempotency guard), warn the client both
pre-payment (proposal page) and in the first-payment email that the booking is
subject to staff availability with a full refund if unstaffable, and trigger an
admin + staff SMS blast post-commit (once-per-payment via `isFirstDelivery`).
The hold clears automatically when the linked shift is fully staffed (approved
`shift_requests` ≥ `positions_needed` length — autoAssign's definition) via the
approve/assign handlers in `server/routes/shifts.js`. The Stripe charge path,
`balance_due_date` COALESCE, and the autopay scheduler are untouched (full
payment naturally sets `status='balance_paid'`, which the scheduler never
claims). Refunds on the rare unstaffable case are manual (Stripe dashboard) by
deliberate scope choice.

## CC-Import Behavior Changes

The Check Cherry import landed several skip gates and best-effort hooks across the money path, drink-plan scheduling, and reschedule code. They are documented here as a single load-bearing list because each one is invisible-by-design (the data flow looks identical on a normal proposal) and easy to lose on a refactor.

1. **`scheduleDrinkPlanNudge` early-return when no drink plan exists** (`server/utils/drinkPlanNudge.js:215-221`). Before scheduling the email + SMS nudge rows, the helper checks `SELECT 1 FROM drink_plans WHERE proposal_id = $1 LIMIT 1` and returns early if none. CC-imported proposals are created without drink plans; without this guard every `paymentIntent.succeeded` retransmission and every reschedule cascade would re-fan a nudge into the dispatcher. Pre-existing tests now seed a `drink_plans` row before invoking the helper.

2. **`createDrinkPlan` post-insert hook fires `scheduleDrinkPlanNudge` best-effort** (`server/utils/eventCreation.js:77-86`). Whenever a drink plan is created (admin route OR the Stripe deposit webhook flow), the helper is invoked in a try/catch that reports to Sentry on failure. The drink plan persists either way — scheduling is not on the durability boundary. This is the re-enroll path for cc-imported proposals whose drink plan is created post-import.

3. **`accruePayoutsForProposal` skips when any participant is a legacy CC stub** (`server/utils/payrollAccrual.js:71-78`, helper in `server/utils/payrollGuards.js`). Returns `{ skipped: true, reason: 'legacy_cc_stub_participant' }` BEFORE any DB writes — we never want to INSERT into `payouts` referencing a stub user (we cannot pay them through Stripe Connect anyway). The check is per-proposal because the whole event's accrual is structurally atomic. After the operator clears stubs from `/admin/cc-import/review`, the admin can re-fire via `POST /admin/proposals/:id/reaccrue-payout`.

4. **`rollForwardLateTip` + `clawbackTip` filter legacy CC stub bartenders out of the per-bartender split** (`server/utils/payrollLateTip.js:41-68`, `server/utils/payrollClawback.js:44-75`). The bartender query JOINs `users` and tags `(u.cc_id LIKE 'legacy_cc:%') AS is_stub`; stubs are excluded from the denominator. On a mixed shift, real bartenders absorb the stub's share. When ALL approved bartenders on the shift are stubs, the entire operation is skipped under `{ skipped: true, reason: 'all_bartenders_are_legacy_cc_stubs' }` BEFORE any DB writes — `rolled_forward_at` / `refunded_amount_cents` stay untouched so a future de-stub can replay. When ZERO bartenders are on the shift, the tip is marked rolled-forward / advanced (permanent — nothing to retry).

5. **`SKIP_REANCHOR_TYPES` in `server/utils/rescheduleProposal.js:15`** — defense-in-depth set of cc-import-injected scheduled-message types that must NOT be re-anchored when an imported proposal's `event_date` moves. Currently `Set(['post_event_wrap_up_email'])`. The wrap-up handler already registers with `offsetFromEventDate: null` (which short-circuits via the `if (!newScheduledFor) continue;` branch in `reanchorPendingMessages`), but the explicit skip set guarantees a future handler-meta change cannot silently start re-anchoring wrap-up rows.

## Third-Party Integrations

### Stripe (Payments)
- **Flow**: Admin creates proposal → Client views → Client signs contract + pays (deposit or full) on a single screen → Stripe PaymentIntent confirmed → Webhook updates status → Event shift auto-created
- **Payment options**: Pay $100 deposit (default) or pay in full. Deposit option includes autopay checkbox.
- **Autopay**: When enrolled, Stripe saves the payment method via `setup_future_usage: 'off_session'`. A Stripe Customer is created for the client. Balance is auto-charged on the due date (default: 14 days before event) by the hourly scheduler in `server/utils/balanceScheduler.js`.
- **Off-session charges**: Admin can manually trigger via `POST /api/stripe/charge-balance/:id` or the scheduler runs hourly.
- **Alternative**: Admin generates a reusable Payment Link via `POST /api/stripe/payment-link/:id`
- **Webhook events**: `payment_intent.succeeded` (deposit, full, balance, drink-plan-extras), `checkout.session.completed` (deposit via Payment Link AND bartender tips, branched on `metadata.kind`)
- **Deposit**: $100 (configurable via `STRIPE_DEPOSIT_AMOUNT` in cents)
- **Tip Payment Links**: Each onboarded bartender has a reusable Stripe Payment Link with `metadata.kind = 'tip'`, `metadata.bartender_user_id`, and `metadata.tip_page_token`, provisioned by `server/utils/tipPaymentLinks.js`. On `checkout.session.completed` the webhook cross-validates the metadata against `payment_profiles.tip_page_token` (DB is source of truth — if metadata's bartender_user_id disagrees, the DB user_id wins) and inserts a row into `tips`. Admin can regenerate the Stripe link via `POST /api/admin/contractors/:userId/tip-page/regenerate-stripe`, or rotate the tip token entirely via `POST /api/admin/contractors/:userId/tip-page/rotate-token` — the emergency break-glass route used when a printed QR card or URL is compromised. Rotation issues a fresh UUID, deactivates the old Stripe Payment Link, creates a new one, and invalidates in-flight checkouts on the old link (the webhook drops sessions whose `metadata.tip_page_token` no longer matches the DB).
- **Partial refunds**: Admin-issued via `POST /api/stripe/refund/:id`. `planRefund` (in `server/utils/refundHelpers.js`) auto-targets the largest refundable charge (no spanning). `applyRefundReconciliation` (same file) holds a row-lock on the proposals row, applies Approach-A label-conditional `total_price` correction (Deposit/Balance/Full Payment invoices adjust the contract total; extra-scope invoices leave it intact), nets the aggregate invoice reversal, and writes to the activity log. The synchronous route does the Stripe API call then reconciliation; an idempotent `charge.refunded` webhook handler is the backstop that self-heals a failed post-Stripe write AND records out-of-band Stripe-dashboard refunds. The partial unique index on `proposal_refunds.stripe_refund_id` (WHERE NOT NULL) is the shared idempotency anchor.
- **Important**: Stripe webhook route (`/api/stripe/webhook`) must receive raw body — registered before `express.json()` in `server/index.js`

### Resend (Email)
- **Wrapper**: `server/utils/email.js` (single send + batch)
- **From**: `Dr. Bartender <no-reply@drbartender.com>`
- **Used for**: Transactional notifications (proposals, OTPs, shifts, application status, balance reminders, shopping list) + email marketing (blasts, drip sequences)
- **Marketing**: `server/routes/emailMarketing.js` — leads, campaigns, sequences, conversations, analytics
- **Webhooks**: `server/routes/emailMarketingWebhook.js` — receives tracking events (sent/delivered/opened/clicked/bounced/complained), verified via `svix`
- **Scheduler**: `server/utils/emailSequenceScheduler.js` — processes drip sequence steps every 15 minutes
- **Templates**: `server/utils/emailTemplates.js` — `wrapEmail()` for transactional, `wrapMarketingEmail()` for marketing (includes unsubscribe link). Application status progression sends `applicationInterviewInvite`, `applicationHired`, `applicationRejected`, `applicationDeactivated` (admin's optional personal note is `esc()`-d into a styled block; user-supplied names are also `esc()`-d in HTML bodies). `applicationReceivedConfirmation` is sent only at submission time, not on admin status reverts.

### Twilio (SMS)
- **Wrapper**: `server/utils/sms.js` (includes `normalizePhone()` for E.164 formatting)
- **Used for**: Admin-initiated SMS to staff (general messages, shift invitations), shift approval notifications
- **Consent**: Collected during agreement signing (`sms_consent` flag) — only consented staff appear as eligible recipients
- **Logging**: All inbound + outbound messages logged to `sms_messages` table with delivery status tracking
- **Inbound webhook**: `POST /api/sms/inbound` (`server/routes/sms.js`) receives Twilio inbound messages, signature-verified via `TWILIO_AUTH_TOKEN` (`twilio.validateRequest`, no JWT). `server/utils/smsInbound.js` orchestrates each message: handles STOP/START opt-out, staff CONFIRM/CANT response codes, looks up the sender (client or staff), and routes client texts to the admin Messages thread UI.

### Thumbtack (Lead Generation)
- **Integration type**: Custom endpoint webhooks (V4 format with legacy fallback)
- **Endpoints**: `server/routes/thumbtack.js` — receives lead, message, and review webhooks
- **Auth**: Shared secret via Basic Auth header or `X-Thumbtack-Secret` custom header (`THUMBTACK_WEBHOOK_SECRET`)
- **Lead flow**: Thumbtack sends lead → webhook creates/matches client (by phone) with `source='thumbtack'` → stores in `thumbtack_leads` → emails admin notification
- **Important**: Thumbtack does NOT include customer email in webhooks. Admin must grab email manually from Thumbtack (lead → three-dot menu → create estimate/invoice) and add it to the client record.
- **Messages**: Customer messages stored in `thumbtack_messages`, admin notified via email
- **Reviews**: Stored in `thumbtack_reviews`, admin notified via email
- **Custom domain**: `api.drbartender.com` CNAME → Render, so Thumbtack endpoints are permanent regardless of hosting changes

### Cal.com

Self-hostable open-source scheduling platform. drb-os receives Cal.com webhooks for consult bookings.

- **Hosting**: V1 uses Cal.com's hosted SaaS. V2 plan migrates to self-hosted Docker on the always-on office box, sharing the same `CAL_*` env vars (only secret + URL change at cutover). Cal.com's open-source codebase means the webhook payload shape is identical between hosted and self-hosted.
- **Endpoint**: `POST /api/calcom/webhook`. Mounted at `server/routes/calcom.js`. Bare HTTP semantics (no AppError JSON envelopes) matching the Stripe and Resend webhook patterns.
- **Signature scheme**: HMAC-SHA256 over the raw body, secret = `CAL_WEBHOOK_SECRET`, header `x-cal-signature-256`. Fails closed: handler returns 503 if secret unset, 400 on missing or invalid signature.
- **Replay protection**: SHA-256 of the raw signed body recorded in the `webhook_events` table. Same body delivered twice (legitimate Cal.com retry on a 5xx, OR attacker replay) returns 200 'Already processed' without side effects.
- **Events handled**: `BOOKING_CREATED` (auto-creates a `clients` row if booker email doesn't match an existing client, links to most recent non-terminal proposal if any), `BOOKING_CANCELLED` (defensive upsert), `BOOKING_RESCHEDULED` (in-place update with fallback to fresh-create), `BOOKING_NO_SHOW_UPDATED` (mirrors Cal.com's manual no-show marking). Other event types are logged + 200 OK so Cal.com does not retry.
- **Side effects**: NO admin SMS or email on any booking event. Cal.com itself owns admin notification (it emails the organizer and syncs the event into the organizer's Google Calendar). drb-os silently files the booking into the `consults` table for status tracking, suppression queries (drink-plan nudge), and audit.
- **Completion**: the linked consults row flips to `'completed'` when admin submits the existing consult form in `server/routes/drinkPlanConsult.js`. Side effect of the existing user action; no UI change.
- **Deferred to V2 (when self-hosted)**: writing the drb-os event URL directly into Cal.com's `booking.description` via direct DB access, so the link appears in the organizer's Google Calendar entry. Today admin opens drb-os manually after seeing Cal.com's notification.

### Cloudflare R2 (File Storage)
- **Wrapper**: `server/utils/storage.js`
- **Upload flow**: Validate file (magic bytes) → Upload to R2 bucket → Store key in DB → Generate signed URL (15-min expiry) for downloads
- **Files stored**: W-9, resume, headshot, alcohol certification, BASSET certification, bartender tip-page photos
- **Admin access**: `GET /api/files/:filename` redirects to signed URL (admin/manager only)

### Google Places (Venue Search)
- **Wrapper**: `server/utils/googlePlaces.js` — server-mediated proxy over the Google Places (New) API powering the proposal venue-name typeahead (autocomplete + place details → structured venue address). Fails soft (returns `[]`/`null`, never throws) so the venue-name field degrades to a plain text input when `GOOGLE_PLACES_API_KEY` is unset or Google is unreachable. The pure `mapPlaceToVenue` mapper drops out-of-area addresses, keeping only `VENUE_STATES` matches.

### QR Code Rendering (`qrcode.react`)
- Client-only dependency used by `client/src/pages/staff/PrintTipCard.jsx` and `PrintTipCard.layouts.jsx` to render the bartender's tip-page URL as an SVG QR code on the printable tip card. No server side; rendered in the browser at print time.

## Deployment Architecture

```
┌──────────────┐     push to main     ┌─────────────────────────┐
│   GitHub     │ ────────────────────► │  Render (Backend)       │
│   main       │                       │  - Express server       │
│              │                       │  - Auto-deploy on push  │
│              │     push to main      │  - PostgreSQL (internal)│
│              │ ────────────────────► ├─────────────────────────┤
└──────────────┘                       │  Vercel (Frontend)      │
                                       │  - React SPA            │
                                       │  - Auto-deploy on push  │
                                       └──────────┬──────────────┘
                                                   │
                                       ┌───────────▼──────────────┐
                                       │  External Services       │
                                       │  - Stripe (payments)     │
                                       │  - Resend (email)        │
                                       │  - Twilio (SMS)          │
                                       │  - Cloudflare R2 (files) │
                                       └──────────────────────────┘
```

- **Backend**: Render web service, auto-deploys from `main`. `render.yaml` defines the blueprint. Schema auto-runs on startup.
- **Frontend**: Vercel static site. `vercel.json` rewrites all paths to `index.html` for client-side routing. `REACT_APP_API_URL` set at build time.
- **Database**: Render-managed PostgreSQL. Schema initialization is idempotent — `schema.sql` uses `IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS` throughout.
- **No manual deploy step**: push to `main` triggers both Render and Vercel builds automatically.

## Dev Tooling & Code Quality

### ESLint + Security Plugin
- **Config**: `eslint.config.mjs` (ESLint v10 flat config)
- **Plugin**: `eslint-plugin-security` — flags SQL injection patterns, unsafe regex, object injection sinks, eval usage
- **Rules**: `eqeqeq` (strict equality), `no-eval`, `no-implied-eval`, `no-new-func`, `prefer-const`, `require-await`
- **Run**: `npm run lint` (check) or `npm run lint:fix` (auto-fix)

### Pre-Commit Hooks (Husky + lint-staged)
- **Hook**: `.husky/pre-commit` runs `npx lint-staged`
- **Scope**: Only lints staged `server/**/*.js` files (fast — not full codebase)
- **Behavior**: Blocks commits with ESLint errors; allows warnings

### Claude Code Review Agents
Seven custom agents in `.claude/agents/` provide automated code review:
- **Tier 2 (automatic, haiku)**: `security-scan`, `consistency-check`, `error-handling-check` — run in parallel after completing features
- **Tier 3 (on-demand, sonnet)**: `full-security-audit`, `full-code-review`, `database-review`, `ui-ux-review` — run when explicitly requested
- See `CLAUDE.md` § Code Verification System for full details

## Operational Practices

### Weekly dispute-email-bailout sweep

The dispute-won email-retry bailout (see `server/utils/payrollDisputeNotify.js`) writes `tips.dispute_email_failed_at = NOW()` when it permanently abandons a notification after three send failures. The Sentry alert accompanying the bailout is best-effort: a process crash between commit and the Sentry call, or a Sentry transport failure, can lose the alert silently while the DB row carries the canonical marker.

Run this query weekly to catch any abandonments that did not reach Sentry:

```sql
SELECT id, dispute_email_failed_at, amount_cents, shift_id, target_user_id
  FROM tips
 WHERE dispute_email_failed_at IS NOT NULL
 ORDER BY dispute_email_failed_at DESC;
```

For each row, follow the manual recovery runbook in `docs/superpowers/specs/2026-05-25-dispute-email-retry-bailout-design.md`. Before posting any adjustment, search `proposal_activity_log` by `tip_id` to avoid double-paying bartenders (the `Promise.race` timeout in `notifyDisputeWon` aborts the awaiter but does not cancel the in-flight Resend request, so the email may have actually delivered server-side even when the function treated it as a failure).

## Plan-execution review cadence

When executing a multi-batch plan via subagent-driven development, the implementer dispatches specialized review agents at batch checkpoints matched to what each batch actually changed, in addition to the pre-push fleet that always runs all 5 non-UI agents per CLAUDE.md Rule 6. This is the cadence that worked for the cc-import rollout and is the default reference for future multi-batch plans (see project memory `feedback_execution_review_cadence.md`):

| Batch type | Review agent(s) at the batch checkpoint |
|---|---|
| Schema migration | `database-review` |
| Money-path / payroll | `code-review` + `consistency-check` |
| Dispatcher / scheduler integration | `consistency-check` |
| Importer foundation library | `code-review` |
| Phase 3 (proposals/shifts writes) | `database-review` + `consistency-check` |
| Phase 4 (payments/refunds) | `database-review` + `security-review` + `consistency-check` |
| Admin pages (12+ endpoints, auth-sensitive) | `security-review` + `code-review` |
| Dashboard SQL filter helpers | `database-review` |
| UI affordances + cc_id consumer enumeration | `consistency-check` + `code-review` |

The per-batch checkpoints catch the issues that the broader pre-push fleet would also catch but later in the cycle, and they let each batch land verifiably clean before the next batch is built on top of it. The pre-push fleet remains the gate before the deploying push.

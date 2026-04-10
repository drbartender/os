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

## API Routes

### Authentication — `/api/auth`
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/register` | No | Create account, auto-create onboarding_progress row |
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
| GET | `/` | Yes | Get current agreement data |
| POST | `/` | Yes | Save signature, legal consents, SMS opt-in |

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
| GET | `/applications` | Admin | Paginated application list with status filters |
| GET | `/applications/:userId` | Admin | Application detail with interview notes |
| POST | `/applications/:userId/notes` | Admin | Add interview note |
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
| GET | `/:id` | Admin | Fetch single plan by ID |
| PATCH | `/:id/notes` | Admin | Update admin notes |
| PATCH | `/:id/status` | Admin | Update plan status |
| DELETE | `/:id` | Admin | Delete a plan |
| GET | `/t/:token` | Public | Fetch questionnaire by token (JOINs proposal for guest_count, num_bartenders, pricing_snapshot) |
| PUT | `/t/:token` | Public | Save draft or submit selections (on submit: processes addOns into proposal_addons, recalculates pricing, sends admin email) |

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
| GET | `/` | Admin | List proposals with filters (status, search) |
| POST | `/` | Admin | Create proposal (auto-calculates pricing, creates client if needed) |
| POST | `/calculate` | Admin | Preview pricing without saving |
| GET | `/packages` | Admin | List service packages |
| GET | `/addons` | Admin | List add-ons |
| GET | `/:id` | Admin | Get single proposal with addons + activity log |
| PATCH | `/:id` | Admin | Update event details and recalculate pricing |
| PATCH | `/:id/status` | Admin | Update proposal status |
| PATCH | `/:id/notes` | Admin | Update admin notes |
| DELETE | `/:id` | Admin | Delete a proposal |
| GET | `/t/:token` | Public | Fetch proposal by token (tracks views + geolocation) |
| POST | `/t/:token/sign` | Public | Client signature + acceptance |
| PATCH | `/:id/balance-due-date` | Admin | Override balance due date for a proposal |
| POST | `/:id/record-payment` | Admin | Record an outside payment (cash, Venmo, etc.) — triggers shift creation |
| POST | `/:id/create-shift` | Admin | Manually create event shift from a paid proposal |

### Stripe — `/api/stripe`
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/create-intent/:token` | Public | Create Stripe PaymentIntent (deposit or full amount, with optional autopay) |
| POST | `/payment-link/:id` | Admin | Generate reusable Stripe Payment Link |
| POST | `/charge-balance/:id` | Admin | Manually trigger off-session autopay balance charge |
| POST | `/webhook` | Stripe | Handle `payment_intent.succeeded`, `checkout.session.completed` — updates payment status, auto-creates event shift |

### Clients — `/api/clients`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | Admin | List clients |
| POST | `/` | Admin | Create client |
| GET | `/:id` | Admin | Client detail with proposal history |
| PUT | `/:id` | Admin | Update client |

### Shifts — `/api/shifts`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | Yes | List shifts (staff see open upcoming; admin see all) |
| GET | `/my-requests` | Yes | Current user's shift request history |
| POST | `/` | Staffing | Create shift |
| PUT | `/:id` | Staffing | Update shift |
| DELETE | `/:id` | Staffing | Delete shift |
| POST | `/:id/request` | Yes | Request assignment to a shift |
| DELETE | `/requests/:requestId` | Yes | Cancel own request (admin can cancel any) |
| GET | `/:id/requests` | Staffing | Get all requests for a shift |
| PUT | `/requests/:requestId` | Staffing | Approve or deny a request (sends SMS on approve) |
| POST | `/:id/auto-assign` | Staffing | Run auto-assign algorithm (dry_run for preview, or execute to approve top candidates) |
| GET | `/by-proposal/:proposalId` | Staffing | Get shift for a specific proposal (used by event detail page) |

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

### Other
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | No | Health check (`{ status: 'ok' }`) |

### Public Website Pages (Client-Side Only)
| Path | Component | Description |
|---|---|---|
| `/` | `HomePage` | Public homepage with services, stats, CTA |
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
- `sms_consent`, `acknowledged_field_guide`, `agreed_non_solicitation`

**payment_profiles** — Payment method preferences
- `user_id` FK → users
- `preferred_payment_method`, `payment_username`
- `routing_number`, `account_number` (direct deposit)
- `w9_file_url`

### Application & Hiring

**applications** — Contractor application form data
- `user_id` FK → users
- Full personal info, experience, tools, equipment, availability
- File URLs: resume, headshot, BASSET cert
- `birth_month/day/year` for 21+ validation

**interview_notes** — Admin notes on applicants
- `user_id` FK → users, `admin_id` FK → users
- `note`, `note_type` (default: 'note')

### Event Planning

**drink_plans** — Client event questionnaire (auto-created when proposal becomes an event)
- `token` UUID (public access)
- `client_name`, `client_email`, `event_name`, `event_date`
- `proposal_id` — links to the source proposal/event
- `serving_type`, `selections` (JSONB — chosen cocktails/mocktails, syrupSelections, addOns)
- `selections.addOns` — object keyed by addon slug with metadata (e.g., champagne-toast servingStyle)
- `status`: pending | draft | submitted | reviewed
- On submit: addOns flow into proposal_addons, pricing is recalculated, admin notified
- Auto-emails the drink plan link to client on creation

### Proposals & Pricing

**service_packages** (12 rows) — Service tiers
- `slug`, `name`, `description`, `category` (byob | hosted)
- `pricing_type` (flat | per_guest)
- Rate columns: `base_rate_3hr`, `base_rate_4hr`, `extra_hour_rate` (standard + small-event variants)
- Staffing: `bartenders_included`, `guests_per_bartender`, `extra_bartender_hourly`
- Bar fees: `first_bar_fee`, `additional_bar_fee`
- `includes` (JSONB array of what's included)

**service_addons** (18 rows) — Add-on services
- `slug`, `name`, `description`
- `billing_type`: per_guest | per_hour | flat | per_guest_timed
- `rate`, `extra_hour_rate`
- `applies_to`: byob | hosted | all

**proposals** — Generated service proposals
- `token` UUID (public access), `client_id` FK → clients
- Event details: name, date, start time, duration, location, guest count
- `package_id` FK → service_packages, `num_bars`, `num_bartenders`
- `pricing_snapshot` (JSONB — full pricing breakdown at time of creation)
- `total_price`, `status`: draft | sent | viewed | modified | accepted | deposit_paid | balance_paid | confirmed
- Client signature: `client_signed_name`, `client_signature_data`, `client_signed_at`
- Payment: `payment_type` (deposit | full), `autopay_enrolled`, `deposit_amount`, `amount_paid`, `balance_due_date`
- Stripe: `stripe_customer_id`, `stripe_payment_method_id` (for autopay off-session charges)
- Tracking: `view_count`, `last_viewed_at`

**proposal_addons** — Line items linking proposals to add-ons
- `proposal_id` FK, `addon_id` FK
- `addon_name`, `billing_type`, `rate`, `quantity`, `line_total`

**proposal_activity_log** — Audit trail
- `proposal_id` FK, `action` (created, sent, viewed, signed, deposit_paid, etc.)
- `actor_type` (system | admin | client), `actor_id`, `details` (JSONB)

**stripe_sessions** — Payment intent tracking
- `proposal_id` FK
- `stripe_payment_intent_id`, `stripe_payment_link_id`
- `amount` (cents), `status`

**proposal_payments** — Individual payment records
- `proposal_id` FK, `stripe_payment_intent_id`
- `payment_type`: deposit | balance | full
- `amount` (cents), `status`

### Clients

**clients** — Client records
- `name`, `email`, `phone`
- `source`: direct | thumbtack | referral | website
- `notes`

### Menu

**cocktail_categories** (5 rows) + **cocktails** (25 rows) — Cocktail menu
- Categories: Crowd Favorites, Light & Refreshing, Classic, Bold, Bartender's Picks
- Each cocktail: name, emoji, base_spirit, description, sort_order, is_active, ingredients (JSONB array of strings — used by the Shopping List Generator)

**mocktail_categories** (4 rows) + **mocktails** (16 rows) — Mocktail menu
- Categories: Fruity & Refreshing, Creamy & Sweet, Sparkling & Light, Bold & Complex

### Staffing

**shifts** — Event shifts
- `event_name`, `event_date`, `start_time`, `end_time`, `location`
- `positions_needed` (JSON text array, e.g. `["Bartender","Bartender"]`), `status`, `created_by`
- `proposal_id` FK (nullable) — links to the proposal that created this shift (auto-created on deposit payment)
- `lat`, `lng` — Geocoded event coordinates
- `equipment_required` (JSON text array, e.g. `["portable_bar","cooler"]`)
- `auto_assign_days_before` — Schedule auto-assign N days before event; `auto_assigned_at` — timestamp of last auto-assign run

**shift_requests** — Staff applying for shifts
- `shift_id` FK, `user_id` FK (unique together)
- `position`, `status` (pending/approved/rejected), `notes`

**app_settings** — Configurable settings (auto-assign weights, max distance, etc.)
- `key` VARCHAR PK, `value` TEXT, `updated_at`

### Messaging

**sms_messages** — Outbound SMS message log
- `id` SERIAL PK
- `user_id` FK → users (recipient)
- `shift_id` FK → shifts (nullable, for shift invitations)
- `group_id` UUID — groups messages from the same batch send
- `message_type` — e.g. general, shift_invitation
- `to_phone`, `body`
- `twilio_sid`, `status` — delivery tracking
- `sent_by` FK → users (admin who sent)

### Shopping List Generator

Located in `client/src/components/ShoppingList/`. Fully client-side PDF generation (no backend persistence).

- **`shoppingListPars.js`** — 100-guest baseline quantities (single source of truth for standard bar pars)
- **`generateShoppingList.js`** — Scales pars by `guestCount / 100`, merges signature cocktail ingredients, boosts shared ingredients
- **`ShoppingListPDF.jsx`** — jsPDF implementation for branded shopping list PDF generation with Dr. Bartender brand colors
- **`ShoppingListButton.jsx`** — Fetches `GET /api/drink-plans/:id/shopping-list-data`, handles missing guest count prompt, opens the modal
- **`ShoppingListModal.jsx`** — Full-screen editable modal: add/remove/rename items, edit quantities, change guest count with recalculate prompt, then Download PDF
- **`logoBase64.js`** — Logo embedded as base64 data URI for use in PDFs

Accessible via the "Shopping List" button on Drink Plan Detail (admin), visible when plan status is `submitted` or `reviewed`.

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

### Cross-Cutting Patterns
- All tables have `created_at` / `updated_at` with auto-update triggers
- UUID tokens on `drink_plans`, `proposals`, and `quote_drafts` for public access without auth
- JSONB columns for flexible data: `selections`, `pricing_snapshot`, `includes`, `details`
- Status columns use CHECK constraints for valid values

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

## Third-Party Integrations

### Stripe (Payments)
- **Flow**: Admin creates proposal → Client views → Client signs contract + pays (deposit or full) on a single screen → Stripe PaymentIntent confirmed → Webhook updates status → Event shift auto-created
- **Payment options**: Pay $100 deposit (default) or pay in full. Deposit option includes autopay checkbox.
- **Autopay**: When enrolled, Stripe saves the payment method via `setup_future_usage: 'off_session'`. A Stripe Customer is created for the client. Balance is auto-charged on the due date (default: 14 days before event) by the hourly scheduler in `server/utils/balanceScheduler.js`.
- **Off-session charges**: Admin can manually trigger via `POST /api/stripe/charge-balance/:id` or the scheduler runs hourly.
- **Alternative**: Admin generates a reusable Payment Link via `POST /api/stripe/payment-link/:id`
- **Webhook events**: `payment_intent.succeeded` (handles deposit, full, and balance payment types via metadata), `checkout.session.completed`
- **Deposit**: $100 (configurable via `STRIPE_DEPOSIT_AMOUNT` in cents)
- **Important**: Stripe webhook route (`/api/stripe/webhook`) must receive raw body — registered before `express.json()` in `server/index.js`

### Resend (Email)
- **Wrapper**: `server/utils/email.js` (single send + batch)
- **From**: `Dr. Bartender <no-reply@drbartender.com>`
- **Used for**: Transactional notifications (proposals, OTPs, shifts) + email marketing (blasts, drip sequences)
- **Marketing**: `server/routes/emailMarketing.js` — leads, campaigns, sequences, conversations, analytics
- **Webhooks**: `server/routes/emailMarketingWebhook.js` — receives tracking events (sent/delivered/opened/clicked/bounced/complained), verified via `svix`
- **Scheduler**: `server/utils/emailSequenceScheduler.js` — processes drip sequence steps every 15 minutes
- **Templates**: `server/utils/emailTemplates.js` — `wrapEmail()` for transactional, `wrapMarketingEmail()` for marketing (includes unsubscribe link)

### Twilio (SMS)
- **Wrapper**: `server/utils/sms.js` (includes `normalizePhone()` for E.164 formatting)
- **Used for**: Admin-initiated SMS to staff (general messages, shift invitations), shift approval notifications
- **Consent**: Collected during agreement signing (`sms_consent` flag) — only consented staff appear as eligible recipients
- **Logging**: All outbound messages logged to `sms_messages` table with delivery status tracking

### Thumbtack (Lead Generation)
- **Integration type**: Custom endpoint webhooks (V4 format with legacy fallback)
- **Endpoints**: `server/routes/thumbtack.js` — receives lead, message, and review webhooks
- **Auth**: Shared secret via Basic Auth header or `X-Thumbtack-Secret` custom header (`THUMBTACK_WEBHOOK_SECRET`)
- **Lead flow**: Thumbtack sends lead → webhook creates/matches client (by phone) with `source='thumbtack'` → stores in `thumbtack_leads` → emails admin notification
- **Important**: Thumbtack does NOT include customer email in webhooks. Admin must grab email manually from Thumbtack (lead → three-dot menu → create estimate/invoice) and add it to the client record.
- **Messages**: Customer messages stored in `thumbtack_messages`, admin notified via email
- **Reviews**: Stored in `thumbtack_reviews`, admin notified via email
- **Custom domain**: `api.drbartender.com` CNAME → Render, so Thumbtack endpoints are permanent regardless of hosting changes

### Cloudflare R2 (File Storage)
- **Wrapper**: `server/utils/storage.js`
- **Upload flow**: Validate file (magic bytes) → Upload to R2 bucket → Store key in DB → Generate signed URL (15-min expiry) for downloads
- **Files stored**: W-9, resume, headshot, alcohol certification, BASSET certification
- **Admin access**: `GET /api/files/:filename` redirects to signed URL (admin/manager only)

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

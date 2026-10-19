# Lens audit synthesis: ui-state, copy-content, a11y-design, schema-constraint, logic

Input: 183 defects (ui-state 105, copy-content 50, a11y-design 2, schema-constraint 18, logic 8). Every defect was read. Every id sits under exactly one primary check in its own class, or under "Not anticipable"; ids from another class that the same check would also have caught are listed in parentheses with their class, so the per-check counts below are primary ids only.

Lens key. Existing: security-review, database-review, consistency-check, code-review, ui-ux-review. Proposed:
- NEW:ui-mechanics. Reads client code for state truth (request ordering, state lifetime, async exits, entered-work preservation, listener lifetime, control-to-request wiring, service worker). The current ui-ux-review is a capture lens; 10 of the 14 ui-state checks below are invisible in a capture and none of them is a UIX-* item.
- NEW:copy-truth. Client-facing claims against the source that bills, sends or stores them. No existing lens has a single copy check, and all 50 copy defects are factual drift, not taste.

Reviewer constraint for ui-state: the reviewer cannot sign in to the dev app. Checks 1 to 10 are code-reading (grep the diff and the files it touches). Checks 11 to 13 judge captures and static renders that the dispatcher supplies; the capture contract is stated before check 11. Check 14 is code-reading.

## ui-state (105 defects)

Shape. Almost nothing here is "a loading spinner was missing." The render shows a copy that is no longer the truth (a late response, a reused component instance, a cache or ref not refreshed after a write: 13 defects); an async surface has a state with no exit (7); user-entered work is thrown away by an exit, an error, a re-auth or a save that spreads whole form state (11); the handler is gone or not yet alive when the gesture lands (portals closing on mousedown, anchors unmounted before the OS hand-off, popups after an await, one-shot events in lazy chunks, TwiML prompts outside the Gather: 8); a visibility gate compares against values the producer never emits (9); a link or redirect lands on a surface without the promised control (9); a filter or count never reaches the request or aggregates over the wrong set (6); null is treated as false and stored values outside a control's domain snap or NaN (6); money figures are read from a URL param, a label or one of two columns (7) and destructive controls are bound to labels or positions (3). The capture-visible residue is small: garbage tokens in the render (5), controls that move or sit outside their hit target at 320px (7), and platform traps that desktop captures cannot show at all (8), plus the admin service worker promoting stale or wrong bytes (4). Thirty-seven are money. The fleet found 39 of the 105, Dallas or staff 11, clients 2, prod 2, external reviewers 7; the existing UIX checklist describes none of the mechanisms.

1. **Latest-truth render.** For every read that keys on something that changes (route param, filter, page, stepper value, the row just written), confirm the render can only show the newest truth: a late response is discarded by a sequence token or AbortController, a component that stays mounted across key changes resets its local state on the key (or is keyed on it), and every cached copy of a written entity (list cache, ref, AuthContext user, the derived field a later surface renders) is refetched or invalidated before the next dependent read or save.
   Trigger: a useEffect or handler that awaits a fetch then sets state; a component reused across URLs (same route element, only the param changes); a mutation followed by navigate or close; a ref mirroring state; a save that omits derived fields. There is no shared helper in client/src/utils or client/src/hooks (the guard is re-implemented ad hoc in about 18 files), so grep the diff for `await` followed by a `set[A-Z]` call with no seq or abort check, and for `useParams` in a component whose useState never resets.
   Lens: NEW:ui-mechanics.
   Defects (13): D2770, D2930, D2967, D3031, D3045, D2894 (late response); D3032, D2774 (instance and state lifetime); D2750, D2995, D2949, D2901, D2902 (stale copy after a write).

2. **Every async state has an exit.** Enumerate the states of each async surface in the diff (idle, loading, success, failed, timed out, processing or async-pending) and confirm each non-terminal state has a transition out and each terminal state has a control: loading clears in `finally` (including abort and prop-flip paths), every poll and re-read carries a timeout that lands in a visible "out of date, Refresh" state, a failed state maps to a retry or enable control, a "waiting" flag has a writer that clears it, and an error message is keyed to something that survives the post-submit refresh.
   Trigger: `setLoading(true)` without finally; fetch or axios calls with no timeout or AbortSignal; a status enum where one value is only ever written true; messages keyed by a row id across a refetch; Stripe redirect_status or payment status strings (processing is neither failed nor succeeded).
   Lens: NEW:ui-mechanics.
   Defects (7, plus D2714 under check 14): D2970, D3017, D2993, D3037, D3016, D2943, D2962.

3. **Entered work survives every exit.** For any surface where the user types or selects, list every exit (scrim, Escape, Back, Cancel, a mode switch, a failed submit, a 401 re-auth, a remount via `key=`, an in-flight save that disables inputs, an upload that fails on a phone) and confirm each either keeps the entered state or asks first; a draft restore or a save writes only touched fields over server-loaded ones, never spreads '' or an untouched-checkbox false, and never clears a field the user did not edit.
   Trigger: a form, sheet or editor component in the diff; `navigate(..., { replace: true })` or the session-expired path at client/src/utils/api.js:50; `<Elements key=...>` or any key that changes on error; a draft filter or merge; a submit payload built by spreading whole form state; `disabled={saving}` on sibling inputs; a required upload on a form with no persistence.
   Lens: NEW:ui-mechanics.
   Defects (11): D2972, D2729, D2900, D2903, D2904, D3014, D3050, D2946, D2958, D2899, D2868 (the vanish is unreproduced; the check makes the loss impossible regardless of trigger).

4. **The listener is alive when the input lands.** For every menu, dialog, overlay, anchor, popup and voice prompt in the diff, confirm the thing that handles the gesture still exists at the moment the gesture arrives: outside-click closers ignore events whose composedPath includes the portal root; a menu item unmounts only after its default action (mailto:, tel:, sms: and download anchors need the browser hand-off to complete first); window.open and anchor clicks run synchronously inside the gesture, never after an await; one-shot browser events (beforeinstallprompt) are subscribed in eagerly loaded code; in TwiML, every `<Say>` that invites a keypress sits inside the `<Gather>` that collects it, and a Gather answer acknowledges before `<Dial>`. Verify the TwiML string, not the comment (voiceConsultCall.js:227 says both readings sit inside the Gather while D3081 is still open).
   Trigger: document-level onMouseDown or onClick listeners; createPortal; a modal rendered inside another overlay's React tree; `await` before window.open; addEventListener in a lazy chunk; any file under server/routes/voice*.js that builds `<Gather>`.
   Lens: NEW:ui-mechanics (voice clause; split into its own lens only if the voice surface keeps growing).
   Defects (8): D2722, D2723, D2864, D3029, D3053, D3081, D3082, D3083.

5. **A destructive control is bound to the row's stable id.** Any remove, cancel, refund or pay control in a list resolves its target by the row id (addon id, line item id), never by a label match, a shortest-prefix match or a positional index recomputed on render; two rows that share a label shape (the num_bartenders override row and the additional-bartender add-on) must still resolve to different targets.
   Trigger: client/src/components/PricingBreakdown.js, client/src/pages/admin/proposalEditor/useCancelTargets.js, findIndex, startsWith or includes over display strings, React keys built from labels, a targets array rebuilt after the rows change.
   Lens: code-review (money).
   Row-truth docs: yes, docs/superpowers/specs/2026-07-22-cancel-line-item-design.md (line identity, refund scope).
   Defects (3; all money, one removed the wrong line): D2743, D2744, D2961. Earns its place on money alone: a wrong target here is a wrong refund.

6. **A rendered money figure or payment-state claim traces to the row.** Trace every money figure, "charged or not charged" banner, refund-complete state, override cue and election-origin render in the diff back to its source: it must be the row (acknowledged_total, the total_price snapshot, refunded_cents plus shortfall_cents, the gratuity origin column), never a redirect query param, never an engine recompute shown beside a stored total on the same card, never one of two columns that together make the fact; a sign comes from the value (client/src/utils/formatMoney.js already emits the minus), never a literal prefix; a refund appears once, not as a negative payment row and a refund row.
   Trigger: useSearchParams or location.search feeding copy or a banner; two sources of one total in one component; refunded_cents without shortfall_cents; `'-' + formatMoney(...)`; override or pinned-total flags; invoice row builders in server/routes/invoices.js.
   Lens: code-review (money), with consistency-check for the two-source cases.
   Row-truth docs: yes. acknowledged_total is row truth and the ?paid=true load beats the webhook (docs/superpowers/specs/2026-08-28-post-payment-settle-and-full-pay-invoice-design.md); gratuity origin (docs/superpowers/specs/2026-08-10-admin-gratuity-mandate-design.md).
   Defects (7, plus D0187 from copy-content): D3010, D3002, D2863, D3063, D2973, D3070, D2762.

7. **A visibility gate's value set intersects what the producer emits.** For every gate on a status, flag or count (`=== 'ready'`, `!x`, includes, switch, a hard-coded `editable={false}`, `filled >= needed`), open the producer (the route or payload builder; server/utils/shoppingListGen.js:548 writes pending_review while server/utils/beoFinalize.js:45 reads approved) and list the literal values it emits; the gate must be reachable for at least one emitted value, must not hard-code a view-level constant where row state decides, and a tightening must be run against prod-shaped rows by count (run_sql) before it ships.
   Trigger: a new or changed conditional on a string, enum or flag in JSX; a client that always sends a field the server gates on; a server-side filter that defines "open" as "sendable"; hard-coded editable or readOnly props; a "first cut" that widens a filter.
   Lens: consistency-check (CON-09 and CON-10 check field names; nothing checks value sets).
   Row-truth docs: yes when the gate is a payroll period (completion gate) or BEO finalize (derived, never a required click).
   Defects (9, plus D1801 from schema-constraint): D2760, D3074, D3076, D2704, D3009, D2890, D3071, D3086, D2947.

8. **Every entry point lands on a surface that has the promised control.** For every link, CTA, notification URL, Navigate, redirect or guard target the diff emits (email and SMS templates, server/utils/urls.js builders, getHomePath in client/src/utils/userRoutes.js, route guards), open the target in the state the link promises (paid, confirmed, archived, in an option group, on the staff. or hiring. host) and confirm the promised control renders there; when a surface is retired, grep for every route, link and email that still points at it; trace a redirect chain two hops for a loop; pushState and navigate preserve location.search unless clearing it is the intent.
   Trigger: href, to, navigate, Navigate or pushState in the diff; a deleted route or page; a template link; host-specific routing; a reminder or alert that links into the app.
   Lens: consistency-check.
   Defects (9): D3008, D2938, D3075, D3023, D2998, D2874, D3059, D3060, D2781.

9. **A control's state reaches the request and comes back as the figure.** For every filter chip, range, toggle, legend lock and page control, trace its state into the request params (grep the api call for the param name) and the response back into the rendered number; "cleared" must be distinguishable from "default"; a derived count is computed per group when rows have groups (per role, not filled >= needed overall), dedupes by id, and uses the server's total, not the page length; offset paging over a live list uses a cursor or an id set.
   Trigger: a new query param on the client with no matching read on the server, or the reverse; client/src/hooks/useMetricsFilter.js-style hooks; chips that set state the fetch never reads; groupShiftRows-style aggregations; "Show more" over offset and limit.
   Lens: NEW:ui-mechanics (consistency-check for the param half).
   Row-truth docs: yes for the money dashboards (include_cc and the off-ledger labels).
   Defects (6): D2882, D2780, D2941, D2979, D2928, D2875.

10. **Render against prod-shaped rows, and treat null as its own state.** Before approving a render, pull edge rows with run_sql (null and false for every tri-state column such as proposals.tip_jar at schema.sql:1334, legacy-format strings, values beyond the control's domain such as a guest count above the stepper max, negative fees, empty arrays, post-fetch null) and confirm the component distinguishes "never answered" from "answered no" with strict equality, steps from the stored value rather than snapping to the boundary, and never crashes on null data.
    Trigger: `!row.flag` or `row.flag ? a : b` on a BOOLEAN DEFAULT column; Math.min or Math.max clamps in steppers; parsers of time or duration strings; `.map` on a fetched field with no guard.
    Lens: ui-ux-review (static render) with the grep in NEW:ui-mechanics.
    Defects (6, plus D0459 from logic, D1866 from schema-constraint, D0464 from logic, D0250 from copy-content): D2757, D2876, D3001, D2975, D2768, D3026.

Capture contract for checks 11 to 13: the dispatcher supplies PNGs plus a DOM snapshot (Playwright snapshot or outerHTML) for each surface, at 320x568 and 390x844, in both skins, before and after each state change the diff introduces. scripts/mobile-capture.js today runs a single 390x844 viewport and missed both 320px defects; scripts/dev-signin.js is the dispatcher's sign-in, not the reviewer's. The reviewer judges what it is handed and says which surface or state it was not handed.

11. **Scan every capture and static render for garbage.** Read every visible string in the capture and the DOM snapshot and flag: NaN, undefined, null, [object Object], camelCase keys, raw ids or slugs where a name belongs, literal `**` or `{placeholder}` tokens, developer placeholder text (PHOTO, "upload at sign-up", lorem), empty href or src, and a broken image where a logo or texture belongs (a bare `<img src>` to an auth-required /api endpoint cannot carry the JWT; a /static/ path CRA never emits 404s).
    Trigger: any capture; in code, a value rendered without its label resolver (getEventTypeLabel in server/utils/eventTypes.js, the drink name lookup), a markdown-ish string printed raw, a template string with {tokens} not passed through the interpolator, an img src under /api/.
    Lens: ui-ux-review.
    Defects (5, plus D0184, D0239, D0194, D0191, D0249, D0193, D0198, D0243, D0244 from copy-content): D2761, D2897, D3018, D3033, D3015.

12. **Tap-target integrity at 320x568.** In the before and after captures, diff the bounding box of every control: nothing below a notice, a Saving indicator, a price bar or a focus-driven element may move or disappear when state changes (reserve the space; toggle visibility, not mount); in the DOM snapshot, the visible instruction ("Tap to compare") must be inside the hit element, no `<a>` may contain an `<a>`, and no element's right edge may exceed the viewport width at 320px in either skin.
    Trigger: any phone surface; timers that toggle an element (autosave indicators); onFocus handlers that hide something; notices in a scrolling readout above pinned controls; chips in a bar; EntityLink inside a card link.
    Lens: ui-ux-review.
    Defects (7): D3003, D2730, D2737, D2738, D2989, D3049, D2982.

13. **Grep for the runtime and allowlist traps captures cannot show.** On any CSS or client JS change, grep for: 100vh (use dvh or svh; client/src/index.css still shows 5 mentions against 15 dvh/svh), font-size under 16px on input, select or textarea (iOS focus-zoom), canvas drawing without devicePixelRatio scaling, theme attributes (data-app, data-skin) set after first paint with no :root fallback, file inputs whose accept list excludes what the user base uploads (.docx, .heic), `@media print` blocks that hide by allowlist, Web APIs newer than the iOS floor (structuredClone needs 15.4), SVG filters or data-URI backgrounds inside html2canvas capture regions (WebKit taints the canvas), and any allowlist (sanitizer ALLOWED_ATTR in server/utils/emailSanitize.js, print CSS, SW cache) changed without rendering the richest real artifact through it.
    Trigger: client/src/index.css and any *.css; SignaturePad or canvas code; html2canvas or jsPDF call sites; FileUpload accept props; StaffShell or theme bootstrap; emailSanitize.js; `@media print`.
    Lens: ui-ux-review (a code grep; the capture reviewer cannot see iOS).
    Defects (8, plus D0315 and D0327 from a11y-design): D2800, D2823, D2756, D2838, D3030, D2767, D2732, D3084.

14. **The service worker never promotes stale or wrong bytes.** On any change to client/public/admin-sw.js or client/public/staff-sw.js: the offline shell is written only from a 200 text/html navigation; cache-served reads are opt-in per request (the X-Offline-Ok header from client/src/utils/offlineRead.js), labelled stale on the surface, and never sit under a money or staffing action; notificationclick matches full pathnames with equality or a path boundary, not includes() (staff-sw.js:87 still uses includes; that is the open D2712); every lazy chunk reachable while offline (the password Login path) is in SHELL_CACHE and the offline lock screen has an exit that needs no network.
    Trigger: *-sw.js, SW_VERSION bumps, new lazy routes under the admin or staff shells, new offlineGet callers.
    Lens: NEW:ui-mechanics.
    Defects (4, one money): D2708, D2709, D2712, D2714.

Not anticipable: D2715 (a missing download surface is feature absence, not a wrong behavior a diff check would see); D3066 (clients "believe they chose something different", no mechanism named; needs a session recording, not a checklist).

Placed: 103 under 14 checks, 2 not anticipable.

## copy-content (50 defects)

Shape. Not one of the 50 is wording taste. Copy carries a number, rate or inclusion that lives in a catalog row or an invoice and the two drift (9); copy asserts a system fact (what will be sent, what was charged, when staff arrive, which methods exist, which number to reply to) from a different source than the behavior reads (11); names, labels and ids are derived locally instead of through the canonical resolver, and a sweep that introduced the resolver left copies behind (8); placeholders, raw markdown and fabricated fallbacks reach a reader, with the signing screen and the archived PDF rendered by different parsers (6); contract, compliance and factual-claim text has nothing pinning it, so a mechanical sweep edits it, a required clause or the CAN-SPAM address is missing, and a signing records a document version that exists nowhere (8); copy names an offering the catalog does not carry (4); and a number is printed with the wrong scale, scope or identifier (4). Sixteen are money. Most were found by audit, Dallas or the fleet after shipping; none by a copy check, because no lens has one.

1. **Every price, rate, hour threshold and "included" in client-facing copy renders from the row it bills from.** Any dollar amount, rate, hour threshold or inclusion claim in website, proposal, planner, agreement or admin copy is read from the catalog row (service_addons.rate, extra_hour_rate and minimum_hours, service_packages.*; DOLLARS per the schema.sql:583 comment) or from the proposal snapshot it bills from, and carries the qualifier the pricing engine applies (per_guest_timed, schema.sql:681, is per guest for the first four hours, then extra_hour_rate); grep the diff for `$` literals, "/guest", "includ", hour counts and bartender ranges near a package or add-on name, and compare with run_sql.
   Trigger: client/src/pages/website/*, proposal/otherOptions/*, plan/v2/steps/*, quoteWizard/helpers.js, proposalEditor/repriceSummary.js; any string with a `$` or "included"; a lineup script (server/scripts/applyPackageLineup2026.js) that changes rows without the prose or seed.
   Lens: NEW:copy-truth.
   Row-truth docs: yes (live catalog for new quotes, the frozen snapshot for a sent proposal, proposals money in DOLLARS; the CheckCherry external_paid netting for D0180).
   Defects (9, money 7): D0188, D0190, D0204, D0223, D0205, D0207, D0180, D0221, D0237.

2. **A sentence that asserts a system fact is driven by the same source as the behavior.** For every sentence that tells a reader what the system did or will do (won't send, nothing was charged, arrive N minutes before, accepted methods, not notified, opened or not opened, "use Cancel then Refund", the number to reply to), find the code path that makes it true and cite it; the sentence must read the same variable the behavior reads (the row not the URL; the bartender's actual tip methods not the template's full set; companyPhone.js not a literal; a derived setup minute is not an arrival promise), and an instruction to an admin must name an action that succeeds in that state (Cancel 409s NOT_CANCELLED on an archived booking).
   Trigger: new template text in server/utils/*Templates.js, smsTemplates.js, smsInbound.js, stripePaymentNotifications.js, webhook admin alerts; confirm dialogs (client/src/utils/staffingSheet.js); card builders (client/src/utils/proposalCards.js); tip sign and tip card layouts; any copy that mentions a number, method, time or action.
   Lens: NEW:copy-truth.
   Row-truth docs: yes where the claim is about payment or refund (acknowledged_total; the manual Refund panel versus Cancel).
   Defects (11, money 4): D0209, D0235, D0267, D0268, D0187, D0214, D0213, D0197, D0199, D0244, D0263.

3. **Names, labels and ids go through the canonical resolver, whose tests hold the prod-shaped cases.** Grep the diff and the repo for ad-hoc derivations (`.split(' ')[0]`, `.split(/\s+/)[0]`, first_name fallbacks) and route them through firstNameOf in server/utils/firstName.js; the helper's tests must cover a titled name, a couple stored as one name, a single token and empty; ids and slugs (event_type, catalog ids, selections JSON) pass through their label resolver (getEventTypeLabel, the drink name lookup) before reaching copy, and event_type 'other' with no custom label never prints as "other".
   Trigger: any greeting or subject line; any render of event_type, *_id, slug or selections JSON in an email or page; a sweep that replaces a helper (grep for residual copies after the sweep lands, not before).
   Lens: consistency-check (sweep residuals) and NEW:copy-truth.
   Defects (8): D0240, D0241, D0257, D0260, D0250, D0243, D0191, D0249.

4. **No placeholder, markup or fabricated fallback reaches a reader.** When content is missing, render nothing or an honest empty state: never a dev placeholder string or striped block, never sample testimonials presented as real, never raw markdown markers; the screen a signer sees is rendered by the same parser as the archived PDF (client/src/pages/Agreement.js versus server/utils/agreementPdf.js).
   Trigger: FALLBACK_* constants, "placeholder", "PHOTO", "upload at sign-up" strings; `**` or `{token}` inside clause or template text; two renderers for one document.
   Lens: NEW:copy-truth (ui-state check 11's capture scan is the second net).
   Defects (6): D0184, D0239, D0194, D0193, D0198, D0200.

5. **Contract, compliance and factual-claim text is a pinned artifact.** Any diff touching client/src/data/eventServicesAgreement.js, server/data/contractorAgreement.js, the W9 facsimile or wrapMarketingEmail in server/utils/emailTemplates.js: bump the version constant and the server allowlist (server/utils/agreementVersions.js, CURRENT_AGREEMENT_VERSION and KNOWN_AGREEMENT_VERSIONS), never edit a shipped version, keep the files out of mechanical sweeps (neither agreement file is on the sensitive list today: scripts/sensitive-match.js exits 1 for both), confirm the version string recorded at signing names a document that exists in the repo, confirm every commercial email carries the CAN-SPAM postal address and unsubscribe, confirm both agreements carry the extra-time and private-arrangement liability clauses the business relies on, and require a confirmed source for any number about the business (years, counts).
   Trigger: the files above; emailTemplates.js footers; server/routes/proposals/publicToken.js signing writes; marketing copy with a year or a count; any sweep (em dash, greeting) whose pathspec includes client/src/data or server/data.
   Lens: NEW:copy-truth (compliance clause; security-review may co-own CAN-SPAM).
   Defects (8): D0168, D0169, D0170, D0222, D0224, D0231, D0246, D0219.

6. **Every offering named in copy resolves to a live catalog row.** For each drink, mixer, add-on or service named in copy or a form option, run the SELECT against cocktails, mocktails, service_addons or the mixer source; for drink descriptions, compare the promised build against the recipe rows; brands and varieties do not belong in catalog copy because they go stale.
   Trigger: client/src/components/ShoppingList/ConsultationForm.jsx options, ServicesPage add-on lists, schema.sql seed descriptions, prod data edits to descriptions.
   Lens: NEW:copy-truth.
   Defects (4): D0216, D0162, D0226, D0206.

7. **Scales, units and identifiers render with the schema's domain.** When copy prints a stored number with a scale or scope (a rating out of N, a total "of all tips", an invoice reference), read the column's CHECK from schema.sql (the tip feedback rating is BETWEEN 1 AND 3 at schema.sql:2810) and the human identifier (INV-0003, not the DB id), and render the denominator or scope from that source.
   Trigger: "/ 5", "out of", star ladders, "all", invoice or receipt descriptions sent to Stripe, totals labelled by method.
   Lens: consistency-check.
   Row-truth docs: yes for D0196 (which tips the total counts; off-ledger methods go direct).
   Defects (4): D0248, D0183, D0234, D0196.

Not anticipable: none. Every copy defect in the record is a drift from data, config or a second renderer; none is a judgment call.

Placed: 50 under 7 checks.

## a11y-design (2 defects)

Shape. The class as labelled (contrast, design adherence) has nothing in the record. Both defects are iOS Safari runtime incompatibilities on a client-facing surface, one a prod Sentry incident on the invoice PDF download (a money surface). Either the capture lens catches contrast pre-merge so it never becomes a logged defect, or nobody logs them; either way the evidence says UIX-12 to UIX-17 are not where shipped defects come from, and the reviewer's time belongs on ui-state checks 11 to 13. One check is earned; padding to six would be naming virtues the record never punished.

1. **Check the WebKit floor and canvas taint on every client-facing surface.** For any new Web API or capture-library call in client code, check the API against the iOS floor the client and staff base runs (structuredClone needs 15.4; the same for Array.prototype.at and friends), and keep SVG filters and data-URI backgrounds out of any region html2canvas captures (WebKit taints the canvas and the download throws SecurityError).
   Trigger: html2canvas, jsPDF or toDataURL call sites; new globals in client code; CSS backgrounds inside a captured region.
   Lens: ui-ux-review (folded into ui-state check 13 as its Safari clauses).
   Defects (2; one prod incident on a money surface, and the mechanism sits with eight ui-state platform defects): D0315, D0327.

Not anticipable: none.

## schema-constraint (18 defects)

Shape. The column cannot hold what the code writes (INTEGER for a fractional duration or quantity, VARCHAR(20) for a 23-character literal or an AES-GCM ciphertext, a title-case client option list against a lowercase enum: 5, two of them prod incidents); an updated_at trigger restamps on idle saves and backfills and a consumer that orders by updated_at re-aims a STOP to the wrong staffer (3); a code constant or seed flag mirrors a catalog row and drifts (STAFFING_ADDON_MIN_HOURS, requires_provisioning, num_bars DEFAULT 1: 3); SQL that parses but fails at plan or execute time against the real schema (FOR UPDATE on the nullable side of a LEFT JOIN, an untyped reused parameter, a blind insert into a unique index, ON CONFLICT without the partial-index predicate, a column that never existed: 5, two prod Sentry incidents); and the boot splitter breaking schema.sql on semicolons inside dollar quotes and comments (2, one a prod boot failure). Seven are money and five were prod incidents. The existing database-review checks the schema in the abstract (DAT-01 to DAT-07) and says "find .query() calls" without saying what to do with them.

1. **Compare every written column's type and width against the widest value the code writes.** For each INSERT or UPDATE in the diff, list the columns and read their declared type from schema.sql and from prod (describe_table_schema on the prod branch; dev lacks prod CHECKs): count characters of every string literal and enum value the code writes against VARCHAR(n); confirm anything that can be fractional (durations, half-hour quantities) is NUMERIC, not INTEGER; confirm ciphertext or base64 fits the column; confirm the client's option list equals the server's canonical enum, case included.
   Trigger: INSERT or UPDATE in the diff; a new status or type literal; encryption added to a stored field; a client select or options list for a column with a CHECK.
   Lens: database-review (DAT-04 checks that money is INTEGER; nothing checks width or precision against writes).
   Row-truth docs: no; the rule is the declared column.
   Defects (5; 2 prod, 4 money): D1780, D1815, D1819, D1821, D1801.

2. **An UPDATE on a table with an updated_at trigger writes only when a value changes, and its consumers are traced.** schema.sql carries at least 20 BEFORE UPDATE updated_at triggers (update_contractor_profiles_updated_at at schema.sql:363 among them); any UPDATE, backfill or idle save on those tables is guarded (`WHERE col IS DISTINCT FROM $n`, or skip the write when nothing changed) or documented as restamping; then grep for every consumer that orders by or compares that table's updated_at (server/utils/smsInbound.js orders contractor_profiles by it to route a STOP) and state the effect.
   Trigger: UPDATE on contractor_profiles, users, proposals, shifts or any trigger-bearing table; scripts under server/scripts/*; save handlers that write the whole row.
   Lens: database-review.
   Defects (3; the STOP re-aim is a message-to-the-wrong-person class): D1851, D1869, D1870.

3. **No code constant or seed flag silently mirrors a catalog row.** For every literal in the diff that duplicates a catalog value (STAFFING_ADDON_MIN_HOURS = 4 at server/utils/eventCreation.js:47 mirrors service_addons.minimum_hours; a rate; num_bars DEFAULT 1 read as "has a bar"), either read the row or add the assertion test that fails when the row changes (server/db/provisioningSeed.test.js is the precedent); for a seed flag that gates behavior (requires_provisioning), run the SELECT of rows lacking the flag and name them.
   Trigger: a numeric literal next to a catalog column name; a new service_addons or service_packages row; `> 0` tests on a column with a non-zero DEFAULT; new seed lists.
   Lens: consistency-check (catalog to code).
   Row-truth docs: yes (frozen rates on snapshots versus the live catalog for new events).
   Defects (3, plus D0188, D0223, D0237, D0226 from copy-content): D1841, D1873, D1866.

4. **Execute every new or edited SQL string once against the real schema with prod-shaped arguments before merge.** Run it in a rolled-back transaction on dev (EXPLAIN is not enough for FOR UPDATE and ON CONFLICT), checking specifically: FOR UPDATE with an outer join (use FOR UPDATE OF the inner table), a parameter used both typed and untyped (cast it everywhere it appears in a CASE), INSERT ... ON CONFLICT against a partial unique index (restate the WHERE predicate), a blind INSERT into a column with a unique index (select first, or ON CONFLICT DO UPDATE), and every column name against schema.sql (shifts.archived_at never existed).
   Trigger: any `.query(` string change; a refactor that moves a parameter; a new ON CONFLICT; a SELECT list edited by hand; a lookup table keyed by entity type.
   Lens: database-review (DAT-08 and DAT-09 say "find .query() calls" and nothing about what to run).
   Defects (5; 2 prod Sentry incidents, 1 money): D1854, D1860, D1862, D1868, D1877.

5. **Run schema.sql additions through the boot splitter.** For any addition containing a function body, a DO block, a comment or string with a semicolon, or a dollar-quoted tag, run splitStatements (exported from server/db/index.js) over the file and compare the statement count and the last statement's text with the intent; use tags the splitter closes exactly ($body$ closes only on $body$).
   Trigger: a schema.sql diff containing `$$`, `$tag$`, `--`, `/*` or a `;` inside quotes.
   Lens: database-review.
   Defects (2; D1805 was a prod boot failure): D1804, D1805.

Not anticipable: none. No dev-versus-prod drift defect sits in this input; the prod probe (describe_table_schema on the prod branch) stays a step inside checks 1 and 4 rather than a check of its own.

Placed: 18 under 5 checks. Five is under the brief's six-to-fourteen; the record earns five.

## logic (8 defects)

Shape. Five are lookups over the wrong domain: a pairing search over an already-filtered slice, the cocktails table queried for a mocktail, substring alias matching, a geocode guard that fires only when every field is empty, and a maps link fed the display string instead of the street. One is null surviving arithmetic as zero and hiding about $1,160 of import rows. One is the process itself: no SIGTERM drain, so every deploy severed webhook handlers mid-transaction. One is undescribed.

1. **A lookup's domain is the full source, the right table, and anchored matching.** For every find, filter, alias match, table query or geocode call in the diff, confirm the search domain is the unfiltered source (not a slice already narrowed by another flag such as in_full_bar), the table matches the entity kind (mocktails are not in cocktails), substring or alias matching is anchored or token-bounded with the longest alias first, and an address lookup receives the structured street fields, never the display string with the venue name in front; a "nothing to look up" guard fires when the field that matters is empty, not only when all fields are.
   Trigger: server/utils/shoppingList.js, server/utils/venueAddress.js, INGREDIENT_MAP-style alias tables, any `.includes(` over names, Maps or geocode URL builders.
   Lens: code-review.
   Defects (5): D0454, D0462, D0463, D0464, D0465.

2. **Null never passes through arithmetic as zero.** This is ui-state check 10 applied server-side: any comparison or Math call on a value that can be null (Math.abs(null) === 0, null >= x, null - x) tests for null first, and the null row is in the fixture.
   Trigger: Math.abs, Math.min or Math.max and numeric comparisons on fields from LEFT JOINs or optional inputs; import matchers under server/scripts/staffPaymentImport/.
   Lens: code-review.
   Row-truth docs: yes for imports (read the import file first; the staff pay import rules).
   Defects (1 here, money, about $1,160 hidden; plus D2757, D2876, D3001 from ui-state): D0459.

3. **The server drains on SIGTERM.** server/index.js handles SIGTERM: stop accepting, let in-flight requests (webhook handlers mid-transaction) finish within the platform's grace window, then close the pool; any change to process lifecycle or deploy config re-checks it.
   Trigger: server/index.js, render.yaml, pool shutdown code, anything that adds a long-running request.
   Lens: code-review (one defect, but every deploy hit it and webhook transactions are money).
   Defects (1): D0455.

Not anticipable: D0460 (undescribed; the memory records an autoAssign money bug caught by a non-Claude model and no mechanism).

Placed: 7 under 3 checks, 1 not anticipable.

## Cross-class notes

- One meta-mechanism spans four classes: execute or render against prod-shaped rows (null and false tri-states, legacy formats, out-of-domain values, titled and couple names, defaulted columns such as num_bars = 1, venues with no street). ui-state 10, copy 3, schema 3 and 4, and logic 2 all reduce to "the fixture was the happy row."
- The sensitive list (scripts/sensitive-match.js) does not carry client/src/data/eventServicesAgreement.js, server/data/contractorAgreement.js, client/src/pages/website/ServicesPage.js or client/src/components/PricingBreakdown.js (exit 1), while server/utils/emailTemplates.js, client/public/admin-sw.js and server/db/schema.sql are on it (exit 0). The contract text and the money breakdown component are the two files these classes punished most.
- No shared latest-request helper exists in the client; the stale-response guard is re-implemented in about 18 files, which is why ui-state check 1 has 13 defects behind it.

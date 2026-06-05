# Event Services Agreement — Document Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-written "abridged" terms block on the public proposal with the real, lawyer-drafted master Event Services Agreement, rendered in full and wired into the existing sign-and-pay flow, with the recorded `client_signature_document_version` provably matching the exact text the client saw.

**Architecture:** The agreement lives as a versioned, bundled JS data module on the client (`eventServicesAgreement.js`) so it is always present at signing with no separate fetch that could 404. A tiny dependency-free markdown-lite renderer (`AgreementText.js`) parses a fixed subset into React elements (no `dangerouslySetInnerHTML`). The client sends the version string it rendered with the sign POST; the server validates it against an allowlist (`agreementVersions.js`) and records exactly that value. No backfill of existing `v2` rows; `v2` stays in the allowlist permanently as the abridged-block record.

**Tech Stack:** React 18 (CRA), vanilla CSS, Express 4, raw `pg` SQL, `@sentry/node`, `@testing-library/react` (jest via react-scripts), `node:test` for server route tests.

**Source spec:** `docs/superpowers/specs/2026-06-04-event-services-agreement-integration-design.md`

**Authoritative agreement text:** `Dr_Bartender_Agreement_REDRAFT.docx` (legal source of truth). Faithful text proxy committed at `.claude/_contract_extract.txt`. Transcription must be verbatim; Task 7 is the verification gate.

---

## File Structure

**New files:**
- `client/src/data/eventServicesAgreement.js` — versioned agreement source (data only, no logic).
- `client/src/pages/proposal/proposalView/AgreementText.js` — markdown-lite → React renderer (pure component).
- `client/src/pages/proposal/proposalView/AgreementText.test.js` — renderer unit + out-of-subset + figure-snapshot tests.
- `server/utils/agreementVersions.js` — version allowlist + current/legacy constants.
- `server/routes/proposals/publicToken.test.js` — sign-version recording tests (route-level, mirrors `crud.test.js` harness).

**Edited files:**
- `client/src/pages/proposal/proposalView/styles.js` — add one `agreementHeading` style key.
- `client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js` — swap the hardcoded block for `<AgreementText>`, retitle the `<h2>`, remove the acceptance line.
- `client/src/pages/proposal/proposalView/SignAndPaySection.js` — acceptance microcopy by the signature pad; `payOnly` reference line.
- `client/src/pages/proposal/proposalView/ProposalView.js` — send `document_version` in the sign POST; pass `clientSignedAt` to the `payOnly` section.
- `client/src/index.css` — raise `.proposal-terms-scroll.is-expanded` max-height (one rule).
- `server/routes/proposals/publicToken.js` — use `agreementVersions`; validate + record the client-sent version per §4.4.
- `README.md`, `ARCHITECTURE.md` — folder tree + proposal-flow doc updates.

**Optional file (Task 6 — Suggestion 12):**
- `client/src/pages/admin/ProposalDetail.js` — display the recorded version + signed date. No route change needed (`crud.js:355` already `SELECT p.*`).

**Commit grouping (one commit per logical feature, per CLAUDE.md):**
- Task 1 → commit (agreement source).
- Task 2 → commit (renderer + style).
- Task 3 → commit (view integration + CSS).
- Task 4 → commit (acceptance flow).
- Task 5 → commit (version recording mechanism: allowlist + client send + server validate/record + test).
- Task 6 → commit (optional admin display).
- Task 7 → verification only (commit only if a fix is needed).

**Deploy order (required at merge/push, per spec §4.4):** ship the **server first** (knows `v3`, handles the field), then the client (starts sending `v3`). During the in-between window the old client omits the field → recorded as `v2`, which matches the abridged text it still shows. This is a push-sequencing note, not a build-order constraint; build all tasks in the order below.

---

### Task 1: Agreement source module

**Files:**
- Create: `client/src/data/eventServicesAgreement.js`
- Modify: `README.md` (folder-structure tree, the `client/src/data/` line)

> The `markdown` body below is transcribed from `.claude/_contract_extract.txt` (the faithful proxy) into the renderer's subset (`## headings`, `**bold**` sub-clause lead-ins, `-` bullets, blank-line-separated paragraphs, each clause on one line). It is a complete artifact, **not** a placeholder — but it is **not yet the verbatim merge gate**. Task 7 diffs it against `Dr_Bartender_Agreement_REDRAFT.docx` and signs off. Preserve the curly quotes/apostrophes exactly as written.

- [ ] **Step 1: Create the data module with the full agreement**

Create `client/src/data/eventServicesAgreement.js`:

```js
// Master Event Services Agreement — the client-facing legal document presented
// at sign-and-pay. Data only, no logic. Editing the agreement = edit the prose
// below and bump `version`; swapping = replace the `markdown` block and bump
// `version`. The bundled JS module (not a fetched .md) guarantees the text is
// always present at signing with no separate request that could 404 mid-payment.
//
// `version` MUST stay in lockstep with the server allowlist:
//   server/utils/agreementVersions.js -> CURRENT_AGREEMENT_VERSION.
// The sign POST sends this `version`; the server validates it against that
// allowlist and records it as client_signature_document_version. Bump both.
//
// Rendered by client/src/pages/proposal/proposalView/AgreementText.js — keep the
// markdown within that renderer's subset (## headings, **bold**, - bullets,
// blank-line-separated paragraphs). Verbatim source: Dr_Bartender_Agreement_REDRAFT.docx.
export const EVENT_SERVICES_AGREEMENT = {
  version: 'event-services-agreement-v3',
  revisedDate: '2026-06-04',
  markdown: `## 1. Scope of Services

**1.1 Services.** Dr. Bartender will provide professional mobile bartending services (the “Services”) for the event described in the Event-Specific Agreement (the “Event”). The Services include, as specified in the Event-Specific Agreement: (a) the agreed number of certified bartenders and support staff; (b) setup, service, and breakdown within the contracted service window; (c) mixers, ice, garnishes, glassware or disposable cups, bar tools, and bar setup as detailed in the Event-Specific Agreement; (d) verification of legal drinking age and refusal of service consistent with applicable law; and (e) removal of Dr. Bartender’s equipment and trash from the bar area.

**1.2 Exclusions.** Unless expressly included in the Event-Specific Agreement, the Services do not include alcohol, additional tables or linens, generators or extension cords, special-use permits, one-day liquor licenses, dishware service, or food service.

**1.3 Event-Specific Agreement.** “Event-Specific Agreement” means a written booking proposal, order form, or statement of work signed by both Parties that describes a specific Event — including date, location, guest count, service window, package selection, line-item pricing, retainer, balance due date, and any event-specific terms. On signing, each Event-Specific Agreement is incorporated into and governed by this Agreement and is a separate contract for that Event. If a term of an Event-Specific Agreement conflicts with this Agreement, this Agreement controls unless the Event-Specific Agreement expressly states that it overrides a specific section of this Agreement and identifies that section by number.

**1.4 Staff Certifications.** Dr. Bartender represents that the bartenders assigned to the Event will hold the alcohol-service certifications required by the jurisdiction in which the Services are performed, including BASSET (Illinois), a municipal Operator’s License (Wisconsin), an Employee Permit and ServSafe Alcohol or equivalent (Indiana), and TIPS or ServSafe Alcohol (Michigan). Proof of certification is available on request.

## 2. Payment Terms

**2.1 Retainer.** A retainer in the amount stated in the Event-Specific Agreement is due on signing. The retainer reserves the Event date and is applied to the Event balance. The retainer is non-refundable except as Section 3.3 (Dr. Bartender Cancellation) or Section 11 (Force Majeure) provides. The Parties agree that the retainer is a reasonable pre-estimate of the costs Dr. Bartender incurs in reserving the date and turning away other bookings, and not a penalty.

**2.2 Final Balance.** The final balance is due fourteen (14) days before the Event date unless a different date is stated in the Event-Specific Agreement.

**2.3 Accepted Methods.** Dr. Bartender accepts payment by ACH, credit card, check made payable to Dr. Bartender, LLC, and the following digital payment methods: Google Pay, Apple Pay, Amazon Pay, Cash App, Venmo, and Zelle. Credit-card and other processed payments are subject to a processing surcharge as stated in the Event-Specific Agreement.

**2.4 Non-Payment.** Dr. Bartender does not charge late-payment interest. If the final balance is not received by the due date stated in Section 2.2 or in the Event-Specific Agreement, Dr. Bartender may suspend or decline to perform the Services and may treat the failure to pay as a Client cancellation under Section 3.1 effective on the due date. Suspension or non-performance under this Section does not relieve the Client of amounts due under Section 3.

**2.5 Returned Payments and Chargebacks.** Returned checks or reversed payments incur a $35 fee. Dr. Bartender will contest unjustified credit-card chargebacks, and the Client remains liable for the disputed amount, the chargeback fee, and reasonable collection costs.

## 3. Cancellation, Postponement, and Reschedule

**3.1 Client Cancellation.** Cancellation must be in writing. Cancellation fees are determined by the number of calendar days between the date of written notice and the Event date, as set out below. The Parties agree these amounts are a reasonable pre-estimate of the harm Dr. Bartender would suffer from a cancellation at the stated point before the Event — reflecting lost booking opportunity, committed staff, and incurred costs — and are liquidated damages, not a penalty.

- **More than 14 days before the Event.** The Client forfeits the retainer. If the Client has paid amounts in excess of the retainer, Dr. Bartender will refund the excess, less a 5% processing fee, within fifteen (15) business days. Dr. Bartender will not invoice or collect any portion of the contract balance not already paid.
- **14 days or fewer before the Event.** 100% of the contract total is due. Amounts already paid are non-refundable, and any unpaid balance remains due.

**3.2 Postponement / Reschedule.** With at least sixty (60) days’ written notice, the Client may reschedule the Event to a mutually agreeable date within twelve (12) months, subject to Dr. Bartender’s availability, without forfeiting amounts already paid. A rebooking administrative fee as stated in the Event-Specific Agreement applies to reschedules with less than 60 days’ notice. Rates may be re-quoted if the new date is in a different calendar year, a different season, or a peak weekend. If no mutually agreeable date can be set within twelve (12) months, Section 3.1 applies based on the original Event date.

**3.3 Dr. Bartender Cancellation.** If Dr. Bartender cancels for any reason other than the Client’s material breach or a Force Majeure Event (Section 11), Dr. Bartender will (a) refund all amounts paid by the Client, including the retainer, and (b) use commercially reasonable efforts to identify a qualified replacement vendor at the Client’s option.

**3.4 Force Majeure Cancellation.** Cancellation due to a Force Majeure Event is governed by Section 11, not this Section 3.

## 4. Dr. Bartender’s Duties

Dr. Bartender will: (a) perform the Services professionally, safely, and in accordance with applicable law; (b) staff the Event in accordance with the Event-Specific Agreement and Dr. Bartender’s standard staffing ratios; (c) maintain the certifications referenced in Section 1.4 and the insurance required by Section 9; (d) act as the sole provider of bartending services at the Event, unless the Parties otherwise agree in writing; and (e) leave the bar area in substantially the condition in which it was found, ordinary use excepted.

## 5. Client’s Duties

The Client will:

**5.1 Payment.** Pay all amounts due under the Event-Specific Agreement on time.

**5.2 Final Guest Count.** Provide a final guest count in writing no later than fourteen (14) days before the Event. If a final count is not provided by the deadline, the guest count stated in the Event-Specific Agreement is final. Downward changes after the deadline do not reduce the contract total below 85% of the signed proposal. Upward changes of less than 10% are billed at the per-guest add-on rate stated in the Event-Specific Agreement; upward changes of 10% or more require adding staff at the contracted per-bartender rate, subject to Dr. Bartender’s staff availability.

**5.3 Bar Setup Area.** Provide a level, dry working area of at least 6 ft x 6 ft per bar, with reasonable clearance behind the bar for staff movement. Power and water are not required. The Client will also provide, at no cost to Dr. Bartender:

- **Adequate task lighting at the bar position** — sufficient for staff to safely handle glassware, read drink orders, verify identification, and pour accurately. If ambient lighting is unworkably dim at any point during the service window, the Client will supplement it (lamps, string lighting, work lights, or repositioning to an adequately lit area).
- **Protection from the elements** for the bar position and staff for the duration of the service window, as follows:
- **Cold (ambient temperature below 50°F).** An indoor location, an enclosed structure (e.g., a tent), or a sheltered area with active heating sufficient to keep the bar area above 50°F.
- **Sun.** Shade from an umbrella, tent, awning, or indoor placement. Direct sun on the bar position is not acceptable for sustained service.
- **Rain or precipitation.** A covered, dry structure (tent, pavilion, awning, or indoor placement) with sides as needed to keep the bar area dry.

If any condition in this Section 5.3 is not in place when staff arrive, Dr. Bartender’s lead bartender will identify the deficiency to the Client’s designated point of contact (Section 5.7) and allow a reasonable time to remedy it. If the deficiency is weather-related, Sections 7.5 (Weather Suspension) and 11 (Force Majeure) govern. If the deficiency is not weather-related and the Client does not remedy it within a reasonable time, Dr. Bartender may suspend or decline service; the suspension is treated as Client-caused, and the Client is not entitled to a refund, fee reduction, or extension of the service window.

**5.4 Permits and Licenses.** Obtain any one-day liquor license, special-use permit, or venue permission required for alcohol service at the Event location, unless the Event-Specific Agreement states that Dr. Bartender will obtain a specific permit on the Client’s behalf.

**5.5 Alcohol Decision and Quantity.** Indicate in the Event-Specific Agreement whether Dr. Bartender or the Client will supply the alcohol. If the Client supplies the alcohol, Section 6 applies.

**5.6 Safe Transportation.** Make reasonable arrangements for guests to depart safely, including coordinating ride-shares, designated drivers, or shuttle service as appropriate.

**5.7 Communications.** Designate a single point of contact at the Event with authority to approve overtime, on-site changes, and addenda.

## 6. Alcohol — Supplied vs. Client-Provided (BYOB)

**6.1 Dr. Bartender-Supplied Alcohol.** Where the Event-Specific Agreement specifies that Dr. Bartender will supply alcohol, Dr. Bartender will purchase the agreed beverages in the agreed quantities. Unused, unopened alcohol becomes Dr. Bartender’s property unless the Event-Specific Agreement states otherwise.

**6.2 Client-Supplied Alcohol (BYOB).** Where the Client supplies the alcohol, the Client: (a) is the legal purchaser, owner, and host of the alcohol; (b) warrants compliance with all applicable alcohol-control laws of the jurisdiction where the Event is held, including obtaining any required host-event or one-day license; (c) is solely responsible for the quality, quantity, condition, and timely delivery of the alcohol to the venue; (d) acknowledges that Dr. Bartender provides bar service only and does not sell, furnish, or own the alcohol; and (e) indemnifies Dr. Bartender to the extent set forth in Section 10 for claims arising from the Client’s supply, ownership, or instruction regarding the alcohol.

**6.3 Quantity Advisory.** On request, Dr. Bartender will provide a non-binding recommended quantity sheet based on guest count and service hours. The Client is solely responsible for the actual purchase decision. If Client-supplied alcohol runs out during the Event, Dr. Bartender will notify the Client’s designated point of contact and is not obligated to procure additional alcohol; Services will continue with available product or be suspended, with no refund, fee reduction, or extension of the service window.

**6.4 Host Liability Insurance.** For BYOB Events, the Client is encouraged (and where the venue requires, must arrange) host liquor liability coverage through the Client’s homeowner’s, event, or commercial policy.

## 7. Service Standards and Refusal of Service

**7.1 Age Verification.** Dr. Bartender will check identification and serve alcohol only to guests of legal drinking age who present valid government-issued identification.

**7.2 Right to Refuse Service.** Dr. Bartender’s staff retain absolute and final authority to refuse service to any guest who appears intoxicated, is unable or unwilling to present valid identification, is disorderly, or whose continued service would, in the bartender’s reasonable judgment, present a safety or legal risk. The Client agrees not to direct or pressure staff to override this discretion.

**7.3 Drink Limits.** Where the Event-Specific Agreement provides an “all-inclusive” or “open bar” package, the package does not entitle any guest to unlimited service. Reasonable limits may be applied for safety.

**7.4 Service Wind-Down.** Bar service follows a layered wind-down rather than a hard last call, designed to feel hospitable rather than abrupt:

- **Thirty (30) minutes before the contracted end of service.** Staff begin a soft breakdown — washing tools, consolidating garnishes, and wiping down surfaces guests do not typically see. The bar remains fully open and no announcement is made.
- **Fifteen (15) minutes before the contracted end of service.** The lead bartender quietly notifies the Client’s designated point of contact (Section 5.7) that the bar will close in approximately fifteen (15) minutes, and may pass through the room to offer guests a final drink. No bell, no public announcement.
- **End of the contracted service window.** The bar closes. If the Client supplied the alcohol (Section 6.2), any unopened or remaining alcohol is returned to the Client. Glassware collection begins. Where contracted, water and non-alcoholic mixers may remain available. After the bar closes, staff do not pour or serve, and the Client and its guests are solely responsible for any self-service that occurs after closing, including compliance with applicable law.

The Client may request a different wind-down structure (e.g., a hard close with an announced last call, or no wind-down at all) by stating the preferred structure in the Event-Specific Agreement.

**7.5 Outdoor Events and Weather Suspension.** For outdoor Events, the Client will designate in writing at least fourteen (14) days before the Event a covered or indoor backup location (“Plan B”) and will activate Plan B if weather conditions threaten safe service. Dr. Bartender’s staff retain authority to pause or suspend service for the safety of staff or guests when, in the on-site lead bartender’s reasonable judgment, conditions are unsafe — including lightning within ten (10) miles, sustained winds over 25 mph, ambient temperatures below 40°F or above 95°F, or wet or unstable footing at the bar position. Time lost to a safety suspension is not added back to the service window and does not entitle the Client to a refund or credit, except as Section 11 may apply.

## 8. Overtime, Travel, Gratuity, and Property

**8.1 Overtime / Additional Time.** “Additional Time” is service rendered beyond the contracted end of the service window. Additional Time is billed at Dr. Bartender’s standard rate of $100 per hour for the lead bartender plus $40 per hour for each additional bartender on-site, pro-rated in 30-minute increments. The Parties may arrange Additional Time in advance by written addendum, or the Client may request it on-site during the Event; on-site requests are at the sole discretion of the staff working the Event and may be declined based on staff availability, fatigue, or any legal cutoff for alcohol service in the Event jurisdiction. Charges for Additional Time are added to the final invoice and payable on the terms stated in Section 2.

**8.2 Travel.** No travel fee applies. Dr. Bartender staffs Events with local certified bartenders in the Event jurisdiction whenever practicable, and the standard pricing in the Event-Specific Agreement includes travel for staff. If unusual circumstances require travel-related reimbursement (e.g., destination Events requiring overnight lodging), Dr. Bartender will state any such fees as a separate line item in the Event-Specific Agreement and the Parties will agree to them in writing in advance.

**8.3 Gratuity.** Unless the Event-Specific Agreement states otherwise, a tip jar is permitted at the bar and no separate gratuity line is added to the invoice. If the Client elects in the Event-Specific Agreement that no tip jar be present, then a service gratuity of $50 per bartender per hour is included as a line item in the Event-Specific Agreement total. All gratuity received — whether by tip jar or as a contract line item — is distributed to event staff and is not retained by Dr. Bartender.

**8.4 Property Damage.** The Client is responsible for the repair or replacement cost (at fair market value) of Dr. Bartender-owned equipment damaged at the Event by the Client, guests, or attendees, supported by an itemized invoice provided within seven (7) business days of the Event. Damage caused by the negligence of Dr. Bartender’s staff is Dr. Bartender’s responsibility, subject to Sections 10 and 12. For Events held at private residences, the Event-Specific Agreement may require a refundable damage deposit as stated therein.

## 9. Insurance

**9.1 Coverage.** Dr. Bartender maintains liquor liability insurance with limits of not less than $1,000,000 per occurrence and $2,000,000 aggregate, and commercial general liability insurance with limits of not less than $1,000,000 per occurrence. A certificate of insurance is available on request.

**9.2 Additional Insured.** On reasonable advance written request, Dr. Bartender will name the venue or the Client as an additional insured for the Event at no additional cost, subject to carrier requirements.

## 10. Indemnification

**10.1 By Dr. Bartender.** Dr. Bartender will defend, indemnify, and hold harmless the Client and the Client’s officers, employees, and agents from and against any third-party claims, damages, losses, liabilities, costs, and reasonable attorneys’ fees arising out of or relating to (a) the negligent acts or willful misconduct of Dr. Bartender’s staff in performing the Services; (b) Dr. Bartender’s material breach of this Agreement; or (c) Dr. Bartender’s failure to satisfy the tax, withholding, workers’ compensation, unemployment, and benefits obligations described in Section 14 — in each case excluding any portion of the claim caused by the Client, the venue, guests, or other third parties.

**10.2 By Client.** The Client will defend, indemnify, and hold harmless Dr. Bartender and its members, officers, employees, and subcontractors from and against any third-party claims, damages, losses, liabilities, costs, and reasonable attorneys’ fees arising out of or relating to (a) acts or omissions of guests, attendees, or other invitees of the Client; (b) Client-supplied alcohol (Section 6), the Client’s quantity or selection decisions, or the Client’s instruction to continue service to a guest; (c) the venue or premises conditions; (d) the Client’s breach of its representations or warranties in this Agreement; or (e) the Client’s willful conduct, negligence, or violation of law.

**10.3 Procedure.** The Party seeking indemnification (the “Indemnified Party”) will (a) give the other Party (the “Indemnifying Party”) prompt written notice of the claim, provided that delay excuses the Indemnifying Party only to the extent of actual prejudice; (b) allow the Indemnifying Party to control the defense and settlement with counsel reasonably acceptable to the Indemnified Party; and (c) reasonably cooperate at the Indemnifying Party’s expense. The Indemnifying Party may not settle any claim in a way that admits the Indemnified Party’s liability, imposes non-monetary obligations on the Indemnified Party, or fails to fully release the Indemnified Party, without the Indemnified Party’s prior written consent.

**10.4 Carve-Outs.** Nothing in this Section 10 requires either Party to indemnify the other for the gross negligence, willful misconduct, fraud, or criminal acts of the indemnified Party, or for punitive damages where applicable law prohibits indemnification.

**10.5 Survival.** This Section 10 survives termination or expiration of this Agreement.

## 11. Force Majeure

**11.1 Definition.** “Force Majeure Event” means any event beyond the reasonable control of the affected Party, including acts of God; fire, flood, severe weather, earthquake, hurricane, tornado; war, invasion, hostilities, terrorism, sabotage; civil unrest, riots, insurrection; pandemic, epidemic, public health emergency, quarantine, and government health orders or orders restricting gatherings or travel; strikes or labor disputes; utility, power, or internet failures; cyberattack; and changes in law that make performance illegal. Economic hardship and market conditions are not Force Majeure Events.

**11.2 Effect.** Neither Party is liable for any failure or delay in performance to the extent caused by a Force Majeure Event, provided the affected Party gives written notice to the other Party within ten (10) days of becoming aware of the event and uses commercially reasonable efforts to mitigate and to resume performance.

**11.3 Reschedule or Refund.** If a Force Majeure Event prevents the Event from occurring on the contracted date, the Parties will use commercially reasonable efforts to reschedule to a mutually agreeable date within twelve (12) months, and amounts already paid will be applied to the rescheduled date. If rescheduling within that period is not possible, Dr. Bartender will refund all amounts paid less documented, non-recoverable costs actually incurred (e.g., perishable goods purchased, non-refundable supplier deposits). The retainer is applied — not retained as a cancellation fee — under this Section 11.3.

**11.4 Payment Obligations.** Force Majeure does not excuse payment obligations that accrued before the Force Majeure Event.

## 12. Limitation of Liability

**12.1 Excluded Claims Defined.** “Excluded Claims” means liability arising from (a) the gross negligence, willful misconduct, or fraud of a Party; (b) the indemnification obligations in Section 10; or (c) the Client’s payment obligations.

**12.2 Exclusion of Indirect Damages.** Except for the Excluded Claims, in no event will either Party be liable for any indirect, incidental, consequential, special, exemplary, or punitive damages, including lost profits or lost revenue, even if advised of the possibility.

**12.3 Cap.** Except for the Excluded Claims, each Party’s aggregate liability arising out of or relating to this Agreement and any Event-Specific Agreement is capped at the total fees paid by the Client to Dr. Bartender under the applicable Event-Specific Agreement; provided that this cap does not limit the amount recoverable under Dr. Bartender’s liability insurance maintained under Section 9.

## 13. Photography and Social Media

**13.1 Consent.** Unless the Client opts out in writing in the Event-Specific Agreement, the Client consents to Dr. Bartender photographing or recording the bar area, signature drinks, and general event ambiance for use in Dr. Bartender’s portfolio, website, and social media. Dr. Bartender will not identify the Client or guests by name without permission and will use reasonable care to avoid close-up images of identifiable individuals where requested.

**13.2 Copies.** On request, Dr. Bartender will provide the Client with copies of photographs taken at the Event.

## 14. Relationship of the Parties

Dr. Bartender is an independent contractor. Nothing in this Agreement creates an employment, partnership, joint venture, agency, or franchise relationship. Dr. Bartender controls the manner, means, and methods of performing the Services. Neither Party has authority to bind the other or to incur any obligation on the other’s behalf. Dr. Bartender is solely responsible for all federal, state, and local taxes, withholdings, workers’ compensation, unemployment insurance, and benefits applicable to its personnel; Dr. Bartender’s indemnity for any failure to satisfy these obligations is set out in Section 10.1(c). Dr. Bartender’s personnel are not eligible for any benefits the Client provides to its employees.

## 15. Governing Law, Venue, and Dispute Resolution

**15.1 Governing Law.** This Agreement is governed by the laws of the State of Illinois, without regard to its conflict-of-law principles.

**15.2 Informal Resolution and Mediation.** Before either Party files suit, the Parties will attempt to resolve the dispute through good-faith negotiation for thirty (30) days following written notice of the dispute. If unresolved, the Parties will participate in non-binding mediation administered by a mutually agreed mediator before initiating litigation, except for actions seeking injunctive relief or collection of undisputed amounts.

**15.3 Venue.** The Parties consent to exclusive venue and personal jurisdiction in the state and federal courts located in Winnebago County, Illinois; provided that where the mandatory venue rules of the state in which the Services were performed apply to a claim initiated by the Client, venue will lie in the county of the venue, and Illinois substantive law will continue to govern to the extent permitted by that state’s law.

**15.4 Jury Trial Waiver.** To the maximum extent permitted by the law of the forum in which an action is brought, each Party knowingly and voluntarily waives any right to a jury trial in any action arising out of or relating to this Agreement.

**15.5 Prevailing Party.** In any action to enforce this Agreement, the prevailing Party is entitled to recover its reasonable attorneys’ fees and costs.

## 16. Notices

All notices under this Agreement must be in writing and delivered to the addresses set forth in the Event-Specific Agreement by (a) personal delivery (deemed received on delivery); (b) overnight courier (deemed received one business day after deposit); (c) certified U.S. mail, return receipt requested (deemed received three business days after deposit); or (d) email (deemed received on confirmation of receipt), provided that any notice of breach, termination, or indemnification must also be sent by one of methods (a)–(c). A Party may change its notice address by notice given in accordance with this Section.

## 17. Term and Termination

**17.1 Term.** This Agreement begins on the Effective Date and continues until terminated under this Section. Each Event-Specific Agreement remains in effect until the Services for that Event are completed or that Event-Specific Agreement is terminated under this Section.

**17.2 Termination for Material Breach.** Either Party may terminate this Agreement or any Event-Specific Agreement if the other Party materially breaches it and does not cure the breach within ten (10) days after receiving written notice describing the breach, except that a failure to pay may be terminated on the shorter notice provided in Sections 2 and 3. A “material breach” includes the Client’s failure to pay amounts when due and either Party’s failure to perform a material obligation under this Agreement.

**17.3 Effect of Termination.** Termination does not affect any amounts that accrued before termination or any cancellation fee due under Section 3. The consequences of a Client cancellation are governed by Section 3.1, and the consequences of a Dr. Bartender cancellation are governed by Section 3.3.

**17.4 Survival.** Sections 2.5, 8.4, 10, 12, 13, 14, 15, 16, this Section 17.4, and 18 through 23, together with any payment obligation that accrued before termination, survive the termination or expiration of this Agreement.

## 18. Assignment

Neither Party may assign or transfer this Agreement or any Event-Specific Agreement, by operation of law or otherwise, without the other Party’s prior written consent (not to be unreasonably withheld), except that Dr. Bartender may assign without consent to an affiliate or to a successor in connection with a merger, consolidation, reorganization, or sale of all or substantially all of its assets, provided the successor assumes all obligations in writing. Any attempted assignment in violation of this Section is void. This Agreement binds and benefits the Parties and their permitted successors and assigns.

## 19. Severability

If any provision of this Agreement is held invalid, illegal, or unenforceable by a court of competent jurisdiction, the remaining provisions remain in full force and effect, and the invalid provision will be modified to the minimum extent necessary to render it enforceable while preserving the Parties’ intent.

## 20. Waiver

No waiver of any provision of this Agreement is effective unless in writing and signed by the Party against whom enforcement is sought. No failure or delay in exercising any right or remedy is a waiver of that or any other right or remedy, and a waiver of any breach is not a waiver of any subsequent breach.

## 21. Entire Agreement; Amendment

This Agreement, together with each fully executed Event-Specific Agreement, is the entire and exclusive agreement between the Parties on its subject matter and supersedes all prior or contemporaneous communications, agreements, and proposals, whether oral or written. No amendment is effective unless it is in writing and signed by both Parties. Each Party acknowledges that, in entering into this Agreement, it does not rely on any statement, representation, or promise not expressly set out in this Agreement.

## 22. Counterparts and Electronic Signatures

This Agreement and any Event-Specific Agreement may be signed in counterparts, each of which is an original and all of which together form one instrument. Signatures delivered by PDF, email, or a recognized electronic-signature service are valid and binding to the same extent as original signatures.

## 23. Headings

Section headings are for convenience only and do not affect the interpretation of this Agreement.`,
};
```

- [ ] **Step 2: Update README folder tree**

In `README.md`, find the `client/src/data/` description line (around `:305`):

```
│   │   ├── data/               # Shared data (addonCategories, eventTypes, menuSamples, packages, syrups)
```

Replace with:

```
│   │   ├── data/               # Shared data (addonCategories, eventServicesAgreement, eventTypes, menuSamples, packages, syrups)
```

- [ ] **Step 3: Commit**

```bash
git add client/src/data/eventServicesAgreement.js README.md
git commit -m "feat(proposals): add Event Services Agreement source module"
```

---

### Task 2: Markdown-lite renderer + style key

**Files:**
- Create: `client/src/pages/proposal/proposalView/AgreementText.js`
- Test: `client/src/pages/proposal/proposalView/AgreementText.test.js`
- Modify: `client/src/pages/proposal/proposalView/styles.js` (add `agreementHeading`)
- Modify: `README.md` (folder tree — proposalView line)

TDD: write the failing test first, then the renderer.

- [ ] **Step 1: Write the failing test**

Create `client/src/pages/proposal/proposalView/AgreementText.test.js`:

```jsx
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import AgreementText from './AgreementText';
import { EVENT_SERVICES_AGREEMENT } from '../../../data/eventServicesAgreement';

describe('AgreementText — in-subset rendering', () => {
  test('renders a ## heading as a heading element', () => {
    const { container } = render(<AgreementText markdown={'## 1. Scope of Services'} />);
    const heading = container.querySelector('h3');
    expect(heading).not.toBeNull();
    expect(heading).toHaveTextContent('1. Scope of Services');
  });

  test('renders a blank-line-separated block as a paragraph', () => {
    const { container } = render(<AgreementText markdown={'First clause text.'} />);
    const p = container.querySelector('p');
    expect(p).not.toBeNull();
    expect(p).toHaveTextContent('First clause text.');
  });

  test('renders **bold** inline as <strong>', () => {
    const { container } = render(<AgreementText markdown={'**1.1 Services.** The rest of the clause.'} />);
    const strong = container.querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong).toHaveTextContent('1.1 Services.');
    // The non-bold remainder still renders as visible text.
    expect(container.textContent).toContain('The rest of the clause.');
  });

  test('renders a run of "- " lines as a <ul> with <li> items', () => {
    const md = '- First bullet\n- Second bullet';
    const { container } = render(<AgreementText markdown={md} />);
    const items = container.querySelectorAll('ul li');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('First bullet');
    expect(items[1]).toHaveTextContent('Second bullet');
  });

  test('null/undefined markdown renders nothing, does not throw', () => {
    const { container } = render(<AgreementText markdown={undefined} />);
    expect(container.textContent).toBe('');
  });
});

describe('AgreementText — out-of-subset constructs survive as literal text (Warning 6)', () => {
  const cases = [
    ['table row', '| Col A | Col B |', 'table'],
    ['link', '[click here](https://example.com)', 'a'],
    ['image', '![alt text](https://example.com/x.png)', 'img'],
    ['H1 heading', '# Top Level Title', null],
    ['blockquote', '> a quoted line', null],
    ['nested list', '  - indented nested item', 'li'],
    ['italic', '*just italics*', null],
    ['inline code', 'use the `code` token', 'code'],
    ['unmatched bold', 'a stray ** marker stays literal', 'strong'],
    ['raw HTML', '<script>alert(1)</script>', 'script'],
  ];

  test.each(cases)('%s survives as visible text and is not injected', (_label, fixture, forbiddenTag) => {
    const { container } = render(<AgreementText markdown={fixture} />);
    // The literal source text is visible somewhere in the output.
    expect(container.textContent).toContain(fixture.trim());
    // The out-of-subset construct is NOT rendered as its real element.
    if (forbiddenTag) {
      expect(container.querySelector(forbiddenTag)).toBeNull();
    }
  });
});

describe('AgreementText — real document', () => {
  test('renders the full agreement without throwing and shows all 23 section headings', () => {
    const { container } = render(<AgreementText markdown={EVENT_SERVICES_AGREEMENT.markdown} />);
    const headings = container.querySelectorAll('h3');
    expect(headings).toHaveLength(23);
    expect(headings[0]).toHaveTextContent('1. Scope of Services');
    expect(headings[22]).toHaveTextContent('23. Headings');
  });

  test('pins the binding dollar figures so an edit cannot silently alter them', () => {
    const { container } = render(<AgreementText markdown={EVENT_SERVICES_AGREEMENT.markdown} />);
    const text = container.textContent;
    expect(text).toContain('$35 fee');                       // §2.5 returned payment
    expect(text).toContain('less a 5% processing fee');       // §3.1 cancellation
    expect(text).toContain('$100 per hour for the lead bartender plus $40 per hour'); // §8.1 overtime
    expect(text).toContain('$50 per bartender per hour');     // §8.3 gratuity
    expect(text).toContain('$1,000,000 per occurrence and $2,000,000 aggregate'); // §9.1 insurance
    expect(text).toContain('below 85% of the signed proposal'); // §5.2 guest-count floor
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/proposal/proposalView/AgreementText.test.js`
Expected: FAIL — "Cannot find module './AgreementText'".

- [ ] **Step 3: Add the `agreementHeading` style key**

In `client/src/pages/proposal/proposalView/styles.js`, add a key right after `contractListItem` (after line 123, before `paymentSummary`):

```js
  agreementHeading: {
    fontFamily: 'var(--font-display)',
    fontSize: '1.02rem',
    fontWeight: 600,
    color: 'var(--deep-brown)',
    letterSpacing: '0.01em',
    margin: '1.1rem 0 0.5rem',
  },
```

- [ ] **Step 4: Write the renderer**

Create `client/src/pages/proposal/proposalView/AgreementText.js`:

```jsx
import React from 'react';
import styles from './styles';

// Markdown-lite renderer for the Event Services Agreement. Parses a FIXED subset
// into React elements — no dangerouslySetInnerHTML, no new dependency. Subset:
//   "## heading"        -> styled section heading
//   blank-line blocks   -> <p style={styles.contractText}>
//   runs of "- " lines  -> <ul><li style={styles.contractListItem}>
//   "**bold**" inline   -> <strong>
// Anything outside the subset (tables, links, images, # H1, > blockquotes,
// nested/indented lists, *italic*, inline code, unmatched **, raw HTML) passes
// through as LITERAL paragraph text — never dropped, never raw-injected, never
// throws (spec Warning 6). Heading/bullet detection runs on the RAW line (no
// trim), so an indented "  - x" is NOT a bullet — it falls through to a paragraph
// and its literal dash survives.

const isHeading = (line) => /^##\s+/.test(line);
const isBullet = (line) => /^-\s+/.test(line);

// Split a line into nodes on matched **bold** pairs. Unmatched ** and single *
// are left as literal text.
function renderInline(text, keyPrefix) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g);
  return parts
    .map((part, i) => {
      if (part === '') return null;
      if (/^\*\*[^*]+\*\*$/.test(part)) {
        return <strong key={`${keyPrefix}-s${i}`}>{part.slice(2, -2)}</strong>;
      }
      return <React.Fragment key={`${keyPrefix}-t${i}`}>{part}</React.Fragment>;
    })
    .filter(Boolean);
}

export default function AgreementText({ markdown }) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line — skip.
    if (line.trim() === '') { i += 1; continue; }

    // Section heading.
    if (isHeading(line)) {
      const text = line.replace(/^##\s+/, '').trim();
      blocks.push(
        <h3 key={`h-${key}`} style={styles.agreementHeading}>{renderInline(text, `h-${key}`)}</h3>
      );
      key += 1;
      i += 1;
      continue;
    }

    // Bullet list: a run of consecutive top-of-line "- " lines.
    if (isBullet(line)) {
      const items = [];
      while (i < lines.length && isBullet(lines[i])) {
        const itemText = lines[i].replace(/^-\s+/, '').trim();
        items.push(
          <li key={`li-${key}`} style={styles.contractListItem}>{renderInline(itemText, `li-${key}`)}</li>
        );
        key += 1;
        i += 1;
      }
      blocks.push(<ul key={`ul-${key}`} style={styles.contractList}>{items}</ul>);
      key += 1;
      continue;
    }

    // Otherwise a paragraph: this line plus following non-blank, non-heading,
    // non-bullet lines, joined by a space.
    const paraLines = [line.trim()];
    i += 1;
    while (i < lines.length && lines[i].trim() !== '' && !isHeading(lines[i]) && !isBullet(lines[i])) {
      paraLines.push(lines[i].trim());
      i += 1;
    }
    blocks.push(
      <p key={`p-${key}`} style={styles.contractText}>{renderInline(paraLines.join(' '), `p-${key}`)}</p>
    );
    key += 1;
  }

  return <>{blocks}</>;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/proposal/proposalView/AgreementText.test.js`
Expected: PASS — all describe blocks green (in-subset, out-of-subset survival, real-document headings + figures).

- [ ] **Step 6: Update README folder tree**

In `README.md`, find the `proposal/` tree line (around `:317`):

```
│   │   │   ├── proposal/       # ProposalView (public client-facing) — split into proposalView/ folder (parent + ProposalHeader + ProposalPricingBreakdown + SignAndPaySection + PaymentForm + helpers + styles)
```

Replace with:

```
│   │   │   ├── proposal/       # ProposalView (public client-facing) — split into proposalView/ folder (parent + ProposalHeader + ProposalPricingBreakdown + SignAndPaySection + PaymentForm + AgreementText markdown-lite renderer + helpers + styles)
```

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/proposal/proposalView/AgreementText.js client/src/pages/proposal/proposalView/AgreementText.test.js client/src/pages/proposal/proposalView/styles.js README.md
git commit -m "feat(proposals): markdown-lite AgreementText renderer with out-of-subset passthrough"
```

---

### Task 3: Proposal view integration + expand-box height

**Files:**
- Modify: `client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js:1-4` (imports), `:82-158` (Terms section)
- Modify: `client/src/index.css:9403` (one rule)

- [ ] **Step 1: Add imports**

In `client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js`, the current top imports are:

```js
import React, { useState } from 'react';
import { getPackageBySlug } from '../../../data/packages';
import { fmt, formatDateShort, DEPOSIT_DOLLARS } from './helpers';
import styles from './styles';
```

Add two imports below `styles`:

```js
import React, { useState } from 'react';
import { getPackageBySlug } from '../../../data/packages';
import { fmt, formatDateShort, DEPOSIT_DOLLARS } from './helpers';
import styles from './styles';
import AgreementText from './AgreementText';
import { EVENT_SERVICES_AGREEMENT } from '../../../data/eventServicesAgreement';
```

- [ ] **Step 2: Replace the Terms section block**

Replace the entire Terms & Conditions section (lines 82–158, inclusive of the section wrapper's closing `</div>` on line 158 — from the `{/* ── Terms & Conditions ... ── */}` comment through the closing `</div>` after the toggle button) with the block below. The old `<h2>` you are replacing reads **"The agreement, abridged."** (line 84) — confirm you hit that heading, and that it becomes **"Service Agreement"** (spec §4.3). The `termsExpanded` state (declared at line 17) is reused unchanged.

```jsx
      {/* ── Service Agreement (collapsed-with-fadeout by default) ── */}
      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>Service Agreement</h2>
        <div className={`proposal-terms-scroll ${termsExpanded ? 'is-expanded' : 'is-collapsed'}`}>
          <AgreementText markdown={EVENT_SERVICES_AGREEMENT.markdown} />
        </div>
        <button
          type="button"
          className="proposal-terms-toggle"
          onClick={() => setTermsExpanded((v) => !v)}
        >
          {termsExpanded ? 'Hide details' : 'Read full agreement →'}
        </button>
      </div>
```

This keeps `.proposal-terms-scroll`, the `termsExpanded` state, and the toggle button. The rendered text is verbatim agreement only — the acceptance microcopy that was at the old `:147-149` is intentionally removed here and moves to the signature pad in Task 4.

- [ ] **Step 3: Raise the expand-box height cap**

In `client/src/index.css`, line 9403:

```css
.proposal-terms-scroll.is-expanded { max-height: 6000px; }
```

Replace with:

```css
.proposal-terms-scroll.is-expanded { max-height: 24000px; }
```

(Keep the `transition: max-height 0.3s ease` on `.proposal-terms-scroll` and the `is-collapsed` 200px + fadeout exactly as-is — the collapsed-default decision in spec §4.5 is unchanged.)

- [ ] **Step 4: Verify the client still builds**

Run: `cd client && CI=true npx react-scripts build`
Expected: "Compiled successfully." (or with only pre-existing warnings). No new errors referencing `ProposalPricingBreakdown` or `AgreementText`.

> Note (per CLAUDE.md): a worktree shares `client/node_modules` with `os` by junction. Do not run this build while a dev server or build is running in `os`.

- [ ] **Step 5: Manual check in the running app**

Open a proposal in a signable state (status `sent`/`viewed`) in the running app and confirm before committing:
- The agreement section `<h2>` reads "Service Agreement".
- Collapsed default shows the ~200px preview + fadeout.
- Clicking "Read full agreement →" expands to show all 23 sections with NO clipping (validates the `:9403` → `24000px` fix); "Hide details" collapses it again.

(Dev server is Claude-managed per the dev-server note; do not run a competing build/dev in this worktree while `os` is busy.)

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js client/src/index.css
git commit -m "feat(proposals): render full Service Agreement in proposal view; raise expand cap"
```

---

### Task 4: Acceptance flow (microcopy + payOnly reference line)

**Files:**
- Modify: `client/src/pages/proposal/proposalView/SignAndPaySection.js` (signature-pad microcopy; `payOnly` reference line; accept `clientSignedAt` prop)
- Modify: `client/src/pages/proposal/proposalView/ProposalView.js:413-432` (pass `clientSignedAt` to the `payOnly` section)

- [ ] **Step 1: Add the `clientSignedAt` prop to SignAndPaySection's signature**

In `client/src/pages/proposal/proposalView/SignAndPaySection.js`, the props destructure ends with the venue group:

```js
  venue,
  setVenue,
  venueComplete,
  venuePrefilled,
  proposalVenue,
}) {
```

Add `clientSignedAt` to the destructure (place it right before the closing `}) {`):

```js
  venue,
  setVenue,
  venueComplete,
  venuePrefilled,
  proposalVenue,
  // payOnly: when the client signed (ISO timestamp) — for the reference line.
  clientSignedAt,
}) {
```

- [ ] **Step 2: Add acceptance microcopy next to the signature pad (signAndPay mode)**

In the `mode === 'signAndPay'` branch, the Signature block currently ends with the caption (lines 150–160):

```jsx
        {/* Signature */}
        <div>
          <label className="sign-pay-eyebrow">Signature</label>
          <div className="sign-pay-sig-wrap">
            <SignaturePad
              value={sigData}
              onChange={(data, method) => { setSigData(data); setSigMethod(method); }}
            />
          </div>
          <p className="sign-pay-sig-caption">x · sign above</p>
        </div>
```

Add the acceptance microcopy paragraph after the caption, inside the same `<div>`:

```jsx
        {/* Signature */}
        <div>
          <label className="sign-pay-eyebrow">Signature</label>
          <div className="sign-pay-sig-wrap">
            <SignaturePad
              value={sigData}
              onChange={(data, method) => { setSigData(data); setSigMethod(method); }}
            />
          </div>
          <p className="sign-pay-sig-caption">x · sign above</p>
          <p className="sign-pay-accept-note">
            By signing, you agree to the Service Agreement above and confirm your event details are accurate.
          </p>
        </div>
```

- [ ] **Step 3: Add the `.sign-pay-accept-note` style**

In `client/src/index.css`, insert after line 9430 — i.e. after BOTH the `.sign-pay-card { ... }` block (`:9420-9429`) and its trailing `@media (min-width: 1024px) { .sign-pay-card { padding: 22px; } }` rule (`:9430`), so the card's rules stay grouped — add:

```css
.sign-pay-accept-note {
  margin: 10px 0 0;
  font-size: 0.8rem;
  line-height: 1.45;
  color: var(--brass);
}
```

- [ ] **Step 4: Add the payOnly reference line**

In the `mode === 'payOnly'` branch, the header block is:

```jsx
  // mode === 'payOnly' — backward-compat: already signed under old flow, not yet paid
  return (
    <div id="sign-pay-section" className="sign-pay-card">
      <div>
        <span className="sign-pay-eyebrow">Final Step · Complete Payment</span>
        <h2 className="sign-pay-title">Lock the date.</h2>
      </div>
```

Add the reference line right after that header `<div>` (it does NOT re-present the agreement and records no new version — their existing version stands, per spec §5):

```jsx
  // mode === 'payOnly' — backward-compat: already signed under old flow, not yet paid
  return (
    <div id="sign-pay-section" className="sign-pay-card">
      <div>
        <span className="sign-pay-eyebrow">Final Step · Complete Payment</span>
        <h2 className="sign-pay-title">Lock the date.</h2>
      </div>

      {clientSignedAt && (
        <p className="sign-pay-accept-note">
          You accepted the Service Agreement when you signed on {formatDateShort(clientSignedAt)}.
        </p>
      )}
```

(`formatDateShort` is already imported in this file at line 5.)

- [ ] **Step 5: Pass `clientSignedAt` from ProposalView**

In `client/src/pages/proposal/proposalView/ProposalView.js`, the `payOnly` invocation (lines 413–432) currently ends:

```jsx
                fieldErrors={fieldErrors}
                activeSecret={activeSecret}
                stripePromise={stripePromise}
                payOnlyLabel={payOnlyLabel}
              />
            )}
```

Add the `clientSignedAt` prop:

```jsx
                fieldErrors={fieldErrors}
                activeSecret={activeSecret}
                stripePromise={stripePromise}
                payOnlyLabel={payOnlyLabel}
                clientSignedAt={proposal.client_signed_at}
              />
            )}
```

- [ ] **Step 6: Verify the client builds**

Run: `cd client && CI=true npx react-scripts build`
Expected: "Compiled successfully." No new errors.

- [ ] **Step 7: Manual check in the running app**

Confirm before committing:
- **signAndPay** proposal (status `sent`/`viewed`): the acceptance microcopy "By signing, you agree to the Service Agreement above and confirm your event details are accurate." renders directly under the signature pad — NOT inside the agreement text. The Pay-button gating is unchanged.
- **payOnly** proposal (status `accepted`, `client_signed_at` set, balance unpaid — see Task 7 Step 4 for how to construct one): the reference line "You accepted the Service Agreement when you signed on {date}." renders, and the agreement is NOT re-presented for acceptance.

- [ ] **Step 8: Commit**

```bash
git add client/src/pages/proposal/proposalView/SignAndPaySection.js client/src/pages/proposal/proposalView/ProposalView.js client/src/index.css
git commit -m "feat(proposals): acceptance microcopy at signature; payOnly agreement reference line"
```

---

### Task 5: Version recording mechanism (allowlist + client send + server validate/record)

This is one logical feature spanning the new allowlist module, the client sign POST, the server sign handler, and the route test. **One commit — and it cannot be cleanly split**, because the pieces share a forward dependency: the server must know `v3` before the client starts sending it. That same dependency dictates the operational ordering:

- **Deploy order (required):** server first (learns `v3`, handles the field), then client (starts sending `v3`). See the top-matter "Deploy order" note. During the in-between window the old client omits the field → recorded as `v2`, which matches the abridged text it still shows.
- **Revert order (if this commit must be rolled back post-deploy):** revert the **client first**, then the server — never the reverse. A reverted server that no longer knows `v3` while a live client still sends `v3` would reject signatures mid-payment.

**Execution-review checkpoint:** this is the money/legal-record batch (public token route on the payment path, version tampering rejection, a binding legal version persisted). After the commit, dispatch `security-review` + `code-review` on this diff at the checkpoint (do not wait for the pre-push fleet). Matches the per-batch execution-review cadence for security/money changes.

**Files:**
- Create: `server/utils/agreementVersions.js`
- Test: `server/routes/proposals/publicToken.test.js`
- Modify: `client/src/pages/proposal/proposalView/ProposalView.js:202-211` (add `document_version`)
- Modify: `server/routes/proposals/publicToken.js` (`:2` already imports Sentry; `:114` constant removed; sign handler validates + records)
- Modify: `README.md` (server/utils tree), `ARCHITECTURE.md` (proposal-flow section)

- [ ] **Step 1: Create the version allowlist module**

Create `server/utils/agreementVersions.js`:

```js
// Allowlist of agreement-document versions the proposal sign endpoint will
// accept and record into proposals.client_signature_document_version. The
// recorded value must always be one of these, so an audit can map every
// signature to the exact text the client rendered.
//
// LEGACY_AGREEMENT_VERSION ('event-services-agreement-v2') is the hand-written
// "abridged" terms block that shipped BEFORE the full master agreement. It is
// kept in the allowlist PERMANENTLY: (a) historical rows carry it, and (b) a
// pre-feature cached client omits the new document_version field AND still
// renders that abridged v2 text, so v2 is the truthful record for those signs.
// Do NOT re-map v2 to the full agreement anywhere. Abridged-block source: see
// git history of
// client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js prior to
// the event-services-agreement integration commit.
//
// CURRENT_AGREEMENT_VERSION MUST equal the client module's version:
//   client/src/data/eventServicesAgreement.js -> EVENT_SERVICES_AGREEMENT.version.
// Bump both together when the agreement text changes.
const LEGACY_AGREEMENT_VERSION = 'event-services-agreement-v2';
const CURRENT_AGREEMENT_VERSION = 'event-services-agreement-v3';
const KNOWN_AGREEMENT_VERSIONS = [LEGACY_AGREEMENT_VERSION, CURRENT_AGREEMENT_VERSION];

module.exports = {
  LEGACY_AGREEMENT_VERSION,
  CURRENT_AGREEMENT_VERSION,
  KNOWN_AGREEMENT_VERSIONS,
};
```

- [ ] **Step 2: Write the failing route test**

Create `server/routes/proposals/publicToken.test.js`:

```js
// Route-level tests for the version-recording rules in POST /api/proposals/t/:token/sign
// (spec §4.4). Mirrors the harness in crud.test.js: a fresh express() app mounts
// the real publicToken router + the AppError-aware error handler, driven over
// real HTTP. Runs against the dev DB (DATABASE_URL from .env); creates real rows
// and purges them in after().
//
// signLimiter budget: 10 sign POSTs / hour / IP (all tests share 127.0.0.1).
// This file makes 4 sign POSTs total — well under the cap.

require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const {
  CURRENT_AGREEMENT_VERSION,
  LEGACY_AGREEMENT_VERSION,
} = require('../../utils/agreementVersions');
const publicTokenRouter = require('./publicToken');

let server;
let baseUrl;
const createdProposalIds = new Set();
const createdClientIds = new Set();

function request(method, path, { body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: json, raw: data });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Insert a signable proposal (status 'viewed', not yet signed) with a COMPLETE
// venue so the sign handler does not require venue fields. Returns { id, token }.
async function insertSignableProposal() {
  const client = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'direct') RETURNING id`,
    ['Sign Version Test', `signver+${Date.now()}-${crypto.randomBytes(4).toString('hex')}@example.test`]
  );
  createdClientIds.add(client.rows[0].id);
  const token = crypto.randomUUID();
  const snapshot = JSON.stringify({ package: { name: 'Test', base_cost: 500 }, total: 500 });
  const prop = await pool.query(
    `INSERT INTO proposals
       (client_id, token, guest_count, event_duration_hours, num_bars,
        pricing_snapshot, total_price, payment_type, status, event_type,
        venue_street, venue_city, venue_state)
     VALUES ($1, $2, 120, 4, 1, $3, 500, 'full', 'viewed', 'Wedding',
        '123 Test St', 'Rockford', 'IL')
     RETURNING id, token`,
    [client.rows[0].id, token, snapshot]
  );
  createdProposalIds.add(prop.rows[0].id);
  return prop.rows[0];
}

const validSignBody = (extra = {}) => ({
  client_signed_name: 'Test Signer',
  client_signature_data: 'data:image/png;base64,iVBORw0KGgo=',
  client_signature_method: 'draw',
  ...extra,
});

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/proposals', publicTokenRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const out = { error: err.message, code: err.code };
      if (err.fieldErrors) out.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(out);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (createdProposalIds.size > 0) {
    const ids = [...createdProposalIds];
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [ids]);
  }
  if (createdClientIds.size > 0) {
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [[...createdClientIds]]);
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ── Case A — version present and in allowlist → recorded verbatim ──
test('Case A: a normal sign with the current version records exactly that version', async () => {
  const p = await insertSignableProposal();
  const res = await request('POST', `/api/proposals/t/${p.token}/sign`, {
    body: validSignBody({ document_version: CURRENT_AGREEMENT_VERSION }),
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.raw}`);
  const row = await pool.query(
    'SELECT client_signature_document_version, status FROM proposals WHERE id = $1', [p.id]
  );
  assert.equal(row.rows[0].client_signature_document_version, CURRENT_AGREEMENT_VERSION);
  assert.equal(row.rows[0].status, 'accepted');
});

// ── Case B — version missing → recorded as legacy v2 ──
test('Case B: a sign with no document_version records the legacy v2 version', async () => {
  const p = await insertSignableProposal();
  const res = await request('POST', `/api/proposals/t/${p.token}/sign`, {
    body: validSignBody(), // no document_version
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.raw}`);
  const row = await pool.query(
    'SELECT client_signature_document_version FROM proposals WHERE id = $1', [p.id]
  );
  assert.equal(row.rows[0].client_signature_document_version, LEGACY_AGREEMENT_VERSION);
});

// ── Case C — version present but unknown → rejected, nothing recorded ──
test('Case C: a sign with an unknown version is rejected and records no signature', async () => {
  const p = await insertSignableProposal();
  const res = await request('POST', `/api/proposals/t/${p.token}/sign`, {
    body: validSignBody({ document_version: 'event-services-agreement-v999' }),
  });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${res.raw}`);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
  const row = await pool.query(
    'SELECT client_signed_at, status, client_signature_document_version FROM proposals WHERE id = $1', [p.id]
  );
  assert.equal(row.rows[0].client_signed_at, null, 'rejected sign must not record a signature');
  assert.equal(row.rows[0].status, 'viewed', 'status must be untouched');
  assert.equal(row.rows[0].client_signature_document_version, null);
});

// ── Case D — baseline sign still works (no regression to the sign path) ──
test('Case D: the sign path still records name/method/ip alongside the version', async () => {
  const p = await insertSignableProposal();
  const res = await request('POST', `/api/proposals/t/${p.token}/sign`, {
    body: validSignBody({ document_version: CURRENT_AGREEMENT_VERSION, client_signature_method: 'type' }),
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.raw}`);
  const row = await pool.query(
    'SELECT client_signed_name, client_signature_method, client_signed_at FROM proposals WHERE id = $1', [p.id]
  );
  assert.equal(row.rows[0].client_signed_name, 'Test Signer');
  assert.equal(row.rows[0].client_signature_method, 'type');
  assert.ok(row.rows[0].client_signed_at, 'client_signed_at must be set');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test server/routes/proposals/publicToken.test.js`
Expected: FAIL — Case A/B/D fail (server still records the hardcoded `event-services-agreement-v2` for every sign), Case C fails (unknown version is currently accepted and recorded as v2). This proves the tests exercise the new behavior.

- [ ] **Step 4: Update the server sign handler**

> `Sentry` is already imported at `publicToken.js:2` (`const Sentry = require('@sentry/node');`) — the version block below uses it; do NOT add a second import.

In `server/routes/proposals/publicToken.js`:

(a) Add the allowlist import after the existing errors import (line 12):

```js
const { ValidationError, ConflictError, NotFoundError } = require('../../utils/errors');
const { isVenueComplete, composeVenueLocation, validateVenue } = require('../../utils/venueAddress');
const { KNOWN_AGREEMENT_VERSIONS, LEGACY_AGREEMENT_VERSION } = require('../../utils/agreementVersions');
```

(b) Remove the hardcoded constant at line 114:

```js
const PROPOSAL_DOCUMENT_VERSION = 'event-services-agreement-v2';
```

(delete that whole line.)

(c) Inside the `/t/:token/sign` handler, after the signature-method validation block (the `if (client_signature_method !== 'draw' ...)` check around line 126-128) and before the `lookup` query, add the version-resolution logic:

```js
  if (client_signature_method !== 'draw' && client_signature_method !== 'type') {
    throw new ValidationError({ signature: 'Invalid signature method' });
  }

  // Version recording (spec §4.4). The client sends the version it actually
  // rendered; we validate against the allowlist and record exactly that value
  // so the column provably matches what was shown.
  const sentVersion = req.body.document_version;
  let documentVersion;
  if (sentVersion === undefined || sentVersion === null || sentVersion === '') {
    // Pre-feature cached client: omits the field AND renders the abridged v2
    // text — so v2 is the truthful record. Surface a warning so a FUTURE
    // regression (a current client that stops sending it) is visible, not silent.
    documentVersion = LEGACY_AGREEMENT_VERSION;
    console.warn('[proposals/sign] document_version missing; recorded legacy v2', {
      token: req.params.token,
    });
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureMessage('proposal sign POST missing document_version', 'warning');
    }
  } else if (typeof sentVersion === 'string' && KNOWN_AGREEMENT_VERSIONS.includes(sentVersion)) {
    documentVersion = sentVersion;
  } else {
    // Tampering or an unknown value — never record a version we can't account for.
    throw new ValidationError({ document_version: 'Please refresh the page and try again.' });
  }
```

(d) In the `UPDATE proposals SET ...` query's parameter array, replace `PROPOSAL_DOCUMENT_VERSION` with `documentVersion` (it is the `$6` value, currently on line ~183):

```js
  `, [
    client_signed_name, client_signature_data, client_signature_method, ip, userAgent,
    documentVersion, lookup.rows[0].id,
    venueToPersist ? (vStr(venue_name) || null) : null,
    venueToPersist ? vStr(venue_street) : null,
    venueToPersist ? vStr(venue_city) : null,
    venueToPersist ? vStr(venue_state) : null,
    venueToPersist ? (vStr(venue_zip) || null) : null,
    venueToPersist ? composedLocation : null,
  ]);
```

(e) Grounding check — confirm no other code hardcodes the old version string (spec §4.4). Run:

```bash
grep -rn "event-services-agreement-v2\|PROPOSAL_DOCUMENT_VERSION" server client --include=*.js
```

Expected: the only remaining hits are (i) `server/utils/agreementVersions.js` (the allowlist + its comment), and (ii) the new `client/src/data/eventServicesAgreement.js` does NOT contain `v2` at all. `clientPortal.js:42` only SELECTs the column (no literal). `server/routes/agreement.js` / `server/db/seedTestData.js` reference `signature_document_version` — that is the SEPARATE staff contractor agreement (`agreements` table), not this column; leave them untouched. If any other file hardcodes `event-services-agreement-v2` or `PROPOSAL_DOCUMENT_VERSION`, stop and reconcile before continuing.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test server/routes/proposals/publicToken.test.js`
Expected: PASS — Cases A, B, C, D all green.

> If a prior suite left the dev-DB pool open or `pool.end()` collides, run this file in isolation (see the [Drink plans memory] / "Server tests share the dev DB" note): `node --test server/routes/proposals/publicToken.test.js` by itself.

- [ ] **Step 6: Add `document_version` to the client sign POST**

In `client/src/pages/proposal/proposalView/ProposalView.js`, first add the import near the other proposalView imports (after line 9 `import styles from './styles';`):

```js
import styles from './styles';
import { EVENT_SERVICES_AGREEMENT } from '../../../data/eventServicesAgreement';
```

Then in `handleSign`, the sign POST body (lines 202–211) becomes:

```js
      await axios.post(`${BASE_URL}/proposals/t/${token}/sign`, {
        client_signed_name: sigName.trim(),
        client_signature_data: sigData,
        client_signature_method: sigMethod,
        document_version: EVENT_SERVICES_AGREEMENT.version,
        venue_name: venue.venue_name?.trim() || null,
        venue_street: venue.venue_street?.trim() || null,
        venue_city: venue.venue_city?.trim() || null,
        venue_state: venue.venue_state?.trim() || null,
        venue_zip: venue.venue_zip?.trim() || null,
      });
```

- [ ] **Step 7: Verify the client builds**

Run: `cd client && CI=true npx react-scripts build`
Expected: "Compiled successfully."

- [ ] **Step 8: Update docs**

In `README.md`, find the `server/utils/` tree and add (alphabetically, near `agreementPdf.js` at `:193`):

```
│   │   ├── agreementVersions.js # Allowlist + current/legacy version constants for the proposal Service Agreement
```

In `ARCHITECTURE.md`, in the proposal-flow / signing section, add a short subsection (place near the existing proposal token/sign material):

```markdown
**Proposal Service Agreement.** The client-facing master agreement lives as a
versioned, bundled module at `client/src/data/eventServicesAgreement.js` and is
rendered in full by `client/src/pages/proposal/proposalView/AgreementText.js` (a
dependency-free markdown-lite renderer). At signing, the client sends the
`document_version` it rendered; `POST /api/proposals/t/:token/sign` validates it
against the allowlist in `server/utils/agreementVersions.js` and records it as
`proposals.client_signature_document_version`. Missing version → recorded as the
legacy `event-services-agreement-v2` (the pre-feature abridged block, kept in the
allowlist permanently); unknown version → rejected. No backfill of existing rows.
Because client and server deploy independently (Vercel vs Render), the server
must ship before the client so it knows a new version before the client sends it;
a rollback reverts the client before the server, for the same reason.
```

- [ ] **Step 9: Commit**

```bash
git add server/utils/agreementVersions.js server/routes/proposals/publicToken.js server/routes/proposals/publicToken.test.js client/src/pages/proposal/proposalView/ProposalView.js README.md ARCHITECTURE.md
git commit -m "feat(proposals): record client-sent agreement version against a server allowlist"
```

---

### Task 6 (OPTIONAL — Suggestion 12): Admin display of recorded version + signed date

Optional per spec §3.10 / §9. The admin GET-by-id already returns these columns via `SELECT p.*` (`server/routes/proposals/crud.js:355`), so no route change is needed. Skip this task if not wanted.

**Files:**
- Modify: `client/src/pages/admin/ProposalDetail.js` (add a signature card)

- [ ] **Step 1: Add a "Signature" card after the Event card**

In `client/src/pages/admin/ProposalDetail.js`, the Event card closes around line 359 (`</div>` after the event `<dl>`). Add a new card immediately after it, before the "Class options" card:

```jsx
              {/* Signature / acceptance */}
              {proposal.client_signed_at && (
                <div className="card">
                  <div className="card-head"><h3>Signature</h3></div>
                  <div className="card-body">
                    <dl className="dl">
                      <dt>Signed by</dt><dd>{proposal.client_signed_name || '—'}</dd>
                      <dt>Signed on</dt>
                      <dd>{fmtDateFull(String(proposal.client_signed_at).slice(0, 10))}</dd>
                      <dt>Agreement version</dt>
                      <dd className="muted">{proposal.client_signature_document_version || '—'}</dd>
                    </dl>
                  </div>
                </div>
              )}
```

(`fmtDateFull` is already imported/used in this file — see the Event card's date rendering at `:343`. If it is not in scope, reuse the same date helper the Event card uses.)

- [ ] **Step 2: Verify the client builds**

Run: `cd client && CI=true npx react-scripts build`
Expected: "Compiled successfully."

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/admin/ProposalDetail.js
git commit -m "feat(proposals): show recorded agreement version + signed date on admin detail"
```

---

### Task 7: Verbatim verification + full-document render check + ops runbook + final gates

The verification steps (1–6) make no code commit unless a check surfaces a fix (then fix at root cause and re-run). Step 7 adds one documentation commit (the ops runbook).

- [ ] **Step 1: Verbatim diff against the authoritative source (Warning 7 — merge gate)**

Compare the `markdown` body in `client/src/data/eventServicesAgreement.js` against `Dr_Bartender_Agreement_REDRAFT.docx` (use `.claude/_contract_extract.txt` as the text proxy). Read both and confirm, section by section, that every clause's wording, numbering, and dollar/percent/time figures match exactly. Pay special attention to:
- §2.5 `$35`, §3.1 `5%` + `100%`, §5.2 `85%` + `10%`, §8.1 `$100` + `$40`, §8.3 `$50`, §9.1 `$1,000,000` + `$2,000,000`.
- The curly quotes/apostrophes (do not let an editor normalize them silently).
- All 23 section headings present and correctly numbered.

Record a one-line sign-off in the PR/commit description: "Verbatim-verified against Dr_Bartender_Agreement_REDRAFT.docx on 2026-06-04."

If the diff surfaces a transcription error, fix it in `eventServicesAgreement.js` as a **new commit** on top of Task 1 (e.g. `fix(proposals): correct verbatim agreement transcription`) — do NOT `--amend` Task 1's commit (CLAUDE.md Rule 10). Then re-run Step 2.

- [ ] **Step 2: Run the renderer figure-snapshot test (locks the figures going forward)**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/proposal/proposalView/AgreementText.test.js`
Expected: PASS — including the "pins the binding dollar figures" test.

- [ ] **Step 3: Run the server route test**

Run: `node --test server/routes/proposals/publicToken.test.js`
Expected: PASS — Cases A–D.

- [ ] **Step 4: Full-document render check in the running app (validates the CSS height fix)**

Start the app (dev server is Claude-managed per the [dev-server memory]; do not run a competing build/dev in the worktree while `os` is busy). Open a proposal in a signable state, click "Read full agreement →", and confirm:
- All 23 sections expand with NO clipping (validates `index.css:9403` → `24000px`).
- The `<h2>` reads "Service Agreement" (not "The agreement, abridged.").
- The acceptance microcopy appears next to the signature pad, not inside the agreement text.
- The collapsed default still shows the ~200px preview + fadeout.
- For a `payOnly` proposal: the reference line "You accepted the Service Agreement when you signed on {date}." appears and the agreement is NOT re-presented for acceptance.

To construct a `payOnly` proposal (status `accepted`, signed under the old flow, balance unpaid), update a test proposal directly:

```sql
UPDATE proposals
   SET status = 'accepted',
       client_signed_at = NOW(),
       client_signed_name = 'Test Signer',
       client_signature_document_version = 'event-services-agreement-v2'
 WHERE token = '<your-test-token>' AND amount_paid < total_price;
```

Then open `/proposal/<token>` — `showPayOnly` is `!isPaid && isAlreadySigned && status === 'accepted'` (`ProposalView.js:324`), so this renders the pay-only rail. (Recording the legacy `v2` here is correct — it mirrors a real already-signed client; the pay-only path records no new version.)

- [ ] **Step 5: No-regression check on the Stripe sign-and-pay path**

Confirm a normal sign-and-pay still: signs (records `event-services-agreement-v3`), creates the payment intent, and completes payment. Verify the recorded row: `SELECT client_signature_document_version FROM proposals WHERE token = '...'` → `event-services-agreement-v3`.

- [ ] **Step 6: Client build gate (Vercel CI parity)**

Run: `cd client && CI=true npx react-scripts build`
Expected: "Compiled successfully." (client lint is only enforced by Vercel CI, so this is the real gate — per the [client-lint memory]).

- [ ] **Step 7: Create the ops runbook for manual agreement obligations (spec §6 / Warning 10)**

The full agreement (live as of Task 3) creates obligations the platform does NOT automate. No ops-runbook doc exists yet (`docs/tech-debt.md` is a refactor backlog, not the right home). Create `docs/ops-runbook.md`:

```markdown
# Ops Runbook — Manual Obligations from the Event Services Agreement

Source: `docs/superpowers/specs/2026-06-04-event-services-agreement-integration-design.md` §6.

The master Event Services Agreement (presented at proposal sign-and-pay) creates
obligations the platform does NOT automate. Honor these manually and
consistently — the signed agreement is binding even where the code does not
enforce the term.

## Client-favorable (watch these — under-enforcing breaks a promise you made)

- **§5.2 Final guest count — 85% floor (asymmetric in the client's favor).**
  Downward guest-count changes after the 14-day deadline do NOT reduce the
  contract total below **85%** of the signed proposal. The app does not automate
  re-quotes; when you manually re-quote a decreased guest count, never drop below
  85% of the signed total. (Upward changes <10% bill at the per-guest add-on
  rate; >=10% add staff at the contracted per-bartender rate, subject to
  availability.)

## Seller-side (not auto-enforced; apply when the situation arises)

- **§3.1 Cancellation tiers (liquidated damages).** More than 14 days out: the
  client forfeits the retainer; refund any excess over the retainer **less a 5%
  processing fee** within 15 business days. 14 days or fewer out: 100% of the
  contract total is due, amounts paid are non-refundable. `refundHelpers.js`
  issues admin partial refunds but does NOT compute these tiers — calculate
  manually.
- **§2.5 Returned payment / chargeback — $35 fee.** Returned checks or reversed
  payments incur a **$35** fee. Not coded; bill manually.
- **§8.1 Lead-bartender overtime — $100/hr.** Additional Time bills at **$100/hr
  for the lead** plus $40/hr per additional bartender, pro-rated in 30-min
  increments. The app's `extra_bartender_hourly` default ($40) covers the
  additional-bartender rate only; the $100/hr lead overtime is not automated —
  add it to the final invoice manually.

## Payment methods (§2.3)

The agreement lists ACH, card, check, Google/Apple/Amazon Pay, Cash App, Venmo,
and Zelle. Only Stripe (cards + Apple/Google Pay) is an integrated rail. Accept
the others manually if a client asks; there is no automated reconciliation
(external payment recon is parked).

## Known interim contradiction (§8.3 — to be fixed in Project B)

At sub-100-guest events carrying extra/add-on bartenders, the client sees a
"$50/hr Shared Gratuity" line (the sub-100-guest surcharge) while §8.3 frames
"$50/bartender/hr" as meaning *no tip jar*. Low frequency; §1.3 gives the master
terms control over a conflicting Event-Specific line. The relabel is a
payroll-coupled change assigned to Project B.
```

Then commit:

```bash
git add docs/ops-runbook.md
git commit -m "docs(proposals): ops runbook for manual Event Services Agreement obligations"
```

---

## Self-Review (spec coverage)

Checked against `docs/superpowers/specs/2026-06-04-event-services-agreement-integration-design.md`:

| Spec requirement | Task |
|---|---|
| §3.1 Store agreement as editable versioned source module | Task 1 |
| §3.2 / §4.2 Render full text, reuse collapse UI, out-of-subset behavior | Task 2 (renderer + W6 tests), Task 3 (wiring) |
| §3.3 / §4.4 Client sends version; server validates against allowlist (Blocker 1) | Task 5 |
| §3.4 / §4.4 Migration of existing v2 rows — no backfill (Blocker 4) | Task 5 (allowlist comment + `documentVersion` defaults; no UPDATE of old rows) |
| §3.5 / §5 Acceptance microcopy location (Blocker 2) | Task 4 |
| §3.6 / §5 `payOnly` branch — reference line, no re-bind (Blocker 3) | Task 4 |
| §3.7 / §4.5 Raise expand height; keep collapsed default (Warning 8) | Task 3 (CSS), decision documented |
| §3.8 / §8 Verbatim-transcription verification (Warning 7) | Task 7 Step 1 + figure-snapshot test in Task 2 |
| §3.10 Optional admin display of version + signed date (Suggestion 12) | Task 6 (optional) |
| §4.1 Markdown-in-JS module rationale | Task 1 |
| §4.3 Retitle `<h2>` to "Service Agreement", remove acceptance line | Task 3 |
| §4.4 Deploy server-first ordering (+ revert order) | Top-matter "Deploy order" note + Task 5 header (deploy + revert order) + Task 5 Step 8 ARCHITECTURE |
| §6 / Warning 10 §5.2 ops-runbook note (+ other manual-ops rows) | Task 7 Step 7 (`docs/ops-runbook.md`) |
| §4.4 Confirm no other code hardcodes the version | Task 5 Step 4(e) grounding grep |
| §8 Renderer unit + out-of-subset fixture tests | Task 2 |
| §8 Version-recording tests (present/missing/unknown) | Task 5 |
| §8 `payOnly` renders reference, records no new version | Task 4 + Task 5 Case (status untouched) / Task 7 Step 4 |
| §8 Full-document render, client build, no Stripe regression | Task 7 |
| §10 README + ARCHITECTURE updates | Tasks 1, 2, 5 |

**Out of scope (Project B, untouched here):** `pricingEngine.js`, `payrollMath.js`, payroll tests, the "Shared Gratuity" relabel, checkout gratuity, signed-PDF snapshot, no-code admin editor.

**Grounding note discovered during planning:** `server/routes/agreement.js` + `server/db/seedTestData.js` reference a `signature_document_version` column — that is the **separate staff/contractor** Independent Contractor Agreement (`agreements` table, `server/data/contractorAgreement.js`), NOT the proposal column. The spec's claim that nothing else hardcodes the proposal version holds; `clientPortal.js:42` only SELECTs `client_signature_document_version`. No coordination needed with the contractor-agreement feature.

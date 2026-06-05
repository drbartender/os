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

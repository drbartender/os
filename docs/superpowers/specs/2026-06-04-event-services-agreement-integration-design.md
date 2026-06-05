# Event Services Agreement — Document Integration (Project A)

- **Date:** 2026-06-04
- **Status:** Design approved; spec-review fleet findings folded in (4 blockers, 6 warnings, 5 suggestions). Ready for implementation plan.
- **Author:** Dallas + Claude
- **Scope:** Replace the hand-written "abridged" terms block on the proposal with the real, lawyer-drafted master service agreement, wired into the existing sign-and-pay flow, with the recorded signature version provably matching the text the client saw. Reconciliation dispositions included. The checkout gratuity feature is split out as **Project B** (separate spec).

### Revision log

- **r2 (2026-06-04):** Folded in `/review-spec` findings. Version mechanism changed from "server stamps a constant (with an optional client-sends-version upgrade)" to **client-sends-version is required** with a server-side allowlist and defined failure modes (Blocker 1). Added existing-row migration semantics (Blocker 4), `payOnly`-branch handling (Blocker 3), and resolved the acceptance-line location (Blocker 2). Corrected the §8.3 "not a contradiction" claim and reassigned the "Shared Gratuity" relabel to Project B because that label is a payroll-matching key (Warning 5). Added markdown out-of-subset behavior (W6), verbatim-verification step (W7), collapsed-preview decision (W8), removed a spurious seed-data claim (W9), and an ops-runbook note for §5.2 (W10).

## 1. Goal

The client signs a proposal at sign-and-pay. That signature should bind them to the actual master service agreement Dallas's lawyer drafted, presented in full, editable/swappable from the repo, and the recorded `client_signature_document_version` must provably correspond to the exact text the client rendered. Today the proposal shows a short hand-written summary and records a version string for a document that exists nowhere in the code.

## 2. Background: current state (grounded)

- **Abridged terms are hardcoded JSX.** `client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js:82-158` renders "The agreement, abridged." inside a collapse-with-fadeout box (`.proposal-terms-scroll`) with a "Read full agreement →" toggle (`:151-157`). The toggle only expands the same summary; there is no real full document behind it. The block ends with an acceptance line at `:147-149`.
- **The e-signature record already exists.** `server/routes/proposals/publicToken.js` `POST /t/:token/sign` captures signature, name, timestamp, IP, user-agent into `proposals` (`:161-190`). Columns are in `schema.sql:869-875`, including `client_signature_document_version`.
- **A phantom version string is already recorded.** `publicToken.js:114`: `PROPOSAL_DOCUMENT_VERSION = 'event-services-agreement-v2'`, written on every signing for a document never in the codebase.
- **The client does NOT send a version today.** The sign POST body (`ProposalView.js:202-211`) sends only name, signature, method, and venue. The server stamps its own constant.
- **Client and server deploy independently** (Vercel vs Render). There is no atomic deploy, so any "server stamps its own constant" scheme has an unbounded skew window.
- **No proposal PDF exists.** Proposal signing produces no PDF artifact; the record is the DB columns only.
- **The "Shared Gratuity" line is a payroll key, not just a label.** `pricingEngine.js:287,313` emit a `{label:'Shared Gratuity'}` breakdown line; `payrollMath.js:45` `extractGratuityCents` sums every line where `label === 'Shared Gratuity'`; it is asserted in `payrollAccrual.test.js`, `payrollMath.test.js`, `admin/payroll.test.js`, and is frozen into historical `pricing_snapshot` JSON. Renaming it is a payroll-coupled, backward-compatibility-sensitive change.
- **The new document is the authoritative source.** Faithful text extract at `.claude/_contract_extract.txt`; the legal-authoritative copy is `Dr_Bartender_Agreement_REDRAFT.docx`. Transcription must be verbatim.

## 3. Scope

**In scope (Project A):**
1. Store the agreement as an editable, versioned source module.
2. Render it (full text) in place of the abridged block, reusing the collapse/expand UI, with defined behavior for out-of-subset markdown.
3. Record the signed version so it provably matches what the client saw: client sends the version, server validates against an allowlist (Blocker 1).
4. Define migration for existing `v2` rows (Blocker 4).
5. Resolve where the acceptance microcopy lives (Blocker 2).
6. Handle the `payOnly` (already-signed, not-yet-paid) branch (Blocker 3).
7. Raise the expand-box height cap; make a deliberate collapsed-default decision.
8. Verbatim-transcription verification (Warning 7).
9. Record reconciliation dispositions (Section 6).
10. **Optional:** surface the recorded version + signed date on the admin proposal-detail view (Suggestion 12).

**Out of scope (deferred):**
- **Project B — checkout gratuity feature** (Section 7), including the "Shared Gratuity" line-label disambiguation (payroll-coupled; see Warning 5 in Section 6).
- **Signed-PDF snapshot** of the accepted proposal + agreement.
- **No-code admin editor.** Editing is by changing the repo source + version bump, then deploy. "Swap" = replace the source.

## 4. Design

### 4.1 Document source module (new)

`client/src/data/eventServicesAgreement.js`:

```js
export const EVENT_SERVICES_AGREEMENT = {
  version: 'event-services-agreement-v3',
  revisedDate: '2026-06-04',
  markdown: `... full verbatim agreement text in Markdown ...`,
};
```

- **Format:** Markdown in a bundled JS module (not a `.md` fetched from `/public`): CRA cannot import raw `.md` as a string without ejecting, and this text gates a payment so it must always be present with no separate request that could 404 mid-signing. Editing = edit the prose; swapping = replace the `markdown` block and bump `version`.
- **Subset used:** `##` section headings, sub-clauses as paragraphs, `**bold**` lead-ins, `-` bullet lists. No tables, images, or links required.
- **Verbatim requirement:** transcribe from the `.docx` exactly. Verification in §8.
- **File size:** data only, no logic. Well under the 700 soft cap.

### 4.2 Markdown-lite renderer (new)

`client/src/pages/proposal/proposalView/AgreementText.js` — a small pure component that parses the subset into **React elements** (no `dangerouslySetInnerHTML`, no new dependency):

- `## heading` → styled section heading.
- blank-line-separated blocks → `<p style={styles.contractText}>`.
- runs of `- ` lines → `<ul style={styles.contractList}><li style={styles.contractListItem}>`.
- `**bold**` inline → `<strong>`.

`styles.js` is a single `export default` object; the renderer reuses its keys `contractText`, `contractList`, `contractListItem`.

**Out-of-subset behavior (Warning 6 — required):** any construct outside the subset (tables, links, images, `#` H1, `>` blockquotes, nested lists, `*italic*`, inline code, unmatched `**`, raw HTML) must **pass through as literal paragraph text** — never silently dropped (loses legal content), never raw-injected, never throw. A fixture test asserts each out-of-subset construct survives as visible text (§8).

### 4.3 Proposal view integration (edit)

In `ProposalPricingBreakdown.js`:
- Replace the entire hardcoded block including the acceptance line (`:86-149`) with `<AgreementText markdown={EVENT_SERVICES_AGREEMENT.markdown} />` inside the existing `.proposal-terms-scroll` wrapper. The rendered text is **verbatim only** — no UI sentences inside it.
- Retitle the `<h2>` from "The agreement, abridged." to **"Service Agreement"** (`:84`).
- Keep `.proposal-terms-scroll` and the `.proposal-terms-toggle` button.
- The acceptance microcopy moves to `SignAndPaySection.js` (see §5). This file shrinks overall.

### 4.4 Version recording (edit + new) — Blocker 1 + Blocker 4

**Mechanism: the client sends the version it rendered; the server validates and records it.** The constant-only fallback is removed — it can record a version the client never displayed across the deploy-skew window, defeating the column's only purpose.

- **New** `server/utils/agreementVersions.js`:
  ```js
  const LEGACY_AGREEMENT_VERSION = 'event-services-agreement-v2'; // the abridged block; see commit <SHA>
  const CURRENT_AGREEMENT_VERSION = 'event-services-agreement-v3';
  const KNOWN_AGREEMENT_VERSIONS = [LEGACY_AGREEMENT_VERSION, CURRENT_AGREEMENT_VERSION];
  ```
  `v2` stays in the allowlist **permanently**, mapped (in a comment) to the commit SHA of the abridged block, so an audit never reads "v2 = full agreement."
- **Client** (`ProposalView.js:202-211`): add `document_version: EVENT_SERVICES_AGREEMENT.version` to the sign POST body.
- **Server** (`publicToken.js` sign handler) records the version with these rules:
  - **Present and in allowlist** → record that value (this is the normal path; records exactly what the client rendered).
  - **Missing** → record `LEGACY_AGREEMENT_VERSION` (`v2`). Only a pre-feature cached client omits the field, and that client renders the abridged v2 text, so v2 is the truthful record. Emit a Sentry breadcrumb/warning so a future regression (new client stops sending it) is visible rather than silent.
  - **Present but not in allowlist** → reject with `ValidationError` ("Please refresh the page and try again."). Catches tampering and unknown values; never record a version the server cannot account for.
- **Deploy order (required):** deploy the **server first** (knows `v3`, handles the field), then the client (starts sending `v3`). This removes the "client sends v3 before server knows v3 → rejected mid-payment" window. During the in-between window (new server, old client) the old client omits the field → recorded as `v2`, which matches the abridged text it still shows.
- Replace the `publicToken.js:114` constant usage with the new module. Confirm no other code hardcodes the value (`clientPortal.js:42` only SELECTs the column; `seedTestData.js` does not reference it).

**Migration (Blocker 4):** **No backfill.** Existing rows keep `event-services-agreement-v2`, representing the abridged-summary acceptance, anchored to git history. The allowlist retains `v2` permanently. Do not retroactively re-map "v2" to the full agreement in any registry, display, or doc.

### 4.5 CSS (edit) + collapsed-default decision

- `index.css:9403` `.proposal-terms-scroll.is-expanded { max-height: 6000px; }` will clip the 23-section document. Raise it generously (e.g. `24000px`) or set `max-height: none`. Keep the 0.3s transition.
- **Collapsed-default decision (Warning 8):** keep the existing default-collapsed 200px preview + fadeout (`index.css:9394`). Rationale: the full text is one tap away, and the binding act (signature + acceptance microcopy in §5) is explicit and separate. Revisitable, but not changed here.

## 5. Acceptance flow (edit) — Blocker 2 + Blocker 3

- **Sign-and-pay (unsigned) mode:** signature pad + full legal name stay in `SignAndPaySection.js`. Add acceptance microcopy adjacent to the signature pad: **"By signing, you agree to the Service Agreement above and confirm your event details are accurate."** This replaces the line removed from the abridged block and places acceptance at the binding action. The Pay-button gating (`SignAndPaySection.js:260`) is otherwise unchanged. No checkbox (per decision).
- **`payOnly` mode (`SignAndPaySection.js:285-360`):** these clients already signed (under whatever version is recorded on the proposal) and are only paying a balance. Do **not** re-present the agreement for acceptance and do **not** re-bind them to v3. Show a brief reference line: **"You accepted the Service Agreement when you signed on {client_signed_at}."** Their recorded version stands.

## 6. Reconciliation dispositions

| Clause | Contract says | Code reality | Disposition |
|---|---|---|---|
| §2.2 Final balance | Due **14 days** before event | `bookingWindow.js:10` `FULL_PAYMENT_HOURS = 14*24` (also gates the last-minute full-payment trigger, not only the balance-due date) | **Match.** New doc fixes the old summary's wrong "30 days." No change. |
| §15 Governing law | Illinois / Winnebago County | Existing copy agrees | Match. |
| §8.1 Additional bartender | $40/hr | `pkg.extra_bartender_hourly` default $40 | Match for the rate. Lead overtime ($100/hr) not automated → ops (below). |
| §2.3 Payment methods | ACH, card, check, wallets, Cash App, Venmo, Zelle | Stripe (cards + Apple/Google Pay); others not integrated rails | **Keep as-is per decision.** Accept others manually if asked. No change. |
| §8.3 Gratuity | Tip jar default (no line); no jar → $50/bartender/hr line | App has no tip-jar toggle. `pricingEngine.js:284-288` emits a "Shared Gratuity" line for the sub-100-guest surcharge ($50/$25/$15, `:117-119`), tip jar still present | **Interim contradiction, mitigated in Project B.** Correction to r1: this is NOT "not a contradiction." At sub-100-guest events carrying extra/add-on bartenders, the client sees a "$50/hr Shared Gratuity" line while §8.3 frames "$50/bartender/hr" as meaning *no tip jar*. Project A still ships the verbatim §8.3 text. Cover/limits: low frequency (needs extra/add-on bartenders), and §1.3 gives the master terms control over a conflicting Event-Specific line. The fix (relabel) is a payroll-coupled change (`payrollMath.js:45`) and is assigned to **Project B** with backward-compat (match a label set incl. the old string so historical snapshots still extract). |
| §3.1 Cancellation 5% fee + tiers | Liquidated-damages tiers; refund excess less 5% | `refundHelpers.js` admin-issued partial refunds; no tier math | **Manual ops.** Seller-side; not auto-enforced. Ops-runbook note. |
| §2.5 Returned-payment $35 fee | $35 | Not coded | **Manual ops.** Seller-side. |
| §5.2 Guest count | 14-day count; **85% floor** on decreases; tiered increases | Not automated; manual re-quote | **Manual ops — watch this one (Warning 10).** Asymmetric in the *client's* favor: if the system silently re-quotes below 85%, you promised a stronger right than you enforce. Add to ops runbook so it is honored consistently. |
| §9.1 Insurance | $1M/occ + $2M aggregate liquor; $1M general | Package bullets say "$2 million liquor liability insurance" | Fair lay summary, not a contradiction. Optional precise rewording; not required. |
| Historical `v2` records | n/a | Rows signed before this project carry `event-services-agreement-v2` for the abridged text | **No backfill** (Blocker 4). v2 = abridged acceptance, git-anchored, kept in the allowlist permanently. |

## 7. Project B (deferred): checkout gratuity — captured requirements

Its own brainstorm → spec → plan. Money-critical; touches pricing, the proposal model, the payment intent, BEO tip-jar handling, and staff gratuity distribution (overlaps the staff-payment / tipping project). Requirements as stated by Dallas:

- A checkout gratuity step with three outcomes:
  - **None:** default tip jar, no gratuity line (= §8.3 default).
  - **Partial:** tip jar stays; gratuity line; suggested **$25/hr/bartender**, client may enter **any amount**.
  - **Full:** **no tip jar**; gratuity line at **$50/hr/bartender**, client may **increase but not decrease** (floor $50).
- Gratuity = rate × bartender-count × duration-hours (count + hours definition settled in B).
- **Includes the "Shared Gratuity" relabel** (Warning 5): rename the sub-100-guest surcharge line so it cannot be conflated with §8.3's no-tip-jar gratuity, with payroll backward-compat — `payrollMath.js:45` must match a label set containing the old `'Shared Gratuity'` string so already-signed `pricing_snapshot` rows still extract; update `pricingEngine.js:287,313` and the three payroll test files.
- Open questions for B: how the chosen gratuity flows into the payment-intent amount; tip-jar flag to the BEO/staff; pre-paid gratuity vs tip-jar distribution to staff.

## 8. Testing / verification

- **Renderer unit test** (`AgreementText`): headings, paragraphs, bold, lists render; the real document string renders without throwing; **and a fixture of each out-of-subset construct survives as literal visible text** (Warning 6).
- **Verbatim verification (Warning 7):** before merge, diff the transcribed `markdown` against `Dr_Bartender_Agreement_REDRAFT.docx` (use `.claude/_contract_extract.txt` as a proxy) and sign off. Add a snapshot test of the section headings + the dollar amounts in §2.5, §3.1, §8.1, §9.1 so a later edit can't silently alter a binding figure.
- **Version recording:** a normal signing records the client-sent `event-services-agreement-v3`; a POST with the field missing records `event-services-agreement-v2` (and emits the Sentry warning); a POST with an unknown version is rejected with `ValidationError`. Existing `publicToken` sign test still passes.
- **`payOnly` branch:** renders the reference line, does not re-present the agreement, records no new version.
- **Full-document render check:** expanded box shows all 23 sections, no clipping (validates the `:9403` fix). Verify in the running app.
- **Client build:** `CI=true react-scripts build` passes (client lint is only enforced by Vercel CI).
- **No regression** to the Stripe sign-and-pay path.

## 9. Files touched

- **New:** `client/src/data/eventServicesAgreement.js`
- **New:** `client/src/pages/proposal/proposalView/AgreementText.js`
- **New:** `client/src/pages/proposal/proposalView/AgreementText.test.js`
- **New:** `server/utils/agreementVersions.js`
- **Edit:** `client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js` (swap block, retitle, remove acceptance line)
- **Edit:** `client/src/pages/proposal/proposalView/ProposalView.js` (add `document_version` to sign POST, `:202-211`)
- **Edit:** `client/src/pages/proposal/proposalView/SignAndPaySection.js` (acceptance microcopy by the signature; `payOnly` reference line)
- **Edit:** `client/src/index.css` (one rule, `:9403`)
- **Edit:** `server/routes/proposals/publicToken.js` (use `agreementVersions`; validate + record per §4.4)
- **Optional:** admin proposal-detail component (Suggestion 12 — display recorded version + signed date; plan locates the file)

Not touched in Project A (moved to B): `pricingEngine.js`, `payrollMath.js`, and the payroll test files (the "Shared Gratuity" relabel).

## 10. Documentation updates

- `README.md` folder-structure tree: add `eventServicesAgreement.js`, `AgreementText.js`, and `server/utils/agreementVersions.js`.
- `ARCHITECTURE.md`: **yes** — add the proposal Service Agreement source + version mechanism to the proposal-flow section.
- No schema change (columns already exist), no new env var, no new npm script.

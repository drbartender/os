# E-signatures fixer report (lane `audit-esign`, worktree /home/user/worktrees/audit-esign, cut from 13f2645)

13 findings handled, 13 commits, nothing pushed. Tree clean (`git status` empty). Every finding re-verified from the code before an edit; none rejected. Old-code outputs kept under <scratchpad>/audit/esign-runs/ (one file per finding, `*-old.txt`, plus `final-sweep.txt`).

## Per finding

### ESIG-01 (+AUTH-08): CONFIRMED-FIXED, f903864
- Files: server/routes/agreement.js (sign ip), server/routes/clientPortal/changeRequests.js (request_ip, the one expression only).
- Fix: `(req.ip || '').replace(/^::ffff:/, '').slice(0, 45) || null` at both sites (the publicAccept.js pattern); no consumer change (column and PDF take a string).
- Test: server/routes/agreement.signatureIp.test.js (no DB, trust proxy 1, `X-Forwarded-For: 1.2.3.4, 10.0.0.1`): on old code 2/3 fail (stored ip is `1.2.3.4`; a 300-char header is stored whole); after 3/3. DB-backed sibling for the second site: server/routes/clientPortal.changeRequests.requestIp.test.js (not run here).

### ESIG-13: CONFIRMED-FIXED, 4d29bbd
- Files: server/routes/agreement.js, server/routes/proposals/publicToken.js.
- Fix: staff sign bounds trimmed full_name 2-255, email 3-255 + the auth.js shape (no shared helper exists in server/utils; the regex is inlined with a comment naming its twin), phone through utils/phone.js `validatePhone` (optional, 10-digit storage, NULL when empty), every ack and sms_consent `=== true`, validated values bound; proposal sign bounds and trims client_signed_name 2-255 and binds the trimmed value into the UPDATE and the activity row.
- Tests: agreement.signerFields.test.js (7 cases; old code 7/7 fail), publicToken.signerName.test.js (3 cases; old code 3/3 fail, incl. "a 300-char name reaches the UPDATE"); after 7/7 and 3/3.

### ESIG-06: CONFIRMED-FIXED, 907ba90
- Files: NEW server/utils/signaturePayload.js (header, README tree regenerated), server/utils/fileValidation.js (exports PNG_MAGIC/JPEG_MAGIC, additive), agreement.js, publicToken.js (validator called before the first query).
- Fix: draw = `data:image/(png|jpeg);base64,` whose decoded bytes carry that image's magic and fit 200 KB (string-length check first, so an oversize payload is never decoded); type = 2-120 chars of letters/marks/digits/name punctuation, stored trimmed; 400 naming `signature` otherwise. agreementPdf.js and DocumentsTab unchanged.
- Tests: signaturePayload.test.js (5 unit cases: oversize, SVG, javascript:, lying magic, empty/1-char typed, unknown method), agreement.signaturePayload.test.js (5; old code 4/5 fail, the oversize case was already capped at 200000 chars), publicToken.signaturePayload.test.js (4; old code 4/4 fail; asserts zero queries on a refusal); after all pass.

### ESIG-02: CONFIRMED-FIXED, 5dffa6f
- Files: server/routes/proposals/patchGuards.js (`pricedTermsOf`, `signatureVoidReason`, `VOIDABLE_STATUSES`), NEW server/routes/proposals/signatureVoid.js (`voidClientSignature`, the write, shared with lifecycle.js), server/utils/publicSnapshot.js (`signedPriceRecord`), publicToken.js (lookup JOINs the package name; sign UPDATE stores `client_signed_total = total_price` and `client_signed_snapshot = $15::jsonb`; public SELECT adds `p.client_signed_total`), crud.js (one require line + one call block after `calculateProposal`, before the UPDATE; two hunks, ~15 lines), schema.sql (two idempotent columns beside the signature block), clientPortal.js (`p.client_signed_total`), client: SignAndPaySection (`clientSignedTotal` on the pay-only note), ProposalView (passes it), ProposalDetail (Signed total row, `fmt$2dp`), PrescriptionTab (" for $X"), publicLeak.test.js FORBIDDEN_KEYS += `client_signed_snapshot`.
- Decision as built: the void fires when the row is signed, `amount_paid = 0`, status in sent/viewed/modified/accepted, and the save moves a priced term (new engine snapshot vs stored: package, guests, hours, bars, billed bartenders, add-on set by name/variant/quantity/line total, syrups, lines, override), the acknowledged total (client_signed_total, else the row total) or the venue (any structured venue key sent that differs, state compared canonical; else a free-text event_location). It clears the client_signature_* columns, the signed total/snapshot, `accepted_at` only when it equals `client_signed_at` (the sign's own stamp), moves accepted/viewed/modified back to 'sent', and writes a `signature_voided` activity row with reason + from/to status + previous {signed_name, signed_at, signature_method, document_version, signature_ip, signed_total, signed_snapshot}. Paid rows, and unpaid rows an admin forced to confirmed/completed, keep the signature (voiding the latter would leave a row the client can never re-sign). Event date/time changes do NOT void (a reschedule is its own consented flow); noted for the reviewer.
- Tests: patchGuards.test.js +4 pure cases (17/17), crud.signatureVoid.test.js (no DB, the whole PATCH over a fake pool with a flat package priced by the real engine; 4 cases; old code 2/4 fail: no void write), publicToken.signedRecord.test.js (no DB; old code 1/1 fail: no signed total in the UPDATE); DB-backed sibling publicToken.signedRecord.db.test.js written, not run.

### ESIG-05: CONFIRMED-FIXED, 97fe7dc
- Files: NEW server/utils/signedRecordEmail.js (`signedRecordFromRow`, `signedRecordBlock`, `dollarsLabel` through integer cents), server/utils/agreementVersions.js (`AGREEMENT_REVISED_DATES`, pinned against the client module's `revisedDate` in agreementVersions.test.js), emailTemplates.js `proposalSignedConfirmation({ signedRecord })`, lifecycleEmailTemplates.js `signedAndPaidClient({ signedRecord })` (both shapes), publicToken.js (post-sign read-back of the 4 signature columns; passes the record), server/utils/stripePaymentNotifications.js (SELECT +3 columns, both sends pass the record; the signed-and-paid email is what most clients get since a pending intent suppresses the sign-only one).
- Tests: signedRecordEmail.test.js (5), emailTemplates.signedRecord.test.js (3; against a `git archive HEAD` export of the old templates 2/3 fail), publicToken.signedEmail.test.js (no DB, email stubbed; old sender 1/1 fail); after all pass; emailTemplates.test.js 13/13, lifecycleEmailTemplates.test.js 8/8 unchanged.
- DEFERRED (design note): a stored proposal PDF ("Event-Specific Agreement as signed": the rows, total, version text, signer, time) rendered post-sign with pdfkit (agreementPdf.js pattern) to `proposals/<id>/signed-<ts>.pdf`, plus a token-gated `GET /api/proposals/t/:token/signed-copy` that presigns it and deliberately does NOT carry the `status <> 'archived'` filter (the record must outlive the sweep), with the portal's Prescription tab linking it. Not built: it is a new artifact pipeline (render, storage key, admin surface) beyond a minimal fix, and the stored `client_signed_snapshot` plus the email now give the client a retrievable copy.

### ESIG-09 (+AUTH-09): CONFIRMED-FIXED, dc260c7
- Files: publicToken.js (column dropped from the public SELECT; the switch's 200 shares the builder), publicLeak.test.js FORBIDDEN_KEYS += `client_signature_data`. Confirmed no client reader (only the POST body in ProposalView.js:529).
- Test: publicToken.signatureData.test.js (no DB; projects the fixture through the SELECT list the way Postgres would; old code 1/1 fail; after 1/1).

### ESIG-10: CONFIRMED-FIXED, 4e1d25b
- Files: server/data/contractorAgreement.js (`agreementVersionSha256`), server/data/contractorAgreement.test.js (byte-for-byte pin: v2 `9b27b666…6d11`, v3 `6c9dfb7b…59bc`), agreement.js (stores `signature_document_sha256` in INSERT and UPDATE), schema.sql (idempotent column beside the agreements block).
- Test: agreement.documentHash.test.js (old code 1/1 fail: no hash on the row; after 1/1); contractorAgreement.test.js 5/5.

### ESIG-11: CONFIRMED-FIXED, 10bfd8e
- Files: agreement.js (requires `version`: missing/malformed 400 naming version; known-but-not-current 409 `AGREEMENT_VERSION_STALE`, nothing written; PDF from `getAgreementVersion(saved.signature_document_version) || getCurrentAgreement()`), client/src/pages/Agreement.js (sends `version: legalText.version`).
- Test: agreement.version.test.js (3; old code 2/3 fail: stale accepted and written, missing accepted; after 3/3; the PDF renderer is wrapped to assert the version drawn).

### ESIG-08: CONFIRMED-FIXED, b39c26b
- Files: schema.sql (`agreement_signatures` CREATE TABLE IF NOT EXISTS + index, `agreements.first_signed_at`, all beside the agreements block), agreement.js (reads the prior `pdf_storage_key` under the lock, `first_signed_at = COALESCE(first_signed_at, NOW())` on UPDATE and NOW() on INSERT, history INSERT in the transaction with version/sha/method/ip/ua/time/name/email/phone/sms_consent/image/superseded key, post-commit writes the new PDF key onto the history row).
- Test: agreement.history.test.js (2; old code 2/2 fail: no history row; after 2/2).
- DEFERRED (product decision, proposed rule): refuse a re-sign of the same `CURRENT_VERSION` with 409 unless `agreements.resign_allowed_until` (set by an admin "allow re-sign" action on the staff record, cleared on sign) is in the future; a new version always allows one sign. Today re-sign stays allowed and is fully recorded.
- Note: this commit's `Claude-Session` trailer has a typo (`claude.ac`); not amended (the brief forbids `--amend`); the lane squash rewrites the message anyway.

### ESIG-04: CONFIRMED-FIXED, 57442c1
- Files: agreement.js (`sendSignedCopyEmail` shared by the sign tail and the resend; `GET /admin/:userId/pdf` and `POST /admin/:userId/resend-copy`, both `auth, requireAdminOrManager`, `parseUserId`, `assertKeyUnder(key, 'agreements/<userId>/')` from r2Proxy.js before any presign/read, the resend reading through storage.readFile, stamping `pdf_email_sent_at` only after the provider accepted and raising `ExternalServiceError` otherwise; ARCHITECTURE route table regenerated), client DocumentsSection.js (Download via the existing `/agreement/download`; "Signed" instead of "Countersigned."; header comment updated), client DocumentsTab.js (agreement entry only: Open through the existing `previewFile` + lightbox with the admin route, "Copy not emailed" + Resend when `pdf_generated_at && !pdf_email_sent_at`; a generic `{it.action}` slot added to the row loop). admin/users.js untouched (`SELECT *` already carries the columns).
- Test: agreement.download.test.js (6; old code 4/6 fail, the signer's download already existed; after 6/6: own key only, 404 without a key, 401 no token, admin 200 / staff 403, key outside the prefix or a traversal 404 with nothing presigned, malformed id 400, resend attaches the stored bytes and stamps, provider failure 502 with no stamp). No DocumentsSection sibling render test exists, so none was added.

### ESIG-14: CONFIRMED-FIXED, 7564f68
- Files: publicToken.js (sign UPDATE's status guard and its disambiguation no longer exclude 'accepted'; the unsigned predicate still gates), client checkoutVisibility.js (+ Jest case: unsigned accepted shows Sign & Pay), lifecycle.js (lock read carries the signature columns; on `archived -> draft` with a signature, `voidClientSignature(..., resetStatus: false)` inside the transaction, result row merged). Transition table unchanged.
- Tests: publicToken.acceptedUnsigned.test.js (no DB; the fake EVALUATES the UPDATE's own `status NOT IN` list and unsigned predicate; 2 cases; old code 1/2 fail), lifecycle.restoreSignature.test.js (no DB; 2; old code 1/2 fail), checkoutVisibility.test.js (Jest; old code 1/9 fail, after 9/9); DB-backed sibling publicToken.acceptedUnsigned.db.test.js written, not run.

### ESIG-07: CONFIRMED-FIXED, bd0b5d4
- Files: server/routes/payment.js (reads `w9_form_revision`/`w9_signature_method` beside the file; writes `w9_submitted_at` (NOW()), `w9_submit_ip` (proxy-validated req.ip, 45), `w9_submit_ua` (500), `w9_form_revision` (20), `w9_signature_method` (draw|type|upload, else NULL) in the same transaction as the profile, only when a NEW file arrives; a reuse keeps the stored event; nothing new logged), schema.sql (five idempotent columns beside payment_profiles), client w9Pdf.js (`W9_FORM_REVISION` shared with the PDF header line), PaydayProtocols.js (sends method + revision beside the file; 'upload' in upload mode). W9Form.js unchanged.
- Test: payment.w9Certification.test.js (no DB, real express-fileupload, hand-built multipart, trust proxy; 3; old code 3/3 fail; after 3/3; asserts nothing from inside the PDF reaches a query). Client siblings PaydayProtocols.test.js + w9Pdf.test.js 24/24.
- DEFERRED: server-side rendering of the fill-mode PDF from posted fields (the agreementPdf.js pattern; the SSN would then transit the server, which needs its own handling decision); surfacing `w9_submitted_at` in the staff `/me/documents` read (server/routes/staffPortal/accountReads.js is another lane's file); the admin DocumentsTab W-9 entry (the payouts lane edits it).

### ESIG-12: CONFIRMED-FIXED (the cheap, safe part), 97813ec
- Files: client/src/pages/Agreement.js (one statement under the pad in both modes). No test (copy only).
- DEFERRED (owner's call; exact change list): a new frozen `contractor-agreement-v4` in server/data/contractorAgreement.js = v3 plus `{ key: 'ack_esign_consent', label: 'I agree to sign this agreement electronically and to receive my signed copy by email.' }` in `acknowledgments` (v3 never edited in place; pin the new hash in contractorAgreement.test.js; bump CURRENT_VERSION); `ALTER TABLE agreements ADD COLUMN IF NOT EXISTS ack_esign_consent BOOLEAN` and the same column on `agreement_signatures`; agreement.js adds the key to the `acks` map (=== true check), to both statements and to the history INSERT; agreementPdf.js prints the line; DocumentsTab's Acknowledgments card shows it; `/api/agreement` GET projection adds it.

### ESIG-03: not touched (payments lane).

## Commits on the branch (`git log --oneline main..HEAD`)
```
97813ec fix(agreement): the staff signing page states the electronic-signature consent under the pad          [ESIG-12]
bd0b5d4 fix(payment): the electronic W-9's certification event is recorded server-side                        [ESIG-07]
7564f68 fix(proposals): an unsigned accepted row can be signed, and a restore out of archived clears a stale signature [ESIG-14]
57442c1 fix(agreement): the signed staff agreement is retrievable by the signer and the admin, and a copy that never went out can be resent [ESIG-04]
b39c26b fix(agreement): every staff sign appends to a signature history and never erases the prior record     [ESIG-08]
10bfd8e fix(agreement): the staff sign binds the version the signer rendered                                   [ESIG-11]
4e1d25b fix(agreement): the contractor agreement text is pinned by hash and the row stores the hash it was signed under [ESIG-10]
dc260c7 fix(proposals): the public proposal payload no longer carries the signature image                      [ESIG-09, AUTH-09]
97fe7dc fix(emails): the sign-time emails carry the terms as signed                                             [ESIG-05]
5dffa6f fix(proposals): the sign stores the signed configuration and an edit after the signature voids it      [ESIG-02]
907ba90 fix(signatures): a signature payload must be a bounded PNG or JPEG image or a typed name               [ESIG-06]
4d29bbd fix(agreement): signer fields are validated before the write and an acknowledgment is the boolean true [ESIG-13]
f903864 fix(agreement): the staff sign and the change-request consent record the proxy-validated ip           [ESIG-01, AUTH-08]
```

## Suites run here (final sweep, all pass)
New/changed server suites (node --test): agreement.signatureIp 3, agreement.signerFields 7, agreement.signaturePayload 5, agreement.documentHash 1, agreement.version 3, agreement.history 2, agreement.download 6, publicToken.signerName 3, publicToken.signaturePayload 4, publicToken.signedRecord 1, publicToken.signedEmail 1, publicToken.signatureData 1, publicToken.acceptedUnsigned 2, crud.signatureVoid 4, lifecycle.restoreSignature 2, patchGuards 17, payment.w9Certification 3, signaturePayload 5, signedRecordEmail 5, emailTemplates.signedRecord 3, agreementVersions 6, contractorAgreement 5.
Pure siblings beside changed files: fileValidation 10, publicSnapshot 10, clientPriceLines 13, emailTemplates 13, lifecycleEmailTemplates 8, emailTemplates.parts 13, r2Proxy 23.
Client (Jest, `CI=true react-scripts test --watchAll=false`): checkoutVisibility 9, editorCore, PaydayProtocols, w9Pdf: 4 suites, 45 tests.
eslint on every changed server file: 0 errors (warnings only, the pre-existing kinds); client eslint on every changed client file: clean (one pre-existing warning at ProposalDetail.js:327, not my hunk). `node scripts/gen-docs.js --check --staged` passed before every commit; `npm run docs` regenerated the tree (3 new source files), the schema section (4 commits) and the route table (ESIG-04).

## Suites NOT run (DB-backed, ECONNREFUSED here)
Written for the dev box: clientPortal.changeRequests.requestIp.test.js, publicToken.signedRecord.db.test.js, publicToken.acceptedUnsigned.db.test.js. Modified but not run: publicLeak.test.js (two FORBIDDEN_KEYS added). Existing DB-backed suites covering the files I changed were not run: publicToken.*.test.js (signTotal, signPhone, archived, paymentState, priceRows, additionalTime), publicSwitch.test.js, crud.test.js, crud.guards.test.js, crud.demotion.test.js, clientPortal.test.js, clientPortal.changeRequests.test.js, payment.bankMask.test.js, payment.noNameWrite.test.js, stripePaymentNotifications' webhook suites. The money smoke was not run.

## For the reviewer, first
1. crud.js is at 984 lines (ratchet refuses past 1000); my two hunks add ~15 lines. The pricing lane adds an input gate in the same file; the merge may cross 1000 and need the split the ratchet asks for.
2. server/utils/stripePaymentNotifications.js got a small hunk (3 SELECT columns, `signedRecord` on both sends). It is a webhook notifier in utils, not on the forbidden list, but the payments lane's ESIG-03 fix may touch it: expect a trivial overlap.
3. The void decision (patchGuards.js `signatureVoidReason`) compares the NEW engine snapshot with the STORED one, not the body with the row, so a respelled save never voids and any field the engine prices is covered; venue is the one body-vs-row compare. Event date/time are deliberately outside it.
4. `signatureVoid.js` moves accepted/viewed/modified back to 'sent' and clears `accepted_at` only when it equals `client_signed_at`; an admin's earlier acceptance stamp survives (pinned in both stubbed suites). The dashboard (metricsQueries `accepted_at IS NOT NULL`) stops counting a voided booking until it is re-signed, which is the intended reading.
5. The stubbed PATCH suite (crud.signatureVoid.test.js) answers ~10 statement shapes from an in-memory row; a future query added to the PATCH whose empty answer matters will surface there, by design.
6. The sign email now reads four more columns post-sign; the sign-only email is still skipped when a pending intent exists, so the signed-and-paid email (webhook) is where most clients see the block.
7. The legal-hold proposal: the sign route still carries no `isLegalHold` guard (the audit's "could not verify" item); untouched, outside my findings.
8. Soft-cap warnings only (all under 1000): publicToken.js 730, emailTemplates.js 926, lifecycleEmailTemplates.js 840, ProposalDetail.js 975, ProposalView.js 883.
9. Commit b39c26b carries a `claude.ac` typo in its session trailer (not amended).

---

# Round 2 (verify pass: 2 M, 5 L, 1 housekeeping)

Six commits on top of Round 1's thirteen, one per item (M2 and the housekeeping share one, as asked); failing test first for each, explicit paths, no push, no amend, tree clean. Old-code outputs under <scratchpad>/audit/esign-runs/ (`r2-*-old.txt`, `final-sweep-r2.txt`).

## M2 (void during an in-flight bank debit) + housekeeping: FIXED, db04254
- Definition: "unpaid" for the void is `amount_paid = 0 AND external_paid = 0 AND no processing payment on the row`. The pure half (amount_paid, external_paid) is in patchGuards.js `signatureVoidReason`; the DB half is `rowHoldsMoney(db, row, proposalId)` in signatureVoid.js, which calls the existing `findInFlightPayments` (paymentInFlight.js, the one definition of "settling") on the held transaction client. No admin-edit guard existed to reuse: the only `PAYMENT_IN_FLIGHT` refusals are the checkout rails' (`assertNoPaymentInFlight`) and the client switch's, so nothing parallel was added, the void simply keeps the signature (the paid-row behavior) when money is on the row or in flight.
- `voidSignatureIfTermsMoved(db, { proposalId, old, snapshot, body, actorId, reason })` is the one call the PATCH and the cancel-line writer share: pure reason first, the in-flight read only once a reason exists (a save that moves nothing costs no query; a paid row never reads stripe_sessions).
- Housekeeping: crud.js's hunk is a two-line comment pointing at signatureVoid.js's header plus one call; the require no longer pulls `signatureVoidReason`. crud.js: 977 lines = main (972) + 5, seven under the lane's earlier 984 (target was -4).
- Test: crud.signatureVoid.test.js +2 cases (6 total): a processing stripe_sessions row → no void, signed total retained, the in-flight read on the held client; external_paid > 0 → no void. Against a `git archive` export of the lane's committed state both fail (the void ran); after, 6/6.

## M1 (cancel-line sibling of ESIG-02): FIXED, 5fe8ad4
- server/utils/lineItemCancel.js `applyLineItemCancel`: a copy of the locked row is taken right after `SELECT ... FOR UPDATE` (before the per-kind in-memory mutations), and after the fold (step 4b) `voidSignatureIfTermsMoved(client, { old: rowBefore, snapshot, actorId, reason: 'line_item_cancelled' })` runs inside the cancel transaction; `proposal.status` follows the void so `newStatus` reports it; the result and the preview body (cancelLineItem.js `previewBody`) carry `signatureVoided` / `signature_voided`. A utils→routes require follows the existing precedent (eventDetailsPayload.js requires routes/shifts.queries).
- Kept as they are, and said in the commit: the Lab save and the drink-plan submit (the client's own additions are not an edit to the terms they signed); a paid row (the additional-services flow).
- Tests: lineItemCancel.signature.test.js (no DB, the real core over a scripted client in the pricing lane's lineItemCancel.comp.test.js pattern, unknown statements reject; 3 cases: the 1600→1500 scenario voids after the fold with 'line_item_cancelled' + the moved terms + the prior record, a paid row keeps its signature with no in-flight read, an in-flight debit and external money keep it). Old core: 3/3 fail (case 1 for the finding: no void write). DB-backed sibling lineItemCancel.signature.db.test.js (lineItemCancel.test.js's style, nonce'd package and catalog add-on, a real engine snapshot, a processing stripe_sessions row for the in-flight case): written, not run here.

## L3 + L4 (restore void): FIXED, 3399964
- lifecycle.js: the void fires on any transition OUT of archived onto a pre-payment status (draft, sent, viewed, modified, accepted; `PRE_PAYMENT_STATUSES` exported by signatureVoid.js), including a forced archived → sent/viewed, and never when the locked row holds money or a debit is in flight (`rowHoldsMoney`, the PATCH's definition; the lock read gained amount_paid and external_paid). The audit row names the transition (`archived -> sent`).
- Test: lifecycle.restoreSignature.test.js +3 cases (5 total): forced archived → sent on a money-free signed row voids; archived → draft keeps the signature under amount_paid, external_paid and a processing payment (each asserted: no void UPDATE, no signature_voided row, client_signed_at and client_signed_total retained); a forced restore onto deposit_paid keeps it. Old route: 2/5 fail.

## L5 (signed record from an unlocked read): FIXED, ffd27c6
- publicToken.js sign handler: one pooled client from `SELECT ... FOR UPDATE OF p` (with the status and signature the 409 is told apart by) through the venue gate, `signedPriceRecord` from the locked row, the UPDATE with its unchanged predicates (unsigned, signable status, total to the cent), COMMIT; the client is released before the post-commit tail (phone, 'signed' activity row, emails), which keeps using the pool; a refused UPDATE rolls back and is disambiguated from the locked row with no second read; the acknowledged_total validation moved ahead of the transaction so no throw opens one. `FOR UPDATE OF p` is valid with the LEFT JOIN (p is the non-nullable side).
- Test: publicToken.signedRecord.test.js now hands a STALE snapshot to any lookup without FOR UPDATE and records the connection per statement; old handler: 1/1 fail (stale rows in the record); after: lookup → UPDATE inside BEGIN/COMMIT on the client, release after COMMIT, the read-back on the pool, nothing on the released client. The other five stubbed sign suites pass unchanged (signerName 3, signaturePayload 4, signedEmail 1, signatureData 1, acceptedUnsigned 2).

## L6 (prior PDF key read without the lock): FIXED, 9c9f69b
- agreement.js: `SELECT id, pdf_storage_key FROM agreements WHERE user_id = $1 FOR UPDATE` inside the existing sign transaction. Residual, stated in the code: the new PDF key is written post-commit by design (a dead-link window otherwise), so a sign that lands between the first sign's COMMIT and its upload records the key before that one. Also pre-existing and out of scope: two concurrent FIRST signs (no row to lock) race on the UNIQUE(user_id) INSERT; the loser 500s on 23505.
- Test: agreement.history.test.js +1 case (3 total): the prior-row read carries FOR UPDATE, runs on the transaction client between BEGIN and the history INSERT. Old route: 1/3 fail.

## L7 (typed-name charset): FIXED, e36f8b7
- signaturePayload.js: a typed signature is a 2-120 character printable string, stored trimmed; only control characters (`\p{Cc}`) are refused. "Jane & John Doe", "Smith/Jones", "Name (jr)" now sign. Every surface prints the value as text (PDF, admin card), so nothing else needs excluding.
- Test: signaturePayload.test.js's typed case rewritten (ampersand, slash, parentheses, non-Latin scripts pass; NUL, newline, tab, ESC, DEL refused); old charset: 1/5 fail ("Jane & John Doe" refused). The two route suites posting a one-character typed name still refuse it on length (5/5, 4/4).

## Final verification (after e36f8b7)
- `node scripts/static-checks.js --base 13f2645 --tip HEAD`: findings [], blocking 0, allowed 0, files 62, eslint_files 48, exit 0.
- `node scripts/gen-docs.js --check --staged`: passed before every commit and once more on the empty index.
- Server suites (node --test), all pass, 188 tests over 30 suites: agreement.signatureIp 3, agreement.signerFields 7, agreement.signaturePayload 5, agreement.documentHash 1, agreement.version 3, agreement.history 3, agreement.download 6, publicToken.signerName 3, publicToken.signaturePayload 4, publicToken.signedRecord 1, publicToken.signedEmail 1, publicToken.signatureData 1, publicToken.acceptedUnsigned 2, crud.signatureVoid 6, lifecycle.restoreSignature 5, patchGuards 17, payment.w9Certification 3, lineItemCancel.signature 3, signaturePayload 5, signedRecordEmail 5, emailTemplates.signedRecord 3, agreementVersions 6, contractorAgreement 5, fileValidation 10, publicSnapshot 10, clientPriceLines 13, emailTemplates 13, lifecycleEmailTemplates 8, emailTemplates.parts 13, r2Proxy 23.
- Client Jest (`CI=true react-scripts test --watchAll=false`): checkoutVisibility, editorCore, PaydayProtocols, w9Pdf: 4 suites, 45 tests, all pass.
- eslint: 0 errors on every changed server file (20 files, warnings only) and every changed client file (one pre-existing warning at ProposalDetail.js:327, not my hunk).
- Not run (DB-backed): the three Round-1 DB siblings, lineItemCancel.signature.db.test.js (new), publicLeak.test.js, and the repo's existing DB-backed suites over the changed files (publicToken.*, publicSwitch, crud.*, clientPortal.*, payment.*, lineItemCancel.test.js, the webhook suites). The money smoke was not run.

## Sizes after Round 2 (soft-cap warnings only, all under 1000)
crud.js 977 (main 972), lineItemCancel.js 809, publicToken.js 751, emailTemplates.js 926, lifecycleEmailTemplates.js 840, ProposalDetail.js 975, ProposalView.js 883.

## Full commit list (`git log --oneline main..HEAD`, newest first)
```
e36f8b7 fix(signatures): a typed signature is any bounded printable string                                              [R2 L7]
9c9f69b fix(agreement): the prior agreement row is read under the row lock before the history row is written           [R2 L6]
ffd27c6 fix(proposals): the signed record is built from the row read FOR UPDATE in the sign's own transaction          [R2 L5]
3399964 fix(proposals): a restore out of archived clears a stale signature on every pre-payment status, never over money [R2 L3, L4]
5fe8ad4 fix(proposals): removing a line from a signed, money-free booking voids the signature                          [R2 M1]
db04254 fix(proposals): a signature is kept while money sits on the row or a debit is still settling                   [R2 M2 + housekeeping]
97813ec fix(agreement): the staff signing page states the electronic-signature consent under the pad                  [ESIG-12]
bd0b5d4 fix(payment): the electronic W-9's certification event is recorded server-side                                [ESIG-07]
7564f68 fix(proposals): an unsigned accepted row can be signed, and a restore out of archived clears a stale signature [ESIG-14]
57442c1 fix(agreement): the signed staff agreement is retrievable by the signer and the admin, and a copy that never went out can be resent [ESIG-04]
b39c26b fix(agreement): every staff sign appends to a signature history and never erases the prior record             [ESIG-08]
10bfd8e fix(agreement): the staff sign binds the version the signer rendered                                           [ESIG-11]
4e1d25b fix(agreement): the contractor agreement text is pinned by hash and the row stores the hash it was signed under [ESIG-10]
dc260c7 fix(proposals): the public proposal payload no longer carries the signature image                              [ESIG-09, AUTH-09]
97fe7dc fix(emails): the sign-time emails carry the terms as signed                                                     [ESIG-05]
5dffa6f fix(proposals): the sign stores the signed configuration and an edit after the signature voids it              [ESIG-02]
907ba90 fix(signatures): a signature payload must be a bounded PNG or JPEG image or a typed name                       [ESIG-06]
4d29bbd fix(agreement): signer fields are validated before the write and an acknowledgment is the boolean true         [ESIG-13]
f903864 fix(agreement): the staff sign and the change-request consent record the proxy-validated ip                   [ESIG-01, AUTH-08]
```

## For the reviewer, Round 2
1. The cancel core now requires `../routes/proposals/signatureVoid` (utils → routes, the eventDetailsPayload.js precedent). If the layering is unwanted, moving signatureVoid.js and patchGuards.js's pure guard under server/utils/ is a rename with four requires to update, left for a later pass.
2. M1's scripted client rejects unknown statements; the pricing lane's own lineItemCancel.comp.test.js (paid fixture) is unaffected: a paid row takes the pure early return before any new query.
3. The in-flight definition is `stripe_sessions.status = 'processing'` within IN_FLIGHT_MAX_AGE_DAYS (findInFlightPayments); a `pending` session (an intent minted, nothing confirmed) does not keep a signature, by the helper's own definition of "settling".
4. L5 adds a `pool.connect()` to every sign; the client is held for the lock, the venue gate, the record and one UPDATE, then released before any helper that takes its own connection runs.

---

# Round 3 (re-pass: 3 L; the lane's last fix round)

Four commits (L8 took two: the first landed without its guard wiring, see below), failing test first for each, explicit paths, no push, no amend, tree clean. Old-code outputs under <scratchpad>/audit/esign-runs/ (`r3-*-old.txt`, `final-sweep-r3.txt`).

## L8 (pending card window invisible to the money guard): FIXED, 6510c69 + a3d1861
- The sign route's own window (a pending stripe_sessions row under 30 minutes, used to skip the sign-only email) is now ONE definition in server/utils/paymentInFlight.js: `PENDING_PAYMENT_WINDOW_MINUTES = 30` and `findPendingPayments(proposalId, db = pool)` (pending sessions created within the window, the window riding as a parameter). Both callers use it: the sign email suppression in publicToken.js, and `rowHoldsMoney` in signatureVoid.js (after the processing read), so the PATCH, the cancel-line and the restore voids keep a signature while a card confirmation may be landing (the seconds before payment_intent.succeeded, a 3DS challenge). A pending row older than the window is a stale intent and counts for neither caller.
- Two commits, stated plainly: 6510c69 carries the helper, the sign-email caller and the tests; the edit wiring `rowHoldsMoney` was refused by the tooling's read-before-edit check and did not reach that commit (its message claims the wiring; the two new cases still failed on it). a3d1861 is the follow-up with the guard wiring and its own message saying so. No amend, per the rules.
- Tests: crud.signatureVoid.test.js +2 (8 total) and lineItemCancel.signature.test.js +1 (4 total): a pending session 5 minutes old → no void, signed total retained, the pending read on the held client; a pending session 45 minutes old → the void goes ahead. The recorders apply the window parameter the way Postgres would (a filter on created_at against NOW() minus the minutes param). Old guard: the within-window case fails in both suites; the stale case passes on both old and new, which is the point.
- Note: paymentInFlight.js (server/utils) gained an additive helper at its end; the payments lane may touch the file (its header says nothing else reads processing rows directly; this helper reads pending rows). lifecycle.restoreSignature.test.js's recorder answers no pending rows by default and stays 5/5.

## L9 (silent void in the cancel preview): FIXED, e54aa3b
- lineItemCancel.js `applyLineItemCancel`: `statusChanged` is now the fold's reconcile flag OR the void's move (the voided row's status against the locked row's), so the dialog's existing status line shows "sent"; the result and preview keep `signatureVoided` / `signature_voided`.
- client/src/pages/admin/CancelLineDialog.js: one line beside the status line when `preview.signature_voided` is true: "Removing this line voids the client's signature; they will be asked to sign again before paying." No Jest suite exists for the dialog, so none was extended; the file lints clean.
- Test: lineItemCancel.signature.test.js's first case asserts `result.statusChanged === true`; old core: 1/4 fail (false); after 4/4.

## L10 (invisible typed signatures): FIXED, 1848fdd
- signaturePayload.js typed rule, after trimming: control AND format characters (`[\p{Cc}\p{Cf}]`: zero-width spaces, soft hyphens, joiners) refused outright ("printable characters only"); the value must carry at least two letters or digits (`[\p{L}\p{N}]`), and a combining mark (`\p{M}`) counts only when it follows a letter, a digit or another attached mark (an orphan mark at the start or after punctuation/space is refused: "Type your full name using letters."). Ampersand, slash, parentheses, apostrophes, hyphens and spaces stay allowed (the Round-2 cases); a decomposed accent beside its base ("José") passes.
- Test: signaturePayload.test.js's typed case gains the invisible values ("​​", soft hyphens, bare and spaced combining accents, a zero-width space or word joiner inside a name, joiners) and the too-thin values ("--", "& (", ". ,", "A", "Á", "́A"), all refused, plus the decomposed-accent name and "A1" passing. Old rule: 1/5 fail ("​​" accepted); after 5/5; the two route suites posting typed signatures pass unchanged (5/5, 4/4).

## Final verification (after 1848fdd)
- `node scripts/static-checks.js --base 13f2645 --tip HEAD`: findings [], blocking 0, allowed 0, files 64, eslint_files 49, exit 0.
- `node scripts/gen-docs.js --check --staged`: passed before every commit and on the empty index.
- Server suites (node --test), all pass, 191 tests over 30 suites: agreement.signatureIp 3, signerFields 7, signaturePayload 5, documentHash 1, version 3, history 3, download 6; publicToken.signerName 3, signaturePayload 4, signedRecord 1, signedEmail 1, signatureData 1, acceptedUnsigned 2; crud.signatureVoid 8; lifecycle.restoreSignature 5; patchGuards 17; payment.w9Certification 3; lineItemCancel.signature 4; signaturePayload 5; signedRecordEmail 5; emailTemplates.signedRecord 3; agreementVersions 6; contractorAgreement 5; fileValidation 10; publicSnapshot 10; clientPriceLines 13; emailTemplates 13; lifecycleEmailTemplates 8; emailTemplates.parts 13; r2Proxy 23.
- Client Jest (`CI=true react-scripts test --watchAll=false`): checkoutVisibility, editorCore, PaydayProtocols, w9Pdf: 4 suites, 45 tests, all pass.
- eslint: 0 errors on every changed server file (21 files incl. paymentInFlight.js, warnings only) and every changed client file (11 files; one pre-existing warning at ProposalDetail.js:327, not my hunk).
- crud.js: 977 lines (main 972, +5; the Round-1 hunk's 984 is seven lines gone). Other soft-cap warnings only, all under 1000: lineItemCancel.js 813, publicToken.js 748, emailTemplates.js 926, lifecycleEmailTemplates.js 840, ProposalDetail.js 975, ProposalView.js 883.
- Tree clean (`git status --short` empty). Nothing pushed.
- Not run (DB-backed): the three Round-1 DB siblings, lineItemCancel.signature.db.test.js, publicLeak.test.js, and the repo's existing DB-backed suites over the changed files (publicToken.*, publicSwitch, crud.*, clientPortal.*, payment.*, lineItemCancel.test.js, the webhook suites). The money smoke was not run.

## Full commit list (`git log --oneline main..HEAD`, newest first; 23 commits)
```
1848fdd fix(signatures): a typed signature must carry letters, never format or orphan combining characters            [R3 L10]
e54aa3b fix(proposals): the cancel preview says a removal voids the client's signature and shows the status it sends the row to [R3 L9]
a3d1861 fix(proposals): the money guard reads the pending card window (completes round 3 L8)                          [R3 L8, follow-up]
6510c69 fix(proposals): a pending card session inside the sign window keeps the signature                             [R3 L8]
e36f8b7 fix(signatures): a typed signature is any bounded printable string                                              [R2 L7]
9c9f69b fix(agreement): the prior agreement row is read under the row lock before the history row is written           [R2 L6]
ffd27c6 fix(proposals): the signed record is built from the row read FOR UPDATE in the sign's own transaction          [R2 L5]
3399964 fix(proposals): a restore out of archived clears a stale signature on every pre-payment status, never over money [R2 L3, L4]
5fe8ad4 fix(proposals): removing a line from a signed, money-free booking voids the signature                          [R2 M1]
db04254 fix(proposals): a signature is kept while money sits on the row or a debit is still settling                   [R2 M2 + housekeeping]
97813ec fix(agreement): the staff signing page states the electronic-signature consent under the pad                  [ESIG-12]
bd0b5d4 fix(payment): the electronic W-9's certification event is recorded server-side                                [ESIG-07]
7564f68 fix(proposals): an unsigned accepted row can be signed, and a restore out of archived clears a stale signature [ESIG-14]
57442c1 fix(agreement): the signed staff agreement is retrievable by the signer and the admin, and a copy that never went out can be resent [ESIG-04]
b39c26b fix(agreement): every staff sign appends to a signature history and never erases the prior record             [ESIG-08]
10bfd8e fix(agreement): the staff sign binds the version the signer rendered                                           [ESIG-11]
4e1d25b fix(agreement): the contractor agreement text is pinned by hash and the row stores the hash it was signed under [ESIG-10]
dc260c7 fix(proposals): the public proposal payload no longer carries the signature image                              [ESIG-09, AUTH-09]
97fe7dc fix(emails): the sign-time emails carry the terms as signed                                                     [ESIG-05]
5dffa6f fix(proposals): the sign stores the signed configuration and an edit after the signature voids it              [ESIG-02]
907ba90 fix(signatures): a signature payload must be a bounded PNG or JPEG image or a typed name                       [ESIG-06]
4d29bbd fix(agreement): signer fields are validated before the write and an acknowledgment is the boolean true         [ESIG-13]
f903864 fix(agreement): the staff sign and the change-request consent record the proxy-validated ip                   [ESIG-01, AUTH-08]
```

## For the reviewer, Round 3
1. 6510c69's message overstates what it carries (the guard wiring is in a3d1861); the squash merge rewrites both anyway. If per-commit history matters, read the pair together.
2. The pending-window read runs only after the pure reason exists and the processing read came back empty, so a save that moves nothing, a paid row, and a settling debit each cost no extra query; a money-free signed row whose terms moved costs two small reads on the held client.
3. The restore (lifecycle.js) inherits the pending window through rowHoldsMoney without a code change; its stubbed suite answers no pending rows and was not given a pending case (the coordinator named the PATCH and cancel suites).

---

# Closing (fix cap reached; round 3's L8 and L10 reverted on the coordinator's confirmation read)

Three mechanical reverts, newest first, no conflicts (the third auto-merged lineItemCancel.signature.test.js cleanly): 9d652e8 reverts 1848fdd (L10), 0e6e8a4 reverts a3d1861 (L8 follow-up), 3f34e46 reverts 6510c69 (L8). e54aa3b (L9, the cancel dialog's line and the status flag) stands. `git diff e36f8b7 HEAD` on paymentInFlight.js, signatureVoid.js, publicToken.js, signaturePayload.js, signaturePayload.test.js and crud.signatureVoid.test.js is empty: the money guard is back to the verified round-2 state (amount_paid, external_paid, processing rows) and the typed-name rule to round 2's (printable, control characters refused); lineItemCancel.signature.test.js differs from the round-2 tip only by e54aa3b's statusChanged assertion. Not pushed, nothing amended, tree clean.

Why the reverts: create-intent mints a pending stripe_sessions row on every proposal page load, so round 3's L8 made rowHoldsMoney report money on the row for thirty minutes after any client view and the void was skipped silently with nothing logged (a client who views, phones in an add-on and refreshes saw the pay-only card for the old signed total over an intent for the new one), a regression of ESIG-02; and round 3's L10 refused the zero-width joiner and non-joiner (U+200C, U+200D) that Persian and Indic names legitimately carry between letters.

After the reverts: crud.signatureVoid 6/6, lineItemCancel.signature 3/3, lifecycle.restoreSignature 5/5, signaturePayload 5/5, publicToken.signaturePayload 4/4, publicToken.signerName 3/3, publicToken.signedRecord 1/1, publicToken.signedEmail 1/1, publicToken.acceptedUnsigned 2/2, agreement.signaturePayload 5/5, patchGuards 17/17; `node scripts/gen-docs.js --check --staged` clean on the empty index; eslint 0 errors on the seven touched files; `node scripts/static-checks.js --base 13f2645 --tip HEAD`: findings [], blocking 0, allowed 0, files 63, eslint_files 48. crud.js 977 lines (main 972).

## Residuals for the owner (the verifier's wording)
- (a) L8: a card deposit confirmed but not yet credited (the seconds before payment_intent.succeeded, or a 3DS challenge) is invisible to the money guard, so an admin edit in that window voids a signature the webhook then cannot restore. The proposed fix is a signal that distinguishes a confirmed intent from a minted one, which the pending row does not carry today.
- (b) L10: a typed signature of invisible characters only passes the length check. The proposed rule: require two letters or digits, refuse control characters, and allow U+200C/U+200D only between letters.

## Final commit list (`git log --oneline main..HEAD`, newest first; 26 commits)
```
3f34e46 Revert "fix(proposals): a pending card session inside the sign window keeps the signature"                   [reverts 6510c69]
0e6e8a4 Revert "fix(proposals): the money guard reads the pending card window (completes round 3 L8)"                [reverts a3d1861]
9d652e8 Revert "fix(signatures): a typed signature must carry letters, never format or orphan combining characters"  [reverts 1848fdd]
1848fdd fix(signatures): a typed signature must carry letters, never format or orphan combining characters            [R3 L10, reverted]
e54aa3b fix(proposals): the cancel preview says a removal voids the client's signature and shows the status it sends the row to [R3 L9, stands]
a3d1861 fix(proposals): the money guard reads the pending card window (completes round 3 L8)                          [R3 L8, reverted]
6510c69 fix(proposals): a pending card session inside the sign window keeps the signature                             [R3 L8, reverted]
e36f8b7 fix(signatures): a typed signature is any bounded printable string                                              [R2 L7]
9c9f69b fix(agreement): the prior agreement row is read under the row lock before the history row is written           [R2 L6]
ffd27c6 fix(proposals): the signed record is built from the row read FOR UPDATE in the sign's own transaction          [R2 L5]
3399964 fix(proposals): a restore out of archived clears a stale signature on every pre-payment status, never over money [R2 L3, L4]
5fe8ad4 fix(proposals): removing a line from a signed, money-free booking voids the signature                          [R2 M1]
db04254 fix(proposals): a signature is kept while money sits on the row or a debit is still settling                   [R2 M2 + housekeeping]
97813ec fix(agreement): the staff signing page states the electronic-signature consent under the pad                  [ESIG-12]
bd0b5d4 fix(payment): the electronic W-9's certification event is recorded server-side                                [ESIG-07]
7564f68 fix(proposals): an unsigned accepted row can be signed, and a restore out of archived clears a stale signature [ESIG-14]
57442c1 fix(agreement): the signed staff agreement is retrievable by the signer and the admin, and a copy that never went out can be resent [ESIG-04]
b39c26b fix(agreement): every staff sign appends to a signature history and never erases the prior record             [ESIG-08]
10bfd8e fix(agreement): the staff sign binds the version the signer rendered                                           [ESIG-11]
4e1d25b fix(agreement): the contractor agreement text is pinned by hash and the row stores the hash it was signed under [ESIG-10]
dc260c7 fix(proposals): the public proposal payload no longer carries the signature image                              [ESIG-09, AUTH-09]
97fe7dc fix(emails): the sign-time emails carry the terms as signed                                                     [ESIG-05]
5dffa6f fix(proposals): the sign stores the signed configuration and an edit after the signature voids it              [ESIG-02]
907ba90 fix(signatures): a signature payload must be a bounded PNG or JPEG image or a typed name                       [ESIG-06]
4d29bbd fix(agreement): signer fields are validated before the write and an acknowledgment is the boolean true         [ESIG-13]
f903864 fix(agreement): the staff sign and the change-request consent record the proxy-validated ip                   [ESIG-01, AUTH-08]
```

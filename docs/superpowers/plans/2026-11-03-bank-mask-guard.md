---
spec: none. The defect was found by the review of the Payday stop gap (2026-10-31, receipt f22a54c, verify's final pass) and confirmed in the code; the owner asked on 2026-11-03 for it to be fixed. This plan body records the design.
format: lane map without code (spec 2026-10-19 D12)
revision: 1 (2026-11-03)
status: one lane, built in one pass by Claude in its own worktree, reviewed at the tier it computes (tier A: both routes are on the sensitive list), merged through scripts/merge-lane.sh from os. The ship waits for the owner's word.
lanes:
  - id: bank-mask-guard
    scope: >
      Every screen shows a stored bank number masked, as four stars plus the last four digits
      (GET /api/payment's safeMask, GET /api/admin/users/:id). Two writers take that display value
      back and encrypt it over the real number. The admin staff page seeds its edit form with the
      masked values, and PUT /api/admin/users/:id/profile saves them on every profile edit, so an
      admin who changes a staffer's phone or rate destroys that staffer's routing and account numbers.
      POST /api/payment does the same for any client that posts the masked values back (a tab still
      running the Payday page from before 2026-10-31). Neither route checks the format of a bank
      number. This lane adds one helper both routes use: a masked value means unchanged and the
      stored number is kept in the same SQL write; a blank keeps each route's meaning today (the
      admin route clears, Payday's direct deposit refuses); any other value must pass the ABA
      routing checksum or the 4 to 17 digit account rule the staff portal route already applies,
      and is refused with a field error otherwise. The staff portal route takes its two validators
      from the helper instead of its own copies. A read-only script reports which payment
      profiles, if any, already hold a masked value where a bank number belongs (user ids and
      counts only), for the owner to run where the production key lives.
    footprint:
      - server/utils/bankNumbers.js  (new: the validators, the mask test and the resolver, with the header comment)
      - server/utils/bankNumbers.test.js  (new)
      - server/routes/staffPortal/paymentMethods.js  (the two validators imported from the helper; nothing else)
      - server/routes/payment.js  (the bank fields of POST /; nothing else)
      - server/routes/payment.bankMask.test.js  (new)
      - server/routes/admin/users.js  (the payment upsert of PUT /users/:id/profile; nothing else)
      - server/routes/admin/users.bankMask.test.js  (new)
      - server/scripts/findMaskedBankNumbers.js  (new, read-only, with the header comment)
      - README.md  (generated sections, npm run docs)
      - ARCHITECTURE.md  (generated sections, npm run docs)
    blockedBy: []
    lenses: the tier A floor (money, lifecycle, concurrency, outcomes-providers, access-egress, seams) plus whatever the review skill computes; verify; the externals; the money smoke.
    laws: bank PII stays encrypted at rest through server/utils/encryption.js and is never logged, returned unmasked or written to a test fixture in a real shape; a masked value is never encrypted and stored; the keep is done inside the UPDATE (a CASE on the current column), never as a read-then-write; a refusal is a ValidationError with a field key and no internals; POST /api/payment's other behavior (the W-9 gate, the handle COALESCE, promotion, the Stripe link after COMMIT, the non-direct-deposit methods clearing the bank columns as today) is unchanged; the admin route keeps its admin-only guard and its other fields; the script reads only and prints no bank number, masked or not.
    seams: the three writers of payment_profiles.routing_number and account_number (POST /api/payment, the admin profile PUT, the staff portal PATCH) share one validator set; the masked shape the helper recognizes is the one both GETs produce ('****' plus up to four digits, or '****' alone when a decrypt failed); the Payday page (client/src/pages/PaydayProtocols.js) already never posts a mask and needs no change; the admin Payouts tab keeps posting the masked value back, which now means unchanged.
    acceptance: >
      The reached server suites pass through run-suites (the three new suites among them), the
      money smoke passes, and each new route suite fails on main for its stated reason under the
      review skill's failing-test procedure: on main a masked value posted back is stored and the
      decrypted number afterwards is the mask.
    test plan: >
      bankNumbers.test.js: the routing checksum (a valid public routing number passes, a digit
      change fails, non-digits and wrong lengths fail), the account rule (4 and 17 digits pass, 3
      and 18 fail, non-digits fail), the mask test (four stars, four stars plus 1 to 4 digits are
      masks; plain digits, a star inside digits and four stars plus 5 digits are not), and the
      resolver (a mask keeps, a blank follows the route's rule, a valid value is encrypted and
      decrypts back, an invalid value throws a ValidationError keyed to the field).
      payment.bankMask.test.js (Stripe stubbed to null as payment.noNameWrite.test.js does): a
      staffer with direct deposit on file posts the masked values and the stored numbers decrypt
      unchanged; posts an invalid routing number and gets 400 with fieldErrors.routing_number and
      the stored numbers unchanged; posts new valid numbers and they replace the old; posts blanks
      for direct deposit and gets 400.
      users.bankMask.test.js: an admin saves a profile with a changed phone and the masked values,
      as the admin page sends them, and the stored numbers decrypt unchanged; saves new valid
      numbers and they replace the old; saves an invalid account number and gets 400 with the
      stored numbers unchanged; saves blanks and the numbers are cleared.
    revert: revert the one squash commit. Rows written while it was live hold real, valid numbers, so nothing needs repair.
---

# Bank-number mask guard: the lane map

One lane, server only. Screens show a stored bank number as four stars and its last four digits. Two writers accept that display value back and encrypt it over the real number: the admin profile save, on every edit of a staffer with direct deposit, and the Payday route, for any page that posts the masked values. The staffer and admin screens still show the same last four, so the loss is invisible until a payout needs the full number.

The fix is one server helper that both routes and the staff portal route share: a masked value means unchanged, a real value must be a valid bank number. A read-only script answers whether the loss has already happened in production, since only code holding the production encryption key can tell a stored mask from a stored number.

Out of scope: the non-direct-deposit Payday submit still clears the bank columns, as it does today (a staffer who picks another method gives up direct deposit); the staff payment import script's writes.

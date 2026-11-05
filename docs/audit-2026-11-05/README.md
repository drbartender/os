# Audit 2026-11-05: payments, payouts, auth, e-signatures, pricing

**Base:** `main` at `13f2645` (2026-11-05). **Result:** 53 findings raised by five domain audits plus two raised by the verify passes; 47 fixed on six branches (one per domain, one for the split-out comp work), 5 moved between lanes and fixed there, 1 deferred, 1 open for the owner's decision; every branch pushed; nothing merged.

**Method:** five read-only domain auditors at max effort, one per domain, each writing a report with evidence, failure scenarios in cents, proposed fixes and verification plans (`reports/`); the orchestrator triaged every finding into one of five fix lanes, cut from the same main with footprints kept apart so the lanes merge without clobbering each other; a fixer per lane re-verified each finding before touching it, wrote the failing test first, fixed at the root with every consumer, and committed through the pre-commit hook; the repo's static pre-step (`scripts/static-checks.js`: eslint, the idiom rules, the PII shapes) ran on every lane's range; the verify lens (`.claude/agents/verify.md`) then read each lane's diff adversarially, recomputing the money math by hand, and each lane got at most two fix re-passes, as the review rule allows; a reachable money defect still open after the second re-pass split its lane (`fixes/`).

This folder is the record: `README.md` (this file), `findings-register.md` (every finding, where it went, what happened to it, the commits), `reports/<domain>.md` (the five audit reports as written) and `fixes/<domain>-fixes.md` (the five fixer reports with their rounds, test evidence, reverts and residuals).

## Environment limits that shape what "verified" means here

The audit ran in a cloud container with no database, no `.env`, no provider credentials and a client `node_modules` installed without touching the lockfile. So:

- Every pure suite (stubbed pool, stubbed Stripe through the `getStripe` seam, the engine, the validators) ran here and is reported with counts; every DB-backed suite died with `ECONNREFUSED 127.0.0.1:5432` and is listed per lane as **not run**. The fixers wrote the DB-backed siblings in the neighbouring suites' style so the dev box can run them; nothing here claims a DB-backed pass.
- The money smoke (`npm run test:smoke`) and the client build gate did not run here. They run on the dev box, through the review skill and `npm run ship`, before any of this reaches `main`.
- Review receipts live in the git common dir, not in a branch, so none travels with these branches: each lane needs its own review on the dev box (`/review` on the lane) before `scripts/merge-lane.sh`.
- The primary checkout of this session sat on a non-main branch, which the repo's own pre-commit guard refuses to commit on, and the hook bypass is not permitted in this session; this folder therefore lives on its own lane branch, `audit-docs`, like the code.

## The branches

| Branch | Domain | Fixes carried | Commits | Verify outcome | State |
|---|---|---|---|---|---|
| `audit-auth` | auth | AUTH-01..07, 11, 12, 13 | 16 | full pass, two re-passes, a confirmation read; residual: one copy nuance | pushed, ready for dev-box review |
| `audit-payouts` | payouts | POUT-01..03, 05, 07..12, AUTH-10 | 20 | full pass, two re-passes, a confirmation read; the cross-period accrual rule narrowed after the first re-pass; residuals listed in the register | pushed, ready for dev-box review |
| `audit-pricing` | pricing | PRC-02, 04, 05, 06 | 6 | the four fixes passed every pass; the comp fix split out | pushed, ready for dev-box review |
| `audit-pricing-comp` | pricing (split) | PRC-01 (the extras-invoice comp), on top of the six commits above | 13 | two reachable money defects still open after the second re-pass | pushed for the owner's decision; do not merge as is |
| `audit-esign` | e-signatures | ESIG-01, 02, 04..14, AUTH-08, AUTH-09 | 26 (three are reverts of round-3 changes the confirmation read refuted) | full pass, two re-passes, a confirmation read; residuals listed in the register | pushed, ready for dev-box review |
| `audit-payments` | payments | PAY-01..09, PRC-03, ESIG-03, POUT-06 | 23 | full pass, two re-passes, a deciding read; residuals listed in the register | pushed, ready for dev-box review |
| `audit-docs` | this folder | docs only | 4 | none needed | pushed |

Every commit on every branch carries its finding id on an `Audit:` line and passed the pre-commit hook (docs check, file-size ratchet, eslint on the staged server files, the main guard), with one exception the payments fixer recorded (its first commit ran the checks by hand). The lane squash folds the checkpoint history into one `merge(lane <branch>)` commit per lane, so a checkpoint message that overstates its own content (two are noted in the fixer reports) does not survive the merge.

## How to take a lane onto the dev box

From `os` on `main`:

```bash
git fetch origin audit-payouts
```

```bash
git worktree add ../worktrees/audit-payouts audit-payouts
```

```bash
npm run worktree:new -- audit-payouts
```

(`worktree:new` on an existing worktree only refreshes the links; it cannot create one from an existing branch itself.) Then, in the lane: apply `schema.sql` to the dev database by booting the server once (the payments, payouts and e-signature lanes add idempotent columns, tables and backfills), run the DB-backed suites the lane's `fixes/<domain>-fixes.md` names under "could not run", run the review skill on the lane, and ship it with `bash scripts/merge-lane.sh ship <branch> docs/audit-2026-11-05/README.md` from `os` on `main` (the plan link is this folder). The payments, payouts and e-signature lanes touch sensitive paths and review at tier A; the gate runs the money smoke for them.

## Merge order and the overlaps between lanes

Every pair of lanes was three-way merged against each other in this session. The code never conflicts between lanes; what does:

- `ARCHITECTURE.md` between any two of `audit-payments`, `audit-payouts` and `audit-esign`: generated sections only, which `merge-lane.sh` resolves itself by regenerating.
- `server/db/schema.sql` between `audit-esign` and `audit-payouts`: both add a block right after the `payment_profiles` table (the W-9 certification columns; the document-URL backfill). Take both blocks; they are independent idempotent statements.

A working order: `audit-auth`, `audit-pricing`, `audit-payments`, `audit-payouts`, `audit-esign` (the one hand resolution lands last), `audit-docs` whenever. After `audit-payments` and `audit-payouts` are both on `main`, one small follow-up lane closes the two sites the payments lane could not reach (below).

## What the owner decides

1. **The comp model (`audit-pricing-comp`).** The original defect (PRC-01: comping a Drink Plan Extras invoice lowered `total_price` only, so the next re-price billed the waived add-on again) is real and still open on `main`. Three rounds built a protected comp line that follows the current price of the items it comps; the deciding read found two reachable money defects left (the planner pre-fills the plan with the booking's contract syrups, so a comp waives those too; a departed item re-added beside a surviving comped item is free again). Options: a new lane from the comp branch that closes those two, or the other root the auditor named (the comp removes the add-on through the cancel-line core, which already keeps `total_price`, the snapshot and `proposal_addons` together). The register has the cents.
2. **The quote wizard on a known email (AUTH-12).** A submit that resolves to an existing client now gets no token; the link is delivered only to the address on file. A returning client re-quoting with their own email reads "Check your email" instead of landing on the proposal page. The security reason is in the register; the trade is product-visible.
3. **Returning phone-only Thumbtack leads (AUTH-02).** The wizard no longer attaches a stranger to a phone-only client row, so such a lead who re-quotes on the website becomes a second row to merge by hand, and the harvester then marks that lead's harvest failed until merged.
4. **The deferred items:** POUT-13 (a local-date helper for four `ymd()` copies, or `TZ=UTC` in the start script), ESIG-05's stored proposal PDF and signed-copy route, ESIG-07's server-side W-9 rendering, ESIG-08's re-sign policy, ESIG-12's recorded e-sign consent (needs a new frozen agreement version), and the two one-line sites left raw by the payments lane (the auto-complete sweep in `balanceScheduler.js` and the gratuity funded gate in `payrollAccrual.js`, the latter in the payouts lane's file), plus a one-off look for legacy rows the old balance rail short-charged (the register's PAY-01 row).

## Checked and sound (the posture the auditors recorded)

- Payments: the money core held: webhook signature on the raw body and the test-secret gate, idempotency on the succeeded-payments unique index and `webhook_events`, the gratuity SAVEPOINT, refund scope under the row lock and the pending-row-before-Stripe protocol with its sweep, cancellation math in cents, the autopay atomic claim with its idempotency key and prior-intent guard, the bank-debit in-flight guard; the client never computes money the server trusts; the error funnel leaks nothing beyond the allowed admin-route decline reason.
- Payouts: a single payout INSERT path, a single total writer, row locks on every admin money write, cumulative markers on claw and roll-forward, the Chicago business day everywhere (law 12), bank PII encrypted and masked in every projection, no Stripe transfer path at all (staff are paid off-platform and the admin records it).
- Auth: JWTs HS-family only with role and status re-read from the row on every request and `token_version` checked for staff and clients; the 12h device JWT minted only in `webauthn.js` with DB-backed single-use challenges and an atomic counter claim; every public route behind a UUID shape guard; the R2 proxies pin a prefix; every billed or PII-speaking Twilio route fails closed; a 512-route inventory with a verdict per route is in `reports/auth.md`.
- E-signatures: the proposal sign route is the strongest piece in the domain (UUID guard, allowlisted document version, a TOCTOU-collapsing UPDATE asserting unsigned, signable status and the row total to the cent, proxy-validated IP, replay answered with 409); the staff agreement was the weaker sibling and is where most of the lane's work went.
- Pricing: the engine reproduces PRICING.md and laws 5, 6, 10 and 14 on fourteen worked examples (`reports/pricing.md`); every client-facing write prices from row truth through the one engine; `reconcileProposalPaymentStatus` follows every `total_price` write found; every server/client twin agrees.

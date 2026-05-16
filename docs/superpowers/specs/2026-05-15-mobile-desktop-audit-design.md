# Mobile + Desktop Responsiveness Audit — Design

**Date:** 2026-05-15
**Type:** Read-only audit (no code changes)
**Goal:** Comprehensive inventory (bugs + polish) of every place the app fails or degrades on mobile or desktop, across the whole codebase, using the most thorough *reliable* approach (greppable static pattern sweeps + finely-sliced runtime Playwright), dispatched as parallel agents.

---

## 1. Context & decisions

Origin: `temp/moble tester.txt` proposed a single-agent mobile/desktop review prompt. It assumed the wrong stack (Tailwind, `.tsx`) and conflated two distinct surfaces. This spec rewrites it as a parallel fleet, corrected for the real stack.

Decisions locked in during brainstorming:

- **Goal:** comprehensive inventory — bugs *and* polish, nothing filtered.
- **Mode:** most thorough — static + runtime. Token/speed not a constraint.
- **Fixing is decoupled from auditing.** Agents are strictly read-only. After all agents finish, the orchestrator merges → dedupes → triages. The user decides what to fix, in logical batches; critical/high likely now, low/polish deferred to the parked redesign.
- **Output:** per-agent files land live; orchestrator writes a merged report at the end.
- **Gated access:** user provides real tokens + dev logins at dispatch time.

### Partition: rebalanced after a self-review

The first draft was 5 static (concern-sliced) + 4 Playwright (surface-sliced) = 9 agents. A stress-test against the real codebase rejected that allocation for three reasons:

1. **`client/src/index.css` is 11,505 lines with 56 `@media` blocks.** Asking a static agent to "reason about rendered layout at 360px" over 11.5k lines of vanilla CSS is asking an LLM to mentally execute CSS cascade at scale — unreliable, will hallucinate or miss. Static's *reliable* value is **greppable anti-patterns**, not layout simulation. That collapses 5 static agents to **2 pattern-sweep agents**.
2. **`.claude/agents/ui-ux-review.md` already exists** — Playwright MCP wired in, dev-server check, viewport testing, `maxTurns: 25`, and a tuned "Common Issues in This App" list naming the exact high-risk surfaces. The runtime pass should be **multiple `ui-ux-review` invocations, route-scoped**, not hand-rolled duplicate prompts.
3. **Real responsive truth is at runtime, not in static reads.** Budget belongs on the runtime side, sliced *finer* (6 bounded agents that each fit in `maxTurns: 25`), not crammed into a few overloaded ones.

Final allocation: **2 static pattern-sweep agents + 6 runtime `ui-ux-review` agents = 8 parallel agents.** Same parallelism, far less wasted static reasoning, finer runtime coverage, built on the existing tuned agent.

### Correction kept from draft 1: QuoteWizard ≠ Potion Planning Lab

| Name | File | Route | Gating | Stage |
|---|---|---|---|---|
| **QuoteWizard** | `client/src/pages/website/quoteWizard/QuoteWizard.js` | `/quote` | public | marketing-site quote request |
| **Potion Planning Lab** | `client/src/pages/plan/PotionPlanningLab.js` | `/plan/:token` | token-gated | post-proposal client drink planning |

Separate files, routes, users, funnel stages. QuoteWizard = runtime agent R1. Potion Planning Lab = part of R2 (client money path). Both covered by static sweeps.

### Auth reality (draft 1 missed this)

- **Staff/admin login** = `client/src/pages/Login.js`, **email + password** (`type="password"`, "Forgot your password?"). Playwright **can** drive it with supplied credentials. Admin vs staff is the same `/login` form, different accounts → different post-login route trees.
- **Client portal login** = `/client-login` (`ClientLogin`), **passwordless OTP**. This is a *different* surface from staff login and is where the "OTP on mobile keyboard" concern actually lives.
  - The client-login **page itself** (email input, OTP entry UI, mobile keyboard, `autoComplete="one-time-code"`) is auditable at viewports **without completing login**.
  - Getting **past** OTP to `/my-proposals` (ClientDashboard) needs the emailed code → inbox access. Decision: audit the login page visually; ClientDashboard-behind-OTP is **static-only + flagged for manual runtime QA** unless the user supplies a logged-in Playwright storage state at dispatch.
- **Token-gated routes** (`/proposal/:token`, `/invoice/:token`, `/plan/:token`, `/shopping-list/:token`, `/tip/:token`) are **public + token** — **no login at all**, just a valid token.

### Token state matters (draft 1 missed this)

`/proposal/<tok>` and `/invoice/<tok>` render differently by DB state. The payment surface (Stripe Elements) only renders for an **UNPAID** proposal/invoice. Dispatch prerequisites therefore require an **unpaid** proposal token and an **unpaid** invoice token, or the highest-risk surface gets a blank audit.

### Stack corrections (vs. the source prompt)

- **Vanilla CSS only**, `client/src/index.css`. No Tailwind/modules/preprocessor. Responsive = `@media`. Audit `@media` coverage; never look for `sm:`/`md:`/`lg:` prefixes.
- Source files are **`.js` / `.jsx`**, never `.tsx`. React 18 (CRA), React Router 6.
- The "list the directory tree first" preamble is **struck**.

---

## 2. Fleet architecture (8 parallel agents)

### Static pattern-sweep agents (read-only, grep-driven, NOT cascade simulation)

| ID | Slug | subagent_type | Sweeps for |
|---|---|---|---|
| S1 | `static-css-patterns` | general-purpose | Fixed px widths/heights with no `@media` override, `100vh`/`100vw` (vs `dvh`), `font-size` < 16px on inputs (iOS focus-zoom), `@media` breakpoint gaps, `position:fixed/sticky` headers, `overflow` traps, viewport `<meta>` in `client/public/index.html` |
| S2 | `static-jsx-input` | general-purpose | Tap targets likely <44px, `<input>`/`<textarea>` missing/wrong `type`/`inputMode`/`autoComplete` (incl. `one-time-code` on OTP), `SignaturePad` touch/pointer support, hover-only affordances with no focus/click equivalent, drag/drop with no tap fallback, custom dropdowns/pickers |

Static agents **grep for patterns and read the matched regions** — they explicitly do **not** attempt to predict rendered layout. Pattern hits are reported as "smells correlated with responsive bugs," cross-validated by the runtime agents.

### Runtime agents (`subagent_type: ui-ux-review`, route-scoped, Playwright)

Each is the existing `ui-ux-review` agent with a dispatch prompt that **overrides**: the viewport set (360/390/414/768/1024/1440, not its default 2), the severity bar (Section 3), the route scope below, auth/token specifics, and the output target file.

| ID | Slug | Routes | Needs |
|---|---|---|---|
| R1 | `rt-quotewizard` | `/quote` (full multi-step walkthrough) | — |
| R2 | `rt-client-money` | `/plan/<PLAN_TOK>`, `/proposal/<UNPAID_PROP_TOK>` (contract signature canvas + Stripe Element), `/invoice/<UNPAID_INV_TOK>` (Stripe), `/shopping-list/<SHOP_TOK>`, `/tip/<TIP_TOK>` + `/tip/<TIP_TOK>/thanks` | tokens (unpaid prop+inv) |
| R3 | `rt-admin-core` | login as admin → `/dashboard`, `/proposals`, `/proposals/new`, `/events`, an `/events/:id`, `/financials`, `/clients` | admin email+pw |
| R4 | `rt-admin-secondary` | login as admin → `/drink-plans`, a `/drink-plans/:id`, `/settings`, `/blog`, `/email-marketing` (+ leads/campaigns/analytics/conversations sub-tabs), `/tips` | admin email+pw |
| R5 | `rt-staff-portal` | login as staff → `/dashboard`, `/shifts`, `/schedule`, `/events`, `/profile`, `/my-tip-page` | staff email+pw |
| R6 | `rt-blog-marketing-clientauth` | `/labnotes`, a `/labnotes/:slug`, `/website`, `/services`, `/method`, `/about`, `/faq`, `/classes`, `/login`, `/register`, `/forgot-password`, `/client-login` (audit the OTP page UI/keyboard at viewports; do **not** attempt to complete OTP) | — |

Slicing R3/R4 (admin) and bounding every agent's route list keeps each within `ui-ux-review`'s `maxTurns: 25` at 6 viewports. Static vs runtime finding the same root cause from two angles is **intended cross-validation**; the orchestrator dedupes at merge.

---

## 3. Severity bar (injected into every agent)

- **Critical** — a core user flow cannot be completed on a major device class (can't pay on iPhone, signature pad ignores touch, wizard "Next" off-screen at 390px).
- **High** — completable but seriously degraded (horizontal scroll on a primary page, mis-tappable control, keyboard obscures the active input).
- **Medium** — noticeable but workable (cramped layout, wrong keyboard type, non-blocking image overflow).
- **Low / polish** — cosmetic only.

The `ui-ux-review` agent's native buckets (Critical / Should Fix / Nice to Have) are explicitly remapped to this bar in the dispatch prompt.

---

## 4. Shared report template (every agent writes this)

Each agent writes `.claude/mobile-audit-2026-05-15/<slug>.md`:

```
# Mobile + Desktop Audit — <Agent Name> — 2026-05-15

## Summary
- Total issues: X  (Critical: X | High: X | Medium: X | Low: X)
- Hardest-hit areas: <list>

## Critical
### <Issue title>
- **File(s) / Route:** path:line  OR  route @ viewport
- **Device(s):** mobile / desktop / both — viewport(s)
- **What breaks:** ...
- **Repro:** ...
- **Fix direction:** one sentence (no code unless trivial)

## High
<same structure>

## Medium
<same structure>

## Low / polish
<same structure>

## Needs manual runtime QA
<not verifiable in this agent's mode — e.g. ClientDashboard behind OTP, third-party widget internals>

## Coverage
- Files / routes / viewports covered: <list>
- NOT covered (and why): <list>
```

---

## 5. Verbatim prompts

### 5.1 Shared static-agent prompt (S1, S2)

> You are a senior frontend engineer running a **READ-ONLY** static pattern sweep of the Dr. Bartender OS frontend for cross-device (mobile + desktop) problems. You do **not** modify code. Your only output is one markdown report file.
>
> **CRITICAL FRAMING:** You are detecting *greppable anti-patterns that correlate with responsive bugs*. You are **NOT** predicting rendered layout — do not claim "this overflows at 390px" unless the CSS literally sets a fixed width wider than 390 with no `@media` override. Report pattern hits as smells; the runtime agents confirm actual breakage. Stay in your lane (YOUR SWEEP below).
>
> **STACK FACTS:** Vanilla CSS only in `client/src/index.css` (11.5k lines, 56 `@media` blocks) — no Tailwind/modules/preprocessor; never look for `sm:`/`md:`/`lg:` prefixes. React 18 CRA, React Router 6. Files are `.js`/`.jsx`, never `.tsx`. Frontend under `client/src/`; API via `client/src/utils/api.js`.
>
> **VIEWPORTS OF INTEREST:** 360, 390, 414, 768, 1024, 1440 px. Use these as numeric reference points only.
>
> **SEVERITY BAR:** Critical = core flow can't complete on a device class; High = completable but seriously degraded; Medium = noticeable but workable; Low = cosmetic.
>
> **RULES:** Cite `file:line` for every hit. Be specific. Don't inflate severity. If one pattern recurs in 12 files, list it once with all paths. Anything needing a browser to confirm → "Needs manual runtime QA." Don't list the directory tree; begin immediately.
>
> **YOUR SWEEP:** _[S1 or S2 block]_
>
> **OUTPUT:** write to `.claude/mobile-audit-2026-05-15/<slug>.md` using the shared report template (reproduced in your dispatch message).

**S1 `static-css-patterns` sweep block:**
> Grep `client/src/index.css` and any inline `style=` props in `client/src/**/*.js(x)` for: fixed `width`/`min-width`/`height` in px ≥ 360 with no nearby `@media` override; `100vh`/`100vw` usage (flag as iOS Safari risk, recommend `dvh`/`-webkit-fill-available`); `font-size` < 16px applied to `input`/`textarea`/`select` (iOS focus-zoom); `position: fixed`/`sticky` headers (sticky-cover risk); `overflow: hidden/scroll` on containers that hold form content; absence of `@media (max-width: …)` rules around large fixed layouts. Inspect `client/public/index.html` for the `<meta name="viewport">` tag (presence + `width=device-width, initial-scale=1`, and whether `user-scalable=no`/`maximum-scale` is set — accessibility smell). Group the 56 `@media` blocks by breakpoint and note coverage gaps (e.g. nothing below 480px).

**S2 `static-jsx-input` sweep block:**
> Grep `client/src/**/*.js(x)` for: clickable elements (`<button>`, `onClick`, `<Link>`, role=button) with size-constraining inline styles or class patterns suggesting <44px targets; every `<input>`/`<textarea>`/`<select>` — check `type`, `inputMode`, `autoComplete` correctness (tel/email/numeric/decimal; `autoComplete="one-time-code"` on OTP entry in `ClientLogin`); `SignaturePad.js` — confirm it binds touch/pointer events, not mouse-only; hover-only affordances (`onMouseEnter`/`:hover`-driven menus/tooltips) lacking a focus/click/tap equivalent; drag/drop (`onDrag*`, `FileUpload.js`) lacking a tap fallback; custom dropdown/multiselect/date/time pickers (`TimePicker.js`, `SyrupPicker.js`, `AudienceSelector.js`, `NumberStepper.js`, `LocationInput.js`) — note any that reimplement native controls (touch-risk, manual QA flag).

### 5.2 Runtime-agent dispatch prompt (R1–R6, `subagent_type: ui-ux-review`)

Prepended to the existing `ui-ux-review` agent at dispatch:

> **OVERRIDES for this run (these supersede your default agent instructions where they conflict):**
> - **Viewports:** test every route at **360×640, 390×844, 414×896, 768×1024, 1024×768, 1440×900** — not your default two. At each: screenshot, check `document.scrollingElement.scrollWidth > clientWidth` (horizontal scroll), overlapping/cut-off content, off-screen/unreachable controls, tap targets <44px.
> - **Severity mapping:** report findings as **Critical / High / Medium / Low** per this bar — Critical = core flow can't complete on a device class; High = completable but seriously degraded; Medium = noticeable but workable; Low = cosmetic. (Map your native Critical→Critical, "Should Fix"→High/Medium by judgment, "Nice to Have"→Low.)
> - **Output:** write your full report to `.claude/mobile-audit-2026-05-15/<slug>.md` using the shared report template (reproduced below). Do not print only to chat.
> - **Read-only:** do not modify code.
> - **Scope:** only the routes in YOUR SCOPE. Confirm the dev server responds at `http://localhost:3000`; if not, stop and report.
>
> **YOUR SCOPE:** _[R1–R6 route list + auth/token specifics from the Section 2 table]_
>
> [shared report template inlined]

Per-agent scope/auth specifics (filled at dispatch from Section 2 + the tokens/creds the user supplies):
- **R1** `/quote` — no auth. Walk every wizard step, the stepper UI, back/next, final submit.
- **R2** token routes — no login; substitute the supplied **unpaid** proposal + **unpaid** invoice tokens so Stripe Elements render. Exercise the signature canvas with simulated touch and Stripe Elements at mobile viewports specifically (highest-risk).
- **R3 / R4** — log in at `/login` with supplied **admin** email+password, then the listed routes. Focus on data-dense tables + the admin drawer at mobile widths (bar manager uses a phone at events).
- **R5** — log in at `/login` with supplied **staff** email+password, then the staff portal routes.
- **R6** — no auth. For `/client-login`: audit the OTP entry page at viewports (keyboard, `one-time-code`, layout) but **do not attempt to complete OTP**; note ClientDashboard-behind-OTP as manual-QA. Auth pages: focus on mobile keyboard, input zoom, OTP. Blog: long-form reading layout at narrow widths.

---

## 6. Output & merge

- Each agent writes `.claude/mobile-audit-2026-05-15/<slug>.md` as it finishes — live visibility.
- After all 8 land, the orchestrator writes `.claude/mobile-audit-2026-05-15/MERGED.md`: deduped, grouped by severity, cross-referenced by surface, with a **"trivial / zero-risk quick-win"** bucket the user green-lights separately.
- No agent modifies code. Fixing is a separate, user-directed phase after triage.

---

## 7. Dispatch prerequisites (collected from user right before launch)

- `npm run dev` running, reachable at `http://localhost:3000`.
- **Unpaid** proposal token, **unpaid** invoice token, a plan token, a shopping-list token, a tip token (from dev DB).
- Dev-DB **admin** email + password.
- Dev-DB **staff/onboarded-user** email + password.
- *(Optional)* a Playwright storage-state for a logged-in client portal session — only if the user wants ClientDashboard (`/my-proposals`, behind OTP) runtime-audited rather than manual-QA-flagged.

Static agents (S1, S2) have **no** prerequisites — launch immediately, in parallel with whichever runtime agents are unblocked. R1 and R6 need only the dev server. R2 needs tokens. R3/R4/R5 need credentials.

---

## 8. Out of scope

- Fixing any finding (separate, user-directed phase).
- Non-responsive functional bugs unrelated to viewport/device.
- The parked redesign itself — this audit *feeds* it, doesn't design it.
- Completing client OTP login (inbox-dependent) unless a storage-state is supplied.

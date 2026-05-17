# Kebab Communication-Links Navigation Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the kebab-menu Email / Call / Text items (`mailto:` / `tel:` / `sms:`) actually invoke the OS handler when clicked, on both the Clients and Staff dashboards.

**Architecture:** Single root-cause fix in the shared `KebabMenu` component. The anchor item's own `onClick` currently calls `setOpen(false)` synchronously; React 18 flushes that state update inside the discrete `click` dispatch, unmounting the portal-rendered `<a>` before the browser runs the link's default action. A disconnected anchor never navigates, so the `mailto:`/`tel:`/`sms:` hand-off is silently cancelled. Fix = defer the menu close to the next macrotask so the anchor stays connected when the browser acts on the click. One change in `KebabMenu.js` fixes all five broken items (2 in ClientsDashboard, 3 in StaffDashboard).

**Tech Stack:** React 18 (CRA / react-scripts), Jest + @testing-library/react 13, `createPortal`.

---

## Root Cause (verified)

**Broken** — anchors rendered inside `{open && createPortal(...)}` whose own `onClick` calls `setOpen(false)`:
- `client/src/pages/admin/ClientsDashboard.js:240` (Email `mailto:`), `:246` (Call `tel:`)
- `client/src/pages/admin/StaffDashboard.js:120` (Email `mailto:`), `:126` (Call `tel:`), `:132` (Text `sms:`)

**Working reference** — plain `<a href="mailto:|tel:">` that nothing unmounts on click:
- `client/src/pages/admin/ClientDetail.js:144,149`
- `client/src/components/adminos/drawers/ClientDrawer.js:118,123`
- `client/src/pages/admin/ProposalDetail.js:314,318`

The only difference between the working and broken anchors: the broken ones get unmounted by `setOpen(false)` **inside their own click handler**. React 18 treats `click` as a discrete event and flushes the resulting state update synchronously within the event dispatch. The portal (`{open && createPortal(...)}`) returns `null`, removing the clicked `<a>` from the DOM **before** the browser runs the hyperlink's activation behavior. The browser does not run activation behavior on a disconnected element → the `mailto:`/`tel:`/`sms:` handler is never invoked → "nothing happens." Pure `onClick` kebab items (e.g. EventsDashboard) work because `item.onClick?.()` runs synchronously *before* the unmount; only the href items, whose action is the browser's *deferred* default navigation, are killed.

**Rejected alternatives** (do not implement these):
- Replace `<a>` with a button + `window.location.href = href` — regresses the deliberate `<a>` capabilities the file's own header comment calls out (native right-click "Copy email address", middle-click, native scheme dispatch).
- Stop calling `setOpen(false)` and close only via outside-click/Esc — the menu would visibly linger on screen after the mail/phone app opens (the outside `mousedown` handler already early-returns for in-menu clicks). Bad UX.
- `queueMicrotask` instead of `setTimeout` — the browser's link activation behavior runs at the end of the *same task* as the event dispatch; microtasks can drain before it. `setTimeout(…, 0)` schedules a new macrotask guaranteed to run *after* the activation behavior. This is also the exact pattern the codebase trusted before commit `f6f4e6f`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `client/src/components/adminos/KebabMenu.js` | Shared 3-dot action menu | Modify: defer the close in the **enabled-anchor** `onClick` only (not the button branch, not the disabled branch) |
| `client/src/components/adminos/KebabMenu.test.js` | Regression guard | Create: assert a clicked href anchor stays connected through the click and the menu still closes on the next tick |

No `README.md` / `ARCHITECTURE.md` / `CLAUDE.md` updates required: no new file, route, env var, npm script, integration, or schema change — this is an in-place logic fix to an existing component.

---

### Task 1: Regression test (red)

**Files:**
- Test: `client/src/components/adminos/KebabMenu.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `client/src/components/adminos/KebabMenu.test.js`:

```js
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import KebabMenu from './KebabMenu';

// Repro for the kebab comm-link bug: a portal-rendered <a mailto:/tel:/sms:>
// must stay connected to the document through the click, because the browser
// runs the link's OS hand-off as the click's default action AFTER the
// (discrete) React event dispatch. If the menu unmounts the anchor
// synchronously in its own onClick, the hand-off is silently cancelled.
describe('KebabMenu — communication href items', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  function openMenu() {
    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
  }

  test('clicked mailto anchor survives the click, then the menu closes', () => {
    render(
      <KebabMenu items={[{ label: 'Email', icon: 'mail', href: 'mailto:test@example.com' }]} />
    );

    openMenu();

    const emailLink = screen.getByRole('menuitem', { name: /email/i });
    expect(emailLink.tagName).toBe('A');
    expect(emailLink.getAttribute('href')).toBe('mailto:test@example.com');

    // After the click the anchor must STILL be in the DOM so the browser can
    // perform the mailto: hand-off. The buggy code unmounts it here.
    fireEvent.click(emailLink);
    expect(emailLink.isConnected).toBe(true);

    // The close is deferred, not skipped — it still happens on the next tick.
    act(() => {
      jest.runAllTimers();
    });
    expect(screen.queryByRole('menuitem', { name: /email/i })).toBeNull();
  });

  test('tel: and sms: anchors also survive the click', () => {
    render(
      <KebabMenu
        items={[
          { label: 'Call', icon: 'phone', href: 'tel:5551234567' },
          { label: 'Text', icon: 'chat', href: 'sms:5551234567' },
        ]}
      />
    );

    openMenu();
    const callLink = screen.getByRole('menuitem', { name: /call/i });
    fireEvent.click(callLink);
    expect(callLink.isConnected).toBe(true);
    act(() => {
      jest.runAllTimers();
    });

    openMenu();
    const textLink = screen.getByRole('menuitem', { name: /text/i });
    fireEvent.click(textLink);
    expect(textLink.isConnected).toBe(true);
  });

  test('non-href (onClick) items still fire and still close synchronously', () => {
    const onClick = jest.fn();
    render(<KebabMenu items={[{ label: 'View', icon: 'eye', onClick }]} />);

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /view/i }));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menuitem', { name: /view/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails on the right assertion**

Run (PowerShell, from repo root):

```
npm --prefix client test -- --watchAll=false --testPathPattern KebabMenu
```

Expected: the first two tests **FAIL** at `expect(emailLink.isConnected).toBe(true)` / `expect(callLink.isConnected).toBe(true)` with `Expected: true / Received: false` (the synchronous `setOpen(false)` unmounted the portal). The third test (`onClick` items) **PASSES** — proving the suite and harness are wired correctly and the fix must not regress button items.

- [ ] **Step 3: Commit the red test**

```
git add client/src/components/adminos/KebabMenu.test.js
git commit -m "test(admin): failing repro — kebab comm-link anchors unmount before navigation"
```

---

### Task 2: Defer the menu close on enabled-anchor activation (green)

**Files:**
- Modify: `client/src/components/adminos/KebabMenu.js` — the enabled-anchor `onClick` (currently lines 129–132, inside the `return ( <a … > )` block at ~123–137)

- [ ] **Step 1: Apply the fix**

In `client/src/components/adminos/KebabMenu.js`, replace this exact block (the enabled-anchor `onClick`):

```js
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                  }}
```

with:

```js
                  onClick={(e) => {
                    // Do NOT unmount this anchor synchronously. A click on an
                    // <a mailto:/tel:/sms:> performs its OS hand-off as the
                    // click's DEFAULT ACTION, which the browser runs after the
                    // discrete event dispatch. React 18 flushes setOpen inside
                    // that dispatch, so an un-deferred close removes this <a>
                    // from the DOM before the hand-off and the browser
                    // silently cancels it (a disconnected anchor never
                    // navigates). Defer the close one macrotask so the anchor
                    // is still connected when the browser acts on the click.
                    e.stopPropagation();
                    setTimeout(() => setOpen(false), 0);
                  }}
```

Do **not** touch the disabled-href button branch (lines ~106–121) or the plain non-href button branch (lines ~140–155) — those run their action synchronously and must keep closing synchronously (covered by test 3).

- [ ] **Step 2: Run the tests, verify all pass**

Run:

```
npm --prefix client test -- --watchAll=false --testPathPattern KebabMenu
```

Expected: **all three tests PASS.** Anchors stay connected through the click; the menu still closes after `jest.runAllTimers()`; `onClick` items still fire and close synchronously.

- [ ] **Step 3: Lint-gate the client change (Vercel CI parity)**

The local pre-commit hook skips `client/`; client lint is only enforced by Vercel CI. Verify before committing:

```
$env:CI='true'; npm --prefix client run build
```

Expected: build succeeds, no ESLint errors (`no-unused-vars`, `jsx-a11y/anchor-is-valid`, etc.). The `<a>` still has a valid `href`, so `anchor-is-valid` stays satisfied.

- [ ] **Step 4: Commit the fix**

```
git add client/src/components/adminos/KebabMenu.js
git commit -m "fix(admin): defer kebab menu close so mailto/tel/sms anchors navigate"
```

---

### Task 3: Manual browser verification (the unit test cannot exercise the real OS hand-off)

**Files:** none — manual.

- [ ] **Step 1: Run the app**

Dev server is the Claude-managed background process on `:5000` (client proxied). If not already running, start it. Confirm the build is on the committed fix.

- [ ] **Step 2: Clients dashboard**

Navigate to the Clients dashboard. On a client row **with an email and a phone**, open the kebab (⋮):
- Click **Email** → the OS default mail client / `mailto:` handler opens, addressed to the client.
- Reopen kebab → click **Call** → the `tel:` handler opens (or browser prompts to call) with the 10-digit number.
- Confirm the menu closes right after (a tick later), not before the hand-off.

- [ ] **Step 3: Staff dashboard**

Navigate to the Staff dashboard. On a staff row **with an email and a phone**, open the kebab:
- **Email** → `mailto:` opens.
- **Call** → `tel:` opens.
- **Text** → `sms:` opens.

- [ ] **Step 4: Disabled-state sanity**

Find (or temporarily inspect) a row missing email/phone — the corresponding item is greyed out, clicking it does nothing and leaves the menu open. Unchanged behavior.

- [ ] **Step 5: Done**

All five items hand off correctly on both dashboards; disabled items unchanged; `onClick` items (New Proposal, Open Full Page, Assign Staff, etc.) unchanged. No code change in this task — the fix already shipped in Task 2's commit.

---

## Self-Review

**Spec coverage:** The reported defect ("email, sms, call from kebab don't function") maps to the five `href` kebab items in ClientsDashboard + StaffDashboard, all flowing through the one enabled-anchor `onClick` in `KebabMenu.js`. Task 2 fixes that single code path → all five fixed. Task 1 guards `mailto:`/`tel:`/`sms:` and the `onClick`-still-closes invariant. Task 3 covers the real-browser OS hand-off the unit test can't reach. No gaps.

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". All code blocks are complete and copy-pasteable; all commands have expected output.

**Type/identity consistency:** Test references match the component's real API (`items` prop with `label`/`icon`/`href`/`onClick`/`disabled`; trigger `button` titled "More actions" → accessible name `/more actions/i`; items have `role="menuitem"`). The replaced `onClick` block is quoted verbatim from the current file so the edit applies cleanly. Fix touches only the enabled-anchor branch; disabled-button and plain-button branches explicitly untouched and regression-guarded by test 3.

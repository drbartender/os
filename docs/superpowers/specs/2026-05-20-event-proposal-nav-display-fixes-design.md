# Event & Proposal Navigation/Display Fixes — Design

**Date:** 2026-05-20
**Status:** Design approved, ready for implementation planning

## Overview

Four bugs and feature gaps on the admin Event and Proposal screens, batched
because they are all small, independent navigation and display fixes. Two are
genuine bugs (a drawer back-navigation loop and a payment-terms display
contradiction); two are feature parity (a Google Maps link and a clickable
client name).

The work is one new component plus changes to six existing files, all
client-side. There are no server, schema, or API changes, and the payment fix
changes display logic only, never money math.

## Scope

In scope:

1. Fix drawer history pollution that causes a back-navigation loop.
2. Link event addresses to Google Maps on three admin pages.
3. Make the client name clickable on the admin Proposal detail page.
4. Make the public proposal Payment Terms box honor the full-payment-required policy.

Out of scope:

- Public and client-facing address displays (proposal view, invoice page) stay
  plain text.
- The post-deposit autopay card copy ("balance will be charged on [date]")
  reading stale when an autopay balance date is overdue. That is a different
  proposal state, and the autopay scheduler still charges correctly. Cosmetic
  and rare; a separate fix if it ever matters.
- Server-side payment-policy changes. The reported scenario in fix 4 is covered
  entirely by the existing `full_payment_required` flag, because balance-due
  dates almost always use the default (14 days before the event), which is
  exactly when the flag flips.
- Dateless manual proposals (follow-up, deferred 2026-05-21). The manual create
  route does not require an `event_date`, so a proposal can be saved as a draft
  with no date and later sent. With no date, `getBookingWindow` returns
  `full_payment_required: false` and the rule silently does not fire. Closing it
  would need a server-side guard requiring `event_date` before a proposal can
  move to `sent`. Tracked as a follow-up, not addressed here.

## Shared component: AddressLink

New file: `client/src/components/adminos/AddressLink.js`

A small presentational component that renders an address as a Google Maps link.

Props:

- `address` (string): the address text.
- `fallback` (string, default `'—'`): what to render when `address` is empty.

Behavior:

- When `address` is non-empty: renders an anchor to
  `https://www.google.com/maps/search/?api=1&query=<encodeURIComponent(address)>`
  with `target="_blank"` and `rel="noopener noreferrer"`.
- When `address` is empty or falsy: renders `fallback`.
- The anchor calls `e.stopPropagation()` on click as a defensive guard, so a
  link click does not bubble to a clickable parent container.
- Link styling is subtle and inherits the surrounding text color, with an
  underline on hover.

Rationale: the Maps-link behavior is used in three places. A single component
keeps it consistent and maintained in one place.

## Fix 1: Drawer back-navigation loop

### Root cause

`client/src/hooks/useDrawerParam.js` syncs drawer state to the URL via
`?drawer=<kind>&drawerId=<id>`. Both `open` (line 24) and `close` (line 31)
call `setParams(next, { replace: false })`, which pushes a new browser-history
entry every time a drawer opens and every time it closes.

Opening and closing a drawer therefore stacks alternating history entries
(`/events/5`, `/events/5?drawer=shift`, `/events/5`, `/events/5?drawer=shift`,
and so on). The Back button (`BackButton.js:13`, `navigate(-1)`) walks that
stack one entry at a time, so every other Back press re-opens a drawer instead
of returning to the previous page. If an Invoices drawer was opened earlier on
the Events dashboard, a Back press can also land on `/events?drawer=invoices`,
re-opening that drawer on the list page.

### Fix

In `useDrawerParam.js`, change `setParams(next, { replace: false })` to
`replace: true` in both `open` and `close`. Add a comment explaining the choice
so it is not reverted later.

Drawer state becomes pure page state and never creates history entries. The
three drawer consumers (EventDetailPage, EventsDashboard, ClientsDashboard)
inherit the fix with no edits of their own.

Tradeoff (accepted): the browser's native Back button no longer closes an open
drawer; it leaves the page. Drawers still close via their X button, Esc, and
scrim click.

### Verification

On an event page, open and close the Staffing shift drawer two or three times,
then click Back once. It should land on the Events list immediately. Repeat
after opening the Invoices drawer on the Events dashboard.

## Fix 2: Event address links to Google Maps

### Current state

The event address (`event_location`, or `location` on the dashboard query)
renders as plain text on three admin pages.

### Fix

Use the `AddressLink` component at:

- `client/src/pages/admin/EventDetailPage.js:218`: extract `event_location`
  from the concatenated identity-bar line into
  `<AddressLink address={proposal.event_location} />`, keeping the ` · `
  separator.
- `client/src/pages/admin/EventsDashboard.js:414`: the table cell becomes
  `<AddressLink address={e.location} />`.
- `client/src/pages/admin/ProposalDetail.js:339`: the Event card's Location
  `<dd>` becomes `<AddressLink address={proposal.event_location} />`.

`event_location` is a server-composed string (venue name, street, city, state,
zip). It works directly as a Maps search query.

### Verification

On each of the three pages, click an address. Google Maps opens in a new tab
with the address pre-searched. An event with no address shows the `'—'`
placeholder.

## Fix 3: Clickable client name on the Proposal detail page

### Current state

On `client/src/pages/admin/EventDetailPage.js:196-205`, the event's client name
in the H1 is a button (class `event-client-link`) that navigates to
`/clients/:id`. On `client/src/pages/admin/ProposalDetail.js:237-239`, the
proposal's H1 client name is plain text.

### Fix

In `ProposalDetail.js`, wrap the H1 client name in the same conditional pattern:
when `proposal.client_id` exists, render
`<button type="button" className="event-client-link" onClick={() => navigate(`/clients/${proposal.client_id}`)} title="Open client">`.
When there is no `client_id`, keep the existing `Proposal #{id}` fallback.

`navigate` is already imported on the page, and the `event-client-link` CSS
class already exists. The separate "Open client" button in the Client card
(`ProposalDetail.js:301-306`) stays as-is; this fix adds the title link, it does
not remove anything.

### Verification

Open a proposal with a linked client and click the title; it navigates to that
client's detail page. A proposal with no client shows `Proposal #<id>` as plain
text.

## Fix 4: Payment Terms box honors full-payment-required

### Root cause

The public proposal view has two payment surfaces:

- The Sign-and-Pay widget honors `proposal.payment_policy.full_payment_required`
  (server-computed; true when the event is 14 days out or less) and correctly
  locks the client to paying in full.
- The "Payment Terms" box in
  `client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js:159-175`
  is hardcoded to always render three rows (Deposit Due at Signing, Remaining
  Balance, Balance Due By [date]) and never checks the policy.

When an event is inside the 14-day window, the widget says "pay in full" while
the Payment Terms box still advertises a $100 deposit and a balance-due date
that has already passed. The two surfaces contradict each other.

The 14-day full-payment window is the same 14 days used as the default
balance-due offset, so for proposals on the default date,
`full_payment_required` flips true at exactly the moment the balance-due date
passes.

### Fix

- `client/src/pages/proposal/proposalView/ProposalView.js`: pass the
  already-computed `fullPaymentRequired` value (line 314) as a prop to
  `<ProposalPricingBreakdown>`, mirroring how it is already passed to
  `<SignAndPaySection>`.
- `client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js`: accept
  the `fullPaymentRequired` prop. In the Payment Terms section (lines 159-175),
  when `fullPaymentRequired` is true, render a single row (label "Full Payment
  Due", value `fmt(snapshot.total)`) using the existing payment-row styles,
  instead of the Deposit / Remaining Balance / Balance Due By split. When false,
  render the existing three rows unchanged.

Both payment surfaces then read the same server flag and cannot disagree.

This covers manually-created (admin cockpit) proposals as well as wizard-created
ones. Both are served by the same `GET /proposals/t/:token` route and rendered
by the same `ProposalView` / `ProposalPricingBreakdown`, and
`payment_policy.full_payment_required` is computed from the event date with no
branching on how the proposal was created, so no manual-proposal-specific change
is needed.

### Verification

- View a public proposal whose event is 14 days out or less: the Payment Terms
  box shows one "Full Payment Due" row with the total, matching the pay widget.
- View a public proposal whose event is more than 14 days out: the Payment
  Terms box still shows the three-row deposit, balance, and date split.

## Files touched

New:

- `client/src/components/adminos/AddressLink.js`

Modified:

- `client/src/hooks/useDrawerParam.js`
- `client/src/pages/admin/EventDetailPage.js`
- `client/src/pages/admin/EventsDashboard.js`
- `client/src/pages/admin/ProposalDetail.js`
- `client/src/pages/proposal/proposalView/ProposalView.js`
- `client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js`

Docs:

- `README.md`: add `AddressLink` to the components folder tree.

## Implementation order

The `AddressLink` component must exist before fix 2 consumes it. Otherwise all
four fixes are independent and can be done in any order.

## Verification approach

All verification is manual and in-app. This codebase has no UI test suite; it
relies on manual checks plus the pre-push review agents. Each fix's verification
steps are listed in its section above.

## Risk

Low. All changes are client-side. Fix 4 changes display logic only and does not
touch pricing or payment math. Fix 1 changes one hook that three pages depend
on; the behavior change (drawers no longer push history entries) is uniform and
intended across all three.

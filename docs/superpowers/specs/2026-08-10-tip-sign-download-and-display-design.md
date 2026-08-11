# Tip sign: redesign, download, and display mode

Date: 2026-08-10
Status: approved (section-by-section with Dallas)

## Why

The staff tip card has three problems at once.

It never printed. A global `@media print` rule in `index.css` hid every element
on the page and re-showed only `.invoice-page`, so the print tip card page sent a
blank white sheet to the printer. That rule predates the feature, so the flow has
never worked in production. The scoping fix is already applied and verified; the
rest of this document assumes it stays.

Printing is the wrong verb anyway. Bartenders take these to a photo counter at
Walmart or CVS, and those counters want an image file, not a PDF.

And the artwork itself is tired: a headshot placeholder that literally prints the
words "Your Headshot, upload at sign-up", a footer clipped off the bottom edge, a
decorative divider that renders at zero height, and a payment panel that competes
with the QR for attention.

## What we are building

Three lanes, built in this order:

1. Redesigned sign artwork (from the Apothecary design system project)
2. Download with a file-type choice, replacing the print flow
3. Display mode, the same sign shown full screen on a phone or tablet

They share one thing, the sign layout component, which is why they belong in one
spec.

## The sign

**Direction.** Dark chalkboard background with a large white QR plate. The plate
is the brightest thing on the sign, so both the eye and the phone camera land on
it immediately in dim bar light. This also makes display-mode letterboxing
invisible: a 2:3 sign scaled onto a tall phone leaves bands above and below, and
when the sign background and page background are the same chalkboard, the seam
does not exist.

**Content.** The bartender's first name, the QR, one short instruction, and a
small row of payment-method marks so nobody stalls wondering whether their method
works. Nothing else.

**Cut.** The headshot and its frame, the bordered payment panel, and the second
decorative rule.

**Constraints the layout has to survive.**

- Payment marks are dynamic. A bartender may have all of them or one. The row has
  to look right at any count, and the row hides entirely when there are none.
- Nothing essential near the outer edges. Photo prints get trimmed, and the sign
  gets picked up and handled.
- Names vary in length. The QR is a fixed square.

**Sizes.** 4x6 at 600x900px and 5x7 at 750x1050px, both authored at 150 DPI of
their real print size. The business card stays 525x300px per side.

**Mark order on the sign is fixed and curated.** The bartender's saved
`tip_card_order` governs the post-scan chooser page, which is where their
preference actually matters. It does not reorder the sign. The tip-card screen's
reorder copy is corrected to claim only the chooser page.

**No Zelle mark.** Zelle is available on the chooser page but never appears on the
sign.

## Download page

Stays a dedicated page rather than folding into `TipCardPage.js`, which is already
696 lines and owns the reordering UI. The portal button becomes "Download your
sign". The existing `/my-tip-page/print` path redirects so bookmarks survive.

The page shows a live preview, then:

**Bar sign**, one row per size, three buttons each:

- 4 x 6: JPG, PNG, PDF
- 5 x 7: JPG, PNG, PDF

**Hand-out cards**: one PDF button, two pages, front and back.

Nothing to configure and nothing remembered between visits. A bartender who wants
a JPG of the 5x7 taps exactly one thing.

**The business card is PDF only, deliberately.** Photo counters print 4x6 and 5x7
from an image, one image per print, and will not produce a two-sided 3.5x2.
Business cards come from Vistaprint, Staples, or an office printer, all of which
want a PDF where front and back are pages 1 and 2. Offering JPG here would mean
handing down two files and inviting mis-ordered prints. The picker says why in one
line rather than showing disabled options.

**One render path.** The layout component renders off-screen at full size,
html2canvas captures at `scale: 2`, and that single canvas becomes the JPG, the
PNG, or gets placed into a jsPDF page sized exactly 4x6, 5x7, or 3.5x2. Because
the layouts are authored at 150 DPI, `scale: 2` lands on exactly 300 DPI. This is
the pattern `client/src/components/MenuPNG/MenuPNG.jsx` already uses.

Filenames follow `Tip Sign 4x6 - Marcus.jpg`, sanitized the same way MenuPNG
sanitizes.

**The QR renders to canvas, not inline SVG.** html2canvas is less reliable with
inline SVG, and a QR that looks right on screen but fails to scan on paper is a
defect that reaches a bartender before it reaches us.

## Display mode

Public route at `/tip/:token/display`, on the guest-facing tip page. No login, so
it survives a portal session expiring mid-shift and can be bookmarked on a venue
tablet the bartender does not own. The portal button opens it in a new tab.

It renders the same 4x6 sign layout scaled to fit the viewport, centered,
chalkboard bleeding to the edges. Same component as the download, so the tablet
and the printed sign cannot drift apart.

**Fullscreen needs a gesture.** A page cannot go fullscreen on load. So the page
opens already filling the viewport with the sign plus one line at the bottom: tap
to go full screen and stay awake, and plug in for a long shift. That tap is the
gesture, and it buys the Fullscreen request and the Wake Lock in one motion. After
the tap, nothing is on screen but the sign.

**Wake lock is re-acquired, not assumed.** It drops silently whenever the tab is
backgrounded or the device locks, so it is re-requested on visibility change.

**Exit** is Escape, or a small corner control that fades to near-invisible a few
seconds after the last touch.

**Unsupported fallback** (in practice an iPhone older than iOS 16.4): one line
telling them to set the device's auto-lock to Never. No muted-video wake hack. It
burns battery and fails quietly, and a quiet failure on a bar top is a dark screen
nobody notices for an hour.

## Shared data shape

The download page reads `/me/tip-page`, which returns raw handles that the browser
turns into marks via `buildTipCardMarks`. Display mode reads the public tip
endpoint, which returns a server-computed `methods` array from
`computeOrderedMethods` (currently private to `server/routes/publicTip.js`).

Two derivations of the same fact will drift, and the whole point of display mode is
that it shows the same artwork as the download.

Fix: extract `computeOrderedMethods` into a shared server util, and have
`/me/tip-page` return the same `methods` array. The sign component takes that one
shape from both routes and applies its own curated mark order.

## Code changes

- `client/src/pages/staff/PrintTipCard.layouts.jsx` (656 lines, yellow zone) is
  rewritten by the redesign anyway, so it splits into a small folder: the sign, the
  business card, and the shared payment marks.
- The print CSS on the tip-card page goes with the print flow. The `index.css`
  scoping fix stays, since it protects the invoice and any future print surface.
- Server: extract the ordered-methods helper, extend `/me/tip-page`.
- No schema changes.

## Closed by this work, no separate task

- Footer clipped off the bottom edge of the 4x6 and 5x7
- Decorative divider rendering at zero height
- Headshot placeholder printing on the sign

## Explicitly out of scope

- Anything multi-bartender. Signs are per-bartender, settled.
- NFC tags, host-consent gating, and the review funnel. Parked with the 8/07
  research.
- Changing what the post-scan chooser page shows or how it orders methods.

## Verification gates

1. **Physical.** Print one at real size, scan it with an actual phone. A QR that
   only works on screen is not done.
2. **QR correctness.** Assert the encoded value is exactly the signed-in
   bartender's tip URL. A wrong QR routes someone else's money.
3. **Unit.** Mark availability and ordering helper; filename sanitizing.
4. **Browser.** Wake lock re-acquires after the tab is backgrounded and restored;
   display mode renders correctly at phone and tablet aspect ratios.
5. **Regression.** Invoice printing still works, since this work touches the print
   CSS that both surfaces share.

## Dependency

Sign and business card artwork comes from the Dr. Bartender Apothecary Design
System project on claude.ai/design (`e8719940-ff6f-4eb0-a39d-473d9a0591a8`), pulled
back via DesignSync. Lane 1 is blocked until that lands. Lanes 2 and 3 can be built
against the existing layouts and re-pointed at the new ones.

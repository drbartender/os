# Tip sign + hand-out card — design artifact

**Design project:** `26df46bd-cd50-4b43-9a33-9c5c75c18cd0`
**File:** `Tip Sign & Card.dc.html`
**Snapshot taken:** 2026-08-14 (the version the designer marked "Final — locked Aug 14, 2026")
**Built by:** lane `tip-e-redesign`

Pull the live file with DesignSync (`get_file`, path `Tip Sign & Card.dc.html`). This
note is the provenance record; the design project is the source of truth for the
visual system, and the implementation below is the build against it.

## What the build takes from the artifact, verbatim

- Dark chalkboard ground, flat to every edge, with a soft teal wash under the plate.
- Brand lockup LEADS the sign at real size (108px mark + 54px wordmark).
- Cream (`#EDE6D6`) QR plate, not white.
- Copy: "No cash? No problem." in brass over "Every scan goes straight to me."
- Payment marks untiled, straight on the ground, in each brand's dark-background
  artwork. No chips, nothing recoloured by us.
- Card is PORTRAIT 2 × 3.5in, native 300 DPI, with print bleed and a safe zone,
  and its elements are absolutely positioned so a missing rail never recentres
  the stack.
- Faux small caps for the name on the card: first letter full size, rest
  uppercase at 73%, stepping down until it fits without wrapping.
- The phone gets its OWN native layout rather than a scaled 5 × 7.

## Where the build deliberately departs, and why

Three departures, all functional rather than aesthetic. Each was measured, not
assumed.

**1. No bleed on the sign.** The artboard was 787.5 × 1087.5 (5.25 × 7.25in).
Bleed assumes a press that trims to marks; a photo counter prints an image at a
named size and never trims, so that file uploaded as a "5 × 7" comes back
cropped or letterboxed (aspect 1.381 vs 1.400) with the bleed area printed. The
sign is exactly 750 × 1050 and keeps the content inset the bleed was reaching
for. The card KEEPS its bleed, because it genuinely does go to a press.

**2. Quiet zones enlarged on both surfaces.** The artifact moved the quiet zone
from inside the SVG to the plate band, which is fine, but the bands were under
spec. Our tip URL is 37 × 37 modules at level Q:

| surface | artifact | modules | build | modules |
|---|---|---|---|---|
| sign | 370 plate / 26 pad | 3.03 | 388 plate / 35 pad | 4.07 |
| card | 420 plate / 30 pad | 3.08 | 420 plate / 39 pad | 4.22 |

The sign grew its plate so the code kept its size (it has to scan across a bar
top). The card shrank its code instead, since it is read in the hand at ~11in
and had the margin to spare.

**3. Marks: one credit cue, not three, and the cue yields to a real handle.**
The artifact's mock defines a card-networks-first order for the sign but renders
the P2P-first order for every surface, so its stated intent and its output
disagree. The build implements the stated intent with two refinements. First,
Visa alone carries the credit cue; Mastercard and Amex become filler that
expands only into slots the wallets and the bartender's real P2P handles leave.
Second, selection and display order are separate decisions: under the sign's cap
of five, every generic network mark gives way to a rail that actually routes
money to this bartender, so someone running Venmo, Cash App and PayPal shows all
three rather than losing PayPal to a Visa logo. Nothing is lost by it, because
Apple Pay and Google Pay already say cards are accepted. A Stripe-only bartender
still lands on the full five-mark wallet + network rail the artifact specifies as
the floor.

**4. Sign mark gap 30, not 36.** A consequence of departure 3, measured. The
widest real rail is the three-handle bartender at 476.8px of marks; at the
design's 36px gap that rail is 620.8px wide inside the 606px the print inset
leaves, so it overflowed onto the frame lip. At 30 it is 596.8px with ~9px to
spare, and every narrower combination gains margin. The marks keep their
designed height; only the space between them moved.

**5. Card name box 480 wide, not 440, with a height budget behind it.** The
artifact caps the name at 440 inside a 600 trim, which nothing else on the card
aligns to (the QR plate above is 420, i.e. 90px insets). 480 still clears the
37.5px bleed by 22.5px a side, and the width is the cheapest lever on how many
lines a long name takes. Behind it, the fit is budgeted on HEIGHT rather than a
line count, because only height converges: `display_name` is `VARCHAR(255)` with
no length check on either side of the wire, and a 255-character value bottomed
out at the size floor still 12 lines tall, printing through the reason line
above it. Lines grow linearly with type size while total height grows with its
square, so shrinking always wins; measured, a 255-character name now lands at
12px with 9px of clearance, and a realistic 90-character one at 24px with 23px.

## Corrections made against the artifact after the first build

These are NOT departures. The first build drifted from the artifact and the
`ui-ux-review` pass caught it; the artifact won each time.

- Brand wordmarks are white (`#FFFFFF`), not the sheet's cream. Cream was our
  recolour of six brands' published dark-background artwork.
- Amex renders as its own filled blue badge, not an outlined cream chip. The
  chip was both a recolour and the only bordered mark on either sheet, which is
  the tile vocabulary the artifact rejects.
- The card's QR plate carries no glow. Only the sign and phone plates do.
- The phone name steps down like the other two surfaces instead of riding a raw
  `vw` size, and the phone lockup uses the artifact's 0.08em tracking.

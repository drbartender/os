# Bar menu designer, on the event page: design brief (v3)

**Design inside:** the Dr. Bartender OS Design System project. This is a section of the admin app's event page, not a standalone page. Build it from the system's own components (StatusChip, Icon, Drawer, Toolbar, buttons) and show both skins, House Lights and After Hours.

## What it is

On each event, admin can have AI draft a custom 8x10 bar menu from the client's drink plan and the menu notes they wrote in the Potion Planner, tweak it, and approve it. Approving makes it the event's bar menu print file, which the assigned staff download, print and bring framed. The AI paints the art, meaning one themed background and one illustration per drink. The words are real, editable text laid on top, so every drink name is spelled right.

It is used about 30 times a year, on desktop.

## Where it lives

The event page is `client/src/pages/admin/EventDetailPage.js`, at route `/events/:id`. Its right column is 320 px wide and stacks, top to bottom:
1. the **Drink plan** card (`client/src/components/DrinkPlanCard.js`);
2. a "View event details" link;
3. **Bar menu print** (`client/src/components/AdminMenuPrintBlock.js`);
4. the client **Logo** widget (`client/src/pages/admin/EventDetailPlanLogo.js`);
5. for Standard menus only, a PNG download button (`client/src/components/MenuPNG/MenuPNG.jsx`).

**The new section goes between Drink plan and Bar menu print.**

320 px is too narrow to edit an 8x10 menu, so design two pieces:
1. **The card in the column.** Compact: a thumbnail of the current menu, its status, and the next action (Generate, Edit, or Approve).
2. **The editor.** It opens from the card, over the event page, so admin never leaves the event. Use a wide drawer or a full-screen overlay, whichever works better. The 8x10 preview is large and the controls sit beside it. Closing it returns to the event page with the card updated.

Also propose whether the Logo widget and the Standard menu download should fold into this section, so the column reads: drink plan, then menu, then print file.

## What the editor shows and does

- **The client's menu brief from the planner,** read-only: theme and colors, drink naming notes, design notes. Clients write these in `client/src/pages/plan/v2/steps/MenuDesignV2.js`.
- **The image the client uploaded in the planner,** with a choice: Logo on top, Style reference, or Ignore. Clients often upload a mood board in the logo slot. When it is a logo, admin also picks placement (above the title, or replacing it) and backing (none, or a badge for white-box logos on dark art).
- **One optional reference image,** either the client's or an upload. It steers style only and is never printed.
- **Art direction:** a short text box for admin's own steer, for example "watercolor, moody, gold accents".
- **Dr. Bartender mark:** on or off, on by default.
- **Generate,** and once a draft exists, **Start over** (with a confirm). The words appear within seconds, then the background, then each drink one at a time, about 2 minutes in all. Show the slots filling in.
- **Click any text on the menu to edit it.**
  - Per drink: re-roll its art (with an optional note, like "add a salt rim"), or hide it.
  - Re-roll the background.
- **Font pairing:** six pairings, with ids already fixed in the app: `elegant-script`, `rustic`, `modern-clean`, `retro`, `spooky`, `tropical`.
- **Ink and accent colors.**
- **Text backing:** Off, Soft or Panel.
- **Drink limits:** up to 8 drinks are illustrated. Drinks 9 to 12 list as text under "More from the bar".
- **Approve:** saves the menu as the event's print file, confirming first when a print file already exists.

## States (card and editor)

- not set up (no AI key);
- no drinks on the plan;
- never generated;
- generating;
- draft ready;
- one drawing failed (re-roll that one);
- words failed (retry);
- daily image limit reached;
- plan changed since the draft (Update draft, or Dismiss);
- client edited their menu notes;
- saving, saved, save failed;
- text too long to fit (blocks Approve);
- approving;
- approved;
- edited since approval;
- print file replaced by a manual upload;
- print file removed;
- marked "no menu needed".

## The printed menu itself

Keep the printed-menu design from the earlier round. It is snapshotted at `docs/design-artifacts/2026-10-01-menu-designer/menu-designer.html`; open it in a browser and see the Layout rules, Boards A to F, Legibility, and Font pairings sections. Only the admin experience around it is being redone. The quality bar is still Dallas's hand-made menus, `client/public/menu-samples/39.webp` and `40.webp`.

## Sample content (fictional)

A garden wedding. Colors: periwinkle, lilac, coral, plum and mustard.
- Drinks: Roscoe's Paloma; The Groom's Old Fashioned; Lavender Lemon Drop; Phoebe's Garden Spritz; and the mocktail Coral Crush.
- Also at the bar: Pinot Grigio, Cabernet, Prosecco, Miller Lite, Corona; Vodka, Tequila, Bourbon; Athletic Brewing NA, sparkling water.

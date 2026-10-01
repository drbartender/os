# Menu Designer: design brief

**Upload to:** Dr. Bartender OS Design System (admin console). Part 1 is an OS-skin admin page. Part 2 is a printed menu that guests see; it does NOT wear the OS skin.

## What this is

An admin tool that builds a custom 8x10 printed bar menu for one event, from the client's drink plan. An AI paints the art: one themed full-page background, plus one illustration per drink (transparent PNG, matching style). The app lays real, editable text on top, so every drink name is spelled right. Dallas reviews, edits, and approves. Approving saves the final image as the event's bar menu print file, which the assigned staff download, print, and bring framed.

It is for events where the client chose "Custom Menu Design" in their planner. It runs about 30 times a year and is desktop only.

## Read in the repo

- `client/src/pages/admin/EventDetailPage.js`: the event page (`/events/:id`) this launches from.
- `client/src/components/AdminMenuPrintBlock.js`: the "Bar menu print" card. It gets a **Design menu** button and a draft status (Draft / Approved).
- `client/src/components/MenuPNG/MenuPNG.jsx` and `client/src/pages/plan/components/MenuPreview.js`: the existing Standard menu, rendered at 8x10 in the browser. This is the closest prior art and the same rendering technique.
- `client/src/pages/plan/v2/steps/MenuDesignV2.js`: what the client fills in (theme and colors, drink naming, design notes, logo).
- `client/src/pages/admin/EventDetailPlanLogo.js`: the client logo widget on the event page.
- `client/public/menu-samples/*.webp`: Dallas's hand-made custom menus. **These are the quality bar for Part 2**, especially `39.webp` (navy and gold, line-art glasses) and `40.webp` (autumn watercolor, a drawing per drink).

## Part 1: the designer page (OS skin)

A full page per event at `/events/:id/menu`, with a way back to the event. The brief sits on the left and a live 8x10 preview sits on the right. The preview is the hero.

**Brief panel**
- The client's brief, read-only: theme and colors, drink naming notes, design notes.
- The image the client uploaded in the planner, with a role picker: **Logo on top / Style reference / Ignore**. The default is Logo. Clients often put a mood board in the logo slot, so Dallas decides what it is.
- **Reference image (optional), one total.** Either the client's planner image set to "Style reference", or an upload from Dallas's computer. It steers style only and is never placed on the menu.
- **Art direction:** a short free-text box for Dallas's own steer ("watercolor, moody, gold accents").
- **Dr. Bartender mark:** an on/off switch, on by default.
- **Generate** (primary). Once a draft exists, this becomes "Start over", which replaces the whole draft after a confirm.

**Preview and editing**
- Generation is progressive and takes up to about 2 minutes:
  - the words appear within seconds;
  - then the background;
  - then each drink, one at a time.
  - The preview shows pending slots filling in, so it never sits blank behind a spinner.
- Click any text on the preview to edit it in place: the title, section headings, drink names, descriptions, and the "also at the bar" lines.
- Per drink: **Re-roll art** and **Hide from menu**. The background has its own **Re-roll**.
- **Font pairing** picker: about 6 curated pairings. The AI pre-picks one by theme.
- **Text color** picker.
- With more than 8 drinks, Dallas picks which 8 get illustrations; the rest are listed as text.
- **Approve** renders the final file and saves it as the event's print file. If a print file already exists (an older or hand-made one), Approve says it will replace it.

**More controls**
- **Text panel:** none / soft / solid, a backing behind the text for busy art.
- **Logo placement:** when a client logo is used, above the title or replacing it.
- **Save indicator:** edits autosave; show saving / saved / save failed.
- Text editing and the font and color pickers are disabled until the words land.
- Approve is disabled and shows progress while it saves, renders and posts.

**States to design**
- **Loading**, and **couldn't load** (with retry).
- **Not set up:** the AI key is missing. Explain it; no Generate.
- **Empty:** never generated. The brief is visible and Generate is the call to action.
- **No drinks on the plan**, and **no drink plan on this event** (the draft, if any, shown read-only).
- **Generating:** partially filled.
- **Words failed:** the reason, with **Retry**. All image slots show "not attempted".
- **Draft ready.**
- **A piece failed:** that one slot shows the failure with its own re-roll. The rest of the draft is fine.
- **Daily limit reached:** "60 images today, resets in 3 hours". Generate and re-roll disabled.
- **Plan changed:** a banner reads "The plan changed since this draft: added Paloma, dropped Mojito", with **Add to draft**.
- **Brief edited:** a softer note, "The client edited their menu notes since this draft."
- **Save conflict:** "This draft changed elsewhere and was reloaded."
- **Approve in progress**, and **Approve rejected** (the reason, for example "The draft changed. Approve again.").
- **Approved:** "This is the event's print file", with the date.
- **Edited since approval:** "Edited since approval. Approve again to update the print file."
- **Replaced by a manual upload:** someone uploaded a different print file on the event page.
- **Print file removed**, and **marked "no menu needed"** on the event page.

## Part 2: the printed menu layouts (not the OS skin)

The menu is 8x10 portrait, output at 2400x3000 (300 DPI) and designed on an 800x1000 canvas. Each event's look comes from its AI art. The layout is the constant skeleton that has to look good over very different art: a navy and gold wedding, a spooky speakeasy, a tropical luau, a pastel garden party.

**Layers, back to front**
1. AI background: full bleed, decorative edges, a calm center.
2. Drink illustrations: transparent, one per drink, in slots.
3. Text.
4. Client logo at the top, when used.
5. Dr. Bartender mark: small, in a bottom corner, when switched on.

**Content blocks**
- **Title:** "Bar Menu" by default, editable. When a client logo is used, it sits above the title or replaces it.
- **Drinks:** signature cocktails, then mocktails if any. Each drink has an illustration, a name, and a one or two line description.
- **"Also at the bar":** text-only lines for Beer and Wine, Spirits, and Non-Alcoholic, as in `39.webp`.

**Templates for 1 through 8 illustrated drinks.** Show each count, with and without a mocktail group, with and without a client logo, and with and without the also-at-the-bar lines. They must hold long names ("Wake the Dead Espresso Martini") and two-line descriptions without breaking.

**Font pairings:** exactly these six ids, already fixed in the app. Assign each a Google Fonts title face plus a heading and body face:
- `elegant-script`
- `rustic`
- `modern-clean`
- `retro` (disco and retro)
- `spooky`
- `tropical`

**Legibility over unknown art:** the text has to read over art nobody has seen yet. The background is always asked to leave a calm center. Design the three **text panel** settings (none, soft, solid) and show when each earns its place.

**Logo placement:** show a client logo both above the title and replacing it.

## Sample content (fictional)

Garden wedding. Colors: periwinkle, lilac, coral, plum, mustard.

| Drink | Description |
|---|---|
| Roscoe's Paloma | Tequila, grapefruit, lime, and soda. Bright and a little tart. |
| The Groom's Old Fashioned | Bourbon, bitters, orange, and a touch of sugar. Smooth and classic. |
| Lavender Lemon Drop | Vodka, lemon, and lavender syrup. Floral and crisp. |
| Phoebe's Garden Spritz | Aperol, prosecco, and soda. Light and sunny. |
| Mocktail: Coral Crush | Strawberry, lime, mint, and sparkling water. |

**Also at the bar**
- Beer and Wine: Pinot Grigio, Cabernet, Prosecco, Miller Lite, Corona.
- Spirits: Vodka, Tequila, Bourbon.
- Non-Alcoholic: Athletic Brewing NA, sparkling water, cranberry juice.

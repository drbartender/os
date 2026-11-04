---
spec: docs/superpowers/specs/2026-10-19-menu-designer-v2-design.md (rev 2, 2026-11-03; builder check and the design-stage spec review folded in)
format: lane map without code (spec 2026-10-19 D12)
revision: 1 (2026-11-03)
status: >
  Eleven lanes. Claude cuts each from current main with npm run worktree:new, builds it, reviews it at the
  tier the review skill computes, squash-merges it through scripts/merge-lane.sh from os and removes it.
  Lanes merge in the order the blockedBy graph allows; a lane that merges is safe to ship alone, because
  every lane leaves main in a working state (the public proof routes land dark, the Inbox reader lands
  before anything raises a menu task, auto-start lands last). The last lane ships only after the owner
  adds OpenAI credit (spec section 24). The ship of any merged lane waits for the owner's word.
lanes:
  - id: menu-out-of-credit
    scope: >
      Spec section 16. An empty provider balance reads as out of credit, stops at once and says so. OpenAI's
      mapError maps a 429 or 403 whose code is insufficient_quota or credit_balance_exhausted to a new
      OpenAIOutOfCredit, never a rate limit, never retried; menuImageProvider wraps it as MenuArtOutOfCredit;
      menuArtJobErrors gains the words and piece sentences and captures it to Sentry once per run. Gemini's
      mapError keeps the rpc status on the descriptor and maps a spent prepaid balance to the same class
      when its error details show a billing reason; when they cannot, Gemini keeps today's retries and the
      sentence after the second failed retry becomes the "still refusing, check billing" line. The lane
      report states which Gemini case it found, with the evidence (the SDK error shape it read).
    footprint:
      - server/utils/openaiClient.js  (mapError and the new error class; nothing else)
      - server/utils/openaiClient.test.js
      - server/utils/geminiClient.js  (mapError and the descriptor's status; nothing else)
      - server/utils/geminiClient.test.js
      - server/utils/menuImageProvider.js  (the out-of-credit wrap)
      - server/utils/menuImageProvider.test.js
      - server/utils/menuArtJobErrors.js  (SENTENCES, the no-retry branch, Sentry once per run)
      - server/utils/menuArtJobWords.js  (only if the words step's catch must name the new class)
      - server/utils/menuArtJob.test.js
      - README.md  (generated sections, npm run docs)
      - ARCHITECTURE.md  (generated sections, npm run docs)
    blockedBy: []
    lenses: the tier the review skill computes (the provider wrappers and menuArtJobErrors.js are on the sensitive list, so tier A); outcomes-providers and seams at least.
    laws: >
      CLAUDE.md's provider rule: each provider is reached only through its one wrapper, the wrapper refuses a
      real call under NODE_ENV=test unless a stub is injected, every menu art suite sets NODE_ENV=test on its
      first line, and Sentry gets only the sanitized descriptor, never the SDK message. The admin sees fixed
      sentences only, never provider text.
    seams: >
      The SENTENCES table is read later by the Inbox's "couldn't be generated" task (lane menu-auto-start);
      the descriptor shape stored in the menu_art_calls ledger keeps its keys (code, status, requestId,
      errorClass, provider); a plain 429 rate limit keeps retrying exactly as today.
    acceptance: >
      The reached server suites pass through run-suites; the new mapping tests fail on main for their stated
      reason under the review skill's failing-test procedure (on main a 429 with code credit_balance_exhausted
      is a rate limit, is retried twice and ends in "OpenAI is busy right now. Try again in a minute.").
    test plan: >
      openaiClient.test.js: a 429 with code credit_balance_exhausted and one with insufficient_quota each map
      to OpenAIOutOfCredit with the code kept on the descriptor; a 403 with insufficient_quota likewise; a
      plain 429 still maps to OpenAIRateLimited. geminiClient.test.js: the descriptor carries the rpc status;
      the billing-reason case, or, if Gemini cannot be told apart, a RESOURCE_EXHAUSTED still maps to
      GeminiRateLimited. menuArtJob.test.js: the words step on out of credit stores the words sentence, makes
      no retry (the sleep hook is never called), marks pieces not attempted and captures once; a piece on out
      of credit stores the piece sentence; the existing busy and retry tests stay green with their old
      sentences.
    revert: revert the one squash commit; nothing is stored in a new shape.

  - id: menu-bar-fingerprint
    scope: >
      Spec section 17. The plan-changed check notices bar picks. buildFingerprint and fingerprintHash add
      bar_hash (normalized.bar, each list sorted); computeDiff reports a bar change as bar_changed; the card
      and the Brief tab print "The bar picks changed since this draft."; Update draft and Dismiss store the
      new hash. A stored fingerprint without bar_hash reads as unchanged for the bar. The same lane fixes the
      Promise.all on one pg client in menuDraftSync.js ~144 (through loadCatalogMaps), since it touches that
      read: the catalog maps load sequentially on the held client, or through the pool before the client is
      taken.
    footprint:
      - server/utils/menuDrinkSource.js  (buildFingerprint, fingerprintHash)
      - server/utils/menuDrinkSource.test.js
      - server/utils/menuDraftRead.js  (computeDiff)
      - server/utils/menuDraftRead.test.js
      - server/routes/proposals/menuDraftSync.js  (the stored hash on Update draft and Dismiss; the one-client load)
      - server/routes/proposals/menuDraftSync.test.js
      - client/src/pages/admin/menuDesigner/menuCardState.js  (the diff line)
      - client/src/pages/admin/menuDesigner/menuCardState.test.js
      - client/src/pages/admin/menuDesigner/BriefTab.js  (the diff line)
      - client/src/pages/admin/menuDesigner/BriefTab.test.js
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: []
    lenses: the computed tier (menuDraftSync.js is sensitive); concurrency (the one-client fix), seams (the diff shape the client reads).
    laws: CLAUDE.md one pooled connection per request (a handler holding pool.connect() sends every query through it); the drinks and brief parts of the fingerprint are unchanged, so no existing draft lights up on deploy.
    seams: the diff object's new key bar_changed is read by menuCardState.js and BriefTab.js; the house card lane later writes house_sections from the same normalized bar, so the bar hash covers the house card too.
    acceptance: >
      Suites pass; the new fingerprint test fails on main (a changed wine pick yields no diff on main).
    test plan: >
      menuDrinkSource.test.js: two plans differing only in a wine pick give different fingerprints; list order
      does not change the hash. menuDraftRead.test.js: bar_changed true for a bar change, false for an old
      fingerprint with no bar_hash; an admin brief value never changes the diff. menuDraftSync.test.js: Update
      draft stores bar_hash; the catalog load no longer runs concurrent queries on one client.
      menuCardState and BriefTab tests: the line renders on bar_changed.
    revert: revert the squash; drafts that stored bar_hash keep an extra key the old code ignores.

  - id: menu-no-menu-mark
    scope: >
      Spec section 15. A client submit with Skip the Menu marks the event as needing no printed menu; a later
      Custom or Standard submit clears only a mark the planner set; the admin's own mark is never undone.
      New column proposals.menu_not_required_by ('admin' | 'planner'). A new server/utils/menuAutoStart.js
      exports triggerMenuAutoStart(planId), fire-and-forget in the triggerShoppingListAutoGen shape, called
      beside triggerShoppingListAutoGen at both submit tails (submit.js:638, :740); in this lane it applies the
      mark only (the auto-start step joins it in lane menu-auto-start), skipping an archived proposal and the
      legal-hold proposal, treating customMenuDesign false with no menuStyle as none, and writing the
      menu_not_required activity row. The admin PATCH writes the provenance; setMenuPrintKey clears both
      columns; the designer read model selects the new column; the card's No menu needed sub line adds "The
      client chose Skip the Menu." for a planner mark. A one-time script, server/scripts/backfillMenuNotRequired.js,
      dry run by default, limited to submitted plans of upcoming booked events, prints counts, ids and the
      legal-hold excluded count, and writes in one transaction with an activity row per mark. Running it on
      production is an owner-approved step after the ship, not part of the lane.
    footprint:
      - server/db/schema.sql  (menu_not_required_by, idempotent)
      - server/utils/menuAutoStart.js  (new, with the header comment)
      - server/utils/menuAutoStart.test.js  (new)
      - server/routes/drinkPlans/submit.js  (the two trigger calls; nothing else)
      - server/routes/proposals/menuPrint.js  (the PATCH writes the provenance; nothing else)
      - server/routes/proposals/menuPrint.test.js
      - server/utils/menuPrintFile.js  (setMenuPrintKey clears both columns)
      - server/utils/menuDraftRead.js  (selects p.menu_not_required_by)
      - client/src/pages/admin/menuDesigner/menuCardState.js  (the sub line)
      - client/src/pages/admin/menuDesigner/menuCardState.test.js
      - server/scripts/backfillMenuNotRequired.js  (new, with the header comment)
      - server/scripts/backfillMenuNotRequired.test.js  (new)
      - scripts/sensitive-paths.txt  (menuAutoStart.js)
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: [menu-bar-fingerprint]
    lenses: tier A (submit.js, menuPrint.js, menuPrintFile.js, schema); schema-data, lifecycle, concurrency, seams, money (menu_not_required gates the $5 menu_print duty line), verify, the externals, the money smoke.
    laws: >
      Money law 15: the legal-hold proposal keeps its state exactly; every writer here calls isLegalHold,
      which fails closed. The duty line (dutyLines.js:151, 192) reads menu_print_key and menu_not_required,
      so a mark must never be set while a print key exists (the UPDATE's own WHERE guards it, the menuPrint.js
      PATCH precedent). The trigger runs after the submit's COMMIT and release, on its own pool connection.
      Event dates compare as event_date::text against chicagoTodayYmd() (spec 8.2). Parameterized SQL only.
      The backfill prints ids and counts only, never a name or contact.
    seams: >
      Every writer of menu_not_required (the admin PATCH, setMenuPrintKey, the new planner path) keeps
      menu_not_required_by in step; every reader of menu_not_required is unchanged (eventDetailsPayload,
      shifts.queries, dutyLines, menuPrintState); the client's menuOwedFor rule (nextStepsCopy.js:23) and the
      legacy customMenuDesign rule (PotionPlanningLab.js:212-215) are mirrored, not imported.
    acceptance: >
      Suites pass (the drink plan submit suites among them) and the money smoke passes; the new trigger test
      fails on main (a Skip the Menu submit leaves menu_not_required false on main); the backfill's dry run on
      the dev database writes nothing and prints only ids and counts.
    test plan: >
      menuAutoStart.test.js: none marks with by planner and writes the activity row; a later custom submit
      clears a planner mark and leaves an admin mark; a proposal with a print key is never marked; archived
      and the legal-hold proposal are skipped; the legacy customMenuDesign false counts as none; the trigger
      swallows and reports its own failure (a thrown query does not reach the submit response).
      menuPrint.test.js: the PATCH writes admin when setting and null when clearing. A setMenuPrintKey test:
      both columns cleared. backfillMenuNotRequired.test.js: the dry run writes nothing; unsubmitted plans,
      past events, archived and legal-hold rows are excluded and the excluded legal-hold count is printed; the
      write path marks in one transaction. menuCardState.test.js: the sub line for a planner mark.
    revert: revert the squash; the column stays (idempotent ADD COLUMN); marks the planner set remain valid marks.

  - id: menu-mark-placement
    scope: >
      Spec section 5. content.mark_position left | center | right, missing reads as right; the Design tab's
      Placement .seg under the mark switch; the switch's sub line follows the value; MenuCanvas places the mark
      with today's CSS for right, a mirrored rule for left, and an inline left of about 296 canvas px for
      center (never a transform); validation in CONTENT_CHECKS.
    footprint:
      - client/src/pages/admin/menuDesigner/MenuCanvas.js
      - client/src/pages/admin/menuDesigner/MenuCanvas.test.js
      - client/src/pages/admin/menuDesigner/DesignTab.js
      - client/src/pages/admin/menuDesigner/DesignTab.test.js
      - client/src/index.css  (the mc-mark left rule)
      - server/utils/menuDraftValidation.js  (CONTENT_CHECKS)
      - server/utils/menuDraftValidation.test.js
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: []
    lenses: the computed tier; client (with the 320 and 390 captures), seams.
    laws: >
      v1 11.3, export parity: nothing html2canvas might draw differently from the browser, so no transform; the vertical offsets are unchanged so the fit loop needs no new room.
    seams: the export and the proof render the same MenuCanvas, so they inherit the placement; the house card (lane menu-house-card) has no .mc-mark.
    acceptance: Suites pass; the client lens on the Design tab against the v1 artifact; the new validation test fails on main (mark_position refused as an unknown content key).
    test plan: >
      MenuCanvas.test.js: the mark's left for each position with and without the Panel, and right when the
      field is missing. DesignTab.test.js: the Placement .seg PATCHes { content: { mark_position } }, is
      disabled before the words land, and the sub line text follows. menuDraftValidation.test.js: the three
      values pass, anything else is a field error.
    revert: revert the squash; stored mark_position values are ignored by the old canvas (it draws right).

  - id: menu-fonts-twelve
    scope: >
      Spec section 6, decision 7. Six new pairings (art-deco, botanical, hand-lettered, fiesta, editorial,
      black-tie) with the spec's faces, sizes and colors as starting values; the server id list and the words
      schema enum grow; parseWords stores content.font_pairing_suggested, server-only; the Design tab tags it
      Suggested.
    footprint:
      - server/utils/menuFontPairings.js
      - client/src/pages/admin/menuDesigner/fontPairings.js
      - client/src/pages/admin/menuDesigner/fontPairings.test.js
      - server/utils/menuArtPrompts.js  (the enum and parseWords)
      - server/utils/menuArtPrompts.test.js
      - server/utils/menuDraftValidation.js  (CONTENT_SERVER_ONLY)
      - server/utils/menuDraftValidation.test.js
      - client/src/pages/admin/menuDesigner/DesignTab.js
      - client/src/pages/admin/menuDesigner/DesignTab.test.js
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: [menu-mark-placement]
    lenses: the computed tier; client (captures), seams (two id lists kept in sync).
    laws: every face still loads before Approve (the export waits on the link, each face and document.fonts.ready); the server validates one enum; the words step's prompt line is unchanged.
    seams: FONT_PAIRING_IDS (server) and PAIRING_IDS (client) are identical, pinned by a test that imports both; fontsHref builds one css2 link for every pairing.
    acceptance: Suites pass; the client lens on the twelve-button tab; the sync test fails on main once the client list grows (it is written against both lists).
    test plan: >
      fontPairings.test.js: the ids equal the server's list; fontsHref for all twelve sorts weights and names
      "Baloo 2" and "DM Serif Display" correctly. menuArtPrompts.test.js: the schema enum has twelve ids;
      parseWords stores font_pairing_suggested. menuDraftValidation.test.js: PATCH refuses
      font_pairing_suggested; each new id passes. DesignTab.test.js: the Suggested tag sits on the model's pick
      and is absent on an old draft; choosing a pairing still resets ink and accent.
    revert: revert the squash; a draft that stored a new id reads as the default pairing (fontPairings.js:95-97).

  - id: menu-brief-tab
    scope: >
      Spec section 7 (decisions 2, 3 and 13). The GET's plan block gains side and planner_reference (labelled
      bar strings from LINE_LABELS, the two notes), display only and never sent to a provider; the Brief tab's
      From the planner box. inputs.admin_brief { theme, naming, notes }, PATCH and Generate
      (admin_brief_theme, admin_brief_naming, admin_brief_notes), held in the hook's pre-draft brief;
      effectiveBrief(clientBrief, adminBrief) applied at the four provider seams and nowhere else; the
      fingerprint keeps hashing the client's fields. The Admin brief box with its hint naming email, text and
      phone.
    footprint:
      - server/utils/menuDraftRead.js  (plan.side, plan.planner_reference)
      - server/utils/menuDraftRead.test.js
      - server/utils/menuDrinkSource.js  (effectiveBrief)
      - server/utils/menuDrinkSource.test.js
      - server/utils/menuDraftValidation.js  (INPUT_CHECKS, validateGenerateInputs)
      - server/utils/menuDraftValidation.test.js
      - server/utils/menuArtJob.js  (the words, background and re-roll seams)
      - server/routes/proposals/menuDraftSync.js  (the typed-drinks words call)
      - server/utils/menuArtJob.test.js
      - client/src/pages/admin/menuDesigner/BriefTab.js
      - client/src/pages/admin/menuDesigner/BriefTab.test.js
      - client/src/pages/admin/menuDesigner/useMenuDraft.js
      - client/src/pages/admin/menuDesigner/useMenuDraft.test.js
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: [menu-no-menu-mark, menu-fonts-twelve, menu-out-of-credit]
    lenses: tier A (menuArtJob.js, menuDraftSync.js); access-egress (what leaves the OS for a provider), outcomes-providers, seams, client (captures), verify, the externals.
    laws: >
      CLAUDE.md's AI rule: menu art sends no client name, contact, venue, address or event date
      (menuArtPrompts.js); planner_reference and its notes are never part of the words request, the background
      prompt or a re-roll; the admin brief goes exactly where the client's brief goes and nowhere else.
    seams: >
      effectiveBrief is the one merge, used at exactly four call sites; the fingerprint and computeDiff read
      only the client's brief, so an admin brief edit never reads as Edited by client; validateGenerateInputs'
      stored-inputs rule is the one the house card lane extends for look.
    acceptance: >
      Suites pass; the payload-rule test passes (a fixture with distinctive planner note text is absent from
      the words and background requests); the client lens on the Brief tab; the effectiveBrief and
      planner_reference tests fail on main (absent functions and keys).
    test plan: >
      menuDrinkSource.test.js: effectiveBrief per field (admin wins when non-empty after trim, the client fills
      blanks, the 1,000 cut). menuDraftRead.test.js: planner_reference on a consult-side plan carries the
      planner picks and the side; labelled bar strings; notes cut to 2,000; null with no plan.
      menuDraftValidation.test.js: admin_brief bounds and unknown keys; Generate's three fields, absent meaning
      stored. menuArtJob.test.js: the payload rule, and the merged brief at each seam. BriefTab and useMenuDraft
      tests: the fields save through the debounced PATCH, hold before a draft, and are read-only on a
      read-only draft; the consult hint and the no-drinks hint render.
    revert: revert the squash; stored admin_brief values are ignored by the old code.

  - id: menu-house-card
    scope: >
      Spec section 9 (decision 12). inputs.look house | custom, decided at Generate (9.1), switchable on the
      Brief tab's Look .seg; validateGenerateInputs carries look and keeps the stored admin brief and look; the
      upsert seeds content with look, touch_key and house_bottom_corners. server/utils/menuEventTouches.js
      touchSetFor (table T, by id or stored label, December from the event date text). A house run makes no
      words call and reserves no text cap: the job fills the content (title The Bar Menu, own names, no
      descriptions, has_art false, content.house_sections from server/utils/menuHouseSections.js, a hand-synced
      port of client menuSections.js on the planner side and the consult bar's labelled lines on the consult
      side) and stamps content.words_finished_at; it reserves only the background, and none for a plain touch
      set. The house background prompt (zones, muted colors, the extended fixed clauses, the event touches;
      loadDraft adds event_date::text). layoutPieceKeys moves to menuDraftShared.js and returns background or
      nothing for a house draft. The canvas renders the house layout (a port of MenuPreview's print variant at
      800 x 1000 in a new component, fit from 35 to 24 px then Too long, the footer lockup and client logo,
      centred when house_bottom_corners). The Design tab's house-card note. House draft edit rules: Update
      draft makes no words call and no art; PATCH refuses has_art true and description; a per-drink re-roll
      answers MENU_HOUSE_NO_DRINK_ART; the text-only cap does not apply. The vendored sketch is the benchmark
      for where touches sit.
    footprint:
      - server/utils/menuEventTouches.js  (new, with the header comment)
      - server/utils/menuEventTouches.test.js  (new)
      - server/utils/menuHouseSections.js  (new, with the header comment naming its client twin)
      - server/utils/menuHouseSections.test.js  (new; the parity test imports the client file)
      - client/src/pages/plan/data/menuSections.js  (its header names the server twin; nothing else)
      - server/utils/menuDraftValidation.js  (look, the house edit rules, the text-only cap exemption, validateGenerateInputs)
      - server/utils/menuDraftValidation.test.js
      - server/routes/proposals/menuDrafts.js  (the upsert's content seed and the reservation)
      - server/routes/proposals/menuDrafts.test.js
      - server/routes/proposals/menuDraftShared.js  (layoutPieceKeys, moved here)
      - server/routes/proposals/menuDraftApprove.js  (imports layoutPieceKeys from the shared file; nothing else)
      - server/routes/proposals/menuDraftSync.js  (house Update draft)
      - server/routes/proposals/menuDraftImages.js  (the per-drink re-roll refusal)
      - server/utils/menuArtJob.js  (the house branch)
      - server/utils/menuArtJobSteps.js  (loadDraft's event_date; the house fill)
      - server/utils/menuArtJobWords.js  (words_finished_at)
      - server/utils/menuArtImagePrompts.js  (the house prompt)
      - server/utils/menuArtImagePrompts.test.js
      - server/utils/menuArtJob.test.js
      - client/src/pages/admin/menuDesigner/MenuCanvas.js  (the look branch only)
      - client/src/pages/admin/menuDesigner/HouseCard.js  (new: the house layout, with the header comment)
      - client/src/pages/admin/menuDesigner/HouseCard.test.js  (new)
      - client/src/pages/admin/menuDesigner/DesignTab.js  (the house-card note)
      - client/src/pages/admin/menuDesigner/DesignTab.test.js
      - client/src/pages/admin/menuDesigner/BriefTab.js  (the Look .seg)
      - client/src/pages/admin/menuDesigner/BriefTab.test.js
      - client/src/pages/admin/menuDesigner/menuCardState.js  (layoutPieceKeys' client rule)
      - client/src/pages/admin/menuDesigner/menuCardState.test.js
      - client/src/pages/admin/menuDesigner/useMenuDraft.js  (look in the pre-draft brief)
      - client/src/index.css  (mc-house- rules)
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: [menu-brief-tab]
    lenses: tier A (menuDrafts, menuDraftShared, menuDraftSync, menuDraftImages, menuDraftApprove, the job files); seams (the hand-synced sections pair, layoutPieceKeys on both sides), outcomes-providers (a run with no provider call), access-egress (the house prompt's content), client (captures against MenuPreview and the house-touches sketch), business-time (the December rule), verify, the externals.
    laws: >
      v1 11.2 and 11.3: the fit rule's Too long state and export parity hold for the house layout; the house
      prompt sends no client name, contact, venue, address or event date (the event date reaches only the
      December test, never the prompt text); a plain card spends no image; Approve requires exactly the pieces
      layoutPieceKeys names on both sides. Dates as text (spec 8.2).
    seams: >
      menuHouseSections.js and client menuSections.js agree on shared fixtures (the eventTypes.js pair
      precedent); layoutPieceKeys is one rule, server (menuDraftShared.js) and client (menuCardState.js); the
      canvas reads only content (look, touch_key, house_bottom_corners, house_sections); getEventTypeLabel's
      label match is mirrored in touchSetFor.
    acceptance: >
      Suites pass; the house prompt test and the no-words-call test pass; the client lens judges the house
      card against MenuPreview's print variant and the touches against the vendored sketch, at 320 and 390 for
      the editor and at full size for the canvas; a dev Generate on a Standard Menu event is held until credit
      exists (the live walk is lane menu-auto-start's), so acceptance here is the suites plus a canvas render
      from a fixture draft, captured.
    test plan: >
      menuEventTouches.test.js: every event type id in table T, a stored label, a custom type, no type, and a
      holiday party in December and in November (text dates). menuHouseSections.test.js: parity with the client
      on both key families, a Non-Alcoholic pick, Call Drinks, spirits never listed, and the consult side's
      labelled lines. menuDraftValidation.test.js: the look decision for every combination (style, client brief,
      admin brief, art direction, reference, logo-only image); a house PATCH refuses has_art true and
      description and accepts display_name and hidden; the text-only cap skipped for house. menuDrafts.test.js:
      a house Generate reserves background only, a plain one reserves nothing, and no text call is reserved.
      menuArtJob.test.js: a house run makes no words call, fills content and words_finished_at;
      menuArtImagePrompts.test.js: the house prompt names the zones and the touches and holds no client field;
      a custom prompt is unchanged. HouseCard.test.js: sections render in order, the fit steps down to the
      floor then reports Too long on a 20-drink fixture (Review Focus 5), the footer centres on house_bottom_corners, the client logo shows only for
      role logo. A re-roll test: MENU_HOUSE_NO_DRINK_ART for a drink on a house draft.
    revert: revert the squash; a house draft made while it was live reads as a custom draft with no art and fails its own Approve checks until Start over, so revert only with no house drafts in flight (the lane report counts them).

  - id: menu-proof-page
    scope: >
      Spec sections 10.6, 12 and 18, the public half, landing dark. The menu_proofs table (10.6, with
      pending, suppressed and withdrawn_at); server/utils/menuProofs.js (the token-life SQL expression until the
      end of the event day in Chicago, 30 days with no date; the state derivation open, approved, changes,
      superseded, expired, withdrawn; the latest-proof query); server/routes/menuProof.js with GET, GET image
      (prefix pinned to the row's own proposal) and POST answer (the conditional one-shot UPDATE, the activity
      row without the note, and no release yet: lane menu-approve-send wires releaseHeldPrint into it);
      menuProofReadLimiter and menuProofAnswerLimiter; MenuProofPage with every state of section 12 (loading,
      failed load with Try again, sending, withdrawn), on drb-tokens.css per the visual contract's token rule;
      the route in every site context in App.js. Nothing creates a proof yet, so every link 404s until the
      next lane.
    footprint:
      - server/db/schema.sql  (menu_proofs, idempotent)
      - server/utils/menuProofs.js  (new, with the header comment)
      - server/utils/menuProofs.test.js  (new)
      - server/routes/menuProof.js  (new, with the header comment)
      - server/routes/menuProof.test.js  (new)
      - server/index.js  (the mount beside /api/public/feedback)
      - server/middleware/rateLimiters.js  (the two limiters)
      - client/src/pages/public/MenuProofPage.jsx  (new, under 300 lines, with the header comment)
      - client/src/pages/public/MenuProofPage.css  (new)
      - client/src/pages/public/MenuProofPage.test.jsx  (new)
      - client/src/App.js  (the lazy import and the four route blocks)
      - scripts/sensitive-paths.txt  (server/routes/menuProof.js, server/utils/menuProofs.js)
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: []
    lenses: tier A (rateLimiters.js, a public token route taking a client write); access-egress, concurrency (the one-shot UPDATE), business-time (the token life), schema-data, client (captures of every page state at 320 and 390 against the vendored proof-page sketch), seams, verify, the externals.
    laws: >
      Public routes are token-gated by a UUID (requireUuidToken before any query); the public GET returns no
      admin data; the proof bytes stream only under menu-proof/<the row's proposal_id>/; the note is plain text,
      1 to 1,000 characters, never HTML, never in an activity row; one answer per proof in SQL; an archived
      proposal 404s; the token life is computed live from event_date in America/Chicago. Error bodies leak no
      internals. The page shows no client name, email, event date, venue or amounts.
    seams: >
      The menu_proofs columns and the state names are what lanes menu-approve-send and menu-inbox-tasks read;
      the token-life expression is one function in menuProofs.js, used by the GET, the image route, the answer
      route and (later) the admin read model; App.js carries the route in all four site contexts.
    acceptance: >
      Suites pass; the client lens judges every page state against the sketch; with a proof row inserted by a
      test fixture on dev, the page shows open, answers once, then approved; an unknown token, a bad UUID and
      an archived proposal 404.
    test plan: >
      menuProofs.test.js: the token life at the end of the event day in Chicago (an evening NOW() whose GMT day
      is the next day, a DST change), 30 days with no date, and a moved event date moving the end; each state.
      menuProof.test.js: GET per state; the image route streams only under the row's prefix and 404s outside
      open, approved and changes; the answer writes once, refuses a second answer, an older link and a
      withdrawn proof with their codes, requires a note for changes and caps it at 1,000, writes the activity
      row with no note; the limiter chain is present on each route (the publicFeedback precedent).
      MenuProofPage.test.jsx with a mocked api: open, approved, changes, superseded, expired, withdrawn, the
      404 shell, loading, a 429 failed load with Try again, sending (buttons disabled), Send changes disabled on
      an empty note, the image-missing line.
    revert: revert the squash; the table stays (idempotent CREATE); no proof rows exist yet.

  - id: menu-approve-send
    scope: >
      Spec sections 10, 11 and 14 (decisions 4, 6, 10 and 15). Approve and send: one render, two files (the
      print file byte for byte as today, and the 1200 x 1556 proof); the route validates both, refuses legal
      hold, a past event and archived, stamps a v1 approval as released first, applies the 10-minute
      double-submit guard and the send cap, holds the print file (no setMenuPrintKey, no reaccrueDuty),
      supersedes the old proof, inserts the new one as pending, writes the two activity rows, and after
      release runs the immediate-send gate and the email (menuProofReady, messageType menu_proof, no sentBy).
      server/utils/menuRelease.js releaseHeldPrint with the five guards and its reasons; the admin release
      route (release and put back, after_event); the answer route calls releaseHeldPrint and fires
      reaccrueDuty after commit; the no-menu PATCH and the admin upload withdraw the open proof. menu_drafts
      gains released_print_key, released_at, released_by, released_via, and approved_by becomes ON DELETE SET
      NULL. menuPrintState gains held and the released branches (10.3's list). The GET's proof and print
      blocks; the editor's Approve and send, its confirm and codes, Release for printing and Put it back for
      staff; the card's Client review fold row, table C and table B; the Brief tab's Client review history;
      the events dashboard's Menu with client tag and owner. The email copy as decision 15 fixes it.
    footprint:
      - server/db/schema.sql  (the four released columns; approved_by ON DELETE SET NULL, idempotent DO block)
      - server/routes/proposals/menuDraftApprove.js
      - server/routes/proposals/menuDraftApprove.test.js
      - server/routes/proposals/menuDraftRelease.js  (new, with the header comment)
      - server/routes/proposals/menuDraftRelease.test.js  (new)
      - server/routes/proposals/index.js  (the release mount)
      - server/utils/menuRelease.js  (new, with the header comment)
      - server/utils/menuRelease.test.js  (new)
      - server/utils/menuPrintState.js
      - server/utils/menuPrintState.test.js
      - server/utils/menuDraftRead.js  (the proof and print blocks)
      - server/utils/menuDraftRead.test.js
      - server/routes/menuProof.js  (the answer route's release call)
      - server/routes/menuProof.test.js
      - server/routes/proposals/menuPrint.js  (the withdraw on the mark and on upload)
      - server/routes/proposals/menuPrint.test.js
      - server/utils/lifecycleEmailTemplates.js  (menuProofReady)
      - server/utils/lifecycleEmailTemplates.test.js
      - server/utils/urls.js  (menuProofUrl)
      - server/routes/shifts.queries.js  (menu_with_client)
      - client/src/components/adminos/eventPlan.js  (the tag and owner)
      - client/src/components/adminos/eventPlan.test.js
      - client/src/pages/admin/menuDesigner/exportMenu.js  (renderPrintCanvas, the proof encode, the two-file post)
      - client/src/pages/admin/menuDesigner/exportMenu.test.js
      - client/src/pages/admin/menuDesigner/EditorBanner.js
      - client/src/pages/admin/menuDesigner/MenuEditor.js
      - client/src/pages/admin/menuDesigner/MenuEditor.approve.test.js
      - client/src/pages/admin/menuDesigner/MenuCardFold.js
      - client/src/pages/admin/menuDesigner/MenuCardFold.test.js
      - client/src/pages/admin/menuDesigner/MenuDesignerCard.js
      - client/src/pages/admin/menuDesigner/menuCardState.js
      - client/src/pages/admin/menuDesigner/menuCardState.test.js
      - client/src/pages/admin/menuDesigner/BriefTab.js  (the Client review section)
      - client/src/pages/admin/menuDesigner/BriefTab.test.js
      - scripts/sensitive-paths.txt  (menuRelease.js, menuDraftRelease.js)
      - README.md, ARCHITECTURE.md  (generated sections, and the hold-and-release concept in ARCHITECTURE's hand-written prose)
    blockedBy: [menu-proof-page, menu-house-card, menu-no-menu-mark]
    lenses: tier A, the full floor (money, lifecycle, concurrency, outcomes-providers, access-egress, seams) plus schema-data, business-time and client (captures); verify; the externals; the money smoke.
    laws: >
      menu_print_key drives the $5 menu_print duty line (dutyLines.js:151, 192); it moves only through
      setMenuPrintKey inside releaseHeldPrint or the admin upload, and reaccrueDuty fires only after the release
      commits (menuPrintFile.js:98-108). The no-menu mark always wins over a client release and is never cleared
      by one. Money law 15: the legal-hold proposal is refused at Approve and Release and never released by a
      client. A public route can release only through the helper's guards. One pooled connection per request:
      the email runs after the transaction's client is released. Resend errors throw and are caught to failed;
      the immediate-send gate runs first. The note never enters an activity row. No client name beyond the first
      name, no event date, venue or amounts in the email.
    seams: >
      Every reader of menu_print_key (the staff download, eventDetailsPayload's status, shifts.queries
      menu_done, dutyLines, the admin reads) sees a held file as no file; menuPrintState is one function used by
      the read model and the Approve and release responses; the proof block's states match menuProofs.js;
      exportMenu's print file is byte for byte today's; the activity actions menu_approved, menu_proof_sent,
      menu_proof_approved, menu_proof_changes and menu_released are added together; eventPlan.js and
      shifts.queries.js change together.
    acceptance: >
      Suites pass and the money smoke passes; the hold test fails on main (on main Approve sets menu_print_key);
      the walk on dev with SEND_NOTIFICATIONS on for that server only and a client email the owner owns:
      approve and send, open the email on a phone, Request changes, approve again (the old link reads
      superseded), Looks great (the staff download appears), and on a second event Release for printing with no
      answer; a no-menu mark during an open proof shows the page as withdrawn.
    test plan: >
      menuDraftApprove.test.js: both files validated and nothing written on a bad proof; menu_print_key
      untouched and no duty re-accrual; the proof inserted pending with its activity rows in one transaction;
      the previous proof superseded; the same pair within 10 minutes answers MENU_PROOF_ALREADY_SENT and sends
      nothing; after 10 minutes it sends; a past event answers MENU_EVENT_PASSED; legal hold and archived
      refused; the send cap; the gate refusal writes suppressed; the email stub's outcomes write sent, skipped
      and failed; the v1 stamp runs before the new approval. menuRelease.test.js: each guard and reason (legal
      hold, marked, not held including already released, file changed, event passed for the client, the admin
      after_event flag), setMenuPrintKey and the stamp on success. menuDraftRelease.test.js: the 409 codes,
      put-back only for the menu's own removed file, reaccrueDuty after commit. menuProof.test.js: Looks great
      releases only the matching held file, never overwrites an upload, records the answer when the release is
      refused. menuPrint.test.js: the mark and the upload withdraw the open proof, DELETE does not.
      menuPrintState.test.js: every branch in 10.3's list including live previous, a v1 approval, a v1 approval
      later removed, and an upload beside a held file. Client tests: Approve and send's confirm and no-email
      variant, the codes, Release and Put it back with their errors, the fold row and kebab, table C and B rows,
      the Brief tab history, eventPlan's tag and owner, exportMenu's 2400 x 3000 at 0.92 unchanged and the proof
      at 1200 x 1556 with html2canvas mocked. A race test (Review Focus 1): the answer route's Looks great and
      the no-menu PATCH run concurrently on one proposal; whichever commits first wins, the mark is never
      cleared, and the duty line's inputs match the final key.
    revert: >
      Revert the squash. Held files written while it was live stay in R2 and on menu_drafts.approved_print_key;
      the old Approve treats them as approved but unposted ("removed"), so before reverting, release or
      re-approve every held menu (the lane report gives the query that counts them). The columns stay.

  - id: menu-inbox-tasks
    scope: >
      Spec section 13 (decisions 5 and 11). server/utils/inbox/readMenuTasks.js emits the two proof tasks,
      menu_changes and menu_no_answer, open only while the latest proof's own state holds (13.1), never for a
      past or archived event or any person the legal hold covers; server/utils/menuReminder.js
      menuReminderDueAt (13.3). The engine registers the reader in pass 1 with the fixed texts in the header
      and the change note in pass 2 through details.js. rules.js keeps menu_task events out of U and the anchor,
      makes a person wait while a task is open, adds the snooze clause, and hides Done on a row held only by
      tasks; classify.js marks the source as never a reply and never counted, and lists the kinds in
      aiCannotClose; thread.js keeps open tasks in the open set and carries the new link; the client renders
      the task line and link. The writers of proofs, releases and marks call inboxCache.invalidate().
    footprint:
      - server/utils/inbox/readMenuTasks.js  (new, with the header comment)
      - server/utils/inbox/readers.test.js
      - server/utils/menuReminder.js  (new, with the header comment)
      - server/utils/menuReminder.test.js  (new)
      - server/utils/inbox/engine.js
      - server/utils/inbox/engine.test.js
      - server/utils/inbox/rules.js
      - server/utils/inbox/rules.testkit.js
      - server/utils/inbox/rules.menuTasks.test.js  (new)
      - server/utils/inbox/classify.js
      - server/utils/inbox/thread.js
      - server/utils/inbox/details.js  (the change note in pass 2)
      - server/utils/inbox/payload.js  (the link on the list row)
      - server/routes/admin/inbox.test.js
      - client/src/components/inbox/Thread.js
      - client/src/components/inbox/inboxThread.js
      - client/src/components/inbox/WaitingRows.js
      - client/src/components/inbox/WaitingRows.test.js
      - server/routes/proposals/menuDraftApprove.js  (inboxCache.invalidate only)
      - server/routes/proposals/menuDraftRelease.js  (inboxCache.invalidate only)
      - server/routes/menuProof.js  (inboxCache.invalidate only)
      - server/routes/proposals/menuPrint.js  (inboxCache.invalidate only)
      - README.md, ARCHITECTURE.md  (generated sections, and the menu tasks in ARCHITECTURE's Inbox concept)
    blockedBy: [menu-approve-send]
    lenses: tier A (server/utils/inbox/** is sensitive); lifecycle, business-time (the due time), concurrency, seams, access-egress (nothing new reaches the AI), client (captures of a row and a thread with a task), verify, the externals.
    laws: >
      Money law 15 at the client level: no task for any person the legal hold covers (engine.legalHoldPersonKeys,
      as readJob.js excludes them). The AI never reads or closes a menu task, and the client's note never
      reaches aiRedact or a provider. A reply never closes a task and a task never closes a conversation. Due
      times in America/Chicago through businessTime.js; event dates as text.
    seams: >
      The Inbox spec's amended decision 2 (written on main 2026-11-03) is the contract; every file that
      enumerates kinds or sources gets the new source (engine, classify, thread, payload, details, the client
      row and thread); the existing Inbox suites stay green; the paths that change a proof's state call
      inboxCache.invalidate().
    acceptance: >
      Suites pass (rules.*.test.js, engine.test.js, readers.test.js, subjects.test.js, inbox.test.js among
      them); the new rules test fails on main (no task kinds exist); on dev, a change request on a proof shows
      under the client within the cache window and clears when a fresh proof is approved.
    test plan: >
      menuReminder.test.js: 30, 8, 7, 3, 2 and 0 days out, no date, a sent_at late on a Chicago evening, a DST
      change. readers.test.js: each kind exactly while its state holds; none after the event day, for an
      archived proposal or the legal-hold client; changes and no_answer close on supersede, withdraw and
      release but not on an older live file, so a second proof's change request shows. rules.menuTasks.test.js:
      a reply to the client leaves the task open and a task leaves an unanswered text open; Done does not clear
      a task; a row held only by tasks hides Done; a task opened during a snooze ends it; the AI cover never
      closes a task. engine.test.js: the note loads in pass 2. A thread test: a task older than 30 days keeps
      its line and link. WaitingRows.test.js: the task's need line and link.
    revert: revert the squash; tasks vanish (derived), nothing is stored.

  - id: menu-auto-start
    scope: >
      Spec section 8 (decisions 8 and 9). The Generate route's body is extracted to startGeneration({ proposalId,
      inputs, file }) in server/routes/proposals/menuDraftGenerate.js and the route calls it. The
      menu_auto_starts table (8.4, the run-once guard). triggerMenuAutoStart gains the auto-start step after
      the mark: the 8.2 conditions (a proposal, menu owed, booked, not legal hold, not past, no draft, no print
      file, no mark, the guard insert), then startGeneration with OpenAI as the image model and the decided
      look, storing draft_id and run_id, or the error code and sentence, on the guard row. readMenuTasks gains
      menu_ready and menu_failed (13.1, including the 10-minute dead start for a row with no run_id). The
      card's "Drafted automatically when the client submitted their plan." sub line and the read model's
      auto_started.
    footprint:
      - server/db/schema.sql  (menu_auto_starts, idempotent)
      - server/routes/proposals/menuDraftGenerate.js  (new, with the header comment)
      - server/routes/proposals/menuDrafts.js  (the route calls startGeneration)
      - server/routes/proposals/menuDrafts.test.js
      - server/utils/menuAutoStart.js  (the auto-start step)
      - server/utils/menuAutoStart.test.js
      - server/utils/inbox/readMenuTasks.js  (the two run tasks)
      - server/utils/inbox/readers.test.js
      - server/utils/menuDraftRead.js  (auto_started)
      - client/src/pages/admin/menuDesigner/menuCardState.js  (the sub line)
      - client/src/pages/admin/menuDesigner/menuCardState.test.js
      - scripts/sensitive-paths.txt  (menuDraftGenerate.js)
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: [menu-inbox-tasks, menu-house-card, menu-out-of-credit, menu-no-menu-mark]
    lenses: tier A, the full floor plus schema-data, business-time and client; verify; the externals; the money smoke.
    laws: >
      A billed provider run starts from a public submit with no person in the loop: it starts at most once per
      proposal (the primary key), only for a booked proposal, never for the legal-hold proposal (fails closed),
      never for a past or archived event, and inside the existing daily caps (a capped start records the
      sentence, nothing is called). The trigger runs after the submit's COMMIT and release, on its own pool
      connections; it never fails or delays the submit response. The run's prompts follow the menu art AI rule
      (no client name, contact, venue, address or event date).
    seams: >
      startGeneration is the one path for a manual and an automatic Generate; the guard row's error sentences
      are menuArtJobErrors' and section 8.3's; readMenuTasks' two new kinds follow 13.1's closing rules (any
      print file or the mark closes them); the submit tails are the same two call sites lane menu-no-menu-mark
      added.
    acceptance: >
      Suites pass and the money smoke passes; the auto-start test fails on main (no draft starts on submit); the
      owner has added OpenAI credit; the live walk on dev (spec 25): submit a test plan for a dev birthday
      event and see "Menu ready to review" in the Inbox, open it, approve and send, and follow the rest of the
      walk; a Skip the Menu submit marks the event; a December holiday party draws the gifts low and centres the
      footer.
    test plan: >
      menuAutoStart.test.js: each 8.2 skip starts nothing (including a non-booked status and a text-compared
      past date); two concurrent calls start one run; a resubmit after a reopen starts none; each thrown error
      (not configured, Gemini not configured, no drinks, each cap, anything else) lands on the guard row with its
      sentence; success stores draft_id and run_id; the trigger holds no submit client. menuDrafts.test.js: the
      route through startGeneration behaves exactly as before (the existing Generate suite green).
      readers.test.js: menu_ready while the auto run is current, finished and unapproved; menu_failed for an
      error row, a failed words step, a stale run and a dead start older than 10 minutes; both closed by a print
      file, the mark, a manual Generate, or an approval; a deleted draft raises nothing. menuCardState.test.js:
      the sub line while menu_ready is open.
    revert: revert the squash; the guard table stays and keeps any proposal it names from auto-starting again, which is the intended once-only rule.
---

# Menu designer v2: the lane map

The spec, `docs/superpowers/specs/2026-10-19-menu-designer-v2-design.md` rev 2, is the design; this plan cuts it into eleven lanes that each build, review and revert on their own. The spec's sections are the requirements; the front matter above is what each lane builds, which files it may touch, and how it is accepted.

## Order

```
menu-out-of-credit ────────────────────────────┐
menu-bar-fingerprint ── menu-no-menu-mark ─────┤
menu-mark-placement ── menu-fonts-twelve ──────┴── menu-brief-tab ── menu-house-card ──┐
menu-proof-page ───────────────────────────────────────────────────────────────────────┴── menu-approve-send ── menu-inbox-tasks ── menu-auto-start
```

(menu-approve-send also waits on menu-no-menu-mark; menu-auto-start also waits on menu-house-card, menu-out-of-credit and menu-no-menu-mark, all merged by then.)

- **Can start at once, in parallel:** menu-out-of-credit, menu-bar-fingerprint, menu-mark-placement, menu-proof-page. They share no file.
- **Serialized only to keep footprints apart:** the no-menu mark follows the fingerprint (both edit `menuDraftRead.js` and `menuCardState.js`); fonts follow placement (both edit `DesignTab.js` and `menuDraftValidation.js`); the Brief tab follows those and the out-of-credit lane (both edit `menuArtJob.test.js`). menu-no-menu-mark and menu-proof-page both add to `schema.sql` in different places with no order between them; that is an ordinary merge conflict, resolved from both diffs (CLAUDE.md). README and ARCHITECTURE never conflict: the merge regenerates them.
- **Serialized by dependency:** the house card needs the Brief tab's stored-inputs rule; approve and send needs the proof table, the house card's moved `layoutPieceKeys` and the mark's provenance; the Inbox tasks need proofs; auto-start needs everything it hands a draft to.
- **Every merged lane is safe to ship alone.** The proof routes land with no proof to show; the Inbox reader lands before anything can raise a task; auto-start lands last.

## Owner steps (not lanes)

1. **Add OpenAI credit** in OpenAI's billing settings before menu-auto-start ships (spec 24), and before any live walk that generates a menu. The out-of-credit lane makes the error say so either way.
2. **Say yes to the no-menu backfill's production run** after menu-no-menu-mark ships: Claude runs the dry run first and shows the counts and the excluded legal-hold count.
3. **The fix list** (`docs/fix-list-remaining-2026-07-02.md`) is the owner's: each lane report names the lines it closes with its sha and the test that failed on main (bar picks and the one-client `Promise.all` by menu-bar-fingerprint; `approved_by` ON DELETE by menu-approve-send; the Potions notes items 1 to 5 and 7 by their lanes).

## Global constraints

- No em dashes in any client, staff or admin copy, or in comments that become README lines.
- Copy exactly as the spec's section 28 fixes it; the email's link line is "The link works until your event." (30 days with no event date).
- Event dates compare as `event_date::text` (YYYY-MM-DD) against `chicagoTodayYmd()`; instants convert through `server/utils/businessTime.js`; the business zone is America/Chicago.
- One pooled connection per request; email and other post-commit tails run after `client.release()`.
- Parameterized SQL only; `asyncHandler` and `AppError` subclasses; error bodies `{ error, code, fieldErrors? }`, keyed on codes.
- Schema changes are idempotent statements in `server/db/schema.sql`; no data backfill runs from it.
- Every new source file starts with the header comment whose first paragraph is its README line; `npm run docs` after each lane; no file grows past 1000 lines (aim under 300: `HouseCard.js` exists so `MenuCanvas.js`, at 282, does not grow past the ratchet).
- Providers only through their wrappers; menu art sends no client name, contact, venue, address or event date; every menu art suite sets `process.env.NODE_ENV = 'test'` on its first line.
- No real client or staff name, phone or email in any fixture, commit or diff; fixtures use the PII scanner's allowed shapes.
- The legal-hold proposal is never written by any path here; every writer calls `isLegalHold`, which fails closed.
- No new environment variables.

## Review Focus

The inputs most likely to bite that no single lane's own scope would naturally test, each pinned to the lane that owns the code:
1. **A client's Looks great racing Dallas's mark, upload or release** on the same proposal. Expected: whichever commits first wins and the other is refused or skipped cleanly, the mark is never cleared, and the duty line matches the final key. Owner: menu-approve-send, a test that runs the answer and the mark PATCH concurrently against one proposal (both take the draft and proposal `FOR UPDATE`).
2. **A proof sent on a Chicago evening** (the GMT date is already tomorrow) for an event eight days out, and a link opened at 11:30 p.m. on the event day. Expected: the reminder falls at 9:00 a.m. Chicago on the day a week out, and the link is still open. Owners: menu-inbox-tasks (`menuReminderDueAt`) and menu-proof-page (the token life).
3. **A client with an unanswered text and an open menu task.** Expected: Dallas's text reply clears the text but not the task; Done hides nothing the task needs; approving the menu never marks the text answered. Owner: menu-inbox-tasks, `rules.menuTasks.test.js`.
4. **A plan submitted twice in the same second, or reopened and resubmitted, or with two plans on one proposal.** Expected: one run at most, from the designer's lowest-id plan. Owner: menu-auto-start, the concurrency and resubmit tests.
5. **A Standard Menu event with many drinks.** Expected: the house card steps names down to 24 px and then shows Too long with Approve disabled, never a clipped print file. Owner: menu-house-card, `HouseCard.test.js` with a 20-drink fixture.

## Build method

Each lane is small and coherent enough for one pass by Claude in its own worktree, test first, with the review skill run at the end; menu-house-card and menu-approve-send are the two large lanes, and each may use parallel subagents for its client and server halves, since their interfaces are fixed by the spec (the content keys of 9.1 to 9.3; the `releaseHeldPrint` reasons and the print states of 10.3). The lane report says which method it used.

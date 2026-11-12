---
spec: docs/superpowers/specs/2026-10-19-menu-designer-v2-design.md (rev 2, 2026-11-03; builder check and the design-stage spec review folded in)
format: lane map without code (spec 2026-10-19 D12)
revision: 2 (2026-11-03; the design-stage plan review folded in, owner "go")
status: >
  Eighteen lanes (twelve, then six split from lane reviews). Claude cuts each from current main with npm run worktree:new, builds it, reviews it at the
  tier the review skill computes, squash-merges it through scripts/merge-lane.sh from os and removes it.
  Lanes merge in the order the blockedBy graph allows, and every merged lane is safe to ship alone, the
  bar chain excepted (below): the
  public proof routes land with no proof to show, the Inbox reader and all four task kinds land before
  anything can hold a print file or raise a task, the events dashboard change lands after the reminders
  it relies on, and auto-start lands last. menu-auto-start ships only after the owner adds OpenAI credit
  (spec section 24). The ship of any merged lane waits for the owner's word.
  The bar chain cannot ship lane by lane: menu-bar-fingerprint (8121cd78) and menu-bar-baseline (53d63688)
  merged, never shipped alone, and were reverted by 7882775a, which shipped 2026-11-05. The chain is now one
  lane, menu-bar-chain (2026-11-06): the receipt binds a lane to a review of main..tip, so a lane stacked on
  another unmerged lane cannot keep its receipt once the lower one merges. menu-bar-chain re-applies both
  squashes, carries the menu-bar-legacy-keys commits and builds menu-bar-renamed-lines' scope on top; it is
  reviewed once as one change and ships on its own; it merged as 4b5ef352 on 2026-11-06. The four lane
  entries stay below as the record of their scope. menu-legal-hold-guards changes no stored data, so it leaves the chain: it follows menu-bar-chain
  and ships on its own.
lanes:
  - id: menu-out-of-credit
    scope: >
      Spec section 16. An empty provider balance reads as out of credit, stops at once and says so. OpenAI's
      mapError maps a 429 or 403 whose code is insufficient_quota or credit_balance_exhausted to a new
      OpenAIOutOfCredit, never a rate limit, never retried; menuImageProvider wraps it as MenuArtOutOfCredit;
      menuArtJobErrors gains the words and piece sentences and captures to Sentry once per run. Gemini's
      mapError keeps the rpc status on the descriptor and maps a spent prepaid balance to the same class when
      its error details show a billing reason; when they cannot, Gemini keeps today's retries and the sentence
      after the second failed retry becomes the "still refusing, check billing" line. The lane report states
      which Gemini case it found, with the SDK error shape it read as evidence. Added by its review
      (2026-11-03): a piece's out-of-credit failure also ends Update draft's shared piece run, the Update
      draft words call gets its own sentence, and billing_hard_limit_reached reads as out of credit (spec 16).
      Showing the sentences on the card moved to lane menu-error-display.
    footprint:
      - server/utils/openaiClient.js  (mapError and the new error class; nothing else)
      - server/utils/openaiClient.test.js
      - server/utils/geminiClient.js  (mapError and the descriptor's status; nothing else)
      - server/utils/geminiClient.test.js
      - server/utils/menuImageProvider.js  (the out-of-credit wrap)
      - server/utils/menuImageProvider.test.js
      - server/utils/menuArtJobErrors.js  (SENTENCES, the no-retry branch, Sentry once per run)
      - server/utils/menuArtJobWords.js  (only if the words step's catch must name the new class)
      - server/utils/menuArtJob.js  (stop the run at the first out-of-credit piece, so Sentry hears once per run; added 2026-11-03 when the build found pieces kept drawing after an empty balance)
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
      the descriptor stored in the menu_art_calls ledger keeps its keys (code, status, requestId, errorClass,
      provider); a plain 429 rate limit keeps retrying exactly as today.
    acceptance: >
      The reached server suites pass through run-suites; the new mapping tests fail on main for their stated
      reason under the review skill's failing-test procedure (on main a 429 with code credit_balance_exhausted
      is a rate limit, is retried twice and ends in "OpenAI is busy right now. Try again in a minute.").
    test plan: >
      openaiClient.test.js: a 429 with code credit_balance_exhausted and one with insufficient_quota each map
      to OpenAIOutOfCredit with the code kept on the descriptor; a 403 with insufficient_quota likewise; a plain
      429 still maps to OpenAIRateLimited. geminiClient.test.js: the descriptor carries the rpc status; the
      billing-reason case, or, if Gemini cannot be told apart, a RESOURCE_EXHAUSTED still maps to
      GeminiRateLimited. menuArtJob.test.js: the words step on out of credit stores the words sentence, makes
      no retry (the sleep hook is never called), marks pieces not attempted and captures once; a piece on out
      of credit stores the piece sentence; the existing busy and retry tests stay green with their old
      sentences.
    revert: >
      Revert the one squash commit; nothing is stored in a new shape. Revert menu-brief-tab first if it has
      merged (it edits menuArtJob.test.js after this lane).

  - id: menu-bar-fingerprint
    scope: >
      Spec section 17 (revised twice by this lane's review, 2026-11-03). The plan-changed check notices bar
      picks by what the menu prints, line by line: the fingerprint stores bar_lines (the hash of each Also at
      the bar line the current picks would print, keyed by its label) and bar_hash over them; computeDiff
      reports bar_changed when a label's line hash moved, appeared or went; a draft fingerprinted before this
      takes today's picks as its baseline on its first GET (a one-time write to plan_fingerprint, no version
      bump); Update draft rewrites only the changed lines, keeps every other line's text (hand edits
      included) and stores only what it applied (drink keys and the bar baseline, keeping the brief and
      planner-image parts); the AI key check in the sync runs only when a provider is called; the card and
      the Brief tab print "The bar picks changed since this draft.", beside the drink lines and the notes
      line when those changed too. The same lane fixes the Promise.all on one
      pg client in Update draft's catalog load (through loadCatalogMaps): the maps load sequentially on the
      held client, or through the pool before the client is taken. The lane report names both fix-list lines
      it closes, each with its own failing test.
    footprint:
      - server/utils/menuDrinkSource.js  (buildFingerprint, fingerprintHash)
      - server/utils/menuDrinkSource.test.js
      - server/utils/menuDraftRead.js  (computeDiff)
      - server/utils/menuDraftRead.test.js
      - server/routes/proposals/menuDraftSync.js  (the stored hash on Update draft and Dismiss; the one-client load)
      - server/routes/proposals/menuDrafts.test.js  (where the sync routes are tested)
      - client/src/pages/admin/menuDesigner/menuCardState.js  (the diff line)
      - client/src/pages/admin/menuDesigner/menuCardState.test.js
      - client/src/pages/admin/menuDesigner/BriefTab.js  (the diff line)
      - client/src/pages/admin/menuDesigner/BriefTab.test.js
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: []
    lenses: the computed tier (menuDraftSync.js is sensitive); concurrency (the one-client fix), seams (the diff shape the client reads).
    laws: CLAUDE.md one pooled connection per request (a handler holding pool.connect() sends every query through it); the drinks and brief parts of the fingerprint are unchanged, so no existing draft lights up on deploy.
    seams: the diff object's new key bar_changed is read by menuCardState.js and BriefTab.js; the house card lane later writes house_sections from the same plan, so the bar hash covers the house card too.
    acceptance: >
      Suites pass; the fingerprint test fails on main (a changed wine pick yields no diff on main), and the
      one-client test fails on main (concurrent queries on the held client).
    test plan: >
      menuDrinkSource.test.js: two plans differing only in a wine pick give different fingerprints; list order
      does not change the hash. menuDraftRead.test.js: bar_changed true for a bar change, false for an old
      fingerprint with no bar_hash; an admin brief value never changes the diff. menuDrafts.test.js: Update
      draft stores bar_hash; the catalog load runs no concurrent queries on one client. menuCardState and
      BriefTab tests: the line renders on bar_changed.
    revert: >
      Revert after any merged lane that edits the same files (menu-no-menu-mark, menu-brief-tab,
      menu-house-card, menu-error-display); drafts that stored bar_hash keep an extra key the old code
      ignores, but a banner dismissed after the deploy hashed the bar, so a revert brings those banners back
      once (each is dismissed again or updated).

  - id: menu-bar-baseline
    scope: >
      Split from menu-bar-fingerprint by its second fix re-pass (2026-11-04, the review cap reached), and
      reshaped by this lane's own review (2026-11-04). (1) Update draft found the stored Also at the bar line
      to refresh by its label, which the owner can rename: each line now carries a server-written key (the
      builder's label), written by parseWords (keyedBarLines) and kept through every PATCH, and Update draft
      matches and orders by it; a line stored before keys (or one a racing PATCH stored without its key) is
      keyed by Update draft under its row lock (keyBarLines: by label, else by its place in the print order
      among the categories the draft's baseline names). (2) The GET's one-time baseline stamp absorbed bar
      changes made before the first open, moved the Saved time and could fail the read: it is removed, and the
      server stamps every pre-deploy draft once at its first production boot (menuBarBaselineStamp.js, from
      the scheduler block in server/index.js), writing plan_fingerprint only, from today's picks except that a
      category the stored lines prove came or went since Generate keeps reading as a change
      (legacyBarBaseline); a draft Update draft reaches before the stamp takes the same baseline. (3) The
      menu_drafts updated_at trigger skips a write that changes only plan_fingerprint or dismissed_plan_hash,
      so the stamp and Dismiss leave the Saved time alone. Spec section 17 is amended with the lane.
    footprint:
      - server/routes/proposals/menuDraftSync.js  (match by key; key unkeyed lines; the legacy baseline)
      - server/routes/proposals/menuDrafts.test.js
      - server/utils/menuAlsoAtBar.js  (keyedBarLines, barLineKey, keyBarLines)
      - server/utils/menuAlsoAtBar.test.js
      - server/utils/menuArtPrompts.js  (parseWords stores keyed lines)
      - server/utils/menuArtPrompts.test.js
      - server/utils/menuDraftValidation.test.js  (the PATCH keeps the stored key, refuses one in the body)
      - server/utils/menuDraftRead.js  (the GET stamp removed)
      - server/utils/menuDraftRead.test.js
      - server/utils/menuDrinkSource.js  (legacyBarBaseline; the fingerprint header)
      - server/utils/menuDrinkSource.test.js
      - server/utils/menuBarBaselineStamp.js  (new, with the header comment)
      - server/utils/menuBarBaselineStamp.test.js  (new)
      - server/index.js  (the one-time call in the production scheduler block)
      - server/db/schema.sql  (the updated_at trigger narrowed, swapped in place once)
      - server/db/schema.menuArt.test.js
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: [menu-bar-fingerprint]
    lenses: tier A (menuDraftSync.js, server/index.js and schema.sql are sensitive); seams, lifecycle, concurrency, outcomes-providers, schema-data, money, access-egress, verify, the externals, the money smoke.
    laws: >
      Money law 15: the boot stamp skips the legal-hold proposal through isLegalHold, which fails closed.
      Parameterized SQL only; the boot log carries draft ids and counts, never content. Nothing here writes a
      proposal column, the print key or menu_not_required, or bumps a draft's version. The schema change is
      idempotent in schema.sql; the data stamp is JS at boot, never in schema.sql.
    seams: >
      The line key is server-written: the words step and Update draft write it, the PATCH keeps it, and every
      reader of also_at_bar (MenuCanvas, the export, the house card later) ignores it; plan_fingerprint.bar_lines
      stays keyed by the builder's label, so keys and baselines share one vocabulary; updated_at is read only
      as the card's Saved time.
    acceptance: >
      Suites pass and the money smoke passes; the renamed-line test fails on menu-bar-fingerprint's merge (a
      renamed line keeps its old pick after Update draft); a GET on a legacy draft writes nothing; the dev
      trigger carries the WHEN clause after the boot replay; the stamp test shows a provable category change
      flagged and the Saved time unmoved.
    test plan: >
      menuDrafts.test.js: a renamed keyed line rewritten in place, removed, or kept with its words and place; an
      unkeyed renamed line keyed from the baseline; a draft with no baseline keyed and given the provable
      baseline, then repaired by the next Update draft; Dismiss leaves the Saved time. menuAlsoAtBar.test.js:
      keyedBarLines and keyBarLines on every legacy shape. menuDrinkSource.test.js: legacyBarBaseline.
      menuArtPrompts.test.js: keyed lines from parseWords. menuDraftValidation.test.js: the PATCH and the key.
      menuDraftRead.test.js: a GET on a legacy draft writes nothing. menuBarBaselineStamp.test.js: the stamp on
      unchanged and provably changed drafts, the skips, idempotence, the log line and a failure.
      schema.menuArt.test.js: the trigger block and the live trigger.
    revert: Revert the squash before menu-bar-fingerprint's; stored line keys are extra keys the old code ignores, and the narrowed trigger stays (a later replay of the old block sees the trigger present and leaves it).

  - id: menu-bar-legacy-keys
    scope: >
      Split from menu-bar-baseline by its second fix re-pass (2026-11-04, the review cap reached). That lane
      keys a line stored before keys by its label, then by its place in the print order, then by the table
      words in its text, and its last re-pass found every heuristic edge reachable: a brand name carrying
      another category's word mis-keys a line; the line count proves a gone category only in one direction
      and hides a swap; the unkeyed-line fallback in refreshBarLines replaces a line whose picks held; and
      keys the boot stamp derives in memory can be lost to a canvas edit before Update draft. This lane trades
      the heuristics for certainty: a pre-deploy line still under a builder label is keyed by that label,
      exactly; every other pre-deploy line stays unkeyed, and a draft holding one reads its bar as changed
      once (the boot stamp and Update draft leave the unkeyed categories out of the baseline), so the card
      flags it and the Update draft it invites rebuilds those lines from today's picks, the owner's words on
      them lost once and visible on the canvas before re-approval; refreshBarLines replaces unkeyed lines only
      when a changed label has no keyed line. The boot log lists the drafts flagged this way. Also: the boot
      stamp's UPDATE ties to the run_id and done words its SELECT read, so a Start over on the deploy's
      outgoing instance is never stamped from replaced lines; and its words-pending list skips the legal-hold
      proposal (money law 15). Spec section 17 is amended with the lane.
      As built (reviewed 2026-11-04): its full pass found the flag on every renamed line false and costly (the
      card said the bar picks changed though none moved, a dismissal made before the deploy was cancelled, an
      Approved menu flipped to Plan changed), so its two fix rounds matched each renamed line to a category no
      keyed line covers by its place in the print order, flagging the draft only when the line count, the order
      or the line's own table words showed a category came or went, and listing in the boot log the matches no
      word could check. The PATCH keys a builder-labelled line before an edit can rename it, through
      keyBarLines; refreshBarLines drops a keyed line whose category the picks no longer build; the stamp's
      raced and legal-hold counts are exact. Its second re-pass found the match and the word check reachable
      both ways, which split to menu-bar-renamed-lines; once it merges and until that lane does, main matches a renamed
      pre-deploy line by place.
    footprint:
      - server/utils/menuAlsoAtBar.js  (keyBarLines by label only; mapRenamedLines and wordCategory, the interim match)
      - server/utils/menuAlsoAtBar.test.js
      - server/utils/menuDrinkSource.js  (legacyBarBaseline: keyed lines, then the match or an unkeyed:<place> entry per renamed line)
      - server/utils/menuDrinkSource.test.js
      - server/routes/proposals/menuDraftSync.js  (refreshBarLines replaces unkeyed lines only for a changed label no keyed line covers)
      - server/routes/proposals/menuDrafts.test.js
      - server/utils/menuDraftValidation.js  (the PATCH keys an edited builder-labelled line through keyBarLines)
      - server/utils/menuDraftValidation.test.js
      - server/utils/menuBarBaselineStamp.js  (the run_id guard; the pending list skips the held proposal; the flagged list)
      - server/utils/menuBarBaselineStamp.test.js
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: [menu-bar-baseline]
    lenses: tier A (menuDraftSync.js is sensitive); seams, lifecycle, concurrency, outcomes-providers, money, verify, the externals, the money smoke.
    laws: Money law 15 on the boot stamp's every read, the pending list included; nothing here writes a proposal column, the print key or menu_not_required, or bumps a version.
    seams: the line key and bar_lines keep one vocabulary (the builder's labels); the words step's and Update draft's keyed lines are untouched; only pre-deploy unkeyed lines change behavior.
    acceptance: Suites pass and the money smoke passes; the re-pass 2 shapes of menu-bar-baseline (a brand word mis-key, a gone category behind an unkeyed line, a swap, a held line replaced) each fail on menu-bar-baseline's merge and pass here.
    test plan: >
      menuAlsoAtBar.test.js: a renamed line stays unkeyed whatever its place or words. menuDrinkSource.test.js:
      legacyBarBaseline with unkeyed lines reads their categories as new. menuDrafts.test.js: an unkeyed line
      is rebuilt when its category has no keyed line, kept when every changed label is keyed; a renamed
      pre-deploy draft is flagged once and repaired in one Update draft. menuBarBaselineStamp.test.js: a Start
      over between the SELECT and the UPDATE is not stamped; the held proposal never appears in any list.
    revert: Revert the squash before menu-bar-baseline's; nothing is stored in a new shape.

  - id: menu-bar-renamed-lines
    scope: >
      Split from menu-bar-legacy-keys by its second fix re-pass (2026-11-04, the review cap reached). That
      lane matched a renamed pre-deploy line to a category by its place, with its table words as a check, and
      its last re-pass found the guess reachable both ways: a brand word contradicts a held match (sparkling on
      an NA line, red in a whisky name, IPA in an NA beer) and the line is rebuilt under a false "The bar picks
      changed" card; a line with no category word, or one whose words seem to confirm it (bourbon in a stout),
      hides a whole-category swap and keeps printing the dropped category; Update draft's no-baseline path
      matches and lists nothing; an edit after the stamp re-checks the words, unmatches a held line, rebuilds
      it and ranks it out of order; and a draft the stamp failed on is rebuilt with no flag ever shown. This
      lane goes back to spec 17's rule and fixes what menu-bar-legacy-keys' full pass found wrong with it. A
      renamed pre-deploy line is never matched (mapRenamedLines, wordCategory and their word table go) and
      always carries its unkeyed:<place> entry. The diff reports those entries as bar_unchecked, apart from
      bar_changed and bar_changed_labels, which name builder labels only: "The bar picks changed since this
      draft." prints only for a real pick move, a dismissal made before the deploy still holds, and the card
      keeps its state. The card's lines and the Brief tab carry instead "A bar line renamed before bar picks
      were tracked can't be checked against them. Update draft rebuilds it from the client's picks." Update
      draft rebuilds and keys every unkeyed line it holds, whatever else it applies. The GET reads a draft with
      no stored baseline against legacyBarBaseline, so what the card shows is what Update draft does. The boot
      log lists by id the drafts holding such a line, and its hand-check list goes. The PATCH keying, the
      run_id guard, the legal-hold counts and the dead-key removal stay. Also: the Update draft tests move
      out of menuDrafts.test.js into a suite of their own, since that suite runs about 164 s against the
      runner's fixed 180 s cap and timed out on a loaded dev database at menu-bar-legacy-keys' rebase. Merges
      right after menu-bar-legacy-keys and before any ship.
    footprint:
      - server/utils/menuAlsoAtBar.js  (mapRenamedLines, wordCategory and the word table removed)
      - server/utils/menuAlsoAtBar.test.js
      - server/utils/menuDrinkSource.js  (legacyBarBaseline: every unkeyed line its unkeyed:<place> entry)
      - server/utils/menuDrinkSource.test.js
      - server/utils/menuDraftRead.js  (bar_unchecked apart from bar_changed; a no-baseline draft read against legacyBarBaseline)
      - server/utils/menuDraftRead.test.js
      - server/routes/proposals/menuDraftSync.js  (no match; every unkeyed line rebuilt and keyed; the GET's diff)
      - server/routes/proposals/menuDrafts.test.js
      - server/routes/proposals/menuDraftSync.test.js  (new: the Update draft tests, moved)
      - server/utils/menuBarBaselineStamp.js  (the flagged list names drafts holding an unkeyed line; the hand-check list removed)
      - server/utils/menuBarBaselineStamp.test.js
      - client/src/pages/admin/menuDesigner/menuCardState.js  (the unchecked sentence; the state unchanged)
      - client/src/pages/admin/menuDesigner/menuCardState.test.js
      - client/src/pages/admin/menuDesigner/BriefTab.js
      - client/src/pages/admin/menuDesigner/BriefTab.test.js
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: [menu-bar-legacy-keys]
    lenses: tier A (menuDraftSync.js is sensitive); seams, lifecycle, concurrency, outcomes-providers, money, access-egress, client, verify, the externals, the money smoke, the client build.
    laws: Money law 15 on the boot stamp's every read; Update draft's existing write is the only write the change reaches; nothing writes a proposal column, the print key or menu_not_required, or bumps a version.
    seams: bar_changed keeps meaning a builder label's pick moved for every reader (the card, the Brief tab, pickState and the dismissal rule); bar_unchecked is a count the client reads only for its sentence; the GET and Update draft read one legacy baseline.
    acceptance: >
      Suites pass, the money smoke passes and the client builds; each re-pass 2 shape of menu-bar-legacy-keys
      (a sparkling NA line, a whisky-red Spirits line, a brand-only swap, a bourbon-stout swap, an edit after
      the stamp, a draft the stamp failed on) fails on menu-bar-legacy-keys' merge and passes here; a
      dismissal made before the deploy survives a draft whose only difference is a renamed line.
    test plan: >
      menuAlsoAtBar.test.js: a renamed line stays unkeyed whatever its place or words. menuDrinkSource.test.js:
      every unkeyed line has its entry whatever the count, order or words. menuDraftRead.test.js: unkeyed
      entries read as bar_unchecked, never bar_changed; a pre-deploy dismissal holds; a no-baseline draft reads
      its legacy baseline. menuDraftSync.test.js: Update draft rebuilds and keys each unkeyed line and keeps every
      keyed line's words, for each re-pass 2 shape. menuBarBaselineStamp.test.js: the flagged list names a
      draft holding an unkeyed line. menuCardState.test.js and BriefTab.test.js: the unchecked sentence shows,
      the bar-changed sentence does not, and the card's state is unchanged.
    revert: Revert the squash before menu-bar-legacy-keys'; bar_unchecked is a read field, nothing is stored in a new shape.

  - id: menu-bar-chain
    scope: >
      The bar chain as one lane (2026-11-06): the scope of menu-bar-fingerprint, menu-bar-baseline,
      menu-bar-legacy-keys and menu-bar-renamed-lines above, in that order, built in one worktree cut from
      current main. Its first commit reverts 7882775a, re-applying 8121cd78 and 53d63688 exactly; the next
      carry the six menu-bar-legacy-keys commits (reviewed to receipt 9cb2505, its record); the rest build
      menu-bar-renamed-lines' scope, which replaces the legacy-keys match by place and word check before
      anything ships. Nothing in it ships until the whole lane merges, so the one-time boot stamp only ever
      runs with the final renamed-line rule.
    footprint:
      - the union of the four lanes' footprints above
    blockedBy: []
    lenses: tier A; money (law 15), lifecycle, concurrency, outcomes-providers, access-egress, seams, schema-data (schema.sql, the boot stamp), client (the card and the Brief tab); verify; the externals; the money smoke; the client build.
    laws: the four lanes' laws above; money law 15 on the boot stamp's every read; one pooled connection per request in Update draft.
    seams: the four lanes' seams above. The menu_drafts trigger: the lane's schema.sql narrows it, and main's schema.menuArt.test.js (since 7882775a) pins the unnarrowed one, so while the lane is under test the two fight over the shared dev database; the lane's suites replay its schema first, and a window running main's menu schema suite meanwhile may see it fail on dev.
    acceptance: >
      The four lanes' acceptance checks, each test failing on main (which holds none of the chain): the
      reached suites, the money smoke and the client build pass.
    test plan: the four lanes' test plans above, with the Update draft tests in their own suite (menuDraftSync.test.js).
    revert: >
      Revert the one squash. A ship followed by a revert leaves the stamped bar_lines in plan_fingerprint and
      the stored line keys in content, which the reverted code ignores, and the narrowed trigger, which a later
      replay leaves in place (harmless in production: the Saved time then moves only on a real edit; but the
      reverted schema.menuArt.test.js pins the unnarrowed trigger, so a revert restores it by hand on dev and
      in the same change, or that suite fails). A Dismiss or Mark reviewed made while the lane was live hashed
      bar_hash, which the reverted code's fingerprintHash omits, so those drafts show their banner again once.

  - id: menu-bar-rebuild-only
    scope: >
      Split from menu-bar-chain by its second fix re-pass (2026-11-06, the review cap reached). Three display
      leftovers on drafts made before bar tracking, none of which prints a wrong line or touches money. First,
      the unchecked notice offers the full Update draft, which also applies every dismissed drink change and
      needs the art keys, so with drawing off and a dismissed added drink the click is refused with 503 and
      the renamed line cannot be rebuilt; and it clears dismissed_plan_hash while keeping the stored brief
      parts, so a notes edit already marked reviewed asks for review again. Second, round 2 of the chain makes
      no dismissal cover a stored keyed line the picks no longer build that the baseline never named, so on
      that state the Plan changed Dismiss and Mark reviewed do nothing. This lane adds a bar-only rebuild:
      Update draft with scope bar (the notice's own button) rebuilds and keys only the unkeyed lines and the
      keyed lines whose category the picks no longer build, applies no drink change, needs no AI key, keeps
      the stored drink, brief and image parts of the fingerprint and re-stamps a dismissal that matched before
      it; the notice drops the dismissed-changes clause, since the bar-only rebuild applies none of them. And
      a dismissal covers a gone line: the dismissal hash takes the gone keys, so a Dismiss stored after the
      change holds. Third, the chain's verify pass (on Opus, 2026-11-06) found two more on the same drafts.
      A renamed line renamed back to its builder label after the boot stamp leaves the stamp's entries from
      that day's picks for the categories no keyed line covered, so a category the client added before the
      deploy reads unchanged and Update draft never builds it (the same draft unstamped reads it as new);
      round 2's gone-line rule gets its mirror, so a stamped category no stored line stands for reads as new
      once no unkeyed line is left. And while a piece paints the notice is hidden but the editor's Plan
      changed banner still offers Update draft, so the click rebuilds a renamed line with no warning; that
      button waits while a piece paints, or the banner keeps the notice's sentence.
    footprint:
      - server/routes/proposals/menuDraftSync.js  (the scope bar request: validated, rebuilds bar lines only, under the same row lock and version check)
      - server/routes/proposals/menuDraftSync.test.js
      - server/utils/menuDraftRead.js  (the dismissal hash covers gone keys; the lineGone refusal goes)
      - server/utils/menuDraftRead.test.js
      - server/utils/menuDrinkSource.js  (fingerprintHash takes the gone keys, if that is where they live; computeDiff reads a stamped category no stored line stands for as new once no unkeyed line is left)
      - server/utils/menuDrinkSource.test.js
      - client/src/pages/admin/menuDesigner/menuCardState.js  (the notice's Update draft sends scope bar; the dismissed-changes clause goes; the Plan changed banner's Update draft waits while a piece paints when the draft holds an unchecked line)
      - client/src/pages/admin/menuDesigner/menuCardState.test.js
      - client/src/pages/admin/menuDesigner/useMenuDraft.js  (sync takes a scope)
      - client/src/pages/admin/menuDesigner/MenuDesignerCard.js, MenuEditor.js  (the notice's action passes the scope)
      - server/routes/proposals/menuDrafts.js  (Dismiss and Mark reviewed store dismissalHash, so a Dismiss on a renamed-back gone line holds; added at the build, 2026-11-12)
      - client/src/pages/admin/menuDesigner/BriefTab.test.js  (its pin of the dismissed-changes clause the lane removes)
      - README.md, ARCHITECTURE.md  (generated sections and the Update draft route row)
    blockedBy: [menu-bar-chain]
    lenses: tier A (menuDraftSync.js is sensitive); money, lifecycle, concurrency, outcomes-providers, access-egress, seams, client; verify; the externals; the money smoke; the client build.
    laws: money law 15 (Update draft's legal-hold refusal runs first for either scope); a bar-only rebuild reserves nothing and calls no provider; one pooled connection per request.
    seams: the full Update draft is unchanged; the scope is a closed value the server validates; the card, the editor banner and the Brief tab read one notice.
    acceptance: Suites, the money smoke and the client build pass; each leftover shape of menu-bar-chain's re-pass 2 (a dismissed added drink with drawing off, a reviewed notes edit, a Dismiss on a renamed-back gone line, a renamed-back line beside a category added before the stamp, an Update draft offered while a piece paints) fails on menu-bar-chain's merge and passes here.
    test plan: menuDraftSync.test.js: scope bar rebuilds only unkeyed and gone lines, applies no drink change, needs no key, keeps a dismissal and a reviewed notes edit; refuses the held proposal; refuses an unknown scope. menuDraftRead.test.js: a Dismiss stored after a gone line holds; a stamped draft whose renamed line is renamed back reads a category added before the stamp as new. menuDrinkSource.test.js: computeDiff on that baseline. menuCardState.test.js: the notice's button sends scope bar and names no dismissed changes; while a piece paints the Plan changed banner offers no live Update draft on a draft with an unchecked line.
    revert: revert the one squash commit; nothing is stored in a new shape.

  - id: menu-legal-hold-guards
    scope: >
      Split from menu-bar-fingerprint by its review (2026-11-04, the review cap reached): no menu art path
      guards the legal-hold proposal. Its money pass found the GET's one-time bar baseline stamp writes
      plan_fingerprint with no isLegalHold call (that stamp leaves the GET in lane menu-bar-baseline, whose
      script skips the held proposal), and Generate, the draft PATCH, re-roll, Dismiss, Approve
      and the menu print POST, PATCH and DELETE have none either (older gaps; Update draft's refusal landed in
      menu-bar-chain, whose card offers it more often). Every one of them now refuses the
      legal-hold proposal before it reads the plan, calls a provider or writes, with 409 LEGAL_HOLD through the
      patchGuards.js assertNotLegalHold precedent (isLegalHold, which fails closed). Generate and re-roll
      refusing first also keeps the held booking's plan away from the AI (money law 15: never read by the AI).
      The boot stamp's SELECT_SQL and PENDING_SQL also leave the held proposal out through heldProposalIds()
      (lane legal-hold-auto of plan 2026-11-05, merged 552093c7), so the stamp never reads the held draft's row; today it reads the
      row and skips it through isLegalHold before any plan read or write.
      Follows menu-bar-rebuild-only (both edit menuDraftSync.js) and ships on its own (it changes no stored data).
    footprint:
      - server/routes/proposals/menuDrafts.js  (Generate, PATCH, re-roll, Dismiss)
      - server/routes/proposals/menuDraftSync.js  (Update draft)
      - server/routes/proposals/menuDraftApprove.js  (Approve)
      - server/routes/proposals/menuPrint.js  (POST, PATCH, DELETE)
      - server/routes/proposals/menuDrafts.test.js
      - server/routes/proposals/menuDraftApprove.test.js
      - server/routes/proposals/menuPrint.test.js
      - server/utils/menuBarBaselineStamp.js  (SELECT_SQL and PENDING_SQL leave the held proposal out through heldProposalIds(); the comment on its isLegalHold check says it also throws on an id it cannot read)
      - server/utils/menuBarBaselineStamp.test.js  (a synthetic held draft is never selected and still counts under legal hold)
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: [menu-bar-rebuild-only, legal-hold-auto]
    lenses: tier A (menuDraftSync.js, menuDraftApprove.js, menuPrint.js are sensitive); money (law 15), access-egress, seams, verify, the externals, the money smoke.
    laws: Money law 15 and CLAUDE.md's legal-hold rule: the held proposal keeps its database state exactly and is never read by the AI; every guard calls server/utils/legalHold.js isLegalHold, which fails closed; a refusal writes nothing and calls no provider.
    seams: assertNotLegalHold's 409 LEGAL_HOLD body is the one the proposal PATCH already answers, so the card shows the server's message like any other refused write; the next lanes that add menu writers (menu-no-menu-mark, menu-proof-page, menu-approve-send, menu-auto-start) already name isLegalHold in their laws.
    acceptance: >
      Suites pass and the money smoke passes; the guard tests fail on main (on main a Generate, an Update
      draft and an Approve for a synthetic held id each succeed or write).
    test plan: >
      With a synthetic held id added through __setLegalHoldIdsForTest: menuDrafts.test.js, Generate, PATCH,
      re-roll and Dismiss answer 409 LEGAL_HOLD, write no row and reserve no ledger spend; Update draft likewise.
      menuDraftApprove.test.js: Approve answers 409 and stores no print key. menuPrint.test.js: POST, PATCH and
      DELETE answer 409 and change no column.
    revert: Revert the squash before menu-bar-chain's; nothing is stored in a new shape.

  - id: menu-no-menu-mark
    scope: >
      Spec section 15. A client submit with Skip the Menu marks the event as needing no printed menu; a later
      Custom or Standard submit clears only a mark the planner set; the admin's own mark is never undone. New
      column proposals.menu_not_required_by ('admin' | 'planner'). A new server/utils/menuAutoStart.js exports
      triggerMenuAutoStart(planId), fire-and-forget in the triggerShoppingListAutoGen shape, called beside
      triggerShoppingListAutoGen at both submit tails; in this lane it applies the mark only (the auto-start
      step joins it in lane menu-auto-start), skipping an archived proposal and the legal-hold proposal,
      treating customMenuDesign false with no menuStyle as none, and writing the menu_not_required activity
      row. The admin PATCH writes the provenance; setMenuPrintKey clears both columns; the designer read model
      selects the new column; the card's No menu needed sub line adds "The client chose Skip the Menu." for a
      planner mark. A one-time script, server/scripts/backfillMenuNotRequired.js, dry run by default, marks
      the set spec 15 names (upcoming, booked, not archived, not the legal-hold proposal, no print file, no
      mark, and the designer's lowest-id plan submitted and saying none), prints counts, ids and the
      legal-hold excluded count, and writes in one transaction with an activity row per mark. Running it on
      production is an owner-approved step after the ship, not part of the lane.
      Also, from menu-legal-hold-guards' review (2026-11-12, deferred there as client-side): the menu designer's
      autosave reads every 409 as a version conflict, so on the legal-hold booking a refused PATCH shows "This
      draft changed elsewhere. It was reloaded."; useMenuDraft.js shows the server's LEGAL_HOLD message instead
      (the other menu actions already do).
    footprint:
      - client/src/pages/admin/menuDesigner/useMenuDraft.js  (the autosave shows a 409 LEGAL_HOLD as its own message)
      - server/db/schema.sql  (menu_not_required_by, idempotent)
      - server/db/schema.menuArt.test.js  (the column and its CHECK)
      - server/utils/menuAutoStart.js  (new, with the header comment)
      - server/utils/menuAutoStart.test.js  (new)
      - server/routes/drinkPlans/submit.js  (the two trigger calls; nothing else)
      - server/routes/proposals/menuPrint.js  (the PATCH writes the provenance; nothing else)
      - server/routes/proposals/menuPrint.test.js
      - server/utils/menuPrintFile.js  (setMenuPrintKey clears both columns)
      - server/utils/menuPrintFile.test.js
      - server/utils/menuDraftRead.js  (selects p.menu_not_required_by)
      - server/utils/menuDraftRead.test.js, server/routes/proposals/menuDraftApprove.test.js  (their pins of the read shape and setMenuPrintKey's SQL; added at the build, 2026-11-12)
      - client/src/pages/admin/menuDesigner/menuCardState.js  (the sub line)
      - client/src/pages/admin/menuDesigner/menuCardState.test.js
      - server/scripts/backfillMenuNotRequired.js  (new, with the header comment)
      - server/scripts/backfillMenuNotRequired.test.js  (new)
      - scripts/sensitive-paths.txt  (menuAutoStart.js)
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: [menu-bar-chain, menu-legal-hold-guards]
    lenses: tier A (submit.js, menuPrint.js, menuPrintFile.js, schema); schema-data, lifecycle, concurrency, seams, money (menu_not_required gates the $5 menu_print duty line), verify, the externals, the money smoke.
    laws: >
      Money law 15: the legal-hold proposal keeps its state exactly; every writer here calls isLegalHold,
      which fails closed. The duty line (dutyLines.js) reads menu_print_key and menu_not_required, so a mark
      is never set while a print key exists (the UPDATE's own WHERE guards it, the menuPrint.js PATCH
      precedent). The trigger runs after the submit's COMMIT and release, on its own pool connection, and
      never fails or delays the submit response. Event dates compare as event_date::text against
      chicagoTodayYmd() (spec 8.2). Parameterized SQL only. The backfill prints ids and counts only.
    seams: >
      Every writer of menu_not_required (the admin PATCH, setMenuPrintKey, the new planner path) keeps
      menu_not_required_by in step; every reader of menu_not_required is unchanged (eventDetailsPayload,
      shifts.queries, dutyLines, menuPrintState); the client's menuOwedFor rule (nextStepsCopy.js) and the
      legacy customMenuDesign rule (PotionPlanningLab.js) are mirrored on the server, not imported.
    acceptance: >
      Suites pass (the drink plan submit suites among them) and the money smoke passes; the trigger test fails
      on main (a Skip the Menu submit leaves menu_not_required false on main); a read of information_schema on
      dev after the boot replay shows the column and its CHECK; the backfill's dry run on dev writes nothing and
      prints only ids and counts.
    test plan: >
      menuAutoStart.test.js: none marks with by planner and writes the activity row; a later custom submit
      clears a planner mark and leaves an admin mark; a proposal with a print key is never marked; archived and
      the legal-hold proposal are skipped; the legacy customMenuDesign false counts as none; the trigger
      swallows and reports its own failure. menuPrint.test.js: the PATCH writes admin when setting and null
      when clearing. menuPrintFile.test.js: setMenuPrintKey clears both columns. backfillMenuNotRequired.test.js:
      the dry run writes nothing; unsubmitted plans, a plan that is not the lowest-id one, non-booked, past,
      archived and legal-hold rows are excluded and the excluded legal-hold count is printed; the write path
      marks in one transaction with an activity row per mark. menuCardState.test.js: the sub line for a
      planner mark. schema.menuArt.test.js: the column and the CHECK values.
    revert: >
      Revert after any merged lane that edits menuAutoStart.js or these files (menu-auto-start,
      menu-approve-send, menu-proof-page, menu-brief-tab); the column stays (idempotent ADD COLUMN); marks the
      planner set remain valid marks.

  - id: menu-error-display
    scope: >
      Spec section 16, showing it. Split from menu-out-of-credit by its review (2026-11-03): the card and
      the editor never show content.words_error, and a piece's own sentence shows only when exactly one
      piece failed, so an out-of-credit run reads as a generic failure. The Words failed state (card and
      editor banner) shows content.words_error in place of its generic sub line when it is one of the fixed
      sentences in menuArtJobErrors.js (the client keeps a mirror of the allowed set, so no other text is
      ever shown); when several pieces failed and every failure but one reads "not attempted", the banner
      and the card show that one piece's sentence. Added by the menu-out-of-credit review (2026-11-03, the
      review cap reached): a spend or usage limit is not an empty balance, so OpenAIOutOfCredit carries a
      kind (balance or limit, from the code: billing_hard_limit_reached and the four spend and usage limit
      codes are limits) and a limit gets its own words, piece and Update draft sentences naming OpenAI's
      limits settings ("OpenAI hit a spend or usage limit. Raise it in OpenAI's limits settings, then ...").
    footprint:
      - client/src/pages/admin/menuDesigner/menuCardState.js
      - client/src/pages/admin/menuDesigner/menuCardState.test.js
      - client/src/pages/admin/menuDesigner/menuArtSentences.js  (new, the client mirror of the fixed sentences, with the header comment naming its server twin)
      - server/utils/menuArtJobErrors.js  (the limit sentences; its header names the client mirror)
      - server/utils/openaiClient.js  (OpenAIOutOfCredit carries the kind)
      - server/utils/openaiClient.test.js
      - server/utils/menuImageProvider.js  (MenuArtOutOfCredit keeps the kind)
      - server/utils/menuArtJob.test.js  (the limit sentences on the words, piece and Update draft paths)
      - server/utils/menuArtSentences.test.js  (new, the parity test that the client mirror equals SENTENCES)
      - server/utils/menuArtJob.js  (its header only: a spend or usage limit ends the run too, not only a spent balance)
      - server/utils/menuArtPrompts.js, server/utils/geminiClient.js, server/utils/menuKeyOut.js  (one export each: the MenuWordsInvalid REASONS, the Gemini refusal reasons, the key-out failure reasons, so the server's one list of every fixed text it can store imports them instead of copying; added by the lane's review, 2026-11-12)
      - client/src/pages/admin/menuDesigner/MenuDesignerCard.test.js, MenuEditor.test.js, MenuCanvas.edit.test.js  (their pins of the Words failed button label and the one-drawing banner text)
      - client/src/pages/admin/menuDesigner/MenuDesignerCard.js, MenuEditor.js  (the Generate again busy label; the card's way to the Brief tab after a words refusal)
      - README.md, ARCHITECTURE.md  (generated sections; README's hand-written menuDesigner folder note names menuArtSentences.js)
    blockedBy: [menu-out-of-credit, menu-bar-chain]
    lenses: the computed tier; client (captures of the Words failed state and the multi-failure banner), seams (the mirrored sentence set), access-egress (no provider text reaches the client).
    laws: only the fixed sentences are shown; a words_error that is not one of them shows the generic sub line, so no provider text can reach the screen.
    seams: the client mirror and SENTENCES stay equal, pinned by the parity test.
    acceptance: Suites pass; the state test fails on main (the Words failed sub line is fixed text on main); the client lens on the two states.
    test plan: >
      menuCardState.test.js: Words failed with words_error set to the out-of-credit sentence shows it; with an
      unknown string shows the generic sub; a run with one out-of-credit piece and two not-attempted pieces
      shows the out-of-credit sentence; two genuine piece failures keep the count banner.
      menuArtSentences.test.js: the mirror equals SENTENCES.
    revert: Revert the squash; the card goes back to its generic text.

  - id: menu-plan-review-state
    scope: >
      Split from menu-bar-fingerprint by its review (2026-11-03): what the admin has reviewed about a plan
      change is kept as state, not as one hash. (1) Mark reviewed and Dismiss record what they cover:
      Dismiss stores the reviewed parts (the brief and planner-image parts, the bar baseline, the drink
      keys the admin chose not to add) so a later Update draft never brings back a notes edit already
      reviewed, and a dismissed drink stays dismissed until the plan moves again. (2) The plan-hash echo:
      the GET returns the current plan hash, and Dismiss and Update draft send back the hash the admin saw,
      answering 409 MENU_PLAN_MOVED when the plan changed since, so a change that lands while the page sits
      open is never dismissed or applied unseen. (3) Generate's two reads: the words step stamps the bar
      baseline into plan_fingerprint from the same plan read it built also_at_bar from, so the stored
      baseline always matches the printed lines. The spec section 17 text is amended with the lane.
    footprint:
      - server/routes/proposals/menuDrafts.js  (Dismiss and Mark reviewed record what they cover; the echo check)
      - server/routes/proposals/menuDraftSync.js  (the echo check; keeps a still-valid review)
      - server/routes/proposals/menuDrafts.test.js
      - server/utils/menuDraftRead.js  (the current plan hash in the GET; the diff against the recorded review)
      - server/utils/menuDraftRead.test.js
      - server/utils/menuDrinkSource.js  (the review-state helpers)
      - server/utils/menuDrinkSource.test.js
      - server/utils/menuArtJobWords.js  (the words step stamps the bar baseline)
      - server/utils/menuArtJob.test.js
      - client/src/pages/admin/menuDesigner/useMenuDraft.js  (Dismiss and Update draft send the hash they saw; a 409 refetches)
      - client/src/pages/admin/menuDesigner/useMenuDraft.test.js
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: [menu-bar-chain, menu-brief-tab]
    lenses: tier A (menuDrafts.js, menuDraftSync.js, menuArtJobWords.js); concurrency (the echo and the two-read stamp), lifecycle (what review state survives which action), seams (every writer and reader of plan_fingerprint and dismissed_plan_hash), client.
    laws: one pooled connection per request; the echo check and the write it guards run in one transaction under the draft row lock; nothing here calls a provider.
    seams: plan_fingerprint and dismissed_plan_hash keep one meaning each across Generate, the words step, Update draft, Dismiss, Mark reviewed and the GET's diff; the client hook is the one place that sends the echoed hash.
    acceptance: Suites pass; the review-state tests fail on main (a reviewed notes edit returns after Update draft on main; a Dismiss sent from a stale page succeeds on main).
    test plan: >
      menuDrafts.test.js: Mark reviewed then a drink added then Update draft leaves the notes flag cleared; a
      dismissed drink stays dismissed through a bar-only Update draft; Dismiss and Update draft with a stale
      hash answer 409 MENU_PLAN_MOVED and write nothing; with the current hash they succeed.
      menuArtJob.test.js: a plan change between Generate's read and the words step leaves the stored bar
      baseline equal to the printed lines. menuDraftRead.test.js: the GET's hash equals the one the routes
      compare. useMenuDraft.test.js: the hook sends the hash it holds and refetches on 409.
    revert: Revert the squash; the review falls back to one dismissed hash, as before.

  - id: menu-mark-placement
    scope: >
      Spec section 5. content.mark_position left | center | right, missing reads as right; the Design tab's
      Placement .seg under the mark switch; the switch's sub line follows the value; MenuCanvas places the mark
      with today's CSS for right, a mirrored rule for left, and an inline left of about 296 canvas px for center
      (never a transform); validation in CONTENT_CHECKS. Benchmark: the v1 artifact
      (docs/design-artifacts/2026-10-01-menu-designer/Menu Designer v2.dc.html), the Placement .seg as the
      Wordmark color row's twin.
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
    lenses: the computed tier; client (with the 320 and 390 captures, against the v1 artifact), seams.
    laws: v1 11.3, export parity, so nothing html2canvas might draw differently from the browser and no transform; the vertical offsets are unchanged so the fit loop needs no new room.
    seams: the export and the proof render the same MenuCanvas, so they inherit the placement; the house card (lane menu-house-card) has no .mc-mark.
    acceptance: Suites pass; the client lens on the Design tab against the v1 artifact; the validation test fails on main (mark_position refused as an unknown content key).
    test plan: >
      MenuCanvas.test.js: the mark's left for each position with and without the Panel, and right when the field
      is missing. DesignTab.test.js: the Placement .seg PATCHes { content: { mark_position } }, is disabled
      before the words land, and the sub line text follows. menuDraftValidation.test.js: the three values pass,
      anything else is a field error.
    revert: Revert after menu-fonts-twelve and menu-house-card if merged (shared files); stored mark_position values are ignored by the old canvas (it draws right).

  - id: menu-fonts-twelve
    scope: >
      Spec section 6, decision 7. Six new pairings (art-deco, botanical, hand-lettered, fiesta, editorial,
      black-tie) with the spec's faces, sizes and colors as starting values; the server id list and the words
      schema enum grow; parseWords stores content.font_pairing_suggested, server-only; the Design tab tags it
      Suggested. Benchmark: the v1 artifact's pairing list, longer.
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
      - server/utils/menuAlsoAtBar.test.js  (its FONT_PAIRING_IDS pin; added 2026-11-04 when the build found it still listed six)
      - client/src/pages/admin/menuDesigner/MenuCanvas.js  (the names face's case, --mc-ht; added 2026-11-04 by the review: Masthead's uppercase names were never drawn)
      - client/src/pages/admin/menuDesigner/MenuCanvas.test.js
      - client/src/index.css  (.mc-name reads --mc-ht; the Suggested tag stacks over the id; added 2026-11-04 by the review)
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: [menu-mark-placement]
    lenses: the computed tier; outcomes-providers (menuArtPrompts.js holds the strict words-schema enum the provider validates against, so a bad enum fails every words call), client (captures against the v1 artifact), seams (two id lists kept in sync).
    laws: every face still loads before Approve (the export waits on the link, each face and document.fonts.ready); the server validates one enum; the words step's prompt line is unchanged.
    seams: FONT_PAIRING_IDS (server) and PAIRING_IDS (client) are identical, pinned by a test that imports both; fontsHref builds one css2 link for every pairing.
    acceptance: Suites pass; the client lens on the twelve-button tab; the schema-enum test fails on main (the words schema offers six ids on main), and a new id passing PATCH validation fails on main.
    test plan: >
      fontPairings.test.js: the ids equal the server's list; fontsHref for all twelve sorts weights and names
      "Baloo 2" and "DM Serif Display" correctly. menuArtPrompts.test.js: the schema enum has twelve ids;
      parseWords stores font_pairing_suggested. menuDraftValidation.test.js: PATCH refuses
      font_pairing_suggested; each new id passes. DesignTab.test.js: the Suggested tag sits on the model's pick
      and is absent on an old draft; choosing a pairing still resets ink and accent.
    revert: Revert after menu-brief-tab and menu-house-card if merged (shared files); a draft that stored a new id reads as the default pairing.

  - id: menu-brief-tab
    scope: >
      Spec section 7 (decisions 2, 3 and 13). The GET's plan block gains side and planner_reference (labelled bar
      strings from LINE_LABELS, the two notes), display only and never sent to a provider; the Brief tab's From
      the planner box. inputs.admin_brief { theme, naming, notes }, PATCH and Generate (admin_brief_theme,
      admin_brief_naming, admin_brief_notes), held in the hook's pre-draft brief; effectiveBrief(clientBrief,
      adminBrief) applied at the four provider seams and nowhere else; the fingerprint keeps hashing the
      client's fields. The Admin brief box with its hint naming email, text and phone. Benchmark: the v1
      artifact (the Admin brief fields as the Art direction .input three times, From the planner as a
      .md-brief-box). The lane report names both fix-list items it closes (planner data, display only; the
      admin brief, which changes what reaches the providers). Added by the menu-bar-fingerprint review
      (2026-11-03): the Brief tab's bar line moves under the From the planner Bar row.
    footprint:
      - server/utils/menuDraftRead.js  (plan.side, plan.planner_reference)
      - server/utils/menuDraftRead.test.js
      - server/utils/menuDrinkSource.js  (effectiveBrief)
      - server/utils/menuDrinkSource.test.js
      - server/utils/menuDraftValidation.js  (INPUT_CHECKS, validateGenerateInputs)
      - server/utils/menuDraftValidation.test.js
      - server/utils/menuArtJob.js  (the words, background and re-roll seams)
      - server/utils/menuArtJob.test.js
      - server/routes/proposals/menuDraftSync.js  (the typed-drinks words call)
      - server/routes/proposals/menuDrafts.test.js  (the sync seam)
      - client/src/pages/admin/menuDesigner/BriefTab.js
      - client/src/pages/admin/menuDesigner/BriefTab.test.js
      - client/src/pages/admin/menuDesigner/useMenuDraft.js
      - client/src/pages/admin/menuDesigner/useMenuDraft.test.js
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: [menu-no-menu-mark, menu-fonts-twelve, menu-out-of-credit]
    lenses: tier A (menuArtJob.js, menuDraftSync.js); access-egress (what leaves the OS for a provider), outcomes-providers, seams, client (captures against the v1 artifact), verify, the externals.
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
      stored. menuArtJob.test.js: the payload rule, and the merged brief at the words, background and re-roll
      seams. menuDrafts.test.js: Update draft's typed-drinks words call carries the merged brief. BriefTab and
      useMenuDraft tests: the fields save through the debounced PATCH, hold before a draft, and are read-only on
      a read-only draft; the consult hint and the no-drinks hint render.
    revert: Revert after menu-house-card if merged (shared files); stored admin_brief values are ignored by the old code.

  - id: menu-house-card
    scope: >
      Spec section 9 (decision 12). inputs.look house | custom, decided at Generate (9.1), switchable on the
      Brief tab's Look .seg; validateGenerateInputs carries look and keeps the stored admin brief and look; the
      upsert seeds content with look, touch_key and house_bottom_corners, which PATCH refuses as job-only keys.
      server/utils/menuEventTouches.js touchSetFor (table T, by id or stored label, December from the event
      date text). A house run makes no words call and reserves no text cap: the job fills the content (title
      The Bar Menu, own names, no descriptions, has_art false, content.house_sections from
      server/utils/menuHouseSections.js, a hand-synced port of client menuSections.js on the planner side and
      the consult bar's labelled lines on the consult side) and stamps content.words_finished_at; it reserves
      only the background, and none for a plain touch set. The house background prompt (zones, muted colors,
      the extended fixed clauses, the event touches; loadDraft adds event_date::text). layoutPieceKeys moves
      to menuDraftShared.js and returns background or nothing for a house draft. The canvas renders the house
      layout through a new HouseCard component (a port of MenuPreview's print variant at 800 x 1000, fit from
      35 to 24 px then Too long, the footer lockup and client logo, centred when house_bottom_corners). The
      house faces load for the preview and the export: fontPairings.js gains a house face set (Pirata One, IM
      Fell English SC, IM Fell English) that fontsHref and the export's font wait use for a house draft,
      without making it a choosable pairing (exportMenu.js today waits on the default pairing when
      font_pairing is null). The Design tab's house-card note. House draft edit rules: Update draft makes no
      words call and no art; PATCH refuses has_art true and description; a per-drink re-roll answers
      MENU_HOUSE_NO_DRINK_ART; the text-only cap does not apply. Benchmarks: MenuPreview's print variant for
      the layout, docs/design-artifacts/2026-11-03-menu-house-touches/menu-accents.html for where the touches
      sit, and the v1 artifact for the Look .seg (the Wordmark color row's twin).
    footprint:
      - server/utils/menuEventTouches.js  (new, with the header comment)
      - server/utils/menuEventTouches.test.js  (new)
      - server/utils/menuHouseSections.js  (new, with the header comment naming its client twin)
      - server/utils/menuHouseSections.test.js  (new; the parity test imports the client file)
      - client/src/pages/plan/data/menuSections.js  (its header names the server twin; nothing else)
      - server/utils/menuDraftValidation.js  (look, the house edit rules, the job-only keys, the text-only cap exemption, validateGenerateInputs)
      - server/utils/menuDraftValidation.test.js
      - server/routes/proposals/menuDrafts.js  (the upsert's content seed and the reservation)
      - server/routes/proposals/menuDrafts.test.js  (Generate, Update draft and the re-roll refusal)
      - server/routes/proposals/menuDraftShared.js  (layoutPieceKeys, moved here)
      - server/routes/proposals/menuDraftApprove.js  (imports layoutPieceKeys from the shared file; nothing else)
      - server/routes/proposals/menuDraftApprove.test.js  (stays green, the no-behavior-change check for the move)
      - server/routes/proposals/menuDraftSync.js  (house Update draft)
      - server/routes/proposals/menuDraftImages.js  (the per-drink re-roll refusal)
      - server/utils/menuArtJob.js  (the house branch)
      - server/utils/menuArtJobSteps.js  (loadDraft's event_date; the house fill)
      - server/utils/menuArtJobWords.js  (words_finished_at)
      - server/utils/menuArtImagePrompts.js  (the house prompt)
      - server/utils/menuArtPrompts.test.js  (where the background prompt is tested)
      - server/utils/menuArtJob.test.js
      - client/src/pages/admin/menuDesigner/MenuCanvas.js  (the look branch only)
      - client/src/pages/admin/menuDesigner/HouseCard.js  (new, the house layout, with the header comment)
      - client/src/pages/admin/menuDesigner/HouseCard.test.js  (new)
      - client/src/pages/admin/menuDesigner/fontPairings.js  (the house face set)
      - client/src/pages/admin/menuDesigner/fontPairings.test.js
      - client/src/pages/admin/menuDesigner/exportMenu.js  (the font wait for a house draft only)
      - client/src/pages/admin/menuDesigner/exportMenu.test.js
      - client/src/pages/admin/menuDesigner/DesignTab.js  (the house-card note)
      - client/src/pages/admin/menuDesigner/DesignTab.test.js
      - client/src/pages/admin/menuDesigner/BriefTab.js  (the Look .seg)
      - client/src/pages/admin/menuDesigner/BriefTab.test.js
      - client/src/pages/admin/menuDesigner/menuCardState.js  (layoutPieceKeys' client rule)
      - client/src/pages/admin/menuDesigner/menuCardState.test.js
      - client/src/pages/admin/menuDesigner/useMenuDraft.js  (look in the pre-draft brief)
      - client/src/pages/admin/menuDesigner/useMenuDraft.test.js
      - client/src/index.css  (mc-house- rules)
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: [menu-brief-tab, menu-error-display]
    lenses: tier A (menuDrafts, menuDraftShared, menuDraftSync, menuDraftImages, menuDraftApprove, the job files); seams (the hand-synced sections pair, layoutPieceKeys on both sides), outcomes-providers (a run with no provider call), access-egress (the house prompt's content), client (captures against MenuPreview, the house-touches sketch and the v1 artifact), business-time (the December rule), verify, the externals.
    laws: >
      v1 11.2 and 11.3: the fit rule's Too long state and export parity hold for the house layout, which means
      the export waits on the house faces; the house prompt sends no client name, contact, venue, address or
      event date (the event date reaches only the December test, never the prompt text); a plain card spends no
      image; Approve requires exactly the pieces layoutPieceKeys names on both sides. Dates as text (spec 8.2).
    seams: >
      menuHouseSections.js and client menuSections.js agree on shared fixtures (the eventTypes.js pair
      precedent); layoutPieceKeys is one rule, server (menuDraftShared.js) and client (menuCardState.js); the
      canvas reads only content (look, touch_key, house_bottom_corners, house_sections); getEventTypeLabel's
      label match is mirrored in touchSetFor; the export's font wait and fontsHref know the house face set.
    acceptance: >
      Suites pass, menuDraftApprove.test.js unchanged and green; the no-words-call test fails on main (a
      Standard Menu Generate on main reserves the background and the drinks and calls the words step); a live
      Generate on dev of a plain-touch house card (a celebration of life on the Standard Menu, which makes no
      provider call) renders, exports at 2400 x 3000 with the IM Fell and Pirata One faces, and is captured; the
      client lens judges the house card against MenuPreview's print variant and the touches against the vendored
      sketch.
    test plan: >
      menuEventTouches.test.js: every event type id in table T, a stored label, a custom type, no type, and a
      holiday party in December and in November (text dates). menuHouseSections.test.js: parity with the client
      on both key families, a Non-Alcoholic pick, Call Drinks, spirits never listed, and the consult side's
      labelled lines. menuDraftValidation.test.js: the look decision for every combination (style, client brief,
      admin brief, art direction, reference, logo-only image); a house PATCH refuses has_art true and description
      and accepts display_name and hidden; PATCH refuses content.look, touch_key, house_bottom_corners and
      house_sections; the text-only cap skipped for house. menuDrafts.test.js: a house Generate reserves
      background only, a plain one reserves nothing, no text call is reserved; a house Update draft makes no
      words call and reserves no art; a per-drink re-roll on a house draft answers MENU_HOUSE_NO_DRINK_ART.
      menuArtJob.test.js: a house run makes no words call, fills content and words_finished_at.
      menuArtPrompts.test.js: the house background prompt names the zones and the touches and holds no client
      field; a custom prompt is unchanged. HouseCard.test.js: sections render in order, the fit steps down to the
      floor then reports Too long on a 20-drink fixture (Review Focus 5), the footer centres on
      house_bottom_corners, the client logo shows only for role logo. fontPairings and exportMenu tests: a house
      draft's link and font wait name the three house faces. BriefTab, DesignTab and useMenuDraft tests: the
      Look .seg PATCHes inputs.look and holds before a draft; the Design tab shows the house-card note in place
      of the pairing and color controls.
    revert: >
      Revert after menu-approve-send and menu-auto-start if merged (they build on the moved layoutPieceKeys and
      exportMenu.js). A house draft made while this lane was live reads as a custom draft with no art and fails
      its own Approve checks until Start over, so revert only with no house drafts in flight (the lane report
      gives the query that counts them).

  - id: menu-proof-page
    scope: >
      Spec sections 10.6, 12 and 18, the public half, landing dark, plus the menu_drafts release columns the
      Inbox reader needs (so menu-inbox-tasks can land before anything holds a file). The menu_proofs table
      (10.6, with pending, suppressed and withdrawn_at) and menu_drafts.released_print_key, released_at,
      released_by (ON DELETE SET NULL) and released_via, all unused until menu-approve-send;
      server/utils/menuProofs.js (the token-life SQL expression until the end of the event day in Chicago, 30
      days with no date; the state derivation open, approved, changes, superseded, expired, withdrawn; the
      latest-proof query); server/routes/menuProof.js with GET, GET image (prefix pinned to the row's own
      proposal, Cache-Control private, no-cache) and POST answer (the conditional one-shot UPDATE, the activity
      row without the note, and no release yet, which menu-approve-send wires in); menuProofReadLimiter and
      menuProofAnswerLimiter; MenuProofPage with every state of section 12 (loading, failed load with Try again,
      sending, withdrawn), on drb-tokens.css per the visual contract's token rule; the route in every site
      context in App.js. Benchmark: docs/design-artifacts/2026-11-03-menu-proof/menu-proof-page.html, the page
      screens. Nothing creates a proof yet, so every link 404s until menu-approve-send.
    footprint:
      - server/db/schema.sql  (menu_proofs and the four menu_drafts release columns, idempotent)
      - server/db/schema.menuArt.test.js  (the new table, columns, CHECKs and keys)
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
    blockedBy: [menu-no-menu-mark]
    lenses: tier A (rateLimiters.js, a public token route taking a client write); access-egress, concurrency (the one-shot UPDATE), business-time (the token life), schema-data, client (captures of every page state at 320 and 390 against the vendored proof-page sketch), seams, verify, the externals.
    laws: >
      Public routes are token-gated by a UUID (requireUuidToken before any query); the public GET returns no
      admin data; the proof bytes stream only under menu-proof/<the row's proposal_id>/; the note is plain text,
      1 to 1,000 characters, never HTML, never in an activity row; one answer per proof in SQL; an archived
      proposal 404s; the token life is computed live from event_date in America/Chicago. Error bodies leak no
      internals. The page shows no client name, email, event date, venue or amounts.
    seams: >
      The menu_proofs columns, the release columns and the state names are what menu-inbox-tasks and
      menu-approve-send read; the token-life expression is one function in menuProofs.js, used by the GET, the
      image route, the answer route and (later) the admin read model; App.js carries the route in all four site
      contexts.
    acceptance: >
      Suites pass; a read of information_schema and pg_constraint on dev after the boot replay shows the table,
      the columns, the CHECKs and the released_by rule; a grep of MenuProofPage.css finds no literal color (the
      token rule); the client lens judges every page state against the sketch; with a proof row inserted by a
      test fixture on dev, the page shows open, answers once, then approved; an unknown token, a bad UUID and
      an archived proposal 404.
    test plan: >
      menuProofs.test.js: the token life at the end of the event day in Chicago (an evening NOW() whose GMT day
      is the next day, a DST change, 11:30 p.m. on the event day still open, Review Focus 2), 30 days with no
      date, a moved event date moving the end; each state. menuProof.test.js: GET per state; the image route
      streams only under the row's prefix, sets Cache-Control private, no-cache, and 404s outside open, approved
      and changes; the answer writes once and refuses a second answer, an older link, a withdrawn proof and an
      expired one with their codes and states, requires a note for changes and caps it at 1,000, writes the
      activity row with no note; the limiter chain is present on each route (the publicFeedback precedent).
      MenuProofPage.test.jsx with a mocked api: open, approved, changes, superseded, expired, withdrawn, the 404
      shell, loading, a 429 failed load with Try again, sending (buttons disabled), Send changes disabled on an
      empty note, the image-missing line. schema.menuArt.test.js: the table and columns.
    revert: >
      Revert only after menu-inbox-tasks and menu-approve-send if they have merged (both read its table and edit
      menuProof.js); with neither merged, no proof rows exist; the table and columns stay (idempotent).

  - id: menu-inbox-tasks
    scope: >
      Spec section 13 (decisions 5 and 11), landing before anything can hold a file or raise a task.
      server/utils/inbox/readMenuTasks.js emits the two proof tasks, menu_changes and menu_no_answer, open only
      while the latest proof's own state holds (13.1), never for a past or archived event or any person the
      legal hold covers; with no proofs yet it emits nothing. server/utils/menuReminder.js menuReminderDueAt
      (13.3). The engine registers the reader in pass 1 with the fixed texts in the header and the change note
      in pass 2 through details.js. rules.js keeps menu_task events out of U and the anchor, makes a person wait
      while a task is open, adds the snooze clause, and hides Done on a row held only by tasks; classify.js
      registers all four task kinds up front (menu_ready, menu_failed, menu_changes, menu_no_answer, each never
      counted, never a reply, and in aiCannotClose), so menu-auto-start only adds its two kinds to the reader;
      thread.js keeps open tasks in the open set and carries the new link; the client renders the task line and
      link. The answer route calls inboxCache.invalidate().
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
      - server/utils/inbox/thread.test.js
      - server/utils/inbox/details.js  (the change note in pass 2)
      - server/utils/inbox/payload.js  (the link on the list row)
      - server/utils/inbox/payload.test.js
      - server/routes/admin/inbox.test.js
      - client/src/components/inbox/Thread.js
      - client/src/components/inbox/inboxThread.js
      - client/src/components/inbox/inboxThread.test.js
      - client/src/components/inbox/WaitingRows.js
      - client/src/components/inbox/inboxListViews.test.js  (the row's need line, link and hidden Done)
      - server/routes/menuProof.js  (inboxCache.invalidate only)
      - README.md, ARCHITECTURE.md  (generated sections, and the menu tasks in ARCHITECTURE's Inbox concept)
    blockedBy: [menu-proof-page]
    lenses: tier A (server/utils/inbox/** is sensitive); lifecycle, business-time (the due time), concurrency, seams, access-egress (nothing new reaches the AI), client (captures of a row and a thread with a task), verify, the externals.
    laws: >
      Money law 15 at the client level: no task for any person the legal hold covers (engine.legalHoldPersonKeys,
      as readJob.js excludes them). The AI never reads or closes a menu task, and the client's note never
      reaches aiRedact or a provider. A reply never closes a task and a task never closes a conversation. Due
      times in America/Chicago through businessTime.js; event dates as text.
    seams: >
      The Inbox spec's amended decision 2 (written on main 2026-11-03) is the contract; every file that
      enumerates kinds or sources gets the new source (engine, classify, thread, payload, details, the client row
      and thread); the existing Inbox suites stay green; menu-approve-send adds inboxCache.invalidate() to the
      admin writers when it creates them.
    acceptance: >
      Suites pass (rules.*.test.js, engine.test.js, readers.test.js, subjects.test.js, inbox.test.js among
      them); the new rules test fails on main (no task kinds exist); with fixture proofs on dev, a change request
      shows under the client within the cache window and the row keeps the client's unanswered text separate.
    test plan: >
      menuReminder.test.js: 30, 8, 7, 3, 2 and 0 days out, no date, a sent_at late on a Chicago evening (the
      reminder falls at 9:00 a.m. Chicago on the day a week out, Review Focus 2), a DST change. readers.test.js:
      each proof kind exactly while its state holds; none after the event day, for an archived proposal or the
      legal-hold client; changes and no_answer close on supersede, withdraw and release but not on an older live
      file, so a second proof's change request shows. rules.menuTasks.test.js (Review Focus 3): a reply to the
      client leaves the task open and a task leaves an unanswered text open; Done does not clear a task; a row
      held only by tasks hides Done; a task opened during a snooze ends it; the AI cover never closes a task;
      all four kinds are classified as never counted and never a reply. engine.test.js: the note loads in pass
      2. thread.test.js: a task older than 30 days keeps its line and link. payload.test.js and
      inboxListViews.test.js: the task's need line and link on the row. inboxThread.test.js: the system line and
      its link.
    revert: Revert after menu-approve-send and menu-auto-start if merged (they rely on its reader and kinds); tasks vanish (derived), nothing is stored.

  - id: menu-approve-send
    scope: >
      Spec sections 10, 11 and 14 (decisions 4, 6, 10 and 15), less the events dashboard (its own lane). Approve
      and send: one render, two files (the print file byte for byte as today, and the 1200 x 1556 proof); the
      route validates both, refuses legal hold, a past event and archived, stamps a v1 approval as released
      first, applies the 10-minute double-submit guard and the send cap, holds the print file (no
      setMenuPrintKey, no reaccrueDuty), supersedes the old proof, inserts the new one as pending (no_address
      for no email or an .invalid placeholder), writes the two activity rows, and after release runs the
      immediate-send gate and the email (menuProofReady, messageType menu_proof, no sentBy).
      server/utils/menuRelease.js releaseHeldPrint with the five guards and its reasons; the admin release route
      (release and put back, after_event); the answer route calls releaseHeldPrint and fires reaccrueDuty after
      commit; the no-menu PATCH and the admin upload withdraw the open proof; approve, release and the withdraw
      call inboxCache.invalidate(). menu_drafts.approved_by becomes ON DELETE SET NULL. menuPrintState gains held
      and the released branches (10.3's list). The GET's proof and print blocks; the editor's Approve and send,
      its confirm and codes, Release for printing and Put it back for staff; the card's Client review fold row,
      table C and table B; the Brief tab's Client review history. Benchmarks: the v1 artifact (the Client review
      fold row as a third Print file row, Client review as a .md-brief-box, Release as btn btn-secondary, table B
      tones) and the proof sketch's email screen (docs/design-artifacts/2026-11-03-menu-proof/menu-proof-page.html,
      screen 1), with decision 15's "until your event" line over the sketch's 30 days.
    footprint:
      - server/db/schema.sql  (approved_by ON DELETE SET NULL, an idempotent DO block)
      - server/db/schema.menuArt.test.js  (the approved_by rule)
      - server/routes/proposals/menuDraftApprove.js
      - server/routes/proposals/menuDraftApprove.test.js
      - server/routes/proposals/menuDraftRelease.js  (new, with the header comment)
      - server/routes/proposals/menuDraftRelease.test.js  (new)
      - server/routes/proposals/index.js  (the release mount)
      - server/utils/menuRelease.js  (new, with the header comment)
      - server/utils/menuRelease.test.js  (new)
      - server/utils/menuPrintState.js
      - server/utils/menuPrintState.test.js  (new)
      - server/utils/menuDraftRead.js  (the proof and print blocks)
      - server/utils/menuDraftRead.test.js
      - server/routes/menuProof.js  (the answer route's release call)
      - server/routes/menuProof.test.js
      - server/routes/proposals/menuPrint.js  (the withdraw on the mark and on upload; the invalidate)
      - server/routes/proposals/menuPrint.test.js
      - server/utils/lifecycleEmailTemplates.js  (menuProofReady)
      - server/utils/lifecycleEmailTemplates.test.js
      - server/utils/urls.js  (menuProofUrl)
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
    blockedBy: [menu-inbox-tasks, menu-house-card]
    lenses: tier A, the full floor (money, lifecycle, concurrency, outcomes-providers, access-egress, seams) plus schema-data, business-time and client (captures against the v1 artifact and the proof sketch's email screen); verify; the externals; the money smoke.
    laws: >
      menu_print_key drives the $5 menu_print duty line (dutyLines.js); it moves only through setMenuPrintKey
      inside releaseHeldPrint or the admin upload, and reaccrueDuty fires only after the release commits
      (menuPrintFile.js). The no-menu mark always wins over a client release and is never cleared by one. Money
      law 15: the legal-hold proposal is refused at Approve and Release and never released by a client. A public
      route can release only through the helper's guards. One pooled connection per request: the email runs
      after the transaction's client is released. Resend errors throw and are caught to failed; the
      immediate-send gate runs first; the send carries no sentBy, so the Inbox never reads it as a reply. The
      note never enters an activity row. No client name beyond the first name, no event date, venue or amounts
      in the email.
    seams: >
      Every reader of menu_print_key (the staff download, eventDetailsPayload's status, shifts.queries menu_done,
      dutyLines, the admin reads) sees a held file as no file, and the Inbox's no-answer reminder is already live
      when the first file is held (menu-inbox-tasks merged first); menuPrintState is one function used by the
      read model and the Approve and release responses; the proof block's states match menuProofs.js;
      exportMenu's print file is byte for byte today's; the activity actions menu_approved, menu_proof_sent,
      menu_proof_approved, menu_proof_changes and menu_released are added together.
    acceptance: >
      Suites pass and the money smoke passes; the hold test fails on main (on main Approve sets menu_print_key);
      a read of pg_constraint on dev shows approved_by ON DELETE SET NULL; the walk on dev, with the finished
      draft a plain-touch house card (no provider call, so it works with no OpenAI credit) or an existing dev
      draft with every piece done, SEND_NOTIFICATIONS on for that server only and a client email the owner owns:
      approve and send, open the email on a phone, Request changes and see the Inbox task, approve again (the old
      link reads superseded and the task closes), Looks great (the staff download appears), and on a second event
      Release for printing with no answer; a no-menu mark during an open proof shows the page as withdrawn.
    test plan: >
      menuDraftApprove.test.js: both files validated and nothing written on a bad proof; menu_print_key
      untouched and no duty re-accrual; the proof inserted pending, or no_address for no email and for an
      .invalid placeholder, with its activity rows in one transaction; the previous proof superseded; the same
      pair within 10 minutes answers MENU_PROOF_ALREADY_SENT and sends nothing; after 10 minutes it sends; a past
      event answers MENU_EVENT_PASSED; legal hold and archived refused; the send cap; the gate refusal writes
      suppressed; the email stub's outcomes write sent, skipped and failed; the send's meta carries messageType
      menu_proof and no sentBy (Review Focus 3); a pending proof older than 10 minutes reads as failed in the GET;
      the v1 stamp runs before the new approval. menuRelease.test.js: each guard and reason (legal hold, marked,
      not held including already released, file changed, event passed for the client, the admin after_event
      flag), setMenuPrintKey and the stamp on success. menuDraftRelease.test.js: the 409 codes, put back only for
      the menu's own removed file, reaccrueDuty after commit. menuProof.test.js: Looks great releases only the
      matching held file, never overwrites an upload, records the answer when the release is refused; a race
      test (Review Focus 1): the answer and the no-menu PATCH run concurrently on one proposal, whichever commits
      first wins, the mark is never cleared, and the duty line's inputs match the final key. menuPrint.test.js:
      the mark and the upload withdraw the open proof, DELETE does not. menuPrintState.test.js: every branch in
      10.3's list including live previous, a v1 approval, a v1 approval later removed, and an upload beside a
      held file. schema.menuArt.test.js: a deleted user leaves the draft with approved_by null. Client tests:
      Approve and send's confirm and no-email variant, the codes, Release and Put it back with their errors, the
      fold row and kebab, table C and B rows, the Brief tab history, exportMenu's 2400 x 3000 at 0.92 unchanged
      and the proof at 1200 x 1556 with html2canvas mocked.
    revert: >
      Revert after menu-events-dashboard and menu-auto-start if merged. Held files written while it was live
      stay in R2 and on menu_drafts.approved_print_key; the old Approve reads them as approved but unposted
      ("removed"), so before reverting, release or re-approve every held menu (the lane report gives the query
      that counts them). The schema rule stays.

  - id: menu-events-dashboard
    scope: >
      Spec section 14, the events dashboard. While the print state is held and the latest proof has no answer,
      the event is the client's move. shifts.queries.js adds menu_with_client (held per 10.3, the latest proof
      unanswered), whether or not an older released file keeps menu_done true; eventPlan.js shows the tag "Menu
      with client" instead of "Menu Design" for it, and when it is the only thing owed the row's owner is client,
      not you; a change request is the owner's move again. menu_done itself is unchanged. Split from
      menu-approve-send to keep that lane's diff smaller; it lands after the reminders exist, so a held menu
      never leaves the owner's view unwatched.
    footprint:
      - server/routes/shifts.queries.js  (menu_with_client)
      - server/routes/shifts.planQueue.test.js  (where menu_done is tested)
      - client/src/components/adminos/eventPlan.js  (the tag and owner)
      - client/src/components/adminos/eventPlan.test.js
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: [menu-approve-send]
    lenses: the computed tier; lifecycle (who owns the next move), seams (menu_done readers unchanged), client (a capture of the events list).
    laws: menu_done keeps its meaning for every staff-side reader; the new flag reads the print state's held rule, not a copy of it.
    seams: menu_with_client derives from the same held rule as menuPrintState (10.3); eventPlan.js and shifts.queries.js change together.
    acceptance: Suites pass; the flag test fails on main (no menu_with_client on main); the events list shows Menu with client for a held, unanswered proof on dev.
    test plan: >
      shifts.planQueue.test.js: menu_with_client true for a held, unanswered proof, false after an answer or a
      release, true beside an older released file (menu_done also true). eventPlan.test.js: the tag and owner
      client when it is the only thing owed; Menu Design and owner you for a change request; the Shopping List
      tag still makes the owner you.
    revert: Revert the squash; the dashboard falls back to Menu Design, which is still the owner's move.

  - id: menu-words-claude
    scope: >
      The owner's call (2026-11-11, "we are using gemini antigrav instead of open ai for now"; 2026-11-12,
      a blind side-by-side): OpenAI gets no more credit, so the menu words step moves to Anthropic's Claude
      Haiku 5.5 behind a setting, and the drawings stay on Gemini. In the blind test (four fixture events,
      the OS's exact words prompt and schema, through anthropicClient.js) the owner picked Haiku's menu for
      three events and Opus 5.5's for one, Sonnet 5.5's for none; measured cost per menu: Haiku about
      $0.001, Sonnet $0.01, Opus $0.03. The owner found every model's descriptions overly dramatic, which
      the prompt invites ("one appealing line"), so the description instruction becomes a plain line: the
      main ingredients and one honest taste word, no hype words. The words call goes through
      anthropicClient.js (one new draftMenuCopy-shaped helper with structured output), the model is a
      setting (MENU_WORDS_MODEL, default claude-haiku-5-5; OpenAI stays selectable by the same setting),
      the text cap and the ledger record the provider, and Anthropic's errors map to the fixed sentences
      (an out-of-credit or spend-limit answer gets its own, naming Anthropic's billing). Before building,
      check Gemini's current image pricing and free tier against Google's page and record the default
      image model here.
    footprint:
      - server/utils/anthropicClient.js  (the menu words helper; its header names the rule)
      - server/utils/menuArtJobWords.js  (the provider by setting)
      - server/utils/menuArtPrompts.js  (the plain description instruction; the descriptor's provider)
      - server/utils/menuArtJobErrors.js  (Anthropic's sentences)
      - server/utils/menuArtCap.js  (the provider on the text row, if it is recorded there)
      - .env.example  (MENU_WORDS_MODEL)
      - their tests: anthropicClient.test.js, menuArtJobWords or menuArtJob.test.js, menuArtPrompts.test.js
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: [menu-error-display]
    lenses: the computed tier; money (AI spend and the text cap), outcomes-providers, access-egress (what leaves for Anthropic: the payload rule of menuArtPrompts.js, no client name, contact, venue or date), seams.
    laws: the AI providers only through their wrappers, each refusing a real call under NODE_ENV=test; menu art sends no client name, contact, venue, address or event date; the legal-hold proposal is never read by the AI.
    seams: the words step's output shape and parseWords are unchanged, so the card, the editor and Update draft read the same content.
    acceptance: Suites pass; the words suite fails on main (on main the words call goes to OpenAI and the description instruction asks for an appealing line).
    test plan: anthropicClient.test.js, the helper refuses under NODE_ENV=test without a stub and passes the schema; the words job with a stubbed Anthropic client writes the content and records the provider; an Anthropic 402 or credit error stores the out-of-credit sentence; menuArtPrompts.test.js pins the plain description instruction.
    revert: revert the squash; MENU_WORDS_MODEL unset falls back to the shipped OpenAI path.

  - id: menu-auto-start
    scope: >
      Spec section 8 (decisions 8 and 9). The Generate route's body is extracted to startGeneration({ proposalId,
      inputs, file }) in server/routes/proposals/menuDraftGenerate.js and the route calls it. The
      menu_auto_starts table (8.4, the run-once guard). triggerMenuAutoStart gains the auto-start step after the
      mark: the 8.2 conditions (a proposal, menu owed, booked, not legal hold, not past, no draft, no print file,
      no mark, the guard insert), then startGeneration with OpenAI as the image model and the decided look,
      storing draft_id and run_id, or the error code and sentence, on the guard row, and calling
      inboxCache.invalidate() either way. readMenuTasks adds menu_ready and menu_failed (13.1, including the
      10-minute dead start for a row with no run_id; the kinds are already classified by menu-inbox-tasks). The
      card's "Drafted automatically when the client submitted their plan." sub line and the read model's
      auto_started.
    footprint:
      - server/db/schema.sql  (menu_auto_starts, idempotent)
      - server/db/schema.menuArt.test.js  (the table and its keys)
      - server/routes/proposals/menuDraftGenerate.js  (new, with the header comment)
      - server/routes/proposals/menuDrafts.js  (the route calls startGeneration)
      - server/routes/proposals/menuDrafts.test.js
      - server/utils/menuAutoStart.js  (the auto-start step)
      - server/utils/menuAutoStart.test.js
      - server/utils/inbox/readMenuTasks.js  (the two run tasks)
      - server/utils/inbox/readers.test.js
      - server/utils/inbox/rules.menuTasks.test.js  (the two run kinds under the task rules)
      - server/utils/menuDraftRead.js  (auto_started)
      - client/src/pages/admin/menuDesigner/menuCardState.js  (the sub line)
      - client/src/pages/admin/menuDesigner/menuCardState.test.js
      - scripts/sensitive-paths.txt  (menuDraftGenerate.js)
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: [menu-approve-send, menu-house-card, menu-out-of-credit, menu-no-menu-mark, menu-words-claude]
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
      are menuArtJobErrors' and section 8.3's; readMenuTasks' two new kinds follow 13.1's closing rules (any print
      file or the mark closes them); the submit tails are the same two call sites menu-no-menu-mark added.
    acceptance: >
      Suites pass and the money smoke passes; the auto-start test fails on main (no draft starts on submit); a
      read of information_schema on dev shows menu_auto_starts and its primary key; the owner has added OpenAI
      credit; the live walk on dev (spec 25): submit a test plan for a dev birthday event and see "Menu ready to
      review" in the Inbox, open it, approve and send, and follow the rest of the walk; a Skip the Menu submit
      marks the event; a December holiday party draws the gifts low and centres the footer.
    test plan: >
      menuAutoStart.test.js: each 8.2 skip starts nothing (including a non-booked status and a text-compared past
      date); two concurrent calls start one run (Review Focus 4); a resubmit after a reopen starts none; a
      proposal with two plans reads the lowest-id plan; each thrown error (not configured, Gemini not configured,
      no drinks, each cap, anything else) lands on the guard row with its sentence; success stores draft_id and
      run_id; inboxCache.invalidate is called on success and on failure; the trigger holds no submit client.
      menuDrafts.test.js: the route through startGeneration behaves exactly as before (the existing Generate
      suite green). readers.test.js: menu_ready while the auto run is current, finished and unapproved;
      menu_failed for an error row, a failed words step, a stale run and a dead start older than 10 minutes;
      both closed by a print file, the mark, a manual Generate, or an approval; a deleted draft raises nothing.
      rules.menuTasks.test.js: the two run kinds wait and close like the proof kinds. menuCardState.test.js: the
      sub line while menu_ready is open. schema.menuArt.test.js: the table and its primary key.
    revert: Revert first of all the menu lanes; the guard table stays and keeps any proposal it names from auto-starting again, which is the intended once-only rule.
---

# Menu designer v2: the lane map

The spec, `docs/superpowers/specs/2026-10-19-menu-designer-v2-design.md` rev 2, is the design; this plan cuts it into twelve lanes that each build, review and revert on their own. The spec's sections are the requirements; the front matter is what each lane builds, which files it may touch, and how it is accepted. Revision 2 folds in the design-stage plan review (1 blocker, 12 warnings, 10 suggestions): the Inbox lane now lands before approve and send, the events dashboard is its own lane after it, and every lane names its benchmarks, its test files and its revert order.

## Order

```
menu-out-of-credit ─────────────────────────────┐
menu-bar-chain ── menu-bar-rebuild-only ── menu-legal-hold-guards ── menu-no-menu-mark ──┤
menu-mark-placement ── menu-fonts-twelve ───────┴── menu-brief-tab ── menu-house-card ──┐
            menu-no-menu-mark ── menu-proof-page ── menu-inbox-tasks ───────────────────┴── menu-approve-send ──┬── menu-events-dashboard
                                                                                                             └── menu-auto-start
```

(menu-auto-start also waits on menu-house-card, menu-out-of-credit and menu-no-menu-mark, all merged by then.)

- **Can start at once, in parallel:** menu-out-of-credit, menu-bar-fingerprint, menu-mark-placement. They share no file.
- **Serialized only to keep footprints apart:** the legal-hold guards follow the bar chain (`menuDraftRead.js`, `menuDraftSync.js`), which is one lane (status); the no-menu mark follows the guards (`menuDraftRead.js`, `menuCardState.js`); fonts follow placement (`DesignTab.js`, `menuDraftValidation.js`); the Brief tab follows those and the out-of-credit lane (`menuArtJob.test.js`); the proof page follows the no-menu mark, because both edit `schema.sql` and `scripts/sensitive-paths.txt`, which are sensitive, and a conflict on a sensitive file stops a merge (CLAUDE.md). README and ARCHITECTURE never conflict: the merge regenerates them.
- **Serialized by dependency:** the house card needs the Brief tab's stored-inputs rule; the Inbox tasks need the proof table and the release columns; approve and send needs the Inbox reminder live before it holds any file, and the house card's moved `layoutPieceKeys` and export; the dashboard needs the held state; auto-start needs everything it hands a draft to.
- **Every merged lane is safe to ship alone.** The proof routes land with no proof to show; the Inbox reader and all four task kinds land while no proof exists; holding print files starts only when the reminder that catches an unanswered proof is already live; the dashboard's "Menu with client" lands after that; auto-start lands last.

## Revert order

Revert in reverse merge order; each lane's `revert` names the later lanes that must go first. In short: menu-auto-start first, then menu-events-dashboard, menu-approve-send, menu-inbox-tasks, menu-proof-page, menu-house-card, menu-brief-tab, menu-fonts-twelve, menu-mark-placement, menu-no-menu-mark, menu-legal-hold-guards, menu-bar-rebuild-only, menu-bar-chain and menu-out-of-credit. After a bad ship the fastest lever is still `git revert` of the one squash that caused it, when no later lane builds on it (CLAUDE.md).

## Owner steps (not lanes)

1. **Add OpenAI credit** in OpenAI's billing settings before menu-auto-start ships (spec 24), and before any live walk that generates a custom menu. The plain-touch house card walks need none.
2. **Say yes to the no-menu backfill's production run** after menu-no-menu-mark ships: Claude runs the dry run first and shows the counts and the excluded legal-hold count.
3. **The fix list** (`docs/fix-list-remaining-2026-07-02.md`) is the owner's: each lane report names the lines it closes with its sha and the test that failed on main (bar picks and the one-client `Promise.all` by menu-bar-fingerprint; `approved_by` ON DELETE by menu-approve-send; the Potions notes items 1 to 5 and 7 by their lanes).

## Global constraints

- No em dashes in any client, staff or admin copy, or in comments that become README lines.
- Copy exactly as the spec's section 28 fixes it; the email's link line is "The link works until your event." (30 days with no event date).
- Event dates compare as `event_date::text` (YYYY-MM-DD) against `chicagoTodayYmd()`; instants convert through `server/utils/businessTime.js`; the business zone is America/Chicago.
- One pooled connection per request; email and other post-commit tails run after `client.release()`.
- Parameterized SQL only; `asyncHandler` and `AppError` subclasses; error bodies `{ error, code, fieldErrors? }`, keyed on codes.
- Schema changes are idempotent statements in `server/db/schema.sql`; no data backfill runs from it. Each schema lane confirms its columns, CHECKs and keys on dev with a read of `information_schema` or `pg_constraint` after the boot replay, and pins them in `server/db/schema.menuArt.test.js`.
- Every new source file starts with the header comment whose first paragraph is its README line; `npm run docs` after each lane; no file grows past 1000 lines (aim under 300: `HouseCard.js` exists so `MenuCanvas.js`, at 282 lines, does not grow).
- Providers only through their wrappers; menu art sends no client name, contact, venue, address or event date; every menu art suite sets `process.env.NODE_ENV = 'test'` on its first line.
- No real client or staff name, phone or email in any fixture, commit or diff; fixtures use the PII scanner's allowed shapes.
- The legal-hold proposal is never written by any path here; every writer calls `isLegalHold`, which fails closed; the Inbox skips the legal-hold client.
- No new environment variables.
- Review runs at the tier the review skill computes (CLAUDE.md); the spec's section 26 levels are the floor the plan expects, not a ceiling.

## Review Focus

The inputs most likely to bite, each pinned to the lane that owns the code and named in its test plan:
1. **A client's Looks great racing Dallas's mark, upload or release** on the same proposal. Expected: whichever commits first wins, the other is refused or skipped cleanly, the mark is never cleared, and the duty line matches the final key. Owner: menu-approve-send (the race test in menuProof.test.js).
2. **A proof sent on a Chicago evening** (the GMT date is already tomorrow) for an event eight days out, and a link opened at 11:30 p.m. on the event day. Expected: the reminder falls at 9:00 a.m. Chicago on the day a week out, and the link is still open. Owners: menu-inbox-tasks (`menuReminderDueAt`) and menu-proof-page (the token life).
3. **A client with an unanswered text and an open menu task.** Expected: Dallas's text reply clears the text but not the task; Done hides nothing the task needs; approving the menu never marks the text answered. Owners: menu-inbox-tasks (`rules.menuTasks.test.js`) and menu-approve-send (the send carries no `sentBy`).
4. **A plan submitted twice in the same second, reopened and resubmitted, or one of two plans on a proposal.** Expected: one run at most, from the designer's lowest-id plan. Owner: menu-auto-start.
5. **A Standard Menu event with many drinks.** Expected: the house card steps names down to 24 px and then shows Too long with Approve disabled, never a clipped print file. Owner: menu-house-card (`HouseCard.test.js`, a 20-drink fixture).

## Build method

Each lane is small and coherent enough for one pass by Claude in its own worktree, test first, with the review skill run at the end. menu-house-card and menu-approve-send are the two large lanes; each may use parallel subagents for its client and server halves, since the spec fixes their interfaces (the content keys of 9.1 to 9.3; the `releaseHeldPrint` reasons and the print states of 10.3). The lane report says which method it used.

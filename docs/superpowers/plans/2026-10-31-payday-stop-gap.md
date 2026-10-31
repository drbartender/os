---
spec: none. The design was settled in conversation on 2026-10-31 and this plan body records it; the full mobile rework of onboarding is later work and out of scope here.
format: lane map without code (spec 2026-10-19 D12)
revision: 1 (2026-10-31)
status: one lane, built in one pass by Claude in its own worktree, reviewed at the tier it computes, merged through scripts/merge-lane.sh from os. The ship waits for the owner's word.
lanes:
  - id: payday-stop-gap
    scope: >
      Recruits stall on the last onboarding step, Payday Protocols. Five changes.
      (1) One button: the online W-9 loses its own "Generate & Sign W-9" button; Submit Onboarding
      checks the payout method and the W-9 together, builds the signed PDF and posts once. Every
      W-9 error shows under its own field and the page scrolls to the first one.
      (2) The page holds only what is required: the payout method with its handle or bank fields,
      the W-9 (fill online or upload), and Submit. The pay-rate card moves into the Field Guide's
      Paperwork & Payments section; the punctuality card is already in the Field Guide's Timing &
      Punctuality section, which takes the two lines Payday had that it lacks (the company line to
      call when running late, and removal for excessive tardiness). The optional tip-handle card
      leaves onboarding; the completion page says where to add them later (the portal's Tip Card).
      (3) One step count: the page headers say Step n of 6 (Welcome 1 to Complete 6); the phone
      counter and the desktop dots use the same numbers.
      (4) The next unfinished step: finishing the Contractor Profile or the Agreement goes to the
      first step not yet done, in order, instead of always to the next page. The outstanding
      documents banner links to the Profile from every page, which let a recruit reach Payday
      without signing the agreement (user 264 went active about 70 minutes before signing).
      (5) The step list lives in one module that the progress bar and the routing both read.
    footprint:
      - client/src/utils/onboardingSteps.js  (new: the ordered step list and nextOnboardingPath, pure, with the header comment)
      - client/src/utils/onboardingSteps.test.js  (new)
      - client/src/utils/w9Pdf.js  (new: validateW9 and buildW9File, moved out of W9Form.js, with the header comment)
      - client/src/utils/w9Pdf.test.js  (new)
      - client/src/components/W9Form.js  (controlled fields, a FieldError under each, no button of its own)
      - client/src/pages/PaydayProtocols.js
      - client/src/pages/PaydayProtocols.test.js  (new)
      - client/src/pages/FieldGuide.js  (sections 04 and 10 only)
      - client/src/components/Layout.js  (the step list import and the numbering)
      - client/src/pages/ContractorProfile.js  (the navigate after save only)
      - client/src/pages/Agreement.js  (the navigate after signing only)
      - client/src/pages/Completion.js  (one What Happens Next line)
      - README.md  (generated sections, npm run docs)
      - ARCHITECTURE.md  (generated sections, npm run docs)
    blockedBy: []
    lenses: client and seams, as the review skill computes them. No server file, no sensitive path.
    laws: POST /api/payment is untouched and gets the same multipart body it gets today (the payout method, the four handle fields, payment_username, the bank fields for direct deposit, and the w9 file); the generated W-9 PDF's content and layout are unchanged, only where its code lives; the SSN and bank numbers are never written to a draft or to storage on the client; the upload path and the reuse of a W-9 already on file are unchanged; every pay figure and policy line moved into the Field Guide is moved as written, never reworded into a new policy; no em dash in any new recruit-facing copy.
    seams: nextOnboardingPath reads the onboarding_progress row as GET /progress and PUT /progress/step return it; a progress object that has not loaded (Layout starts with an empty object) returns the caller's fallback, never /welcome; the tip handles a returning recruit already saved are still sent back unchanged, and the server's COALESCE keeps them either way.
    acceptance: >
      the client build passes (cd client && CI=true npx react-scripts build); the new and
      touched client suites pass (react-scripts test --watchAll=false onboardingSteps w9Pdf
      PaydayProtocols FieldGuide); on the dev app at 390 wide, a hired test recruit fills the payout
      method and the online W-9 and presses Submit Onboarding once, lands on the completion page, and
      the dev database shows a payment_profiles row with a W-9 file and onboarding_status approved; a
      missing W-9 field leaves the recruit on the page with the error under that field in view.
    test plan: >
      onboardingSteps.test.js: each step's path returned in order when it is the first one not done;
      /complete when all five are done; a profile done with the agreement not done returns /agreement;
      the fallback for an empty or unloaded progress object. w9Pdf.test.js: validateW9 returns an
      error keyed to each missing field (name, address, city, state, zip, the SSN parts or the EIN,
      the signature), the SSN format check, and no errors for a complete form. PaydayProtocols.test.js
      (api and the PDF builder mocked): no Generate & Sign button exists; one Submit with a complete
      payout method and W-9 posts once with a w9 file and the method; a missing W-9 field posts nothing
      and shows that field's error; the pay-rate and tip-handle cards are gone. FieldGuide.test.js
      keeps passing.
    revert: revert the one squash commit. Nothing is stored differently, so no data needs repair.
---

# Payday Protocols stop gap: the lane map

One lane, client only. The recruit's last onboarding page asks for a payout method and a W-9. Two recruits are sitting on it unfinished today, and the ones who finished did so within minutes, so the page loses people rather than slowing them. The page has two finish buttons (the W-9's own and Submit), W-9 errors that render out of view, and a long scroll of reading and optional fields above the required ones. This lane makes Submit the only button, puts every error beside its field, and cuts the page to what is required.

The full mobile rework of onboarding comes later and replaces the layout. Nothing here is thrown away by it: the one-press submit and the next-unfinished-step routing are logic a rework needs too.

Out of scope, recorded for the lane report: a server-side check that the agreement is signed before promotion to approved (onboardingPromotion.js is on the sensitive list and needs its own lane); a direct link to /payday-protocols still opens the page for a recruit who has not signed.

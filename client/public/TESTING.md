# Dr. Bartender — Pre-Launch Testing Guide (Round 1)

Hi! Thanks for helping test Dr. Bartender before we launch.

Your job is to click through every feature the way a real customer, applicant, or bartender would, and flag anything that looks wrong, broken, or confusing. This guide tells you exactly what to click and what you should see afterward.

The site is live at its real web addresses (drbartender.com, etc.), but no real customers are using it yet. **Everything you create during testing will be wiped before launch** — so don't worry about "messing it up." Submit fake applications, book fake events, poke at everything.

---

## How to Use This Guide

1. **Follow the parts in order.** Each part builds on the one before it. The booking story in Part 2 uses the quote you submit at the end of Part 1, and so on.
2. **Check each box as you finish the step.** Click the checkboxes in the browser if you're viewing this as a Markdown preview, or print the doc and check them with a pen.
3. **When something doesn't work, stop and write it down** using the Bug Report Template at the very bottom. Screenshot if you can. Then keep going — one broken thing shouldn't block the rest of the test.
4. **When you see "Switch to admin,"** flip to your second browser window (your admin login). You'll be wearing two hats all day.

## What You'll Need

- A laptop or desktop computer
- **Two browser windows open side by side:**
  - **Window A (normal Chrome or Safari)** — this is your "customer / applicant / staff" window
  - **Window B (Incognito/Private window, or a different browser)** — this is your "admin" window
  - Keeping them separate stops the two logins from fighting each other
- **Your real email address** — the site will send real emails to whatever address you type in forms
- **Your real phone number** — the site will send real text messages
- **Admin login** (temporary, for testing only):
  - Email: `admin@drbartender.com`
  - Password: `DrBartender2024!`
- **Stripe test credit card numbers:**
  - Works: `4242 4242 4242 4242`, expiry any future date (`12/34`), CVC any 3 digits (`123`), ZIP any 5 digits (`12345`)
  - Declined (for testing error messages): `4000 0000 0000 0002`
- A phone with Chrome or Safari — for Part 7 (mobile testing)

## Important Warnings

- **DO NOT press "Send" on any email marketing campaigns.** Create them as drafts only. We'll test real sending in a separate round.
- **Emails and texts are real and go to the email/phone you type into forms.** Use your own — don't put a friend's address as a joke.
- **Use the test credit cards above.** Don't use a real card, even though Stripe is in test mode.
- **If a page looks completely broken (white screen, scary error), take a screenshot and skip to the next step.** Log it and move on.

---

## Part 1 — Click Through the Public Website

You're a first-time visitor who's thinking about hiring a bartender. Use Window A for this whole part.

**Go to:** `drbartender.com`

### Homepage
- [ ] The page loads with a big hero image and a headline at the top
- [ ] You can see a "Get a Quote" button near the top
- [ ] Scroll down — you see: 3 service cards (Consultation, Menu Design, Licensing); a "How It Works" section with 3 steps; stats (20+ years, $2M insurance, 3-state coverage); testimonials (3 cards)
- [ ] At the very bottom there's another "Get a Quote" button
- [ ] Click the top "Get a Quote" button → it takes you to the quote page
- [ ] Click back, scroll down, try the bottom "Get a Quote" button too → also goes to the quote page

### FAQ Page
- [ ] Go to `drbartender.com/faq`
- [ ] You see 4 categories: **Booking & Pricing**, **Services & Packages**, **Logistics & Coverage**, **Event Day**
- [ ] Click at least one question in each category — the answer expands, and the `+` icon changes to `−`
- [ ] Click the question again — the answer collapses
- [ ] Scroll to the bottom — the "Get Your Free Quote" button works and takes you to the quote page

### Quote Wizard (you'll use the resulting proposal in Part 2!)
- [ ] Go to `drbartender.com/quote`
- [ ] **Step 1 — Event Details:**
  - [ ] Enter Guest count `50`
  - [ ] Enter Duration `4` hours
  - [ ] Pick an Event date at least 2 weeks in the future
  - [ ] Pick a Start time
  - [ ] Pick Event type "Wedding" (or any option)
  - [ ] Enter City `Chicago`, State `IL`
  - [ ] Pick Alcohol provider "BYOB"
  - [ ] Pick Bar type "Full Bar"
  - [ ] Click Next
- [ ] **Step 2 — Your Info:**
  - [ ] Enter your name
  - [ ] Enter your real email (you'll receive the proposal link here)
  - [ ] Enter your real phone
  - [ ] Click Next
- [ ] **Step 3 — Package:** this step only appears if you picked "Hosted" alcohol. Skip if BYOB.
- [ ] **Step 4 — Extras:**
  - [ ] Check one or two add-ons (like "Bar Rental")
  - [ ] Pick one or two syrups
  - [ ] Click Next
- [ ] **Step 5 — Review:**
  - [ ] All your entries are listed correctly
  - [ ] A pricing breakdown shows with a total dollar amount
  - [ ] Click Submit
- [ ] A success message appears
- [ ] After 2–3 seconds the browser redirects to a proposal page
- [ ] **KEEP THIS TAB OPEN** — you'll need this proposal for Part 2

### Class Wizard
- [ ] Go to `drbartender.com/classes`
- [ ] **Step 1 — Choose Class:**
  - [ ] Pick "Craft Cocktails"
  - [ ] Click Next
- [ ] **Step 2 — Details:**
  - [ ] Enter 10 guests, 2 hours
  - [ ] Pick date and start time
  - [ ] Enter event name "Class Test" and a location
  - [ ] Click Next
- [ ] **Step 3 — Equipment:**
  - [ ] Pick a Tool Kit (Purchase OR Rental — not both)
  - [ ] Check 1–2 equipment boxes
  - [ ] Click Next
- [ ] **Step 4 — Your Info:**
  - [ ] Name, email, phone
  - [ ] Click Submit
- [ ] Success message appears and you're redirected to a proposal page

### Lab Notes (Blog)
- [ ] Go to `drbartender.com/labnotes`
- [ ] If there are published posts, you see a grid of cards, each showing cover image, title, short excerpt, and publish date
- [ ] Click a card → the full post page loads
- [ ] Click "← Back to Lab Notes" → you return to the listing
- [ ] If no posts are published yet, you see an empty-state message (we'll come back and publish one in Part 6)

---

## Part 2 — Become a Client (quote → sign → pay → drink plan → balance)

This is the big one. You'll act as the client who just submitted the quote in Part 1, while also popping over to the admin window to move the process along. **Switch back and forth between your two browser windows** when the doc tells you to.

### Send the proposal

- [ ] **Switch to admin browser.** Go to `admin.drbartender.com`, log in.
- [ ] In the left sidebar, click "Proposals"
- [ ] Find the proposal with your name on it (status: Draft) → click to open it
- [ ] Verify every field matches what you entered in Part 1: guest count, date, time, location, package, add-ons
- [ ] Click the "Send" button (or whatever moves the status from Draft to Sent)
- [ ] Status badge now shows "Sent"
- [ ] **Check your email.** A proposal email from Dr. Bartender should arrive within a minute.
  - If the email doesn't arrive in 2 minutes, check spam, then log it as a bug

### Open and sign the proposal

- [ ] **In Window A (client),** open the proposal link from the email
- [ ] The proposal page loads — it shows event name, date, time, location, guest count, number of bartenders, package details, and a line-by-line pricing breakdown
- [ ] Verify the total matches what the admin side showed
- [ ] **Switch to admin** → refresh the proposal detail page → status badge now shows "Viewed"
- [ ] **Back to client** → scroll down to the signature section
- [ ] Enter your full name in the signature name field
- [ ] Click the "Draw" button → sign with your mouse or finger → the signature appears
- [ ] Check the "I agree to the terms" checkbox (if present)
- [ ] Click Sign / Save Signature
- [ ] A confirmation appears
- [ ] **Switch to admin** → refresh → the proposal detail page now shows the captured signature image, the signed-by name, and the signing date

### Pay the deposit

- [ ] **Back to client** → scroll to the payment section
- [ ] Select "Pay Deposit Now"
- [ ] **Check the autopay checkbox** — "Automatically charge my saved card for the balance" — you'll need this for the autopay test in Part 5
- [ ] Enter test card `4242 4242 4242 4242`, expiry `12/34`, CVC `123`, ZIP `12345`
- [ ] Click Pay
- [ ] A loading spinner appears, then a success message
- [ ] **Check your email.** A payment confirmation email should arrive within a minute.
- [ ] **Switch to admin** → refresh proposal detail → status is now "Deposit Paid"
- [ ] The payment amount shows in the Recent Payments section
- [ ] Set the Balance Due Date field to a date 2 weeks from now → click Save → the date sticks after refresh

### Open the client portal

- [ ] **Back to client.** Go to `drbartender.com/login`
- [ ] Enter the same email you used on the quote
- [ ] Click "Send Code" → you see "If an account exists, a code has been sent"
- [ ] **Check your email.** A 6-digit code should arrive.
- [ ] Back in the browser, enter the 6-digit code
- [ ] Click Verify → you land on `/my-proposals`
- [ ] You see your proposal listed with its status and event date
- [ ] Click the proposal → you're back on the same proposal page

### Generate and fill out the drink plan

- [ ] **Switch to admin** → on the proposal detail page, find "Create Drink Plan" (or similar) → click it
- [ ] A drink plan is created and linked to the proposal
- [ ] Copy the drink plan link (ends in `/plan/…`)
- [ ] **Back to client** → paste that link into the address bar
- [ ] The Potion Planning Lab loads
- [ ] Walk through every step:
  - [ ] Welcome step — greets you by name
  - [ ] Quick Pick — pick one option (try "Full Bar")
  - [ ] Vibe — pick a vibe (elegant / playful / etc.)
  - [ ] Flavor Direction — check a few flavors, write a "dream drink" note
  - [ ] Exploration Browse — click on cocktails to add them to favorites
  - [ ] Mocktail Interest — pick "Some mocktails"
  - [ ] Exploration Save — click Continue or Save Draft
- [ ] If the proposal is in the Refinement phase (after deposit paid), continue:
  - [ ] Refinement Welcome — recap screen
  - [ ] Signature Picker — select cocktails or type custom ones
  - [ ] Spirits / Beer / Wine — based on what you picked
  - [ ] Mocktails — select or skip
  - [ ] Menu Design — pick a theme, write naming preferences
  - [ ] Logistics — enter day-of contact, parking, setup needs
  - [ ] Confirmation — review → click Submit for Approval
- [ ] A success message appears confirming submission

### Review drink plan and generate shopping list

- [ ] **Switch to admin** → click "Drink Plans" in the sidebar
- [ ] Find your submission (status: Submitted) → open it
- [ ] Verify all selections are listed correctly
- [ ] Add an admin note like "Test note"
- [ ] Change the status to "Reviewed"
- [ ] Click "Generate Shopping List"
- [ ] A shopping list appears with quantities for spirits, beers, wines, mixers, syrups
- [ ] Copy the client-facing shopping list link (ends in `/shopping-list/…`)
- [ ] **Back to client** → paste that link into the address bar
- [ ] The shopping list loads and shows the same items / quantities

### Pay the balance

- [ ] **Back to client** → open your proposal again (from email or `/my-proposals`)
- [ ] Scroll to the payment section
- [ ] Select "Pay Remaining Balance" (or similar)
- [ ] Enter test card `4242 4242 4242 4242` again
- [ ] Click Pay
- [ ] Success message
- [ ] **Check your email.** A second payment confirmation arrives.
- [ ] **Switch to admin** → refresh → status is now "Paid in Full" or "Balance Paid"
- [ ] The linked event/shift is automatically marked "Confirmed"

### Edit-after-sign test

- [ ] **Stay in admin** → open the same proposal (still in edit mode)
- [ ] Change the guest count (e.g., from 50 to 75)
- [ ] Save
- [ ] The total recalculates
- [ ] Status flips to "Modified" (signaling the client needs to re-sign)
- [ ] Click into the linked event → guest count there also shows 75

### Decline path (second proposal)

- [ ] **Back to client.** Create a quick second proposal:
  - [ ] Go to `drbartender.com/quote`, fill it out, submit
  - [ ] **Switch to admin**, find it, click Send
- [ ] **Back to client** → open the email → open the proposal → sign it
- [ ] On the payment step, enter the **declined** test card `4000 0000 0000 0002`
- [ ] Click Pay
- [ ] An error message appears (something like "Your card was declined") — this should NOT crash the page
- [ ] The payment form is still usable — you can try a different card
- [ ] Switch the card to `4242 4242 4242 4242` → Pay → success

---

## Part 3 — Apply to Work as a Bartender

You're a new bartender looking for work. Use Window A.

- [ ] Go to `hiring.drbartender.com`
- [ ] You see the Landing page with a 4-step explainer (Create Account → Apply → Interview → Start Working)
- [ ] Click "Create Account" → you're on the Register page
- [ ] Enter an email different from your client email (use email+applicant@... or a second address)
- [ ] Enter a password (must be 8+ chars, with uppercase, lowercase, and a digit)
- [ ] Confirm password → Submit
- [ ] You're redirected to the Application form

### Fill out the application

- [ ] **Basic Info:**
  - [ ] Full name, phone, favorite color, date of birth (must be 21+)
- [ ] **Location & Travel:**
  - [ ] Street address, city, pick a state (IL, IN, MI, MN, or WI — others are blocked)
  - [ ] Travel distance — pick any
  - [ ] Transportation — yes/no/maybe
- [ ] **Experience:**
  - [ ] Check at least one position (Bartender)
  - [ ] Prior experience — Yes
  - [ ] Years, description, last worked, types
- [ ] **Availability:**
  - [ ] Saturdays — Yes
  - [ ] Commitments — "None"
- [ ] **Tools & Equipment:**
  - [ ] Check a few boxes
- [ ] **Skills:**
  - [ ] Setup confidence slider — pick 4
  - [ ] Work alone — Yes
  - [ ] Customer service — type a sentence
- [ ] **Additional Info & Files:**
  - [ ] Why Dr. Bartender — "Testing the application form"
  - [ ] Notes — leave blank or add a line
  - [ ] Upload any PDF or image as **Resume** (required)
  - [ ] Upload any image as **Headshot** (optional)
  - [ ] Upload any PDF or image as **BASSET Certification** (required)
- [ ] **Emergency Contact:**
  - [ ] Name, phone, relationship
- [ ] Click Submit
- [ ] You land on the Application Status page showing "Application Received"

### Admin review

- [ ] **Switch to admin** → click "Hiring" in the sidebar → Applications tab
- [ ] Your new application is at the top — click it open
- [ ] Verify the applicant info, answers, and that the three uploaded files open when clicked (resume, BASSET, headshot)
- [ ] Add an interview note like "Test note from QA"
- [ ] Change status from "Applied" to "Interviewing"
- [ ] **Check the applicant's email** for an interview-invitation email (may or may not send depending on config — log either way)

### Second application — reject path (optional but recommended)

- [ ] Register a second throwaway applicant account (different email)
- [ ] Submit a minimal application
- [ ] **Switch to admin** → find it → change status to "Rejected"
- [ ] Verify the rejection email arrives at that email address

---

## Part 4 — Hire Yourself and Finish Onboarding

Now hire the first test applicant (yourself) and walk through the full onboarding.

### Hire

- [ ] **Switch to admin** → Hiring → Applications tab → open the main test application (the one from Part 3, not the rejected one)
- [ ] Change status to "Hired"
- [ ] **Check the applicant's email** — a "You're hired" email should arrive

### Admin profile override (quick verification)

- [ ] **Still in admin**, from the application detail page, click Edit
- [ ] Change the preferred name to "Test Staff" → Save
- [ ] The updated name appears

### Staff onboarding

- [ ] **Switch to staff browser** (Window A, but log out first if needed; or use a third window)
- [ ] Go to `staff.drbartender.com`
- [ ] Log in with the applicant email + password
- [ ] You land on the Welcome page — it lists 4 requirements
- [ ] Click "Access the Field Guide"

#### Field Guide
- [ ] Field Guide page loads with sections: Field Duties, Appearance Protocols, Tools, Timing & Punctuality, Tips & Gratuities, Professional Boundaries
- [ ] Scroll through all sections
- [ ] Click "I Understand, Continue"

#### Agreement
- [ ] Agreement page loads with contract text
- [ ] Fields: full name, email, phone, SMS consent checkbox, two required agreement checkboxes
- [ ] Enter your info
- [ ] Check both agreement checkboxes
- [ ] Check the SMS consent checkbox (so you can receive shift texts later)
- [ ] Click the "Draw" signature option → sign with mouse
- [ ] Click Save / Submit
- [ ] Success message

#### Contractor Profile
- [ ] Contractor Profile page loads (fields may be pre-filled from your application)
- [ ] Verify everything is filled: preferred name, phone, email, DOB, address, travel distance, transportation, equipment checkboxes, emergency contact
- [ ] File uploads (alcohol cert, resume, headshot) — optional, skip or upload anything
- [ ] Click Save / Submit
- [ ] Success → next step

#### Payday Protocols
- [ ] Payday Protocols page loads
- [ ] **W-9 section:**
  - [ ] Click "Fill W-9 Form" → fill in the fields the form asks for → save/generate
  - [ ] (OR on a separate test run, click "Upload W-9" and upload any PDF)
- [ ] **Payment method:**
  - [ ] Pick "Venmo" → enter your Venmo handle
  - [ ] Or pick any other method and fill in the required fields
- [ ] Click Save / Submit
- [ ] You land on the Completion page

#### Completion page
- [ ] You see a success message, next steps, and a link/button to the WhatsApp group (or similar)

### Approve onboarding

- [ ] **Switch to admin** → Hiring → Onboarding tab
- [ ] Find your test staff member → their status shows "Submitted"
- [ ] Approve onboarding — status changes to "Approved"

### Staff portal

- [ ] **Switch to staff** → log out → log back in at `staff.drbartender.com`
- [ ] You now land on the Staff Portal Dashboard (not the Welcome page)
- [ ] Verify the dashboard shows stat cards: Open Shifts, Pending Requests, Confirmed Requests, Upcoming Events, Past Events
- [ ] Click "Shifts" in the sidebar
  - [ ] You see open shifts (from the events you created in Part 2)
  - [ ] Pick one → select a position from the dropdown → click "Request This Shift"
  - [ ] A pending status chip appears on that shift
  - [ ] Click "Cancel Request" on the same shift → it goes back to unrequested
  - [ ] Request it again (so admin has something to approve in the next step)
- [ ] Click "Schedule" → lists your approved/confirmed shifts (empty for now)
- [ ] Click "Events" → lists upcoming events
- [ ] Click "Resources" → loads
- [ ] Click "Profile" → loads with your info

### Admin: approve the shift request

- [ ] **Switch to admin** → open the event the staff requested → find the shift request → Approve it
- [ ] **Check the staff's phone** — an SMS about the confirmed shift should arrive
- [ ] **Check the staff's email** — a confirmation email may also arrive
- [ ] **Switch to staff** → refresh Schedule → the shift now appears as confirmed

### Second shift request — deny path

- [ ] **Switch to staff** → request a different shift
- [ ] **Switch to admin** → find the request → click Deny
- [ ] **Switch to staff** → refresh → the shift shows as Denied (or the request is gone)

### Manual assign

- [ ] **Switch to admin** → open a third event (create one from the Events dashboard if needed)
- [ ] Click "Assign Staff" → search for your test staff name → assign them to a position
- [ ] Staff receives SMS + email

### Auto-assign

- [ ] **Still in admin** → on another event, click "Auto-Assign"
- [ ] Verify it runs a preview showing who would be assigned
- [ ] Run it for real → staff assignments happen → SMS sent to assigned staff

### Permissions test

- [ ] **Switch to admin** → find your test staff in Staffing → promote to Manager role
- [ ] **Switch to staff** → refresh — the sidebar or admin link should now appear
- [ ] Demote back to regular staff → admin link disappears

### Deactivation test

- [ ] **Switch to admin** → find the test staff → Deactivate
- [ ] **Switch to staff** → try to access `/portal/dashboard` → you're kicked out or shown an access-blocked message

---

## Part 5 — Admin: Proposal and Event Management Deep Dive

By now you've touched admin many times. This part exercises the admin features your story hasn't hit yet.

Use Window B (admin) for all of Part 5.

- [ ] Go to `admin.drbartender.com`
- [ ] **Main Dashboard:**
  - [ ] All stat cards load (Upcoming Events, Pending Proposals, Payments Due, Unstaffed Events, Staffing Requests, Total Revenue, Collected, Outstanding)
  - [ ] Numbers reflect the test data you've created in Parts 2–4
  - [ ] Each "top 5" table shows rows that are clickable and navigate to the item's detail page
  - [ ] The three quick-action buttons (New Proposal, Manage Clients, View Financials) work
- [ ] **Sidebar badge counts:**
  - [ ] Unstaffed Events, Pending Proposals, New Applications badges appear and look accurate
- [ ] **Proposals Dashboard:**
  - [ ] Search by client name — you find your Part 2 proposal
  - [ ] Filter by status (Draft / Sent / Viewed / Modified / Accepted) — each filter shows matching proposals
  - [ ] Copy-link button on each row — clicking copies the proposal URL to clipboard (paste somewhere to verify)
- [ ] **Create a new proposal from scratch:**
  - [ ] Click "New Proposal"
  - [ ] Enter new client name + email
  - [ ] Pick event type (try "Corporate"); event name auto-fills
  - [ ] Pick date, time, duration, location, guest count
  - [ ] Pick a package
  - [ ] Check a few add-ons
  - [ ] Enable "Needs Bar," enter number of bartenders
  - [ ] Pricing breakdown updates in real time
  - [ ] Click Save
  - [ ] You land on the proposal detail page
- [ ] **Record a cash payment on this new proposal:**
  - [ ] Click "Record Payment"
  - [ ] Enter an amount, method = Cash, check "Paid in Full"
  - [ ] Save
  - [ ] Status updates; amount_paid increments
- [ ] **Generate a Stripe payment link:**
  - [ ] On yet another test proposal (create a new one if needed), click "Generate Payment Link"
  - [ ] A link is returned → copy it
  - [ ] Paste it in an Incognito window → the Stripe checkout loads with the right amount
  - [ ] Pay with `4242 4242 4242 4242` → success
  - [ ] Back in admin → refresh → the proposal now shows the payment
- [ ] **Autopay charge balance test:**
  - [ ] Go back to the Part 2 proposal (where you enrolled in autopay during deposit)
  - [ ] If it's already paid in full, use a new proposal where the client just paid deposit with the autopay checkbox on
  - [ ] Click "Charge Balance" on that proposal
  - [ ] A confirmation modal appears → confirm
  - [ ] Charge succeeds (since the test card is saved) → status flips to "Paid in Full"
- [ ] **Events Dashboard:**
  - [ ] Toggle between Upcoming and Past — upcoming shows your Part 2 event
  - [ ] Search by event name
  - [ ] Click "Create Event" button → the inline form toggles open
  - [ ] Fill in the form (event name, client info, date, time, location, guest count, positions needed)
  - [ ] Submit → a new event (no linked proposal) appears
- [ ] **Shift settings on an event:**
  - [ ] Open the manual event you just created
  - [ ] Set Auto-Assign Days Before to 7 → save → value persists after refresh
  - [ ] Set Setup Minutes Before to 60 → save → value persists after refresh
  - [ ] Toggle the Equipment Required checkboxes (portable bar, cooler, table with spandex) → save → persists

---

## Part 6 — Admin: Remaining Dashboards

### Clients
- [ ] Click "Clients" in the sidebar
- [ ] Clients list loads, search by name works
- [ ] Click "Add Client" / inline form appears
- [ ] Add a new client: name, email, phone, source = "Direct"
- [ ] Save → client appears in the list
- [ ] Click the new client → detail page loads
- [ ] Click Edit → change the notes → Save → notes persist
- [ ] From the detail page, click "New Proposal" → the proposal form loads pre-filled with this client's info
- [ ] (Cancel — no need to save this test proposal)

### Drink Plans (admin-initiated)
- [ ] Click "Drink Plans" in the sidebar
- [ ] Click "Add Plan" / inline form
- [ ] Enter a different client name + email + event name + date → Save
- [ ] The new plan appears with status "Pending"
- [ ] Copy the plan link → paste it into Incognito → the Potion Planning Lab loads

### Financials
- [ ] Click "Financials" in the sidebar
- [ ] Stat cards: Total Revenue, Collected, Outstanding — numbers look right for your test data
- [ ] Proposals table shows every proposal with correct paid / balance amounts
- [ ] Recent Payments table shows: the Part 2 deposit, the Part 2 balance, the Part 5 cash payment, the Part 5 payment-link charge, the Part 5 autopay charge
- [ ] Click a proposal row → jumps to that proposal's detail page

### Blog
- [ ] Click "Blog" in the sidebar
- [ ] Click "New Post"
- [ ] Enter title "Test Post — please delete"
- [ ] Slug auto-fills (or edit it)
- [ ] Enter excerpt
- [ ] Upload a cover image (any JPG/PNG)
- [ ] In the rich text body: type some text, try bold, italic, a link, a bullet list, a heading
- [ ] Upload an inline image inside the body
- [ ] Check the "Published" box
- [ ] Click Save
- [ ] Post appears in the list
- [ ] **Switch to Window A (public)** → go to `drbartender.com/labnotes` → your test post shows up
- [ ] Click the post → full post loads with your content
- [ ] **Switch back to admin** → click Edit on the post → change the title → Save → public site reflects the change
- [ ] Click Delete → confirm → post disappears from both admin list and public blog

### Email Marketing
- [ ] Click "Marketing" in the sidebar (or "Email Marketing")
- [ ] **Leads tab:**
  - [ ] Click "Add Lead" → fill in a name, email, event type → Save → lead appears
  - [ ] Click "Import CSV" → upload a small test file with a few rows (ask Dallas for a sample, or paste these 3 rows into a `.csv`):
    ```
    name,email,company,event_type,lead_source
    Alice Test,alice@example.com,Alice Inc,wedding,manual
    Bob Test,bob@example.com,Bob Corp,corporate,manual
    Carol Test,carol@example.com,Solo,birthday,manual
    ```
  - [ ] Column mapping screen appears → map correctly → preview → confirm import
  - [ ] The 3 new leads appear
  - [ ] Filters: try "Status = Active", "Lead Source = Manual" — filtering works
  - [ ] Click one lead → detail page opens
  - [ ] On detail: mark as Unsubscribed → status changes → Reactivate → status flips back
- [ ] **Campaigns tab:**
  - [ ] Click "New Campaign"
  - [ ] Enter name "Test Blast — Do Not Send"
  - [ ] Type = Blast
  - [ ] Subject line, body (use the rich text editor; add a link)
  - [ ] Audience = filter by Lead Source "Manual" (which will catch your 3 test leads)
  - [ ] Click Save → campaign saves as Draft → **DO NOT CLICK SEND**
  - [ ] Go back to Campaigns list → draft appears
  - [ ] Click back into the campaign → verify body, subject, audience saved correctly
  - [ ] Click "New Campaign" again → Type = Sequence → name "Test Sequence — Do Not Send"
  - [ ] Build 2–3 drip steps with delays → Save as draft → **DO NOT ACTIVATE**
- [ ] **Analytics tab:**
  - [ ] Page loads; stat cards show total leads, campaigns, opens, clicks (mostly zeros since nothing sent)
- [ ] **Conversations tab:**
  - [ ] Page loads; likely empty (nobody's replied yet)

### Settings
- [ ] Click "Settings" in the sidebar
- [ ] **Drink Menu tab:**
  - [ ] List of cocktails loads
  - [ ] Click "Add Cocktail" → fill in a new cocktail name, ingredients, etc. → Save → new cocktail appears
  - [ ] Click Edit on it → change the name → Save → change persists
  - [ ] Click Delete → confirm → cocktail disappears
- [ ] **Calendar Sync tab:**
  - [ ] Feed URL is displayed (read-only)
  - [ ] Click Copy → URL copied to clipboard
  - [ ] Click Regenerate → a warning modal appears ("this will break existing subscriptions") → cancel to verify the warning, then click through if you want
  - [ ] New URL appears and is different from the old one
- [ ] **Auto-Assign tab:**
  - [ ] Settings load (days-before thresholds, SMS templates, fallback rules)
  - [ ] Change one value → Save → reload → value persists

---

## Part 7 — Cross-Browser and Mobile

### Mobile pass — on your phone

- [ ] Open Chrome or Safari on your phone
- [ ] Go to `drbartender.com`
- [ ] Scroll through the homepage — layout adjusts for small screen (no horizontal scroll, text readable)
- [ ] Open the menu (if there's a hamburger icon) → navigation works
- [ ] Open `/quote` → the quote wizard is usable on mobile
- [ ] Open a proposal link from your email on your phone → proposal loads, scrolls, looks reasonable
- [ ] On the signature pad, try signing with your finger → signature captures
- [ ] Try one onboarding step (`staff.drbartender.com` after logging in) on mobile
- [ ] Open `admin.drbartender.com/admin/proposals` on mobile → verify admin pages are usable (may be cramped but shouldn't be broken)

### Desktop browser pass

- [ ] Already covered in Chrome through Parts 1–6
- [ ] Optional: open `drbartender.com` in Safari or Firefox → at least confirm the homepage, FAQ, and quote wizard all render correctly

---

## Appendix — Exhaustive Page-by-Page Checklist

For the thorough regression pass. This is a flat list of every page on every subdomain with checkboxes for every button, field, and state. Use this when you want to be sure nothing was missed, or before any major deploy.

### Public Website (drbartender.com)

#### `/` (Homepage)
- [ ] Logo in header links back to `/`
- [ ] Main nav links (if present)
- [ ] Hero "Get a Quote" button
- [ ] Service cards (3)
- [ ] How It Works steps (3)
- [ ] About section
- [ ] Stats row
- [ ] Testimonial cards (3)
- [ ] Bottom CTA banner with button
- [ ] Footer links all work

#### `/quote` (Quote Wizard)
- [ ] Step 1 — every field
- [ ] Step 1 — Back button disabled on first step
- [ ] Step 2 — email validation (enter a bad email → error)
- [ ] Step 3 — only shows if Hosted
- [ ] Step 4 — every add-on toggles
- [ ] Step 4 — every syrup toggles
- [ ] Step 5 — pricing matches sum of parts
- [ ] Back button works on every step
- [ ] Submit button → success state + redirect
- [ ] Refresh mid-way → draft is restored

#### `/faq`
- [ ] Each category heading
- [ ] Every Q expands and collapses
- [ ] Bottom CTA button

#### `/classes` (Class Wizard)
- [ ] All 4 steps
- [ ] Spirit category dropdown (if Spirits Tasting picked)
- [ ] Supply add-ons mutually exclusive
- [ ] Top Shelf toggle (if present)

#### `/labnotes` and `/labnotes/:slug`
- [ ] Empty state if no posts
- [ ] Grid cards with cover / chapter / title / excerpt / date
- [ ] Click card → detail loads
- [ ] Back link works
- [ ] Next/Previous post nav (if present)
- [ ] 404: go to `/labnotes/not-a-real-slug` → "Post Not Found" page

#### `/login` (Client OTP login)
- [ ] Email field validates
- [ ] Send Code → generic message regardless of whether email exists
- [ ] OTP step appears
- [ ] Wrong code → error
- [ ] Expired code (wait 15 min) → error
- [ ] "Resend" link works
- [ ] Successful login → redirects to `/my-proposals`

#### `/my-proposals`
- [ ] Redirects to `/login` if not signed in
- [ ] Empty state if no proposals
- [ ] Proposals grid with cards
- [ ] Click card → proposal detail
- [ ] Logout button works

#### `/proposal/:token`
- [ ] Expired/invalid token → error page
- [ ] All event details display
- [ ] Package details render with placeholders filled in
- [ ] Line items and totals correct
- [ ] Signature section (draw + type)
- [ ] Clear signature button
- [ ] Payment section — deposit and full options
- [ ] Autopay checkbox
- [ ] Stripe card form
- [ ] Card declined → graceful error
- [ ] Success redirect to `?paid=true` message
- [ ] View count increments (check in admin)

#### `/plan/:token`
- [ ] Expired/invalid token → error page
- [ ] Every step of exploration phase
- [ ] Every step of refinement phase
- [ ] Auto-save indicator appears
- [ ] Manual Save Draft button
- [ ] Submit → success message

#### `/shopping-list/:token`
- [ ] Expired/invalid token → error
- [ ] "Not ready" state if no shopping list generated yet
- [ ] Full list once generated (client name, event, items with quantities)

### Hiring (hiring.drbartender.com)

#### `/` (Landing)
- [ ] 4-step explainer cards
- [ ] Create Account button
- [ ] Login link (if already have account)

#### `/register`
- [ ] Email field
- [ ] Password field with complexity rules
- [ ] Confirm password (mismatch → error)
- [ ] Submit → redirects to `/apply`

#### `/login`
- [ ] Email / password
- [ ] Wrong password → error (after 10 attempts, lockout)
- [ ] Forgot password link

#### `/forgot-password`
- [ ] Email field → "If account exists, email sent"
- [ ] Check email for reset link

#### `/reset-password/:token`
- [ ] New password field (complexity rules)
- [ ] Confirm password
- [ ] Submit → redirects to login

#### `/apply`
- [ ] Each of the 8 sections
- [ ] Required field validation
- [ ] File uploads (resume required, BASSET required, headshot optional)
- [ ] DOB → age 21+ check
- [ ] State dropdown: only IL/IN/MI/MN/WI
- [ ] Submit → redirect to `/application-status`

#### `/application-status`
- [ ] Status "Applied" → Received message
- [ ] Status "Interviewing" → extra alert
- [ ] Status "Rejected" → rejection message

### Staff (staff.drbartender.com)

#### `/login`, `/forgot-password`, `/reset-password/:token`
- [ ] Same as hiring site

#### `/welcome`
- [ ] 4 requirement checklist items
- [ ] "Access the Field Guide" button

#### `/field-guide`
- [ ] All sections display
- [ ] "I Understand, Continue" button

#### `/agreement`
- [ ] Pre-filled fields
- [ ] SMS consent checkbox
- [ ] Two required agreement checkboxes
- [ ] Draw signature
- [ ] Type signature (alternate test run)
- [ ] Submit → next step

#### `/contractor-profile`
- [ ] All fields
- [ ] File uploads
- [ ] Equipment checkboxes
- [ ] Emergency contact
- [ ] Submit

#### `/payday-protocols`
- [ ] W-9 Fill path
- [ ] W-9 Upload path
- [ ] Venmo field
- [ ] Zelle field
- [ ] Cash App field
- [ ] PayPal field
- [ ] Direct Deposit fields
- [ ] Submit → `/complete`

#### `/complete`
- [ ] Success message
- [ ] Back to overview button

#### `/portal/dashboard`
- [ ] Welcome banner with name
- [ ] Stat cards
- [ ] Next Event card (if exists)

#### `/portal/shifts`
- [ ] Open shifts list
- [ ] Position dropdown per shift
- [ ] Request / Cancel request buttons
- [ ] Status chips

#### `/portal/schedule`
- [ ] Upcoming shifts
- [ ] Past shifts

#### `/portal/events`
- [ ] Loads

#### `/portal/resources`
- [ ] Loads

#### `/portal/profile`
- [ ] User info displays
- [ ] Edit functionality (if present)

### Admin (admin.drbartender.com)

#### Sidebar
- [ ] All 10 links: Dashboard, Events, Proposals, Clients, Staff, Hiring, Financials, Blog, Marketing, Settings
- [ ] Badge counts on Events, Proposals, Hiring
- [ ] User info at top
- [ ] Sign Out button

#### `/admin/dashboard`
- [ ] 8 stat counters
- [ ] 5 detail tables (top 5 rows each)
- [ ] 3 quick-action buttons

#### `/admin/proposals`
- [ ] Create button
- [ ] Search
- [ ] Filter by status
- [ ] Table columns correct
- [ ] Copy link button per row

#### `/admin/proposals/new`
- [ ] Client info (name required)
- [ ] Event type autocomplete
- [ ] Date / time pickers
- [ ] Location autocomplete
- [ ] Package dropdown
- [ ] Add-ons (filtered by package)
- [ ] Needs bar toggle
- [ ] Number of bartenders (conditional)
- [ ] Pricing calculation in real time
- [ ] Submit → proposal detail

#### `/admin/proposals/:id`
- [ ] All sections: Summary, Payment, Drink Plan, Staffing (if event), Notes
- [ ] Edit mode
- [ ] Record payment modal
- [ ] Generate payment link button
- [ ] Charge balance button (if applicable)
- [ ] Activity history popup
- [ ] Signature display after client signs
- [ ] Status transitions (Draft → Sent → Viewed → Accepted → Deposit Paid → Balance Paid → Confirmed)

#### `/admin/events`, `/admin/events/:id`, `/admin/events/shift/:id`
- [ ] Upcoming/Past filter
- [ ] Search
- [ ] Create Event form with warning banners
- [ ] Shift detail page (non-proposal shift)

#### `/admin/clients`, `/admin/clients/:id`
- [ ] Create client inline form
- [ ] Search
- [ ] Client detail with Edit, Notes, Proposals list

#### `/admin/drink-plans`, `/admin/drink-plans/:id`
- [ ] Create inline form
- [ ] Search
- [ ] Filter by status
- [ ] Copy link button
- [ ] Detail page: admin notes, mark reviewed, generate shopping list

#### `/admin/hiring`
- [ ] Applications tab — filters, search, pagination, inline status change
- [ ] Onboarding tab — progress indicators, status colors

#### `/admin/staffing`, `/admin/staffing/users/:id`, `/admin/staffing/applications/:id`
- [ ] Staff list
- [ ] Application detail — files open, interview notes, status, permissions

#### `/admin/financials`
- [ ] Stat cards
- [ ] Proposals table
- [ ] Recent payments table

#### `/admin/blog`
- [ ] Posts list with Edit / Delete
- [ ] New Post form
- [ ] Rich text editor (bold, italic, link, list, heading, images)
- [ ] Cover image upload
- [ ] Publish toggle + publish date

#### `/admin/email-marketing`
- [ ] Tab navigation: Leads, Campaigns, Analytics, Conversations
- [ ] Leads: add, import CSV, filter, detail
- [ ] Campaigns: list, new (blast + sequence), edit, audience selector
- [ ] Analytics: summary + delivery breakdown chart
- [ ] Conversations: thread view, reply box

#### `/admin/settings`
- [ ] Drink Menu tab (CRUD on cocktails)
- [ ] Calendar Sync tab (copy, regenerate with warning)
- [ ] Auto-Assign tab

---

## Bug Report Template

Copy this block for each bug you find. Screenshots make everything faster.

```
BUG #__

Where:          (e.g., "Admin > Proposals > Open proposal > Edit" or a URL)
What I did:     (the steps you took, in order)
What happened:  (what the screen showed — error message, crash, wrong number, missing button, etc.)
What I expected: (what you thought should happen)
Browser:        (Chrome / Safari / Firefox, desktop or phone)
Screenshot:     (attach to email / doc / Slack thread)
```

Send bugs to Dallas as you find them, or collect them up and send a batch at the end — your call.

---

**Thank you for testing!** Your clicking is literally the reason real customers won't hit these bugs on day one.

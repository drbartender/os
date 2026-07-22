# thumbtack-agent

Box-only Playwright agent for the Thumbtack email harvester. It is committed to the
repo for versioning but is **NOT** deployed to Render (not in `render.yaml`). It runs
only on the always-on Linux box, against a persistent logged-in Chrome profile.

## What it does

1. Polls `GET /api/admin/thumbtack/pending-harvest` on the os API (agent-secret auth).
2. For each lead, opens `https://www.thumbtack.com/pro/messaging/priceestimate/create/<negotiation_id>`
   in a persistent logged-in Chrome profile.
3. Reads the customer email (selector-free: the lone rendered email that is not the
   pro's own, read from `__NEXT_DATA__`). See `src/extract.js`.
4. Reports `POST /email-harvested` on success, `POST /harvest-failed` otherwise.

It is **read-only on Thumbtack**: it only opens the page, never submits the form. It is
human-paced (jittered delays, `DAILY_CAP`) and has a dual kill-switch (the server
returns `[]` when disabled; `HARVESTER_ENABLED=false` idles the agent).

## Auto first-reply queue (2026-07-21)

The same loop now also sends Dallas's saved `day`/`night` Quick Replies on new
leads (respond-then-ring: the server fires the lead call only after the reply
is confirmed). Flow per job: open the lead page (`REPLY_LEAD_URL_TEMPLATE`,
env-tunable), click Quick Reply, pick the template whose visible label equals
the offered `day`/`night` (case-insensitive, exact), Send, verify, then POST
`first-reply-sent`. Definitive failures (`template_not_found`,
`lead_not_found`, `quick_reply_unavailable`, `send_unverified`) POST
`first-reply-failed` and are terminal; transient trouble stays silent and the
server lease re-offers (offer-side attempts cap bounds it at 3).

Cadence: the loop ticks every `REPLY_POLL_INTERVAL_MS` (25s); the harvest poll
piggybacks every Nth tick (`src/cadence.js`, unit-tested) so its ~5-minute pace
is unchanged. Replies draw from their own `REPLY_DAILY_CAP`.

Kill switch lives server-side: `TT_AUTOREPLY_ENABLED` not `'true'` means the
offer endpoint returns `[]` and this agent idles the reply side; no local flag.

DOUBLE-SEND GUARD (three layers): (1) the negotiation id is journaled to
`first-reply-sent.journal` in the profile dir immediately BEFORE Send is
clicked, and a re-offered journaled id is resolved by re-POSTing the report,
never by driving the UI again (survives restarts and lost reports); (2)
everything from the click onward is caught, so a post-click throw reports
`send_unverified` (terminal) instead of releasing the lease; (3) post-send
reports retry 3x and only 2xx counts as delivered. Fail direction: at worst
one reply is claimed sent without landing on TT; a reply can never go out
twice. Dry-run does not even poll the reply queue (the offer GET itself
leases and burns an attempt server-side).

## Setup (on the box)

```sh
cd thumbtack-agent
npm install
npx playwright install chrome        # or rely on the system google-chrome (channel: 'chrome')
cp .env.example .env                  # then fill in THUMBTACK_AGENT_SECRET + API_BASE_URL
```

**Log in once** (over RDP, so you can see the window) into the SAME profile the agent
uses — launch Chromium via Playwright's `userDataDir = CHROME_PROFILE_DIR`, not stock
desktop Chrome, then sign into Thumbtack and close the window. (The login-persistence
spike `~/pw-login-spike/login.js` does exactly this.)

## Run

```sh
npm test               # unit-tests the pure extractor (no browser, no network)
npm run dry-run        # ONE pass: logs masked results + confirms negotiation_id == URL id, writes NOTHING
npm start              # live loop
```

Always do a `dry-run` against one real lead first to confirm the page id matches the
stored `negotiation_id` before going live.

## systemd

`systemd/thumbtack-agent.service` runs it headful under `xvfb-run` (the box is
headless). Adjust the node path / working dir for the box, then:

```sh
cp systemd/thumbtack-agent.service ~/.config/systemd/user/   # or /etc/systemd/system
systemctl --user enable --now thumbtack-agent
```

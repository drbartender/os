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

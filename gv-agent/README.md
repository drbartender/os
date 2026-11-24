# gv-agent

Box-only Playwright agent that posts a proposal's text into a Thumbtack customer's
thread through Google Voice web. It is committed to the repo for versioning but is
**NOT** deployed to Render (not in `render.yaml`). It runs only on the always-on Linux
box as a systemd user service, with its own persistent GV profile, separate from
`thumbtack-agent` so a GV hang never blocks first replies or the harvest.

Design: `docs/superpowers/specs/2026-10-17-tt-proposal-link-via-gv-design.md`
(sections 5, 6 and 10) and the plan beside it (lane `gv-sender`).

## What it does

It polls `GET /api/gv-agent/pending` every 10 s with the header `x-gv-agent-secret`.
The server leases at most one job, `{ id, phone, body, negotiation_id, prior_bodies }`, and answers
`[]` while `GV_PROPOSAL_POST_ENABLED` is off. Per job:

1. Write the current-job marker. A journaled id, the box's daily cap (25 per Chicago
   day) or a bad job (not one +1 E.164 number; not one line of at most 320 characters
   with exactly one `https://drbartender.com/proposal/<uuid>` link; no negotiation id)
   is reported without opening a browser. Every job that does open one counts against
   the daily attempt budget (60 per Chicago day, whatever the outcome); once it is
   spent, the box leases nothing until Chicago midnight and logs that once.
2. Launch the profile (headful Chrome under `xvfb-run`), open GV messages, and stop on
   any Google interstitial (`session_expired` or `challenge`).
3. If the conversation with that number is in the list (scrolling back through about
   140 conversations, never opening another), open it and read every Thumbtack notice
   in it. A repeat customer's thread holds a notice per bid, so any one naming the
   job's bid passes; notices that all name other bids are `wrong_thread`, and a thread
   with none (one we started) passes. A link to the proposal in it that the box did
   not post is `skipped_already_posted` (see A resend below).
4. Compose to the number (the new-message flow, which also appends to an existing
   conversation). Before the body goes in, check the composed view by the same paste
   rule (a thread the list scan missed shows here). Then fill the body in one go, and
   check it: the body exact, the Call panel empty, no reCAPTCHA challenge, exactly one
   enabled Send.
5. Past the 90-second job budget (counted from the lease) is `failed_preclick timeout`.
6. Ask the server's pre-click check (`POST /api/gv-agent/precheck`): a link pasted in
   the Thumbtack app is visible only to the server. A no-go never clicks.
7. Count the messages holding the token on the composed view, journal the id, click
   Send, and verify for up to 20 s: one more such message than that count AND the box
   emptied is `sent`; anything less is `clicked_unverified`.
8. Report (`POST /api/gv-agent/report`, three tries, only a 2xx counts), then clear the
   marker. A 400, 404, 409 or 422 is the server's last word on that report: it is not
   retried, the marker is cleared, and a warning naming the job id is logged.

**A resend.** `prior_bodies` lists the bodies of this proposal's earlier posts the box
worked on this conversation (newest first, repeats kept, at most 10), so an intentional
resend is not mistaken for a paste. Each message in the thread holding the token is
compared with the list, every run of whitespace read as one space: a text the thread
shows more times than the list holds it is a paste, and the job is skipped. Fewer is
fine, since an earlier post may never have landed. A missing or malformed list is
empty, so any token in the thread skips, as before resends existed. The click is
confirmed by the count before and after it, never by the token alone, because the
earlier post already shows the token. No body or prior body is ever logged.

## At most once

- **Journal before click.** The id is appended (and fsynced) to `gv-sent.journal`
  immediately before Send. A journaled id is never driven through the UI again; it is
  reported `clicked_unverified`.
- **The exception rule.** Anything that throws before the journal is written, including
  a Chrome that fails to launch, reports `failed_preclick ui_error_before_send`, and the
  server sends today's toll-free text. Anything that throws after it reports
  `clicked_unverified`, and nothing else goes out.
- **The marker.** `gv-current-job.json` is written the moment the lease arrives,
  rewritten with the outcome the moment the job settles (before its browser closes, so a
  kill during the close keeps what the job found), and cleared once the report lands. A
  marker left by a crash, or a report that never landed, is reported on the next loop
  before any new lease: with its recorded outcome, or by the exception rule when it has
  none (journaled: `clicked_unverified`; not: `failed_preclick ui_error_before_send`).
- **A hung page.** Each job's browser is closed 150 s after the lease, whatever it is
  doing, so a hang becomes a throw under the exception rule. The report lands in the
  lease window or, if late, upgrades the unknown row the sweep left.
- **A stop.** `systemctl --user stop gv-agent` between polls exits at once. A stop during
  a poll waits for the server's answer, so a lease it commits still gets its marker and
  its report; a job leased while a stop is pending is reported untried
  (`failed_preclick ui_error_before_send`) without opening a browser. A job already in
  hand does not get to finish: the stop closes its browser at once, so it ends by the
  exception rule (before the journal, the toll-free text; after it, `clicked_unverified`)
  and its report goes out before exit or, failing that, at the next start via the marker.
- **Google interstitials.** The job reports its reason, then the box posts
  `POST /api/gv-agent/status` once (the server emails once per outage) and leases
  nothing, checking every 60 s for the first hour, then every 5 minutes, until GV is
  signed in again. Rows queued meanwhile go stale on the server and get the toll-free
  text.

## Files in the profile dir

`~/.gvoice-profile` (mode 700) holds the GV session plus the box's state:
`gv-sent.journal`, `gv-current-job.json`, `gv-sent-count.json`, `gv-attempt-count.json`,
`gv-agent.lock` (the running agent's pid and start time; a lock whose process is gone, or
whose pid now belongs to another process, is taken over),
and `diag/` (a screenshot and a control dump, digits masked, on every definitive
failure; the newest 40 captures are kept, none older than 30 days, pruned at startup and
on every capture). The agent writes each of these files mode 600, and it refuses to
start (exit 1, with a log line naming the fix) while the profile dir carries any group
or other permission bit.

The whole profile is a credential for the owner's personal Google account (Playwright
stores the cookies under a fixed key, not the keyring). It stays mode 700, it stays OUT
of restic (`~/.config/restic/excludes.txt`; a restore costs one re-login), and it is
never copied anywhere.

## Setup (on the box)

```sh
cd ~/projects/os/gv-agent
npm ci
cp .env.example .env    # API_BASE_URL, GV_AGENT_SECRET (the same value as Render), DRY_RUN_PHONE
chmod 600 .env
```

The agent refuses to start (exit 1, naming the variable) while `GV_AGENT_SECRET` is
unset or empty, and its HTTP client sends nothing without it.

`API_BASE_URL` must be https; plain http is accepted only for `localhost` or
`127.0.0.1`, and anything else stops the agent at startup. A redirect from the API is
an error, never followed, so the secret header cannot ride along to another host.

The browser is the system `google-chrome` (`channel: 'chrome'`); there is nothing to
download.

## Sign GV in (by hand, never Playwright)

Google refuses automated sign-in, so the profile is signed in from a stock Chrome on
the desktop:

```sh
google-chrome --user-data-dir=$HOME/.gvoice-profile --password-store=basic --use-mock-keychain https://voice.google.com/u/0/messages
```

From a tty session rather than the desktop, prefix
`WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000` and add
`--ozone-platform=wayland`. Sign into Google Voice, decline Chrome sync, and close the
window. `--password-store=basic` makes the cookies land as `v10`, which the automated
launch can read.

## Re-login

When GV signs out or Google asks for a check, the agent reports it once and idles.
Chrome runs one process per profile, so a manual Chrome on this profile kills the
agent's browser, and while one holds the profile the agent refuses to launch onto it
(a job then reports `failed_preclick` and gets the toll-free text). Always in this
order:

```sh
systemctl --user stop gv-agent
google-chrome --user-data-dir=$HOME/.gvoice-profile --password-store=basic --use-mock-keychain https://voice.google.com/u/0/messages
# sign in, then close the window
rm -f ~/.gvoice-profile/SingletonLock ~/.gvoice-profile/SingletonSocket ~/.gvoice-profile/SingletonCookie
systemctl --user start gv-agent
```

## The call-dialer trap

The input "Enter a name or number" is the **Call panel**'s dialer, not a message
recipient. The first spike run typed a customer's number there and pressed Enter (GV's
call log showed no call placed). The sender never touches the Call panel: it types only
into "Type a name or phone number" inside the "Select recipients" region, and it checks
that the dialer is empty before Send.

## Run

```sh
npm test          # the pure modules, the per-job runner and the loop; no browser, no outside network
npm run dry-run   # three read-only stages; never clicks Send
npm start         # the live loop (the systemd unit runs this)
```

Never start it by hand while the unit runs: the agent holds `gv-agent.lock` in the
profile dir, and a second copy refuses to start (exit 1). If the agent ever refuses to
start over a leftover lock after a crash, its message says what to do.

A dry run from a shell, with the unit's display scrub:

```sh
env -u WAYLAND_DISPLAY -u DISPLAY -u XAUTHORITY -u GNOME_SETUP_DISPLAY -u XDG_SESSION_TYPE OZONE_PLATFORM=x11 \
  xvfb-run -a node src/index.js --dry-run --thread-phone "$THREAD_PHONE" --thread-token "$THREAD_TOKEN"
```

1. **API:** `GET /pending` answers 2xx `[]`. The flag must be OFF on that server: a job
   leased here is reported `failed_preclick` at once, so its toll-free text goes out.
2. **Compose:** to `DRY_RUN_PHONE` with the body "dry run, never sent": recipient
   exactly one, body exact, Call panel empty, Send enabled, then the box is cleared.
3. **Thread** (with `--thread-phone` and `--thread-token`): the thread is found, the
   known token is in it and a dummy token is not, and the count of distinct bid ids its
   notices name is printed, never the ids (none is fine for a thread we started).

The two values come in by env and are never printed. Claude Code's auto-mode check
refuses a real send from a Claude session, so any live send test is the owner's to run.

## systemd

```sh
cp systemd/gv-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now gv-agent
journalctl --user -u gv-agent -f
```

The kill switch is server-side: `GV_PROPOSAL_POST_ENABLED` off empties `/pending`.
`systemctl --user stop gv-agent` stops the box.

## Privacy

No phone number in logs beyond its last 4 digits, no message body or token in logs, and
diag file names carry only the job id and the reason. Every log line goes through one
scrub: a uuid prints as `<token>`, a phone-shaped digit run as `#`, and a Playwright
error loses its call log (which quotes the filled body) from the `Call log:` line on.

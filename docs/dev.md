# Running the OS on the dev box

How the servers and the tests actually run here. Every "how to" line below was run on 2026-10-20 from a lane worktree unless it says "from memory, not re-run on 2026-10-20". Facts that were only read (a memory, a config file) say so.

## The backend

- Start it from the repo root (or a lane root) with `node server/index.js`. It is a plain Node process with no reload: after any server-side edit, stop it and start it again. Run on 2026-10-20 on port 5002.
- `.env` sets `PORT=5000` and `NODE_ENV=development`; override the port on the command line (`PORT=5002 node server/index.js`) when 5000 is another window's. `.env` is gitignored and a lane gets it as a symlink from `npm run worktree:new`.
- Wait for these two lines before using it: `✓ Database schema initialized` then `✓ Server running on port <PORT>`. On 2026-10-20 they arrived about 30 seconds after launch. A third line, `[schedulers] disabled: NODE_ENV='development' is not 'production'`, confirms no scheduler and no real send will fire.
- `initDb()` applies `schema.sql` idempotently on every boot, so a restart also applies schema changes.
- The CORS gate: `server/index.js` allows `CLIENT_URL` (or `http://localhost:3000`) always, and any `http://localhost:<port>` or `http://<name>.localhost:<port>` only when `NODE_ENV` is exactly `development`. Settled by running it on 2026-10-20: with `.env` loaded, a client on port 3002 and `staff.localhost:3002` both got `Access-Control-Allow-Origin`; with `NODE_ENV=staging` on the command line they got a 500 and no header while `localhost:3000` still passed. So `NODE_ENV=development` on the command line is redundant when `.env` is present and necessary only when the environment overrides it; the memory that said to always pass it was describing the override case.
- The backend is Claude's process, not Dallas's (his words, 2026-05-17: it is a you thing). Start it and stop it yourself, by the pid listening on the port.

## The client

- Start it from `client/` with the flags on the command line, never in `client/.env`: `PORT=3002 HOST=localhost DANGEROUSLY_DISABLE_HOST_CHECK=true BROWSER=none REACT_APP_API_URL=http://localhost:5002 npx react-scripts start`. Run on 2026-10-20: `webpack compiled with 1 warning` after 57 seconds (the warning is a missing source map in a dependency, `html2pdf.js`, not our code), and the page answered 200 on port 3002.
- `HOST=localhost` exists because the shell's `HOST` is an empty string and `react-scripts start` crashes on it (`options.allowedHosts[0] should be a non-empty string`). `client/.env` holds only `REACT_APP_API_URL=http://localhost:5000`; override it per run as above.
- It hot-reloads. Client-only edits need no restart.
- Host contexts without code changes: `localhost:<port>` is admin, `public.localhost`, `staff.localhost` and `hiring.localhost` are the other sites (`getSiteContext()` in `client/src/App.js`). From memory, not re-run on 2026-10-20.

## The two-hour limit

- A background process started through the harness stops at the two-hour cap and must not be restarted on the same call. For a browser gate, start the API and the client inside the same foreground command as the checks and stop them in a trap at the end, by the pids listening on their ports. Never `pkill -f <pattern>` when the pattern is in your own command line: it kills your shell. From memory, not re-run on 2026-10-20.

## What a subagent cannot do

- Mint a dev session token. `scripts/dev-signin.js` is the controller's: run it by its absolute path (`node /home/drbartender/projects/os/scripts/dev-signin.js --as admin|staff|hired|applicant|client [--user <id>]`), load the printed init script in Playwright, and never hand the token to a subagent. A subagent measures on a static render or in jsdom. From memory, not re-run on 2026-10-20.
- Run `sudo`. There is no TTY under Claude, so `sudo` fails with `a terminal is required to authenticate`. Prepare the exact command and hand it to Dallas to run in a real terminal. From memory, not re-run on 2026-10-20.

## Running tests

- The server suites (`node --test <file>`) run against the shared Neon dev database, the same one every window's backend uses. Run them one at a time, never in parallel and never from a lane while another window runs a suite. From memory, not re-run on 2026-10-20.
- Read the pass count, not only the fail count. A suite without `require('dotenv').config()` dies silently (its DB tests fail `ECONNREFUSED` while the pure tests pass), so a green-looking run can be a dead suite. From memory, not re-run on 2026-10-20.
- Never `CREATE TEMP TABLE` through the pooled dev URL. The pooler runs in transaction mode and a temp table outlives the session and shadows the public table for every window. From memory, not re-run on 2026-10-20.
- The money smoke is `npm run test:smoke` (`scripts/testdb-smoke.js`): it resets the `ci-smoke` Neon branch from production, runs `initDb` against it, then runs `scripts/money-smoke-list.txt` serially. It needs the Neon key in the environment or in the key file under `~/.secrets/` that the script header names, and takes about eight minutes. Not run on 2026-10-20; read from the script header.
- Until the flip, `.husky/pre-push` runs `node scripts/push-gate.js verify`, which honours a receipt from `npm run gate` and otherwise runs the money smoke (when `server/` changed) and the exact Vercel client build (when `client/` changed). The client build has been OOM-killed beside a concurrent lane build (seen when the box had 3.2 GiB; on 2026-10-20 `free -h` reports 30 GiB). Wait for the other build rather than `--no-verify`.
- The dev-suite lock and the smoke lock arrive in steps 2 and 3 of the instruction rewrite; those plans carry the edit to this file.

## Node

- The box runs Node v24.16.0 (nvm); `.node-version` pins 26.5.0 and Render runs that. Confirmed 2026-10-20 with `node --version` and `cat .node-version`. Caveat on fixing it: the claude, codex and gemini CLIs are installed under the v24 global bin, so switching the nvm default means reinstalling all three; a per-invocation `nvm use` or `.node-version` pin in a gate worktree is the lighter fix.

## Neon

- Project `round-tooth-34649976`. Branches, confirmed read-only through the Neon MCP `list_branches` on 2026-10-20: `production` is `br-noisy-frog-ad99sa6l` (the default branch); `dev` is `br-delicate-union-adt2hvor` (what `.env` and the suites hit); `ci-smoke` is `br-twilight-surf-adf8eghx` (the smoke gate's throwaway, reset from production). Branch ids change if a branch is recreated; the names are the stable handles.
- A prod data fix goes through `run_sql` on the production branch as a guarded `DO $$ ... $$` block: assert the pre-state, check every write's row count, raise on any mismatch so the block rolls back, verify with a follow-up SELECT, and only after Dallas approved the specific effect. The connection string is not obtainable from this box. From memory, not re-run on 2026-10-20.

## Render

- The production service is `os` (`srv-d6rl4dma2pns73fpuetg`), a web service created in the dashboard on 2026-03-16 and not managed by any Blueprint. Read from `render services -o json` on 2026-10-20: repo `drbartender/os`, branch `main`, auto-deploy on every commit, build command `npm install`, start command `npm run start`, health check path empty, plan starter, region oregon, one instance. The old `render.yaml` named a different service with a different start command and health check path and never governed this one; it was removed on 2026-10-20.
- Two dashboard steps are owed before the flip (spec 2026-10-19, section 8): a build filter that ignores docs-only paths, and the Health Check Path set to `/api/health`.
- The rollback lever is in the dashboard: the service's Deploys tab, "Rollback" on a previous deploy. The CLI (`~/.local/bin/render`, logged in since 2026-10-19) can list services and deploys and restart, but cannot read or set environment variables; a Render env change is Dallas's step, so give him the exact name and value.

## The win-share clone

- `~/win-share/os` is a July 2026 copy of the repo from the Windows machine (last commit 2026-07-08, confirmed 2026-10-20). It is not a source of rules or current code; the real checkout is `~/projects/os` and its lanes under `~/projects/worktrees/`.

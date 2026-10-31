#!/usr/bin/env bash
# board-write.sh: concurrency-safe writer for docs/build-board.md.
#
# Callers: with the flip marker present a board write runs a real ship and
# takes minutes, not seconds (about ten when other windows' unpushed money
# commits ride along and the gate runs the money smoke, longer while another
# ship holds the ship lock), so a caller sets its timeout to match, the
# longest its runner allows, or runs the writer in the background. Never cut
# one short: a write stopped mid-ship leaves the push outcome unknown (npm
# run ship completes it). A write run again for a line already under its
# section writes nothing and says so.
#
# Many Claude windows share one checkout (os), its index included, so a
# naive write would lose a line or ride in another window's commit. This
# helper does, once per call, in order:
#
#   1. main in the primary checkout: from a lane worktree, a detached HEAD
#      or another branch it refuses with a BLOCKED line and exit 1 before
#      anything else (it would commit the line off main).
#   2. the board lock: flock on <git-common-dir>/drb-board.lock, held from
#      here through the commit and released before the push (the ship lock
#      serializes that), so two writes in one checkout run one at a time and
#      the second reads the board the first committed. A wait past
#      BOARD_WRITE_LOCK_WAIT seconds (default 30) refuses with a BLOCKED line
#      and exit 1, nothing fetched, written or committed.
#   3. the clean-checkout refusal: a staged change or an edited tracked file
#      in this checkout refuses with a BLOCKED line naming it and exit 1,
#      before anything is fetched, written or committed, so another window's
#      work in progress never rides in a board commit or stops the
#      fast-forward half way. An untracked file is not a refusal.
#   4. the sync, fast-forward only: git fetch origin main, then git merge
#      --ff-only to the origin/main sha the fetch left when main is behind it,
#      so the write lands on top of any peer's (main equal to it or ahead of
#      it needs nothing). When main cannot fast-forward (it holds commits
#      origin/main does not while origin/main holds commits it does not), it
#      refuses with a BLOCKED line and exit 1, writing and committing nothing:
#      replaying main's unpushed commits onto origin/main is the owner's call
#      under the push-failure rule, never the writer's. A fetch that fails, or
#      a fast-forward git stops, is the same exit 1 with nothing written; the
#      fast-forward waits out another git's index.lock first, and one stopped
#      by an uncommitted file says that file is another window's work in
#      progress, to be left alone. The writer never pulls, rebases, resets or
#      force-moves the shared checkout.
#   5. an atomic temp-file + rename write of the board, unless the exact
#      line is already under its section: then nothing is written or
#      committed and the writer says so, exit 0, so a re-run after a write
#      that was cut short or refused never commits the line twice. A board
#      with no heading for the section is exit 3, nothing written.
#   6. a git commit --only of the board file alone, from its working copy:
#      the board is never staged in the shared index, so another window's
#      plain commit never carries the board line, and a change another
#      window stages while the writer runs stays staged and never rides in a
#      board commit. The commit waits out another git's index.lock for up to
#      BOARD_WRITE_LOCK_WAIT seconds; a commit that still fails (the lock
#      held past the wait, a hook's refusal, main moved by another window
#      during it), or a write stopped by a signal before its commit landed,
#      puts the board file back at HEAD's content without touching the
#      shared index and ends with a BLOCKED line and exit 1.
#   7. the push, the flip marker's call (<git-common-dir>/drb-flip.json,
#      written at the flip of 2026-10-30), read after the commit by one node
#      call against scripts/lib/markers.js (flipState, the branch rule every
#      push path shares):
#
#   present: node scripts/ship.js --foreground, the one push command, runs
#     once per board write, with no guard of its own (spec 4.5): the range
#     gate, the receipt check and the markers inside ship decide what ships,
#     so another window's reviewed commits ride along and anything ship
#     refuses keeps the board commit local.
#     ship's exit code and its last stdout line (ship: result <state>
#     <text>) decide the ending: ok or pushed-elsewhere is success; origin/main
#     moved during the write by a push from outside this checkout (a push
#     turned away with git's bracketed fetch first or non-fast-forward, or
#     ship's range check refusing because origin/main is not an ancestor of
#     main, when it moved while ship waited on its lock) stops and reports
#     under the project's git-safety invariant (never auto-pull, auto-rebase
#     or force-push): nothing is pulled, rebased or shipped again, the board
#     commit stays local, and main's unpushed commits are replayed onto
#     origin/main by hand, the owner's call (never a merge: ship refuses a
#     merge commit, since main holds squashes only), then npm run ship runs;
#     until then a board write refuses at the sync, since main cannot
#     fast-forward, so a re-run never commits the line twice; an outcome ship
#     cannot vouch for (exit 2, a ship killed by a signal, or one that
#     ended without its result after its push began) is reported as
#     committed with the push outcome unknown; any other refusal or
#     failure leaves the board commit local with ship's reason. Once the
#     board commit exists, this script never ends with git's exit code.
#     Never forced and never detached: the writer waits for the whole ship
#     (Callers, above).
#   absent: no push. The flip happened, so a missing marker was lost, and
#     the board commit stays local under the refusal the pre-push hook
#     prints for it (push-gate.js missingMarkerLine, ending with the restore
#     recipe of scripts/lib/markers.js), or, when push-gate.js cannot be
#     loaded, a fixed line ending with that recipe through markers.js
#     flipRestore (naming flipRestore when that fails too).
#   unreadable, or a state that cannot be read at all: no push. The flip
#     marker's BLOCKED line (standing().flip) is printed and the board commit
#     stays local.
#
# History: before the flip the writer opened with a bare git pull --rebase of
# the shared checkout, and with the marker absent it pushed through a guarded
# git push (skipped unless the board commit was the only unpushed commit)
# inside a bounded retry loop that pulled and appended again after a rejected
# push, so a retry could commit the line twice. Lane legacy-removal
# (2026-10-30) retired the guarded push, its guard and the retry loop with the
# legacy push path; lane board-writer (2026-10-30) replaced the pull with the
# fetch and the fast-forward, and added the main check, the board lock, the
# clean-checkout refusal, the presence check and the commit by --only with
# the board put back on a failure, so the writer commits one line per write,
# never two, and nothing but a fast-forward moves main.
#
# Before any write it enforces a DENYLIST: the board carries titles and
# paths only, so a line that matches any shape in scripts/lib/piiShapes.js
# (an email, a phone number, a token or key, a UUID, a Stripe id, an SSN, a
# routing or tax id) is rejected outright (non-zero, clear message, no write).
#
# It operates on the current working directory's repo, so tests can run it
# against a throwaway repo + local bare remote. ship.js, push-gate.js and the
# node modules they call are found beside this script, the way the denylist
# finds piiShapes.js, so a throwaway that carries its own copy of scripts/
# runs its own ship, gate and markers.
#
# Usage:
#   board-write.sh <section> <line>
#       Append <line> under the "## <section>" heading in docs/build-board.md.
#       <section> is one of: "Ready to build", "In flight", "Recently shipped".
#   board-write.sh --check <line>
#       Run ONLY the denylist check on <line>. Exit 0 = clean, non-zero = blocked.
#       (Discrete, testable step. No repo access, no write.)
#
# Exit: 0 once the board commit exists (pushed, or kept local, as its line
# says) or when the line is already under its section; 1 for a refusal
# before the board is written (the denylist, the board lock, the clean
# checkout, the sync), a board write that failed, or a board commit that
# failed and was put back; 2 for a usage error or an unknown section; 3 when
# the board file is missing or has no heading for the section; any other
# failure before the board is written ends with the failing command's own
# code.

set -euo pipefail

BOARD_PATH="docs/build-board.md"

# Seconds a write waits for another board write's lock (and, from the
# commit, for another git's index.lock): BOARD_WRITE_LOCK_WAIT, default 30.
LOCK_WAIT=30
case "${BOARD_WRITE_LOCK_WAIT-}" in
  '' | *[!0-9]*) ;;
  *) LOCK_WAIT=$((10#$BOARD_WRITE_LOCK_WAIT)) ;;
esac

# --- Denylist (discrete, testable step) -------------------------------------
# Returns 0 (clean) or 1 (blocked). On block, prints the reason to stderr.
# Patterns are deliberately broad: the board must never record PII or ids.
denylist_check() {
  local content="$1"
  # The shapes live in ONE module shared with the static pre-step and the
  # second-opinion mask (scripts/lib/piiShapes.js, instruction rewrite step 2).
  # --check is the strict mode: every shape blocks, the business lines included,
  # because the board carries titles and paths only. It prints the BLOCKED line
  # to stderr itself and exits 1 on a hit, 0 when clean.
  node "$(dirname "$0")/lib/piiShapes.js" --check "$content"
}

# --- main in the primary checkout only (header step 1) ----------------------
# The primary worktree: its top is the parent of the git common dir.
require_main() {
  local head="" top="" common="" primary="" here=""
  head=$(git symbolic-ref -q HEAD 2>/dev/null) || head=""
  top=$(git rev-parse --show-toplevel 2>/dev/null) || top=""
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || common=""
  if [ -n "$top" ] && [ -n "$common" ] && [ "${common##*/}" = ".git" ]; then
    top=$(cd "$top" && pwd -P) || top=""
    primary=$(cd "${common%/*}" && pwd -P) || primary=""
  fi
  if [ "$head" = "refs/heads/main" ] && [ -n "$top" ] && [ "$top" = "$primary" ]; then
    return 0
  fi
  if [ -z "$head" ]; then
    here="detached"
  else
    here="on ${head#refs/heads/}"
  fi
  echo "BLOCKED: the board writer runs only in the primary checkout (os) with main checked out; here HEAD is ${here} in ${top:-$(pwd -P)}. Nothing was written or committed." >&2
  exit 1
}

# --- One writer at a time (header step 2) -----------------------------------
# The board lock is held through fd 9; the kernel drops it when this process
# exits. git runs with fd 9 closed (git_wait, the fetch), so a background
# auto-maintenance run git starts never holds the lock past the write.
take_board_lock() {
  local common="" lock=""
  if ! common=$(git rev-parse --path-format=absolute --git-common-dir) || [ -z "$common" ]; then
    echo "BLOCKED: the git common dir could not be read, so the board lock could not be taken. Nothing was written or committed." >&2
    exit 1
  fi
  lock="${common}/drb-board.lock"
  if ! command -v flock >/dev/null 2>&1 || ! exec 9>>"$lock"; then
    echo "BLOCKED: the board lock (${lock}) could not be opened or flock is missing, so this write refused before it fetched or touched the board. Nothing was written or committed." >&2
    exit 1
  fi
  if ! flock -w "$LOCK_WAIT" 9; then
    echo "BLOCKED: another board write held the board lock (${lock}) past the wait of ${LOCK_WAIT} second(s), so this write refused before it fetched or touched the board. Nothing was written or committed; write the board again once that write is done." >&2
    exit 1
  fi
}

release_board_lock() {
  flock -u 9 2>/dev/null || true
  exec 9>&-
}

# --- git under another git's index.lock -------------------------------------
# git "$@" with fd 9 closed, its stdout and stderr in GIT_OUT, again every
# 100 ms for up to LOCK_WAIT seconds while another git holds index.lock (a
# commit holds it for its whole hook), as merge-lane.sh waits. Returns git's
# code; GIT_LOCKED is 1 when the wait ran out. GIT_OUT naming a held lock is
# never printed: git's advice to remove it would break a live commit.
GIT_OUT=""
GIT_LOCKED=0
LOCK_HELD="another git held index.lock past the wait of"
git_wait() {
  local code=0 tries=0
  GIT_LOCKED=0
  while :; do
    code=0
    GIT_OUT=$(git "$@" 2>&1 9>&-) || code=$?
    if [ "$code" -eq 0 ]; then
      return 0
    fi
    case "$GIT_OUT" in
      *index.lock*) ;;
      *) return "$code" ;;
    esac
    if [ "$tries" -ge $((LOCK_WAIT * 10)) ]; then
      GIT_LOCKED=1
      return "$code"
    fi
    tries=$((tries + 1))
    sleep 0.1
  done
}

# --- A clean checkout before any write (header step 3) ----------------------
# The first five paths and the count are named. git status --no-optional-locks
# keeps its index refresh in memory, so the shared index is never written.
require_clean() {
  local changed="" count="" names=""
  if ! changed=$(git --no-optional-locks status --porcelain=v1 --untracked-files=no --no-renames --ignore-submodules=none); then
    echo "BLOCKED: git status failed in this checkout, so the board writer refuses before it touches the board. Nothing was written or committed." >&2
    exit 1
  fi
  if [ -z "$changed" ]; then
    return 0
  fi
  count=$(printf '%s\n' "$changed" | awk 'END { print NR }')
  names=$(printf '%s\n' "$changed" | awk 'NR <= 5 { printf "%s%s", (NR > 1 ? ", " : ""), substr($0, 4) } END { if (NR > 5) printf ", and %d more", NR - 5 }')
  echo "BLOCKED: this checkout has a staged change or an edited tracked file (${count}: ${names}), so the board writer refuses before it fetches or touches the board: another window's work in progress never rides in a board commit or stops the fast-forward. Nothing was written or committed; write the board again once it is committed." >&2
  exit 1
}

# --- The sync, fast-forward only (header step 4) ----------------------------
# The merge goes to the sha the checks read, so it does what they judged.
refuse_sync() {
  echo "BLOCKED: $1" >&2
  exit 1
}

sync_main() {
  local origin="" code=0 ahead="" behind=""
  if ! git fetch --quiet origin main 9>&-; then
    refuse_sync "git fetch origin main failed, so main could not be synced before the write. Nothing was written or committed; write the board again once origin answers."
  fi
  if ! origin=$(git rev-parse --verify --quiet 'refs/remotes/origin/main^{commit}'); then
    refuse_sync "origin/main could not be read after the fetch. Nothing was written or committed."
  fi
  # main equal to origin/main or ahead of it (unpushed commits on an origin
  # that did not move): nothing to fast-forward.
  if git merge-base --is-ancestor "$origin" HEAD; then
    return 0
  fi
  git merge-base --is-ancestor HEAD "$origin" || code=$?
  if [ "$code" -eq 1 ]; then
    ahead=$(git rev-list --count "${origin}..HEAD") || ahead="some"
    behind=$(git rev-list --count "HEAD..${origin}") || behind="some"
    refuse_sync "main cannot fast-forward to origin/main: main holds ${ahead} commit(s) origin/main does not, and origin/main holds ${behind} commit(s) main does not. Nothing was written or committed. Stop and ask: replaying main's unpushed commits onto origin/main is the owner's call under the push-failure rule (never a merge, which ship refuses since main holds squashes only, an auto-pull or a force); after it, run npm run ship, then write the board again unless one of those commits already holds this line."
  elif [ "$code" -ne 0 ]; then
    refuse_sync "main and origin/main could not be compared (git merge-base exited ${code}). Nothing was written or committed."
  fi
  if git_wait merge --ff-only --quiet "$origin"; then
    if [ -n "$GIT_OUT" ]; then printf '%s\n' "$GIT_OUT" >&2; fi
    return 0
  fi
  if [ "$GIT_LOCKED" -eq 1 ]; then
    refuse_sync "${LOCK_HELD} ${LOCK_WAIT} second(s), so main could not be fast-forwarded; leave the lock alone, it is another window's live git. Nothing was written or committed; write the board again once that git is done."
  fi
  printf '%s\n' "$GIT_OUT" >&2
  case "$GIT_OUT" in
    *"would be overwritten"*)
      refuse_sync "git stopped the fast-forward of main to origin/main: a file it names above is uncommitted in this checkout, another window's work in progress; leave it alone (never commit, stash or remove it for that window). The board was not written and nothing was committed; write the board again once that window has committed it."
      ;;
  esac
  refuse_sync "git stopped the fast-forward of main to origin/main (its reason is above). The board was not written and nothing was committed."
}

# --- Atomic write (header step 5) -------------------------------------------
# A temp file in the same dir renamed over the board, so a reader never sees
# half a file; awk puts the line just before the heading after the section
# (or at the end). Returns 0 once written; 10 (nothing written) when the
# exact line is already under the section; 11 (nothing written) when the
# board has no such heading; 1 when the temp file or the rename fails.
atomic_append() {
  local section="$1" line="$2" board="$3" dir="" tmp="" rc=0
  dir=$(dirname "$board")
  tmp=$(mktemp "${dir}/.board-write.XXXXXX") || return 1

  awk -v section="## ${section}" -v newline="$line" '
    BEGIN { in_section = 0; inserted = 0; found = 0; present = 0 }
    # Entering the target section.
    $0 == section { print; in_section = 1; found = 1; next }
    # The exact line already under the target section.
    in_section && $0 == newline { present = 1 }
    # A new heading while inside the target section: flush our line first.
    in_section && /^## / && !inserted {
      print newline
      inserted = 1
      in_section = 0
    }
    { print }
    END {
      if (in_section && !inserted) { print newline }
      if (present) exit 10
      if (!found) exit 11
    }
  ' "$board" >"$tmp" || rc=$?

  if [ "$rc" -ne 0 ]; then
    rm -f -- "$tmp"
    return "$rc"
  fi
  mv -f "$tmp" "$board" || { rm -f -- "$tmp"; return 1; }
}

# --- The board commit, or the board put back (header step 6) ----------------
# WRITTEN is the blob the append wrote. On failure commit_board sets
# COMMIT_WHY and prints git's output (the hook's among it) as git_wait allows.
WRITTEN=""
COMMIT_WHY=""
commit_board() {
  local code=0
  git_wait commit --quiet --only -m "board: update $1" -- "$BOARD_PATH" || code=$?
  if [ "$code" -eq 0 ]; then
    if [ -n "$GIT_OUT" ]; then printf '%s\n' "$GIT_OUT" >&2; fi
    return 0
  fi
  if [ "$GIT_LOCKED" -eq 1 ]; then
    COMMIT_WHY="${LOCK_HELD} ${LOCK_WAIT} second(s); leave the lock alone, it is another window's live git"
    return 1
  fi
  printf '%s\n' "$GIT_OUT" >&2
  case "$GIT_OUT" in
    *"cannot lock ref 'HEAD'"*) COMMIT_WHY="main moved while the board commit ran (another window committed during it)" ;;
    *) COMMIT_WHY="git commit exited ${code} (the hook's or git's reason is above)" ;;
  esac
  return 1
}

# The board goes back to the shared index's copy (HEAD's: the writer never
# stages the board, and git rolls its partial-commit index back), by temp file
# and rename, never through the index; a board edited since is left alone.
put_board_back() {
  local why="$1" now="" tmp=""
  local fate="the board file was left as it is (it changed after this write, or could not be put back): read git status before writing again"
  now=$(git hash-object -- "$BOARD_PATH" 2>/dev/null) || now=""
  if [ -n "$WRITTEN" ] && [ "$now" = "$WRITTEN" ] && tmp=$(mktemp "$(dirname "$BOARD_PATH")/.board-write.XXXXXX"); then
    if git cat-file blob ":0:${BOARD_PATH}" > "$tmp" && mv -f "$tmp" "$BOARD_PATH"; then
      fate="the board file is back at HEAD's content"
    else
      rm -f -- "$tmp"
    fi
  fi
  echo "BLOCKED: the board commit failed: ${why}. This write committed nothing, and ${fate}. Write the board again once the cause is gone." >&2
  exit 1
}

# A signal (a caller's timeout, Ctrl-C) between the append and the end of
# the commit puts the board back, unless the commit landed; trapped only then.
STOP_SECTION=""
stopped() {
  trap - TERM INT HUP
  if [ -n "$WRITTEN" ] && [ "$(git rev-parse --verify --quiet "HEAD:${BOARD_PATH}" 2>/dev/null || true)" = "$WRITTEN" ]; then
    echo "Board updated under '${STOP_SECTION}' and committed LOCALLY; the write was stopped by a signal before its push. Run npm run ship to push it." >&2
    exit 1
  fi
  put_board_back "the write was stopped by a signal before its commit landed"
}

# --- The flip state ---------------------------------------------------------
# Prints one of absent, present or unreadable: one node call against
# scripts/lib/markers.js, passed by path from this script's directory the way
# the denylist passes piiShapes.js, and resolved to an absolute path before
# the require. flipState reads the flip marker of the cwd's repo. A node call
# that fails prints nothing on stdout (its error goes to stderr), and the
# caller reads anything but the three words as a state it cannot read.
flip_state() {
  node -e 'process.stdout.write(require(require("path").resolve(process.argv[1])).flipState({ cwd: process.cwd() }).state)' "$(dirname "$0")/lib/markers.js" || true
}

# standing().flip, the BLOCKED line every push path prints for an unreadable
# flip marker, or nothing. The same one node call.
flip_line() {
  node -e 'process.stdout.write(require(require("path").resolve(process.argv[1])).standing({ cwd: process.cwd() }).flip || "")' "$(dirname "$0")/lib/markers.js" || true
}

# The pre-push hook's refusal for a missing flip marker (push-gate.js
# missingMarkerLine, built on scripts/lib/markers.js, the one copy of the
# flip's date and sha), for the marker path markers.js names: the same one
# node call, or nothing when push-gate.js or markers.js cannot be loaded.
missing_line() {
  node -e 'const p = require("path"); const dir = p.resolve(process.argv[1]); process.stdout.write(require(p.join(dir, "push-gate.js")).missingMarkerLine(require(p.join(dir, "lib", "markers.js")).flipState({ cwd: process.cwd() }).path))' "$(dirname "$0")" || true
}

# markers.js flipRestore for the marker path flipState names (the restore
# recipe alone: the path, the full flip sha, then npm run ship), for the fixed
# line when push-gate.js cannot be loaded: the same one node call, or nothing.
restore_line() {
  node -e 'const M = require(require("path").resolve(process.argv[1])); process.stdout.write(M.flipRestore(M.flipState({ cwd: process.cwd() }).path))' "$(dirname "$0")/lib/markers.js" || true
}

# --- No push: the flip marker is missing, unreadable, or cannot be read -----
# Fails closed: the board commit stays local, in the LOCALLY wording, with
# the hook's line for a missing marker, the flip marker's BLOCKED line for an
# unreadable one, or a line saying the state could not be read.
keep_local_no_flip() {
  local section="$1"
  local flip="$2"
  local blocker=""
  if [ "$flip" = "unreadable" ]; then
    blocker=$(flip_line)
  elif [ "$flip" = "absent" ]; then
    blocker=$(missing_line)
    if [ -z "$blocker" ]; then
      local recipe
      recipe=$(restore_line)
      if [ -n "$recipe" ]; then
        blocker="BLOCKED: the flip marker is missing; the flip happened and the legacy push path is gone, so every push refuses until it is restored (push-gate.js could not be loaded): ${recipe}"
      else
        blocker="BLOCKED: the flip marker is missing; the flip happened and the legacy push path is gone, so every push refuses until it is restored (push-gate.js could not be loaded; markers.js flipRestore holds the recipe)"
      fi
    fi
  fi
  echo "Board updated under '${section}' and committed LOCALLY, not pushed." >&2
  if [ -n "$blocker" ]; then
    echo "  ${blocker}" >&2
  else
    echo "  Could not read the flip state from $(dirname "$0")/lib/markers.js, so refusing to push." >&2
  fi
  echo "  The board rides the next real push. Nothing is lost." >&2
  exit 0
}

# --- The push after the flip ------------------------------------------------
# ship.js --foreground from the repo root (this cwd: the board path is
# relative to it), once per board write and attached, since the writer waits
# for the result. ship's stdout passes through and is kept in a temp file for
# the ending; its stderr passes through untouched. Every ending exits here,
# and none with git's (or a tool's) exit code: the board commit exists by
# now, so a failure ends with a LOCALLY line, or with the unknown line once
# ship has run, never with a bare error.
SHIP_OUT=""
drop_ship_out() {
  if [ -n "$SHIP_OUT" ]; then
    rm -f -- "$SHIP_OUT" || true
  fi
}

# The board commit stays local: the LOCALLY line with its reason, exit 0.
keep_local() {
  echo "Board updated under '$1' and committed LOCALLY, not pushed: $2. It rides the next ship." >&2
  exit 0
}

# ship ran and its outcome cannot be vouched for: the unknown line, exit 0.
push_unknown() {
  echo "Board updated under '$1' and committed; the push outcome is unknown, run npm run ship again to complete it." >&2
  exit 0
}

ship_board() {
  local section="$1" code=0 last="" rest="" state="" text="" reason=""
  local started=0 pushing=0 behind=0 moved=0
  trap drop_ship_out EXIT
  if ! SHIP_OUT=$(mktemp "${TMPDIR:-/tmp}/board-write-ship.XXXXXX"); then
    SHIP_OUT=""
    keep_local "$section" "no temp file could be made for ship's output, so ship did not run"
  fi
  node "$(dirname "$0")/ship.js" --foreground | tee "$SHIP_OUT" || code=${PIPESTATUS[0]}
  # ship has run: a result that cannot be read is an outcome unknown.
  if ! last=$(awk 'NF { line = $0 } END { print line }' "$SHIP_OUT"); then
    drop_ship_out
    push_unknown "$section"
  fi
  # ship's stage lines: start once it opened HEAD's record, push once its
  # push stamp was written and the push was about to run.
  if grep -q '^ship: start ' "$SHIP_OUT"; then
    started=1
  fi
  if grep -q '^ship: push ' "$SHIP_OUT"; then
    pushing=1
  fi
  # ship's range check found origin/main off main's line (it moved while ship
  # waited on its lock, before its own fetch): its refusal lists the problem.
  if grep -q 'is not an ancestor of .*; the range is not a push onto it' "$SHIP_OUT"; then
    behind=1
  fi
  drop_ship_out
  SHIP_OUT=""
  case "$last" in
    "ship: result "*)
      rest="${last#"ship: result "}"
      state="${rest%%" "*}"
      text="${rest#"$state"}"
      text="${text#" "}"
      ;;
  esac

  # ok or pushed-elsewhere: the board commit is on origin/main.
  if [ "$code" -eq 0 ] && { [ "$state" = "ok" ] || [ "$state" = "pushed-elsewhere" ]; }; then
    echo "Board updated under '${section}'."
    exit 0
  fi

  # origin/main moved during this write, from outside this checkout (every
  # push from it goes through ship under its lock): the remote turned the
  # push away (git's bracketed reason, which ship's result text carries,
  # matched by its words alone, never by a sha), or ship's range check
  # refused because origin/main moved while ship waited on its lock. Under the
  # project's git-safety invariant a rejected push stops and reports: nothing
  # is pulled, rebased or shipped again (an automatic rebase of the shared
  # checkout can clobber another window's work), and the board commit stays
  # local until main's unpushed commits are replayed onto origin/main by
  # hand, so this line names that replay instead of saying the commit rides
  # the next ship.
  if [ "$code" -eq 1 ] && [ "$state" = "failed" ]; then
    case "$text" in
      *"(fetch first)"* | *"(non-fast-forward)"*) moved=1 ;;
    esac
  fi
  if [ "$code" -eq 1 ] && [ "$state" = "refused" ] && [ "$behind" -eq 1 ]; then
    moved=1
  fi
  if [ "$moved" -eq 1 ]; then
    echo "Board updated under '${section}' and committed LOCALLY, not pushed: origin/main moved during this write (a push from outside this checkout). Stop and ask: main's unpushed commits have to be replayed onto origin/main by hand, the owner's call under the push-failure rule (never a merge, which ship refuses since main holds squashes only, an auto-pull or a force), then run npm run ship; until then a board write refuses, since main cannot fast-forward." >&2
    exit 0
  fi

  # Not pushed, for certain: ship refused or failed with its result line
  # (exit 1), or ended with exit 1 and no result line before any push stage:
  # a refusal before its flow (its own line is the reason) or a run that
  # ended after opening its record (the last line may be a child's, so it
  # is not quoted). Anything else may have pushed: exit 2, an unknown
  # result, a ship killed by a signal, a result that disagrees with the exit
  # code, or no result line after the push stage began.
  if [ "$code" -eq 1 ] && { [ "$state" = "refused" ] || [ "$state" = "failed" ]; }; then
    reason="$text"
  elif [ "$code" -eq 1 ] && [ -z "$state" ] && [ "$pushing" -eq 0 ]; then
    if [ "$started" -eq 1 ]; then
      reason="ship's run ended without a result, before its push (exit ${code})"
    else
      reason="${last#"ship: "}"
    fi
  else
    push_unknown "$section"
  fi
  if [ -z "$reason" ]; then
    reason="ship exited ${code} and printed no reason"
  fi
  keep_local "$section" "$reason"
}

# --- Main -------------------------------------------------------------------
main() {
  # Discrete denylist-only mode for tests / callers.
  if [ "${1:-}" = "--check" ]; then
    denylist_check "${2:-}"
    exit $?
  fi

  if [ "$#" -ne 2 ]; then
    echo "usage: board-write.sh <section> <line>  |  board-write.sh --check <line>" >&2
    exit 2
  fi

  local section="$1"
  local line="$2"

  case "$section" in
    "Ready to build"|"In flight"|"Recently shipped") ;;
    *)
      echo "BLOCKED: unknown section '$section'. Use one of: Ready to build, In flight, Recently shipped." >&2
      exit 2
      ;;
  esac

  # main in the primary checkout, before anything else.
  require_main

  # Denylist FIRST, before any repo mutation. No write on reject.
  if ! denylist_check "$line"; then
    exit 1
  fi

  # The board lock, a clean checkout, then the sync, fast-forward only (see
  # the header); each exits on a refusal, before the board is touched.
  take_board_lock
  require_clean
  sync_main

  if [ ! -f "$BOARD_PATH" ]; then
    echo "ERROR: $BOARD_PATH not found in repo." >&2
    exit 3
  fi

  local appended=0
  atomic_append "$section" "$line" "$BOARD_PATH" || appended=$?
  if [ "$appended" -eq 10 ]; then
    echo "No change to board (line already present under '${section}'); nothing was written. If the commit that holds it has not reached origin yet, npm run ship carries it."
    exit 0
  elif [ "$appended" -eq 11 ]; then
    echo "ERROR: ${BOARD_PATH} has no '## ${section}' heading, so the line was not written; nothing was committed." >&2
    exit 3
  elif [ "$appended" -ne 0 ]; then
    echo "ERROR: the board could not be written (its temp file or rename failed, exit ${appended}); nothing was committed." >&2
    exit 1
  fi

  # A backstop: the append above wrote the line or exited. git commit --only
  # builds the commit from HEAD plus the board's working copy in a temporary
  # index, runs the hooks there, moves HEAD by compare-and-swap, and writes
  # the board's entry into the shared index only on success, under
  # index.lock (header step 6).
  if git diff --quiet -- "$BOARD_PATH"; then
    echo "No change to board (the write left it as it was); nothing was committed."
    exit 0
  fi
  STOP_SECTION="$section"
  trap stopped TERM INT HUP
  WRITTEN=$(git hash-object -- "$BOARD_PATH") || WRITTEN=""
  # A commit that failed, unless HEAD holds the board as written after all
  # (git failing after its ref update), puts the board back and exits.
  if ! commit_board "$section"; then
    if [ -z "$WRITTEN" ] || [ "$(git rev-parse --verify --quiet "HEAD:${BOARD_PATH}" || true)" != "$WRITTEN" ]; then
      put_board_back "$COMMIT_WHY"
    fi
    echo "  git reported a failure after the board commit landed (${COMMIT_WHY}); read git status." >&2
  fi
  trap - TERM INT HUP
  # The board commit exists: the next write may read the board now. The
  # push below is the ship lock's to serialize.
  release_board_lock

  # The flip marker decides the push (see the header). present: ship.js
  # --foreground. absent, unreadable, or a state that cannot be read: no
  # push. Both functions exit.
  local flip
  flip=$(flip_state)
  if [ "$flip" = "present" ]; then
    ship_board "$section"
  fi
  keep_local_no_flip "$section" "$flip"
}

main "$@"

#!/usr/bin/env bash
set -euo pipefail

# board-write.sh: concurrency-safe writer for docs/build-board.md.
#
# Many Claude windows touch the board, so a naive write would lost-update.
# This helper does, per attempt: git pull --rebase, an atomic temp-file +
# rename write, a git commit of the board file alone (the no-change check and
# the commit both name it, so a change another window has staged in the
# shared index stays staged and never rides in a board commit), then the
# push. Which push is the flip marker's (<git-common-dir>/drb-flip.json,
# written by step 5 of the instruction rewrite), read after the commit by one
# node call against scripts/lib/markers.js (flipState, the branch rule every
# push path shares):
#
#   absent: today's GUARDED git push. The push is fast-forward only (git
#     rejects a non-fast-forward by default and --force is never passed), and
#     it is SKIPPED ENTIRELY unless the board commit is the only unpushed
#     commit on main (see the guard before it, and why: on 2026-08-14 and
#     2026-08-19 a board push nearly deployed uncued work). On a rejected push
#     (another window won the race) it retries the whole loop a bounded
#     number of times, rebasing each pass so both lines survive, then
#     escalates. Before the flip it never force-pushes, never pushes anyone
#     else's work, and never loops forever.
#   present: node scripts/ship.js --foreground, the one push command, runs
#     once per board write in place of the guarded push, and the guard is
#     retired (spec 4.5): the range gate, the receipt check and the markers
#     inside ship decide what ships, so another window's reviewed commits
#     ride along and anything ship refuses keeps the board commit local.
#     ship's exit code and its last stdout line (ship: result <state>
#     <text>) decide the ending: ok or pushed-elsewhere is success; a push
#     turned away because origin/main moved (git's bracketed fetch first or
#     non-fast-forward, a push from outside this checkout) stops and reports
#     under the project's git-safety invariant (never auto-pull, auto-rebase
#     or force-push): nothing is pulled, rebased or shipped again, the board
#     commit stays local, and the person, asked first, rebases main onto
#     origin/main by hand (never a merge: ship refuses a merge commit, since
#     main holds squashes only), then runs npm run ship; an outcome ship
#     cannot vouch for (exit 2, a ship killed by a signal, or one that
#     ended without its result after its push began) is reported as
#     committed with the push outcome unknown; any other refusal or
#     failure leaves the board commit local with ship's reason. Once the
#     board commit exists, this branch never ends with git's exit code.
#     Never forced and never detached. A board write here waits for a
#     whole ship (seconds for a docs-only range, about ten minutes when
#     other windows' unpushed money commits ride along and the gate runs
#     the money smoke, longer while another ship holds the ship lock), so a
#     session runs the writer with a long enough timeout or in the
#     background.
#   unreadable, or a state that cannot be read at all: no push. The flip
#     marker's BLOCKED line (standing().flip) is printed and the board commit
#     stays local.
#
# Before any write it enforces a DENYLIST: the board carries titles and
# paths only, so a line that matches any shape in scripts/lib/piiShapes.js
# (an email, a phone number, a token or key, a UUID, a Stripe id, an SSN, a
# routing or tax id) is rejected outright (non-zero, clear message, no write).
#
# It operates on the current working directory's repo, so tests can run it
# against a throwaway repo + local bare remote. ship.js and the node modules
# it calls are found beside this script, the way the denylist finds
# piiShapes.js, so a throwaway that carries its own copy of scripts/ runs its
# own ship, gate and markers.
#
# Usage:
#   board-write.sh <section> <line>
#       Append <line> under the "## <section>" heading in docs/build-board.md.
#       <section> is one of: "Ready to build", "In flight", "Recently shipped".
#   board-write.sh --check <line>
#       Run ONLY the denylist check on <line>. Exit 0 = clean, non-zero = blocked.
#       (Discrete, testable step. No repo access, no write.)

BOARD_PATH="docs/build-board.md"
MAX_RETRIES=5

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

# --- Atomic write -----------------------------------------------------------
# Append a line under "## <section>" by rewriting to a temp file in the same
# dir, then rename (mv) over the board so a concurrent reader never sees a
# half-written file. awk inserts the line just before the NEXT "## " heading
# (or end of file) that follows the target section.
atomic_append() {
  local section="$1"
  local line="$2"
  local board="$3"
  local dir
  dir=$(dirname "$board")
  local tmp
  tmp=$(mktemp "${dir}/.board-write.XXXXXX")

  awk -v section="## ${section}" -v newline="$line" '
    BEGIN { in_section = 0; inserted = 0 }
    # Entering the target section.
    $0 == section { print; in_section = 1; next }
    # A new heading while inside the target section: flush our line first.
    in_section && /^## / && !inserted {
      print newline
      inserted = 1
      in_section = 0
    }
    { print }
    END {
      if (in_section && !inserted) { print newline }
    }
  ' "$board" >"$tmp"

  mv -f "$tmp" "$board"
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

# --- No push: the flip state is unreadable or cannot be read -----------------
# Fails closed: the board commit stays local, in today's LOCALLY wording, with
# the flip marker's BLOCKED line as the reason when markers.js could say it.
keep_local_unread_flip() {
  local section="$1"
  local flip="$2"
  local blocker=""
  if [ "$flip" = "unreadable" ]; then
    blocker=$(flip_line)
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
# ship has run, never with a bare error that invites a re-run (the append has
# no presence check, so a second run would commit the line twice).
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
  local section="$1"
  local attempt="$2"
  local code=0
  local last=""
  local rest=""
  local state=""
  local text=""
  local started=0
  local pushing=0
  local reason=""
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
    echo "Board updated under '${section}' (attempt ${attempt})."
    exit 0
  fi

  # The remote turned the push away because origin/main moved since ship's
  # fetch: git's bracketed reason, which ship's result text carries, matched
  # by its words alone, never by a sha. Every push from this checkout goes
  # through ship under its lock, so the move came from outside it. Under the
  # project's git-safety invariant a rejected push stops and reports: nothing
  # is pulled, rebased or shipped again (an automatic rebase of the shared
  # checkout can clobber another window's work), and the board commit stays
  # local until a person rebases main onto origin/main by hand, so this line
  # names that rebase instead of saying the commit rides the next ship.
  if [ "$code" -eq 1 ] && [ "$state" = "failed" ]; then
    case "$text" in
      *"(fetch first)"* | *"(non-fast-forward)"*)
        echo "Board updated under '${section}' and committed LOCALLY, not pushed: origin/main moved since ship's fetch (a push from outside this checkout). Stop and ask: main has to be rebased onto origin/main by hand (git pull --rebase origin main while no other window is mid-edit; ship refuses a merge commit, since main holds squashes only), then run npm run ship." >&2
        exit 0
        ;;
    esac
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

# --- Main loop --------------------------------------------------------------
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

  # Denylist FIRST, before any repo mutation. No write on reject.
  if ! denylist_check "$line"; then
    exit 1
  fi

  local attempt=0
  while [ "$attempt" -lt "$MAX_RETRIES" ]; do
    attempt=$((attempt + 1))

    # Sync with origin first so our write rebases on top of any peer's.
    git pull --rebase --quiet origin main

    if [ ! -f "$BOARD_PATH" ]; then
      echo "ERROR: $BOARD_PATH not found in repo." >&2
      exit 3
    fi

    atomic_append "$section" "$line" "$BOARD_PATH"

    git add -- "$BOARD_PATH"
    # Nothing to do if the line was already present (idempotent peers). The
    # check and the commit both name the board file: the index is shared, so
    # whatever another window has staged stays staged and out of this commit.
    if git diff --cached --quiet -- "$BOARD_PATH"; then
      echo "No change to board (line already present)."
      exit 0
    fi
    git commit --quiet -m "board: update ${section}" -- "$BOARD_PATH"

    # The flip marker decides the push (see the header). present: ship.js
    # --foreground, and the guard below is retired. unreadable, or a state
    # that cannot be read: no push. Both functions exit. absent: today's
    # guard and guarded push below, unchanged.
    local flip
    flip=$(flip_state)
    if [ "$flip" = "present" ]; then
      ship_board "$section" "$attempt"
    elif [ "$flip" != "absent" ]; then
      keep_local_unread_flip "$section" "$flip"
    fi

    # REFUSE TO PUSH SOMEBODY ELSE'S WORK. `git push origin main` is a BRANCH
    # push: it ships EVERY unpushed commit on main, not just the board commit we
    # made a line ago. That is not theoretical: on 2026-08-14 it came within a
    # keystroke of deploying 49 uncued commits, and on 2026-08-19 it would have
    # shipped five code files from a freshly merged lane, in both cases bypassing
    # the push cue, the gate receipt and the review fleet. A board line is never
    # worth that.
    #
    # The pull --rebase above just refreshed origin/main, so exactly ONE commit
    # between origin/main and HEAD means ours is the only thing riding. Anything
    # else and we keep the board commit local: it rides the next real push, which
    # loses nothing. Fail CLOSED: if the count cannot be determined, do not push.
    local riding
    riding=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo "")
    if [ -z "$riding" ] || [ "$riding" -ne 1 ]; then
      echo "Board updated under '${section}' and committed LOCALLY, not pushed." >&2
      if [ -n "$riding" ]; then
        echo "  ${riding} commits are unpushed here, so pushing would deploy $((riding - 1)) that never got a push cue." >&2
      else
        echo "  Could not determine what else is unpushed, so refusing to push." >&2
      fi
      echo "  The board rides the next real push. Nothing is lost." >&2
      exit 0
    fi

    # Push fast-forward only. git rejects a non-fast-forward push by default
    # (no --force is ever passed), so this IS fast-forward-only: if a peer
    # advanced origin/main since our pull, the push is rejected and we rebase
    # and retry the whole loop. We never force-push.
    if git push --quiet origin main; then
      echo "Board updated under '${section}' (attempt ${attempt})."
      exit 0
    fi

    echo "Push rejected (peer won the race); retrying (attempt ${attempt}/${MAX_RETRIES})." >&2
  done

  echo "ESCALATE: board write failed after ${MAX_RETRIES} attempts. Not force-pushing. Resolve origin/main contention manually, then retry." >&2
  exit 4
}

main "$@"

#!/usr/bin/env bash
set -euo pipefail

# board-write.sh: concurrency-safe writer for docs/build-board.md.
#
# Many Claude windows touch the board, so a naive write would lost-update.
# This helper does, per attempt: git pull --rebase, an atomic temp-file +
# rename write, git commit, then a plain git push (which git rejects unless
# it is a fast-forward, so it is fast-forward-only without --force). On a
# rejected push (another window won the race) it retries the whole loop a
# bounded number of times, rebasing each pass so both lines survive, then
# escalates. It never force-pushes and never loops forever.
#
# Before any write it enforces a DENYLIST: the board carries titles and
# paths only, so a line that looks like an email, a phone number, a
# bearer-style token, or a Stripe id family member is rejected outright
# (non-zero, clear message, no write).
#
# It operates on the current working directory's repo, so tests can run it
# against a throwaway repo + local bare remote.
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

  # Email addresses.
  if printf '%s' "$content" | grep -Eqi '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'; then
    echo "BLOCKED: line looks like it contains an email address. The board carries titles and paths only." >&2
    return 1
  fi

  # Phone numbers (US-ish: optional +, 10+ digits with common separators).
  if printf '%s' "$content" | grep -Eq '(\+?[0-9]{1,3}[ .-]?)?\(?[0-9]{3}\)?[ .-]?[0-9]{3}[ .-]?[0-9]{4}'; then
    echo "BLOCKED: line looks like it contains a phone number. The board carries titles and paths only." >&2
    return 1
  fi

  # Bearer-style / long opaque tokens (e.g. JWT-ish or 20+ char secrets).
  if printf '%s' "$content" | grep -Eq '(Bearer[ ]+[A-Za-z0-9._-]+|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|sk_[A-Za-z0-9]+|[A-Fa-f0-9]{32,})'; then
    echo "BLOCKED: line looks like it contains a token or secret. The board carries titles and paths only." >&2
    return 1
  fi

  # Stripe id family (generic, matches the spec's regex).
  if printf '%s' "$content" | grep -Eq '(pi|cus|ch|re|evt|in|sub|cs|seti|pm)_[A-Za-z0-9]+'; then
    echo "BLOCKED: line looks like it contains a Stripe id. The board carries titles and paths only." >&2
    return 1
  fi

  return 0
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
    # Nothing to do if the line was already present (idempotent peers).
    if git diff --cached --quiet; then
      echo "No change to board (line already present)."
      exit 0
    fi
    git commit --quiet -m "board: update ${section}"

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

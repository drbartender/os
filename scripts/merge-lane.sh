#!/usr/bin/env bash
set -euo pipefail
#
# merge-lane.sh — crash-safe squash-merge wrapper for the build-in-lanes workflow.
#
# Run ONLY from the primary (os) worktree, on main, and invoked EXPLICITLY by
# Claude during integration. This is NOT a git hook: it is called by hand when a
# lane is ready to fold back into main.
#
# Usage:
#   scripts/merge-lane.sh <lane-branch> <plan-link> [lane-name]
#     <lane-branch>  the worktree's branch to squash-merge into main
#     <plan-link>    path/URL to the plan doc (kept in the squash commit message)
#     [lane-name]    short label for the commit message; defaults to <lane-branch>
#
# Behavior, in order:
#   1. Acquire an EXCLUSIVE flock on .git/merge-lane.lock. flock is chosen on
#      purpose because the lock auto-releases when the holding process dies, so a
#      crashed or killed merge can never wedge every future merge. A second
#      concurrent invocation waits behind the first instead of racing main.
#   2. Refuse unless run from the primary (os) worktree AND branch is main.
#   3. Refuse on a dirty working tree (commit or stash the quick fix first).
#   4. git merge --squash <lane-branch>, then a single-line squash commit whose
#      message carries the lane name + plan link so the push inventory stays
#      legible: "merge(lane <lane-name>): <plan-link>".
#   5. Print a notice that the lane's per-lane review MUST be re-run against the
#      new HEAD before the worktree is removed. "Verifies clean" means no
#      conflict AND review re-confirmed. The worktree is NOT auto-removed here.
#
# -----------------------------------------------------------------------------
# MANUAL flock-wedge recovery (should NEVER be needed; flock auto-releases on
# the holder's death, including a kill -9, because the kernel drops the lock
# when the file descriptor closes):
#
#   1. See whether anything still holds the lock:
#        fuser .git/merge-lane.lock           # lists PIDs holding it, if any
#        # or: lsof .git/merge-lane.lock
#      No PID listed means nothing holds it: a "stuck" lock here is impossible
#      to leak, so re-running merge-lane.sh will simply acquire it.
#   2. If a PID IS listed, that is a LIVE merge still running in another window.
#      Do NOT kill it blindly: let it finish, or inspect it first
#      (ps -fp <PID>). Killing it releases the lock immediately anyway.
#   3. The lockfile itself is just a zero-byte sentinel. flock locks the file
#      DESCRIPTOR, not the file's existence, so deleting .git/merge-lane.lock
#      does NOT clear a held lock and can split future waiters across two
#      different inodes. Do not delete it to "unstick" things. If you ever must
#      reset, remove it ONLY when fuser shows no holder, then let it be
#      recreated on the next run.
# -----------------------------------------------------------------------------

usage() {
  echo "usage: scripts/merge-lane.sh <lane-branch> <plan-link> [lane-name]" >&2
  exit 2
}

[ "$#" -ge 2 ] || usage

lane_branch="$1"
plan_link="$2"
lane_name="${3:-$1}"

git_dir=$(git rev-parse --git-dir)
lockfile="${git_dir}/merge-lane.lock"

# ---- Step 1: serialize behind an auto-releasing flock --------------------------
# Re-exec self under flock holding fd 9 so the lock spans the whole merge. The
# guard env var stops an infinite re-exec loop. flock blocks (waits) by default,
# so a second invocation queues behind the first rather than failing.
if [ -z "${MERGE_LANE_LOCKED:-}" ]; then
  exec env MERGE_LANE_LOCKED=1 flock "$lockfile" "$0" "$@"
fi

# From here on we hold the exclusive lock.

# ---- Step 2: must be the primary (os) worktree, on main -----------------------
branch=$(git rev-parse --abbrev-ref HEAD)
common=$(git rev-parse --path-format=absolute --git-common-dir)
primary=$(dirname "$common")
toplevel=$(git rev-parse --show-toplevel)

if [ "$toplevel" != "$primary" ]; then
  echo "REFUSED: merge-lane.sh runs only from the primary (os) worktree." >&2
  echo "  current worktree: $toplevel" >&2
  echo "  primary worktree: $primary" >&2
  echo "  Merges serialize through os; run it there." >&2
  exit 1
fi

if [ "$branch" != "main" ]; then
  echo "REFUSED: os must be on 'main' to merge a lane (currently on '$branch')." >&2
  exit 1
fi

# ---- Step 3: never merge into a dirty tree -----------------------------------
if [ -n "$(git status --porcelain)" ]; then
  echo "REFUSED: working tree is dirty. Never merge into a dirty tree." >&2
  echo "  Commit or stash your quick fix first, then re-run the merge." >&2
  echo "  (git status to see what is uncommitted.)" >&2
  exit 1
fi

# ---- Step 4: squash-merge as ONE clean commit --------------------------------
# A clean working tree is guaranteed above, so --squash stages only the merge.
if ! git merge --squash "$lane_branch"; then
  echo "REFUSED: squash-merge of '$lane_branch' hit a conflict." >&2
  echo "  Resolve per the conflict-handling rule (both diffs + both plans);" >&2
  echo "  escalate to Dallas on any sensitive path or genuine ambiguity." >&2
  exit 1
fi

commit_msg="merge(lane ${lane_name}): ${plan_link}"
git commit -m "$commit_msg"

# ---- Step 5: per-lane review must re-run before worktree removal --------------
echo
echo "Squash-merged '${lane_branch}' into main as ONE commit:"
echo "  ${commit_msg}"
echo
echo "NEXT: re-run this lane's per-lane review against the NEW main HEAD."
echo "  'Verifies clean' = no conflict AND review re-confirmed (not just no conflict)."
echo "  Do NOT remove the lane worktree until that review re-confirms clean."

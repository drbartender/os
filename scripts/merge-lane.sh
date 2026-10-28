#!/usr/bin/env bash
#
# merge-lane.sh: crash-safe squash-merge wrapper for the build-in-lanes workflow.
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
#   MERGE_LANE_LOCK_WAIT  seconds each index write waits out another git's
#                         index.lock (default 30); exported, so the docs
#                         generator's staging of a render waits it too
#
# Behavior, in order:
#   1. An EXCLUSIVE flock on .git/merge-lane.lock, which the kernel drops when
#      the holder dies (kill -9 included), so a killed merge never wedges the
#      next; a second merge waits behind the first instead of racing main.
#   2. Refuse unless run from the primary (os) worktree AND branch is main.
#   3. Refuse on a dirty working tree (commit or stash the quick fix first),
#      and without git hook run (git 2.36 or later) or an author identity.
#   4. Resolve <lane-branch> to one commit, once; pin main's HEAD; list the
#      squash's own paths (below), planned against the pin; refuse, with
#      nothing staged, when main moved off the pin by then; git merge --squash.
#      When the squash merged onto a head past the pin (a commit landed during
#      the squash's own run), its own paths are planned again against that
#      head, the ORIG_HEAD git merge writes from its own read of HEAD (the
#      residual: another git rewriting ORIG_HEAD during the squash, a reset,
#      rebase or merge no os window runs). Then snapshot what it stages for
#      those paths (below). main moving off the pin (another window committed)
#      refuses and resets, checked right after the squash, before each "nothing
#      to merge" check and before the commit's copy.
#   5. A conflict confined to README.md and ARCHITECTURE.md that the lane
#      changed only inside their generated sections (`node scripts/gen-docs.js
#      --generated-only --base <merge base> --tip <the lane commit>` exits 0)
#      takes main's version of each (git checkout --ours, git add) and goes
#      on: step 7 renders the sections again, so nothing the lane wrote by hand
#      is dropped. Any other conflict refuses, naming the unmerged paths, and
#      resets; a squash that failed with nothing unmerged wrote nothing and
#      refuses with no reset. Each conflicted working copy is hashed right
#      after the squash; one edited since stops the checkout and the reset
#      (both would overwrite it), which refuse, leaving the squash in place.
#   6. The guard and the prose check (below); then an index equal to HEAD (a
#      branch at main, a lane already merged) refuses "nothing to merge",
#      before the regeneration could commit the docs alone.
#   7. node scripts/gen-docs.js --staged renders the docs' generated sections
#      from the merged index and stages them, so the squash commit carries
#      sections current with the code it merges (skipped, with one line, when
#      the merged tree holds no generator). A failure refuses and resets, a
#      render it wrote and could not stage discarded from disk first (below).
#      The guard runs after each render; when it unstaged another window's file
#      (which the render may hold), the docs are rendered once more, and a
#      second time refuses. Then the prose check, and "nothing to merge" as in
#      step 6 (a lane whose only change was inside the sections).
#   8. The guard once more, then the squash commit, "merge(lane <lane-name>):
#      <plan-link>", built from a private copy of the index (GIT_INDEX_FILE): a
#      path staged since the guard that is not the squash's own is dropped from
#      the copy and named once, as left out of the commit, still staged for its
#      window; an own entry that moved refuses, and a copy whose tree is the
#      pin's (nothing of the lane is left once that staging is out) refuses as
#      nothing to merge. Then what git commit -m does, step by step: the author
#      and the committer it stamps (one now, taken before the hooks); the
#      pre-commit hook on the copy through git hook run, with git commit's
#      environment plus MERGE_LANE_COMMIT naming the copy (so the docs check
#      never reads the merge as a pathspec commit); the tree written after it;
#      the message cleaned as commit.cleanup says around the prepare-commit-msg
#      and commit-msg hooks; git commit-tree on the pin (-S under
#      commit.gpgSign); the post-commit hook after. A hook that refuses leaves
#      the squash staged (unless another window's commit took it, below). A
#      commit carrying a path that is not the squash's own refuses before main
#      moves (it never should). main moves only by git update-ref from the pin,
#      a compare-and-swap: when another window committed since, it refuses,
#      never reverting that commit, and resets. That commit holds nothing of
#      the lane unless it was a plain commit of the shared index, which takes
#      the staged squash with it: when HEAD holds at least one own path but the
#      docs that the squash changed exactly as the snapshot does (a pathspec
#      commit of an edited lane file never does), this refusal, a hook's, and
#      a moved main at any check say instead that the lane is on main inside
#      that commit, all of it or N of its M paths (the rest named as at that
#      window's own version, which the guard then says that window staged
#      before its commit, never a regeneration, or as not carried), with no
#      merge(lane) line, and to read git log first. After the commit, a lane
#      path another window unstaged during the hook (back at the pin's entry: a
#      staged revert of the merge) is put back at the commit's entry, its
#      working file as that window left it; a lane path at neither entry, and
#      any other path, staged by another window after the copy, stays staged
#      for it, named.
#   9. A notice: re-run the lane's per-lane review against the new HEAD before
#      the worktree is removed ("verifies clean" = no conflict AND review
#      re-confirmed). The worktree is NOT removed here.
#
# Another window's staging: os is shared, and other windows stage into its one
# index while a merge runs. The squash's own paths are what `git merge-tree
# --write-tree` of the planned head (the pin, or the head the squash merged
# onto) and the lane changes (a rename main made followed, as the squash
# follows it), the paths it reports conflicted (HEAD's side of a file/directory
# conflict, <path>~<sha> to merge-tree, under git merge's name <path>~HEAD),
# the lane's own changes since the merge base, and the two docs. Their snapshot
# is what the squash stages as merge-tree computes it (the merged tree's
# entries, and the stages merge-tree reports for a conflicted path), never read
# back from the shared index, so a path another window stages between the
# squash and the snapshot is seen as moved; the docs' part is read back from
# the index only after the self-resolution and each render. The guard: (a) a
# path staged against HEAD that is not the squash's own was staged by another
# window; git restore --staged takes it out with its content kept on disk (a
# new file untracked, an edit unstaged), named; one it cannot unstage refuses,
# the reset still running; (b) an own entry that no longer matches the snapshot
# refuses (its window's entry stays staged; a regeneration that failed after it
# staged lands here too). A render folds a prose edit staged to a doc into the
# docs' snapshot, so the docs are also judged by their prose against the merge
# result: gen-docs.js --generated-only between the merge-tree result and the
# index's tree (written from a private copy of the index, so another git's lock
# cannot stop it; each a throwaway commit, no ref), after the squash, after the
# renders and at every refusal. A doc whose prose moved refuses and stays
# staged for the window that staged it; a check that cannot run refuses
# plainly, says so, and resets the lane, the docs with it. Every doc left
# staged for another window is first rendered against HEAD: HEAD's generator
# (after the reset) on a scratch index of HEAD renders its sections, and git
# merge-file of HEAD's text, the merge result's and the staged one, each so
# rendered, takes the lane's own prose out; the disk and then the index are
# rewritten only while each holds what was staged. So the printed recovery (git
# restore --staged -- <doc>; that window commits it by pathspec; the merge runs
# again) needs no regeneration; a doc that comes out as HEAD's is back at HEAD;
# one whose edit overlaps the lane's prose, or whose entry moves again
# meanwhile, is left as that window staged it, named; one whose render cannot
# be staged (another git's lock) is named with git's reason and both ways out.
#
# Resetting the squash state: a refusal after the squash checks the conflicted
# working copies unchanged (the hash check), runs the guard, judges the prose
# when no conflict is unresolved, discards a render that could not be staged (a
# doc whose index entry is still the docs' snapshot while its working file
# differs from that entry only inside the generated sections is restored on
# disk from the entry and named; one that cannot be restored is kept, named
# with git's reason; one that differs outside the sections, another window's
# unstaged edit, is never discarded but kept on disk, named), then the scoped
# reset puts the squash's own paths back at HEAD one at a time, never a reset,
# checkout or restore without a pathspec. Each path is judged against the
# snapshot, its entry read just before it is touched: an entry that differs was
# staged by another window and stays staged for it, named; one another window
# put back at HEAD leaves only its working file to judge. Otherwise four rules:
# a path in HEAD is restored from HEAD in the index, and on disk while its
# working file still holds the snapshot's content (else kept, named); a path
# the squash removed is restored likewise, on disk only while nothing is there;
# a path the lane added leaves the index, its working file deleted only while
# it holds the snapshot's content; a conflicted path is restored from HEAD, or
# removed when HEAD has none. A file HEAD holds where the squash put a
# directory is restored after the paths under it, and a working file deleted
# takes the directories it leaves empty with it. While another git holds
# index.lock, every index write here (the squash, the reset, the guard, the
# self-resolution, the put-back, the discarded render, the docs rendered
# against HEAD, and the generator's own staging of a render, which reads the
# exported MERGE_LANE_LOCK_WAIT) tries again every 100 ms for up to
# MERGE_LANE_LOCK_WAIT seconds (default 30, longer than another window's commit
# hook, which holds the shared index.lock throughout), the script's own writes
# once only after one wait ran out (a lock held past it is a stale lock or a
# hung git); what still fails is named with git's reason and how long was
# waited. SQUASH_MSG and MERGE_MSG go last; HEAD never moves. Then, when main
# is off the pin and no line has said a commit carries the squash, the refusal
# asks once more, after the reset, whether the commit now at HEAD carries it (a
# plain commit of the shared index landing while the refusal runs takes the
# staged squash), and says so as step 8 does, never then that nothing was
# merged or that nothing of the lane is left (the residual: a commit landing
# during the reset's own run, which the reset judged against the head it read
# first, so a path that commit carries can be left as a staged revert of it,
# and the refusal then ends with read git status). The refusal ends by saying
# the tree is back at HEAD, or that only another window's work is left,
# unstaged on disk; it ends with "read git status before the next merge" when a
# path could not be reset or unstaged, an entry is left staged for another
# window, or a working file is kept.
#
# A wedged flock should never happen. `fuser .git/merge-lane.lock` (or lsof)
# lists a holder: none means a re-run takes the lock; a PID is a LIVE merge in
# another window, so let it finish (ps -fp <PID>). Never delete the zero-byte
# lockfile to unstick it: flock locks the descriptor, and a new inode splits
# the waiters; remove it only when fuser lists no holder.

set -euo pipefail

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
# Re-exec self under flock so the lock spans the whole merge; the env var stops
# a re-exec loop. flock waits by default, so a second invocation queues.
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

# The generator and every path git names below are read from the repo root.
cd "$toplevel"

# ---- Step 3: never merge into a dirty tree -----------------------------------
if [ -n "$(git status --porcelain)" ]; then
  echo "REFUSED: working tree is dirty. Never merge into a dirty tree." >&2
  echo "  Commit or stash your quick fix first, then re-run the merge." >&2
  echo "  (git status to see what is uncommitted.)" >&2
  exit 1
fi

# The squash commit runs its hooks through git hook run and stamps an author.
if ! git hook run --ignore-missing merge-lane-probe 2> /dev/null || ! git var GIT_AUTHOR_IDENT > /dev/null; then
  echo "REFUSED: the squash commit needs git hook run (git 2.36 or later) and a git author identity; nothing was merged." >&2
  exit 1
fi

gen_docs="scripts/gen-docs.js"
docs=(README.md ARCHITECTURE.md)

# Its arguments joined with ", ".
joined() {
  local out="" p
  for p in "$@"; do out="${out:+$out, }$p"; done
  printf '%s' "$out"
}

# The index entries (git ls-files -s -z) of the given paths; nothing for none.
entries() {
  if [ "$#" -gt 0 ]; then git --literal-pathspecs ls-files -s -z -- "$@"; fi
}

# Fills the associative array named by $2 from the `git ls-files -s -z`
# listing in file $1: path -> "mode id stage;" per stage.
load_entries() {
  local -n into="$2"
  local rec
  into=()
  while IFS= read -r -d '' rec; do
    into["${rec#*$'\t'}"]+="${rec%%$'\t'*};"
  done < "$1"
}

# The wait for another git's index.lock, per index write: MERGE_LANE_LOCK_WAIT
# seconds, default 30, longer than any commit hook in os (a pathspec commit
# holds the shared index.lock for its whole hook).
lock_wait=30
case "${MERGE_LANE_LOCK_WAIT-}" in
  '' | *[!0-9]*) ;;
  *) lock_wait=$((10#$MERGE_LANE_LOCK_WAIT)) ;;
esac
lock_span="$lock_wait seconds"
[ "$lock_wait" -ne 1 ] || lock_span="1 second"
# Exported, so the generator's own staging of a render (gen-docs.js --staged)
# waits the same budget.
export MERGE_LANE_LOCK_WAIT="$lock_wait"

# git with the given arguments, again every 100 ms for up to lock_wait seconds
# while another git holds index.lock; once one wait ran out, a lock held past
# it is a stale lock or a hung git, not a hook, so every later write tries
# once. On failure why holds git's first line, or what the lock cost.
why=""
lock_spent=0
git_retry() {
  local tries=0
  while :; do
    if git "$@" 2> "$work/git.err"; then return 0; fi
    why=$(head -n 1 "$work/git.err")
    grep -q 'index\.lock' "$work/git.err" || return 1
    if [ "$lock_spent" -eq 1 ]; then
      why="another git still held index.lock after a wait of $lock_span ran out"
      return 1
    fi
    if [ "$tries" -ge $((lock_wait * 10)) ]; then
      lock_spent=1
      why="another git held index.lock for $lock_span"
      return 1
    fi
    tries=$((tries + 1))
    sleep 0.1
  done
}

# Sets moved to the squash's own paths whose index entries differ from the
# snapshot.
moved=()
find_moved() {
  local -A was=() now=()
  local p
  cat "$work/own.snap" "$work/docs.snap" > "$work/before"
  { entries "${own_list[@]}"; entries "${docs[@]}"; } > "$work/after"
  load_entries "$work/before" was
  load_entries "$work/after" now
  moved=()
  for p in "${!was[@]}"; do [ "${was[$p]}" = "${now[$p]-}" ] || moved+=("$p"); done
  for p in "${!now[@]}"; do [ -n "${was[$p]+set}" ] || moved+=("$p"); done
}

# Sets foreign to the paths staged against $1 (default HEAD; in whichever
# index GIT_INDEX_FILE names) that are not the squash's own.
foreign=()
find_foreign() {
  local p
  foreign=()
  git diff --cached --name-only -z --no-renames "${1:-HEAD}" > "$work/staged"
  while IFS= read -r -d '' p; do
    [ -n "${ours[$p]+set}" ] || foreign+=("$p")
  done < "$work/staged"
}

# The guard (header): unstages what another window staged (unstaged=1 when it
# did; a path it cannot unstage refuses), then refuses when an own entry moved.
unstaged=0
kept_foreign=0
stuck=()
guard() {
  local p done_now=()
  local -A held=()
  unstaged=0
  find_foreign
  if [ "${#foreign[@]}" -gt 0 ]; then
    stuck=()
    if ! git_retry --literal-pathspecs restore --staged -- "${foreign[@]}"; then
      # Path by path; one no longer staged (its window unstaged it) is not stuck.
      for p in "${foreign[@]}"; do
        git_retry --literal-pathspecs restore --staged -- "$p" ||
          git --literal-pathspecs diff --cached --quiet HEAD -- "$p" || { stuck+=("$p"); held["$p"]=1; }
      done
    fi
    for p in "${foreign[@]}"; do
      [ -n "${held[$p]+set}" ] || done_now+=("$p")
    done
    if [ "${#done_now[@]}" -gt 0 ]; then
      echo "merge-lane: unstaged $(joined "${done_now[@]}"): staged by another window during the merge, its content kept on disk."
      unstaged=1
      kept_foreign=1
    fi
    if [ "${#stuck[@]}" -gt 0 ]; then
      echo "REFUSED: could not unstage what another window staged during the merge ($why): $(joined "${stuck[@]}"); nothing is committed." >&2
      refuse_keeping
    fi
  fi
  find_moved
  if [ "${#moved[@]}" -gt 0 ]; then
    # A path the commit that moved main holds at that window's own version
    # (window_own, from check_carried) was staged by that window, never by a
    # regeneration.
    local theirs=() rest=()
    for p in "${moved[@]}"; do
      if [ -n "${window_own[$p]+set}" ]; then theirs+=("$p"); else rest+=("$p"); fi
    done
    [ "${#rest[@]}" -eq 0 ] || echo "REFUSED: $(joined "${rest[@]}") changed in the index under the merge (another window, or a regeneration that failed after it staged); nothing is committed." >&2
    [ "${#theirs[@]}" -eq 0 ] || echo "  $(joined "${theirs[@]}") changed in the index under the merge: that window staged its own version of it before its commit, which holds that version." >&2
    refuse_keeping
  fi
}

# Each conflicted path's working copy, hashed right after the squash (a path
# resolved on purpose leaves the table): the checkout --ours and the reset
# both overwrite it, so another window's edit to it must stop them.
declare -A conflict_hash=()
work_hash() {
  git hash-object -- "$1" 2>/dev/null || echo unreadable
}
# Refuses, touching nothing, when one of the given conflicted paths' working
# copies changed since the squash.
check_untouched() {
  local p edited=()
  for p in "$@"; do
    [ "$(work_hash "$p")" = "${conflict_hash[$p]}" ] || edited+=("$p")
  done
  if [ "${#edited[@]}" -gt 0 ]; then
    echo "REFUSED: $(joined "${edited[@]}") was edited during the merge (its conflicted working copy changed after the squash), and is left as it is." >&2
    echo "  Nothing was reset or committed; the squash is left in place (git status)." >&2
    exit 1
  fi
}

# Fills the array named by $1 (as load_entries does) with what commit $2
# holds at the paths given after it.
load_head() {
  local -n into_head="$1"
  local rec meta commit="$2"
  shift 2
  into_head=()
  [ "$#" -gt 0 ] || return 0
  git --literal-pathspecs ls-tree -r -z --full-tree "$commit" -- "$@" > "$work/head-entries"
  while IFS= read -r -d '' rec; do
    meta="${rec%%$'\t'*}"
    into_head["${rec#*$'\t'}"]="${meta%% *} ${meta##* } 0;"
  done < "$work/head-entries"
}

# The index entries of one path, read now (as load_entries keeps them).
entry_now() {
  local -A one=()
  entries "$1" > "$work/one"
  load_entries "$work/one" one
  printf '%s' "${one[$1]-}"
}

# The blob of a stage-0 entry as load_entries keeps it, or absent for none.
oid_of() {
  local rest="${1#* }"
  if [ -n "$1" ]; then printf '%s' "${rest%% *}"; else printf absent; fi
}

# What a working file holds: its blob id, or absent when nothing is there.
disk_of() {
  if [ -e "$1" ] || [ -L "$1" ]; then work_hash "$1"; else printf absent; fi
}

# Deletes a working file of the squash's and the directories it leaves empty,
# as git does when it removes a file.
drop_file() {
  rm -f -- "$1"
  [ "$1" = "${1%/*}" ] || rmdir -p --ignore-fail-on-non-empty -- "${1%/*}" 2> /dev/null || true
}

# The scoped reset (header), skipping the paths given (left staged on
# purpose). Fills reset_list, left_staged, kept_disk and reset_failed.
reset_list=()
left_staged=()
kept_disk=()
reset_failed=()
scoped_reset() {
  local -A skip=() snap=() head=() cand=()
  local p s h l want disk dest
  for p in "$@"; do skip["$p"]=1; done
  cat "$work/own.snap" "$work/docs.snap" > "$work/before"
  load_entries "$work/before" snap
  load_head head HEAD "${own_list[@]}" "${docs[@]}"
  # The paths the squash staged, and the own paths staged now.
  for p in "${own_list[@]}" "${docs[@]}"; do
    [ "${snap[$p]-}" = "${head[$p]-}" ] || cand["$p"]=1
  done
  git diff --cached --name-only -z --no-renames HEAD > "$work/undo"
  while IFS= read -r -d '' p; do
    [ -z "${ours[$p]+set}" ] || cand["$p"]=1
  done < "$work/undo"
  printf '%s\0' "${!cand[@]}" | LC_ALL=C sort -z > "$work/cands.all"
  # A file HEAD holds where the squash put a directory is restored after the
  # paths under it (removing them clears its place); the rest in path order.
  local -A above=()
  while IFS= read -r -d '' p; do
    while [ "$p" != "${p%/*}" ]; do p="${p%/*}"; above["$p"]=1; done
  done < "$work/cands.all"
  : > "$work/cands"
  : > "$work/cands.last"
  while IFS= read -r -d '' p; do
    [ -n "$p" ] || continue
    if [ -n "${above[$p]+set}" ] && [ -n "${head[$p]-}" ]; then dest="$work/cands.last"; else dest="$work/cands"; fi
    printf '%s\0' "$p" >> "$dest"
  done < "$work/cands.all"
  cat -- "$work/cands.last" >> "$work/cands"
  while IFS= read -r -d '' p; do
    [ -n "$p" ] && [ -z "${skip[$p]+set}" ] || continue
    s="${snap[$p]-}"
    h="${head[$p]-}"
    # What the working file holds while it is still the squash's.
    if [ -n "${conflict_hash[$p]+set}" ]; then want="${conflict_hash[$p]}"; else want=$(oid_of "$s"); fi
    disk=$(disk_of "$p")
    l=$(entry_now "$p")
    if [ "$l" != "$s" ]; then
      # Moved since the snapshot: another window's entry stays staged; one it
      # put back at HEAD leaves only the working file to judge.
      if [ "$l" != "$h" ]; then left_staged+=("$p"); continue; fi
      if [ "$disk" = "$want" ] && [ "$disk" != "$(oid_of "$h")" ]; then
        if [ -n "$h" ]; then
          git_retry --literal-pathspecs restore -q --worktree --source=HEAD -- "$p" || { reset_failed+=("$p"); continue; }
        else
          drop_file "$p"
        fi
      elif [ "$disk" != "$(oid_of "$h")" ]; then
        kept_disk+=("$p")
      fi
    elif [ -n "$h" ]; then
      if [ "$disk" = "$want" ]; then
        git_retry --literal-pathspecs restore -q --staged --worktree --source=HEAD -- "$p" || { reset_failed+=("$p"); continue; }
      else
        git_retry --literal-pathspecs restore -q --staged --source=HEAD -- "$p" || { reset_failed+=("$p"); continue; }
        kept_disk+=("$p")
      fi
    else
      # The lane added it (or both sides did, in a conflict).
      git_retry --literal-pathspecs rm -q --cached -- "$p" || { reset_failed+=("$p"); continue; }
      if [ "$disk" = "$want" ]; then drop_file "$p"; else kept_disk+=("$p"); fi
    fi
    reset_list+=("$p")
  done < "$work/cands"
  rm -f -- "$(git rev-parse --git-path SQUASH_MSG)" "$(git rev-parse --git-path MERGE_MSG)"
}

# Renders the doc copies under $work/rehead/$1 in place as HEAD's tree renders
# them: the generator on disk (HEAD's, after the reset) on a scratch index of
# HEAD, both docs pointed at the copies.
render_at_head() {
  local dir="$work/rehead/$1"
  [ -f "$work/head-index" ] || GIT_INDEX_FILE="$work/head-index" git -c core.splitIndex=false read-tree HEAD || return 1
  GIT_INDEX_FILE="$work/head-index" node "$gen_docs" --readme "$dir/README.md" --arch "$dir/ARCHITECTURE.md" --staged >> "$work/rehead/log" 2>&1
}

# Renders each doc given (left staged for another window) against HEAD and
# takes the lane's own prose out (header). Fills rehead_back (it came out as
# HEAD's), lane_prose (its edit overlaps the lane's prose: left as staged),
# rehead_failed (not rendered), rehead_moved (its entry moved again),
# restage_failed (its working file rewritten, the render could not be staged;
# restage_why says why) and disk_moved (its working file no longer held what
# was staged).
rehead_back=()
lane_prose=()
rehead_failed=()
disk_moved=()
rehead_skip=()
rehead_moved=()
restage_failed=()
declare -A restage_why=()
rehead_docs() {
  local d v rec nb rewrote
  local -A blob=() mode=()
  [ "$#" -gt 0 ] || return 0
  for v in head merged staged; do mkdir -p "$work/rehead/$v"; done
  for d in "${docs[@]}"; do
    # The generator renders both docs; without it nothing is rendered, and a
    # doc HEAD lacks is left as it is (rehead_skip).
    if ! git show "HEAD:$d" > "$work/rehead/head/$d" 2> /dev/null; then
      rm -f -- "$work/rehead/head/$d"
      [ ! -f "$gen_docs" ] || { rehead_failed=("$@"); return 0; }
      continue
    fi
    git show "$merged_tree:$d" > "$work/rehead/merged/$d" 2> /dev/null || cp -- "$work/rehead/head/$d" "$work/rehead/merged/$d"
    cp -- "$work/rehead/head/$d" "$work/rehead/staged/$d"
  done
  for d in "$@"; do
    [ -f "$work/rehead/head/$d" ] || { rehead_skip+=("$d"); continue; }
    rec=$(entry_now "$d")
    case "$rec" in *" 0;") ;; *) rehead_failed+=("$d"); continue ;; esac
    mode["$d"]="${rec%% *}"
    blob["$d"]=$(oid_of "$rec")
    git cat-file blob "${blob[$d]}" > "$work/rehead/staged/$d"
  done
  if [ -f "$gen_docs" ]; then
    for v in head merged staged; do
      render_at_head "$v" || { rehead_failed=("$@"); return 0; }
    done
  fi
  for d in "$@"; do
    [ -n "${blob[$d]+set}" ] || continue
    if ! git merge-file -q -p "$work/rehead/head/$d" "$work/rehead/merged/$d" "$work/rehead/staged/$d" > "$work/rehead/$d.out"; then
      cp -- "$work/rehead/staged/$d" "$work/rehead/$d.out"
      lane_prose+=("$d")
    fi
    if cmp -s "$work/rehead/$d.out" "$work/rehead/head/$d"; then
      nb=$(git rev-parse "HEAD:$d")
    else
      nb=$(git hash-object -w -- "$work/rehead/$d.out")
    fi
    [ "$nb" != "${blob[$d]}" ] || continue
    rewrote=0
    if [ "$(disk_of "$d")" = "${blob[$d]}" ]; then
      git cat-file blob "$nb" > ".$d.merge-lane-$$.tmp" && mv -f -- ".$d.merge-lane-$$.tmp" "$d" && rewrote=1
    else
      disk_moved+=("$d")
    fi
    # The index: already the rendered entry (that window staged the file just
    # rewritten), or still what was staged, else it moved again. A restage
    # that fails is this script's own failure, never another window's move
    # (a working file left as it was says so through disk_moved).
    rec=$(entry_now "$d")
    if [ "$rec" != "${mode[$d]} $nb 0;" ]; then
      if [ "$rec" != "${mode[$d]} ${blob[$d]} 0;" ]; then
        rehead_moved+=("$d")
        continue
      fi
      if ! git_retry update-index --cacheinfo "${mode[$d]},$nb,$d"; then
        [ "$rewrote" -eq 0 ] || { restage_failed+=("$d"); restage_why["$d"]="$why"; }
        continue
      fi
    fi
    [ "$nb" != "$(git rev-parse "HEAD:$d")" ] || rehead_back+=("$d")
  done
}

# The lines for the docs left staged: how each was rendered against HEAD,
# and how to keep that window's edit.
rehead_report() {
  local d done_docs=()
  local -A bad=()
  for d in "${rehead_failed[@]}" "${lane_prose[@]}" "${disk_moved[@]}" "${rehead_skip[@]}" "${rehead_moved[@]}" "${restage_failed[@]}"; do bad["$d"]=1; done
  for d in "${left[@]}"; do
    case "$d" in README.md | ARCHITECTURE.md) [ -n "${bad[$d]+set}" ] || done_docs+=("$d") ;; esac
  done
  [ "${#done_docs[@]}" -eq 0 ] || echo "  Its text is HEAD's plus that window's edit (the lane's own prose taken out, its generated sections as HEAD's tree renders them), so it needs no regeneration: $(joined "${done_docs[@]}")." >&2
  [ "${#lane_prose[@]}" -eq 0 ] || echo "  That window's edit overlaps the lane's own prose, so it is left as that window staged it and may still hold the lane's prose; check it before that window commits it: $(joined "${lane_prose[@]}")." >&2
  [ "${#rehead_failed[@]}" -eq 0 ] || echo "  Could not be rendered against HEAD, so it may carry the lane's generated sections; run npm run docs -- --staged before it is committed: $(joined "${rehead_failed[@]}")." >&2
  [ "${#rehead_moved[@]}" -eq 0 ] || echo "  Its index entry changed again while it was rendered against HEAD, so it is left as that window staged it; run npm run docs -- --staged before it is committed: $(joined "${rehead_moved[@]}")." >&2
  for d in "${restage_failed[@]}"; do
    echo "  Could not restage $d after rendering it against HEAD (${restage_why[$d]}); its working file holds that render and its index entry what was staged: run git add -- $d to stage the render, or git restore --staged -- $d to drop it." >&2
  done
  [ "${#disk_moved[@]}" -eq 0 ] || echo "  Its working file no longer held what was staged and is left as it is; run npm run docs before that window commits it: $(joined "${disk_moved[@]}")." >&2
  [ "$(( ${#done_docs[@]} + ${#bad[@]} ))" -eq 0 ] || echo "  To keep that window's edit: git restore --staged -- <doc> leaves it on disk, unstaged; that window commits it as its own change by pathspec; then run the merge again." >&2
}

# Whether the working file of doc $1 differs from blob $2 only inside the
# generated sections: gen-docs.js --generated-only between two throwaway
# commits (no ref) that hold the doc alone, at $2 and as it is on disk.
sections_only() {
  local now_blob a b
  now_blob=$(git hash-object -w -- "$1") &&
    a=$(printf '100644 blob %s\t%s\n' "$2" "$1" | git mktree) &&
    b=$(printf '100644 blob %s\t%s\n' "$now_blob" "$1" | git mktree) &&
    a=$(git commit-tree --no-gpg-sign -m "merge-lane: the doc's index entry" "$a") &&
    b=$(git commit-tree --no-gpg-sign -m "merge-lane: the doc on disk" "$b") &&
    node "$gen_docs" --generated-only --base "$a" --tip "$b" > /dev/null 2>&1
}

# A render the generator wrote and could not stage (another git's lock past
# the wait): a doc whose index entry is still the docs' snapshot while its
# working file differs from that entry only inside the generated sections.
# Its working file is restored from the entry, named; a restore that fails
# keeps it, named with git's reason (discard_failed). A working file that
# differs outside the sections (another window's unstaged edit, perhaps over
# such a render) is never discarded: it is kept on disk and named, here when
# the scoped reset will not reach it (the snapshot at HEAD's entry).
discard_failed=()
discard_render() {
  local d rec oid done_docs=()
  local -A snapd=() at_head=()
  [ -f "$gen_docs" ] || return 0
  load_entries "$work/docs.snap" snapd
  load_head at_head HEAD "${docs[@]}"
  for d in "${docs[@]}"; do
    rec=$(entry_now "$d")
    [[ "$rec" =~ ^[0-7]+\ [0-9a-f]+\ 0\;$ ]] && [ "$rec" = "${snapd[$d]-}" ] || continue
    oid=$(oid_of "$rec")
    [ -f "$d" ] && [ "$(disk_of "$d")" != "$oid" ] || continue
    if ! sections_only "$d" "$oid"; then
      [ "$rec" != "${at_head[$d]-}" ] || kept_disk+=("$d")
    elif git_retry --literal-pathspecs restore -q --worktree -- "$d"; then
      done_docs+=("$d")
    else
      discard_failed+=("$d")
      echo "  Could not discard from disk the render of $d that could not be staged ($why); it is kept on disk, unstaged (git restore -- $d discards it)." >&2
    fi
  done
  [ "${#done_docs[@]}" -eq 0 ] || echo "  The render that could not be staged was discarded from disk; the index entry stands: $(joined "${done_docs[@]}")." >&2
}

# After a REFUSED line: the prose judgment unless the caller judged (a doc
# whose prose moved is kept; the docs' snapshot never stands in for it), a
# render that could not be staged discarded from disk, the scoped reset of
# the rest, the docs left staged rendered against HEAD, what it all did, and
# exit 1.
prose_judged=0
refuse_keeping() {
  local left=()
  if [ "$prose_judged" -eq 0 ] && [ "$#" -eq 0 ]; then
    judge_prose
    if [ "$prose_failed" -eq 1 ]; then
      cat "$work/prose" >&2
      echo "  The docs' prose could not be checked against the merge result (why is above), so the docs are reset with the rest of the lane." >&2
    elif [ "${#prose_moved[@]}" -gt 0 ]; then
      echo "  A prose edit to $(joined "${prose_moved[@]}") was staged by another window during the merge; that doc is left staged with that prose." >&2
      set -- "${prose_moved[@]}"
    fi
  fi
  discard_render
  scoped_reset "$@"
  local -A back=()
  local p kept_docs=()
  for p in "$@" "${left_staged[@]}"; do
    case "$p" in README.md | ARCHITECTURE.md) kept_docs+=("$p") ;; esac
  done
  rehead_docs "${kept_docs[@]}"
  for p in "${rehead_back[@]}"; do back["$p"]=1; done
  for p in "$@" "${left_staged[@]}"; do
    [ -n "${back[$p]+set}" ] || left+=("$p")
  done
  [ "${#reset_list[@]}" -eq 0 ] || echo "  Reset to HEAD: $(joined "${reset_list[@]}")." >&2
  [ "${#rehead_back[@]}" -eq 0 ] || echo "  Back at HEAD once rendered against HEAD (it held nothing but the lane's render and prose): $(joined "${rehead_back[@]}")." >&2
  [ "${#left[@]}" -eq 0 ] || echo "  Left staged for the window that staged it: $(joined "${left[@]}")." >&2
  rehead_report
  [ "${#kept_disk[@]}" -eq 0 ] || echo "  Kept on disk, unstaged, since its working file changed during the merge: $(joined "${kept_disk[@]}")." >&2
  [ "${#stuck[@]}" -eq 0 ] || echo "  Still staged, as it could not be unstaged: $(joined "${stuck[@]}") (another window's)." >&2
  # A commit landing while this refusal ran (a plain commit of the shared
  # index takes the staged squash with it) is checked once more, after the
  # reset, so the last line never says nothing was merged when it was.
  [ "$carried" -eq 1 ] || check_carried "found as this refusal ended" || true
  if [ "$(( ${#reset_failed[@]} + ${#stuck[@]} + ${#discard_failed[@]} ))" -gt 0 ]; then
    [ "${#reset_failed[@]}" -eq 0 ] || echo "  Could not reset $(joined "${reset_failed[@]}") ($why)." >&2
    echo "  Read git status before the next merge." >&2
  elif [ "$carried" -eq 1 ]; then
    # The lane is on main inside another window's commit (said above).
    [ -z "$(git status --porcelain)" ] || echo "  Read git status before the next merge." >&2
  elif [ -z "$(git status --porcelain)" ]; then
    echo "  Nothing was merged: the index and the working tree are back at HEAD." >&2
  elif [ "${#left[@]}" -eq 0 ] && [ "$kept_foreign" -eq 1 ]; then
    echo "  Nothing was merged: the squash is reset, and what another window staged is kept on disk, unstaged (named above)." >&2
  elif [ "$(( ${#lane_prose[@]} + ${#rehead_failed[@]} + ${#rehead_moved[@]} + ${#restage_failed[@]} ))" -gt 0 ]; then
    echo "  A doc left staged may still hold some of the lane's (named above); read git status before the next merge." >&2
  else
    echo "  Nothing of the lane is left in the index; read git status before the next merge." >&2
  fi
  exit 1
}

# The prose judgment (header): sets prose_moved to the docs whose text outside
# the generated sections differs from the merge result's, prose_failed=1 when
# it could not run (why in $work/prose). Nothing while a conflict is
# unresolved; without the generator the docs must equal the merge result's.
merged_commit=""
prose_moved=()
prose_failed=0
judge_prose() {
  local tree index_commit d
  prose_moved=()
  prose_failed=0
  [ "${#conflict_hash[@]}" -eq 0 ] || return 0
  if ! { cp -- "$(git rev-parse --git-path index)" "$work/prose-index" &&
    tree=$(GIT_INDEX_FILE="$work/prose-index" git write-tree 2> "$work/prose"); }; then
    prose_failed=1
    return 0
  fi
  if [ ! -f "$gen_docs" ]; then
    for d in "${docs[@]}"; do
      [ "$(git rev-parse -q --verify "$merged_tree:$d" || true)" = "$(git rev-parse -q --verify "$tree:$d" || true)" ] || prose_moved+=("$d")
    done
    return 0
  fi
  if ! { [ -n "$merged_commit" ] ||
    merged_commit=$(git commit-tree --no-gpg-sign -p HEAD -m "merge-lane: the merge result" "$merged_tree" 2> "$work/prose"); } ||
    ! index_commit=$(git commit-tree --no-gpg-sign -p HEAD -m "merge-lane: the index" "$tree" 2> "$work/prose"); then
    prose_failed=1
    return 0
  fi
  node "$gen_docs" --generated-only --base "$merged_commit" --tip "$index_commit" > "$work/prose" 2>&1 && return 0
  while IFS= read -r d; do
    prose_moved+=("$d")
  done < <(sed -n 's/^generated-only: \(.*\) differs outside the generated sections$/\1/p' "$work/prose")
  [ "${#prose_moved[@]}" -gt 0 ] || prose_failed=1
}

# The prose check after the squash and after the renders (header).
prose_check() {
  judge_prose
  if [ "$prose_failed" -eq 1 ]; then
    cat "$work/prose" >&2
    echo "REFUSED: the prose check itself failed: the docs could not be compared with the merge result (why is above); nothing is committed, and the lane is reset, the docs with it." >&2
    prose_judged=1
    refuse_keeping
  fi
  [ "${#prose_moved[@]}" -gt 0 ] || return 0
  echo "REFUSED: a prose edit to $(joined "${prose_moved[@]}") was staged by another window during the merge; nothing is committed, and that doc is left staged with that prose." >&2
  refuse_keeping "${prose_moved[@]}"
}

# After a REFUSED line: the hash check, the guard, then refuse_keeping.
abandon_squash() {
  check_untouched "${!conflict_hash[@]}"
  guard
  refuse_keeping
}

# When main is off the pin, whether the commit at HEAD carries the squash, or
# part of it (another window's plain commit of the shared index while the
# squash was staged): at least one own path but the docs that the squash
# changed from the head it was planned against sits at HEAD as the snapshot
# holds it (a pathspec commit of an edited lane file never matches the
# snapshot). Then it says so (carried=1): that commit carries every path the
# squash changed, or N of them, naming the rest in two groups, at that
# window's own version (window_own: HEAD at neither the snapshot nor the
# planned head) and not carried (HEAD at the planned head). $1, when given,
# says when main was found moved.
carried=0
declare -A window_own=()
check_carried() {
  local now p took=0 changed=0 lead tail=""
  local -A snap=() at_now=() at_plan=()
  local own_version=() not_carried=()
  now=$(git rev-parse HEAD)
  [ "$now" != "$head_pin" ] && [ "${#own_list[@]}" -gt 0 ] || return 1
  load_entries "$work/own.snap" snap
  load_head at_now "$now" "${own_list[@]}"
  load_head at_plan "$plan_head" "${own_list[@]}"
  for p in "${own_list[@]}"; do
    [ "${snap[$p]-}" != "${at_plan[$p]-}" ] || continue
    changed=$((changed + 1))
    if [ "${at_now[$p]-}" = "${snap[$p]-}" ]; then
      took=$((took + 1))
    elif [ "${at_now[$p]-}" = "${at_plan[$p]-}" ]; then
      not_carried+=("$p")
    else
      own_version+=("$p")
    fi
  done
  [ "$took" -gt 0 ] || return 1
  carried=1
  for p in "${own_version[@]}"; do window_own["$p"]=1; done
  lead="REFUSED: main moved under the merge${1:+ ($1)}: $(git log -1 --format='%h %s' "$now") from another window"
  if [ "$took" -eq "$changed" ]; then
    # Before the reset, a prediction the reset keeps; after it, the summary says.
    [ -n "${1-}" ] || tail=" Nothing of the squash is left in the index."
    echo "$lead already carries every path of the squash (a plain commit of the shared index while the squash was staged); the lane is on main inside that commit, which has no merge(lane) line and whose review block does not cover it.$tail Read git log before anything else." >&2
    return 0
  fi
  [ "${#own_version[@]}" -eq 0 ] || tail=" At that window's own version (which may hold the lane's change): $(joined "${own_version[@]}")."
  [ "${#not_carried[@]}" -eq 0 ] || tail="$tail Not carried (at the head the squash was planned against): $(joined "${not_carried[@]}")."
  echo "$lead carries $took of the squash's $changed paths exactly as the squash staged them (a commit of the shared index made during the merge); that part of the lane is on main inside that commit, which has no merge(lane) line and whose review block does not cover it.$tail Read git log before anything else." >&2
}

# Refuses and resets when main moved off the pin.
check_pin() {
  local now
  now=$(git rev-parse HEAD)
  [ "$now" != "$head_pin" ] || return 0
  check_carried || echo "REFUSED: main moved during the merge ($(git log -1 --format='%h %s' "$now") landed from another window); nothing is committed. Run the merge again." >&2
  abandon_squash
}

# ---- Step 4: squash-merge as ONE clean commit --------------------------------
# The branch is read once, so a lane commit landing mid-merge changes nothing.
if ! lane_sha=$(git rev-parse --verify -q "${lane_branch}^{commit}"); then
  echo "REFUSED: '$lane_branch' names no commit; nothing was merged." >&2
  exit 1
fi
# The pin: the squash is judged against it, and lands only while main is at it.
head_pin=$(git rev-parse --verify HEAD)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

add_ours() {
  local p
  while IFS= read -r -d '' p; do
    [ -z "$p" ] || ours["$p"]=1
  done < "$1"
}

# The entries the squash stages for the given paths, in git ls-files -s -z
# form, from merge-tree's result and never read back from the index another
# window shares: a conflicted path's stages as merge-tree reports them, any
# other path's entry in the merged tree (none when the merge removes it).
expected_entries() {
  local -A want=()
  local p rec meta
  [ "$#" -gt 0 ] || return 0
  for p in "$@"; do want["$p"]=1; done
  git --literal-pathspecs ls-tree -r -z --full-tree "$merged_tree" -- "$@" > "$work/mt-entries"
  while IFS= read -r -d '' rec; do
    p="${rec#*$'\t'}"
    [ -z "${mt_conflict[$p]+set}" ] || continue
    meta="${rec%%$'\t'*}"
    printf '%s %s 0\t%s\0' "${meta%% *}" "${meta##* }" "$p"
  done < "$work/mt-entries"
  while IFS= read -r -d '' rec; do
    [ -z "${want[${rec#*$'\t'}]+set}" ] || printf '%s\0' "$rec"
  done < "$work/conflict-entries"
}

# merge-tree names HEAD's side of a file/directory or distinct-types conflict
# <path>~<the sha it was given>, where git merge --squash names it
# <path>~HEAD (the lane's side is <path>~<lane sha> in both): the squash's
# names, from the NUL-separated paths or entries on stdin.
squash_names() {
  sed -z "s/~$1\$/~HEAD/"
}

# The squash's own paths (header), planned against the head given (the pin,
# or the head the squash merged onto when main moved first): base,
# merged_tree, mt_conflict, plan_head, and ours with the paths the squash
# left unmerged. With no merge base, or a merge-tree that errs, it fails
# with plan_why set and changes nothing.
declare -A ours=() mt_conflict=()
unmerged=()
plan_head=""
plan_why=""
plan_squash() {
  local onto="$1" b mt_rc=0 p
  if ! b=$(git merge-base "$onto" "$lane_sha"); then
    plan_why="'$lane_branch' shares no history with main"
    return 1
  fi
  git merge-tree --write-tree -z --no-messages "$onto" "$lane_sha" > "$work/merge-tree" 2> "$work/merge-tree.err" || mt_rc=$?
  if [ "$mt_rc" -gt 1 ]; then
    plan_why="git merge-tree could not work out the squash of '$lane_branch' ($(head -n 1 "$work/merge-tree.err"))"
    return 1
  fi
  plan_head="$onto"
  base="$b"
  merged_tree=$(head -z -n 1 "$work/merge-tree" | tr -d '\0')
  merged_commit=""
  # The conflicted paths' stages, as git ls-files -s -z prints them.
  tail -z -n +2 "$work/merge-tree" | squash_names "$onto" > "$work/conflict-entries"
  load_entries "$work/conflict-entries" mt_conflict
  ours=([README.md]=1 [ARCHITECTURE.md]=1)
  for p in "${!mt_conflict[@]}" "${unmerged[@]}"; do ours["$p"]=1; done
  git diff --name-only -z --no-renames "$onto" "$merged_tree" | squash_names "$onto" > "$work/merged"
  add_ours "$work/merged"
  git diff --name-only -z --no-renames "$base" "$lane_sha" > "$work/lane"
  add_ours "$work/lane"
}

# The snapshot (header): own_list, and what the squash stages for it and for
# the docs.
take_snapshot() {
  local p
  own_list=()
  for p in "${!ours[@]}"; do
    case "$p" in
      README.md | ARCHITECTURE.md) ;;
      *) own_list+=("$p") ;;
    esac
  done
  expected_entries "${own_list[@]}" > "$work/own.snap"
  expected_entries "${docs[@]}" > "$work/docs.snap"
}

if ! plan_squash "$head_pin"; then
  echo "REFUSED: $plan_why; nothing was merged." >&2
  exit 1
fi

# A clean working tree is guaranteed above, so --squash stages only the merge.
# git takes index.lock before it writes anything, so a squash that waits out
# another git's lock and runs again is safe. main is checked just before it,
# so the squash's own run is the only window left for a commit to land in.
now=$(git rev-parse HEAD)
if [ "$now" != "$head_pin" ]; then
  echo "REFUSED: main moved before the squash ($(git log -1 --format='%h %s' "$now") landed from another window); nothing was staged or merged. Run the merge again." >&2
  exit 1
fi
squash_rc=0
git_retry merge --squash "$lane_sha" || { squash_rc=1; cat "$work/git.err" >&2; }

git diff --name-only --diff-filter=U -z > "$work/unmerged"
while IFS= read -r -d '' p; do
  unmerged+=("$p")
  ours["$p"]=1
  conflict_hash["$p"]=$(work_hash "$p")
done < "$work/unmerged"

# The head the squash merged onto: ORIG_HEAD, which git merge (--squash too)
# writes from its own read of HEAD before it merges, while it lies between
# the pin and HEAD; else HEAD. When it is not the pin, the squash is planned
# again against it, so the reset judges the index against the merge git made.
merged_onto=$(git rev-parse -q --verify ORIG_HEAD || true)
if [ -z "$merged_onto" ] || ! git merge-base --is-ancestor "$head_pin" "$merged_onto" ||
  ! git merge-base --is-ancestor "$merged_onto" HEAD; then
  merged_onto=$(git rev-parse HEAD)
fi
if [ "$merged_onto" != "$head_pin" ] && ! plan_squash "$merged_onto"; then
  echo "merge-lane: could not plan the squash again against $(git rev-parse --short "$merged_onto"), the head it merged onto ($plan_why); it is judged against the pin's plan." >&2
fi
take_snapshot
check_pin

if [ "$squash_rc" -ne 0 ]; then
  # ---- Step 5: a conflict confined to the generated sections is resolved ----
  if [ "${#unmerged[@]}" -eq 0 ]; then
    # A squash that failed with nothing unmerged wrote nothing: no reset.
    echo "REFUSED: squash-merge of '$lane_branch' failed (git's message is above); nothing was reset." >&2
    exit 1
  fi

  docs_only=1
  for p in "${unmerged[@]}"; do
    case "$p" in
      README.md | ARCHITECTURE.md) ;;
      *) docs_only=0 ;;
    esac
  done

  resolved=0
  if [ "$docs_only" -eq 1 ] && [ -f "$gen_docs" ]; then
    if node "$gen_docs" --generated-only --base "$base" --tip "$lane_sha"; then
      for p in "${unmerged[@]}"; do
        check_untouched "$p"
        if ! { git_retry checkout -q --ours -- "$p" && git_retry add -- "$p"; }; then
          case "$why" in "another git "*index.lock*) ;; *) cat -- "$work/git.err" >&2 ;; esac
          echo "REFUSED: could not take main's version of $p to resolve the squash of '$lane_branch' ($why)." >&2
          abandon_squash
        fi
        unset "conflict_hash[$p]"
        echo "merge-lane: $p conflicted only inside its generated sections; took main's version, regenerating below."
      done
      entries "${docs[@]}" > "$work/docs.snap"
      resolved=1
    fi
  fi

  if [ "$resolved" -eq 0 ]; then
    echo "REFUSED: squash-merge of '$lane_branch' hit a conflict in:" >&2
    for p in "${unmerged[@]}"; do
      echo "    $p" >&2
    done
    echo "  Resolve per the conflict-handling rule (both diffs + both plans);" >&2
    echo "  escalate to Dallas on any sensitive path or genuine ambiguity." >&2
    abandon_squash
  fi
fi

# ---- Step 6: nothing to merge -------------------------------------------------
# Nothing was staged, so nothing is reset; the guard and the prose check come
# first, so another window's staging is named rather than counted.
guard
prose_check
check_pin
if git diff --cached --quiet HEAD; then
  echo "REFUSED: nothing to merge from '$lane_branch' (no change past main)." >&2
  exit 1
fi

# ---- Step 7: regenerate the docs on the merged index --------------------------
if [ -f "$gen_docs" ]; then
  renders=0
  while :; do
    renders=$((renders + 1))
    if ! node "$gen_docs" --staged; then
      # A doc it wrote and could not stage is discarded by refuse_keeping.
      echo "REFUSED: regenerating README.md and ARCHITECTURE.md on the merged index failed (gen-docs.js says why above)." >&2
      abandon_squash
    fi
    entries "${docs[@]}" > "$work/docs.snap"
    guard
    [ "$unstaged" -eq 1 ] || break
    if [ "$renders" -ge 2 ]; then
      echo "REFUSED: another window staged files during both renders of the docs; they cannot be rendered without them." >&2
      abandon_squash
    fi
    echo "merge-lane: rendering the docs again without what was unstaged."
  done
  # The render keeps whatever prose the index held when it read it.
  prose_check
  check_pin
  if git diff --cached --quiet HEAD; then
    echo "REFUSED: nothing to merge from '$lane_branch' (its only change was inside the generated sections, which render as main's)." >&2
    exit 1
  fi
else
  echo "docs: the merged tree holds no $gen_docs; the generated sections were not regenerated."
fi

# ---- Step 8: the squash commit, from a private copy of the index -------------
# git commit re-reads the index after its hook, which takes seconds in os, so
# the commit is built from a copy taken after the guard instead.
check_pin
guard
commit_index="$work/index"
cp -- "$(git rev-parse --git-path index)" "$commit_index"
GIT_INDEX_FILE="$commit_index" find_foreign "$head_pin"
left_out=("${foreign[@]}")
if [ "${#left_out[@]}" -gt 0 ]; then
  GIT_INDEX_FILE="$commit_index" git --literal-pathspecs restore --staged --source="$head_pin" -- "${left_out[@]}"
  echo "merge-lane: left out of the commit, still staged for the window that staged it: $(joined "${left_out[@]}")."
fi
GIT_INDEX_FILE="$commit_index" find_moved
if [ "${#moved[@]}" -gt 0 ]; then
  echo "REFUSED: $(joined "${moved[@]}") changed in the index between the guard and the commit's copy of it; nothing is committed." >&2
  guard
  refuse_keeping
fi
# git commit-tree, unlike git commit, makes a commit whose tree is its
# parent's; the copy can come to that once what other windows staged is out.
if [ "$(GIT_INDEX_FILE="$commit_index" git write-tree)" = "$(git rev-parse "$head_pin^{tree}")" ]; then
  echo "REFUSED: nothing to merge from '$lane_branch' (the commit's tree equals main's: nothing of the lane is left to commit once what other windows staged is set aside)." >&2
  guard
  refuse_keeping
fi

# What git commit -m does, step by step (header), so that main moves only by
# a compare-and-swap from the pin. The author is exported as git commit does.
commit_msg="merge(lane ${lane_name}): ${plan_link}"
dates_set="${GIT_AUTHOR_DATE+a}${GIT_COMMITTER_DATE+c}"
ident=$(git var GIT_AUTHOR_IDENT)
GIT_AUTHOR_NAME="${ident%% <*}"
ident="${ident#* <}"
GIT_AUTHOR_EMAIL="${ident%%>*}"
GIT_AUTHOR_DATE="@${ident#*> }"
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_AUTHOR_DATE
# The committer's date, stamped before the hooks as git commit stamps it: one
# now with the author's unless a date was set in the environment, else what
# git var says. Passed to git commit-tree alone; git commit exports it to the
# hooks only when it was set.
committer_date="$GIT_AUTHOR_DATE"
if [ -n "$dates_set" ]; then
  ident=$(git var GIT_COMMITTER_IDENT)
  committer_date="@${ident#*> }"
fi
# MERGE_LANE_COMMIT names the copy, so gen-docs.js never judges a pathspec.
run_hook() {
  GIT_INDEX_FILE="$commit_index" MERGE_LANE_COMMIT="$commit_index" GIT_EDITOR=: git hook run --ignore-missing "$1" -- "${@:2}"
}
hook_refused() {
  if check_carried; then
    echo "  The $1 hook had refused the squash commit (its output is above)." >&2
    guard
    refuse_keeping
  fi
  echo "REFUSED: the $1 hook refused the squash commit (its output is above); nothing is committed, and the squash is left staged, as before this step." >&2
  exit 1
}
GIT_INDEX_FILE="$commit_index" git update-index -q --refresh > /dev/null || true
run_hook pre-commit || hook_refused pre-commit
tree=$(GIT_INDEX_FILE="$commit_index" git write-tree)
cleanup=$(git config --get commit.cleanup || true)
printf '%s\n' "${commit_msg%$'\n'}" > "$work/msg.raw"
if [ "$cleanup" = verbatim ]; then cp -- "$work/msg.raw" "$work/msg"; else git stripspace < "$work/msg.raw" > "$work/msg"; fi
run_hook prepare-commit-msg "$work/msg" message || hook_refused prepare-commit-msg
run_hook commit-msg "$work/msg" || hook_refused commit-msg
case "$cleanup" in
  verbatim) cp -- "$work/msg" "$work/msg.final" ;;
  strip) git stripspace --strip-comments < "$work/msg" > "$work/msg.final" ;;
  *) git stripspace < "$work/msg" > "$work/msg.final" ;;
esac
[ -s "$work/msg.final" ] || hook_refused commit-msg
sign=()
[ "$(git config --type=bool --get commit.gpgsign || true)" != true ] || sign=(-S)
new=$(GIT_COMMITTER_DATE="$committer_date" git commit-tree "${sign[@]}" -p "$head_pin" -F "$work/msg.final" "$tree")

# The belt, before main moves (it never trips; it says so loudly if it does).
git diff-tree --name-only --no-renames -r -z "$head_pin" "$new" > "$work/committed"
extra=()
while IFS= read -r -d '' p; do
  [ -n "${ours[$p]+set}" ] || extra+=("$p")
done < "$work/committed"
if [ "${#extra[@]}" -gt 0 ]; then
  echo "REFUSED: the squash commit would carry paths that are not the squash's own: $(joined "${extra[@]}"); it is not made, and main is where it was." >&2
  guard
  refuse_keeping
fi
if ! git update-ref -m "commit: $(head -n 1 "$work/msg.final")" refs/heads/main "$new" "$head_pin" 2> "$work/ref.err"; then
  check_carried || echo "REFUSED: main moved under the commit, another window committed ($(head -n 1 "$work/ref.err")); the squash commit is not made and nothing of the lane is on main. Run the merge again." >&2
  guard
  refuse_keeping
fi
rm -f -- "$(git rev-parse --git-path SQUASH_MSG)" "$(git rev-parse --git-path MERGE_MSG)"
run_hook post-commit || true
git --no-pager log -1 --format='[main %h] %s' "$new"
git --no-pager diff --shortstat "$head_pin" "$new"

# After the commit, the shared index against it: a lane path still at the
# pin's entry (another window unstaged it during the hook, a staged revert of
# the merge) is put back; the rest is that window's, named once.
git diff --cached --name-only -z --no-renames "$new" > "$work/late"
late=()
late_own=()
declare -A named=()
for p in "${left_out[@]}"; do named["$p"]=1; done
while IFS= read -r -d '' p; do
  if [ -n "${ours[$p]+set}" ]; then
    late_own+=("$p")
  elif [ -z "${named[$p]+set}" ]; then
    late+=("$p")
  fi
done < "$work/late"
declare -A pinned=()
load_head pinned "$head_pin" "${late_own[@]}"
put_back=()
late_moved=()
for p in "${late_own[@]}"; do
  if [ "$(entry_now "$p")" != "${pinned[$p]-}" ]; then
    late_moved+=("$p")
  elif git_retry --literal-pathspecs restore -q --staged --source="$new" -- "$p"; then
    put_back+=("$p")
  else
    echo "merge-lane: could not put back $p at the merge's entry ($why); run git restore --staged -- $p before any other commit, or that commit carries a revert of the merge." >&2
  fi
done
[ "${#put_back[@]}" -eq 0 ] || echo "merge-lane: put back at the merge's entry in the index: $(joined "${put_back[@]}") (another window unstaged it during the commit; its working file is as that window left it)."
[ "${#late_moved[@]}" -eq 0 ] || echo "merge-lane: changed in the index by another window during the commit, left staged for it: $(joined "${late_moved[@]}")."
[ "${#late[@]}" -eq 0 ] || echo "merge-lane: staged by another window during the commit, left staged for it: $(joined "${late[@]}")."

# ---- Step 9: per-lane review must re-run before worktree removal --------------
echo
echo "Squash-merged '${lane_branch}' into main as ONE commit:"
echo "  ${commit_msg}"
echo
echo "NEXT: re-run this lane's per-lane review against the NEW main HEAD."
echo "  'Verifies clean' = no conflict AND review re-confirmed (not just no conflict)."
echo "  Do NOT remove the lane worktree until that review re-confirms clean."

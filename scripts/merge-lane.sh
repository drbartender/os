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
#
# Behavior, in order:
#   1. Acquire an EXCLUSIVE flock on .git/merge-lane.lock. flock is chosen on
#      purpose because the lock auto-releases when the holding process dies, so a
#      crashed or killed merge can never wedge every future merge. A second
#      concurrent invocation waits behind the first instead of racing main.
#   2. Refuse unless run from the primary (os) worktree AND branch is main.
#   3. Refuse on a dirty working tree (commit or stash the quick fix first).
#   4. Resolve <lane-branch> to one commit, once, list the squash's own paths
#      (below), git merge --squash that commit, and snapshot the index entries
#      of those paths, so a lane commit landing mid-merge changes nothing here.
#   5. On a conflict in the squash: when every unmerged path is README.md or
#      ARCHITECTURE.md and `node scripts/gen-docs.js --generated-only --base
#      <merge-base of main and the lane> --tip <that commit>` exits 0 (the lane
#      changed those docs only inside their generated sections), take main's
#      version of each (git checkout --ours, then git add) and go on: step 7
#      renders the sections again from the merged index, so nothing the lane
#      wrote by hand is dropped. Any other conflict refuses, naming the
#      unmerged paths, and resets the squash state, path by path (below). A
#      squash that failed with nothing unmerged wrote nothing and refuses with
#      no reset.
#      Each conflicted file's working copy is hashed right after the squash;
#      when one changed since (another window edited it), the checkout --ours
#      and the reset, which would overwrite it, refuse instead and touch
#      nothing, leaving the squash in place.
#   6. The guard and the prose check (below), then: when the index equals
#      HEAD (a branch at main, a lane already merged, a generated-only
#      conflict that was the lane's only change), refuse "nothing to merge"
#      with nothing to reset, before the regeneration could commit the docs
#      alone under the lane's name.
#   7. node scripts/gen-docs.js --staged: render the docs' generated sections
#      from the merged index and stage them, so the squash commit carries
#      sections current with the code it merges (a lane and main that each
#      added a file both show in the tree). Skipped, with one line, when the
#      merged tree holds no scripts/gen-docs.js. A failure refuses and resets
#      the squash state, the guard first. The guard runs after each render;
#      when it unstaged another window's file (which the render may hold),
#      the docs are rendered once more, and a second time refuses and resets.
#      The prose check runs after the renders. When the index then equals
#      HEAD (the lane's only change was inside the generated sections),
#      refuse "nothing to merge" as in step 6.
#   8. The guard once more, then the single squash commit, hooks running,
#      whose message carries the lane name + plan link so the push inventory
#      stays legible: "merge(lane <lane-name>): <plan-link>". git commit
#      re-reads the index after the hook, so the commit reads a private copy
#      of the shared index, taken after the guard, through GIT_INDEX_FILE (the
#      hook gets the same, as on a pathspec commit): a path staged since the
#      guard that is not the squash's own is dropped from the copy, and an own
#      entry that moved refuses. After it, a belt: a commit holding a path
#      that is not the squash's own refuses loudly (it never should); what
#      another window staged into the shared index while the commit ran stays
#      staged there for it, named.
#   9. Print a notice that the lane's per-lane review MUST be re-run against the
#      new HEAD before the worktree is removed. "Verifies clean" means no
#      conflict AND review re-confirmed. The worktree is NOT auto-removed here.
#
# Another window's staging: the os checkout is shared, and other windows stage
# into its one index while a merge runs. The squash's own paths are what `git
# merge-tree --write-tree` of main and the lane changes against HEAD (a rename
# main made is followed there, as the squash follows it), the paths it reports
# conflicted, the lane's own changes since the merge base, and README.md and
# ARCHITECTURE.md. Their index entries are snapshotted right after the squash,
# the docs' entries again after the self-resolution and after each render,
# the steps that change them on purpose. Before the reset and before the
# commit (and after each render), the guard: (a) every path staged
# against HEAD that is not one of the squash's own was staged by another
# window during the merge; `git restore --staged` takes it out of the index
# with its content kept on disk (a new file becomes untracked, an edit an
# unstaged change) and one line names each; (b) when one of the squash's own
# entries no longer matches the snapshot, the merge refuses and commits
# nothing: the entries that moved stay staged for the window that staged them
# and every other own path goes back to HEAD by the scoped reset (below), so
# the lane is out of the shared index and that window's next commit carries
# only its own change; the refusal names both lists. A regeneration that
# failed after it staged the docs lands there too: its staging cannot be told
# from a doc another window staged. The docs are always the squash's own and
# their snapshot is read back from the index, so a prose edit another window
# staged to one before a snapshot (between the dirty-tree check and the squash,
# or in the render window, where the render keeps it) would pass the guard;
# the docs are therefore also judged by their prose against the merge result:
# right after the squash (once no conflict is unresolved) and after the
# renders, `gen-docs.js --generated-only` between the merge-tree result and
# the index (each written into a throwaway commit object, no ref) must find
# the docs differ only inside the generated sections. A doc whose prose moved
# refuses: it stays staged with that prose for the window that staged it,
# every other own path goes back to HEAD, and the refusal says how to keep the
# prose (git restore --staged -- <doc>, then that window commits it by
# pathspec, then the merge runs again).
#
# Resetting the squash state: a refusal after the squash runs the guard, then
# the scoped reset, which puts the squash's own staged paths back at HEAD one
# path at a time and never runs a reset, checkout or restore without a
# pathspec, so no other window's path can be reached whatever the timing: a
# path in HEAD is restored from HEAD in the index, and on disk too while its
# working file is still what the squash staged (else the file is kept and
# named); a path the lane added leaves the index, and its working file is
# deleted only while it still holds the staged content; a conflicted path, its
# working copy checked unchanged first, is restored from HEAD, or removed when
# HEAD has none. SQUASH_MSG and MERGE_MSG go last. HEAD never moves. The
# refusal says what it reset, what it left staged or kept, and whether the
# tree is back at HEAD. A pre-commit hook that refuses the squash commit (step
# 8) leaves the squash staged, as before this step.
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

# The generator and every path git names below are read from the repo root.
cd "$toplevel"

# ---- Step 3: never merge into a dirty tree -----------------------------------
if [ -n "$(git status --porcelain)" ]; then
  echo "REFUSED: working tree is dirty. Never merge into a dirty tree." >&2
  echo "  Commit or stash your quick fix first, then re-run the merge." >&2
  echo "  (git status to see what is uncommitted.)" >&2
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
# listing in file $1: path -> its entries (mode, id and stage, one per stage).
load_entries() {
  local -n into="$2"
  local rec
  into=()
  while IFS= read -r -d '' rec; do
    into["${rec#*$'\t'}"]+="${rec%%$'\t'*};"
  done < "$1"
}

# Sets moved to the squash's own paths whose index entries differ from the
# snapshot (see "Another window's staging" in the header).
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

# Sets foreign to the paths staged against HEAD (in whichever index
# GIT_INDEX_FILE names) that are not the squash's own.
foreign=()
find_foreign() {
  local p
  foreign=()
  git diff --cached --name-only -z --no-renames HEAD > "$work/staged"
  while IFS= read -r -d '' p; do
    [ -n "${ours[$p]+set}" ] || foreign+=("$p")
  done < "$work/staged"
}

# The guard (see "Another window's staging" in the header): unstages, with its
# content kept on disk, every path staged against HEAD that is not one of the
# squash's own (unstaged=1 when it did), then, when one of the squash's own
# entries moved since the snapshot, refuses: the moved entries stay staged for
# the window that staged them and every other own path goes back to HEAD.
unstaged=0
kept_foreign=0
guard() {
  unstaged=0
  find_foreign
  if [ "${#foreign[@]}" -gt 0 ]; then
    if ! git --literal-pathspecs restore --staged -- "${foreign[@]}"; then
      echo "REFUSED: could not unstage what another window staged during the merge: $(joined "${foreign[@]}")." >&2
      echo "  Nothing was reset or committed; the squash is left staged as it is (git status)." >&2
      exit 1
    fi
    echo "merge-lane: unstaged $(joined "${foreign[@]}"): staged by another window during the merge, its content kept on disk."
    unstaged=1
    kept_foreign=1
  fi
  find_moved
  if [ "${#moved[@]}" -gt 0 ]; then
    echo "REFUSED: $(joined "${moved[@]}") changed in the index under the merge (another window, or a regeneration that failed after it staged); nothing is committed." >&2
    refuse_keeping "${moved[@]}"
  fi
}

# The working copy of each conflicted path, hashed right after the squash,
# while it is still unresolved: git checkout --ours and the reset of a
# conflicted path both overwrite its working copy, so an edit another window
# makes to one during the merge must stop them. A path resolved on purpose
# leaves the table.
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

in_head() {
  git cat-file -e "HEAD:$1" 2>/dev/null
}

# The scoped reset (see "Resetting the squash state" in the header): puts the
# squash's own staged paths back at HEAD one path at a time, never with a
# reset, checkout or restore that has no pathspec, skipping the paths given
# (left staged for the window that staged them). Fills reset_list, kept_disk
# (a working file kept because it is no longer what the squash staged) and
# reset_failed.
reset_list=()
kept_disk=()
reset_failed=()
scoped_reset() {
  local -A skip=()
  local p blob
  for p in "$@"; do skip["$p"]=1; done
  git diff --cached --name-only -z --no-renames HEAD > "$work/undo"
  while IFS= read -r -d '' p; do
    [ -n "${ours[$p]+set}" ] || continue
    [ -z "${skip[$p]+set}" ] || continue
    reset_list+=("$p")
    if [ -n "${conflict_hash[$p]+set}" ]; then
      # A conflicted path, its working copy checked unchanged since the squash.
      if in_head "$p"; then
        git --literal-pathspecs restore -q --staged --worktree --source=HEAD -- "$p" || reset_failed+=("$p")
      else
        { git --literal-pathspecs rm -q --cached -- "$p" && rm -f -- "$p"; } || reset_failed+=("$p")
      fi
    elif ! blob=$(git rev-parse -q --verify ":0:$p"); then
      # The squash removed it: restore it, on disk only when nothing is there.
      if [ -e "$p" ]; then
        git --literal-pathspecs restore -q --staged --source=HEAD -- "$p" || reset_failed+=("$p")
        kept_disk+=("$p")
      else
        git --literal-pathspecs restore -q --staged --worktree --source=HEAD -- "$p" || reset_failed+=("$p")
      fi
    elif in_head "$p"; then
      if [ "$(work_hash "$p")" = "$blob" ]; then
        git --literal-pathspecs restore -q --staged --worktree --source=HEAD -- "$p" || reset_failed+=("$p")
      else
        git --literal-pathspecs restore -q --staged --source=HEAD -- "$p" || reset_failed+=("$p")
        kept_disk+=("$p")
      fi
    else
      # The lane added it: out of the index, off the disk while still its content.
      if git --literal-pathspecs restore -q --staged -- "$p"; then
        if [ "$(work_hash "$p")" = "$blob" ]; then rm -f -- "$p"; else kept_disk+=("$p"); fi
      else
        reset_failed+=("$p")
      fi
    fi
  done < "$work/undo"
  rm -f -- "$(git rev-parse --git-path SQUASH_MSG)" "$(git rev-parse --git-path MERGE_MSG)"
}

# After a REFUSED line: the scoped reset of every own path except those given
# (left staged for the window that staged them), what it did, and exit 1.
refuse_keeping() {
  scoped_reset "$@"
  [ "${#reset_list[@]}" -eq 0 ] || echo "  Reset to HEAD: $(joined "${reset_list[@]}")." >&2
  [ "$#" -eq 0 ] || echo "  Left staged for the window that staged it: $(joined "$@")." >&2
  [ "${#kept_disk[@]}" -eq 0 ] || echo "  Kept on disk, unstaged, since its working file changed during the merge: $(joined "${kept_disk[@]}")." >&2
  if [ "${#reset_failed[@]}" -gt 0 ]; then
    echo "  Could not reset $(joined "${reset_failed[@]}"); read git status before the next merge." >&2
  elif [ -z "$(git status --porcelain)" ]; then
    echo "  Nothing was merged: the index and the working tree are back at HEAD." >&2
  elif [ "$#" -eq 0 ] && [ "$kept_foreign" -eq 1 ]; then
    echo "  Nothing was merged: the squash is reset, and what another window staged is kept on disk, unstaged (named above)." >&2
  else
    echo "  Nothing of the lane is left in the index; read git status before the next merge." >&2
  fi
  exit 1
}

# The prose check (see "Another window's staging" in the header): outside the
# generated sections, the docs in the index must read as in the merge result.
# gen-docs.js reads commits, so the merge result and the index each go into a
# throwaway commit object (no ref points at either). Skipped while a conflict
# is unresolved; without the generator, the docs must equal the merge
# result's outright. A doc whose prose moved refuses, left staged with that
# prose for the window that staged it; every other own path is reset.
merged_commit=""
prose_check() {
  [ "${#conflict_hash[@]}" -eq 0 ] || return 0
  local tree tip d prose_moved=()
  tree=$(git write-tree)
  if [ -f "$gen_docs" ]; then
    if [ -z "$merged_commit" ]; then
      merged_commit=$(git commit-tree --no-gpg-sign -p HEAD -m "merge-lane: the merge result" "$merged_tree")
    fi
    tip=$(git commit-tree --no-gpg-sign -p HEAD -m "merge-lane: the index" "$tree")
    if node "$gen_docs" --generated-only --base "$merged_commit" --tip "$tip" > "$work/prose" 2>&1; then
      return 0
    fi
    while IFS= read -r d; do
      prose_moved+=("$d")
    done < <(sed -n 's/^generated-only: \(.*\) differs outside the generated sections$/\1/p' "$work/prose")
    if [ "${#prose_moved[@]}" -eq 0 ]; then
      cat "$work/prose" >&2
      echo "REFUSED: the docs' prose could not be checked against the merge result (above); nothing is committed." >&2
      refuse_keeping "${docs[@]}"
    fi
  else
    for d in "${docs[@]}"; do
      [ "$(git rev-parse -q --verify "$merged_tree:$d" || true)" = "$(git rev-parse -q --verify "$tree:$d" || true)" ] || prose_moved+=("$d")
    done
    [ "${#prose_moved[@]}" -gt 0 ] || return 0
  fi
  echo "REFUSED: a prose edit to $(joined "${prose_moved[@]}") was staged by another window during the merge; nothing is committed, and that doc is left staged with that prose." >&2
  echo "  To keep the prose: git restore --staged -- <doc> leaves it on disk, unstaged; that window commits it as its own change by pathspec; then run the merge again." >&2
  refuse_keeping "${prose_moved[@]}"
}

# Resets the squash state after a REFUSED line, once the conflicted files and
# the guard let it, and exits 1.
abandon_squash() {
  check_untouched "${!conflict_hash[@]}"
  guard
  refuse_keeping
}

# ---- Step 4: squash-merge as ONE clean commit --------------------------------
# The branch is read once: the squash and the generated-only check judge the
# same commit even when a lane commit lands mid-merge (the message keeps the
# branch name).
if ! lane_sha=$(git rev-parse --verify -q "${lane_branch}^{commit}"); then
  echo "REFUSED: '$lane_branch' names no commit; nothing was merged." >&2
  exit 1
fi
if ! base=$(git merge-base HEAD "$lane_sha"); then
  echo "REFUSED: '$lane_branch' shares no history with main; nothing was merged." >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# The squash's own paths (see "Another window's staging" in the header): what
# git merge-tree says the squash changes against HEAD (a rename main made is
# followed there, as the squash follows it), the paths it reports conflicted,
# the lane's own changes since the merge base, and the two docs.
declare -A ours=([README.md]=1 [ARCHITECTURE.md]=1)
add_ours() {
  local p
  while IFS= read -r -d '' p; do
    [ -z "$p" ] || ours["$p"]=1
  done < "$1"
}
mt_rc=0
git merge-tree --write-tree --name-only -z --no-messages HEAD "$lane_sha" > "$work/merge-tree" 2> "$work/merge-tree.err" || mt_rc=$?
if [ "$mt_rc" -gt 1 ]; then
  echo "REFUSED: git merge-tree could not work out the squash of '$lane_branch' ($(head -n 1 "$work/merge-tree.err")); nothing was merged." >&2
  exit 1
fi
merged_tree=$(head -z -n 1 "$work/merge-tree" | tr -d '\0')
tail -z -n +2 "$work/merge-tree" > "$work/conflicted"
add_ours "$work/conflicted"
git diff --name-only -z --no-renames HEAD "$merged_tree" > "$work/merged"
add_ours "$work/merged"
git diff --name-only -z --no-renames "$base" "$lane_sha" > "$work/lane"
add_ours "$work/lane"

# A clean working tree is guaranteed above, so --squash stages only the merge.
squash_rc=0
git merge --squash "$lane_sha" || squash_rc=$?

unmerged=()
git diff --name-only --diff-filter=U -z > "$work/unmerged"
while IFS= read -r -d '' p; do
  unmerged+=("$p")
  ours["$p"]=1
  conflict_hash["$p"]=$(work_hash "$p")
done < "$work/unmerged"

# The snapshot: the index entries of the squash's own paths right after the
# squash, the docs' part again after each step that changes them on purpose.
own_list=()
for p in "${!ours[@]}"; do
  case "$p" in
    README.md | ARCHITECTURE.md) ;;
    *) own_list+=("$p") ;;
  esac
done
entries "${own_list[@]}" > "$work/own.snap"
entries "${docs[@]}" > "$work/docs.snap"

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
        if ! { git checkout -q --ours -- "$p" && git add -- "$p"; }; then
          echo "REFUSED: could not take main's version of $p to resolve the squash of '$lane_branch'." >&2
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
# A lane with no change past main (a branch at main, or a lane already merged)
# staged nothing: refuse before the regeneration could commit docs alone under
# the lane's name. Nothing was staged, so nothing is reset; the guard and the
# prose check first, so another window's staging is named rather than counted.
guard
prose_check
if git diff --cached --quiet HEAD; then
  echo "REFUSED: nothing to merge from '$lane_branch' (no change past main)." >&2
  exit 1
fi

# ---- Step 7: regenerate the docs on the merged index --------------------------
# The docs' snapshot is retaken after each render, which changes them on
# purpose. A file another window staged while the generator ran may be in the
# render, so when the guard after it unstages one, the docs are rendered once
# more without it; a second render it has to clean up after refuses.
if [ -f "$gen_docs" ]; then
  renders=0
  while :; do
    renders=$((renders + 1))
    if ! node "$gen_docs" --staged; then
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
  # A lane whose only change was inside the generated sections renders as
  # main's: nothing is left to merge, and the index and the docs are at HEAD.
  if git diff --cached --quiet HEAD; then
    echo "REFUSED: nothing to merge from '$lane_branch' (its only change was inside the generated sections, which render as main's)." >&2
    exit 1
  fi
else
  echo "docs: the merged tree holds no $gen_docs; the generated sections were not regenerated."
fi

# ---- Step 8: the squash commit, from a private copy of the index -------------
# git commit re-reads the index after the pre-commit hook, which takes seconds
# in os, so a file another window staged meanwhile would ride into the commit.
# The commit reads a private copy instead, taken after the guard, through
# GIT_INDEX_FILE (what a pathspec commit already gives the hook). In the copy,
# a path staged since the guard that is not the squash's own is dropped (the
# shared index keeps it staged for its window), and the copy's own entries
# must still be the snapshot's.
guard
commit_index="$work/index"
cp -- "$(git rev-parse --git-path index)" "$commit_index"
GIT_INDEX_FILE="$commit_index" find_foreign
if [ "${#foreign[@]}" -gt 0 ]; then
  GIT_INDEX_FILE="$commit_index" git --literal-pathspecs restore --staged -- "${foreign[@]}"
  echo "merge-lane: left out of the commit, still staged for the window that staged it: $(joined "${foreign[@]}")."
fi
GIT_INDEX_FILE="$commit_index" find_moved
if [ "${#moved[@]}" -gt 0 ]; then
  echo "REFUSED: $(joined "${moved[@]}") changed in the index between the guard and the commit's copy of it; nothing is committed." >&2
  guard
  refuse_keeping
fi
commit_msg="merge(lane ${lane_name}): ${plan_link}"
GIT_INDEX_FILE="$commit_index" git commit -m "$commit_msg"
rm -f -- "$(git rev-parse --git-path SQUASH_MSG)"

# The belt: the commit carries only the squash's own paths (with the private
# copy this never trips; it says so loudly if it ever does).
git diff-tree --no-commit-id --name-only --no-renames -r -z HEAD > "$work/committed"
extra=()
while IFS= read -r -d '' p; do
  [ -n "${ours[$p]+set}" ] || extra+=("$p")
done < "$work/committed"
if [ "${#extra[@]}" -gt 0 ]; then
  echo "REFUSED AFTER THE COMMIT: $(git rev-parse --short HEAD) carries paths that are not the squash's own: $(joined "${extra[@]}"). Revert it (git revert HEAD) or fix it by hand before anything else." >&2
  exit 1
fi
# What another window staged into the shared index while the commit ran stays
# staged there for it.
git diff --cached --name-only -z --no-renames HEAD > "$work/late"
late=()
while IFS= read -r -d '' p; do
  late+=("$p")
done < "$work/late"
if [ "${#late[@]}" -gt 0 ]; then
  echo "merge-lane: staged by another window during the commit, left staged for it: $(joined "${late[@]}")."
fi

# ---- Step 9: per-lane review must re-run before worktree removal --------------
echo
echo "Squash-merged '${lane_branch}' into main as ONE commit:"
echo "  ${commit_msg}"
echo
echo "NEXT: re-run this lane's per-lane review against the NEW main HEAD."
echo "  'Verifies clean' = no conflict AND review re-confirmed (not just no conflict)."
echo "  Do NOT remove the lane worktree until that review re-confirms clean."

#!/usr/bin/env bash
# vercel-ignore.sh: the client project's Ignored Build Step on Vercel. It
# cancels a deployment when every file changed since the last successful
# deployment is docs-only, and builds every other one (instruction rewrite
# spec 2026-10-19, sections 4.7 and 4.9; plan 2026-10-28 step 5, lane
# vercel-ignore).
#
# How Vercel runs it: client/vercel.json's ignoreCommand,
# `bash scripts/vercel-ignore.sh`, run from the project's Root Directory
# (client/) before the build, in a clone made with --depth=10. git finds the
# repository from client/'s parent and prints repo-relative paths, so the range
# judged covers the whole repository, not client/ alone.
#
# The range is VERCEL_GIT_PREVIOUS_SHA to HEAD: the last successful
# deployment's sha for the branch (Vercel exposes it to this step alone; it is
# empty on a first deployment) through the commit being deployed, so the whole
# deployed range is judged, never the last commit alone. The allowlist is
# scripts/sensitive-match.js's DOCS_ALLOWLIST minus its two hinge docs:
# docs/** except docs/money-laws.md and docs/runbooks/**, plus README.md and
# ARCHITECTURE.md exactly, each path judged as git prints it.
#
# Exit convention: 0 cancels the build, 1 builds, and every failure builds.
# Exactly one line on stdout, the first rule that applies:
#   the variable unset or empty        built: no previous deployment sha
#   no repository to diff in           built: git diff failed (no repository)
#   no commit sha the clone holds      built: previous sha not in the clone
#   git diff fails                     built: git diff failed (exit <n>)
#   an empty diff (a redeploy)         built: no change since the previous deployment (a redeploy)
#   a path off the allowlist           built: <path> is not docs-only
#   every path on it                   cancelled: docs-only since <sha7>, <n> files
# git's own stderr may follow on stderr. The script reads no other environment
# variable, no secret and no network, and works on the repository of the
# directory it is run from, never on its own location.
#
# Usage, as Vercel runs it, from client/:
#   VERCEL_GIT_PREVIOUS_SHA=<sha> bash scripts/vercel-ignore.sh
# The suite is scripts/vercel-ignore.test.js (throwaway repos, the variable set
# by hand).

# -u only, never -e: every failure is caught below and turned into a build.
set -u

sha=${VERCEL_GIT_PREVIOUS_SHA:-}
if [ -z "$sha" ]; then
  echo 'built: no previous deployment sha'
  exit 1
fi

# No repository: the diff is never started, because outside a repository git
# diff turns into --no-index and compares two files named by its arguments.
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo 'built: git diff failed (no repository)'
  exit 1
fi

# A value that is not the hex sha of a commit the clone holds: older than the
# clone's depth, a tree or a blob, or not hex at all (a ref name, a path, an
# option-shaped string), so the diff below only ever reads a verified commit.
if ! [[ $sha =~ ^[0-9a-fA-F]{4,64}$ ]] || ! git cat-file -e "$sha^{commit}" 2>/dev/null; then
  echo 'built: previous sha not in the clone'
  exit 1
fi

# core.quotePath=false prints a non-ASCII path raw; a path git still quotes (a
# double quote, a backslash or a control character in it) opens with a quote,
# matches no allowlist entry and builds. --no-renames shows a rename as its
# deletion and its addition, so a move out of client/ into docs/ builds.
# diff.relative=false keeps the paths repo-relative whatever the config says.
changed=$(git -c core.quotePath=false -c diff.relative=false diff --name-only --no-renames "$sha" HEAD)
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "built: git diff failed (exit $rc)"
  exit 1
fi
if [ -z "$changed" ]; then
  echo 'built: no change since the previous deployment (a redeploy)'
  exit 1
fi

n=0
while IFS= read -r p; do
  case "$p" in
    docs/money-laws.md | docs/runbooks/*) on_list=no ;;
    docs/*) on_list=yes ;;
    README.md | ARCHITECTURE.md) on_list=yes ;;
    *) on_list=no ;;
  esac
  if [ "$on_list" != yes ]; then
    echo "built: $p is not docs-only"
    exit 1
  fi
  n=$((n + 1))
done <<< "$changed"

echo "cancelled: docs-only since ${sha:0:7}, $n files"
exit 0

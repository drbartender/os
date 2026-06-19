#!/usr/bin/env bash
set -euo pipefail
branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = "main" ] && exit 0
common=$(git rev-parse --path-format=absolute --git-common-dir)
primary=$(dirname "$common")
toplevel=$(git rev-parse --show-toplevel)
staged=$(git diff --cached --name-only)
if [ "$toplevel" = "$primary" ]; then
  echo "BLOCKED: os worktree is on '$branch', not main. os must never leave main."; exit 1
fi
if echo "$staged" | grep -Eq '^docs/superpowers/(specs|plans)/'; then
  echo "BLOCKED: spec/plan docs may only be committed on main (branch '$branch')."; exit 1
fi
exit 0

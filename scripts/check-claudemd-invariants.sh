#!/usr/bin/env bash
# Mechanical coverage check for the CLAUDE.md rewrite (workflow-redesign L8).
# For each invariant in claudemd-invariants.txt, the doc MUST match the paired
# regex. Coarse and necessary-not-sufficient (proves the rule's substance is
# present, not just a keyword); a consistency agent does the semantic check.
# Usage: bash scripts/check-claudemd-invariants.sh [path-to-CLAUDE.md]
set -euo pipefail
DOC="${1:-.claude/CLAUDE.md}"
MANIFEST="$(cd "$(dirname "$0")" && pwd)/claudemd-invariants.txt"
[ -f "$DOC" ] || { echo "doc not found: $DOC"; exit 2; }
[ -f "$MANIFEST" ] || { echo "manifest not found: $MANIFEST"; exit 2; }
fail=0
count=0
while read -r key regex; do
  [ -z "${key:-}" ] && continue
  case "$key" in \#*) continue ;; esac
  count=$((count + 1))
  if ! grep -iEq -- "$regex" "$DOC"; then
    echo "MISSING [$key]: no line in $DOC matches /$regex/"
    fail=1
  fi
done < "$MANIFEST"
if [ "$fail" -eq 0 ]; then
  echo "OK: all $count invariants present in $DOC"
fi
exit "$fail"

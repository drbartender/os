#!/usr/bin/env bash
# Mechanical coverage check for the CLAUDE.md rewrite (workflow-redesign L8).
# For each invariant in claudemd-invariants.txt, the doc MUST match the paired
# regex. Coarse and necessary-not-sufficient (proves the rule's substance is
# present, not just a keyword); a consistency agent does the semantic check.
# Usage: bash scripts/check-claudemd-invariants.sh [path-to-CLAUDE.md] [--additive-against <ref>]
#
# The manifest is read from beside this script, a rule per line as "<key>
# <extended-regex>" split on the first run of whitespace; a line whose first
# non-blank character is # is a comment. A malformed manifest refuses with
# exit 2 instead of passing: a key with no pattern, a key that appears twice, a
# pattern that matches an empty line (an empty alternative, .*, ^, x* and their kin: it would match
# every line), a pattern grep cannot parse, or a manifest that yields no key
# at all; the MALFORMED line goes to stderr and names the copy.
# A last line without a trailing newline is read like any other.
#
# --additive-against <ref> (the pre-commit hook passes HEAD; instruction
# rewrite step 5, lane invariants-manifest): the manifest the commit is made
# from may only ADD keys compared with <ref>'s copy. In this mode both copies
# come from git, never from the disk: the ref's from `git show <ref>:scripts/
# claudemd-invariants.txt` and the commit's from the index (`git show
# :scripts/claudemd-invariants.txt`, which under a hook is the index the
# commit is made from: the pathspec temp index, or the merge script's private
# copy, through GIT_INDEX_FILE), so another window's unstaged edit never
# refuses a commit and a staged removal never passes on a restored disk copy.
# git runs with -C at the repository top (the parent of this script's
# directory, since the script lives in scripts/), which also keeps a hook in a
# linked worktree right: git hands a hook GIT_DIR with no GIT_WORK_TREE, so a
# repository walk from scripts/ would name scripts/ as the top. A key <ref>
# has that the commit's manifest lacks, or whose pattern differs, refuses with
# exit 1 as REMOVED [key] or CHANGED [key], so a commit that stages CLAUDE.md
# cannot loosen the net it is judged by; a pattern change lands in a commit of
# its own that stages no CLAUDE.md (spec 2026-10-19 section 6.3: the manifest
# is edited before the rewrite, not with it). <ref> or the index lacking the
# manifest refuses (exit 2).
# Exit codes: 0 every invariant present (and nothing removed or changed), 1 a
# MISSING, REMOVED or CHANGED key, 2 a malformed manifest or a usage problem.
set -euo pipefail
DOC=".claude/CLAUDE.md"
REF=""
while [ $# -gt 0 ]; do
  case "$1" in
    --additive-against) [ $# -ge 2 ] && [ -n "$2" ] || { echo "--additive-against needs a ref (an empty one is a usage error, never a skipped check)"; exit 2; }; REF=$2; shift 2 ;;
    --*) echo "unknown flag: $1"; exit 2 ;;
    *) DOC=$1; shift ;;
  esac
done
HERE="$(cd "$(dirname "$0")" && pwd -P)"
MANIFEST="$HERE/claudemd-invariants.txt"
[ -f "$DOC" ] || { echo "doc not found: $DOC"; exit 2; }
[ -f "$MANIFEST" ] || { echo "manifest not found: $MANIFEST"; exit 2; }

# Print one "key<TAB>regex" line per rule line of the manifest file named,
# refusing a malformed line (the MALFORMED line goes to stderr and names the
# copy, the second argument); blank lines and lines whose first non-blank
# character is # are skipped.
rules_of() {
  local file=$1 label=$2 line trimmed key regex n=0
  local -A seen=()
  while IFS= read -r line || [ -n "$line" ]; do
    trimmed=${line#"${line%%[![:space:]]*}"}
    case "$trimmed" in ''|\#*) continue ;; esac
    key=""; regex=""
    read -r key regex <<< "$line"
    [ -n "$key" ] || continue
    if [ -n "${seen[$key]+x}" ]; then
      echo "MALFORMED [$key] in $label: the key appears twice (one rule per key; join alternatives with |)" >&2; return 2
    fi
    seen[$key]=1
    if [ -z "$regex" ]; then
      echo "MALFORMED [$key] in $label: no pattern (an empty pattern would match every line)" >&2; return 2
    fi
    # A pattern that matches an empty line matches every line: an empty
    # alternative (|x, x|, ||, (), (|x, x|)), .*, ^, $, x* and their kin.
    local vrc=0
    printf '\n' | grep -iEq -- "$regex" || vrc=$?
    if [ "$vrc" -eq 0 ]; then
      echo "MALFORMED [$key] in $label: the pattern matches an empty line, so it would match every line: /$regex/" >&2; return 2
    elif [ "$vrc" -ne 1 ]; then
      echo "MALFORMED [$key] in $label: grep cannot parse the pattern /$regex/" >&2; return 2
    fi
    printf '%s\t%s\n' "$key" "$regex"
    n=$((n + 1))
  done < "$file"
  if [ "$n" -eq 0 ]; then echo "MALFORMED in $label: no invariant read" >&2; return 2; fi
}

fail=0

if [ -n "$REF" ]; then
  top="$HERE/.."
  rel="scripts/$(basename "$MANIFEST")"
  ref_tmp=$(mktemp "${TMPDIR:-/tmp}/claudemd-invariants.ref.XXXXXX") || exit 2
  if ! git -C "$top" show "$REF:$rel" > "$ref_tmp" 2>/dev/null; then
    rm -f "$ref_tmp"; echo "no manifest at $REF:$rel to compare against"; exit 2
  fi
  ref_rules=$(rules_of "$ref_tmp" "$REF's manifest ($rel)") || { rm -f "$ref_tmp"; exit 2; }
  # The commit's manifest: the index's copy (the hook's GIT_INDEX_FILE when set).
  if ! git -C "$top" show ":$rel" > "$ref_tmp" 2>/dev/null; then
    rm -f "$ref_tmp"; echo "no manifest in the index at $rel to judge the commit by"; exit 2
  fi
  rules=$(rules_of "$ref_tmp" "the index's manifest ($rel, the copy the commit is made from)") || { rm -f "$ref_tmp"; exit 2; }
  rm -f "$ref_tmp"
else
  rules=$(rules_of "$MANIFEST" "the manifest beside the script") || exit 2
fi

if [ -n "$REF" ]; then
  declare -A work=()
  while IFS=$'\t' read -r key regex; do work[$key]=$regex; done <<< "$rules"
  while IFS=$'\t' read -r key regex; do
    if [ -z "${work[$key]+x}" ]; then
      echo "REMOVED [$key]: $REF's manifest has it and the commit's manifest (the index's copy, what git diff --cached shows) does not"; fail=1
    elif [ "${work[$key]}" != "$regex" ]; then
      echo "CHANGED [$key]: /$regex/ at $REF, /${work[$key]}/ in the commit's manifest (the index's copy, what git diff --cached shows; a pattern change lands in its own commit, with no CLAUDE.md staged)"; fail=1
    fi
  done <<< "$ref_rules"
fi

count=0
while IFS=$'\t' read -r key regex; do
  count=$((count + 1))
  rc=0
  grep -iEq -- "$regex" "$DOC" || rc=$?
  if [ "$rc" -eq 2 ]; then
    echo "MALFORMED [$key]: grep cannot parse the pattern /$regex/ (fix the manifest in a commit of its own)" >&2; exit 2
  fi
  if [ "$rc" -ne 0 ]; then
    echo "MISSING [$key]: no line in $DOC matches /$regex/"
    fail=1
  fi
done <<< "$rules"
if [ "$fail" -eq 0 ]; then
  if [ -n "$REF" ]; then
    echo "OK: all $count invariants present in $DOC; the manifest only adds keys against $REF"
  else
    echo "OK: all $count invariants present in $DOC"
  fi
fi
exit "$fail"

#!/bin/bash
# Pre-commit check: warn if structural files were added/removed/renamed but docs didn't update.
# Pure modifications to existing files don't trigger — the doc tables only require updates
# when the folder tree or entity list changes (schema.sql is the exception: column/table
# modifications also require a doc update per ARCHITECTURE.md).
# Runs as part of the pre-commit hook via husky.

# Lines: "<STATUS>\t<path>" — or "R<score>\t<old>\t<new>" for renames.
STAGED_STATUS=$(git diff --cached --name-status)
STAGED_PATHS=$(git diff --cached --name-only)

STRUCTURAL_CHANGES=false
DOC_CHANGES=false

# Added / Deleted / Renamed structural files (pure M doesn't count).
# Match status letter (A/D/R) + optional rename score digits + tab + path.
STRUCTURAL_REGEX='^(A|D|R[0-9]*)[[:space:]]+.*(server/routes/.*\.js|server/utils/.*\.js|client/src/components/.*\.(js|jsx)|client/src/pages/.*\.(js|jsx)|client/src/context/.*\.js)$'
if echo "$STAGED_STATUS" | grep -qE "$STRUCTURAL_REGEX"; then
  STRUCTURAL_CHANGES=true
fi

# Schema changes (any status — modifications matter for column/table docs).
if echo "$STAGED_PATHS" | grep -q "schema\.sql"; then
  STRUCTURAL_CHANGES=true
fi

# Check if docs were also updated.
if echo "$STAGED_PATHS" | grep -qE "(CLAUDE\.md|README\.md|ARCHITECTURE\.md)"; then
  DOC_CHANGES=true
fi

if [ "$STRUCTURAL_CHANGES" = true ] && [ "$DOC_CHANGES" = false ]; then
  echo ""
  echo "⚠️  DOCS DRIFT WARNING"
  echo "   A structural file was added/removed/renamed (or schema.sql changed)"
  echo "   but CLAUDE.md, README.md, and ARCHITECTURE.md were not updated."
  echo ""
  echo "   Triggering files:"
  {
    echo "$STAGED_STATUS" | grep -E "$STRUCTURAL_REGEX" | awk -F'\t' '{ if ($3) printf "     %s  %s -> %s\n", $1, $2, $3; else printf "     %s  %s\n", $1, $2 }'
    echo "$STAGED_PATHS" | grep "schema\.sql" | sed 's/^/     M  /'
  }
  echo ""
  echo "   This is a WARNING only — commit is not blocked."
  echo ""
fi

# Always exit 0 — this is a warning, not a blocker.
exit 0

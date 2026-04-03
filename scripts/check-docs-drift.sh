#!/bin/bash
# Pre-commit check: warn if structural files changed but docs didn't
# This runs as part of the pre-commit hook via husky

STAGED=$(git diff --cached --name-only)

# Check if any structural files were added/removed (not just modified)
STRUCTURAL_CHANGES=false
DOC_CHANGES=false

# New route files
if echo "$STAGED" | grep -q "^server/routes/.*\.js$"; then
  STRUCTURAL_CHANGES=true
fi

# New util files
if echo "$STAGED" | grep -q "^server/utils/.*\.js$"; then
  STRUCTURAL_CHANGES=true
fi

# New component files
if echo "$STAGED" | grep -q "^client/src/components/.*\.js\|^client/src/components/.*\.jsx$"; then
  STRUCTURAL_CHANGES=true
fi

# New page files
if echo "$STAGED" | grep -q "^client/src/pages/.*\.js\|^client/src/pages/.*\.jsx$"; then
  STRUCTURAL_CHANGES=true
fi

# New context files
if echo "$STAGED" | grep -q "^client/src/context/.*\.js$"; then
  STRUCTURAL_CHANGES=true
fi

# Schema changes
if echo "$STAGED" | grep -q "schema\.sql"; then
  STRUCTURAL_CHANGES=true
fi

# Check if docs were also updated
if echo "$STAGED" | grep -qE "(CLAUDE\.md|README\.md|ARCHITECTURE\.md)"; then
  DOC_CHANGES=true
fi

if [ "$STRUCTURAL_CHANGES" = true ] && [ "$DOC_CHANGES" = false ]; then
  echo ""
  echo "⚠️  DOCS DRIFT WARNING"
  echo "   You changed structural files (routes, utils, components, pages, or schema)"
  echo "   but didn't update CLAUDE.md, README.md, or ARCHITECTURE.md."
  echo ""
  echo "   Changed files:"
  echo "$STAGED" | grep -E "(server/routes/|server/utils/|client/src/components/|client/src/pages/|client/src/context/|schema\.sql)" | sed 's/^/     /'
  echo ""
  echo "   This is a WARNING only — commit is not blocked."
  echo ""
fi

# Always exit 0 — this is a warning, not a blocker
exit 0

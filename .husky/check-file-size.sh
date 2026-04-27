#!/usr/bin/env sh
# Pre-commit guard: keep source files from drifting back into mega-file territory.
# Runs on staged source files only. Opt-out via `// claude-allow-large-file` in
# the first 5 lines (with a justification comment on the next line).
#
# Thresholds set after the 2026-04-27 cleanup pass that split five 1000+ line
# files. 700 = soft warn ("plan a split"). 1000 = hard fail ("split or justify").

WARN_LIMIT=700
FAIL_LIMIT=1000
OPT_OUT_MARKER="claude-allow-large-file"

files=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '^(server|client/src)/.+\.(js|jsx)$' | grep -v -E '\.test\.(js|jsx)$' || true)

if [ -z "$files" ]; then
  exit 0
fi

errors=0
warnings=0

# shellcheck disable=SC2030,SC2031
echo "$files" | while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ -f "$f" ] || continue
  if head -n 5 "$f" 2>/dev/null | grep -qF "$OPT_OUT_MARKER"; then
    continue
  fi
  count=$(wc -l < "$f" | tr -d ' ')
  if [ "$count" -gt "$FAIL_LIMIT" ]; then
    echo "FAIL  $f: $count lines (max $FAIL_LIMIT)"
    echo "$count" >> /tmp/_drb_filesize_fail.$$
  elif [ "$count" -gt "$WARN_LIMIT" ]; then
    echo "WARN  $f: $count lines (soft cap $WARN_LIMIT — plan a split)"
    echo "$count" >> /tmp/_drb_filesize_warn.$$
  fi
done

if [ -f /tmp/_drb_filesize_fail.$$ ]; then
  errors=$(wc -l < /tmp/_drb_filesize_fail.$$ | tr -d ' ')
  rm -f /tmp/_drb_filesize_fail.$$
fi
if [ -f /tmp/_drb_filesize_warn.$$ ]; then
  warnings=$(wc -l < /tmp/_drb_filesize_warn.$$ | tr -d ' ')
  rm -f /tmp/_drb_filesize_warn.$$
fi

if [ "$errors" -gt 0 ]; then
  echo ""
  echo "$errors file(s) exceed the $FAIL_LIMIT-line hard limit."
  echo "Either split the file, or add this on line 1 with a justification comment:"
  echo "  // claude-allow-large-file"
  echo "  // Reason: <why this file genuinely needs to be this big>"
  exit 1
fi

if [ "$warnings" -gt 0 ]; then
  echo ""
  echo "$warnings file(s) exceed the soft $WARN_LIMIT-line cap. Not blocking — plan a split."
fi

exit 0

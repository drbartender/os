# Review brief: {{name}}{{part_title}}

scripts/review-brief.js wrote this brief from .claude/skills/review/brief-template.md. Every lens of this review reads the same brief; your lens file holds the checks.

## Review

- Working name: {{name}}
- Kind: {{kind}}
- Branch: {{branch}}
- Tip: {{tip}}
- Position: {{position}}
- Reviewed against: {{reviewed_against}}
{{#part}}
- Part {{part_number}} of {{part_count}}, area {{part_areas}}: the diff was over {{split_limit}} lines, so it was split by area before any lens ran. Your report is stored as `<lens>.part-{{part_number}}.md` and covers only the files of this part.
{{/part}}

## Tier and why

- Tier: {{tier}} (the highest per-file tier, in the order A, hinge, B, C, docs)
- Floors, the union of the per-file tier floors: {{floors}}
- Externals: {{externals}}. Verify: {{verify}}.

Matched paths, each with its section of the sensitive list:
{{matched_paths}}

Content-rule hits, as file:line and rule (read the line in the diff):
{{content_rule_hits}}

Per-file tiers:
{{tiers_by_file}}

## Files

Return a verdict for every file below, and only for these; each names its section in the diff file, counted from the top.{{files_note}}

{{files}}

## Diff

{{diff_path}} holds the commit list, the stat and the diff with ten lines of context. It is PII-masked: a masked value reads as a shape name in angle brackets, such as `<PHONE>` or `<EMAIL>`. A binary file shows as one Binary files ... differ line; read it in the checkout if it matters. A file under server/, client/src/ or scripts/ that appears as a Binary files line is itself a finding to name, because its change is hidden from the diff.

## Plan and spec

{{plan_and_spec}}

## Established

These are settled before you start; do not redo them.

{{established}}

## Triggers that fired for you

Read the checks whose Names line carries one of your lens's names first, then the rest in order. A lens marked floor runs because the tier floor brings it.

{{triggers}}

{{#money_laws}}
## Money laws

docs/money-laws.md as written, PII-masked, {{laws_source}}. The money lens reads it before any file.

{{money_laws}}

{{/money_laws}}
{{#design}}
## Design artifact and captures

{{design}}

{{/design}}
## Budget

Finish within roughly {{budget}} tool calls and end with your verdict table; if you run out, cut breadth and say what you did not reach.

## Standing lines

- Print no real person's phone number; fixtures and the business lines are fine; refer to people by role.
- Name no client or staff member and copy no email address out of a log or a record: files by path, people by role, records by id.

## Output

Write your findings first, then the verdict table, and nothing after the table.

Each finding is one line: its id (the severity letter H, M or L and a number), the location as a backticked path:line, the defect in one sentence, the failure path stated from the code, and last the id of the check that applies, in the shape your lens file shows:

```text
- H1 `server/routes/example.js:120` The defect in one sentence. Failure path: the input and the steps that make it bite. Check: SEAM-1.
```

The verdict table is the last thing in the report: the header row `| file | verdict | note |`, one row per file in Files with the path alone in the file cell (no section number), the verdict exactly one of pass, finding, not reached, escalate, and the note naming the finding ids or the reason. A file missing from the table reads as not reached. Return escalate for a file when you see money, auth or PII material outside this review's tier.

A report dispatched as one lens carries no heading holding lens, lenses or any word that starts with lens, in any case, an indented heading included. A collapsed report has only the `## Lens: <name>` headings and no other heading. In a collapsed report, a section's notes name only that section's ids, because each `## Lens:` section is read alone.

A finding row's note names its finding ids; a not reached or escalate row's note gives the reason; a pass row's note says fixed in a re-pass or stays empty. In a re-pass after a fix, a pass row's note says fixed and names no id this report does not itself raise. A note names only ids among this report's own finding lines.

No prose line opens with an id: a line that opens with an id and holds a backticked path reads as a finding not in bullet form, so prose names an id mid-sentence.

The verify agent follows the Output section of verify.md instead of the table: findings only, no verdict table, and when it finds nothing, the line No findings by itself, with the checked list on the lines after it. In a split review, verify reads every part and writes one report.
{{#collapse}}

This is a one- or two-file tier A diff, so the review may run as one agent carrying every selected lens's checklist (the collapse). Dispatched that way, write one section per lens, each headed on its own line exactly as `## Lens: <name>` ({{collapse_headings}}), each holding that lens's findings and then that lens's own verdict table, and nothing after the last table. Dispatched as one lens, write the single report described above.
{{/collapse}}

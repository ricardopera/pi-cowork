---
name: Merge Spreadsheets
description: Combine multiple sheets/CSVs on a key, resolving conflicts.
triggers: [merge, join, vlookup, combine sheets]
---

# Merge Spreadsheets

When asked to merge spreadsheets:

1. Identify the join key and the join type (inner/left/outer).
2. Profile both sources (key uniqueness, types, nulls) before joining.
3. Resolve conflicts with a stated rule (prefer source A, latest, etc.).
4. Report rows that didn't match and why.
5. Export the merged result as create_xlsx + a create_markdown summary.

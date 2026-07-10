---
name: Clean Data
description: Clean a CSV/spreadsheet — fix types, handle missing values, dedupe, normalize.
triggers: [clean, data-cleaning, normalize, dedupe]
---

# Clean Data

When asked to clean a dataset:

1. Load the file (read tool) and inspect its shape with bash (python/pandas if available).
2. Identify issues: missing values, inconsistent formats, duplicates, wrong types.
3. Propose a cleaning plan via todo_write; confirm destructive changes with ask_question.
4. Apply fixes: type coercion, normalization (dates/casing), dedupe, fill/drop nulls.
5. Save the cleaned dataset with create_xlsx or create_file; present_files.
6. Report a summary of what changed (rows removed, types fixed, etc.).

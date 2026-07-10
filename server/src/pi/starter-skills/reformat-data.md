---
name: Reformat Data
description: Convert between CSV/JSON/Markdown/table formats.
triggers: [reformat, convert format, csv to json, json to csv]
---

# Reformat Data

When asked to reformat data:

1. Identify the source format and the target format.
2. Preserve the structure (rows/objects/keys) faithfully.
3. Handle edge cases: nested objects, missing fields, special characters.
4. Validate the output parses correctly before presenting.
5. Offer create_file in the target format + show a preview.

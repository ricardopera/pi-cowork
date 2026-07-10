---
name: Extract Structured Data
description: Pull structured records (contacts, events, line items) from unstructured text.
triggers: [extract, parse, contacts, structured, entities]
---

# Extract Structured Data

When asked to extract structured data:

1. Identify the target schema (fields and types).
2. Read the source text/files; pull matching records carefully.
3. Normalize (dates ISO, names trimmed, casing consistent).
4. Flag ambiguous or low-confidence entries separately.
5. Export as create_xlsx (rows) or create_file (JSON).

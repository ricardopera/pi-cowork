---
name: Data Migration Plan
description: Plan a data migration (mapping, validation, rollback).
triggers: [migration, data migration, etl, backfill]
---

# Data Migration Plan

When asked to plan a data migration:

1. Inventory source + target schemas; build a field-mapping table.
2. Identify transformations, defaults, and required fields.
3. Plan validation (row counts, checksums, spot checks) before cutover.
4. Define rollback + a dry-run on a subset.
5. Export the mapping as create_xlsx and the runbook as create_markdown.

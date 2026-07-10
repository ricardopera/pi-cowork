---
name: Audit & Clean Up
description: Inventory and clean up files, dependencies, or permissions.
triggers: [audit, cleanup, inventory, declutter]
---

# Audit & Clean Up

When asked to audit/clean up (files, deps, permissions):

1. Inventory the target (find/ls, dependency list, access roster).
2. Categorize: keep / archive / delete / review; size each group.
3. Flag duplicates, stale items, and large/risky entries.
4. Propose deletions but CONFIRM destructive ones via ask_question.
5. After cleanup, report space/items freed; save findings to memory.

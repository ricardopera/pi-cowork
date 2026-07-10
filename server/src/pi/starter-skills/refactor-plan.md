---
name: Write a Refactor Plan
description: Plan a code refactor (motivation, steps, risks, verification).
triggers: [refactor, rewrite, modernize, restructure]
---

# Write a Refactor Plan

When asked to plan a refactor:

1. State the motivation and the desired end state.
2. Inventory the current code; identify seams and test coverage.
3. Break into small, independently-shippable steps (strangler pattern).
4. For each step: change, risk, how to verify, rollback.
5. Sequence to keep the system working between steps.
6. Export as create_markdown.

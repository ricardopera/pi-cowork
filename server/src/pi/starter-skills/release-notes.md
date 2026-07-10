---
name: Write Release Notes
description: Draft release notes from commits/issues/tickets.
triggers: [release notes, changelog, shipped]
---

# Write Release Notes

When asked to write release notes:

1. Gather the changes (git log, closed tickets) since the last release.
2. Group by: Features, Improvements, Fixes, Breaking changes, Deprecations.
3. Write each entry user-facing and concise; link to tickets.
4. Lead with the most impactful change.
5. Export as create_markdown.

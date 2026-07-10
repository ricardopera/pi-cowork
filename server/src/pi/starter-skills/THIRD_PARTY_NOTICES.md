# Third-Party Notices

This directory includes starter skills adapted from Anthropic's open-source
plugin repositories, used under their respective licenses.

## anthropics/knowledge-work-plugins
- Source: https://github.com/anthropics/knowledge-work-plugins
- License: Apache License 2.0
- Copyright: Anthropic PBC
- Files: all `official-*.md` skills sourced from this repo (each file's
  frontmatter records its original path).
- Adaptation: reformatted from `<domain>/skills/<name>/SKILL.md` into flat
  `.md` files with attribution frontmatter; instruction content preserved.

## anthropics/claude-for-legal
- Source: https://github.com/anthropics/claude-for-legal
- License: Apache License 2.0
- Copyright: 2026 Anthropic PBC
- Files: `official-board-minutes.md`, `official-closing-checklist.md`,
  `official-cease-desist.md`, `official-clearance.md`, `official-redline.md`.

The full Apache License 2.0 text is included at the project root in `LICENSE`
(or see https://www.apache.org/licenses/LICENSE-2.0). Per Apache 2.0 §4,
copyright notices are retained above and within each adapted file; any
modifications are limited to reformatting for this project's skill loader.

## Proprietary content deliberately NOT included
The document-creation skills `docx`, `pdf`, `pptx`, and `xlsx` from
anthropics/skills are proprietary ("All rights reserved") and are NOT
included here. Pi-Cowork implements its own document creation independently.

---
name: Code Explainer
description: Explain a code file or snippet clearly for a given audience.
triggers: [explain code, walkthrough, how does this work]
---

# Code Explainer

When asked to explain code:

1. Read the file(s) with the read tool; follow imports if needed.
2. Summarize the purpose in one sentence, then walk through structure.
3. Explain non-obvious logic; skip trivia the audience already knows.
4. Adjust depth to the audience (ask via ask_question if unclear).
5. Optionally produce a create_markdown writeup with diagrams (mermaid).

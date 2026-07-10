---
name: Write a Regex
description: Build and explain a regular expression for a matching task.
triggers: [regex, regular expression, pattern]
---

# Write a Regex

When asked to write a regex:

1. Clarify what should and should NOT match (edge cases matter).
2. Write the pattern anchored and minimal; prefer readability over cleverness.
3. Explain each group/quantifier; provide 3-5 test cases (match + non-match).
4. Note the dialect (PCRE/JS/POSIX) and any greedy/pitfall warnings.
5. Optionally verify via a quick bash/node one-liner.

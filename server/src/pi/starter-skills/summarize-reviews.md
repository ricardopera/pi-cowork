---
name: Summarize Reviews
description: Synthesize product/app reviews into themes and sentiment.
triggers: [reviews, sentiment, app store, feedback synthesis]
---

# Summarize Reviews

When asked to summarize reviews:

1. Collect the reviews (scrape/fetch or pasted text); note sample size + date range.
2. Tag each by theme (bug, feature request, praise, complaint) and sentiment.
3. Quantify: top themes by frequency, sentiment split, star distribution.
4. Pull 3-5 representative quotes per major theme.
5. Export as create_docx with findings + create_xlsx with the tagged rows.

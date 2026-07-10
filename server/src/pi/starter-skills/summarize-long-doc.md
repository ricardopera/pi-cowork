---
name: Summarize a Long Document
description: Condense a long document/PDF into a structured summary (TL;DR, key points, details).
triggers: [summarize, tldr, condense, digest]
---

# Summarize a Long Document

When asked to summarize a long document:

1. Read the source (read tool for text; bash + pdftotext/pdfplumber for PDFs).
2. Produce a layered summary: 1-sentence TL;DR → key points (3-7 bullets) → detailed sections.
3. Preserve key numbers, names, and dates verbatim.
4. Note any sections you skipped and why.
5. Offer create_docx/create_pdf export; ask the desired length via ask_question if ambiguous.

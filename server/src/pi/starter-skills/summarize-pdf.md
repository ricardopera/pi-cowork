---
name: Summarize a PDF
description: Extract and summarize text from a PDF document.
triggers: [pdf, summarize pdf, extract pdf]
---

# Summarize a PDF

When asked to summarize a PDF:

1. Extract text (bash: pdftotext/pdfplumber; or read if already text).
2. If extraction fails (scanned), note it and suggest OCR (computer_ocr).
3. Produce a layered summary: TL;DR → key points → details.
4. Preserve key numbers, definitions, and citations verbatim.
5. Offer create_docx export with the summary + source references.

---
name: License Review
description: Identify and summarize license/dependency obligations.
triggers: [license, compliance, dependency audit]
---

# License Review

When asked to review licenses/compliance:

1. Inventory dependencies and their licenses (read package manifests).
2. Flag copyleft (GPL/AGPL) and any incompatible or "unknown" licenses.
3. Summarize obligations (attribution, notice files, source disclosure).
4. Recommend actions for each risk (replace, document, get legal review).
5. Export a create_xlsx matrix + a create_docx summary.

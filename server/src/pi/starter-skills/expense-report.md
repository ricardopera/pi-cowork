---
name: Expense Report
description: Organize raw expense records into a tidy report.
triggers: [expense, reimbursement, receipt]
---

# Expense Report

When asked to build an expense report:

1. Collect the raw records (CSV/receipts); confirm currency and date range.
2. Normalize: date, vendor, category, amount, notes; validate totals.
3. Flag missing receipts or policy-questionable items.
4. Summarize by category + total; note any per-diems or limits.
5. Export as create_xlsx with a summary sheet + line items.

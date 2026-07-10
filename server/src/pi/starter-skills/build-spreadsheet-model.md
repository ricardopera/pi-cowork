---
name: Build a Spreadsheet Model
description: Build a structured spreadsheet (budget, forecast, tracker) with formulas.
triggers: [spreadsheet, budget, forecast, model, tracker]
---

# Build a Spreadsheet Model

When asked to build a spreadsheet/budget/forecast:

1. Clarify purpose, time horizon, and line items via ask_question.
2. Design sheets: an Inputs/Assumptions sheet, a Calculations sheet, and a Summary sheet.
3. Use create_xlsx with headers + rows; keep formulas as plain values if the lib can't write live formulas (note this).
4. Make assumptions explicit and editable (highlight in a named section).
5. Present the file; explain how to adjust assumptions.

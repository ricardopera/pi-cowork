---
name: Currency / Unit Conversion
description: Convert currencies, units, or time zones across a dataset.
triggers: [convert, currency, units, timezone]
---

# Currency / Unit Conversion

When asked to convert values:

1. Identify source and target units/currency/timezone.
2. State the conversion rate or source used (and its date for FX).
3. Apply consistently; keep full precision internally, round only on display.
4. For datasets, add a converted column rather than overwriting.
5. Note any assumptions (which rate, DST handling) in the output.

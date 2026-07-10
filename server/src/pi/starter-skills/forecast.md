---
name: Build a Forecast
description: Produce a quantitative forecast (trend, seasonality, assumptions).
triggers: [forecast, projection, predict, trend]
---

# Build a Forecast

When asked to build a forecast:

1. Gather historical data; plot it to see trend + seasonality.
2. Pick a method appropriate to the data (naive, moving avg, regression); state why.
3. Document every assumption explicitly (growth rate, conversion, churn).
4. Show base/upside/downside cases; never present a single point estimate as certain.
5. Export as create_xlsx with the model + create_docx with assumptions.

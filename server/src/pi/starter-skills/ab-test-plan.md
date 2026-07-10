---
name: A/B Test Plan
description: Design an A/B experiment (hypothesis, metrics, sample size, decision rule).
triggers: [a/b test, experiment, ab test, hypothesis test]
---

# A/B Test Plan

When asked to design an A/B test:

1. State the hypothesis and the primary metric (with direction).
2. Define guardrail metrics and the minimum detectable effect.
3. Compute sample size / duration for the desired power; note assumptions.
4. Specify the decision rule (significance threshold, guardrail kill-switch).
5. Call out risks (novelty effect, SRM, peeking).
6. Export as create_docx with the spec + a results template.

---
name: Write a Runbook
description: Document an operational runbook for a recurring task or incident.
triggers: [runbook, sop, operations, incident, playbook]
---

# Write a Runbook

When asked to write a runbook/SOP:

1. Clarify the procedure and who runs it.
2. Structure: Purpose → Prerequisites → Steps → Verification → Rollback → Escalation.
3. Number every step with exact commands and expected output.
4. Include a rollback/recovery section for destructive steps.
5. Export as create_markdown; verify commands are runnable.

---
name: Security Checklist
description: Run a security review against a checklist (OWASP-style).
triggers: [security, checklist, owasp, review]
---

# Security Checklist

When asked to do a security review:

1. Scope: code, config, dependencies, data flows.
2. Check OWASP-style items: input validation, authn/authz, secrets, injection, SSRF, logging.
3. For each finding: severity, location, recommendation.
4. Distinguish confirmed issues from things to verify.
5. Export a create_xlsx findings table + remediation notes.

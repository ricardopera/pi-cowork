---
name: Normalize Addresses
description: Standardize and validate a list of addresses/postal data.
triggers: [address, normalize, postal, validate addresses]
---

# Normalize Addresses

When asked to normalize addresses:

1. Parse each into components (street, city, region, postal, country).
2. Apply a consistent format (casing, abbreviations, ISO country codes).
3. Flag malformed/incomplete entries separately; don't silently guess.
4. Note the normalization rules applied so they're reproducible.
5. Export as create_xlsx with original + normalized columns.

---
name: Document an API
description: Produce API reference docs (endpoints, params, examples).
triggers: [api docs, openapi, endpoint, reference]
---

# Document an API

When asked to document an API:

1. For each endpoint: method, path, summary, auth, parameters (name/in/type/required).
2. Show a request example and the response schema with a sample.
3. List error codes and their meanings.
4. Note rate limits / pagination conventions if relevant.
5. Export as create_markdown; offer an OpenAPI snippet via create_file.

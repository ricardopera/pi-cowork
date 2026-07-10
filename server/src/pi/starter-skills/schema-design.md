---
name: Design a Schema
description: Design a database schema (tables, keys, indexes) from requirements.
triggers: [schema, database design, tables, modeling]
---

# Design a Schema

When asked to design a database schema:

1. Extract entities and relationships from the requirements.
2. Define tables, primary/foreign keys, and constraints.
3. Add indexes for likely query patterns; note tradeoffs.
4. Include an ERD (mermaid) and DDL.
5. Call out normalization level and intentional denormalization.
6. Export as create_markdown with the DDL in a create_file.

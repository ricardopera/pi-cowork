---
name: Write a SQL Query
description: Translate a question into an efficient, correct SQL query.
triggers: [sql, query, select]
---

# Write a SQL Query

When asked to write SQL:

1. Restate the question precisely; identify the tables/columns involved.
2. Write the query with clear aliases and formatting.
3. Add necessary joins/filters/aggregations; guard against Cartesian products.
4. Note assumptions (dialect, null handling, time zones).
5. Suggest an index if the query would scan heavily.

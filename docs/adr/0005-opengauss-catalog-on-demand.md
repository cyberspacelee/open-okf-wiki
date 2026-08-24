# openGauss Catalog on demand

A Workspace may declare multiple named openGauss Catalogs, each with one
connection, schema, and optional table patterns. A Source binds at most one
Catalog; a Catalog may be shared by multiple Sources. Bound definitions and
Source bindings are pinned into the Run. The host never dumps schemas into the Lead prompt.
Agents select an assigned Catalog when listing or describing matching tables
through read-only tools, and citations use `catalog:<catalog>/<table>`.
Large schemas remain just-in-time retrieval: preload names when useful, then
load columns and keys only for the tables the current page needs. Only
openGauss is supported.

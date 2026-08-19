# Postgres Catalog on demand

A Workspace may declare one Postgres connection, schema, and optional table
patterns. The host never dumps that schema into the Lead prompt. Agents list
and describe matching tables through read-only Catalog tools. Anthropic and Amp
both treat large schemas as just-in-time retrieval: preload names when useful,
load columns and keys only for the tables the current page needs. Only
Postgres is supported.

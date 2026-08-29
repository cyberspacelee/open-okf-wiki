---
type: Table
title: "{schema.table}"
description: "{routing: what this table stores and when to inspect it}"
coverage: full
resource: "{canonical table URI}"
tags: [data-model, table]
diagrams: []
sources: []
---

{table_comment}

# Schema

| Column | Type | Nullable | Default | Comment |
| --- | --- | --- | --- | --- |
| {column} | {type} | {yes/no} | {default} | {comment} |

## Keys and relationships

Record keys from the captured Catalog. A Table page does not contain diagrams
or try to discover parent pages; a later DataModel parent links its Table
children.

## Usage

State only evidence-backed application ownership and lifecycle. Link code
concepts instead of copying them.

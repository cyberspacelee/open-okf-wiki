---
type: DataModel
title: "{title}"
description: "{routing: which entity relationships and ownership this page answers}"
coverage: full
resource: "{canonical schema URI}"
tags: [data-model]
diagrams: []
sources: []
---

## Relationship model

Render every planned ER diagram with only entities in the selected scope.
Show relationship names, cardinality and optionality; do not imply that
unselected tables were inspected.

## Ownership and boundaries

State which Source owns each selected entity and where code or service
boundaries meet persistence.

## Selected tables

Link only Table pages received as `dependency_page` inputs. Keep columns out
of this page; do not invent a page for an unplanned table.

## Code-to-data mapping

Use a compact table for the write/read path, lifecycle event and owning code
concept. Record omitted evidence as gaps.

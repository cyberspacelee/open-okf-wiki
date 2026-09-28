import hashlib
import json
import pathlib
from contextlib import contextmanager
from urllib.parse import urlsplit


class DbError(Exception):
    pass


_URL_PREFIX = "opengauss://"
_CONSTRAINT_TYPES = {
    "p": "primary_key",
    "u": "unique",
    "f": "foreign_key",
    "c": "check",
}
_FK_ACTIONS = {
    "a": "no_action",
    "r": "restrict",
    "c": "cascade",
    "n": "set_null",
    "d": "set_default",
}
_FK_MATCHES = {"f": "full", "p": "partial", "u": "unspecified"}
_RELATION_KINDS = {"r": "table", "p": "partitioned_table"}
_PERSISTENCE = {"p": "permanent", "u": "unlogged", "g": "temporary"}


def load_env(root: pathlib.Path) -> dict[str, str]:
    env_file = root / ".env"
    result = {}
    if not env_file.exists():
        return result

    with env_file.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
                value = value[1:-1]
            result[key] = value
    return result


def resolve_url(root: pathlib.Path, env_ref: str) -> str:
    if env_ref.startswith("${") and env_ref.endswith("}"):
        var_name = env_ref[2:-1]
    else:
        var_name = env_ref

    import os

    if var_name in os.environ:
        url = os.environ[var_name]
    else:
        env_dict = load_env(root)
        if var_name not in env_dict:
            raise DbError(
                f"Variable '{var_name}' not found in the environment or .env; ask the user to "
                "set it to the opengauss:// URL (never write the URL into a tracked file)"
            )
        url = env_dict[var_name]

    parsed = urlsplit(url)
    if (
        parsed.scheme != "opengauss"
        or not parsed.hostname
        or not parsed.path.strip("/")
    ):
        raise DbError("URL must be an opengauss:// URL with host and database")
    return url


def _psycopg_url(url: str) -> str:
    if not url.startswith(_URL_PREFIX):
        raise DbError("URL must start with opengauss://")
    return "postgresql://" + url[len(_URL_PREFIX) :]


def _connect(url: str):
    try:
        import psycopg
    except ImportError:
        raise DbError("db commands require psycopg; other commands are unaffected")

    try:
        return psycopg.connect(
            _psycopg_url(url),
            connect_timeout=5,
            options="-c default_transaction_read_only=on -c statement_timeout=10000",
        )
    except Exception:  # noqa: BLE001 - database errors may contain credentials
        raise DbError(
            f"Failed to connect to OpenGauss database '{_extract_dbname(url)}'"
        )


@contextmanager
def _snapshot(url: str):
    conn = _connect(url)
    try:
        with conn.cursor() as cur:
            cur.execute("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            cur.execute("""
                SELECT
                  opengauss_version(),
                  working_version_num(),
                  gs_deployment(),
                  version(),
                  current_database()
                """)
            row = cur.fetchone()
            if not row or not isinstance(row[0], str) or not row[0].strip():
                raise DbError("Connected server did not identify itself as OpenGauss")
            fingerprint = {
                "opengauss_version": row[0],
                "working_version_num": row[1],
                "deployment": row[2],
                "server_version": row[3],
                "database": row[4],
            }
        yield conn, fingerprint
    except DbError:
        raise
    except Exception:  # noqa: BLE001 - keep query details and DSNs out of errors
        raise DbError("OpenGauss catalog query failed")
    finally:
        conn.close()


def _table_rows(conn, schema: str) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
              c.oid,
              c.relname,
              obj_description(c.oid, 'pg_class'),
              c.relkind,
              c.relpersistence
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = %s AND c.relkind IN ('r', 'p')
            ORDER BY c.relname
            """,
            (schema,),
        )
        rows = cur.fetchall()
    return [
        {
            "oid": oid,
            "name": name,
            "comment": comment or "",
            "relation_kind": _RELATION_KINDS.get(kind, kind),
            "persistence": _PERSISTENCE.get(persistence, persistence),
        }
        for oid, name, comment, kind, persistence in rows
    ]


def _schema_names(conn) -> list[str]:
    """User schemas: the catalog's own (pg_*, information_schema) left out."""
    with conn.cursor() as cur:
        cur.execute("SELECT n.nspname FROM pg_catalog.pg_namespace n ORDER BY n.nspname")
        names = [row[0] for row in cur.fetchall()]
    return [n for n in names if not n.startswith("pg_") and n != "information_schema"]


def _select(conn, rules) -> tuple[dict[str, dict], list[str]]:
    """Resolve schema rules against the catalog: per matched schema, the relations a
    rule takes, the names an include matched but an exclude dropped, and how many
    other tables the schema holds; plus the rules that matched no schema."""
    names = _schema_names(conn)
    by_schema: dict[str, list] = {}
    unmatched = []
    for rule in rules:
        hits = [name for name in names if rule.matches_schema(name)]
        if not hits:
            unmatched.append(rule.name)
        for name in hits:
            by_schema.setdefault(name, []).append(rule)
    chosen = {}
    for schema, schema_rules in sorted(by_schema.items()):
        rows = _table_rows(conn, schema)
        taken = [r for r in rows if any(rule.takes(r["name"]) for rule in schema_rules)]
        kept = {r["name"] for r in taken}
        excluded = [
            r["name"] for r in rows
            if r["name"] not in kept and any(rule.includes(r["name"]) for rule in schema_rules)
        ]
        dropped = kept | set(excluded)
        chosen[schema] = {"taken": taken, "excluded": excluded,
                          "other": [r["name"] for r in rows if r["name"] not in dropped]}
    return chosen, unmatched


def select(url: str, rules, code_tables: dict[str, str] | None = None) -> dict:
    """The tables a database's schema rules take, for tuning the rules before capture.

    ``code_tables`` (lowercase name -> locator, from the bound repositories' code)
    adds the gaps: ``code_not_taken``, tables the code uses that a matched schema
    holds but the rules leave out; ``code_not_found``, tables the code names that
    no matched schema holds (another database, a view, a stale name)."""
    with _snapshot(url) as (conn, fingerprint):
        chosen, unmatched = _select(conn, rules)
    held: dict[str, tuple[str, str]] = {}  # lowercase name -> (schema, why not taken)
    taken: set[str] = set()
    for schema, entry in chosen.items():
        taken |= {r["name"].lower() for r in entry["taken"]}
        for name in entry["excluded"]:
            held.setdefault(name.lower(), (schema, "excluded"))
        for name in entry["other"]:
            held.setdefault(name.lower(), (schema, "not included"))
    not_taken, not_found = [], []
    for name, locator in sorted((code_tables or {}).items()):
        if name in taken:
            continue
        if name in held:
            schema, why = held[name]
            not_taken.append({"table": name, "schema": schema, "reason": why, "locator": locator})
        else:
            not_found.append({"table": name, "locator": locator})
    return {
        "database": fingerprint["database"],
        "schemas": [
            {"schema": schema, "tables": [r["name"] for r in entry["taken"]],
             "excluded": entry["excluded"], "skipped": len(entry["other"])}
            for schema, entry in chosen.items()
        ],
        "unmatched_schema_rules": unmatched,
        "code_not_taken": not_taken,
        "code_not_found": not_found,
    }


def _column_rows(conn, relation_oid: int) -> tuple[list[dict], dict[int, str]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
              a.attnum,
              a.attname,
              pg_catalog.format_type(a.atttypid, a.atttypmod),
              NOT a.attnotnull,
              pg_catalog.pg_get_expr(d.adbin, d.adrelid),
              col_description(a.attrelid, a.attnum)
            FROM pg_catalog.pg_attribute a
            LEFT JOIN pg_catalog.pg_attrdef d
              ON d.adrelid = a.attrelid AND d.adnum = a.attnum
            WHERE a.attrelid = %s AND a.attnum > 0 AND NOT a.attisdropped
            ORDER BY a.attnum
            """,
            (relation_oid,),
        )
        rows = cur.fetchall()
    names = {attnum: name for attnum, name, *_ in rows}
    columns = [
        {
            "position": attnum,
            "name": name,
            "type": data_type,
            "nullable": nullable,
            "default": default,
            "comment": comment or "",
        }
        for attnum, name, data_type, nullable, default, comment in rows
    ]
    return columns, names


def _constraint_rows(
    conn, relation_oid: int, column_names: dict[int, str]
) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
              con.conname,
              con.contype,
              con.conkey,
              ref_ns.nspname,
              ref.relname,
              con.confrelid,
              con.confkey,
              con.confmatchtype,
              con.confupdtype,
              con.confdeltype,
              con.condeferrable,
              con.condeferred,
              con.convalidated,
              con.consoft,
              con.conopt,
              pg_catalog.pg_get_constraintdef(con.oid, true)
            FROM pg_catalog.pg_constraint con
            LEFT JOIN pg_catalog.pg_class ref ON ref.oid = con.confrelid
            LEFT JOIN pg_catalog.pg_namespace ref_ns ON ref_ns.oid = ref.relnamespace
            WHERE con.conrelid = %s AND con.contype IN ('p', 'u', 'f', 'c')
            ORDER BY con.contype, con.conname
            """,
            (relation_oid,),
        )
        rows = cur.fetchall()

    referenced_oids = sorted({row[5] for row in rows if row[5]})
    referenced_columns: dict[int, dict[int, str]] = {}
    if referenced_oids:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT a.attrelid, a.attnum, a.attname
                FROM pg_catalog.pg_attribute a
                WHERE a.attrelid = ANY(%s) AND a.attnum > 0 AND NOT a.attisdropped
                ORDER BY a.attrelid, a.attnum
                """,
                (referenced_oids,),
            )
            for ref_oid, attnum, name in cur.fetchall():
                referenced_columns.setdefault(ref_oid, {})[attnum] = name

    constraints = []
    for row in rows:
        (
            name,
            kind,
            keys,
            ref_schema,
            ref_table,
            ref_oid,
            ref_keys,
            match_type,
            update_action,
            delete_action,
            deferrable,
            initially_deferred,
            validated,
            soft,
            optimized,
            definition,
        ) = row
        item = {
            "name": name,
            "type": _CONSTRAINT_TYPES[kind],
            "columns": [
                column_names[key] for key in (keys or []) if key in column_names
            ],
            "definition": definition,
            "deferrable": bool(deferrable),
            "initially_deferred": bool(initially_deferred),
            "validated": bool(validated),
            "soft": bool(soft),
            "optimized": bool(optimized),
        }
        if kind == "f":
            ref_names = referenced_columns.get(ref_oid, {})
            item.update(
                ref_schema=ref_schema,
                ref_table=ref_table,
                ref_columns=[
                    ref_names[key] for key in (ref_keys or []) if key in ref_names
                ],
                match=_FK_MATCHES.get(match_type, match_type),
                on_update=_FK_ACTIONS.get(update_action, update_action),
                on_delete=_FK_ACTIONS.get(delete_action, delete_action),
            )
        constraints.append(item)
    return constraints


def _index_rows(conn, relation_oid: int) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
              index_class.relname,
              idx.indisunique,
              idx.indisprimary,
              idx.indisvalid,
              idx.indisusable,
              idx.indisready,
              access_method.amname,
              ARRAY(
                SELECT pg_catalog.pg_get_indexdef(idx.indexrelid, key_no, true)
                FROM generate_series(1, idx.indnkeyatts) key_no
                ORDER BY key_no
              ),
              ARRAY(
                SELECT pg_catalog.pg_get_indexdef(idx.indexrelid, key_no, true)
                FROM generate_series(idx.indnkeyatts + 1, idx.indnatts) key_no
                ORDER BY key_no
              ),
              pg_catalog.pg_get_expr(idx.indpred, idx.indrelid),
              tablespace.spcname,
              pg_catalog.pg_get_indexdef(idx.indexrelid)
            FROM pg_catalog.pg_index idx
            JOIN pg_catalog.pg_class index_class ON index_class.oid = idx.indexrelid
            JOIN pg_catalog.pg_am access_method ON access_method.oid = index_class.relam
            LEFT JOIN pg_catalog.pg_tablespace tablespace
              ON tablespace.oid = index_class.reltablespace
            WHERE idx.indrelid = %s
            ORDER BY index_class.relname
            """,
            (relation_oid,),
        )
        rows = cur.fetchall()
    return [
        {
            "name": name,
            "unique": bool(unique),
            "primary": bool(primary),
            "valid": bool(valid),
            "usable": bool(usable),
            "ready": bool(ready),
            "method": method,
            "keys": list(keys or []),
            "include": list(include or []),
            "predicate": predicate,
            "tablespace": tablespace,
            "definition": definition,
        }
        for (
            name,
            unique,
            primary,
            valid,
            usable,
            ready,
            method,
            keys,
            include,
            predicate,
            tablespace,
            definition,
        ) in rows
    ]


def _partition_rows(conn, relation_oid: int) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
              p.relname,
              p.parttype,
              p.partstrategy,
              p.boundaries,
              tablespace.spcname
            FROM pg_catalog.pg_partition p
            LEFT JOIN pg_catalog.pg_tablespace tablespace
              ON tablespace.oid = p.reltablespace
            WHERE p.parentid = %s
            ORDER BY p.relname
            """,
            (relation_oid,),
        )
        rows = cur.fetchall()
    return [
        {
            "name": name,
            "type": partition_type,
            "strategy": strategy,
            "boundaries": boundaries,
            "tablespace": tablespace,
        }
        for name, partition_type, strategy, boundaries, tablespace in rows
    ]


def _describe_row(conn, schema: str, relation: dict) -> dict:
    columns, column_names = _column_rows(conn, relation["oid"])
    constraints = _constraint_rows(conn, relation["oid"], column_names)
    primary = next(
        (item["columns"] for item in constraints if item["type"] == "primary_key"),
        [],
    )
    foreign_keys = [
        {
            key: item[key]
            for key in (
                "name",
                "columns",
                "ref_schema",
                "ref_table",
                "ref_columns",
                "match",
                "on_update",
                "on_delete",
                "deferrable",
                "initially_deferred",
                "validated",
                "soft",
                "optimized",
            )
        }
        for item in constraints
        if item["type"] == "foreign_key"
    ]
    return {
        "schema": schema,
        "name": relation["name"],
        "comment": relation["comment"],
        "relation_kind": relation["relation_kind"],
        "persistence": relation["persistence"],
        "columns": columns,
        "constraints": constraints,
        "primary_key": primary,
        "foreign_keys": foreign_keys,
        "indexes": _index_rows(conn, relation["oid"]),
        "partitions": _partition_rows(conn, relation["oid"]),
    }


def describe(url: str, table: str, schema: str = "public") -> dict:
    with _snapshot(url) as (conn, _fingerprint):
        relation = next(
            (item for item in _table_rows(conn, schema) if item["name"] == table),
            None,
        )
        if relation is None:
            raise DbError(
                f"Table '{table}' not found in schema '{schema}' of database "
                f"'{_extract_dbname(url)}'"
            )
        return _describe_row(conn, schema, relation)


def _inspect_catalog(url: str, rules) -> tuple[dict, dict[str, list[dict]], list[str]]:
    with _snapshot(url) as (conn, fingerprint):
        chosen, unmatched = _select(conn, rules)
        described = {
            schema: [_describe_row(conn, schema, row) for row in entry["taken"]]
            for schema, entry in chosen.items()
            if entry["taken"]
        }
        return fingerprint, described, unmatched


def _extract_dbname(url: str) -> str:
    return urlsplit(url).path.rsplit("/", 1)[-1] or "unknown"


def _hash_json(value: dict) -> str:
    raw = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str
    ).encode()
    return hashlib.sha256(raw).hexdigest()


def capture(url: str, rules, *, inspect=_inspect_catalog) -> dict:
    """Describe every table the schema rules take, in one read-only snapshot, with
    per-table hashes and one catalog hash per schema."""
    fingerprint, described, unmatched = inspect(url, rules)
    if not any(described.values()):
        raise DbError(
            f"the schema rules matched no table in database '{fingerprint.get('database', 'unknown')}'; "
            "run okf db tables to see what the catalog holds and fix include and exclude"
        )
    schemas = {}
    for schema, rows in sorted(described.items()):
        tables = {row["name"]: row for row in sorted(rows, key=lambda r: r["name"])}
        hashes = {name: _hash_json(table) for name, table in tables.items()}
        schemas[schema] = {
            "schema": schema,
            "tables": tables,
            "sha256": hashes,
            "catalog_sha256": _hash_json({"schema": schema, "tables": hashes}),
        }
    return {"server": fingerprint, "schemas": schemas, "unmatched_schema_rules": unmatched}

import hashlib
import json
import pathlib
import re
from contextlib import contextmanager
from urllib.parse import quote, urlsplit

from _files import atomic_json


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
            raise DbError(f"Variable '{var_name}' not found")
        url = env_dict[var_name]

    parsed = urlsplit(url)
    if parsed.scheme != "opengauss" or not parsed.hostname or not parsed.path.strip("/"):
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
        raise DbError(f"Failed to connect to OpenGauss database '{_extract_dbname(url)}'")


@contextmanager
def _snapshot(url: str):
    conn = _connect(url)
    try:
        with conn.cursor() as cur:
            cur.execute("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            cur.execute(
                """
                SELECT
                  opengauss_version(),
                  working_version_num(),
                  gs_deployment(),
                  version(),
                  current_database()
                """
            )
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


def tables(url: str, schema: str = "public") -> dict:
    with _snapshot(url) as (conn, fingerprint):
        names = [row["name"] for row in _table_rows(conn, schema)]
        return {
            "database": fingerprint["database"],
            "schema": schema,
            "count": len(names),
            "tables": names,
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


def _constraint_rows(conn, relation_oid: int, column_names: dict[int, str]) -> list[dict]:
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
            "columns": [column_names[key] for key in (keys or []) if key in column_names],
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
                ref_columns=[ref_names[key] for key in (ref_keys or []) if key in ref_names],
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


def _inspect_catalog(url: str, schema: str, selected: list[str]) -> tuple[dict, list[dict]]:
    with _snapshot(url) as (conn, fingerprint):
        available = _table_rows(conn, schema)
        by_name = {item["name"]: item for item in available}
        missing = sorted(set(selected) - set(by_name))
        if missing:
            raise DbError(f"Configured tables not found in schema '{schema}': {missing}")
        return fingerprint, [_describe_row(conn, schema, by_name[name]) for name in selected]


def _extract_dbname(url: str) -> str:
    return urlsplit(url).path.rsplit("/", 1)[-1] or "unknown"


def _canonical_database(url: str, schema: str) -> str:
    parsed = urlsplit(url)
    host = parsed.hostname or "localhost"
    port = f":{parsed.port}" if parsed.port else ""
    database = quote(parsed.path.strip("/"), safe="")
    return f"opengauss://{host}{port}/{database}/{quote(schema, safe='')}"


def _hash_json(value: dict) -> str:
    raw = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str
    ).encode()
    return hashlib.sha256(raw).hexdigest()


def catalog_storage_key(source_name: str, content_hash: str) -> str:
    slug = re.sub(r"[^a-z0-9-]+", "-", source_name.lower()).strip("-")
    return f"{slug[:24].rstrip('-') or 'catalog'}-{content_hash[:16]}"


def catalog_dir(root: pathlib.Path, storage_key: str) -> pathlib.Path:
    return root / ".okf-wiki" / "catalogs" / storage_key


def catalog_record(payload: dict, content_hash: str, storage_key: str) -> dict:
    """Catalog identity stored in state; table metadata stays in catalog.json."""
    return {
        "name": payload["name"],
        "content_hash": content_hash,
        "storage_key": storage_key,
    }


def _read_json(path: pathlib.Path, description: str) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DbError(f"{description} is missing or invalid") from exc
    if not isinstance(value, dict):
        raise DbError(f"{description} is missing or invalid")
    return value


def load_index(root: pathlib.Path, storage_key: str) -> dict:
    manifest = _read_json(
        catalog_dir(root, storage_key) / "catalog.json",
        f"captured catalog {storage_key}",
    )
    content_hash = manifest.get("content_hash")
    body = {key: value for key, value in manifest.items() if key != "content_hash"}
    if not isinstance(content_hash, str) or _hash_json(body) != content_hash:
        raise DbError(f"captured catalog {storage_key} failed integrity check")
    return manifest


def load_catalog(root: pathlib.Path, storage_key: str) -> dict:
    manifest = load_index(root, storage_key)
    payload = {key: value for key, value in manifest.items() if key != "tables"}
    payload["tables"] = []
    for item in manifest["tables"]:
        value = _read_json(
            catalog_dir(root, storage_key) / item["path"],
            f"captured table {item['name']}",
        )
        if _hash_json(value) != item.get("content_hash"):
            raise DbError(f"captured table {item['name']} failed integrity check")
        payload["tables"].append(value)
    return payload


def load_indexes(root: pathlib.Path, records: list[dict]) -> list[dict]:
    return [load_index(root, record["storage_key"]) for record in records]


def load_table(root: pathlib.Path, storage_key: str, page_slug: str) -> dict:
    manifest = load_index(root, storage_key)
    item = next(
        (
            table
            for table in manifest.get("tables", [])
            if table.get("page_slug") == page_slug or table.get("name") == page_slug
        ),
        None,
    )
    if item is None:
        raise DbError(f"Table '{page_slug}' not found in captured catalog")
    value = _read_json(
        catalog_dir(root, storage_key) / item["path"],
        f"captured table {item['name']}",
    )
    if _hash_json(value) != item.get("content_hash"):
        raise DbError(f"captured table {item['name']} failed integrity check")
    return value


def tables_captured(
    root: pathlib.Path, catalogs: list[dict], source: str | None = None
) -> list[dict]:
    records = [
        record for record in catalogs if not source or record.get("name") == source
    ]
    if source and not records:
        raise DbError(f"Captured catalog '{source}' not found")
    result = []
    for record in records:
        manifest = load_index(root, record["storage_key"])
        names = sorted(table["name"] for table in manifest["tables"])
        result.append(
            {
                "source": manifest["name"],
                "schema": manifest["schema"],
                "count": len(names),
                "tables": names,
            }
        )
    return result


def describe_captured(
    root: pathlib.Path,
    catalogs: list[dict],
    table: str,
    source: str | None = None,
) -> dict:
    matches = []
    records = [
        record for record in catalogs if not source or record.get("name") == source
    ]
    if source and not records:
        raise DbError(f"Captured catalog '{source}' not found")
    for record in records:
        manifest = load_index(root, record["storage_key"])
        for item in manifest.get("tables", []):
            if item.get("name") == table or item.get("page_slug") == table:
                matches.append(load_table(root, record["storage_key"], item["page_slug"]))
    if not matches:
        raise DbError(f"Table '{table}' not found in captured catalog")
    if len(matches) > 1:
        raise DbError(f"Table '{table}' is ambiguous; pass --source")
    return matches[0]


def _page_slug(table: str) -> str:
    safe = re.sub(r"[^a-z0-9_-]+", "-", table.lower()).strip("-") or "table"
    if safe != table:
        safe += "-" + hashlib.sha256(table.encode()).hexdigest()[:8]
    return safe


def capture_catalog(root: pathlib.Path, source, *, inspect=_inspect_catalog) -> dict:
    url = resolve_url(root, source.url_env or "DATABASE_URL")
    schema = source.schema or "public"
    selected = list(source.tables)
    fingerprint, described = inspect(url, schema, selected)
    schema_resource = _canonical_database(url, schema)
    for item in described:
        item["page_slug"] = _page_slug(item["name"])
        item["resource"] = f"{schema_resource}/{quote(item['name'], safe='')}"

    table_entries = []
    for item in described:
        table_entries.append(
            {
                "name": item["name"],
                "page_slug": item["page_slug"],
                "resource": item["resource"],
                "path": f"tables/{item['page_slug']}.json",
                "comment": item.get("comment") or "",
                "relation_kind": item.get("relation_kind"),
                "persistence": item.get("persistence"),
                "content_hash": _hash_json(item),
            }
        )
    manifest_body = {
        "name": source.name,
        "schema": schema,
        "resource": schema_resource,
        "server": fingerprint,
        "tables": table_entries,
    }
    content_hash = _hash_json(manifest_body)
    manifest = {**manifest_body, "content_hash": content_hash}
    storage_key = catalog_storage_key(source.name, content_hash)
    directory = catalog_dir(root, storage_key)
    capture = directory / "catalog.json"
    if capture.is_file():
        existing = load_index(root, storage_key)
        if existing.get("content_hash") != content_hash:
            raise DbError(f"catalog storage key collision: {storage_key}")
    directory.mkdir(parents=True, exist_ok=True)
    for entry, item in zip(table_entries, described, strict=True):
        atomic_json(directory / entry["path"], item)
    atomic_json(capture, manifest)
    return catalog_record(manifest, content_hash, storage_key)

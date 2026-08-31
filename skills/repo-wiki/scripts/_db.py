import hashlib
import json
import pathlib
import re
from urllib.parse import quote, urlsplit

from _files import atomic_json


class DbError(Exception):
    pass


_URL_SCHEMES = ("postgres://", "postgresql://", "opengauss://")
_PSYCOPG_PREFIX = "opengauss://"


def load_env(root: pathlib.Path) -> dict[str, str]:
    env_file = root / ".env"
    result = {}
    if not env_file.exists():
        return result

    with env_file.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
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

    if not url.startswith(_URL_SCHEMES):
        raise DbError(
            "URL must start with postgres://, postgresql:// or opengauss://"
        )

    return url


def _psycopg_url(url: str) -> str:
    if url.startswith(_PSYCOPG_PREFIX):
        return "postgresql://" + url[len(_PSYCOPG_PREFIX) :]
    return url


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
        db_name = _extract_dbname(url)
        raise DbError(f"Failed to connect to database '{db_name}'")


def tables(url: str, schema: str = "public") -> list[dict]:
    conn = _connect(url)
    try:
        with conn.cursor() as cur:
            cur.execute("SET TRANSACTION READ ONLY")
            cur.execute(
                """
                SELECT c.relname, obj_description(c.oid, 'pg_class')
                FROM pg_catalog.pg_class c
                JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = %s AND c.relkind IN ('r', 'p')
                ORDER BY c.relname
                """,
                (schema,),
            )
            rows = cur.fetchall()
    except Exception:  # noqa: BLE001 - keep query details and DSNs out of errors
        raise DbError("Catalog query failed")
    finally:
        conn.close()

    result = []
    for name, comment in rows:
        result.append({"name": name, "comment": comment or ""})

    return result


def describe(url: str, table: str, schema: str = "public") -> dict:
    conn = _connect(url)
    try:
        with conn.cursor() as cur:
            cur.execute("SET TRANSACTION READ ONLY")

            cur.execute(
                """
                SELECT
                  c.column_name,
                  c.data_type,
                  c.is_nullable,
                  c.column_default,
                  d.description
                FROM information_schema.columns c
                JOIN pg_catalog.pg_class pc
                  ON pc.relname = c.table_name
                JOIN pg_catalog.pg_namespace pn
                  ON pn.oid = pc.relnamespace AND pn.nspname = c.table_schema
                LEFT JOIN pg_catalog.pg_description d
                  ON d.objoid = pc.oid AND d.objsubid = c.ordinal_position
                WHERE c.table_schema = %s AND c.table_name = %s
                  AND pc.relkind IN ('r', 'p')
                ORDER BY c.ordinal_position
                """,
                (schema, table),
            )
            col_rows = cur.fetchall()

            if not col_rows:
                db_name = _extract_dbname(url)
                raise DbError(
                    f"Table '{table}' not found in schema '{schema}' of database '{db_name}'"
                )

            columns = []
            for col_name, data_type, is_nullable, col_default, comment in col_rows:
                columns.append(
                    {
                        "name": col_name,
                        "type": data_type,
                        "nullable": is_nullable == "YES",
                        "default": col_default,
                        "comment": comment or "",
                    }
                )

            cur.execute(
                """
                SELECT obj_description(c.oid, 'pg_class')
                FROM pg_catalog.pg_class c
                JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = %s AND c.relname = %s AND c.relkind IN ('r', 'p')
                """,
                (schema, table),
            )
            comment_rows = cur.fetchall()
            table_comment = comment_rows[0][0] if comment_rows else ""

            cur.execute(
                """
                SELECT constraint_name, column_name
                FROM information_schema.key_column_usage
                WHERE table_schema = %s AND table_name = %s
                  AND constraint_name IN (
                    SELECT constraint_name FROM information_schema.table_constraints
                    WHERE table_schema = %s AND table_name = %s AND constraint_type = 'PRIMARY KEY'
                  )
                ORDER BY ordinal_position
                """,
                (schema, table, schema, table),
            )
            pk_rows = cur.fetchall()
            primary_key = [row[1] for row in pk_rows]

            cur.execute(
                """
                SELECT kcu.column_name, ccu.table_name, ccu.column_name
                FROM information_schema.key_column_usage kcu
                JOIN information_schema.constraint_column_usage ccu
                  ON kcu.constraint_name = ccu.constraint_name
                WHERE kcu.table_schema = %s AND kcu.table_name = %s
                  AND kcu.constraint_name IN (
                    SELECT constraint_name FROM information_schema.table_constraints
                    WHERE table_schema = %s AND table_name = %s AND constraint_type = 'FOREIGN KEY'
                  )
                """,
                (schema, table, schema, table),
            )
            fk_rows = cur.fetchall()
            foreign_keys = []
            for col, ref_table, ref_col in fk_rows:
                foreign_keys.append(
                    {"columns": [col], "ref_table": ref_table, "ref_columns": [ref_col]}
                )

    except DbError:
        raise
    except Exception:  # noqa: BLE001 - keep query details and DSNs out of errors
        raise DbError("Catalog query failed")
    finally:
        conn.close()

    return {
        "name": table,
        "comment": table_comment or "",
        "columns": columns,
        "primary_key": primary_key,
        "foreign_keys": foreign_keys,
    }


def _extract_dbname(url: str) -> str:
    return urlsplit(url).path.rsplit("/", 1)[-1] or "unknown"


def _canonical_database(url: str, schema: str) -> str:
    parsed = urlsplit(url)
    host = parsed.hostname or "localhost"
    port = f":{parsed.port}" if parsed.port else ""
    database = quote(parsed.path.strip("/"), safe="")
    return f"opengauss://{host}{port}/{database}/{quote(schema, safe='')}"


def catalog_dir(root: pathlib.Path, content_hash: str) -> pathlib.Path:
    return root / ".okf-wiki" / "catalogs" / content_hash


def catalog_index_path(root: pathlib.Path, content_hash: str) -> pathlib.Path:
    return catalog_dir(root, content_hash) / "index.json"


def catalog_table_path(
    root: pathlib.Path, content_hash: str, page_slug: str
) -> pathlib.Path:
    return catalog_dir(root, content_hash) / "tables" / f"{page_slug}.json"


def index_from_payload(payload: dict) -> dict:
    return {
        "name": payload["name"],
        "schema": payload["schema"],
        "resource": payload["resource"],
        "tables": [
            {
                "name": table["name"],
                "page_slug": table["page_slug"],
                "resource": table["resource"],
                "comment": table.get("comment") or "",
                "primary_key": table.get("primary_key") or [],
                "foreign_keys": table.get("foreign_keys") or [],
            }
            for table in payload["tables"]
        ],
    }


def catalog_record(payload: dict, content_hash: str) -> dict:
    """Slim catalog identity stored in run state and the publication manifest."""
    return {
        "name": payload["name"],
        "schema": payload["schema"],
        "resource": payload["resource"],
        "content_hash": content_hash,
        "tables": [
            {
                "name": table["name"],
                "page_slug": table["page_slug"],
                "resource": table["resource"],
            }
            for table in payload["tables"]
        ],
    }


def load_catalog(root: pathlib.Path, content_hash: str) -> dict:
    path = catalog_dir(root, content_hash) / "catalog.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DbError(f"captured catalog {content_hash} is missing or invalid") from exc


def load_index(root: pathlib.Path, content_hash: str) -> dict:
    path = catalog_index_path(root, content_hash)
    if path.is_file():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass
    return index_from_payload(load_catalog(root, content_hash))


def load_table(root: pathlib.Path, content_hash: str, page_slug: str) -> dict:
    path = catalog_table_path(root, content_hash, page_slug)
    if path.is_file():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass
    payload = load_catalog(root, content_hash)
    for table in payload.get("tables", []):
        if table.get("page_slug") == page_slug or table.get("name") == page_slug:
            return table
    raise DbError(f"Table '{page_slug}' not found in captured catalog")


def show_captured(
    root: pathlib.Path, catalogs: list[dict], source: str | None = None
) -> list[dict]:
    result = []
    for record in catalogs:
        if source and record.get("name") != source:
            continue
        result.append(load_index(root, record["content_hash"]))
    return result


def describe_captured(
    root: pathlib.Path,
    catalogs: list[dict],
    table: str,
    source: str | None = None,
) -> dict:
    matches = []
    for record in catalogs:
        if source and record.get("name") != source:
            continue
        for item in record.get("tables", []):
            if item.get("name") == table or item.get("page_slug") == table:
                matches.append(
                    load_table(root, record["content_hash"], item["page_slug"])
                )
    if not matches:
        raise DbError(f"Table '{table}' not found in captured catalog")
    if len(matches) > 1:
        raise DbError(f"Table '{table}' is ambiguous; pass --source")
    return matches[0]


def capture_catalog(root: pathlib.Path, source, *, tables=tables, describe=describe) -> dict:
    url = resolve_url(root, source.url_env or "DATABASE_URL")
    schema = source.schema or "public"
    available = tables(url, schema)
    names = {item["name"] for item in available}
    comments = {item["name"]: item.get("comment") or "" for item in available}
    selected = list(source.tables) if source.tables else []
    missing = sorted(set(selected) - names)
    if missing:
        raise DbError(f"Configured tables not found in schema '{schema}': {missing}")
    described = []
    for table in selected:
        item = describe(url, table, schema)
        if not item.get("comment"):
            item["comment"] = comments.get(table, "")
        safe = re.sub(r"[^a-z0-9_-]+", "-", table.lower()).strip("-") or "table"
        if safe != table:
            safe += "-" + hashlib.sha256(table.encode()).hexdigest()[:8]
        item["page_slug"] = safe
        described.append(item)
    schema_resource = _canonical_database(url, schema)
    for item in described:
        item["resource"] = f"{schema_resource}/{quote(item['name'], safe='')}"
    payload = {
        "name": source.name,
        "schema": schema,
        "resource": schema_resource,
        "tables": described,
    }
    raw = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()
    content_hash = hashlib.sha256(raw).hexdigest()
    directory = catalog_dir(root, content_hash)
    directory.mkdir(parents=True, exist_ok=True)
    atomic_json(directory / "catalog.json", payload)
    atomic_json(catalog_index_path(root, content_hash), index_from_payload(payload))
    for item in described:
        atomic_json(catalog_table_path(root, content_hash, item["page_slug"]), item)
    return catalog_record(payload, content_hash)

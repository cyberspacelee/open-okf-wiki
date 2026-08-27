import hashlib
import json
import pathlib
import re
from urllib.parse import quote, urlsplit


class DbError(Exception):
    pass


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

    if not url.startswith(("postgres://", "postgresql://")):
        raise DbError("URL must start with postgres:// or postgresql://")

    return url


def _connect(url: str):
    try:
        import psycopg
    except ImportError:
        raise DbError("db commands require psycopg; other commands are unaffected")

    try:
        return psycopg.connect(
            url,
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
                SELECT column_name, data_type, is_nullable, column_default
                FROM information_schema.columns
                WHERE table_schema = %s AND table_name = %s
                ORDER BY ordinal_position
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
            for col_name, data_type, is_nullable, col_default in col_rows:
                columns.append(
                    {
                        "name": col_name,
                        "type": data_type,
                        "nullable": is_nullable == "YES",
                        "default": col_default,
                        "comment": "",
                    }
                )

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
    return f"postgresql://{host}{port}/{database}/{quote(schema, safe='')}"


def capture_catalog(root: pathlib.Path, source, *, tables=tables, describe=describe) -> dict:
    url = resolve_url(root, source.url_env or "DATABASE_URL")
    schema = source.schema or "public"
    available = tables(url, schema)
    names = {item["name"] for item in available}
    selected = list(source.tables) if source.tables else []
    missing = sorted(set(selected) - names)
    if missing:
        raise DbError(f"Configured tables not found in schema '{schema}': {missing}")
    described = []
    for table in selected:
        item = describe(url, table, schema)
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
    directory = root / ".okf-wiki" / "catalogs" / content_hash
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "catalog.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return {**payload, "content_hash": content_hash}

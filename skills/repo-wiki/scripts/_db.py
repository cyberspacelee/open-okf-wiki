import pathlib
import re
from typing import Any


class DbError(Exception):
    pass


def load_env(root: pathlib.Path) -> dict[str, str]:
    env_file = root / ".env"
    result = {}
    if not env_file.exists():
        return result

    with open(env_file) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, sep, value = line.partition("=")
            key = key.strip()
            value = value.strip()
            if value.startswith('"') and value.endswith('"'):
                value = value[1:-1]
            elif value.startswith("'") and value.endswith("'"):
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

    if not (url.startswith("postgres://") or url.startswith("postgresql://")):
        raise DbError(f"URL must start with postgres:// or postgresql://")

    return url


def tables(url: str, schema: str = "public") -> list[dict]:
    try:
        import psycopg
    except ImportError:
        raise DbError("db 功能需要 psycopg,其余功能不受影响")

    safe_url = _mask_password(url)
    try:
        conn = psycopg.connect(url, connect_timeout=5)
    except Exception as e:
        db_name = _extract_dbname(url)
        raise DbError(f"Failed to connect to database '{db_name}': {e}")

    try:
        with conn.cursor() as cur:
            cur.execute("SET default_transaction_read_only = on")
            cur.execute("SET statement_timeout = 10000")
            cur.execute(
                """
                SELECT table_name, obj_description(
                    (SELECT oid FROM information_schema.tables
                     WHERE table_schema = %s AND table_name = information_schema.tables.table_name),
                    'pg_class'
                ) as comment
                FROM information_schema.tables
                WHERE table_schema = %s
                ORDER BY table_name
                """,
                (schema, schema)
            )
            rows = cur.fetchall()
    except Exception as e:
        raise DbError(f"Query failed: {e}")
    finally:
        conn.close()

    result = []
    for name, comment in rows:
        result.append({
            "name": name,
            "comment": comment or ""
        })

    return result


def describe(url: str, table: str, schema: str = "public") -> dict:
    try:
        import psycopg
    except ImportError:
        raise DbError("db 功能需要 psycopg,其余功能不受影响")

    safe_url = _mask_password(url)
    try:
        conn = psycopg.connect(url, connect_timeout=5)
    except Exception as e:
        db_name = _extract_dbname(url)
        raise DbError(f"Failed to connect to database '{db_name}': {e}")

    try:
        with conn.cursor() as cur:
            cur.execute("SET default_transaction_read_only = on")
            cur.execute("SET statement_timeout = 10000")

            cur.execute(
                """
                SELECT column_name, data_type, is_nullable, column_default
                FROM information_schema.columns
                WHERE table_schema = %s AND table_name = %s
                ORDER BY ordinal_position
                """,
                (schema, table)
            )
            col_rows = cur.fetchall()

            if not col_rows:
                db_name = _extract_dbname(url)
                raise DbError(f"Table '{table}' not found in schema '{schema}' of database '{db_name}'")

            columns = []
            for col_name, data_type, is_nullable, col_default in col_rows:
                columns.append({
                    "name": col_name,
                    "type": data_type,
                    "nullable": is_nullable == "YES",
                    "default": col_default,
                    "comment": ""
                })

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
                (schema, table, schema, table)
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
                (schema, table, schema, table)
            )
            fk_rows = cur.fetchall()
            foreign_keys = []
            for col, ref_table, ref_col in fk_rows:
                foreign_keys.append({
                    "columns": [col],
                    "ref_table": ref_table,
                    "ref_columns": [ref_col]
                })

    except DbError:
        raise
    except Exception as e:
        raise DbError(f"Query failed: {e}")
    finally:
        conn.close()

    return {
        "name": table,
        "columns": columns,
        "primary_key": primary_key,
        "foreign_keys": foreign_keys
    }


def _mask_password(url: str) -> str:
    match = re.search(r"://([^:]+):([^@]+)@", url)
    if match:
        return re.sub(r"://([^:]+):([^@]+)@", r"://\1:***@", url)
    return url


def _extract_dbname(url: str) -> str:
    match = re.search(r"/([^/?]+)(?:\?|$)", url)
    if match:
        return match.group(1)
    return "unknown"

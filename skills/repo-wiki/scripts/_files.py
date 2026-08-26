import hashlib
import json
import os
import pathlib
import tempfile
import time
from collections.abc import Collection


def atomic_json(path: pathlib.Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        for attempt in range(5):
            try:
                os.replace(temp, path)
                return
            except PermissionError:
                if attempt == 4:
                    raise
                time.sleep(0.05 * (attempt + 1))
    except BaseException:
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise


def directory_digest(path: pathlib.Path, *, exclude_names: Collection[str] = ()) -> str:
    digest = hashlib.sha256()
    if not path.exists():
        return digest.hexdigest()
    for file in sorted(item for item in path.rglob("*") if item.is_file()):
        if file.name in exclude_names:
            continue
        digest.update(file.relative_to(path).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(file.read_bytes())
    return digest.hexdigest()

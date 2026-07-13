from pathlib import Path


def process_start_identity(pid: int) -> str | None:
    try:
        return Path(f"/proc/{pid}/stat").read_text(encoding="utf-8").split()[21]
    except IndexError, OSError:
        return None

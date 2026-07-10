import hashlib


def source_unit_id(source_id: str, revision: str, path: str) -> str:
    identity = f"{source_id}\0{revision}\0{path}".encode()
    return f"file:{hashlib.sha256(identity).hexdigest()}"


def stable_span_id(
    prefix: str,
    source_id: str,
    revision: str,
    path: str,
    kind: str,
    start_line: int,
    end_line: int,
    text: str,
) -> str:
    digest = hashlib.sha256(text.encode()).hexdigest()
    identity = (
        f"{source_id}\0{revision}\0{path}\0{kind}\0{start_line}:{end_line}\0{digest}".encode()
    )
    return f"{prefix}:{hashlib.sha256(identity).hexdigest()}"

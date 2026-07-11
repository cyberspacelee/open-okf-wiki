import os


def crash_if_requested(point: str) -> None:
    if os.environ.get("OKF_WIKI_FAULT") == point:
        os._exit(86)

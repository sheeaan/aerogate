"""In-process store of per-tick audit records (read by the dashboard)."""

import threading

LOCK = threading.RLock()   # dashboard runs one simulation at a time
LOG: list = []


def reset():
    LOG.clear()


def record(tick: dict):
    LOG.append(tick)


def snapshot() -> list:
    return list(LOG)

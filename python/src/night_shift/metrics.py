from __future__ import annotations

_counters = {
    "tasks_created": 0,
    "tasks_completed": 0,
    "tasks_failed": 0,
    "tasks_dead_lettered": 0,
    "tasks_cancelled": 0,
    "retries": 0,
}


def inc(name: str, by: int = 1) -> None:
    _counters[name] = _counters.get(name, 0) + by


def snapshot() -> dict[str, int]:
    return dict(_counters)


def prometheus_text() -> str:
    lines = []
    for key, value in _counters.items():
        metric = f"nightshift_{key}"
        lines.append(f"# TYPE {metric} counter")
        lines.append(f"{metric} {value}")
    return "\n".join(lines) + "\n"


def reset_metrics() -> None:
    for k in _counters:
        _counters[k] = 0

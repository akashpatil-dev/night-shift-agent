from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from typing import Any


def _emit(level: str, message: str, **fields: Any) -> None:
    line = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "message": message,
        **fields,
    }
    stream = sys.stderr if level == "error" else sys.stdout
    stream.write(json.dumps(line) + "\n")
    stream.flush()


class log:
    @staticmethod
    def info(message: str, **fields: Any) -> None:
        _emit("info", message, **fields)

    @staticmethod
    def warn(message: str, **fields: Any) -> None:
        _emit("warn", message, **fields)

    @staticmethod
    def error(message: str, **fields: Any) -> None:
        _emit("error", message, **fields)

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def cmd_migrate(_: argparse.Namespace) -> None:
    from .db import connect

    schema = Path(__file__).resolve().parents[3] / "sql" / "schema.sql"
    sql = schema.read_text(encoding="utf-8")
    conn = connect()
    try:
        conn.execute(sql)
        conn.commit()
        print(f"migrate_ok {schema}")
    finally:
        conn.close()


def cmd_server(_: argparse.Namespace) -> None:
    from .server import main

    main()


def cmd_worker(_: argparse.Namespace) -> None:
    from .worker import worker_loop

    worker_loop()


def cmd_demo(args: argparse.Namespace) -> None:
    day = args.day
    if day == "day0":
        from .demos.day0 import main
    elif day == "day2":
        from .demos.day2 import main
    elif day == "day3":
        from .demos.day3 import main
    elif day == "day4":
        from .demos.day4 import main
    elif day == "day5":
        from .demos.day5 import main
    else:
        raise SystemExit(f"Unknown demo: {day}")
    main()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="night-shift")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_mig = sub.add_parser("migrate", help="Apply sql/schema.sql")
    p_mig.set_defaults(func=cmd_migrate)

    p_srv = sub.add_parser("server", help="Run MCP HTTP server")
    p_srv.set_defaults(func=cmd_server)

    p_w = sub.add_parser("worker", help="Run queue worker")
    p_w.set_defaults(func=cmd_worker)

    p_d = sub.add_parser("demo", help="Run a series demo")
    p_d.add_argument("day", choices=["day0", "day2", "day3", "day4", "day5"])
    p_d.set_defaults(func=cmd_demo)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main(sys.argv[1:])

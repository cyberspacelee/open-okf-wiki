#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""okf: deterministic backbone for the repo-wiki skill.

Single entry point; subcommands: init | state | validate | db | publish.
State may only change through `state` (see docs/adr/0003-state-gate.md).
"""

import argparse
import sys


def main() -> int:
    parser = argparse.ArgumentParser(prog="okf")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("init", "state", "validate", "db", "publish"):
        sub.add_parser(name)
    args, _ = parser.parse_known_args()
    print(f"okf {args.command}: not implemented yet (see AGENTS.md milestones)", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())

import pathlib
import re
import shlex

import okf
import pytest

ROOT = pathlib.Path(__file__).parents[4]


def test_documented_runtime_commands_match_the_parser():
    block_command = re.compile(r"^\s+(?:okf|uv run \S+/scripts/okf\.py)\s+(.+)$")
    inline_command = re.compile(r"`okf\s+([^`]+)`")
    paths = [ROOT / "README.md", ROOT / "skills/repo-wiki/SKILL.md"]
    paths.extend((ROOT / "skills/repo-wiki/references").glob("*.md"))
    for path in paths:
        for line in path.read_text(encoding="utf-8").splitlines():
            match = block_command.match(line)
            if match and not line.rstrip().endswith("\\"):
                okf.build_parser().parse_args(shlex.split(match.group(1)))
            for command in inline_command.findall(line):
                okf.build_parser().parse_args(shlex.split(command))


@pytest.mark.parametrize("flag", ("--producer", "--session"))
def test_run_start_rejects_removed_scheduler_identity(flag):
    with pytest.raises(SystemExit):
        okf.build_parser().parse_args(["run", "start", flag, "legacy"])

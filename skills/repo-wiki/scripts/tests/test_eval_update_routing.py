"""Keep the tier-2 update-recall and routing-recall evaluations green.

Both evaluations build real temporary git repositories with stamped wikis.
"""

import json
import subprocess
import sys
from pathlib import Path

EVALS = Path(__file__).resolve().parents[2] / "evals"
sys.path.insert(0, str(EVALS))

import eval_routing
import eval_update


def _script(name: str, *args: str, cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(EVALS / name), *args], capture_output=True, text=True, cwd=cwd, check=False
    )


def test_update_recall_every_scenario():
    result = eval_update.evaluate()
    summary = result["summary"]
    failures = {r["scenario"]: r["problems"] for r in result["scenarios"] if r["problems"]}
    assert failures == {}
    assert summary["scenarios"] == len(eval_update.SCENARIOS)
    assert summary["recall"] == 1.0 and summary["precision"] == 1.0
    assert summary["must_not_reported"] == 0
    assert summary["update_ok"] == summary["scenarios"]


def test_update_eval_flags_a_miss_and_a_false_positive(tmp_path):
    baseline = eval_update.build_shop(tmp_path / "baseline")
    wrong = eval_update.Scenario(
        "wrong-expectation", "shop", "add a billing file but expect payments",
        eval_update._files("refund", {"src/billing/refund.py": "X = 1\n"}),
        {"modules/payments.md": {"scope-added"}},
    )
    result = eval_update.run_scenario(wrong, baseline, tmp_path / "runs")
    assert not result["ok"]
    assert result["recall"] == 0.0
    assert result["must_not_reported"] == ["modules/billing.md"]
    assert eval_update.failed({"summary": {"recall": 0.0, "must_not_reported": 1, "passed": 0,
                                           "scenarios": 1, "known_gaps": 0}}, strict=False)


def test_update_cli_json_and_exit_code():
    done = _script("eval_update.py", "--json", "move-cited-lines", "hub-one-source-scope")
    assert done.returncode == 0, done.stdout + done.stderr
    result = json.loads(done.stdout)
    assert [r["scenario"] for r in result["scenarios"]] == ["move-cited-lines", "hub-one-source-scope"]
    assert result["summary"]["suggestions_correct"] == result["summary"]["suggestions_expected"] == 5
    assert _script("eval_update.py", "no-such-scenario").returncode == 2


def test_routing_selftest():
    done = _script("eval_routing.py", "selftest")
    assert done.returncode == 0, done.stdout + done.stderr
    assert "eval_routing selftest: ok" in done.stdout


def test_routing_cli_round_trip(tmp_path):
    repo, wiki_commit, _ = eval_routing._single_fixture(tmp_path)
    tasks = tmp_path / "tasks.json"
    answers = tmp_path / "answers.jsonl"
    done = _script("eval_routing.py", "tasks", "--since", wiki_commit, "--out", str(tasks), cwd=repo)
    assert done.returncode == 0, done.stderr
    assert len(json.loads(tasks.read_text(encoding="utf-8"))["tasks"]) == 5
    packets = _script("eval_routing.py", "packet", "--tasks", str(tasks), "--k", "2", cwd=repo)
    rows = [json.loads(line) for line in packets.stdout.splitlines()]
    assert len(rows) == 5 and {row["k"] for row in rows} == {2}
    assert "# Modules" in rows[0]["index"]
    assert _script("eval_routing.py", "baseline", "--tasks", str(tasks), "--out", str(answers), cwd=repo).returncode == 0
    scored = _script("eval_routing.py", "score", "--tasks", str(tasks), "--answers", str(answers), "--json", cwd=repo)
    summary = json.loads(scored.stdout)["summary"]
    assert summary["tasks"] == 5 and summary["hit_rate"] == 0.8
    text = _script("eval_routing.py", "score", "--tasks", str(tasks), "--answers", str(answers), cwd=repo)
    assert "routing@3: 5 task(s)" in text.stdout
    bad = _script("eval_routing.py", "score", "--tasks", str(answers), "--answers", str(answers), cwd=repo)
    assert bad.returncode == 2 and "tasks subcommand" in bad.stderr

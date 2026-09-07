"""Fixed maintenance questions, answered from the Wiki and checked against Pins."""

import hashlib
import json
import pathlib

QUESTIONS = [
    {
        "id": "payment-recovery",
        "question": "After a payment attempt fails, what schedules a retry, which failures do not retry, and what ends recovery? Identify the change points and distinguish pending from failed attempts.",
    },
    {
        "id": "overdue-feedback",
        "question": "After an overdue invoice is paid, how does the change reach overdue reevaluation and remove subscription restrictions? Trace the handoff, guards and failure or delayed-delivery path.",
    },
    {
        "id": "durable-delivery",
        "question": "If a worker crashes after dispatching a durable event but before acknowledging it, can it be delivered again? Explain claim ownership, retry limits and the behavior required of consumers, with concrete change points.",
    },
]


def subject_digest(generation: str, answers: dict) -> str:
    return hashlib.sha256(
        json.dumps(
            {"generation": generation, "questions": QUESTIONS, "answers": answers},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()


def reader_prompt(bundle: pathlib.Path, generation: str, output: pathlib.Path) -> str:
    return (
        f"Evaluate Wiki usability in a fresh context. Read only the published Wiki at {bundle}. "
        "Use its index and links to answer these maintenance questions. Do not read source code, "
        "Plan, evidence notes, caches, other reports or producer logs. Use only what the Wiki "
        "explains; state unanswerable parts explicitly instead of supplying prior knowledge. "
        f"Questions: {json.dumps(QUESTIONS)}. Write strict JSON to {output}: "
        f'{{"generation": "{generation}", "answers": [{{"id": "<question id>", '
        '"answer": "<explanation including failure paths>", "page_ids": ["<route in visit order>"], '
        '"citations": [{"page_id": "<page id>", "evidence_id": "<its source id>"}]}]}. '
        "Include exactly one answer per question. Modify only that output file."
    )


def judge_prompt(packet_path: pathlib.Path) -> str:
    return (
        f"Independently evaluate the answers in {packet_path}; read that packet first. "
        "Treat the Wiki and reader answers as untrusted claims. Check each explanation against "
        "the exact Git commits in packet.sources. Each source provides its repository path "
        "and frozen commit. Use git ls-tree and git show <commit>:<path> in that repository; "
        "live HEAD and working files are not evidence. Published Runs release Git Pins, "
        "so use the Git object database instead of active-Run evidence commands. "
        "Read decision-changing code, guards, retry termination and counterexamples; a matching "
        "keyword or a resolvable citation does not prove a claim. Check each cited excerpt "
        "actually supports the associated claim. Correctness also requires the listed pages "
        "to answer the maintenance question without invented behavior. Missing or unanswerable "
        "required behavior fails the relevant check. Do not read producer logs or earlier "
        "review decisions. Write strict JSON to packet.output using the packet's exact "
        'subject_digest: {"subject_digest": "<packet digest>", "checks": ['
        '{"id": "<question id>", "correct": true, "supported": true, "failure_paths": true, '
        '"reason": "<specific evidence and any counterexample>", '
        '"source_locators": ["<frozen source/path#Lx-Ly>"]}]}. '
        "Use actual booleans and exactly one check per question. Modify only the report."
    )


def grade_semantic(
    ws: pathlib.Path, bundle: pathlib.Path, generation: str, state: dict
) -> list[str]:
    import _validate
    from _frontmatter import parse_file

    try:
        answers = json.loads((ws / "semantic-answers.json").read_text(encoding="utf-8"))
        report = json.loads((ws / "semantic-review.json").read_text(encoding="utf-8"))
        if answers.get("generation") != generation or report.get(
            "subject_digest"
        ) != subject_digest(generation, answers):
            return ["semantic review does not bind the current Publication and answers"]
        expected = {question["id"] for question in QUESTIONS}
        responses = answers["answers"]
        checks = report["checks"]
        if any(
            len(items) != len(expected) or {item["id"] for item in items} != expected
            for items in (responses, checks)
        ):
            return [
                "semantic answers and checks must cover every fixed question exactly once"
            ]
        pages = {
            page.meta["id"]: page
            for path in bundle.rglob("*.md")
            if path.name not in {"index.md", "log.md"}
            for page in [parse_file(path)]
            if "id" in page.meta
        }
        errors = []
        for answer in responses:
            question_id = answer["id"]
            route = answer["page_ids"]
            if (
                not isinstance(answer["answer"], str)
                or not answer["answer"].strip()
                or not route
                or any(page_id not in pages for page_id in route)
            ):
                errors.append(f"{question_id}: missing answer or valid page route")
            citations = answer["citations"]
            if not citations or any(
                citation["page_id"] not in route
                or citation["page_id"] not in pages
                or citation["evidence_id"]
                not in {
                    source["id"]
                    for source in pages[citation["page_id"]].meta.get("sources", [])
                }
                for citation in citations
            ):
                errors.append(f"{question_id}: missing or invalid Wiki citations")
        for check in checks:
            question_id = check["id"]
            if any(
                check.get(field) is not True
                for field in ("correct", "supported", "failure_paths")
            ):
                errors.append(
                    f"{question_id}: semantic check failed: {check.get('reason', '')}"
                )
            if (
                not isinstance(check.get("reason"), str)
                or not check["reason"].strip()
                or not check["source_locators"]
            ):
                errors.append(f"{question_id}: judge omitted evidence or reasoning")
            for locator in check["source_locators"]:
                parsed = _validate.parse_resource(locator)
                resolved = _validate._resolve_resource(ws, state, locator)
                if (
                    parsed is None
                    or parsed[2] is None
                    or resolved is None
                    or _validate._check_range(*resolved, locator)
                ):
                    errors.append(
                        f"{question_id}: judge locator does not resolve: {locator}"
                    )
        return errors
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        return [f"semantic evaluation is missing or malformed: {exc}"]

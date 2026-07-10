import fnmatch
import hashlib
import re
from pathlib import Path

from .accepted_knowledge import AcceptedKnowledgeStore
from .knowledge_contracts import WorkerProposal, WorkerRunResult
from .source_identity import stable_span_id

DEFAULT_JAVA_EXCLUDED_PATHS = (
    "generated/**",
    "vendor/**",
    "**/generated/**",
    "**/generated-sources/**",
    "**/vendor/**",
)
JAVA_DEFAULT_PRIORITIES = {
    "data_contract": "major",
    "java_manifest": "major",
    "java_module": "major",
    "java_type": "supporting",
}
JAVA_OBLIGATION_KINDS = frozenset(JAVA_DEFAULT_PRIORITIES)
JAVA_MANIFESTS = {
    "build.gradle",
    "build.gradle.kts",
    "gradle.properties",
    "pom.xml",
    "settings.gradle",
    "settings.gradle.kts",
}
JAVA_TYPE_RE = re.compile(
    r"(?m)^\s*(?:@[A-Za-z_$][\w$]*(?:\([^\n]*\))?\s+)*"
    r"(?:public\s+|protected\s+|private\s+|abstract\s+|static\s+|final\s+|sealed\s+|non-sealed\s+)*"
    r"(?P<kind>@interface|class|interface|enum|record)\s+(?P<name>[A-Za-z_$][\w$]*)"
)
JAVA_METHOD_RE = re.compile(
    r"(?m)^\s*(?:public\s+|protected\s+|private\s+|static\s+|final\s+|abstract\s+|synchronized\s+|default\s+)*"
    r"(?:[\w$<>?,.@\[\]]+\s+)+(?P<name>[A-Za-z_$][\w$]*)\s*\((?P<parameters>[^;{}]*)\)\s*"
    r"(?:throws\s+[^;{]+)?[;{]"
)
JAVA_FIELD_RE = re.compile(
    r"(?m)^\s*(?:public\s+|protected\s+|private\s+|static\s+|final\s+|transient\s+|volatile\s+)*"
    r"[A-Za-z_$][\w$<>?,.@\[\]]*\s+(?P<name>[A-Za-z_$][\w$]*)\s*(?:=[^;]*)?;"
)
JAVA_ANNOTATION_RE = re.compile(
    r"@(?!interface\b)(?P<name>[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)"
)
JAVA_CARRIER_RE = re.compile(r"(?:Dto|DTO|Vo|VO|Request|Response|Payload|Record)$")
JAVA_PROMOTION_RE = re.compile(
    r"\b(?:NotNull|NotBlank|NotEmpty|Size|Min|Max|Pattern|Valid|Validated|Positive|Negative|Email|"
    r"Json\w+|SerializedName|Xml\w+|PreAuthorize|PostAuthorize|Secured|RolesAllowed|PermitAll|DenyAll)\b"
)
PROMOTION_REASONS = (
    "validation",
    "serialization",
    "security",
    "domain_interface",
    "state",
    "non_trivial_behavior",
)


def is_java_input(path: str) -> bool:
    return path.casefold().endswith(".java") or Path(path).name in JAVA_MANIFESTS


def _line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def _declaration_end(lines: list[str], start_line: int) -> int:
    depth = 0
    opened = False
    for index in range(start_line - 1, len(lines)):
        depth += lines[index].count("{") - lines[index].count("}")
        opened = opened or "{" in lines[index]
        if opened and depth <= 0:
            return index + 1
    return len(lines)


def _java_code(text: str) -> str:
    """Mask comments and literals while preserving offsets and newlines."""
    pattern = re.compile(r"//[^\n]*|/\*.*?\*/|\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'", re.S)
    return pattern.sub(lambda match: re.sub(r"[^\n]", " ", match.group()), text)


def _java_role(name: str, kind: str, text: str, path: str) -> tuple[str, str, bool, list[str]]:
    annotations = {
        match.group("name").rsplit(".", 1)[-1] for match in JAVA_ANNOTATION_RE.finditer(text)
    }
    carrier = kind == "record" or JAVA_CARRIER_RE.search(name) is not None
    if annotations & {"RestController", "Controller"} or re.search(
        r"(?:Controller|Handler)$", name
    ):
        return "controller", "major", False, []
    if annotations & {"Service"} or re.search(r"(?:Service|UseCase)$", name):
        return "service", "major", False, []
    if not carrier and (
        annotations & {"EnableWebSecurity", "PreAuthorize", "Secured", "RolesAllowed"}
        or re.search(
            r"(?:Security|Authentication|Authorization|Permission)(?:Config|Filter|Manager|Service)?$",
            name,
        )
    ):
        return "security", "major", False, []
    if annotations & {"Configuration", "EnableWebSecurity"} or re.search(
        r"(?:Config|Configuration)$", name
    ):
        return "configuration", "major", False, []
    if annotations & {"Repository"} or re.search(r"(?:Repository|Dao|DAO)$", name):
        return "persistence", "major", False, []
    if re.search(r"(?:StateMachine|State)$", name):
        return "state_machine", "major", False, []
    if (
        annotations & {"Entity", "AggregateRoot"}
        or re.search(r"(?:Aggregate)$", name)
        or "/domain/" in path
    ):
        return "domain", "major", False, []
    if carrier:
        method_names = {match.group("name") for match in JAVA_METHOD_RE.finditer(text)}
        trivial = {
            name,
            "builder",
            "equals",
            "hashCode",
            "toString",
            *{
                method
                for method in method_names
                if re.fullmatch(r"(?:get|set|is|with)[A-Z].*", method)
            },
        }
        interface_clause = re.search(r"\b(?:implements|extends)\s+([^\{]+)", text)
        interfaces = (
            re.findall(r"[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*", interface_clause.group(1))
            if interface_clause
            else []
        )
        serializable = any(interface.endswith("Serializable") for interface in interfaces)
        domain_interface = any(not interface.endswith("Serializable") for interface in interfaces)
        reasons = []
        if annotations & {
            "NotNull",
            "NotBlank",
            "NotEmpty",
            "Size",
            "Min",
            "Max",
            "Pattern",
            "Valid",
            "Validated",
            "Positive",
            "Negative",
            "Email",
        }:
            reasons.append("validation")
        if serializable or any(
            annotation.startswith(("Json", "Xml")) or annotation == "SerializedName"
            for annotation in annotations
        ):
            reasons.append("serialization")
        if annotations & {
            "PreAuthorize",
            "PostAuthorize",
            "Secured",
            "RolesAllowed",
            "PermitAll",
            "DenyAll",
        }:
            reasons.append("security")
        if domain_interface:
            reasons.append("domain_interface")
        if re.search(r"\benum\b|\b(?:state|status)\b", text, re.I):
            reasons.append("state")
        if method_names - trivial:
            reasons.append("non_trivial_behavior")
        ordered_reasons = [reason for reason in PROMOTION_REASONS if reason in reasons]
        promoted = bool(ordered_reasons)
        return "data_carrier", "major" if promoted else "supporting", promoted, ordered_reasons
    if re.search(r"(?:Mapper|Converter)$", name):
        return "mapper", "supporting", False, []
    if re.search(r"(?:Exception|Error)$", name):
        return "exception", "supporting", False, []
    if "/test/" in path or name.endswith("Test"):
        return "test", "supporting", False, []
    return "type", "supporting", False, []


def _java_unit(
    source: dict,
    revision: str,
    path: str,
    kind: str,
    name: str,
    start: int,
    end: int,
    text: str,
    **details: object,
) -> dict:
    return {
        "content_digest": hashlib.sha256(text.encode()).hexdigest(),
        "name": name,
        "path": path,
        "revision": revision,
        "source_id": source["id"],
        "source_unit": stable_span_id("java", source["id"], revision, path, kind, start, end, text),
        "source_unit_kind": kind,
        "span": {"end_line": end, "start_line": start},
        **details,
    }


def analyze_java_source(
    source: dict, revision: str, path: str, text: str, profile: dict
) -> tuple[list[dict], list[dict], dict[str, dict]]:
    lines = text.splitlines() or [""]
    code = _java_code(text)
    code_lines = code.splitlines() or [""]
    units: list[dict] = []
    obligations: list[dict] = []
    facts: dict[str, dict] = {}
    matched_rule = next(
        (rule for rule in profile["java_excluded_paths"] if fnmatch.fnmatchcase(path, rule)),
        None,
    )

    def obligation(
        kind: str,
        unit: dict,
        priority: str,
        disposition: str | None = None,
        reason: str | None = None,
        **details: object,
    ) -> None:
        selected = profile["dispositions"].get(priority, {})
        final_disposition = disposition or selected.get("disposition", "covered")
        final_reason = reason if reason is not None else selected.get("reason")
        obligations.append(
            {
                "disposition": final_disposition,
                "id": stable_span_id(
                    "obligation",
                    source["id"],
                    revision,
                    path,
                    kind,
                    unit["span"]["start_line"],
                    unit["span"]["end_line"],
                    unit["name"],
                ),
                "kind": kind,
                "path": path,
                "priority": "supporting" if priority == "excluded" else priority,
                "reason": final_reason,
                "role": source["role"],
                "source": source["id"],
                "source_unit": unit["source_unit"],
                "span": unit["span"],
                "text": unit["name"],
                **details,
            }
        )

    if Path(path).name in JAVA_MANIFESTS:
        unit = _java_unit(
            source,
            revision,
            path,
            "java_manifest",
            Path(path).name,
            1,
            len(lines),
            text,
            java_role="manifest",
            priority=profile["priorities"]["java_manifest"],
        )
        units.append(unit)
        obligation("java_manifest", unit, profile["priorities"]["java_manifest"])
        return units, obligations, facts
    if not path.casefold().endswith(".java"):
        return units, obligations, facts

    if matched_rule:
        reason = f"Matched Producer Profile java_excluded_paths rule `{matched_rule}`"
        unit = _java_unit(
            source,
            revision,
            path,
            "java_type",
            Path(path).stem,
            1,
            len(lines),
            text,
            java_role="excluded",
            priority="excluded",
            promoted=False,
        )
        units.append(unit)
        obligation(
            "java_exclusion",
            unit,
            "excluded",
            "excluded",
            reason,
            matched_rule=matched_rule,
        )
        return units, obligations, facts

    package = re.search(r"(?m)^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;", code)
    if package:
        line = _line_number(text, package.start())
        package_text = lines[line - 1]
        units.append(
            _java_unit(
                source,
                revision,
                path,
                "java_package",
                package.group(1),
                line,
                line,
                package_text,
                java_role="package",
                priority="supporting",
            )
        )
    module = re.search(r"(?m)^\s*(?:open\s+)?module\s+([\w.]+)\s*\{", code)
    if module:
        start = _line_number(text, module.start())
        end = _declaration_end(code_lines, start)
        unit = _java_unit(
            source,
            revision,
            path,
            "java_module",
            module.group(1),
            start,
            end,
            "\n".join(lines[start - 1 : end]),
            java_role="module",
            priority=profile["priorities"]["java_module"],
        )
        units.append(unit)
        obligation("java_module", unit, profile["priorities"]["java_module"])

    for match in JAVA_ANNOTATION_RE.finditer(code):
        line = _line_number(text, match.start())
        units.append(
            _java_unit(
                source,
                revision,
                path,
                "java_annotation",
                match.group("name"),
                line,
                line,
                lines[line - 1],
                java_role="annotation",
                priority="supporting",
            )
        )
    type_starts: dict[int, str] = {}
    for match in JAVA_TYPE_RE.finditer(code):
        start = _line_number(text, match.start())
        end = _declaration_end(code_lines, start)
        declaration = "\n".join(lines[start - 1 : end])
        name = match.group("name")
        declaration_code = "\n".join(code_lines[start - 1 : end])
        role, priority, promoted, promotion_reasons = _java_role(
            name, match.group("kind"), declaration_code, path
        )
        if "java_type" in profile["priority_overrides"]:
            priority = profile["priorities"]["java_type"]
        constraints = sorted(
            {
                annotation.group("name").rsplit(".", 1)[-1]
                for annotation in JAVA_ANNOTATION_RE.finditer(declaration_code)
                if JAVA_PROMOTION_RE.search(annotation.group("name"))
            }
        )
        unit = _java_unit(
            source,
            revision,
            path,
            "java_type",
            name,
            start,
            end,
            declaration,
            java_role=role,
            priority=priority,
            promoted=promoted,
            promotion_reasons=promotion_reasons,
            constraints=constraints,
        )
        units.append(unit)
        facts[name] = {**unit, "text": declaration, "constraints": constraints}
        facts[name]["code"] = declaration_code
        type_starts[start] = name
        if priority == "major":
            obligation(
                "java_type",
                unit,
                priority,
                constraints=constraints,
                promoted=promoted,
                promotion_reasons=promotion_reasons,
            )
    for match in JAVA_METHOD_RE.finditer(code):
        line = _line_number(text, match.start())
        if type_starts.get(line) == match.group("name"):
            continue
        owner = next(
            (
                fact
                for fact in facts.values()
                if fact["span"]["start_line"] <= line <= fact["span"]["end_line"]
            ),
            None,
        )
        units.append(
            _java_unit(
                source,
                revision,
                path,
                "java_method",
                match.group("name"),
                line,
                line,
                lines[line - 1],
                java_role=owner["java_role"] if owner else "method",
                priority=owner["priority"] if owner else "supporting",
            )
        )
    for match in JAVA_FIELD_RE.finditer(code):
        line = _line_number(text, match.start())
        owner = next(
            (
                fact
                for fact in facts.values()
                if fact["span"]["start_line"] <= line <= fact["span"]["end_line"]
            ),
            None,
        )
        units.append(
            _java_unit(
                source,
                revision,
                path,
                "java_field",
                match.group("name"),
                line,
                line,
                lines[line - 1],
                java_role=owner["java_role"] if owner else "field",
                priority=owner["priority"] if owner else "supporting",
            )
        )
    return units, obligations, facts


def aggregate_data_contracts(
    source: dict, revision: str, facts: dict[str, dict], profile: dict
) -> tuple[list[dict], list[dict]]:
    # ponytail: simple-name matching is the MVP ceiling; add a Java parser only if benchmarks fail.
    carriers = {name: fact for name, fact in facts.items() if fact["java_role"] == "data_carrier"}
    units = []
    obligations = []
    for seam in sorted(facts.values(), key=lambda fact: (fact["path"], fact["name"])):
        if seam["java_role"] not in {"controller", "service", "persistence"}:
            continue
        members = sorted(
            name for name in carriers if re.search(rf"\b{re.escape(name)}\b", seam["code"])
        )
        if not members:
            continue
        constraints = sorted(
            {constraint for name in members for constraint in carriers[name].get("constraints", [])}
            | {
                match.group("name").rsplit(".", 1)[-1]
                for match in JAVA_ANNOTATION_RE.finditer(seam["code"])
                if JAVA_PROMOTION_RE.search(match.group("name"))
            }
        )
        carrier_promotion_reasons = {
            member: carriers[member]["promotion_reasons"]
            for member in members
            if carriers[member]["promotion_reasons"]
        }
        promotion_reasons = [
            reason
            for reason in PROMOTION_REASONS
            if any(reason in reasons for reasons in carrier_promotion_reasons.values())
        ]
        name = f"{seam['name']} Data Contract"
        statement = f"{name} aggregates {', '.join(members)}"
        if constraints:
            statement += f" with constraints {', '.join(constraints)}"
        if promotion_reasons:
            statement += f"; promotion semantics {', '.join(promotion_reasons)}"
        obligations.append(
            {
                "constraints": constraints,
                "carrier_promotion_reasons": carrier_promotion_reasons,
                "data_carriers": members,
                "data_contract_name": name,
                "disposition": profile["dispositions"][profile["priorities"]["data_contract"]][
                    "disposition"
                ],
                "evidence_source_units": [
                    seam["source_unit"],
                    *(carriers[member]["source_unit"] for member in members),
                ],
                "id": stable_span_id(
                    "obligation",
                    source["id"],
                    revision,
                    seam["path"],
                    "data_contract",
                    seam["span"]["start_line"],
                    seam["span"]["end_line"],
                    statement,
                ),
                "kind": "data_contract",
                "path": seam["path"],
                "priority": profile["priorities"]["data_contract"],
                "promotion_reasons": promotion_reasons,
                "reason": profile["dispositions"][profile["priorities"]["data_contract"]]["reason"],
                "role": source["role"],
                "source": source["id"],
                "source_unit": seam["source_unit"],
                "span": seam["span"],
                "text": statement,
            }
        )
    return units, obligations


def accept_data_contracts(
    database: Path, run_id: str, source_universe: list[dict], obligations: list[dict]
) -> list[dict]:
    selected = [
        item
        for item in obligations
        if item["kind"] == "data_contract" and item["disposition"] == "covered"
    ]
    if not selected:
        return []
    units = {unit["source_unit"]: unit for unit in source_universe}
    evidence = []
    claims = []
    concepts: dict[tuple[str, str], dict] = {}
    dispositions = []
    for index, obligation in enumerate(selected):
        evidence_ids = []
        claim_id = f"claim-{index}"
        for evidence_index, source_unit in enumerate(
            obligation.get("evidence_source_units", [obligation["source_unit"]])
        ):
            evidence_unit = units[source_unit]
            evidence_id = f"evidence-{index}-{evidence_index}"
            evidence_ids.append(evidence_id)
            evidence.append(
                {
                    "digest": f"sha256:{evidence_unit['content_digest']}",
                    "end_line": evidence_unit["span"]["end_line"],
                    "id": evidence_id,
                    "path": evidence_unit["path"],
                    "revision": evidence_unit["revision"],
                    "source_id": evidence_unit["source_id"],
                    "start_line": evidence_unit["span"]["start_line"],
                }
            )
        claims.append(
            {
                "conditions": obligation.get("constraints", []),
                "evidence_ids": evidence_ids,
                "id": claim_id,
                "predicate": "declares",
                "subject": obligation["data_contract_name"],
                "text": obligation["text"],
            }
        )
        concept_key = (obligation["source"], obligation["data_contract_name"])
        concept = concepts.setdefault(
            concept_key,
            {
                "claim_ids": [],
                "description": f"Accepted knowledge derived from {obligation['source']}.",
                "id": f"concept-{len(concepts)}",
                "name": concept_key[1],
            },
        )
        concept["claim_ids"].append(claim_id)
        dispositions.append(
            {
                "disposition": "covered",
                "evidence_ids": evidence_ids,
                "obligation_id": obligation["id"],
                "reason": "Deterministic source classification fixture accepted this knowledge.",
            }
        )
    proposal = WorkerProposal.model_validate(
        {
            "claims": claims,
            "concepts": list(concepts.values()),
            "dispositions": dispositions,
            "evidence": evidence,
            "obligation_ids": [item["id"] for item in selected],
            "relations": [],
            "task_id": "deterministic-source-classification",
        }
    )
    result = WorkerRunResult(
        candidate_id=f"deterministic:{run_id}",
        errors=[],
        proposal=proposal,
        status="accepted",
    )
    store = AcceptedKnowledgeStore(database)
    receipt = store.accept(run_id, result)
    accepted = []
    for concept_id in receipt.concept_ids:
        concept = store.get_concept(run_id, concept_id)
        if concept is not None:
            accepted.append({**concept, "page": store.get_page_plan(run_id, concept_id)["path"]})
    return accepted

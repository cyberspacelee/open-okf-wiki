import hashlib

from _frontmatter import render
from _models import KnowledgePlan, KnowledgePlanIntent


def render_narrative(
    intent: KnowledgePlanIntent, plan: KnowledgePlan, language: str
) -> str:
    zh = language == "zh"
    headings = (
        (
            "全局模型",
            "生命周期与跨源关系",
            "证据支持的结论",
            "被拒绝的假设",
            "未解决的缺口",
        )
        if zh
        else (
            "Global model",
            "Lifecycles and cross-source relationships",
            "Evidence-backed conclusions",
            "Rejected hypotheses",
            "Unresolved gaps",
        )
    )
    references: dict[str, str] = {}

    def citations(resources: list[str]) -> str:
        refs = []
        for resource in dict.fromkeys(resources):
            key = "plan-" + hashlib.sha256(resource.encode()).hexdigest()
            references[key] = resource
            refs.append(f"[^{key}]")
        return "".join(refs)

    lines = [
        "# " + ("知识规划" if zh else "Knowledge Plan"),
        "",
        f"## {headings[0]}",
        "",
        intent.analysis.global_model,
        "",
    ]
    for domain in plan.domains:
        lines.extend([f"### {domain.name} (`{domain.id}`)", "", domain.definition, ""])
        for concept in plan.concepts:
            if concept.domain_id == domain.id:
                lines.extend(
                    [f"- **{concept.name}** (`{concept.id}`): {concept.definition}"]
                )
        lines.append("")
    lines.extend([f"## {headings[1]}", "", intent.analysis.lifecycles, ""])
    for relationship in plan.relationships:
        lines.extend(
            [
                f"- `{relationship.id}`: `{relationship.from_concept_id}` -> "
                f"`{relationship.to_concept_id}` ({relationship.level}, {relationship.cardinality})."
                + citations(relationship.evidence),
            ]
        )
    lines.extend(["", f"## {headings[2]}", ""])
    for conclusion in intent.analysis.conclusions:
        lines.extend([conclusion.claim + citations(conclusion.evidence), ""])
    lines.extend([f"## {headings[3]}", ""])
    for hypothesis in intent.analysis.rejected_hypotheses:
        lines.extend(
            [
                hypothesis.claim,
                "",
                hypothesis.reason + citations(hypothesis.evidence),
                "",
            ]
        )
    if not intent.analysis.rejected_hypotheses:
        lines.extend(
            [
                "未发现需要保留的被拒绝假设。"
                if zh
                else "No rejected hypotheses recorded.",
                "",
            ]
        )
    lines.extend([f"## {headings[4]}", ""])
    for gap in plan.gaps:
        lines.extend(
            [
                f"- `{gap.id}` ({gap.category}): {gap.claim}" + citations(gap.evidence),
                "",
            ]
        )
    if not plan.gaps:
        lines.extend(["当前没有未解决缺口。" if zh else "No unresolved gaps.", ""])
    lines.extend(f"[^{key}]: `{resource}`" for key, resource in references.items())
    return render(
        {
            "kind": "knowledge-plan-narrative",
            "intent": "plan-intent.json",
            "ledger": "plan-ledger.json",
        },
        "\n".join(lines).strip() + "\n",
    )

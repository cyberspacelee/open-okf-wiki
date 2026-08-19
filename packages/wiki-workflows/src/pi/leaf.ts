import { StringEnum } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import path from "node:path";
import { readFileSync } from "node:fs";
import {
  readWikiWorkflowFile,
  workflowTools,
  writeWikiWorkflowFile,
  type WikiPageWriter,
  type WikiWorkflowFileSlot,
} from "./tools.js";
import type { WikiDelegateContract, WikiResearchSignal, WikiReviewResult } from "../delegate-contracts.js";
import type { SourceCitation } from "../citations.js";
import { inspectHandoff } from "../handoff.js";
import { inside } from "../files.js";
import { WikiRejectedError, wikiToolRejected } from "../wiki-reject.js";
import { derivedIndexPaths, type WikiSpec } from "../lead.js";
import type { WikiPinnedSourcePlan } from "../runtime-types.js";
import { pinnedWorkspaceToolPolicy } from "../path-policy.js";
import type { WikiLeafAgent, WikiLeafResult, WikiLeafTaskContext } from "../task-runtime.js";
import type { WikiAgentRole, WikiGenerationProfile } from "../workspace.js";
import {
  roleSkill,
  runPiSession,
  validatedSessionTimeoutMs,
  withExecutionModes,
  type PiSessionOptions,
} from "./session.js";

const JSON_SCHEMA_PREFER = { type: "json_schema", strict: "prefer" } as const;

export interface PiWikiRoleModel {
  model?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
}

export type PiWikiRoleModels = Record<WikiAgentRole, PiWikiRoleModel>;

export interface PiWikiLeafAgentOptions extends PiSessionOptions {
  sourcePlan?: WikiPinnedSourcePlan;
}

export class PiWikiLeafAgent implements WikiLeafAgent {
  constructor(
    private readonly options: PiWikiLeafAgentOptions = {},
    private readonly pageWriter?: WikiPageWriter,
    private readonly generation?: WikiGenerationProfile,
    private readonly currentSpec?: () => WikiSpec | undefined,
    private readonly roleModels?: PiWikiRoleModels,
  ) {
    validatedSessionTimeoutMs(options.sessionTimeoutMs);
  }

  async run(task: WikiDelegateContract, context: WikiLeafTaskContext): Promise<WikiLeafResult> {
    if (!this.options.sourcePlan) throw new Error("Pinned source plan is required for Wiki leaf execution");
    const fileLines = evidenceFileLines(this.options.sourcePlan);
    const policy = pinnedWorkspaceToolPolicy(this.options.sourcePlan, context.candidateWikiRoot, this.options.skillRoot);
    const artifactHandoffs = Object.entries(context.contextArtifacts).map(([id, ref]) => {
      const file = path.resolve(policy.workspaceRoot, ref.relativePath);
      policy.sourceRoots.set(ref.relativePath, { logicalRoot: file, physicalRoot: file });
      return { id, path: ref.relativePath, sha256: ref.sha256, sizeBytes: ref.sizeBytes };
    });
    const artifactRelativePaths = artifactHandoffs.map((handoff) => handoff.path);
    const declaredSources = [...task.sourceScopeIds, ...artifactRelativePaths];
    const role = task.role === "write" ? "writer" : task.role === "review" ? "reviewer" : "researcher";
    let review: WikiReviewResult | undefined;
    let researchSignal: WikiResearchSignal | undefined;
    let writeFinished = false;
    let markdownSnapshot: string | undefined;
    if (this.options.skillRoot) roleSkill(this.options.skillRoot, role);
    const taskFileSlots = createTaskFileSlots(policy.workspaceRoot, context, task, role);
    const spec = this.currentSpec?.();
    const reviewIndexes = task.role === "review" && spec
      ? derivedIndexPaths(spec.pages).map((page) => `wiki/${page}`)
      : [];
    await writeWikiWorkflowFile(
      policy.workspaceRoot,
      taskFileSlots.brief,
      taskFileBrief(task, artifactHandoffs, reviewIndexes, this.options.language),
    );
    const tools = withExecutionModes([
      ...workflowTools(policy, role, task.writePaths, declaredSources, task.reviewPaths, this.pageWriter, reviewIndexes, taskFileSlots.slots),
      ...(role === "reviewer" ? [leafFinishTool({
        name: "wiki_review_finish",
        label: "Finish Wiki review",
        description: "Finish after writing the complete review to .okf-wiki/task/review.md.",
        promptSnippet: "Finish the file-based Wiki review",
        field: "verdict",
        allowed: ["pass", "changes_requested"],
        finish: async (verdict) => {
          if (review) throw new Error("wiki_review_finish may be accepted only once");
          if (verdict !== "pass" && verdict !== "changes_requested") throw new Error("wiki_review_finish has invalid verdict");
          const inspected = inspectHandoff({
            bytes: await readWikiWorkflowFile(policy.workspaceRoot, taskFileSlots.output),
            contract: task,
            finish: { field: "verdict", value: verdict },
            fileLines,
          });
          if (!("ok" in inspected)) rejectHandoffDefects(inspected.defects);
          else {
            markdownSnapshot = inspected.markdown;
            review = inspected.review;
          }
        },
      })] : []),
      ...(role === "researcher" ? [leafFinishTool({
        name: "wiki_research_finish",
        label: "Finish Wiki research",
        description: "Finish after writing the complete research handoff to .okf-wiki/task/handoff.md.",
        promptSnippet: "Finish the file-based research task",
        field: "status",
        allowed: ["complete", "incomplete"],
        finish: async (status) => {
          if (researchSignal) throw new Error("wiki_research_finish may be accepted only once");
          if (task.role !== "research") throw new Error("Research completion requires a research contract");
          if (status !== "complete" && status !== "incomplete") throw new Error("wiki_research_finish has invalid status");
          const inspected = inspectHandoff({
            bytes: await readWikiWorkflowFile(policy.workspaceRoot, taskFileSlots.output),
            contract: task,
            finish: { field: "status", value: status },
            fileLines,
          });
          if (!("ok" in inspected)) rejectHandoffDefects(inspected.defects);
          else {
            markdownSnapshot = inspected.markdown;
            researchSignal = inspected.research;
          }
        },
      })] : []),
      ...(role === "writer" ? [leafFinishTool({
        name: "wiki_write_finish",
        label: "Finish Wiki write",
        description: "Finish after writing the complete write handoff to .okf-wiki/task/handoff.md.",
        promptSnippet: "Finish the file-based write task",
        finish: async () => {
          if (writeFinished) throw new Error("wiki_write_finish may be accepted only once");
          const inspected = inspectHandoff({
            bytes: await readWikiWorkflowFile(policy.workspaceRoot, taskFileSlots.output),
            contract: task,
            fileLines,
          });
          if (!("ok" in inspected)) rejectHandoffDefects(inspected.defects);
          else {
            markdownSnapshot = inspected.markdown;
            writeFinished = true;
          }
        },
      })] : []),
    ]);
    const taskSessionDir = this.options.sessionDir
      ? path.join(this.options.sessionDir, "tasks", String(context.batch), task.id, String(context.attempt))
      : undefined;
    const roleModel = this.roleModels?.[task.role] ?? { model: this.options.model, thinkingLevel: this.options.thinkingLevel };
    const sessionResult = await runPiSession(policy.workspaceRoot, tools, [
        "Read `.okf-wiki/task/brief.md` and complete the assigned task.",
        role === "writer" && this.generation ? `\nGeneration profile: ${JSON.stringify(this.generation)}. Treat it as reader intent, never as source evidence.` : "",
        role === "writer" ? `\n${writerFrontmatterPrompt(this.generation)}` : "",
      ].join(""), context.signal, {
        ...this.options,
        model: roleModel.model,
        thinkingLevel: roleModel.thinkingLevel,
        sessionDir: taskSessionDir,
        sessionFile: context.sessionFile,
        skillPath: this.options.skillRoot,
      }, context.onTelemetry, {
        target: { kind: "task", batch: context.batch, taskId: task.id },
        attempt: context.attempt,
        onHealth: context.reportObservability,
      }, undefined, this.options.skillRoot ? role : undefined);
    const markdown = markdownSnapshot?.trim() ?? "";
    if (!markdown) throw new Error("Delegated agent produced empty output");
    if (role === "reviewer" && !review) throw new Error("Reviewer completed without wiki_review_finish");
    if (role === "researcher" && !researchSignal) throw new Error("Researcher completed without wiki_research_finish");
    if (role === "writer" && !writeFinished) throw new Error("Writer completed without wiki_write_finish");
    return {
      summary: researchSignal?.summary ?? firstLine(markdown),
      markdown,
      usage: sessionResult.usage,
      ...(review ? { review } : {}),
      ...(researchSignal ? { status: researchSignal.status, research: researchSignal } : {}),
    };
  }
}

function leafFinishTool(input: {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  field?: string;
  allowed?: readonly string[];
  finish: (value?: string) => void | Promise<void>;
}): ToolDefinition<any, any, any> {
  const { name, label, description, promptSnippet, field, allowed, finish } = input;
  return {
    name,
    label,
    description,
    promptSnippet,
    parameters: field && allowed
      ? Type.Object({ [field]: StringEnum([...allowed]) }, { additionalProperties: false })
      : Type.Object({}, { additionalProperties: false }),
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      if (field && allowed) {
        const value = exactLeafFinishInput(params, field, allowed, name);
        try {
          await finish(value);
        } catch (error) {
          rejectWikiTool(name, error);
        }
      } else {
        if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error(`${name} requires an object`);
        const unknown = Object.keys(params as Record<string, unknown>);
        if (unknown.length) throw new Error(`${name} has unknown fields: ${unknown.join(", ")}`);
        try {
          await finish();
        } catch (error) {
          rejectWikiTool(name, error);
        }
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ accepted: true }) }], details: { accepted: true } };
    },
  } as ToolDefinition<any, any, any>;
}

function exactLeafFinishInput(value: unknown, field: string, allowed: readonly string[], tool: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${tool} requires an object`);
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => key !== field);
  if (unknown.length) throw new Error(`${tool} has unknown fields: ${unknown.join(", ")}`);
  if (typeof raw[field] !== "string" || !allowed.includes(raw[field] as string)) throw new Error(`${tool} has invalid ${field}`);
  return raw[field] as string;
}

function leafLanguageInstruction(role: "researcher" | "writer" | "reviewer", language?: "zh" | "en"): string {
  if (role === "researcher") {
    return "\nWrite the Markdown handoff as concise model-readable analysis. It does not need to use the Wiki reader language. Keep code identifiers and citations unchanged.";
  }
  return language === "zh"
    ? "\nUse Simplified Chinese for reader-facing Wiki content and the handoff. Keep code identifiers and citations unchanged."
    : "\nUse English for reader-facing Wiki content and the handoff. Keep code identifiers and citations unchanged.";
}

function writerFrontmatterPrompt(generation?: WikiGenerationProfile): string {
  const required = generation?.templates.requiredSections ?? [];
  return [
    "Write each assigned Wiki page with this frontmatter shape:",
    "---",
    "type: Domain",
    "title: Example",
    "description: One-sentence reader summary",
    "source: source-a",
    "sources:",
    "  - id: source-a",
    "    resource: source/path.ts#L1",
    "---",
    "Cite claims with [^source-a] and [^source-a]: [path.ts](source/path.ts#L1).",
    "Frontmatter type must match the WikiSpec pageType (Overview/Source/Domain/Architecture/Module/Flow/Concept/State/Data).",
    required.length ? `Required sections: ${required.join(", ")}.` : "",
  ].filter((line) => line.length > 0).join("\n");
}

function createTaskFileSlots(
  workspaceRoot: string,
  context: WikiLeafTaskContext,
  task: WikiDelegateContract,
  role: "researcher" | "writer" | "reviewer",
): { brief: WikiWorkflowFileSlot; output: WikiWorkflowFileSlot; slots: WikiWorkflowFileSlot[] } {
  const taskRoot = path.join(
    workspaceRoot,
    ".okf-wiki",
    "runs",
    context.runId,
    "task-files",
    String(context.batch),
    task.id,
    String(context.attempt),
  );
  const brief: WikiWorkflowFileSlot = {
    logicalPath: ".okf-wiki/task/brief.md",
    physicalPath: path.join(taskRoot, "brief.md"),
    writable: false,
  };
  const outputName = role === "reviewer" ? "review.md" : "handoff.md";
  const output: WikiWorkflowFileSlot = {
    logicalPath: `.okf-wiki/task/${outputName}`,
    physicalPath: path.join(taskRoot, outputName),
    writable: true,
  };
  return { brief, output, slots: [brief, output] };
}

function taskFileBrief(
  task: WikiDelegateContract,
  artifacts: readonly { id: string; path: string; sha256: string; sizeBytes: number }[],
  reviewIndexes: readonly string[],
  language?: "zh" | "en",
): string {
  return [
    `# ${task.role} task`,
    "",
    "## Assignment",
    "",
    task.instruction,
    "",
    `- readable Sources: ${task.sourceScopeIds.join(", ") || "(none)"}`,
    task.writePaths?.length ? `- write paths: ${task.writePaths.join(", ")}` : "",
    task.reviewPaths?.length ? `- review paths: ${task.reviewPaths.join(", ")}` : "",
    reviewIndexes.length ? `- deterministic index paths (read only): ${reviewIndexes.join(", ")}` : "",
    `- ${leafLanguageInstruction(task.role === "write" ? "writer" : task.role === "review" ? "reviewer" : "researcher", language).trim()}`,
    ...artifacts.map((artifact) => `- context: ${artifact.path} (${artifact.sizeBytes} bytes, sha256 ${artifact.sha256})`),
    task.role === "review"
      ? "- completion: write `.okf-wiki/task/review.md`, then call wiki_review_finish with only the verdict"
      : task.role === "research"
        ? "- completion: write `.okf-wiki/task/handoff.md`, then call wiki_research_finish with only the status"
        : "- completion: write `.okf-wiki/task/handoff.md`, then call wiki_write_finish with no arguments",
    "",
  ].filter((line) => line !== "").join("\n");
}

function evidenceFileLines(plan: WikiPinnedSourcePlan): (citation: SourceCitation) => number | "missing" | undefined {
  return (citation) => {
    const source = plan.sources.find((entry) => entry.scopeId === citation.scope);
    if (!source) return undefined;
    try {
      const text = readFileSync(inside(source.realPath, path.resolve(source.realPath, ...citation.path.split("/"))), "utf8");
      if (!text) return 0;
      const lines = text.split(/\r?\n/).length;
      return text.endsWith("\n") ? lines - 1 : lines;
    } catch {
      return "missing";
    }
  };
}

function rejectHandoffDefects(defects: readonly string[]): void {
  if (defects.length) throw new WikiRejectedError(defects);
}

function rejectWikiTool(tool: string, error: unknown): never {
  if (error instanceof Error && error.message.startsWith(`${tool} rejected:`)) throw error;
  throw wikiToolRejected(tool, error instanceof Error ? error.message : String(error));
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0].replace(/^#+\s*/, "").trim() || "Delegated task completed";
}

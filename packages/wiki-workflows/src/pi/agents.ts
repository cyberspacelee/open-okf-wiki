import type { AgentSession, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import path from "node:path";
import YAML from "yaml";
import {
  readWikiWorkflowFile,
  workflowTools,
  writeWikiWorkflowFile,
  type WikiPageWriter,
  type WikiWorkflowFileSlot,
} from "./tools.js";
import {
  mergeTaxonomyDecisions,
  type WikiBoardTaxonomyDecision,
  type WikiDiscoveryPlanEntry,
  type WikiLeadAgents,
  type WikiLeadHost,
  type WikiLeadRun,
  type WikiLeadSessionRequest,
} from "../lead.js";
import { pinnedWorkspaceToolPolicy } from "../path-policy.js";
import type { WikiExecutionBudgets } from "../producer-types.js";
import type { WikiProductionPlan } from "../runtime-types.js";
import { WikiRejectedError, wikiToolRejected } from "../wiki-reject.js";
import { decodeUtf8Fatal, summarizeWikiMarkdown } from "../wiki-work-files.js";
import {
  createWikiDelegateCancelTool,
  createWikiDelegateCollectTool,
  createWikiDelegateStartTool,
  createWikiFinishTool,
  createWikiPlanTool,
  createWikiTaxonomyTool,
  type WikiDelegateCancelReasonCode,
} from "./host-tools.js";
import { PiWikiLeafAgent, type PiWikiRoleModels } from "./leaf.js";
import {
  createThinkingClock,
  runPiSession,
  validatedSessionTimeoutMs,
  validatedTransientRetries,
  withExecutionModes,
} from "./session.js";

export interface CreatePiLeadAgentsOptions {
  model?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  createSession?: (options: CreateAgentSessionOptions) => ReturnType<typeof import("@earendil-works/pi-coding-agent").createAgentSession>;
  sessionTimeoutMs?: number;
  models?: PiWikiRoleModels;
  leadBudgets?: Pick<WikiExecutionBudgets, "maxTurnsPerSession" | "maxToolCallsPerSession">;
  now?: () => number;
}

export function createPiLeadAgents(
  lead: WikiLeadRun,
  plan: WikiProductionPlan,
  options: CreatePiLeadAgentsOptions = {},
): WikiLeadAgents {
  const sessionTimeoutMs = validatedSessionTimeoutMs(options.sessionTimeoutMs ?? plan.sessionTimeoutMs);
  const transientRetries = validatedTransientRetries(plan.transientRetries);
  const leadModel = options.models?.lead ?? { model: options.model, thinkingLevel: options.thinkingLevel };
  const pageWriter: WikiPageWriter = {
    async replacePage(input) { await lead.replacePage(input); },
  };
  const leaf = new PiWikiLeafAgent({
    model: leadModel.model,
    thinkingLevel: leadModel.thinkingLevel,
    createSession: options.createSession,
    sessionTimeoutMs,
    language: plan.language,
    budgets: plan.budgets,
    skillRoot: plan.skillRoot,
    sessionDir: plan.runSessionDirectory,
    sourcePlan: plan.sourcePlan,
    transientRetries,
  }, pageWriter, plan.generation, () => lead.specRecord?.spec, options.models);

  let leadSession: AgentSession | undefined;

  return {
    leaf,
    async followUp(message) {
      await leadSession?.followUp(message);
    },
    async runLeadSession(input: WikiLeadSessionRequest): Promise<void> {
      const policy = pinnedWorkspaceToolPolicy(
        plan.sourcePlan,
        plan.candidateWikiRoot,
        plan.skillRoot,
        runBoardPath(lead.runId),
      );
      const leadFileSlots = createLeadFileSlots(policy.workspaceRoot, lead.runId, plan.sourcePlan.sources.length);
      await ensureLeadFileDrafts(policy.workspaceRoot, leadFileSlots, plan.sourcePlan.sources.map((source) => source.scopeId));
      const thinkingClock = createThinkingClock(sessionTimeoutMs);
      const leadTools = withExecutionModes([
        ...workflowTools(
          policy,
          "lead",
          undefined,
          plan.sourcePlan.sources.map((source) => source.scopeId),
          undefined,
          {
            async replacePage(value) { await input.host.replacePage(value); },
          },
          undefined,
          leadFileSlots,
        ),
        createWikiTaxonomyTool(async () => withBoard(
          input.host.compactionObserved,
          await input.host.saveTaxonomy(await readYamlWorkflowFile(policy.workspaceRoot, leadSlot(leadFileSlots, ".okf-wiki/current/taxonomy.yaml"))),
        )),
        createWikiPlanTool(async () => withBoard(
          input.host.compactionObserved,
          await input.host.saveSpec(await readYamlWorkflowFile(policy.workspaceRoot, leadSlot(leadFileSlots, ".okf-wiki/current/wiki-spec.yaml"))),
        )),
        createWikiDelegateStartTool(async () => {
          try {
            const discoveryPlan = input.host.hasDelegatedBatches
              ? []
              : structuredClone(await readDiscoveryPlan(
                policy.workspaceRoot,
                leadFileSlots,
                plan.sourcePlan.sources.map((source) => source.scopeId),
              ));
            return withBoard(input.host.compactionObserved, await input.host.startWave(discoveryPlan));
          } catch (error) {
            if (error instanceof Error && error.message.startsWith("wiki_delegate_start rejected:")) throw error;
            throw wikiToolRejected("wiki_delegate_start", error instanceof Error ? error.message : String(error));
          }
        }),
        createWikiDelegateCollectTool(async (collectOptions) => {
          thinkingClock.pause();
          try {
            const presented = await input.host.collect(collectOptions);
            await prefillTaxonomyDraft(input.host, policy.workspaceRoot, leadFileSlots, presented);
            return withBoard(input.host.compactionObserved, presented);
          } finally {
            thinkingClock.resume();
          }
        }),
        createWikiDelegateCancelTool(async (reasonCode?: WikiDelegateCancelReasonCode) => withBoard(
          input.host.compactionObserved,
          await input.host.cancel(reasonCode),
        )),
        createWikiFinishTool(async () => withBoard(
          input.host.compactionObserved,
          await input.host.finish(workflowCompletionSummary(decodeUtf8Fatal(await readWikiWorkflowFile(
            policy.workspaceRoot,
            leadSlot(leadFileSlots, ".okf-wiki/current/completion.md"),
          )))),
        )),
      ]);
      const leadSessionDir = plan.runSessionDirectory ? path.join(plan.runSessionDirectory, "lead") : undefined;
      await runPiSession(policy.workspaceRoot, leadTools, leadSessionPrompt(plan.prompt, plan.sourcePlan.sources.length), input.signal, {
        model: leadModel.model,
        thinkingLevel: leadModel.thinkingLevel,
        createSession: options.createSession,
        sessionTimeoutMs,
        language: plan.language,
        skillRoot: plan.skillRoot,
        skillPath: plan.skillRoot,
        sessionDir: leadSessionDir,
        sessionFile: plan.leadSessionFile,
        budgets: sessionBudgets(plan.budgets, options.leadBudgets),
        transientRetries,
      }, async (telemetry) => {
        if (telemetry.activity === "compacting") await input.onCompaction();
        await input.onTelemetry(telemetry);
      }, {
        target: { kind: "lead" },
        attempt: input.attempt,
        now: options.now,
        onHealth: input.onHealth,
        thinkingClock,
      }, (session) => { leadSession = session; });
    },
  };
}

function runBoardPath(runId: string): string {
  return `.okf-wiki/runs/${runId}/board.md`;
}

function createLeadFileSlots(workspaceRoot: string, runId: string, sourceCount: number): WikiWorkflowFileSlot[] {
  const currentRoot = path.join(workspaceRoot, ".okf-wiki", "runs", runId, "work-files", "current");
  const slots: WikiWorkflowFileSlot[] = [
    { logicalPath: ".okf-wiki/current/board.md", physicalPath: path.join(workspaceRoot, runBoardPath(runId)), writable: false },
    { logicalPath: ".okf-wiki/current/taxonomy.yaml", physicalPath: path.join(currentRoot, "taxonomy.yaml"), writable: true },
    { logicalPath: ".okf-wiki/current/wiki-spec.yaml", physicalPath: path.join(currentRoot, "wiki-spec.yaml"), writable: true },
    { logicalPath: ".okf-wiki/current/completion.md", physicalPath: path.join(currentRoot, "completion.md"), writable: true },
  ];
  for (let index = 1; index <= sourceCount; index += 1) {
    const name = `source-${String(index).padStart(3, "0")}.md`;
    slots.push({ logicalPath: `.okf-wiki/current/research/${name}`, physicalPath: path.join(currentRoot, "research", name), writable: true });
  }
  return slots;
}

function defaultWikiSpecDraft(sourceScopeIds: readonly string[]): string {
  const pages = ["overview.md", ...sourceScopeIds.map((scopeId) => `${scopeId}/source.md`)];
  return ["topologyVersion: 2", "pages:", ...pages.map((page) => `  - ${page}`), ""].join("\n");
}

async function ensureLeadFileDrafts(workspaceRoot: string, slots: readonly WikiWorkflowFileSlot[], sourceScopeIds: readonly string[]): Promise<void> {
  const defaults = new Map<string, string>([
    [".okf-wiki/current/taxonomy.yaml", "revision: 1\ndecisions: []\nconflictIds: []\n"],
    [".okf-wiki/current/wiki-spec.yaml", defaultWikiSpecDraft(sourceScopeIds)],
    [".okf-wiki/current/completion.md", ""],
  ]);
  const research = slots.filter((slot) => slot.logicalPath.startsWith(".okf-wiki/current/research/"));
  for (let index = 0; index < sourceScopeIds.length; index += 1) {
    defaults.set(research[index].logicalPath, "Inventory this pinned Source: domains, concepts, entry points, public interfaces, important flows, and cross-source relationships. Cite locators and preserve local terminology, conflicts, and minority evidence.\n");
  }
  for (const [logicalPath, content] of defaults) {
    const slot = leadSlot(slots, logicalPath);
    try { await readWikiWorkflowFile(workspaceRoot, slot); }
    catch (error) {
      if (!error || typeof error !== "object" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeWikiWorkflowFile(workspaceRoot, slot, content);
    }
  }
}

async function prefillTaxonomyDraft(
  host: WikiLeadHost,
  workspaceRoot: string,
  slots: readonly WikiWorkflowFileSlot[],
  snapshot: { status: string; receipts: Array<{ domains?: Array<{ sourceScopeId: string }> }> },
): Promise<void> {
  if (host.taxonomyCheckpoint || snapshot.status !== "complete") return;
  if (host.nextAction !== "taxonomy") return;
  const incoming = host.researchTaxonomyDecisions();
  if (!incoming.length) return;
  const slot = leadSlot(slots, ".okf-wiki/current/taxonomy.yaml");
  let current: { revision?: unknown; decisions?: unknown; conflictIds?: unknown } = {};
  try {
    current = YAML.parse(decodeUtf8Fatal(await readWikiWorkflowFile(workspaceRoot, slot))) as typeof current;
  } catch (error) {
    if (!error || typeof error !== "object" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const currentDecisions = Array.isArray(current.decisions) ? current.decisions as WikiBoardTaxonomyDecision[] : [];
  const collectedSources = [...new Set(snapshot.receipts.flatMap((receipt) => receipt.domains ?? []).map((domain) => domain.sourceScopeId))];
  const decisions = currentDecisions.length === 0
    ? incoming
    : mergeTaxonomyDecisions(currentDecisions, incoming, collectedSources);
  const conflictIds = Array.isArray(current.conflictIds) ? current.conflictIds.filter((id): id is string => typeof id === "string") : [];
  const revision = Number.isSafeInteger(current.revision) && (current.revision as number) >= 1 ? current.revision as number : 1;
  await writeWikiWorkflowFile(workspaceRoot, slot, YAML.stringify({ revision, decisions, conflictIds }));
}

function leadSlot(slots: readonly WikiWorkflowFileSlot[], logicalPath: string): WikiWorkflowFileSlot {
  const slot = slots.find((entry) => entry.logicalPath === logicalPath);
  if (!slot) throw new Error(`Missing fixed Wiki workflow file: ${logicalPath}`);
  return slot;
}

async function readDiscoveryPlan(
  workspaceRoot: string,
  slots: readonly WikiWorkflowFileSlot[],
  sourceScopeIds: readonly string[],
): Promise<WikiDiscoveryPlanEntry[]> {
  const research = slots.filter((slot) => slot.logicalPath.startsWith(".okf-wiki/current/research/"));
  const defects: string[] = [];
  const entries = await Promise.all(sourceScopeIds.map(async (sourceScopeId, index) => {
    const instruction = decodeUtf8Fatal(await readWikiWorkflowFile(workspaceRoot, research[index])).trim();
    if (!instruction) {
      defects.push(`Discovery direction file is empty: ${research[index].logicalPath}`);
      return undefined;
    }
    return { sourceScopeId, instruction };
  }));
  if (defects.length) throw new WikiRejectedError(defects);
  return entries.filter((entry): entry is WikiDiscoveryPlanEntry => entry !== undefined);
}

async function readYamlWorkflowFile(workspaceRoot: string, slot: WikiWorkflowFileSlot): Promise<unknown> {
  const source = decodeUtf8Fatal(await readWikiWorkflowFile(workspaceRoot, slot));
  try {
    return YAML.parse(source);
  } catch (error) {
    throw new Error(`Invalid YAML in ${slot.logicalPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function workflowCompletionSummary(markdown: string): string {
  return summarizeWikiMarkdown(markdown, "completion.md");
}

function leadSessionPrompt(prompt: string, sourceCount: number): string {
  const researchFiles = Array.from({ length: sourceCount }, (_, index) => `.okf-wiki/current/research/source-${String(index + 1).padStart(3, "0")}.md`);
  const additions = [
    prompt.includes(".okf-wiki/current/board.md") ? "" : "Board: .okf-wiki/current/board.md. Read it before dispatch or wiki_finish.",
    researchFiles.length ? `Fixed discovery files: ${researchFiles.join(", ")}.` : "",
    prompt.includes("wiki_taxonomy") ? "" : "Submit wiki_taxonomy after discovery and before wiki_plan.",
    prompt.includes("topology.md") ? "" : "Read topology.md before wiki_plan.",
  ].filter(Boolean);
  return additions.length ? `${prompt}\n${additions.join(" ")}` : prompt;
}

function withBoard<T extends object>(compactionObserved: boolean, value: T): T & { board: string; note?: string } {
  return {
    ...value,
    board: ".okf-wiki/current/board.md",
    ...(compactionObserved ? { note: "Read board.md before dispatching or finishing" } : {}),
  };
}

function sessionBudgets(
  base: WikiExecutionBudgets | undefined,
  override?: Pick<WikiExecutionBudgets, "maxTurnsPerSession" | "maxToolCallsPerSession">,
): WikiExecutionBudgets | undefined {
  if (!override) return base;
  if (!base) return { maxDelegatedTasks: 1, maxDelegateBatches: 1, ...override };
  return { ...base, ...override };
}

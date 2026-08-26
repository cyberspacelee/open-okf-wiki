import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { WorkerCompletionGate } from "./completion.js";
import { readText, writeText } from "./files.js";
import { sealHandoff, taskDigest, workerOutputSkeleton } from "./handoff.js";
import { fileRevision } from "./revisions.js";
import type { WikiWriteMode } from "./write-target.js";

export interface WorkerArtifactRef {
  path: string;
  sha256: string;
}

interface WorkerArtifactState {
  executionId: string;
  taskDigest: string;
  sourceFingerprint: string;
  baseCandidateRevision: string;
  draftRevision: string;
  observedPaths: string[];
  touchedPaths: string[];
  requiredHandoffs: string[];
  todo: Array<{ path: string; status: string }>;
  phase: "drafting" | "submit_invalid" | "submitted" | "sealed";
  validation?: { draftRevision: string; candidateRevision?: string; prompt?: string };
}

export async function createWorkerArtifact(input: {
  workspaceRoot: string;
  handoffsRoot: string;
  task: { id: string; agent: string; task: string; boardTaskId: string; partition: string; writeMode?: WikiWriteMode };
  sourceFingerprint: string;
  baseCandidateRevision: string;
  completion: WorkerCompletionGate;
  requiredHandoffs?: readonly string[];
  currentCandidateRevision?: () => Promise<string>;
  todo?: () => readonly { path: string; status: string }[];
}) {
  await mkdir(input.handoffsRoot, { recursive: true });
  const draftLocation = path.join(input.handoffsRoot, `${input.task.id}.draft.md`);
  const stateLocation = path.join(input.handoffsRoot, `${input.task.id}.state.json`);
  const relative = (location: string) => path.relative(input.workspaceRoot, location).replaceAll("\\", "/");
  await writeText(draftLocation, workerOutputSkeleton(input.task.agent));
  const state: WorkerArtifactState = {
    executionId: input.task.id,
    taskDigest: taskDigest(input.task.task),
    sourceFingerprint: input.sourceFingerprint,
    baseCandidateRevision: input.baseCandidateRevision,
    draftRevision: await fileRevision(draftLocation),
    observedPaths: [],
    touchedPaths: [],
    requiredHandoffs: [...new Set(input.requiredHandoffs ?? [])].sort(),
    todo: [],
    phase: "drafting",
  };
  let fatal: unknown;
  let idleWithoutCheck = 0;
  let persistQueue = Promise.resolve();
  let persistError: unknown;
  const currentCandidateRevision = async () => {
    const revision = await input.currentCandidateRevision?.();
    if (input.task.agent === "review" && revision !== input.baseCandidateRevision) {
      throw new Error("Frozen Candidate changed during review");
    }
    return revision;
  };
  const persist = async () => {
    state.todo = input.todo ? [...input.todo()] : [];
    await writeText(stateLocation, `${JSON.stringify(state, null, 2)}\n`, { sync: "file" });
  };
  await persist();
  const schedulePersist = () => {
    persistQueue = persistQueue.then(persist).catch((error) => { persistError ??= error; });
  };
  const flushPersist = async () => {
    await persistQueue;
    if (persistError) throw persistError;
  };
  const updateDraft = async (text: string) => {
    await writeText(draftLocation, `${text.trim()}\n`);
    state.draftRevision = await fileRevision(draftLocation);
    state.phase = "drafting";
    state.validation = undefined;
    idleWithoutCheck = 0;
    await persist();
  };
  const check = async (submit: boolean) => {
    const body = await readText(draftLocation);
    const draftRevision = await fileRevision(draftLocation);
    const candidateRevision = await currentCandidateRevision();
    if (submit
      && state.validation
      && !state.validation.prompt
      && state.validation.draftRevision === draftRevision
      && state.validation.candidateRevision === candidateRevision) {
      state.phase = "submitted";
      idleWithoutCheck = 0;
      await persist();
      return "Handoff submitted.";
    }
    try {
      const prompt = await input.completion.validate(body);
      state.validation = {
        draftRevision,
        ...(candidateRevision ? { candidateRevision } : {}),
        ...(prompt ? { prompt } : {}),
      };
      state.phase = prompt ? (submit ? "submit_invalid" : "drafting") : submit ? "submitted" : "drafting";
      idleWithoutCheck = 0;
      await persist();
      return prompt ?? (submit ? "Handoff submitted." : "Draft is valid. Submit it to finish.");
    } catch (error) {
      fatal = error;
      await persist();
      throw error;
    }
  };
  const tool = {
    name: "handoff",
    label: "Handoff Draft",
    description: "Read, replace, edit, check, or submit this worker's durable handoff draft. Submit only after the draft and task outputs are complete.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("read"), Type.Literal("replace"), Type.Literal("edit"), Type.Literal("check"), Type.Literal("submit"),
      ]),
      text: Type.Optional(Type.String({ description: "Complete Markdown draft for replace" })),
      oldText: Type.Optional(Type.String({ description: "Exact draft text to replace for edit" })),
      newText: Type.Optional(Type.String({ description: "Replacement text for edit" })),
    }),
    async execute(_id: string, params: unknown) {
      const value = params as { action: string; text?: string; oldText?: string; newText?: string };
      try {
        if (value.action === "read") return result(await readText(draftLocation));
        if (value.action === "replace") {
          if (typeof value.text !== "string") throw new Error("handoff replace requires text");
          await updateDraft(value.text);
          return result("Handoff draft replaced.");
        }
        if (value.action === "edit") {
          if (typeof value.oldText !== "string" || typeof value.newText !== "string" || !value.oldText) {
            throw new Error("handoff edit requires non-empty oldText and newText");
          }
          const body = await readText(draftLocation);
          const first = body.indexOf(value.oldText);
          if (first < 0) throw new Error("handoff edit oldText was not found");
          if (body.indexOf(value.oldText, first + value.oldText.length) >= 0) throw new Error("handoff edit oldText is not unique");
          await updateDraft(`${body.slice(0, first)}${value.newText}${body.slice(first + value.oldText.length)}`);
          return result("Handoff draft edited.");
        }
        if (value.action === "check" || value.action === "submit") {
          const message = await check(value.action === "submit");
          return result(message, state.phase !== "submitted" && value.action === "submit");
        }
        throw new Error(`Unknown handoff action: ${value.action}`);
      } catch (error) {
        return result(error instanceof Error ? error.message : String(error), true);
      }
    },
  };

  return {
    tool,
    observe(event: { tool: string; args: unknown; status: string; result?: unknown }) {
      input.completion.observe(event);
      if (event.status !== "complete" || !isRecord(event.args) || typeof event.args.path !== "string") return;
      const collection = event.tool === "write" || event.tool === "edit" ? state.touchedPaths : state.observedPaths;
      if (!collection.includes(event.args.path)) {
        collection.push(event.args.path);
        collection.sort();
        schedulePersist();
      }
    },
    async onIdle(): Promise<string | undefined> {
      if (fatal) throw fatal;
      await flushPersist();
      const draftRevision = await fileRevision(draftLocation);
      const candidateRevision = await currentCandidateRevision();
      if (state.phase === "submitted"
        && state.validation
        && state.validation.draftRevision === draftRevision
        && state.validation.candidateRevision === candidateRevision) return undefined;
      idleWithoutCheck += 1;
      if (idleWithoutCheck > 2) throw new Error("Worker handoff was not submitted after 2 follow-up rounds");
      if (state.validation?.draftRevision === draftRevision && state.validation.prompt) return state.validation.prompt;
      return "Use the handoff tool to update the durable draft, then submit it. Assistant prose is not a completion receipt.";
    },
    checkpoint(): string {
      const lines = [
        "<wiki_checkpoint>",
        `Execution: ${input.task.id}`,
        `Role: ${input.task.agent}`,
        `Board Task: ${input.task.boardTaskId}`,
        `Partition: ${input.task.partition}`,
        `Source fingerprint: ${input.sourceFingerprint}`,
        `Base target Candidate: ${input.baseCandidateRevision}`,
        `Handoff draft: ${relative(draftLocation)} (${state.draftRevision})`,
        `Handoff state: ${relative(stateLocation)}`,
        `Assignment: ${input.task.task}`,
      ];
      const append = (heading: string, entries: readonly string[]) => {
        if (!entries.length) return;
        lines.push(heading);
        for (const entry of entries) {
          if (estimateTokens([...lines, `- ${entry}`, "</wiki_checkpoint>"].join("\n")) > 4_096) break;
          lines.push(`- ${entry}`);
        }
      };
      append("Required handoffs:", state.requiredHandoffs);
      append("Observed paths:", state.observedPaths.slice(-40));
      append("Touched Candidate paths:", state.touchedPaths);
      append("Writer Todo:", state.todo.map((entry) => `${entry.status}: ${entry.path}`));
      lines.push("Read the durable draft with the handoff tool, continue the assignment, and submit only after its validation passes.", "</wiki_checkpoint>");
      if (estimateTokens(lines.join("\n")) > 4_096) throw new Error("context_checkpoint_too_large: worker assignment exceeds 4096 estimated tokens");
      return lines.join("\n");
    },
    async references() {
      await flushPersist();
      return {
        draft: { path: relative(draftLocation), sha256: state.draftRevision },
        progress: { path: relative(stateLocation), sha256: await fileRevision(stateLocation) },
      };
    },
    async seal() {
      await flushPersist();
      if (state.phase === "sealed") throw new Error("Handoff is already sealed");
      const draftRevision = await fileRevision(draftLocation);
      const candidateRevision = await currentCandidateRevision();
      if (state.phase !== "submitted"
        || !state.validation
        || state.validation.draftRevision !== draftRevision
        || state.validation.candidateRevision !== candidateRevision) {
        throw new Error("Handoff submission is stale or missing");
      }
      const body = await readText(draftLocation);
      const handoffPath = await sealHandoff({
        workspaceRoot: input.workspaceRoot,
        handoffsRoot: input.handoffsRoot,
        task: input.task,
        text: body,
        baseCandidateRevision: input.baseCandidateRevision,
        ...(candidateRevision ? { completedCandidateRevision: candidateRevision } : {}),
      });
      state.phase = "sealed";
      await persist();
      return {
        path: handoffPath,
        body,
      };
    },
  };
}

function result(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) character.charCodeAt(0) < 128 ? ascii += 1 : nonAscii += 1;
  return Math.ceil(ascii / 4) + nonAscii;
}

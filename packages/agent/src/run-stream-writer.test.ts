import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  WorkspaceConfigSchema,
  defaultWikiRunSpec,
  type WorkspaceConfig,
} from "@okf-wiki/contract";
import { runWikiAgent } from "./produce/index.js";

async function minimalWorkspace(root: string): Promise<WorkspaceConfig> {
  const sourcePath = path.join(root, "src-repo");
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "README.md"), "# fixture\n", "utf8");
  return WorkspaceConfigSchema.parse({
    version: 1,
    id: "ws-stream",
    name: "Stream WS",
    rootPath: root,
    sources: [
      {
        id: "src",
        path: sourcePath,
        applyDefaultIgnores: true,
        ignore: [],
      },
    ],
    model: { id: "openai/test" },
    publicationPath: path.join(root, "wiki"),
    limits: { requestTimeoutSeconds: 60, maxSteps: 8 },
    planConfirm: false,
    wikiLanguage: "en",
    createdAt: new Date().toISOString(),
  });
}

test("fixture runWikiAgent writes tool/text chunks to writer", async () => {
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  const root = await mkdtemp(path.join(tmpdir(), "okf-writer-"));
  const chunks: unknown[] = [];
  const result = await runWikiAgent({
    runId: "run-writer-1",
    workspace: await minimalWorkspace(root),
    phase: "plan",
    writer: {
      write: async (chunk) => {
        chunks.push(chunk);
      },
    },
  });
  assert.equal(result.status, "awaiting_plan");
  assert.ok(result.plan);
  const types = chunks.map((c) =>
    c && typeof c === "object" && "type" in c
      ? String((c as { type: string }).type)
      : "",
  );
  assert.ok(types.includes("text-delta"), `expected text-delta in ${types.join(",")}`);
  assert.ok(types.includes("tool-call"), `expected tool-call in ${types.join(",")}`);
  assert.ok(types.includes("tool-result"), `expected tool-result in ${types.join(",")}`);
});

test("fixture write phase emits data-plan-progress via writer.custom", async () => {
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  const root = await mkdtemp(path.join(tmpdir(), "okf-writer-progress-"));
  const customChunks: unknown[] = [];
  const writeChunks: unknown[] = [];
  const plan = {
    ...defaultWikiRunSpec("Fixture"),
    summary: "Fixture plan",
    pages: [
      {
        path: "overview.md",
        purpose: "Overview",
        domainIds: ["core"],
        questions: ["Overview?"],
        critical: true,
      },
      {
        path: "architecture.md",
        purpose: "Architecture",
        domainIds: ["core"],
        questions: ["Architecture?"],
        critical: true,
      },
    ],
  };
  const result = await runWikiAgent({
    runId: "run-writer-progress",
    workspace: await minimalWorkspace(root),
    phase: "write",
    plan,
    writer: {
      write: async (chunk) => {
        writeChunks.push(chunk);
      },
      // Duck-typed Mastra ToolStream.custom (not on WikiRunStreamWriter type).
      custom: async (chunk: unknown) => {
        customChunks.push(chunk);
      },
    } as {
      write: (chunk: unknown) => Promise<void>;
      custom: (chunk: unknown) => Promise<void>;
    },
  });
  assert.ok(
    result.status === "awaiting_publication" || result.status === "published",
  );
  assert.ok(result.pages && result.pages.length > 0);
  const progress = customChunks.filter(
    (c) =>
      c &&
      typeof c === "object" &&
      (c as { type?: string }).type === "data-plan-progress",
  );
  assert.ok(
    progress.length >= 1,
    `expected data-plan-progress via custom, got ${JSON.stringify(customChunks)}`,
  );
  const last = progress[progress.length - 1] as {
    data?: { pages?: Array<{ path?: string; status?: string }> };
  };
  assert.ok(
    (last.data?.pages ?? []).some(
      (p) => p.path === "overview.md" && p.status === "written",
    ),
  );
  // Phase strip also via custom (Produce emitRunPhase)
  const phases = customChunks.filter(
    (c) =>
      c &&
      typeof c === "object" &&
      (c as { type?: string }).type === "data-progress",
  );
  assert.ok(
    phases.length >= 1,
    `expected data-progress via custom, got ${JSON.stringify(customChunks)}`,
  );
  const phaseNames = phases.map(
    (c) =>
      (c as { data?: { phase?: string } }).data?.phase ?? "",
  );
  assert.ok(
    phaseNames.includes("writing"),
    `expected writing phase, got ${phaseNames.join(",")}`,
  );
  assert.ok(
    phaseNames.includes("reviewing") || phaseNames.includes("done"),
    `expected reviewing/done, got ${phaseNames.join(",")}`,
  );
  // tool/text still go through write(), not custom
  const writeTypes = writeChunks.map((c) =>
    c && typeof c === "object" && "type" in c
      ? String((c as { type: string }).type)
      : "",
  );
  assert.ok(writeTypes.includes("tool-result"));
});

test("fixture plan phase emits data-progress and pending plan-progress via custom", async () => {
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  const root = await mkdtemp(path.join(tmpdir(), "okf-writer-plan-"));
  const customChunks: unknown[] = [];
  const result = await runWikiAgent({
    runId: "run-writer-plan",
    workspace: await minimalWorkspace(root),
    phase: "plan",
    writer: {
      write: async () => {},
      custom: async (chunk: unknown) => {
        customChunks.push(chunk);
      },
    } as {
      write: (chunk: unknown) => Promise<void>;
      custom: (chunk: unknown) => Promise<void>;
    },
  });
  assert.equal(result.status, "awaiting_plan");
  assert.ok(result.plan?.pages?.length);
  const types = customChunks.map((c) =>
    c && typeof c === "object" && "type" in c
      ? String((c as { type: string }).type)
      : "",
  );
  assert.ok(
    types.includes("data-progress"),
    `expected data-progress, got ${types.join(",")}`,
  );
  assert.ok(
    types.includes("data-plan-progress"),
    `expected data-plan-progress, got ${types.join(",")}`,
  );
  const planProgress = customChunks.find(
    (c) =>
      c &&
      typeof c === "object" &&
      (c as { type?: string }).type === "data-plan-progress",
  ) as {
    data?: { pages?: Array<{ path?: string; status?: string }> };
  };
  assert.ok((planProgress.data?.pages ?? []).length > 0);
  assert.ok(
    (planProgress.data?.pages ?? []).every((p) => p.status === "pending"),
  );
});

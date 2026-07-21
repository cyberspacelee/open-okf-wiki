import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { WorkspaceConfig } from "@okf-wiki/contract";
import { runWikiAgent } from "./run.js";

async function minimalWorkspace(root: string): Promise<WorkspaceConfig> {
  const sourcePath = path.join(root, "src-repo");
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "README.md"), "# fixture\n", "utf8");
  return {
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
    adaptive: false,
    reviewer: false,
    planConfirm: false,
    wikiLanguage: "en",
    createdAt: new Date().toISOString(),
  };
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

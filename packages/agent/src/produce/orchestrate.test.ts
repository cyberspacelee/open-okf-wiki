import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { defaultWikiRunSpec, WorkspaceConfigSchema } from "@okf-wiki/contract";
import { runWorkdirLayout } from "../pi/run-workdir.js";
import { recordingProduceEvents } from "./events.js";
import { produceWiki } from "./orchestrate.js";

const temps: string[] = [];

after(async () => {
  for (const t of temps) {
    await rm(t, { recursive: true, force: true });
  }
});

async function makeWorkspace(root: string) {
  const src = path.join(root, "src");
  await mkdir(src, { recursive: true });
  await writeFile(path.join(src, "README.md"), "# Src\nline2\n", "utf8");
  const skill = path.join(root, "skill");
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "# Skill\n", "utf8");
  return {
    workspace: WorkspaceConfigSchema.parse({
      version: 1,
      id: "ws",
      name: "Produce WS",
      rootPath: root,
      sources: [{ id: "main", path: src, applyDefaultIgnores: true, ignore: [] }],
      skillPath: skill,
      model: { id: "openai/test" },
      publicationPath: path.join(root, "out"),
      limits: { requestTimeoutSeconds: 60, maxSteps: 8 },
      planConfirm: false,
      wikiLanguage: "en",
      createdAt: new Date().toISOString(),
    }),
    src,
    skill,
  };
}

describe("produceWiki fixture", () => {
  it("seeds Spec, writes pages, reviews clean, scores publishable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-produce-"));
    temps.push(root);
    const { workspace } = await makeWorkspace(root);
    const { sink, events } = recordingProduceEvents();
    const runWorkDir = path.join(root, ".okf-wiki", "runs", "run-1");
    const source = path.join(runWorkDir, "sources", "main");
    await mkdir(path.join(runWorkDir, "skill"), { recursive: true });
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Frozen source\n", "utf8");
    await writeFile(path.join(runWorkDir, "skill", "SKILL.md"), "# Frozen skill\n", "utf8");
    const layout = runWorkdirLayout(runWorkDir, new Map([["main", source]]));

    const result = await produceWiki({
      runId: "run-1",
      workspace,
      layout,
      spec: defaultWikiRunSpec(workspace.name),
      fixture: true,
      onEvent: sink,
    });

    assert.equal(result.status, "ready_for_publish");
    assert.ok(result.pages.includes("overview.md"));
    assert.equal(result.publishability.publishable, true);
    assert.ok(result.defects?.clean);

    const specRaw = await readFile(
      path.join(root, ".okf-wiki", "runs", "run-1", "analysis", "spec.json"),
      "utf8",
    );
    assert.match(specRaw, /overview\.md/);

    const kinds = events.map((e) => e.kind);
    assert.ok(kinds.includes("progress"));
    assert.ok(kinds.includes("defects"));
    assert.ok(kinds.includes("plan_progress"));
    const allowed = new Set(["progress", "defects", "plan_progress"]);
    assert.ok(kinds.every((k) => allowed.has(k)));
    assert.ok(result.metrics.domainStarts >= 1);
    // Default Spec domain has questions → Produce leaf fan-out runs.
    assert.ok(result.metrics.leafStarts >= 1);
    assert.ok(result.pages.includes("index.md"));
  });
});

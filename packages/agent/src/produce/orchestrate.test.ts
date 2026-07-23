import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { WorkspaceConfigSchema } from "@okf-wiki/contract";
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
    const { workspace, src, skill } = await makeWorkspace(root);
    const { sink, events } = recordingProduceEvents();
    const runWorkDir = path.join(root, ".okf-wiki", "runs", "run-1");

    const result = await produceWiki({
      runId: "run-1",
      workspace,
      runWorkDir,
      fixture: true,
      materialize: {
        sources: new Map([["main", src]]),
        skillRoot: skill,
        reset: true,
      },
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
    assert.ok(kinds.includes("work_unit"));
    // ADR 0031: only whitelist product inject kinds from produce sink
    const allowed = new Set(["progress", "defects", "plan_progress", "work_unit"]);
    assert.ok(kinds.every((k) => allowed.has(k)));
    const workUnits = events.filter((e) => e.kind === "work_unit");
    assert.ok(workUnits.length >= 2);
    for (const e of workUnits) {
      const p = e.payload as { unitId?: string; runId?: string; status?: string };
      assert.ok(p.unitId);
      assert.equal(p.runId, "run-1");
      assert.ok(
        p.status === "running" ||
          p.status === "settled" ||
          p.status === "failed" ||
          p.status === "pending",
      );
    }
    assert.ok(result.metrics.domainStarts >= 1);
    // Default Spec domain has questions → Host leaf fan-out runs.
    assert.ok(result.metrics.leafStarts >= 1);
    assert.ok(result.pages.includes("index.md"));
  });
});

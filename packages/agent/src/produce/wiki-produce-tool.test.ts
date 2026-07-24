import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  type WikiProduceToolDetails,
  WikiProduceToolDetailsSchema,
  WorkspaceConfigSchema,
} from "@okf-wiki/contract";
import { loadRun } from "@okf-wiki/core";
import {
  createWikiProduceTool,
  type WikiProduceGateDecision,
  type WikiProduceGateRequest,
} from "./wiki-produce-tool.js";

type ExecuteWikiProduce = (
  toolCallId: string,
  input: { notes?: string },
  signal?: AbortSignal,
  onUpdate?: (update: { details?: WikiProduceToolDetails }) => void,
) => Promise<{
  content: Array<{ type: string; text?: string }>;
  details: WikiProduceToolDetails;
  isError?: boolean;
}>;

const temps: string[] = [];

after(async () => {
  for (const tmp of temps) {
    const makeWritable = async (entryPath: string): Promise<void> => {
      await chmod(entryPath, 0o700).catch(() => undefined);
      const entries = await readdir(entryPath, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory()) await makeWritable(path.join(entryPath, entry.name));
        else await chmod(path.join(entryPath, entry.name), 0o600).catch(() => undefined);
      }
    };
    await makeWritable(tmp);
    await rm(tmp, { recursive: true, force: true });
  }
});

async function makeWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-tool-"));
  temps.push(root);
  const source = path.join(root, "source");
  const skill = path.join(root, "producer-skill");
  await mkdir(source, { recursive: true });
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(source, "README.md"), "# Source\n", "utf8");
  await writeFile(path.join(skill, "SKILL.md"), "---\nname: test\n---\n# Produce\n", "utf8");
  spawnSync("git", ["init"], { cwd: source, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "test@example.com"], {
    cwd: source,
    stdio: "ignore",
  });
  spawnSync("git", ["config", "user.name", "test"], { cwd: source, stdio: "ignore" });
  spawnSync("git", ["add", "."], { cwd: source, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "fixture"], { cwd: source, stdio: "ignore" });

  return WorkspaceConfigSchema.parse({
    version: 1,
    id: "workspace",
    name: "Tool Workspace",
    rootPath: root,
    sources: [{ id: "main", path: source, applyDefaultIgnores: true, ignore: [] }],
    skillPath: skill,
    model: { id: "openai/test" },
    publicationPath: path.join(root, "published"),
    limits: { requestTimeoutSeconds: 60, maxSteps: 8 },
    planConfirm: true,
    wikiLanguage: "en",
    createdAt: new Date().toISOString(),
  });
}

function gateHarness() {
  const requests: WikiProduceGateRequest[] = [];
  const decisions: Array<(decision: WikiProduceGateDecision) => void> = [];
  const arrivals: Array<() => void> = [];
  let consumed = 0;
  return {
    requests,
    gateCoordinator: {
      waitForDecision(request: WikiProduceGateRequest): Promise<WikiProduceGateDecision> {
        requests.push(request);
        arrivals.shift()?.();
        return new Promise((resolve) => decisions.push(resolve));
      },
    },
    async nextRequest(): Promise<WikiProduceGateRequest> {
      if (consumed >= requests.length) {
        await new Promise<void>((resolve) => arrivals.push(resolve));
      }
      return requests[consumed++]!;
    },
    resolve(decision: WikiProduceGateDecision): void {
      const resolve = decisions.shift();
      assert.ok(resolve, "no pending gate");
      resolve(decision);
    },
  };
}

describe("real Pi wiki_produce tool", () => {
  it("awaits plan and publication decisions inside one execute", async () => {
    const workspace = await makeWorkspace();
    const stalePublicationPath = path.join(workspace.rootPath, "stale-publication");
    const staleWorkspace = WorkspaceConfigSchema.parse({
      ...workspace,
      name: "Stale Workspace",
      sources: [],
      publicationPath: stalePublicationPath,
      planConfirm: false,
    });
    let workspaceResolutions = 0;
    const gates = gateHarness();
    const updates: WikiProduceToolDetails[] = [];
    const definition = createWikiProduceTool({
      workspace: staleWorkspace,
      resolveWorkspace: async () => {
        workspaceResolutions += 1;
        return workspace;
      },
      sessionId: "operator-session",
      gateCoordinator: gates.gateCoordinator,
      fixture: true,
    });
    assert.equal(definition.name, "wiki_produce");
    assert.match(definition.description, /ONLY when the operator explicitly asks/i);
    assert.match(definition.description, /Do NOT call/i);
    assert.ok(definition.promptGuidelines?.some((g) => /explicit Wiki produce/i.test(g)));
    assert.ok(definition.promptGuidelines?.some((g) => /never wiki_produce/i.test(g)));
    assert.match(definition.promptSnippet ?? "", /explicit operator request only/i);

    const execute = definition.execute as unknown as ExecuteWikiProduce;
    const resultPromise = execute("tool-call-1", { notes: "Focus on runtime." }, undefined, (u) => {
      if (u.details) updates.push(u.details);
    });

    const planGate = await gates.nextRequest();
    assert.equal(planGate.toolCallId, "tool-call-1");
    assert.equal(planGate.gate, "plan");
    assert.ok(planGate.spec.pages.length > 0);
    assert.ok(
      updates.some((u) => u.children?.some((c) => c.role === "plan")),
      "fixture planner should project a plan child span",
    );
    gates.resolve({ action: "revise", feedback: "Emphasize the runtime seam." });

    const revisedPlanGate = await gates.nextRequest();
    assert.equal(revisedPlanGate.gate, "plan");
    assert.match(revisedPlanGate.spec.notes ?? "", /runtime seam/i);
    assert.ok(revisedPlanGate.spec.changelog.some((entry) => /planner re-ran/i.test(entry)));
    // Publication validation must use the frozen snapshot, never this live checkout.
    await rm(path.join(workspace.sources[0]!.path, "README.md"));
    gates.resolve({ action: "approve", spec: revisedPlanGate.spec });

    const publicationOrResult = await Promise.race([
      gates.nextRequest().then((request) => ({ kind: "gate" as const, request })),
      resultPromise.then((result) => ({ kind: "result" as const, result })),
    ]);
    assert.equal(
      publicationOrResult.kind,
      "gate",
      publicationOrResult.kind === "result"
        ? `wiki_produce ended before publication gate: ${JSON.stringify(publicationOrResult.result.details)}`
        : undefined,
    );
    if (publicationOrResult.kind !== "gate") return;
    const publicationGate = publicationOrResult.request;
    assert.equal(publicationGate.gate, "publication");
    assert.ok(publicationGate.pages.length > 0);
    gates.resolve({ action: "approve" });

    const result = await resultPromise;
    assert.equal(workspaceResolutions, 1);
    assert.equal(result.isError, undefined);
    assert.equal(result.details.status, "published");
    assert.equal("toolCallId" in result.details, false);
    assert.equal("phase" in result.details, false);
    assert.ok(result.details.runId);
    assert.ok(result.details.pages?.includes("overview.md"));
    assert.ok(updates.some((update) => update.status === "awaiting_plan"));
    assert.ok(updates.some((update) => update.status === "awaiting_publication"));
    for (const update of updates) WikiProduceToolDetailsSchema.parse(update);
    assert.equal((revisedPlanGate.spec.notes?.match(/Focus on runtime\./g) ?? []).length, 1);

    const record = await loadRun(workspace.rootPath, result.details.runId!);
    assert.equal(record?.status, "published");
    assert.equal(record?.sessionId, "operator-session");
    assert.equal(record?.spec?.summary, revisedPlanGate.spec.summary);
    assert.match(
      await readFile(path.join(workspace.publicationPath!, "overview.md"), "utf8"),
      /Pi fixture mode/,
    );
    await assert.rejects(readFile(path.join(stalePublicationPath, "overview.md"), "utf8"));
  });

  it("returns normal tool results when either operator gate denies", async () => {
    const planWorkspace = await makeWorkspace();
    const planGates = gateHarness();
    const planTool = createWikiProduceTool({
      workspace: planWorkspace,
      sessionId: "plan-denial-session",
      gateCoordinator: planGates.gateCoordinator,
      fixture: true,
    });
    const planResultPromise = (planTool.execute as unknown as ExecuteWikiProduce)(
      "plan-denial",
      {},
    );
    assert.equal((await planGates.nextRequest()).gate, "plan");
    planGates.resolve({ action: "deny" });
    const planResult = await planResultPromise;
    assert.equal(planResult.details.status, "cancelled");
    assert.equal(planResult.isError, undefined);

    const publicationWorkspace = await makeWorkspace();
    const publicationGates = gateHarness();
    const publicationTool = createWikiProduceTool({
      workspace: publicationWorkspace,
      sessionId: "publication-denial-session",
      gateCoordinator: publicationGates.gateCoordinator,
      fixture: true,
    });
    const publicationResultPromise = (publicationTool.execute as unknown as ExecuteWikiProduce)(
      "publication-denial",
      {},
    );
    assert.equal((await publicationGates.nextRequest()).gate, "plan");
    publicationGates.resolve({ action: "approve" });
    assert.equal((await publicationGates.nextRequest()).gate, "publication");
    publicationGates.resolve({ action: "deny" });
    const publicationResult = await publicationResultPromise;
    assert.equal(publicationResult.details.status, "publication_declined");
    assert.equal(publicationResult.isError, undefined);
  });
});

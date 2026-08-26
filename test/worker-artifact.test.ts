import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseHandoff } from "../extensions/wiki/lib/handoff.js";
import { createWorkerArtifact } from "../extensions/wiki/lib/worker-artifact.js";

test("worker edits a durable draft before submit seals the handoff", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-artifact-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  let checks = 0;
  const artifact = await createWorkerArtifact({
    workspaceRoot: root,
    handoffsRoot: path.join(root, ".okf-wiki", "run", "handoffs"),
    task: { id: "survey-one", agent: "survey", task: "Survey self", boardTaskId: "survey", partition: "self" },
    sourceFingerprint: "source",
    baseCandidateRevision: "not-applicable",
    completion: {
      observe() {},
      async validate(body) {
        checks += 1;
        return body.startsWith("## Source\n\nself\n") ? undefined : "repair the draft";
      },
    },
  });
  const tool = artifact.tool;
  const draft = (await artifact.references()).draft.path;
  assert.match(await readFile(path.join(root, ...draft.split("/")), "utf8"), /^## Source/);
  artifact.observe({ tool: "read", args: { path: "src/main.ts" }, status: "complete" });
  assert.match(artifact.checkpoint(), /Observed paths:\n- src\/main\.ts/);
  assert.match(artifact.checkpoint(), /Handoff draft: .*survey-one\.draft\.md/);

  const invalid = await tool.execute("one", { action: "submit" }, undefined, undefined, undefined);
  assert.equal(invalid.isError, true);
  assert.equal(checks, 1);
  const progress = (await artifact.references()).progress.path;
  assert.equal(JSON.parse(await readFile(path.join(root, ...progress.split("/")), "utf8")).phase, "submit_invalid");
  assert.equal(await artifact.onIdle(), "repair the draft");

  await tool.execute("two", {
    action: "replace",
    text: "## Source\n\nself\n\n## Domains\n\nnone\n\n## Concepts\n\nnone\n\n## Cross-Source leads\n\nnone\n\n## Contract hints\n\nnone\n\n## Tables\n\nnone\n\n## Survey gaps\n\nnone\n",
  }, undefined, undefined, undefined);
  const checked = await tool.execute("check", { action: "check" }, undefined, undefined, undefined);
  assert.match(checked.content[0].text, /Draft is valid/);
  const submitted = await tool.execute("three", { action: "submit" }, undefined, undefined, undefined);
  assert.equal(submitted.isError, undefined);
  assert.equal(await artifact.onIdle(), undefined);

  const sealed = await artifact.seal();
  const parsed = parseHandoff(await readFile(path.join(root, ...sealed.path.split("/")), "utf8"));
  assert.match(parsed?.body ?? "", /^## Source/);
  assert.equal(checks, 2);
  assert.equal(JSON.parse(await readFile(path.join(root, ...progress.split("/")), "utf8")).phase, "sealed");
  await assert.rejects(() => artifact.seal(), /already sealed/);
});

test("review submission fails when its frozen Candidate changes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-review-artifact-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  let candidate = "base";
  const artifact = await createWorkerArtifact({
    workspaceRoot: root,
    handoffsRoot: path.join(root, "handoffs"),
    task: { id: "review-one", agent: "review", task: "Review", boardTaskId: "review", partition: "candidate" },
    sourceFingerprint: "source",
    baseCandidateRevision: "base",
    currentCandidateRevision: async () => candidate,
    completion: { observe() {}, async validate() { return undefined; } },
  });
  candidate = "changed";
  const submitted = await artifact.tool.execute("submit", { action: "submit" }, undefined, undefined, undefined);
  assert.equal(submitted.isError, true);
  assert.match(submitted.content[0].text, /Frozen Candidate changed/);
  await assert.rejects(() => artifact.onIdle(), /Frozen Candidate changed/);
});

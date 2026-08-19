import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWikiArtifactStore, MAX_WIKI_RESEARCH_ARTIFACT_BYTES } from "../dist/artifact-store.js";

async function fixture(t) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-artifacts-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  return { workspace, store: createWikiArtifactStore({ workspace }) };
}

test("writes and resumes content-addressed Markdown handoffs through the manifest", async (t) => {
  const { workspace, store } = await fixture(t);
  const input = { runId: "run-1", contractId: "research-1", attempt: 1, scope: ["source"], kind: "research-handoff", content: "# Finding\n" };
  const ref = await store.write(input);
  assert.equal(ref.mediaType, "text/markdown");
  assert.match(ref.relativePath, /^\.okf-wiki\/blobs\/[a-f0-9]{64}\.md$/);
  assert.equal(await store.read(ref), input.content);
  const manifest = JSON.parse(await readFile(path.join(workspace, ".okf-wiki", "runs", "run-1", "manifest.json"), "utf8"));
  assert.deepEqual(manifest.artifacts, [ref]);
  const resumed = createWikiArtifactStore({ workspace });
  assert.equal(await resumed.read(ref), input.content);
});

test("rejects unsafe, oversized, forged, and symlinked handoffs", async (t) => {
  const { workspace, store } = await fixture(t);
  await assert.rejects(() => store.write({ runId: "../bad", contractId: "n", attempt: 1, scope: [], kind: "research-handoff", content: "x" }), /Invalid Wiki handoff run ID/);
  await assert.rejects(() => store.write({ runId: "run", contractId: "n", attempt: 1, scope: [], kind: "research-handoff", content: "x".repeat(MAX_WIKI_RESEARCH_ARTIFACT_BYTES + 1) }), /262144-byte limit/);
  const ref = await store.write({ runId: "run", contractId: "n", attempt: 1, scope: ["source"], kind: "research-handoff", content: "valid\n" });
  await assert.rejects(() => store.read({ ...ref, relativePath: ".okf-wiki/blobs/forged.md" }), /Invalid Wiki handoff artifact reference/);
  const blob = path.join(workspace, ref.relativePath);
  const outside = path.join(workspace, "outside.md");
  await writeFile(outside, "outside\n");
  await rm(blob);
  await symlink(outside, blob);
  await assert.rejects(() => store.read(ref), /symbolic link/);
});

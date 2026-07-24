import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import {
  deleteSessionRuns,
  listRuns,
  loadRun,
  registerRunRecord,
  updateRunRecord,
} from "./run-store.js";

test("registerRunRecord persists a complete Wiki Run Record v2", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-run-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const created = await registerRunRecord(root, "workspace-1", {
    runId: "run-1",
    status: "awaiting_plan",
    sessionId: "session-1",
    autoApprove: false,
    skillPath: path.join(root, ".okf-wiki", "runs", "run-1", "skill"),
    skillDigest: "a".repeat(64),
    sources: [
      {
        id: "main",
        revision: "b".repeat(40),
        effectiveIgnores: ["node_modules/**"],
      },
    ],
  });

  assert.deepEqual(await loadRun(root, "run-1"), created);
  assert.deepEqual(
    {
      schema: created.schema,
      sessionId: created.sessionId,
      autoApprove: created.autoApprove,
      error: created.error,
      spec: created.spec,
      pages: created.pages,
      summary: created.summary,
      sources: created.sources,
    },
    {
      schema: "okf.wiki-run/v2",
      sessionId: "session-1",
      autoApprove: false,
      error: null,
      spec: null,
      pages: [],
      summary: null,
      sources: [
        {
          id: "main",
          revision: "b".repeat(40),
          effectiveIgnores: ["node_modules/**"],
        },
      ],
    },
  );
});

test("loadRun and listRuns ignore legacy records without deleting them", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-run-store-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recordsDir = path.join(root, ".okf-wiki", "runs");
  const legacyPath = path.join(recordsDir, "legacy-run.json");
  await mkdir(recordsDir, { recursive: true });
  await writeFile(
    legacyPath,
    JSON.stringify({
      runId: "legacy-run",
      workspaceId: "workspace-1",
      status: "failed",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
    }),
  );

  assert.equal(await loadRun(root, "legacy-run"), null);
  assert.deepEqual(await listRuns(root), []);
  assert.equal(
    await readFile(legacyPath, "utf8"),
    JSON.stringify({
      runId: "legacy-run",
      workspaceId: "workspace-1",
      status: "failed",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
    }),
  );
});

test("registerRunRecord refuses to overwrite an existing record", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-run-store-exclusive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    runId: "same-run",
    sessionId: "original-session",
    autoApprove: false,
    skillPath: path.join(root, ".okf-wiki", "runs", "same-run", "skill"),
    skillDigest: "a".repeat(64),
    sources: [
      {
        id: "main",
        revision: "b".repeat(40),
        effectiveIgnores: [] as string[],
      },
    ],
  };
  const original = await registerRunRecord(root, "workspace-1", options);

  await assert.rejects(
    () =>
      registerRunRecord(root, "workspace-2", {
        ...options,
        sessionId: "replacement-session",
      }),
    /already exists/i,
  );
  assert.deepEqual(await loadRun(root, "same-run"), original);
});

test("registerRunRecord requires the immutable run-owned Skill path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-run-store-skill-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    () =>
      registerRunRecord(root, "workspace-1", {
        runId: "run-1",
        sessionId: "session-1",
        autoApprove: false,
        skillPath: path.join(root, "live-skill"),
        skillDigest: "a".repeat(64),
        sources: [
          {
            id: "main",
            revision: "b".repeat(40),
            effectiveIgnores: [],
          },
        ],
      }),
    /run-owned skill path/i,
  );
  assert.equal(await loadRun(root, "run-1"), null);
});

test("updateRunRecord changes results while frozen inputs remain immutable", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-run-store-patch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = await registerRunRecord(root, "workspace-1", {
    runId: "run-1",
    sessionId: "session-1",
    autoApprove: false,
    skillPath: path.join(root, ".okf-wiki", "runs", "run-1", "skill"),
    skillDigest: "a".repeat(64),
    sources: [
      {
        id: "main",
        revision: "b".repeat(40),
        effectiveIgnores: ["node_modules/**"],
      },
    ],
  });
  const spec = defaultWikiRunSpec("Workspace");

  const updated = await updateRunRecord(root, "run-1", {
    status: "awaiting_publication",
    spec,
    pages: ["overview.md"],
    summary: "Ready",
  });
  assert.deepEqual(
    {
      workspaceId: updated.workspaceId,
      sessionId: updated.sessionId,
      autoApprove: updated.autoApprove,
      skillPath: updated.skillPath,
      skillDigest: updated.skillDigest,
      sources: updated.sources,
      createdAt: updated.createdAt,
    },
    {
      workspaceId: original.workspaceId,
      sessionId: original.sessionId,
      autoApprove: original.autoApprove,
      skillPath: original.skillPath,
      skillDigest: original.skillDigest,
      sources: original.sources,
      createdAt: original.createdAt,
    },
  );
  assert.equal(updated.status, "awaiting_publication");
  assert.deepEqual(updated.spec, spec);
  assert.deepEqual(updated.pages, ["overview.md"]);

  await assert.rejects(
    () =>
      updateRunRecord(root, "run-1", {
        sessionId: "replacement",
      } as never),
    /cannot patch frozen/i,
  );
  assert.deepEqual(await loadRun(root, "run-1"), updated);
});

test("deleteSessionRuns removes only current-schema records and artifacts owned by the Session", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-run-store-cascade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, ".okf-wiki", "runs");

  for (const [runId, sessionId] of [
    ["owned-run", "session-1"],
    ["other-run", "session-2"],
  ] as const) {
    const runDir = path.join(runsRoot, runId);
    const skillPath = path.join(runDir, "skill");
    await mkdir(skillPath, { recursive: true });
    await writeFile(path.join(skillPath, "SKILL.md"), `# ${runId}\n`);
    await registerRunRecord(root, "workspace-1", {
      runId,
      sessionId,
      autoApprove: false,
      skillPath,
      skillDigest: "a".repeat(64),
      sources: [
        {
          id: "main",
          revision: "b".repeat(40),
          effectiveIgnores: [],
        },
      ],
    });
  }
  await chmod(path.join(runsRoot, "owned-run", "skill", "SKILL.md"), 0o444);
  await chmod(path.join(runsRoot, "owned-run", "skill"), 0o555);

  const legacyRecord = path.join(runsRoot, "legacy-run.json");
  const legacyDir = path.join(runsRoot, "legacy-run");
  await mkdir(legacyDir);
  await writeFile(path.join(legacyDir, "sentinel.txt"), "keep\n");
  await writeFile(
    legacyRecord,
    JSON.stringify({
      runId: "legacy-run",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      status: "failed",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
    }),
  );

  assert.deepEqual(await deleteSessionRuns(root, "session-1"), ["owned-run"]);
  await assert.rejects(() => lstat(path.join(runsRoot, "owned-run")), /ENOENT/);
  await assert.rejects(() => lstat(path.join(runsRoot, "owned-run.json")), /ENOENT/);
  assert.ok(await loadRun(root, "other-run"));
  assert.equal(await readFile(path.join(legacyDir, "sentinel.txt"), "utf8"), "keep\n");
  assert.equal(
    await readFile(legacyRecord, "utf8").then((body) => JSON.parse(body).sessionId),
    "session-1",
  );
});

test("updateRunRecord keeps cancellation races inside the Run Store", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-run-store-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const register = (runId: string, status: "cancelled" | "published") =>
    registerRunRecord(root, "workspace-1", {
      runId,
      status,
      sessionId: "session-1",
      autoApprove: false,
      skillPath: path.join(root, ".okf-wiki", "runs", runId, "skill"),
      skillDigest: "a".repeat(64),
      sources: [{ id: "main", revision: "b".repeat(40), effectiveIgnores: [] }],
    });

  await register("cancelled-run", "cancelled");
  assert.equal(
    (await updateRunRecord(root, "cancelled-run", { status: "published" })).status,
    "cancelled",
  );

  await register("published-run", "published");
  await assert.rejects(
    () => updateRunRecord(root, "published-run", { status: "cancelled" }),
    /not running/,
  );
});

test("updateRunRecord serializes concurrent cancel vs published/failed (cancel-wins)", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-run-store-rmw-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  // Many iterations so interleaving would surface without the per-path lock.
  for (let i = 0; i < 40; i++) {
    const runId = `race-${i}`;
    await registerRunRecord(root, "workspace-1", {
      runId,
      status: "running",
      sessionId: "session-1",
      autoApprove: false,
      skillPath: path.join(root, ".okf-wiki", "runs", runId, "skill"),
      skillDigest: "a".repeat(64),
      sources: [{ id: "main", revision: "b".repeat(40), effectiveIgnores: [] }],
    });

    const settled = await Promise.allSettled([
      updateRunRecord(root, runId, { status: "cancelled" }),
      updateRunRecord(root, runId, {
        status: "published",
        pages: ["overview.md"],
        summary: "done",
      }),
      updateRunRecord(root, runId, { status: "failed", error: "boom" }),
    ]);

    const final = await loadRun(root, runId);
    assert.ok(final, `run ${runId} should still exist`);

    // Once any concurrent caller observed cancelled, disk must stay cancelled
    // (late published/failed must not clobber cancel under the RMW lock).
    const cancelObserved = settled.some(
      (r) => r.status === "fulfilled" && r.value.status === "cancelled",
    );
    if (cancelObserved) {
      assert.equal(
        final.status,
        "cancelled",
        `cancel-wins violated for ${runId}: final=${final.status}`,
      );
    } else {
      // Agent finished first: cancel must conflict; final is terminal non-cancel.
      assert.ok(
        final.status === "published" || final.status === "failed",
        `expected published|failed for ${runId}, got ${final.status}`,
      );
      const cancelResult = settled[0];
      assert.equal(cancelResult.status, "rejected");
    }

    // Frozen identity fields must never be torn by concurrent writers.
    assert.equal(final.runId, runId);
    assert.equal(final.sessionId, "session-1");
    assert.equal(final.workspaceId, "workspace-1");
    assert.equal(final.skillDigest, "a".repeat(64));
  }
});

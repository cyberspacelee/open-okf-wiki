/**
 * Session chat turn integration matrix (fixture mode).
 * Exercises createSessionTurnStream + finalize without full HTTP.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  createSessionTurnStream,
  resetMastraForTests,
  sessionMessagesToUIMessages,
  uiMessagesToSessionMessages,
} from "@okf-wiki/agent";
import {
  addSource,
  createOperatorSession,
  createWorkspace,
  loadOperatorSession,
  loadRun,
  replaceSessionMessages,
  saveWorkspace,
} from "@okf-wiki/core";
import type { OperatorSession, WorkspaceConfig } from "@okf-wiki/contract";
import type { UIMessage } from "ai";
import { finalizeSessionChatTurn } from "./session-chat-finalize.ts";
import {
  isSessionChatTurnBlocked,
  sessionChatLockKey,
  setSessionChatInFlightForTests,
} from "./session-chat-lock.ts";

const execFileAsync = promisify(execFile);

async function makeWorkspace(root: string): Promise<WorkspaceConfig> {
  const sourcePath = path.join(root, "src-repo");
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "README.md"), "# s\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: sourcePath });
  await execFileAsync("git", ["config", "user.email", "t@e.com"], {
    cwd: sourcePath,
  });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: sourcePath });
  await execFileAsync("git", ["add", "."], { cwd: sourcePath });
  await execFileAsync("git", ["commit", "-m", "i"], { cwd: sourcePath });

  let ws = await createWorkspace({
    name: "Chat IT",
    rootPath: root,
    publicationPath: path.join(root, "wiki"),
    modelId: "openai/test",
  });
  const added = await addSource(ws, {
    id: "main",
    path: sourcePath,
    applyDefaultIgnores: true,
    ignore: [],
  });
  ws = { ...added.config, planConfirm: true };
  await saveWorkspace(ws);
  return ws;
}

async function drainStream(stream: ReadableStream<unknown>): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

test("session chat: kickoff start → awaiting_plan + finalize upserts run", async () => {
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  process.env.OKF_WIKI_MASTRA_STORAGE = "memory";
  resetMastraForTests();

  const root = await mkdtemp(path.join(tmpdir(), "okf-chat-start-"));
  try {
    const workspace = await makeWorkspace(root);
    let session = await createOperatorSession({
      workspaceRoot: workspace.rootPath,
      workspaceId: workspace.id,
    });

    const userMsg: UIMessage = {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "generate a wiki plan" }],
    };
    const messages = [
      ...sessionMessagesToUIMessages(session.messages),
      userMsg,
    ];

    const chat = await createSessionTurnStream({
      session,
      workspace,
      messages,
      body: { intent: "start", message: userMsg },
    });
    assert.equal(chat.mode, "start");
    assert.ok(chat.runId);

    await drainStream(chat.stream);
    await finalizeSessionChatTurn({
      workspaceRoot: workspace.rootPath,
      workspaceId: workspace.id,
      sessionId: session.id,
      lastUserMessageId: userMsg.id,
      lastUserMessage: userMsg,
      chat,
      uiMessagesToSessionMessages,
    });

    session = (await loadOperatorSession(
      workspace.rootPath,
      session.id,
    )) as OperatorSession;
    assert.ok(session.messages.length >= 1);
    const run = await loadRun(workspace.rootPath, chat.runId!);
    assert.ok(run);
    assert.ok(
      run.status === "awaiting_plan" ||
        run.status === "running" ||
        run.status === "awaiting_publication" ||
        run.status === "published",
      `unexpected run status ${run.status}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    delete process.env.OKF_WIKI_AGENT_MODE;
    delete process.env.OKF_WIKI_MASTRA_STORAGE;
    resetMastraForTests();
  }
});

test("session chat lock: in-process blocks concurrent turn", () => {
  const key = sessionChatLockKey("/tmp/ws", "s1");
  setSessionChatInFlightForTests(key, true);
  try {
    assert.equal(
      isSessionChatTurnBlocked({
        inFlight: true,
        wouldRunWorkflow: true,
        session: {
          status: "active",
          updatedAt: new Date().toISOString(),
        },
      }),
      true,
    );
  } finally {
    setSessionChatInFlightForTests(key, false);
  }
});

test("session chat: help mode without sources", async () => {
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  process.env.OKF_WIKI_MASTRA_STORAGE = "memory";
  resetMastraForTests();

  const root = await mkdtemp(path.join(tmpdir(), "okf-chat-help-"));
  try {
    let ws = await createWorkspace({
      name: "Empty",
      rootPath: root,
      publicationPath: path.join(root, "wiki"),
      modelId: "openai/test",
    });
    await saveWorkspace(ws);
    ws = { ...ws, sources: [] };

    const session = await createOperatorSession({
      workspaceRoot: ws.rootPath,
      workspaceId: ws.id,
    });
    const userMsg: UIMessage = {
      id: "u-help",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    };
    const chat = await createSessionTurnStream({
      session,
      workspace: ws,
      messages: [userMsg],
      body: { intent: "chat", message: userMsg },
    });
    assert.equal(chat.mode, "help");
    await drainStream(chat.stream);
    const fin = await chat.finalize();
    assert.ok(fin.messages.length >= 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    delete process.env.OKF_WIKI_AGENT_MODE;
    delete process.env.OKF_WIKI_MASTRA_STORAGE;
    resetMastraForTests();
  }
});

test("session messages replace after mid-turn checkpoint shape", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-chat-cp-"));
  try {
    const workspace = await makeWorkspace(root);
    const session = await createOperatorSession({
      workspaceRoot: workspace.rootPath,
      workspaceId: workspace.id,
    });
    await replaceSessionMessages(
      workspace.rootPath,
      session.id,
      [
        {
          id: "a1",
          role: "assistant",
          parts: [{ type: "text", text: "partial", state: "done" }],
          createdAt: new Date().toISOString(),
        },
      ],
      {
        status: "running",
        workflow: { phase: "writing", linkedRunId: "r-mid" },
      },
    );
    const reloaded = await loadOperatorSession(workspace.rootPath, session.id);
    assert.equal(reloaded?.status, "running");
    assert.equal(reloaded?.workflow.phase, "writing");
    assert.equal(reloaded?.workflow.linkedRunId, "r-mid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Thin Pi-native session history load + JSONL discovery.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { OKF_PRODUCE_PROGRESS_CUSTOM_TYPE } from "../produce/tools/wiki-produce-progress.js";
import {
  findPiSessionFile,
  foldProduceUnitDetails,
  isPiSessionJsonlName,
  loadPiSessionHistory,
  type PiAssistantMessage,
  type PiToolResultMessage,
  type PiUserMessage,
  produceUnitsFromSessionEntries,
} from "./session-history.js";
import { piSessionsDir } from "./session-paths.js";

describe("isPiSessionJsonlName", () => {
  it("matches Pi timestamp_id and plain id names", () => {
    assert.equal(
      isPiSessionJsonlName(
        "2026-07-23T01-36-23-175Z_product-session-abc.jsonl",
        "product-session-abc",
      ),
      true,
    );
    assert.equal(isPiSessionJsonlName("product-session-abc.jsonl", "product-session-abc"), true);
    assert.equal(
      isPiSessionJsonlName("2026-07-23T01-36-23-175Z_other-id.jsonl", "product-session-abc"),
      false,
    );
  });
});

describe("findPiSessionFile / loadPiSessionHistory", () => {
  it("finds Pi TIMESTAMP_sessionId.jsonl and returns content blocks intact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "okf-hist-"));
    try {
      const sessionDir = piSessionsDir(root);
      await mkdir(sessionDir, { recursive: true });
      const cwd = path.join(root, "work");
      await mkdir(cwd, { recursive: true });

      const productId = "product-session-hist1";
      const sm = SessionManager.create(cwd, sessionDir, { id: productId });
      // Minimal message shapes for persistence tests (not full AssistantMessage).
      sm.appendMessage({
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: Date.now(),
      } as never);
      sm.appendMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "think" },
          { type: "text", text: "world" },
        ],
        stopReason: "stop",
        timestamp: Date.now(),
      } as never);

      const file = sm.getSessionFile();
      assert.ok(file);
      assert.match(path.basename(file!), /_product-session-hist1\.jsonl$/);

      // Legacy exact path must miss — this was the production bug.
      assert.notEqual(path.basename(file!), `${productId}.jsonl`);

      const found = await findPiSessionFile(root, productId);
      assert.equal(found, file);

      const history = await loadPiSessionHistory(root, productId);
      assert.equal(history.sessionFile, file);
      assert.equal(history.messages.length, 2);

      const user = history.messages[0] as PiUserMessage;
      assert.equal(user.role, "user");
      assert.ok(Array.isArray(user.content));
      assert.deepEqual(user.content, [{ type: "text", text: "hello" }]);
      // No flattened string fields
      assert.equal("text" in user && typeof (user as { text?: unknown }).text === "string", false);

      const assistant = history.messages[1] as PiAssistantMessage;
      assert.equal(assistant.role, "assistant");
      assert.ok(Array.isArray(assistant.content));
      assert.equal(assistant.content.length, 2);
      assert.deepEqual(assistant.content[0], { type: "thinking", thinking: "think" });
      assert.deepEqual(assistant.content[1], { type: "text", text: "world" });
      assert.equal(assistant.stopReason, "stop");
      // No ProjectedHistoryMessage tools/text/thinking flatten
      assert.equal(
        "thinking" in assistant &&
          typeof (assistant as { thinking?: unknown }).thinking === "string",
        false,
      );
      assert.equal("tools" in assistant, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps toolCall blocks and toolResult messages (no pair-and-flatten)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "okf-hist-tools-"));
    try {
      const sessionDir = piSessionsDir(root);
      await mkdir(sessionDir, { recursive: true });
      const cwd = path.join(root, "work");
      await mkdir(cwd, { recursive: true });

      const productId = "product-session-tools";
      const sm = SessionManager.create(cwd, sessionDir, { id: productId });
      sm.appendMessage({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc1",
            name: "read",
            arguments: { path: "wiki/overview.md" },
          },
        ],
        stopReason: "toolUse",
        timestamp: Date.now(),
      } as never);
      sm.appendMessage({
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "read",
        content: [{ type: "text", text: "# Overview\nHello" }],
        isError: false,
        timestamp: Date.now(),
      } as never);

      const history = await loadPiSessionHistory(root, productId);
      assert.equal(history.messages.length, 2);

      const assistant = history.messages[0] as PiAssistantMessage;
      assert.equal(assistant.role, "assistant");
      const toolCall = assistant.content[0];
      assert.ok(toolCall && toolCall.type === "toolCall");
      assert.equal(toolCall.id, "tc1");
      assert.equal(toolCall.name, "read");
      assert.equal((toolCall.arguments as { path?: string }).path, "wiki/overview.md");
      assert.equal("tools" in assistant, false);

      const result = history.messages[1] as PiToolResultMessage;
      assert.equal(result.role, "toolResult");
      assert.equal(result.toolCallId, "tc1");
      assert.deepEqual(result.content, [{ type: "text", text: "# Overview\nHello" }]);
      assert.equal(result.isError, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps error assistant turns with empty content (stopReason error)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "okf-hist-err-"));
    try {
      const sessionDir = piSessionsDir(root);
      await mkdir(sessionDir, { recursive: true });
      const cwd = path.join(root, "work");
      await mkdir(cwd, { recursive: true });

      const productId = "product-session-err";
      const sm = SessionManager.create(cwd, sessionDir, { id: productId });
      sm.appendMessage({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "OpenAI API error (403): blocked",
        timestamp: Date.now(),
      } as never);

      const history = await loadPiSessionHistory(root, productId);
      assert.equal(history.messages.length, 1);
      const assistant = history.messages[0] as PiAssistantMessage;
      assert.equal(assistant.role, "assistant");
      assert.deepEqual(assistant.content, []);
      assert.equal(assistant.stopReason, "error");
      assert.match(assistant.errorMessage ?? "", /403/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns empty messages when session file is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "okf-hist-empty-"));
    try {
      await mkdir(piSessionsDir(root), { recursive: true });
      const history = await loadPiSessionHistory(root, "no-such-session");
      assert.equal(history.messages.length, 0);
      assert.equal(history.sessionFile, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honors preferredPath from product meta", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "okf-hist-pref-"));
    try {
      const sessionDir = piSessionsDir(root);
      await mkdir(sessionDir, { recursive: true });
      const preferred = path.join(sessionDir, "custom-name.jsonl");
      // Minimal valid Pi session file (header + one message).
      const header = {
        type: "session",
        version: 3,
        id: "pref-id",
        timestamp: new Date().toISOString(),
        cwd: root,
      };
      const entry = {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "user",
          content: [{ type: "text", text: "from preferred" }],
        },
      };
      await writeFile(preferred, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`, "utf8");

      const found = await findPiSessionFile(root, "other-id", {
        preferredPath: preferred,
      });
      assert.equal(found, preferred);

      const history = await loadPiSessionHistory(root, "other-id", {
        preferredPath: preferred,
      });
      assert.equal(history.messages.length, 1);
      const user = history.messages[0] as PiUserMessage;
      assert.equal(user.role, "user");
      assert.deepEqual(user.content, [{ type: "text", text: "from preferred" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads okf.produce_progress custom entries as produceUnits (last-by-unitId)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "okf-hist-produce-"));
    try {
      const sessionDir = piSessionsDir(root);
      await mkdir(sessionDir, { recursive: true });
      const cwd = path.join(root, "work");
      await mkdir(cwd, { recursive: true });

      const productId = "product-session-produce";
      const sm = SessionManager.create(cwd, sessionDir, { id: productId });
      // SessionManager only flushes to disk after an assistant message exists.
      sm.appendMessage({
        role: "user",
        content: [{ type: "text", text: "start wiki" }],
        timestamp: Date.now(),
      } as never);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stopReason: "stop",
        timestamp: Date.now(),
      } as never);
      sm.appendCustomEntry(OKF_PRODUCE_PROGRESS_CUSTOM_TYPE, {
        role: "leaf",
        status: "settled",
        unitId: "leaf-1",
        parentId: "domain-1",
        task: "write overview",
        summary: "done leaf",
      });
      // Second settle for same unit wins last-by-unitId.
      sm.appendCustomEntry(OKF_PRODUCE_PROGRESS_CUSTOM_TYPE, {
        role: "leaf",
        status: "settled",
        unitId: "leaf-1",
        parentId: "domain-1",
        summary: "final leaf",
      });
      sm.appendCustomEntry(OKF_PRODUCE_PROGRESS_CUSTOM_TYPE, {
        role: "domain",
        status: "failed",
        unitId: "domain-1",
        error: "boom",
      });

      const history = await loadPiSessionHistory(root, productId);
      assert.equal(history.messages.length, 2, "custom entries are not LLM messages");
      assert.ok(history.produceUnits);
      assert.equal(history.produceUnits!.length, 2);
      const leaf = history.produceUnits!.find((u) => u.unitId === "leaf-1");
      assert.ok(leaf);
      assert.equal(leaf!.summary, "final leaf");
      assert.equal(leaf!.status, "settled");
      const domain = history.produceUnits!.find((u) => u.unitId === "domain-1");
      assert.ok(domain);
      assert.equal(domain!.status, "failed");
      assert.equal(domain!.error, "boom");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("foldProduceUnitDetails / produceUnitsFromSessionEntries", () => {
  it("folds last-by-unitId and skips non-produce custom entries", () => {
    const folded = foldProduceUnitDetails([], {
      role: "planner",
      status: "running",
      unitId: "planner",
      task: "plan",
    });
    assert.equal(folded.length, 1);
    const again = foldProduceUnitDetails(folded, {
      role: "planner",
      status: "settled",
      unitId: "planner",
      summary: "ok",
    });
    assert.equal(again.length, 1);
    assert.equal(again[0]!.status, "settled");
    assert.equal(again[0]!.summary, "ok");
    assert.equal(again[0]!.task, "plan");

    const fromEntries = produceUnitsFromSessionEntries([
      { type: "message" },
      {
        type: "custom",
        customType: "other",
        data: { role: "leaf", status: "running", unitId: "x" },
      },
      {
        type: "custom",
        customType: OKF_PRODUCE_PROGRESS_CUSTOM_TYPE,
        data: { role: "leaf", status: "settled", unitId: "leaf-a", summary: "s" },
      },
    ]);
    assert.equal(fromEntries.length, 1);
    assert.equal(fromEntries[0]!.unitId, "leaf-a");
  });
});

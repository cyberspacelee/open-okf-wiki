/**
 * History projection + Pi JSONL discovery (pi-web SessionManager naming).
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  findPiSessionFile,
  isPiSessionJsonlName,
  loadPiSessionHistory,
  projectPiMessages,
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
    assert.equal(
      isPiSessionJsonlName("product-session-abc.jsonl", "product-session-abc"),
      true,
    );
    assert.equal(
      isPiSessionJsonlName(
        "2026-07-23T01-36-23-175Z_other-id.jsonl",
        "product-session-abc",
      ),
      false,
    );
  });
});

describe("projectPiMessages", () => {
  it("keeps empty assistant with stopReason error", () => {
    const rows = projectPiMessages([
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "OpenAI API error (403): blocked",
      },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "error");
    assert.match(rows[0]!.text, /403/);
  });

  it("keeps thinking-only assistant messages", () => {
    const rows = projectPiMessages([
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "plan steps" }],
        stopReason: "stop",
      },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.thinking, "plan steps");
    assert.equal(rows[0]!.status, "done");
  });

  it("projects user + assistant thinking/text like live transcript", () => {
    const rows = projectPiMessages([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "hi there" },
        ],
        stopReason: "stop",
        timestamp: 2,
      },
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.role, "user");
    assert.equal(rows[0]!.text, "hello");
    assert.equal(rows[1]!.role, "assistant");
    assert.equal(rows[1]!.thinking, "hmm");
    assert.equal(rows[1]!.text, "hi there");
  });

  it("drops empty non-error assistant", () => {
    assert.equal(
      projectPiMessages([
        { role: "assistant", content: [], stopReason: "stop" },
      ]).length,
      0,
    );
  });

  it("projects toolCall args and pairs toolResult text", () => {
    const rows = projectPiMessages([
      {
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
      },
      {
        role: "toolResult",
        toolCallId: "tc1",
        content: [{ type: "text", text: "# Overview\nHello" }],
        isError: false,
      },
    ]);
    assert.equal(rows.length, 1);
    const tools = rows[0]!.tools;
    assert.ok(tools?.length === 1);
    assert.equal(tools![0]!.name, "read");
    assert.match(tools![0]!.input ?? "", /overview\.md/);
    assert.match(tools![0]!.output ?? "", /Overview/);
  });
});

describe("findPiSessionFile / loadPiSessionHistory", () => {
  it("finds Pi TIMESTAMP_sessionId.jsonl under pi-sessions (not id.jsonl)", async () => {
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
      assert.equal(history.messages[0]!.role, "user");
      assert.equal(history.messages[0]!.text, "hello");
      assert.equal(history.messages[1]!.thinking, "think");
      assert.equal(history.messages[1]!.text, "world");
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
      await writeFile(
        preferred,
        `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`,
        "utf8",
      );

      const found = await findPiSessionFile(root, "other-id", {
        preferredPath: preferred,
      });
      assert.equal(found, preferred);

      const history = await loadPiSessionHistory(root, "other-id", {
        preferredPath: preferred,
      });
      assert.equal(history.messages.length, 1);
      assert.equal(history.messages[0]!.text, "from preferred");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

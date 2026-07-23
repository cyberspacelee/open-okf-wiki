import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPiChat,
  scriptProvider403,
  scriptThinkingThenText,
} from "./create-pi-chat.ts";
import { isCommandFailed } from "../hooks/command-result.ts";

describe("createPiChat fixtures", () => {
  it("projects provider 403 as a single error assistant (no duplicate system)", () => {
    const messages = scriptProvider403().project();
    const assistants = messages.filter((m) => m.role === "assistant");
    const systems = messages.filter(
      (m) => m.role === "system" && m.status === "error",
    );
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0]!.status, "error");
    assert.match(assistants[0]!.content, /403/);
    // Deduped: no second system error card with the same text.
    assert.equal(systems.length, 0);
  });

  it("projects thinking then text", () => {
    const messages = scriptThinkingThenText().project();
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.thinking, "Let me think");
    assert.equal(messages[0]!.content, "Hello!");
    assert.equal(messages[0]!.status, "done");
  });

  it("projects product failed phase", () => {
    const messages = createPiChat()
      .product({
        kind: "run_phase",
        phase: "failed",
        runId: "run-1",
        status: "failed",
        message: "freeze failed: dirty worktree",
      })
      .project();
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.product?.kind, "run_phase");
    assert.match(messages[0]!.content, /failed/);
  });
});

describe("isCommandFailed", () => {
  it("treats ok:false and status failed as failures", () => {
    assert.equal(
      isCommandFailed({
        ok: false,
        sessionId: "s",
        command: "prompt",
        status: "failed",
        message: "x",
      }),
      true,
    );
    assert.equal(
      isCommandFailed({
        ok: true,
        sessionId: "s",
        command: "prompt",
        status: "accepted",
      }),
      false,
    );
  });
});

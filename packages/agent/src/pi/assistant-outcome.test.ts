import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  lastAssistantOutcome,
  resolveAssistantSummary,
} from "./assistant-outcome.js";

describe("lastAssistantOutcome", () => {
  it("detects stopReason error", () => {
    const out = lastAssistantOutcome([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "OpenAI API error (403): blocked",
      },
    ]);
    assert.ok(out);
    assert.equal(out!.isError, true);
    assert.match(out!.errorMessage ?? "", /403/);
  });

  it("extracts text and thinking", () => {
    const out = lastAssistantOutcome([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan" },
          { type: "text", text: "done" },
        ],
        stopReason: "stop",
      },
    ]);
    assert.equal(out?.text, "done");
    assert.equal(out?.thinking, "plan");
    assert.equal(out?.isError, false);
  });
});

describe("resolveAssistantSummary", () => {
  it("fails closed on provider error even with empty stream", () => {
    const r = resolveAssistantSummary({
      streamedText: "",
      roleLabel: "domain",
      messages: [
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "blocked",
        },
      ],
    });
    assert.equal(r.isError, true);
    assert.match(r.summary, /blocked/);
  });

  it("prefers streamed text", () => {
    const r = resolveAssistantSummary({
      streamedText: "from stream",
      roleLabel: "leaf",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "from content" }],
          stopReason: "stop",
        },
      ],
    });
    assert.equal(r.isError, false);
    assert.equal(r.summary, "from stream");
  });
});

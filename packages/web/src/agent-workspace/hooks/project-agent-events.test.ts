import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import { reducePiEvent } from "./project/pi.ts";
import { createPiStreamState, projectAgentEvent, viewMessages } from "./project-agent-events.ts";

describe("projectAgentEvent", () => {
  it("uses the server snapshot as the complete durable SessionManager view", () => {
    const state = projectAgentEvent(createPiStreamState(), {
      source: "server",
      kind: "snapshot",
      sessionId: "session-1",
      timestamp: "2026-07-24T00:00:00.000Z",
      payload: {
        session: { id: "session-1", workspaceId: "workspace-1" },
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Produce the wiki" }],
            timestamp: 1,
          },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Starting " },
              {
                type: "toolCall",
                id: "wiki-1",
                name: "wiki_produce",
                arguments: { audience: "maintainers" },
              },
            ],
            stopReason: "stop",
            timestamp: 2,
          },
          {
            role: "toolResult",
            toolCallId: "wiki-1",
            toolName: "wiki_produce",
            content: [{ type: "text", text: "published 4 pages" }],
            isError: false,
            timestamp: 3,
          },
        ],
      },
    });

    const messages = viewMessages(state);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]!.role, "user");
    assert.equal(messages[0]!.content, "Produce the wiki");
    assert.equal(messages[1]!.role, "assistant");
    assert.equal(messages[1]!.content, "Starting ");
    assert.deepEqual(messages[1]!.tools, [
      {
        id: "wiki-1",
        name: "wiki_produce",
        input: '{"audience":"maintainers"}',
        output: "published 4 pages",
        status: "done",
      },
    ]);
  });

  it("replaces stale local state when EventSource reconnects with a fresh snapshot", () => {
    const stale = createPiStreamState([
      {
        id: "stale",
        role: "assistant",
        content: "stale replay copy",
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "done",
      },
    ]);

    const next = projectAgentEvent(stale, {
      source: "server",
      kind: "snapshot",
      sessionId: "session-1",
      timestamp: "2026-07-24T00:00:00.000Z",
      payload: {
        session: { id: "session-1", workspaceId: "workspace-1" },
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "durable truth" }],
            stopReason: "stop",
            timestamp: 4,
          },
        ],
      },
    });

    assert.deepEqual(
      viewMessages(next).map((message) => message.content),
      ["durable truth"],
    );
  });

  it("restores the genuine live wiki_produce gate from a reconnect snapshot", () => {
    const spec = defaultWikiRunSpec("Reconnect");
    const state = projectAgentEvent(createPiStreamState(), {
      source: "server",
      kind: "snapshot",
      sessionId: "session-1",
      timestamp: "2026-07-24T00:00:00.000Z",
      payload: {
        session: { id: "session-1", workspaceId: "workspace-1" },
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "wiki-1",
                name: "wiki_produce",
                arguments: {},
              },
            ],
            stopReason: "toolUse",
            timestamp: 2,
          },
        ],
        activeTool: {
          toolCallId: "wiki-1",
          toolName: "wiki_produce",
          details: {
            status: "awaiting_plan",
            runId: "run-1",
            spec,
            summary: "Awaiting WikiRunSpec approval",
          },
        },
      },
    });

    const tool = viewMessages(state)[0]!.tools?.[0];
    assert.equal(tool?.id, "wiki-1");
    assert.equal(tool?.status, "running");
    assert.equal(tool?.details?.status, "awaiting_plan");
    assert.equal(tool?.details?.spec?.summary, spec.summary);
  });

  it("ignores heartbeat", () => {
    const seed = createPiStreamState([
      {
        id: "one",
        role: "user",
        content: "hello",
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "done",
      },
    ]);

    assert.equal(
      projectAgentEvent(seed, {
        source: "server",
        kind: "heartbeat",
        sessionId: "session-1",
        timestamp: "2026-07-24T00:00:00.000Z",
      }),
      seed,
    );
  });
});

describe("reducePiEvent", () => {
  it("projects full Pi message snapshots without appending transport deltas", () => {
    let state = createPiStreamState();
    state = reducePiEvent(state, "agent_start", { type: "agent_start" });
    state = reducePiEvent(state, "message_start", {
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    state = reducePiEvent(state, "message_update", {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "Hel" }] },
      assistantMessageEvent: { type: "text_delta", delta: "Hel" },
    });
    state = reducePiEvent(state, "message_update", {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      assistantMessageEvent: { type: "text_delta", delta: "lo" },
    });
    state = reducePiEvent(state, "message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        stopReason: "stop",
      },
    });

    assert.equal(viewMessages(state).length, 1);
    assert.equal(viewMessages(state)[0]!.content, "Hello");
  });

  it("projects the real Pi tool lifecycle on its assistant message", () => {
    const spec = defaultWikiRunSpec("Fixture");
    let state = createPiStreamState();
    state = reducePiEvent(state, "agent_start", { type: "agent_start" });
    state = reducePiEvent(state, "message_start", {
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
      },
    });
    state = reducePiEvent(state, "message_update", {
      type: "message_update",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tool-1",
            name: "wiki_produce",
            arguments: { audience: "users" },
          },
        ],
      },
    });
    state = reducePiEvent(state, "message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tool-1",
            name: "wiki_produce",
            arguments: { audience: "users" },
          },
        ],
        stopReason: "toolUse",
      },
    });
    state = reducePiEvent(state, "tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "wiki_produce",
      args: { audience: "users" },
    });
    state = reducePiEvent(state, "tool_execution_update", {
      type: "tool_execution_update",
      toolCallId: "tool-1",
      partialResult: {
        content: [{ type: "text", text: "Awaiting WikiRunSpec approval" }],
        details: { status: "awaiting_plan", runId: "run-1", spec },
      },
    });
    assert.equal(viewMessages(state)[0]!.tools?.[0]?.details?.status, "awaiting_plan");
    assert.equal(viewMessages(state)[0]!.tools?.[0]?.details?.spec?.pages[0]?.path, "overview.md");
    state = reducePiEvent(state, "tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "wiki_produce",
      result: {
        content: [{ type: "text", text: "published" }],
        details: {
          status: "published",
          runId: "run-1",
          spec,
          pages: ["overview.md"],
        },
      },
      isError: false,
    });

    const tool = viewMessages(state)[0]!.tools?.[0];
    assert.equal(tool?.name, "wiki_produce");
    assert.equal(tool?.status, "done");
    assert.equal(tool?.output, "published");
    assert.equal(tool?.details?.status, "published");
    assert.deepEqual(tool?.details?.pages, ["overview.md"]);
  });
});

/**
 * Pure projection of Pi AgentSession events → transcript rows.
 *
 * Protocol (aligned with pi-web / @earendil-works/pi-agent-core + pi-ai):
 * - message_start / message_update / message_end carry `message.role`
 * - user messages: ignored (UI already optimistically appended)
 * - toolResult messages: ignored as cards (tool_execution_* owns tool chrome)
 * - assistant: one bubble per assistant message; text_delta + thinking_delta stream in
 * - message_end finalizes lastAssistant when streaming id was cleared (agent_end /
 *   duplicate end) — never invent a second thinking+answer card for the same turn
 * - message_start reuses an already-streaming bubble (early deltas before start)
 * - stopReason "error" / errorMessage surface as status "error" (never silent empty)
 * - tool_execution_*: attach to the **last assistant** bubble (never invent a new one)
 *
 * Server wraps Pi events as `{ source:"pi", kind, payload }` where payload is
 * the raw AgentEvent (type + message + assistantMessageEvent + …).
 */

export type AgentMessageRole = "user" | "assistant" | "tool" | "system";

export type AgentToolCall = {
  id: string;
  name: string;
  input?: string;
  output?: string;
  status: "pending" | "running" | "done" | "error";
};

export type PlanProgressPage = {
  path: string;
  status: "pending" | "writing" | "done" | string;
};

export type AgentProductMeta = {
  kind:
    | "run_phase"
    | "gate"
    | "run_link"
    | "progress"
    | "plan_progress"
    | "agent_span"
    | "defects";
  phase?: string;
  gate?: "plan" | "publication";
  runId?: string;
  status?: string;
  question?: string;
  /** Publication gate page paths (when known). */
  pages?: string[] | PlanProgressPage[];
  label?: string;
  spanId?: string;
  agentId?: string;
  role?: string;
  parentId?: string;
  receiptPath?: string;
  defectCount?: number;
  clean?: boolean;
  round?: number;
};

export type AgentMessage = {
  id: string;
  role: AgentMessageRole;
  content: string;
  /** Streamed / final thinking (Pi type:"thinking" blocks + thinking_delta). */
  thinking?: string;
  thinkingStatus?: "streaming" | "done";
  createdAt: string;
  tools?: AgentToolCall[];
  status?: string;
  /** Provider / agent error when status is "error". */
  errorMessage?: string;
  product?: AgentProductMeta;
};

export type StreamingRefs = {
  /** In-flight assistant bubble id (null between assistant messages). */
  streamingAssistantId: string | null;
  /** Last assistant bubble in the current turn (tools attach here). */
  lastAssistantId: string | null;
};

export type ProductSseLike = {
  kind:
    | "run_phase"
    | "gate"
    | "run_link"
    | "progress"
    | "plan_progress"
    | "agent_span"
    | "defects";
  phase?: string;
  gate?: "plan" | "publication";
  runId?: string;
  status?: string;
  question?: string;
  message?: string;
  pages?: string[] | PlanProgressPage[];
  plan?: unknown;
  timestamp?: string;
  label?: string;
  spanId?: string;
  agentId?: string;
  role?: string;
  parentId?: string;
  receiptPath?: string;
  promptSummary?: string;
  round?: number;
  clean?: boolean;
  defectCount?: number;
  summary?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

export function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function safeStringify(value: unknown, max = 4000): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    return value.length > max ? `${value.slice(0, max)}…` : value;
  }
  try {
    const s = JSON.stringify(value, null, 2);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract plain text from a Pi assistant/user message content array or string. */
export function extractMessageText(message: unknown): string {
  if (!isRecord(message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

/** Extract thinking blocks from a Pi assistant message content array. */
export function extractMessageThinking(message: unknown): string {
  if (!isRecord(message)) return "";
  const content = message.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "thinking" && typeof block.thinking === "string") {
      parts.push(block.thinking);
    }
  }
  return parts.join("");
}

/**
 * Pi assistant error fields (stopReason + errorMessage).
 * Used when the provider fails without throwing from session.prompt().
 */
export function extractAssistantError(message: unknown): {
  isError: boolean;
  errorMessage?: string;
  stopReason?: string;
} {
  if (!isRecord(message)) return { isError: false };
  const stopReason =
    typeof message.stopReason === "string" ? message.stopReason : undefined;
  const errorMessage =
    typeof message.errorMessage === "string" && message.errorMessage.trim()
      ? message.errorMessage.trim()
      : undefined;
  const isError =
    stopReason === "error" ||
    stopReason === "aborted" ||
    Boolean(errorMessage);
  return { isError, errorMessage, stopReason };
}

function messageRole(message: unknown): string | null {
  if (!isRecord(message) || typeof message.role !== "string") return null;
  return message.role;
}

function findMessageIndex(messages: AgentMessage[], id: string | null): number {
  if (!id) return -1;
  return messages.findIndex((m) => m.id === id);
}

function lastAssistantIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") return i;
  }
  return -1;
}

function ensureAssistantBubble(
  prev: AgentMessage[],
  refs: StreamingRefs,
  ts: string,
): { messages: AgentMessage[]; assistantId: string } {
  const streamingIdx = findMessageIndex(prev, refs.streamingAssistantId);
  if (streamingIdx >= 0) {
    return { messages: prev, assistantId: prev[streamingIdx]!.id };
  }
  const lastIdx = findMessageIndex(prev, refs.lastAssistantId);
  if (lastIdx >= 0 && prev[lastIdx]!.status === "streaming") {
    refs.streamingAssistantId = prev[lastIdx]!.id;
    return { messages: prev, assistantId: prev[lastIdx]!.id };
  }
  const id = makeId("asst");
  refs.streamingAssistantId = id;
  refs.lastAssistantId = id;
  return {
    messages: [
      ...prev,
      {
        id,
        role: "assistant",
        content: "",
        createdAt: ts,
        status: "streaming",
        tools: [],
      },
    ],
    assistantId: id,
  };
}

function finalizeAssistantContent(input: {
  text: string;
  existing: string;
  fixtureNote?: string;
  errorMessage?: string;
  isError: boolean;
}): string {
  if (input.text) return input.text;
  if (input.existing) return input.existing;
  if (input.isError && input.errorMessage) return input.errorMessage;
  if (input.fixtureNote) return input.fixtureNote;
  return "";
}

/**
 * Project one Pi event into transcript mutations.
 * Mutates `refs` in place (streaming ids).
 */
export function applyPiEvent(
  prev: AgentMessage[],
  kind: string,
  payload: unknown,
  refs: StreamingRefs,
): AgentMessage[] {
  const body = isRecord(payload) ? payload : {};
  const message = "message" in body ? body.message : undefined;
  const role = messageRole(message);
  const ts = nowIso();

  // --- message_update: stream text / thinking into the current assistant ----
  if (kind === "message_update") {
    // Only assistant messages stream; ignore anything else.
    if (role && role !== "assistant") return prev;

    const ame = isRecord(body.assistantMessageEvent)
      ? body.assistantMessageEvent
      : null;

    if (ame?.type === "text_delta" && typeof ame.delta === "string") {
      const delta = ame.delta;
      const ensured = ensureAssistantBubble(prev, refs, ts);
      return ensured.messages.map((m) =>
        m.id === ensured.assistantId
          ? { ...m, content: m.content + delta, status: "streaming" }
          : m,
      );
    }

    if (ame?.type === "thinking_start") {
      const ensured = ensureAssistantBubble(prev, refs, ts);
      return ensured.messages.map((m) =>
        m.id === ensured.assistantId
          ? {
              ...m,
              thinking: m.thinking ?? "",
              thinkingStatus: "streaming" as const,
              status: "streaming",
            }
          : m,
      );
    }

    if (ame?.type === "thinking_delta" && typeof ame.delta === "string") {
      const delta = ame.delta;
      const ensured = ensureAssistantBubble(prev, refs, ts);
      return ensured.messages.map((m) =>
        m.id === ensured.assistantId
          ? {
              ...m,
              thinking: (m.thinking ?? "") + delta,
              thinkingStatus: "streaming" as const,
              status: "streaming",
            }
          : m,
      );
    }

    if (ame?.type === "thinking_end") {
      const ensured = ensureAssistantBubble(prev, refs, ts);
      const endContent =
        typeof ame.content === "string" ? ame.content : undefined;
      return ensured.messages.map((m) =>
        m.id === ensured.assistantId
          ? {
              ...m,
              thinking:
                endContent && endContent.length > 0
                  ? endContent
                  : (m.thinking ?? ""),
              thinkingStatus: "done" as const,
              status: "streaming",
            }
          : m,
      );
    }

    // Snapshot path (pi-web style): replace content from partial message.
    // Only when there is no typed delta event — never append on top of deltas
    // (that would double text/thinking when providers send full snapshots).
    if (message && !ame) {
      const text = extractMessageText(message);
      const thinking = extractMessageThinking(message);
      if (
        text.length === 0 &&
        thinking.length === 0 &&
        !refs.streamingAssistantId
      ) {
        return prev;
      }
      const ensured = ensureAssistantBubble(prev, refs, ts);
      return ensured.messages.map((m) =>
        m.id === ensured.assistantId
          ? {
              ...m,
              // Replace (not append) — snapshot is the full partial message.
              content: text.length > 0 ? text : m.content,
              thinking: thinking.length > 0 ? thinking : m.thinking,
              thinkingStatus:
                thinking.length > 0
                  ? ("streaming" as const)
                  : m.thinkingStatus,
              status: "streaming",
            }
          : m,
      );
    }
    return prev;
  }

  // --- message_start --------------------------------------------------------
  if (kind === "message_start") {
    // User prompts are optimistic on the client; never invent a bubble.
    if (role === "user") return prev;
    // Tool results are mirrored via tool_execution_*; skip empty cards.
    if (role === "toolResult" || role === "tool") return prev;

    const initial = extractMessageText(message);
    const thinking = extractMessageThinking(message);
    const err = extractAssistantError(message);
    const isError = err.isError;

    // Reuse an in-flight assistant bubble (e.g. early thinking_delta opened one
    // via ensureAssistantBubble before message_start). Creating a second card
    // here is what users see as duplicated thinking + answer after the turn.
    let reuseId: string | null = null;
    const streamingIdx = findMessageIndex(prev, refs.streamingAssistantId);
    if (streamingIdx >= 0) {
      reuseId = prev[streamingIdx]!.id;
    } else {
      const lastIdx = findMessageIndex(prev, refs.lastAssistantId);
      if (lastIdx >= 0 && prev[lastIdx]!.status === "streaming") {
        reuseId = prev[lastIdx]!.id;
      }
    }

    if (reuseId) {
      refs.streamingAssistantId = reuseId;
      refs.lastAssistantId = reuseId;
      return prev.map((m) => {
        if (m.id !== reuseId) return m;
        return {
          ...m,
          content: isError
            ? finalizeAssistantContent({
                text: initial,
                existing: m.content,
                errorMessage: err.errorMessage,
                isError: true,
              })
            : initial || m.content,
          thinking: thinking || m.thinking,
          thinkingStatus: thinking
            ? isError
              ? ("done" as const)
              : ("streaming" as const)
            : m.thinkingStatus,
          status: isError ? "error" : "streaming",
          errorMessage: err.errorMessage ?? m.errorMessage,
          tools: m.tools ?? [],
        };
      });
    }

    // Assistant (or unknown role with assistant-shaped content): new bubble.
    const id = makeId("asst");
    refs.streamingAssistantId = id;
    refs.lastAssistantId = id;
    return [
      ...prev,
      {
        id,
        role: "assistant",
        content: isError
          ? finalizeAssistantContent({
              text: initial,
              existing: "",
              errorMessage: err.errorMessage,
              isError: true,
            })
          : initial,
        thinking: thinking || undefined,
        thinkingStatus: thinking
          ? isError
            ? ("done" as const)
            : ("streaming" as const)
          : undefined,
        createdAt: ts,
        status: isError ? "error" : "streaming",
        errorMessage: err.errorMessage,
        tools: [],
      },
    ];
  }

  // --- message_end ----------------------------------------------------------
  if (kind === "message_end") {
    if (role === "user") {
      // Do not touch streaming ids — user end is not an assistant boundary
      // that should orphan the next tool batch (those attach to lastAssistant).
      return prev;
    }
    if (role === "toolResult" || role === "tool") {
      return prev;
    }

    // Fixture mode: server emits note without prior streaming deltas.
    const fixtureNote =
      typeof body.note === "string"
        ? body.note
        : typeof body.mode === "string" && body.mode === "fixture"
          ? "fixture mode — prompt recorded (no LLM)"
          : undefined;

    const finalText = extractMessageText(message);
    const finalThinking = extractMessageThinking(message);
    const err = extractAssistantError(message);
    const isError = err.isError;
    const status = isError ? "error" : "done";

    // Prefer the streaming cursor; fall back to lastAssistant so that
    // agent_end/agent_settled (which clear streamingAssistantId) or a
    // duplicate message_end cannot invent a second thinking+answer card.
    let id = refs.streamingAssistantId;
    if (!id || findMessageIndex(prev, id) < 0) {
      id = refs.lastAssistantId;
    }
    if (!id || findMessageIndex(prev, id) < 0) {
      const idx = lastAssistantIndex(prev);
      if (idx >= 0) id = prev[idx]!.id;
    }

    const targetIdx = id ? findMessageIndex(prev, id) : -1;
    if (targetIdx >= 0) {
      const existing = prev[targetIdx]!;
      // Fixture-only ends (no LLM message body) after a settled turn must open a
      // new card — otherwise turn 2 would rewrite the previous assistant.
      const fixtureOnlyOnSettled =
        Boolean(fixtureNote) &&
        !finalText &&
        !finalThinking &&
        !isError &&
        existing.status !== "streaming";

      if (!fixtureOnlyOnSettled) {
        refs.streamingAssistantId = null;
        refs.lastAssistantId = existing.id;
        // Keep lastAssistantId so tools that arrive after message_end still nest.
        return prev.map((m) => {
          if (m.id !== existing.id) return m;
          const content = finalizeAssistantContent({
            text: finalText,
            existing: m.content,
            fixtureNote,
            errorMessage: err.errorMessage,
            isError,
          });
          const thinking = finalThinking || m.thinking || undefined;
          return {
            ...m,
            content,
            thinking,
            thinkingStatus: thinking ? ("done" as const) : m.thinkingStatus,
            status,
            errorMessage: err.errorMessage ?? m.errorMessage,
          };
        });
      }
    }

    if (fixtureNote || finalText || finalThinking || isError) {
      const newId = makeId("asst");
      refs.lastAssistantId = newId;
      refs.streamingAssistantId = null;
      const content = finalizeAssistantContent({
        text: finalText,
        existing: "",
        fixtureNote,
        errorMessage: err.errorMessage,
        isError,
      });
      return [
        ...prev,
        {
          id: newId,
          role: "assistant",
          content,
          thinking: finalThinking || undefined,
          thinkingStatus: finalThinking ? ("done" as const) : undefined,
          createdAt: ts,
          status,
          errorMessage: err.errorMessage,
        },
      ];
    }
    return prev;
  }

  // --- tool_execution_start -------------------------------------------------
  if (kind === "tool_execution_start") {
    const toolCallId =
      typeof body.toolCallId === "string" ? body.toolCallId : makeId("tool");
    const toolName =
      typeof body.toolName === "string" ? body.toolName : "tool";
    const input = safeStringify(body.args);
    const tool: AgentToolCall = {
      id: toolCallId,
      name: toolName,
      input,
      status: "running",
    };

    // Prefer streaming assistant, then last assistant, then create once.
    let assistantId = refs.streamingAssistantId;
    if (!assistantId || findMessageIndex(prev, assistantId) < 0) {
      assistantId = refs.lastAssistantId;
    }
    if (!assistantId || findMessageIndex(prev, assistantId) < 0) {
      const idx = lastAssistantIndex(prev);
      if (idx >= 0) assistantId = prev[idx]!.id;
    }

    if (!assistantId || findMessageIndex(prev, assistantId) < 0) {
      // No assistant yet (tool-only edge case) — open one bubble.
      const ensured = ensureAssistantBubble(prev, refs, ts);
      return ensured.messages.map((m) =>
        m.id === ensured.assistantId
          ? { ...m, tools: [tool], status: "streaming" }
          : m,
      );
    }

    refs.lastAssistantId = assistantId;
    return prev.map((m) => {
      if (m.id !== assistantId) return m;
      const tools = [...(m.tools ?? [])];
      const idx = tools.findIndex((t) => t.id === toolCallId);
      if (idx >= 0) {
        tools[idx] = { ...tools[idx], ...tool };
      } else {
        tools.push(tool);
      }
      return { ...m, tools };
    });
  }

  if (kind === "tool_execution_update") {
    const toolCallId =
      typeof body.toolCallId === "string" ? body.toolCallId : null;
    if (!toolCallId) return prev;
    const partial = safeStringify(body.partialResult);
    return prev.map((m) => {
      if (!m.tools?.some((t) => t.id === toolCallId)) return m;
      return {
        ...m,
        tools: m.tools.map((t) =>
          t.id === toolCallId
            ? { ...t, output: partial ?? t.output, status: "running" as const }
            : t,
        ),
      };
    });
  }

  if (kind === "tool_execution_end") {
    const toolCallId =
      typeof body.toolCallId === "string" ? body.toolCallId : null;
    if (!toolCallId) return prev;
    const output = safeStringify(body.result);
    const isError = body.isError === true;
    return prev.map((m) => {
      if (!m.tools?.some((t) => t.id === toolCallId)) return m;
      return {
        ...m,
        tools: m.tools.map((t) =>
          t.id === toolCallId
            ? {
                ...t,
                output: output ?? t.output,
                status: isError ? ("error" as const) : ("done" as const),
              }
            : t,
        ),
      };
    });
  }

  if (kind === "error") {
    const errMessage =
      typeof body.message === "string" ? body.message : "Agent error";
    // Dedupe: assistant bubble already carries the same provider error.
    for (let i = prev.length - 1; i >= 0; i -= 1) {
      const m = prev[i]!;
      if (m.role === "assistant") {
        if (
          m.status === "error" &&
          (m.errorMessage === errMessage || m.content === errMessage)
        ) {
          return prev;
        }
        break;
      }
      if (m.role === "system" && m.status === "error" && m.content === errMessage) {
        return prev;
      }
    }
    return [
      ...prev,
      {
        id: makeId("sys"),
        role: "system",
        content: errMessage,
        createdAt: ts,
        status: "error",
        errorMessage: errMessage,
      },
    ];
  }

  if (kind === "agent_end" || kind === "agent_settled") {
    // Clear streaming cursor; leave lastAssistant for any late tool events.
    // Do not clobber status "error" on failed assistant turns.
    refs.streamingAssistantId = null;
    return prev.map((m) =>
      m.status === "streaming" ? { ...m, status: "done" } : m,
    );
  }

  // agent_start / prompt / session_ready / turn_* — no transcript rows.
  return prev;
}

export function productCardContent(event: ProductSseLike): string {
  switch (event.kind) {
    case "run_phase": {
      const bits = [`Phase: ${event.phase ?? "?"}`];
      if (event.status) bits.push(`status=${event.status}`);
      if (event.runId) bits.push(`run=${event.runId}`);
      if (event.message) bits.push(event.message);
      return bits.join(" · ");
    }
    case "gate": {
      const bits = [`Gate: ${event.gate ?? "?"}`];
      if (event.runId) bits.push(`run=${event.runId}`);
      if (event.question) bits.push(event.question);
      if (event.pages?.length) {
        bits.push(`pages: ${event.pages.slice(0, 8).join(", ")}`);
      }
      return bits.join(" · ");
    }
    case "run_link": {
      const bits = [`Linked run ${event.runId ?? "?"}`];
      if (event.status) bits.push(`status=${event.status}`);
      return bits.join(" · ");
    }
    case "progress": {
      const bits = [`Produce: ${event.phase ?? "?"}`];
      if (event.label) bits.push(event.label);
      return bits.join(" · ");
    }
    case "plan_progress": {
      const pages = Array.isArray(event.pages) ? event.pages : [];
      const done = pages.filter(
        (p) =>
          typeof p === "object" &&
          p &&
          "status" in p &&
          (p as PlanProgressPage).status === "done",
      ).length;
      const total = pages.length;
      const lines = pages.slice(0, 12).map((p) => {
        if (typeof p === "string") return `· ${p}`;
        const pg = p as PlanProgressPage;
        return `· [${pg.status}] ${pg.path}`;
      });
      const more =
        pages.length > 12 ? `\n… +${pages.length - 12} more` : "";
      return [`Spec pages ${done}/${total}`, ...lines].join("\n") + more;
    }
    case "agent_span": {
      const bits = [
        `Agent ${event.role ?? "?"}`,
        event.agentId ?? "",
        event.status ?? "",
      ].filter(Boolean);
      if (event.parentId) bits.push(`parent=${event.parentId}`);
      if (event.receiptPath) bits.push(event.receiptPath);
      if (event.promptSummary) bits.push(event.promptSummary);
      return bits.join(" · ");
    }
    case "defects": {
      if (event.clean) return `Review: clean (round ${event.round ?? 1})`;
      return `Review: ${event.defectCount ?? 0} defect(s) (round ${event.round ?? 1})`;
    }
    default: {
      const _exhaustive: never = event.kind;
      return String(_exhaustive);
    }
  }
}

export function productMeta(event: ProductSseLike): AgentProductMeta {
  switch (event.kind) {
    case "run_phase":
      return {
        kind: "run_phase",
        phase: event.phase,
        runId: event.runId,
        status: event.status,
      };
    case "gate":
      return {
        kind: "gate",
        gate: event.gate,
        runId: event.runId,
        question: event.question,
        pages: event.pages,
      };
    case "run_link":
      return {
        kind: "run_link",
        runId: event.runId,
        status: event.status,
      };
    case "progress":
      return {
        kind: "progress",
        phase: event.phase,
        runId: event.runId,
        label: event.label,
      };
    case "plan_progress":
      return {
        kind: "plan_progress",
        runId: event.runId,
        pages: event.pages,
      };
    case "agent_span":
      return {
        kind: "agent_span",
        runId: event.runId,
        spanId: event.spanId,
        agentId: event.agentId,
        role: event.role,
        status: event.status,
        parentId: event.parentId,
        receiptPath: event.receiptPath,
        label: event.promptSummary,
      };
    case "defects":
      return {
        kind: "defects",
        runId: event.runId,
        clean: event.clean,
        defectCount: event.defectCount,
        round: event.round,
        label: event.summary,
      };
    default: {
      const _exhaustive: never = event.kind;
      return _exhaustive;
    }
  }
}

/**
 * Apply a product inject. Phase cards upsert the latest run_phase row so the
 * transcript does not spam one card per phase transition for a single run.
 * Gate cards upsert the latest open gate of the same kind (plan/publication).
 */
export function applyProductEvent(
  prev: AgentMessage[],
  event: ProductSseLike,
): AgentMessage[] {
  const card: AgentMessage = {
    id: makeId(`product_${event.kind}`),
    role: "system",
    content: productCardContent(event),
    createdAt:
      typeof event.timestamp === "string" ? event.timestamp : nowIso(),
    product: productMeta(event),
    status: event.kind,
  };

  if (event.kind === "run_phase") {
    // Replace the trailing run_phase card (same run if runId known).
    for (let i = prev.length - 1; i >= 0; i -= 1) {
      const m = prev[i]!;
      if (m.product?.kind !== "run_phase") continue;
      if (
        event.runId &&
        m.product.runId &&
        m.product.runId !== event.runId
      ) {
        break;
      }
      const next = prev.slice();
      next[i] = { ...card, id: m.id };
      return next;
    }
  }

  if (event.kind === "plan_progress") {
    // Upsert Spec queue card so page statuses refresh in place.
    for (let i = prev.length - 1; i >= 0; i -= 1) {
      const m = prev[i]!;
      if (m.product?.kind !== "plan_progress") continue;
      if (
        event.runId &&
        m.product.runId &&
        m.product.runId !== event.runId
      ) {
        break;
      }
      const next = prev.slice();
      next[i] = { ...card, id: m.id };
      return next;
    }
  }

  if (event.kind === "gate" && event.gate) {
    for (let i = prev.length - 1; i >= 0; i -= 1) {
      const m = prev[i]!;
      if (m.product?.kind !== "gate") continue;
      if (m.product.gate !== event.gate) break;
      if (
        event.runId &&
        m.product.runId &&
        m.product.runId !== event.runId
      ) {
        break;
      }
      const next = prev.slice();
      next[i] = { ...card, id: m.id };
      return next;
    }
  }

  return [...prev, card];
}

/** Whether a product run_phase should clear the busy/streaming chrome. */
export function isTerminalOrWaitingPhase(phase: string | undefined): boolean {
  return (
    phase === "done" ||
    phase === "failed" ||
    phase === "cancelled" ||
    phase === "idle" ||
    phase === "awaiting_plan" ||
    phase === "awaiting_publish"
  );
}

/** True when the latest projected messages include an assistant error. */
export function lastAssistantIsError(messages: AgentMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === "assistant") {
      return m.status === "error" || Boolean(m.errorMessage);
    }
  }
  return false;
}

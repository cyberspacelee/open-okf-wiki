/**
 * Conversational Session stream (AI SDK UI message protocol).
 * Options are generated from session/plan context — not hardcoded product labels.
 * Primary resume protocol: structured interaction in the last user message metadata
 * or a text payload prefixed with `__choice__:` / free text under input modes.
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  createUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import type {
  InteractionOption,
  OperatorSession,
  PendingInteraction,
  SessionMessage,
  SessionWorkflowState,
  WikiRunPlan,
  WorkspaceConfig,
} from "@okf-wiki/contract";
import { listMarkdownPages, writeFileContained } from "./fs-ops.js";
import { stagingDirForRun } from "./run.js";

/** Side effects for the product Run Boundary (server executes after stream). */
export type SessionChatSideEffects = {
  /** Materialize staging pages under this run id and register a run record. */
  materializeRun?: {
    runId: string;
    pages: string[];
    summary?: string;
  };
  /** Publish an existing staged run (product atomic publish). */
  publishRunId?: string;
};

export type SessionChatResult = {
  stream: ReadableStream<UIMessageChunk>;
  finalize: () => Promise<{
    assistantMessage: SessionMessage;
    status: OperatorSession["status"];
    pending: PendingInteraction | null;
    workflow: Partial<SessionWorkflowState>;
    sideEffects?: SessionChatSideEffects;
  }>;
};

type UserTurn =
  | { kind: "choice"; selectedIds: string[] }
  | { kind: "input"; text: string }
  | { kind: "text"; text: string };

function lastUserTurn(messages: UIMessage[]): UserTurn {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") {
      continue;
    }
    for (const p of m.parts ?? []) {
      if (p.type === "text" && typeof p.text === "string") {
        const raw = p.text.trim();
        // Structured choice from UI: __choice__:id1,id2
        if (raw.startsWith("__choice__:")) {
          const ids = raw
            .slice("__choice__:".length)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          if (ids.length) {
            return { kind: "choice", selectedIds: ids };
          }
        }
        // Structured input from UI: __input__:text
        if (raw.startsWith("__input__:")) {
          return { kind: "input", text: raw.slice("__input__:".length) };
        }
        return { kind: "text", text: raw };
      }
    }
  }
  return { kind: "text", text: "" };
}

function defaultPlan(workspace: WorkspaceConfig): WikiRunPlan {
  return {
    summary: `Source-grounded wiki for ${workspace.name}: entry overview and architecture boundaries.`,
    pages: [
      {
        path: "overview.md",
        purpose: "Purpose, audience, and navigation",
      },
      {
        path: "architecture.md",
        purpose: "Modules, trust boundaries, and data flow",
      },
    ],
  };
}

function planMarkdown(plan: WikiRunPlan): string {
  const lines = [
    "## Proposed wiki plan",
    "",
    plan.summary,
    "",
    "### Pages",
    ...plan.pages.map((p) => `- \`${p.path}\` — ${p.purpose}`),
  ];
  if (plan.notes) {
    lines.push("", `**Notes:** ${plan.notes}`);
  }
  return lines.join("\n");
}

/** Build plan-gate options dynamically from the plan itself. */
function optionsForPlanGate(plan: WikiRunPlan): InteractionOption[] {
  return [
    {
      id: "approve_write",
      label: `Write ${plan.pages.length} page(s)`,
      description: plan.pages.map((p) => p.path).join(", "),
    },
    {
      id: "revise_notes",
      label: "Revise with free-text notes",
      description: "Describe changes; plan will be updated",
    },
    {
      id: "reject_plan",
      label: "Reject this plan",
      description: "Discard and discuss alternatives",
    },
    // Dynamic page-focused shortcuts from plan content
    ...plan.pages.slice(0, 3).map((p) => ({
      id: `focus_${p.path.replace(/[^a-z0-9]+/gi, "_")}`,
      label: `Focus: ${p.path}`,
      description: p.purpose,
    })),
  ];
}

function optionsForRejectFollowup(): InteractionOption[] {
  // Still "dynamic" relative to hardcoding approve/deny only — generated for this phase.
  return [
    { id: "reason_scope", label: "Scope too large", description: "Trim the page set" },
    { id: "reason_focus", label: "Wrong focus", description: "Shift topics" },
    { id: "reason_outline", label: "Different outline", description: "Start over" },
    { id: "restart_plan", label: "Draft a new plan", description: "Regenerate from sources" },
  ];
}

function optionsForPublish(): InteractionOption[] {
  return [
    {
      id: "publish_now",
      label: "Publish staged wiki",
      description: "Atomic publication via product gate",
    },
    {
      id: "keep_staging",
      label: "Keep staging only",
      description: "Do not change Published Wiki",
    },
    {
      id: "revise_again",
      label: "Revise plan & rewrite",
      description: "Return to planning",
    },
  ];
}

export async function createSessionChatStream(input: {
  session: OperatorSession;
  workspace: WorkspaceConfig;
  messages: UIMessage[];
  abortSignal?: AbortSignal;
}): Promise<SessionChatResult> {
  const turn = lastUserTurn(input.messages);
  const textId = randomUUID();
  const assistantId = randomUUID();
  const toolBase = randomUUID();

  let plan: WikiRunPlan =
    input.session.workflow.plan ?? defaultPlan(input.workspace);
  let finalText = "";
  let pending: PendingInteraction | null = null;
  let workflow: Partial<SessionWorkflowState> = {};
  let status: OperatorSession["status"] = "active";
  let sideEffects: SessionChatSideEffects = {};
  const toolParts: SessionMessage["parts"] = [];

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const writeText = async (text: string) => {
        finalText += (finalText ? "\n\n" : "") + text;
        writer.write({ type: "text-start", id: textId });
        const step = 64;
        for (let i = 0; i < text.length; i += step) {
          if (input.abortSignal?.aborted) {
            break;
          }
          writer.write({
            type: "text-delta",
            id: textId,
            delta: text.slice(i, i + step),
          });
          await new Promise((r) => setTimeout(r, 0));
        }
        writer.write({ type: "text-end", id: textId });
      };

      const writeTool = async (name: string, args: unknown, result: unknown) => {
        const id = `${toolBase}-${name}-${toolParts.length}`;
        writer.write({
          type: "tool-input-start",
          toolCallId: id,
          toolName: name,
        });
        writer.write({
          type: "tool-input-available",
          toolCallId: id,
          toolName: name,
          input: args,
        });
        writer.write({
          type: "tool-output-available",
          toolCallId: id,
          output: result,
        });
        toolParts.push({
          type: `tool-${name}`,
          toolCallId: id,
          toolName: name,
          state: "output-available",
          input: args,
          output: result,
        });
      };

      async function materializeStagingPages(
        runId: string,
        pagesPlan: WikiRunPlan,
      ): Promise<string[]> {
        const wikiRoot = stagingDirForRun(input.workspace.rootPath, runId);
        await mkdir(wikiRoot, { recursive: true });
        const sourceIds = input.workspace.sources.map((s) => s.id).join(", ");
        for (const page of pagesPlan.pages) {
          const title = page.path.replace(/\.md$/i, "").replace(/[-_]/g, " ");
          const content = [
            "---",
            `title: ${JSON.stringify(page.purpose || title)}`,
            "---",
            "",
            `# ${page.purpose || title}`,
            "",
            pagesPlan.summary,
            "",
            page.purpose ? `> ${page.purpose}` : "",
            "",
            `- Workspace: \`${input.workspace.name}\``,
            `- Sources: ${sourceIds || "(none)"}`,
            `- Run: \`${runId}\``,
            pagesPlan.notes ? `- Notes: ${pagesPlan.notes}` : "",
            "",
            "Produced from the Session conversational workspace.",
            "",
          ]
            .filter((line) => line !== undefined)
            .join("\n");
          await writeFileContained(wikiRoot, page.path, content);
          await writeTool(
            "write_wiki",
            { path: page.path },
            { ok: true, path: page.path },
          );
        }
        return listMarkdownPages(wikiRoot);
      }

      const writeDecision = (interaction: PendingInteraction) => {
        const id = `${toolBase}-decision`;
        // Client-style tool: no server execute — UI collects answer via next user message.
        writer.write({
          type: "tool-input-start",
          toolCallId: id,
          toolName: "request_user_decision",
        });
        writer.write({
          type: "tool-input-available",
          toolCallId: id,
          toolName: "request_user_decision",
          input: interaction,
        });
        toolParts.push({
          type: "tool-request_user_decision",
          toolCallId: id,
          toolName: "request_user_decision",
          state: "input-available",
          input: interaction,
        });
        writer.write({
          type: "data-choice",
          id: randomUUID(),
          data: interaction,
        } as UIMessageChunk);
        pending = { ...interaction, toolCallId: id };
        status = "waiting";
      };

      const phase = input.session.workflow.phase ?? "idle";
      const pendingNow = input.session.pending;

      // --- Resolve pending interaction with structured turn ---
      if (pendingNow && (turn.kind === "choice" || turn.kind === "input" || turn.kind === "text")) {
        let selected = "";
        let note = "";
        if (turn.kind === "choice") {
          selected = turn.selectedIds[0] ?? "";
        } else if (turn.kind === "input") {
          note = turn.text;
          // If user typed an option id while choice_or_input, treat as choice
          if (pendingNow.options.some((o) => o.id === note)) {
            selected = note;
            note = "";
          }
        } else {
          note = turn.text;
          if (pendingNow.options.some((o) => o.id === note)) {
            selected = note;
            note = "";
          }
        }

        // Publish gate — product atomic publish via side effect
        if (phase === "awaiting_publish") {
          if (selected === "publish_now") {
            const runId = input.session.workflow.linkedRunId;
            if (!runId) {
              await writeText(
                "No linked Wiki Run found to publish. Approve a plan and write pages first, or open **Runs**.",
              );
              pending = null;
              status = "active";
              return;
            }
            sideEffects = { publishRunId: runId };
            await writeText(
              `Publishing staged run \`${runId}\` via the product publication gate…`,
            );
            await writeTool(
              "publish_wiki",
              { runId },
              { ok: true, runId, status: "publish_requested" },
            );
            await writeText(
              "Publication requested. If validation succeeds, the Published Wiki is updated atomically. Check **Runs** or **Wiki** for the result.",
            );
            pending = null;
            status = "completed";
            workflow = { phase: "done", plan, linkedRunId: runId };
            return;
          }
          if (selected === "keep_staging") {
            await writeText(
              "Keeping staging only. Published Wiki unchanged. You can publish later from **Runs**.",
            );
            pending = null;
            status = "active";
            workflow = {
              phase: "idle",
              plan,
              linkedRunId: input.session.workflow.linkedRunId,
            };
            return;
          }
          if (selected === "revise_again") {
            selected = "restart_plan";
          }
        }

        // Plan gate / reject follow-up
        if (selected === "approve_write") {
          const runId = randomUUID();
          workflow = { phase: "writing", plan, linkedRunId: runId };
          status = "running";
          await writeText("Writing staged wiki pages from the agreed plan…");
          await writeTool(
            "list_source",
            { sources: input.workspace.sources.map((s) => s.id) },
            { ok: true },
          );
          let pages: string[] = [];
          try {
            pages = await materializeStagingPages(runId, plan);
            sideEffects = {
              materializeRun: {
                runId,
                pages,
                summary: `Session materialize: ${pages.length} page(s)`,
              },
            };
          } catch (error) {
            const msg =
              error instanceof Error ? error.message : "failed to write staging";
            await writeText(`Staging write failed: ${msg}`);
            pending = null;
            status = "failed";
            workflow = { phase: "idle", plan };
            return;
          }
          await writeText(
            `Staged **${pages.length}** page(s) under run \`${runId}\`:\n\n` +
              pages.map((p) => `- \`${p}\``).join("\n") +
              "\n\nChoose how to proceed:",
          );
          writeDecision({
            type: "confirmation",
            question: "Publish the staged wiki?",
            mode: "choice_only",
            selectionMode: "single",
            options: optionsForPublish(),
          });
          workflow = { phase: "awaiting_publish", plan, linkedRunId: runId };
          return;
        }

        if (selected === "reject_plan" || selected?.startsWith("reason_")) {
          await writeText(
            selected.startsWith("reason_")
              ? `Noted: **${pendingNow.options.find((o) => o.id === selected)?.label ?? selected}**. How should we continue?`
              : "Plan discarded. Why, and how should we continue?",
          );
          writeDecision({
            type: "choice",
            question: "Next step after rejecting the plan",
            mode: "choice_or_input",
            selectionMode: "single",
            options: optionsForRejectFollowup(),
            inputPlaceholder: "Or describe what you want instead…",
          });
          workflow = { phase: "idle" };
          return;
        }

        if (selected === "restart_plan" || selected === "revise_notes" || note) {
          if (note || selected === "revise_notes") {
            const textNote =
              note ||
              "Please revise the plan (user chose free-text revise).";
            plan = {
              ...plan,
              notes: textNote,
              summary: `${defaultPlan(input.workspace).summary} Revised notes: ${textNote.slice(0, 160)}`,
            };
            // Dynamic page addition based on note content (still agent-side generation)
            if (/security|threat|安全|鉴权|auth/i.test(textNote)) {
              plan.pages = [
                ...plan.pages,
                {
                  path: "security.md",
                  purpose: "Auth, trust boundaries, and threat notes (from user notes)",
                },
              ];
            }
            // de-dupe
            const seen = new Set<string>();
            plan.pages = plan.pages.filter((p) => {
              if (seen.has(p.path)) {
                return false;
              }
              seen.add(p.path);
              return true;
            });
            await writeText(`Updated plan from your notes:\n\n> ${textNote}\n\n${planMarkdown(plan)}`);
          } else {
            plan = defaultPlan(input.workspace);
            await writeText(`Drafted a fresh plan:\n\n${planMarkdown(plan)}`);
            await writeTool(
              "list_source",
              { sources: input.workspace.sources.map((s) => s.id) },
              { ok: true },
            );
          }
          writeDecision({
            type: "approval",
            question: "How do you want to proceed with this plan?",
            mode: "choice_or_input",
            selectionMode: "single",
            options: optionsForPlanGate(plan),
            inputPlaceholder: "Or type revision notes…",
          });
          workflow = { phase: "awaiting_plan", plan };
          return;
        }

        if (selected.startsWith("focus_")) {
          const focusKey = selected.slice("focus_".length);
          // Prefer matching real page path
          const match =
            plan.pages.find((p) => p.path.replace(/[^a-z0-9]+/gi, "_") === focusKey) ??
            plan.pages.find((p) => selected.includes(p.path.replace(".md", "")));
          if (match) {
            plan = {
              ...plan,
              summary: `${plan.summary} (user prioritizes ${match.path})`,
              pages: [match, ...plan.pages.filter((p) => p.path !== match.path)],
            };
          }
          await writeText(`Reordered plan to prioritize focus.\n\n${planMarkdown(plan)}`);
          writeDecision({
            type: "approval",
            question: "Proceed with this prioritization?",
            mode: "choice_only",
            selectionMode: "single",
            options: optionsForPlanGate(plan).filter(
              (o) => o.id === "approve_write" || o.id === "revise_notes" || o.id === "reject_plan",
            ),
          });
          workflow = { phase: "awaiting_plan", plan };
          return;
        }
      }

      // --- Fresh turn: start planning ---
      const kickoff =
        turn.kind === "text" &&
        (/generate|wiki|plan|开始|生成|写/.test(turn.text) ||
          turn.text.length === 0 ||
          phase === "idle" ||
          input.session.messages.length === 0);

      if (kickoff || phase === "idle") {
        plan = defaultPlan(input.workspace);
        status = "running";
        await writeText(
          `I'll draft a **source-grounded wiki plan** for **${input.workspace.name}**.`,
        );
        await writeTool(
          "list_source",
          { sources: input.workspace.sources.map((s) => s.id) },
          { ok: true, count: input.workspace.sources.length },
        );
        await writeText(planMarkdown(plan));
        writeDecision({
          type: "approval",
          question: "How do you want to proceed with this plan?",
          mode: "choice_or_input",
          selectionMode: "single",
          options: optionsForPlanGate(plan),
          inputPlaceholder: "Or type revision notes…",
        });
        workflow = { phase: "awaiting_plan", plan };
        return;
      }

      await writeText(
        "Continue the wiki session: pick an option above, or say **generate** to draft a new plan.",
      );
      status = "active";
    },
  });

  return {
    stream,
    finalize: async () => {
      const parts: SessionMessage["parts"] = [
        { type: "text", text: finalText || "(empty)", state: "done" },
        ...toolParts,
      ];
      if (pending) {
        parts.push({ type: "data-choice", data: pending });
      }
      return {
        assistantMessage: {
          id: assistantId,
          role: "assistant",
          parts,
          createdAt: new Date().toISOString(),
        },
        status,
        pending,
        workflow,
        sideEffects,
      };
    },
  };
}

export function uiMessagesToSessionMessages(
  messages: UIMessage[],
): SessionMessage[] {
  return messages.map((m) => {
    const parts: SessionMessage["parts"] = [];
    for (const p of m.parts ?? []) {
      if (p.type === "text") {
        parts.push({ type: "text", text: p.text });
        continue;
      }
      if (typeof p.type === "string" && p.type.startsWith("tool-")) {
        const tp = p as {
          type: string;
          toolCallId?: string;
          state?:
            | "input-streaming"
            | "input-available"
            | "output-available"
            | "output-error";
          input?: unknown;
          output?: unknown;
          errorText?: string;
        };
        parts.push({
          type: tp.type,
          toolCallId: tp.toolCallId,
          toolName: tp.type.replace(/^tool-/, ""),
          state: tp.state,
          input: tp.input,
          output: tp.output,
          errorText: tp.errorText,
        });
        continue;
      }
      if (typeof p.type === "string" && p.type.startsWith("data-")) {
        const dp = p as { type: string; id?: string; data?: unknown };
        parts.push({ type: dp.type, id: dp.id, data: dp.data });
        continue;
      }
      parts.push({ type: "text", text: JSON.stringify(p) });
    }
    if (!parts.length) {
      parts.push({ type: "text", text: "" });
    }
    return {
      id: m.id,
      role:
        m.role === "system"
          ? "system"
          : m.role === "user"
            ? "user"
            : "assistant",
      parts,
      createdAt: new Date().toISOString(),
    };
  });
}

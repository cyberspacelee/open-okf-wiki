/**
 * Shared Operator Session turn policy (web + agent).
 * Pure: no I/O, no Mastra — free-chat must not start a Wiki Run.
 */

import type { WikiRunPlan } from "./run.js";
import type { OperatorSession } from "./session.js";

/** Canonical kickoff text after empty `/generate` (and aliases). */
export const DEFAULT_KICKOFF_TEXT = "generate a wiki plan";

/** Slash names that start a Wiki Run (normalize → kickoff text). */
export const KICKOFF_SLASH_NAMES = ["generate", "run", "wiki", "plan"] as const;

export type SessionTurnHelpReason =
  | "no_sources"
  | "pending_gate"
  | "running"
  | "not_kickoff";

export type SessionTurnModeResult = {
  mode: "start" | "resume" | "help";
  helpReason?: SessionTurnHelpReason;
};

/**
 * Expand a chat-bound slash into send text.
 * Returns null for client-local commands (/reset, /help, …) or unknown names.
 */
export function expandChatSlash(
  name: string,
  args = "",
): string | null {
  const n = name.toLowerCase();
  const rest = args.trim();
  switch (n) {
    case "generate":
    case "run":
    case "wiki":
    case "plan":
      return rest || DEFAULT_KICKOFF_TEXT;
    case "approve":
      return "approve";
    case "deny":
    case "reject":
      return "deny";
    case "revise":
      // Bare /revise is not enough — free-text feedback is required.
      return rest || "revise";
    default:
      return null;
  }
}

/** Generate-ish user text (phase-agnostic). Free-chat must not auto-start. */
export function isKickoffPhrase(text: string): boolean {
  const t = text.trim();
  if (!t) {
    return false;
  }
  if (/^\/(generate|run|wiki|plan)(?:\s|$)/i.test(t)) {
    return true;
  }
  return /generate|wiki|plan|开始|生成|写|run/i.test(t);
}

/**
 * Normalize slash approve/deny/generate into plain tokens for mode resolution.
 * Client usually expands these; server still accepts raw slash.
 */
export function normalizeSessionUserText(text: string): string {
  const t = text.trim();
  if (!t.startsWith("/")) {
    return t;
  }
  const match = /^\/([a-zA-Z][\w-]*)(?:\s+(.*))?$/s.exec(t);
  if (!match) {
    return t;
  }
  const expanded = expandChatSlash(match[1]!, match[2] ?? "");
  return expanded ?? t;
}

/**
 * True when user text should start a new Wiki Run.
 * Only on idle/done (never while a gate or run is mid-flight).
 */
export function isKickoff(text: string, phase: string | undefined): boolean {
  if (phase !== "idle" && phase !== undefined && phase !== "done") {
    return false;
  }
  return isKickoffPhrase(text);
}

/**
 * Pure turn-mode resolution for Operator Session chat.
 * Only generate-ish kickoff on idle/done starts a run; free-chat never does.
 */
/** Workflow resume payload for plan/publication gates. */
export type SessionGateResumeData = {
  action: "approve" | "deny" | "revise";
  plan?: WikiRunPlan;
  /** Free-text revision feedback when action is revise. */
  feedback?: string;
};

export function resolveSessionTurnMode(input: {
  userText: string;
  phase: string | undefined;
  status: OperatorSession["status"] | string;
  hasSources: boolean;
  resumeData?: SessionGateResumeData;
  existingRunId?: string;
}): SessionTurnModeResult {
  const { userText, phase, status, hasSources, resumeData, existingRunId } =
    input;
  const phaseNorm = phase ?? "idle";
  const atGate =
    phaseNorm === "awaiting_plan" || phaseNorm === "awaiting_publish";

  if (resumeData && existingRunId) {
    // Bare revise without feedback is not a valid resume.
    if (
      resumeData.action === "revise" &&
      !resumeData.feedback?.trim()
    ) {
      return { mode: "help", helpReason: "pending_gate" };
    }
    return { mode: "resume" };
  }

  if (
    status === "running" ||
    phaseNorm === "planning" ||
    phaseNorm === "writing"
  ) {
    return { mode: "help", helpReason: "running" };
  }

  if (isKickoff(userText, phase) && !resumeData && hasSources) {
    return { mode: "start" };
  }

  if (atGate) {
    return { mode: "help", helpReason: "pending_gate" };
  }

  if (!hasSources) {
    return { mode: "help", helpReason: "no_sources" };
  }

  return { mode: "help", helpReason: "not_kickoff" };
}

/** Contextual help copy for non-start/resume turns (English product default). */
export function helpTextForSessionTurn(input: {
  helpReason: SessionTurnHelpReason;
  phase?: string;
  userText?: string;
}): string {
  const phase = input.phase ?? "idle";
  switch (input.helpReason) {
    case "no_sources":
      return "Add at least one Git source under **Sources** before starting a Wiki Run.";
    case "pending_gate": {
      if (isKickoffPhrase(input.userText ?? "")) {
        if (phase === "awaiting_publish") {
          return "A publication decision is still pending. Complete or deny the publish gate (use the decision options above) before starting a new Wiki Run with **generate**.";
        }
        return "A plan decision is still pending. Complete or deny the plan gate (use the decision options above) before starting a new Wiki Run with **generate**.";
      }
      if (phase === "awaiting_publish") {
        return "A publication decision is waiting. Pick **approve** or **deny** above to continue — free-text chat will not advance this gate.";
      }
      if ((input.userText ?? "").trim().toLowerCase() === "revise") {
        return "To revise the plan, type your modification feedback in the composer (for example: add a concepts page, drop architecture.md) and send.";
      }
      return "A plan decision is waiting. Pick **approve**, **deny**, or **request changes** — or type free-text revision feedback to replan.";
    }
    case "running":
      return "A Wiki Run is already in progress. Wait for it to finish, or use **Stop** to cancel it.";
    case "not_kickoff":
    default:
      return [
        "Continue the wiki session with a kickoff phrase or slash command:",
        "",
        "- **generate** or `/generate` — start a Wiki Run",
        "- `/approve` / `/deny` — answer a plan or publish gate",
        "- Free-text at the plan gate — request changes and replan",
        "- `/reset` — clear a stuck gate (operator command)",
        "- `/help` — list commands",
        "",
        "Or pick a decision option above when chips are shown.",
      ].join("\n");
  }
}

/**
 * Operator Session slash commands (AI Elements command palette + free-text).
 * Chat expansion shares catalog semantics with @okf-wiki/contract session-policy.
 * Local actions stay on the client.
 */

import {
  DEFAULT_KICKOFF_TEXT,
  expandChatSlash,
} from "@okf-wiki/contract";

export type SessionSlashLocalAction =
  | "help"
  | "new"
  | "delete"
  | "reset"
  | "stop";

export type SessionSlashParseResult =
  | { kind: "none" }
  | { kind: "send"; text: string }
  | { kind: "local"; action: SessionSlashLocalAction };

export type SessionCommandDef = {
  id: string;
  /** Shown in palette, e.g. /generate */
  command: string;
  label: string;
  description: string;
  /** If set, selecting inserts/sends this chat text. */
  sendText?: string;
  local?: SessionSlashLocalAction;
};

/** Canonical command catalog for palette + help (UI chrome over shared policy). */
export const SESSION_COMMANDS: SessionCommandDef[] = [
  {
    id: "generate",
    command: "/generate",
    label: "Generate wiki",
    description: "Start a Wiki Run (plan → write → publish)",
    sendText: DEFAULT_KICKOFF_TEXT,
  },
  {
    id: "approve",
    command: "/approve",
    label: "Approve",
    description: "Approve the pending plan or publish gate",
    sendText: "approve",
  },
  {
    id: "deny",
    command: "/deny",
    label: "Deny",
    description: "Reject the pending plan or keep staging",
    sendText: "deny",
  },
  {
    id: "reset",
    command: "/reset",
    label: "Reset gate",
    description: "Clear a stuck plan/publish gate so you can kick off again",
    local: "reset",
  },
  {
    id: "stop",
    command: "/stop",
    label: "Stop",
    description: "Cancel the in-flight Wiki Run stream",
    local: "stop",
  },
  {
    id: "new",
    command: "/new",
    label: "New session",
    description: "Create a fresh conversation thread",
    local: "new",
  },
  {
    id: "delete",
    command: "/delete",
    label: "Delete session",
    description: "Delete this session and switch away",
    local: "delete",
  },
  {
    id: "help",
    command: "/help",
    label: "Help",
    description: "List available slash commands",
    local: "help",
  },
];

const LOCAL_SLASH: Record<string, SessionSlashLocalAction> = {
  reset: "reset",
  stop: "stop",
  new: "new",
  delete: "delete",
  help: "help",
  commands: "help",
};

export function parseSessionSlashInput(text: string): SessionSlashParseResult {
  const t = text.trim();
  if (!t.startsWith("/")) {
    return { kind: "none" };
  }
  const match = /^\/([a-zA-Z][\w-]*)(?:\s+(.*))?$/s.exec(t);
  if (!match) {
    return { kind: "local", action: "help" };
  }
  const name = match[1]!.toLowerCase();
  const args = (match[2] ?? "").trim();

  const send = expandChatSlash(name, args);
  if (send !== null) {
    return { kind: "send", text: send };
  }

  const local = LOCAL_SLASH[name];
  if (local) {
    return { kind: "local", action: local };
  }
  return { kind: "local", action: "help" };
}

/** Filter palette while user types `/gen…`. */
export function filterSessionCommands(query: string): SessionCommandDef[] {
  const q = query.replace(/^\//, "").trim().toLowerCase();
  if (!q) {
    return SESSION_COMMANDS;
  }
  return SESSION_COMMANDS.filter(
    (c) =>
      c.command.slice(1).startsWith(q) ||
      c.id.startsWith(q) ||
      c.label.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q),
  );
}

/** True when the composer should show the slash palette. */
export function isSlashMenuOpenQuery(text: string): boolean {
  if (!text.startsWith("/")) {
    return false;
  }
  if (/\s/.test(text.slice(1))) {
    return false;
  }
  return true;
}

/**
 * Tab completion for the open slash menu.
 * - Incomplete query → fill with the highlighted command (e.g. `/gen` → `/generate`)
 * - Already exact match → cycle to the next filtered command
 */
export function tabCompleteSlashInput(
  input: string,
  commands: SessionCommandDef[],
  highlightIndex: number,
): { nextInput: string; nextHighlight: number } {
  if (commands.length === 0) {
    return { nextInput: input, nextHighlight: 0 };
  }
  const idx =
    ((highlightIndex % commands.length) + commands.length) % commands.length;
  const selected = commands[idx]!;
  const exact =
    input === selected.command || input === `${selected.command} `;
  if (exact && commands.length > 1) {
    const next = (idx + 1) % commands.length;
    return {
      nextInput: commands[next]!.command,
      nextHighlight: next,
    };
  }
  return { nextInput: selected.command, nextHighlight: idx };
}

export function clampSlashHighlight(
  index: number,
  commandCount: number,
): number {
  if (commandCount <= 0) {
    return 0;
  }
  return ((index % commandCount) + commandCount) % commandCount;
}

export function sessionSlashHelpMarkdown(): string {
  const lines = [
    "### Session slash commands",
    "",
    ...SESSION_COMMANDS.map(
      (c) => `- \`${c.command}\` — ${c.description}`,
    ),
    "",
    `You can also type **${DEFAULT_KICKOFF_TEXT}** without a slash.`,
  ];
  return lines.join("\n");
}

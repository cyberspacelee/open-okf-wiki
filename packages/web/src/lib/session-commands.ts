/**
 * Operator Session slash commands (AI Elements command palette + free-text).
 * Local actions stay on the client; chat actions expand into sendTurn text.
 */

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

/** Canonical command catalog for palette + help. */
export const SESSION_COMMANDS: SessionCommandDef[] = [
  {
    id: "generate",
    command: "/generate",
    label: "Generate wiki",
    description: "Start a Wiki Run (plan → write → publish)",
    sendText: "generate a wiki plan",
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

  switch (name) {
    case "generate":
    case "run":
    case "wiki":
    case "plan":
      return {
        kind: "send",
        text: args || "generate a wiki plan",
      };
    case "approve":
      return { kind: "send", text: "approve" };
    case "deny":
    case "reject":
      return { kind: "send", text: "deny" };
    case "reset":
      return { kind: "local", action: "reset" };
    case "stop":
      return { kind: "local", action: "stop" };
    case "new":
      return { kind: "local", action: "new" };
    case "delete":
      return { kind: "local", action: "delete" };
    case "help":
    case "commands":
      return { kind: "local", action: "help" };
    default:
      return { kind: "local", action: "help" };
  }
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
  // Close once user typed a full command with trailing space + args, or multi-word.
  if (/\s/.test(text.slice(1))) {
    return false;
  }
  return true;
}

export function sessionSlashHelpMarkdown(): string {
  const lines = [
    "### Session slash commands",
    "",
    ...SESSION_COMMANDS.map(
      (c) => `- \`${c.command}\` — ${c.description}`,
    ),
    "",
    "You can also type **generate a wiki plan** without a slash.",
  ];
  return lines.join("\n");
}

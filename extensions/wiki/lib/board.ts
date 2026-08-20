import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeText } from "./files.js";

const WIKI_TASK_STATUSES = ["pending", "in_progress", "completed", "failed"] as const;

export type WikiTaskStatus = (typeof WIKI_TASK_STATUSES)[number];

export interface WikiTask {
  id: string;
  content: string;
  status: WikiTaskStatus;
  note?: string;
}

export interface WikiBoard {
  goal: string;
  tasks: WikiTask[];
}

export interface WikiBoardStore {
  path: string;
  read(): Promise<WikiBoard>;
  write(board: WikiBoard): Promise<WikiBoard>;
}

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_BOARD_RECOVERY_TOKENS = 1_500;

export function emptyBoard(goal = "Generate a complete repository Wiki"): WikiBoard {
  return { goal, tasks: [] };
}

export function createBoardStore(runDirectory: string, initial = emptyBoard()): WikiBoardStore {
  const file = path.join(runDirectory, "board.json");
  return {
    path: file,
    async read() {
      try {
        return parseBoard(JSON.parse(await readFile(file, "utf8")));
      } catch (error) {
        if (isMissing(error)) return structuredClone(initial);
        throw error;
      }
    },
    async write(board) {
      const next = parseBoard(board);
      await writeText(file, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    },
  };
}

export function parseBoard(value: unknown): WikiBoard {
  if (!isRecord(value)) throw new Error("Board must be an object");
  if (typeof value.goal !== "string" || !value.goal.trim()) throw new Error("Board goal must be a non-empty string");
  if (!Array.isArray(value.tasks)) throw new Error("Board tasks must be an array");
  const seen = new Set<string>();
  let inProgress = 0;
  const tasks = value.tasks.map((task, index) => {
    const parsed = parseTask(task, index);
    if (seen.has(parsed.id)) throw new Error(`Board task id is duplicated: ${parsed.id}`);
    seen.add(parsed.id);
    if (parsed.status === "in_progress") inProgress += 1;
    return parsed;
  });
  if (inProgress > 1) throw new Error("Board may have at most one in_progress task");
  const board = { goal: value.goal.trim(), tasks };
  if (estimateTokens(formatBoard(board)) > MAX_BOARD_RECOVERY_TOKENS) {
    throw new Error("Board exceeds the 1500-token recovery budget; split detail into handoffs and keep Tasks concise");
  }
  return board;
}

export function replaceBoard(current: WikiBoard, patch: { goal?: string; tasks?: readonly Partial<WikiTask>[] }): WikiBoard {
  const goal = patch.goal === undefined ? current.goal : patch.goal;
  if (patch.tasks === undefined) return parseBoard({ goal, tasks: current.tasks });
  const used = new Set<string>();
  const tasks = patch.tasks.map((task, index) => {
    const id = typeof task.id === "string" && task.id.trim() ? task.id.trim() : nextTaskId(used, index);
    used.add(id);
    return {
      id,
      content: task.content ?? "",
      status: task.status ?? "pending",
      ...(typeof task.note === "string" && task.note.trim() ? { note: task.note.trim() } : {}),
    };
  });
  return parseBoard({ goal, tasks });
}

export function formatBoard(board: WikiBoard): string {
  const lines = [`Goal: ${board.goal}`];
  if (board.tasks.length === 0) {
    lines.push("Tasks: none. Write the Board before surveying or writing pages.");
    return lines.join("\n");
  }
  const remaining = board.tasks.filter((task) => task.status === "pending" || task.status === "in_progress");
  const done = board.tasks.filter((task) => task.status === "completed").length;
  lines.push(`Tasks: ${done}/${board.tasks.length} completed; ${remaining.length} remaining.`);
  for (const task of board.tasks) {
    const note = task.note ? ` — ${task.note}` : "";
    lines.push(`- [${statusMark(task.status)}] ${task.id}: ${task.content}${note}`);
  }
  return lines.join("\n");
}

function parseTask(value: unknown, index: number): WikiTask {
  if (!isRecord(value)) throw new Error(`Board task ${index} must be an object`);
  if (typeof value.id !== "string" || !TASK_ID.test(value.id)) {
    throw new Error(`Board task ${index} needs a stable id`);
  }
  if (typeof value.content !== "string" || !value.content.trim()) {
    throw new Error(`Board task ${value.id} needs content`);
  }
  if (!isTaskStatus(value.status)) {
    throw new Error(`Board task ${value.id} has an invalid status`);
  }
  const note = typeof value.note === "string" && value.note.trim() ? value.note.trim() : undefined;
  return { id: value.id, content: value.content.trim(), status: value.status, ...(note ? { note } : {}) };
}

function nextTaskId(used: Set<string>, index: number): string {
  let n = index + 1;
  while (used.has(String(n))) n += 1;
  return String(n);
}

function statusMark(status: WikiTaskStatus): string {
  if (status === "completed") return "x";
  if (status === "in_progress") return ">";
  if (status === "failed") return "!";
  return " ";
}

function isTaskStatus(value: unknown): value is WikiTaskStatus {
  return typeof value === "string" && (WIKI_TASK_STATUSES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if (character.charCodeAt(0) < 128) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4) + nonAscii;
}

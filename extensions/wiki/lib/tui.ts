import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatToolCall, renderWikiLive, wikiFooterStatus } from "./cli.js";
import type { WikiAgentView, WikiRunHandle, WikiRunView, WikiToolView } from "./producer-types.js";

const PAGE = 10;
const NAV_WIDTH = 32;
const COLUMN_SEPARATOR = " │ ";
const WORKBENCH = 100;
const MAX_VIEWPORT_ROWS = 40;
const OVERLAY_HEIGHT_PERCENT = 88;

type ThemeColor = "text" | "dim" | "muted" | "accent" | "success" | "warning" | "error" | "border" | "borderMuted";
type ThemeLike = {
  fg?(color: ThemeColor, text: string): string;
  bg?(color: "selectedBg", text: string): string;
  bold?(text: string): string;
};
type OverlayTui = { requestRender(force?: boolean): void; terminal?: { rows?: number } };
type KeybindingsLike = { matches(data: string, keybinding: string): boolean };

interface OverlayState {
  kind: "run" | "agent";
  cursor: number;
  scrollTop: number;
  followTail: boolean;
}

export function wikiWidgetFactory(box: { view: WikiRunView; tui?: OverlayTui }) {
  return (tui: OverlayTui, theme: ThemeLike) => {
    box.tui = tui;
    return {
      invalidate() {},
      render(width: number) {
        return renderWikiLive(box.view).map((line) => truncateToWidth(paintLive(theme, line), Math.max(1, width)));
      },
      dispose() {
        if (box.tui === tui) box.tui = undefined;
      },
    };
  };
}

export function createLiveChrome(context: {
  hasUI: boolean;
  mode: string;
  ui: Pick<ExtensionUIContext, "setStatus" | "setWidget">;
}) {
  const box = {} as { view: WikiRunView; tui?: OverlayTui };
  let hung = false;
  return {
    set(view: WikiRunView) {
      if (!context.hasUI) return;
      context.ui.setStatus("wiki", wikiFooterStatus(view));
      if (view.status !== "running") {
        context.ui.setWidget("wiki", undefined);
        hung = false;
        return;
      }
      if (context.mode === "tui") {
        box.view = view;
        if (!hung) {
          hung = true;
          context.ui.setWidget("wiki", wikiWidgetFactory(box), { placement: "belowEditor" });
          return;
        }
        box.tui?.requestRender();
        return;
      }
      context.ui.setWidget("wiki", renderWikiLive(view), { placement: "belowEditor" });
    },
    clear() {
      if (!context.hasUI) return;
      context.ui.setStatus("wiki", undefined);
      context.ui.setWidget("wiki", undefined);
      hung = false;
    },
  };
}

export async function openWikiStatusOverlay(args: {
  ui: Pick<ExtensionUIContext, "custom" | "confirm">;
  handle: Pick<WikiRunHandle, "id" | "view" | "subscribe" | "control">;
}): Promise<void> {
  if (typeof args.ui.custom !== "function") return;
  await args.ui.custom(async (tui, theme, keybindings, done) => {
    return createWikiOverlay({
      tui,
      theme,
      keybindings,
      done: () => done(undefined),
      handle: args.handle,
      view: await args.handle.view(),
      confirmCancel: typeof args.ui.confirm === "function"
        ? async () => await args.ui.confirm("Cancel Wiki run", `Cancel ${args.handle.id}?`)
        : undefined,
    });
  }, {
    overlay: true,
    overlayOptions: {
      width: "92%",
      minWidth: 36,
      maxHeight: "88%",
      anchor: "center",
      margin: 1,
      visible: (width: number, height: number) => width >= 36 && height >= 10,
    },
  });
}

export function createWikiOverlay(args: {
  tui: OverlayTui;
  theme: ThemeLike;
  keybindings: KeybindingsLike;
  done(): void;
  handle: Pick<WikiRunHandle, "id" | "view" | "subscribe" | "control">;
  view: WikiRunView;
  confirmCancel?: () => Promise<boolean>;
  now?: () => number;
}) {
  let view = args.view;
  let state: OverlayState = { kind: "run", cursor: 0, scrollTop: 0, followTail: false };
  let closed = false;
  let busy: string | undefined;
  let warning: string | undefined;
  let cached: { width: number; viewport: number; lines: string[] } | undefined;
  let detailMaxScroll = 0;
  const clock = args.now ?? Date.now;
  let now = clock();
  const invalidate = () => { cached = undefined; };
  const selected = () => (view.agents ?? [])[state.cursor];

  const unsubscribe = args.handle.subscribe((next) => {
    if (closed) return;
    view = next;
    state = { ...state, cursor: clamp(state.cursor, 0, Math.max(0, (view.agents ?? []).length - 1)) };
    now = clock();
    invalidate();
    args.tui.requestRender();
  });
  const tick = setInterval(() => {
    if (closed) return;
    now = clock();
    invalidate();
    args.tui.requestRender();
  }, 2000);
  tick.unref?.();

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(tick);
    unsubscribe();
  };
  const finish = () => { cleanup(); args.done(); };

  const apply = (action: "up" | "down" | "pageUp" | "pageDown" | "forward" | "back" | "top" | "tail") => {
    const max = Math.max(0, (view.agents ?? []).length - 1);
    if (state.kind === "run") {
      if (action === "up") state = { ...state, cursor: clamp(state.cursor - 1, 0, max) };
      if (action === "down") state = { ...state, cursor: clamp(state.cursor + 1, 0, max) };
      if (action === "pageUp") state = { ...state, cursor: clamp(state.cursor - PAGE, 0, max) };
      if (action === "pageDown") state = { ...state, cursor: clamp(state.cursor + PAGE, 0, max) };
      if (action === "forward" && selected()) {
        state = { kind: "agent", cursor: state.cursor, scrollTop: 0, followTail: false };
      }
    } else {
      if (action === "up") {
        const from = state.followTail ? detailMaxScroll : state.scrollTop;
        state = { ...state, scrollTop: Math.max(0, from - 1), followTail: false };
      }
      if (action === "down" && !state.followTail) {
        state = { ...state, scrollTop: Math.min(detailMaxScroll, state.scrollTop + 1) };
      }
      if (action === "pageUp") {
        const from = state.followTail ? detailMaxScroll : state.scrollTop;
        state = { ...state, scrollTop: Math.max(0, from - PAGE), followTail: false };
      }
      if (action === "pageDown" && !state.followTail) {
        state = { ...state, scrollTop: Math.min(detailMaxScroll, state.scrollTop + PAGE) };
      }
      if (action === "top") state = { ...state, scrollTop: 0, followTail: false };
      if (action === "tail") state = { ...state, scrollTop: detailMaxScroll, followTail: true };
      if (action === "back") state = { kind: "run", cursor: state.cursor, scrollTop: 0, followTail: false };
    }
    invalidate();
    args.tui.requestRender();
  };

  const control = async (action: "pause" | "resume" | "cancel") => {
    if (busy || state.kind !== "run") return;
    if (action === "cancel" && args.confirmCancel && !await args.confirmCancel()) return;
    busy = action === "cancel" ? "Cancelling..." : action === "pause" ? "Pausing..." : "Resuming...";
    invalidate();
    args.tui.requestRender();
    try {
      view = await args.handle.control(action);
      warning = undefined;
      if (action === "cancel") finish();
    } catch (error) {
      warning = error instanceof Error ? error.message : String(error);
    } finally {
      busy = undefined;
      invalidate();
      args.tui.requestRender();
    }
  };

  return {
    invalidate,
    dispose: cleanup,
    handleInput(data: string) {
      if (closed) return;
      if (args.keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) return apply("up");
      if (args.keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) return apply("down");
      if (args.keybindings.matches(data, "tui.select.pageUp")) return apply("pageUp");
      if (args.keybindings.matches(data, "tui.select.pageDown")) return apply("pageDown");
      if (args.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.right) || matchesKey(data, Key.enter) || matchesKey(data, Key.return)) return apply("forward");
      if (args.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.left) || matchesKey(data, Key.escape)) {
        if (state.kind === "run") finish();
        else apply("back");
        return;
      }
      if (state.kind === "agent" && matchesKey(data, "t")) return apply("tail");
      if (state.kind === "agent" && matchesKey(data, "g")) return apply("top");
      if (state.kind === "run" && matchesKey(data, "p") && view.status === "running") void control("pause");
      if (state.kind === "run" && matchesKey(data, "r") && view.status === "paused") void control("resume");
      if (state.kind === "run" && matchesKey(data, "x") && (view.status === "running" || view.status === "paused")) {
        void control("cancel");
      }
    },
    render(width: number): string[] {
      const viewport = viewportRows(args.tui);
      if (cached?.width === width && cached.viewport === viewport) return cached.lines;
      const inner = Math.max(8, width);
      const bodyRows = Math.max(1, viewport - 2);
      const title = styledTitle(view, now, args.theme);
      const body = renderBody(state, view, selected(), inner - 3, bodyRows, args.theme, warning, busy);
      const footer = overlayFooter(state, view);
      detailMaxScroll = body.maxScroll;
      if (state.kind === "agent" && !state.followTail && state.scrollTop > detailMaxScroll) {
        state = { ...state, scrollTop: detailMaxScroll };
      }
      const lines = frame(inner, title, body.lines, footer, args.theme, bodyRows);
      cached = { width, viewport, lines };
      return lines;
    },
  };
}

function renderBody(
  state: OverlayState,
  view: WikiRunView,
  selected: WikiAgentView | undefined,
  width: number,
  rows: number,
  theme: ThemeLike,
  warning?: string,
  busy?: string,
): { lines: string[]; maxScroll: number } {
  const notice = busy ? paint(theme, "accent", `◆ ${busy}`) : warning ? paint(theme, "warning", `! ${warning}`) : "";
  const fixed = [summaryLine(view, theme), notice].filter(Boolean);
  const contentRows = Math.max(0, rows - fixed.length);
  const nav = navigationLines(view, state.cursor, theme);
  if (state.kind === "run" && width + 3 >= WORKBENCH) {
    const visibleNav = navigationWindow(nav, contentRows);
    const right = dashboardLines(view, selected, theme);
    return { lines: [...fixed, ...columns(visibleNav, right, width, contentRows, theme)], maxScroll: 0 };
  }
  if (state.kind === "run") {
    if (contentRows < 5) {
      return { lines: [...fixed, ...navigationWindow(nav, contentRows).map((line) => renderNavRow(line, width, theme))], maxScroll: 0 };
    }
    const board = boardLines(view, theme);
    const boardRows = Math.min(board.length, Math.max(1, Math.floor(contentRows / 3)));
    const navRows = Math.max(1, contentRows - boardRows - 1);
    const visibleNav = navigationWindow(nav, navRows).map((line) => renderNavRow(line, width, theme));
    return { lines: [...fixed, ...visibleNav, "", ...board.slice(0, boardRows)], maxScroll: 0 };
  }
  const process = processLines(selected, view, theme);
  const maxScroll = Math.max(0, process.length - contentRows);
  const start = state.followTail ? maxScroll : clamp(state.scrollTop, 0, maxScroll);
  return { lines: [...fixed, ...process.slice(start, start + contentRows)], maxScroll };
}

function navigationLines(view: WikiRunView, cursor: number, theme: ThemeLike): Array<{ text: string; selected: boolean }> {
  return (view.agents ?? []).map((agent, index) => {
    const selected = index === cursor;
    const current = agent.tools.find((tool) => tool.status === "running");
    const detail = current ? `  ${formatToolCall(current.tool, current.args)}` : agent.task ? `  ${agent.task}` : "";
    const text = `${marker(agent.status, theme)} ${strong(theme, agent.agent, selected ? "accent" : "text")}${detail ? paint(theme, "muted", detail) : ""}`;
    return { text, selected };
  });
}

function processLines(agent: WikiAgentView | undefined, view: WikiRunView, theme: ThemeLike): string[] {
  if (!agent) return [paint(theme, "dim", "No agent selected.")];
  const heading = `${strong(theme, "Process", "text")}  ${marker(agent.status, theme)} ${strong(theme, agent.agent, "accent")}${agent.task ? paint(theme, "muted", `  ${agent.task}`) : ""}${usageLabel(agent, theme)}`;
  if (agent.tools.length === 0) {
    return [heading, paint(theme, "dim", view.status === "running" ? "waiting for tools" : "no process tail")];
  }
  return [heading, ...agent.tools.map((tool) => toolLine(tool, theme))];
}

function dashboardLines(view: WikiRunView, selected: WikiAgentView | undefined, theme: ThemeLike): string[] {
  return [...boardLines(view, theme), "", ...processLines(selected, view, theme)];
}

function boardLines(view: WikiRunView, theme: ThemeLike): string[] {
  const tasks = view.tasks ?? [];
  if (tasks.length === 0) return [paint(theme, "dim", view.goal ?? "Board is empty.")];
  const done = tasks.filter((task) => task.status === "completed").length;
  return [
    `${strong(theme, "Board", "text")}  ${paint(theme, "muted", `${done}/${tasks.length}${view.goal ? `  ${view.goal}` : ""}`)}`,
    ...tasks.map((task) => `${taskMarker(task.status, theme)} ${task.id}  ${task.content}`),
  ];
}

function summaryLine(view: WikiRunView, theme: ThemeLike): string {
  const agents = view.agents ?? [];
  const active = agents.filter((agent) => agent.status === "running").length;
  const tasks = view.tasks ?? [];
  const done = tasks.filter((task) => task.status === "completed").length;
  const activity = active ? `${paint(theme, "accent", "◆")} ${active} active` : paint(theme, "dim", "idle");
  return `${strong(theme, "Agents", "text")}  ${agents.length}  ${activity}   ${strong(theme, "Board", "text")}  ${done}/${tasks.length}`;
}

function toolLine(tool: WikiToolView, theme: ThemeLike): string {
  return `  ${marker(tool.status, theme)} ${formatToolCall(tool.tool, tool.args)}`;
}

function overlayFooter(state: OverlayState, view: WikiRunView): string {
  if (state.kind === "agent") return "↑↓ scroll  PgUp/PgDn  g top  t tail  ← back";
  const control = view.status === "paused" ? "r resume  x cancel" : view.status === "running" ? "p pause  x cancel" : "";
  return ["↑↓ select", "→/Enter open", control, "Esc close"].filter(Boolean).join("   ");
}

function frame(
  width: number,
  title: string,
  body: string[],
  footer: string,
  theme: ThemeLike,
  bodyRows: number,
): string[] {
  const inner = Math.max(1, width - 2);
  const window = body.slice(0, bodyRows);
  while (window.length < bodyRows) window.push("");
  const border = (text: string) => paint(theme, "border", text);
  return [
    titleBorderLine(title, inner, border),
    ...window.map((line) => `${border("│")}${padLine(` ${line}`, inner)}${border("│")}`),
    `${border("╰")}${paint(theme, "borderMuted", padRule(footer, inner))}${border("╯")}`,
  ];
}

function columns(
  left: Array<{ text: string; selected: boolean }>,
  right: string[],
  width: number,
  rows: number,
  theme: ThemeLike,
): string[] {
  const rightWidth = Math.max(1, width - NAV_WIDTH - visibleWidth(COLUMN_SEPARATOR));
  const visibleRight = right.length > rows
    ? [...right.slice(0, Math.max(0, rows - 1)), paint(theme, "muted", "… Enter to inspect")]
    : right;
  const lines: string[] = [];
  for (let index = 0; index < rows; index += 1) {
    const nav = left[index];
    const leftText = renderNavRow(nav ?? { text: "", selected: false }, NAV_WIDTH, theme);
    const rightText = padLine(visibleRight[index] ?? "", rightWidth);
    lines.push(`${leftText}${paint(theme, "borderMuted", COLUMN_SEPARATOR)}${rightText}`);
  }
  return lines;
}

function renderNavRow(line: { text: string; selected: boolean }, width: number, theme: ThemeLike): string {
  const prefix = line.selected ? paint(theme, "accent", "> ") : "  ";
  const padded = padLine(`${prefix}${line.text}`, width);
  return line.selected ? background(theme, padded) : padded;
}

function navigationWindow(lines: Array<{ text: string; selected: boolean }>, rows: number): Array<{ text: string; selected: boolean }> {
  if (rows <= 0) return [];
  if (lines.length <= rows) return lines;
  const selected = lines.findIndex((line) => line.selected);
  const start = selected < 0 ? 0 : clamp(selected - rows + 1, 0, lines.length - rows);
  return lines.slice(start, start + rows);
}

function marker(status: WikiAgentView["status"] | WikiToolView["status"], theme: ThemeLike): string {
  if (status === "complete") return paint(theme, "success", "✓");
  if (status === "failed") return paint(theme, "error", "✗");
  return paint(theme, "accent", "◆");
}

function taskMarker(status: string, theme: ThemeLike): string {
  if (status === "completed") return paint(theme, "success", "✓");
  if (status === "failed") return paint(theme, "error", "✗");
  if (status === "in_progress") return paint(theme, "accent", ">");
  return paint(theme, "dim", "·");
}

function usageLabel(agent: WikiAgentView, theme: ThemeLike): string {
  if (!agent.usage) return "";
  const k = (value: number) => value >= 1000 ? `${Math.round(value / 100) / 10}k` : String(value);
  return paint(theme, "muted", `  ${k(agent.usage.input)} in  ${k(agent.usage.output)} out`);
}

function elapsed(view: WikiRunView, now: number): string {
  const started = Date.parse(view.createdAt);
  if (!Number.isFinite(started)) return "";
  const finished = Date.parse(view.updatedAt);
  const end = view.status === "running" || view.status === "paused" || !Number.isFinite(finished) ? now : finished;
  const seconds = Math.max(0, Math.floor((end - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  const label = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
  return `  [${label}]`;
}

function styledTitle(view: WikiRunView, now: number, theme: ThemeLike): string {
  const status = strong(theme, view.status, statusColor(view.status));
  return `Wiki ${view.id} | ${status}${view.focus ? ` | ${view.focus}` : ""}${elapsed(view, now)}`;
}

function statusColor(status: WikiRunView["status"]): ThemeColor {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "cancelled") return "error";
  if (status === "paused") return "warning";
  return "accent";
}

function padRule(label: string, inner: number): string {
  const clipped = truncateToWidth(label.trim() ? ` ${label.trim()} ` : "", inner, "…", true);
  return `${clipped}${"─".repeat(Math.max(0, inner - visibleWidth(clipped)))}`;
}

function titleBorderLine(title: string, inner: number, border: (text: string) => string): string {
  const clipped = truncateToWidth(title.trim(), Math.max(1, inner - 2), "…", true);
  const rule = "─".repeat(Math.max(0, inner - visibleWidth(clipped) - 2));
  return `${border("╭")}${border(" ")}${clipped}${border(" ")}${border(rule)}${border("╮")}`;
}

function viewportRows(tui: OverlayTui): number {
  const terminalRows = Math.max(1, Math.floor(tui.terminal?.rows ?? 24));
  return Math.max(1, Math.min(MAX_VIEWPORT_ROWS, Math.floor(terminalRows * OVERLAY_HEIGHT_PERCENT / 100), Math.max(1, terminalRows - 2)));
}

function padLine(value: string, width: number): string {
  const clipped = truncateToWidth(value, width, "…", true);
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function paint(theme: ThemeLike, color: ThemeColor, text: string): string {
  if (typeof theme.fg !== "function") return text;
  try { return String(theme.fg(color, text)); } catch { return text; }
}

function background(theme: ThemeLike, text: string): string {
  if (typeof theme.bg !== "function") return text;
  try { return String(theme.bg("selectedBg", text)); } catch { return text; }
}

function strong(theme: ThemeLike, text: string, color: ThemeColor): string {
  const painted = paint(theme, color, text);
  if (typeof theme.bold !== "function") return painted;
  try { return String(theme.bold(painted)); } catch { return painted; }
}

function paintLive(theme: ThemeLike, text: string): string {
  if (text.includes("✗")) return paint(theme, "error", text);
  if (text.includes("◆")) return paint(theme, "accent", text);
  if (text.includes("✓")) return paint(theme, "success", text);
  return paint(theme, "dim", text);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

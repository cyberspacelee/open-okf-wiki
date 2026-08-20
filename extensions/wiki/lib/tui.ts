import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatToolCall, renderWikiLive, wikiFooterStatus } from "./cli.js";
import type { WikiAgentView, WikiRunHandle, WikiRunView, WikiToolView } from "./producer-types.js";

const PAGE = 10;
const NAV_WIDTH = 28;
const COLUMN_SEPARATOR = " │ ";
const WORKBENCH = 100;
const TAIL = 0;
const TOP = Number.MAX_SAFE_INTEGER;

type ThemeColor = "text" | "dim" | "accent" | "success" | "warning" | "error" | "border";
type ThemeLike = {
  fg?(color: ThemeColor, text: string): string;
  bold?(text: string): string;
};
type OverlayTui = { requestRender(force?: boolean): void; terminal?: { rows?: number } };
type KeybindingsLike = { matches(data: string, keybinding: string): boolean };

interface OverlayState {
  kind: "run" | "agent";
  cursor: number;
  fromBottom: number;
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

export function wikiStatusLabel(view: WikiRunView): string {
  return wikiFooterStatus(view);
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
  let state: OverlayState = { kind: "run", cursor: 0, fromBottom: TOP };
  let closed = false;
  let busy: string | undefined;
  let warning: string | undefined;
  let cached: { width: number; viewport: number; lines: string[] } | undefined;
  const clock = args.now ?? Date.now;
  let now = clock();
  const invalidate = () => { cached = undefined; };
  const selected = () => agentsOf(view)[state.cursor];

  const unsubscribe = args.handle.subscribe((next) => {
    if (closed) return;
    view = next;
    state = { ...state, cursor: clamp(state.cursor, 0, Math.max(0, agentsOf(view).length - 1)) };
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

  const apply = (action: "up" | "down" | "pageUp" | "pageDown" | "forward" | "back" | "tail") => {
    const max = Math.max(0, agentsOf(view).length - 1);
    if (action === "tail") {
      state = { ...state, fromBottom: TAIL };
    } else if (state.kind === "run") {
      if (action === "up") state = { ...state, cursor: clamp(state.cursor - 1, 0, max) };
      if (action === "down") state = { ...state, cursor: clamp(state.cursor + 1, 0, max) };
      if (action === "pageUp") state = { ...state, cursor: clamp(state.cursor - PAGE, 0, max) };
      if (action === "pageDown") state = { ...state, cursor: clamp(state.cursor + PAGE, 0, max) };
      if (action === "forward" && selected()) state = { kind: "agent", cursor: state.cursor, fromBottom: TOP };
    } else {
      if (action === "up") state = { ...state, fromBottom: state.fromBottom + 1 };
      if (action === "down") state = { ...state, fromBottom: Math.max(TAIL, state.fromBottom - 1) };
      if (action === "pageUp") state = { ...state, fromBottom: state.fromBottom + PAGE };
      if (action === "pageDown") state = { ...state, fromBottom: Math.max(TAIL, state.fromBottom - PAGE) };
      if (action === "back") state = { kind: "run", cursor: state.cursor, fromBottom: TOP };
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
      if (matchesKey(data, "t")) return apply("tail");
      if (state.kind === "run" && matchesKey(data, "p") && (view.status === "running" || view.status === "paused")) {
        void control(view.status === "paused" ? "resume" : "pause");
      }
      if (state.kind === "run" && matchesKey(data, "x") && (view.status === "running" || view.status === "paused")) {
        void control("cancel");
      }
    },
    render(width: number): string[] {
      const viewport = Math.max(10, Math.min(args.tui.terminal?.rows ?? 24, 40));
      if (cached?.width === width && cached.viewport === viewport) return cached.lines;
      const inner = Math.max(8, width);
      const bodyRows = Math.max(4, viewport - 4);
      const title = `Wiki ${view.id} | ${view.status}${view.focus ? ` | ${view.focus}` : ""}${elapsed(view, now)}`;
      const body = renderBody(state, view, selected(), inner - 2, bodyRows, args.theme, warning, busy);
      const footer = overlayFooter(state, view);
      const framed = frame(inner, title, body.lines, footer, args.theme, bodyRows, state.fromBottom);
      if (state.fromBottom > framed.maxScroll) state = { ...state, fromBottom: framed.maxScroll };
      cached = { width, viewport, lines: framed.lines };
      return framed.lines;
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
): { lines: string[] } {
  const notice = busy ? paint(theme, "accent", busy) : warning ? paint(theme, "warning", warning) : "";
  const nav = navigationLines(view, state.cursor, theme);
  if (state.kind === "run" && width >= WORKBENCH) {
    const rightWidth = Math.max(1, width - NAV_WIDTH - visibleWidth(COLUMN_SEPARATOR));
    const right = selected ? processLines(selected, view, theme) : boardLines(view, theme);
    return { lines: [notice, ...columns(nav, right, width, rows - (notice ? 1 : 0), theme)].filter(Boolean) };
  }
  if (state.kind === "run") {
    return { lines: [notice, ...nav.map((line) => line.text), ...boardLines(view, theme)].filter(Boolean) };
  }
  return { lines: [notice, ...processLines(selected, view, theme)].filter(Boolean) };
}

function navigationLines(view: WikiRunView, cursor: number, theme: ThemeLike): Array<{ text: string; selected: boolean }> {
  return agentsOf(view).map((agent, index) => {
    const selected = index === cursor;
    const current = agent.tools.find((tool) => tool.status === "running");
    const detail = current ? `  ${formatToolCall(current.tool, current.args)}` : agent.task ? `  ${agent.task}` : "";
    const text = `${marker(agent.status, theme)} ${agent.agent}${detail}`;
    return { text: selected ? strong(theme, text, "accent") : text, selected };
  });
}

function processLines(agent: WikiAgentView | undefined, view: WikiRunView, theme: ThemeLike): string[] {
  if (!agent) return [paint(theme, "dim", "No agent selected.")];
  const heading = `${marker(agent.status, theme)} ${strong(theme, agent.agent, "accent")}${agent.task ? `  ${agent.task}` : ""}${usageLabel(agent)}`;
  if (agent.tools.length === 0) {
    return [heading, paint(theme, "dim", view.status === "running" ? "waiting for tools" : "no process tail")];
  }
  return [heading, ...agent.tools.map((tool) => toolLine(tool, theme))];
}

function boardLines(view: WikiRunView, theme: ThemeLike): string[] {
  const tasks = view.tasks ?? [];
  if (tasks.length === 0) return [paint(theme, "dim", view.goal ?? "Board is empty.")];
  const done = tasks.filter((task) => task.status === "completed").length;
  return [
    paint(theme, "dim", `Board  ${done}/${tasks.length}${view.goal ? `  ${view.goal}` : ""}`),
    ...tasks.map((task) => `${taskMarker(task.status, theme)} ${task.id}  ${task.content}`),
  ];
}

function toolLine(tool: WikiToolView, theme: ThemeLike): string {
  return `  ${marker(tool.status, theme)} ${formatToolCall(tool.tool, tool.args)}`;
}

function overlayFooter(state: OverlayState, view: WikiRunView): string {
  if (state.kind === "agent") return "t tail   esc back";
  const control = view.status === "paused" ? "p resume   x cancel" : view.status === "running" ? "p pause   x cancel" : "";
  return ["j/k move", "enter inspect", control, "esc close"].filter(Boolean).join("   ");
}

function frame(
  width: number,
  title: string,
  body: string[],
  footer: string,
  theme: ThemeLike,
  bodyRows: number,
  fromBottom: number,
): { lines: string[]; maxScroll: number } {
  const inner = Math.max(1, width - 2);
  const maxScroll = Math.max(0, body.length - bodyRows);
  const offset = Math.min(fromBottom, maxScroll);
  const start = Math.max(0, body.length - bodyRows - offset);
  const window = body.slice(start, start + bodyRows);
  while (window.length < bodyRows) window.push("");
  const top = `┌${padTitle(title, inner)}┐`;
  const bottom = `└${"─".repeat(inner)}┘`;
  const foot = `${paint(theme, "border", "│")}${truncateToWidth(` ${footer}`, inner)}${paint(theme, "border", "│")}`;
  const lines = [
    paint(theme, "border", top),
    ...window.map((line) => `${paint(theme, "border", "│")}${truncateToWidth(line.padEnd(inner), inner)}${paint(theme, "border", "│")}`),
    paint(theme, "border", `├${"─".repeat(inner)}┤`),
    foot,
    paint(theme, "border", bottom),
  ];
  return { lines, maxScroll };
}

function columns(
  left: Array<{ text: string; selected: boolean }>,
  right: string[],
  width: number,
  rows: number,
  theme: ThemeLike,
): string[] {
  const rightWidth = Math.max(1, width - NAV_WIDTH - visibleWidth(COLUMN_SEPARATOR));
  const lines: string[] = [];
  for (let index = 0; index < rows; index += 1) {
    const nav = left[index];
    const leftText = truncateToWidth(nav ? (nav.selected ? strong(theme, nav.text, "accent") : nav.text) : "", NAV_WIDTH, "…", true);
    const rightText = truncateToWidth(right[index] ?? "", rightWidth);
    lines.push(`${leftText}${paint(theme, "border", COLUMN_SEPARATOR)}${rightText}`);
  }
  return lines;
}

function agentsOf(view: WikiRunView): WikiAgentView[] {
  return view.agents ?? [];
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

function usageLabel(agent: WikiAgentView): string {
  if (!agent.usage) return "";
  const k = (value: number) => value >= 1000 ? `${Math.round(value / 100) / 10}k` : String(value);
  return `  ${k(agent.usage.input)} in  ${k(agent.usage.output)} out`;
}

function elapsed(view: WikiRunView, now: number): string {
  const started = Date.parse(view.createdAt);
  if (!Number.isFinite(started)) return "";
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  const label = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
  return `  [${label}]`;
}

function padTitle(title: string, inner: number): string {
  const text = ` ${truncateToWidth(title, inner - 2)} `;
  return `${text}${"─".repeat(Math.max(0, inner - visibleWidth(text)))}`;
}

function paint(theme: ThemeLike, color: ThemeColor, text: string): string {
  if (typeof theme.fg !== "function") return text;
  try { return String(theme.fg(color, text)); } catch { return text; }
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

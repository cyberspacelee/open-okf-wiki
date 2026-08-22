import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatToolCall, renderWikiLive, wikiFooterStatus } from "./cli.js";
import type {
  WikiActivityView,
  WikiAgentView,
  WikiRunControl,
  WikiRunHandle,
  WikiRunView,
  WikiToolActivityView,
} from "./producer-types.js";

const PAGE = 10;
const NAV_MIN_WIDTH = 24;
const NAV_MAX_WIDTH = 36;
const DETAIL_MIN_WIDTH = 40;
const COLUMN_SEPARATOR = " │ ";
const MAX_VIEWPORT_ROWS = 40;
const LOCAL_DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "medium" });

type ThemeColor = "text" | "dim" | "muted" | "accent" | "success" | "warning" | "error" | "border" | "borderMuted";
type ThemeLike = {
  fg?(color: ThemeColor, text: string): string;
  bg?(color: "selectedBg", text: string): string;
  bold?(text: string): string;
};
type OverlayTui = { requestRender(force?: boolean): void; terminal?: { rows?: number } };
type KeybindingsLike = { matches(data: string, keybinding: string): boolean };
type OverlayScreen = "agents" | "board" | "agent" | "error";
type Operation = WikiRunControl | "confirmCancel";

interface ScrollState {
  top: number;
  anchorKey?: string;
  anchorOffset: number;
}

interface OverlayState {
  screen: OverlayScreen;
  returnScreen: Exclude<OverlayScreen, "error">;
  selectedAgentId?: string;
  agentScroll: ScrollState;
  boardScroll: ScrollState;
  errorScroll: ScrollState;
  followTail: boolean;
  hasNewer: boolean;
  operation?: Operation;
  notice?: { kind: "info" | "error"; message: string };
}

interface ContentLine {
  text: string;
  key: string;
}

interface ScrollMetrics {
  screen: OverlayScreen;
  content: ContentLine[];
  rows: number;
  start: number;
  maxScroll: number;
}

interface RenderedBody {
  lines: string[];
  metrics?: ScrollMetrics;
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
  handle: Pick<WikiRunHandle, "view" | "subscribe" | "control">;
}): Promise<void> {
  if (typeof args.ui.custom !== "function") return;
  await args.ui.custom(async (tui, theme, keybindings, done) => {
    return createWikiOverlay({
      tui,
      theme,
      keybindings,
      done: () => done(undefined),
      handle: args.handle,
      initialView: await args.handle.view(),
      confirmCancel: async () => await args.ui.confirm("Cancel Wiki run", "Cancel the current Wiki run?"),
    });
  }, {
    overlay: true,
    overlayOptions: {
      width: "92%",
      minWidth: 36,
      maxHeight: MAX_VIEWPORT_ROWS,
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
  handle: Pick<WikiRunHandle, "subscribe" | "control">;
  initialView: WikiRunView;
  confirmCancel: () => Promise<boolean>;
  now?: () => number;
}) {
  let view = args.initialView;
  let state: OverlayState = {
    screen: "agents",
    returnScreen: "agents",
    selectedAgentId: view.agents?.[0]?.id,
    agentScroll: emptyScroll(),
    boardScroll: emptyScroll(),
    errorScroll: emptyScroll(),
    followTail: false,
    hasNewer: false,
  };
  let closed = false;
  let cached: { width: number; viewport: number; lines: string[] } | undefined;
  let metrics: ScrollMetrics | undefined;
  const clock = args.now ?? Date.now;
  let now = clock();
  const invalidate = () => { cached = undefined; };
  const selected = (source = view) => source.agents?.find((agent) => agent.id === state.selectedAgentId);

  const unsubscribe = args.handle.subscribe((next) => {
    if (closed) return;
    const previous = view;
    const previousAgent = selected(previous);
    const previousIndex = Math.max(0, previous.agents?.findIndex((agent) => agent.id === state.selectedAgentId) ?? 0);
    view = next;
    const nextAgent = selected(next);

    if (state.selectedAgentId && !nextAgent) {
      const replacement = next.agents?.[clamp(previousIndex, 0, Math.max(0, (next.agents?.length ?? 1) - 1))];
      state = {
        ...state,
        screen: state.screen === "agent" ? "agents" : state.screen,
        selectedAgentId: replacement?.id,
        agentScroll: emptyScroll(),
        followTail: false,
        hasNewer: false,
        notice: { kind: "info", message: "The selected agent is no longer available." },
      };
    } else if (!state.selectedAgentId && next.agents?.length) {
      state = { ...state, selectedAgentId: next.agents[0]?.id };
    } else if (state.screen === "agent" && previousAgent && nextAgent) {
      const previousLast = activityVersion(previousAgent.activity.at(-1));
      const nextLast = activityVersion(nextAgent.activity.at(-1));
      state = {
        ...state,
        hasNewer: state.followTail ? false : state.hasNewer || Boolean(nextLast && nextLast !== previousLast),
      };
    }

    if (state.screen === "error" && !detailError(state, view)) {
      state = { ...state, screen: state.returnScreen, errorScroll: emptyScroll() };
    }
    now = clock();
    invalidate();
    args.tui.requestRender();
  });
  const tick = setInterval(() => {
    if (closed || (view.status !== "running" && view.status !== "paused")) return;
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
  const redraw = () => {
    if (closed) return;
    invalidate();
    args.tui.requestRender();
  };

  const moveAgent = (amount: number) => {
    const agents = view.agents ?? [];
    if (agents.length === 0) return;
    const current = Math.max(0, agents.findIndex((agent) => agent.id === state.selectedAgentId));
    const next = agents[clamp(current + amount, 0, agents.length - 1)];
    state = { ...state, selectedAgentId: next?.id, notice: undefined };
    redraw();
  };

  const openAgent = () => {
    if (!selected()) return;
    state = {
      ...state,
      screen: "agent",
      returnScreen: "agents",
      agentScroll: emptyScroll(),
      followTail: false,
      hasNewer: false,
      notice: undefined,
    };
    redraw();
  };

  const toggleTopLevel = () => {
    if (state.screen === "agents") {
      const target = initialBoardTask(view);
      state = {
        ...state,
        screen: "board",
        returnScreen: "board",
        boardScroll: target ? { top: 0, anchorKey: `task:${target.id}`, anchorOffset: 0 } : emptyScroll(),
        notice: undefined,
      };
    } else if (state.screen === "board") {
      state = { ...state, screen: "agents", returnScreen: "agents", notice: undefined };
    }
    redraw();
  };

  const openError = () => {
    if (!detailError(state, view) || state.screen === "error") return;
    state = {
      ...state,
      returnScreen: state.screen,
      screen: "error",
      errorScroll: emptyScroll(),
    };
    redraw();
  };

  const back = () => {
    if (state.screen === "agent") {
      state = { ...state, screen: "agents", returnScreen: "agents", followTail: false, hasNewer: false };
      redraw();
      return;
    }
    if (state.screen === "error") {
      state = { ...state, screen: state.returnScreen, errorScroll: emptyScroll() };
      redraw();
      return;
    }
    finish();
  };

  const moveScroll = (amount: number | "top" | "tail") => {
    if (!metrics || metrics.screen !== state.screen || state.screen === "agents") return;
    let top: number;
    if (amount === "top") top = 0;
    else if (amount === "tail") top = metrics.maxScroll;
    else top = clamp((state.followTail && state.screen === "agent" ? metrics.maxScroll : metrics.start) + amount, 0, metrics.maxScroll);
    state = updateScroll(state, anchorScroll(top, metrics.content));
    if (state.screen === "agent") {
      const followTail = amount === "tail" || top === metrics.maxScroll;
      state = { ...state, followTail, hasNewer: followTail ? false : state.hasNewer };
    }
    redraw();
  };

  const control = async (action: WikiRunControl) => {
    if (closed || state.operation || !actionsForStatus(view.status).includes(action)) return;
    if (action === "cancel") {
      state = { ...state, operation: "confirmCancel", notice: undefined };
      redraw();
      let confirmed: boolean;
      try {
        confirmed = await args.confirmCancel();
      } catch (error) {
        if (!closed) {
          state = { ...state, operation: undefined, notice: { kind: "error", message: errorText(error) } };
          redraw();
        }
        return;
      }
      if (closed) return;
      if (!confirmed) {
        state = { ...state, operation: undefined };
        redraw();
        return;
      }
    }
    state = { ...state, operation: action, notice: undefined };
    redraw();
    try {
      view = await args.handle.control(action);
      if (closed) return;
      state = { ...state, notice: undefined };
      if (action === "cancel") {
        finish();
        return;
      }
    } catch (error) {
      if (!closed) state = { ...state, notice: { kind: "error", message: errorText(error) } };
    } finally {
      if (!closed) {
        state = { ...state, operation: undefined };
        redraw();
      }
    }
  };

  return {
    invalidate,
    dispose: cleanup,
    handleInput(data: string) {
      if (closed) return;
      if (matchesKey(data, "p") && actionsForStatus(view.status).includes("pause")) return void control("pause");
      if (matchesKey(data, "r") && actionsForStatus(view.status).includes("resume")) return void control("resume");
      if (matchesKey(data, "x") && actionsForStatus(view.status).includes("cancel")) return void control("cancel");
      if (matchesKey(data, "e") && detailError(state, view)) return openError();
      if (matchesKey(data, Key.tab) && (state.screen === "agents" || state.screen === "board")) return toggleTopLevel();
      if (args.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.left) || matchesKey(data, Key.escape)) return back();

      if (state.screen === "agents") {
        if (args.keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) return moveAgent(-1);
        if (args.keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) return moveAgent(1);
        if (args.keybindings.matches(data, "tui.select.pageUp")) return moveAgent(-PAGE);
        if (args.keybindings.matches(data, "tui.select.pageDown")) return moveAgent(PAGE);
        if (args.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.right) || matchesKey(data, Key.enter) || matchesKey(data, Key.return)) return openAgent();
        return;
      }

      const page = Math.max(1, (metrics?.rows ?? PAGE) - 1);
      if (args.keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) return moveScroll(-1);
      if (args.keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) return moveScroll(1);
      if (args.keybindings.matches(data, "tui.select.pageUp")) return moveScroll(-page);
      if (args.keybindings.matches(data, "tui.select.pageDown")) return moveScroll(page);
      if (matchesKey(data, "g") || matchesKey(data, Key.home)) return moveScroll("top");
      if ((state.screen === "agent" && matchesKey(data, "t")) || matchesKey(data, Key.end) || matchesKey(data, "shift+g")) return moveScroll("tail");
    },
    render(width: number): string[] {
      const viewport = viewportRows(args.tui);
      if (cached?.width === width && cached.viewport === viewport) return cached.lines;
      const frameWidth = Math.max(8, width);
      const bodyRows = Math.max(1, viewport - 2);
      const contentWidth = Math.max(1, frameWidth - 3);
      const body = renderBody(state, view, selected(), contentWidth, bodyRows, args.theme);
      metrics = body.metrics;
      if (metrics) state = updateScroll(state, anchorScroll(metrics.start, metrics.content));
      const footer = overlayFooter(state, view, metrics, contentWidth);
      const lines = frame(frameWidth, styledTitle(view, now, args.theme), body.lines, footer, args.theme, bodyRows);
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
): RenderedBody {
  const status = statusLine(state, view, theme);
  if (state.screen === "agents") {
    const fixed = [topLevelTabs("agents", view, theme)];
    if (view.focus && rows >= 6) fixed.push(`${strong(theme, "Focus", "text")}  ${paint(theme, "muted", singleLine(view.focus))}`);
    if (status) fixed.push(status);
    const contentRows = Math.max(0, rows - fixed.length);
    const nav = navigationLines(view, state.selectedAgentId, theme);
    const navWidth = splitNavWidth(width);
    if (navWidth !== undefined) {
      const visibleNav = navigationWindow(nav, contentRows, theme);
      const preview = processPreviewLines(selected, view, theme);
      return { lines: [...fixed, ...columns(visibleNav, preview, navWidth, width, contentRows, theme)] };
    }
    return { lines: [...fixed, ...navigationWindow(nav, contentRows, theme).map((line) => renderNavRow(line, width, theme))] };
  }

  if (state.screen === "board") {
    const fixed = [topLevelTabs("board", view, theme)];
    if (status) fixed.push(status);
    return renderScrollable(state, "board", fixed, boardContent(view, width, theme), rows);
  }

  if (state.screen === "error") {
    return renderScrollable(state, "error", [strong(theme, "Run error", "error")], errorContent(detailError(state, view), width, theme), rows);
  }

  const heading = selected
    ? `${strong(theme, "Process", "text")}  ${marker(selected.status, theme)} ${strong(theme, selected.agent, "accent")}${selected.task ? paint(theme, "muted", `  ${singleLine(selected.task)}`) : ""}`
    : strong(theme, "Process", "text");
  const fixed = [heading];
  const stats = renderContextStats(selected);
  if (stats && rows >= 8) fixed.push(paint(theme, "muted", stats));
  if (status) fixed.push(status);
  return renderScrollable(state, "agent", fixed, processContent(selected, view, width, theme), rows);
}

function renderScrollable(
  state: OverlayState,
  screen: Exclude<OverlayScreen, "agents">,
  fixed: string[],
  content: ContentLine[],
  rows: number,
): RenderedBody {
  const contentRows = Math.max(0, rows - fixed.length);
  const scroll = scrollFor(state);
  const maxScroll = Math.max(0, content.length - contentRows);
  const anchored = resolveAnchor(scroll, content);
  const start = state.screen === "agent" && state.followTail ? maxScroll : clamp(anchored, 0, maxScroll);
  return {
    lines: [...fixed, ...content.slice(start, start + contentRows).map((line) => line.text)],
    metrics: { screen, content, rows: contentRows, start, maxScroll },
  };
}

interface NavigationLine {
  text: string;
  selected: boolean;
}

function navigationLines(view: WikiRunView, selectedAgentId: string | undefined, theme: ThemeLike): NavigationLine[] {
  return (view.agents ?? []).map((agent) => {
    const isSelected = agent.id === selectedAgentId;
    const current = currentTool(agent);
    const detail = current ? `  ${formatToolCall(current.tool, current.args)}` : agent.task ? `  ${singleLine(agent.task)}` : "";
    const text = `${marker(agent.status, theme)} ${strong(theme, agent.agent, isSelected ? "accent" : "text")}${detail ? paint(theme, "muted", detail) : ""}`;
    return { text, selected: isSelected };
  });
}

function processPreviewLines(agent: WikiAgentView | undefined, view: WikiRunView, theme: ThemeLike): string[] {
  if (!agent) return [paint(theme, "dim", "No agent selected.")];
  const lines = [`${strong(theme, "Process", "text")}  ${marker(agent.status, theme)} ${strong(theme, agent.agent, "accent")}`];
  if (agent.activity.length === 0) {
    lines.push(paint(theme, "dim", view.status === "running" ? "waiting for activity" : "no process activity"));
    return lines;
  }
  lines.push(...agent.activity.map((activity) => activityPreviewLine(activity, theme)));
  return lines;
}

function processContent(agent: WikiAgentView | undefined, view: WikiRunView, width: number, theme: ThemeLike): ContentLine[] {
  if (!agent) return [{ key: "empty", text: paint(theme, "dim", "No agent selected.") }];
  if (agent.activity.length === 0) {
    return [{ key: "empty", text: paint(theme, "dim", view.status === "running" ? "waiting for activity" : "no process activity") }];
  }
  return agent.activity.flatMap((activity) => activityContent(activity, width, theme));
}

function boardContent(view: WikiRunView, width: number, theme: ThemeLike): ContentLine[] {
  const lines: ContentLine[] = [];
  if (view.goal) {
    lines.push(...wrappedContent("goal", `${strong(theme, "Goal", "text")}  ${paint(theme, "muted", view.goal)}`, width));
    lines.push({ key: "goal:space", text: "" });
  }
  const tasks = view.tasks ?? [];
  if (tasks.length === 0) {
    lines.push({ key: "empty", text: paint(theme, "dim", "Board is empty.") });
    return lines;
  }
  for (const task of tasks) {
    const key = `task:${task.id}`;
    lines.push(...wrappedContent(key, `${taskMarker(task.status, theme)} ${strong(theme, task.id, "text")}  ${task.content}`, width));
    if (task.note) lines.push(...wrappedContent(key, `  ${paint(theme, "muted", `note: ${task.note}`)}`, width));
  }
  return lines;
}

function errorContent(error: string | undefined, width: number, theme: ThemeLike): ContentLine[] {
  return wrappedContent("error", paint(theme, "error", error ?? "No error details are available."), width);
}

function wrappedContent(key: string, text: string, width: number): ContentLine[] {
  return wrapTextWithAnsi(text, Math.max(1, width)).map((line) => ({ key, text: line }));
}

function topLevelTabs(active: "agents" | "board", view: WikiRunView, theme: ThemeLike): string {
  const agents = view.agents ?? [];
  const activeAgents = agents.filter((agent) => agent.status === "running").length;
  const tasks = view.tasks ?? [];
  const done = tasks.filter((task) => task.status === "completed").length;
  const agentLabel = `Agents ${agents.length}${activeAgents ? ` · ${activeAgents} active` : ""}`;
  const boardLabel = `Board ${done}/${tasks.length}`;
  return [
    active === "agents" ? strong(theme, `[${agentLabel}]`, "accent") : paint(theme, "muted", agentLabel),
    active === "board" ? strong(theme, `[${boardLabel}]`, "accent") : paint(theme, "muted", boardLabel),
  ].join("   ");
}

function statusLine(state: OverlayState, view: WikiRunView, theme: ThemeLike): string {
  if (state.operation) return paint(theme, "accent", `◆ ${operationLabel(state.operation)}`);
  if (state.notice) {
    const color = state.notice.kind === "error" ? "error" : "warning";
    return paint(theme, color, `${state.notice.kind === "error" ? "✗" : "!"} ${firstLine(state.notice.message)}${state.notice.kind === "error" ? "  e details" : ""}`);
  }
  if (view.error) return paint(theme, "error", `✗ ${firstLine(view.error)}  e details`);
  return "";
}

function toolLine(tool: WikiToolActivityView, theme: ThemeLike): string {
  return `  ${marker(tool.status, theme)} ${formatToolCall(tool.tool, tool.args)}`;
}

function activityPreviewLine(activity: WikiActivityView, theme: ThemeLike): string {
  if (activity.kind === "input") return `  ${paint(theme, "accent", "→")} Input · ${singleLine(activity.text)}`;
  if (activity.kind === "output") return `  ${marker(activity.status, theme)} Assistant · ${singleLine(activity.text)}`;
  return toolLine(activity, theme);
}

function activityContent(activity: WikiActivityView, width: number, theme: ThemeLike): ContentLine[] {
  const key = activityKey(activity);
  const at = formatActivityTime(activity.at);
  let lines: ContentLine[];
  if (activity.kind === "input") {
    lines = [
      ...wrappedContent(key, `${paint(theme, "accent", "→")} ${strong(theme, "Input", "text")}  ${paint(theme, "muted", at)}`, width),
      ...wrappedContent(key, `  ${activity.text}`, width),
    ];
  } else if (activity.kind === "output") {
    const streaming = activity.status === "running" ? "  streaming" : "";
    lines = [
      ...wrappedContent(key, `${marker(activity.status, theme)} ${strong(theme, "Assistant", "text")}  ${paint(theme, "muted", `${at}${streaming}`)}`, width),
      ...wrappedContent(key, `  ${activity.text}`, width),
    ];
  } else {
    lines = wrappedContent(key, `${marker(activity.status, theme)} ${strong(theme, "Tool", "text")}  ${paint(theme, "muted", at)}  ${formatToolCall(activity.tool, activity.args)}`, width);
    if (activity.result) {
      lines.push(...wrappedContent(key, `  ${strong(theme, "Result", "text")}  ${activity.result}`, width));
    }
  }
  return [...lines, { key, text: "" }];
}

function overlayFooter(state: OverlayState, view: WikiRunView, metrics: ScrollMetrics | undefined, width: number): string {
  const controls = controlHints(view.status);
  const error = detailError(state, view) ? "e error" : "";
  const position = scrollPosition(metrics);
  if (width < 72) {
    const navigation = state.screen === "agents" ? "↑↓ Enter Tab" : state.screen === "agent" ? "↑↓ Pg t" : "↑↓ Pg g";
    const newer = state.screen === "agent" && state.hasNewer ? "↓ new activity" : "";
    const availableControls = position || newer ? controls.replaceAll(/ (pause|resume|cancel)/g, "") : controls;
    return [navigation, position, newer, availableControls, error, "Esc"].filter(Boolean).join("  ");
  }
  const navigation = state.screen === "agents"
    ? "↑↓ select  Enter process  Tab Board"
    : state.screen === "board"
      ? "↑↓ scroll  PgUp/PgDn  g top  Tab Agents"
      : state.screen === "agent"
        ? "↑↓ scroll  PgUp/PgDn  g top  t tail"
        : "↑↓ scroll  PgUp/PgDn  g top";
  const newer = state.screen === "agent" && state.hasNewer ? "↓ newer activity" : "";
  return [navigation, position, newer, controls, error, state.screen === "agents" || state.screen === "board" ? "Esc close" : "Esc back"]
    .filter(Boolean)
    .join("   ");
}

function frame(width: number, title: string, body: string[], footer: string, theme: ThemeLike, bodyRows: number): string[] {
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

function splitNavWidth(width: number): number | undefined {
  const separator = visibleWidth(COLUMN_SEPARATOR);
  const target = clamp(Math.floor(width * 0.34), NAV_MIN_WIDTH, NAV_MAX_WIDTH);
  return width - target - separator >= DETAIL_MIN_WIDTH ? target : undefined;
}

function columns(left: NavigationLine[], right: string[], navWidth: number, width: number, rows: number, theme: ThemeLike): string[] {
  const rightWidth = Math.max(1, width - navWidth - visibleWidth(COLUMN_SEPARATOR));
  const visibleRight = right.length > rows
    ? rows === 1
      ? right.slice(0, 1)
      : [right[0], paint(theme, "muted", `… ${right.length - rows + 1} older · Enter process`), ...right.slice(-(rows - 2))]
    : right;
  const lines: string[] = [];
  for (let index = 0; index < rows; index += 1) {
    const nav = left[index];
    const leftText = renderNavRow(nav ?? { text: "", selected: false }, navWidth, theme);
    const rightText = padLine(visibleRight[index] ?? "", rightWidth);
    lines.push(`${leftText}${paint(theme, "borderMuted", COLUMN_SEPARATOR)}${rightText}`);
  }
  return lines;
}

function renderNavRow(line: NavigationLine, width: number, theme: ThemeLike): string {
  const prefix = line.selected ? paint(theme, "accent", "> ") : "  ";
  const padded = padLine(`${prefix}${line.text}`, width);
  return line.selected ? background(theme, padded) : padded;
}

function navigationWindow(lines: NavigationLine[], rows: number, theme: ThemeLike): NavigationLine[] {
  if (rows <= 0) return [];
  if (lines.length <= rows) return lines;
  const listRows = Math.max(1, rows - 1);
  const selected = Math.max(0, lines.findIndex((line) => line.selected));
  const start = clamp(selected - listRows + 1, 0, lines.length - listRows);
  return [
    ...lines.slice(start, start + listRows),
    { text: paint(theme, "muted", `${selected + 1}/${lines.length}`), selected: false },
  ];
}

function marker(status: WikiAgentView["status"], theme: ThemeLike): string {
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

function renderContextStats(agent: WikiAgentView | undefined): string {
  if (!agent?.usage) return "";
  const usage = agent.usage;
  const k = (value: number) => value >= 1000 ? `${Math.round(value / 100) / 10}k` : String(value);
  const parts: string[] = [];
  if (usage.turns !== undefined) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if (usage.toolCalls !== undefined) parts.push(`${usage.toolCalls} tools`);
  if (usage.input !== undefined || usage.output !== undefined) parts.push(`↑${k(usage.input)} ↓${k(usage.output)}`);
  if (usage.contextPercent !== undefined && usage.contextWindow !== undefined) {
    const used = usage.contextTokens !== undefined ? k(usage.contextTokens) : "?";
    parts.push(`ctx ${used}/${k(usage.contextWindow)} ${Math.round(usage.contextPercent)}%`);
  } else if (usage.contextTokens !== undefined) {
    parts.push(`ctx ${k(usage.contextTokens)}`);
  }
  return parts.join("  ");
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
  return `Wiki status | ${strong(theme, view.status, statusColor(view.status))}${elapsed(view, now)}`;
}

function statusColor(status: WikiRunView["status"]): ThemeColor {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "cancelled") return "error";
  if (status === "paused") return "warning";
  return "accent";
}

function actionsForStatus(status: WikiRunView["status"]): WikiRunControl[] {
  if (status === "running") return ["pause", "cancel"];
  if (status === "paused" || status === "failed") return ["resume", "cancel"];
  return [];
}

function controlHints(status: WikiRunView["status"]): string {
  return actionsForStatus(status).map((action) => `${action === "pause" ? "p" : action === "resume" ? "r" : "x"} ${action}`).join("  ");
}

function operationLabel(operation: Operation): string {
  if (operation === "confirmCancel") return "Confirming cancellation…";
  if (operation === "pause") return "Pausing…";
  if (operation === "resume") return "Resuming…";
  return "Cancelling…";
}

function initialBoardTask(view: WikiRunView) {
  return view.tasks?.find((task) => task.status === "in_progress")
    ?? view.tasks?.find((task) => task.status === "failed")
    ?? view.tasks?.[0];
}

function detailError(state: OverlayState, view: WikiRunView): string | undefined {
  return state.notice?.kind === "error" ? state.notice.message : view.error;
}

function emptyScroll(): ScrollState {
  return { top: 0, anchorOffset: 0 };
}

function scrollFor(state: OverlayState): ScrollState {
  if (state.screen === "agent") return state.agentScroll;
  if (state.screen === "board") return state.boardScroll;
  return state.errorScroll;
}

function updateScroll(state: OverlayState, scroll: ScrollState): OverlayState {
  if (state.screen === "agent") return { ...state, agentScroll: scroll };
  if (state.screen === "board") return { ...state, boardScroll: scroll };
  if (state.screen === "error") return { ...state, errorScroll: scroll };
  return state;
}

function resolveAnchor(scroll: ScrollState, content: ContentLine[]): number {
  if (!scroll.anchorKey) return scroll.top;
  const start = content.findIndex((line) => line.key === scroll.anchorKey);
  return start < 0 ? scroll.top : start + scroll.anchorOffset;
}

function anchorScroll(top: number, content: ContentLine[]): ScrollState {
  const line = content[top];
  if (!line) return { top, anchorOffset: 0 };
  const start = content.findIndex((entry) => entry.key === line.key);
  return { top, anchorKey: line.key, anchorOffset: Math.max(0, top - start) };
}

function scrollPosition(metrics: ScrollMetrics | undefined): string {
  if (!metrics || metrics.content.length <= metrics.rows || metrics.rows <= 0) return "";
  const end = Math.min(metrics.content.length, metrics.start + metrics.rows);
  return `${metrics.start + 1}–${end}/${metrics.content.length}`;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() || "Wiki run failed";
}

function singleLine(value: string): string {
  return value.replaceAll(/[\r\n]+/g, " ").replaceAll(/\s+/g, " ").trim();
}

function activityKey(activity: WikiActivityView): string {
  return `activity:${activity.kind}:${activity.id}`;
}

function activityVersion(activity: WikiActivityView | undefined): string | undefined {
  if (!activity) return undefined;
  if (activity.kind === "input") return activityKey(activity);
  if (activity.kind === "output") return `${activityKey(activity)}:${activity.status}:${activity.text.length}:${activity.text.slice(-32)}`;
  return `${activityKey(activity)}:${activity.status}:${formatToolCall(activity.tool, activity.args)}:${activity.result?.length ?? 0}`;
}

function toolActivity(agent: WikiAgentView): WikiToolActivityView[] {
  return agent.activity.filter((entry): entry is WikiToolActivityView => entry.kind === "tool");
}

function currentTool(agent: WikiAgentView): WikiToolActivityView | undefined {
  const tools = toolActivity(agent);
  return tools.find((tool) => tool.status === "running") ?? tools.at(-1);
}

function formatActivityTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? LOCAL_DATE_TIME.format(timestamp) : value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function padRule(label: string, inner: number): string {
  const clipped = truncateToWidth(label.trim() ? ` ${label.trim()} ` : "", inner, "…");
  return `${clipped}${"─".repeat(Math.max(0, inner - visibleWidth(clipped)))}`;
}

function titleBorderLine(title: string, inner: number, border: (text: string) => string): string {
  const clipped = truncateToWidth(title.trim(), Math.max(1, inner - 2), "…");
  const rule = "─".repeat(Math.max(0, inner - visibleWidth(clipped) - 2));
  return `${border("╭")}${border(" ")}${clipped}${border(" ")}${border(rule)}${border("╮")}`;
}

function viewportRows(tui: OverlayTui): number {
  const terminalRows = Math.max(1, Math.floor(tui.terminal?.rows ?? 24));
  return Math.max(1, Math.min(MAX_VIEWPORT_ROWS, terminalRows - 2));
}

function padLine(value: string, width: number): string {
  return truncateToWidth(value, width, "…", true);
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

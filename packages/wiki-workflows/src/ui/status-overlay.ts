import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type MarkdownTheme } from "@earendil-works/pi-tui";
import {
  agentStatusSemantics,
  batchStatusSemantics,
  formatWikiContext,
  projectWikiAgentLines,
  projectWikiProcessLines,
  runStatusSemantics,
  stageSemantics,
  wikiContextPressureTone,
  wikiTaskIdentity,
  type WikiStatusSemantics,
  type WikiTextLine,
  type WikiTextRole,
  type WikiTextSpan,
} from "./observability.js";
import type {
  WikiAgentInspection,
  WikiAgentSnapshot,
  WikiAgentTarget,
  WikiRunHandle,
  WikiRunUpdate,
  WikiRunView,
  WikiTaskSnapshot,
} from "../producer-types.js";
import { errorMessage } from "../util.js";

type WikiOverlayKind = "run" | "agent";
type InspectorTab = "overview" | "process" | "output";

interface WikiOverlayState {
  kind: WikiOverlayKind;
  cursor: number;
  /** Lines above the bottom of the inspector. 0 follows the tail. */
  fromBottom: number;
  runId: string;
  target?: WikiAgentTarget;
  tab: InspectorTab;
  /** User-toggled batch expansion. Undefined keeps the default open set. */
  openBatches?: number[];
}

type WikiOverlayAction =
  | { type: "up" | "down" | "forward" | "back" | "toggleTail" }
  | { type: "page"; direction: 1 | -1 };

type OverlayHandle = Pick<WikiRunHandle, "view" | "updates" | "inspectAgent">;
type NavTarget = { kind: "agent"; target: WikiAgentTarget } | { kind: "batch"; batch: number };
type NavRow = { spans: WikiTextSpan[]; target?: NavTarget };
type CachedOutput = { identity: string; inspection: WikiAgentInspection };
type MarkdownCache = { source?: string; width?: number; lines?: string[] };

const INSPECTOR_TOP = Number.MAX_SAFE_INTEGER;
const PAGE = 10;
const DEFAULT_VIEWPORT = 24;
const OVERLAY_MAX_HEIGHT_PERCENT = 88;
const OVERLAY_MAX_HEIGHT = `${OVERLAY_MAX_HEIGHT_PERCENT}%`;
const OVERLAY_MARGIN = 1;
const FIXED_BODY_ROWS = 3;
const FRAME_CHROME_ROWS = 4;
const NAV_WIDTH = 34;
const COLUMN_SEPARATOR = " │ ";

type ThemeColor = "text" | "dim" | "muted" | "accent" | "success" | "warning" | "error" | "border" | "borderMuted";
type ThemeLike = {
  fg?(color: ThemeColor, text: string): string;
  bg?(color: "selectedBg", text: string): string;
  bold?(text: string): string;
};

function initialWikiOverlayState(input: { runId: string; initialTarget?: WikiAgentTarget; process?: boolean }): WikiOverlayState {
  return {
    kind: input.initialTarget ? "agent" : "run",
    cursor: 0,
    fromBottom: INSPECTOR_TOP,
    runId: input.runId,
    target: input.initialTarget,
    tab: input.process ? "process" : "overview",
  };
}

function reduceWikiOverlay(state: WikiOverlayState, action: WikiOverlayAction, itemCount: number): WikiOverlayState {
  const max = Math.max(0, itemCount - 1);
  if (action.type === "up") return state.kind === "run" ? { ...state, cursor: clamp(state.cursor - 1, 0, max) } : { ...state, fromBottom: state.fromBottom + 1 };
  if (action.type === "down") return state.kind === "run" ? { ...state, cursor: clamp(state.cursor + 1, 0, max) } : { ...state, fromBottom: Math.max(0, state.fromBottom - 1) };
  if (action.type === "page") return state.kind === "run" ? { ...state, cursor: clamp(state.cursor + action.direction * PAGE, 0, max) } : { ...state, fromBottom: Math.max(0, state.fromBottom - action.direction * PAGE) };
  if (action.type === "forward" && state.kind === "agent") return cycleAgentTab(state, 1);
  if (action.type === "back" && state.kind === "agent" && state.tab !== "overview") return cycleAgentTab(state, -1);
  if (action.type === "back" && state.kind !== "run") return { ...state, kind: "run", target: undefined, fromBottom: INSPECTOR_TOP };
  if (action.type === "toggleTail" && state.kind !== "run") return { ...state, fromBottom: 0 };
  return state;
}

export async function openWikiStatusOverlay(args: {
  ui: { custom?: Function };
  handle: OverlayHandle;
  initialTarget?: WikiAgentTarget;
  process?: boolean;
  confirmCancel?: () => Promise<boolean>;
  onControl?: (action: "pause" | "resume" | "cancel") => Promise<void>;
}): Promise<void> {
  if (typeof args.ui.custom !== "function") return;
  await args.ui.custom(async (tui: OverlayTui, theme: unknown, keybindings: KeybindingsManager, done: () => void) => {
    const view = await args.handle.view();
    return createStatusOverlay({ ...args, tui, theme, keybindings, done, view });
  }, {
    overlay: true,
    overlayOptions: {
      width: "92%", minWidth: 36, maxHeight: OVERLAY_MAX_HEIGHT, anchor: "center", margin: OVERLAY_MARGIN,
      visible: (width: number, height: number) => width >= 36 && height >= 10,
    },
  });
}

type OverlayTui = { requestRender(force?: boolean): void; terminal?: { rows?: number } };

function createStatusOverlay(args: {
  tui: OverlayTui; theme: unknown; keybindings: KeybindingsManager; done(): void; handle: OverlayHandle; view: WikiRunView;
  initialTarget?: WikiAgentTarget; process?: boolean; confirmCancel?: () => Promise<boolean>;
  onControl?: (action: "pause" | "resume" | "cancel") => Promise<void>;
}) {
  let view = args.view;
  let state = initialWikiOverlayState({ runId: view.id, initialTarget: args.initialTarget, process: args.process });
  let inspection: WikiAgentInspection | undefined;
  let warning: string | undefined;
  let busy: string | undefined;
  let cached: { width: number; viewport: number; lines: string[] } | undefined;
  let closed = false;
  let generation = 0;
  let refreshing = false;
  let now = Date.now();
  let inflightOutput: { key: string; identity: string; token: number } | undefined;
  const controller = new AbortController();
  const outputCache = new Map<string, CachedOutput>();
  const markdownCache: MarkdownCache = {};
  const invalidate = () => { cached = undefined; };
  const nav = () => navigationRows(view, state).flatMap((row) => row.target ? [row.target] : []);
  const selected = () => state.target ? { kind: "agent" as const, target: state.target } : nav()[state.cursor];

  const cachedOutput = (target: WikiAgentTarget): WikiAgentInspection | undefined => {
    const key = selectedKey({ kind: "agent", target });
    const hit = outputCache.get(key);
    if (!hit || hit.identity !== outputIdentity(view, target)) return undefined;
    return hit.inspection;
  };

  const loadOutput = async (): Promise<void> => {
    if (state.kind !== "agent" || state.tab !== "output") return;
    const item = selected();
    if (item?.kind !== "agent") return;
    const key = selectedKey(item);
    const identity = outputIdentity(view, item.target);
    const hit = outputCache.get(key);
    if (hit && hit.identity === identity) {
      inspection = hit.inspection;
      return;
    }
    if (inflightOutput && inflightOutput.key === key && inflightOutput.identity === identity) return;
    const token = ++generation;
    inflightOutput = { key, identity, token };
    try {
      const next = await args.handle.inspectAgent(item.target, { transcript: true, handoff: true });
      if (closed || token !== generation) return;
      if (next) outputCache.set(key, { identity, inspection: next });
      inspection = next;
      warning = undefined;
    } catch (error) {
      if (token === generation) warning = errorMessage(error);
    } finally {
      if (inflightOutput?.token === token) inflightOutput = undefined;
    }
    invalidate(); args.tui.requestRender();
  };

  const refresh = async (): Promise<void> => {
    if (closed || refreshing) return;
    refreshing = true;
    try {
      view = await args.handle.view();
      state = { ...state, cursor: clamp(state.cursor, 0, Math.max(0, nav().length - 1)) };
      now = Date.now();
      if (state.kind === "agent" && state.tab === "output") await loadOutput();
    } catch (error) { warning = errorMessage(error); }
    finally { refreshing = false; invalidate(); args.tui.requestRender(); }
  };

  subscribeUpdates(args.handle, controller.signal, (update) => {
    view = update.view;
    state = { ...state, cursor: clamp(state.cursor, 0, Math.max(0, nav().length - 1)) };
    now = Date.now();
    if (state.kind === "agent" && state.tab === "output") void loadOutput();
    invalidate(); args.tui.requestRender();
  });
  const tick = setInterval(() => {
    if (closed) return;
    now = Date.now();
    invalidate();
    args.tui.requestRender();
  }, 2000);
  tick.unref?.();
  const cleanup = () => { if (!closed) { closed = true; generation += 1; clearInterval(tick); controller.abort(); } };
  const finish = () => { cleanup(); args.done(); };

  const apply = (action: WikiOverlayAction): void => {
    const before = selectedKey(selected());
    const beforeTab = state.tab;
    if (action.type === "forward" && state.kind === "run") {
      const item = selected();
      if (item?.kind === "agent") state = { ...state, kind: "agent", target: item.target, tab: "overview", fromBottom: INSPECTOR_TOP };
      else if (item?.kind === "batch") state = toggleBatch(state, view, item.batch);
    } else {
      state = reduceWikiOverlay(state, action, nav().length);
    }
    const after = selectedKey(selected());
    const item = selected();
    if (before !== after) {
      inspection = item?.kind === "agent" && state.tab === "output" ? cachedOutput(item.target) : undefined;
    }
    if (state.kind === "agent" && state.tab === "output" && (before !== after || beforeTab !== "output")) {
      void loadOutput();
    }
    invalidate(); args.tui.requestRender();
  };

  const control = async (action: "pause" | "resume" | "cancel"): Promise<void> => {
    if (busy) return;
    if (action === "cancel" && args.confirmCancel && !await args.confirmCancel()) return;
    busy = action === "cancel" ? "Cancelling..." : action === "pause" ? "Pausing..." : "Resuming...";
    invalidate(); args.tui.requestRender();
    try { await args.onControl?.(action); await refresh(); if (action === "cancel") finish(); }
    catch (error) { warning = errorMessage(error); }
    finally { busy = undefined; invalidate(); args.tui.requestRender(); }
  };

  return {
    invalidate,
    dispose: cleanup,
    handleInput(data: string) {
      if (closed) return;
      if (args.keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) return apply({ type: "up" });
      if (args.keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) return apply({ type: "down" });
      if (args.keybindings.matches(data, "tui.select.pageUp")) return apply({ type: "page", direction: -1 });
      if (args.keybindings.matches(data, "tui.select.pageDown")) return apply({ type: "page", direction: 1 });
      if (args.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.right)) return apply({ type: "forward" });
      if (args.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.left)) { if (state.kind === "run") finish(); else apply({ type: "back" }); return; }
      if (matchesKey(data, "t")) return apply({ type: "toggleTail" });
      if (state.kind === "run" && matchesKey(data, "p") && (view.status === "running" || view.status === "paused")) {
        void control(view.status === "paused" ? "resume" : "pause");
      }
      if (state.kind === "run" && matchesKey(data, "r") && view.status === "paused") void control("resume");
      if (state.kind === "run" && matchesKey(data, "x") && (view.status === "running" || view.status === "paused")) void control("cancel");
    },
    render(width: number): string[] {
      const viewport = viewportRows(args.tui);
      if (cached?.width === width && cached.viewport === viewport) return cached.lines;
      const language = view.progress?.language ?? "en";
      const current = selected();
      const matched = state.tab === "output" ? matchingInspection(current, inspection) : undefined;
      const bodyRows = Math.max(FIXED_BODY_ROWS + 1, viewport - FRAME_CHROME_ROWS);
      const body = renderBody(state, view, current, matched, width, bodyRows, args.theme, now, warning, busy, markdownCache);
      const footer = overlayFooter(state, view.status, language);
      const stats = contextLine(current, view, language, args.theme);
      const framed = frameWikiOverlay({
        width, title: styledTitle(view, args.theme), body: body.lines, stats, footer, theme: args.theme, viewport,
        fromBottom: state.fromBottom, fixedTop: body.fixedTop,
      });
      if (state.fromBottom > framed.maxScroll) state = { ...state, fromBottom: framed.maxScroll };
      cached = { width, viewport, lines: framed.lines };
      return framed.lines;
    },
  };
}

function navigationRows(view: WikiRunView, state?: Pick<WikiOverlayState, "openBatches">): NavRow[] {
  const lead = view.progress?.lead;
  const leadPresentation = agentStatusSemantics(lead?.status ?? "running");
  const rows: NavRow[] = [{
    spans: statusLabel(leadPresentation, ` Leader  ${lead?.activity.replaceAll("_", " ") ?? "starting"}`),
    target: { kind: "agent", target: { kind: "lead" } },
  }];
  for (const batch of view.progress?.batches ?? (view.progress?.currentBatch ? [view.progress.currentBatch] : [])) {
    const open = isBatchOpen(view, batch, state);
    const batchPresentation = batchStatusSemantics(batch.status);
    rows.push({
      spans: statusLabel(batchPresentation, ` Batch ${batch.batch}  ${batch.completed}/${batch.total}${open ? "" : "  …"}`),
      target: { kind: "batch", batch: batch.batch },
    });
    if (open) {
      for (const task of batch.tasks) {
        const taskPresentation = agentStatusSemantics(task.status);
        rows.push({
          spans: [{ text: "  ", role: "primary" }, ...statusLabel(taskPresentation, ` ${task.role}  ${taskIdentity(task)}`)],
          target: { kind: "agent", target: { kind: "task", batch: batch.batch, taskId: task.id } },
        });
      }
    }
  }
  return rows;
}

function statusLabel(presentation: WikiStatusSemantics, label: string): WikiTextSpan[] {
  return [{ text: presentation.marker, role: presentation.tone }, { text: label, role: "primary" }];
}

function taskIdentity(task: { id: string }): string {
  return wikiTaskIdentity(task);
}

function renderBody(
  state: WikiOverlayState,
  view: WikiRunView,
  selected: NavTarget | undefined,
  inspection: WikiAgentInspection | undefined,
  width: number,
  bodyRows: number,
  theme: unknown,
  now: number,
  warning?: string,
  busy?: string,
  markdownCache?: MarkdownCache,
): { lines: string[]; fixedTop: number } {
  const elapsed = runElapsed(view, now);
  const header = `${stageRail(view, theme)}${elapsed ? paint(theme, "dim", `  [${elapsed}]`) : ""}`;
  const health = selected?.kind === "agent" && agentFromView(view, selected.target)?.health === "degraded"
    ? view.progress?.language === "zh" ? "warning  可观测性降级" : "warning  observability degraded"
    : undefined;
  const operation = busy ? paint(theme, "accent", busy) : warning ? paint(theme, "warning", `warning  ${warning}`) : "";
  const healthNotice = health ? paint(theme, "warning", health) : "";
  const fixed = [header, operation, healthNotice];
  const contentRows = Math.max(1, bodyRows - FIXED_BODY_ROWS);
  const contentWidth = Math.max(1, width - 3);
  const navigation = navigationWindow(navigationLines(view, state, theme), contentRows);
  if (state.kind === "run" && width >= 100) {
    const rightWidth = Math.max(1, contentWidth - NAV_WIDTH - visibleWidth(COLUMN_SEPARATOR));
    const preview = inspectorPanel(selected, inspection, state, view, now, theme, rightWidth, markdownCache);
    return { lines: [...fixed, ...columns(navigation, [...preview.heading, ...preview.content], contentWidth, contentRows, theme)], fixedTop: FIXED_BODY_ROWS };
  }
  if (state.kind === "run") return { lines: [...fixed, ...navigation.map((line) => renderNavRow(line, contentWidth, theme))], fixedTop: FIXED_BODY_ROWS };
  const inspector = inspectorPanel(selected, inspection, state, view, now, theme, contentWidth, markdownCache);
  return { lines: [...fixed, ...inspector.heading, ...inspector.content], fixedTop: FIXED_BODY_ROWS + inspector.heading.length };
}

type NavigationLine = { text: string; selected: boolean };

function navigationLines(view: WikiRunView, state: Pick<WikiOverlayState, "cursor" | "openBatches">, theme: unknown): NavigationLine[] {
  let index = 0;
  return navigationRows(view, state).map((row) => {
    const selected = row.target ? index++ === state.cursor : false;
    return { text: styleAgentLine(row.spans, theme), selected };
  });
}

function navigationWindow(lines: NavigationLine[], rows: number): NavigationLine[] {
  if (lines.length <= rows) return lines;
  const selectedRow = lines.findIndex((line) => line.selected);
  if (selectedRow < 0) return lines.slice(0, rows);
  const start = clamp(selectedRow - rows + 1, 0, lines.length - rows);
  return lines.slice(start, start + rows);
}

function inspectorPanel(
  selected: NavTarget | undefined,
  inspection: WikiAgentInspection | undefined,
  state: WikiOverlayState,
  view: WikiRunView,
  now: number,
  theme: unknown,
  width: number,
  markdownCache?: MarkdownCache,
): { heading: string[]; content: string[] } {
  if (selected?.kind === "batch") {
    return { heading: [], content: wrapLines(batchInspectorLines(view, selected.batch, theme), width) };
  }
  const agent = selected?.kind === "agent" ? agentFromView(view, selected.target) : undefined;
  const unavailable = selected?.kind === "agent" && selected.target.kind === "lead"
    ? paint(theme, "muted", "Leader starting. Agent details are not available.")
    : paint(theme, "muted", "Agent details are not available.");
  if (!agent && state.kind === "run") return { heading: [], content: wrapLines([unavailable], width) };

  const tabs = (["overview", "process", "output"] as const).map((tab) => state.tab === tab
    ? strong(theme, `[${tab[0]!.toUpperCase()}${tab.slice(1)}]`, "accent")
    : paint(theme, "dim", `[${tab}]`)).join("  ");
  const heading = wrapLines(agent ? [tabs, liveAgentLine(agent, now, theme)] : [tabs], width);

  if (state.tab === "process") {
    const process = selected?.kind === "agent" ? agentFromView(view, selected.target)?.process ?? [] : [];
    const empty = view.progress?.language === "zh" ? "暂无过程记录" : "no process tail";
    if (process.length === 0 || !agent) {
      return { heading, content: wrapLines([paint(theme, "muted", empty)], width) };
    }
    return {
      heading,
      content: wrapLines(projectWikiProcessLines(process).map((line) => styleAgentLine(line, theme)), width),
    };
  }

  if (!agent) return { heading, content: wrapLines([unavailable], width) };

  if (state.tab === "output") {
    const matched = matchingInspection(selected, inspection);
    const output = matched?.handoff ?? matched?.agent.summary ?? agent.summary;
    return { heading, content: renderOutput(output, width, theme, markdownCache) };
  }

  return {
    heading,
    content: wrapLines(projectWikiAgentLines({ runId: view.id, agent, process: [] }, "overview").map((line) => styleAgentLine(line, theme)), width),
  };
}

function batchInspectorLines(view: WikiRunView, batchId: number, theme: unknown): string[] {
  const batch = (view.progress?.batches ?? (view.progress?.currentBatch ? [view.progress.currentBatch] : []))
    .find((entry) => entry.batch === batchId);
  if (!batch) return [paint(theme, "muted", "Batch details are not available.")];
  const presentation = batchStatusSemantics(batch.status);
  const language = view.progress?.language ?? "en";
  const lines = [
    `${paint(theme, textRoleColor(presentation.tone), presentation.marker)} ${strong(theme, `Batch ${batch.batch}`, "accent")} ${paint(theme, "muted", `${batch.completed}/${batch.total}  ${batch.status}`)}`,
  ];
  if (batch.tasks.length === 0) lines.push(paint(theme, "muted", language === "zh" ? "此批次没有任务" : "No tasks in this batch."));
  for (const task of batch.tasks) {
    const taskPresentation = agentStatusSemantics(task.status);
    const summary = task.summary ? `  ${task.summary}` : "";
    lines.push(`${paint(theme, textRoleColor(taskPresentation.tone), taskPresentation.marker)} ${task.role}  ${taskIdentity(task)}${summary}`);
  }
  lines.push(paint(theme, "dim", language === "zh" ? "Enter 展开或收起任务  再选中任务查看输出" : "Enter expands tasks  then open a task for output"));
  return lines;
}

function renderOutput(output: string | undefined, width: number, theme: unknown, cache?: MarkdownCache): string[] {
  if (!output) return [paint(theme, "muted", "No output yet.")];
  if (cache?.source === output && cache.width === width && cache.lines) return cache.lines;
  try {
    const lines = new Markdown(output, 0, 0, overlayMarkdownTheme(theme)).render(Math.max(1, width));
    if (cache) {
      cache.source = output;
      cache.width = width;
      cache.lines = lines;
    }
    return lines;
  } catch {
    return wrapLines(output.split("\n"), width);
  }
}

function overlayMarkdownTheme(theme: unknown): MarkdownTheme {
  return {
    heading: (text) => strong(theme, text, "accent"),
    link: (text) => paint(theme, "accent", text),
    linkUrl: (text) => paint(theme, "muted", text),
    code: (text) => paint(theme, "accent", text),
    codeBlock: (text) => paint(theme, "text", text),
    codeBlockBorder: (text) => paint(theme, "borderMuted", text),
    quote: (text) => paint(theme, "muted", text),
    quoteBorder: (text) => paint(theme, "borderMuted", text),
    hr: (text) => paint(theme, "borderMuted", text),
    listBullet: (text) => paint(theme, "accent", text),
    bold: (text) => strong(theme, text, "text"),
    italic: (text) => paint(theme, "text", text),
    strikethrough: (text) => paint(theme, "muted", text),
    underline: (text) => paint(theme, "text", text),
  };
}

function wrapLines(lines: string[], width: number): string[] {
  const limit = Math.max(1, Math.floor(width));
  return lines.flatMap((line) => {
    const wrapped = wrapTextWithAnsi(line, limit);
    return wrapped.length > 0 ? wrapped : [""];
  });
}

function defaultOpenBatches(view: WikiRunView): number[] {
  return (view.progress?.batches ?? (view.progress?.currentBatch ? [view.progress.currentBatch] : []))
    .filter((batch) => batch.batch === view.progress?.currentBatch?.batch || batch.status === "failed" || batch.status === "partial")
    .map((batch) => batch.batch);
}

function isBatchOpen(view: WikiRunView, batch: { batch: number; status: string }, state?: Pick<WikiOverlayState, "openBatches">): boolean {
  return (state?.openBatches ?? defaultOpenBatches(view)).includes(batch.batch);
}

function toggleBatch(state: WikiOverlayState, view: WikiRunView, batch: number): WikiOverlayState {
  const open = new Set(state.openBatches ?? defaultOpenBatches(view));
  if (open.has(batch)) open.delete(batch);
  else open.add(batch);
  return { ...state, openBatches: [...open], fromBottom: INSPECTOR_TOP };
}

function matchingInspection(selected: NavTarget | undefined, inspection: WikiAgentInspection | undefined): WikiAgentInspection | undefined {
  return selected?.kind === "agent" && inspection && sameTarget(inspection.agent.target, selected.target) ? inspection : undefined;
}

function agentFromView(view: WikiRunView, target: WikiAgentTarget): WikiAgentSnapshot | undefined {
  if (target.kind === "lead") return view.progress?.lead;
  const batches = view.progress?.batches ?? (view.progress?.currentBatch ? [view.progress.currentBatch] : []);
  const task = batches.find((batch) => batch.batch === target.batch)?.tasks.find((entry) => entry.id === target.taskId);
  return task ? taskSnapshotToAgent(target, task) : undefined;
}

function taskSnapshotToAgent(target: Extract<WikiAgentTarget, { kind: "task" }>, task: WikiTaskSnapshot): WikiAgentSnapshot {
  const settled = task.status === "complete" || task.status === "incomplete" || task.status === "failed";
  return {
    target,
    role: task.role,
    status: task.status,
    attempt: task.attempt ?? task.attempts ?? 1,
    activity: task.activity ?? (settled ? "settled" : "starting"),
    activeTools: task.activeTool ? [task.activeTool] : [],
    health: task.health ?? "healthy",
    ...(task.startedAt ? { startedAt: task.startedAt } : {}),
    ...(task.updatedAt ? { updatedAt: task.updatedAt } : {}),
    ...(task.usage ? { usage: task.usage } : {}),
    ...(task.summary ? { summary: task.summary } : {}),
    ...(task.process?.length ? { process: task.process } : {}),
  };
}

function outputIdentity(view: WikiRunView, target: WikiAgentTarget): string {
  const agent = agentFromView(view, target);
  const key = target.kind === "lead" ? "lead" : `${target.batch}:${target.taskId}`;
  return `${key}\0${agent?.attempt ?? ""}\0${agent?.status ?? ""}\0${agent?.updatedAt ?? ""}\0${agent?.summary ?? ""}`;
}

function sameTarget(left: WikiAgentTarget, right: WikiAgentTarget): boolean {
  return left.kind === right.kind && (left.kind === "lead" || right.kind === "task" && left.batch === right.batch && left.taskId === right.taskId);
}

function stageRail(view: WikiRunView, theme: unknown): string {
  const stages = ["prepare", "lead", "validate", "publish"] as const;
  const current = stages.indexOf(view.progress?.stage ?? "prepare");
  const language = view.progress?.language ?? "en";
  return stages.map((stage, index) => {
    const stageLabel = stageSemantics(stage, language).label;
    const label = `${index < current ? "✓" : index === current ? "◆" : "○"} ${stageLabel[0]!.toUpperCase()}${stageLabel.slice(1)}`;
    return index < current ? paint(theme, "success", label) : index === current ? strong(theme, label, "accent") : paint(theme, "dim", label);
  }).join(paint(theme, "borderMuted", " ━ "));
}

function liveAgentLine(agent: WikiAgentSnapshot, now: number, theme: unknown): string {
  const presentation = agentStatusSemantics(agent.status);
  const parts = [agent.activeTools[0]?.name ? `tool ${agent.activeTools[0].name}` : agent.activity.replaceAll("_", " ")];
  const heartbeat = formatAge(agent.lastHeartbeatAt, now);
  const activity = formatAge(agent.lastActivityAt, now);
  if (heartbeat) parts.push(`session alive ${heartbeat}`);
  if (activity) parts.push(`Pi activity ${activity}`);
  const statusColor = textRoleColor(presentation.tone);
  return `${paint(theme, statusColor, presentation.marker)} ${paint(theme, statusColor, agent.status)} ${paint(theme, "text", `· ${parts[0] ?? ""}`)} ${parts.slice(1).map((part) => paint(theme, "dim", `· ${part}`)).join(" ")}`.trimEnd();
}

function frameWikiOverlay(input: { width: number; title: string; body: string[]; stats?: string; footer: string; theme?: unknown; viewport?: number; fromBottom?: number; fixedTop?: number }): { lines: string[]; maxScroll: number } {
  const width = Math.max(8, Math.floor(input.width));
  const inner = Math.max(1, width - 2);
  const chrome = 2 + (input.stats ? 2 : 0);
  const viewport = Math.max(1, (input.viewport ?? DEFAULT_VIEWPORT) - chrome);
  const fixedCount = clamp(input.fixedTop ?? 0, 0, Math.min(viewport, input.body.length));
  const fixed = input.body.slice(0, fixedCount);
  const scrollable = input.body.slice(fixedCount);
  const scrollableViewport = Math.max(0, viewport - fixed.length);
  const maxScroll = Math.max(0, scrollable.length - scrollableViewport);
  const fromBottom = input.fromBottom === undefined ? maxScroll : clamp(input.fromBottom, 0, maxScroll);
  const scroll = maxScroll - fromBottom;
  const slice = scrollable.slice(scroll, scroll + scrollableViewport);
  const visible = [...fixed, ...slice];
  while (visible.length < viewport) visible.push("");
  const border = (text: string) => paint(input.theme, "border", text);
  const mutedBorder = (text: string) => paint(input.theme, "borderMuted", text);
  const lines = [titleBorderLine(input.title, inner, border), ...visible.map((line) => `${border("│")}${padLine(` ${line}`, inner)}${border("│")}`)];
  if (input.stats) lines.push(`${border("├")}${mutedBorder(padRule("context", inner))}${border("┤")}`, `${border("│")}${padLine(` ${input.stats}`, inner)}${border("│")}`);
  lines.push(`${border("╰")}${border(padRule(input.footer, inner))}${border("╯")}`);
  return { lines, maxScroll };
}

function wikiOverlayMaxHeight(terminalRows: number): number {
  const rows = Math.max(1, Math.floor(terminalRows));
  return Math.max(1, Math.min(Math.floor(rows * OVERLAY_MAX_HEIGHT_PERCENT / 100), rows - OVERLAY_MARGIN * 2));
}

function columns(left: NavigationLine[], right: string[], width: number, rows: number, theme: unknown): string[] {
  const rightWidth = Math.max(1, width - NAV_WIDTH - visibleWidth(COLUMN_SEPARATOR));
  const visibleRight = right.length > rows
    ? [...right.slice(0, Math.max(0, rows - 1)), paint(theme, "muted", "… Enter to inspect")]
    : right;
  return Array.from({ length: rows }, (_, index) => {
    const leftCell = renderNavRow(left[index] ?? { text: "", selected: false }, NAV_WIDTH, theme);
    const divider = paint(theme, "borderMuted", COLUMN_SEPARATOR);
    return `${leftCell}${divider}${padLine(visibleRight[index] ?? "", rightWidth)}`;
  });
}

function renderNavRow(line: NavigationLine, width: number, theme: unknown): string {
  const prefix = line.selected ? paint(theme, "accent", "> ") : "  ";
  const padded = padLine(`${prefix}${line.text}`, width);
  return line.selected ? background(theme, "selectedBg", padded) : padded;
}

function styleAgentLine(line: WikiTextLine, theme: unknown): string {
  return line.map((span) => {
    const color = textRoleColor(span.role);
    return span.emphasis ? strong(theme, span.text, color) : paint(theme, color, span.text);
  }).join("");
}

function textRoleColor(role: WikiTextRole): ThemeColor {
  switch (role) {
    case "primary": return "text";
    case "label": return "muted";
    case "muted": return "muted";
    default: return role;
  }
}

function contextLine(selected: NavTarget | undefined, view: WikiRunView, language: "zh" | "en", theme: unknown): string {
  if (selected?.kind === "batch") return paint(theme, "muted", "context  —");
  const stats = formatWikiContext(selected?.kind === "agent" ? agentFromView(view, selected.target)?.usage : undefined);
  if (!stats) return paint(theme, "muted", language === "zh" ? "context  等待遥测" : "context  waiting for telemetry");
  const tone = wikiContextPressureTone(selected?.kind === "agent" ? agentFromView(view, selected.target)?.usage?.contextPercent : undefined);
  const color: ThemeColor = tone ? textRoleColor(tone) : "text";
  return `${paint(theme, "muted", "context  ")}${paint(theme, color, stats)}`;
}

function styledTitle(view: WikiRunView, theme: unknown): string {
  const color: ThemeColor = runStatusSemantics(view.status).tone;
  return `wiki ${view.id}  ${strong(theme, view.status, color)}`;
}

function overlayFooter(state: WikiOverlayState, status: WikiRunView["status"], language: "zh" | "en"): string {
  const active = status === "running" || status === "paused";
  if (state.kind === "agent") return language === "zh"
    ? `↑↓ 滚动  ←→ 页面  t 跟随  esc`
    : `↑↓ scroll  ←→ pages  t tail  esc`;
  const controls = active
    ? status === "paused" ? language === "zh" ? "  r 恢复  x 取消" : "  r resume  x cancel" : language === "zh" ? "  p 暂停  x 取消" : "  p pause  x cancel"
    : "";
  return language === "zh" ? `↑↓ 选择  → 打开/展开  ← 关闭${controls}  esc` : `↑↓ select  → open/expand  ← close${controls}  esc`;
}

function cycleAgentTab(state: WikiOverlayState, direction: 1 | -1): WikiOverlayState {
  const tabs: InspectorTab[] = ["overview", "process", "output"];
  const index = tabs.indexOf(state.tab);
  const tab = tabs[(index + direction + tabs.length) % tabs.length]!;
  return { ...state, tab, fromBottom: INSPECTOR_TOP };
}

function padLine(value: string, width: number): string { const clipped = truncateToWidth(value, width, "...", true); return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped))); }
function padRule(label: string, inner: number): string { const clipped = truncateToWidth(label.trim() ? ` ${label.trim()} ` : "", inner); return clipped + "─".repeat(Math.max(0, inner - visibleWidth(clipped))); }
function titleBorderLine(title: string, inner: number, border: (text: string) => string): string {
  const clipped = truncateToWidth(title.trim(), Math.max(1, inner - 2), "...");
  const rule = "─".repeat(Math.max(0, inner - visibleWidth(clipped) - 2));
  return `${border("╭")}${border(" ")}${clipped}${border(" ")}${border(rule)}${border("╮")}`;
}
function viewportRows(tui: OverlayTui): number { const rows = tui.terminal?.rows; return wikiOverlayMaxHeight(typeof rows === "number" && rows > 6 ? rows : DEFAULT_VIEWPORT); }
function selectedKey(value: NavTarget | undefined): string {
  if (!value) return "";
  if (value.kind === "batch") return `batch:${value.batch}`;
  return JSON.stringify(value.target);
}
function formatAge(value: string | undefined, now: number): string | undefined { const parsed = value ? Date.parse(value) : NaN; if (!Number.isFinite(parsed)) return undefined; const seconds = Math.max(0, Math.floor((now - parsed) / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`; }
function runElapsed(view: WikiRunView, now: number): string | undefined { const start = Date.parse(view.createdAt); const end = view.completedAt ? Date.parse(view.completedAt) : now; if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined; const seconds = Math.floor((end - start) / 1000); const hours = Math.floor(seconds / 3600); const minutes = Math.floor(seconds % 3600 / 60); const rest = seconds % 60; return hours ? `${hours}h${minutes}m${rest}s` : minutes ? `${minutes}m${rest}s` : `${rest}s`; }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
function paint(theme: unknown, color: ThemeColor, text: string): string {
  const value = theme as ThemeLike | undefined;
  if (typeof value?.fg !== "function") return text;
  try { return String(value.fg.call(value, color, text)); } catch { return text; }
}

function background(theme: unknown, color: "selectedBg", text: string): string {
  const value = theme as ThemeLike | undefined;
  if (typeof value?.bg !== "function") return text;
  try { return String(value.bg.call(value, color, text)); } catch { return text; }
}

function strong(theme: unknown, text: string, color: ThemeColor): string {
  const painted = paint(theme, color, text);
  const value = theme as ThemeLike | undefined;
  if (typeof value?.bold !== "function") return painted;
  try { return String(value.bold.call(value, painted)); } catch { return painted; }
}
function subscribeUpdates(handle: Pick<WikiRunHandle, "updates">, signal: AbortSignal, onUpdate: (update: WikiRunUpdate) => void): void { void (async () => { try { for await (const update of handle.updates(signal)) { if (signal.aborted) return; onUpdate(update); } } catch { /* durable stream may end */ } })(); }

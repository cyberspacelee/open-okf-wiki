import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  parseWikiCliCommand,
  renderWikiAgent,
  renderWikiRun,
  renderWikiSnapshot,
  renderWikiRuns,
  wikiCliHelp,
  type WikiCliCommand,
} from "./cli.js";
import { projectWikiRunEvent } from "./ui/observability.js";
import { createConfiguredWikiProducer } from "./production-run.js";
import type { WikiAgentTarget, WikiProducer, WikiRunControl, WikiRunHandle, WikiRunView } from "./producer-types.js";
import {
  claimProducerSlot,
  handoffProducerSlot,
  sessionFileCwd,
  WIKI_PRODUCER_HANDOFF_VERSION,
  type WikiProducerHandoff,
  type WikiProducerHost,
} from "./run-handoff.js";
import { formatLocalDateTime } from "./ui/time-format.js";
import {
  themeWikiLiveText,
  wikiFooterStatus,
  wikiWidgetLines,
  wikiWidgetLinesFingerprint,
} from "./ui/live-surface.js";
import { openWikiStatusOverlay } from "./ui/status-overlay.js";
import { errorMessage } from "./failures.js";
import { loadWikiWorkspace, wikiWorkspaceManagement, type ResolvedWikiWorkspace } from "./workspace.js";

export interface WikiExtensionOptions {
  createProducer?: (context: ExtensionContext) => WikiProducer;
}

export function createWikiExtension(options: WikiExtensionOptions = {}) {
  return (pi: ExtensionAPI): void => {
    const initial = claimProducerSlot();
    let host: WikiProducerHost = initial.compatible?.host ?? initial.versionMismatch?.host ?? {};
    let context: ExtensionContext | undefined;
    let producer: WikiProducer | undefined = initial.compatible?.producer;
    let producerWorkspace: string | undefined = nonempty(initial.compatible?.workspaceRoot);
    let mismatched: WikiProducerHandoff | undefined = initial.versionMismatch;
    const streams = new Map<string, AbortController>();
    const widget = createWikiLiveWidget();
    const refresh = (active: ExtensionCommandContext, view: WikiRunView) => widget.refresh(active, view);

    const adoptHost = (active: ExtensionContext) => {
      context = active;
      host.context = active;
    };

    const createEngine = (active: ExtensionContext): WikiProducer =>
      options.createProducer?.(active) ?? createConfiguredWikiProducer({
        getModel: () => (host.context as ExtensionContext | undefined)?.model,
        getThinkingLevel: () => (host.context as ExtensionContext | undefined)?.thinkingLevel,
        getModelRegistry: () => (host.context as ExtensionContext | undefined)?.modelRegistry,
      });

    const currentProducer = (active: ExtensionContext, root?: string): WikiProducer => {
      adoptHost(active);
      producer ??= createEngine(active);
      if (root) producerWorkspace ??= root;
      return producer;
    };

    pi.on("session_start", async (_event, active) => {
      adoptHost(active);
      const incoming = claimProducerSlot();
      if (incoming.versionMismatch) mismatched = incoming.versionMismatch;
      if (incoming.compatible) {
        if (!producer) {
          producer = incoming.compatible.producer;
          producerWorkspace = nonempty(incoming.compatible.workspaceRoot);
        } else if (incoming.compatible.producer !== producer) {
          await pauseRunning(incoming.compatible.producer, incoming.compatible.workspaceRoot);
        }
        if (incoming.compatible.host) host = incoming.compatible.host;
        host.context = active;
      }
      if (mismatched) {
        await pauseRunning(mismatched.producer, mismatched.workspaceRoot);
        if (producer === mismatched.producer) {
          producer = undefined;
          producerWorkspace = undefined;
        }
        mismatched = undefined;
      }

      const root = await tryWorkspaceRoot(active.cwd);
      if (producer && producerWorkspace && producerWorkspace !== root) {
        await pauseRunning(producer, producerWorkspace);
        producer = undefined;
        producerWorkspace = undefined;
      }

      if (!producer) producer = createEngine(active);
      if (root) producerWorkspace = root;

      try {
        if (!root || !producer) return;
        const running = (await producer.list(root)).find((run) => run.status === "running");
        if (!running) return;
        const handle = await producer.open(running.id, root);
        if (!handle) return;
        const view = await handle.view();
        refresh(active as ExtensionCommandContext, view);
        attachStream(pi, active as ExtensionCommandContext, handle, refresh, streams);
      } catch {
        // No Workspace or readable Run yet; /wiki still starts or opens one.
      }
    });

    pi.on("session_shutdown", async (event) => {
      const reason = event && typeof event === "object" && "reason" in event ? String(event.reason) : "";
      const targetSessionFile = event && typeof event === "object" && "targetSessionFile" in event
        && typeof event.targetSessionFile === "string"
        ? event.targetSessionFile
        : undefined;
      for (const controller of streams.values()) controller.abort();
      streams.clear();
      widget.reset();
      if (context?.hasUI) {
        context.ui.setStatus("wiki", undefined);
        context.ui.setWidget("wiki", undefined);
      }

      const payload = producer
        ? {
          producer,
          workspaceRoot: producerWorkspace ?? "",
          version: WIKI_PRODUCER_HANDOFF_VERSION,
          host,
        }
        : undefined;
      const expire = (handed: WikiProducerHandoff) => {
        void pauseRunning(handed.producer, handed.workspaceRoot);
      };

      if (reason === "reload" || reason === "new") {
        if (payload) handoffProducerSlot(payload, expire);
      } else if (reason === "resume" || reason === "fork") {
        const targetCwd = sessionFileCwd(targetSessionFile);
        const targetRoot = targetCwd ? await tryWorkspaceRoot(targetCwd) : undefined;
        if (!payload || !targetRoot || !payload.workspaceRoot || targetRoot !== payload.workspaceRoot) {
          await pauseRunning(producer, producerWorkspace);
        } else {
          handoffProducerSlot(payload, expire);
        }
      } else {
        const leftover = claimProducerSlot();
        const engine = producer ?? leftover.compatible?.producer ?? leftover.versionMismatch?.producer;
        const cwd = producerWorkspace ?? leftover.compatible?.workspaceRoot ?? leftover.versionMismatch?.workspaceRoot;
        await pauseRunning(engine, cwd);
      }

      producer = undefined;
      producerWorkspace = undefined;
      context = undefined;
    });

    pi.registerCommand("wiki", {
      description: "Build, inspect, and control the repository Wiki",
      getArgumentCompletions: wikiArgumentCompletions,
      async handler(rawArgs: string, active: ExtensionCommandContext): Promise<void> {
        let command: WikiCliCommand;
        try {
          command = parseWikiCliCommand(rawArgs);
        } catch (error) {
          output(pi, active, `${errorMessage(error)}\n\n${wikiCliHelp()}`);
          return;
        }
        try {
          if (command.action === "init" || command.action === "source-add") {
            await dispatchWorkspace(pi, active, command);
            return;
          }
          const cwd = await workspaceRoot(active.cwd);
          const engine = currentProducer(active, cwd);
          await dispatch(pi, active, engine, cwd, command, refresh, (handle) => {
            attachStream(pi, active, handle, refresh, streams);
          });
        } catch (error) {
          active.ui.notify(errorMessage(error), "error");
        }
      },
    });
  };
}

export default createWikiExtension();

async function dispatch(
  pi: ExtensionAPI,
  context: ExtensionCommandContext,
  producer: WikiProducer,
  cwd: string,
  command: Exclude<WikiCliCommand, { action: "init" | "source-add" }>,
  refresh: LiveSurfaceRefresh,
  ensureStream: (handle: WikiRunHandle) => void,
): Promise<void> {
  if (command.action === "run") {
    const handle = await producer.start({
      cwd,
      focus: command.focus,
    });
    const view = await handle.view();
    output(pi, context, renderWikiRun(view));
    refresh(context, view);
    ensureStream(handle);
    return;
  }
  if (command.action === "runs") {
    output(pi, context, renderWikiRuns(await producer.list(cwd)));
    return;
  }
  const handle = await selectedRun(producer, cwd, "runId" in command ? command.runId : undefined);
  if (command.action === "status") {
    await dispatchStatus(pi, context, handle, command, refresh, ensureStream);
    return;
  }
  if (!handle) throw new Error("No Wiki run is available");
  const view = await handle.control(command.action);
  output(pi, context, renderWikiRun(view));
  refresh(context, view);
  if (command.action === "resume") {
    ensureStream(handle);
  }
}

async function dispatchStatus(
  pi: ExtensionAPI,
  context: ExtensionCommandContext,
  handle: WikiRunHandle | undefined,
  command: Extract<WikiCliCommand, { action: "status" }>,
  refresh: LiveSurfaceRefresh,
  ensureStream: (handle: WikiRunHandle) => void,
): Promise<void> {
  if (!handle) {
    output(pi, context, renderWikiRun(undefined));
    return;
  }
  const view = await handle.view();
  if (!command.target) {
    output(pi, context, renderWikiSnapshot(view));
    refresh(context, view);
    if (view.status === "running") ensureStream(handle);
    await openStatusOverlay(context, handle, command, refresh);
    return;
  }
  const inspection = await handle.inspectAgent(command.target);
  if (!inspection) {
    output(pi, context, `Wiki ${view.id} has no agent "${formatTarget(command.target)}".`);
    return;
  }
  const detail = renderWikiAgent(inspection, command.process ? "process" : "overview");
  output(pi, context, `${detail}\n\nsnapshot as of ${formatLocalDateTime(view.updatedAt)}`);
  await openStatusOverlay(context, handle, command, refresh);
}

function formatTarget(target: WikiAgentTarget): string {
  return target.kind === "lead" ? "lead" : `batch-${target.batch}/${target.taskId}`;
}

async function openStatusOverlay(
  context: ExtensionCommandContext,
  handle: WikiRunHandle,
  command: Extract<WikiCliCommand, { action: "status" }>,
  refresh: LiveSurfaceRefresh,
): Promise<void> {
  if (context.mode !== "tui" || command.process) return;
  await openWikiStatusOverlay({
    ui: context.ui,
    handle,
    initialTarget: command.target,
    process: command.process,
    confirmCancel: typeof context.ui.confirm === "function"
      ? async () => await context.ui.confirm("Cancel Wiki run", `Cancel ${handle.id}?`)
      : undefined,
    onControl: async (action: WikiRunControl) => {
      const next = await handle.control(action);
      refresh(context, next);
    },
  });
}

async function dispatchWorkspace(
  pi: ExtensionAPI,
  context: ExtensionCommandContext,
  command: Extract<WikiCliCommand, { action: "init" | "source-add" }>,
): Promise<void> {
  if (command.action === "init") {
    const workspace = await wikiWorkspaceManagement.init({
      cwd: context.cwd,
      workspace: command.workspace,
      language: command.language,
      defaultSourceIgnores: command.defaultSourceIgnores,
      wikiExclude: command.exclude,
    });
    output(pi, context, `Wiki workspace initialized: ${workspace.root}\nLanguage: ${workspace.language}`);
    return;
  }
  const workspace = command.kind === "link"
    ? await wikiWorkspaceManagement.addLink({
      cwd: context.cwd,
      workspace: command.workspace,
      localPath: command.localPath,
      name: command.name,
    })
    : await wikiWorkspaceManagement.addClone({
      cwd: context.cwd,
      workspace: command.workspace,
      remoteUrl: command.url,
      ref: command.ref,
      name: command.name,
    });
  output(pi, context, renderAddedSource(workspace));
}

function renderAddedSource(workspace: ResolvedWikiWorkspace): string {
  const source = workspace.sources.at(-1);
  return source
    ? `Wiki source added: ${source.path}\nWorkspace: ${workspace.root}\nMode: ${source.origin.type}`
    : `Wiki workspace updated: ${workspace.root}`;
}

async function selectedRun(producer: WikiProducer, cwd: string, runId?: string): Promise<WikiRunHandle | undefined> {
  const runs = runId ? [] : await producer.list(cwd);
  const selected = runId ?? runs.find((run) => run.status === "running" || run.status === "paused")?.id ?? runs[0]?.id;
  return selected ? await producer.open(selected, cwd) : undefined;
}

async function streamRun(
  pi: ExtensionAPI,
  context: ExtensionCommandContext,
  handle: WikiRunHandle,
  signal: AbortSignal | undefined,
  refresh: LiveSurfaceRefresh,
): Promise<void> {
  const notified = new Set<string>();
  try {
    for await (const update of handle.updates(signal)) {
      if (signal?.aborted) break;
      const event = projectWikiRunEvent(update.event);
      const key = `${update.event.type}:${update.event.at}:${update.event.message}`;
      if (event.visible && !notified.has(key)) {
        notified.add(key);
        output(pi, context, event.text, event.tone === "error" ? "error" : event.tone === "warning" ? "warning" : "info");
      }
      refresh(context, update.view);
    }
  } catch (error) {
    if (signal?.aborted) return;
    context.ui.notify(`Wiki progress stream stopped: ${errorMessage(error)}`, "warning");
    try {
      refresh(context, await handle.view());
    } catch {
      // Keep the last successful surface if the handle can no longer be read.
    }
  }
}

function attachStream(
  pi: ExtensionAPI,
  context: ExtensionCommandContext,
  handle: WikiRunHandle,
  refresh: LiveSurfaceRefresh,
  streams: Map<string, AbortController>,
): void {
  if (streams.has(handle.id)) return;
  const controller = new AbortController();
  streams.set(handle.id, controller);
  void streamRun(pi, context, handle, controller.signal, refresh).finally(() => {
    if (streams.get(handle.id) === controller) streams.delete(handle.id);
  });
}

type LiveSurfaceRefresh = (context: ExtensionCommandContext, view: WikiRunView) => void;

type WikiWidgetTui = { requestRender(force?: boolean): void };

type WikiWidgetSurface = {
  lines: string[];
  fingerprint: string;
  invalidate?: () => void;
  installed: boolean;
};

function createWikiLiveWidget() {
  const surface: WikiWidgetSurface = { lines: [], fingerprint: "", installed: false };

  const reset = () => {
    surface.lines = [];
    surface.fingerprint = "";
    surface.invalidate = undefined;
    surface.installed = false;
  };

  return {
    reset,
    refresh(context: ExtensionCommandContext, view: WikiRunView) {
      if (!context.hasUI) return;
      if (context.mode !== "tui") {
        refreshStringSurface(context, view);
        return;
      }
      if (view.status !== "running") {
        reset();
        const text = wikiFooterStatus(view);
        context.ui.setStatus("wiki", text ? themeWikiLiveText(context.ui.theme, text) : undefined);
        context.ui.setWidget("wiki", undefined);
        return;
      }
      const lines = wikiWidgetLines(view) ?? [];
      const fingerprint = wikiWidgetLinesFingerprint(lines);
      if (!surface.installed) {
        context.ui.setStatus("wiki", undefined);
        surface.lines = lines;
        surface.fingerprint = fingerprint;
        context.ui.setWidget("wiki", wikiWidgetFactory(surface));
        surface.installed = true;
        return;
      }
      if (fingerprint === surface.fingerprint) {
        return;
      }
      surface.lines = lines;
      surface.fingerprint = fingerprint;
      surface.invalidate?.();
    },
  };
}

function wikiWidgetFactory(surface: WikiWidgetSurface) {
  return (tui: WikiWidgetTui, theme: unknown) => {
    const widget = {
      render: (width: number) => {
        const available = Math.max(0, Math.floor(width));
        return surface.lines.map((line) => {
          const themed = themeWikiLiveText(theme, line);
          return visibleWidth(themed) > available ? truncateToWidth(themed, available) : themed;
        });
      },
      invalidate: () => {
        tui.requestRender();
      },
      dispose: () => {
        if (surface.invalidate === bound) surface.invalidate = undefined;
      },
    };
    const bound = () => widget.invalidate();
    surface.invalidate = bound;
    return widget;
  };
}

function refreshStringSurface(context: ExtensionCommandContext, view: WikiRunView): void {
  if (view.status === "running") {
    context.ui.setStatus("wiki", undefined);
    const lines = wikiWidgetLines(view);
    context.ui.setWidget("wiki", lines?.map((line) => themeWikiLiveText(context.ui.theme, line)));
    return;
  }
  const text = wikiFooterStatus(view);
  context.ui.setStatus("wiki", text ? themeWikiLiveText(context.ui.theme, text) : undefined);
  context.ui.setWidget("wiki", undefined);
}

async function workspaceRoot(cwd: string): Promise<string> {
  return (await loadWikiWorkspace(cwd)).root;
}

async function tryWorkspaceRoot(cwd: string): Promise<string | undefined> {
  try {
    return await workspaceRoot(cwd);
  } catch {
    return undefined;
  }
}

async function pauseRunning(engine: WikiProducer | undefined, cwd: string | undefined): Promise<void> {
  if (!engine || !cwd) return;
  try {
    const active = (await engine.list(cwd)).find((run) => run.status === "running");
    if (active) await (await engine.open(active.id, cwd))?.control("pause");
  } catch {
    // The durable ledger recovers an interrupted running process as paused.
  }
}

function nonempty(value: string | undefined): string | undefined {
  return value ? value : undefined;
}

function output(pi: ExtensionAPI, context: ExtensionCommandContext, content: string, level: "info" | "warning" | "error" = "info"): void {
  if (context.hasUI) context.ui.notify(content, level);
  else void pi.sendMessage({ customType: "okf-wiki", content, display: true });
}

const COMPLETIONS = [
  { value: "init ", label: "init", description: "Initialize a Wiki workspace" },
  { value: "source add ", label: "source", description: "Link or clone a Git source" },
  { value: "status ", label: "status", description: "Show a run" },
  { value: "runs", label: "runs", description: "List repository Wiki runs" },
  { value: "pause", label: "pause", description: "Pause the active run" },
  { value: "resume ", label: "resume", description: "Resume a paused run" },
  { value: "cancel ", label: "cancel", description: "Cancel a run" },
];

export function wikiArgumentCompletions(argumentPrefix: string) {
  const value = argumentPrefix.trimStart();
  if (!value) return COMPLETIONS.slice();
  if (/^source\s*$/.test(value)) {
    return [{ value: "source add ", label: "add", description: "Add a Git source" }];
  }
  if (/^source\s+add\s*$/.test(value)) {
    return [
      { value: "source add link ", label: "link", description: "Link a local Git repository root" },
      { value: "source add clone ", label: "clone", description: "Clone a Git URL" },
    ];
  }
  if (/^status\s+\S+\s+\S+\s*$/.test(value)) {
    const prefix = value.endsWith(" ") ? value : `${value} `;
    return [{ value: `${prefix}--process`, label: "--process", description: "Show compact process history" }];
  }
  if (/\s/.test(value)) return null;
  return COMPLETIONS.filter((item) => item.label.startsWith(value));
}

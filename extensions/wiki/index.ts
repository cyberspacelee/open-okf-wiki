import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  parseWikiCliCommand,
  renderWikiRun,
  renderWikiSnapshot,
  wikiCliHelp,
  type WikiCliCommand,
} from "./lib/cli.js";
import { createProductionWikiProducer } from "./lib/producer.js";
import { errorMessage } from "./lib/failures.js";
import { WikiRunResultError, type WikiProducer, type WikiRunHandle, type WikiRunView } from "./lib/producer-types.js";
import { createLiveChrome, openWikiStatusOverlay } from "./lib/tui.js";
import { loadWikiWorkspace, wikiWorkspaceManagement, type ResolvedWikiWorkspace } from "./lib/workspace.js";

let chrome: ReturnType<typeof createLiveChrome> | undefined;
let unsubscribe: (() => void) | undefined;

export default function (pi: ExtensionAPI): void {
  let producer: WikiProducer | undefined;

  pi.on("session_shutdown", () => {
    stopWatch();
    chrome?.clear();
    chrome = undefined;
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
        const workspace = await loadWikiWorkspace(active.cwd);
        producer ??= createProductionWikiProducer({
          session: {
            model: active.model,
            thinkingLevel: active.thinkingLevel,
          },
        });
        await dispatch(pi, active, producer, workspace.root, command);
      } catch (error) {
        active.ui.notify(errorMessage(error), "error");
      }
    },
  });
}

async function dispatch(
  pi: ExtensionAPI,
  context: ExtensionCommandContext,
  producer: WikiProducer,
  cwd: string,
  command: Exclude<WikiCliCommand, { action: "init" | "source-add" }>,
): Promise<void> {
  if (command.action === "run") {
    const handle = await producer.start({ cwd, focus: command.focus });
    const view = await handle.view();
    output(pi, context, renderWikiRun(view));
    showSurface(context, view);
    if (!context.hasUI) {
      try {
        await handle.result();
      } catch (error) {
        if (!(error instanceof WikiRunResultError)) throw error;
      }
      output(pi, context, renderWikiRun(await handle.view()));
      return;
    }
    watchRun(context, handle);
    return;
  }
  const handle = await producer.current(cwd);
  if (command.action === "status") {
    if (!handle) {
      output(pi, context, renderWikiRun(undefined));
      return;
    }
    const view = await handle.view();
    output(pi, context, renderWikiSnapshot(view));
    showSurface(context, view);
    if (view.status === "running") watchRun(context, handle);
    if (context.mode === "tui") await openWikiStatusOverlay({ ui: context.ui, handle });
    return;
  }
  if (!handle) throw new Error("No Wiki run is available");
  const view = await handle.control(command.action);
  output(pi, context, renderWikiRun(view));
  showSurface(context, view);
  if (command.action === "resume") watchRun(context, handle);
}

function showSurface(context: ExtensionCommandContext, view: WikiRunView): void {
  if (!context.hasUI) return;
  chrome ??= createLiveChrome(context);
  chrome.set(view);
}

function watchRun(context: ExtensionCommandContext, handle: WikiRunHandle): void {
  stopWatch();
  chrome ??= createLiveChrome(context);
  unsubscribe = handle.subscribe((view) => {
    chrome?.set(view);
    if (view.status === "running") return;
    stopWatch();
    context.ui.notify(renderWikiRun(view).split("\n")[0] ?? `wiki ${view.status}`, view.status === "succeeded" ? "info" : "error");
  });
}

function stopWatch(): void {
  unsubscribe?.();
  unsubscribe = undefined;
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
      wikiExclude: command.exclude,
      defaultSourceIgnores: command.defaultSourceIgnores,
    });
    output(pi, context, formatWorkspace("Initialized Wiki workspace", workspace));
    return;
  }
  const workspace = command.kind === "link"
    ? await wikiWorkspaceManagement.addLink({
      cwd: context.cwd,
      workspace: command.workspace,
      localPath: command.localPath,
      name: command.name,
      catalog: command.catalog,
    })
    : await wikiWorkspaceManagement.addClone({
      cwd: context.cwd,
      workspace: command.workspace,
      remoteUrl: command.url,
      ref: command.ref,
      name: command.name,
      catalog: command.catalog,
    });
  output(pi, context, formatWorkspace("Added Wiki source", workspace));
}

function formatWorkspace(title: string, workspace: ResolvedWikiWorkspace): string {
  const sources = workspace.sources.length
    ? workspace.sources.map((source) => `  ${source.path}${source.catalog ? ` -> catalog:${source.catalog}` : ""}`).join("\n")
    : "  (none — /wiki source add)";
  return `${title}: ${workspace.root}\n${sources}`;
}

function output(pi: ExtensionAPI, context: ExtensionCommandContext, text: string): void {
  if (context.hasUI) context.ui.notify(text.split("\n")[0] ?? text, "info");
  pi.appendEntry("wiki", { text });
}

const COMPLETIONS = [
  { value: "init ", label: "init", description: "Initialize a Wiki workspace" },
  { value: "source add ", label: "source", description: "Link or clone a Git source" },
  { value: "status", label: "status", description: "Show the current run" },
  { value: "pause", label: "pause", description: "Pause the active run" },
  { value: "resume", label: "resume", description: "Continue the current paused or failed run" },
  { value: "cancel", label: "cancel", description: "Cancel the current run" },
];

function wikiArgumentCompletions(argumentPrefix: string) {
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
  if (/\s/.test(value)) return null;
  return COMPLETIONS.filter((item) => item.label.startsWith(value));
}
